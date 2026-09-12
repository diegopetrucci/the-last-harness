export const ACTIVITY_MONITOR_INTERVAL_MS = 1_000;
export const ACTIVITY_MONITOR_GAP_THRESHOLD_MS = ACTIVITY_MONITOR_INTERVAL_MS * 2;
export function getActivityMonitorGap(previousMonitorTickAt, now) {
    const gapMs = previousMonitorTickAt === undefined ? 0 : Math.max(0, now - previousMonitorTickAt);
    return { gapMs, detected: gapMs > ACTIVITY_MONITOR_GAP_THRESHOLD_MS };
}
export function observeActivityWindow(input) {
    const { detected } = getActivityMonitorGap(input.previousMonitorTickAt, input.now);
    let observedIdleSince = input.observedIdleSince;
    if (detected)
        observedIdleSince = input.now;
    else if (observedIdleSince === undefined)
        observedIdleSince = input.startedAt;
    else if (input.observedActivityAt !== input.activityAt)
        observedIdleSince = input.now;
    return {
        observedIdleSince,
        observedActivityAt: input.activityAt,
    };
}
export const MAX_IDLE_EPISODE_ID_LENGTH = 128;
export const MAX_HEALTH_ATTEMPT_ID_LENGTH = 96;
const PRINTABLE_ASCII_START = 0x21;
const PRINTABLE_ASCII_END = 0x7e;
export function normalizeIdleEpisodeId(value) {
    if (typeof value !== "string")
        return undefined;
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined ||
            (codePoint < PRINTABLE_ASCII_START && codePoint !== 0x20) ||
            codePoint > PRINTABLE_ASCII_END) {
            return undefined;
        }
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > MAX_IDLE_EPISODE_ID_LENGTH) {
        return undefined;
    }
    return normalized;
}
function normalizeAttemptId(value) {
    const normalized = normalizeIdleEpisodeId(value);
    if (!normalized || normalized.length > MAX_HEALTH_ATTEMPT_ID_LENGTH) {
        throw new Error(`Health transition attempt id must be a non-empty printable value of at most ${MAX_HEALTH_ATTEMPT_ID_LENGTH} characters.`);
    }
    return normalized;
}
export function createHealthTransitionState(attemptId) {
    return {
        attemptId: normalizeAttemptId(attemptId),
        idleEpisodeCount: 0,
        durableAttentionReasons: [],
        activeLongRunningNoticeSent: false,
    };
}
function projectActivityState(state) {
    if (state.durableAttentionReasons.length > 0 || state.idleEpisodeId !== undefined) {
        return "needs_attention";
    }
    return state.activeLongRunningNoticeSent ? "active_long_running" : undefined;
}
function cloneState(state) {
    return {
        ...state,
        durableAttentionReasons: [...state.durableAttentionReasons],
    };
}
function episodeIdFor(state, count) {
    const id = `${state.attemptId}~idle~${count.toString(36)}`;
    const normalized = normalizeIdleEpisodeId(id);
    if (!normalized) {
        throw new Error("Health transition idle episode identity exceeded its bounded format.");
    }
    return normalized;
}
function sameCompaction(left, right) {
    return left?.reason === right?.reason;
}
export function transitionHealth(current, action) {
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
            if (!next.activeLongRunningNoticeSent &&
                next.idleEpisodeId === undefined &&
                next.durableAttentionReasons.length === 0) {
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
            next.idleEpisodeId = undefined;
            next.compaction = undefined;
            next.activityState = undefined;
            clearProjection = true;
            idleEpisodeEnded = previousIdleEpisodeId !== undefined;
            break;
        }
        case "attempt_reset": {
            const attemptId = normalizeAttemptId(action.attemptId);
            next = {
                ...createHealthTransitionState(attemptId),
                durableAttentionReasons: [...current.durableAttentionReasons],
                activeLongRunningNoticeSent: current.activeLongRunningNoticeSent,
            };
            idleEpisodeEnded = previousIdleEpisodeId !== undefined;
            break;
        }
    }
    if (!clearProjection)
        next.activityState = projectActivityState(next);
    const projectionChanged = previousProjection !== next.activityState;
    const changed = projectionChanged ||
        previousIdleEpisodeId !== next.idleEpisodeId ||
        current.attemptId !== next.attemptId ||
        current.idleEpisodeCount !== next.idleEpisodeCount ||
        current.activeLongRunningNoticeSent !== next.activeLongRunningNoticeSent ||
        current.durableAttentionReasons.length !== next.durableAttentionReasons.length ||
        current.durableAttentionReasons.some((reason, index) => reason !== next.durableAttentionReasons[index]) ||
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
export function recoverValidatedActivity(state) {
    return transitionHealth(state, { type: "validated_activity" });
}
export function resetHealthTransitionState(state, attemptId) {
    return transitionHealth(state, { type: "attempt_reset", attemptId });
}
