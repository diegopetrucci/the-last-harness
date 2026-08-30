import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

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
  projectAgentSnapshotRegistryStats,
  retainProjectAgentRunReference,
  lookupProjectAgentRunReference,
  releaseProjectAgentRunReference,
  retainProjectAgentSnapshotReference,
  releaseProjectAgentSnapshotReference,
  releaseProjectAgentRunReferencesForSession,
  getProjectAgentRunReferenceMetadata,
  revokeProjectAgentSnapshot,
} = await jiti.import("../extensions/subagents/src/agents/project-agent-snapshot.ts");
const {
  getTlhProjectAgentAccess,
  probeTlhProjectAgentRunMarker,
  setTlhProjectAgentAccessProvider,
  setTlhProjectAgentSnapshotOperations,
} = await import("../extensions/the-last-harness/project-agent-access.mjs");
const { loadProjectAgentSnapshot } =
  await import("../extensions/the-last-harness/project-agent-loader-bridge.mjs");
const { ASYNC_DIR } = await jiti.import("../extensions/subagents/src/shared/types.ts");
const { probeAsyncRunForProjectAgentMarker } = await jiti.import(
  "../extensions/subagents/src/runs/background/async-resume.ts",
);
const { createSubagentExecutor } = await jiti.import(
  "../extensions/subagents/src/runs/foreground/subagent-executor.ts",
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
  const filePath = join(realpathSync(projectRoot), ".tlh", "agents", "custom", "XYZ.md");
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

function createControlState() {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear() {} },
  };
}

function createControlExecutor(root, state, snapshot, kill) {
  return createSubagentExecutor({
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      getSessionName: () => "lifecycle-parent",
    },
    state,
    config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} },
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [] }),
    getProjectAgentAccess: () => ({
      capability: snapshot.capability,
      expected: getProjectAgentSnapshotProvenance(snapshot.capability),
      architect: true,
      reauthorize: async () => true,
    }),
    kill,
  });
}

function writeRunningControlStatus(runId, capture, { projectAgent = true } = {}) {
  const asyncDir = join(ASYNC_DIR, runId);
  const sessionFile = join(asyncDir, "worker.jsonl");
  mkdirSync(asyncDir, { recursive: true });
  writeFileSync(sessionFile, "", "utf8");
  const step = {
    agent: capture.provenance.agent,
    status: "running",
    sessionFile,
    ...(projectAgent ? { projectAgent: capture } : {}),
  };
  writeFileSync(
    join(asyncDir, "status.json"),
    JSON.stringify({
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      sessionId: capture.provenance.sessionId,
      cwd: capture.provenance.projectRoot,
      startedAt: 100,
      lastUpdate: Date.now(),
      sessionFile,
      steps: [step],
      ...(projectAgent ? { projectAgents: [capture] } : {}),
    }),
    "utf8",
  );
  return asyncDir;
}

function revokeSnapshotSafely(capability) {
  try {
    revokeProjectAgentSnapshot(capability);
  } catch {
    // A run reference or lifecycle cleanup may already have collected it.
  }
}

