/**
 * Characterization tests for the subagent async-only dispatch contract.
 *
 * These tests pin the contracts that hold after the async-only switch:
 *   - async omitted → background (asyncId returned, runSync not called)
 *   - async:false   → rejected before any side effect
 *   - async:true    → background (unchanged)
 *   - print/rpc mode → new dispatch and resume rejected; observational actions pass
 *   - Historical paused-foreground resume → background continuation (unchanged)
 *
 * Epic: remove synchronous/foreground execution from the first-party subagent
 * tool; keep only async/background runs.
 *
 * Ticket: tlhf-5veu (converted from tlhf-dfoe characterization tests)
 *
 * Running: node scripts/run-subagents-tests.mjs unit
 *   (uses isolate-temp-root.mjs — ASYNC_DIR is redirected to a per-process
 *    isolated temp root so fixture writes never pollute live sessions)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import {
  ASYNC_DIR,
  type AcceptanceLedger,
  type ForegroundResumeRun,
  type ResolvedAcceptanceConfig,
  type SubagentState,
} from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import {
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  releaseProjectAgentRunReference,
} from "../../src/agents/project-agent-snapshot.ts";
import type { ProjectAgentSnapshotCapability } from "../../src/agents/project-agent-snapshot.ts";
import {
  makeAgent as makeSupportAgent,
  makeMinimalCtx,
  makeSubagentState,
} from "../support/helpers.ts";

import {
  createProjectGeneration,
  makeAgent as makeProjectAgent,
  makeContext as makeProjectContext,
  makeExecutor as makeProjectExecutor,
  revokeIfRegistered,
  text as extractText,
} from "../support/project-agent-control-fixtures.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";

// ---------------------------------------------------------------------------
// Module-level cleanup
// ---------------------------------------------------------------------------

const _tempDirs: string[] = [];
const _capabilitiesToRevoke: ProjectAgentSnapshotCapability[] = [];
const _runIdsToRelease: string[] = [];

after(() => {
  for (const capability of _capabilitiesToRevoke) {
    revokeIfRegistered(capability);
  }
  for (const runId of _runIdsToRelease) {
    try {
      releaseProjectAgentRunReference(runId);
    } catch {
      // best-effort
    }
    fs.rmSync(path.join(ASYNC_DIR, runId), { recursive: true, force: true });
  }
  for (const dir of _tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Common executor helpers
// ---------------------------------------------------------------------------

type AsyncSingleSeam = (
  runId: string,
  params: Record<string, unknown>,
) => {
  content: Array<{ type: string; text: string }>;
  details: { asyncId: string; results: unknown[] };
};

type AsyncParallelSeam = (
  runId: string,
  params: Record<string, unknown>,
) => {
  content: Array<{ type: string; text: string }>;
  details: { asyncId: string; results: unknown[]; mode: string };
};

function makeExecutor(
  sessionRoot: string,
  state: SubagentState,
  options: {
    executeAsyncSingle?: AsyncSingleSeam;
    executeAsyncParallel?: AsyncParallelSeam;
    config?: Record<string, unknown>;
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
      getSessionName() {
        return "parent";
      },
    } as any,
    state,
    config: { maxSubagentDepth: 2, control: {}, ...options.config } as any,
    tempArtifactsDir: sessionRoot,
    getSubagentSessionRoot: () => sessionRoot,
    expandTilde: (v: string) => v,
    discoverAgents: () => ({
      agents: [
        makeSupportAgent("echo", { description: "Echo agent" }),
        makeSupportAgent("second", { description: "Second agent" }),
      ],
    }),
    ...(options.executeAsyncSingle
      ? { executeAsyncSingle: options.executeAsyncSingle as any }
      : {}),
    ...(options.executeAsyncParallel
      ? { executeAsyncParallel: options.executeAsyncParallel as any }
      : {}),
  });
}

function makeExecutorCapturing(
  sessionRoot: string,
  config?: Record<string, unknown>,
): {
  executor: ReturnType<typeof makeExecutor>;
  asyncCalls: Array<{ runId: string; params: unknown }>;
  parallelCalls: Array<{ runId: string; params: unknown }>;
  state: SubagentState;
} {
  const asyncCalls: Array<{ runId: string; params: unknown }> = [];
  const parallelCalls: Array<{ runId: string; params: unknown }> = [];
  const state = makeSubagentState({ baseCwd: sessionRoot });
  const executor = makeExecutor(sessionRoot, state, {
    config,
    executeAsyncSingle: (runId: string, params: Record<string, unknown>) => {
      asyncCalls.push({ runId, params });
      return {
        content: [{ type: "text", text: "async-seam-ok" }],
        details: { asyncId: runId, results: [] },
      };
    },
    // Seam for parallel dispatch: prevents real background-runner spawns that
    // would create temp dirs (and potentially recreate dirs after afterEach
    // cleanup), causing temp-dir leaks detected by run-test-tmpdir-guard.mjs.
    executeAsyncParallel: (runId: string, params: Record<string, unknown>) => {
      parallelCalls.push({ runId, params });
      return {
        content: [{ type: "text", text: "parallel-seam-ok" }],
        details: { asyncId: runId, results: [], mode: "parallel" },
      };
    },
  });
  return { executor, asyncCalls, parallelCalls, state };
}

// ---------------------------------------------------------------------------
// Paused foreground run fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal well-formed acceptance ledger for a paused child.
 * status:"skipped" with a non-none effective level triggers continuationAcceptance forwarding.
 */
