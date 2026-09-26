export const SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION = 1;
const TERMINATION_REASONS = new Set([
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
const TELEMETRY_STATES = new Set([
    "queued",
    "running",
    "completed",
    "failed",
    "paused",
    "cancelled",
    "continued",
]);
const ACCEPTANCE_STATUSES = new Set([
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
const NOTIFY_ON = new Set(["needs_attention"]);
const NOTIFY_CHANNELS = new Set(["event", "async"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function finiteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function safeIndex(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function normalizeModelIdentity(value) {
    if (!isRecord(value) || !nonEmptyString(value.provider) || !nonEmptyString(value.model)) {
        return undefined;
    }
    return {
        provider: value.provider.trim(),
        model: value.model.trim(),
        ...(nonEmptyString(value.thinking) ? { thinking: value.thinking.trim() } : {}),
    };
}
function normalizeUsage(value) {
    if (!isRecord(value))
        return undefined;
    const inputTokens = value.inputTokens;
    const outputTokens = value.outputTokens;
    const cacheReadTokens = value.cacheReadTokens;
    const cacheWriteTokens = value.cacheWriteTokens;
    const costUsd = value.costUsd;
    if (!finiteNonNegative(inputTokens) ||
        !finiteNonNegative(outputTokens) ||
        !finiteNonNegative(cacheReadTokens) ||
        !finiteNonNegative(cacheWriteTokens) ||
        !finiteNonNegative(costUsd))
        return undefined;
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
    };
}
function usageFromSource(value) {
    if (!value)
        return undefined;
    if ("inputTokens" in value)
        return normalizeUsage(value);
    if (!finiteNonNegative(value.input) ||
        !finiteNonNegative(value.output) ||
        !finiteNonNegative(value.cacheRead) ||
        !finiteNonNegative(value.cacheWrite) ||
        !finiteNonNegative(value.cost)) {
        return undefined;
    }
    return {
        inputTokens: value.input,
        outputTokens: value.output,
        cacheReadTokens: value.cacheRead,
        cacheWriteTokens: value.cacheWrite,
        costUsd: value.cost,
    };
}
function normalizeActivity(value) {
    if (!isRecord(value))
        return undefined;
    const turns = value.turns === undefined ? undefined : finiteNonNegative(value.turns) ? value.turns : null;
    const toolCalls = value.toolCalls === undefined
        ? undefined
        : finiteNonNegative(value.toolCalls)
            ? value.toolCalls
            : null;
    if (turns === null || toolCalls === null || (turns === undefined && toolCalls === undefined))
        return undefined;
    return {
        ...(turns !== undefined ? { turns } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
    };
}
function normalizeTiming(value) {
    if (!isRecord(value))
        return undefined;
    const startedAt = value.startedAt;
    const endedAt = value.endedAt;
    const durationMs = value.durationMs;
    const activeRuntimeMs = value.activeRuntimeMs;
    if ((startedAt !== undefined && !finiteNonNegative(startedAt)) ||
        (endedAt !== undefined && !finiteNonNegative(endedAt)) ||
        (durationMs !== undefined && !finiteNonNegative(durationMs)) ||
        (activeRuntimeMs !== undefined && !finiteNonNegative(activeRuntimeMs))) {
        return undefined;
    }
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
function normalizeOutcome(value) {
    if (!isRecord(value) || !TELEMETRY_STATES.has(value.state)) {
        return undefined;
    }
    const terminationReason = value.terminationReason;
    const acceptanceStatus = value.acceptanceStatus;
    if (terminationReason !== undefined &&
        !TERMINATION_REASONS.has(terminationReason))
        return undefined;
    if (acceptanceStatus !== undefined &&
        !ACCEPTANCE_STATUSES.has(acceptanceStatus))
        return undefined;
    return {
        state: value.state,
        ...(terminationReason !== undefined
            ? { terminationReason: terminationReason }
            : {}),
        ...(acceptanceStatus !== undefined
            ? { acceptanceStatus: acceptanceStatus }
            : {}),
    };
}
function normalizeLineage(value) {
    if (!isRecord(value))
        return undefined;
    let continuationFrom;
    if (isRecord(value.continuationFrom) &&
        nonEmptyString(value.continuationFrom.sourceRunId) &&
        (value.continuationFrom.sourceStepIndex === undefined ||
            safeIndex(value.continuationFrom.sourceStepIndex))) {
        continuationFrom = {
            sourceRunId: value.continuationFrom.sourceRunId.trim(),
            ...(value.continuationFrom.sourceStepIndex !== undefined
                ? { sourceStepIndex: value.continuationFrom.sourceStepIndex }
                : {}),
        };
    }
    let continuations;
    if (Array.isArray(value.continuations)) {
        const validContinuations = [];
        for (const entry of value.continuations) {
            if (!isRecord(entry))
                continue;
            const continuationRunId = entry.continuationRunId;
            const sourceStepIndex = entry.sourceStepIndex;
            if (!nonEmptyString(continuationRunId))
                continue;
            if (sourceStepIndex !== undefined && !safeIndex(sourceStepIndex))
                continue;
            validContinuations.push({
                continuationRunId: continuationRunId.trim(),
                ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
            });
        }
        if (validContinuations.length > 0)
            continuations = validContinuations;
    }
    let nested;
    if (isRecord(value.nested) &&
        nonEmptyString(value.nested.rootRunId) &&
        nonEmptyString(value.nested.parentRunId) &&
        (value.nested.parentStepIndex === undefined || safeIndex(value.nested.parentStepIndex)) &&
        (value.nested.depth === undefined || safeIndex(value.nested.depth))) {
        nested = {
            rootRunId: value.nested.rootRunId.trim(),
            parentRunId: value.nested.parentRunId.trim(),
            ...(value.nested.parentStepIndex !== undefined
                ? { parentStepIndex: value.nested.parentStepIndex }
                : {}),
            ...(value.nested.depth !== undefined ? { depth: value.nested.depth } : {}),
        };
    }
    if (!continuationFrom && !continuations && !nested)
        return undefined;
    return {
        ...(continuationFrom ? { continuationFrom } : {}),
        ...(continuations ? { continuations } : {}),
        ...(nested ? { nested } : {}),
    };
}
function normalizeProvenance(value) {
    if (!isRecord(value) || !nonEmptyString(value.tlhVersion) || !nonEmptyString(value.piVersion)) {
        return undefined;
    }
    if (!finiteNonNegative(value.loadedAt))
        return undefined;
    return {
        tlhVersion: value.tlhVersion.trim(),
        piVersion: value.piVersion.trim(),
        ...(nonEmptyString(value.installGeneration)
            ? { installGeneration: value.installGeneration.trim() }
            : {}),
        loadedAt: value.loadedAt,
    };
}
function normalizeControls(value) {
    if (!isRecord(value))
        return undefined;
    if (!finiteNonNegative(value.needsAttentionAfterMs) ||
        !finiteNonNegative(value.failedToolAttemptsBeforeAttention) ||
        !Array.isArray(value.notifyOn) ||
        !Array.isArray(value.notifyChannels))
        return undefined;
    const notifyOn = value.notifyOn.filter((entry) => NOTIFY_ON.has(entry));
    const notifyChannels = value.notifyChannels.filter((entry) => NOTIFY_CHANNELS.has(entry));
    if (notifyOn.length !== value.notifyOn.length ||
        notifyChannels.length !== value.notifyChannels.length)
        return undefined;
    return {
        needsAttentionAfterMs: value.needsAttentionAfterMs,
        failedToolAttemptsBeforeAttention: value.failedToolAttemptsBeforeAttention,
        notifyOn,
        notifyChannels,
    };
}
export function normalizeSubagentRunTelemetry(value) {
    if (!isRecord(value) || value.schemaVersion !== SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION)
        return undefined;
    if (!isRecord(value.run) || !nonEmptyString(value.run.id))
        return undefined;
    if (value.run.execution !== "foreground" && value.run.execution !== "async")
        return undefined;
    if (value.run.mode !== "single" && value.run.mode !== "parallel")
        return undefined;
    if (!Array.isArray(value.steps))
        return undefined;
    const steps = [];
    for (const entry of value.steps) {
        if (!isRecord(entry) || !safeIndex(entry.index) || !nonEmptyString(entry.agent))
            return undefined;
        const usage = entry.usage === undefined ? undefined : normalizeUsage(entry.usage);
        const activity = entry.activity === undefined ? undefined : normalizeActivity(entry.activity);
        const timing = entry.timing === undefined ? undefined : normalizeTiming(entry.timing);
        const outcome = entry.outcome === undefined ? undefined : normalizeOutcome(entry.outcome);
        const model = entry.model === undefined ? undefined : normalizeModelIdentity(entry.model);
        steps.push({
            index: entry.index,
            agent: entry.agent.trim(),
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(activity ? { activity } : {}),
            ...(timing ? { timing } : {}),
            ...(outcome ? { outcome } : {}),
        });
    }
    const provenance = normalizeProvenance(value.provenance);
    const controls = normalizeControls(value.controls);
    if (!provenance || !controls)
        return undefined;
    const usage = value.usage === undefined ? undefined : normalizeUsage(value.usage);
    const timing = value.timing === undefined ? undefined : normalizeTiming(value.timing);
    const outcome = value.outcome === undefined ? undefined : normalizeOutcome(value.outcome);
    const lineage = value.lineage === undefined ? undefined : normalizeLineage(value.lineage);
    return {
        schemaVersion: SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION,
        run: { id: value.run.id.trim(), execution: value.run.execution, mode: value.run.mode },
        steps,
        ...(usage ? { usage } : {}),
        ...(timing ? { timing } : {}),
        ...(outcome ? { outcome } : {}),
        ...(lineage ? { lineage } : {}),
        provenance,
        controls,
    };
}
export function appendSubagentTelemetryContinuation(telemetry, input) {
    if (!telemetry || !nonEmptyString(input.continuationRunId))
        return telemetry;
    if (input.sourceStepIndex !== undefined && !safeIndex(input.sourceStepIndex))
        return telemetry;
    const existing = telemetry.lineage?.continuations ?? [];
    const continuation = {
        continuationRunId: input.continuationRunId.trim(),
        ...(input.sourceStepIndex !== undefined ? { sourceStepIndex: input.sourceStepIndex } : {}),
    };
    const alreadyRecorded = existing.some((entry) => entry.continuationRunId === continuation.continuationRunId &&
        entry.sourceStepIndex === continuation.sourceStepIndex);
    const continuations = alreadyRecorded ? existing : [...existing, continuation];
    return {
        ...telemetry,
        ...(telemetry.lineage || continuations.length > 0
            ? {
                lineage: {
                    ...telemetry.lineage,
                    continuations,
                },
            }
            : {}),
    };
}
export function continuationTelemetryMetadata(source, sourceRunId, sourceStepIndex) {
    if (!source || !nonEmptyString(sourceRunId))
        return {};
    if (sourceStepIndex !== undefined && !safeIndex(sourceStepIndex))
        return {};
    return {
        provenance: source.provenance,
        lineage: {
            ...(source.lineage?.nested ? { nested: { ...source.lineage.nested } } : {}),
            continuationFrom: {
                sourceRunId: sourceRunId.trim(),
                ...(sourceStepIndex !== undefined ? { sourceStepIndex } : {}),
            },
        },
    };
}
function mergeTelemetryTiming(current, persisted, persistedWins) {
    if (!current && !persisted)
        return undefined;
    const merged = persistedWins ? { ...current, ...persisted } : { ...persisted, ...current };
    return normalizeTiming(merged);
}
function mergeTelemetryLineage(current, persisted) {
    if (!current && !persisted)
        return undefined;
    const continuations = [...(persisted?.continuations ?? []), ...(current?.continuations ?? [])];
    const uniqueContinuations = continuations.filter((entry, index) => continuations.findIndex((candidate) => candidate.continuationRunId === entry.continuationRunId &&
        candidate.sourceStepIndex === entry.sourceStepIndex) === index);
    return {
        ...(current?.continuationFrom
            ? { continuationFrom: { ...current.continuationFrom } }
            : persisted?.continuationFrom
                ? { continuationFrom: { ...persisted.continuationFrom } }
                : {}),
        ...(uniqueContinuations.length > 0 ? { continuations: uniqueContinuations } : {}),
        ...(current?.nested
            ? { nested: { ...current.nested } }
            : persisted?.nested
                ? { nested: { ...persisted.nested } }
                : {}),
    };
}
export function mergeSubagentRunTelemetry(currentValue, persistedValue, options = {}) {
    const current = normalizeSubagentRunTelemetry(currentValue);
    const persisted = normalizeSubagentRunTelemetry(persistedValue);
    if (!current)
        return persisted;
    if (!persisted)
        return current;
    const persistedOutcomeWins = options.persistedOutcomeWins === true;
    const persistedSteps = new Map(persisted.steps.map((step) => [step.index, step]));
    const currentSteps = new Map(current.steps.map((step) => [step.index, step]));
    const indexes = [...new Set([...persistedSteps.keys(), ...currentSteps.keys()])].sort((a, b) => a - b);
    const steps = indexes.map((index) => {
        const currentStep = currentSteps.get(index);
        const persistedStep = persistedSteps.get(index);
        if (!currentStep)
            return { ...persistedStep };
        if (!persistedStep)
            return { ...currentStep };
        const timing = mergeTelemetryTiming(currentStep.timing, persistedStep.timing, persistedOutcomeWins);
        return {
            ...persistedStep,
            ...currentStep,
            ...(persistedOutcomeWins && persistedStep.outcome
                ? { outcome: { ...persistedStep.outcome } }
                : {}),
            ...(persistedStep.model && !currentStep.model ? { model: { ...persistedStep.model } } : {}),
            ...(persistedStep.usage && !currentStep.usage ? { usage: { ...persistedStep.usage } } : {}),
            ...(persistedStep.activity && !currentStep.activity
                ? { activity: { ...persistedStep.activity } }
                : {}),
            ...(timing ? { timing } : {}),
        };
    });
    const usage = current.usage ?? persisted.usage;
    const timing = mergeTelemetryTiming(current.timing, persisted.timing, persistedOutcomeWins);
    const outcome = persistedOutcomeWins && persisted.outcome
        ? persisted.outcome
        : (current.outcome ?? persisted.outcome);
    const lineage = mergeTelemetryLineage(current.lineage, persisted.lineage);
    return {
        ...current,
        steps,
        ...(usage ? { usage: { ...usage } } : {}),
        ...(timing ? { timing: { ...timing } } : {}),
        ...(outcome ? { outcome: { ...outcome } } : {}),
        ...(lineage ? { lineage } : {}),
        provenance: { ...persisted.provenance },
        controls: {
            ...persisted.controls,
            notifyOn: [...persisted.controls.notifyOn],
            notifyChannels: [...persisted.controls.notifyChannels],
        },
    };
}
function controlsFromResolved(value) {
    return {
        needsAttentionAfterMs: value.needsAttentionAfterMs,
        failedToolAttemptsBeforeAttention: value.failedToolAttemptsBeforeAttention,
        notifyOn: [...value.notifyOn].filter((entry) => entry === "needs_attention"),
        notifyChannels: [...value.notifyChannels].filter((entry) => entry === "event" || entry === "async"),
    };
}
function addUsage(target, source) {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.cacheWriteTokens += source.cacheWriteTokens;
    target.costUsd += source.costUsd;
}
function aggregateUsage(steps) {
    const sources = steps
        .map((step) => step.usage)
        .filter((usage) => Boolean(usage));
    if (sources.length === 0)
        return undefined;
    const total = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    };
    for (const source of sources)
        addUsage(total, source);
    return total;
}
function timingFromInput(input) {
    const durationMs = input.durationMs ??
        (input.startedAt !== undefined && input.endedAt !== undefined
            ? Math.max(0, input.endedAt - input.startedAt)
            : undefined);
    const timing = {
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(input.activeRuntimeMs !== undefined ? { activeRuntimeMs: input.activeRuntimeMs } : {}),
    };
    return Object.keys(timing).length > 0 ? timing : undefined;
}
export function buildSubagentRunTelemetry(input) {
    const steps = input.steps.map((step) => {
        const usage = usageFromSource(step.usage);
        const model = normalizeModelIdentity(step.model);
        const activity = step.activity ? normalizeActivity(step.activity) : undefined;
        const timing = step.timing ? timingFromInput(step.timing) : undefined;
        return {
            index: step.index,
            agent: step.agent,
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(activity ? { activity } : {}),
            ...(timing ? { timing } : {}),
            ...(step.outcome ? { outcome: { ...step.outcome } } : {}),
        };
    });
    const usage = aggregateUsage(steps);
    const timing = timingFromInput(input);
    const outcome = input.outcome ? { ...input.outcome } : undefined;
    const lineage = input.lineage ? normalizeLineage(input.lineage) : undefined;
    return {
        schemaVersion: SUBAGENT_RUN_TELEMETRY_SCHEMA_VERSION,
        run: { id: input.runId, execution: input.execution, mode: input.mode },
        steps,
        ...(usage ? { usage } : {}),
        ...(timing ? { timing } : {}),
        ...(outcome ? { outcome } : {}),
        ...(lineage ? { lineage } : {}),
        provenance: {
            tlhVersion: input.provenance.tlhVersion,
            piVersion: input.provenance.piVersion,
            ...(input.provenance.installGeneration
                ? { installGeneration: input.provenance.installGeneration }
                : {}),
            loadedAt: input.provenance.loadedAt,
        },
        controls: controlsFromResolved(input.controls),
    };
}
function stateFromValue(value) {
    if (value === "complete" || value === "completed")
        return "completed";
    if (value === "pausing")
        return "paused";
    if (value === "queued" ||
        value === "running" ||
        value === "failed" ||
        value === "paused" ||
        value === "cancelled" ||
        value === "continued")
        return value;
    return undefined;
}
export function resolveSubagentTelemetryOutcome(input) {
    const explicitState = stateFromValue(input.state);
    const state = explicitState && !["queued", "running"].includes(explicitState)
        ? explicitState
        : input.terminationReason === "cancelled"
            ? "cancelled"
            : input.interrupted ||
                input.terminationReason === "interrupted" ||
                input.terminationReason === "paused"
                ? "paused"
                : input.timedOut || input.terminationReason === "timed_out"
                    ? "failed"
                    : (explicitState ??
                        (input.success === true
                            ? "completed"
                            : input.success === false
                                ? "failed"
                                : undefined));
    if (!state)
        return undefined;
    return {
        state,
        ...(input.terminationReason ? { terminationReason: input.terminationReason } : {}),
        ...(input.acceptanceStatus ? { acceptanceStatus: input.acceptanceStatus } : {}),
    };
}
const PARALLEL_OUTCOME_STATE_PRECEDENCE = [
    "cancelled",
    "paused",
    "failed",
    "continued",
    "completed",
    "running",
    "queued",
];
const PARALLEL_OUTCOME_REASON_PRECEDENCE = [
    "cancelled",
    "paused",
    "interrupted",
    "timed_out",
    "output_limit",
    "context_exhausted",
    "model_error",
    "tool_budget_blocked",
    "process_exit",
    "unknown",
    "completed",
];
function parallelOutcomeReasonRank(reason) {
    if (!reason)
        return PARALLEL_OUTCOME_REASON_PRECEDENCE.length;
    return PARALLEL_OUTCOME_REASON_PRECEDENCE.indexOf(reason);
}
function compareParallelOutcomeCandidates(left, right) {
    const reasonRank = parallelOutcomeReasonRank(left.outcome.terminationReason) -
        parallelOutcomeReasonRank(right.outcome.terminationReason);
    if (reasonRank !== 0)
        return reasonRank;
    if (left.index !== undefined && right.index !== undefined && left.index !== right.index)
        return left.index - right.index;
    if (left.index !== undefined && right.index === undefined)
        return -1;
    if (left.index === undefined && right.index !== undefined)
        return 1;
    if (left.agent < right.agent)
        return -1;
    if (left.agent > right.agent)
        return 1;
    return left.inputOrder - right.inputOrder;
}
export function resolveParallelSubagentTelemetryOutcome(inputs) {
    const candidates = inputs.flatMap((input, inputOrder) => {
        const outcome = resolveSubagentTelemetryOutcome(input);
        return outcome ? [{ outcome, index: input.index, agent: input.agent ?? "", inputOrder }] : [];
    });
    if (candidates.length === 0)
        return undefined;
    const aggregateState = PARALLEL_OUTCOME_STATE_PRECEDENCE.find((state) => candidates.some((candidate) => candidate.outcome.state === state));
    if (!aggregateState)
        return undefined;
    const selected = candidates
        .filter((candidate) => candidate.outcome.state === aggregateState)
        .sort(compareParallelOutcomeCandidates)[0];
    if (!selected)
        return undefined;
    return {
        state: selected.outcome.state,
        ...(selected.outcome.terminationReason
            ? { terminationReason: selected.outcome.terminationReason }
            : {}),
    };
}
export function finalizeSubagentRunTelemetry(telemetry, outcome, endedAt) {
    if (!telemetry)
        return undefined;
    const terminalStates = new Set([
        "completed",
        "failed",
        "paused",
        "cancelled",
        "continued",
    ]);
    const steps = telemetry.steps.map((step) => {
        const currentState = step.outcome?.state;
        if (currentState && terminalStates.has(currentState))
            return { ...step };
        return { ...step, outcome: { ...outcome } };
    });
    const priorTiming = telemetry.timing;
    const startedAt = priorTiming?.startedAt;
    const timing = priorTiming && endedAt !== undefined
        ? {
            ...priorTiming,
            ...(priorTiming.endedAt === undefined ? { endedAt } : {}),
            ...(priorTiming.durationMs === undefined && startedAt !== undefined
                ? { durationMs: Math.max(0, endedAt - startedAt) }
                : {}),
        }
        : priorTiming
            ? { ...priorTiming }
            : undefined;
    return {
        ...telemetry,
        steps,
        ...(timing ? { timing } : {}),
        outcome: { ...outcome },
    };
}
export function transitionSubagentRunTelemetryLifecycle(input) {
    const telemetry = normalizeSubagentRunTelemetry(input.telemetry);
    if (!telemetry)
        return undefined;
    const runState = stateFromValue(input.runState);
    if (!runState)
        return telemetry;
    const timingForTransition = (timing) => {
        if (!timing)
            return undefined;
        const endedAt = timing.endedAt ?? input.endedAt;
        return {
            ...timing,
            ...(timing.endedAt === undefined && input.endedAt !== undefined
                ? { endedAt: input.endedAt }
                : {}),
            ...(timing.durationMs === undefined && timing.startedAt !== undefined && endedAt !== undefined
                ? { durationMs: Math.max(0, endedAt - timing.startedAt) }
                : {}),
        };
    };
    const outcome = {
        ...telemetry.outcome,
        state: runState,
        ...(runState === "cancelled" ? { terminationReason: "cancelled" } : {}),
    };
    const steps = telemetry.steps.map((step) => {
        if (step.index !== input.stepIndex)
            return { ...step };
        const stepOutcome = {
            ...step.outcome,
            state: input.stepState,
            ...(input.stepState === "cancelled" ? { terminationReason: "cancelled" } : {}),
        };
        const timing = timingForTransition(step.timing);
        return { ...step, ...(timing ? { timing } : {}), outcome: stepOutcome };
    });
    const timing = timingForTransition(telemetry.timing);
    return {
        ...telemetry,
        steps,
        ...(timing ? { timing } : {}),
        outcome,
    };
}
export function telemetryFromSingleResults(input) {
    const runOutcome = input.outcome ??
        (input.mode === "parallel"
            ? resolveParallelSubagentTelemetryOutcome(input.results.map((result, index) => ({
                index: input.stepIndexes?.[index] ?? index,
                agent: result.agent,
                state: result.cancel ? "cancelled" : result.pause ? "paused" : undefined,
                success: result.exitCode === 0 && !result.interrupted,
                interrupted: result.interrupted,
                timedOut: result.timedOut,
                terminationReason: result.terminationReason,
            })))
            : undefined);
    return buildSubagentRunTelemetry({
        ...input,
        execution: "foreground",
        outcome: runOutcome,
        steps: input.results.map((result, index) => {
            const activityValues = {
                ...(result.usage ? { turns: result.usage.turns } : {}),
                ...(result.progressSummary?.toolCount !== undefined
                    ? { toolCalls: result.progressSummary.toolCount }
                    : {}),
            };
            const timingValues = {
                ...(result.progressSummary?.durationMs !== undefined
                    ? { durationMs: result.progressSummary.durationMs }
                    : {}),
                ...(result.activeRuntimeMs !== undefined
                    ? { activeRuntimeMs: result.activeRuntimeMs }
                    : {}),
            };
            return {
                index: input.stepIndexes?.[index] ?? index,
                agent: result.agent,
                model: result.modelIdentity,
                usage: result.usage,
                ...(Object.keys(activityValues).length > 0 ? { activity: activityValues } : {}),
                ...(Object.keys(timingValues).length > 0 ? { timing: timingValues } : {}),
                outcome: resolveSubagentTelemetryOutcome({
                    success: result.exitCode === 0 && !result.interrupted,
                    interrupted: result.interrupted,
                    timedOut: result.timedOut,
                    terminationReason: result.terminationReason,
                    acceptanceStatus: result.acceptance?.status,
                }),
            };
        }),
    });
}
function usageFromAttempts(attempts) {
    if (!attempts || attempts.length === 0)
        return undefined;
    let usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
    };
    let found = false;
    for (const attempt of attempts) {
        if (!attempt.usage)
            continue;
        found = true;
        usage = {
            input: usage.input + attempt.usage.input,
            output: usage.output + attempt.usage.output,
            cacheRead: usage.cacheRead + attempt.usage.cacheRead,
            cacheWrite: usage.cacheWrite + attempt.usage.cacheWrite,
            cost: usage.cost + attempt.usage.cost,
            turns: usage.turns + attempt.usage.turns,
        };
    }
    return found ? usage : undefined;
}
export function telemetryFromRunnerResults(input) {
    if (!input.provenance)
        return undefined;
    const steps = input.results.map((result, resultIndex) => {
        const index = result.index ?? resultIndex;
        const status = input.statusSteps?.[index];
        const usage = usageFromAttempts(result.modelAttempts);
        const telemetryUsage = usageFromSource(usage);
        const model = normalizeModelIdentity(result.modelIdentity ?? status?.modelIdentity);
        const turns = usage?.turns ?? status?.turnCount;
        const toolCalls = result.toolCount ?? status?.toolCount;
        const activity = turns !== undefined || toolCalls !== undefined
            ? {
                ...(turns !== undefined ? { turns } : {}),
                ...(toolCalls !== undefined ? { toolCalls } : {}),
            }
            : undefined;
        const stepTiming = timingFromInput({
            startedAt: result.startedAt ?? status?.startedAt,
            endedAt: result.endedAt ?? status?.endedAt,
            durationMs: result.durationMs ?? status?.durationMs,
            activeRuntimeMs: result.activeRuntimeMs ?? status?.activeRuntimeMs,
        });
        const outcome = resolveSubagentTelemetryOutcome({
            state: status?.status,
            success: result.success,
            interrupted: result.interrupted,
            timedOut: result.timedOut || status?.timedOut,
            terminationReason: result.terminationReason ?? status?.terminationReason,
            acceptanceStatus: result.acceptance?.status ?? status?.acceptance?.status,
        });
        return {
            index,
            agent: result.agent,
            ...(model ? { model } : {}),
            ...(telemetryUsage ? { usage: telemetryUsage } : {}),
            ...(activity ? { activity } : {}),
            ...(stepTiming ? { timing: stepTiming } : {}),
            ...(outcome ? { outcome } : {}),
        };
    });
    const runOutcome = input.outcome ??
        (input.results.length === 0
            ? undefined
            : resolveParallelSubagentTelemetryOutcome(input.results.map((result, resultIndex) => {
                const index = result.index ?? resultIndex;
                const status = input.statusSteps?.[index];
                return {
                    index,
                    agent: result.agent,
                    state: status?.status,
                    success: result.success,
                    interrupted: result.interrupted,
                    timedOut: result.timedOut || status?.timedOut,
                    terminationReason: result.terminationReason ?? status?.terminationReason,
                };
            })));
    return buildSubagentRunTelemetry({
        runId: input.runId,
        execution: "async",
        mode: input.mode,
        steps,
        provenance: input.provenance,
        controls: input.controls,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        activeRuntimeMs: input.activeRuntimeMs,
        outcome: runOutcome,
        lineage: input.lineage,
    });
}
