import * as path from "node:path";
import { ASYNC_DIR } from "../../shared/types.js";
import { lifecycleContinuationForIndex } from "../shared/lifecycle-state.js";
export function cloneForegroundPauseHealth(source, clearMissing = false) {
    return {
        ...(clearMissing || source?.activityState !== undefined
            ? { activityState: source?.activityState }
            : {}),
        ...(clearMissing || source?.idleEpisodeId !== undefined
            ? { idleEpisodeId: source?.idleEpisodeId }
            : {}),
        ...(clearMissing || source?.durableAttentionReasons !== undefined
            ? {
                durableAttentionReasons: source?.durableAttentionReasons
                    ? [...source.durableAttentionReasons]
                    : source?.durableAttentionReasons,
            }
            : {}),
        ...(clearMissing || source?.compaction !== undefined
            ? { compaction: source?.compaction ? { ...source.compaction } : source?.compaction }
            : {}),
    };
}
export function pausedForegroundHealthFromResult(result, clearMissing = false) {
    return cloneForegroundPauseHealth(result.progress, clearMissing);
}
export function indexedLifecycleContinuation(status, index = 0) {
    return lifecycleContinuationForIndex(status, index);
}
export function isClaimedPausedLifecycle(status, index = 0) {
    const continuation = indexedLifecycleContinuation(status, index);
    return (status?.state === "paused" &&
        typeof continuation?.claimToken === "string" &&
        continuation.claimToken.length > 0);
}
export function pausedForegroundStatusPath(runId) {
    return path.join(ASYNC_DIR, runId);
}
export function pausedForegroundTerminationReason(result, pauseProjected = false) {
    return pauseProjected || result.pause ? "paused" : result.terminationReason;
}
