/**
 * Pure heartbeat state machine.
 *
 * No I/O, no timers, no async — just state transitions.  The controller in
 * heartbeat-controller.ts handles timers and async side-effects, injecting
 * the clock so everything here remains unit-testable.
 *
 * Terminology:
 *   gap    – the window of time while at least one async run is live.
 *            A gap is opened by startGap() and closed by closeGap().
 *   beat   – a ghost provider request issued mid-gap to refresh the
 *            prompt-cache TTL.
 */

import type { ResolvedHeartbeatConfig } from "./heartbeat-config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Loggable outcome for each beat or skip-with-log event. */
export type HeartbeatOutcome =
  | "cache_read" // beat succeeded; cache was read at read-prices
  | "cache_write_mismatch" // beat observed a large cache write; gap stopped
  | "error" // stream or auth error during beat
  | "capped" // per-gap beat cap or max-duration cap reached
  | "lost" // elapsed >= LATE_BEAT_THRESHOLD_MS at beat time; cache TTL likely expired
  | "cancelled"; // beat aborted by a lifecycle event (gap closing) — never affects error breaker

/** Usage observed from the ghost stream's first usage-bearing event. */
export interface HeartbeatUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** State for one active gap. */
export interface HeartbeatGap {
  gapId: string;
  /** Timestamp when this gap was opened. */
  gapStartedAt: number;
  /**
   * Timestamp of the most recent provider request or successful beat.
   * The next beat fires ~intervalMs after this.
   */
  lastRequestAt: number;
  /** Number of completed beats in this gap (all outcomes, including errors/mismatches). */
  beatCount: number;
}

/** Full mutable state owned by the state machine. */
export interface HeartbeatMachineState {
  /** Permanently disabled for the session (e.g. 3 consecutive errors). */
  disabled: boolean;
  /** Number of consecutive beat errors. Resets on cache_read. */
  consecutiveErrors: number;
  /** True while a beat stream is in flight. */
  inFlight: boolean;
  /** Active gap, or null when no live run exists. */
  gap: HeartbeatGap | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** If elapsed since lastRequestAt >= this value, the cache TTL is likely expired. */
export const LATE_BEAT_THRESHOLD_MS = 290_000;

/** If cacheWrite tokens exceed this in a ghost request, stop the gap. */
export const CACHE_WRITE_MISMATCH_THRESHOLD = 256;

/** Session is disabled after this many consecutive beat errors. */
export const MAX_CONSECUTIVE_ERRORS = 3;

// ---------------------------------------------------------------------------
// Decision type
// ---------------------------------------------------------------------------

/** What the controller should do when the beat timer fires. */
export type BeatDecision =
  | { fire: true }
  | {
      fire: false;
      /** Reason is a loggable outcome only for skip conditions that get written to the JSONL log. */
      outcome: "disabled" | "no_gap" | "not_idle" | "in_flight" | "capped" | "lost";
      /** Whether the gap should be closed as a result of this skip. */
      stopGap: boolean;
    };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHeartbeatState(): HeartbeatMachineState {
  return {
    disabled: false,
    consecutiveErrors: 0,
    inFlight: false,
    gap: null,
  };
}

// ---------------------------------------------------------------------------
// Gap lifecycle
// ---------------------------------------------------------------------------

/** Open a new gap. Caller must ensure no gap is already active. */
export function openGap(state: HeartbeatMachineState, gapId: string, now: number): void {
  state.gap = { gapId, gapStartedAt: now, lastRequestAt: now, beatCount: 0 };
}

/** Close the active gap. Safe to call when no gap is active. */
export function closeGap(state: HeartbeatMachineState): void {
  state.gap = null;
}

// ---------------------------------------------------------------------------
// Provider-request capture
// ---------------------------------------------------------------------------

/** Update lastRequestAt whenever the parent sends a real provider request. */
export function recordProviderRequest(state: HeartbeatMachineState, now: number): void {
  if (state.gap) {
    state.gap.lastRequestAt = now;
  }
}

// ---------------------------------------------------------------------------
// Beat scheduling
// ---------------------------------------------------------------------------

/**
 * Decide whether to fire a beat when the timer callback runs.
 *
 * @param config   Resolved config for the current session.
 * @param state    Current machine state (not mutated here).
 * @param isIdle   Whether the parent Pi session is currently idle.
 * @param now      Current timestamp (ms).
 */
export function decideBeat(
  config: ResolvedHeartbeatConfig,
  state: HeartbeatMachineState,
  isIdle: boolean,
  now: number,
): BeatDecision {
  if (state.disabled) return { fire: false, outcome: "disabled", stopGap: false };
  if (!state.gap) return { fire: false, outcome: "no_gap", stopGap: false };
  if (!isIdle) return { fire: false, outcome: "not_idle", stopGap: false };
  if (state.inFlight) return { fire: false, outcome: "in_flight", stopGap: false };

  const elapsed = now - state.gap.lastRequestAt;
  if (elapsed >= LATE_BEAT_THRESHOLD_MS) return { fire: false, outcome: "lost", stopGap: true };

  if (state.gap.beatCount >= config.maxBeatsPerGap) {
    return { fire: false, outcome: "capped", stopGap: true };
  }

  const gapElapsed = now - state.gap.gapStartedAt;
  if (gapElapsed >= config.maxDurationMs) {
    return { fire: false, outcome: "capped", stopGap: true };
  }

  return { fire: true };
}

// ---------------------------------------------------------------------------
// Beat lifecycle
// ---------------------------------------------------------------------------

/** Mark a beat as in-flight. Call before launching the ghost stream. */
export function beginBeat(state: HeartbeatMachineState): void {
  state.inFlight = true;
}

export interface CompleteBeatResult {
  /** Whether the gap should be closed after this beat. */
  stopGap: boolean;
  /** Whether the entire session heartbeat has been permanently disabled. */
  disableSession: boolean;
}

/**
 * Record the outcome of a completed beat and advance state.
 *
 * Every ghost request (including errors and mismatches) increments beatCount so
 * the economic cap and beat indices remain accurate across all outcomes.
 *
 * @param state   Machine state (mutated in place).
 * @param outcome The result of the beat.
 * @param now     Current timestamp — used to update lastRequestAt on cache_read.
 */
export function completeBeat(
  state: HeartbeatMachineState,
  outcome: HeartbeatOutcome,
  now: number,
): CompleteBeatResult {
  state.inFlight = false;

  // Lifecycle cancellation: the beat was aborted because the gap is closing.
  // Just reset inFlight — do not increment beatCount, consecutiveErrors, or
  // trigger any gap-stop logic.  The wiring already counted the beat optimistically
  // via onBeatIssued, so no further state changes are needed here.
  if (outcome === "cancelled") {
    return { stopGap: false, disableSession: false };
  }

  let stopGap = false;

  // Always count every ghost request toward beatCount so the economic cap and
  // beat indices are correct even when the beat results in an error or mismatch.
  if (state.gap) {
    state.gap.beatCount++;
  }

  if (outcome === "cache_read") {
    state.consecutiveErrors = 0;
    if (state.gap) {
      // Treat the beat itself as the new lastRequestAt so the next interval
      // starts from when we successfully refreshed the cache.
      state.gap.lastRequestAt = now;
    }
  } else if (outcome === "error") {
    state.consecutiveErrors++;
  } else if (outcome === "cache_write_mismatch") {
    stopGap = true;
  }

  const disableSession = state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
  if (disableSession) {
    state.disabled = true;
    stopGap = true;
  }

  return { stopGap, disableSession };
}
