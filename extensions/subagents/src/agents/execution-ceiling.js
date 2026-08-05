export function isPositiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
export function remainingExecutionTimeMs(maxExecutionTimeMs, activeRuntimeMs = 0) {
    if (maxExecutionTimeMs === undefined)
        return undefined;
    return Math.max(0, maxExecutionTimeMs - Math.max(0, activeRuntimeMs));
}
