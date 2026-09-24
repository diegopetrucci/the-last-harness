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
  const nudges: Array<{ text: string; options?: unknown }> = [];
  return {
    sent,
    nudges,
    pi: {
      sendMessage(message: unknown, options?: unknown) {
        sent.push({ message, options });
      },
      sendUserMessage(text: string, options?: unknown) {
        nudges.push({ text, options });
      },
    },
  };
}

describe("subagent control notice delivery", () => {
  it("delivers async needs-attention notices with no options and one nudge when idle", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      isIdle: () => true,
    });

    assert.equal(recorder.sent.length, 1);
    assert.equal(
      recorder.sent[0]?.options,
      undefined,
      "sendMessage must have no options (no triggerTurn)",
    );
    assert.equal(recorder.nudges.length, 1, "exactly one nudge");
    assert.equal(
      recorder.nudges[0]?.text,
      "[tlh] Subagent run needs attention \u2014 see notice above.",
    );
    assert.deepEqual(recorder.nudges[0]?.options, { deliverAs: "followUp" });
  });

  it("delivers async needs-attention notices with no options and no nudge when not idle", () => {
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
      "sendMessage must have no options (no triggerTurn)",
    );
    assert.equal(recorder.nudges.length, 0, "no nudge when not idle");
  });

  it("assumes idle when no isIdle is provided (nudge sent)", () => {
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
    });

    assert.equal(recorder.sent.length, 1);
    assert.equal(recorder.nudges.length, 1, "nudge sent when isIdle not provided (assumes idle)");
  });
});
