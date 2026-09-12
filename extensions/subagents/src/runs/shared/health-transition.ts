import type {
  ActivityState,
  CompactionReason,
  DurableAttentionReason,
} from "../../shared/types.ts";

/** Watchdog cadence shared by foreground and background activity observers. */
export const ACTIVITY_MONITOR_INTERVAL_MS = 1_000;
export const ACTIVITY_MONITOR_GAP_THRESHOLD_MS = ACTIVITY_MONITOR_INTERVAL_MS * 2;

export function getActivityMonitorGap(
  previousMonitorTickAt: number | undefined,
  now: number,
): { gapMs: number; detected: boolean } {
  const gapMs = previousMonitorTickAt === undefined ? 0 : Math.max(0, now - previousMonitorTickAt);
  return { gapMs, detected: gapMs > ACTIVITY_MONITOR_GAP_THRESHOLD_MS };
}

/**
 * Advance an observation window without rewriting the child's activity time.
 * A delayed watchdog tick starts a new window; otherwise a changed activity
 * timestamp or an uninitialized window starts observation at the current time.
 */
export function observeActivityWindow(input: {
  previousMonitorTickAt?: number;
  now: number;
  startedAt: number;
  activityAt: number;
  observedIdleSince?: number;
  observedActivityAt?: number;
}): {
  observedIdleSince: number;
  observedActivityAt: number;
} {
  const { detected } = getActivityMonitorGap(input.previousMonitorTickAt, input.now);
  let observedIdleSince = input.observedIdleSince;
  if (detected) observedIdleSince = input.now;
  else if (observedIdleSince === undefined) observedIdleSince = input.startedAt;
  else if (input.observedActivityAt !== input.activityAt) observedIdleSince = input.now;
  return {
    observedIdleSince,
    observedActivityAt: input.activityAt,
  };
}

/** Maximum length of an episode identity carried through a control event. */
export const MAX_IDLE_EPISODE_ID_LENGTH = 128;

/** Maximum length of the unique attempt prefix used to create episode identities. */
export const MAX_HEALTH_ATTEMPT_ID_LENGTH = 96;

const PRINTABLE_ASCII_START = 0x21;
const PRINTABLE_ASCII_END = 0x7e;

/**
 * Normalize an externally supplied episode identity before it is persisted or
 * used in a notification key. IDs are deliberately conservative: they are
 * short, non-empty printable values so a child cannot inject line breaks or
 * grow control records without bound.
 */
export function normalizeIdleEpisodeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint < PRINTABLE_ASCII_START && codePoint !== 0x20) ||
      codePoint > PRINTABLE_ASCII_END
    ) {
      return undefined;
    }
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_IDLE_EPISODE_ID_LENGTH) {
    return undefined;
  }
  return normalized;
}

function normalizeAttemptId(value: string): string {
  const normalized = normalizeIdleEpisodeId(value);
  if (!normalized || normalized.length > MAX_HEALTH_ATTEMPT_ID_LENGTH) {
    throw new Error(
      `Health transition attempt id must be a non-empty printable value of at most ${MAX_HEALTH_ATTEMPT_ID_LENGTH} characters.`,
    );
  }
  return normalized;
}

export interface CompactionOperation {
  reason: CompactionReason;
}

/** Health state for one active execution segment and its durable run projection. */
export interface HealthTransitionState {
  /** Caller-supplied unique prefix. It must change for every replacement attempt. */
  attemptId: string;
  /** Monotonic count for this attempt; it is never used as the identity alone. */
  idleEpisodeCount: number;
  /** Current idle episode, if the attempt is presently idle. */
  idleEpisodeId?: string;
  /** All durable causes observed during this attempt, without selecting one to erase another. */
  durableAttentionReasons: readonly DurableAttentionReason[];
  /** Compaction is an operation independent of current tool state. */
  compaction?: CompactionOperation;
  /** Whether the one-shot active-long-running notice has already been earned. */
  activeLongRunningNoticeSent: boolean;
  /** Display projection for callers to publish. */
  activityState?: ActivityState;
}

export type HealthTransitionAction =
  | { type: "enter_idle" }
  | { type: "validated_activity" }
  | { type: "durable_attention"; reason: DurableAttentionReason }
  | { type: "active_long_running" }
  | { type: "compaction_start"; reason: CompactionReason }
  | { type: "compaction_end" }
  | { type: "clear_ephemeral" }
  | { type: "attempt_reset"; attemptId: string };

export interface HealthTransitionResult {
  state: HealthTransitionState;
  /** True when any health, episode, durable-cause, or operation metadata changed. */
  changed: boolean;
  /** True when the displayed activity enum changed. */
  projectionChanged: boolean;
  projection: ActivityState | undefined;
  /** True only when this action created a new idle episode. */
  idleEpisodeStarted: boolean;
  /** True only when validated activity or an attempt reset ended an idle episode. */
  idleEpisodeEnded: boolean;
  /** True when a newly earned active-long-running notice should be published. */
  activeLongRunningNotice: boolean;
  /** True when this action can publish an idle-derived notice without masking a durable cause. */
  idleAttentionEligible: boolean;
}

export function createHealthTransitionState(attemptId: string): HealthTransitionState {
  return {
    attemptId: normalizeAttemptId(attemptId),
    idleEpisodeCount: 0,
    durableAttentionReasons: [],
    activeLongRunningNoticeSent: false,
  };
}