function makeSkippedAcceptanceLedger(): AcceptanceLedger {
  const effectiveAcceptance: ResolvedAcceptanceConfig = {
    level: "checked",
    explicit: true,
    inferredReason: [],
    criteria: [],
    evidence: [],
    verify: [],
    stopRules: [],
  };
  return {
    status: "skipped",
    explicit: true,
    effectiveAcceptance,
    inferredReason: [],
    criteria: [],
    runtimeChecks: [],
    verifyRuns: [],
  };
}

/**
 * Build and register a paused foreground run in state and write its persisted
 * status under ASYNC_DIR.  Returns a cleanup function that removes the
 * artifacts.
 */
function setupPausedForegroundRun(
  state: SubagentState,
  root: string,
  options: {
    runId?: string;
    agent?: string;
    acceptance?: AcceptanceLedger;
    activeRuntimeMs?: number;
    modelIdentity?: { provider: string; model: string };
  } = {},
): { runId: string; sessionFile: string; asyncDir: string; cleanup: () => void } {
  const runId = options.runId ?? `paused-fg-${Date.now().toString(36)}`;
  const agent = options.agent ?? "echo";
  const sessionFile = path.join(root, `${runId}-session.jsonl`);
  const asyncDir = path.join(ASYNC_DIR, runId);

  // Create session file (required by resolveForegroundResumeTarget)
  fs.writeFileSync(sessionFile, "", "utf-8");

  // Write the paused status to ASYNC_DIR (required by claimPausedAwaitingSupervisorTarget)
  fs.mkdirSync(asyncDir, { recursive: true });
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    mode: "single",
    state: "paused",
    startedAt: Date.now() - 10_000,
    lastUpdate: Date.now(),
    cwd: root,
    steps: [
      {
        agent,
        status: "paused",
        sessionFile,
        pause: { kind: "awaiting_supervisor" as const, summary: "Needs supervisor input." },
        // Acceptance must be present in the ASYNC status step — resolveAsyncResumeTarget
        // rejects paused steps with no acceptance ledger.
        acceptance: makeSkippedAcceptanceLedger() as any,
        ...(options.activeRuntimeMs !== undefined
          ? { activeRuntimeMs: options.activeRuntimeMs }
          : {}),
        ...(options.modelIdentity !== undefined ? { modelIdentity: options.modelIdentity } : {}),
      },
    ],
    pause: {
      kind: "awaiting_supervisor",
      summary: "Needs supervisor input.",
    },
  });

  // Paused children MUST have a well-formed acceptance ledger —
  // resolveForegroundResumeTarget enforces this and rejects otherwise.
  const defaultAcceptance = makeSkippedAcceptanceLedger();

  // Populate state.foregroundRuns (required by resolveRememberedForegroundRun)
  const foregroundRun: ForegroundResumeRun = {
    runId,
    mode: "single",
    cwd: root,
    updatedAt: Date.now(),
    children: [
      {
        agent,
        index: 0,
        status: "paused",
        sessionFile,
        pause: { kind: "awaiting_supervisor" as const, summary: "Needs supervisor input." },
        acceptance: options.acceptance ?? defaultAcceptance,
        ...(options.activeRuntimeMs !== undefined
          ? { activeRuntimeMs: options.activeRuntimeMs }
          : {}),
        ...(options.modelIdentity !== undefined ? { modelIdentity: options.modelIdentity } : {}),
      },
    ],
  };
  state.foregroundRuns ??= new Map();
  state.foregroundRuns.set(runId, foregroundRun);

  const cleanup = () => {
    fs.rmSync(asyncDir, { recursive: true, force: true });
    try {
      fs.rmSync(sessionFile, { force: true });
    } catch {
      // best-effort
    }
  };

  return { runId, sessionFile, asyncDir, cleanup };
}

// ---------------------------------------------------------------------------
// (a) Async-only dispatch routing tests
// ---------------------------------------------------------------------------

