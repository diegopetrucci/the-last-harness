import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHealthTransitionState,
  MAX_HEALTH_ATTEMPT_ID_LENGTH,
  MAX_IDLE_EPISODE_ID_LENGTH,
  normalizeIdleEpisodeId,
  recoverValidatedActivity,
  resetHealthTransitionState,
  transitionHealth,
  type HealthTransitionState,
} from "../../src/runs/shared/health-transition.ts";
import type { DurableAttentionReason } from "../../src/shared/types.ts";

function enterIdle(state: HealthTransitionState) {
  return transitionHealth(state, { type: "enter_idle" });
}

describe("shared health transitions", () => {
  it("keeps one idle identity stable, recovers, and creates a distinct second episode", () => {
    const initial = createHealthTransitionState("attempt-a");
    const first = enterIdle(initial);
    const repeated = enterIdle(first.state);
    const recovered = recoverValidatedActivity(repeated.state);
    const second = enterIdle(recovered.state);

    assert.equal(first.changed, true);
    assert.equal(first.projection, "needs_attention");
    assert.equal(first.idleEpisodeStarted, true);
    assert.equal(first.idleAttentionEligible, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.state.idleEpisodeId, first.state.idleEpisodeId);
    assert.equal(recovered.changed, true);
    assert.equal(recovered.projection, undefined);
    assert.equal(recovered.projectionChanged, true);
    assert.equal(recovered.idleEpisodeEnded, true);
    assert.equal(second.idleEpisodeStarted, true);
    assert.notEqual(second.state.idleEpisodeId, first.state.idleEpisodeId);
    assert.match(second.state.idleEpisodeId ?? "", /^attempt-a~idle~/);
  });

  it("keeps durable attention causes sticky while recovering only idle health", () => {
    const idle = enterIdle(createHealthTransitionState("attempt-a"));
    const durable = transitionHealth(idle.state, {
      type: "durable_attention",
      reason: "context_pressure",
    });
    const activity = recoverValidatedActivity(durable.state);
    const secondIdle = enterIdle(activity.state);
    const failure = transitionHealth(secondIdle.state, {
      type: "durable_attention",
      reason: "tool_failures",
    });
    const completion = transitionHealth(failure.state, {
      type: "durable_attention",
      reason: "completion_guard",
    });

    assert.deepEqual(durable.state.durableAttentionReasons, ["context_pressure"]);
    assert.equal(durable.projection, "needs_attention");
    assert.equal(activity.idleEpisodeEnded, true);
    assert.equal(activity.projection, "needs_attention");
    assert.equal(activity.projectionChanged, false);
    assert.equal(activity.state.durableAttentionReasons.includes("context_pressure"), true);
    assert.equal(secondIdle.idleAttentionEligible, false);
    assert.deepEqual(completion.state.durableAttentionReasons, [
      "context_pressure",
      "tool_failures",
      "completion_guard",
    ] satisfies readonly DurableAttentionReason[]);
    assert.equal(completion.projection, "needs_attention");
  });

  it("tracks compaction as an independent operation and clears it on end or attempt reset", () => {
    const initial = createHealthTransitionState("attempt-a");
    const started = transitionHealth(initial, {
      type: "compaction_start",
      reason: "threshold",
    });
    const repeated = transitionHealth(started.state, {
      type: "compaction_start",
      reason: "threshold",
    });
    const ended = transitionHealth(repeated.state, { type: "compaction_end" });
    const restarted = transitionHealth(ended.state, {
      type: "compaction_start",
      reason: "overflow",
    });
    const reset = resetHealthTransitionState(restarted.state, "attempt-b");

    assert.deepEqual(started.state.compaction, { reason: "threshold" });
    assert.equal(started.changed, true);
    assert.equal(started.projection, undefined);
    assert.equal(repeated.changed, false);
    assert.equal(ended.changed, true);
    assert.equal(ended.state.compaction, undefined);
    assert.deepEqual(restarted.state.compaction, { reason: "overflow" });
    assert.equal(reset.state.compaction, undefined);
    assert.equal(reset.state.attemptId, "attempt-b");
  });

  it("normalizes and bounds external episode identities", () => {
    assert.equal(normalizeIdleEpisodeId("  attempt-a~idle~1  "), "attempt-a~idle~1");
    assert.equal(normalizeIdleEpisodeId(""), undefined);
    assert.equal(normalizeIdleEpisodeId("\nunsafe"), undefined);
    assert.equal(normalizeIdleEpisodeId("x".repeat(MAX_IDLE_EPISODE_ID_LENGTH + 1)), undefined);
    assert.throws(
      () => createHealthTransitionState("x".repeat(MAX_HEALTH_ATTEMPT_ID_LENGTH + 1)),
      /attempt id/,
    );
  });

  it("clears ephemeral projection while retaining durable causes", () => {
    const initial = createHealthTransitionState("attempt-a");
    const durable = transitionHealth(initial, {
      type: "durable_attention",
      reason: "context_pressure",
    });
    const idle = enterIdle(durable.state);
    const compacting = transitionHealth(idle.state, {
      type: "compaction_start",
      reason: "overflow",
    });
    const cleared = transitionHealth(compacting.state, { type: "clear_ephemeral" });

    assert.equal(cleared.state.activityState, undefined);
    assert.equal(cleared.state.idleEpisodeId, undefined);
    assert.equal(cleared.state.compaction, undefined);
    assert.deepEqual(cleared.state.durableAttentionReasons, ["context_pressure"]);
    assert.equal(cleared.idleEpisodeEnded, true);
    assert.equal(cleared.projectionChanged, true);

    const nextActivity = recoverValidatedActivity(cleared.state);
    assert.equal(nextActivity.state.activityState, "needs_attention");
    assert.deepEqual(nextActivity.state.durableAttentionReasons, ["context_pressure"]);
  });

  it("preserves durable causes while replacing the child attempt", () => {
    const durable = transitionHealth(createHealthTransitionState("attempt-a"), {
      type: "durable_attention",
      reason: "context_pressure",
    });
    const compacting = transitionHealth(durable.state, {
      type: "compaction_start",
      reason: "overflow",
    });
    const replaced = resetHealthTransitionState(compacting.state, "attempt-b");

    assert.deepEqual(replaced.state.durableAttentionReasons, ["context_pressure"]);
    assert.equal(replaced.state.compaction, undefined);
    assert.equal(replaced.state.idleEpisodeId, undefined);
    assert.equal(replaced.projection, "needs_attention");
  });

  it("uses a new attempt prefix instead of reusing the previous episode identity", () => {
    const firstAttempt = enterIdle(createHealthTransitionState("attempt-a"));
    const replaced = resetHealthTransitionState(firstAttempt.state, "attempt-b");
    const secondAttempt = enterIdle(replaced.state);

    assert.equal(replaced.idleEpisodeEnded, true);
    assert.notEqual(firstAttempt.state.idleEpisodeId, secondAttempt.state.idleEpisodeId);
    assert.match(secondAttempt.state.idleEpisodeId ?? "", /^attempt-b~idle~/);
  });
});
