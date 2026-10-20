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
});
