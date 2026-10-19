/**
 * Active-runtime accounting for per-instance role budgets. Values crossing a
 * persistence boundary are accepted only when finite and non-negative; consumed
 * time is rounded upward and clamped to a safe integer so legacy or corrupt
 * evidence can never widen a continuation budget.
 */
export function normalizeActiveRuntimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
    : undefined;
}

/** Normalize an accounting checkpoint timestamp without allowing unsafe output. */
export function normalizeActiveRuntimeCheckpointAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : undefined;
}

export function boundedActiveRuntimeMs(value: unknown, fallback = 0): number {
  return normalizeActiveRuntimeMs(value) ?? normalizeActiveRuntimeMs(fallback) ?? 0;
}
