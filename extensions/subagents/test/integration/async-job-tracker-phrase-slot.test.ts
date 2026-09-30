/**
 * Integration test: phrase-slot boundary triggers a widget rerender.
 *
 * Verifies that when a job's phrase slot changes (live clock advances past
 * PHRASE_HOLD_MS) without any status update, the poller still sets
 * widgetChanged and requests exactly one additional rerender.
 *
 * No fixed sleeps racing the fake clock are used.  The test drives polls via
 * a very small pollIntervalMs and observes render counts through
 * waitForCondition and a quiescence helper.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import {
  available,
  createEventRecorder,
  createState,
  createUiContext,
  trackerMod,
  type AsyncJobTrackerModule,
  waitForCondition,
} from "../support/async-job-tracker-fixtures.ts";
import { PHRASE_HOLD_MS } from "../../src/tui/whimsical-phrases.ts";

/**
 * Wait until the render count has not changed for at least `windowMs`.
 * Returns the stable count.  Fails with an assertion error on timeout.
 */
async function waitForStableCount(
  getCount: () => number,
  windowMs: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastChange = Date.now();
  let prev = getCount();
  while (Date.now() - lastChange < windowMs) {
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for render count to stabilize (last count: ${prev})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = getCount();
    if (current !== prev) {
      lastChange = Date.now();
      prev = current;
    }
  }
  return prev;
}

describe(
  "async job tracker phrase-slot rerender",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
    it("triggers exactly one widget rerender when phrase slot changes without status update", async () => {
      const asyncRoot = createTempDir("pi-async-job-phrase-slot-");
      let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
      try {
        const state = createState();
        const ui = createUiContext();
        const recorder = createEventRecorder();

        const runId = "run-phrase-slot";
        const runDir = path.join(asyncRoot, runId);
        fs.mkdirSync(runDir, { recursive: true });

        // Write a stable status.json so widgetRenderKey does not change after
        // the first poll (the only change is queued → running on that tick).
        const startedAt = 0;
        const lastUpdate = 1_000;
        fs.writeFileSync(
          path.join(runDir, "status.json"),
          JSON.stringify({
            state: "running",
            mode: "single",
            startedAt,
            lastUpdate,
            steps: [{ status: "running", agent: "worker", startedAt }],
          }),
          "utf-8",
        );

        // Controllable clock: start just before a slot boundary.
        let fakeNow = PHRASE_HOLD_MS - 10;
        const nowFn = () => fakeNow;

        // Very small poll interval so stability is observable quickly.
        const pollIntervalMs = 5;
        // Quiescence window: no render for 3 poll intervals before declaring stable.
        const quiescenceMs = 3 * pollIntervalMs;

        tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
          pollIntervalMs,
          completionRetentionMs: 10_000,
          resultsDir: asyncRoot,
          now: nowFn,
        });

        // resetJobs renders once (empty widget).
        // handleStarted renders once (queued job added).
        // First poll renders once (queued → running status transition).
        // After that the status is stable and fakeNow stays below the slot
        // boundary, so no further renders are expected until the boundary is
        // crossed.  The phrase-slot key is baselined in handleStarted so the
        // queued → running transition does not cause a spurious extra render.
        tracker.resetJobs(ui.ctx as never);
        tracker.handleStarted({
          id: runId,
          asyncDir: runDir,
          agent: "worker",
          mode: "single",
        });

        // Wait for at least one render to confirm setup succeeded.
        await waitForCondition(
          () => ui.widgets.length >= 1,
          "initial render",
          scaleTestTimeout(2_000),
        );

        // Wait for the render count to quiesce before the slot boundary.
        // This confirms that polls within the same slot produce 0 extra renders.
        const stableCount = await waitForStableCount(
          () => ui.widgets.length,
          quiescenceMs,
          scaleTestTimeout(3_000),
        );

        // Cross the slot boundary.
        fakeNow = PHRASE_HOLD_MS + 10;

        // Exactly one rerender must fire on the next poll.
        await waitForCondition(
          () => ui.widgets.length > stableCount,
          "rerender on phrase-slot boundary",
          scaleTestTimeout(2_000),
        );
        const countAfterSlot = ui.widgets.length;
        assert.equal(countAfterSlot, stableCount + 1, "exactly one rerender at slot boundary");

        // After the slot change is consumed, no further rerenders should occur.
        const finalCount = await waitForStableCount(
          () => ui.widgets.length,
          quiescenceMs,
          scaleTestTimeout(2_000),
        );
        assert.equal(finalCount, stableCount + 1, "no additional rerenders after slot is consumed");
      } finally {
        tracker?.resetJobs();
        removeTempDir(asyncRoot);
      }
    });
  },
);
