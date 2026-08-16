export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function remainingExecutionTimeMs(
  maxExecutionTimeMs: number | undefined,
  activeRuntimeMs = 0,
): number | undefined {
  if (maxExecutionTimeMs === undefined) return undefined;
  return Math.max(0, maxExecutionTimeMs - Math.max(0, activeRuntimeMs));
}
