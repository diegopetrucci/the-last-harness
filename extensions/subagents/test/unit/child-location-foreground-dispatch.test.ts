/**
 * Unit tests verifying that the child-location snapshot flows correctly through
 * the foreground dispatch plumbing.
 *
 * Coverage:
 * - Single-run path (runSinglePath): snapshot captured in RunSyncOptions at
 *   dispatch time; absent when cwds match.
 * - Parallel-run path (runForegroundParallelTasks): per-task snapshot captured
 *   in each RunSyncOptions at dispatch time.
 * - Streaming updates: childLocation survives intermediate onUpdate callbacks
 *   for both single and parallel paths.
 * - Consumer-level assertion: the field is present on the SingleResult that
 *   reaches the render layer (Details["results"][number]).
 *
 * No subprocess is spawned in the dispatch tests; runSync is replaced with an
 * injectable seam that captures received options and emits controlled onUpdate
 * events. The setup-failure regression block (ts-1496) calls the real runSync
 * with an agent whose invalid tool policy causes buildPiArgs to throw before
 * any subprocess is spawned.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { RunSyncOptions, SingleResult, Details } from "../../src/shared/types.ts";
import type { SubagentToolResult } from "../../src/shared/types.ts";
import type { ChildLocationSnapshot } from "../../src/shared/child-location.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a mock runSync that:
 * 1. Captures the options it receives into `capturedOptions`.
 * 2. Optionally emits one streaming onUpdate before returning, using the result
 *    as the streaming payload (simulates progress ticks from a real child).
 * 3. Returns `resultFn(options)` as the final SingleResult.
 */
function makeCapturingRunSync(options: {
  capturedOptions: RunSyncOptions[];
  /**
   * Called to produce the final (and streaming) result for this call.
   * Receives the RunSyncOptions so tests can propagate childLocation from
   * options → result to simulate real runSync behaviour.
   */
  resultFn: (opts: RunSyncOptions) => SingleResult;
  /** When true, emit one onUpdate tick before resolving. Default true. */
  emitStreaming?: boolean;
}) {
  return async (
    _runtimeCwd: string,
    _agents: unknown[],
    agentName: string,
    _task: string,
    opts: RunSyncOptions,
  ): Promise<SingleResult> => {
    options.capturedOptions.push(opts);
    const result = options.resultFn(opts);

    const emitStreaming = options.emitStreaming !== false;
    if (emitStreaming && opts.onUpdate) {
      opts.onUpdate({
        content: [{ type: "text", text: agentName }],
        details: {
          mode: "single",
          results: [result],
          progress: [],
        },
      });
    }

    return result;
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
) {
  const state = makeState();
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
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: os.tmpdir(),
    getSubagentSessionRoot: () => os.tmpdir(),
    expandTilde: (v: string) => v,
    discoverAgents: (_cwd: string) => ({
      agents: [
        {
          name: "worker",
          description: "test agent",
          systemPrompt: "",
          systemPromptMode: "replace" as const,
          inheritProjectContext: false,
          inheritSkills: false,
          source: "user" as const,
          filePath: "",
        },
      ],
    }),
    runSync: runSync as any,
  });
}

function executeRun(
  executor: ReturnType<typeof makeExecutor>,
  cwd: string,
  parentCwd: string,
  onUpdate?: (r: SubagentToolResult<Details>) => void,
) {
  return executor.execute(
    "run",
    { agent: "worker", task: "test task", cwd },
    new AbortController().signal,
    onUpdate,
    makeCtx(parentCwd),
  );
}

