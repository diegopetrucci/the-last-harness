import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildControlEvent,
  claimControlNotification,
  controlNotificationKey,
  deriveActivityState,
  formatControlNoticeMessage,
  parseControlEvent,
  resolveControlConfig,
  shouldNotifyControlEvent,
} from "../../src/runs/shared/subagent-control.ts";
import type { ControlConfig } from "../../src/shared/types.ts";

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

  it("defaults notifications to needs attention", () => {
    const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
    assert.equal(shouldNotifyControlEvent(config, event), true);
    assert.deepEqual(config.notifyOn, ["needs_attention"]);
    assert.deepEqual(config.notifyChannels, ["event", "async"]);
  });

  it("uses the longer idle default and ignores retired configuration", () => {
    const defaults = resolveControlConfig();
    assert.equal(defaults.needsAttentionAfterMs, 180_000);

    const legacy: ControlConfig = {};
    Reflect.set(legacy, "activeNoticeAfterMs", 1);
    Reflect.set(legacy, "activeNoticeAfterTurns", 1);
    Reflect.set(legacy, "activeNoticeAfterTokens", 1);
    Reflect.set(legacy, "notifyOn", ["active_long_running"]);
    const migrated = resolveControlConfig(legacy);
    assert.equal(migrated.needsAttentionAfterMs, 180_000);
    assert.deepEqual(migrated.notifyOn, []);
    assert.equal(Object.hasOwn(migrated, "activeNoticeAfterMs"), false);
    assert.equal(Object.hasOwn(migrated, "activeNoticeAfterTurns"), false);
    assert.equal(Object.hasOwn(migrated, "activeNoticeAfterTokens"), false);

    Reflect.set(legacy, "notifyOn", ["active_long_running", "needs_attention"]);
    assert.deepEqual(resolveControlConfig(legacy).notifyOn, ["needs_attention"]);
  });

  it("resolves custom notification config", () => {
    const custom = resolveControlConfig(undefined, {
      needsAttentionAfterMs: 1234,
      failedToolAttemptsBeforeAttention: 4,
      notifyOn: ["needs_attention", "nope" as never],
      notifyChannels: ["event", "bad" as never],
    });
    assert.equal(custom.needsAttentionAfterMs, 1234);
    assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
    assert.deepEqual(custom.notifyOn, ["needs_attention"]);
    assert.deepEqual(custom.notifyChannels, ["event"]);
  });

  it("falls back to defaults for invalid non-empty notification arrays", () => {
    const custom = resolveControlConfig(undefined, {
      notifyOn: ["bogus" as never],
      notifyChannels: ["bogus" as never],
    });
    assert.deepEqual(custom.notifyOn, ["needs_attention"]);
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

    const message = formatControlNoticeMessage(event);

    assert.match(message, /Subagent needs attention: worker/);
    assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
    assert.match(message, /Live async nudges interrupt the child before sending the follow-up/);
    assert.match(
      message,
      /Nudge: subagent\(\{ action: "resume", id: "78f659a3", message: "What are you blocked on\?/,
    );
    assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
    assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
    assert.doesNotMatch(message, /Wait:/);
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

    const message = formatControlNoticeMessage(event);

    assert.match(message, /Subagent failed: worker/);
    assert.match(message, /read the output artifact or session/);
    assert.match(message, /Run: 78f659a3 step 1/);
    assert.doesNotMatch(message, /Status:/);
    assert.doesNotMatch(message, /Interrupt:/);
    assert.doesNotMatch(message, /What are you blocked on/);
  });

  it("round-trips bounded idle episode identity without changing legacy or non-idle keys", () => {
    const idle = buildControlEvent({
      to: "needs_attention",
      runId: "run-episode",
      agent: "worker",
      reason: "idle",
      idleEpisodeId: "  attempt-a~idle~1  ",
    });
    const parsed = parseControlEvent(JSON.parse(JSON.stringify(idle)));
    assert.ok(parsed);
    assert.equal(parsed.idleEpisodeId, "attempt-a~idle~1");
    assert.equal(
      controlNotificationKey(parsed),
      "run-episode:needs_attention:idle:attempt-a~idle~1",
    );

    const invalid = parseControlEvent({
      ...idle,
      idleEpisodeId: "\nunsafe",
    });
    assert.ok(invalid);
    assert.equal(invalid.idleEpisodeId, undefined);
    assert.equal(controlNotificationKey(invalid), "run-episode:needs_attention:idle");

    const legacy = buildControlEvent({
      to: "needs_attention",
      runId: "run-legacy",
      agent: "worker",
    });
    assert.equal(controlNotificationKey(legacy), "run-legacy:needs_attention:idle");

    const durable = buildControlEvent({
      to: "needs_attention",
      runId: "run-episode",
      agent: "worker",
      reason: "context_pressure",
      idleEpisodeId: "attempt-a~idle~2",
    });
    assert.equal(durable.idleEpisodeId, undefined);
    assert.equal(controlNotificationKey(durable), "run-episode:needs_attention:context_pressure::");
  });

  it("dedupes notifications once per child and attention state", () => {
    const event = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      index: 0,
    });
    const seen = new Set<string>();

    assert.equal(controlNotificationKey(event), "run-1:0:needs_attention:idle");
    assert.equal(claimControlNotification(resolveControlConfig(), event, seen), true);
    assert.equal(claimControlNotification(resolveControlConfig(), event, seen), false);

    const terminalEvent = buildControlEvent({
      to: "needs_attention",
      runId: "run-1",
      agent: "worker",
      index: 0,
      message: "worker completed without making edits for an implementation task",
      reason: "completion_guard",
    });
    assert.equal(claimControlNotification(resolveControlConfig(), terminalEvent, seen), true);
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
