import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

import { createPiHarness } from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerTlhPrimaryAgentRuntime } = await jiti.import(
  "../extensions/the-last-harness/primary-agent-runtime.ts",
);
const { PRIMARY_AGENT_SESSION_STATE_ENTRY } = await jiti.import(
  "../extensions/the-last-harness-primary-agent.mjs",
);
const {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  resolveProjectAgentSnapshot,
  retainProjectAgentRunReference,
  releaseProjectAgentRunReference,
} = await jiti.import("../extensions/subagents/src/agents/project-agent-snapshot.ts");
const {
  getTlhProjectAgentAccess,
  probeTlhProjectAgentRunMarker,
  setTlhProjectAgentAccessProvider,
} = await import("../extensions/the-last-harness/project-agent-access.mjs");
const { loadProjectAgentSnapshot } =
  await import("../extensions/the-last-harness/project-agent-loader-bridge.mjs");
const { ASYNC_DIR } = await jiti.import("../extensions/subagents/src/shared/types.ts");
const { probeAsyncRunForProjectAgentMarker } = await jiti.import(
  "../extensions/subagents/src/runs/background/async-resume.ts",
);

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function primaryAgents() {
  const make = (name) => ({
    name,
    description: `Test ${name}`,
    tools: ["subagent"],
    systemPrompt: "Test primary.",
    filePath: `agents/primary/${name}.md`,
  });
  return new Map([
    ["architect", make("architect")],
    ["rush", make("rush")],
    ["product", make("product")],
    ["bug-hunter", make("bug-hunter")],
  ]);
}

function createContext(cwd, sessionId, branch = []) {
  return {
    cwd,
    mode: "json",
    hasUI: false,
    ui: { notify() {}, confirm: async () => false },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getBranch: () => branch,
    },
    modelRegistry: { getAvailable: () => [] },
    model: undefined,
    scopedModels: [],
    thinkingLevel: "low",
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  };
}

function primaryBranch(selection) {
  return [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: selection },
    },
  ];
}

function makeSnapshot(projectRoot, generationId) {
  const filePath = join(projectRoot, ".tlh", "agents", "xyz.md");
  const agent = {
    name: "embedded.xyz",
    localName: "xyz",
    packageName: "embedded",
    description: "Project lifecycle agent",
    tools: ["read"],
    systemPrompt: `Prompt ${generationId}`,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source: "project",
    filePath,
  };
  const capability = registerProjectAgentSnapshot({
    projectRoot,
    sessionId: "lifecycle-session",
    generationId,
    entries: [{ agent, digest: `digest-${generationId}`, frontmatterFields: ["tools"] }],
  });
  const provenance = getProjectAgentSnapshotProvenance(capability);
  return {
    status: "loaded",
    capability,
    provenance,
    manifest: resolveProjectAgentSnapshot(capability, provenance),
  };
}

