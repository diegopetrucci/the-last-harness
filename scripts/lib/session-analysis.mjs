/**
 * Read-only session analysis module.
 *
 * Parses Pi session JSONL files and exposes a normalized read model.
 * All operations are strictly read-only — nothing in this module may
 * write to, mutate, or rewrite any file under the sessions directory.
 *
 * IMPORTANT: Do not import run-history.jsonl via any path.  Its
 * loadRunsForAgent reader performs a destructive truncation on read.
 *
 * This module is for out-of-process CLI use only.  Do NOT import it
 * from the extension startup path.
 */
import { createHash } from "node:crypto";
import { parseProviderModelReference } from "../../extensions/the-last-harness/model-defaults.js";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { pairToolCalls } from "../../extensions/the-last-harness/tool-pairing.js";
import { isCompletionBatchCandidate, MAX_COMPLETION_BATCH_COUNT, MAX_COMPLETION_CHUNK_ENTRIES, MAX_COMPLETION_BATCH_ID_LENGTH, projectCompletionBatchFlushFields, SUBAGENT_COMPLETION_BATCH_KIND, SUBAGENT_COMPLETION_BATCH_SCHEMA_VERSION, } from "./subagent-analysis-parser.mjs";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Throw if `filePath` resolves (following symlinks) to `run-history.jsonl`.
 *
 * The Pi runtime's `loadRunsForAgent` reader truncates that file on open,
 * making a read destructive.  Defend at the module boundary so no consumer
 * can accidentally open it regardless of how the path was constructed.
 */
function assertNotRunHistory(filePath) {
    let resolved;
    try {
        resolved = realpathSync(filePath);
    }
    catch {
        // File may not exist yet (e.g. a path being validated before creation).
        // Fall back to the literal path for the basename check.
        resolved = filePath;
    }
    if (basename(resolved) === "run-history.jsonl") {
        throw new Error(`Refusing to open run-history.jsonl: the Pi runtime truncates that file on read. ` +
            `Resolve using a session-specific path instead. Attempted path: ${filePath}`);
    }
}
/** Tolerant streaming JSONL line reader.  Does not load whole files. */
async function* readJsonlLines(filePath) {
    assertNotRunHistory(filePath);
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed)
            continue; // blank / trailing newline
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            yield { __malformed: true };
            continue;
        }
        yield parsed;
    }
}
/** Safely read the file size; returns -1 on any error. */
function safeFileSize(filePath) {
    try {
        return statSync(filePath).size;
    }
    catch {
        return -1;
    }
}
// ---------------------------------------------------------------------------
// Streaming projection
// ---------------------------------------------------------------------------
/**
 * Bounds for values copied into the in-memory analysis projection.  These are
 * intentionally generous for ordinary Pi metadata while preventing one
 * malformed line from retaining an unbounded string or array.
 */
