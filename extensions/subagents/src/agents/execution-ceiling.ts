import { normalizeActiveRuntimeMs } from "../runs/shared/lifecycle-state.ts";

export const DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS = 14_400_000;

/** Code-owned ceilings for the installer-managed first-party subagent roles. */
export const CANONICAL_AGENT_MAX_EXECUTION_TIME_MS: Readonly<Record<string, number>> =
  Object.freeze({
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Warn when the retired human-owned shared run ceiling is still present.
 * The input is intentionally only inspected for key presence so its value is
 * never disclosed and the user-owned config remains untouched. The extension
 * load boundary invokes this once per load.
 */
export function warnRetiredExecutionPolicy(input: unknown): void {
  if (!isRecord(input) || !hasOwn(input, "maxRunTimeMs")) return;
  console.warn(
    "[tlh] Ignoring retired execution.maxRunTimeMs; per-role execution budgets remain active.",
  );
}

/** Return the canonical ceiling for an installer-managed role, if one exists. */
export function canonicalAgentMaxExecutionTimeMs(agentName: string): number | undefined {
  return Object.hasOwn(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, agentName)
    ? CANONICAL_AGENT_MAX_EXECUTION_TIME_MS[agentName]
    : undefined;
}

/** Apply the independent fallback used by trusted custom/project agents. */
export function resolveCustomAgentMaxExecutionTimeMs(
  maxExecutionTimeMs: number | undefined,
): number {
  return maxExecutionTimeMs ?? DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS;
}

export type ExecutionTimeoutOwner = "role" | "run";

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function normalizeExecutionTimeoutOwner(value: unknown): ExecutionTimeoutOwner | undefined {
  return value === "role" || value === "run" ? value : undefined;
}

export function remainingExecutionTimeMs(
  maxExecutionTimeMs: number | undefined,
  activeRuntimeMs: unknown = 0,
): number | undefined {
  if (maxExecutionTimeMs === undefined) return undefined;
  if (!isPositiveSafeInteger(maxExecutionTimeMs)) return 0;
  const consumedActiveRuntimeMs = normalizeActiveRuntimeMs(activeRuntimeMs);
  if (consumedActiveRuntimeMs === undefined) return 0;
  return Math.max(0, maxExecutionTimeMs - consumedActiveRuntimeMs);
}
