import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createPiHarness } from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";
import {
  primaryAgents,
  createContext,
  primaryBranch,
  makeSnapshot,
  createControlState,
  createControlExecutor,
  revokeSnapshotSafely,
  registerTlhPrimaryAgentRuntime,
  createProjectAgentRunCapture,
  retainProjectAgentRunReference,
  releaseProjectAgentRunReference,
  getTlhProjectAgentAccess,
  setTlhProjectAgentAccessProvider,
  ASYNC_DIR,
  originalHome,
  originalUserProfile,
  originalPiCodingAgentDir,
} from "./the-last-harness-project-agent-lifecycle-test-helpers.mjs";

test("primary tool authorization allows enabled primaries to control retained embedded runs while keeping disabled initiation-only", async (t) => {
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

  const disabledContext = contextFor("disabled");
  for (const action of ["resume", "steer"]) {
    const blocked = await toolCall(
      { toolName: "subagent", input: { action, id: runId, message: "Continue." } },
      disabledContext,
    );
    assert.equal(blocked?.block, true, `disabled ${action} should be blocked`);
    assert.match(blocked?.reason ?? "", /enabled primary|project-agent/i);
  }

  for (const selection of ["architect", "rush", "product", "bug-hunter"]) {
    const context = contextFor(selection);
    const branch = await toolCall(
      { toolName: "subagent", input: { action: "resume", id: runId, message: "Continue." } },
      context,
    );
    assert.equal(branch, undefined, `${selection} resume should reach the executor`);
    const steer = await toolCall(
      { toolName: "subagent", input: { action: "steer", id: runId, message: "Focus." } },
      context,
    );
    assert.equal(steer, undefined, `${selection} steer should reach the executor`);
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

test("Rush revives a persisted embedded run through the trusted rebind path", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "tlh-project-agent-primary-rush-rebind-"));
  const home = join(fixture, "home");
  const agentDir = join(fixture, "agent");
  const projectRoot = join(fixture, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", projectRoot], { stdio: "ignore" });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  new ProjectTrustStore(agentDir).set(projectRoot, true);
  const snapshot = makeSnapshot(projectRoot, "primary-rush-rebind-generation");
  const capture = createProjectAgentRunCapture(
    snapshot.manifest,
    snapshot.manifest.entries[0].agent,
  );
  const persistedCapture = {
    ...capture,
    provenance: { ...capture.provenance, processInstanceId: "prior-process" },
  };
  const runId = `primary-rush-rebind-${Date.now().toString(36)}`;
  const runDirectories = [join(ASYNC_DIR, runId)];
  const writePersistedStatus = (id, steps) => {
    const asyncDir = join(ASYNC_DIR, id);
    mkdirSync(asyncDir, { recursive: true });
    for (const step of steps) {
      mkdirSync(join(asyncDir, "sessions"), { recursive: true });
      writeFileSync(step.sessionFile, "", "utf8");
    }
    writeFileSync(
      join(asyncDir, "status.json"),
      JSON.stringify({
        runId: id,
        mode: "parallel",
        state: "complete",
        sessionId: "lifecycle-session",
        cwd: projectRoot,
        startedAt: 100,
        endedAt: 200,
        lastUpdate: Date.now(),
        steps,
        projectAgents: steps.flatMap((step) => (step.projectAgent ? [step.projectAgent] : [])),
      }),
      "utf8",
    );
  };
  writePersistedStatus(runId, [
    {
      agent: persistedCapture.provenance.agent,
      status: "complete",
      sessionFile: join(ASYNC_DIR, runId, "embedded.jsonl"),
      projectAgent: persistedCapture,
    },
  ]);
  t.after(() => {
    setTlhProjectAgentAccessProvider(undefined);
    for (const asyncDir of runDirectories) rmSync(asyncDir, { recursive: true, force: true });
    revokeSnapshotSafely(snapshot.capability);
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
  const rushContext = createContext(projectRoot, "lifecycle-session", primaryBranch("rush"));
  await runtime.applySessionStart(rushContext);

  const reviveInput = {
    action: "resume",
    id: runId,
    index: 0,
    message: "Continue the explicitly requested embedded run.",
  };
  assert.equal(
    await toolCall({ toolName: "subagent", input: reviveInput }, rushContext),
    undefined,
    "Rush should reach executor reauthorization for a persisted embedded target",
  );
  let dispatchCalls = 0;
  const executor = createControlExecutor(projectRoot, createControlState(), snapshot, () => true, {
    getProjectAgentAccess: () =>
      getTlhProjectAgentAccess({
        cwd: projectRoot,
        sessionId: "lifecycle-session",
        targetNames: ["embedded.xyz"],
      }),
    executeAsyncSingle: (continuedId, params) => {
      dispatchCalls++;
      return {
        content: [{ type: "text", text: "continued" }],
        details: { asyncId: continuedId, params, results: [] },
      };
    },
  });
  const revived = await executor.execute(
    "rush-persisted-rebind",
    reviveInput,
    new AbortController().signal,
    undefined,
    rushContext,
  );
  assert.equal(revived.isError, undefined, revived.content?.[0]?.text ?? "");
  assert.equal(dispatchCalls, 1);
});

test("primary tool authorization permits every primary to dispatch embedded runs and rejects unsafe cwd paths", async (t) => {
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
  const disabledContext = createContext(
    projectRoot,
    "lifecycle-session",
    primaryBranch("disabled"),
  );
  const disabledRequest = projectRequest();
  const disabledResult = await toolCall(disabledRequest, disabledContext);
  assert.equal(disabledResult, undefined, "disabled mode may initiate an explicit project run");
  assert.equal(disabledRequest.input.agentScope, "project");
  assert.equal(Object.hasOwn(disabledRequest.input, "context"), false);
  const disabledAccess = getTlhProjectAgentAccess({
    cwd: projectRoot,
    sessionId: "lifecycle-session",
    targetNames: ["embedded.xyz"],
  });
  assert.equal(disabledAccess?.canManage, false);
  assert.equal(disabledAccess?.architect, false);
  assert.equal(disabledAccess?.canInitiate, true);

  for (const selection of ["architect", "rush", "product", "bug-hunter"]) {
    const primaryContext = createContext(
      projectRoot,
      "lifecycle-session",
      primaryBranch(selection),
    );
    const directRequest = projectRequest();
    const directResult = await toolCall(directRequest, primaryContext);
    assert.equal(directResult, undefined, `${selection} should dispatch an embedded run`);
    assert.equal(directRequest.input.agentScope, "project");
    const access = getTlhProjectAgentAccess({
      cwd: projectRoot,
      sessionId: "lifecycle-session",
      targetNames: ["embedded.xyz"],
    });
    assert.equal(access?.canManage, true, `${selection} can manage retained runs`);
    assert.equal(access?.architect, selection === "architect", `${selection} architect diagnostic`);
    assert.equal(access?.canInitiate, true, `${selection} can initiate runs`);

    const parallelRequest = {
      toolName: "subagent",
      input: { tasks: [{ agent: "embedded.xyz", task: "use project agent in parallel" }] },
    };
    const parallelResult = await toolCall(parallelRequest, primaryContext);
    assert.equal(parallelResult, undefined, `${selection} should dispatch an embedded batch`);
    assert.equal(parallelRequest.input.agentScope, "project");
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