function projectActivityState(state: HealthTransitionState): ActivityState | undefined {
  if (state.durableAttentionReasons.length > 0 || state.idleEpisodeId !== undefined) {
    return "needs_attention";
  }
  return state.activeLongRunningNoticeSent ? "active_long_running" : undefined;
}

function cloneState(state: HealthTransitionState): HealthTransitionState {
  return {
    ...state,
    durableAttentionReasons: [...state.durableAttentionReasons],
  };
}

function episodeIdFor(state: HealthTransitionState, count: number): string {
  const id = `${state.attemptId}~idle~${count.toString(36)}`;
  const normalized = normalizeIdleEpisodeId(id);
  if (!normalized) {
    throw new Error("Health transition idle episode identity exceeded its bounded format.");
  }
  return normalized;
}

function sameCompaction(
  left: CompactionOperation | undefined,
  right: CompactionOperation | undefined,
): boolean {
  return left?.reason === right?.reason;
}

/**
 * Apply one concrete health transition without timers, I/O, or runner policy.
 * The input state is not mutated, making the helper safe to share between
 * foreground and background producers.
 */
export function transitionHealth(
  current: HealthTransitionState,
  action: HealthTransitionAction,
): HealthTransitionResult {
  const previousProjection = projectActivityState(current);
  const previousIdleEpisodeId = current.idleEpisodeId;
  const previousCompaction = current.compaction;
  let next = cloneState(current);
  let idleEpisodeStarted = false;
  let idleEpisodeEnded = false;
  let activeLongRunningNotice = false;
  let idleAttentionEligible = false;
  let clearProjection = false;

  switch (action.type) {
    case "enter_idle": {
      if (next.idleEpisodeId === undefined) {
        next.idleEpisodeCount += 1;
        next.idleEpisodeId = episodeIdFor(next, next.idleEpisodeCount);
        idleEpisodeStarted = true;
        idleAttentionEligible = next.durableAttentionReasons.length === 0;
      }
      break;
    }
    case "validated_activity": {
      if (next.idleEpisodeId !== undefined) {
        next.idleEpisodeId = undefined;
        idleEpisodeEnded = true;
      }
      break;
    }
    case "durable_attention": {
      if (!next.durableAttentionReasons.includes(action.reason)) {
        next.durableAttentionReasons = [...next.durableAttentionReasons, action.reason];
      }
      break;
    }
    case "active_long_running": {
      if (
        !next.activeLongRunningNoticeSent &&
        next.idleEpisodeId === undefined &&
        next.durableAttentionReasons.length === 0
      ) {
        next.activeLongRunningNoticeSent = true;
        activeLongRunningNotice = true;
      }
      break;
    }
    case "compaction_start": {
      next.compaction = { reason: action.reason };
      break;
    }
    case "compaction_end": {
      next.compaction = undefined;
      break;
    }
    case "clear_ephemeral": {
      // Lifecycle cleanup clears recoverable health metadata without erasing
      // durable causes or an already-earned long-running notice. The closed
      // runner segment must not immediately re-project those retained causes;
      // a later validated producer or attempt reset may do so explicitly.
      next.idleEpisodeId = undefined;
      next.compaction = undefined;
      next.activityState = undefined;
      clearProjection = true;
      idleEpisodeEnded = previousIdleEpisodeId !== undefined;
      break;
    }
    case "attempt_reset": {
      const attemptId = normalizeAttemptId(action.attemptId);
      // A replacement starts with no in-flight operation or idle episode, but
      // durable causes and an already-earned long-running notice belong to the
      // run projection and must not be lost at an attempt boundary.
      next = {
        ...createHealthTransitionState(attemptId),
        durableAttentionReasons: [...current.durableAttentionReasons],
        activeLongRunningNoticeSent: current.activeLongRunningNoticeSent,
      };
      idleEpisodeEnded = previousIdleEpisodeId !== undefined;
      break;
    }
  }

  if (!clearProjection) next.activityState = projectActivityState(next);
  const projectionChanged = previousProjection !== next.activityState;
  const changed =
    projectionChanged ||
    previousIdleEpisodeId !== next.idleEpisodeId ||
    current.attemptId !== next.attemptId ||
    current.idleEpisodeCount !== next.idleEpisodeCount ||
    current.activeLongRunningNoticeSent !== next.activeLongRunningNoticeSent ||
    current.durableAttentionReasons.length !== next.durableAttentionReasons.length ||
    current.durableAttentionReasons.some(
      (reason, index) => reason !== next.durableAttentionReasons[index],
    ) ||
    !sameCompaction(previousCompaction, next.compaction);

  return {
    state: next,
    changed,
    projectionChanged,
    projection: next.activityState,
    idleEpisodeStarted,
    idleEpisodeEnded,
    activeLongRunningNotice,
    idleAttentionEligible,
  };
}

/** Convenience wrapper for a validated activity boundary. */
export function recoverValidatedActivity(state: HealthTransitionState): HealthTransitionResult {
  return transitionHealth(state, { type: "validated_activity" });
}

/** Convenience wrapper for cleanup or model-attempt replacement. */
export function resetHealthTransitionState(
  state: HealthTransitionState,
  attemptId: string,
): HealthTransitionResult {
  return transitionHealth(state, { type: "attempt_reset", attemptId });
}
