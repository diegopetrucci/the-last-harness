export const DEFAULT_HEARTBEAT_CONFIG = {
    enabled: false,
    intervalMs: 255_000,
    maxDurationMs: 3_600_000,
    maxBeatsPerGap: 11,
};
function parsePositiveInt(value) {
    if (typeof value !== "number")
        return undefined;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1)
        return undefined;
    return value;
}
function parseStrictBoolean(value) {
    if (typeof value !== "boolean")
        return undefined;
    return value;
}
export function resolveHeartbeatConfig(globalConfig, override) {
    const enabled = parseStrictBoolean(override?.enabled) ??
        parseStrictBoolean(globalConfig?.enabled) ??
        DEFAULT_HEARTBEAT_CONFIG.enabled;
    const intervalMs = parsePositiveInt(override?.intervalMs) ??
        parsePositiveInt(globalConfig?.intervalMs) ??
        DEFAULT_HEARTBEAT_CONFIG.intervalMs;
    const maxDurationMs = parsePositiveInt(override?.maxDurationMs) ??
        parsePositiveInt(globalConfig?.maxDurationMs) ??
        DEFAULT_HEARTBEAT_CONFIG.maxDurationMs;
    const maxBeatsPerGap = parsePositiveInt(override?.maxBeatsPerGap) ??
        parsePositiveInt(globalConfig?.maxBeatsPerGap) ??
        DEFAULT_HEARTBEAT_CONFIG.maxBeatsPerGap;
    return { enabled, intervalMs, maxDurationMs, maxBeatsPerGap };
}
