/**
 * Unit tests for the startedAt projection fix in awaited-progress.ts.
 *
 * Verifies:
 * - buildAwaitedProgressUpdate (PRODUCTION projection) sets AgentProgress.startedAt
 *   from the status without the caller supplying it manually.
 * - With that startedAt, phrases rotate at the 8 s live-clock boundary even when
 *   no new progress update arrives (idle gap scenario).
 * - Phrases stay the same within a single 8 s slot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAwaitedProgressUpdate } from "../../src/runs/background/awaited-progress.ts";
import { PHRASE_HOLD_MS } from "../../src/tui/whimsical-phrases.ts";
import { compactThinkingPhrase } from "../../src/tui/render-primitives.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

const START = 1_000_000; // arbitrary stable epoch ms

/** Minimal AsyncStatus for a running single-step run. */
function makeRunningStatus(startedAt: number): AsyncStatus {
  return {
    runId: "test-run-1",
    mode: "single",
    state: "running",
    startedAt,
    steps: [
      {
        agent: "test-agent",
        status: "running",
        startedAt: undefined, // intentionally absent so projection falls back to run-level
        turnCount: 3,
        toolCount: 2,
        recentOutput: [],
        recentTools: [],
      },
    ],
  };
}

/** Minimal AwaitedProgressInput for a single-task plan. */
const progressInput = {
  id: "test-run-1",
  asyncDir: "/tmp/test-run-1",
  mode: "single" as const,
  plan: {
    kind: "single" as const,
    task: {
      agent: "test-agent",
      task: "do work",
      inheritProjectContext: false,
      inheritSkills: false,
    },
  },
};

describe("buildAwaitedProgressUpdate – startedAt projection", () => {
  it("projects startedAt from status.startedAt when the step has no startedAt", () => {
    const status = makeRunningStatus(START);
    const update = buildAwaitedProgressUpdate(progressInput, status, () => START + 1_000);
    const progressArr = update.details.progress;
    assert.ok(Array.isArray(progressArr) && progressArr.length > 0, "progress array must exist");
    const progress = progressArr[0];
    assert.ok(progress !== undefined, "progress[0] must exist");
    assert.equal(
      progress.startedAt,
      START,
      "startedAt must be projected from status.startedAt when step.startedAt is absent",
    );
  });

  it("projects startedAt from step.startedAt when it is present", () => {
    const status = makeRunningStatus(START);
    // Provide a step-level startedAt that differs from the run-level one.
    status.steps![0]!.startedAt = START + 500;
    const update = buildAwaitedProgressUpdate(progressInput, status, () => START + 2_000);
    const progressArr = update.details.progress;
    assert.ok(Array.isArray(progressArr) && progressArr.length > 0, "progress array must exist");
    const progress = progressArr[0];
    assert.ok(progress !== undefined, "progress[0] must exist");
    assert.equal(
      progress.startedAt,
      START + 500,
      "startedAt must be projected from step.startedAt when present",
    );
  });

  it("phrase rotates at the 8 s boundary with no new progress update (idle gap)", () => {
    const status = makeRunningStatus(START);
    // Build the progress snapshot once; do NOT rebuild it between the two renders.
    const update = buildAwaitedProgressUpdate(progressInput, status, () => START);
    const progressArr = update.details.progress;
    assert.ok(Array.isArray(progressArr) && progressArr.length > 0, "progress array must exist");
    const progress = progressArr[0];
    assert.ok(progress !== undefined, "progress[0] must exist");
    assert.ok(
      progress.startedAt !== undefined,
      "progress.startedAt must be set by the production projection",
    );
    const { startedAt } = progress;

    // Simulate what compactProgressActivityLines does when the host passes
    // `now` to the renderer: elapsedMs = now - progress.startedAt.
    const elapsedJustBefore = START + PHRASE_HOLD_MS - 100 - startedAt; // 7.9 s
    const elapsedJustAfter = START + PHRASE_HOLD_MS + 100 - startedAt; // 8.1 s

    const phraseAt7_9s = compactThinkingPhrase(
      progress.activityState,
      progress.turnCount,
      undefined,
      undefined,
      elapsedJustBefore,
    );
    const phraseAt8_1s = compactThinkingPhrase(
      progress.activityState,
      progress.turnCount,
      undefined,
      undefined,
      elapsedJustAfter,
    );

    assert.ok(phraseAt7_9s !== undefined, "phrase must be defined at 7.9 s");
    assert.ok(phraseAt8_1s !== undefined, "phrase must be defined at 8.1 s");
    assert.notEqual(
      phraseAt7_9s,
      phraseAt8_1s,
      "phrase must change when the live clock crosses the 8 s boundary",
    );
  });

  it("phrase stays the same within a single 8 s slot (no flicker)", () => {
    const status = makeRunningStatus(START);
    const update = buildAwaitedProgressUpdate(progressInput, status, () => START);
    const progressArr2 = update.details.progress;
    assert.ok(Array.isArray(progressArr2) && progressArr2.length > 0, "progress array must exist");
    const progress = progressArr2[0];
    assert.ok(progress !== undefined, "progress[0] must exist");
    assert.ok(progress.startedAt !== undefined, "progress.startedAt must be defined");
    const { startedAt } = progress;

    // Four sample points within the first 8 s slot.
    const elapsedSamples = [0, 1_000, 4_000, PHRASE_HOLD_MS - 1].map(
      (offset) => START + offset - startedAt,
    );
    const phrases = elapsedSamples.map((elapsedMs) =>
      compactThinkingPhrase(
        progress.activityState,
        progress.turnCount,
        undefined,
        undefined,
        elapsedMs,
      ),
    );
    const unique = new Set(phrases);
    assert.equal(
      unique.size,
      1,
      "all samples within the same 8 s slot must produce the same phrase",
    );
  });
});
