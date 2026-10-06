/**
 * Unit tests verifying that the child-location snapshot flows correctly through
 * the dispatch and pause/resume plumbing.
 *
 * Coverage (async-only, post-tlhf-5veu):
 * - Dispatch path: child-location-async-dispatch.test.ts covers the async
 *   runner plan; those tests were the equivalent and are not duplicated here.
 *   Removed dispatch assertions are noted in the tlhf-5veu acceptance report.
 * - Setup-failure path (ts-1496): calls runSync directly, still valid.
 * - Historical paused-foreground resume: legacy-fixture tests verify that a
 *   paused-foreground run carrying childLocation or tkTicketId resumes as a
 *   background continuation with the correct cwd/ticket forwarded.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { RunSyncOptions, SingleResult } from "../../src/shared/types.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import {
  ASYNC_DIR,
  type AcceptanceLedger,
  type ForegroundResumeRun,
  type ResolvedAcceptanceConfig,
} from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { resolveForegroundResumeTarget } from "../../src/runs/foreground/foreground-run-state.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Session roots created by makeExecutor(); cleaned up in the after() hook. */
const _sessionRoots: string[] = [];

after(() => {
  for (const dir of _sessionRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

const parentCwd = os.tmpdir();
// A child cwd that is guaranteed to differ from parentCwd.
const childCwd = path.join(os.tmpdir(), "tlh-unit-test-fg-child-loc");

function makeState() {
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

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    sessionManager: {
      getSessionId(): string | undefined {
        return "session-fg-loc";
      },
      getSessionFile(): string | undefined {
        return undefined;
      },
    },
    modelRegistry: {
      getAvailable() {
        return [];
      },
    },
  } as any;
}

/** Minimal SingleResult suitable for mock runSync returns. */
function makeResult(agentName: string, childLocation?: ChildLocationSnapshot): SingleResult {
  return {
    agent: agentName,
    task: "test task",
    exitCode: 0,
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    finalOutput: "done",
    ...(childLocation !== undefined ? { childLocation } : {}),
  };
}

function makeExecutor(
  runSync: (
    runtimeCwd: string,
    agents: unknown[],
    agentName: string,
    task: string,
    opts: RunSyncOptions,
  ) => Promise<SingleResult>,
  options: {
    agent?: AgentConfig;
    state?: ReturnType<typeof makeState>;
    concurrency?: number;
    executeAsyncSingle?: (
      runId: string,
      params: Record<string, unknown>,
    ) => Record<string, unknown>;
  } = {},
) {
  const state = options.state ?? makeState();
  const agent =
    options.agent ??
    ({
      name: "worker",
      description: "test agent",
      systemPrompt: "",
      systemPromptMode: "replace" as const,
      inheritProjectContext: false,
      inheritSkills: false,
      source: "user" as const,
      filePath: "",
    } satisfies AgentConfig);
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
    config: {
      maxSubagentDepth: 2,
      control: {},
      ...(options.concurrency !== undefined
        ? { parallel: { concurrency: options.concurrency } }
        : {}),
    } as any,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fg-dispatch-sessions-"));
      _sessionRoots.push(dir);
      return dir;
    },
    expandTilde: (v: string) => v,
    discoverAgents: (_cwd: string) => ({ agents: [agent] }),
    runSync: runSync as any,
    ...(options.executeAsyncSingle
      ? { executeAsyncSingle: options.executeAsyncSingle as never }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Legacy-fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal well-formed acceptance ledger for a paused child.
 * status:"skipped" with a non-none effective level satisfies the
 * paused-step acceptance requirement in resolveAsyncResumeTarget.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dispatch tests deleted in tlhf-5veu (async-only transition):
//
// The following test blocks were removed because all new dispatch now routes
// through the async path. Equivalent coverage exists in:
//   child-location-async-dispatch.test.ts (buildAsyncRunnerPlan plan coverage)
//
// Deleted assertions and their justification:
//   (1) "passes childLocation in RunSyncOptions when child cwd differs from parent cwd"
//       → Foreground runSync seam no longer receives dispatch; equivalent:
//         child-location-async-dispatch.test.ts "RunnerSubagentStep carries childLocation…"
//   (2) "omits childLocation in RunSyncOptions when child cwd matches parent cwd"
//       → Equivalent: child-location-async-dispatch.test.ts "RunnerSubagentStep omits childLocation…"
//   (3) "childLocation on the final SingleResult reaches the render layer"
//       → Async initial receipt has no inline SingleResults; foreground-only behavior.
//   (4) "childLocation survives intermediate streaming onUpdate (single-run path)"
//       → Streaming onUpdate is foreground-only; async dispatch has no equivalent path.
//   (5) "passes childLocation for tasks with cwds differing from parent" (parallel)
//       → Equivalent: child-location-async-dispatch.test.ts plan test with tasks.
//   (6) "childLocation on parallel SingleResults reaches the render layer"
//       → Foreground-only; same reason as (3).
//   (7) "childLocation survives intermediate streaming onUpdate (parallel path)"
//       → Foreground-only; same reason as (4).
//   (8) "childLocation is identical across streaming update and final result"
//       → Streaming is foreground-only; no async equivalent exists at this level.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ITEM 2 — Historical paused-foreground resume: childLocation preserved
//
// After async-only dispatch, new runs never create foreground pauses.
// Historical paused-foreground records on disk must still resume correctly as
// background continuations. The test sets up the paused status directly as a
// fixture and verifies the continuation is dispatched with the original child
// cwd (which causes the real async runner to compute a fresh childLocation).
// ---------------------------------------------------------------------------

describe("child-location historical paused-foreground resume (ITEM 2)", () => {
  it("historical paused-foreground single run with childLocation resumes as background continuation preserving the child cwd", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-cld-item2-"));
    const asyncCalls: Array<{ runId: string; params: unknown }> = [];
    const noopRunSync = async (
      _rCwd: string,
      _agents: unknown[],
      agentName: string,
    ): Promise<SingleResult> => makeResult(agentName);
    const state = makeState();
    const executor = makeExecutor(noopRunSync, {
      state,
      executeAsyncSingle: (runId: string, params: Record<string, unknown>) => {
        asyncCalls.push({ runId, params });
        return {
          content: [{ type: "text", text: "resumed-ok" }],
          details: { asyncId: runId, results: [] },
        };
      },
    });

    // Write paused-foreground fixture with cwd=childCwd (differs from parentCwd).
    const runId = `paused-fg-cld-item2-${Date.now().toString(36)}`;
    const sessionFile = path.join(root, `${runId}-session.jsonl`);
    const asyncDir = path.join(ASYNC_DIR, runId);
    fs.writeFileSync(sessionFile, "", "utf8");
    fs.mkdirSync(asyncDir, { recursive: true });

    const acceptance = makeSkippedAcceptanceLedger();
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state: "paused",
      startedAt: Date.now() - 2000,
      lastUpdate: Date.now(),
      cwd: childCwd, // differs from parentCwd → childLocation computed on resume
      steps: [
        {
          agent: "worker",
          status: "paused",
          sessionFile,
          pause: { kind: "awaiting_supervisor", summary: "Test pause." },
          acceptance,
          childLocation: { childCwd, displayPath: "tlh-cld-item2", branch: "feat-cld-item2" },
        },
      ],
      pause: { kind: "awaiting_supervisor", summary: "Test pause." },
    });

    // Populate state.foregroundRuns (required by resolveRememberedForegroundRun).
    state.foregroundRuns.set(runId, {
      runId,
      mode: "single",
      cwd: childCwd,
      updatedAt: Date.now(),
      children: [
        {
          agent: "worker",
          index: 0,
          status: "paused",
          sessionFile,
          pause: { kind: "awaiting_supervisor", summary: "Test pause." },
          acceptance,
        },
      ],
    } as ForegroundResumeRun);

    try {
      const result = await executor.execute(
        "resume-item2",
        { action: "resume", id: runId, message: "continue" },
        new AbortController().signal,
        undefined,
        makeCtx(parentCwd),
      );
      assert.equal(
        result.isError,
        undefined,
        `resume should succeed; got: ${JSON.stringify(result.content)}`,
      );
      assert.equal(
        asyncCalls.length,
        1,
        "executeAsyncSingle must be called once for the continuation",
      );
      const capturedCwd = (asyncCalls[0]!.params as { cwd?: string }).cwd;
      assert.equal(
        capturedCwd,
        childCwd,
        "resume continuation must be dispatched with the original childCwd from the paused run",
      );
    } finally {
      state.foregroundRuns.delete(runId);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.rmSync(sessionFile, { force: true });
      } catch {
        // best-effort
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ITEM 3 (ts-y7q9) — Historical paused parallel batch: childLocation preserved
//
// After async-only dispatch, new parallel runs no longer create cohort pauses
// via the foreground path. Historical paused parallel records on disk may have
// queued (pending) steps whose childLocation must be preserved. This test
// verifies the paused status correctly captures childLocation for a pending
// step and that the step's resume target is accessible via
// resolveAsyncResumeTarget.
// ---------------------------------------------------------------------------

describe("historical paused parallel batch preserves queued-step childLocation (ITEM 3)", () => {
  it("paused parallel status correctly preserves childLocation for a pending queued step", async () => {
    const queuedTaskCwd = path.join(os.tmpdir(), "tlh-cld-item3-queued");

    // Build fixture: mode=parallel, step[0] paused (same cwd), step[1] pending (childCwd).
    const runId = `paused-fg-parallel-item3-${Date.now().toString(36)}`;
    const sessionFile0 = path.join(os.tmpdir(), `${runId}-s0.jsonl`);
    const asyncDir = path.join(ASYNC_DIR, runId);
    fs.writeFileSync(sessionFile0, "", "utf8");
    fs.mkdirSync(asyncDir, { recursive: true });

    const acceptance = makeSkippedAcceptanceLedger();
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      startedAt: Date.now() - 3000,
      lastUpdate: Date.now(),
      cwd: parentCwd,
      steps: [
        {
          agent: "worker",
          status: "paused",
          sessionFile: sessionFile0,
          pause: { kind: "awaiting_supervisor", summary: "Task 0 paused." },
          acceptance,
        },
        {
          agent: "worker",
          status: "pending",
          childLocation: {
            childCwd: queuedTaskCwd,
            displayPath: "tlh-item3-queued",
            branch: "feat-item3",
          },
        },
      ],
      pause: { kind: "awaiting_supervisor", summary: "Task 0 paused." },
    });

    try {
      // Verify the persisted status preserves childLocation for step[1].
      const status = readStatus(asyncDir);
      assert.ok(status, "paused parallel status must exist");
      assert.ok(status.steps && status.steps.length >= 2, "status must have 2 steps");
      const queuedStep = status.steps![1]!;
      assert.ok(
        queuedStep.childLocation !== undefined,
        "childLocation must be preserved in the paused status for the queued step",
      );
      assert.equal(
        queuedStep.childLocation!.childCwd,
        queuedTaskCwd,
        "persisted childCwd must match the queued task cwd",
      );

      // The pending step's info is accessible via resolveAsyncResumeTarget (read-only).
      const pendingTarget = resolveAsyncResumeTarget(
        { id: runId, index: 1 },
        { asyncDirRoot: ASYNC_DIR },
        { readOnly: true, requireSessionFile: false },
      );
      assert.equal(pendingTarget.agent, "worker");
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.rmSync(sessionFile0, { force: true });
      } catch {
        // best-effort
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Developer ticket — historical paused parallel batch preserves tkTicketId
//
// After async-only dispatch, new developer-ticket parallel runs no longer
// create cohort pauses via the foreground path. Historical paused parallel
// records may have pending steps with tkTicketId, which must be preserved and
// accessible via both the in-memory state and the async resume resolution APIs.
// ---------------------------------------------------------------------------

describe("historical paused parallel batch preserves queued-step tkTicketId", () => {
  it("paused parallel status correctly preserves tkTicketId for both paused and pending steps", async () => {
    const runId = `paused-fg-parallel-ticket-${Date.now().toString(36)}`;
    const sessionFile0 = path.join(os.tmpdir(), `${runId}-s0.jsonl`);
    const asyncDir = path.join(ASYNC_DIR, runId);
    fs.writeFileSync(sessionFile0, "", "utf8");
    fs.mkdirSync(asyncDir, { recursive: true });

    const acceptance = makeSkippedAcceptanceLedger();
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "parallel",
      state: "paused",
      startedAt: Date.now() - 3000,
      lastUpdate: Date.now(),
      cwd: parentCwd,
      steps: [
        {
          agent: "developer",
          status: "paused",
          sessionFile: sessionFile0,
          pause: { kind: "awaiting_supervisor", summary: "Task 0 paused." },
          acceptance,
          tkTicketId: "tlhm-first",
        },
        {
          agent: "developer",
          status: "pending",
          tkTicketId: "tlhm-second",
        },
      ],
      pause: { kind: "awaiting_supervisor", summary: "Task 0 paused." },
    });

    // Populate state.foregroundRuns (consumed by resolveForegroundResumeTarget).
    const state = makeState();
    state.foregroundRuns.set(runId, {
      runId,
      mode: "parallel",
      cwd: parentCwd,
      updatedAt: Date.now(),
      children: [
        {
          agent: "developer",
          index: 0,
          status: "paused",
          sessionFile: sessionFile0,
          pause: { kind: "awaiting_supervisor", summary: "Task 0 paused." },
          acceptance,
          tkTicketId: "tlhm-first",
        },
        {
          agent: "developer",
          index: 1,
          status: "pending",
          tkTicketId: "tlhm-second",
        },
      ],
    } as ForegroundResumeRun);

    try {
      // In-memory state preserves tkTicketId for the queued child.
      assert.equal(
        [...state.foregroundRuns.values()][0]!.children[1]?.tkTicketId,
        "tlhm-second",
        "in-memory queued child must carry tkTicketId",
      );

      // In-memory state resolves tkTicketId for the paused child (step 0).
      const requester = resolveForegroundResumeTarget({ id: runId, index: 0 }, state);
      assert.equal(requester?.tkTicketId, "tlhm-first");

      // Persisted status preserves tkTicketId for step[1].
      const status = readStatus(asyncDir);
      assert.ok(status, "paused parallel status must exist");
      assert.equal(status.steps?.[1]?.status, "pending");
      assert.equal(status.steps?.[1]?.tkTicketId, "tlhm-second");

      // resolveAsyncResumeTarget (read-only) exposes tkTicketId for the pending step.
      const queuedTarget = resolveAsyncResumeTarget(
        { id: runId, index: 1 },
        { asyncDirRoot: ASYNC_DIR },
        { readOnly: true, requireSessionFile: false },
      );
      assert.equal(queuedTarget.tkTicketId, "tlhm-second");
    } finally {
      state.foregroundRuns.delete(runId);
      fs.rmSync(asyncDir, { recursive: true, force: true });
      try {
        fs.rmSync(sessionFile0, { force: true });
      } catch {
        // best-effort
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 (ts-1496) — Setup-failure path must preserve childLocation
//
// A setup failure (buildPiArgs throwing before any subprocess is spawned) is
// disproportionately likely to stem from a bad working directory. The terminal
// card for a single-path failure is rendered directly from the SingleResult, so
// childLocation must survive the early-return path in runSingleAttempt.
// ---------------------------------------------------------------------------

describe("setup-failure result preserves childLocation (ts-1496)", () => {
  /**
   * An agent whose tool policy is deliberately invalid: inheritSkills=true
   * combined with extension-path-only tools. buildPiArgs rejects this
   * combination before spawning any subprocess, exercising the catch block
   * in runSingleAttempt that we patched to carry childLocation.
   */
  const badAgent: AgentConfig = {
    name: "bad-agent",
    description: "agent with invalid tool policy for setup-failure test",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: true, // requires read tool
    tools: ["/some/extension.ts"], // extension-path-only → triggers buildPiArgs error
    systemPrompt: "",
    source: "user",
    filePath: "",
  };

  const testChildLocation: ChildLocationSnapshot = {
    childCwd: path.join(os.tmpdir(), "tlh-setup-failure-child-loc"),
    displayPath: "tlh-setup-failure-child-loc",
    branch: "feat-setup-failure",
  };

  it("single-path setup failure carries dispatch-time childLocation on the terminal result", async () => {
    const options: RunSyncOptions = {
      runId: "tlh-test-setup-failure-1",
      childLocation: testChildLocation,
      // No artifactsDir → setupForegroundArtifacts is a no-op (no filesystem side-effects).
    };

    const result = await runSync(os.tmpdir(), [badAgent], "bad-agent", "test task", options);

    // The result must represent a setup failure.
    assert.equal(result.exitCode, 1, "setup failure must produce exitCode 1");
    assert.ok(result.error, "setup failure must carry an error message");
    assert.ok(
      result.error.includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
      `error must be the invalid lazy-skill/tool-policy error; got: ${result.error}`,
    );

    // The childLocation passed at dispatch time must survive the early-return path.
    assert.ok(
      result.childLocation !== undefined,
      "setup-failure SingleResult must carry the dispatch-time childLocation",
    );
    assert.equal(
      result.childLocation!.childCwd,
      testChildLocation.childCwd,
      "childCwd must match the dispatch-time snapshot",
    );
    assert.equal(
      result.childLocation!.branch,
      testChildLocation.branch,
      "branch must match the dispatch-time snapshot",
    );
  });

  it("setup failure without a childLocation does not add a childLocation field", async () => {
    const options: RunSyncOptions = {
      runId: "tlh-test-setup-failure-2",
      // No childLocation — same-cwd scenario.
    };

    const result = await runSync(os.tmpdir(), [badAgent], "bad-agent", "test task", options);

    assert.equal(result.exitCode, 1, "setup failure must produce exitCode 1");
    assert.ok(result.error, "setup failure must carry an error message");
    assert.ok(
      result.error.includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
      `error must be the invalid lazy-skill/tool-policy error; got: ${result.error}`,
    );
    assert.equal(
      result.childLocation,
      undefined,
      "setup-failure result must not add childLocation when none was provided",
    );
  });
});