const MAX_PROJECTION_STRING_LENGTH = 512;
const MAX_PROJECTION_PATH_LENGTH = 4096;
const MAX_PROJECTION_ITEMS = 64;
const MAX_NOTIFICATION_TEXT_LENGTH = 4096;
const MAX_OPAQUE_ID_LENGTH = 512;
const MAX_CORRELATION_TRACKED_IDS = 4096;
const MAX_CORRELATION_OCCURRENCES_PER_ID = 128;
const BACKGROUND_COMPLETION_NUDGE = "[tlh] Background subagent completed — see notification above.";
const CONTROL_NOTICE_NUDGE = "[tlh] Subagent run needs attention — see notice above.";
const SUBAGENT_NOTIFY_TYPE = "subagent-notify";
const SUBAGENT_CONTROL_TYPE = "subagent_control_notice";
const SUBAGENT_ACTIONS = new Set([
    "list",
    "get",
    "status",
    "interrupt",
    "resume",
    "steer",
    "doctor",
]);
const TELEMETRY_OUTCOME_STATES = new Set([
    "queued",
    "running",
    "completed",
    "failed",
    "paused",
    "cancelled",
    "continued",
]);
const TELEMETRY_TERMINATION_REASONS = new Set([
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
const TELEMETRY_ACCEPTANCE_STATUSES = new Set([
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
const LEGACY_OUTCOME_STATES = new Set([...TELEMETRY_OUTCOME_STATES, "complete"]);
// Include values from persisted pre-telemetry/control-channel records. The
// supervisor reasons are retained as bounded labels when they appear on a
// control event; they are not display text.
const CONTROL_EVENT_REASONS = new Set([
    "idle",
    "completion_guard",
    "tool_failures",
    "context_pressure",
    "time_threshold",
    "need_decision",
    "interview_request",
    "progress_update",
]);
const CONTEXT_PRESSURE_LEVELS = new Set(["warning", "critical"]);
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function finiteNonNegative(value) {
    return finiteNumber(value) && value >= 0;
}
function safeIndex(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** Copy a bounded string while rejecting control characters. */
function projectionString(value, maxLength = MAX_PROJECTION_STRING_LENGTH) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed || [...trimmed].length > maxLength)
        return undefined;
    if ([...trimmed].some((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
    }))
        return undefined;
    return trimmed;
}
/** Legacy IDs use the stricter path-safe grammar. */
function projectionLegacyId(value) {
    const normalized = projectionString(value);
    return normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized) ? normalized : undefined;
}
/** Structured telemetry IDs are opaque map inputs; slash and spaces are valid. */
function projectionOpaqueId(value) {
    return projectionString(value, MAX_OPAQUE_ID_LENGTH);
}
function projectionMetadata(value) {
    const normalized = projectionString(value);
    return normalized && !normalized.includes("/") && !normalized.includes("\\")
        ? normalized
        : undefined;
}
function projectFiniteFields(source, fields, options = {}) {
    const value = {};
    let invalid = false;
    for (const field of fields) {
        if (!hasOwn(source, field))
            continue;
        const candidate = source[field];
        const valid = options.nonNegative === false ? finiteNumber(candidate) : finiteNonNegative(candidate);
        if (valid)
            value[field] = candidate;
        else
            invalid = true;
    }
    return { value, invalid };
}
function projectBooleanFields(source, fields) {
    const value = {};
    let invalid = false;
    for (const field of fields) {
        if (!hasOwn(source, field))
            continue;
        if (typeof source[field] === "boolean")
            value[field] = source[field];
        else
            invalid = true;
    }
    return { value, invalid };
}
function projectStringFields(source, fields, options = {}) {
    const value = {};
    let invalid = false;
    for (const field of fields) {
        if (!hasOwn(source, field))
            continue;
        const normalized = options.metadata
            ? projectionMetadata(source[field])
            : projectionString(source[field]);
        if (normalized !== undefined)
            value[field] = normalized;
        else
            invalid = true;
    }
    return { value, invalid };
}
function projectAllowedStringFields(source, fields, allowed) {
    const value = {};
    let invalid = false;
    for (const field of fields) {
        if (!hasOwn(source, field))
            continue;
        if (typeof source[field] === "string" && allowed.has(source[field]))
            value[field] = source[field];
        else
            invalid = true;
    }
    return { value, invalid };
}
function projectUsageObject(value) {
    if (!isObject(value))
        return { invalid: true };
    const projected = projectFiniteFields(value, [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "costUsd",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
    ]);
    let invalid = projected.invalid;
    if (hasOwn(value, "cost")) {
        if (finiteNonNegative(value.cost)) {
            projected.value.cost = value.cost;
        }
        else if (isObject(value.cost)) {
            // Pi's persisted usage shape stores the legacy cost total as a nested
            // object. Normalize only its numeric total; never retain the breakdown.
            const cost = projectFiniteFields(value.cost, ["total"]);
            if (cost.value.total !== undefined)
                projected.value.cost = cost.value.total;
            if (cost.invalid || cost.value.total === undefined)
                invalid = true;
        }
        else {
            invalid = true;
        }
    }
    return { value: projected.value, invalid };
}
function projectTelemetryModel(value) {
    if (!isObject(value))
        return { invalid: true };
    const provider = projectionOpaqueId(value.provider);
    const model = projectionOpaqueId(value.model);
    const thinking = hasOwn(value, "thinking") ? projectionOpaqueId(value.thinking) : undefined;
    return {
        value: {
            ...(provider !== undefined ? { provider } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(thinking !== undefined ? { thinking } : {}),
        },
        invalid: provider === undefined ||
            model === undefined ||
            (hasOwn(value, "thinking") && thinking === undefined),
    };
}
function projectTelemetryOutcome(value) {
    if (!isObject(value))
        return { invalid: true };
    const state = projectAllowedStringFields(value, ["state"], TELEMETRY_OUTCOME_STATES);
    const termination = projectAllowedStringFields(value, ["terminationReason"], TELEMETRY_TERMINATION_REASONS);
    const acceptanceStatus = projectAllowedStringFields(value, ["acceptanceStatus"], TELEMETRY_ACCEPTANCE_STATUSES);
    const booleans = projectBooleanFields(value, ["timedOut", "interrupted", "success"]);
    const numbers = projectFiniteFields(value, ["exitCode"], { nonNegative: false });
    const acceptance = isObject(value.acceptance)
        ? projectAllowedStringFields(value.acceptance, ["status"], TELEMETRY_ACCEPTANCE_STATUSES)
        : { value: {}, invalid: hasOwn(value, "acceptance") };
    return {
        value: {
            ...state.value,
            ...termination.value,
            ...acceptanceStatus.value,
            ...booleans.value,
            ...numbers.value,
            ...(hasOwn(value, "acceptance") ? { acceptance: acceptance.value } : {}),
        },
        invalid: state.invalid ||
            termination.invalid ||
            acceptanceStatus.invalid ||
            booleans.invalid ||
            numbers.invalid ||
            acceptance.invalid,
    };
}
function projectTelemetryTiming(value) {
    if (!isObject(value))
        return { invalid: true };
    const fields = projectFiniteFields(value, [
        "startedAt",
        "endedAt",
        "durationMs",
        "activeRuntimeMs",
    ]);
    return { value: fields.value, invalid: fields.invalid };
}
function projectTelemetryActivity(value) {
    if (!isObject(value))
        return { invalid: true };
    const fields = projectFiniteFields(value, ["turns", "toolCalls"]);
    return { value: fields.value, invalid: fields.invalid };
}
function projectTelemetryLineage(value) {
    if (!isObject(value))
        return { invalid: true };
    let invalid = false;
    const result = {};
    if (hasOwn(value, "continuationFrom")) {
        if (!isObject(value.continuationFrom)) {
            invalid = true;
        }
        else {
            const sourceRunId = projectionOpaqueId(value.continuationFrom.sourceRunId);
            const sourceStepIndex = value.continuationFrom.sourceStepIndex === undefined
                ? undefined
                : safeIndex(value.continuationFrom.sourceStepIndex)
                    ? value.continuationFrom.sourceStepIndex
                    : undefined;
            if (!sourceRunId ||
                (value.continuationFrom.sourceStepIndex !== undefined && sourceStepIndex === undefined))
                invalid = true;
            result.continuationFrom = {
                ...(sourceRunId !== undefined ? { sourceRunId } : {}),
                ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
            };
        }
    }
    if (hasOwn(value, "continuations")) {
        if (!Array.isArray(value.continuations)) {
            invalid = true;
        }
        else {
            const continuations = [];
            if (value.continuations.length > MAX_PROJECTION_ITEMS)
                invalid = true;
            for (const entry of value.continuations.slice(0, MAX_PROJECTION_ITEMS)) {
                if (!isObject(entry)) {
                    invalid = true;
                    continue;
                }
                const continuationRunId = projectionOpaqueId(entry.continuationRunId);
                const sourceStepIndex = entry.sourceStepIndex === undefined
                    ? undefined
                    : safeIndex(entry.sourceStepIndex)
                        ? entry.sourceStepIndex
                        : undefined;
                if (!continuationRunId ||
                    (entry.sourceStepIndex !== undefined && sourceStepIndex === undefined)) {
                    invalid = true;
                    continue;
                }
                continuations.push({
                    continuationRunId,
                    ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
                });
            }
            result.continuations = continuations;
        }
    }
    if (hasOwn(value, "nested")) {
        if (!isObject(value.nested)) {
            invalid = true;
        }
        else {
            const rootRunId = projectionOpaqueId(value.nested.rootRunId);
            const parentRunId = projectionOpaqueId(value.nested.parentRunId);
            const parentStepIndex = value.nested.parentStepIndex === undefined
                ? undefined
                : safeIndex(value.nested.parentStepIndex)
                    ? value.nested.parentStepIndex
                    : undefined;
            const depth = value.nested.depth === undefined
                ? undefined
                : safeIndex(value.nested.depth)
                    ? value.nested.depth
                    : undefined;
            if (!rootRunId ||
                !parentRunId ||
                (value.nested.parentStepIndex !== undefined && parentStepIndex === undefined) ||
                (value.nested.depth !== undefined && depth === undefined))
                invalid = true;
            result.nested = {
                ...(rootRunId !== undefined ? { rootRunId } : {}),
                ...(parentRunId !== undefined ? { parentRunId } : {}),
                ...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
                ...(depth !== undefined ? { depth } : {}),
            };
        }
    }
    return { value: result, invalid };
}
/** Project only the allowlisted fields of a structured telemetry envelope. */
function projectTelemetryEnvelope(value) {
    if (!isObject(value))
        return { invalid: true };
    let invalid = false;
    const result = {};
    if (hasOwn(value, "schemaVersion")) {
        if (typeof value.schemaVersion === "number" && Number.isSafeInteger(value.schemaVersion))
            result.schemaVersion = value.schemaVersion;
        else
            invalid = true;
    }
    if (!isObject(value.run)) {
        invalid = true;
    }
    else {
        const run = {};
        const id = projectionOpaqueId(value.run.id);
        if (id !== undefined)
            run.id = id;
        else
            invalid = true;
        if (value.run.execution === "foreground" || value.run.execution === "async")
            run.execution = value.run.execution;
        else
            invalid = true;
        if (value.run.mode === "single" || value.run.mode === "parallel")
            run.mode = value.run.mode;
        else
            invalid = true;
        result.run = run;
    }
    if (!Array.isArray(value.steps)) {
        invalid = true;
    }
    else {
        const steps = [];
        if (value.steps.length > MAX_PROJECTION_ITEMS)
            invalid = true;
        for (const rawStep of value.steps.slice(0, MAX_PROJECTION_ITEMS)) {
            if (!isObject(rawStep)) {
                invalid = true;
                continue;
            }
            const step = {};
            if (safeIndex(rawStep.index))
                step.index = rawStep.index;
            else
                invalid = true;
            const agent = projectionMetadata(rawStep.agent);
            if (agent !== undefined)
                step.agent = agent;
            else
                invalid = true;
            for (const [key, projector] of [
                ["model", projectTelemetryModel],
                ["usage", projectUsageObject],
                ["activity", projectTelemetryActivity],
                ["timing", projectTelemetryTiming],
                ["outcome", projectTelemetryOutcome],
            ]) {
                if (!hasOwn(rawStep, key))
                    continue;
                const projected = projector(rawStep[key]);
                if (projected.value !== undefined)
                    step[key] = projected.value;
                if (projected.invalid)
                    invalid = true;
            }
            steps.push(step);
        }
        result.steps = steps;
    }
    for (const [key, projector] of [
        ["usage", projectUsageObject],
        ["timing", projectTelemetryTiming],
        ["outcome", projectTelemetryOutcome],
        ["lineage", projectTelemetryLineage],
    ]) {
        if (!hasOwn(value, key))
            continue;
        const projected = projector(value[key]);
        if (projected.value !== undefined)
            result[key] = projected.value;
        if (projected.invalid)
            invalid = true;
    }
    if (!isObject(value.provenance)) {
        invalid = true;
    }
    else {
        const provenance = {};
        const strings = projectStringFields(value.provenance, ["tlhVersion", "piVersion", "installGeneration"], { metadata: true });
        const loadedAt = projectFiniteFields(value.provenance, ["loadedAt"]);
        Object.assign(provenance, strings.value, loadedAt.value);
        if (strings.invalid || loadedAt.invalid)
            invalid = true;
        result.provenance = provenance;
    }
    if (!isObject(value.controls)) {
        invalid = true;
    }
    else {
        const controls = {};
        const numbers = projectFiniteFields(value.controls, [
            "needsAttentionAfterMs",
            "failedToolAttemptsBeforeAttention",
        ]);
        Object.assign(controls, numbers.value);
        if (numbers.invalid)
            invalid = true;
        for (const field of ["notifyOn", "notifyChannels"]) {
            if (!Array.isArray(value.controls[field])) {
                invalid = true;
                continue;
            }
            if (value.controls[field].length > MAX_PROJECTION_ITEMS)
                invalid = true;
            const values = [];
            for (const candidate of value.controls[field].slice(0, MAX_PROJECTION_ITEMS)) {
                const valid = field === "notifyOn"
                    ? candidate === "needs_attention"
                    : candidate === "event" || candidate === "async";
                if (valid)
                    values.push(candidate);
                else
                    invalid = true;
            }
            controls[field] = values;
        }
        result.controls = controls;
    }
    if (invalid)
        result.__projectionInvalid = true;
    return { value: result, invalid };
}
function projectControlEvent(value) {
    if (!isObject(value))
        return { invalid: true };
    let invalid = false;
    const result = {};
    const runId = projectionOpaqueId(value.runId);
    if (runId !== undefined)
        result.runId = runId;
    else
        invalid = true;
    const validTransition = (value.type === "needs_attention" && value.to === "needs_attention") ||
        (value.type === "active_long_running" && value.to === "active_long_running");
    if (validTransition) {
        result.type = value.type;
        result.to = value.to;
    }
    else {
        invalid = true;
    }
    const ts = projectFiniteFields(value, ["ts"]);
    const index = hasOwn(value, "index")
        ? safeIndex(value.index)
            ? { index: value.index }
            : undefined
        : {};
    if (ts.value.ts !== undefined)
        result.ts = ts.value.ts;
    if (ts.invalid)
        invalid = true;
    if (hasOwn(value, "index") && index === undefined)
        invalid = true;
    if (index?.index !== undefined)
        result.index = index.index;
    const agent = projectionMetadata(value.agent);
    if (agent !== undefined)
        result.agent = agent;
    else
        invalid = true;
    const messagePresent = typeof value.message === "string" && value.message.trim() !== "";
    result.messagePresent = messagePresent;
    if (!messagePresent)
        invalid = true;
    const reasons = projectAllowedStringFields(value, ["reason"], CONTROL_EVENT_REASONS);
    const pressure = projectAllowedStringFields(value, ["contextPressureSeverity", "contextPressureThreshold"], CONTEXT_PRESSURE_LEVELS);
    const idleEpisode = projectStringFields(value, ["idleEpisodeId"], { metadata: true });
    Object.assign(result, reasons.value, pressure.value, idleEpisode.value);
    if (reasons.invalid || pressure.invalid || idleEpisode.invalid)
        invalid = true;
    if (invalid)
        result.__projectionInvalid = true;
    return { value: result, invalid };
}
function projectLegacyModelFields(source, target) {
    let invalid = false;
    if (hasOwn(source, "model")) {
        const rawModel = projectionString(source.model);
        const parsedReference = rawModel === undefined ? undefined : parseProviderModelReference(rawModel);
        const qualifiedModelValid = parsedReference !== undefined &&
            projectionMetadata(parsedReference.provider) !== undefined &&
            projectionOpaqueId(parsedReference.id) !== undefined;
        const model = rawModel !== undefined && (qualifiedModelValid || projectionMetadata(rawModel) !== undefined)
            ? rawModel
            : undefined;
        if (model !== undefined)
            target.model = model;
        else
            invalid = true;
    }
    for (const field of ["provider", "thinking"]) {
        if (!hasOwn(source, field))
            continue;
        const value = projectionMetadata(source[field]);
        if (value !== undefined)
            target[field] = value;
        else
            invalid = true;
    }
    if (hasOwn(source, "modelIdentity")) {
        const modelIdentity = projectTelemetryModel(source.modelIdentity);
        if (modelIdentity.value !== undefined)
            target.modelIdentity = modelIdentity.value;
        if (modelIdentity.invalid)
            invalid = true;
    }
    return invalid;
}
function projectLegacyChild(value) {
    if (!isObject(value))
        return { invalid: true };
    let invalid = false;
    const result = {};
    const agent = projectionMetadata(value.agent);
    if (agent !== undefined)
        result.agent = agent;
    else if (hasOwn(value, "agent"))
        invalid = true;
    if (hasOwn(value, "index")) {
        if (safeIndex(value.index))
            result.index = value.index;
        else
            invalid = true;
    }
    invalid = projectLegacyModelFields(value, result) || invalid;
    const states = projectAllowedStringFields(value, ["status", "state"], LEGACY_OUTCOME_STATES);
    const termination = projectAllowedStringFields(value, ["terminationReason"], TELEMETRY_TERMINATION_REASONS);
    const acceptanceStatus = projectAllowedStringFields(value, ["acceptanceStatus"], TELEMETRY_ACCEPTANCE_STATUSES);
    Object.assign(result, states.value, termination.value, acceptanceStatus.value);
    if (states.invalid || termination.invalid || acceptanceStatus.invalid)
        invalid = true;
    const directNumbers = projectFiniteFields(value, ["startedAt", "endedAt", "durationMs", "activeRuntimeMs", "exitCode"], { nonNegative: false });
    Object.assign(result, directNumbers.value);
    if (directNumbers.invalid)
        invalid = true;
    const directBooleans = projectBooleanFields(value, ["timedOut", "interrupted", "success"]);
    Object.assign(result, directBooleans.value);
    if (directBooleans.invalid)
        invalid = true;
    if (hasOwn(value, "acceptance")) {
        if (isObject(value.acceptance)) {
            const acceptance = projectAllowedStringFields(value.acceptance, ["status"], TELEMETRY_ACCEPTANCE_STATUSES);
            result.acceptance = acceptance.value;
            if (acceptance.invalid)
                invalid = true;
        }
        else
            invalid = true;
    }
    for (const [key, projector] of [
        ["usage", projectUsageObject],
        ["timing", projectTelemetryTiming],
        ["outcome", projectTelemetryOutcome],
    ]) {
        if (!hasOwn(value, key))
            continue;
        const projected = projector(value[key]);
        if (projected.value !== undefined)
            result[key] = projected.value;
        if (projected.invalid)
            invalid = true;
    }
    if (hasOwn(value, "totalCost")) {
        const totalCost = projectFiniteFields(isObject(value.totalCost) ? value.totalCost : {}, [
            "costUsd",
        ]);
        if (isObject(value.totalCost))
            result.totalCost = totalCost.value;
        if (!isObject(value.totalCost) || totalCost.invalid)
            invalid = true;
    }
    if (hasOwn(value, "controlEvents")) {
        if (!Array.isArray(value.controlEvents)) {
            invalid = true;
        }
        else {
            const events = [];
            if (value.controlEvents.length > MAX_PROJECTION_ITEMS)
                invalid = true;
            for (const event of value.controlEvents.slice(0, MAX_PROJECTION_ITEMS)) {
                const projected = projectControlEvent(event);
                if (projected.value !== undefined)
                    events.push(projected.value);
                if (projected.invalid)
                    invalid = true;
            }
            result.controlEvents = events;
        }
    }
    if (invalid)
        result.__projectionInvalid = true;
    return { value: result, invalid };
}
/** Project result details without copying task, prompt, output, cwd, or settings. */
function projectSubagentDetails(value, options = {}) {
    if (!isObject(value))
        return undefined;
    let invalid = false;
    const result = {};
    const projectRunId = options.opaqueIds ? projectionOpaqueId : projectionLegacyId;
    for (const field of ["runId", "asyncId"]) {
        if (!hasOwn(value, field))
            continue;
        const id = projectRunId(value[field]);
        if (id !== undefined)
            result[field] = id;
        else
            invalid = true;
    }
    const mode = value.mode === "single" || value.mode === "parallel" || value.mode === "management"
        ? value.mode
        : undefined;
    if (hasOwn(value, "mode")) {
        if (mode !== undefined)
            result.mode = mode;
        else
            invalid = true;
    }
    invalid = projectLegacyModelFields(value, result) || invalid;
    const agent = projectStringFields(value, ["agent"], { metadata: true });
    const states = projectAllowedStringFields(value, ["status", "state"], LEGACY_OUTCOME_STATES);
    const termination = projectAllowedStringFields(value, ["terminationReason"], TELEMETRY_TERMINATION_REASONS);
    const acceptanceStatus = projectAllowedStringFields(value, ["acceptanceStatus"], TELEMETRY_ACCEPTANCE_STATUSES);
    Object.assign(result, agent.value, states.value, termination.value, acceptanceStatus.value);
    if (agent.invalid || states.invalid || termination.invalid || acceptanceStatus.invalid)
        invalid = true;
    const numbers = projectFiniteFields(value, ["durationMs", "activeRuntimeMs", "startedAt", "endedAt", "exitCode", "totalSteps"], { nonNegative: false });
    Object.assign(result, numbers.value);
    if (numbers.invalid)
        invalid = true;
    const booleans = projectBooleanFields(value, ["timedOut", "interrupted", "success"]);
    Object.assign(result, booleans.value);
    if (booleans.invalid)
        invalid = true;
    if (hasOwn(value, "acceptance")) {
        if (isObject(value.acceptance)) {
            const acceptance = projectAllowedStringFields(value.acceptance, ["status"], TELEMETRY_ACCEPTANCE_STATUSES);
            result.acceptance = acceptance.value;
            if (acceptance.invalid)
                invalid = true;
        }
        else
            invalid = true;
    }
    for (const [key, projector] of [
        ["totalChildUsage", projectUsageObject],
        [
            "totalCost",
            (candidate) => isObject(candidate)
                ? (() => {
                    const cost = projectFiniteFields(candidate, ["costUsd"]);
                    return { value: cost.value, invalid: cost.invalid };
                })()
                : { value: undefined, invalid: true },
        ],
        ["telemetry", projectTelemetryEnvelope],
        ["event", projectControlEvent],
    ]) {
        if (!hasOwn(value, key))
            continue;
        const projected = projector(value[key]);
        if (projected.value !== undefined)
            result[key] = projected.value;
        if (projected.invalid)
            invalid = true;
    }
    if (hasOwn(value, "results")) {
        if (!Array.isArray(value.results)) {
            invalid = true;
        }
        else {
            const results = [];
            if (value.results.length > MAX_PROJECTION_ITEMS)
                invalid = true;
            for (const child of value.results.slice(0, MAX_PROJECTION_ITEMS)) {
                const projected = projectLegacyChild(child);
                if (projected.value !== undefined)
                    results.push(projected.value);
                if (projected.invalid)
                    invalid = true;
            }
            result.results = results;
        }
    }
    if (hasOwn(value, "controlEvents")) {
        if (!Array.isArray(value.controlEvents)) {
            invalid = true;
        }
        else {
            const events = [];
            if (value.controlEvents.length > MAX_PROJECTION_ITEMS)
                invalid = true;
            for (const event of value.controlEvents.slice(0, MAX_PROJECTION_ITEMS)) {
                const projected = projectControlEvent(event);
                if (projected.value !== undefined)
                    events.push(projected.value);
                if (projected.invalid)
                    invalid = true;
            }
            result.controlEvents = events;
        }
    }
    // An async directory is a path in the raw message. Retain only its presence
    // as an execution hint, never the path itself.
    if (hasOwn(value, "asyncDir"))
        result.asyncReference = true;
    if (hasOwn(value, "source")) {
        if (value.source === "foreground" || value.source === "async")
            result.source = value.source;
        else
            invalid = true;
    }
    if (invalid)
        result.__projectionInvalid = true;
    return result;
}
/** Project the runtime's telemetry-only grouped completion carrier. */
function projectCompletionBatchDetails(value) {
    if (!isObject(value))
        return undefined;
    let invalid = false;
    const result = {};
    if (value.schemaVersion === SUBAGENT_COMPLETION_BATCH_SCHEMA_VERSION)
        result.schemaVersion = value.schemaVersion;
    else
        invalid = true;
    if (value.kind === SUBAGENT_COMPLETION_BATCH_KIND)
        result.kind = value.kind;
    else
        invalid = true;
    const rawBatchId = projectionString(value.batchId, MAX_COMPLETION_BATCH_ID_LENGTH);
    // Keep only an equality token in the streaming projection; the raw opaque
    // carrier ID is not user-facing evidence and need not persist in memory.
    const batchId = rawBatchId === undefined
        ? undefined
        : createHash("sha256").update(rawBatchId).digest("hex").slice(0, 32);
    const batchIndex = safeIndex(value.batchIndex) ? value.batchIndex : undefined;
    const batchCount = safeIndex(value.batchCount) ? value.batchCount : undefined;
    const flushFields = projectCompletionBatchFlushFields(value);
    Object.assign(result, flushFields.value);
    if (flushFields.invalid)
        invalid = true;
    if (batchId !== undefined && [...batchId].length <= MAX_COMPLETION_BATCH_ID_LENGTH)
        result.batchId = batchId;
    else
        invalid = true;
    if (batchIndex !== undefined)
        result.batchIndex = batchIndex;
    else
        invalid = true;
    if (batchCount !== undefined &&
        batchCount >= 1 &&
        batchCount <= MAX_COMPLETION_BATCH_COUNT &&
        batchIndex !== undefined &&
        batchIndex < batchCount)
        result.batchCount = batchCount;
    else
        invalid = true;
    if (typeof value.triggersTurn === "boolean")
        result.triggersTurn = value.triggersTurn;
    else
        invalid = true;
    if (!Array.isArray(value.completions)) {
        invalid = true;
    }
    else {
        if (value.completions.length === 0 || value.completions.length > MAX_COMPLETION_CHUNK_ENTRIES)
            invalid = true;
        const completions = [];
        for (const rawEntry of value.completions.slice(0, MAX_COMPLETION_CHUNK_ENTRIES)) {
            if (!isObject(rawEntry)) {
                // Preserve an entry-shaped marker so the parser can invalidate this
                // batch while still accepting independently valid sibling entries.
                completions.push({ __projectionInvalid: true });
                continue;
            }
            let entryInvalid = false;
            const completion = {};
            const agent = projectionMetadata(rawEntry.agent);
            if (agent !== undefined && [...agent].length <= 160)
                completion.agent = agent;
            else
                entryInvalid = true;
            if (rawEntry.status === "completed" ||
                rawEntry.status === "failed" ||
                rawEntry.status === "paused")
                completion.status = rawEntry.status;
            else
                entryInvalid = true;
            if (hasOwn(rawEntry, "durationMs")) {
                const duration = projectFiniteFields(rawEntry, ["durationMs"]);
                Object.assign(completion, duration.value);
                if (duration.invalid)
                    entryInvalid = true;
            }
            if (hasOwn(rawEntry, "asyncId")) {
                const asyncId = projectionOpaqueId(rawEntry.asyncId);
                if (asyncId !== undefined && [...asyncId].length <= MAX_COMPLETION_BATCH_ID_LENGTH)
                    completion.asyncId = asyncId;
                else
                    entryInvalid = true;
            }
            if (hasOwn(rawEntry, "telemetry")) {
                const telemetry = projectTelemetryEnvelope(rawEntry.telemetry);
                // Retain the bounded projected envelope, including its invalid marker,
                // so a malformed sibling is a coverage gap rather than erasing valid
                // telemetry from the rest of the grouped notification.
                completion.telemetry = telemetry.value ?? { __projectionInvalid: true };
                if (telemetry.invalid)
                    entryInvalid = true;
            }
            if (entryInvalid)
                completion.__projectionInvalid = true;
            completions.push(completion);
        }
        result.completions = completions;
    }
    // This marker describes only malformed batch-level fields. Entry-level
    // markers stay nested so valid siblings can be parsed independently.
    if (invalid)
        result.__projectionInvalid = true;
    return result;
}
function parseProjectionCallArguments(item) {
    const raw = hasOwn(item, "arguments") ? item.arguments : item.args;
    if (raw === undefined)
        return { operation: {}, malformed: false };
    let args;
    if (isObject(raw))
        args = raw;
    else if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (isObject(parsed))
                args = parsed;
        }
        catch {
            // malformed below
        }
    }
    if (!args)
        return { operation: { malformedArguments: true }, malformed: true };
    const operation = {};
    if (hasOwn(args, "action")) {
        operation.hasAction = true;
        if (typeof args.action === "string" && SUBAGENT_ACTIONS.has(args.action))
            operation.action = args.action;
        else {
            operation.actionUnknown = true;
            operation.actionMalformed = typeof args.action !== "string";
        }
    }
    if (hasOwn(args, "id")) {
        operation.hasTarget = true;
        const targetRunId = projectionLegacyId(args.id);
        if (targetRunId !== undefined)
            operation.targetRunId = targetRunId;
        else
            operation.targetInvalid = true;
    }
    if (hasOwn(args, "async")) {
        operation.hasAsync = true;
        if (typeof args.async === "boolean")
            operation.async = args.async;
        else
            operation.asyncInvalid = true;
    }
    if (hasOwn(args, "agent"))
        operation.agentPresent = true;
    if (hasOwn(args, "tasks"))
        operation.tasksPresent = true;
    const roles = [];
    const agent = projectionMetadata(args.agent);
    if (agent !== undefined)
        roles.push(agent);
    if (Array.isArray(args.tasks)) {
        if (args.tasks.length > MAX_PROJECTION_ITEMS)
            operation.tasksTruncated = true;
        for (const task of args.tasks.slice(0, MAX_PROJECTION_ITEMS)) {
            if (!isObject(task))
                continue;
            const taskAgent = projectionMetadata(task.agent);
            if (taskAgent !== undefined)
                roles.push(taskAgent);
        }
    }
    if (roles.length > 0)
        operation.roles = [...new Set(roles)].slice(0, MAX_PROJECTION_ITEMS);
    return { operation, malformed: false };
}
function selectedToolName(item) {
    const candidate = item.toolName ?? item.name;
    return typeof candidate === "string" ? candidate : undefined;
}
function isSubagentToolCall(item) {
    return (isObject(item) &&
        item.type === "toolCall" &&
        projectionMetadata(selectedToolName(item)) === "subagent");
}
function isValidProjectionTimestamp(entry, message) {
    const timestamp = projectionTimestamp(entry, message);
    return timestamp !== undefined && Number.isFinite(Date.parse(timestamp));
}
function projectAssistantToolCall(item) {
    if (!isObject(item) || item.type !== "toolCall")
        return undefined;
    // Pi persists tool-call IDs as opaque provider/composite values such as
    // `call_*|fc_*`. They are map keys for pairing, not legacy metadata IDs.
    const toolCallId = projectionOpaqueId(item.toolCallId ?? item.id);
    const toolName = projectionMetadata(selectedToolName(item));
    if (toolName === undefined)
        return undefined;
    const result = { type: "toolCall", toolName };
    if (toolCallId !== undefined)
        result.toolCallId = toolCallId;
    if (toolName === "subagent") {
        result.operation = parseProjectionCallArguments(item).operation;
    }
    return result;
}
function projectionTimestamp(entry, message) {
    let invalidStringFallback;
    const parseString = (value) => {
        const timestamp = projectionString(value, 128);
        if (timestamp === undefined)
            return undefined;
        if (Number.isFinite(Date.parse(timestamp)))
            return timestamp;
        invalidStringFallback ??= timestamp;
        return undefined;
    };
    const parseNumber = (value) => {
        if (!finiteNumber(value))
            return undefined;
        const timestamp = new Date(value);
        return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
    };
    // Prefer the string entry timestamp when the persisted message timestamp is
    // numeric. This retains the exact ISO envelope Pi writes and remains
    // compatible with historical fixtures where only message.timestamp exists.
    if (typeof message.timestamp === "string") {
        const timestamp = parseString(message.timestamp);
        if (timestamp !== undefined)
            return timestamp;
    }
    if (typeof entry.timestamp === "string") {
        const timestamp = parseString(entry.timestamp);
        if (timestamp !== undefined)
            return timestamp;
    }
    if (typeof message.timestamp === "number") {
        const timestamp = parseNumber(message.timestamp);
        if (timestamp !== undefined)
            return timestamp;
    }
    if (typeof entry.timestamp === "number") {
        const timestamp = parseNumber(entry.timestamp);
        if (timestamp !== undefined)
            return timestamp;
    }
    // Preserve a bounded malformed string so pairToolCalls can report an
    // invalid pair rather than silently dropping evidence altogether.
    return invalidStringFallback;
}
function messageTextForProjection(value) {
    if (typeof value === "string")
        return value.slice(0, MAX_NOTIFICATION_TEXT_LENGTH);
    if (!Array.isArray(value))
        return undefined;
    const parts = [];
    let length = 0;
    for (const item of value) {
        if (!isObject(item) || item.type !== "text" || typeof item.text !== "string")
            return undefined;
        const remaining = MAX_NOTIFICATION_TEXT_LENGTH - length;
        if (remaining <= 0)
            break;
        const text = item.text.slice(0, remaining);
        parts.push(text);
        length += text.length;
    }
    return parts.join("");
}
function projectMessageEntry(entry, message) {
    const customType = typeof message.customType === "string" ? message.customType : undefined;
    const role = typeof message.role === "string"
        ? message.role
        : customType === SUBAGENT_NOTIFY_TYPE || customType === SUBAGENT_CONTROL_TYPE
            ? "custom"
            : "other";
    if (role !== "assistant" && role !== "toolResult" && role !== "user" && role !== "custom")
        return undefined;
    const projected = { role };
    const timestamp = projectionTimestamp(entry, message);
    if (timestamp !== undefined)
        projected.timestamp = timestamp;
    if (role === "assistant") {
        if (hasOwn(message, "usage")) {
            const usage = projectUsageObject(message.usage);
            if (usage.value !== undefined)
                projected.usage = usage.value;
        }
        if (Array.isArray(message.content)) {
            const content = [];
            for (const item of message.content.slice(0, MAX_PROJECTION_ITEMS)) {
                const toolCall = projectAssistantToolCall(item);
                if (toolCall !== undefined)
                    content.push(toolCall);
            }
            projected.content = content;
        }
    }
    else if (role === "toolResult") {
        // Result IDs use the same opaque provider/composite identity as calls.
        const toolCallId = projectionOpaqueId(message.toolCallId);
        const toolName = projectionMetadata(message.toolName);
        if (toolCallId !== undefined)
            projected.toolCallId = toolCallId;
        if (toolName !== undefined)
            projected.toolName = toolName;
        projected.isError = message.isError === true;
        if (hasOwn(message, "details")) {
            const details = projectSubagentDetails(message.details);
            if (details !== undefined)
                projected.details = details;
            else
                projected.details = { __projectionInvalid: true };
        }
    }
    if (customType === SUBAGENT_NOTIFY_TYPE || customType === SUBAGENT_CONTROL_TYPE) {
        projected.customType = customType;
        const text = messageTextForProjection(message.content);
        if (customType === SUBAGENT_NOTIFY_TYPE &&
            text !== undefined &&
            /^Background tasks? (?:completed|failed|paused)(?:\s*\([^)]*\))?:/.test(text))
            projected.legacyNotification = "completion";
        if (customType === SUBAGENT_CONTROL_TYPE &&
            text !== undefined &&
            /^Subagent(?: run)? needs attention\b/.test(text))
            projected.legacyNotification = "control";
        if (hasOwn(message, "details")) {
            const details = isCompletionBatchCandidate(message.details)
                ? projectCompletionBatchDetails(message.details)
                : projectSubagentDetails(message.details, { opaqueIds: true });
            if (details !== undefined)
                projected.details = details;
            else
                projected.details = { __projectionInvalid: true };
        }
    }
    if (role === "user") {
        const text = messageTextForProjection(message.content);
        if (text === BACKGROUND_COMPLETION_NUDGE)
            projected.syntheticNudge = "completion";
        else if (text === CONTROL_NOTICE_NUDGE)
            projected.syntheticNudge = "control";
    }
    if (role === "custom" &&
        customType !== SUBAGENT_NOTIFY_TYPE &&
        customType !== SUBAGENT_CONTROL_TYPE)
        return undefined;
    return { type: "message", message: projected };
}
/** Adapt Pi's persisted top-level custom_message envelope to the common projection. */
function customMessageForEntry(entry) {
    const customType = typeof entry.customType === "string" ? entry.customType : undefined;
    if (customType !== SUBAGENT_NOTIFY_TYPE && customType !== SUBAGENT_CONTROL_TYPE)
        return undefined;
    return {
        role: "custom",
        customType,
        ...(hasOwn(entry, "content") ? { content: entry.content } : {}),
        ...(hasOwn(entry, "details") ? { details: entry.details } : {}),
    };
}
function projectionContainsInvalidMarker(value) {
    if (Array.isArray(value))
        return value.some(projectionContainsInvalidMarker);
    if (!isObject(value))
        return false;
    if (value.__projectionInvalid === true)
        return true;
    return Object.values(value).some(projectionContainsInvalidMarker);
}
/**
 * Count evidence-bearing values that were dropped by the bounded projection.
 * This deliberately ignores ordinary display payloads and unknown metadata:
 * only losses that can change subagent analysis coverage are surfaced.
 */
