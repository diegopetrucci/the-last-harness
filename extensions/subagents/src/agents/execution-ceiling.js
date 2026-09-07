import { normalizeActiveRuntimeMs } from "../runs/shared/lifecycle-state.js";
export const DEFAULT_SUBAGENT_MAX_RUN_TIME_MS = 14_400_000;
export const DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS = DEFAULT_SUBAGENT_MAX_RUN_TIME_MS;
export const CANONICAL_AGENT_MAX_EXECUTION_TIME_MS = Object.freeze({
    developer: 7_200_000,
    "code-reviewer": 1_800_000,
    "test-runner": 3_600_000,
    librarian: 14_400_000,
    oracle: 2_700_000,
    contrarian: 1_800_000,
    "repo-scout": 600_000,
    "web-scout": 300_000,
    "diff-summarizer": 300_000,
});
let invalidExecutionPolicyWarningShown = false;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function invalidExecutionPolicyDiagnostic() {
    return (`[tlh] Invalid execution.maxRunTimeMs; using the bounded default of ` +
        `${DEFAULT_SUBAGENT_MAX_RUN_TIME_MS}ms (4h). Set a positive safe integer or false.`);
}
function warnInvalidExecutionPolicy(message) {
    if (invalidExecutionPolicyWarningShown)
        return;
    invalidExecutionPolicyWarningShown = true;
    console.warn(message);
}
export function resolveExecutionPolicy(input) {
    const executionRecord = isRecord(input) ? input : undefined;
    if (!executionRecord) {
        if (input === undefined)
            return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS };
        const diagnostic = invalidExecutionPolicyDiagnostic();
        warnInvalidExecutionPolicy(diagnostic);
        return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS, diagnostic };
    }
    if (!hasOwn(executionRecord, "maxRunTimeMs")) {
        return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS };
    }
    const value = executionRecord.maxRunTimeMs;
    if (value === false)
        return { maxRunTimeMs: false };
    if (isPositiveSafeInteger(value))
        return { maxRunTimeMs: value };
    const diagnostic = invalidExecutionPolicyDiagnostic();
    warnInvalidExecutionPolicy(diagnostic);
    return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS, diagnostic };
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
