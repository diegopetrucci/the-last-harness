import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  discoverAgents,
  discoverAgentsAll,
  discoverAgentsWithProjectSnapshot,
} from "../../src/agents/agents.ts";
import {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  ProjectAgentSnapshotCapabilityError,
  ProjectAgentSnapshotMergeError,
  mergeProjectAgentSnapshot,
  registerProjectAgentSnapshot,
  resolveProjectAgentRunReference,
  lookupProjectAgentRunReference,
  resolveProjectAgentSnapshot,
  revokeProjectAgentSnapshot,
  retainProjectAgentRunReference,
  releaseProjectAgentRunReference,
  retainProjectAgentSnapshotReference,
  releaseProjectAgentSnapshotReference,
  cleanupProjectAgentSnapshotRegistry,
  projectAgentSnapshotRegistryStats,
  type ProjectAgentSnapshotInput,
} from "../../src/agents/project-agent-snapshot.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeAgent(name: string, source: AgentConfig["source"] = "project"): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source,
    filePath: path.join(tempProject, ".tlh", "agents", `${name}.md`),
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf-8");
}

function makeEntry(
  agent: AgentConfig | string,
  digest: string,
  frontmatterFields: string[] = [],
): { agent: AgentConfig; digest: string; frontmatterFields: string[] } {
  return {
    agent: typeof agent === "string" ? makeAgent(agent) : agent,
    digest,
    frontmatterFields,
  };
}

function register(
  overrides: Partial<ProjectAgentSnapshotInput> = {},
): ReturnType<typeof registerProjectAgentSnapshot> {
  return registerProjectAgentSnapshot({
    projectRoot: tempProject,
    sessionId: "session-1",
    generationId: "generation-1",
    entries: [makeEntry("snapshot", "digest-snapshot")],
    ...overrides,
  });
}

