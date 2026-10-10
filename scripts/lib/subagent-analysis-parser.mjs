import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseProviderModelReference } from "../../extensions/the-last-harness/model-defaults.js";
import { ACCEPTANCE_STATUSES, OUTCOME_STATES, TERMINATION_REASONS, isStrictTelemetryEnvelope, } from "./subagent-analysis-validation.mjs";
import { tupleKey } from "./subagent-analysis-keys.mjs";
const require = createRequire(import.meta.url);
const { normalizeSubagentRunTelemetry, resolveParallelSubagentTelemetryOutcome: resolveRuntimeParallelSubagentTelemetryOutcome, } = require("../../extensions/subagents/src/shared/telemetry.js");
/** Keep report derivation on the same boundary-safe canonical runtime semantics. */
export function resolveParallelTelemetryOutcome(inputs) {
    return resolveRuntimeParallelSubagentTelemetryOutcome(inputs);
}
export const SUBAGENT_NOTIFY_TYPE = "subagent-notify";
export const SUBAGENT_CONTROL_TYPE = "subagent_control_notice";
export const SUBAGENT_COMPLETION_BATCH_SCHEMA_VERSION = 1;
export const SUBAGENT_COMPLETION_BATCH_KIND = "subagent_completion_batch";
/**
 * Bound one persisted notification chunk; the runtime logical-batch bound is
 * 512 entries, while each parser chunk carries at most 8 entries.
 */