function projectionGapCountForMessage(entry, message, projection) {
    let gaps = 0;
    const role = typeof message.role === "string" ? message.role : "other";
    const customType = typeof message.customType === "string" ? message.customType : undefined;
    if (role === "assistant") {
        const content = message.content;
        const toolCalls = Array.isArray(content)
            ? content.filter((item) => isObject(item) && item.type === "toolCall")
            : [];
        const subagentCalls = toolCalls.filter(isSubagentToolCall);
        // A long assistant content array is only a coverage gap when the omitted
        // suffix contains subagent evidence. Ordinary display/tool metadata is
        // intentionally outside this counter's boundary.
        if (Array.isArray(content) &&
            content.length > MAX_PROJECTION_ITEMS &&
            content.slice(MAX_PROJECTION_ITEMS).some(isSubagentToolCall))
            gaps++;
        for (const item of subagentCalls) {
            if (projectionOpaqueId(item.toolCallId ?? item.id) === undefined)
                gaps++;
            if (projectionMetadata(selectedToolName(item)) === undefined)
                gaps++;
            if (!isValidProjectionTimestamp(entry, message))
                gaps++;
            const parsedArguments = parseProjectionCallArguments(item);
            const operation = parsedArguments.operation;
            if (parsedArguments.malformed ||
                operation.actionMalformed === true ||
                operation.targetInvalid === true ||
                operation.asyncInvalid === true ||
                operation.tasksTruncated === true)
                gaps++;
        }
        // Assistant usage is consumed for a synthetic subagent wakeup or launch
        // context; do not turn malformed usage on unrelated assistant turns into a
        // false subagent projection gap.
        if (subagentCalls.length > 0 &&
            hasOwn(message, "usage") &&
            projectUsageObject(message.usage).invalid)
            gaps++;
    }
    else if (role === "toolResult" && projectionMetadata(message.toolName) === "subagent") {
        if (projectionOpaqueId(message.toolCallId) === undefined)
            gaps++;
        if (!isValidProjectionTimestamp(entry, message))
            gaps++;
        if (hasOwn(message, "details")) {
            const details = isObject(message.details)
                ? projectSubagentDetails(message.details)
                : undefined;
            if (details === undefined || projectionContainsInvalidMarker(details))
                gaps++;
        }
    }
    if (customType === SUBAGENT_NOTIFY_TYPE || customType === SUBAGENT_CONTROL_TYPE) {
        if (!isValidProjectionTimestamp(entry, message))
            gaps++;
        if (hasOwn(message, "details")) {
            const details = isCompletionBatchCandidate(message.details)
                ? projectCompletionBatchDetails(message.details)
                : projectSubagentDetails(message.details, { opaqueIds: true });
            if (details === undefined || projectionContainsInvalidMarker(details))
                gaps++;
        }
    }
    const relevant = (role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(isSubagentToolCall)) ||
        (role === "toolResult" && projectionMetadata(message.toolName) === "subagent") ||
        customType === SUBAGENT_NOTIFY_TYPE ||
        customType === SUBAGENT_CONTROL_TYPE;
    if (projection === undefined && relevant)
        gaps++;
    return gaps;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Scan a single session JSONL file in a streaming, read-only manner.
 *
 * - Malformed lines are counted and skipped, never thrown.
 * - An unterminated trailing line (live session append) is tolerated.
 * - Tool calls and results are paired by `toolCallId` only — never by
 *   adjacency or tool name.
 * - The file is never written to or mutated.
 * - Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function scanSessionFile(filePath) {
    // Fix 1: reject run-history.jsonl at the public API boundary as well, so
    // any direct caller gets a clear error even if readJsonlLines is bypassed.
    assertNotRunHistory(filePath);
    const sizeBefore = safeFileSize(filePath);
    let sessionHeader = null;
    let malformedLines = 0;
    let projectionGapCount = 0;
    const entries = [];
    const correlationEvidenceCapture = createCorrelationEvidenceCapture();
    for await (const parsed of readJsonlLines(filePath)) {
        if (!isObject(parsed)) {
            malformedLines++;
            continue;
        }
        // Sentinel set by the generator for unparseable lines
        if (parsed["__malformed"] === true) {
            malformedLines++;
            continue;
        }
        const entryType = parsed["type"];
        if (entryType === "session" && sessionHeader === null) {
            if (typeof parsed["version"] === "number" &&
                typeof parsed["id"] === "string" &&
                typeof parsed["timestamp"] === "string" &&
                typeof parsed["cwd"] === "string") {
                sessionHeader = {
                    type: "session",
                    version: parsed["version"],
                    id: parsed["id"],
                    timestamp: parsed["timestamp"],
                    cwd: parsed["cwd"],
                };
            }
            continue;
        }
        if (entryType === "custom_message") {
            const message = customMessageForEntry(parsed);
            if (message !== undefined) {
                const projection = projectMessageEntry(parsed, message);
                projectionGapCount += projectionGapCountForMessage(parsed, message, projection);
                if (projection !== undefined)
                    entries.push(projection);
            }
            continue;
        }
        if (entryType !== "message")
            continue;
        const message = parsed["message"];
        if (!isObject(message)) {
            malformedLines++;
            continue;
        }
        captureCorrelationEntryEvidence(correlationEvidenceCapture, parsed, message);
        const projection = projectMessageEntry(parsed, message);
        projectionGapCount += projectionGapCountForMessage(parsed, message, projection);
        if (projection !== undefined)
            entries.push(projection);
    }
    const sizeAfter = safeFileSize(filePath);
    const { toolPairs, unmatchedToolCallCount, unmatchedToolResultCount, observedToolCallCount, duplicateToolCallIdCount, invalidTimestampPairCount, } = pairToolCalls(entries);
    const pairedSubagentToolCallIds = new Set(toolPairs.filter((pair) => pair.toolName === "subagent").map((pair) => pair.toolCallId));
    const correlationEvidence = buildCorrelationEvidenceToken(correlationEvidenceCapture, pairedSubagentToolCallIds);
    return {
        filePath,
        sessionHeader,
        entries,
        toolPairs,
        malformedLines,
        unmatchedToolCallCount,
        unmatchedToolResultCount,
        fileSizeChangedDuringScan: sizeBefore !== sizeAfter,
        observedToolCallCount,
        duplicateToolCallIdCount,
        invalidTimestampPairCount,
        projectionGapCount,
        correlationEvidenceDigest: correlationEvidence?.digest ?? null,
        correlationEvidenceGeneration: correlationEvidence?.generation ?? 0,
        correlationEvidenceCaptureOverflow: correlationEvidenceCapture.overflow,
    };
}
/**
 * Read only the session header from a JSONL file without scanning
 * all entries.  Returns null when no valid session header is found.
 *
 * Stops reading as soon as the header is found.
 * Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function readSessionHeader(filePath) {
    // Fix 1: also guard the header-only reader.
    assertNotRunHistory(filePath);
    for await (const parsed of readJsonlLines(filePath)) {
        if (!isObject(parsed) || parsed["__malformed"] === true)
            continue;
        if (parsed["type"] === "session" &&
            typeof parsed["version"] === "number" &&
            typeof parsed["id"] === "string" &&
            typeof parsed["timestamp"] === "string" &&
            typeof parsed["cwd"] === "string") {
            return {
                type: "session",
                version: parsed["version"],
                id: parsed["id"],
                timestamp: parsed["timestamp"],
                cwd: parsed["cwd"],
            };
        }
    }
    return null;
}
function createCorrelationEvidenceCapture() {
    return { byToolCallId: new Map(), overflow: false };
}
function recordCorrelationEvidence(capture, toolCallId, kind, token) {
    if (capture.overflow)
        return;
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    let accumulator = capture.byToolCallId.get(toolCallId);
    if (!accumulator) {
        if (capture.byToolCallId.size >= MAX_CORRELATION_TRACKED_IDS) {
            capture.overflow = true;
            return;
        }
        accumulator = {
            callCount: 0,
            resultCount: 0,
            latestCallDigest: null,
            latestResultDigest: null,
        };
        capture.byToolCallId.set(toolCallId, accumulator);
    }
    if (kind === "call") {
        if (accumulator.callCount >= MAX_CORRELATION_OCCURRENCES_PER_ID) {
            capture.overflow = true;
            return;
        }
        accumulator.callCount++;
        accumulator.latestCallDigest = tokenDigest;
    }
    else {
        if (accumulator.resultCount >= MAX_CORRELATION_OCCURRENCES_PER_ID) {
            capture.overflow = true;
            return;
        }
        accumulator.resultCount++;
        accumulator.latestResultDigest = tokenDigest;
    }
}
function correlationDetailsToken(value) {
    const details = correlationDetails(value);
    if (!details)
        return null;
    return JSON.stringify({
        runId: details.runId ?? null,
        results: details.results?.map((result) => ({
            agent: result.agent ?? null,
            sessionFile: result.sessionFile,
        })) ?? null,
    });
}
function captureCorrelationCallEvidence(capture, entry, message, allowedToolCallIds) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return;
    const timestamp = correlationTimestamp(entry, message);
    if (timestamp === undefined)
        return;
    for (const item of message.content.slice(0, MAX_PROJECTION_ITEMS)) {
        if (!isSubagentToolCall(item))
            continue;
        const toolCallId = projectionOpaqueId(item.toolCallId ?? item.id);
        if (!toolCallId || (allowedToolCallIds && !allowedToolCallIds.has(toolCallId)))
            continue;
        const toolName = projectionMetadata(selectedToolName(item));
        if (toolName !== "subagent")
            continue;
        recordCorrelationEvidence(capture, toolCallId, "call", JSON.stringify({
            timestamp,
            toolName,
            operation: parseProjectionCallArguments(item).operation,
        }));
    }
}
function captureCorrelationResultEvidence(capture, entry, message, allowedToolCallIds) {
    if (message.role !== "toolResult")
        return;
    const timestamp = correlationTimestamp(entry, message);
    const toolCallId = projectionOpaqueId(message.toolCallId);
    if (timestamp === undefined ||
        !toolCallId ||
        (allowedToolCallIds && !allowedToolCallIds.has(toolCallId)) ||
        !capture.byToolCallId.has(toolCallId))
        return;
    const toolName = projectionMetadata(message.toolName);
    if (toolName !== undefined && toolName !== "subagent")
        return;
    recordCorrelationEvidence(capture, toolCallId, "result", JSON.stringify({
        timestamp,
        toolName: toolName ?? null,
        details: correlationDetailsToken(message.details),
    }));
}
function captureCorrelationEntryEvidence(capture, entry, message, allowedToolCallIds) {
    captureCorrelationCallEvidence(capture, entry, message, allowedToolCallIds);
    captureCorrelationResultEvidence(capture, entry, message, allowedToolCallIds);
}
function buildCorrelationEvidenceToken(capture, pairedSubagentToolCallIds) {
    if (capture.overflow)
        return null;
    const hash = createHash("sha256");
    hash.update("tlh-correlation-evidence-v1\\n");
    let generation = 0;
    for (const toolCallId of [...pairedSubagentToolCallIds].sort()) {
        const evidence = capture.byToolCallId.get(toolCallId);
        if (!evidence) {
            hash.update(`${JSON.stringify({ toolCallId, missing: true })}\\n`);
            generation++;
            continue;
        }
        generation += evidence.callCount + evidence.resultCount;
        hash.update(`${JSON.stringify({
            toolCallId,
            callCount: evidence.callCount,
            resultCount: evidence.resultCount,
            latestCallDigest: evidence.latestCallDigest,
            latestResultDigest: evidence.latestResultDigest,
        })}\\n`);
    }
    return { digest: hash.digest("hex"), generation };
}
function correlationTimestamp(entry, message) {
    return projectionTimestamp(entry, message);
}
function correlationDetails(value) {
    if (!isObject(value))
        return undefined;
    const details = {};
    const runId = projectionLegacyId(value.runId);
    if (runId !== undefined)
        details.runId = runId;
    if (Array.isArray(value.results)) {
        const results = [];
        for (const child of value.results.slice(0, MAX_PROJECTION_ITEMS)) {
            if (!isObject(child) || typeof child.sessionFile !== "string" || !child.sessionFile)
                continue;
            const sessionFile = projectionString(child.sessionFile, MAX_PROJECTION_PATH_LENGTH);
            if (sessionFile === undefined)
                continue;
            const agent = projectionMetadata(child.agent);
            results.push({
                sessionFile,
                ...(agent !== undefined ? { agent } : {}),
            });
        }
        details.results = results;
    }
    return details;
}
async function readCorrelationEvidence(filePath, pairedSubagentToolCallIds) {
    const calls = new Map();
    const results = new Map();
    const evidenceCapture = createCorrelationEvidenceCapture();
    for await (const parsed of readJsonlLines(filePath)) {
        if (!isObject(parsed) || parsed.__malformed === true || parsed.type !== "message")
            continue;
        const message = parsed.message;
        if (!isObject(message))
            continue;
        captureCorrelationEntryEvidence(evidenceCapture, parsed, message, pairedSubagentToolCallIds);
        const timestamp = correlationTimestamp(parsed, message);
        if (timestamp === undefined)
            continue;
        if (message.role === "assistant" && Array.isArray(message.content)) {
            for (const item of message.content.slice(0, MAX_PROJECTION_ITEMS)) {
                if (!isObject(item) || item.type !== "toolCall")
                    continue;
                const toolCallId = projectionOpaqueId(item.toolCallId ?? item.id);
                if (!toolCallId || !pairedSubagentToolCallIds.has(toolCallId))
                    continue;
                const toolName = projectionMetadata(selectedToolName(item));
                if (toolName === undefined)
                    continue;
                calls.set(toolCallId, { toolName, timestamp });
            }
            continue;
        }
        if (message.role === "toolResult") {
            const toolCallId = projectionOpaqueId(message.toolCallId);
            const toolName = projectionMetadata(message.toolName);
            if (!toolCallId ||
                !pairedSubagentToolCallIds.has(toolCallId) ||
                (toolName !== undefined && toolName !== "subagent"))
                continue;
            results.set(toolCallId, {
                timestamp,
                details: correlationDetails(message.details),
            });
        }
    }
    const evidence = [];
    for (const [toolCallId, call] of calls) {
        if (call.toolName !== "subagent")
            continue;
        const result = results.get(toolCallId);
        if (!result)
            continue;
        const callMs = new Date(call.timestamp).getTime();
        const resultMs = new Date(result.timestamp).getTime();
        if (!Number.isFinite(callMs) || !Number.isFinite(resultMs) || resultMs < callMs)
            continue;
        if (result.details?.runId && result.details.results)
            evidence.push({ toolCallId, details: result.details });
    }
    const token = buildCorrelationEvidenceToken(evidenceCapture, pairedSubagentToolCallIds);
    return {
        evidence,
        digest: token?.digest ?? null,
        generation: token?.generation ?? 0,
        overflow: evidenceCapture.overflow,
    };
}
/** Extract correlations and report bounded evidence failures without raw values. */
export async function extractSubagentCorrelationsWithStatus(scanResult, sessionsDir) {
    const empty = { correlations: [], failureReasons: [] };
    if (!scanResult.sessionHeader)
        return empty;
    const parentSessionId = scanResult.sessionHeader.id;
    const pairedSubagentToolCallIds = new Set(scanResult.toolPairs
        .filter((pair) => pair.toolName === "subagent")
        .map((pair) => pair.toolCallId));
    if (pairedSubagentToolCallIds.size === 0)
        return empty;
    if (scanResult.correlationEvidenceCaptureOverflow ||
        scanResult.correlationEvidenceDigest === null)
        return empty;
    let rescan;
    try {
        rescan = await readCorrelationEvidence(scanResult.filePath, pairedSubagentToolCallIds);
    }
    catch {
        // The source may have disappeared or become unreadable after the scan.
        return empty;
    }
    if (rescan.overflow)
        return {
            correlations: [],
            failureReasons: ["rescanCaptureOverflow"],
        };
    const failureReasons = [];
    if (scanResult.correlationEvidenceDigest !== rescan.digest)
        failureReasons.push("digestMismatch");
    if (scanResult.correlationEvidenceGeneration !== rescan.generation)
        failureReasons.push("generationMismatch");
    if (failureReasons.length > 0)
        return { correlations: [], failureReasons };
    const correlations = [];
    for (const { toolCallId, details } of rescan.evidence) {
        for (const r of details.results ?? []) {
            // Resolve child paths only after canonicalizing them beneath sessionsDir.
            let underSessionsDir = false;
            if (sessionsDir !== undefined) {
                try {
                    const realChild = realpathSync(r.sessionFile);
                    const realSessions = realpathSync(sessionsDir);
                    underSessionsDir = realChild.startsWith(realSessions + "/");
                }
                catch {
                    underSessionsDir = false;
                }
            }
            let childResolved = false;
            let childSessionId;
            let childStartedAt;
            if (underSessionsDir) {
                try {
                    const header = await readSessionHeader(r.sessionFile);
                    if (header) {
                        childResolved = true;
                        childSessionId = header.id;
                        childStartedAt = header.timestamp;
                    }
                }
                catch {
                    // Keep unresolved on missing or unreadable child files.
                }
            }
            correlations.push({
                parentSessionFile: scanResult.filePath,
                parentSessionId,
                toolCallId,
                runId: details.runId,
                ...(r.agent !== undefined ? { agent: r.agent } : {}),
                childSessionFile: r.sessionFile,
                childResolved,
                ...(childSessionId !== undefined ? { childSessionId } : {}),
                ...(childStartedAt !== undefined ? { childStartedAt } : {}),
            });
        }
    }
    return { correlations, failureReasons };
}
export async function extractSubagentCorrelations(scanResult, sessionsDir) {
    return (await extractSubagentCorrelationsWithStatus(scanResult, sessionsDir)).correlations;
}
// ---------------------------------------------------------------------------
export { aggregateCoverage, recordCorrelationEvidenceFailures, } from "./session-analysis-coverage.mjs";
export { analyzeSubagentSessions, analyzeSubagents } from "./subagent-analysis.mjs";
