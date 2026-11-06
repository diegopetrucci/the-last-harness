/**
 * Foreground pause lifecycle projections (read side).
 *
 * New foreground runs are no longer created; these helpers remain for the legacy
 * paused-run inspection, resume, cancel, and fail-closed revival paths.
 */

import * as path from "node:path";
import { ASYNC_DIR, type AsyncStatus, type SingleResult } from "../../shared/types.ts";
import { lifecycleContinuationForIndex } from "../shared/lifecycle-state.ts";

export type ForegroundPauseHealth = Pick<
  NonNullable<AsyncStatus["steps"]>[number],
  "activityState" | "idleEpisodeId" | "durableAttentionReasons" | "compaction"
>;

export function cloneForegroundPauseHealth(
  source: ForegroundPauseHealth | undefined,
  clearMissing = false,
): ForegroundPauseHealth {
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

export function pausedForegroundHealthFromResult(
  result: SingleResult,
  clearMissing = false,
): ForegroundPauseHealth {
  return cloneForegroundPauseHealth(result.progress, clearMissing);
}

export function indexedLifecycleContinuation(
  status: AsyncStatus | null | undefined,
  index = 0,
): NonNullable<AsyncStatus["lifecycle"]>["continuation"] | undefined {
  return lifecycleContinuationForIndex(status, index);
}

export function isClaimedPausedLifecycle(
  status: AsyncStatus | null | undefined,
  index = 0,
): boolean {
  const continuation = indexedLifecycleContinuation(status, index);
  return (
    status?.state === "paused" &&
    typeof continuation?.claimToken === "string" &&
    continuation.claimToken.length > 0
  );
}

export function pausedForegroundStatusPath(runId: string): string {
  return path.join(ASYNC_DIR, runId);
}

export function pausedForegroundTerminationReason(
  result: SingleResult,
  pauseProjected = false,
): NonNullable<SingleResult["terminationReason"]> | undefined {
  return pauseProjected || result.pause ? "paused" : result.terminationReason;
}
