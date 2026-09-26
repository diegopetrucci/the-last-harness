/** Strict validation for persisted subagent telemetry before normalization. */
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function finiteNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function safeStepIndex(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
const MAX_OPAQUE_ID_LENGTH = 512;
/** Structured telemetry IDs are opaque, bounded map keys (not file paths). */
function boundedOpaqueId(value) {
    if (typeof value !== "string")
        return false;
    const normalized = value.trim();
    if (!normalized || [...normalized].length > MAX_OPAQUE_ID_LENGTH)
        return false;
    return ![...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
    });
}
export const OUTCOME_STATES = new Set([
    "queued",
    "running",
    "completed",
    "failed",
    "paused",
    "cancelled",
    "continued",
]);
export const TERMINATION_REASONS = new Set([
    "completed",
    "output_limit",
    "model_error",
    "interrupted",
    "timed_out",
    "tool_budget_blocked",
    "paused",
    "cancelled",
    "process_exit",
    "context_exhausted",
    "unknown",
]);
export const ACCEPTANCE_STATUSES = new Set([
    "not-required",
    "claimed",
    "attested",
    "checked",
    "verified",
    "reviewed",
    "accepted",
    "rejected",
    "skipped",
]);
function strictOptionalFiniteFields(value, fields) {
    return fields.every((field) => !hasOwn(value, field) || finiteNonNegativeNumber(value[field]));
}
function strictOptionalNonEmptyStrings(value, fields) {
    return fields.every((field) => !hasOwn(value, field) || (typeof value[field] === "string" && value[field].trim() !== ""));
}
function isStrictTelemetryUsage(value) {
    return (isObject(value) &&
        finiteNonNegativeNumber(value.inputTokens) &&
        finiteNonNegativeNumber(value.outputTokens) &&
        finiteNonNegativeNumber(value.cacheReadTokens) &&
        finiteNonNegativeNumber(value.cacheWriteTokens) &&
        finiteNonNegativeNumber(value.costUsd));
}
function isStrictTelemetryTiming(value) {
    return (isObject(value) &&
        strictOptionalFiniteFields(value, ["startedAt", "endedAt", "durationMs", "activeRuntimeMs"]) &&
        ["startedAt", "endedAt", "durationMs", "activeRuntimeMs"].some((field) => hasOwn(value, field)));
}
function isStrictTelemetryModel(value) {
    return (isObject(value) &&
        typeof value.provider === "string" &&
        value.provider.trim() !== "" &&
        typeof value.model === "string" &&
        value.model.trim() !== "" &&
        strictOptionalNonEmptyStrings(value, ["thinking"]));
}
function isStrictTelemetryOutcome(value) {
    return (isObject(value) &&
        typeof value.state === "string" &&
        OUTCOME_STATES.has(value.state) &&
        (!hasOwn(value, "terminationReason") ||
            (typeof value.terminationReason === "string" &&
                TERMINATION_REASONS.has(value.terminationReason))) &&
        (!hasOwn(value, "acceptanceStatus") ||
            (typeof value.acceptanceStatus === "string" &&
                ACCEPTANCE_STATUSES.has(value.acceptanceStatus))));
}
function isStrictTelemetryActivity(value) {
    return (isObject(value) &&
        strictOptionalFiniteFields(value, ["turns", "toolCalls"]) &&
        ["turns", "toolCalls"].some((field) => hasOwn(value, field)));
}
function strictOptionalStepFields(value, fields) {
    return fields.every((field) => !hasOwn(value, field) || safeStepIndex(value[field]) !== undefined);
}
function isStrictLineageReference(value, fields) {
    if (!isObject(value))
        return false;
    const numericFields = fields.filter((field) => field.endsWith("Index") || field === "depth");
    const stringFields = fields.filter((field) => !field.endsWith("Index") && field !== "depth");
    return (strictOptionalStepFields(value, numericFields) &&
        stringFields.every((field) => boundedOpaqueId(value[field])));
}
function isStrictTelemetryLineage(value) {
    if (!isObject(value))
        return false;
    let recognized = false;
    if (hasOwn(value, "continuationFrom")) {
        recognized = true;
        if (!isStrictLineageReference(value.continuationFrom, ["sourceRunId", "sourceStepIndex"]))
            return false;
    }
    if (hasOwn(value, "continuations")) {
        recognized = true;
        if (!Array.isArray(value.continuations))
            return false;
        for (const continuation of value.continuations) {
            if (!isStrictLineageReference(continuation, ["continuationRunId", "sourceStepIndex"]))
                return false;
        }
    }
    if (hasOwn(value, "nested")) {
        recognized = true;
        if (!isStrictLineageReference(value.nested, [
            "rootRunId",
            "parentRunId",
            "parentStepIndex",
            "depth",
        ]))
            return false;
    }
    return recognized;
}
function isStrictTelemetryStep(value) {
    if (!isObject(value) ||
        safeStepIndex(value.index) === undefined ||
        typeof value.agent !== "string" ||
        value.agent.trim() === "")
        return false;
    if (hasOwn(value, "model") && !isStrictTelemetryModel(value.model))
        return false;
    if (hasOwn(value, "usage") && !isStrictTelemetryUsage(value.usage))
        return false;
    if (hasOwn(value, "activity") && !isStrictTelemetryActivity(value.activity))
        return false;
    if (hasOwn(value, "timing") && !isStrictTelemetryTiming(value.timing))
        return false;
    return !hasOwn(value, "outcome") || isStrictTelemetryOutcome(value.outcome);
}
function isStrictTelemetryProvenance(value) {
    return (isObject(value) &&
        typeof value.tlhVersion === "string" &&
        value.tlhVersion.trim() !== "" &&
        typeof value.piVersion === "string" &&
        value.piVersion.trim() !== "" &&
        finiteNonNegativeNumber(value.loadedAt) &&
        strictOptionalNonEmptyStrings(value, ["installGeneration"]));
}
function isStrictTelemetryControls(value) {
    if (!isObject(value) ||
        !finiteNonNegativeNumber(value.needsAttentionAfterMs) ||
        !finiteNonNegativeNumber(value.failedToolAttemptsBeforeAttention) ||
        !Array.isArray(value.notifyOn) ||
        !Array.isArray(value.notifyChannels))
        return false;
    return (value.notifyOn.every((entry) => entry === "needs_attention") &&
        value.notifyChannels.every((entry) => entry === "event" || entry === "async"));
}
export function isStrictTelemetryEnvelope(value) {
    if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.run))
        return false;
    if (!boundedOpaqueId(value.run.id) ||
        (value.run.execution !== "foreground" && value.run.execution !== "async") ||
        (value.run.mode !== "single" && value.run.mode !== "parallel") ||
        !Array.isArray(value.steps) ||
        !isStrictTelemetryProvenance(value.provenance) ||
        !isStrictTelemetryControls(value.controls))
        return false;
    const stepIndexes = new Set();
    for (const step of value.steps) {
        if (!isStrictTelemetryStep(step))
            return false;
        const index = safeStepIndex(step.index);
        if (index === undefined || stepIndexes.has(index))
            return false;
        stepIndexes.add(index);
    }
    if (hasOwn(value, "usage") && !isStrictTelemetryUsage(value.usage))
        return false;
    if (hasOwn(value, "timing") && !isStrictTelemetryTiming(value.timing))
        return false;
    if (hasOwn(value, "outcome") && !isStrictTelemetryOutcome(value.outcome))
        return false;
    return !hasOwn(value, "lineage") || isStrictTelemetryLineage(value.lineage);
}
