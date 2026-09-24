import { parsePersistedChildLocationSnapshot } from "../../shared/child-location.js";
import { parseContextPressureCrossedThresholds, parseContextPressureProjection, parseContextUsageDiagnostics, parseSubagentTerminationReason, } from "../../shared/context-diagnostics.js";
import { safeTerminalText } from "../../shared/display-text.js";
import { normalizeProjectAgentIdentity } from "../../agents/project-agent-loader.js";
import { normalizeChildProcessCleanup } from "../shared/process-group-cleanup.js";
import { parseSubagentTerminalResult } from "../../shared/terminal-result.js";
import { persistedTicketId } from "../shared/ticket-context.js";
function safeStatusReadCause(cause) {
    if (typeof cause !== "object" || cause === null || Array.isArray(cause))
        return undefined;
    const value = cause;
    const safe = {};
    if (typeof value.code === "string")
        safe.code = value.code;
    if (typeof value.path === "string")
        safe.path = value.path;
    if (typeof value.syscall === "string")
        safe.syscall = value.syscall;
    return Object.keys(safe).length > 0 ? safe : undefined;
}
export class AsyncStatusReadError extends Error {
    name = "AsyncStatusReadError";
    asyncDir;
    statusPath;
    failure;
    constructor(input) {
        const cause = input.failure === "unreadable" ? safeStatusReadCause(input.cause) : undefined;
        super(input.message, cause === undefined ? undefined : { cause });
        this.asyncDir = input.asyncDir;
        this.statusPath = input.statusPath;
        this.failure = input.failure;
    }
}
export function isAsyncStatusReadError(error) {
    return error instanceof AsyncStatusReadError;
}
export const MAX_UNREADABLE_STATUS_REPORTS = 20;
export function formatUnreadableStatus(statusPath) {
    return `unreadable status at ${safeTerminalText(statusPath)}`;
}
function isRecordValue(value) {
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
export function canonicalLifecycleState(value) {
    if (value === "complete" || value === "completed" || value === "continued")
        return "complete";
    return typeof value === "string" && ROOT_STATES.has(value)
        ? value
        : "failed";
}
export function canonicalLifecycleStepState(value) {
    if (value === "complete" || value === "completed" || value === "continued")
        return "complete";
    return typeof value === "string" && STEP_STATES.has(value)
        ? value
        : "failed";
}
function invalidStatus(asyncDir, statusPath, message) {
    return new AsyncStatusReadError({
        asyncDir,
        statusPath,
        failure: "invalid",
        message,
    });
}
function finiteNumber(value) {
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
];
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
];
function validateOptionalFiniteFields(asyncDir, statusPath, value, fields, prefix) {
    for (const field of fields) {
        if (value[field] !== undefined && !finiteNumber(value[field]))
            throw invalidStatus(asyncDir, statusPath, `${prefix}${field} must be a finite number.`);
    }
}
function validateCoreStatus(asyncDir, statusPath, value) {
    if (!isRecordValue(value))
        throw invalidStatus(asyncDir, statusPath, "status must be an object.");
    if (typeof value.runId !== "string")
        throw invalidStatus(asyncDir, statusPath, "runId must be a string.");
    if (typeof value.mode !== "string" || !["single", "parallel", "chain"].includes(value.mode)) {
        throw invalidStatus(asyncDir, statusPath, "mode is invalid.");
    }
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
        validateOptionalFiniteFields(asyncDir, statusPath, step, STEP_FINITE_FIELDS, `steps[${index}].`);
        if (typeof step.status !== "string" || !STEP_STATES.has(step.status))
            throw invalidStatus(asyncDir, statusPath, `steps[${index}].status is invalid.`);
    }
    if (value.sessionId !== undefined && typeof value.sessionId !== "string")
        throw invalidStatus(asyncDir, statusPath, "sessionId must be a string.");
    if (value.awaited !== undefined && typeof value.awaited !== "boolean")
        throw invalidStatus(asyncDir, statusPath, "awaited must be a boolean.");
}
function normalizePersistedActivityState(value) {
    return value === "needs_attention" ? value : undefined;
}
function normalizePersistedCompaction(value) {
    if (!isRecordValue(value))
        return undefined;
    const reason = value.reason;
    return reason === "manual" || reason === "threshold" || reason === "overflow"
        ? { reason }
        : undefined;
}
const normalizeLifecycleState = canonicalLifecycleState;
const normalizeStepState = canonicalLifecycleStepState;
const CONTINUATION_PHASES = new Set(["claimed", "reserved", "launched", "completed", "continued"]);
const CONTINUATION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function hasContinuationMetadata(value) {
    if (!isRecordValue(value))
        return false;
    const token = (candidate) => typeof candidate === "string" &&
        candidate.trim().length > 0 &&
        Buffer.byteLength(candidate.trim(), "utf8") <= 120 &&
        CONTINUATION_TOKEN.test(candidate.trim());
    return ((typeof value.phase === "string" && CONTINUATION_PHASES.has(value.phase)) ||
        token(value.claimToken) ||
        token(value.continuationRunId) ||
        ["claimedAt", "ownerPid", "launchedAt", "completedAt", "continuedAt"].some((field) => field === "ownerPid"
            ? typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] > 0
            : typeof value[field] === "number" && Number.isFinite(value[field])));
}
function continuationKey(value) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return String(value);
    if (typeof value !== "string" || !/^\d+$/.test(value))
        return undefined;
    const index = Number(value);
    return Number.isSafeInteger(index) ? String(index) : undefined;
}
function continuationMetadataForIndex(value, index) {
    if (!isRecordValue(value))
        return undefined;
    const expected = String(index);
    const candidate = Object.entries(value).find(([key]) => continuationKey(key) === expected)?.[1];
    return isRecordValue(candidate) ? candidate : undefined;
}
function projectLegacyContinuationMetadata(status, rootWasContinued, continuedIndexes) {
    const source = isRecordValue(status.lifecycle) ? status.lifecycle : {};
    let lifecycle = source;
    let byIndex = isRecordValue(source.continuationsByIndex)
        ? { ...source.continuationsByIndex }
        : undefined;
    if (rootWasContinued &&
        !hasContinuationMetadata(source.continuation) &&
        !hasContinuationMetadata(continuationMetadataForIndex(source.continuationsByIndex, 0))) {
        lifecycle = { ...lifecycle, continuation: { phase: "completed" } };
    }
    for (const index of continuedIndexes) {
        const existing = continuationMetadataForIndex(byIndex, index);
        const rootEquivalent = index === 0 && hasContinuationMetadata(lifecycle.continuation);
        if (existing !== undefined && hasContinuationMetadata(existing))
            continue;
        if (rootEquivalent)
            continue;
        byIndex ??= {};
        byIndex[String(index)] = { phase: "completed" };
    }
    if (byIndex)
        lifecycle = { ...lifecycle, continuationsByIndex: byIndex };
    if (lifecycle !== source)
        status.lifecycle = lifecycle;
}
export function parsePersistedAsyncStatus(value, asyncDir, statusPath) {
    validateCoreStatus(asyncDir, statusPath, value);
    const status = value;
    const rootWasContinued = status.state === "continued";
    const continuedIndexes = (status.steps ?? [])
        .map((step, index) => (step.status === "continued" ? index : undefined))
        .filter((index) => index !== undefined);
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
        const generation = status.lifecycle.generation;
        if (generation !== undefined &&
            (!Number.isSafeInteger(generation) || (typeof generation === "number" && generation < 0)))
            throw invalidStatus(asyncDir, statusPath, "lifecycle.generation must be a non-negative integer.");
        if (status.lifecycle.resumeBlockedReason !== undefined &&
            status.lifecycle.resumeBlockedReason !== "supervisor_lifecycle_failure")
            throw invalidStatus(asyncDir, statusPath, "lifecycle.resumeBlockedReason is invalid.");
    }
    projectLegacyContinuationMetadata(status, rootWasContinued, continuedIndexes);
    if (status.processCleanup !== undefined) {
        const processCleanup = normalizeChildProcessCleanup(status.processCleanup);
        if (!processCleanup)
            throw invalidStatus(asyncDir, statusPath, "processCleanup is invalid.");
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
            if (normalizedTicket)
                step.ticketId = normalizedTicket;
            else
                delete step.ticketId;
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
        step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(step.contextPressureCrossedThresholds);
        step.terminationReason = parseSubagentTerminationReason(step.terminationReason);
        step.childLocation = parsePersistedChildLocationSnapshot(step.childLocation);
    }
    return status;
}