test("the default bridge loads a generated project-agent snapshot from a real Git worktree", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-bridge-"));
  const projectRoot = join(fixture, "project");
  const agentDir = join(fixture, "agent");
  mkdirSync(join(projectRoot, ".tlh", "agents", "custom"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  new ProjectTrustStore(agentDir).set(projectRoot, true);
  writeFileSync(
    join(projectRoot, ".tlh", "agents", "custom", "BRIDGE.md"),
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
    trustDependencies: {
      createProjectTrustStore: (trustAgentDir) => new ProjectTrustStore(trustAgentDir),
    },
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
  const denied = { status: "denied", diagnostics: ["test denial"] };
  const calls = [];
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async (options) => {
      calls.push(options);
      if (calls.length === 1) return first;
      if (calls.length === 2) return makeSnapshot(projectRoot, "generation-two");
      return denied;
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
  assert.equal(naturalRequest.input.agentScope, "project");
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

test("primary runtime rebinds a replaced trusted file and retains the fresh capture for handoff", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-rebind-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  const outsideRoot = join(fixture, "outside");
  const customDirectory = join(projectRoot, ".tlh", "agents", "custom");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  mkdirSync(customDirectory, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  new ProjectTrustStore(agentDir).set(projectRoot, true);
  const definitionPath = join(customDirectory, "WORKER.md");
  writeFileSync(
    definitionPath,
    `---
name: worker
package: embedded
description: Primary rebind worker
tools: read
---
Original trusted prompt.
`,
    "utf8",
  );
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

  const loads = [];
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async (options) => {
      loads.push(options);
      return loadProjectAgentSnapshot(options);
    },
  });
  const context = createContext(projectRoot, "lifecycle-session");
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  await runtime.applySessionStart(context);
  const initialAccess = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.worker"],
  });
  const initialManifest = resolveProjectAgentSnapshot(
    initialAccess.capability,
    initialAccess.expected,
  );
  const initialCapture = createProjectAgentRunCapture(
    initialManifest,
    initialManifest.entries[0].agent,
  );

  const movedPath = `${definitionPath}.old`;
  renameSync(definitionPath, movedPath);
  writeFileSync(
    definitionPath,
    `---
name: worker
package: embedded
description: Primary rebind worker
tools: read
---
Current replacement prompt.
`,
    "utf8",
  );
  const rebound = await initialAccess.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.worker",
  });
  assert.ok(rebound);
  assert.notEqual(rebound.expected.generationId, initialAccess.expected.generationId);
  assert.equal(rebound.capture.config.systemPrompt, "Current replacement prompt.");
  assert.notEqual(rebound.capture.provenance.digest, initialCapture.provenance.digest);
  assert.equal(
    resolveProjectAgentSnapshot(rebound.capability, rebound.expected).entries[0].agent.systemPrompt,
    "Current replacement prompt.",
  );
  assert.equal(loads.length, 2);
  assert.throws(
    () => resolveProjectAgentSnapshot(initialAccess.capability, initialAccess.expected),
    /invalid|does not match/i,
    "the replaced generation must be released after the handoff",
  );
  assert.doesNotThrow(
    () => resolveProjectAgentSnapshot(rebound.capability, rebound.expected),
    "the fresh generation must remain resolvable",
  );

  const currentRebindAccess = () => {
    const access = getTlhProjectAgentAccess({
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      targetNames: ["embedded.worker"],
    });
    assert.ok(access?.rebind);
    return access;
  };
  const renamedPath = `${definitionPath}.renamed`;
  renameSync(definitionPath, renamedPath);
  const renamedAccess = currentRebindAccess();
  const loadsBeforeRename = loads.length;
  assert.equal(
    await renamedAccess.rebind({
      projectRoot,
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      agent: "embedded.worker",
    }),
    undefined,
    "a renamed definition must not be revived from a persisted path",
  );
  assert.equal(
    loads.length,
    loadsBeforeRename + 1,
    "renamed validation must load a fresh snapshot",
  );
  writeFileSync(
    definitionPath,
    `---
name: worker
package: embedded
description: Primary rebind worker
tools: read
---
Current replacement prompt.
`,
    "utf8",
  );
  new ProjectTrustStore(agentDir).set(projectRoot, false);
  const untrustedAccess = currentRebindAccess();
  const loadsBeforeUntrusted = loads.length;
  assert.equal(
    await untrustedAccess.rebind({
      projectRoot,
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      agent: "embedded.worker",
    }),
    undefined,
    "an untrusted root must not be revived",
  );
  assert.equal(
    loads.length,
    loadsBeforeUntrusted + 1,
    "untrusted validation must load a fresh snapshot",
  );
  new ProjectTrustStore(agentDir).set(projectRoot, true);
  writeFileSync(
    definitionPath,
    `---
name: worker
package: profile
description: Unsafe replacement
tools: read
---
Must not execute.
`,
    "utf8",
  );
  const nonEmbeddedAccess = currentRebindAccess();
  const loadsBeforeNonEmbedded = loads.length;
  assert.equal(
    await nonEmbeddedAccess.rebind({
      projectRoot,
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      agent: "embedded.worker",
    }),
    undefined,
    "a non-embedded definition must fail closed",
  );
  assert.equal(
    loads.length,
    loadsBeforeNonEmbedded + 1,
    "non-embedded validation must load a fresh snapshot",
  );
  writeFileSync(
    definitionPath,
    `---
name: worker
package: embedded
description: Primary rebind worker
tools: read
---
Current replacement prompt.
`,
    "utf8",
  );
  const outsideRootAccess = currentRebindAccess();
  const loadsBeforeOutsideRoot = loads.length;
  assert.equal(
    await outsideRootAccess.rebind({
      projectRoot: outsideRoot,
      cwd: outsideRoot,
      sessionId: "lifecycle-session",
      agent: "embedded.worker",
    }),
    undefined,
    "a root outside the active project must fail closed",
  );
  assert.equal(
    loads.length,
    loadsBeforeOutsideRoot + 1,
    "outside-root validation must load a fresh snapshot",
  );

  const handoffRunId = "primary-rebind-handoff";
  retainProjectAgentRunReference(rebound.capability, handoffRunId, [rebound.capture]);
  t.after(() => releaseProjectAgentRunReference(handoffRunId));
  await shutdown({}, context);
  assert.equal(lookupProjectAgentRunReference(handoffRunId).status, "found");
  assert.equal(
    lookupProjectAgentRunReference(handoffRunId).captures[0].config.systemPrompt,
    "Current replacement prompt.",
  );
  assert.throws(
    () => resolveProjectAgentSnapshot(initialAccess.capability, initialAccess.expected),
    /invalid|does not match/i,
    "shutdown must not restore the replaced generation",
  );
  assert.doesNotThrow(
    () => resolveProjectAgentSnapshot(rebound.capability, rebound.expected),
    "the handoff run must retain the fresh generation after shutdown",
  );
  assert.equal(readFileSync(movedPath, "utf8").includes("Original trusted prompt."), true);
});

