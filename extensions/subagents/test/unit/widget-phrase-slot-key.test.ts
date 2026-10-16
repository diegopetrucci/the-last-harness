/**
 * Unit tests for widgetPhraseSlotKey and phrase-advancing render behavior.
 *
 * Verifies:
 * - widgetPhraseSlotKey returns "" for non-running jobs.
 * - Job-level slot anchors on job.startedAt.
 * - Job-level slot falls back to running step's startedAt when job.startedAt is absent.
 * - Step rows in parallel mode each contribute their own slot.
 * - Nested child rows contribute their own slot.
 * - Slot changes at the 8-second boundary.
 * - buildWidgetLines renders a different phrase when phraseNow crosses a slot boundary.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PHRASE_HOLD_MS,
  buildWidgetLines,
  createWidgetTestIsolation,
  createWidgetTheme,
  escapeRegExp,
  widgetPhraseSlotKey,
  whimsicalThinkingPhrase,
} from "../support/render-widget-fixtures.ts";

const theme = createWidgetTheme();
const widgetTestIsolation = createWidgetTestIsolation(theme);
beforeEach(widgetTestIsolation.beforeEach);
afterEach(widgetTestIsolation.afterEach);

describe("widgetPhraseSlotKey", () => {
  it("returns empty string for non-running jobs", () => {
    for (const status of ["queued", "complete", "failed", "paused", "continued"] as const) {
      const job = {
        asyncId: "j1",
        asyncDir: "/tmp/j1",
        status,
        startedAt: 0,
        updatedAt: 10_000,
      };
      assert.equal(widgetPhraseSlotKey(job as never, 10_000), "");
    }
  });

  it("job-level row anchors on job.startedAt", () => {
    const startedAt = 0;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt,
      updatedAt: startedAt,
    };
    // At slot boundary 0 → 1 (PHRASE_HOLD_MS ms elapsed)
    const slotBefore = widgetPhraseSlotKey(job as never, PHRASE_HOLD_MS - 1);
    const slotAt = widgetPhraseSlotKey(job as never, PHRASE_HOLD_MS);
    assert.notEqual(slotBefore, slotAt, "slot key must change at PHRASE_HOLD_MS boundary");
  });

  it("falls back to running step startedAt when job.startedAt is absent", () => {
    const stepStartedAt = 10_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      // no startedAt on job
      updatedAt: 10_000,
      steps: [
        {
          status: "running" as const,
          startedAt: stepStartedAt,
          agent: "worker",
          index: 0,
        },
      ],
    };
    // Slot 0 vs slot 1 relative to stepStartedAt
    const slot0 = widgetPhraseSlotKey(job as never, stepStartedAt + PHRASE_HOLD_MS - 1);
    const slot1 = widgetPhraseSlotKey(job as never, stepStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(slot0, slot1, "slot must advance at boundary using step startedAt fallback");
  });

  it("step rows each contribute their own slot (parallel mode)", () => {
    const t0 = 0;
    // Two steps started at different times
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: t0,
      updatedAt: t0,
      mode: "parallel" as const,
      steps: [
        { status: "running" as const, startedAt: t0, agent: "a1", index: 0 },
        { status: "running" as const, startedAt: t0 + 4_000, agent: "a2", index: 1 },
      ],
    };
    // At t0 + PHRASE_HOLD_MS, job-level and step0 change; step1 is still in slot 0
    const keyBefore = widgetPhraseSlotKey(job as never, t0 + PHRASE_HOLD_MS - 1);
    const keyAt = widgetPhraseSlotKey(job as never, t0 + PHRASE_HOLD_MS);
    assert.notEqual(keyBefore, keyAt, "parallel step slots must change at boundary");
    // Both keys should have 3 slot numbers (job-level, step0, step1)
    assert.equal(keyBefore.split(",").length, 3, "should have 3 slot entries (job + 2 steps)");
  });

  it("nested child rows contribute their own slot", () => {
    const childStartedAt = 5_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: 0,
      updatedAt: 5_000,
      nestedChildren: [
        {
          id: "nested-1",
          state: "running" as const,
          startedAt: childStartedAt,
          agent: "nested-worker",
        },
      ],
    };
    const slot0 = widgetPhraseSlotKey(job as never, childStartedAt + PHRASE_HOLD_MS - 1);
    const slot1 = widgetPhraseSlotKey(job as never, childStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(slot0, slot1, "nested child slot must advance at its own startedAt boundary");
    // Should have 2 slot entries: job-level + nested child
    assert.equal(slot0.split(",").length, 2, "should have 2 slot entries (job + nested child)");
  });

  it("does not include non-running nested children", () => {
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: 0,
      updatedAt: 1_000,
      nestedChildren: [
        { id: "n1", state: "complete" as const, startedAt: 0, agent: "done" },
        { id: "n2", state: "failed" as const, startedAt: 0, agent: "err" },
      ],
    };
    const key = widgetPhraseSlotKey(job as never, 5_000);
    // Only job-level slot (1 entry), non-running nested children excluded
    assert.equal(key.split(",").length, 1, "only job-level slot for non-running nested children");
  });

  it("traverses step.children (nested runs under a step) recursively", () => {
    const childStartedAt = 2_000;
    const grandchildStartedAt = 3_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: 0,
      updatedAt: 0,
      steps: [
        {
          status: "running" as const,
          startedAt: 0,
          agent: "worker",
          index: 0,
          children: [
            {
              id: "child-1",
              state: "running" as const,
              startedAt: childStartedAt,
              children: [
                {
                  id: "grandchild-1",
                  state: "running" as const,
                  startedAt: grandchildStartedAt,
                },
              ],
            },
          ],
        },
      ],
    };
    // 4 slots: job-level, step, child, grandchild
    const key = widgetPhraseSlotKey(job as never, 1_000);
    assert.equal(
      key.split(",").length,
      4,
      "should have 4 slot entries (job + step + child + grandchild)",
    );

    // Grandchild slot changes at its own boundary
    const slotBefore = widgetPhraseSlotKey(job as never, grandchildStartedAt + PHRASE_HOLD_MS - 1);
    const slotAt = widgetPhraseSlotKey(job as never, grandchildStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(
      slotBefore,
      slotAt,
      "grandchild slot must advance at its own startedAt boundary",
    );
  });

  it("traverses nested child's steps (NestedRunSummary.steps)", () => {
    const nestedStepStartedAt = 4_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: 0,
      updatedAt: 0,
      nestedChildren: [
        {
          id: "nested-1",
          state: "running" as const,
          startedAt: 1_000,
          steps: [
            {
              agent: "sub-worker",
              status: "running" as const,
              startedAt: nestedStepStartedAt,
            },
          ],
        },
      ],
    };
    // 3 slots: job-level, nested child, nested step
    const key = widgetPhraseSlotKey(job as never, 5_000);
    assert.equal(
      key.split(",").length,
      3,
      "should have 3 slot entries (job + nested child + nested step)",
    );

    // Nested step slot changes at its own boundary
    const slotBefore = widgetPhraseSlotKey(job as never, nestedStepStartedAt + PHRASE_HOLD_MS - 1);
    const slotAt = widgetPhraseSlotKey(job as never, nestedStepStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(
      slotBefore,
      slotAt,
      "nested step slot must advance at its own startedAt boundary",
    );
  });

  it("includes running descendants under a non-running parent job", () => {
    // A job that is not running may still have running nestedChildren (e.g.
    // during status transitions).
    const childStartedAt = 5_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "complete" as const,
      startedAt: 0,
      updatedAt: 10_000,
      nestedChildren: [
        {
          id: "still-running",
          state: "running" as const,
          startedAt: childStartedAt,
        },
      ],
    };
    // Should NOT return "" — the running nested child must be covered
    const key = widgetPhraseSlotKey(job as never, childStartedAt + 1_000);
    assert.notEqual(key, "", "must not return empty string when running nested child exists");
    assert.equal(key.split(",").length, 1, "only nested child slot (job is not running)");

    const slotBefore = widgetPhraseSlotKey(job as never, childStartedAt + PHRASE_HOLD_MS - 1);
    const slotAt = widgetPhraseSlotKey(job as never, childStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(
      slotBefore,
      slotAt,
      "nested child slot must advance even when parent is not running",
    );
  });

  it("traverses child.children recursively (grandchildren of nestedChildren)", () => {
    const grandchildStartedAt = 6_000;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      startedAt: 0,
      updatedAt: 0,
      nestedChildren: [
        {
          id: "child-1",
          state: "running" as const,
          startedAt: 1_000,
          children: [
            {
              id: "grandchild-1",
              state: "running" as const,
              startedAt: grandchildStartedAt,
            },
          ],
        },
      ],
    };
    // 3 slots: job-level, child, grandchild
    const key = widgetPhraseSlotKey(job as never, 7_000);
    assert.equal(key.split(",").length, 3, "should have 3 slot entries (job + child + grandchild)");

    const slotBefore = widgetPhraseSlotKey(job as never, grandchildStartedAt + PHRASE_HOLD_MS - 1);
    const slotAt = widgetPhraseSlotKey(job as never, grandchildStartedAt + PHRASE_HOLD_MS);
    assert.notEqual(slotBefore, slotAt, "grandchild slot must advance at its own boundary");
  });
});

describe("buildWidgetLines phrase-advancing with explicit now", () => {
  it("renders a different phrase when phraseNow crosses a slot boundary (job row)", () => {
    const startedAt = 0;
    // Single running job with no current tool: should show a thinking phrase
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      mode: "single" as const,
      agents: ["worker"],
      startedAt,
      updatedAt: startedAt,
      lastActivityAt: startedAt,
    };
    const slot0Phrase = whimsicalThinkingPhrase(0, startedAt + 1, startedAt);
    const slot1Phrase = whimsicalThinkingPhrase(0, startedAt + PHRASE_HOLD_MS, startedAt);
    assert.notEqual(slot0Phrase, slot1Phrase, "slot 0 and slot 1 phrases must differ");

    const linesSlot0 = buildWidgetLines(
      [job as never],
      theme as never,
      120,
      false,
      startedAt + 1,
    ).join("\n");
    const linesSlot1 = buildWidgetLines(
      [job as never],
      theme as never,
      120,
      false,
      startedAt + PHRASE_HOLD_MS,
    ).join("\n");

    assert.match(linesSlot0, new RegExp(escapeRegExp(slot0Phrase)));
    assert.match(linesSlot1, new RegExp(escapeRegExp(slot1Phrase)));
  });

  it("renders a different phrase for a step row when phraseNow crosses a slot boundary", () => {
    const stepStartedAt = 0;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      mode: "sequential" as const,
      agents: ["worker"],
      startedAt: stepStartedAt,
      updatedAt: stepStartedAt,
      steps: [
        {
          status: "running" as const,
          startedAt: stepStartedAt,
          agent: "worker",
          index: 0,
          lastActivityAt: stepStartedAt,
        },
      ],
    };
    const slot0Phrase = whimsicalThinkingPhrase(0, stepStartedAt + 1, stepStartedAt);
    const slot1Phrase = whimsicalThinkingPhrase(0, stepStartedAt + PHRASE_HOLD_MS, stepStartedAt);
    assert.notEqual(slot0Phrase, slot1Phrase);

    const linesSlot0 = buildWidgetLines(
      [job as never],
      theme as never,
      120,
      false,
      stepStartedAt + 1,
    ).join("\n");
    const linesSlot1 = buildWidgetLines(
      [job as never],
      theme as never,
      120,
      false,
      stepStartedAt + PHRASE_HOLD_MS,
    ).join("\n");

    assert.match(linesSlot0, new RegExp(escapeRegExp(slot0Phrase)));
    assert.match(linesSlot1, new RegExp(escapeRegExp(slot1Phrase)));
  });

  it("renders a different phrase for parallel step rows when phraseNow crosses a boundary", () => {
    const t0 = 0;
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      mode: "parallel" as const,
      agents: ["a1", "a2"],
      startedAt: t0,
      updatedAt: t0,
      stepsTotal: 2,
      runningSteps: 2,
      completedSteps: 0,
      steps: [
        {
          status: "running" as const,
          startedAt: t0,
          agent: "a1",
          index: 0,
          lastActivityAt: t0,
        },
        {
          status: "running" as const,
          startedAt: t0,
          agent: "a2",
          index: 1,
          lastActivityAt: t0,
        },
      ],
    };
    const slot0Phrase = whimsicalThinkingPhrase(0, t0 + 1, t0);
    const slot1Phrase = whimsicalThinkingPhrase(0, t0 + PHRASE_HOLD_MS, t0);

    const linesSlot0 = buildWidgetLines([job as never], theme as never, 160, false, t0 + 1).join(
      "\n",
    );
    const linesSlot1 = buildWidgetLines(
      [job as never],
      theme as never,
      160,
      false,
      t0 + PHRASE_HOLD_MS,
    ).join("\n");

    // Both steps show phrases; slot 0 text appears in slot0 render
    assert.match(linesSlot0, new RegExp(escapeRegExp(slot0Phrase)));
    // Slot 1 text appears in slot1 render
    assert.match(linesSlot1, new RegExp(escapeRegExp(slot1Phrase)));
  });

  it("without phraseNow, phrase uses job.updatedAt as snapshotNow (existing behaviour)", () => {
    const startedAt = 0;
    const updatedAt = 1_000; // < PHRASE_HOLD_MS, so slot 0
    const job = {
      asyncId: "j1",
      asyncDir: "/tmp/j1",
      status: "running" as const,
      mode: "single" as const,
      agents: ["worker"],
      startedAt,
      updatedAt,
      lastActivityAt: updatedAt,
    };
    const expectedPhrase = whimsicalThinkingPhrase(0, updatedAt, startedAt);
    // Call without phraseNow – should use updatedAt, same as before this feature
    const lines = buildWidgetLines([job as never], theme as never, 120, false).join("\n");
    assert.match(lines, new RegExp(escapeRegExp(expectedPhrase)));
  });
});
