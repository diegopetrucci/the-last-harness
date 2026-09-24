/**
 * cache_warming_decision handler for the subagents extension.
 *
 * While async child runs are live, escalates Pi's idle prompt-cache warming
 * decision from "stop" to "warm" when the economics justify it.
 *
 * Policy notes:
 * - last-handler-wins: returning { action: 'warm' } can override an earlier
 *   extension's 'stop'. Never return { action: 'stop' } — stop ends the whole
 *   warming run, and the event has no phase field to gate on.
 * - P=1 (missCost - warmCost >= 0.05) is an optimistic threshold for the
 *   child-wait case; it is not a measured continuation probability.
 */

import type {
  CacheWarmingDecisionEvent,
  CacheWarmingDecisionEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { countLiveAsyncRuns } from "../runs/background/live-async-runs.ts";
import type { SubagentState } from "../shared/types.ts";

/** Minimum expected savings (missCost - warmCost) required to override to 'warm'. */
const MIN_SAVINGS = 0.05;

/**
 * Evaluate a cache_warming_decision event and return { action: 'warm' } when
 * async children are live and the economics justify warming, or return
 * undefined to abstain and let Pi's own decision stand.
 */
export function handleCacheWarmingDecision(
  event: CacheWarmingDecisionEvent,
  ctx: ExtensionContext,
  state: SubagentState,
): CacheWarmingDecisionEventResult | void {
  // Guard: only act for the session this extension instance owns.
  let currentSessionId: string;
  try {
    currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  } catch {
    // Session identity unavailable — abstain.
    return undefined;
  }
  if (currentSessionId !== state.currentSessionId) return undefined;

  // Guard: only override when at least one async child is genuinely live.
  if (countLiveAsyncRuns(state.asyncJobs) <= 0) return undefined;

  // Guard: simple P=1 economics check — savings must meet Pi's threshold.
  if (event.missCost - event.warmCost < MIN_SAVINGS) return undefined;

  return { action: "warm" };
}

/**
 * Register the cache_warming_decision handler on the Pi extension API.
 */
export function registerCacheWarmingDecision(pi: ExtensionAPI, state: SubagentState): void {
  pi.on(
    "cache_warming_decision",
    (
      event: CacheWarmingDecisionEvent,
      ctx: ExtensionContext,
    ): CacheWarmingDecisionEventResult | void => handleCacheWarmingDecision(event, ctx, state),
  );
}