test("the default bridge loads a generated project-agent snapshot from a real Git worktree", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-bridge-"));
  const projectRoot = join(fixture, "project");
  const agentDir = join(fixture, "agent");
  mkdirSync(join(projectRoot, ".tlh", "agents"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  writeFileSync(
    join(projectRoot, ".tlh", "agents", "bridge.md"),
    `---
name: bridge
package: embedded
description: Bridge smoke agent
tools: read
---
Bridge smoke prompt.
`,
    "utf8",
  );
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const result = await loadProjectAgentSnapshot({
    cwd: projectRoot,
    sessionId: "bridge-smoke-session",
    agentDir,
    defaultProjectTrust: "always",
    trustDependencies: {
      createProjectTrustStore: (trustAgentDir) => new ProjectTrustStore(trustAgentDir),
      hasTrustRequiringProjectResources,
    },
    context: { hasUI: false },
  });

  assert.equal(result.status, "loaded");
  assert.equal(result.provenance?.projectRoot, realpathSync(projectRoot));
  assert.deepEqual(
    result.manifest?.entries.map((entry) => entry.agent.name),
    ["embedded.bridge"],
  );
});

test("native project-agent marker probe stays semantically aligned with the canonical probe", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-probe-parity-"));
  const tempRoot = join(fixture, "temp");
  const asyncRoot = join(tempRoot, "async-subagent-runs");
  const resultsRoot = join(tempRoot, "async-subagent-results");
  const outsideRoot = join(fixture, "outside");
  const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
  mkdirSync(asyncRoot, { recursive: true });
  mkdirSync(resultsRoot, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
  t.after(() => {
    rmSync(fixture, { recursive: true, force: true });
    if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
    else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
  });

  const writeStatus = (id, value) => {
    const runDirectory = join(asyncRoot, id);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, "status.json"),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  };
  const writeResult = (id, value) => {
    writeFileSync(
      join(resultsRoot, `${id}.json`),
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  };
  const resetRoots = () => {
    rmSync(asyncRoot, { recursive: true, force: true });
    rmSync(resultsRoot, { recursive: true, force: true });
    mkdirSync(asyncRoot, { recursive: true });
    mkdirSync(resultsRoot, { recursive: true });
  };
  const markerStatus = (id) => ({
    runId: id,
    mode: "single",
    state: "running",
    steps: [{ projectAgent: {} }],
  });

  const cases = [
    {
      name: "exact id",
      input: { id: "exact-id" },
      setup: () => writeStatus("exact-id", markerStatus("exact-id")),
      expected: "present",
    },
    {
      name: "unique id prefix",
      input: { id: "unique-prefix" },
      setup: () => writeStatus("unique-prefix-run", markerStatus("unique-prefix-run")),
      expected: "present",
    },
    {
      name: "ambiguous id prefix",
      input: { id: "ambiguous-prefix" },
      setup: () => {
        writeStatus("ambiguous-prefix-one", {});
        writeStatus("ambiguous-prefix-two", {});
      },
      expected: "unavailable",
    },
    {
      name: "matching id and directory",
      input: { id: "directory-id", dir: join(asyncRoot, "directory-id") },
      setup: () => writeStatus("directory-id", markerStatus("directory-id")),
      expected: "present",
    },
    {
      name: "empty directory falls back to id resolution",
      input: { id: "empty-dir-id", dir: "" },
      setup: () => writeStatus("empty-dir-id", markerStatus("empty-dir-id")),
      expected: "present",
    },
    {
      name: "null directory falls back to id resolution",
      input: { id: "null-dir-id", dir: null },
      setup: () => writeStatus("null-dir-id", markerStatus("null-dir-id")),
      expected: "present",
    },
    {
      name: "malformed marker file",
      input: { id: "malformed-marker" },
      setup: () => writeStatus("malformed-marker", '{"projectAgent":'),
      expected: "present",
    },
    {
      name: "malformed file without marker",
      input: { id: "malformed-no-marker" },
      setup: () => writeStatus("malformed-no-marker", "not-json"),
      expected: "unavailable",
    },
    {
      name: "valid no-marker file",
      input: { id: "no-marker" },
      setup: () => writeStatus("no-marker", { runId: "no-marker", state: "running" }),
      expected: "absent",
    },
    {
      name: "nested marker",
      input: { id: "nested-marker" },
      setup: () =>
        writeStatus("nested-marker", {
          runId: "nested-marker",
          nestedChildren: [{ results: [{ projectAgents: [] }] }],
        }),
      expected: "present",
    },
    {
      name: "result-only inventory",
      input: { id: "result-only" },
      setup: () => writeResult("result-only", { runId: "result-only", projectAgent: {} }),
      expected: "present",
    },
    {
      name: "missing run",
      input: { id: "missing-run" },
      setup: () => {},
      expected: "absent",
    },
    {
      name: "directory root escape",
      input: { id: "escape-run", dir: outsideRoot },
      setup: () => {},
      expected: "unavailable",
    },
  ];

  for (const testCase of cases) {
    resetRoots();
    testCase.setup();
    const canonical = probeAsyncRunForProjectAgentMarker(testCase.input, {
      asyncDirRoot: asyncRoot,
      resultsDir: resultsRoot,
    });
    const native = await probeTlhProjectAgentRunMarker(testCase.input);
    assert.deepEqual(canonical, { status: testCase.expected }, `${testCase.name}: canonical`);
    assert.deepEqual(native, canonical, `${testCase.name}: native parity`);
  }
});

test("project-agent loading is one session-start snapshot and reload replaces the active generation", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-lifecycle-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectRoot, ".tlh", "agents"), { recursive: true });

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  const first = makeSnapshot(projectRoot, "generation-one");
  const second = makeSnapshot(projectRoot, "generation-two");
  const denied = { status: "denied", diagnostics: ["test denial"] };
  const loads = [first, second, denied];
  const calls = [];
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async (options) => {
      calls.push(options);
      return loads[Math.min(calls.length - 1, loads.length - 1)];
    },
  });
  const context = createContext(projectRoot, "lifecycle-session");
  const beforeAgentStart = pi.events.find((entry) => entry.name === "before_agent_start")?.handler;
  const toolCall = pi.events.find((entry) => entry.name === "tool_call")?.handler;
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof toolCall, "function");
  assert.equal(typeof shutdown, "function");

  await runtime.applySessionStart(context);
  await beforeAgentStart({ systemPrompt: "base" }, context);
  await beforeAgentStart({ systemPrompt: "base" }, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "lifecycle-session");
  assert.equal(
    getTlhProjectAgentAccess({ cwd: projectRoot, sessionId: "lifecycle-session" }).expected
      .generationId,
    "generation-one",
  );

  const naturalRequest = {
    toolName: "subagent",
    input: { agent: "embedded.xyz", task: "use the xyz subagent naturally" },
  };
  assert.equal(await toolCall(naturalRequest, context), undefined);
  assert.equal(naturalRequest.input.agentScope, "user");
  assert.equal(naturalRequest.input.context, "fresh");

  await runtime.applySessionStart(context);
  assert.equal(calls.length, 2);
  assert.equal(
    getTlhProjectAgentAccess({ cwd: projectRoot, sessionId: "lifecycle-session" }).expected
      .generationId,
    "generation-two",
  );
  await beforeAgentStart({ systemPrompt: "base" }, context);
  assert.equal(calls.length, 2, "before_agent_start must not rescan project definitions");

  await runtime.applySessionStart(context);
  assert.equal(calls.length, 3);
  assert.equal(
    getTlhProjectAgentAccess({ cwd: projectRoot, sessionId: "lifecycle-session" }),
    undefined,
  );

  await shutdown({}, context);
});

