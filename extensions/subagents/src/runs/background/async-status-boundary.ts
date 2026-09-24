import type {
  ActivityState,
  AsyncStatus,
  CompactionReason,
  ContextPressureProjection,
  ContextPressureThreshold,
  ContextUsageDiagnostics,
  SubagentTerminationReason,
} from "../../shared/types.ts";
import { parsePersistedChildLocationSnapshot } from "../../shared/child-location.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
  parseSubagentTerminationReason,
} from "../../shared/context-diagnostics.ts";
import { safeTerminalText } from "../../shared/display-text.ts";
import { normalizeProjectAgentIdentity } from "../../agents/project-agent-loader.ts";
import { normalizeChildProcessCleanup } from "../shared/process-group-cleanup.ts";
import { parseSubagentTerminalResult } from "../../shared/terminal-result.ts";
import { persistedTicketId } from "../shared/ticket-context.ts";

export type AsyncStatusReadFailure = "invalid" | "unreadable" | "oversize";

export interface AsyncStatusReadErrorInput {
  asyncDir: string;
  statusPath: string;
  failure: AsyncStatusReadFailure;
  message: string;
  cause?: unknown;
}

interface SafeStatusReadCause {
  code?: string;
  path?: string;
  syscall?: string;
}

function safeStatusReadCause(cause: unknown): SafeStatusReadCause | undefined {
  if (typeof cause !== "object" || cause === null || Array.isArray(cause)) return undefined;
  const value = cause as Record<string, unknown>;
  const safe: SafeStatusReadCause = {};
  if (typeof value.code === "string") safe.code = value.code;
  if (typeof value.path === "string") safe.path = value.path;
  if (typeof value.syscall === "string") safe.syscall = value.syscall;
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/**
 * Raised when a persisted status cannot be safely consumed. The caller owns
 * the display boundary; this error deliberately retains only the status path,
 * a bounded category, and sanitized I/O metadata. Invalid JSON/shape errors
 * never retain parser causes because those may echo file contents.
 */
export class AsyncStatusReadError extends Error {
  readonly name = "AsyncStatusReadError";
  readonly asyncDir: string;
  readonly statusPath: string;
  readonly failure: AsyncStatusReadFailure;

  constructor(input: AsyncStatusReadErrorInput) {
    const cause = input.failure === "unreadable" ? safeStatusReadCause(input.cause) : undefined;
    super(input.message, cause === undefined ? undefined : { cause });
    this.asyncDir = input.asyncDir;
    this.statusPath = input.statusPath;
    this.failure = input.failure;
  }
}

export function isAsyncStatusReadError(error: unknown): error is AsyncStatusReadError {
  return error instanceof AsyncStatusReadError;
}

export const MAX_UNREADABLE_STATUS_REPORTS = 20;

/** Format an unreadable status path only after it crosses a display boundary. */
export function formatUnreadableStatus(statusPath: string): string {
  return `unreadable status at ${safeTerminalText(statusPath)}`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROOT_STATES = new Set([
  "queued",
  "running",
  "pausing",
  "complete",
  "completed",
  "failed",
  "paused",
  "continued",
  "cancelled",
]);
const STEP_STATES = new Set([
  "pending",
  "running",
  "pausing",
  "complete",
  "completed",
  "failed",
  "paused",
  "continued",
  "cancelled",
]);

export type CanonicalLifecycleState = Exclude<AsyncStatus["state"], "completed" | "continued">;
export type CanonicalLifecycleStepState = Exclude<
  NonNullable<AsyncStatus["steps"]>[number]["status"],
  "completed" | "continued"
>;

export function canonicalLifecycleState(value: unknown): CanonicalLifecycleState {
  if (value === "complete" || value === "completed" || value === "continued") return "complete";
  return typeof value === "string" && ROOT_STATES.has(value)
    ? (value as CanonicalLifecycleState)
    : "failed";
}

export function canonicalLifecycleStepState(value: unknown): CanonicalLifecycleStepState {
  if (value === "complete" || value === "completed" || value === "continued") return "complete";
  return typeof value === "string" && STEP_STATES.has(value)
    ? (value as CanonicalLifecycleStepState)
    : "failed";
}

function invalidStatus(
  asyncDir: string,
  statusPath: string,
  message: string,
): AsyncStatusReadError {
  return new AsyncStatusReadError({
    asyncDir,
    statusPath,
    failure: "invalid",
    message,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ROOT_FINITE_FIELDS = [
  "lastActivityAt",
  "currentToolStartedAt",
  "turnCount",
  "toolCount",
  "steerCount",
  "lastSteerAt",
  "endedAt",
  "lastUpdate",
  "timeoutMs",
  "deadlineAt",
  "currentStep",
  "pendingAppends",
  "pid",
] as const;
const STEP_FINITE_FIELDS = [
  "lastActivityAt",
  "currentToolStartedAt",
  "interruptRequestedAt",
  "turnCount",
  "toolCount",
  "steerCount",
  "lastSteerAt",
  "startedAt",
  "endedAt",
  "durationMs",
  "timeoutMs",
  "deadlineAt",
] as const;

function validateOptionalFiniteFields(
  asyncDir: string,
  statusPath: string,
  value: Record<string, unknown>,
  fields: readonly string[],
  prefix: string,
): void {
  for (const field of fields) {
    if (value[field] !== undefined && !finiteNumber(value[field]))
      throw invalidStatus(asyncDir, statusPath, `${prefix}${field} must be a finite number.`);
  }
}

function validateCoreStatus(
  asyncDir: string,
  statusPath: string,
  value: unknown,
): asserts value is AsyncStatus & { cwd?: string } {
  if (!isRecordValue(value)) throw invalidStatus(asyncDir, statusPath, "status must be an object.");
  if (typeof value.runId !== "string")
    throw invalidStatus(asyncDir, statusPath, "runId must be a string.");
  if (typeof value.mode !== "string" || !["single", "parallel", "chain"].includes(value.mode)) {
    throw invalidStatus(asyncDir, statusPath, "mode is invalid.");
  }
  // Historical artifacts have carried retired/forward-compatible lifecycle
  // labels. Keep any string state readable, but fail closed to the canonical
  // in-memory state; never rewrite the historical record merely because its
  // state is unknown.
  if (typeof value.state !== "string")
    throw invalidStatus(asyncDir, statusPath, "state must be a string.");
  if (!finiteNumber(value.startedAt))
    throw invalidStatus(asyncDir, statusPath, "startedAt must be a finite number.");
  validateOptionalFiniteFields(asyncDir, statusPath, value, ROOT_FINITE_FIELDS, "");
  if (value.steps !== undefined && !Array.isArray(value.steps))
    throw invalidStatus(asyncDir, statusPath, "steps must be an array.");
  for (const [index, step] of (value.steps ?? []).entries()) {
    if (!isRecordValue(step))
      throw invalidStatus(asyncDir, statusPath, `steps[${index}] must be an object.`);
    if (typeof step.agent !== "string")
      throw invalidStatus(asyncDir, statusPath, `steps[${index}].agent must be a string.`);
    validateOptionalFiniteFields(
      asyncDir,
      statusPath,
      step,
      STEP_FINITE_FIELDS,
      `steps[${index}].`,
    );
    if (typeof step.status !== "string" || !STEP_STATES.has(step.status))
      throw invalidStatus(asyncDir, statusPath, `steps[${index}].status is invalid.`);
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== "string")
    throw invalidStatus(asyncDir, statusPath, "sessionId must be a string.");
  if (value.awaited !== undefined && typeof value.awaited !== "boolean")
    throw invalidStatus(asyncDir, statusPath, "awaited must be a boolean.");
}

function normalizePersistedActivityState(value: unknown): ActivityState | undefined {
  return value === "needs_attention" ? value : undefined;
}

function normalizePersistedCompaction(value: unknown): { reason: CompactionReason } | undefined {
  if (!isRecordValue(value)) return undefined;
  const reason = value.reason;
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? { reason }
    : undefined;
}

const normalizeLifecycleState = canonicalLifecycleState;
const normalizeStepState = canonicalLifecycleStepState;

const CONTINUATION_PHASES = new Set(["claimed", "reserved", "launched", "completed", "continued"]);
const CONTINUATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function hasContinuationMetadata(value: unknown): boolean {
  if (!isRecordValue(value)) return false;
  const token = (candidate: unknown): boolean =>
    typeof candidate === "string" &&
    candidate.trim().length > 0 &&
    Buffer.byteLength(candidate.trim(), "utf8") <= 120 &&
    CONTINUATION_TOKEN.test(candidate.trim());
  return (
    (typeof value.phase === "string" && CONTINUATION_PHASES.has(value.phase)) ||
    token(value.claimToken) ||
    token(value.continuationRunId) ||
    ["claimedAt", "ownerPid", "launchedAt", "completedAt", "continuedAt"].some((field) =>
      field === "ownerPid"
        ? typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] > 0
        : typeof value[field] === "number" && Number.isFinite(value[field]),
    )
  );
}

function continuationKey(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const index = Number(value);
  return Number.isSafeInteger(index) ? String(index) : undefined;
}

function continuationMetadataForIndex(
  value: unknown,
  index: number,
): Record<string, unknown> | undefined {
  if (!isRecordValue(value)) return undefined;
  const expected = String(index);
  const candidate = Object.entries(value).find(([key]) => continuationKey(key) === expected)?.[1];
  return isRecordValue(candidate) ? candidate : undefined;
}

function projectLegacyContinuationMetadata(
  status: AsyncStatus & { cwd?: string },
  rootWasContinued: boolean,
  continuedIndexes: number[],
): void {
  const source = isRecordValue(status.lifecycle) ? status.lifecycle : {};
  let lifecycle = source;
  let byIndex = isRecordValue(source.continuationsByIndex)
    ? { ...source.continuationsByIndex }
    : undefined;
  if (
    rootWasContinued &&
    !hasContinuationMetadata(source.continuation) &&
    !hasContinuationMetadata(continuationMetadataForIndex(source.continuationsByIndex, 0))
  ) {
    lifecycle = { ...lifecycle, continuation: { phase: "completed" } };
  }
  for (const index of continuedIndexes) {
    const existing = continuationMetadataForIndex(byIndex, index);
    const rootEquivalent = index === 0 && hasContinuationMetadata(lifecycle.continuation);
    if (existing !== undefined && hasContinuationMetadata(existing)) continue;
    if (rootEquivalent) continue;
    byIndex ??= {};
    byIndex[String(index)] = { phase: "completed" };
  }
  if (byIndex) lifecycle = { ...lifecycle, continuationsByIndex: byIndex };
  if (lifecycle !== source) status.lifecycle = lifecycle;
}

/**
 * Validate and narrow one parsed JSON value before any status field is used.
 * Unknown keys are intentionally preserved for historical, open status
 * artifacts; only fields consumed by TLH are bounded and normalized.
 */
export function parsePersistedAsyncStatus(
  value: unknown,
  asyncDir: string,
  statusPath: string,
): AsyncStatus & { cwd?: string } {
  validateCoreStatus(asyncDir, statusPath, value);
  const status = value;
  const rootWasContinued = status.state === "continued";
  const continuedIndexes = (status.steps ?? [])
    .map((step, index) => (step.status === "continued" ? index : undefined))
    .filter((index): index is number => index !== undefined);
  status.state = normalizeLifecycleState(status.state);
  const terminalResult = parseSubagentTerminalResult(status.terminalResult);
  if (Object.hasOwn(status, "terminalResult") && !terminalResult)
    throw invalidStatus(asyncDir, statusPath, "terminalResult is invalid.");
  status.terminalResult = terminalResult;
  status.activityState = normalizePersistedActivityState(status.activityState);
  Reflect.deleteProperty(status, "durableAttentionReasons");
  if (status.lifecycle !== undefined) {
    if (!isRecordValue(status.lifecycle))
      throw invalidStatus(asyncDir, statusPath, "lifecycle must be an object.");
    const generation: unknown = status.lifecycle.generation;
    if (
      generation !== undefined &&
      (!Number.isSafeInteger(generation) || (typeof generation === "number" && generation < 0))
    )
      throw invalidStatus(
        asyncDir,
        statusPath,
        "lifecycle.generation must be a non-negative integer.",
      );
    if (
      status.lifecycle.resumeBlockedReason !== undefined &&
      status.lifecycle.resumeBlockedReason !== "supervisor_lifecycle_failure"
    )
      throw invalidStatus(asyncDir, statusPath, "lifecycle.resumeBlockedReason is invalid.");
  }
  projectLegacyContinuationMetadata(status, rootWasContinued, continuedIndexes);

  if (status.processCleanup !== undefined) {
    const processCleanup = normalizeChildProcessCleanup(status.processCleanup);
    if (!processCleanup) throw invalidStatus(asyncDir, statusPath, "processCleanup is invalid.");
    status.processCleanup = processCleanup;
  }
  if (status.projectAgents !== undefined) {
    if (!Array.isArray(status.projectAgents))
      throw invalidStatus(asyncDir, statusPath, "projectAgents must be an array.");
    for (const [index, capture] of status.projectAgents.entries()) {
      if (!normalizeProjectAgentIdentity(capture))
        throw invalidStatus(asyncDir, statusPath, `projectAgents[${index}] is invalid.`);
    }
  }
  for (const [index, step] of (status.steps ?? []).entries()) {
    if (step.ticketId !== undefined) {
      const normalizedTicket = persistedTicketId(step.ticketId);
      if (normalizedTicket) step.ticketId = normalizedTicket;
      else delete step.ticketId;
    }
    step.status = normalizeStepState(step.status);
    step.activityState = normalizePersistedActivityState(step.activityState);
    step.compaction = normalizePersistedCompaction(step.compaction);
    Reflect.deleteProperty(step, "durableAttentionReasons");
    const terminalResult = parseSubagentTerminalResult(step.terminalResult);
    if (Object.hasOwn(step, "terminalResult") && !terminalResult)
      throw invalidStatus(asyncDir, statusPath, `steps[${index}].terminalResult is invalid.`);
    step.terminalResult = terminalResult;
    if (step.projectAgent !== undefined && !normalizeProjectAgentIdentity(step.projectAgent))
      throw invalidStatus(asyncDir, statusPath, `steps[${index}].projectAgent is invalid.`);
    step.contextUsage = parseContextUsageDiagnostics(step.contextUsage);
    step.contextPressure = parseContextPressureProjection(step.contextPressure);
    step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
      step.contextPressureCrossedThresholds,
    );
    step.terminationReason = parseSubagentTerminationReason(step.terminationReason);
    step.childLocation = parsePersistedChildLocationSnapshot(step.childLocation);
  }
  return status;
}

export type PersistedContextUsage = ContextUsageDiagnostics;
export type PersistedContextPressure = ContextPressureProjection;
export type PersistedContextThreshold = ContextPressureThreshold;
export type PersistedTerminationReason = SubagentTerminationReason;