test("primary runtime keeps same-capability rebinds stable and fails closed on retain errors", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-rebind-guards-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const baseSnapshot = makeSnapshot(projectRoot, "primary-rebind-guards-generation");
  const snapshot = {
    ...baseSnapshot,
    trust: { trusted: true, source: "test" },
  };
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

  let loadCount = 0;
  let returnInvalidCapability = false;
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => {
      loadCount++;
      if (!returnInvalidCapability) return snapshot;
      return { ...snapshot, capability: {} };
    },
  });
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  const context = createContext(projectRoot, "lifecycle-session");
  await runtime.applySessionStart(context);
  const access = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.ok(access?.rebind);
  const beforeSame = projectAgentSnapshotRegistryStats();
  const same = await access.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.xyz",
  });
  assert.ok(same);
  assert.equal(same.capability, access.capability, "same capability must not be re-retained");
  assert.deepEqual(projectAgentSnapshotRegistryStats(), beforeSame);

  returnInvalidCapability = true;
  const failed = await access.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.xyz",
  });
  assert.equal(failed, undefined, "a retain failure must not authorize the returned metadata");
  assert.deepEqual(projectAgentSnapshotRegistryStats(), beforeSame);
  assert.doesNotThrow(() => resolveProjectAgentSnapshot(access.capability, access.expected));
  assert.equal(loadCount, 3);
  await shutdown?.({}, context);
});

test("primary runtime releases every rejected rebind generation without changing registry stats", async (t) => {
  const fixture = mkdtempSync(
    join(tmpdir(), "tlh-project-agent-primary-rebind-rejected-lifecycle-"),
  );
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const initialSnapshot = {
    ...makeSnapshot(projectRoot, "primary-rebind-rejected-initial"),
    trust: { trusted: true, source: "test" },
  };
  const rejectedSnapshots = [];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    rejectedSnapshots.forEach((snapshot) => revokeSnapshotSafely(snapshot.capability));
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  let loadCount = 0;
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => {
      loadCount++;
      if (loadCount === 1) return initialSnapshot;
      const rejected = {
        ...makeSnapshot(projectRoot, `primary-rebind-rejected-${loadCount}`),
        trust: { trusted: false, source: "test-denied" },
      };
      rejectedSnapshots.push(rejected);
      return rejected;
    },
  });
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  const context = createContext(projectRoot, "lifecycle-session");
  await runtime.applySessionStart(context);
  const access = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.ok(access?.rebind);
  const baseline = projectAgentSnapshotRegistryStats();

  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(
      await access.rebind({
        projectRoot,
        cwd: projectRoot,
        sessionId: "lifecycle-session",
        agent: "embedded.xyz",
      }),
      undefined,
      "a newly loaded but untrusted rebind must be rejected",
    );
    assert.deepEqual(
      projectAgentSnapshotRegistryStats(),
      baseline,
      `rejected rebind ${attempt + 1} must release its temporary generation owner`,
    );
  }
  assert.equal(loadCount, 5);
  assert.equal(
    getTlhProjectAgentAccess({ cwd: projectRoot, sessionId: "lifecycle-session" }).expected
      .generationId,
    "primary-rebind-rejected-initial",
    "rejected rebinds must not replace the active authority",
  );
  for (const rejected of rejectedSnapshots) {
    assert.throws(
      () => resolveProjectAgentSnapshot(rejected.capability, rejected.provenance),
      /invalid|does not match/i,
      "a rejected rebind generation must be collected after its temporary owner is released",
    );
  }
  await shutdown?.({}, context);
});

