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

/** Internal runner cadence for durable active-runtime accounting evidence. */
export const ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * Pure persistence gate for runner-owned accounting checkpoints. A frozen
 * tracker may still expose its final total, but it must never trigger another
 * periodic status write. The runner supplies the pre-checkpoint frozen state so
 * a final freeze can publish one last runtime advance before teardown.
 */
export function shouldPersistActiveRuntimeCheckpoint(input: {
  previousActiveRuntimeMs: unknown;
  currentActiveRuntimeMs: unknown;
  trackerFrozen: boolean;
}): boolean {
  if (input.trackerFrozen) return false;
  const current = normalizeActiveRuntimeMs(input.currentActiveRuntimeMs);
  const previous = normalizeActiveRuntimeMs(input.previousActiveRuntimeMs);
  return current !== undefined && (previous === undefined || current > previous);
}

export interface ActiveRuntimeTracker {
  current(now?: number): number;
  checkpoint(now?: number): number;
  /** Freeze this segment so post-terminal cleanup time is never charged. */
  freeze(now?: number): number;
  /** Whether this segment has already been frozen. */
  isFrozen(): boolean;
  finalize(now?: number): number;
}

export interface ActiveRuntimeCheckpointUpdate {
  activeRuntimeMs: number;
  activeRuntimeCheckpointAt: number;
}

export interface ActiveRuntimeCheckpointCandidate {
  tracker: ActiveRuntimeTracker;
  previousActiveRuntimeMs: unknown;
  previousActiveRuntimeCheckpointAt: unknown;
  apply: (update: ActiveRuntimeCheckpointUpdate) => void;
}

/**
 * Apply one runner checkpoint decision across its active steps. The tracker
 * frozen flag is sampled before checkpoint/freeze so a final freeze can publish
 * one last runtime advance, while repeated or already-frozen calls do not
 * invoke the injected persistence callback.
 */
export function applyActiveRuntimeCheckpoint(
  candidates: readonly ActiveRuntimeCheckpointCandidate[],
  input: { now: number; freeze?: boolean; persist?: () => void },
): boolean {
  let advanced = false;
  for (const candidate of candidates) {
    const trackerFrozen = candidate.tracker.isFrozen();
    const runtime = input.freeze
      ? candidate.tracker.freeze(input.now)
      : candidate.tracker.checkpoint(input.now);
    if (
      !shouldPersistActiveRuntimeCheckpoint({
        previousActiveRuntimeMs: candidate.previousActiveRuntimeMs,
        currentActiveRuntimeMs: runtime,
        trackerFrozen,
      })
    )
      continue;
    candidate.apply({
      activeRuntimeMs: Math.max(
        normalizeActiveRuntimeMs(candidate.previousActiveRuntimeMs) ?? 0,
        runtime,
      ),
      activeRuntimeCheckpointAt: Math.max(
        normalizeActiveRuntimeCheckpointAt(candidate.previousActiveRuntimeCheckpointAt) ?? 0,
        normalizeActiveRuntimeCheckpointAt(input.now) ?? 0,
      ),
    });
    advanced = true;
  }
  if (advanced) input.persist?.();
  return advanced;
}

/**
 * Track one active execution segment without ever charging the same interval
 * twice. A checkpoint advances the segment origin, so a later finalization
 * adds only the time since that checkpoint. Paused time belongs outside this
 * tracker; a resumed segment should create a new tracker with the checkpointed
 * total as its prior value.
 */
export function createActiveRuntimeTracker(
  input: {
    priorActiveRuntimeMs?: unknown;
    segmentStartedAt?: number;
    now?: () => number;
  } = {},
): ActiveRuntimeTracker {
  const now = input.now ?? (() => Date.now());
  const suppliedSegmentStart = normalizeActiveRuntimeCheckpointAt(input.segmentStartedAt);
  const initialNow =
    suppliedSegmentStart ?? normalizeActiveRuntimeCheckpointAt(now()) ?? Date.now();
  let total = boundedActiveRuntimeMs(input.priorActiveRuntimeMs);
  let segmentStartedAt = suppliedSegmentStart ?? initialNow;
  let frozen = false;

  const current = (at = now()): number => {
    if (frozen) return total;
    const normalizedAt = normalizeActiveRuntimeCheckpointAt(at);
    const elapsed = normalizedAt === undefined ? 0 : Math.max(0, normalizedAt - segmentStartedAt);
    return Math.min(Number.MAX_SAFE_INTEGER, total + elapsed);
  };
  const checkpoint = (at = now()): number => {
    const normalizedAt = normalizeActiveRuntimeCheckpointAt(at) ?? segmentStartedAt;
    const checkpointAt = Math.max(segmentStartedAt, normalizedAt);
    total = current(checkpointAt);
    segmentStartedAt = checkpointAt;
    return total;
  };
  const freeze = (at = now()): number => {
    if (!frozen) {
      checkpoint(at);
      frozen = true;
    }
    return total;
  };
  return {
    current,
    checkpoint,
    freeze,
    isFrozen: () => frozen,
    finalize: (at = now()) => (frozen ? total : checkpoint(at)),
  };
}

/**
 * Name the first accounting field that is present but malformed. Absent
 * metadata is legacy-compatible (it counts as unspent); a present value that
 * cannot be trusted must reject the continuation rather than be dropped, since
 * dropping it would silently widen the instance's role budget or erase its
 * poison classification.
 */
export function malformedActiveRuntimeAccountingField(
  value: Record<string, unknown>,
): "activeRuntimeMs" | "activeRuntimeCheckpointAt" | "timeoutOwner" | undefined {
  for (const field of ["activeRuntimeMs", "activeRuntimeCheckpointAt"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) return field;
  }
  const owner = value.timeoutOwner;
  if (owner !== undefined && owner !== "role" && owner !== "run") return "timeoutOwner";
  return undefined;
}

const ACCOUNTING_FIELDS = ["activeRuntimeMs", "activeRuntimeCheckpointAt", "timeoutOwner"] as const;

/**
 * Re-attach present-but-malformed accounting fields from the raw persisted
 * status (root and per-step by index) onto a normalized status, verbatim.
 * Only for persistence paths that must not erase fail-closed evidence.
 */
export function carryMalformedAccounting<T extends object>(normalized: T, raw: unknown): T {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject(raw)) return normalized;
  const carry = (target: Record<string, unknown>, source: unknown): Record<string, unknown> => {
    if (!isObject(source)) return target;
    const next = { ...target };
    for (const field of ACCOUNTING_FIELDS) {
      if (
        source[field] !== undefined &&
        malformedActiveRuntimeAccountingField({ [field]: source[field] })
      )
        next[field] = source[field];
    }
    return next;
  };
  const result = carry(normalized as Record<string, unknown>, raw);
  const steps = result.steps;
  const rawSteps = raw.steps;
  if (Array.isArray(steps) && Array.isArray(rawSteps))
    result.steps = steps.map((step, index) =>
      carry(step as Record<string, unknown>, rawSteps[index]),
    );
  return result as T;
}
