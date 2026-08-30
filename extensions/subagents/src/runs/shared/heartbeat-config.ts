/**
 * Heartbeat configuration types and resolution.
 *
 * Follows the same pattern as subagent-control.ts: global config and per-use
 * overrides are merged, positive-integer fields are validated, and defaults
 * apply for any missing/invalid value.
 */

export interface HeartbeatConfig {
  enabled?: boolean;
  /** Interval between beats in ms. Default: 255 000 (~4m15s). */
  intervalMs?: number;
  /** Hard ceiling on how long a gap may be heartbeated in ms. Default: 3 600 000 (1h). */
  maxDurationMs?: number;
  /** Maximum beats per gap (~break-even limit for cache economics). Default: 11. */
  maxBeatsPerGap?: number;
}

export interface ResolvedHeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  maxDurationMs: number;
  maxBeatsPerGap: number;
}

export const DEFAULT_HEARTBEAT_CONFIG: ResolvedHeartbeatConfig = {
  enabled: false,
  intervalMs: 255_000,
  maxDurationMs: 3_600_000,
  maxBeatsPerGap: 11,
};

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/**
 * Parse `enabled` strictly: only accept an actual boolean.
 * A truthy non-boolean (e.g. the string `"false"`) is rejected and the default
 * (false) is used instead, so a mis-typed config never silently enables real
 * spending.
 */
function parseStrictBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") return undefined;
  return value;
}

export function resolveHeartbeatConfig(
  globalConfig?: HeartbeatConfig,
  override?: HeartbeatConfig,
): ResolvedHeartbeatConfig {
  const enabled =
    parseStrictBoolean(override?.enabled) ??
    parseStrictBoolean(globalConfig?.enabled) ??
    DEFAULT_HEARTBEAT_CONFIG.enabled;
  const intervalMs =
    parsePositiveInt(override?.intervalMs) ??
    parsePositiveInt(globalConfig?.intervalMs) ??
    DEFAULT_HEARTBEAT_CONFIG.intervalMs;
  const maxDurationMs =
    parsePositiveInt(override?.maxDurationMs) ??
    parsePositiveInt(globalConfig?.maxDurationMs) ??
    DEFAULT_HEARTBEAT_CONFIG.maxDurationMs;
  const maxBeatsPerGap =
    parsePositiveInt(override?.maxBeatsPerGap) ??
    parsePositiveInt(globalConfig?.maxBeatsPerGap) ??
    DEFAULT_HEARTBEAT_CONFIG.maxBeatsPerGap;
  return { enabled, intervalMs, maxDurationMs, maxBeatsPerGap };
}
