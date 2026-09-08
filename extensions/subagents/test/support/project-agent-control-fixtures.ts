import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../src/shared/types.ts";
import {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
  revokeProjectAgentSnapshot,
  resolveProjectAgentSnapshot,
  type ProjectAgentRunCapture,
  type ProjectAgentSnapshotCapability,
} from "../../src/agents/project-agent-snapshot.ts";
import {
  createSubagentExecutor,
  type ProjectAgentAccess,
} from "../../src/runs/foreground/subagent-executor.ts";
import { writeAsyncArtifactJson as writeJson } from "./async-artifact-fixtures.ts";

export type ProjectAgentRebind = NonNullable<ProjectAgentAccess["rebind"]>;

export function createProjectAgentControlEnvironment() {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  let testHome = "";

  return {
    setup() {
      testHome = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-home-"));
      process.env.HOME = testHome;
      process.env.USERPROFILE = testHome;
      delete process.env.PI_CODING_AGENT_DIR;
    },
    teardown() {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
      fs.rmSync(testHome, { recursive: true, force: true });
    },
  };
}

export function createState(): SubagentState {
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
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

export function makeAgent(
  root: string,
  name: string,
  prompt = "Captured project prompt",
): Record<string, unknown> {
  return {
    name,
    localName: name.replace(/^embedded\./, ""),
    packageName: "embedded",
    description: `${name} project agent`,
    tools: ["read"],
    systemPrompt: prompt,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source: "project",
    filePath: path.join(
      root,
      ".tlh",
      "agents",
      "custom",
      `${name.replace("embedded.", "").toUpperCase()}.md`,
    ),
  };
}

export function createProjectGeneration(
  root: string,
  sessionId: string,
  generationId: string,
  name = "embedded.worker",
  prompt = "Captured project prompt",
  digest = `digest-${generationId}`,
): {
  capability: ProjectAgentSnapshotCapability;
  capture: ProjectAgentRunCapture;
} {
  const agent = makeAgent(root, name, prompt);
  const capability = registerProjectAgentSnapshot({
    projectRoot: root,
    sessionId,
    generationId,
    entries: [{ agent: agent as never, digest, frontmatterFields: ["tools"] }],
  });
  const manifest = resolveProjectAgentSnapshot(
    capability,
    getProjectAgentSnapshotProvenance(capability),
  );
  return {
    capability,
    capture: createProjectAgentRunCapture(manifest, agent as never),
  };
}

export function makeContext(root: string, sessionId = "session-project"): any {
  return {
    cwd: root,
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => null,
      getBranch: () => [],
    },
    modelRegistry: { getAvailable: () => [] },
    model: undefined,
  };
}

export function makeExecutor(
  root: string,
  state: SubagentState,
  active: {
    capability: ProjectAgentSnapshotCapability;
    architect?: boolean;
    reauthorize?: () => Promise<boolean>;
    rebind?: ProjectAgentRebind;
  },
  options: {
    executeAsyncSingle?: (...args: any[]) => any;
    runSync?: (...args: any[]) => any;
    discoverAgents?: (...args: any[]) => { agents: any[]; modelScope?: any };
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  } = {},
) {
  return createSubagentExecutor({
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      getSessionName: () => "parent",
    } as any,
    state,
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: options.discoverAgents ?? (() => ({ agents: [] })),
    getProjectAgentAccess: () => ({
      capability: active.capability,
      expected: getProjectAgentSnapshotProvenance(active.capability),
      architect: active.architect ?? true,
      reauthorize: active.reauthorize ?? (async () => true),
      ...(active.rebind ? { rebind: active.rebind } : {}),
    }),
    executeAsyncSingle: options.executeAsyncSingle,
    runSync: options.runSync,
    kill: options.kill ?? (() => true),
  });
}

export function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

export function runAsyncDir(runId: string): string {
  return path.join(ASYNC_DIR, runId);
}

export function cleanupRun(runId: string): void {
  fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
  fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
  releaseProjectAgentRunReference(runId);
}

export function revokeIfRegistered(capability: ProjectAgentSnapshotCapability): void {
  try {
    revokeProjectAgentSnapshot(capability);
  } catch {
    // A prior run-reference release may already have collected this generation.
  }
}

export function writeStatus(
  runId: string,
  root: string,
  capture: ProjectAgentRunCapture,
  options: {
    state?: import("../../src/shared/types.ts").AsyncStatus["state"];
    steps?: any[];
    sessionFile?: string;
    cwd?: string;
  } = {},
): string {
  const asyncDir = runAsyncDir(runId);
  const sessionFile = options.sessionFile ?? path.join(asyncDir, "worker.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf8");
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state: options.state ?? "complete",
    pid: 12345,
    sessionId: capture.provenance.sessionId,
    cwd: options.cwd ?? root,
    startedAt: 100,
    endedAt: 200,
    lastUpdate: Date.now(),
    sessionFile,
    steps: options.steps ?? [
      {
        agent: capture.provenance.agent,
        status: options.state === "running" ? "running" : "complete",
        sessionFile,
        projectAgent: capture,
      },
    ],
  });
  return asyncDir;
}
