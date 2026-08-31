import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beginBeat,
  CACHE_WRITE_MISMATCH_THRESHOLD,
  closeGap,
  completeBeat,
  createHeartbeatState,
  decideBeat,
  LATE_BEAT_THRESHOLD_MS,
  MAX_CONSECUTIVE_ERRORS,
  openGap,
  recordProviderRequest,
} from "../../src/runs/shared/heartbeat-state.ts";
import type { ResolvedHeartbeatConfig } from "../../src/runs/shared/heartbeat-config.ts";

const cfg: ResolvedHeartbeatConfig = {
  enabled: true,
  intervalMs: 255_000,
  maxDurationMs: 3_600_000,
  maxBeatsPerGap: 3,
};

describe("heartbeat state machine — initial state", () => {
  it("starts disabled=false, consecutiveErrors=0, inFlight=false, gap=null", () => {
    const state = createHeartbeatState();
    assert.equal(state.disabled, false);
    assert.equal(state.consecutiveErrors, 0);
    assert.equal(state.inFlight, false);
    assert.equal(state.gap, null);
  });
});

describe("gap lifecycle", () => {
  it("openGap sets gap fields", () => {
    const state = createHeartbeatState();
    openGap(state, "gap-1", 1000);
    assert.ok(state.gap);
    assert.equal(state.gap.gapId, "gap-1");
    assert.equal(state.gap.gapStartedAt, 1000);
    assert.equal(state.gap.lastRequestAt, 1000);
    assert.equal(state.gap.beatCount, 0);
  });

  it("closeGap nulls the gap", () => {
    const state = createHeartbeatState();
    openGap(state, "gap-1", 1000);
    closeGap(state);
    assert.equal(state.gap, null);
  });

  it("closeGap is safe when no gap is active", () => {
    const state = createHeartbeatState();
    assert.doesNotThrow(() => closeGap(state));
  });
});

describe("recordProviderRequest", () => {
  it("updates lastRequestAt when a gap is active", () => {
    const state = createHeartbeatState();
    openGap(state, "gap-1", 1000);
    recordProviderRequest(state, 5000);
    assert.equal(state.gap?.lastRequestAt, 5000);
  });

  it("is a no-op when no gap is active", () => {
    const state = createHeartbeatState();
    assert.doesNotThrow(() => recordProviderRequest(state, 5000));
  });
});

describe("decideBeat — skip conditions", () => {
  it("returns disabled when state.disabled is true", () => {
    const state = createHeartbeatState();
    state.disabled = true;
    const d = decideBeat(cfg, state, true, 1000);
    assert.equal(d.fire, false);
    assert.equal(d.fire === false && d.outcome, "disabled");
  });

  it("returns no_gap when no gap is active", () => {
    const state = createHeartbeatState();
    const d = decideBeat(cfg, state, true, 1000);
    assert.equal(d.fire, false);
    assert.equal(d.fire === false && d.outcome, "no_gap");
  });

  it("returns not_idle when parent is not idle", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    const d = decideBeat(cfg, state, false, 100);
    assert.equal(d.fire, false);
    assert.equal(d.fire === false && d.outcome, "not_idle");
  });

  it("returns in_flight when a beat is already running", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    state.inFlight = true;
    const d = decideBeat(cfg, state, true, 100);
    assert.equal(d.fire, false);
    assert.equal(d.fire === false && d.outcome, "in_flight");
  });

  it("returns lost and stopGap=true when elapsed >= LATE_BEAT_THRESHOLD_MS", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    const d = decideBeat(cfg, state, true, LATE_BEAT_THRESHOLD_MS);
    assert.equal(d.fire, false);
    if (d.fire === false) {
      assert.equal(d.outcome, "lost");
      assert.equal(d.stopGap, true);
    }
  });

  it("returns capped and stopGap=true when beatCount >= maxBeatsPerGap", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    state.gap!.beatCount = cfg.maxBeatsPerGap;
    const d = decideBeat(cfg, state, true, 100);
    assert.equal(d.fire, false);
    if (d.fire === false) {
      assert.equal(d.outcome, "capped");
      assert.equal(d.stopGap, true);
    }
  });

  it("returns capped and stopGap=true when gap exceeds maxDurationMs", () => {
    const state = createHeartbeatState();
    const now = cfg.maxDurationMs;
    // Open the gap at a point far enough back for duration to exceed maxDurationMs,
    // but set lastRequestAt recently so the late-timer check does not trigger first.
    openGap(state, "g", 0);
    // Override lastRequestAt to be recent so elapsed < LATE_BEAT_THRESHOLD_MS
    state.gap!.lastRequestAt = now - 1;
    const d = decideBeat(cfg, state, true, now);
    assert.equal(d.fire, false);
    if (d.fire === false) {
      assert.equal(d.outcome, "capped");
      assert.equal(d.stopGap, true);
    }
  });

  it("fires when all conditions are met", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    const d = decideBeat(cfg, state, true, 100);
    assert.equal(d.fire, true);
  });

  it("still fires one ms before the late threshold", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    // One ms before the threshold
    const d = decideBeat(cfg, state, true, LATE_BEAT_THRESHOLD_MS - 1);
    assert.equal(d.fire, true);
  });
});

