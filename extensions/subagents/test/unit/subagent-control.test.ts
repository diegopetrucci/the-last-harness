import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildControlEvent,
  claimControlNotification,
  controlNotificationKey,
  deriveActivityState,
  formatControlIntercomMessage,
  formatControlNoticeMessage,
  parseControlEvent,
  resolveControlConfig,
  shouldNotifyControlEvent,
} from "../../src/runs/shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../src/runs/shared/long-running-guard.ts";

const config = resolveControlConfig(undefined, {
  needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
  it("marks a run as needing attention only after the idle threshold", () => {
    assert.equal(
      deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }),
      undefined,
    );
    assert.equal(
      deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }),
      "needs_attention",
    );
    assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
  });

  it("suppresses idle attention while a tool call is in flight", () => {
    assert.equal(
      deriveActivityState({
        config,
        startedAt: 0,
        lastActivityAt: 0,
        toolCallInFlight: true,
        now: 400,
      }),
      undefined,
    );
    assert.equal(
      deriveActivityState({
        config,
        startedAt: 0,
        lastActivityAt: 0,
        toolCallInFlight: false,
        now: 400,
      }),
      "needs_attention",
    );
  });

  it("builds compact needs-attention control events", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      index: 2,
      ts: 1_000,
      lastActivityAt: 100,
    });
    assert.deepEqual(event, {
      type: "needs_attention",
      to: "needs_attention",
      ts: 1_000,
      runId: "run-1",
      agent: "worker",
      index: 2,
      message: "worker needs attention (no observed activity for 0s)",
      reason: "idle",
      elapsedMs: 900,
    });
  });

  it("supports a specific attention message", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      message: "worker completed without making edits for an implementation task",
    });

    assert.equal(event.message, "worker completed without making edits for an implementation task");
  });

  it("builds terminal completion guard control events", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      message: "worker completed without making edits for an implementation task",
      reason: "completion_guard",
    });

    assert.equal(event.reason, "completion_guard");
  });

  it("defaults notifications to active-long-running and needs attention without intercom", () => {
    const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
    const activeEvent = buildControlEvent({
      type: "active_long_running",
      to: "active_long_running",
      runId: "run-1",
      agent: "worker",
    });
    assert.equal(shouldNotifyControlEvent(config, event), true);
    assert.equal(shouldNotifyControlEvent(config, activeEvent), true);
    assert.deepEqual(config.notifyOn, ["active_long_running", "needs_attention"]);
    assert.deepEqual(config.notifyChannels, ["event", "async"]);
  });

  it("defaults active-long-running notices to elapsed time only", () => {
    const defaults = resolveControlConfig();

    assert.equal(defaults.activeNoticeAfterMs, 240_000);
    assert.equal(defaults.activeNoticeAfterTurns, undefined);
    assert.equal(defaults.activeNoticeAfterTokens, undefined);
    assert.equal(
      nextLongRunningTrigger(defaults, {
        startedAt: 0,
        now: 77_000,
        turns: 50,
        tokens: 800_000,
      }),
      undefined,
    );
    assert.equal(
      nextLongRunningTrigger(defaults, {
        startedAt: 0,
        now: 240_000,
        turns: 1,
        tokens: 1,
      }),
      "time_threshold",
    );
  });

  it("supports opt-in turn and token long-running thresholds", () => {
    const tokenBudget = resolveControlConfig(undefined, {
      activeNoticeAfterMs: 999_999,
      activeNoticeAfterTokens: 500_000,
    });
    const turnBudget = resolveControlConfig(undefined, {
      activeNoticeAfterMs: 999_999,
      activeNoticeAfterTurns: 5,
    });

    assert.equal(
      nextLongRunningTrigger(tokenBudget, {
        startedAt: 0,
        now: 77_000,
        turns: 1,
        tokens: 500_000,
      }),
      "token_threshold",
    );
    assert.equal(
      nextLongRunningTrigger(turnBudget, {
        startedAt: 0,
        now: 77_000,
        turns: 5,
        tokens: 1,
      }),
      "turn_threshold",
    );
  });

  it("resolves custom notification config", () => {
    const custom = resolveControlConfig(undefined, {
      needsAttentionAfterMs: 1234,
      activeNoticeAfterMs: 2345,
      activeNoticeAfterTurns: 7,
      activeNoticeAfterTokens: 8000,
      failedToolAttemptsBeforeAttention: 4,
      notifyOn: ["active_long_running", "needs_attention", "nope" as never],
      notifyChannels: ["event", "intercom", "bad" as never],
    });
    assert.equal(custom.needsAttentionAfterMs, 1234);
    assert.equal(custom.activeNoticeAfterMs, 2345);
    assert.equal(custom.activeNoticeAfterTurns, 7);
    assert.equal(custom.activeNoticeAfterTokens, 8000);
    assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
    assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
    assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
  });

  it("falls back to defaults for invalid non-empty notification arrays", () => {
    const custom = resolveControlConfig(undefined, {
      notifyOn: ["bogus" as never],
      notifyChannels: ["bogus" as never],
    });
    assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
    assert.deepEqual(custom.notifyChannels, ["event", "async"]);
  });

  it("allows empty notification arrays to disable notifications", () => {
    const custom = resolveControlConfig(undefined, {
      notifyOn: [],
      notifyChannels: [],
    });
    const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
    assert.deepEqual(custom.notifyOn, []);
    assert.deepEqual(custom.notifyChannels, []);
    assert.equal(shouldNotifyControlEvent(custom, event), false);
  });

  it("formats control notices with a proactive hint and concrete commands", () => {
    const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

    const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

    assert.match(message, /Subagent needs attention: worker/);
    assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
    assert.match(message, /Live async nudges interrupt the child before sending the follow-up/);
    assert.match(
      message,
      /Nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/,
    );
    assert.match(message, /Direct intercom target: subagent-worker-78f659a3/);
    assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
    assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
    assert.doesNotMatch(message, /Wait:/);
  });

  it("formats active-long-running notices as informational", () => {
    const event = buildControlEvent({
      type: "active_long_running",
      to: "active_long_running",
      runId: "78f659a3",
      agent: "worker",
      turns: 15,
      tokens: 160000,
      toolCount: 42,
      currentTool: "edit",
      currentPath: "src/runs/background/async-status.ts",
      reason: "turn_threshold",
    });

    const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

    assert.match(message, /Subagent active but long-running: worker/);
    assert.match(message, /Inspect status/);
    assert.match(
      message,
      /Nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/,
    );
    assert.match(message, /15 turns/);
    assert.match(message, /160000 tokens/);
    assert.match(message, /path src\/runs\/background\/async-status\.ts/);
    assert.doesNotMatch(message, /Subagent needs attention/);
  });

  it("formats terminal completion guard notices without live-run commands", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "78f659a3",
      agent: "worker",
      index: 0,
      message: "worker completed without making edits for an implementation task",
      reason: "completion_guard",
    });

    const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

    assert.match(message, /Subagent failed: worker/);
    assert.match(message, /read the output artifact or session/);
    assert.match(message, /Run intercom target \(may be inactive\): subagent-worker-78f659a3-1/);
    assert.doesNotMatch(message, /Status:/);
    assert.doesNotMatch(message, /Interrupt:/);
    assert.doesNotMatch(message, /What are you blocked on/);
  });

  it("formats intercom notifications with the same control commands", () => {
    const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

    const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

    assert.match(message, /worker needs attention in run 78f659a3/);
    assert.match(
      message,
      /Nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/,
    );
  });

  it("dedupes notifications once per child target and attention state", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      index: 0,
    });
    const seen = new Set<string>();

    assert.equal(
      controlNotificationKey(event, "subagent-worker-run-1-1"),
      "subagent-worker-run-1-1:needs_attention:idle",
    );
    assert.equal(
      claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"),
      true,
    );
    assert.equal(
      claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"),
      false,
    );

    const terminalEvent = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      index: 0,
      message: "worker completed without making edits for an implementation task",
      reason: "completion_guard",
    });
    assert.equal(
      claimControlNotification(
        resolveControlConfig(),
        terminalEvent,
        seen,
        "subagent-worker-run-1-1",
      ),
      true,
    );
  });

  it("dedupes warning and critical pressure events independently", () => {
    const warning = buildControlEvent({
      to: "needs_attention",
      runId: "run-pressure",
      agent: "worker",
      reason: "context_pressure",
      contextPressureSeverity: "warning",
      contextPressureThreshold: "warning",
      message: "warning",
    });
    const critical = buildControlEvent({
      ...warning,
      contextPressureSeverity: "critical",
      contextPressureThreshold: "critical",
      message: "critical",
    });
    const seen = new Set<string>();
    assert.equal(claimControlNotification(resolveControlConfig(), warning, seen), true);
    assert.equal(claimControlNotification(resolveControlConfig(), warning, seen), false);
    assert.equal(claimControlNotification(resolveControlConfig(), critical, seen), true);
    assert.equal(claimControlNotification(resolveControlConfig(), critical, seen), false);
    assert.deepEqual(parseControlEvent(JSON.parse(JSON.stringify(critical))), critical);
    assert.equal(parseControlEvent({ ...critical, contextPressureSeverity: "bogus" }), undefined);

    const malformedReason = parseControlEvent({ ...critical, reason: "future_reason" });
    assert.ok(malformedReason);
    assert.equal(malformedReason.reason, undefined);
    assert.match(formatControlNoticeMessage(malformedReason), /Subagent needs attention: worker/);
    assert.equal(controlNotificationKey(malformedReason), "run-pressure:needs_attention:idle");
    assert.equal(claimControlNotification(resolveControlConfig(), malformedReason, seen), true);
    assert.equal(claimControlNotification(resolveControlConfig(), malformedReason, seen), false);
  });

  it("retains finite control-event metrics and drops JSON exponent overflow", () => {
    const ordinary = parseControlEvent(
      JSON.parse(
        '{"type":"needs_attention","to":"needs_attention","ts":1000,"runId":"run-metrics","agent":"worker","message":"metrics","turns":0,"tokens":42,"toolCount":3,"currentToolDurationMs":0,"elapsedMs":500}',
      ),
    );
    assert.ok(ordinary);
    assert.deepEqual(
      {
        turns: ordinary.turns,
        tokens: ordinary.tokens,
        toolCount: ordinary.toolCount,
        currentToolDurationMs: ordinary.currentToolDurationMs,
        elapsedMs: ordinary.elapsedMs,
      },
      { turns: 0, tokens: 42, toolCount: 3, currentToolDurationMs: 0, elapsedMs: 500 },
    );

    const overflow = parseControlEvent(
      JSON.parse(
        '{"type":"needs_attention","to":"needs_attention","ts":1000,"runId":"run-overflow","agent":"worker","message":"overflow","turns":1e400,"tokens":1e400,"toolCount":1e400,"currentToolDurationMs":1e400,"elapsedMs":1e400}',
      ),
    );
    assert.ok(overflow);
    assert.deepEqual(
      {
        turns: overflow.turns,
        tokens: overflow.tokens,
        toolCount: overflow.toolCount,
        currentToolDurationMs: overflow.currentToolDurationMs,
        elapsedMs: overflow.elapsedMs,
      },
      {
        turns: undefined,
        tokens: undefined,
        toolCount: undefined,
        currentToolDurationMs: undefined,
        elapsedMs: undefined,
      },
    );
  });
});
