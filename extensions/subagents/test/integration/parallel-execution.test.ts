/**
 * Integration tests for the mapConcurrent utility and parallel dispatch validation.
 *
 * Provenance (tlhf-60wy): the runSync-driven parallel worker tests were removed
 * with the foreground engine; independent per-task results and output paths are
 * covered on the background path in executor-dispatch.test.ts,
 * async-single-execution-basic.test.ts and
 * async-execution-models-output-output-artifacts-streaming.test.ts. The
 * dispatch-validation tests here go through executor.execute().
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgent,
  makeMinimalCtx,
  tryImport,
} from "../support/helpers.ts";
import { available, createSubagentExecutor } from "../support/single-execution-fixtures.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const mapConcurrent = utils?.mapConcurrent;

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
// Parallel executor dispatch validation (async path)
// ---------------------------------------------------------------------------

describe(
  "parallel dispatch validation",
  { skip: !available ? "pi packages not available" : undefined },
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

    function makeExecutor() {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state: {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        },
        config: {},
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents: [makeAgent("echo")] }),
      });
    }

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
