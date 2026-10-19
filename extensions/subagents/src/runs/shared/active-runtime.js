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
