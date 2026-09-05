import { normalizeActiveRuntimeMs } from "../runs/shared/lifecycle-state.ts";

export const DEFAULT_SUBAGENT_MAX_RUN_TIME_MS = 14_400_000;
export const DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS = DEFAULT_SUBAGENT_MAX_RUN_TIME_MS;

/** Code-owned ceilings for the installer-managed first-party subagent roles. */
export const CANONICAL_AGENT_MAX_EXECUTION_TIME_MS: Readonly<Record<string, number>> =
  Object.freeze({
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

export interface ResolvedExecutionPolicy {
  /** `false` deliberately disables the configured run-level default. */
  maxRunTimeMs: number | false;
  /** Bounded, actionable diagnostic returned when the input was invalid. */
  diagnostic?: string;
}

let invalidExecutionPolicyWarningShown = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidExecutionPolicyDiagnostic(): string {
  return (
    `[tlh] Invalid execution.maxRunTimeMs; using the bounded default of ` +
    `${DEFAULT_SUBAGENT_MAX_RUN_TIME_MS}ms (4h). Set a positive safe integer or false.`
  );
}

function warnInvalidExecutionPolicy(message: string): void {
  if (invalidExecutionPolicyWarningShown) return;
  invalidExecutionPolicyWarningShown = true;
  console.warn(message);
}

/**
 * Resolve the human-owned run-level execution policy from its open execution
 * block. Only an own `maxRunTimeMs` property is consumed; all other keys
 * remain outside this policy boundary.
 */
export function resolveExecutionPolicy(input: unknown): ResolvedExecutionPolicy {
  const executionRecord = isRecord(input) ? input : undefined;

  if (!executionRecord) {
    if (input === undefined) return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS };
    const diagnostic = invalidExecutionPolicyDiagnostic();
    warnInvalidExecutionPolicy(diagnostic);
    return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS, diagnostic };
  }
  if (!hasOwn(executionRecord, "maxRunTimeMs")) {
    return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS };
  }

  const value = executionRecord.maxRunTimeMs;
  if (value === false) return { maxRunTimeMs: false };
  if (isPositiveSafeInteger(value)) return { maxRunTimeMs: value };

  const diagnostic = invalidExecutionPolicyDiagnostic();
  warnInvalidExecutionPolicy(diagnostic);
  return { maxRunTimeMs: DEFAULT_SUBAGENT_MAX_RUN_TIME_MS, diagnostic };
}

/** Return the canonical ceiling for an installer-managed role, if one exists. */
export function canonicalAgentMaxExecutionTimeMs(agentName: string): number | undefined {
  return Object.hasOwn(CANONICAL_AGENT_MAX_EXECUTION_TIME_MS, agentName)
    ? CANONICAL_AGENT_MAX_EXECUTION_TIME_MS[agentName]
    : undefined;
}

/** Apply the shared fallback used by trusted custom/project agents. */
export function resolveCustomAgentMaxExecutionTimeMs(
  maxExecutionTimeMs: number | undefined,
): number {
  return maxExecutionTimeMs ?? DEFAULT_CUSTOM_AGENT_MAX_EXECUTION_TIME_MS;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
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
