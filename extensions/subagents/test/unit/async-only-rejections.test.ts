/**
 * Rejection-state matrix and collision tests for the async-only dispatch contract.
 * Extracted from async-only-dispatch-characterization.test.ts to keep both files
 * under the 2000-line formatter/linter ceiling.
 *
 * Covers:
 *   (a) Rejection gate leaves executor state unchanged (baseCwd, foregroundRuns, ASYNC_DIR).
 *   (b) Parallel output collision check (executor-level pre-launch gate, uses executeAsyncParallel seam).
 *   (c) Collision-check negative controls (disabled/file-only/distinct-cwds, seam-captured).
 *
 * Ticket: tlhf-5veu (split from async-only-dispatch-characterization.test.ts)
 */

import assert from "node:assert/strict";
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
import {
  makeAgent as makeSupportAgent,
  makeMinimalCtx,
  makeSubagentState,
} from "../support/helpers.ts";
import {
  notCollisionError,
  setupLiveAsyncRun,
  setupPersistedAsyncRun,
} from "../support/parallel-dispatch-fixtures.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";

// ---------------------------------------------------------------------------
// Module-level cleanup
// ---------------------------------------------------------------------------

const _tempDirs: string[] = [];

after(() => {
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

/** Create an executor with the default agent list (echo + second) and optional seams. */
function makeExecutor(sessionRoot: string, state: SubagentState) {
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
    tempArtifactsDir: sessionRoot,
    getSubagentSessionRoot: () => sessionRoot,
    expandTilde: (v: string) => v,
    discoverAgents: () => ({
      agents: [
        makeSupportAgent("echo", { description: "Echo agent" }),
        makeSupportAgent("second", { description: "Second agent" }),
      ],
    }),
  });
}

// ---------------------------------------------------------------------------
// Paused foreground run fixture helpers (duplicated from characterization test
// so each file remains self-contained).
// ---------------------------------------------------------------------------

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

function setupPausedForegroundRun(
  state: SubagentState,
  root: string,
  options: { runId?: string; agent?: string } = {},
): { runId: string; sessionFile: string; asyncDir: string; cleanup: () => void } {
  const runId = options.runId ?? `paused-fg-rej-${Date.now().toString(36)}`;
  const agent = options.agent ?? "echo";
  const sessionFile = path.join(root, `${runId}-session.jsonl`);
  const asyncDir = path.join(ASYNC_DIR, runId);

  fs.writeFileSync(sessionFile, "", "utf-8");
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
        acceptance: makeSkippedAcceptanceLedger() as any,
      },
    ],
    pause: { kind: "awaiting_supervisor", summary: "Needs supervisor input." },
  });

  const defaultAcceptance = makeSkippedAcceptanceLedger();
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
        acceptance: defaultAcceptance,
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
// Parallel seam helpers — capture params, spawn no runners.
// ---------------------------------------------------------------------------

/**
 * Create an executor with a given agent list and an executeAsyncParallel seam.
 * The seam records calls and returns a stub launch receipt without spawning any
 * background runner processes.
 */
function makeParallelSeamExecutor(
  root: string,
  agentList: AgentConfig[],
): {
  executor: ReturnType<typeof createSubagentExecutor>;
  parallelCalls: Array<{ runId: string; params: unknown }>;
} {
  const parallelCalls: Array<{ runId: string; params: unknown }> = [];
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
    discoverAgents: () => ({ agents: agentList }),
    executeAsyncParallel: ((runId: string, params: unknown) => {
      parallelCalls.push({ runId, params });
      return {
        content: [{ type: "text" as const, text: "async-parallel-seam-ok" }],
        details: { asyncId: runId, results: [] },
      };
    }) as any,
  });
  return { executor, parallelCalls };
}

/** Run a parallel dispatch through a seam executor; no runners are spawned. */
async function runParallelWithSeam(
  root: string,
  agentList: AgentConfig[],
  tasks: unknown[],
): Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  parallelCalls: Array<{ runId: string; params: unknown }>;
}> {
  const { executor, parallelCalls } = makeParallelSeamExecutor(root, agentList);
  const result = await executor.execute(
    "id",
    { tasks } as any,
    new AbortController().signal,
    undefined,
    makeMinimalCtx(root),
  );
  return { ...result, parallelCalls };
}

// ---------------------------------------------------------------------------
// (a) Rejection gate leaves executor state unchanged
// Snapshots state before a rejected call; asserts baseCwd, subagentInProgress,
// foregroundRuns unchanged and no new ASYNC_DIR entry created.
// ---------------------------------------------------------------------------