test("primary tool authorization gates retained project controls while leaving status and interrupt available", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-control-gates-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectRoot, ".tlh", "agents"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  const snapshot = makeSnapshot(projectRoot, "primary-control-generation");
  const capture = createProjectAgentRunCapture(
    snapshot.manifest,
    snapshot.manifest.entries[0].agent,
  );
  const runId = "retained-primary-control-run";
  retainProjectAgentRunReference(snapshot.capability, runId, [capture]);
  t.after(() => releaseProjectAgentRunReference(runId));
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => snapshot,
  });
  const toolCall = pi.events.find((entry) => entry.name === "tool_call")?.handler;
  assert.equal(typeof toolCall, "function");
  const contextFor = (selection) =>
    createContext(projectRoot, "lifecycle-session", primaryBranch(selection));
  await runtime.applySessionStart(contextFor("architect"));

  for (const selection of ["disabled", "rush", "product", "bug-hunter"]) {
    const context = contextFor(selection);
    const branch = await toolCall(
      { toolName: "subagent", input: { action: "resume", id: runId, message: "Continue." } },
      context,
    );
    assert.equal(branch?.block, true, `${selection} resume should be blocked`);
    assert.match(branch?.reason ?? "", /architect|project-agent|Rush/);
    const steer = await toolCall(
      { toolName: "subagent", input: { action: "steer", id: runId, message: "Focus." } },
      context,
    );
    assert.equal(steer?.block, true, `${selection} steer should be blocked`);
    assert.match(steer?.reason ?? "", /architect|project-agent|Rush/);
  }
  assert.equal(
    await toolCall(
      { toolName: "subagent", input: { action: "status", id: runId } },
      contextFor("rush"),
    ),
    undefined,
  );
  assert.equal(
    await toolCall(
      { toolName: "subagent", input: { action: "interrupt", id: runId } },
      contextFor("rush"),
    ),
    undefined,
  );

  await runtime.applySessionStart(contextFor("architect"));
});

