import { normalizeActiveRuntimeMs } from "../runs/shared/lifecycle-state.js";
export const DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS = 14_400_000;
export const CANONICAL_AGENT_MAX_EXECUTION_TIME_MS = Object.freeze({
    developer: 3_600_000,
    "code-reviewer": 1_800_000,
    "test-runner": 3_600_000,
    librarian: 14_400_000,
    oracle: 2_700_000,
    contrarian: 1_800_000,
    "repo-scout": 600_000,
    "web-scout": 300_000,
    "diff-summarizer": 300_000,
});
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
export function warnRetiredExecutionPolicy(input) {
    if (!isRecord(input) || !hasOwn(input, "maxRunTimeMs"))
        return;
    console.warn("[tlh] Ignoring retired execution.maxRunTimeMs; per-role execution budgets remain active.");
}
export function canonicalAgentMaxExecutionTimeMs(agentName) {
    return Object.hasOwn(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, agentName)
        ? CANONICAL_AGENT_MAX_EXECUTION_TIME_MS[agentName]
        : undefined;
}
export function resolveCustomAgentMaxExecutionTimeMs(maxExecutionTimeMs) {
    return maxExecutionTimeMs ?? DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS;
}
export function isPositiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
export function normalizeExecutionTimeoutOwner(value) {
    return value === "role" || value === "run" ? value : undefined;
}
export function remainingExecutionTimeMs(maxExecutionTimeMs, activeRuntimeMs = 0) {
    if (maxExecutionTimeMs === undefined)
        return undefined;
    if (!isPositiveSafeInteger(maxExecutionTimeMs))
        return 0;
    const consumedActiveRuntimeMs = normalizeActiveRuntimeMs(activeRuntimeMs);
    if (consumedActiveRuntimeMs === undefined)
        return 0;
    return Math.max(0, maxExecutionTimeMs - consumedActiveRuntimeMs);
}