describe("async-only — rejection gate leaves executor state unchanged", () => {
  function snapshotState(state: ReturnType<typeof makeSubagentState>) {
    return {
      baseCwd: state.baseCwd,
      subagentInProgress: state.subagentInProgress,
      foregroundRunsSize: state.foregroundRuns?.size ?? 0,
    };
  }

  function captureAsyncDirEntries(): Set<string> {
    try {
      return new Set(fs.readdirSync(ASYNC_DIR));
    } catch {
      return new Set();
    }
  }

  it(
    "async:false dispatch leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-async-false-dispatch";
      const root = makeTempDir("tlh-ao-state-false-dispatch-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);

      const before = snapshotState(state);
      const asyncDirBefore = captureAsyncDirEntries();

      const result = await executor.execute(
        "id",
        { agent: "echo", task: "hello", async: false },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );

      const after = snapshotState(state);
      const asyncDirAfter = captureAsyncDirEntries();

      assert.equal(result.isError, true, "async:false dispatch must be rejected");
      assert.deepEqual(
        after,
        before,
        "executor state must be unchanged after async:false rejection",
      );
      const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
      assert.deepEqual(
        newAsyncEntries,
        [],
        "no new ASYNC_DIR entry must be created on async:false rejection",
      );
    },
  );

  it(
    "async:false resume leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no new ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-async-false-resume";
      const root = makeTempDir("tlh-ao-state-false-resume-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);
      const { runId, cleanup } = setupPausedForegroundRun(state, root);

      try {
        const before = snapshotState(state);
        const asyncDirBefore = captureAsyncDirEntries();

        const result = await executor.execute(
          "id",
          { action: "resume", id: runId, async: false },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(root),
        );

        const after = snapshotState(state);
        const asyncDirAfter = captureAsyncDirEntries();

        assert.equal(result.isError, true, "async:false resume must be rejected");
        assert.deepEqual(
          after,
          before,
          "executor state must be unchanged after async:false resume rejection",
        );
        const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
        assert.deepEqual(
          newAsyncEntries,
          [],
          "no new ASYNC_DIR entry must be created on async:false resume rejection",
        );
      } finally {
        cleanup();
      }
    },
  );

  it(
    "print/rpc dispatch leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-print-dispatch";
      const root = makeTempDir("tlh-ao-state-print-dispatch-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);

      const before = snapshotState(state);
      const asyncDirBefore = captureAsyncDirEntries();

      const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
      const result = await executor.execute(
        "id",
        { agent: "echo", task: "hello" },
        new AbortController().signal,
        undefined,
        ctx,
      );

      const after = snapshotState(state);
      const asyncDirAfter = captureAsyncDirEntries();

      assert.equal(result.isError, true, "print mode dispatch must be rejected");
      assert.deepEqual(
        after,
        before,
        "executor state must be unchanged after print-mode rejection",
      );
      const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
      assert.deepEqual(
        newAsyncEntries,
        [],
        "no new ASYNC_DIR entry must be created on print-mode rejection",
      );
    },
  );

  // Remaining matrix cells: single/parallel async:false, mode gate, and live/persisted resume.
  it(
    "parallel async:false dispatch leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-async-false-parallel-dispatch";
      const root = makeTempDir("tlh-ao-state-false-parallel-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);

      const before = snapshotState(state);
      const asyncDirBefore = captureAsyncDirEntries();

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

      const after = snapshotState(state);
      const asyncDirAfter = captureAsyncDirEntries();

      assert.equal(result.isError, true, "parallel async:false must be rejected");
      assert.deepEqual(
        after,
        before,
        "executor state must be unchanged after parallel async:false rejection",
      );
      const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
      assert.deepEqual(
        newAsyncEntries,
        [],
        "no new ASYNC_DIR entry must be created on parallel async:false rejection",
      );
    },
  );

  it(
    "count-expanded async:false dispatch leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-async-false-count-dispatch";
      const root = makeTempDir("tlh-ao-state-false-count-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);

      const before = snapshotState(state);
      const asyncDirBefore = captureAsyncDirEntries();

      const result = await executor.execute(
        "id",
        { tasks: [{ agent: "echo", task: "expand me", count: 3 }], async: false },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(root),
      );

      const after = snapshotState(state);
      const asyncDirAfter = captureAsyncDirEntries();

      assert.equal(result.isError, true, "count-expanded async:false must be rejected");
      assert.deepEqual(
        after,
        before,
        "executor state must be unchanged after count-expanded async:false rejection",
      );
      const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
      assert.deepEqual(
        newAsyncEntries,
        [],
        "no new ASYNC_DIR entry must be created on count-expanded async:false rejection",
      );
    },
  );

  it(
    "print/rpc mode resume leaves state (baseCwd, subagentInProgress, foregroundRuns/Controls) unchanged" +
      " and creates no new ASYNC_DIR entry",
    async () => {
      const sentinel = "/sentinel-print-resume";
      const root = makeTempDir("tlh-ao-state-print-resume-");
      const state = makeSubagentState({ baseCwd: sentinel });
      const executor = makeExecutor(root, state);
      const { runId, cleanup } = setupPausedForegroundRun(state, root);

      try {
        const before = snapshotState(state);
        const asyncDirBefore = captureAsyncDirEntries();

        const ctx = { ...makeMinimalCtx(root), mode: "print" as const };
        const result = await executor.execute(
          "id",
          { action: "resume", id: runId, message: "Resume in print mode" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        const after = snapshotState(state);
        const asyncDirAfter = captureAsyncDirEntries();

        assert.equal(result.isError, true, "print mode resume must be rejected");
        assert.deepEqual(
          after,
          before,
          "executor state must be unchanged after print-mode resume rejection",
        );
        const newAsyncEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
        assert.deepEqual(
          newAsyncEntries,
          [],
          "no new ASYNC_DIR entry must be created on print-mode resume rejection",
        );
      } finally {
        cleanup();
      }
    },
  );

  // NOTE: embedded.* missing-capability rejection mutates baseCwd (initState() runs before
  // project resolution) and predates this ticket; OUT OF SCOPE.  Tests below cover
  // async:false and print/rpc gates that run BEFORE initState(). No test is omitted.

  const rejectMatrixCases: Array<{
    label: string;
    input: (
      state: ReturnType<typeof makeSubagentState>,
      root: string,
    ) => { dispatch: Record<string, unknown>; mode?: "print" | "rpc"; cleanup?: () => void };
  }> = [
    {
      label: "embedded.* async:false dispatch",
      input: () => ({ dispatch: { agent: "embedded.worker", task: "task", async: false } }),
    },
    {
      label: "embedded.* print-mode dispatch",
      input: () => ({
        dispatch: { agent: "embedded.worker", task: "task" },
        mode: "print" as const,
      }),
    },
    {
      label: "embedded.* rpc-mode dispatch",
      input: () => ({ dispatch: { agent: "embedded.worker", task: "task" }, mode: "rpc" as const }),
    },
    {
      label: "parallel print-mode dispatch",
      input: () => ({
        dispatch: {
          tasks: [
            { agent: "echo", task: "t1" },
            { agent: "second", task: "t2" },
          ],
        },
        mode: "print" as const,
      }),
    },
    {
      label: "parallel rpc-mode dispatch",
      input: () => ({
        dispatch: {
          tasks: [
            { agent: "echo", task: "t1" },
            { agent: "second", task: "t2" },
          ],
        },
        mode: "rpc" as const,
      }),
    },
    {
      label: "count-expanded print-mode dispatch",
      input: () => ({
        dispatch: { tasks: [{ agent: "echo", task: "expand", count: 2 }] },
        mode: "print" as const,
      }),
    },
    {
      label: "count-expanded rpc-mode dispatch",
      input: () => ({
        dispatch: { tasks: [{ agent: "echo", task: "expand", count: 2 }] },
        mode: "rpc" as const,
      }),
    },
    {
      label: "rpc single dispatch",
      input: () => ({ dispatch: { agent: "echo", task: "hello" }, mode: "rpc" as const }),
    },
    {
      label: "rpc resume (historical paused-foreground)",
      input: (state, root) => {
        const { runId, cleanup } = setupPausedForegroundRun(state, root);
        return {
          dispatch: { action: "resume", id: runId, message: "resume" },
          mode: "rpc" as const,
          cleanup,
        };
      },
    },
    {
      label: "async:false resume (live async run)",
      input: (state, root) => {
        const { runId, cleanup } = setupLiveAsyncRun(state, root);
        return { dispatch: { action: "resume", id: runId, async: false }, cleanup };
      },
    },
    {
      label: "async:false resume (persisted async run)",
      input: (_state, root) => {
        const { runId, cleanup } = setupPersistedAsyncRun(root);
        return { dispatch: { action: "resume", id: runId, async: false }, cleanup };
      },
    },
    {
      label: "print-mode resume (live async run)",
      input: (state, root) => {
        const { runId, cleanup } = setupLiveAsyncRun(state, root);
        return {
          dispatch: { action: "resume", id: runId, message: "continue" },
          mode: "print" as const,
          cleanup,
        };
      },
    },
    {
      label: "print-mode resume (persisted async run)",
      input: (_state, root) => {
        const { runId, cleanup } = setupPersistedAsyncRun(root);
        return {
          dispatch: { action: "resume", id: runId, message: "continue" },
          mode: "print" as const,
          cleanup,
        };
      },
    },
    {
      label: "rpc-mode resume (live async run)",
      input: (state, root) => {
        const { runId, cleanup } = setupLiveAsyncRun(state, root);
        return {
          dispatch: { action: "resume", id: runId, message: "continue" },
          mode: "rpc" as const,
          cleanup,
        };
      },
    },
    {
      label: "rpc-mode resume (persisted async run)",
      input: (_state, root) => {
        const { runId, cleanup } = setupPersistedAsyncRun(root);
        return {
          dispatch: { action: "resume", id: runId, message: "continue" },
          mode: "rpc" as const,
          cleanup,
        };
      },
    },
  ];

  for (const testCase of rejectMatrixCases) {
    it(`${testCase.label} leaves state unchanged and creates no ASYNC_DIR entry`, async () => {
      const root = makeTempDir(
        `tlh-ao-rm-${testCase.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 30)}-`,
      );
      const state = makeSubagentState({
        baseCwd: "/sentinel-" + testCase.label.replace(/\W+/g, "-"),
      });
      const executor = makeExecutor(root, state);
      const { dispatch, mode, cleanup } = testCase.input(state, root);
      try {
        const before = snapshotState(state);
        const asyncDirBefore = captureAsyncDirEntries();
        const ctx = mode ? { ...makeMinimalCtx(root), mode } : makeMinimalCtx(root);
        const result = await executor.execute(
          "id",
          dispatch as any,
          new AbortController().signal,
          undefined,
          ctx,
        );
        const after = snapshotState(state);
        const asyncDirAfter = captureAsyncDirEntries();
        assert.equal(result.isError, true, `${testCase.label} must be rejected`);
        assert.deepEqual(
          after,
          before,
          `executor state must be unchanged after ${testCase.label} rejection`,
        );
        const newEntries = [...asyncDirAfter].filter((e) => !asyncDirBefore.has(e));
        assert.deepEqual(newEntries, [], `no new ASYNC_DIR entry on ${testCase.label} rejection`);
      } finally {
        cleanup?.();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (b) Parallel output collision check
// Both suites use the executeAsyncParallel seam so no runner processes are spawned.
// Collision tests assert the seam is NOT called; non-colliding tests assert it IS called.
// ---------------------------------------------------------------------------

describe("async-only — parallel output collision check", () => {
  it("rejects two tasks in different cwds with the same relative output when artifacts are enabled", async () => {
    const root = makeTempDir("tlh-ao-col-diffcwd-");
    const { executor, parallelCalls } = makeParallelSeamExecutor(root, [
      makeSupportAgent("writer", { description: "Writer" }),
      makeSupportAgent("reporter", { description: "Reporter" }),
    ]);

    const result = await executor.execute(
      "id",
      {
        tasks: [
          { agent: "writer", task: "write", cwd: "dir1", output: "report.md" },
          { agent: "reporter", task: "report", cwd: "dir2", output: "report.md" },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(result.isError, true, "same-relative-output parallel dispatch must be rejected");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /same path|resolve.*same|duplicate/i);
    assert.equal(parallelCalls.length, 0, "executeAsyncParallel must not be called on collision");
  });

  it("detects agent-default output collisions: two tasks relying on the same agent-default output", async () => {
    const root = makeTempDir("tlh-ao-col-agentdefault-");
    // Both agents declare the same default output path.
    const { executor, parallelCalls } = makeParallelSeamExecutor(root, [
      makeSupportAgent("writer", { description: "Writer", output: "findings.md" }),
      makeSupportAgent("reporter", { description: "Reporter", output: "findings.md" }),
    ]);

    const result = await executor.execute(
      "id",
      {
        // No explicit output: each task picks up the agent default.
        tasks: [
          { agent: "writer", task: "write" },
          { agent: "reporter", task: "report" },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(root),
    );

    assert.equal(
      result.isError,
      true,
      "agent-default output collision must be detected and rejected",
    );
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /same path|resolve.*same|duplicate/i);
    assert.equal(parallelCalls.length, 0, "executeAsyncParallel must not be called on collision");
  });

  it("allows parallel dispatch when tasks have distinct output paths (non-colliding control)", async () => {
    const root = makeTempDir("tlh-ao-col-nodupe-");
    const { parallelCalls, ...result } = await runParallelWithSeam(
      root,
      [
        makeSupportAgent("writer", { description: "Writer" }),
        makeSupportAgent("reporter", { description: "Reporter" }),
      ],
      [
        { agent: "writer", task: "write", output: "output-1.md" },
        { agent: "reporter", task: "report", output: "output-2.md" },
      ],
    );
    // Collision check passes; seam captures the dispatch instead of spawning runners.
    assert.ok(
      notCollisionError(result),
      "distinct outputs must not be rejected by the collision check",
    );
    assert.equal(parallelCalls.length, 1, "executeAsyncParallel seam must be called once");
  });
});

// ---------------------------------------------------------------------------
// (c) Collision-check negative controls — executor level (disabled/file-only/distinct-cwds).
// ---------------------------------------------------------------------------
describe("async-only — collision-check negative controls at executor level", () => {
  it("parallel dispatch with two tasks with output disabled (false) passes collision check", async () => {
    const root = makeTempDir("tlh-ao-neg-disabled-");
    const { parallelCalls, ...result } = await runParallelWithSeam(
      root,
      [
        makeSupportAgent("writer", { description: "Writer" }),
        makeSupportAgent("reporter", { description: "Reporter" }),
      ],
      [
        { agent: "writer", task: "write", output: false },
        { agent: "reporter", task: "report", output: false },
      ],
    );
    assert.ok(
      notCollisionError(result),
      "disabled-output tasks must not be rejected by the collision check",
    );
    assert.equal(parallelCalls.length, 1, "executeAsyncParallel seam must be called once");
  });

  it('parallel dispatch with two tasks with output disabled ("false" string) passes collision check', async () => {
    const root = makeTempDir("tlh-ao-neg-disabled-str-");
    const { parallelCalls, ...result } = await runParallelWithSeam(
      root,
      [
        makeSupportAgent("writer", { description: "Writer" }),
        makeSupportAgent("reporter", { description: "Reporter" }),
      ],
      [
        { agent: "writer", task: "write", output: "false" },
        { agent: "reporter", task: "report", output: "false" },
      ],
    );
    assert.ok(
      notCollisionError(result),
      'string-"false"-output tasks must not be rejected by the collision check',
    );
    assert.equal(parallelCalls.length, 1, "executeAsyncParallel seam must be called once");
  });

  it("parallel file-only tasks with distinct output paths pass collision check", async () => {
    const root = makeTempDir("tlh-ao-neg-fileonly-");
    const { parallelCalls, ...result } = await runParallelWithSeam(
      root,
      [
        makeSupportAgent("writer", { description: "Writer" }),
        makeSupportAgent("reporter", { description: "Reporter" }),
      ],
      [
        { agent: "writer", task: "write", output: "report-a.md", outputMode: "file-only" },
        { agent: "reporter", task: "report", output: "report-b.md", outputMode: "file-only" },
      ],
    );
    assert.ok(
      notCollisionError(result),
      "file-only tasks with distinct outputs must not be rejected by the collision check",
    );
    assert.equal(parallelCalls.length, 1, "executeAsyncParallel seam must be called once");
  });

  it("parallel tasks with distinct output paths in different cwds pass collision check", async () => {
    const root = makeTempDir("tlh-ao-neg-diffcwd-ok-");
    const dir1 = fs.mkdtempSync(path.join(root, "sub1-"));
    const dir2 = fs.mkdtempSync(path.join(root, "sub2-"));
    // Distinct output names ensure different resolved paths whether artifacts
    // are enabled (resolved against outputBaseDir) or disabled (task cwd).
    const { parallelCalls, ...result } = await runParallelWithSeam(
      root,
      [
        makeSupportAgent("writer", { description: "Writer" }),
        makeSupportAgent("reporter", { description: "Reporter" }),
      ],
      [
        { agent: "writer", task: "write", cwd: dir1, output: "report-a.md" },
        { agent: "reporter", task: "report", cwd: dir2, output: "report-b.md" },
      ],
    );
    assert.ok(
      notCollisionError(result),
      "tasks in different cwds with distinct output names must not be rejected by the collision check",
    );
    assert.equal(parallelCalls.length, 1, "executeAsyncParallel seam must be called once");
  });
});