describe("async-only dispatch routing", () => {
  // -----------------------------------------------------------------------
  // async parameter: omitted / false / true  (single run)
  // -----------------------------------------------------------------------

  it("async omitted dispatches as background — asyncId returned", async () => {
    const root = makeTempDir("tlh-ao-omitted-");
    const { executor, asyncCalls } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { agent: "echo", task: "hello" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    // Background job was started.
    assert.ok(result.details?.asyncId, "expected asyncId for omitted-async dispatch");
    assert.equal(result.isError, undefined);
    // The seam was used.
    assert.equal(asyncCalls.length, 1, "executeAsyncSingle seam must be called once");
  });

  it("async:false is rejected — isError true, no side effects (no asyncCalls, no session dir)", async () => {
    const sessions: string[] = [];
    const asyncCalls: Array<{ runId: string; params: unknown }> = [];
    const root = makeTempDir("tlh-ao-false-");
    const state = makeSubagentState({ baseCwd: root });
    const executor = createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state,
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: () => {
        const dir = makeTempDir("tlh-ao-sessions-");
        sessions.push(dir);
        return dir;
      },
      expandTilde: (v: string) => v,
      discoverAgents: () => ({
        agents: [makeSupportAgent("echo", { description: "Echo agent" })],
      }),
      executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
        asyncCalls.push({ runId, params });
        return {
          content: [{ type: "text", text: "seam" }],
          details: { asyncId: runId, results: [] },
        };
      }) as any,
    });

    const result = await executor.execute(
      "id",
      { agent: "echo", task: "hello", async: false },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true, "async:false must be rejected");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /async:false is no longer supported/i);
    assert.equal(
      asyncCalls.length,
      0,
      "executeAsyncSingle must not be called when async:false is rejected",
    );
    // No session dir should have been created (getSubagentSessionRoot must not be invoked)
    assert.equal(
      sessions.length,
      0,
      "getSubagentSessionRoot must not be called when async:false is rejected",
    );
  });

  it("async:true returns an asyncId (background)", async () => {
    const root = makeTempDir("tlh-ao-true-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { agent: "echo", task: "hello", async: true },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    // Result carries an asyncId — the background run was registered.
    assert.ok(result.details?.asyncId, "expected asyncId for async:true dispatch");
    assert.equal(result.isError, undefined);
  });

  // -----------------------------------------------------------------------
  // async parameter: parallel mode
  // -----------------------------------------------------------------------

  it("parallel + async:false is rejected — isError, no asyncCalls", async () => {
    const root = makeTempDir("tlh-ao-false-parallel-");
    const { executor, asyncCalls } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      {
        tasks: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: false,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true, "parallel async:false must be rejected");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /async:false is no longer supported/i);
    assert.equal(asyncCalls.length, 0, "executeAsyncSingle must not be called");
  });

  it("parallel + async:true returns asyncId", async () => {
    const root = makeTempDir("tlh-ao-true-parallel-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      {
        tasks: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.ok(result.details?.asyncId, "expected asyncId for async:true parallel dispatch");
    assert.equal(result.details?.mode, "parallel");
    assert.equal(result.isError, undefined);
  });

  // -----------------------------------------------------------------------
  // count expansion
  // -----------------------------------------------------------------------

  it("tasks[].count expands to N background runs — asyncId returned, no runSync calls", async () => {
    const root = makeTempDir("tlh-ao-count-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { tasks: [{ agent: "echo", task: "repeat", count: 3 }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details?.mode, "parallel");
    // Parallel dispatch goes through executeAsyncParallel (not the executeAsyncSingle seam);
    // verify asyncId is present in the result receipt.
    assert.ok(result.details?.asyncId, "expected asyncId for count-expanded parallel dispatch");
  });

  // -----------------------------------------------------------------------
  // Session directory is created BEFORE dispatch (for async:true / omitted)
  // but NOT created for async:false (rejected before any side effect)
  // -----------------------------------------------------------------------

  it("session dir is created for background dispatch (async omitted) before returning asyncId", async () => {
    const sessions: string[] = [];
    const root = makeTempDir("tlh-ao-sessdir-omitted-");
    const state = makeSubagentState({ baseCwd: root });
    const executor = createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state,
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: () => {
        const dir = makeTempDir("tlh-ao-sessions-");
        sessions.push(dir);
        return dir;
      },
      expandTilde: (v: string) => v,
      discoverAgents: () => ({
        agents: [makeSupportAgent("echo", { description: "Echo" })],
      }),
      // Seam for async dispatch: prevents a real detached-runner spawn that
      // would write files under the session dir and potentially recreate it
      // after after() cleanup, causing temp-dir leaks.
      executeAsyncSingle: ((runId: string) => ({
        content: [{ type: "text", text: "seam-ok" }],
        details: { asyncId: runId, results: [] },
      })) as any,
    });

    const result = await executor.execute(
      "id",
      { agent: "echo", task: "check session dir" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, undefined);
    assert.ok(result.details?.asyncId);
    assert.ok(
      sessions.length > 0,
      "expected getSubagentSessionRoot to be called for background dispatch",
    );
  });

  it("async:false rejected before session dir is created — getSubagentSessionRoot not called", async () => {
    const sessions: string[] = [];
    const root = makeTempDir("tlh-ao-sessdir-false-");
    const state = makeSubagentState({ baseCwd: root });
    const executor = createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state,
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: () => {
        const dir = makeTempDir("tlh-ao-sessions-");
        sessions.push(dir);
        return dir;
      },
      expandTilde: (v: string) => v,
      discoverAgents: () => ({
        agents: [makeSupportAgent("echo", { description: "Echo" })],
      }),
    });

    const result = await executor.execute(
      "id",
      { agent: "echo", task: "check session dir", async: false },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true, "async:false must be rejected");
    assert.equal(
      sessions.length,
      0,
      "getSubagentSessionRoot must not be called when async:false is rejected",
    );
  });

  // -----------------------------------------------------------------------
  // Action routing — observational actions always work
  // -----------------------------------------------------------------------

  it("action:list routes to agent-management and succeeds (not an error)", async () => {
    const root = makeTempDir("tlh-ao-list-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "list" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.ok(
      !result.isError,
      `expected no error, got: ${result.content.map((c) => (c.type === "text" ? c.text : "")).join("")}`,
    );
  });

  it("action:get for an unknown agent returns an error in management mode", async () => {
    const root = makeTempDir("tlh-ao-get-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "get", agent: "nonexistent-agent" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "management");
    assert.equal(result.isError, true);
  });

  it("action:status with no running run delegates to inspectSubagentStatus (mode:'single')", async () => {
    const root = makeTempDir("tlh-ao-status-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "status" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "single");
  });

  it("action:doctor returns management mode with a diagnostic report", async () => {
    const root = makeTempDir("tlh-ao-doctor-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "doctor" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "management");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.ok(text.length > 0, "expected a non-empty doctor report");
  });

  it("action:interrupt with no active run returns a management-mode result", async () => {
    const root = makeTempDir("tlh-ao-interrupt-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "interrupt" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "management");
  });

  it("action:steer with no active run returns a management-mode result", async () => {
    const root = makeTempDir("tlh-ao-steer-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "steer", message: "Go left" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "management");
  });

  it("action:resume with no matching run returns an error in management mode", async () => {
    const root = makeTempDir("tlh-ao-resume-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "resume", id: "nonexistent-run-id" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.details?.mode, "management");
    assert.equal(result.isError, true);
  });

  it("unknown action is rejected with an error listing valid actions", async () => {
    const root = makeTempDir("tlh-ao-unknown-action-");
    const { executor } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { action: "create" as any },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /Unknown action: create/);
    assert.match(text, /Valid:/);
  });

  it("rejects action='single' instead of treating it as execution", async () => {
    const root = makeTempDir("tlh-ao-single-alias-");
    const { executor, asyncCalls, parallelCalls } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "single-alias",
      { action: "single" as any, agent: "echo", task: "Run through alias" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /Unknown action: single/);
    assert.equal(asyncCalls.length, 0);
    assert.equal(parallelCalls.length, 0);
  });

  it("rejects arbitrary unknown action strings without launching", async () => {
    const root = makeTempDir("tlh-ao-unknown-arbitrary-");
    const { executor, asyncCalls, parallelCalls } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "unknown-action",
      { action: "not-a-real-action" as any, agent: "echo", task: "Should not run" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /Unknown action: not-a-real-action/);
    assert.match(text, /Valid:/);
    assert.equal(asyncCalls.length, 0);
    assert.equal(parallelCalls.length, 0);
  });

  // -----------------------------------------------------------------------
  // Background dispatch does NOT set foregroundControl
  // -----------------------------------------------------------------------

  it("background dispatch (async omitted) does not set foregroundControl — foregroundControls remains empty", async () => {
    const root = makeTempDir("tlh-ao-bg-ctrl-");
    let capturedForegroundControlsSize = -1;
    const asyncCalls: Array<{ runId: string; params: unknown }> = [];
    const state = makeSubagentState({ baseCwd: root });

    const executor = createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state,
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: () => root,
      expandTilde: (v: string) => v,
      discoverAgents: () => ({
        agents: [makeSupportAgent("echo", { description: "Echo" })],
      }),
      executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
        // Capture foregroundControls size at seam-call time
        capturedForegroundControlsSize = state.foregroundControls.size;
        asyncCalls.push({ runId, params });
        return {
          content: [{ type: "text", text: "async-seam-ok" }],
          details: { asyncId: runId, results: [] },
        };
      }) as any,
    });

    await executor.execute(
      "id",
      { agent: "echo", task: "supervisor test" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(asyncCalls.length, 1, "executeAsyncSingle seam was not called");
    // Background dispatch never sets foregroundControl
    assert.equal(
      capturedForegroundControlsSize,
      0,
      "foregroundControls must be empty during background dispatch",
    );
    assert.equal(
      state.foregroundControls.size,
      0,
      "foregroundControls must be empty after background dispatch",
    );
  });

  // -----------------------------------------------------------------------
  // async:false on action:resume is also rejected
  // -----------------------------------------------------------------------

  it("action:resume with async:false is rejected before any side effects", async () => {
    const root = makeTempDir("tlh-ao-resume-false-");
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root);

    try {
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Continue", async: false },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );

      assert.equal(result.isError, true, "async:false on resume must be rejected");
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      assert.match(text, /async:false is no longer supported/i);
      // executeAsyncSingle must not have been called
      assert.equal(
        asyncCalls.length,
        0,
        "executeAsyncSingle must not be called when async:false on resume",
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Hermetic foreground resume tests
//
// All tests inject the executeAsyncSingle seam so no child process is spawned.
// ASYNC_DIR is redirected by isolate-temp-root.mjs (loaded by the test runner)
// so writes to ASYNC_DIR do not pollute live sessions.
// ---------------------------------------------------------------------------

describe("async-only — hermetic paused-foreground resume", () => {
  it(
    "resume of a supervisor-paused run dispatches to background via seam" +
      " — correct agent, mode:'management', asyncId set",
    async () => {
      const root = makeTempDir("tlh-ao-resume-hermetic-");
      const { executor, asyncCalls, state } = makeExecutorCapturing(root);
      const { runId, cleanup } = setupPausedForegroundRun(state, root);

      try {
        const result = await executor.execute(
          "id",
          { action: "resume", id: runId, message: "Continue now" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(root),
        );

        // No error.
        assert.equal(result.isError, undefined);
        // Dispatched to background.
        assert.equal(asyncCalls.length, 1, "executeAsyncSingle seam must be called once");
        // The seam received the correct agent.
        const dispatchedParams = asyncCalls[0]!.params as Record<string, unknown>;
        assert.equal(dispatchedParams.agent, "echo");
        // asyncId reflects the new continuation run
        const newRunId = asyncCalls[0]!.runId;
        assert.ok(newRunId, "expected a continuation runId from the seam");
        assert.equal(result.details?.asyncId, newRunId);
      } finally {
        cleanup();
      }
    },
  );

  it(
    "second resume of same paused run is rejected while claimed" + " — duplicate-resume exclusion",
    async () => {
      const root = makeTempDir("tlh-ao-resume-dup-");
      const { executor, asyncCalls, state } = makeExecutorCapturing(root);
      const { runId, cleanup } = setupPausedForegroundRun(state, root);

      try {
        // First resume: should claim and succeed.
        const first = await executor.execute(
          "id-1",
          { action: "resume", id: runId, message: "First resume" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(root),
        );
        assert.equal(first.isError, undefined, "first resume should succeed");
        assert.equal(asyncCalls.length, 1, "first resume must call the seam once");

        // Status file should now show the lifecycle phase as "launched"
        const status = readStatus(path.join(ASYNC_DIR, runId));
        const continuation = status?.lifecycle?.continuation;
        assert.ok(
          continuation?.phase === "launched" || continuation?.phase === "reserved",
          `expected lifecycle phase to be launched or reserved after first resume, got '${continuation?.phase}'`,
        );

        // Second resume: should be rejected.
        const second = await executor.execute(
          "id-2",
          { action: "resume", id: runId, message: "Second resume" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(root),
        );
        assert.equal(second.isError, true, "second resume must fail");
        const secondText = second.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.match(secondText, /already claimed|already launched|cannot be resumed/i);
        // Seam must not have been called a second time.
        assert.equal(asyncCalls.length, 1, "executeAsyncSingle must not be called again");
      } finally {
        cleanup();
      }
    },
  );

  it("continuationAcceptance from paused child is forwarded to background continuation", async () => {
    const root = makeTempDir("tlh-ao-resume-acceptance-");
    const acceptance = makeSkippedAcceptanceLedger();
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root, { acceptance });

    try {
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Resume with acceptance" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );
      assert.equal(result.isError, undefined);
      assert.equal(asyncCalls.length, 1);

      const dispatchedParams = asyncCalls[0]!.params as Record<string, unknown>;
      assert.ok(
        dispatchedParams.continuationAcceptance,
        "expected continuationAcceptance to be forwarded",
      );
      assert.equal(
        (dispatchedParams.continuationAcceptance as Record<string, unknown>).level,
        "checked",
      );
    } finally {
      cleanup();
    }
  });

  it("activeRuntimeMs from paused child is carried over to background continuation", async () => {
    const root = makeTempDir("tlh-ao-resume-runtime-");
    const activeRuntimeMs = 45_000;
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root, { activeRuntimeMs });

    try {
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Resume with runtime" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );
      assert.equal(result.isError, undefined);
      assert.equal(asyncCalls.length, 1);

      const dispatchedParams = asyncCalls[0]!.params as Record<string, unknown>;
      assert.ok(
        typeof dispatchedParams.activeRuntimeMs === "number",
        "expected activeRuntimeMs to be forwarded",
      );
      assert.ok(
        (dispatchedParams.activeRuntimeMs as number) >= activeRuntimeMs,
        `expected activeRuntimeMs >= ${activeRuntimeMs}, got ${dispatchedParams.activeRuntimeMs}`,
      );
    } finally {
      cleanup();
    }
  });

  it("modelIdentity from paused child is restored as restoredModelIdentity in continuation", async () => {
    const root = makeTempDir("tlh-ao-resume-model-");
    const modelIdentity = { provider: "anthropic", model: "claude-opus-4-5" };
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root, { modelIdentity });

    try {
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Resume with model" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );
      assert.equal(result.isError, undefined);
      assert.equal(asyncCalls.length, 1);

      const dispatchedParams = asyncCalls[0]!.params as Record<string, unknown>;
      const restored = dispatchedParams.restoredModelIdentity as
        | { provider: string; model: string }
        | undefined;
      assert.ok(restored, "expected restoredModelIdentity to be forwarded");
      assert.equal(restored.provider, modelIdentity.provider);
      assert.equal(restored.model, modelIdentity.model);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Supervisor pause/cancel: interrupt of a paused foreground run
// ---------------------------------------------------------------------------

describe("async-only — supervisor pause/cancel", () => {
  it(
    "interrupt of a supervisor-paused foreground run cancels it" +
      " — status transitions to cancelled, result is management mode",
    async () => {
      const root = makeTempDir("tlh-ao-interrupt-paused-");
      const { executor, state } = makeExecutorCapturing(root);

      const { runId, asyncDir, cleanup } = setupPausedForegroundRun(state, root);
      state.foregroundControls.delete(runId);

      try {
        const result = await executor.execute(
          "id",
          { action: "interrupt", id: runId },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(root),
        );

        assert.equal(result.isError, undefined, "cancellation of a paused run should succeed");
        assert.equal(result.details?.mode, "management");
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        assert.match(text, /Cancelled/i);

        const status = readStatus(asyncDir);
        assert.ok(
          status?.state === "cancelled" || status?.steps?.[0]?.status === "cancelled",
          `expected status to be cancelled, got ${status?.state} / step ${status?.steps?.[0]?.status}`,
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// (a) Project-agent (embedded.*) dispatch authorization
// ---------------------------------------------------------------------------

describe("async-only — project-agent dispatch authorization", () => {
  it("embedded.* dispatch with no capability is rejected before async dispatch", async () => {
    const root = makeTempDir("tlh-ao-proj-no-cap-");
    const { executor, asyncCalls } = makeExecutorCapturing(root);

    const result = await executor.execute(
      "id",
      { agent: "embedded.worker", task: "do something", agentScope: "project" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /unavailable|invalid|rejected/i);
    assert.equal(
      asyncCalls.length,
      0,
      "executeAsyncSingle must not be called when capability is missing",
    );
  });

  it("embedded.* dispatch with canInitiate:false (non-architect mode) is rejected before spawn", async () => {
    const root = makeTempDir("tlh-ao-proj-no-init-");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const agentDef = makeProjectAgent(root, "embedded.worker");
    const capability = registerProjectAgentSnapshot({
      projectRoot: root,
      sessionId: "session-no-init",
      generationId: "gen-no-init",
      entries: [
        { agent: agentDef as never, digest: "digest-no-init", frontmatterFields: ["tools"] },
      ],
    });
    _capabilitiesToRevoke.push(capability);
    const expected = getProjectAgentSnapshotProvenance(capability);

    const asyncCalls: Array<{ runId: string; params: unknown }> = [];
    const executor = createSubagentExecutor({
      pi: {
        events: {
          emit() {},
          on() {
            return () => {};
          },
        },
        getSessionName() {
          return "parent";
        },
      } as any,
      state: makeSubagentState({ baseCwd: root }),
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: root,
      getSubagentSessionRoot: () => root,
      expandTilde: (v: string) => v,
      discoverAgents: () => ({ agents: [] }),
      getProjectAgentAccess: () => ({
        capability,
        expected,
        architect: false,
        canInitiate: false,
      }),
      executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
        asyncCalls.push({ runId, params });
        return {
          content: [{ type: "text", text: "seam" }],
          details: { asyncId: runId, results: [] },
        };
      }) as any,
    });

    const result = await executor.execute(
      "id",
      {
        agent: "embedded.worker",
        task: "do something",
        agentScope: "project",
        cwd: root,
      },
      new AbortController().signal,
      undefined,
      {
        ...makeMinimalCtx(root),
        sessionManager: {
          getSessionId: () => "session-no-init",
          getSessionFile: () => undefined,
          getBranch: () => [],
        } as any,
      },
    );

    assert.equal(result.isError, true);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /requires.*architect|disabled.*primary|architect.*disabled/i);
    assert.equal(
      asyncCalls.length,
      0,
      "executeAsyncSingle must not be called when canInitiate is false",
    );
  });

  it("embedded.* dispatch with valid capability and architect access dispatches as background", async () => {
    const root = fs.realpathSync(makeTempDir("tlh-ao-proj-auth-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });

    const sessionId = "session-auth-dispatch";
    const { capability } = createProjectGeneration(
      root,
      sessionId,
      "gen-auth-dispatch",
      "embedded.worker",
      "Worker prompt for dispatch test",
    );
    _capabilitiesToRevoke.push(capability);

    const asyncCalls: Array<{ runId: string; params: unknown }> = [];
    const executor = makeProjectExecutor(
      root,
      makeSubagentState({ baseCwd: root, currentSessionId: sessionId }),
      { capability, architect: true, reauthorize: async () => true },
      {
        executeAsyncSingle: ((runId: string, params: Record<string, unknown>) => {
          asyncCalls.push({ runId, params });
          return {
            content: [{ type: "text", text: "async-seam-ok" }],
            details: { asyncId: runId, results: [] },
          };
        }) as any,
      },
    );

    const result = await executor.execute(
      "id",
      {
        agent: "embedded.worker",
        task: "inspect the project",
        agentScope: "project",
        cwd: root,
      },
      new AbortController().signal,
      undefined,
      makeProjectContext(root, sessionId),
    );

    assert.equal(result.isError, undefined, extractText(result));
    // Background dispatch: executeAsyncSingle seam must be called, not runSync
    assert.equal(
      asyncCalls.length,
      1,
      "expected one background dispatch for authorized embedded.* agent",
    );
    assert.ok(
      result.details?.asyncId,
      "expected asyncId in result for authorized embedded.* dispatch",
    );
  });
});

// ---------------------------------------------------------------------------
// (a) print/rpc mode gate
//
// New dispatch and resume are rejected in print/rpc mode.
// Observational actions (list, get, status, interrupt, steer, doctor) still work.
// ---------------------------------------------------------------------------

describe("async-only — print/rpc mode gate", () => {
  it("dispatch in print mode is rejected — isError true", async () => {
    const root = makeTempDir("tlh-ao-print-dispatch-");
    const { executor, asyncCalls } = makeExecutorCapturing(root);

    const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
    const result = await executor.execute(
      "id",
      { agent: "echo", task: "print mode dispatch" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true, "dispatch in print mode must be rejected");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /not available in non-interactive mode/i);
    assert.equal(asyncCalls.length, 0, "executeAsyncSingle must not be called in print mode");
  });

  it("dispatch in rpc mode is rejected — isError true", async () => {
    const root = makeTempDir("tlh-ao-rpc-dispatch-");
    const { executor, asyncCalls } = makeExecutorCapturing(root);

    const ctx = { ...makeMinimalCtx(root), mode: "rpc" as const };
    const result = await executor.execute(
      "id",
      { agent: "echo", task: "rpc mode dispatch" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true, "dispatch in rpc mode must be rejected");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /not available in non-interactive mode/i);
    assert.equal(asyncCalls.length, 0, "executeAsyncSingle must not be called in rpc mode");
  });

  it("resume in print mode is rejected — isError true, executeAsyncSingle not called", async () => {
    const root = makeTempDir("tlh-ao-print-resume-");
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root);

    try {
      const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Resume in print mode" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(result.isError, true, "resume in print mode must be rejected");
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      assert.match(text, /not available in non-interactive mode/i);
      assert.equal(asyncCalls.length, 0, "executeAsyncSingle must not be called in print mode");
    } finally {
      cleanup();
    }
  });

  it("resume in rpc mode is rejected — isError true, executeAsyncSingle not called", async () => {
    const root = makeTempDir("tlh-ao-rpc-resume-");
    const { executor, asyncCalls, state } = makeExecutorCapturing(root);
    const { runId, cleanup } = setupPausedForegroundRun(state, root);

    try {
      const ctx = { ...makeMinimalCtx(root), mode: "rpc" as const };
      const result = await executor.execute(
        "id",
        { action: "resume", id: runId, message: "Resume in rpc mode" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(result.isError, true, "resume in rpc mode must be rejected");
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      assert.match(text, /not available in non-interactive mode/i);
      assert.equal(asyncCalls.length, 0, "executeAsyncSingle must not be called in rpc mode");
    } finally {
      cleanup();
    }
  });

  it("action:list in print mode succeeds — observational actions are unaffected by mode gate", async () => {
    const root = makeTempDir("tlh-ao-print-list-");
    const { executor } = makeExecutorCapturing(root);

    const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
    const result = await executor.execute(
      "id",
      { action: "list" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.ok(!result.isError, "action:list in print mode must succeed");
  });

  it("action:status in rpc mode succeeds — observational actions are unaffected by mode gate", async () => {
    const root = makeTempDir("tlh-ao-rpc-status-");
    const { executor } = makeExecutorCapturing(root);

    const ctx = { ...makeMinimalCtx(root), mode: "rpc" as const };
    const result = await executor.execute(
      "id",
      { action: "status" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.ok(!result.isError, "action:status in rpc mode must succeed");
  });

  it("action:interrupt in print mode succeeds — observational actions are unaffected by mode gate", async () => {
    const root = makeTempDir("tlh-ao-print-interrupt-");
    const { executor } = makeExecutorCapturing(root);

    const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
    const result = await executor.execute(
      "id",
      { action: "interrupt" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    // No active run, but the action itself goes through (management result, possibly isError for no target)
    assert.equal(result.details?.mode, "management");
  });
});

// ---------------------------------------------------------------------------
// Ported from single-execution-basic.test.ts (removed with foreground engine)
// ---------------------------------------------------------------------------

describe("async-only — concurrent dispatch and management guards", () => {
  it("rejects duplicate concurrent subagent execution calls", async () => {
    // After async-only: the first call returns a background receipt immediately;
    // the second call is rejected before the background child has called mockPi.
    const root = makeTempDir("tlh-ao-concurrent-dup-");
    const { executor } = makeExecutorCapturing(root);
    const ctx = makeMinimalCtx(root);

    const first = executor.execute(
      "first",
      { agent: "echo", task: "First call" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const second = await executor.execute(
      "second",
      { agent: "echo", task: "Duplicate call" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const firstResult = await first;

    assert.equal(firstResult.isError, undefined);
    assert.ok(firstResult.details?.asyncId, "expected asyncId for accepted background dispatch");
    assert.equal(second.isError, true);
    const secondText = second.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(secondText, /Issue exactly ONE subagent call per turn/);
  });

  it("ignores legacy per-session spawn quota config and env values", async () => {
    // After async-only: each call returns a background receipt;
    // verify neither dispatch is rejected by legacy quota logic.
    const root = makeTempDir("tlh-ao-spawn-quota-");
    const { executor } = makeExecutorCapturing(root, { maxSubagentSpawnsPerSession: 1 });
    const ctx = makeMinimalCtx(root);

    const savedMaxSpawns = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
    process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "0";
    try {
      const first = await executor.execute(
        "first",
        { agent: "echo", task: "First call" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const second = await executor.execute(
        "second",
        { agent: "echo", task: "Second call" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      assert.equal(first.isError, undefined);
      assert.ok(first.details?.asyncId, "expected asyncId for first background dispatch");
      assert.equal(second.isError, undefined);
      assert.ok(second.details?.asyncId, "expected asyncId for second background dispatch");
    } finally {
      if (savedMaxSpawns === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
      else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = savedMaxSpawns;
    }
  });

  it("allows management actions while an execution call is in progress", async () => {
    // After async-only: the first call returns a background receipt immediately;
    // a concurrent status action must not be rejected.
    const root = makeTempDir("tlh-ao-mgmt-in-progress-");
    const { executor } = makeExecutorCapturing(root);
    const ctx = makeMinimalCtx(root);

    const first = executor.execute(
      "first",
      { agent: "echo", task: "First call" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const status = await executor.execute(
      "status",
      { action: "status" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const firstResult = await first;

    assert.equal(firstResult.isError, undefined);
    assert.equal(status.isError, undefined);
    const statusText = status.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.doesNotMatch(statusText, /Rejected: a subagent call is already in progress/);
  });
});
