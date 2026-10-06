/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { SingleResult } from "../../src/shared/types.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  makeAgent,
  makeAgentConfigs,
  makeMinimalCtx,
  removeTempDir,
  tryImport,
} from "../support/helpers.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
  it("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  it("preserves order regardless of completion time", async () => {
    const items = [80, 10, 40]; // delays in ms
    const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    assert.deepEqual(results, [0, 1, 2], "results should be in original order");
  });

  it("respects concurrency limit", async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await mapConcurrent(items, 2, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });

    assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
  });

  it("handles empty array", async () => {
    const results = await mapConcurrent([], 4, async (item: unknown) => item);
    assert.deepEqual(results, []);
  });

  it("propagates errors", async () => {
    await assert.rejects(
      () =>
        mapConcurrent([1, 2, 3], 2, async (item: number) => {
          if (item === 2) throw new Error("boom");
          return item;
        }),
      /boom/,
    );
  });
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe(
  "parallel agent execution",
  { skip: !piAvailable ? "pi packages not available" : undefined },
  () => {
    let tempDir: string;
    let mockPi: MockPi;

    before(() => {
      mockPi = createMockPi();
      mockPi.install();
    });

    after(() => {
      mockPi.uninstall();
    });

    beforeEach(() => {
      tempDir = createTempDir();
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function makeExecutor(
      agents = [makeAgent("echo")],
      config: Record<string, unknown> = {},
      runSyncOverride?: (...args: any[]) => Promise<SingleResult>,
    ) {
      return createSubagentExecutor({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        },
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
        runSync: runSyncOverride,
      });
    }

    it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
      const tasks = ["Task A", "Task B", "Task C"];

      const results = await mapConcurrent(
        tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
        3,
        async ({ agent, task, index }: any) => {
          return runSync(tempDir, agents, agent, task, { index });
        },
      );

      assert.equal(results.length, 3);
      assert.ok(results.every((r: any) => r.exitCode === 0));
      assert.equal(results[0].agent, "agent-a");
      assert.equal(results[1].agent, "agent-b");
      assert.equal(results[2].agent, "agent-c");
    });

    it("all agents get independent results", async () => {
      mockPi.onCall({ output: "Result" });
      const agents = makeAgentConfigs(["a", "b"]);

      const results = await mapConcurrent(
        [
          { agent: "a", task: "Task A" },
          { agent: "b", task: "Task B" },
        ],
        2,
        async ({ agent, task }: any, i: number) =>
          runSync(tempDir, agents, agent, task, { index: i }),
      );

      assert.equal(results.length, 2);
      assert.equal(results[0].agent, "a");
      assert.equal(results[1].agent, "b");
      const ok = results.filter((r: any) => r.exitCode === 0).length;
      assert.equal(ok, 2);
    });

    // Removed foreground parallel tests (async-only migration):
    // - "persists independent requester, active, pending, and terminal cohort health through the public executor":
    //   Foreground-only; supervisor pause callbacks have no async dispatch equivalent.
    // - "carries one resolved tk ticket to the matching active foreground parallel child":
    //   Covered by async-execution-runner-launch-config-validation.test.ts
    //   "assigns fresh tickets through async single and two-child parallel launches".
    // - "top-level parallel inherits the parent session model for unconfigured tasks...":
    //   Covered by async-execution-runner-launch-config-validation.test.ts
    //   "propagates canonical developer and native worker policies through async parallel planning".
    // - "top-level parallel surfaces fallback notices after a retry":
    //   Foreground-only model fallback retry; async fallback in
    //   async-execution-models-output-model-fallback-context.test.ts.
    // - "applies agent acceptance roles to inferred parallel acceptance":
    //   Covered by async-execution-runner-launch-config-validation.test.ts
    //   "applies agent acceptance roles to inferred async parallel acceptance".
    // - "top-level parallel output saves use per-task output paths":
    //   Covered by async-execution-models-output-output-artifacts-streaming.test.ts
    //   "background single runs route relative outputs to outputBaseDir".
    // - "top-level parallel preserves completed siblings and marks timed-out children":
    //   Foreground-only timeout/sibling behavior; async timeouts in
    //   async-execution-runner-deadlines-process-failures.test.ts.
    // - "enforces mixed foreground agent ceilings independently":
    //   Foreground-only ceiling enforcement; no async equivalent.
    // - "top-level parallel file-only output aggregates concise file references":
    //   Covered by async-execution-models-output-output-artifacts-streaming.test.ts
    //   "background file-only runs write full output but return only a file reference".
    // - "treats string false as disabled output in top-level parallel runs":
    //   Covered by async-execution-models-output-output-artifacts-streaming.test.ts
    //   "background single runs treat string false as disabled output".
    // - "top-level parallel reads are injected once with a task/read prefix":
    //   Covered by async launch-config validation tests.
    // - "top-level parallel defaultProgress uses isolated run storage":
    //   Foreground-only; async progress is configured via async runner plan.
    // - "top-level parallel suppresses progress when the task is review-only":
    //   Foreground-only; async covered via async runner plan.

    it(
      "rejects parallel execution action aliases instead of normalizing them",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        for (const action of ["parallel", "PARALLEL", "tasks"]) {
          mockPi.reset();
          const executor = makeExecutor();

          const result = await executor.execute(
            `parallel-alias-${action}`,
            { action, tasks: [{ agent: "echo", task: `Run ${action}` }] },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", new RegExp(`Unknown action: ${action}`));
          assert.equal(mockPi.callCount(), 0);
        }
      },
    );

    it(
      "rejects top-level parallel file-only output without an output path",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const executor = makeExecutor();

        const result = await executor.execute(
          "parallel-file-only-missing-output",
          { tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
        assert.equal(mockPi.callCount(), 0);
      },
    );

    it(
      "rejects duplicate top-level parallel output paths",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const executor = makeExecutor();

        const result = await executor.execute(
          "parallel-duplicate-output",
          {
            tasks: [
              { agent: "echo", task: "Write A", output: "same.md" },
              { agent: "echo", task: "Write B", output: "same.md" },
            ],
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /same path/);
        assert.equal(mockPi.callCount(), 0);
      },
    );
  },
);