test("primary runtime releases stale session-load generations without changing registry stats", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-load-rejected-lifecycle-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const staleSnapshots = [];
  let pendingStaleRelease;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    staleSnapshots.forEach((snapshot) => revokeSnapshotSafely(snapshot.capability));
    if (pendingStaleRelease) pendingStaleRelease();
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  let loadCount = 0;
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => {
      loadCount++;
      if (loadCount === 1) {
        return {
          ...makeSnapshot(projectRoot, "primary-load-rejected-initial"),
          trust: { trusted: true, source: "test" },
        };
      }
      if (loadCount % 2 === 0) {
        const stale = {
          ...makeSnapshot(projectRoot, `primary-load-rejected-stale-${loadCount}`),
          trust: { trusted: true, source: "test" },
        };
        staleSnapshots.push(stale);
        return await new Promise((resolve) => {
          pendingStaleRelease = () => {
            pendingStaleRelease = undefined;
            resolve(stale);
          };
        });
      }
      return {
        ...makeSnapshot(projectRoot, `primary-load-rejected-current-${loadCount}`),
        trust: { trusted: true, source: "test" },
      };
    },
  });
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  const context = createContext(projectRoot, "lifecycle-session");
  await runtime.applySessionStart(context);
  const baseline = projectAgentSnapshotRegistryStats();

  for (let attempt = 0; attempt < 3; attempt++) {
    const staleLoad = runtime.applySessionStart(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loadCount, attempt * 2 + 2);
    const currentLoad = runtime.applySessionStart(context);
    await currentLoad;
    assert.equal(typeof pendingStaleRelease, "function");
    pendingStaleRelease();
    await staleLoad;
    assert.deepEqual(
      projectAgentSnapshotRegistryStats(),
      baseline,
      `stale session load ${attempt + 1} must release its temporary generation owner`,
    );
  }
  assert.equal(loadCount, 7);
  for (const stale of staleSnapshots) {
    assert.throws(
      () => resolveProjectAgentSnapshot(stale.capability, stale.provenance),
      /invalid|does not match/i,
      "a stale session-load generation must be collected after rejection",
    );
  }
  await shutdown?.({}, context);
});