function executeParallelRun(
  executor: ReturnType<typeof makeExecutor>,
  tasks: Array<{ agent: string; task: string; cwd?: string }>,
  parentCwd: string,
  onUpdate?: (r: SubagentToolResult<Details>) => void,
) {
  return executor.execute(
    "run",
    { tasks },
    new AbortController().signal,
    onUpdate,
    makeCtx(parentCwd),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("child-location snapshot in foreground dispatch", () => {
  // -------------------------------------------------------------------------
  // Single-run path
  // -------------------------------------------------------------------------

  describe("single-run path", () => {
    it("passes childLocation in RunSyncOptions when child cwd differs from parent cwd", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
      });

      await executeRun(makeExecutor(runSync), childCwd, parentCwd);

      assert.equal(capturedOptions.length, 1, "runSync must be called exactly once");
      const opts = capturedOptions[0]!;
      assert.ok(
        opts.childLocation !== undefined,
        "childLocation must be set in RunSyncOptions when cwds differ",
      );
      assert.equal(opts.childLocation!.childCwd, childCwd);
      assert.ok(
        typeof opts.childLocation!.displayPath === "string" &&
          opts.childLocation!.displayPath.length > 0,
        "displayPath must be a non-empty string",
      );
    });

    it("omits childLocation in RunSyncOptions when child cwd matches parent cwd", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
      });

      await executeRun(makeExecutor(runSync), parentCwd, parentCwd);

      assert.equal(capturedOptions.length, 1, "runSync must be called exactly once");
      const opts = capturedOptions[0]!;
      assert.equal(
        opts.childLocation,
        undefined,
        "childLocation must be absent when cwds are the same",
      );
    });

    it("childLocation on the final SingleResult reaches the render layer (consumer check)", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const runSync = makeCapturingRunSync({
        capturedOptions,
        // Simulate real runSync: propagate childLocation from options to result.
        resultFn: (opts) => makeResult("worker", opts.childLocation),
      });

      const outcome = await executeRun(makeExecutor(runSync), childCwd, parentCwd);

      const firstResult = outcome.details?.results[0];
      assert.ok(firstResult, "expected a result in details.results[0]");
      assert.ok(
        firstResult.childLocation !== undefined,
        "childLocation must be present on the SingleResult read by the render layer",
      );
      assert.equal(firstResult.childLocation!.childCwd, childCwd);
    });

    it("childLocation survives intermediate streaming onUpdate (single-run path)", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const streamingResults: SingleResult[] = [];

      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
        emitStreaming: true,
      });

      const outerOnUpdate = (update: SubagentToolResult<Details>) => {
        const results = update.details?.results ?? [];
        for (const r of results) streamingResults.push(r);
      };

      await executeRun(makeExecutor(runSync), childCwd, parentCwd, outerOnUpdate);

      assert.ok(
        streamingResults.length > 0,
        "at least one streaming update must have been emitted",
      );
      const streamingResult = streamingResults[0]!;
      assert.ok(
        streamingResult.childLocation !== undefined,
        "childLocation must be present on the streaming SingleResult seen by the render layer",
      );
      assert.equal(streamingResult.childLocation!.childCwd, childCwd);
    });
  });

  // -------------------------------------------------------------------------
  // Parallel-run path
  // -------------------------------------------------------------------------

  describe("parallel-run path", () => {
    it("passes childLocation for tasks with cwds differing from parent", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
      });

      await executeParallelRun(
        makeExecutor(runSync),
        [
          { agent: "worker", task: "task A", cwd: childCwd },
          { agent: "worker", task: "task B" }, // no cwd → same as parent
        ],
        parentCwd,
      );

      assert.equal(capturedOptions.length, 2, "runSync must be called once per task");

      // Task A: different cwd → childLocation present.
      const optsA = capturedOptions[0]!;
      assert.ok(
        optsA.childLocation !== undefined,
        "childLocation must be set for the task with a differing cwd",
      );
      assert.equal(optsA.childLocation!.childCwd, childCwd);

      // Task B: same cwd as parent → childLocation absent.
      const optsB = capturedOptions[1]!;
      assert.equal(
        optsB.childLocation,
        undefined,
        "childLocation must be absent for the task with the same cwd as parent",
      );
    });

    it("childLocation on parallel SingleResults reaches the render layer (consumer check)", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
      });

      const outcome = await executeParallelRun(
        makeExecutor(runSync),
        [{ agent: "worker", task: "task A", cwd: childCwd }],
        parentCwd,
      );

      const firstResult = outcome.details?.results[0];
      assert.ok(firstResult, "expected a result in details.results[0]");
      assert.ok(
        firstResult.childLocation !== undefined,
        "childLocation must be present on the parallel SingleResult read by the render layer",
      );
      assert.equal(firstResult.childLocation!.childCwd, childCwd);
    });

    it("childLocation survives intermediate streaming onUpdate (parallel path)", async () => {
      const capturedOptions: RunSyncOptions[] = [];
      const streamingResults: SingleResult[] = [];

      const runSync = makeCapturingRunSync({
        capturedOptions,
        resultFn: (opts) => makeResult("worker", opts.childLocation),
        emitStreaming: true,
      });

      const outerOnUpdate = (update: SubagentToolResult<Details>) => {
        const results = update.details?.results ?? [];
        for (const r of results) streamingResults.push(r);
      };

      await executeParallelRun(
        makeExecutor(runSync),
        [{ agent: "worker", task: "task A", cwd: childCwd }],
        parentCwd,
        outerOnUpdate,
      );

      assert.ok(
        streamingResults.length > 0,
        "at least one streaming update must have been emitted by the parallel path",
      );
      const streamingResult = streamingResults.find((r) => r.childLocation !== undefined);
      assert.ok(
        streamingResult !== undefined,
        "at least one streaming SingleResult seen by the render layer must carry childLocation",
      );
      assert.equal(streamingResult.childLocation!.childCwd, childCwd);
    });
  });

  // -------------------------------------------------------------------------
  // Snapshot computed once at dispatch (not per streaming tick)
  // -------------------------------------------------------------------------

  it("childLocation is identical across streaming update and final result (captured once)", async () => {
    const capturedOptions: RunSyncOptions[] = [];
    const streamingSnapshots: ChildLocationSnapshot[] = [];

    let capturedSnapshot: ChildLocationSnapshot | undefined;

    const runSync = makeCapturingRunSync({
      capturedOptions,
      resultFn: (opts) => {
        capturedSnapshot = opts.childLocation;
        return makeResult("worker", opts.childLocation);
      },
      emitStreaming: true,
    });

    const outerOnUpdate = (update: SubagentToolResult<Details>) => {
      for (const r of update.details?.results ?? []) {
        if (r.childLocation) streamingSnapshots.push(r.childLocation);
      }
    };

    const outcome = await executeRun(makeExecutor(runSync), childCwd, parentCwd, outerOnUpdate);

    // The options snapshot, streaming snapshot, and final result snapshot are
    // the same object (or at minimum deep-equal), confirming a single capture.
    assert.ok(capturedSnapshot, "snapshot must be set at dispatch time");
    assert.ok(streamingSnapshots.length > 0, "streaming snapshots must be present");
    assert.deepEqual(
      capturedSnapshot,
      streamingSnapshots[0],
      "dispatch-time snapshot and streaming snapshot must be deep-equal (single capture)",
    );
    const finalSnapshot = outcome.details?.results[0]?.childLocation;
    assert.deepEqual(
      capturedSnapshot,
      finalSnapshot,
      "dispatch-time snapshot and final result snapshot must be deep-equal",
    );
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — Pause round-trip: childLocation survives foreground pause/restore
// ---------------------------------------------------------------------------

describe("child-location pause round-trip (ITEM 2)", () => {
  it("childLocation is persisted to the paused status file (single-run path)", async () => {
    // This test drives onSupervisorPauseTransition in the mock runSync so that
    // persistPausedForegroundSingleRun writes a status file we can inspect.
    // It confirms buildPausedStepFromResult carries childLocation through the
    // paused status snapshot.

    const snapshot: ChildLocationSnapshot = {
      childCwd: childCwd,
      displayPath: "tlh-unit-test-fg-child-loc",
      branch: "feat-pause-rt",
    };

    let pauseTransitionCalled = false;

    const runSync = async (
      _runtimeCwd: string,
      _agents: unknown[],
      _agentName: string,
      _task: string,
      opts: RunSyncOptions,
    ): Promise<SingleResult> => {
      const result: SingleResult = {
        agent: "worker",
        task: "pause round-trip test task",
        exitCode: 0,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        finalOutput: "done",
        // childLocation is set by execution.ts at dispatch time; simulate that here.
        childLocation: snapshot,
        // A pause marker so the executor knows this was paused.
        pause: {
          kind: "awaiting_supervisor" as const,
          summary: "Pause requested for test.",
          requestedAt: Date.now(),
          pausedAt: Date.now() + 50,
        },
      };

      // Simulate the supervisor-pause transition lifecycle.
      if (opts.onSupervisorPauseTransition) {
        opts.onSupervisorPauseTransition({ stage: "pausing", ownerPid: process.pid, result });
        pauseTransitionCalled = true;
        // Pause the result so the executor's state is also updated.
        opts.onSupervisorPauseTransition({ stage: "paused", result });
      }

      return result;
    };

    const state = makeState();
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
      tempArtifactsDir: os.tmpdir(),
      getSubagentSessionRoot: () => os.tmpdir(),
      expandTilde: (v: string) => v,
      discoverAgents: (_cwd: string) => ({
        agents: [
          {
            name: "worker",
            description: "test agent",
            systemPrompt: "",
            systemPromptMode: "replace" as const,
            inheritProjectContext: false,
            inheritSkills: false,
            source: "user" as const,
            filePath: "",
          },
        ],
      }),
      runSync: runSync as any,
    });

    await executor.execute(
      "run",
      { agent: "worker", task: "pause round-trip test task", cwd: childCwd },
      new AbortController().signal,
      undefined,
      makeCtx(parentCwd),
    );

    assert.ok(pauseTransitionCalled, "onSupervisorPauseTransition must have been called");

    // Find the run ID from state.foregroundRuns (populated by updateRememberedForegroundChild
    // on stage=paused).
    const runEntry = [...state.foregroundRuns.values()][0];
    const runId = runEntry?.runId;
    // Assert on the value we actually need: a non-empty string runId.
    // This narrows `runId` from `string | undefined` to `string` so it is
    // safe to pass to path.join below.
    assert.ok(runId, "foregroundRuns must have an entry with a runId after pause");

    // Read the persisted paused status file.
    const asyncDir = path.join(ASYNC_DIR, runId);
    const status = readStatus(asyncDir);
    assert.ok(status, `paused status file must exist at ${asyncDir}`);
    assert.ok(status.steps?.length, "paused status must have steps");

    const step = status.steps![0]!;
    assert.ok(
      step.childLocation !== undefined,
      "childLocation must be persisted in the paused step snapshot",
    );
    assert.equal(
      step.childLocation!.childCwd,
      snapshot.childCwd,
      "persisted childCwd must match dispatch-time snapshot",
    );
    assert.equal(
      step.childLocation!.branch,
      snapshot.branch,
      "persisted branch must match dispatch-time snapshot",
    );
  });
});

