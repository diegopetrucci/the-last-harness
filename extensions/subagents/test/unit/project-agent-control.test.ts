import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createProjectAgentRunCapture,
  getProjectAgentRunReferenceMetadata,
  getProjectAgentSnapshotProvenance,
  lookupProjectAgentRunReference,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
  releaseProjectAgentSnapshotReference,
  revokeProjectAgentSnapshot,
  retainProjectAgentRunReference,
  retainProjectAgentRunReferenceFrom,
  retainProjectAgentSnapshotReference,
  resolveProjectAgentSnapshot,
  type ProjectAgentRunCapture,
  type ProjectAgentSnapshotCapability,
} from "../../src/agents/project-agent-snapshot.ts";
import {
  createSubagentExecutor,
  trimRememberedForegroundRuns,
  type ProjectAgentAccess,
} from "../../src/runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  type SubagentState,
} from "../../src/shared/types.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

let testHome = "";
type ProjectAgentRebind = NonNullable<ProjectAgentAccess["rebind"]>;

function createState(): SubagentState {
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

function makeAgent(
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

function createProjectGeneration(
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

function makeContext(root: string, sessionId = "session-project"): any {
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

function makeExecutor(
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

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";
}

function runAsyncDir(runId: string): string {
  return path.join(ASYNC_DIR, runId);
}

function cleanupRun(runId: string): void {
  fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
  fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
  releaseProjectAgentRunReference(runId);
}

function revokeIfRegistered(capability: ProjectAgentSnapshotCapability): void {
  try {
    revokeProjectAgentSnapshot(capability);
  } catch {
    // A prior run-reference release may already have collected this generation.
  }
}

function writeStatus(
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

describe("project-agent control authorization", () => {
  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-home-"));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it("resumes from the retained original generation after reload and source deletion", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-reload-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const first = createProjectGeneration(
      root,
      "session-project",
      "generation-one",
      "embedded.worker",
      "Original prompt",
      "digest-one",
    );
    const second = createProjectGeneration(
      root,
      "session-project",
      "generation-two",
      "embedded.worker",
      "Reloaded prompt",
      "digest-two",
    );
    const runId = `project-reload-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(first.capability, runId, [first.capture]);
    const asyncDir = writeStatus(runId, root, first.capture);
    const sourcePath = first.capture.config.filePath;
    fs.rmSync(sourcePath, { force: true });
    let active = second;
    let rebindCalls = 0;
    let dispatched: any;
    const executor = makeExecutor(
      root,
      createState(),
      {
        get capability() {
          return active.capability;
        },
        rebind: async () => {
          rebindCalls++;
          return second;
        },
      } as any,
      {
        executeAsyncSingle: (continuedId: string, params: any) => {
          dispatched = { continuedId, params };
          return {
            content: [{ type: "text", text: "continued" }],
            details: { asyncId: continuedId, results: [] },
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Continue using the original context." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.match(dispatched.params.agentConfig.systemPrompt, /^Original prompt/);
      assert.equal(dispatched.params.projectAgent.provenance.generationId, "generation-one");
      assert.equal(dispatched.params.projectAgent.provenance.digest, "digest-one");
      assert.equal(dispatched.params.projectAgent.config.systemPrompt, "Original prompt");
      assert.equal(rebindCalls, 0, "same-process continuation must not perform a fresh rebind");
      assert.equal(fs.existsSync(sourcePath), false);
      assert.equal(fs.existsSync(asyncDir), true);
    } finally {
      cleanupRun(runId);
      if (dispatched?.continuedId) releaseProjectAgentRunReference(dispatched.continuedId);
      revokeIfRegistered(first.capability);
      revokeIfRegistered(second.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebinds a project definition in a new process and reports an old-to-new digest change", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-rebind-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const workspaceLink = path.join(root, "workspace-link");
    let persistedCwd = workspace;
    try {
      fs.symlinkSync(workspace, workspaceLink, "dir");
      persistedCwd = workspaceLink;
    } catch {
      // The canonical-path assertion below remains useful on platforms that
      // do not permit test symlinks.
    }
    const canonicalCwd = fs.realpathSync(workspace);
    const original = createProjectGeneration(
      root,
      "session-project",
      "generation-rebind-old",
      "embedded.worker",
      "Original prompt",
      "digest-old",
    );
    const rebound = createProjectGeneration(
      root,
      "session-project",
      "generation-rebind-new",
      "embedded.worker",
      "Current prompt",
      "digest-new",
    );
    const persisted = {
      ...original.capture,
      provenance: {
        ...original.capture.provenance,
        processInstanceId: "prior-process",
      },
      // This path is intentionally forged and must never be used by the
      // fresh operation; the current capability supplies the canonical path.
      config: {
        ...original.capture.config,
        filePath: path.join(root, "outside", "forged.md"),
      },
    } as ProjectAgentRunCapture;
    const runId = `project-rebind-${Date.now().toString(36)}`;
    writeStatus(runId, root, persisted, { cwd: persistedCwd });
    let rebindRequest: unknown;
    let dispatched: any;
    const executor = makeExecutor(
      root,
      createState(),
      {
        capability: rebound.capability,
        rebind: async (request) => {
          rebindRequest = request;
          return {
            capability: rebound.capability,
            expected: getProjectAgentSnapshotProvenance(rebound.capability),
            capture: rebound.capture,
          };
        },
      },
      {
        executeAsyncSingle: (continuedId: string, params: any) => {
          dispatched = { continuedId, params };
          return {
            content: [{ type: "text", text: "rebound" }],
            details: { asyncId: continuedId, results: [] },
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume-rebind",
        { action: "resume", id: runId, message: "Continue with the current definition." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.deepEqual(rebindRequest, {
        projectRoot: root,
        cwd: canonicalCwd,
        sessionId: "session-project",
        agent: "embedded.worker",
      });
      assert.equal(dispatched.params.cwd, canonicalCwd);
      assert.equal(dispatched.params.ctx.cwd, canonicalCwd);
      assert.equal(dispatched.params.projectAgent.config.systemPrompt, "Current prompt");
      assert.equal(dispatched.params.projectAgent.config.filePath, rebound.capture.config.filePath);
      assert.deepEqual(getProjectAgentRunReferenceMetadata(dispatched.continuedId), [
        rebound.capture.provenance,
      ]);
      assert.match(text(result), /digest-old.*→.*digest-new/);
      assert.match(text(result), /current validated definition|review the change/i);
    } finally {
      cleanupRun(runId);
      if (dispatched?.continuedId) releaseProjectAgentRunReference(dispatched.continuedId);
      revokeIfRegistered(original.capability);
      revokeIfRegistered(rebound.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a fresh rebind is removed, untrusted, unsafe, or rooted elsewhere", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fresh-fail-")),
    );
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fresh-other-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["init", "--quiet", otherRoot]);
    const original = createProjectGeneration(
      root,
      "session-project",
      "generation-fresh-original",
      "embedded.worker",
      "Original fresh prompt",
      "digest-fresh-original",
    );
    const current = createProjectGeneration(
      root,
      "session-project",
      "generation-fresh-current",
      "embedded.worker",
      "Current fresh prompt",
      "digest-fresh-current",
    );
    const wrongRoot = createProjectGeneration(
      otherRoot,
      "session-project",
      "generation-fresh-other",
      "embedded.worker",
      "Wrong-root prompt",
      "digest-fresh-other",
    );
    const unsafeCapture = {
      ...current.capture,
      config: {
        ...current.capture.config,
        filePath: path.join(root, "outside", "forged.md"),
      },
    } as ProjectAgentRunCapture;
    const reboundFor =
      (value: { capability: ProjectAgentSnapshotCapability; capture: ProjectAgentRunCapture }) =>
      async () => ({
        capability: value.capability,
        expected: getProjectAgentSnapshotProvenance(value.capability),
        capture: value.capture,
      });
    const cases: Array<{
      label: string;
      rebind: ProjectAgentRebind;
    }> = [
      { label: "removed", rebind: async () => undefined },
      { label: "renamed", rebind: async () => undefined },
      { label: "untrusted", rebind: async () => undefined },
      {
        label: "unsafe",
        rebind: reboundFor({ capability: current.capability, capture: unsafeCapture }),
      },
      { label: "wrong-root", rebind: reboundFor(wrongRoot) },
    ];
    const runIds: string[] = [];
    try {
      for (const item of cases) {
        const runId = `project-fresh-${item.label}-${Date.now().toString(36)}`;
        runIds.push(runId);
        const persisted = {
          ...original.capture,
          provenance: {
            ...original.capture.provenance,
            processInstanceId: "prior-process",
          },
        } as ProjectAgentRunCapture;
        writeStatus(runId, root, persisted);
        let dispatchCalls = 0;
        const executor = makeExecutor(
          root,
          createState(),
          { capability: current.capability, rebind: item.rebind },
          {
            executeAsyncSingle: () => {
              dispatchCalls++;
              return {
                content: [{ type: "text", text: "unsafe dispatch" }],
                details: { results: [] },
              };
            },
          },
        );
        const result = await executor.execute(
          `fresh-${item.label}`,
          { action: "resume", id: runId, message: `Reject ${item.label}.` },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true, item.label);
        assert.match(text(result), /project-agent|rebind|unsafe|root|definition/i, item.label);
        assert.equal(dispatchCalls, 0, `${item.label} must not dispatch`);
      }
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(original.capability);
      revokeIfRegistered(current.capability);
      revokeIfRegistered(wrongRoot.capability);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for session, root, process, trust, generation, digest, config, and source corruption", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-fail-")),
    );
    const otherRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-other-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["init", "--quiet", otherRoot]);
    const generation = createProjectGeneration(root, "session-project", "generation-fail");
    const active = { capability: generation.capability, architect: true };
    const state = createState();
    const executor = makeExecutor(root, state, active);
    const cases: Array<{
      label: string;
      mutate: (capture: ProjectAgentRunCapture) => ProjectAgentRunCapture | Record<string, unknown>;
      context?: any;
      access?: any;
    }> = [
      {
        label: "new session",
        mutate: (capture) => capture,
        context: makeContext(root, "session-other"),
      },
      {
        label: "canonical root mismatch",
        mutate: (capture) => capture,
        context: makeContext(otherRoot),
      },
      {
        label: "stale process",
        mutate: (capture) => capture,
        access: {
          capability: generation.capability,
          expected: {
            ...getProjectAgentSnapshotProvenance(generation.capability),
            processInstanceId: "stale-process",
          },
          architect: true,
        },
      },
      {
        label: "trust revocation",
        mutate: (capture) => capture,
        access: {
          capability: generation.capability,
          architect: true,
          reauthorize: async () => false,
        },
      },
      {
        label: "digest corruption",
        mutate: (capture) => ({
          ...capture,
          provenance: { ...capture.provenance, digest: "wrong" },
        }),
      },
      {
        label: "config corruption",
        mutate: (capture) => ({
          ...capture,
          config: { ...capture.config, systemPrompt: "forged" },
        }),
      },
      {
        label: "source corruption",
        mutate: (capture) => ({
          ...capture,
          provenance: { ...capture.provenance, source: "user" },
        }),
      },
    ];
    const asyncDirs: string[] = [];
    const runIds: string[] = [];
    try {
      for (const item of cases) {
        const runId = `project-fail-${item.label.replaceAll(" ", "-")}-${Date.now().toString(36)}`;
        runIds.push(runId);
        retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
        const persisted = item.mutate(generation.capture);
        asyncDirs.push(
          writeStatus(runId, root, generation.capture, {
            steps: [
              {
                agent: generation.capture.provenance.agent,
                status: "complete",
                sessionFile: path.join(runAsyncDir(runId), "worker.jsonl"),
                projectAgent: persisted,
              },
            ],
          }),
        );
        const currentExecutor = item.access
          ? createSubagentExecutor({
              pi: {
                events: { emit() {}, on: () => () => {} },
                getSessionName: () => "parent",
              } as any,
              state,
              config: { maxSubagentDepth: 2, control: {} } as any,
              tempArtifactsDir: root,
              getSubagentSessionRoot: () => root,
              expandTilde: (value) => value,
              discoverAgents: () => ({ agents: [] }),
              getProjectAgentAccess: () => item.access,
              kill: () => true,
            })
          : executor;
        const result = await currentExecutor.execute(
          "resume",
          { action: "resume", id: runId, message: `Check ${item.label}.` },
          new AbortController().signal,
          undefined,
          item.context ?? makeContext(root),
        );
        assert.equal(result.isError, true, item.label);
        assert.match(
          text(result),
          /TLH project-agent control rejected|corrupt|different session|root|trust|invalid|generation/i,
        );
      }

      const missingGenerationId = `project-fail-missing-generation-${Date.now().toString(36)}`;
      runIds.push(missingGenerationId);
      retainProjectAgentRunReference(generation.capability, missingGenerationId, [
        generation.capture,
      ]);
      const missingDir = writeStatus(missingGenerationId, root, generation.capture);
      asyncDirs.push(missingDir);
      const staleAccess = {
        capability: generation.capability,
        expected: {
          ...getProjectAgentSnapshotProvenance(generation.capability),
          generationId: "missing-generation",
        },
        architect: true,
      };
      const missingExecutor = createSubagentExecutor({
        pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
        state,
        config: { maxSubagentDepth: 2, control: {} } as any,
        tempArtifactsDir: root,
        getSubagentSessionRoot: () => root,
        expandTilde: (value) => value,
        discoverAgents: () => ({ agents: [] }),
        getProjectAgentAccess: () => staleAccess,
        kill: () => true,
      });
      const missingResult = await missingExecutor.execute(
        "resume",
        { action: "resume", id: missingGenerationId, message: "Check missing generation." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(missingResult.isError, true);
      assert.match(text(missingResult), /invalid|generation|capability|rejected/i);
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects removed, empty, out-of-range, cohort-paused, and mixed ordinary child markers before steering", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-steer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-steer");
    const state = createState();
    const executor = makeExecutor(root, state, { capability: generation.capability });
    const runIds: string[] = [];
    try {
      const missingMarkerId = `project-steer-marker-${Date.now().toString(36)}`;
      runIds.push(missingMarkerId);
      retainProjectAgentRunReference(generation.capability, missingMarkerId, [generation.capture]);
      const missingMarkerDir = writeStatus(missingMarkerId, root, generation.capture);
      const missingMarkerStatus = JSON.parse(
        fs.readFileSync(path.join(missingMarkerDir, "status.json"), "utf8"),
      );
      delete missingMarkerStatus.steps[0].projectAgent;
      writeJson(path.join(missingMarkerDir, "status.json"), missingMarkerStatus);
      const missingMarker = await executor.execute(
        "steer",
        { action: "steer", id: missingMarkerId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(missingMarker.isError, true);
      assert.match(text(missingMarker), /missing|corrupt|project-agent/i);

      const emptyId = `project-steer-empty-${Date.now().toString(36)}`;
      runIds.push(emptyId);
      retainProjectAgentRunReference(generation.capability, emptyId, [generation.capture]);
      const emptyDir = writeStatus(emptyId, root, generation.capture, { steps: [] });
      const empty = await executor.execute(
        "steer",
        { action: "steer", id: emptyId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(empty.isError, true);
      assert.match(text(empty), /no selectable|project-agent/i);
      assert.equal(fs.existsSync(path.join(emptyDir, "control", "steer-requests")), false);

      const rangeId = `project-steer-range-${Date.now().toString(36)}`;
      runIds.push(rangeId);
      retainProjectAgentRunReference(generation.capability, rangeId, [generation.capture]);
      writeStatus(rangeId, root, generation.capture, { state: "running" });
      const range = await executor.execute(
        "steer",
        { action: "steer", id: rangeId, index: 3, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(range.isError, true);
      assert.match(text(range), /out of range|project-agent/i);

      const cohortId = `project-steer-cohort-${Date.now().toString(36)}`;
      runIds.push(cohortId);
      retainProjectAgentRunReference(generation.capability, cohortId, [generation.capture]);
      const cohortDir = writeStatus(cohortId, root, generation.capture, {
        state: "paused",
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "paused",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(cohortId), "one.jsonl"),
          },
          {
            agent: generation.capture.provenance.agent,
            status: "paused",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(cohortId), "two.jsonl"),
          },
        ],
      });
      fs.writeFileSync(path.join(runAsyncDir(cohortId), "two.jsonl"), "", "utf8");
      const cohort = await executor.execute(
        "steer",
        { action: "steer", id: cohortId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(cohort.isError, true);
      assert.match(text(cohort), /no running or pending|project-agent/i);
      assert.equal(fs.existsSync(path.join(cohortDir, "control", "steer-requests")), false);

      const mixedId = `project-steer-mixed-${Date.now().toString(36)}`;
      runIds.push(mixedId);
      retainProjectAgentRunReference(generation.capability, mixedId, [generation.capture]);
      const mixedDir = writeStatus(mixedId, root, generation.capture, {
        state: "running",
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "running",
            projectAgent: generation.capture,
            sessionFile: path.join(runAsyncDir(mixedId), "one.jsonl"),
          },
          {
            agent: "worker",
            status: "running",
            sessionFile: path.join(runAsyncDir(mixedId), "two.jsonl"),
          },
        ],
      });
      fs.writeFileSync(path.join(runAsyncDir(mixedId), "two.jsonl"), "", "utf8");
      const mixed = await executor.execute(
        "steer",
        { action: "steer", id: mixedId, message: "Do not select an ordinary sibling." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(mixed.isError, true);
      assert.match(text(mixed), /ordinary sibling|matching retained|project-agent/i);
      assert.equal(fs.existsSync(path.join(mixedDir, "control", "steer-requests")), false);
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists a foreground pause capture and resumes it after a generation reload", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-foreground-pause-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const first = createProjectGeneration(
      root,
      "session-project",
      "generation-foreground-one",
      "embedded.worker",
      "Foreground original",
      "foreground-digest-one",
    );
    const second = createProjectGeneration(
      root,
      "session-project",
      "generation-foreground-two",
      "embedded.worker",
      "Foreground reloaded",
      "foreground-digest-two",
    );
    let active = first;
    let pausedRunId = "";
    let resumedRunId = "";
    const state = createState();
    const executor = makeExecutor(
      root,
      state,
      {
        get capability() {
          return active.capability;
        },
      } as any,
      {
        runSync: async (
          _cwd: string,
          _agents: any[],
          _agent: string,
          _task: string,
          options: any,
        ) => {
          pausedRunId = options.runId;
          fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
          fs.writeFileSync(options.sessionFile, "", "utf8");
          const result = {
            agent: "embedded.worker",
            task: "foreground pause",
            projectAgent: first.capture,
            exitCode: 0,
            interrupted: true,
            finalOutput: "Paused foreground child.",
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
            sessionFile: options.sessionFile,
            pause: { kind: "awaiting_supervisor", summary: "Need supervisor input." },
          };
          options.onSupervisorPauseTransition?.({ stage: "pausing", result, ownerPid: 12345 });
          options.onSupervisorPauseTransition?.({ stage: "paused", result });
          return result;
        },
        executeAsyncSingle: (runId: string, params: any) => {
          resumedRunId = runId;
          return {
            content: [{ type: "text", text: "resumed" }],
            details: { asyncId: runId, results: [] },
            params,
          };
        },
      },
    );
    try {
      const initial = await executor.execute(
        "foreground",
        {
          agent: "embedded.worker",
          task: "foreground pause",
          agentScope: "project",
        },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(initial.isError, undefined);
      assert.ok(pausedRunId);
      const persistedPath = path.join(ASYNC_DIR, pausedRunId, "status.json");
      const persisted = JSON.parse(fs.readFileSync(persistedPath, "utf8"));
      assert.deepEqual(persisted.steps?.[0]?.projectAgent, first.capture);
      assert.equal(persisted.steps?.[0]?.projectAgent?.config.systemPrompt, "Foreground original");
      fs.rmSync(first.capture.config.filePath, { force: true });
      active = second;

      delete persisted.steps[0].projectAgent;
      writeJson(persistedPath, persisted);
      const removedMarker = await executor.execute(
        "foreground-resume-removed-marker",
        { action: "resume", id: pausedRunId, message: "Do not bypass." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(removedMarker.isError, true);
      assert.match(text(removedMarker), /missing|corrupt|project-agent/i);
      persisted.steps[0].projectAgent = first.capture;
      writeJson(persistedPath, persisted);

      const resumed = await executor.execute(
        "foreground-resume",
        { action: "resume", id: pausedRunId, message: "Continue after reload." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(resumed.isError, undefined);
      assert.ok(resumedRunId);
      assert.equal(lookupProjectAgentRunReference(resumedRunId).status, "found");
    } finally {
      releaseProjectAgentRunReference(pausedRunId);
      if (resumedRunId) releaseProjectAgentRunReference(resumedRunId);
      revokeIfRegistered(first.capability);
      revokeIfRegistered(second.capability);
      fs.rmSync(path.join(ASYNC_DIR, pausedRunId), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains complete and failed project generations beyond the UI cleanup window", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-retention-")),
    );
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-terminal-retention",
    );
    retainProjectAgentSnapshotReference(generation.capability, "terminal-retention-test-owner");
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(runAsyncDir("placeholder")),
      {
        completionRetentionMs: 5,
        projectAgentTerminalRetentionMs: 40,
        resultsDir: path.join(root, "results"),
      },
    );
    const runIds: string[] = [];
    try {
      for (const [index, success] of [true, false].entries()) {
        const runId = `project-terminal-${success ? "complete" : "failed"}-${Date.now().toString(36)}-${index}`;
        runIds.push(runId);
        const asyncDir = writeStatus(runId, root, generation.capture, {
          state: success ? "complete" : "failed",
        });
        retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
        state.asyncJobs.set(runId, {
          asyncId: runId,
          asyncDir,
          status: "running",
          updatedAt: Date.now(),
        });
        tracker.handleComplete({
          id: runId,
          asyncDir,
          success,
          sessionId: "session-project",
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(lookupProjectAgentRunReference(runId).status, "found");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
    } finally {
      tracker.resetJobs();
      for (const runId of runIds) {
        releaseProjectAgentRunReference(runId);
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentSnapshotReference("terminal-retention-test-owner");
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves pending terminal cleanup across a same-session tracker reset", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-reset-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-tracker-reset");
    const runId = `project-tracker-reset-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture, { state: "complete" });
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 60 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        success: true,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      tracker.resetJobs();
      assert.equal(state.asyncJobs.size, 0, "reset still clears UI job state");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "same-session reset must not release before the terminal window",
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "missing",
        "preserved timer must release at the configured bounded window",
      );
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let reset cleanup release a reference reused in another session", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-reuse-")),
    );
    const previousGeneration = createProjectGeneration(
      root,
      "session-project-old",
      "generation-tracker-reuse-old",
    );
    const nextGeneration = createProjectGeneration(
      root,
      "session-project-new",
      "generation-tracker-reuse-new",
    );
    const runId = `project-tracker-reuse-${Date.now().toString(36)}`;
    retainProjectAgentSnapshotReference(nextGeneration.capability, "tracker-reuse-next-owner");
    const asyncDir = writeStatus(runId, root, previousGeneration.capture, {
      state: "complete",
    });
    retainProjectAgentRunReference(previousGeneration.capability, runId, [
      previousGeneration.capture,
    ]);
    const state = createState();
    state.currentSessionId = "session-project-old";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 45 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        success: true,
        sessionId: "session-project-old",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      state.currentSessionId = "session-project-new";
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      retainProjectAgentRunReference(nextGeneration.capability, runId, [nextGeneration.capture]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "a session reset must not prematurely release the reused id",
      );
      await new Promise((resolve) => setTimeout(resolve, 45));
      assert.equal(
        lookupProjectAgentRunReference(runId).status,
        "found",
        "the stale timer must not release the new session reference",
      );
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      releaseProjectAgentSnapshotReference("tracker-reuse-next-owner");
      revokeIfRegistered(previousGeneration.capability);
      revokeIfRegistered(nextGeneration.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases a continued project cohort once every sibling is terminal", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-cohort-")),
    );
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-terminal-cohort",
    );
    const runId = `project-terminal-cohort-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    fs.mkdirSync(asyncDir, { recursive: true });
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "continued",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "continued",
          projectAgent: generation.capture,
        },
        { agent: "ordinary", status: "complete" },
      ],
    });
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 40 },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains continued/cancelled cohorts for terminal project siblings with usable sessions", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-terminal-sibling-")),
    );
    const firstAgent = makeAgent(root, "embedded.worker", "Selected project prompt");
    const siblingAgent = makeAgent(root, "embedded.reviewer", "Terminal sibling prompt");
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "session-project",
      generationId: "generation-terminal-sibling",
      entries: [
        { agent: firstAgent as never, digest: "digest-worker", frontmatterFields: ["tools"] },
        { agent: siblingAgent as never, digest: "digest-reviewer", frontmatterFields: ["tools"] },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const captures = [
      createProjectAgentRunCapture(manifest, firstAgent as never),
      createProjectAgentRunCapture(manifest, siblingAgent as never),
    ];
    retainProjectAgentSnapshotReference(capability, "terminal-sibling-test-owner");
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(runAsyncDir("placeholder")),
      { completionRetentionMs: 5, projectAgentTerminalRetentionMs: 40 },
    );
    const runIds: string[] = [];
    try {
      for (const terminalState of ["continued", "cancelled"] as const) {
        for (const siblingState of ["complete", "failed"] as const) {
          const runId = `project-terminal-sibling-${terminalState}-${siblingState}-${Date.now().toString(36)}`;
          runIds.push(runId);
          const asyncDir = runAsyncDir(runId);
          const selectedSession = path.join(asyncDir, "worker.jsonl");
          const siblingSession = path.join(asyncDir, "reviewer.jsonl");
          fs.mkdirSync(asyncDir, { recursive: true });
          fs.writeFileSync(selectedSession, "", "utf8");
          fs.writeFileSync(siblingSession, "", "utf8");
          writeJson(path.join(asyncDir, "status.json"), {
            runId,
            mode: "parallel",
            state: terminalState,
            sessionId: "session-project",
            cwd: root,
            startedAt: Date.now(),
            lastUpdate: Date.now(),
            steps: [
              {
                agent: captures[0]!.provenance.agent,
                status: terminalState,
                sessionFile: selectedSession,
                projectAgent: captures[0],
              },
              {
                agent: captures[1]!.provenance.agent,
                status: siblingState,
                sessionFile: siblingSession,
                projectAgent: captures[1],
              },
            ],
          });
          retainProjectAgentRunReference(capability, runId, captures);
          state.asyncJobs.set(runId, {
            asyncId: runId,
            asyncDir,
            status: "running",
            updatedAt: Date.now(),
          });
          tracker.handleComplete({
            id: runId,
            asyncDir,
            state: terminalState,
            success: false,
            sessionId: "session-project",
          });
          await new Promise((resolve) => setTimeout(resolve, 15));
          assert.equal(lookupProjectAgentRunReference(runId).status, "found");
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
          releaseProjectAgentRunReference(runId);
          state.asyncJobs.clear();
          fs.rmSync(asyncDir, { recursive: true, force: true });
        }
      }
    } finally {
      tracker.resetJobs();
      for (const runId of runIds) {
        releaseProjectAgentRunReference(runId);
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentSnapshotReference("terminal-sibling-test-owner");
      revokeIfRegistered(capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not release a continued async reference while a sibling remains resumable", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-tracker-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-tracker");
    const runId = `project-tracker-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    const siblingSession = path.join(asyncDir, "sibling.jsonl");
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(siblingSession, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "continued",
          projectAgent: generation.capture,
        },
        { agent: "ordinary", status: "paused", sessionFile: siblingSession },
      ],
    });
    const state = createState();
    state.currentSessionId = "session-project";
    const tracker = createAsyncJobTracker(
      { events: { emit() {} } } as any,
      state,
      path.dirname(asyncDir),
      { completionRetentionMs: 5, resultsDir: path.join(root, "results") },
    );
    try {
      state.asyncJobs.set(runId, {
        asyncId: runId,
        asyncDir,
        status: "running",
        updatedAt: Date.now(),
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");

      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "parallel",
        state: "continued",
        sessionId: "session-project",
        cwd: root,
        startedAt: 100,
        lastUpdate: Date.now(),
        steps: [
          {
            agent: generation.capture.provenance.agent,
            status: "continued",
            projectAgent: generation.capture,
          },
          { agent: "ordinary", status: "continued", sessionFile: siblingSession },
        ],
      });
      tracker.handleComplete({
        id: runId,
        asyncDir,
        state: "continued",
        success: false,
        sessionId: "session-project",
      });
      assert.equal(lookupProjectAgentRunReference(runId).status, "missing");
    } finally {
      tracker.resetJobs();
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not release a paused foreground reference when its in-memory projection is evicted", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-lru-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-lru");
    const runId = `project-lru-${Date.now().toString(36)}`;
    retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    const asyncDir = runAsyncDir(runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: generation.capture.provenance.agent,
          status: "paused",
          sessionFile,
          projectAgent: generation.capture,
        },
      ],
    });
    const state = createState();
    state.foregroundRuns = new Map(
      Array.from({ length: 51 }, (_, index) => {
        const id = index === 0 ? runId : `foreground-complete-${index}-${Date.now().toString(36)}`;
        return [
          id,
          {
            runId: id,
            mode: "parallel",
            cwd: root,
            updatedAt: index,
            children:
              index === 0
                ? [{ agent: generation.capture.provenance.agent, status: "paused", sessionFile }]
                : [{ agent: "worker", status: "completed" }],
          },
        ];
      }),
    ) as any;
    try {
      trimRememberedForegroundRuns(state);
      assert.equal(state.foregroundRuns?.has(runId), false);
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");
    } finally {
      releaseProjectAgentRunReference(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects capture-bearing controls when the private reference is missing", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-ordinary-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-ordinary");
    const state = createState();
    const runId = `ordinary-steer-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(path.join(asyncDir, "worker.jsonl"), "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "running",
      pid: 12345,
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      steps: [
        {
          agent: "worker",
          status: "running",
          sessionFile: path.join(asyncDir, "worker.jsonl"),
          // Artifact presence alone must not turn an ordinary control into a
          // project authorization path when no private run reference exists.
          projectAgent: generation.capture,
        },
      ],
    });
    try {
      const executor = makeExecutor(root, state, {
        capability: generation.capability,
        architect: false,
      });
      const result = await executor.execute(
        "steer",
        { action: "steer", id: runId, message: "Do not fall back." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      const requestDir = path.join(asyncDir, "control", "steer-requests");
      assert.equal(fs.existsSync(requestDir), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies marker-bearing resume before same-name profile discovery", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-missing-resume-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-missing-resume",
    );
    const runId = `project-missing-resume-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture);
    const impostor = {
      ...makeAgent(root, generation.capture.provenance.agent, "Profile impostor"),
      packageName: "profile",
      source: "user",
      filePath: path.join(root, "profile", "impostor.md"),
    };
    let discoveryCalls = 0;
    let dispatchCalls = 0;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability },
      {
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [impostor] };
        },
        executeAsyncSingle: () => {
          dispatchCalls++;
          return { content: [{ type: "text", text: "forged dispatch" }], details: { results: [] } };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not dispatch the profile impostor." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(discoveryCalls, 0);
      assert.equal(dispatchCalls, 0);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed retained project identity before continuation spawn", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-malformed-identity-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const malformedAgent = { ...makeAgent(root, "embedded.worker"), tools: [] };
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "session-project",
      generationId: "generation-malformed-identity",
      entries: [
        {
          agent: malformedAgent as never,
          digest: "digest-malformed-identity",
          frontmatterFields: ["tools"],
        },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, malformedAgent as never);
    const runId = `project-malformed-identity-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, capture);
    retainProjectAgentRunReference(capability, runId, [capture]);
    let continuationSpawned = false;
    const executor = makeExecutor(
      root,
      createState(),
      { capability },
      {
        executeAsyncSingle: (continuationId: string) => {
          continuationSpawned = true;
          return {
            content: [{ type: "text", text: "forged continuation" }],
            details: { asyncId: continuationId, results: [] },
          };
        },
      },
    );
    try {
      const result = await executor.execute(
        "resume-malformed-identity",
        { action: "resume", id: runId, message: "Do not continue malformed identity." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /does not carry an explicit usable tools list/);
      assert.equal(continuationSpawned, false);
      assert.equal(lookupProjectAgentRunReference(runId).status, "found");
      assert.equal(fs.existsSync(path.join(asyncDir, "control")), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies marker-bearing steer for architect and non-architect paths without a reference", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-missing-steer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-missing-steer");
    const runIds = [
      `project-missing-steer-architect-${Date.now().toString(36)}`,
      `project-missing-steer-nonarchitect-${Date.now().toString(36)}`,
    ];
    const asyncDirs = runIds.map((runId) =>
      writeStatus(runId, root, generation.capture, { state: "running" }),
    );
    try {
      for (const [index, architect] of [true, false].entries()) {
        const executor = makeExecutor(root, createState(), {
          capability: generation.capability,
          architect,
        });
        const result = await executor.execute(
          "steer",
          { action: "steer", id: runIds[index], message: "Do not fall back." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true, architect ? "architect" : "non-architect");
        assert.match(text(result), /private reference|project-agent|fallback/i);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "steer-requests")),
          false,
        );
      }
    } finally {
      for (const runId of runIds) cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      for (const asyncDir of asyncDirs) fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when interrupting a project run loses its process-private reference", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-marker-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-interrupt");
    const runIds = [
      `project-interrupt-marker-architect-${Date.now().toString(36)}`,
      `project-interrupt-marker-nonarchitect-${Date.now().toString(36)}`,
    ];
    const asyncDirs = runIds.map((runId) =>
      writeStatus(runId, root, generation.capture, { state: "running" }),
    );
    try {
      for (const [index, architect] of [true, false].entries()) {
        let signalled = false;
        const executor = makeExecutor(
          root,
          createState(),
          { capability: generation.capability, architect },
          { kill: () => (signalled = true) },
        );
        // The run is intentionally not retained in the current process. An
        // interrupt must not silently become ordinary control over a persisted
        // project marker, regardless of primary mode.
        const result = await executor.execute(
          `interrupt-project-marker-${architect ? "architect" : "nonarchitect"}`,
          { action: "interrupt", id: runIds[index]! },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true);
        assert.match(text(result), /private reference|project-agent|fallback/i);
        assert.equal(signalled, false);
        assert.equal(
          fs.existsSync(path.join(asyncDirs[index]!, "control", "interrupt.json")),
          false,
        );
      }
    } finally {
      for (const asyncDir of asyncDirs) fs.rmSync(asyncDir, { recursive: true, force: true });
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires interrupt resolution to match retained project runs and preserves ordinary errors", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-prefix-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-interrupt-prefix",
    );
    const suffix = Date.now().toString(36);
    const projectRunId = `target-project-${suffix}`;
    const mismatchedRunId = `target-other-${suffix}`;
    const ordinaryRunId = `ordinary-interrupt-${suffix}`;
    const ambiguousRunIds = [
      `ambiguous-project-interrupt-a-${suffix}`,
      `ambiguous-project-interrupt-b-${suffix}`,
    ];
    const genericAmbiguousRunIds = [
      `generic-interrupt-a-${suffix}`,
      `generic-interrupt-b-${suffix}`,
    ];
    const mismatchedDir = writeStatus(mismatchedRunId, root, generation.capture, {
      state: "running",
    });
    const ordinaryDir = writeStatus(ordinaryRunId, root, generation.capture, {
      state: "running",
    });
    for (const asyncDir of [mismatchedDir, ordinaryDir]) {
      const statusPath = path.join(asyncDir, "status.json");
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      delete status.steps[0].projectAgent;
      writeJson(statusPath, status);
    }
    retainProjectAgentRunReference(generation.capability, projectRunId, [generation.capture]);
    for (const runId of ambiguousRunIds) {
      retainProjectAgentRunReference(generation.capability, runId, [generation.capture]);
    }
    try {
      let signalled = false;
      const executor = makeExecutor(
        root,
        createState(),
        { capability: generation.capability },
        { kill: () => (signalled = true) },
      );
      const mismatched = await executor.execute(
        "interrupt-prefix-mismatch",
        { action: "interrupt", id: "target-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(mismatched.isError, true);
      assert.match(text(mismatched), /does not match the resolved interrupt target/);
      assert.equal(signalled, false);
      assert.equal(fs.existsSync(path.join(mismatchedDir, "control", "interrupt.json")), false);

      const ambiguous = await executor.execute(
        "interrupt-prefix-ambiguous",
        { action: "interrupt", id: "ambiguous-project-interrupt-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ambiguous.isError, true);
      assert.match(text(ambiguous), /TLH project-agent control rejected/);
      assert.match(text(ambiguous), /ambiguous in the retained project-agent registry/);
      assert.equal(signalled, false);

      const ordinary = await executor.execute(
        "interrupt-ordinary",
        { action: "interrupt", id: ordinaryRunId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ordinary.isError, undefined, text(ordinary));
      assert.match(text(ordinary), /Interrupt requested for async run/);
      assert.doesNotMatch(text(ordinary), /TLH project-agent control rejected/);
      assert.equal(signalled, true);
      assert.equal(fs.existsSync(path.join(ordinaryDir, "control", "interrupt.json")), true);

      for (const runId of genericAmbiguousRunIds) {
        fs.mkdirSync(runAsyncDir(runId), { recursive: true });
      }
      const genericAmbiguous = await executor.execute(
        "interrupt-generic-prefix-ambiguous",
        { action: "interrupt", id: "generic-interrupt-" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(genericAmbiguous.isError, true);
      assert.match(text(genericAmbiguous), /Ambiguous subagent run id prefix/);
      assert.doesNotMatch(text(genericAmbiguous), /TLH project-agent control rejected/);
    } finally {
      for (const runId of genericAmbiguousRunIds) {
        fs.rmSync(runAsyncDir(runId), { recursive: true, force: true });
      }
      releaseProjectAgentRunReference(projectRunId);
      for (const runId of ambiguousRunIds) releaseProjectAgentRunReference(runId);
      cleanupRun(mismatchedRunId);
      cleanupRun(ordinaryRunId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps marker-free ordinary resume and steer behavior unchanged", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-ordinary-marker-free-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-ordinary-free");
    const impostor = {
      ...makeAgent(root, generation.capture.provenance.agent, "Profile ordinary agent"),
      packageName: "profile",
      source: "user",
      filePath: path.join(root, "profile", "ordinary.md"),
    };
    const resumeId = `ordinary-resume-${Date.now().toString(36)}`;
    const steerId = `ordinary-steer-${Date.now().toString(36)}`;
    const resumeDir = writeStatus(resumeId, root, generation.capture);
    const steerDir = writeStatus(steerId, root, generation.capture, { state: "running" });
    for (const statusPath of [
      path.join(resumeDir, "status.json"),
      path.join(steerDir, "status.json"),
    ]) {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      delete status.steps[0].projectAgent;
      writeJson(statusPath, status);
    }
    let discoveryCalls = 0;
    let dispatchCalls = 0;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability, architect: false },
      {
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [impostor] };
        },
        executeAsyncSingle: (runId: string) => {
          dispatchCalls++;
          return {
            content: [{ type: "text", text: "ordinary resumed" }],
            details: { asyncId: runId, results: [] },
          };
        },
      },
    );
    try {
      const resumed = await executor.execute(
        "resume",
        { action: "resume", id: resumeId, message: "Continue ordinary work." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(resumed.isError, undefined);
      const steered = await executor.execute(
        "steer",
        { action: "steer", id: steerId, message: "Steer ordinary work." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(steered.isError, undefined);
      assert.equal(discoveryCalls, 1);
      assert.equal(dispatchCalls, 1);
      assert.ok(fs.existsSync(path.join(steerDir, "control", "steer-requests")));
    } finally {
      cleanupRun(resumeId);
      cleanupRun(steerId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(resumeDir, { recursive: true, force: true });
      fs.rmSync(steerDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("authorizes the concrete interrupt fallback target before no-id and dir-only signaling", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-interrupt-fallback-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-interrupt-fallback",
    );
    const projectRunId = `project-interrupt-fallback-${Date.now().toString(36)}`;
    const projectAsyncDir = writeStatus(projectRunId, root, generation.capture, {
      state: "running",
    });
    let ordinaryRunId: string | undefined;
    const state = createState();
    state.asyncJobs.set(projectRunId, {
      asyncId: projectRunId,
      asyncDir: projectAsyncDir,
      status: "running",
      pid: 12345,
      updatedAt: 0,
      projectAgents: [generation.capture],
    });
    let signalCalls = 0;
    const executor = makeExecutor(
      root,
      state,
      { capability: generation.capability },
      {
        kill: () => {
          signalCalls++;
          return true;
        },
      },
    );
    try {
      const noId = await executor.execute(
        "interrupt-no-id-project",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(noId.isError, true);
      assert.match(text(noId), /private reference|project-agent|fallback/i);
      assert.equal(signalCalls, 0);
      assert.equal(fs.existsSync(path.join(projectAsyncDir, "control", "interrupt.json")), false);

      const dirOnly = await executor.execute(
        "interrupt-dir-only-project",
        { action: "interrupt", dir: projectAsyncDir },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(dirOnly.isError, true);
      assert.match(text(dirOnly), /private reference|project-agent|fallback/i);
      assert.equal(signalCalls, 0);

      ordinaryRunId = `ordinary-interrupt-fallback-${Date.now().toString(36)}`;
      const ordinaryDir = writeStatus(ordinaryRunId, root, generation.capture, {
        state: "running",
      });
      const ordinaryStatusPath = path.join(ordinaryDir, "status.json");
      const ordinaryStatus = JSON.parse(fs.readFileSync(ordinaryStatusPath, "utf8"));
      delete ordinaryStatus.steps[0].projectAgent;
      writeJson(ordinaryStatusPath, ordinaryStatus);
      state.asyncJobs.set(ordinaryRunId, {
        asyncId: ordinaryRunId,
        asyncDir: ordinaryDir,
        status: "running",
        pid: 12345,
        updatedAt: Date.now() + 1000,
        projectAgents: undefined,
      });
      assert.equal(Object.hasOwn(state.asyncJobs.get(ordinaryRunId)!, "projectAgents"), true);
      const explicitOrdinary = await executor.execute(
        "interrupt-explicit-ordinary",
        { action: "interrupt", id: ordinaryRunId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(explicitOrdinary.isError, undefined, text(explicitOrdinary));
      assert.match(text(explicitOrdinary), /Interrupt requested for async run/);
      assert.equal(signalCalls > 0, true);
      const signalsAfterExplicit = signalCalls;
      const ordinary = await executor.execute(
        "interrupt-no-id-ordinary",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(ordinary.isError, undefined, text(ordinary));
      assert.match(
        text(ordinary),
        new RegExp(`Interrupt requested for async run ${ordinaryRunId}`),
      );
      assert.equal(signalCalls > signalsAfterExplicit, true);
      assert.equal(fs.existsSync(path.join(ordinaryDir, "control", "interrupt.json")), true);
    } finally {
      if (ordinaryRunId) cleanupRun(ordinaryRunId);
      cleanupRun(projectRunId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps no-id and dir-only ordinary paused interrupts on async handling", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-paused-ordinary-interrupt-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-paused-ordinary-interrupt",
    );
    const runId = `paused-ordinary-interrupt-${Date.now().toString(36)}`;
    const asyncDir = runAsyncDir(runId);
    const sessionFile = path.join(asyncDir, "worker.jsonl");
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf8");
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "paused",
      pid: 12345,
      sessionId: "session-project",
      cwd: root,
      startedAt: 100,
      lastUpdate: Date.now(),
      sessionFile,
      pause: { kind: "awaiting_supervisor", pausedAt: Date.now() },
      steps: [{ agent: "ordinary", status: "paused", sessionFile }],
    });
    const state = createState();
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir,
      status: "running",
      pid: 12345,
      updatedAt: Date.now(),
      projectAgents: undefined,
    });
    const executor = makeExecutor(root, state, { capability: generation.capability });
    try {
      for (const params of [
        { action: "interrupt" as const },
        { action: "interrupt" as const, dir: asyncDir },
      ]) {
        const result = await executor.execute(
          "interrupt-paused-ordinary",
          params,
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(result.isError, true);
        assert.match(text(result), /No running async run|interrupt-capable pid/i);
        const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
        assert.equal(persisted.state, "paused");
        assert.equal(persisted.cancel, undefined);
      }
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when no-id interrupt falls through to a project-marked foreground run", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-foreground-fallback-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-foreground-fallback",
    );
    const runId = `project-foreground-fallback-${Date.now().toString(36)}`;
    const state = createState();
    let signalled = false;
    state.foregroundRuns!.set(runId, {
      runId,
      mode: "single",
      cwd: root,
      updatedAt: Date.now(),
      children: [
        {
          agent: generation.capture.provenance.agent,
          index: 0,
          status: "running",
          projectAgent: generation.capture,
        },
      ],
    } as never);
    state.foregroundControls.set(runId, {
      runId,
      mode: "single",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      interrupt: () => {
        signalled = true;
        return true;
      },
    } as never);
    state.lastForegroundControlId = runId;
    const executor = makeExecutor(root, state, { capability: generation.capability });
    try {
      const result = await executor.execute(
        "interrupt-no-id-foreground-project",
        { action: "interrupt" },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);
    } finally {
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("authorizes a same-id async fallback independently of a foreground registry entry", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-dual-interrupt-registry-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-dual-interrupt-registry",
    );
    const runId = `dual-interrupt-registry-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture, { state: "running" });
    const state = createState();
    state.foregroundRuns!.set(runId, {
      runId,
      mode: "single",
      cwd: root,
      updatedAt: Date.now(),
      children: [{ agent: "ordinary", index: 0, status: "completed" }],
    } as never);
    state.asyncJobs.set(runId, {
      asyncId: runId,
      asyncDir,
      status: "running",
      pid: 12345,
      updatedAt: Date.now() + 1,
      projectAgents: undefined,
    });
    let signalled = false;
    const executor = makeExecutor(
      root,
      state,
      { capability: generation.capability },
      { kill: () => (signalled = true) },
    );
    try {
      const result = await executor.execute(
        "interrupt-dual-registry",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);
      assert.equal(fs.existsSync(path.join(asyncDir, "control", "interrupt.json")), false);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies malformed project markers instead of degrading to profile control", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-malformed-marker-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-malformed-marker",
    );
    const runId = `project-malformed-marker-${Date.now().toString(36)}`;
    const asyncDir = writeStatus(runId, root, generation.capture);
    const statusPath = path.join(asyncDir, "status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    delete status.steps[0].projectAgent;
    status.projectAgents = [generation.capture];
    writeJson(statusPath, status);
    let discoveryCalls = 0;
    let signalled = false;
    const executor = makeExecutor(
      root,
      createState(),
      { capability: generation.capability },
      {
        kill: () => {
          signalled = true;
          return true;
        },
        discoverAgents: () => {
          discoveryCalls++;
          return { agents: [makeAgent(root, generation.capture.provenance.agent)] };
        },
      },
    );
    try {
      const inventoryResult = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not degrade from a run inventory." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(inventoryResult.isError, true);
      assert.match(text(inventoryResult), /private reference|project-agent|fallback/i);
      assert.equal(discoveryCalls, 0);
      const interruptResult = await executor.execute(
        "interrupt",
        { action: "interrupt", id: runId },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(interruptResult.isError, true);
      assert.match(text(interruptResult), /private reference|project-agent|fallback/i);
      assert.equal(signalled, false);

      status.projectAgents = [{ forged: true }];
      writeJson(statusPath, status);
      const result = await executor.execute(
        "resume",
        { action: "resume", id: runId, message: "Do not degrade malformed markers." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, true);
      assert.match(text(result), /invalid|project-agent|rejected/i);
      assert.equal(discoveryCalls, 0);
    } finally {
      cleanupRun(runId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies project-marked nested steer without a private reference and preserves marker-free nested steer", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-nested-steer-")),
    );
    const generation = createProjectGeneration(root, "session-project", "generation-nested-steer");
    const rootRunId = `nested-control-root-${Date.now().toString(36)}`;
    const projectRunId = `nested-project-${Date.now().toString(36)}`;
    const ordinaryRunId = `nested-ordinary-${Date.now().toString(36)}`;
    const route = createNestedRoute(rootRunId);
    const nestedRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId);
    const projectAsyncDir = path.join(nestedRoot, projectRunId);
    const ordinaryAsyncDir = path.join(nestedRoot, ordinaryRunId);
    const writeNestedStatus = (runId: string, asyncDir: string) => {
      fs.mkdirSync(asyncDir, { recursive: true });
      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "single",
        state: "running",
        sessionId: "session-project",
        cwd: root,
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        steps: [{ agent: "nested-worker", status: "running" }],
      });
    };
    writeNestedStatus(projectRunId, projectAsyncDir);
    writeNestedStatus(ordinaryRunId, ordinaryAsyncDir);
    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: Date.now(),
      parentRunId: rootRunId,
      child: {
        id: projectRunId,
        parentRunId: rootRunId,
        depth: 1,
        path: [{ runId: rootRunId }],
        state: "running",
        agent: generation.capture.provenance.agent,
        asyncDir: projectAsyncDir,
        projectAgent: generation.capture,
      },
    });
    writeNestedEvent(route, {
      type: "subagent.nested.started",
      ts: Date.now() + 1,
      parentRunId: rootRunId,
      child: {
        id: ordinaryRunId,
        parentRunId: rootRunId,
        depth: 1,
        path: [{ runId: rootRunId }],
        state: "running",
        agent: "nested-worker",
        asyncDir: ordinaryAsyncDir,
      },
    });
    const state = createState();
    state.currentSessionId = "session-project";
    state.asyncJobs.set(rootRunId, {
      asyncId: rootRunId,
      asyncDir: path.join(ASYNC_DIR, rootRunId),
      status: "running",
      nestedRoute: route,
    } as never);
    try {
      for (const architect of [true, false]) {
        const executor = makeExecutor(root, state, {
          capability: generation.capability,
          architect,
        });
        const denied = await executor.execute(
          "steer",
          { action: "steer", id: projectRunId, message: "Do not bypass nested project control." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(denied.isError, true, architect ? "architect" : "non-architect");
        assert.match(text(denied), /nested|private reference|project-agent|fallback/i);
        const compatible = await executor.execute(
          "steer",
          { action: "steer", id: ordinaryRunId, message: "Steer ordinary nested work." },
          new AbortController().signal,
          undefined,
          makeContext(root),
        );
        assert.equal(compatible.isError, undefined);
        assert.match(text(compatible), /Steering queued for nested async run/);
      }
    } finally {
      revokeIfRegistered(generation.capability);
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
      fs.rmSync(nestedRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed nested project-agent event and status markers", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-nested-malformed-")),
    );
    const generation = createProjectGeneration(
      root,
      "session-project",
      "generation-nested-malformed",
    );
    const rootRunId = `nested-malformed-root-${Date.now().toString(36)}`;
    const resumeRunId = `nested-malformed-resume-${Date.now().toString(36)}`;
    const steerRunId = `nested-malformed-steer-${Date.now().toString(36)}`;
    const interruptRunId = `nested-malformed-interrupt-${Date.now().toString(36)}`;
    const foundInterruptRunId = `nested-malformed-found-interrupt-${Date.now().toString(36)}`;
    const route = createNestedRoute(rootRunId);
    const nestedRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId);
    const parentSessionFile = path.join(root, "parent.jsonl");
    const resumeSessionFile = path.join(root, resumeRunId, "session.jsonl");
    fs.mkdirSync(path.dirname(resumeSessionFile), { recursive: true });
    fs.writeFileSync(parentSessionFile, "", "utf8");
    fs.writeFileSync(resumeSessionFile, "", "utf8");

    const interruptProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const interruptPid = interruptProcess.pid;
    if (typeof interruptPid !== "number" || interruptPid <= 0) {
      interruptProcess.kill();
      throw new Error("Failed to start disposable interrupt fixture process.");
    }

    const writeNestedStatus = (
      runId: string,
      state: "running" | "complete",
      step: Record<string, unknown>,
      pid = process.pid,
    ): string => {
      const asyncDir = path.join(nestedRoot, runId);
      fs.mkdirSync(asyncDir, { recursive: true });
      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "single",
        state,
        pid,
        sessionId: "session-project",
        cwd: root,
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        steps: [step as never],
      });
      return asyncDir;
    };

    const resumeAsyncDir = writeNestedStatus(resumeRunId, "complete", {
      agent: "nested-worker",
      status: "complete",
      sessionFile: resumeSessionFile,
      projectAgent: { forged: true },
    });
    const steerAsyncDir = writeNestedStatus(steerRunId, "running", {
      agent: "nested-worker",
      status: "running",
      projectAgent: { forged: true },
    });
    const interruptAsyncDir = writeNestedStatus(
      interruptRunId,
      "running",
      {
        agent: "nested-worker",
        status: "running",
        projectAgent: { forged: true },
      },
      interruptPid,
    );
    const foundInterruptAsyncDir = writeNestedStatus(
      foundInterruptRunId,
      "running",
      {
        agent: "nested-worker",
        status: "running",
      },
      interruptPid,
    );

    const resumeChild = {
      id: resumeRunId,
      parentRunId: rootRunId,
      depth: 1,
      path: [{ runId: rootRunId }],
      state: "complete" as const,
      agent: "nested-worker",
      asyncDir: resumeAsyncDir,
      sessionFile: resumeSessionFile,
    };
    writeNestedEvent(route, {
      type: "subagent.nested.completed",
      ts: Date.now(),
      parentRunId: rootRunId,
      child: resumeChild,
    });

    const steerChild = {
      id: steerRunId,
      parentRunId: rootRunId,
      depth: 1,
      path: [{ runId: rootRunId }],
      state: "running" as const,
      agent: "nested-worker",
      asyncDir: steerAsyncDir,
      steps: [{ agent: "nested-worker", status: "running" as const }],
    };
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: Date.now() + 1,
      parentRunId: rootRunId,
      child: steerChild,
    });

    const interruptChild = {
      id: interruptRunId,
      parentRunId: rootRunId,
      depth: 1,
      path: [{ runId: rootRunId }],
      state: "running" as const,
      agent: "nested-worker",
      asyncDir: interruptAsyncDir,
    };
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: Date.now() + 2,
      parentRunId: rootRunId,
      child: interruptChild,
    });

    const malformedInterruptChild = {
      id: foundInterruptRunId,
      parentRunId: rootRunId,
      depth: 1,
      path: [{ runId: rootRunId }],
      state: "running" as const,
      agent: "nested-worker",
      asyncDir: foundInterruptAsyncDir,
    };
    Reflect.set(malformedInterruptChild, "projectAgent", { forged: true });
    writeNestedEvent(route, {
      type: "subagent.nested.updated",
      ts: Date.now() + 3,
      parentRunId: rootRunId,
      child: malformedInterruptChild,
    });

    retainProjectAgentRunReference(generation.capability, interruptRunId, [generation.capture]);
    retainProjectAgentRunReference(generation.capability, foundInterruptRunId, [
      generation.capture,
    ]);
    const state = createState();
    state.currentSessionId = "session-project";
    state.asyncJobs.set(rootRunId, {
      asyncId: rootRunId,
      asyncDir: path.join(ASYNC_DIR, rootRunId),
      status: "running",
      nestedRoute: route,
    } as never);
    const executor = makeExecutor(root, state, { capability: generation.capability });
    const context = makeContext(root);
    context.sessionManager.getSessionFile = () => parentSessionFile;

    try {
      const steerStatusPath = path.join(steerAsyncDir, "status.json");
      const steerStatus = JSON.parse(fs.readFileSync(steerStatusPath, "utf8"));
      delete steerStatus.steps[0].projectAgent;
      writeJson(steerStatusPath, steerStatus);
      const baselineSteer = await executor.execute(
        "nested-baseline-steer",
        { action: "steer", id: steerRunId, message: "Baseline direct steer would write." },
        new AbortController().signal,
        undefined,
        context,
      );
      assert.equal(baselineSteer.isError, undefined, text(baselineSteer));
      assert.equal(
        text(baselineSteer),
        `Steering queued for nested async run ${steerRunId}. Delivery requires a live Pi child session that supports mid-run steering.`,
      );
      const steerRequestsPath = path.join(steerAsyncDir, "control", "steer-requests");
      assert.equal(fs.existsSync(steerRequestsPath), true);
      fs.rmSync(steerRequestsPath, { recursive: true, force: true });
      steerStatus.steps[0].projectAgent = { forged: true };
      writeJson(steerStatusPath, steerStatus);

      const resume = await executor.execute(
        "nested-malformed-resume",
        { action: "resume", id: resumeRunId, message: "Do not bypass the malformed marker." },
        new AbortController().signal,
        undefined,
        context,
      );
      assert.equal(resume.isError, true);
      assert.equal(
        text(resume),
        `TLH project-agent control rejected: Nested run '${resumeRunId}' has a malformed project-agent marker in persisted status.`,
      );

      const steer = await executor.execute(
        "nested-malformed-steer",
        { action: "steer", id: steerRunId, message: "Do not bypass the malformed marker." },
        new AbortController().signal,
        undefined,
        context,
      );
      assert.equal(steer.isError, true);
      assert.equal(
        text(steer),
        "TLH project-agent control rejected: the nested target has a malformed project-agent marker; refusing steer fallback.",
      );
      assert.equal(fs.existsSync(path.join(steerAsyncDir, "control", "steer-requests")), false);

      const interrupt = await executor.execute(
        "nested-malformed-interrupt",
        { action: "interrupt", id: interruptRunId },
        new AbortController().signal,
        undefined,
        context,
      );
      assert.equal(interrupt.isError, true);
      assert.equal(
        text(interrupt),
        "TLH project-agent control rejected: the nested target has a malformed project-agent marker; refusing interrupt fallback.",
      );
      assert.equal(fs.existsSync(path.join(interruptAsyncDir, "control", "interrupt.json")), false);

      const foundInterrupt = await executor.execute(
        "nested-malformed-found-interrupt",
        { action: "interrupt", id: foundInterruptRunId },
        new AbortController().signal,
        undefined,
        context,
      );
      assert.equal(foundInterrupt.isError, true);
      assert.equal(
        text(foundInterrupt),
        "TLH project-agent control rejected: the nested target carries a malformed or unavailable project-agent marker; refusing nested interrupt fallback.",
      );
      assert.equal(
        fs.existsSync(path.join(foundInterruptAsyncDir, "control", "interrupt.json")),
        false,
      );
    } finally {
      releaseProjectAgentRunReference(interruptRunId);
      releaseProjectAgentRunReference(foundInterruptRunId);
      interruptProcess.kill();
      revokeIfRegistered(generation.capability);
      fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
      fs.rmSync(nestedRoot, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("transfers the private reference to a continuation before source release", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "tlh-project-control-transfer-")),
    );
    execFileSync("git", ["init", "--quiet", root]);
    const generation = createProjectGeneration(root, "session-project", "generation-transfer");
    const sourceId = `project-transfer-source-${Date.now().toString(36)}`;
    writeStatus(sourceId, root, generation.capture);
    retainProjectAgentRunReference(generation.capability, sourceId, [generation.capture]);
    let continuationId = "";
    try {
      retainProjectAgentRunReferenceFrom(sourceId, "project-transfer-direct");
      assert.equal(
        getProjectAgentRunReferenceMetadata("project-transfer-direct")?.[0]?.generationId,
        "generation-transfer",
      );
      releaseProjectAgentRunReference("project-transfer-direct");
      const executor = makeExecutor(
        root,
        createState(),
        { capability: generation.capability },
        {
          executeAsyncSingle: (runId: string) => {
            continuationId = runId;
            return {
              content: [{ type: "text", text: "continued" }],
              details: { asyncId: runId, results: [] },
            };
          },
        },
      );
      const result = await executor.execute(
        "resume",
        { action: "resume", id: sourceId, message: "Continue." },
        new AbortController().signal,
        undefined,
        makeContext(root),
      );
      assert.equal(result.isError, undefined);
      assert.ok(continuationId);
      assert.equal(lookupProjectAgentRunReference(continuationId).status, "found");
      // The complete source is retained for its normal terminal window; it was
      // not released merely because a continuation was launched.
      assert.equal(lookupProjectAgentRunReference(sourceId).status, "found");
    } finally {
      releaseProjectAgentRunReference(sourceId);
      if (continuationId) releaseProjectAgentRunReference(continuationId);
      cleanupRun(sourceId);
      revokeIfRegistered(generation.capability);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