export const MAX_COMPLETION_BATCH_ID_LENGTH = 200;
export const MAX_COMPLETION_BATCH_COUNT = 64;
export const MAX_COMPLETION_CHUNK_ENTRIES = 8;
export const MAX_COMPLETION_BATCH_STATES = 256;
export const BACKGROUND_COMPLETION_NUDGE = "[tlh] Background subagent completed — see notification above.";
export const CONTROL_NOTICE_NUDGE = "[tlh] Subagent run needs attention — see notice above.";
export const SUBAGENT_ACTIONS = new Set([
    "list",
    "get",
    "status",
    "interrupt",
    "resume",
    "steer",
    "doctor",
]);
export const TARGETING_ACTIONS = new Set(["status", "interrupt", "resume", "steer"]);
export function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
export function finiteNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
/** Legacy metadata excludes path separators; it is also used for legacy IDs. */
export function safeMetadataString(value, maxLength = 128) {
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
    if (trimmed.includes("/") || trimmed.includes("\\"))
        return undefined;
    return trimmed;
}
/** Structured IDs and model components are bounded opaque values. */
export function safeOpaqueString(value, maxLength = 512) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim();
    if (!normalized || [...normalized].length > maxLength)
        return undefined;
    if ([...normalized].some((char) => {
        const codePoint = char.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
    }))
        return undefined;
    return normalized;
}
export function safeRunId(value) {
    const normalized = safeMetadataString(value, 128);
    return normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized) ? normalized : undefined;
}
export function safeOpaqueRunId(value) {
    return safeOpaqueString(value, 512);
}
/** Project optional overall-flush metadata without retaining its raw identity. */
export function projectCompletionBatchFlushFields(value) {
    const hasFlushId = hasOwn(value, "flushId");
    const hasFlushIndex = hasOwn(value, "flushIndex");
    const hasFlushCount = hasOwn(value, "flushCount");
    if (!hasFlushId && !hasFlushIndex && !hasFlushCount)
        return { value: {}, invalid: false };
    if (hasFlushId !== hasFlushIndex || hasFlushIndex !== hasFlushCount)
        return { value: {}, invalid: true };
    const flushId = safeOpaqueString(value.flushId, MAX_COMPLETION_BATCH_ID_LENGTH);
    const flushIndex = safeStepIndex(value.flushIndex);
    const flushCount = safeStepIndex(value.flushCount);
    if (!flushId ||
        flushIndex === undefined ||
        flushCount === undefined ||
        flushIndex >= flushCount ||
        flushCount > MAX_COMPLETION_BATCH_STATES)
        return { value: {}, invalid: true };
    return {
        value: {
            flushId: createHash("sha256").update(flushId).digest("hex").slice(0, 32),
            flushIndex,
            flushCount,
        },
        invalid: false,
    };
}
/** Identify malformed grouped-carrier details before legacy fallback can hide them. */
export function isCompletionBatchCandidate(value) {
    if (!isObject(value))
        return false;
    return (value.kind === SUBAGENT_COMPLETION_BATCH_KIND ||
        ["schemaVersion", "batchId", "batchIndex", "batchCount", "triggersTurn", "completions"].some((field) => hasOwn(value, field)));
}
/** Parse only the bounded, telemetry-only v1 grouped completion carrier. */
export function parseCompletionBatchDetails(value) {
    if (!isObject(value) || value.__projectionInvalid === true)
        return undefined;
    if (value.schemaVersion !== SUBAGENT_COMPLETION_BATCH_SCHEMA_VERSION ||
        value.kind !== SUBAGENT_COMPLETION_BATCH_KIND)
        return undefined;
    const batchId = safeOpaqueString(value.batchId, MAX_COMPLETION_BATCH_ID_LENGTH);
    const batchIndex = safeStepIndex(value.batchIndex);
    const batchCount = safeStepIndex(value.batchCount);
    const hasFlushId = hasOwn(value, "flushId");
    const hasFlushIndex = hasOwn(value, "flushIndex");
    const hasFlushCount = hasOwn(value, "flushCount");
    const flushId = hasFlushId
        ? safeOpaqueString(value.flushId, MAX_COMPLETION_BATCH_ID_LENGTH)
        : batchId;
    const flushIndex = hasFlushIndex ? safeStepIndex(value.flushIndex) : 0;
    const flushCount = hasFlushCount ? safeStepIndex(value.flushCount) : 1;
    if (!batchId ||
        batchIndex === undefined ||
        batchCount === undefined ||
        batchCount < 1 ||
        batchCount > MAX_COMPLETION_BATCH_COUNT ||
        batchIndex >= batchCount ||
        hasFlushId !== hasFlushIndex ||
        hasFlushIndex !== hasFlushCount ||
        !flushId ||
        flushIndex === undefined ||
        flushCount === undefined ||
        flushIndex >= flushCount ||
        flushCount > MAX_COMPLETION_BATCH_STATES ||
        typeof value.triggersTurn !== "boolean" ||
        !Array.isArray(value.completions) ||
        value.completions.length === 0 ||
        value.completions.length > MAX_COMPLETION_CHUNK_ENTRIES)
        return undefined;
    let invalid = false;
    const completions = [];
    for (const rawEntry of value.completions) {
        if (!isObject(rawEntry)) {
            invalid = true;
            continue;
        }
        let entryInvalid = rawEntry.__projectionInvalid === true;
        const agent = safeMetadataString(rawEntry.agent, 160);
        if (!agent)
            entryInvalid = true;
        const status = rawEntry.status === "completed" ||
            rawEntry.status === "failed" ||
            rawEntry.status === "paused"
            ? rawEntry.status
            : undefined;
        if (status === undefined)
            entryInvalid = true;
        const durationMs = rawEntry.durationMs === undefined
            ? undefined
            : finiteNonNegativeNumber(rawEntry.durationMs)
                ? rawEntry.durationMs
                : undefined;
        if (rawEntry.durationMs !== undefined && durationMs === undefined)
            entryInvalid = true;
        const asyncId = rawEntry.asyncId === undefined
            ? undefined
            : safeOpaqueString(rawEntry.asyncId, MAX_COMPLETION_BATCH_ID_LENGTH);
        if (rawEntry.asyncId !== undefined && asyncId === undefined)
            entryInvalid = true;
        const telemetryPresent = hasOwn(rawEntry, "telemetry");
        if (telemetryPresent &&
            (!isObject(rawEntry.telemetry) || rawEntry.telemetry.__projectionInvalid))
            entryInvalid = true;
        // Keep an entry that has telemetry even when its display/legacy fields are
        // malformed. The structured envelope is independently useful evidence;
        // processCompletionBatchEntry will withhold malformed legacy fallbacks.
        if (!agent && !status && !telemetryPresent && !asyncId) {
            invalid = true;
            continue;
        }
        completions.push({
            ...(agent ? { agent } : {}),
            ...(status ? { status } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(asyncId !== undefined ? { asyncId } : {}),
            telemetryPresent,
            ...(telemetryPresent ? { telemetry: rawEntry.telemetry } : {}),
            invalid: entryInvalid,
        });
        if (entryInvalid)
            invalid = true;
    }
    return {
        batchId,
        batchIndex,
        batchCount,
        flushId,
        flushIndex,
        flushCount,
        triggersTurn: value.triggersTurn,
        completions,
        invalid,
    };
}
export function safeStepIndex(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function parseTelemetryModel(value) {
    if (!isObject(value))
        return undefined;
    const provider = safeOpaqueString(value.provider);
    const model = safeOpaqueString(value.model);
    if (!provider || !model)
        return undefined;
    const thinking = safeOpaqueString(value.thinking);
    return {
        provider,
        model,
        ...(thinking ? { thinking } : {}),
    };
}
export function parseTelemetryUsage(value) {
    if (!isObject(value))
        return undefined;
    if (!finiteNonNegativeNumber(value.inputTokens) ||
        !finiteNonNegativeNumber(value.outputTokens) ||
        !finiteNonNegativeNumber(value.cacheReadTokens) ||
        !finiteNonNegativeNumber(value.cacheWriteTokens) ||
        !finiteNonNegativeNumber(value.costUsd))
        return undefined;
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        cacheReadTokens: value.cacheReadTokens,
        cacheWriteTokens: value.cacheWriteTokens,
        costUsd: value.costUsd,
    };
}
export function parseLegacyUsage(value) {
    if (!isObject(value))
        return undefined;
    const hasTelemetryCounters = hasOwn(value, "inputTokens") ||
        hasOwn(value, "outputTokens") ||
        hasOwn(value, "cacheReadTokens") ||
        hasOwn(value, "cacheWriteTokens") ||
        hasOwn(value, "costUsd");
    if (hasTelemetryCounters)
        return parseTelemetryUsage(value);
    if (!finiteNonNegativeNumber(value.input) ||
        !finiteNonNegativeNumber(value.output) ||
        !finiteNonNegativeNumber(value.cacheRead) ||
        !finiteNonNegativeNumber(value.cacheWrite) ||
        !finiteNonNegativeNumber(value.cost))
        return undefined;
    return {
        inputTokens: value.input,
        outputTokens: value.output,
        cacheReadTokens: value.cacheRead,
        cacheWriteTokens: value.cacheWrite,
        costUsd: value.cost,
    };
}
export function parseTelemetryTiming(value) {
    if (!isObject(value))
        return undefined;
    const startedAt = value.startedAt === undefined ? undefined : value.startedAt;
    const endedAt = value.endedAt === undefined ? undefined : value.endedAt;
    const rawDurationMs = value.durationMs === undefined ? undefined : value.durationMs;
    const activeRuntimeMs = value.activeRuntimeMs === undefined ? undefined : value.activeRuntimeMs;
    if ((startedAt !== undefined && !finiteNonNegativeNumber(startedAt)) ||
        (endedAt !== undefined && !finiteNonNegativeNumber(endedAt)) ||
        (rawDurationMs !== undefined && !finiteNonNegativeNumber(rawDurationMs)) ||
        (activeRuntimeMs !== undefined && !finiteNonNegativeNumber(activeRuntimeMs)))
        return undefined;
    const durationMs = rawDurationMs ??
        (startedAt !== undefined && endedAt !== undefined
            ? Math.max(0, endedAt - startedAt)
            : undefined);
    if (startedAt === undefined &&
        endedAt === undefined &&
        durationMs === undefined &&
        activeRuntimeMs === undefined)
        return undefined;
    return {
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
    };
}
function allowedSetString(value, allowed) {
    return typeof value === "string" && allowed.has(value) ? value : undefined;
}
export function parseTelemetryOutcome(value) {
    if (!isObject(value) || typeof value.state !== "string" || !OUTCOME_STATES.has(value.state))
        return undefined;
    const terminationReason = value.terminationReason === undefined
        ? undefined
        : allowedSetString(value.terminationReason, TERMINATION_REASONS);
    const acceptanceStatus = value.acceptanceStatus === undefined
        ? undefined
        : allowedSetString(value.acceptanceStatus, ACCEPTANCE_STATUSES);
    return {
        state: value.state,
        ...(terminationReason ? { terminationReason } : {}),
        ...(acceptanceStatus ? { acceptanceStatus } : {}),
    };
}
export function parseLegacyOutcome(value) {
    const direct = parseTelemetryOutcome(value.outcome);
    if (direct)
        return direct;
    const stateValue = typeof value.state === "string" ? value.state : undefined;
    const statusValue = typeof value.status === "string" ? value.status : undefined;
    let state;
    if (statusValue === "complete" ||
        statusValue === "completed" ||
        stateValue === "complete" ||
        stateValue === "completed")
        state = "completed";
    else if (statusValue && OUTCOME_STATES.has(statusValue))
        state = statusValue;
    else if (stateValue && OUTCOME_STATES.has(stateValue))
        state = stateValue;
    else if (value.terminationReason === "cancelled")
        state = "cancelled";
    else if (value.timedOut === true || value.terminationReason === "timed_out")
        state = "failed";
    else if (value.interrupted === true || value.terminationReason === "interrupted")
        state = "paused";
    else if (value.success === true || value.exitCode === 0)
        state = "completed";
    else if (value.success === false || (typeof value.exitCode === "number" && value.exitCode !== 0))
        state = "failed";
    if (!state)
        return undefined;
    const terminationReason = allowedSetString(value.terminationReason, TERMINATION_REASONS);
    const acceptance = isObject(value.acceptance) ? value.acceptance.status : value.acceptanceStatus;
    const acceptanceStatus = allowedSetString(acceptance, ACCEPTANCE_STATUSES);
    return {
        state,
        ...(terminationReason ? { terminationReason } : {}),
        ...(acceptanceStatus ? { acceptanceStatus } : {}),
    };
}
/** Legacy prose/tool fields retain the runtime provider/model grammar. */
export function parseLegacyModel(value) {
    const identity = parseTelemetryModel(value.modelIdentity);
    if (identity)
        return identity;
    if (typeof value.model !== "string")
        return undefined;
    const rawModel = value.model.trim();
    const parsedReference = parseProviderModelReference(rawModel);
    if (parsedReference) {
        const provider = safeMetadataString(parsedReference.provider);
        const model = safeOpaqueString(parsedReference.id);
        if (provider && model)
            return { provider, model };
        // A syntactically qualified reference with unsafe components is not a
        // bare model name. Do not silently downgrade it to the unknown provider.
        return undefined;
    }
    const model = safeMetadataString(rawModel);
    if (!model)
        return undefined;
    const provider = safeMetadataString(value.provider);
    return { provider: provider ?? "unknown", model };
}
export function parseLegacyStepTiming(value) {
    const timing = parseTelemetryTiming(value.timing);
    if (timing) {
        return {
            ...(timing.durationMs !== undefined ? { durationMs: timing.durationMs } : {}),
            ...(timing.activeRuntimeMs !== undefined ? { activeRuntimeMs: timing.activeRuntimeMs } : {}),
        };
    }
    const direct = parseTelemetryTiming(value);
    if (direct) {
        return {
            ...(direct.durationMs !== undefined ? { durationMs: direct.durationMs } : {}),
            ...(direct.activeRuntimeMs !== undefined ? { activeRuntimeMs: direct.activeRuntimeMs } : {}),
        };
    }
    const progress = isObject(value.progress) ? parseTelemetryTiming(value.progress) : undefined;
    if (!progress)
        return undefined;
    return {
        ...(progress.durationMs !== undefined ? { durationMs: progress.durationMs } : {}),
        ...(progress.activeRuntimeMs !== undefined
            ? { activeRuntimeMs: progress.activeRuntimeMs }
            : {}),
    };
}
export function parseNormalizedTelemetry(value) {
    if (isObject(value) && value.__projectionInvalid === true)
        return undefined;
    if (!isStrictTelemetryEnvelope(value))
        return undefined;
    let normalized;
    try {
        normalized = normalizeSubagentRunTelemetry(value);
    }
    catch {
        return undefined;
    }
    if (!normalized)
        return undefined;
    const candidate = normalized;
    if (candidate.schemaVersion !== 1 ||
        !isObject(candidate.run) ||
        (candidate.run.execution !== "foreground" && candidate.run.execution !== "async") ||
        (candidate.run.mode !== "single" && candidate.run.mode !== "parallel") ||
        !Array.isArray(candidate.steps))
        return undefined;
    const runId = safeOpaqueRunId(candidate.run.id);
    if (!runId)
        return undefined;
    const steps = [];
    for (const rawStep of candidate.steps) {
        if (!isObject(rawStep))
            return undefined;
        const index = safeStepIndex(rawStep.index);
        const agent = safeMetadataString(rawStep.agent);
        if (index === undefined || !agent)
            return undefined;
        const model = rawStep.model === undefined ? undefined : parseTelemetryModel(rawStep.model);
        const usage = rawStep.usage === undefined ? undefined : parseTelemetryUsage(rawStep.usage);
        const timing = rawStep.timing === undefined ? undefined : parseTelemetryTiming(rawStep.timing);
        const outcome = rawStep.outcome === undefined ? undefined : parseTelemetryOutcome(rawStep.outcome);
        steps.push({
            index,
            agent,
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(timing ? { timing } : {}),
            ...(outcome ? { outcome } : {}),
        });
    }
    const usage = candidate.usage === undefined ? undefined : parseTelemetryUsage(candidate.usage);
    const timing = candidate.timing === undefined ? undefined : parseTelemetryTiming(candidate.timing);
    const outcome = candidate.outcome === undefined ? undefined : parseTelemetryOutcome(candidate.outcome);
    const lineage = parseTelemetryLineage(candidate.lineage, runId);
    return {
        schemaVersion: 1,
        run: { id: runId, execution: candidate.run.execution, mode: candidate.run.mode },
        steps,
        ...(usage ? { usage } : {}),
        ...(timing ? { timing } : {}),
        ...(outcome ? { outcome } : {}),
        ...(lineage ? { lineage } : {}),
        provenance: isObject(candidate.provenance) ? candidate.provenance : {},
        controls: isObject(candidate.controls) ? candidate.controls : {},
    };
}
export function parseTelemetryLineage(value, childRunId) {
    if (!isObject(value))
        return undefined;
    const continuationFrom = isObject(value.continuationFrom)
        ? (() => {
            const sourceRunId = safeOpaqueRunId(value.continuationFrom?.sourceRunId);
            if (!sourceRunId)
                return undefined;
            const sourceStepIndex = value.continuationFrom?.sourceStepIndex === undefined
                ? undefined
                : safeStepIndex(value.continuationFrom.sourceStepIndex);
            if (value.continuationFrom?.sourceStepIndex !== undefined && sourceStepIndex === undefined)
                return undefined;
            return {
                sourceRunId,
                ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
            };
        })()
        : undefined;
    const continuations = [];
    if (Array.isArray(value.continuations)) {
        for (const entry of value.continuations) {
            if (!isObject(entry))
                continue;
            const continuationRunId = safeOpaqueRunId(entry.continuationRunId);
            if (!continuationRunId)
                continue;
            const sourceStepIndex = entry.sourceStepIndex === undefined ? undefined : safeStepIndex(entry.sourceStepIndex);
            if (entry.sourceStepIndex !== undefined && sourceStepIndex === undefined)
                continue;
            if (continuations.some((candidate) => candidate.continuationRunId === continuationRunId &&
                candidate.sourceStepIndex === sourceStepIndex))
                continue;
            continuations.push({
                continuationRunId,
                ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
            });
        }
    }
    let nested;
    if (isObject(value.nested)) {
        const rootRunId = safeOpaqueRunId(value.nested.rootRunId);
        const parentRunId = safeOpaqueRunId(value.nested.parentRunId);
        if (rootRunId && parentRunId) {
            const parentStepIndex = value.nested.parentStepIndex === undefined
                ? undefined
                : safeStepIndex(value.nested.parentStepIndex);
            const depth = value.nested.depth === undefined ? undefined : safeStepIndex(value.nested.depth);
            nested = {
                rootRunId,
                parentRunId,
                childRunId,
                ...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
                ...(depth !== undefined ? { depth } : {}),
            };
        }
    }
    if (!continuationFrom && continuations.length === 0 && !nested)
        return undefined;
    return {
        ...(continuationFrom ? { continuationFrom } : {}),
        ...(continuations.length > 0 ? { continuations } : {}),
        ...(nested ? { nested } : {}),
    };
}
export function mergeTelemetryLineage(older, newer) {
    if (!older && !newer)
        return undefined;
    const continuationFrom = newer?.continuationFrom ?? older?.continuationFrom;
    const continuations = [...(older?.continuations ?? []), ...(newer?.continuations ?? [])].filter((entry, index, all) => all.findIndex((candidate) => candidate.continuationRunId === entry.continuationRunId &&
        candidate.sourceStepIndex === entry.sourceStepIndex) === index);
    const nested = newer?.nested ?? older?.nested;
    return {
        ...(continuationFrom ? { continuationFrom: { ...continuationFrom } } : {}),
        ...(continuations.length > 0
            ? { continuations: continuations.map((entry) => ({ ...entry })) }
            : {}),
        ...(nested ? { nested: { ...nested } } : {}),
    };
}
export function mergeTelemetryTiming(older, newer) {
    if (!older && !newer)
        return undefined;
    const merged = { ...older, ...newer };
    return parseTelemetryTiming(merged);
}
/** Merge repeated snapshots while keeping per-step identity as the dedupe key. */
export function mergeTelemetrySnapshots(older, newer) {
    const stepsByIndex = new Map();
    for (const step of older.steps)
        stepsByIndex.set(step.index, { ...step });
    for (const step of newer.steps) {
        const previous = stepsByIndex.get(step.index);
        const mergedStep = {
            ...previous,
            ...step,
            ...(previous?.model && !step.model ? { model: { ...previous.model } } : {}),
            ...(previous?.usage && !step.usage ? { usage: { ...previous.usage } } : {}),
            ...(previous?.timing && !step.timing ? { timing: { ...previous.timing } } : {}),
            ...(previous?.outcome && !step.outcome ? { outcome: { ...previous.outcome } } : {}),
        };
        if (step.usage && !step.model)
            delete mergedStep.model;
        stepsByIndex.set(step.index, mergedStep);
    }
    const steps = [...stepsByIndex.values()].sort((a, b) => a.index - b.index);
    const timing = mergeTelemetryTiming(older.timing, newer.timing);
    const outcome = newer.outcome ?? older.outcome;
    const lineage = mergeTelemetryLineage(older.lineage, newer.lineage);
    return {
        ...newer,
        run: { ...newer.run },
        steps,
        ...((newer.usage ?? older.usage) ? { usage: { ...(newer.usage ?? older.usage) } } : {}),
        ...(timing ? { timing } : {}),
        ...(outcome ? { outcome: { ...outcome } } : {}),
        ...(lineage ? { lineage } : {}),
        // Provenance and controls are load-time values. Keep the first valid copy.
        provenance: { ...older.provenance },
        controls: { ...older.controls },
    };
}
export function parseCallArguments(item) {
    const raw = hasOwn(item, "arguments") ? item.arguments : item.args;
    if (raw === undefined)
        return { malformed: false };
    if (isObject(raw))
        return { record: raw, malformed: false };
    if (typeof raw !== "string")
        return { malformed: true };
    try {
        const parsed = JSON.parse(raw);
        return isObject(parsed) ? { record: parsed, malformed: false } : { malformed: true };
    }
    catch {
        return { malformed: true };
    }
}
export function parsedCallOperation(item) {
    const empty = {
        hasAction: false,
        actionUnknown: false,
        actionMalformed: false,
        hasTarget: false,
        targetInvalid: false,
        hasAsync: false,
        asyncInvalid: false,
        agentPresent: false,
        tasksPresent: false,
        roles: [],
        malformedArguments: false,
        tasksTruncated: false,
    };
    if (isObject(item.operation)) {
        return {
            ...empty,
            action: typeof item.operation.action === "string" ? item.operation.action : undefined,
            hasAction: item.operation.hasAction === true,
            actionUnknown: item.operation.actionUnknown === true,
            actionMalformed: item.operation.actionMalformed === true,
            targetRunId: safeRunId(item.operation.targetRunId),
            hasTarget: item.operation.hasTarget === true,
            targetInvalid: item.operation.targetInvalid === true,
            async: typeof item.operation.async === "boolean" ? item.operation.async : undefined,
            hasAsync: item.operation.hasAsync === true,
            asyncInvalid: item.operation.asyncInvalid === true,
            agentPresent: item.operation.agentPresent === true,
            tasksPresent: item.operation.tasksPresent === true,
            roles: Array.isArray(item.operation.roles)
                ? item.operation.roles.filter((role) => safeMetadataString(role) !== undefined)
                : [],
            malformedArguments: item.operation.malformedArguments === true,
            tasksTruncated: item.operation.tasksTruncated === true,
        };
    }
    const parsed = parseCallArguments(item);
    if (parsed.malformed || !parsed.record) {
        return { ...empty, malformedArguments: parsed.malformed };
    }
    const args = parsed.record;
    const hasAction = hasOwn(args, "action");
    const action = typeof args.action === "string" ? args.action : undefined;
    const hasTarget = hasOwn(args, "id");
    const targetRunId = hasTarget ? safeRunId(args.id) : undefined;
    const roles = [];
    const agent = safeMetadataString(args.agent);
    if (agent)
        roles.push(agent);
    const tasksPresent = hasOwn(args, "tasks");
    let tasksTruncated = false;
    if (Array.isArray(args.tasks)) {
        if (args.tasks.length > 64)
            tasksTruncated = true;
        for (const task of args.tasks.slice(0, 64)) {
            if (!isObject(task))
                continue;
            const taskAgent = safeMetadataString(task.agent);
            if (taskAgent)
                roles.push(taskAgent);
        }
    }
    const hasAsync = hasOwn(args, "async");
    return {
        ...empty,
        ...(action !== undefined ? { action } : {}),
        hasAction,
        actionUnknown: hasAction && (action === undefined || !SUBAGENT_ACTIONS.has(action)),
        actionMalformed: hasAction && action === undefined,
        ...(targetRunId ? { targetRunId } : {}),
        hasTarget,
        targetInvalid: hasTarget && targetRunId === undefined,
        ...(typeof args.async === "boolean" ? { async: args.async } : {}),
        hasAsync,
        asyncInvalid: hasAsync && typeof args.async !== "boolean",
        agentPresent: hasOwn(args, "agent"),
        tasksPresent,
        roles: [...new Set(roles)],
        malformedArguments: false,
        tasksTruncated,
    };
}
export function messageText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return undefined;
    const parts = [];
    for (const item of value) {
        if (!isObject(item) || item.type !== "text" || typeof item.text !== "string")
            return undefined;
        parts.push(item.text);
    }
    return parts.join("");
}
export function isLegacyCompletionText(value) {
    const text = messageText(value);
    return (text !== undefined &&
        /^Background tasks? (?:completed|failed|paused)(?:\s*\([^)]*\))?:/.test(text));
}
export function isLegacyControlText(value) {
    const text = messageText(value);
    return text !== undefined && /^Subagent(?: run)? needs attention\b/.test(text);
}
export function syntheticNudgeKind(role, text) {
    if (role !== "user")
        return undefined;
    if (text === BACKGROUND_COMPLETION_NUDGE)
        return "completion";
    if (text === CONTROL_NOTICE_NUDGE)
        return "control";
    return undefined;
}
export function parseDirectSubagentControlEvent(value, source) {
    if (!isObject(value))
        return undefined;
    const runId = safeOpaqueRunId(value.runId);
    const currentTransition = value.type === "needs_attention" && value.to === "needs_attention";
    const retiredTransition = value.type === "active_long_running" &&
        value.to === "active_long_running" &&
        value.reason === "time_threshold";
    if (!runId || (!currentTransition && !retiredTransition))
        return undefined;
    if (!finiteNonNegativeNumber(value.ts) ||
        !safeMetadataString(value.agent) ||
        !((typeof value.message === "string" && value.message.trim() !== "") ||
            value.messagePresent === true))
        return undefined;
    if (value.index !== undefined && safeStepIndex(value.index) === undefined)
        return undefined;
    return { runId, source, event: value };
}
export function parseSubagentControlEvent(details) {
    const source = details.source === "foreground" || details.source === "async"
        ? details.source
        : details.asyncId !== undefined ||
            details.asyncDir !== undefined ||
            details.asyncReference === true
            ? "async"
            : "unknown";
    return parseDirectSubagentControlEvent(details.event, source);
}
export function controlSourceKey(event, runId) {
    return tupleKey("control", runId, finiteNonNegativeNumber(event.ts) ? event.ts : undefined, event.index === undefined ? undefined : safeStepIndex(event.index), safeMetadataString(event.reason), safeMetadataString(event.contextPressureSeverity), safeMetadataString(event.contextPressureThreshold), safeMetadataString(event.idleEpisodeId));
}
export function telemetryExecutionFromRaw(value) {
    if (!isObject(value) || !isObject(value.run))
        return "unknown";
    return value.run.execution === "foreground" || value.run.execution === "async"
        ? value.run.execution
        : "unknown";
}
