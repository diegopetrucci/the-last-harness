// Generated from extensions/subagents/src/runs/shared/active-runtime.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
export function normalizeActiveRuntimeMs(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(value))
        : undefined;
}
export function normalizeActiveRuntimeCheckpointAt(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
        : undefined;
}
export function boundedActiveRuntimeMs(value, fallback = 0) {
    return normalizeActiveRuntimeMs(value) ?? normalizeActiveRuntimeMs(fallback) ?? 0;
}
export const ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS = 30_000;
export function shouldPersistActiveRuntimeCheckpoint(input) {
    if (input.trackerFrozen)
        return false;
    const current = normalizeActiveRuntimeMs(input.currentActiveRuntimeMs);
    const previous = normalizeActiveRuntimeMs(input.previousActiveRuntimeMs);
    return current !== undefined && (previous === undefined || current > previous);
}
export function applyActiveRuntimeCheckpoint(candidates, input) {
    let advanced = false;
    for (const candidate of candidates) {
        const trackerFrozen = candidate.tracker.isFrozen();
        const runtime = input.freeze
            ? candidate.tracker.freeze(input.now)
            : candidate.tracker.checkpoint(input.now);
        if (!shouldPersistActiveRuntimeCheckpoint({
            previousActiveRuntimeMs: candidate.previousActiveRuntimeMs,
            currentActiveRuntimeMs: runtime,
            trackerFrozen,
        }))
            continue;
        candidate.apply({
            activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(candidate.previousActiveRuntimeMs) ?? 0, runtime),
            activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(candidate.previousActiveRuntimeCheckpointAt) ?? 0, normalizeActiveRuntimeCheckpointAt(input.now) ?? 0),
        });
        advanced = true;
    }
    if (advanced)
        input.persist?.();
    return advanced;
}
export function createActiveRuntimeTracker(input = {}) {
    const now = input.now ?? (() => Date.now());
    const suppliedSegmentStart = normalizeActiveRuntimeCheckpointAt(input.segmentStartedAt);
    const initialNow = suppliedSegmentStart ?? normalizeActiveRuntimeCheckpointAt(now()) ?? Date.now();
    let total = boundedActiveRuntimeMs(input.priorActiveRuntimeMs);
    let segmentStartedAt = suppliedSegmentStart ?? initialNow;
    let frozen = false;
    const current = (at = now()) => {
        if (frozen)
            return total;
        const normalizedAt = normalizeActiveRuntimeCheckpointAt(at);
        const elapsed = normalizedAt === undefined ? 0 : Math.max(0, normalizedAt - segmentStartedAt);
        return Math.min(Number.MAX_SAFE_INTEGER, total + elapsed);
    };
    const checkpoint = (at = now()) => {
        const normalizedAt = normalizeActiveRuntimeCheckpointAt(at) ?? segmentStartedAt;
        const checkpointAt = Math.max(segmentStartedAt, normalizedAt);
        total = current(checkpointAt);
        segmentStartedAt = checkpointAt;
        return total;
    };
    const freeze = (at = now()) => {
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
export function malformedActiveRuntimeAccountingField(value) {
    for (const field of ["activeRuntimeMs", "activeRuntimeCheckpointAt"]) {
        const candidate = value[field];
        if (candidate === undefined)
            continue;
        if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
            return field;
    }
    const owner = value.timeoutOwner;
    if (owner !== undefined && owner !== "role" && owner !== "run")
        return "timeoutOwner";
    return undefined;
}
const ACCOUNTING_FIELDS = ["activeRuntimeMs", "activeRuntimeCheckpointAt", "timeoutOwner"];
export function carryMalformedAccounting(normalized, raw) {
    const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    if (!isObject(raw))
        return normalized;
    const carry = (target, source) => {
        if (!isObject(source))
            return target;
        const next = { ...target };
        for (const field of ACCOUNTING_FIELDS) {
            if (source[field] !== undefined &&
                malformedActiveRuntimeAccountingField({ [field]: source[field] }))
                next[field] = source[field];
        }
        return next;
    };
    const result = carry(normalized, raw);
    const steps = result.steps;
    const rawSteps = raw.steps;
    if (Array.isArray(steps) && Array.isArray(rawSteps))
        result.steps = steps.map((step, index) => carry(step, rawSteps[index]));
    return result;
}
