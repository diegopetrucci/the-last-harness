import { resolveCurrentSessionId } from "../shared/session-identity.js";
import { countLiveAsyncRuns } from "../runs/background/live-async-runs.js";
const MIN_SAVINGS = 0.05;
export function handleCacheWarmingDecision(event, ctx, state) {
    let currentSessionId;
    try {
        currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    }
    catch {
        return undefined;
    }
    if (currentSessionId !== state.currentSessionId)
        return undefined;
    if (countLiveAsyncRuns(state.asyncJobs) <= 0)
        return undefined;
    if (event.missCost - event.warmCost < MIN_SAVINGS)
        return undefined;
    return { action: "warm" };
}
export function registerCacheWarmingDecision(pi, state) {
    pi.on("cache_warming_decision", (event, ctx) => handleCacheWarmingDecision(event, ctx, state));
}
