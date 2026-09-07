import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearPendingForegroundControlNotices,
  handleSubagentControlNotice,
} from "../../src/extension/control-notices.ts";
import type { ControlEvent, SubagentState } from "../../src/shared/types.ts";

function makeState(): SubagentState {
  return {
    baseCwd: "/tmp/project",
    currentSessionId: null,
    asyncJobs: new Map(),
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("subagent control notice delivery", () => {
  it("delivers async needs-attention notices with no options and one nudge when idle", () => {
    const state = makeState();
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      foregroundDelayMs: 20,
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
    const state = makeState();
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      foregroundDelayMs: 20,
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
    const state = makeState();
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "async", event: needsAttentionEvent() },
      foregroundDelayMs: 20,
    });

    assert.equal(recorder.sent.length, 1);
    assert.equal(recorder.nudges.length, 1, "nudge sent when isIdle not provided (assumes idle)");
  });

  it("suppresses async completion-guard notices so terminal completion stays authoritative", () => {
    const state = makeState();
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: {
        source: "async",
        event: needsAttentionEvent({
          message: "worker completed without making edits for an implementation task",
          reason: "completion_guard",
        }),
      },
      foregroundDelayMs: 20,
      isIdle: () => true,
    });

    assert.equal(recorder.sent.length, 0);
    assert.equal(recorder.nudges.length, 0);
  });

  it("queues foreground needs-attention notices until the same step is still actionable, with no nudge", async () => {
    const state = makeState();
    state.foregroundControls.set("run-1", {
      runId: "run-1",
      mode: "single",
      startedAt: 0,
      updatedAt: 0,
      currentAgent: "worker",
      currentIndex: 0,
      currentActivityState: "needs_attention",
    });
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "foreground", event: needsAttentionEvent() },
      foregroundDelayMs: 10,
      isIdle: () => true,
    });

    assert.equal(recorder.sent.length, 0);
    await wait(25);
    assert.equal(recorder.sent.length, 1);
    assert.equal(
      recorder.sent[0]?.options,
      undefined,
      "sendMessage must have no options for foreground",
    );
    assert.equal(recorder.nudges.length, 0, "no nudge for foreground notices");
  });

  it("drops queued foreground notices when the run finishes before delivery", async () => {
    const state = makeState();
    state.foregroundControls.set("run-1", {
      runId: "run-1",
      mode: "single",
      startedAt: 0,
      updatedAt: 0,
      currentAgent: "worker",
      currentIndex: 0,
      currentActivityState: "needs_attention",
    });
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "foreground", event: needsAttentionEvent() },
      foregroundDelayMs: 20,
    });
    clearPendingForegroundControlNotices(state, "run-1");
    state.foregroundControls.delete("run-1");

    await wait(35);
    assert.equal(recorder.sent.length, 0);
    assert.equal(recorder.nudges.length, 0);
  });

  it("drops queued foreground notices after the run advances to another step", async () => {
    const state = makeState();
    state.foregroundControls.set("run-1", {
      runId: "run-1",
      mode: "single",
      startedAt: 0,
      updatedAt: 0,
      currentAgent: "worker",
      currentIndex: 0,
      currentActivityState: "needs_attention",
    });
    const recorder = makeRecorder();

    handleSubagentControlNotice({
      pi: recorder.pi,
      state,
      visibleControlNotices: new Set(),
      details: { source: "foreground", event: needsAttentionEvent() },
      foregroundDelayMs: 10,
    });
    state.foregroundControls.set("run-1", {
      runId: "run-1",
      mode: "single",
      startedAt: 0,
      updatedAt: 0,
      currentAgent: "writer",
      currentIndex: 1,
      currentActivityState: undefined,
    });

    await wait(25);
    assert.equal(recorder.sent.length, 0);
    assert.equal(recorder.nudges.length, 0);
  });
});