function writeProfileAgent(name: string): void {
  const filePath = path.join(tempHome, ".pi", "agent", "tlh", "agents", "subagents", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${name} profile agent\n---\n\nProfile prompt.\n`,
    "utf-8",
  );
}

describe("project agent snapshot provider", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-snapshot-home-"));
    tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-snapshot-project-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempProject, { recursive: true, force: true });
  });

  it("registers a frozen capability and resists caller mutation", () => {
    const agent = makeAgent("immutable");
    agent.tools = ["read"];
    agent.supervisorBridge = false;
    agent.toolBudget = { hard: 2, block: ["bash"] };
    const input = {
      projectRoot: tempProject,
      sessionId: "session-immutable",
      generationId: "generation-immutable",
      entries: [makeEntry(agent, "digest-immutable", ["tools", "supervisorBridge", "toolBudget"])],
      tombstones: ["removed-profile"],
    };

    const capability = registerProjectAgentSnapshot(input);
    const provenance = getProjectAgentSnapshotProvenance(capability);
    const manifest = resolveProjectAgentSnapshot(capability, provenance);

    assert.ok(Object.isFrozen(capability));
    assert.equal(JSON.stringify(capability), "{}");
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.provenance));
    assert.ok(Object.isFrozen(manifest.entries));
    assert.ok(Object.isFrozen(manifest.entries[0]));
    assert.ok(Object.isFrozen(manifest.entries[0]?.frontmatterFields));
    assert.deepEqual(manifest.entries[0]?.frontmatterFields, [
      "tools",
      "supervisorBridge",
      "toolBudget",
    ]);
    assert.ok(Object.isFrozen(manifest.entries[0]?.agent));
    assert.ok(Object.isFrozen(manifest.entries[0]?.agent.tools));
    assert.equal(manifest.entries[0]?.agent.supervisorBridge, false);
    assert.ok(Object.isFrozen(manifest.entries[0]?.agent.toolBudget));
    assert.ok(Object.isFrozen(manifest.entries[0]?.agent.toolBudget?.block));

    agent.description = "mutated description";
    agent.tools?.push("write");
    if (Array.isArray(agent.toolBudget.block)) agent.toolBudget.block.push("write");
    input.entries[0]!.digest = "mutated digest";
    input.entries[0]!.frontmatterFields.push("model");
    input.entries.push(makeEntry("later", "later-digest"));
    input.tombstones?.push("later-tombstone");

    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0]?.agent.description, "immutable agent");
    assert.deepEqual(manifest.entries[0]?.agent.tools, ["read"]);
    assert.deepEqual(manifest.entries[0]?.agent.toolBudget?.block, ["bash"]);
    assert.equal(manifest.entries[0]?.digest, "digest-immutable");
    assert.deepEqual(manifest.tombstones, ["removed-profile"]);
    revokeProjectAgentSnapshot(capability);
  });

  it("protects retained run generations until terminal release and then cleans them up", () => {
    const agent = makeAgent("retained-run");
    const capability = register({
      sessionId: "session-retained-run",
      generationId: "generation-retained-run",
      entries: [makeEntry(agent, "digest-retained-run")],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, agent);
    retainProjectAgentRunReference(capability, "retained-run-id", [capture]);
    assert.equal(cleanupProjectAgentSnapshotRegistry(), 0);
    assert.throws(
      () => revokeProjectAgentSnapshot(capability),
      ProjectAgentSnapshotCapabilityError,
    );
    assert.equal(
      resolveProjectAgentRunReference("retained-run-id", capture.provenance).captures[0]?.provenance
        .digest,
      "digest-retained-run",
    );
    assert.deepEqual(lookupProjectAgentRunReference("retained-run-id"), {
      status: "found",
      runId: "retained-run-id",
      captures: resolveProjectAgentRunReference("retained-run-id", capture.provenance).captures,
    });
    assert.equal(releaseProjectAgentRunReference("retained-run-id"), true);
    assert.deepEqual(lookupProjectAgentRunReference("retained-run-id"), { status: "missing" });
    cleanupProjectAgentSnapshotRegistry();
    assert.throws(
      () => resolveProjectAgentSnapshot(capability, getProjectAgentSnapshotProvenance(capability)),
      ProjectAgentSnapshotCapabilityError,
    );
  });

  it("releases only the owned generation instead of sweeping a concurrent registration", () => {
    const ownedCapability = register({
      sessionId: "session-owned-release",
      generationId: "generation-owned-release",
    });
    const concurrentCapability = register({
      sessionId: "session-concurrent-release",
      generationId: "generation-concurrent-release",
    });
    retainProjectAgentSnapshotReference(ownedCapability, "per-capability-release-owner");
    const beforeRelease = projectAgentSnapshotRegistryStats();

    releaseProjectAgentSnapshotReference("per-capability-release-owner");

    assert.equal(
      projectAgentSnapshotRegistryStats().generations,
      beforeRelease.generations - 1,
      "releasing one owner must collect only its generation",
    );
    assert.equal(
      projectAgentSnapshotRegistryStats().references,
      beforeRelease.references - 1,
      "releasing one owner must remove only its reference",
    );
    assert.doesNotThrow(() =>
      resolveProjectAgentSnapshot(
        concurrentCapability,
        getProjectAgentSnapshotProvenance(concurrentCapability),
      ),
    );
    revokeProjectAgentSnapshot(concurrentCapability);
  });

  it("rejects duplicate retained captures so a child cannot resolve ambiguously", () => {
    const agent = makeAgent("duplicate-retained");
    const capability = register({ entries: [makeEntry(agent, "duplicate-digest")] });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, agent);
    assert.throws(
      () =>
        retainProjectAgentRunReference(capability, "duplicate-retained-run", [capture, capture]),
      ProjectAgentSnapshotCapabilityError,
    );
    revokeProjectAgentSnapshot(capability);
  });

  it("reports ambiguous retained run prefixes instead of falling back to discovery", () => {
    const agent = makeAgent("ambiguous-retained");
    const capability = register({ entries: [makeEntry(agent, "ambiguous-digest")] });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, agent);
    retainProjectAgentRunReference(capability, "ambiguous-retained-a", [capture]);
    retainProjectAgentRunReference(capability, "ambiguous-retained-b", [capture]);
    assert.deepEqual(lookupProjectAgentRunReference("ambiguous-retained-"), {
      status: "ambiguous",
      runIds: ["ambiguous-retained-a", "ambiguous-retained-b"],
      captures: [capture.provenance, capture.provenance],
    });
    releaseProjectAgentRunReference("ambiguous-retained-a");
    releaseProjectAgentRunReference("ambiguous-retained-b");
    cleanupProjectAgentSnapshotRegistry();
  });

  it("retains older generations until each capability is explicitly revoked", () => {
    const oldCapability = register({ generationId: "generation-old" });
    const newCapability = register({ generationId: "generation-new" });

    assert.doesNotThrow(() =>
      resolveProjectAgentSnapshot(oldCapability, getProjectAgentSnapshotProvenance(oldCapability)),
    );
    assert.doesNotThrow(() =>
      resolveProjectAgentSnapshot(newCapability, getProjectAgentSnapshotProvenance(newCapability)),
    );

    revokeProjectAgentSnapshot(oldCapability);
    assert.throws(
      () =>
        resolveProjectAgentSnapshot(oldCapability, {
          projectRoot: tempProject,
          sessionId: "session-1",
          generationId: "generation-old",
          processInstanceId: "not-used-after-revoke",
        }),
      (error: unknown) => error instanceof ProjectAgentSnapshotCapabilityError,
    );
    revokeProjectAgentSnapshot(newCapability);
  });

  it("rejects duplicate, contradictory, and non-project registration data", () => {
    assert.throws(
      () =>
        register({
          entries: [makeEntry("duplicate", "one"), makeEntry("duplicate", "two")],
        }),
      /duplicate agent 'duplicate'/,
    );
    assert.throws(
      () => register({ tombstones: ["duplicate-tombstone", "duplicate-tombstone"] }),
      /duplicate tombstone 'duplicate-tombstone'/,
    );
    assert.throws(
      () =>
        register({
          entries: [makeEntry("same-name", "digest")],
          tombstones: ["same-name"],
        }),
      /both an agent and tombstone for 'same-name'/,
    );
    assert.throws(
      () =>
        register({
          entries: [makeEntry(makeAgent("user-agent", "user"), "digest")],
        }),
      /must preserve source 'project'/,
    );
    assert.throws(() => register({ projectRoot: "   " }), /projectRoot must be a non-empty string/);

    for (const disabledValue of [true, false]) {
      const disabled = makeAgent(`disabled-${disabledValue}`);
      disabled.disabled = disabledValue;
      assert.throws(
        () => register({ entries: [makeEntry(disabled, "disabled-digest")] }),
        /must not carry a disabled field/,
      );
    }

    const rejectInvalidAgent = (mutate: (agent: AgentConfig) => void, message: RegExp): void => {
      const agent = makeAgent("invalid-shape");
      mutate(agent);
      assert.throws(
        () => register({ entries: [makeEntry(agent, "invalid-shape-digest")] }),
        message,
      );
    };
    rejectInvalidAgent((agent) => Reflect.set(agent, "description", "   "), /description/);
    rejectInvalidAgent((agent) => Reflect.set(agent, "filePath", ""), /filePath/);
    rejectInvalidAgent((agent) => Reflect.set(agent, "systemPrompt", undefined), /systemPrompt/);
    rejectInvalidAgent(
      (agent) => Reflect.set(agent, "systemPromptMode", "invalid"),
      /systemPromptMode/,
    );
    rejectInvalidAgent(
      (agent) => Reflect.set(agent, "inheritProjectContext", "false"),
      /inheritProjectContext/,
    );
    rejectInvalidAgent((agent) => Reflect.set(agent, "inheritSkills", undefined), /inheritSkills/);
  });

  it("rejects cyclic, non-plain, and non-JSON registration values", () => {
    const cyclic = makeAgent("cyclic");
    Reflect.set(cyclic, "cycle", cyclic);
    assert.throws(
      () => register({ entries: [makeEntry(cyclic, "cyclic-digest")] }),
      /cannot contain cycles/,
    );

    const nonPlain = makeAgent("non-plain");
    Reflect.set(nonPlain, "toolBudget", new Date());
    assert.throws(
      () => register({ entries: [makeEntry(nonPlain, "non-plain-digest")] }),
      /must be plain objects/,
    );

    const withFunction = makeAgent("function");
    Reflect.set(withFunction, "functionValue", () => undefined);
    assert.throws(
      () => register({ entries: [makeEntry(withFunction, "function-digest")] }),
      /JSON-compatible values/,
    );

    const withSymbol = makeAgent("symbol");
    Reflect.set(withSymbol, "symbolValue", Symbol("not-json"));
    assert.throws(
      () => register({ entries: [makeEntry(withSymbol, "symbol-digest")] }),
      /JSON-compatible values/,
    );
    const withBigInt = makeAgent("bigint");
    Reflect.set(withBigInt, "bigIntValue", 1n);
    assert.throws(
      () => register({ entries: [makeEntry(withBigInt, "bigint-digest")] }),
      /JSON-compatible values/,
    );
  });

  it("keeps custom snapshot configuration immutable except for a profile deny", () => {
    writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
      subagents: {
        defaultModel: "user-default",
        agentOverrides: {
          "embedded.override-model": {
            model: "user-override",
            thinking: "high",
            systemPrompt: "user prompt",
            tools: ["write"],
            disabled: false,
          },
          "embedded.explicit-tools": { tools: ["write"], model: "user-tools-model" },
          "embedded.disabled-snapshot": { model: "ignored", disabled: true },
          "embedded.non-disabled": { model: "ignored", disabled: false },
        },
      },
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      subagents: {
        defaultModel: "project-default",
        agentOverrides: {
          "embedded.override-model": { model: "project-override", disabled: true },
          "embedded.non-disabled": { model: "project-model", disabled: true },
        },
      },
    });
    const overrideModel = makeAgent("embedded.override-model");
    overrideModel.model = "root-model";
    overrideModel.thinking = "low";
    overrideModel.systemPrompt = "root prompt";
    overrideModel.tools = ["read"];
    const explicitTools = makeAgent("embedded.explicit-tools");
    explicitTools.tools = ["read"];
    const capability = register({
      sessionId: "session-overrides",
      generationId: "generation-overrides",
      entries: [
        makeEntry("embedded.default-model", "digest-default-model"),
        makeEntry(overrideModel, "digest-override-model", ["model", "thinking", "tools"]),
        makeEntry(explicitTools, "digest-explicit-tools", ["tools"]),
        makeEntry("embedded.disabled-snapshot", "digest-disabled-snapshot"),
        makeEntry("embedded.non-disabled", "digest-non-disabled"),
      ],
    });
    const expected = getProjectAgentSnapshotProvenance(capability);
    const discovered = discoverAgentsWithProjectSnapshot(tempProject, capability, expected);

    const defaultModel = discovered.agents.find((agent) => agent.name === "embedded.default-model");
    assert.equal(defaultModel?.model, undefined);
    const unchanged = discovered.agents.find((agent) => agent.name === "embedded.override-model");
    assert.equal(unchanged?.model, "root-model");
    assert.equal(unchanged?.thinking, "low");
    assert.equal(unchanged?.systemPrompt, "root prompt");
    assert.deepEqual(unchanged?.tools, ["read"]);
    assert.equal(unchanged?.override, undefined);
    assert.deepEqual(
      discovered.agents.find((agent) => agent.name === "embedded.explicit-tools")?.tools,
      ["read"],
    );
    const nonDisabled = discovered.agents.find((agent) => agent.name === "embedded.non-disabled");
    assert.ok(nonDisabled);
    assert.equal(nonDisabled.model, undefined);
    assert.equal(nonDisabled.disabled, undefined);
    assert.equal(
      discovered.agents.some((agent) => agent.name === "embedded.disabled-snapshot"),
      false,
    );
    assert.deepEqual(discovered.projectSnapshot.entries, [
      { name: "embedded.default-model", digest: "digest-default-model" },
      { name: "embedded.override-model", digest: "digest-override-model" },
      { name: "embedded.explicit-tools", digest: "digest-explicit-tools" },
      { name: "embedded.disabled-snapshot", digest: "digest-disabled-snapshot" },
      { name: "embedded.non-disabled", digest: "digest-non-disabled" },
    ]);
    assert.deepEqual(discovered.projectSnapshot.tombstones, []);
    assert.deepEqual(discovered.projectSnapshot.disabledByUser, ["embedded.disabled-snapshot"]);
    assert.ok(Object.isFrozen(discovered.projectSnapshot.disabledByUser));

    revokeProjectAgentSnapshot(capability);
  });

  it("rejects replacement and tombstone collisions outside embedded profile agents", () => {
    const packageCapability = register({
      entries: [makeEntry("package-collision", "package-digest")],
    });
    const packageManifest = resolveProjectAgentSnapshot(
      packageCapability,
      getProjectAgentSnapshotProvenance(packageCapability),
    );
    assert.throws(
      () => mergeProjectAgentSnapshot([makeAgent("package-collision", "package")], packageManifest),
      (error: unknown) => error instanceof ProjectAgentSnapshotMergeError,
    );
    revokeProjectAgentSnapshot(packageCapability);

    const builtinCapability = register({
      entries: [makeEntry("builtin-collision", "builtin-digest")],
    });
    const builtinManifest = resolveProjectAgentSnapshot(
      builtinCapability,
      getProjectAgentSnapshotProvenance(builtinCapability),
    );
    assert.throws(
      () => mergeProjectAgentSnapshot([makeAgent("builtin-collision", "builtin")], builtinManifest),
      (error: unknown) => error instanceof ProjectAgentSnapshotMergeError,
    );
    revokeProjectAgentSnapshot(builtinCapability);

    const plainUserCapability = register({
      entries: [makeEntry("plain-user-collision", "plain-user-digest")],
    });
    const plainUserManifest = resolveProjectAgentSnapshot(
      plainUserCapability,
      getProjectAgentSnapshotProvenance(plainUserCapability),
    );
    assert.throws(
      () =>
        mergeProjectAgentSnapshot([makeAgent("plain-user-collision", "user")], plainUserManifest),
      (error: unknown) => error instanceof ProjectAgentSnapshotMergeError,
    );
    revokeProjectAgentSnapshot(plainUserCapability);

    const genericCapability = register({
      entries: [makeEntry("generic-collision", "generic-digest")],
    });
    const genericManifest = resolveProjectAgentSnapshot(
      genericCapability,
      getProjectAgentSnapshotProvenance(genericCapability),
    );
    assert.throws(
      () => mergeProjectAgentSnapshot([makeAgent("generic-collision", "project")], genericManifest),
      (error: unknown) =>
        error instanceof ProjectAgentSnapshotMergeError &&
        error.message ===
          "Project agent snapshot cannot replace or remove 'generic-collision' from non-embedded project discovery.",
    );
    revokeProjectAgentSnapshot(genericCapability);

    const tombstoneCapability = register({
      entries: [],
      tombstones: ["plain-tombstone-collision"],
    });
    const tombstoneManifest = resolveProjectAgentSnapshot(
      tombstoneCapability,
      getProjectAgentSnapshotProvenance(tombstoneCapability),
    );
    assert.throws(
      () =>
        mergeProjectAgentSnapshot(
          [makeAgent("plain-tombstone-collision", "user")],
          tombstoneManifest,
        ),
      (error: unknown) => error instanceof ProjectAgentSnapshotMergeError,
    );
    revokeProjectAgentSnapshot(tombstoneCapability);
  });

  it("fails closed for unknown, forged, revoked, and mismatched capabilities", () => {
    const capability = register({
      sessionId: "session-secure",
      generationId: "generation-secure",
    });
    const expected = getProjectAgentSnapshotProvenance(capability);
    const invalid = (candidate: unknown, identity = expected) =>
      assert.throws(
        () => resolveProjectAgentSnapshot(candidate, identity),
        (error: unknown) => error instanceof ProjectAgentSnapshotCapabilityError,
      );

    invalid(Object.freeze({}));
    invalid(capability, { ...expected, projectRoot: `${expected.projectRoot}-other` });
    invalid(capability, { ...expected, sessionId: "session-other" });
    invalid(capability, { ...expected, generationId: "generation-other" });
    invalid(capability, { ...expected, processInstanceId: "process-other" });
    invalid(capability, { ...expected, sessionId: " " });

    revokeProjectAgentSnapshot(capability);
    invalid(capability, expected);
  });

  it("merges trusted entries after profile agents and applies tombstones first", () => {
    writeProfileAgent("developer");
    fs.mkdirSync(path.join(tempProject, ".tlh", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tempProject, ".tlh", "agents", "ignored.md"),
      "---\nname: ignored\ndescription: Must not be discovered\n---\n\nIgnored.\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(tempProject, ".pi", "agents"), { recursive: true });
    fs.mkdirSync(path.join(tempProject, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(tempProject, "configured-agents"), { recursive: true });
    fs.mkdirSync(path.join(tempProject, "vendor", "project-package", "agents"), {
      recursive: true,
    });
    writeJson(path.join(tempProject, ".pi", "settings.json"), {
      packages: ["./vendor/project-package"],
      subagents: {
        agentDirs: ["configured-agents"],
        modelScope: { enforce: true, allow: ["project/*"] },
      },
    });
    fs.writeFileSync(
      path.join(tempProject, ".pi", "agents", "generic-project.md"),
      "---\nname: generic-project\ndescription: Must not be discovered\n---\n\nGeneric.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempProject, ".agents", "legacy-project.md"),
      "---\nname: legacy-project\ndescription: Must not be discovered\n---\n\nLegacy.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempProject, "configured-agents", "configured-project.md"),
      "---\nname: configured-project\ndescription: Must not be discovered\n---\n\nConfigured.\n",
      "utf-8",
    );
    writeJson(path.join(tempProject, "vendor", "project-package", "package.json"), {
      name: "project-package",
      "pi-subagents": { agents: ["agents"] },
    });
    fs.writeFileSync(
      path.join(tempProject, "vendor", "project-package", "agents", "package-project.md"),
      "---\nname: package-project\ndescription: Must not be discovered\n---\n\nPackage.\n",
      "utf-8",
    );

    const capability = register({
      sessionId: "session-discovery",
      generationId: "generation-discovery",
      entries: [
        makeEntry("embedded.shared", "digest-shared"),
        makeEntry("project-only", "digest-project-only"),
      ],
      tombstones: ["embedded.remove-me"],
    });
    const expected = getProjectAgentSnapshotProvenance(capability);
    const discovered = discoverAgentsWithProjectSnapshot(tempProject, capability, expected);

    assert.equal(
      discovered.agents.find((agent) => agent.name === "embedded.shared")?.source,
      "project",
    );
    assert.equal(
      discovered.agents.find((agent) => agent.name === "embedded.shared")?.systemPrompt,
      "embedded.shared prompt",
    );
    assert.equal(
      discovered.agents.some((agent) => agent.name === "embedded.remove-me"),
      false,
    );
    assert.equal(
      discovered.agents.some((agent) =>
        [
          "ignored",
          "generic-project",
          "legacy-project",
          "configured-project",
          "package-project",
        ].includes(agent.name),
      ),
      false,
    );
    assert.equal(discovered.modelScope, undefined);
    assert.equal(
      discovered.agents.find((agent) => agent.name === "project-only")?.source,
      "project",
    );
    assert.equal(discovered.agents.find((agent) => agent.name === "developer")?.source, "user");
    assert.deepEqual(discovered.projectSnapshot.entries, [
      { name: "embedded.shared", digest: "digest-shared" },
      { name: "project-only", digest: "digest-project-only" },
    ]);
    assert.deepEqual(discovered.projectSnapshot.tombstones, ["embedded.remove-me"]);
    assert.equal(discovered.projectSnapshot.provenance.generationId, "generation-discovery");
    assert.ok(Object.isFrozen(discovered.projectSnapshot));
    assert.ok(Object.isFrozen(discovered.projectSnapshot.entries));

    revokeProjectAgentSnapshot(capability);
  });

  it("keeps snapshots out of public scope and generic project discovery", () => {
    fs.mkdirSync(path.join(tempProject, ".tlh", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tempProject, ".tlh", "agents", "hidden.md"),
      "---\nname: hidden\ndescription: Hidden project agent\n---\n\nHidden.\n",
      "utf-8",
    );
    const capability = register({
      entries: [makeEntry("private-only", "digest-private-only")],
    });

    assert.equal(
      discoverAgents(tempProject, "both").agents.some((a) => a.name === "private-only"),
      false,
    );
    const all = discoverAgentsAll(tempProject);
    assert.equal(
      [...all.builtin, ...all.package, ...all.user, ...all.project].some(
        (agent) => agent.name === "private-only" || agent.name === "hidden",
      ),
      false,
    );
    revokeProjectAgentSnapshot(capability);
  });
});