// ---------------------------------------------------------------------------
// ITEM 3 (ts-y7q9) — Queued-task pause result must carry its location snapshot
//
// When a parallel run pauses (one task triggers a supervisor pause), subsequent
// tasks that never started are returned as synthetic "Interrupted before
// starting queued task." SingleResults. The finalization path writes the final
// "paused" status from details.results, so any location snapshot attached to
// those synthetic results must be present — otherwise the persisted paused
// status overwrites the intermediate checkpoint and the location line
// disappears.
// ---------------------------------------------------------------------------

describe("queued-task pause result carries childLocation into final persisted state (ITEM 3)", () => {
  it("childLocation survives into the FINAL persisted paused status for a queued task in a parallel run", async () => {
    // Set up two tasks with concurrency=1 so they run sequentially:
    //   index 0 — same cwd as parent (no childLocation)
    //   index 1 — different cwd (childLocation must be captured)
    // Task 0's runSync triggers a supervisor pause. Because concurrency=1,
    // task 1 is queued and never starts; it returns the synthetic
    // "Interrupted before starting" result. Without the fix, that synthetic
    // result lacks childLocation, so the finalization call to
    // persistPausedForegroundCohortRun(results:) drops it from the persisted
    // status file.
    const queuedTaskCwd = path.join(os.tmpdir(), "tlh-unit-test-fg-queued-loc");

    const runSync = async (
      _runtimeCwd: string,
      _agents: unknown[],
      _agentName: string,
      _task: string,
      opts: RunSyncOptions,
    ): Promise<SingleResult> => {
      const result: SingleResult = {
        agent: "worker",
        task: "pause trigger task",
        exitCode: 0,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        finalOutput: "paused",
        pause: {
          kind: "awaiting_supervisor" as const,
          summary: "Pause requested for test.",
          requestedAt: Date.now(),
          pausedAt: Date.now() + 50,
        },
      };

      // Fire the supervisor-pause lifecycle so requestCohortPause is invoked,
      // which sets interrupted=true and prevents task 1 from starting.
      if (opts.onSupervisorPauseTransition) {
        opts.onSupervisorPauseTransition({ stage: "pausing", ownerPid: process.pid, result });
        opts.onSupervisorPauseTransition({ stage: "paused", result });
      }
      return result;
    };

    const state = makeState();
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
      // concurrency: 1 ensures tasks run sequentially so task 1 is queued
      // when task 0 triggers the supervisor pause.
      config: { maxSubagentDepth: 2, control: {}, parallel: { concurrency: 1 } } as any,
      tempArtifactsDir: os.tmpdir(),
      getSubagentSessionRoot: () => os.tmpdir(),
      expandTilde: (v: string) => v,
      discoverAgents: (_cwd: string) => ({
        agents: [
          {
            name: "worker",
            description: "test agent",
            systemPrompt: "",
            systemPromptMode: "replace" as const,
            inheritProjectContext: false,
            inheritSkills: false,
            source: "user" as const,
            filePath: "",
          },
        ],
      }),
      runSync: runSync as any,
    });

    // Run a parallel cohort:
    //   task 0 — parent cwd (no childLocation)
    //   task 1 — queuedTaskCwd (childLocation must be captured and survive)
    // Concurrency=1 (set in config.parallel.concurrency above) ensures task 1
    // is queued when task 0 triggers the supervisor pause.
    await executor.execute(
      "run",
      {
        tasks: [
          { agent: "worker", task: "pause trigger task" },
          { agent: "worker", task: "queued task", cwd: queuedTaskCwd },
        ],
      },
      new AbortController().signal,
      undefined,
      makeCtx(parentCwd),
    );

    // Find the run ID from state.foregroundRuns.
    const runEntry = [...state.foregroundRuns.values()][0];
    const runId = runEntry?.runId;
    assert.ok(runId, "foregroundRuns must have an entry with a runId after pause");

    // Read the final persisted paused status file.
    const asyncDir = path.join(ASYNC_DIR, runId);
    const status = readStatus(asyncDir);
    assert.ok(status, `paused status file must exist at ${asyncDir}`);
    assert.ok(status.steps && status.steps.length >= 2, "paused status must have at least 2 steps");

    // Step at index 1 corresponds to the queued task (different cwd).
    const queuedStep = status.steps![1]!;
    assert.ok(
      queuedStep.childLocation !== undefined,
      "childLocation must be present in the final persisted paused step for the queued task",
    );
    assert.equal(
      queuedStep.childLocation!.childCwd,
      queuedTaskCwd,
      "persisted childCwd must match the queued task's cwd",
    );
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