test("primary hook denies persisted project markers after private registry loss without blocking marker-free controls", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-registry-loss-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const snapshot = makeSnapshot(projectRoot, "primary-registry-loss-generation");
  const capture = createProjectAgentRunCapture(
    snapshot.manifest,
    snapshot.manifest.entries[0].agent,
  );
  const runId = `primary-registry-loss-${Date.now().toString(36)}`;
  const asyncDir = join(ASYNC_DIR, runId);
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(
    join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      mode: "single",
      state: "running",
      sessionId: "lifecycle-session",
      cwd: projectRoot,
      steps: [
        {
          agent: capture.provenance.agent,
          status: "running",
          projectAgent: capture,
        },
      ],
    }),
    "utf8",
  );
  retainProjectAgentRunReference(snapshot.capability, runId, [capture]);
  releaseProjectAgentRunReference(runId);
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    rmSync(asyncDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => snapshot,
  });
  const toolCall = pi.events.find((entry) => entry.name === "tool_call")?.handler;
  assert.equal(typeof toolCall, "function");
  const contextFor = (selection) =>
    createContext(projectRoot, "lifecycle-session", primaryBranch(selection));
  await runtime.applySessionStart(contextFor("architect"));

  for (const selection of ["architect", "rush", "disabled"]) {
    const context = contextFor(selection);
    for (const action of ["resume", "steer"]) {
      const result = await toolCall(
        {
          toolName: "subagent",
          input: { action, id: runId, message: "Registry-loss deny-only check." },
        },
        context,
      );
      assert.equal(result?.block, true, `${selection} ${action} should be blocked`);
      assert.match(result?.reason ?? "", /private|project-agent|fallback/i);
    }
  }

  const statusPath = join(asyncDir, "status.json");
  const markerFree = JSON.parse(readFileSync(statusPath, "utf8"));
  delete markerFree.steps[0].projectAgent;
  writeFileSync(statusPath, JSON.stringify(markerFree), "utf8");
  const ordinaryContext = contextFor("architect");
  assert.equal(
    await toolCall(
      {
        toolName: "subagent",
        input: { action: "resume", id: runId, message: "Ordinary marker-free resume." },
      },
      ordinaryContext,
    ),
    undefined,
  );
  assert.equal(
    await toolCall(
      {
        toolName: "subagent",
        input: { action: "steer", id: runId, message: "Ordinary marker-free steer." },
      },
      ordinaryContext,
    ),
    undefined,
  );

  await runtime.applySessionStart(contextFor("architect"));
});

test("primary tool authorization independently blocks disabled/non-architect project calls and unsafe cwd paths", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-gates-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  const outsideRoot = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-outside-"));
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectRoot, ".tlh", "agents"), { recursive: true });
  const symlinkPath = join(projectRoot, "outside-link");
  try {
    symlinkSync(outsideRoot, symlinkPath, "dir");
  } catch {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    return;
  }

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  const snapshot = makeSnapshot(projectRoot, "primary-gates-generation");
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => snapshot,
  });
  const toolCall = pi.events.find((entry) => entry.name === "tool_call")?.handler;
  assert.equal(typeof toolCall, "function");

  const projectRequest = (cwd = projectRoot) => ({
    toolName: "subagent",
    input: { agent: "embedded.xyz", task: "use project agent", cwd },
  });

  await runtime.applySessionStart(
    createContext(projectRoot, "lifecycle-session", primaryBranch("disabled")),
  );
  const disabledResult = await toolCall(
    projectRequest(),
    createContext(projectRoot, "lifecycle-session", primaryBranch("disabled")),
  );
  assert.equal(disabledResult?.block, true);
  assert.match(disabledResult?.reason ?? "", /architect/);

  for (const selection of ["rush", "product", "bug-hunter"]) {
    const nonArchitectResult = await toolCall(
      projectRequest(),
      createContext(projectRoot, "lifecycle-session", primaryBranch(selection)),
    );
    assert.equal(nonArchitectResult?.block, true, `${selection} should be blocked`);
    assert.match(nonArchitectResult?.reason ?? "", /may not delegate to embedded|architect/);
  }

  const architectContext = createContext(
    projectRoot,
    "lifecycle-session",
    primaryBranch("architect"),
  );
  for (const [label, cwd, expected] of [
    ["outside", outsideRoot, /outside|blocked/i],
    ["missing", join(projectRoot, "missing-directory"), /does not exist|cannot be resolved/i],
    ["symlink escape", symlinkPath, /outside|blocked/i],
  ]) {
    const result = await toolCall(projectRequest(cwd), architectContext);
    assert.equal(result?.block, true, `${label} cwd should be blocked`);
    assert.match(result?.reason ?? "", expected, `${label} cwd reason`);
  }
});
