import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import type { ControlEvent } from "../../src/shared/types.ts";

function needsAttentionEvent(overrides: Partial<ControlEvent> = {}): ControlEvent {
  return {
    type: "needs_attention",
    to: "needs_attention",
    ts: 1,
    runId: "run-1",
    agent: "worker",
    index: 0,
    message: "worker needs attention",
    reason: "idle",
    ...overrides,
  };
}

function makeRecorder() {
  const sent: Array<{ message: unknown; options?: unknown }> = [];
  const syntheticUserMessages: unknown[] = [];
  return {
    sent,
    syntheticUserMessages,
    wakes: () =>
      sent.filter((entry) => (entry.options as { triggerTurn?: boolean } | undefined)?.triggerTurn),
    pi: {
      sendMessage(message: unknown, options?: unknown) {
        sent.push({ message, options });
      },
      sendUserMessage(text: string) {
        syntheticUserMessages.push(text);
      },
    },
  };
}

const triggersTurnOf = (entry: { message: unknown } | undefined) =>
  (entry?.message as { details?: { triggersTurn?: boolean } } | undefined)?.details?.triggersTurn;

const eventOf = (entry: { message: unknown } | undefined): ControlEvent | undefined =>
  (entry?.message as { details?: { event?: ControlEvent } } | undefined)?.details?.event;

describe("subagent control notice delivery", () => {
  it("delivers async needs-attention notices with triggerTurn and no synthetic user message when idle", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      isIdle: () => true,
    });

    assert.equal(recorder.sent.length, 1);
    assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
    assert.equal(triggersTurnOf(recorder.sent[0]), true);
    assert.equal(recorder.syntheticUserMessages.length, 0, "no synthetic user message");
  });

  it("delivers async needs-attention notices with no options (steered, no wake) when not idle", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      isIdle: () => false,
    });

    assert.equal(recorder.sent.length, 1);
    assert.equal(
      recorder.sent[0]?.options,
      undefined,
      "sendMessage must have no options (never triggerTurn:false)",
    );
    assert.equal(recorder.wakes().length, 0, "no triggerTurn when not idle");
    assert.equal(triggersTurnOf(recorder.sent[0]), false);
    assert.equal(recorder.syntheticUserMessages.length, 0);
  });

  it("assumes idle when no isIdle is provided (triggerTurn sent)", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
    });

    assert.equal(recorder.sent.length, 1);
    assert.deepEqual(recorder.sent[0]?.options, { triggerTurn: true });
    assert.equal(triggersTurnOf(recorder.sent[0]), true);
    assert.equal(recorder.syntheticUserMessages.length, 0);
  });

  it("filters notices without an event before delivery", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { event: undefined as never },
    });

    assert.equal(recorder.sent.length, 0);
    assert.equal(recorder.syntheticUserMessages.length, 0);
  });

  it("dedupes live notices while keeping idle and pressure severity distinct", () => {
    const recorder = makeRecorder();
    const visibleControlNotices = new Set<string>();
    const idle = needsAttentionEvent();
    const warning = needsAttentionEvent({
      reason: "context_pressure",
      contextPressureSeverity: "warning",
      contextPressureThreshold: "warning",
      message: "warning pressure",
    });
    const critical = needsAttentionEvent({
      reason: "context_pressure",
      contextPressureSeverity: "critical",
      contextPressureThreshold: "critical",
      message: "critical pressure",
    });

    for (const event of [idle, idle, warning, warning, critical]) {
      handleSubagentControlNotice({
        pi: recorder.pi,
        visibleControlNotices,
        details: { source: "async", event },
      });
    }

    assert.equal(recorder.sent.length, 3);
    assert.equal(eventOf(recorder.sent[0])?.reason, "idle");
    assert.equal(eventOf(recorder.sent[1])?.contextPressureSeverity, "warning");
    assert.equal(eventOf(recorder.sent[2])?.contextPressureSeverity, "critical");
    const warningNotice = recorder.sent[1];
    assert.ok(warningNotice);
    assert.match(
      (warningNotice.message as { content: string }).content,
      /Subagent context pressure: worker/,
    );
    const criticalNotice = recorder.sent[2];
    assert.ok(criticalNotice);
    assert.match(
      (criticalNotice.message as { content: string }).content,
      /Signal: critical pressure/,
    );
  });
});