test("primary runtime refuses a handoff when releasing the active owner fails", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-rebind-release-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const originalSnapshot = {
    ...makeSnapshot(projectRoot, "primary-rebind-release-original"),
    trust: { trusted: true, source: "test" },
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    setTlhProjectAgentSnapshotOperations(undefined);
    rmSync(fixture, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  });

  let loadCount = 0;
  let freshSnapshot;
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => {
      loadCount++;
      if (loadCount === 1) return originalSnapshot;
      freshSnapshot = {
        ...makeSnapshot(projectRoot, "primary-rebind-release-fresh"),
        trust: { trusted: true, source: "test" },
      };
      return freshSnapshot;
    },
  });
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  const context = createContext(projectRoot, "lifecycle-session");
  await runtime.applySessionStart(context);
  const access = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.ok(access?.rebind);

  let failNextRelease = false;
  let releaseCalls = 0;
  const releaseIds = [];
  setTlhProjectAgentSnapshotOperations({
    retainSnapshotReference: retainProjectAgentSnapshotReference,
    releaseSnapshotReference: (referenceId) => {
      releaseCalls++;
      releaseIds.push(referenceId);
      if (failNextRelease) {
        failNextRelease = false;
        throw new Error("simulated active-owner release failure");
      }
      releaseProjectAgentSnapshotReference(referenceId);
    },
    releaseRunReferencesForSession: releaseProjectAgentRunReferencesForSession,
    getRunReferenceMetadata: getProjectAgentRunReferenceMetadata,
    lookupRunReference: lookupProjectAgentRunReference,
  });
  failNextRelease = true;
  const failed = await access.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.xyz",
  });
  assert.equal(failed, undefined);
  assert.equal(releaseCalls, 2, "the active owner and unique handoff are both cleaned up");
  assert.notEqual(releaseIds[0], releaseIds[1], "handoff cleanup must not release an ambiguous id");
  const active = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.equal(active?.expected.generationId, "primary-rebind-release-original");
  assert.doesNotThrow(() => resolveProjectAgentSnapshot(active.capability, active.expected));
  assert.throws(
    () => resolveProjectAgentSnapshot(freshSnapshot.capability, freshSnapshot.provenance),
    /invalid|does not match/i,
  );
  assert.equal(loadCount, 2);

  setTlhProjectAgentSnapshotOperations(undefined);
  await shutdown?.({}, context);
});

