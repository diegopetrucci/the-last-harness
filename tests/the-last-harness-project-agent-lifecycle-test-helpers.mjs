import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
export const { registerTlhPrimaryAgentRuntime } = await jiti.import(
  "../extensions/the-last-harness/primary-agent-runtime.ts",
);
export const { createTlhPrimaryAgentResourceLifecycle, retireTlhPrimaryAgentResourceRuntime } =
  await jiti.import("../extensions/the-last-harness/primary-agent-runtime-lifecycle.ts");
export const { PRIMARY_AGENT_SESSION_STATE_ENTRY } = await jiti.import(
  "../extensions/the-last-harness-primary-agent.mjs",
);
export const {
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
export const {
  getTlhProjectAgentAccess,
  probeTlhProjectAgentRunMarker,
  setTlhProjectAgentAccessProvider,
  setTlhProjectAgentSnapshotOperations,
} = await import("../extensions/the-last-harness/project-agent-access.mjs");
export const { loadProjectAgentSnapshot } =
  await import("../extensions/the-last-harness/project-agent-loader-bridge.mjs");
// Redirect the subagents temp root away from the shared live runtime dir
// before any jiti import of shared/types.ts resolves TEMP_ROOT_DIR.
const _previousSubagentsTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
const _subagentsTmpDir = mkdtempSync(join(tmpdir(), "tlh-project-agent-lifecycle-subagents-tmp-"));
process.env.PI_SUBAGENTS_TEMP_ROOT = _subagentsTmpDir;
after(() => {
  rmSync(_subagentsTmpDir, { recursive: true, force: true });
  if (_previousSubagentsTempRoot === undefined) {
    delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  } else {
    process.env.PI_SUBAGENTS_TEMP_ROOT = _previousSubagentsTempRoot;
  }
});

export const { RETIRED_NESTED_ROUTE_ENV_VARS, SUBAGENT_CHILD_ENV } = await jiti.import(
  "../extensions/subagents/src/runs/shared/pi-args.ts",
);
export const { ASYNC_DIR } = await jiti.import("../extensions/subagents/src/shared/types.ts");
export const { createSubagentExecutor } = await jiti.import(
  "../extensions/subagents/src/runs/foreground/subagent-executor.ts",
);

export const originalHome = process.env.HOME;
export const originalUserProfile = process.env.USERPROFILE;
export const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

export function primaryAgents() {
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

export function createContext(cwd, sessionId, branch = []) {
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

export function primaryBranch(selection) {
  return [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: selection },
    },
  ];
}

export function makeSnapshot(projectRoot, generationId) {
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
    trust: { kind: "project-agent", trusted: true, source: "test" },
  };
}

export function createControlState() {
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

export function createControlExecutor(
  root,
  state,
  snapshot,
  kill,
  { getProjectAgentAccess, executeAsyncSingle } = {},
) {
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
    config: { maxSubagentDepth: 2, control: {} },
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [] }),
    getProjectAgentAccess:
      getProjectAgentAccess ??
      (() => ({
        capability: snapshot.capability,
        expected: getProjectAgentSnapshotProvenance(snapshot.capability),
        architect: true,
        reauthorize: async () => true,
      })),
    executeAsyncSingle,
    kill,
  });
}

export function writeRunningControlStatus(runId, capture, { projectAgent = true } = {}) {
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

export function revokeSnapshotSafely(capability) {
  try {
    revokeProjectAgentSnapshot(capability);
  } catch {
    // A run reference or lifecycle cleanup may already have collected it.
  }
}

export function deferredValue() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