describe("beginBeat", () => {
  it("sets inFlight=true", () => {
    const state = createHeartbeatState();
    beginBeat(state);
    assert.equal(state.inFlight, true);
  });
});

describe("completeBeat — cache_read", () => {
  it("clears inFlight, resets consecutiveErrors, increments beatCount, updates lastRequestAt", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    state.consecutiveErrors = 2;
    beginBeat(state);
    const result = completeBeat(state, "cache_read", 5000);
    assert.equal(state.inFlight, false);
    assert.equal(state.consecutiveErrors, 0);
    assert.equal(state.gap?.beatCount, 1);
    assert.equal(state.gap?.lastRequestAt, 5000);
    assert.equal(result.stopGap, false);
    assert.equal(result.disableSession, false);
  });
});

describe("completeBeat — beatCount increments for ALL outcomes (finding 6)", () => {
  it("increments beatCount on error outcome", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    completeBeat(state, "error", 1000);
    assert.equal(state.gap?.beatCount, 1, "error must increment beatCount");
  });

  it("increments beatCount on cache_write_mismatch outcome", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    completeBeat(state, "cache_write_mismatch", 1000);
    assert.equal(state.gap?.beatCount, 1, "cache_write_mismatch must increment beatCount");
  });

  it("beatCount tracks total ghost requests including errors and mismatches", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    // error
    beginBeat(state);
    completeBeat(state, "error", 1000);
    assert.equal(state.gap?.beatCount, 1);
    // mismatch
    beginBeat(state);
    completeBeat(state, "cache_write_mismatch", 2000);
    // Note: mismatch stops the gap — we just check beatCount before gap is closed
    assert.equal(state.gap?.beatCount, 2);
  });

  it("does not update lastRequestAt on error", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 1000);
    state.gap!.lastRequestAt = 1000;
    beginBeat(state);
    completeBeat(state, "error", 2000);
    assert.equal(state.gap?.lastRequestAt, 1000, "error must not update lastRequestAt");
  });
});

describe("completeBeat — error and circuit breaker", () => {
  it("increments consecutiveErrors on error outcome", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    completeBeat(state, "error", 1000);
    assert.equal(state.consecutiveErrors, 1);
    assert.equal(state.inFlight, false);
    assert.equal(state.disabled, false);
  });

  it("disables session after MAX_CONSECUTIVE_ERRORS errors", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i++) {
      beginBeat(state);
      completeBeat(state, "error", i * 1000);
    }
    assert.equal(state.disabled, false);
    beginBeat(state);
    const result = completeBeat(state, "error", MAX_CONSECUTIVE_ERRORS * 1000);
    assert.equal(state.disabled, true);
    assert.equal(result.disableSession, true);
    assert.equal(result.stopGap, true);
  });

  it("resets consecutiveErrors after a successful cache_read", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    completeBeat(state, "error", 1000);
    beginBeat(state);
    completeBeat(state, "cache_read", 2000);
    assert.equal(state.consecutiveErrors, 0);
    assert.equal(state.disabled, false);
  });
});

describe("completeBeat — cache_write_mismatch circuit breaker", () => {
  it("stops the gap on cache_write_mismatch", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    const result = completeBeat(state, "cache_write_mismatch", 1000);
    assert.equal(result.stopGap, true);
    assert.equal(result.disableSession, false);
  });

  it("does not disable the session on cache_write_mismatch", () => {
    const state = createHeartbeatState();
    openGap(state, "g", 0);
    beginBeat(state);
    const result = completeBeat(state, "cache_write_mismatch", 1000);
    assert.equal(state.disabled, false);
    assert.equal(result.disableSession, false);
  });
});

describe("CACHE_WRITE_MISMATCH_THRESHOLD", () => {
  it("is a positive number", () => {
    assert.ok(CACHE_WRITE_MISMATCH_THRESHOLD > 0);
  });
});

describe("LATE_BEAT_THRESHOLD_MS", () => {
  it("is less than 300 000 (5-minute Anthropic cache TTL)", () => {
    assert.ok(LATE_BEAT_THRESHOLD_MS < 300_000);
    assert.ok(LATE_BEAT_THRESHOLD_MS > 0);
  });
});