test("primary runtime rejects stale rebinds across reload and shutdown awaits", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-rebind-interleave-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const originalSnapshot = {
    ...makeSnapshot(projectRoot, "primary-rebind-interleave-original"),
    trust: { trusted: true, source: "test" },
  };
  let reloadedSnapshot;
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

  const pendingLoads = [];
  let loadCount = 0;
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents(),
    subagentMetadata: [],
    projectAgentLoader: async () => {
      loadCount++;
      if (loadCount === 1) return originalSnapshot;
      if (loadCount === 3) {
        reloadedSnapshot = {
          ...makeSnapshot(projectRoot, "primary-rebind-interleave-reloaded"),
          trust: { trusted: true, source: "test" },
        };
        return reloadedSnapshot;
      }
      return await new Promise((resolve) => pendingLoads.push(resolve));
    },
  });
  const shutdown = pi.events.find((entry) => entry.name === "session_shutdown")?.handler;
  const context = createContext(projectRoot, "lifecycle-session");
  await runtime.applySessionStart(context);
  const initialAccess = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.ok(initialAccess?.rebind);

  const staleAfterReload = initialAccess.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.xyz",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadCount, 2);
  await runtime.applySessionStart(context);
  pendingLoads.shift()(reloadedSnapshot);
  assert.equal(await staleAfterReload, undefined);
  assert.equal(loadCount, 3);
  assert.throws(
    () => resolveProjectAgentSnapshot(initialAccess.capability, initialAccess.expected),
    /invalid|does not match/i,
  );
  const reloadedAccess = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.equal(reloadedAccess?.expected.generationId, "primary-rebind-interleave-reloaded");
  assert.doesNotThrow(() =>
    resolveProjectAgentSnapshot(reloadedAccess.capability, reloadedAccess.expected),
  );

  const staleAfterShutdown = reloadedAccess.rebind({
    projectRoot,
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    agent: "embedded.xyz",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadCount, 4);
  await shutdown?.({}, context);
  pendingLoads.shift()(reloadedSnapshot);
  assert.equal(await staleAfterShutdown, undefined);
  assert.equal(
    getTlhProjectAgentAccess({
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      targetNames: ["embedded.xyz"],
    }),
    undefined,
  );
  assert.ok(reloadedSnapshot);
  assert.throws(
    () => resolveProjectAgentSnapshot(reloadedSnapshot.capability, reloadedSnapshot.provenance),
    /invalid|does not match/i,
    "shutdown must release the reloaded active generation",
  );
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

test("executor authorizes the selected no-id and dir-only interrupt target before fallback signaling", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-interrupt-fallback-"));
  const projectRoot = join(fixture, "project");
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  const snapshot = makeSnapshot(projectRoot, "lifecycle-interrupt-fallback");
  const capture = createProjectAgentRunCapture(
    snapshot.manifest,
    snapshot.manifest.entries[0].agent,
  );
  const projectRunId = `lifecycle-project-interrupt-${Date.now().toString(36)}`;
  const projectAsyncDir = writeRunningControlStatus(projectRunId, capture);
  const ordinaryRunId = `lifecycle-ordinary-interrupt-${Date.now().toString(36)}`;
  let ordinaryAsyncDir;
  const state = createControlState();
  state.asyncJobs.set(projectRunId, {
    asyncId: projectRunId,
    asyncDir: projectAsyncDir,
    status: "running",
    pid: 12345,
    updatedAt: 0,
    projectAgents: [capture],
  });
  const signals = [];
  const executor = createControlExecutor(projectRoot, state, snapshot, (pid, signal) => {
    signals.push({ pid, signal });
    return true;
  });
  t.after(() => {
    rmSync(projectAsyncDir, { recursive: true, force: true });
    if (ordinaryAsyncDir) rmSync(ordinaryAsyncDir, { recursive: true, force: true });
    revokeSnapshotSafely(snapshot.capability);
    rmSync(fixture, { recursive: true, force: true });
  });

  const noId = await executor.execute(
    "lifecycle-interrupt-no-id-project",
    { action: "interrupt" },
    new AbortController().signal,
    undefined,
    createContext(projectRoot, "lifecycle-session"),
  );
  assert.equal(noId.isError, true);
  assert.match(noId.content[0]?.text ?? "", /private reference|project-agent|fallback/i);
  assert.equal(signals.length, 0);
  assert.equal(existsSync(join(projectAsyncDir, "control", "interrupt.json")), false);

  const dirOnly = await executor.execute(
    "lifecycle-interrupt-dir-only-project",
    { action: "interrupt", dir: projectAsyncDir },
    new AbortController().signal,
    undefined,
    createContext(projectRoot, "lifecycle-session"),
  );
  assert.equal(dirOnly.isError, true);
  assert.match(dirOnly.content[0]?.text ?? "", /private reference|project-agent|fallback/i);
  assert.equal(signals.length, 0);

  ordinaryAsyncDir = writeRunningControlStatus(ordinaryRunId, capture, { projectAgent: false });
  state.asyncJobs.set(ordinaryRunId, {
    asyncId: ordinaryRunId,
    asyncDir: ordinaryAsyncDir,
    status: "running",
    pid: 12345,
    updatedAt: Date.now() + 1000,
    projectAgents: undefined,
  });
  assert.equal(Object.hasOwn(state.asyncJobs.get(ordinaryRunId), "projectAgents"), true);
  const explicitOrdinary = await executor.execute(
    "lifecycle-interrupt-explicit-ordinary",
    { action: "interrupt", id: ordinaryRunId },
    new AbortController().signal,
    undefined,
    createContext(projectRoot, "lifecycle-session"),
  );
  assert.equal(explicitOrdinary.isError, undefined, explicitOrdinary.content[0]?.text ?? "");
  assert.match(explicitOrdinary.content[0]?.text ?? "", /Interrupt requested for async run/);
  const signalsAfterExplicit = signals.length;
  const ordinary = await executor.execute(
    "lifecycle-interrupt-no-id-ordinary",
    { action: "interrupt" },
    new AbortController().signal,
    undefined,
    createContext(projectRoot, "lifecycle-session"),
  );
  assert.equal(ordinary.isError, undefined, ordinary.content[0]?.text ?? "");
  assert.match(
    ordinary.content[0]?.text ?? "",
    new RegExp(`Interrupt requested for async run ${ordinaryRunId}`),
  );
  assert.doesNotMatch(ordinary.content[0]?.text ?? "", /TLH project-agent control rejected/);
  assert.equal(signals.length > signalsAfterExplicit, true);
  assert.equal(existsSync(join(ordinaryAsyncDir, "control", "interrupt.json")), true);
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

test("primary tool authorization permits disabled initiation, blocks non-architect calls, and rejects unsafe cwd paths", async (t) => {
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
  const disabledRequest = projectRequest();
  const disabledResult = await toolCall(
    disabledRequest,
    createContext(projectRoot, "lifecycle-session", primaryBranch("disabled")),
  );
  assert.equal(disabledResult, undefined, "disabled mode may initiate an explicit project run");
  assert.equal(disabledRequest.input.agentScope, "project");
  assert.equal(disabledRequest.input.context, "fresh");

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
