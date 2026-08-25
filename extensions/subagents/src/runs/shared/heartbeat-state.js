export const LATE_BEAT_THRESHOLD_MS = 290_000;
export const CACHE_WRITE_MISMATCH_THRESHOLD = 256;
export const MAX_CONSECUTIVE_ERRORS = 3;
export function createHeartbeatState() {
    return {
        disabled: false,
        consecutiveErrors: 0,
        inFlight: false,
        gap: null,
    };
}
export function openGap(state, gapId, now) {
    state.gap = { gapId, gapStartedAt: now, lastRequestAt: now, beatCount: 0 };
}
export function closeGap(state) {
    state.gap = null;
}
export function recordProviderRequest(state, now) {
    if (state.gap) {
        state.gap.lastRequestAt = now;
    }
}
export function decideBeat(config, state, isIdle, now) {
    if (state.disabled)
        return { fire: false, outcome: "disabled", stopGap: false };
    if (!state.gap)
        return { fire: false, outcome: "no_gap", stopGap: false };
    if (!isIdle)
        return { fire: false, outcome: "not_idle", stopGap: false };
    if (state.inFlight)
        return { fire: false, outcome: "in_flight", stopGap: false };
    const elapsed = now - state.gap.lastRequestAt;
    if (elapsed >= LATE_BEAT_THRESHOLD_MS)
        return { fire: false, outcome: "lost", stopGap: true };
    if (state.gap.beatCount >= config.maxBeatsPerGap) {
        return { fire: false, outcome: "capped", stopGap: true };
    }
    const gapElapsed = now - state.gap.gapStartedAt;
    if (gapElapsed >= config.maxDurationMs) {
        return { fire: false, outcome: "capped", stopGap: true };
    }
    return { fire: true };
}
export function beginBeat(state) {
    state.inFlight = true;
}
export function completeBeat(state, outcome, now) {
    state.inFlight = false;
    if (outcome === "cancelled") {
        return { stopGap: false, disableSession: false };
    }
    let stopGap = false;
    if (state.gap) {
        state.gap.beatCount++;
    }
    if (outcome === "cache_read") {
        state.consecutiveErrors = 0;
        if (state.gap) {
            state.gap.lastRequestAt = now;
        }
    }
    else if (outcome === "error") {
        state.consecutiveErrors++;
    }
    else if (outcome === "cache_write_mismatch") {
        stopGap = true;
    }
    const disableSession = state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
    if (disableSession) {
        state.disabled = true;
        stopGap = true;
    }
    return { stopGap, disableSession };
}
