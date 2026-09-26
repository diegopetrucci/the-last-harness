/**
 * Read-only subagent session analysis.
 *
 * This module consumes entries retained by the streaming session scanner. It
 * never opens session files, async artifacts, or run-history.jsonl itself.
 */
import { aggregateCoverage } from "./session-analysis-coverage.mjs";
import { SUBAGENT_ACTIONS, TARGETING_ACTIONS, finiteNonNegativeNumber, hasOwn, isObject, mergeTelemetrySnapshots, parseLegacyModel, parseLegacyOutcome, parseLegacyStepTiming, parseLegacyUsage, parseNormalizedTelemetry, parsedCallOperation, safeMetadataString, safeRunId, safeStepIndex, } from "./subagent-analysis-parser.mjs";
import { addStepMetrics, addSubagentUsage, collectRunLineage, createAggregate, createRunCoverageBucket, createTelemetryCoverageBucket, effectiveRunSteps, emptySubagentUsage, groupMapToObject, incrementAggregateMap, modelKey, outcomeForRun, runContinuation, runRuntime, runUsage, } from "./subagent-analysis-aggregation.mjs";
import { analyzeWakeupsForScan } from "./subagent-analysis-wakeup.mjs";
import { tupleKey } from "./subagent-analysis-keys.mjs";
function parseSubagentToolResultDetails(message) {
    return isObject(message.details) ? message.details : undefined;
}
function telemetryExecutionFromRaw(value) {
    if (!isObject(value) || !isObject(value.run))
        return "unknown";
    return value.run.execution === "foreground" || value.run.execution === "async"
        ? value.run.execution
        : "unknown";
}
function addLegacyDetailsToRun(run, details, sourceKind) {
    run.sourceKinds.add(sourceKind);
    const mode = details.mode;
    if (mode === "single" || mode === "parallel" || mode === "management")
        run.mode = mode;
    if (detailsIndicateAsync(details))
        run.execution = "async";
    const topModel = parseLegacyModel(details);
    if (topModel)
        run.models.set(modelKey(topModel), topModel);
    const topOutcome = parseLegacyOutcome(details);
    if (topOutcome)
        run.legacyOutcome = topOutcome;
    const topUsage = parseLegacyUsage(details.totalChildUsage);
    if (topUsage) {
        run.legacyUsage = topUsage;
    }
    else if (isObject(details.totalCost) && finiteNonNegativeNumber(details.totalCost.costUsd)) {
        run.legacyUsage = { ...emptySubagentUsage(), costUsd: details.totalCost.costUsd };
    }
    const runtime = parseLegacyStepTiming(details);
    if (runtime) {
        run.legacyRuntime = {
            ...(runtime.durationMs !== undefined ? { durationMs: runtime.durationMs } : {}),
            ...(runtime.activeRuntimeMs !== undefined
                ? { activeRuntimeMs: runtime.activeRuntimeMs }
                : {}),
        };
    }
    if (!Array.isArray(details.results))
        return;
    const limit = Math.min(details.results.length, 64);
    for (let index = 0; index < limit; index++) {
        const raw = details.results[index];
        if (!isObject(raw))
            continue;
        const stepIndex = safeStepIndex(raw.index) ?? index;
        const role = safeMetadataString(raw.agent);
        const model = parseLegacyModel(raw);
        const usage = parseLegacyUsage(raw.usage) ??
            (isObject(raw.totalCost) && finiteNonNegativeNumber(raw.totalCost.costUsd)
                ? { ...emptySubagentUsage(), costUsd: raw.totalCost.costUsd }
                : undefined);
        const outcome = parseLegacyOutcome(raw);
        const timing = parseLegacyStepTiming(raw);
        const previous = run.legacySteps.get(stepIndex);
        const next = {
            ...(previous ?? { index: stepIndex }),
            index: stepIndex,
            ...(role ? { role } : {}),
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(outcome ? { outcome } : {}),
            ...(timing ? { timing } : {}),
        };
        run.legacySteps.set(stepIndex, next);
        if (role)
            run.roles.add(role);
        if (model)
            run.models.set(modelKey(model), model);
    }
}
function addCompletionDetailsToRun(run, details) {
    addLegacyDetailsToRun(run, details, "completion");
    const agent = safeMetadataString(details.agent);
    if (agent)
        run.roles.add(agent);
}
function extractRunIdFromDetails(details) {
    if (!details)
        return undefined;
    return safeRunId(details.runId) ?? safeRunId(details.asyncId);
}
function detailsIndicateAsync(details) {
    return (details.asyncId !== undefined ||
        details.asyncDir !== undefined ||
        details.asyncReference === true);
}
function addLaunchRoleHints(run, operation) {
    for (const role of operation.roles)
        run.roles.add(role);
}
/**
 * Analyze subagent evidence already collected by the streaming session reader.
 * This function is intentionally synchronous: callers decide how to scan files,
 * and no analyzer path ever opens run-history.jsonl or an async artifact file.
 */
export function analyzeSubagentSessions(scanResults, baseCoverage = aggregateCoverage(scanResults), options = {}) {
    const runs = new Map();
    const telemetrySourceIdentities = new Set();
    const telemetryBuckets = {
        foreground: createTelemetryCoverageBucket(),
        async: createTelemetryCoverageBucket(),
        unknown: createTelemetryCoverageBucket(),
    };
    const runBuckets = {
        foreground: createRunCoverageBucket(),
        async: createRunCoverageBucket(),
        unknown: createRunCoverageBucket(),
    };
    const counters = {
        telemetryRecordsObserved: 0,
        telemetryRecordsValid: 0,
        telemetryRecordsInvalid: 0,
        telemetryRecordsDeduplicated: 0,
        launchCalls: 0,
        launchesWithoutRunId: 0,
        managementCalls: 0,
        completionNotifications: 0,
        controlNotifications: 0,
        legacyProseNotifications: 0,
        malformedTelemetryRecords: 0,
        malformedCompletionDetails: 0,
        malformedControlDetails: 0,
        unmatchedEvidence: 0,
        completionDetailsMissing: 0,
        controlDetailsMissing: 0,
        wakeupsObserved: 0,
        wakeupsAttributed: 0,
        wakeupsUnattributed: 0,
        wakeupsInterruptedByHumanInput: 0,
        wakeupsMissingAssistantTurn: 0,
        wakeupsMissingRunId: 0,
        wakeupsMissingNudge: 0,
        unmatchedNudges: 0,
        completionBatchesObserved: 0,
        completionBatchesComplete: 0,
        completionBatchesIncomplete: 0,
        completionBatchesMixedLegacy: 0,
        completionBatchChunksObserved: 0,
        completionBatchChunksValid: 0,
        completionBatchChunksInvalid: 0,
        completionBatchStateEvictions: 0,
        completionFlushStateEvictions: 0,
        completionBatchChunksDeduplicated: 0,
        completionBatchChunksDuplicate: 0,
        completionBatchChunksMissing: 0,
        completionBatchEntriesObserved: 0,
        completionBatchEntriesWithoutTelemetry: 0,
        unresolvedManagementTargets: 0,
        managementTargets: 0,
        malformedArguments: 0,
        unclassifiedOperations: 0,
    };
    const operationLaunches = {
        total: 0,
        foreground: 0,
        async: 0,
        unknown: 0,
        withRunId: 0,
        withoutRunId: 0,
        withResult: 0,
        withoutResult: 0,
    };
    const operationManagementByAction = new Map();
    const managementTargetRunIds = [];
    const continuationEdges = new Map();
    const nestedEdges = new Map();
    const wakeups = [];
    const seenCompletionSources = new Set();
    const seenControlSources = new Set();
    function ensureRun(runId) {
        const existing = runs.get(runId);
        if (existing)
            return existing;
        const created = {
            runId,
            execution: "unknown",
            mode: "unknown",
            telemetryRecordCount: 0,
            roles: new Set(),
            models: new Map(),
            legacySteps: new Map(),
            sourceKinds: new Set(),
        };
        runs.set(runId, created);
        return created;
    }
    function addTelemetry(raw, sourceKind) {
        counters.telemetryRecordsObserved++;
        const rawExecution = telemetryExecutionFromRaw(raw);
        telemetryBuckets[rawExecution].records++;
        const normalized = parseNormalizedTelemetry(raw);
        if (!normalized) {
            counters.telemetryRecordsInvalid++;
            counters.malformedTelemetryRecords++;
            telemetryBuckets[rawExecution].invalidRecords++;
            return undefined;
        }
        counters.telemetryRecordsValid++;
        telemetryBuckets[normalized.run.execution].validRecords++;
        const identityParts = normalized.steps.length > 0
            ? normalized.steps.map((step) => tupleKey(normalized.run.id, "step", step.index))
            : [tupleKey(normalized.run.id, "run")];
        if (identityParts.some((identity) => telemetrySourceIdentities.has(identity)))
            counters.telemetryRecordsDeduplicated++;
        for (const identity of identityParts)
            telemetrySourceIdentities.add(identity);
        const run = ensureRun(normalized.run.id);
        run.sourceKinds.add(sourceKind);
        run.telemetryRecordCount++;
        run.execution = normalized.run.execution;
        run.mode = normalized.run.mode;
        run.telemetry = run.telemetry ? mergeTelemetrySnapshots(run.telemetry, normalized) : normalized;
        for (const step of normalized.steps) {
            run.roles.add(step.agent);
            if (step.model)
                run.models.set(modelKey(step.model), step.model);
        }
        return normalized;
    }
    function applyRunHints(run, details, sourceKind) {
        if (!details)
            return;
        const telemetry = parseNormalizedTelemetry(details.telemetry);
        // A normalized envelope is authoritative. Legacy result fields may carry
        // an asyncId for bookkeeping even when the envelope says foreground; do
        // not let those fallback hints overwrite the structured execution/mode.
        if (run.telemetry || telemetry) {
            run.sourceKinds.add(sourceKind);
            if (telemetry) {
                run.execution = telemetry.run.execution;
                run.mode = telemetry.run.mode;
            }
            return;
        }
        addLegacyDetailsToRun(run, details, sourceKind);
    }
    function processToolResult(message) {
        if (message.toolName !== "subagent")
            return;
        const details = parseSubagentToolResultDetails(message);
        if (!details)
            return;
        const telemetry = hasOwn(details, "telemetry")
            ? addTelemetry(details.telemetry, "tool-result")
            : undefined;
        const runId = telemetry?.run.id ?? extractRunIdFromDetails(details);
        if (!runId)
            return;
        const run = ensureRun(runId);
        run.sourceKinds.add("tool-result");
        applyRunHints(run, details, "tool-result");
    }
    function processToolCalls(scanResult, resultByCallId) {
        const entries = scanResult.entries;
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
            const entry = entries[entryIndex];
            if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message))
                continue;
            const message = entry.message;
            if (message.role !== "assistant" || !Array.isArray(message.content))
                continue;
            for (let itemIndex = 0; itemIndex < message.content.length; itemIndex++) {
                const rawItem = message.content[itemIndex];
                if (!isObject(rawItem) || rawItem.type !== "toolCall")
                    continue;
                const toolName = typeof rawItem.toolName === "string"
                    ? rawItem.toolName
                    : typeof rawItem.name === "string"
                        ? rawItem.name
                        : undefined;
                if (toolName !== "subagent")
                    continue;
                const callId = typeof rawItem.toolCallId === "string"
                    ? rawItem.toolCallId
                    : typeof rawItem.id === "string"
                        ? rawItem.id
                        : undefined;
                const result = callId ? resultByCallId.get(callId) : undefined;
                const details = result?.details;
                const operation = parsedCallOperation(rawItem);
                const malformedOperation = operation.malformedArguments || operation.asyncInvalid || operation.actionMalformed;
                if (malformedOperation) {
                    counters.malformedArguments++;
                    counters.unclassifiedOperations++;
                    // Do not turn malformed arguments into a launch or management call.
                    continue;
                }
                if (operation.hasAction) {
                    counters.managementCalls++;
                    const normalizedAction = operation.action && SUBAGENT_ACTIONS.has(operation.action)
                        ? operation.action
                        : "unknown";
                    operationManagementByAction.set(normalizedAction, (operationManagementByAction.get(normalizedAction) ?? 0) + 1);
                    if (operation.action && TARGETING_ACTIONS.has(operation.action) && operation.hasTarget) {
                        const target = operation.targetRunId;
                        if (target) {
                            counters.managementTargets++;
                            managementTargetRunIds.push(target);
                        }
                    }
                    continue;
                }
                operationLaunches.total++;
                counters.launchCalls++;
                if (result)
                    operationLaunches.withResult++;
                else
                    operationLaunches.withoutResult++;
                const telemetry = details && hasOwn(details, "telemetry")
                    ? parseNormalizedTelemetry(details.telemetry)
                    : undefined;
                const runId = telemetry?.run.id ?? extractRunIdFromDetails(details);
                if (runId)
                    operationLaunches.withRunId++;
                else {
                    operationLaunches.withoutRunId++;
                    counters.launchesWithoutRunId++;
                }
                let execution = "unknown";
                if (telemetry)
                    execution = telemetry.run.execution;
                else if (operation.async === true)
                    execution = "async";
                else if (operation.async === false)
                    execution = "foreground";
                else if (details && detailsIndicateAsync(details))
                    execution = "async";
                else if (!operation.asyncInvalid && (operation.agentPresent || operation.tasksPresent))
                    execution = "foreground";
                operationLaunches[execution]++;
                if (runId) {
                    const run = ensureRun(runId);
                    run.sourceKinds.add("launch");
                    if (!run.telemetry) {
                        run.execution = execution;
                        if (operation.tasksPresent)
                            run.mode = "parallel";
                        else if (operation.agentPresent)
                            run.mode = "single";
                        addLaunchRoleHints(run, operation);
                    }
                    applyRunHints(run, details, "launch");
                }
            }
        }
    }
    function parseResultMaps(scanResult) {
        const resultByCallId = new Map();
        const pairedSubagentCallIds = new Set(scanResult.toolPairs
            .filter((pair) => pair.toolName === "subagent")
            .map((pair) => pair.toolCallId));
        for (const entry of scanResult.entries) {
            if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message))
                continue;
            const message = entry.message;
            if (message.role !== "toolResult")
                continue;
            const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
            const details = parseSubagentToolResultDetails(message);
            const hasSubagentEvidence = message.toolName === "subagent" ||
                (details !== undefined &&
                    [
                        "runId",
                        "asyncId",
                        "telemetry",
                        "results",
                        "controlEvents",
                        "event",
                        "kind",
                        "batchId",
                        "batchIndex",
                        "batchCount",
                        "triggersTurn",
                        "completions",
                    ].some((field) => hasOwn(details, field)));
            if (hasSubagentEvidence && (!toolCallId || !pairedSubagentCallIds.has(toolCallId))) {
                counters.unmatchedEvidence++;
            }
            if (!toolCallId || !pairedSubagentCallIds.has(toolCallId))
                continue;
            // Pairing is intentionally keyed by ID, but an explicitly different
            // tool name is not subagent evidence. A missing name remains compatible
            // with persisted Pi shapes where the result carries only its details.
            if (message.toolName !== undefined && message.toolName !== "subagent")
                continue;
            const subagentMessage = message.toolName === "subagent" ? message : { ...message, toolName: "subagent" };
            resultByCallId.set(toolCallId, details ? { details } : {});
            processToolResult(subagentMessage);
        }
        return resultByCallId;
    }
    for (const scanResult of scanResults) {
        const resultByCallId = parseResultMaps(scanResult);
        processToolCalls(scanResult, resultByCallId);
        analyzeWakeupsForScan(scanResult, {
            ensureRun,
            getRun: (runId) => runs.get(runId),
            addTelemetry,
            addCompletionDetailsToRun,
            counters,
            wakeups,
            seenCompletionSources,
            seenControlSources,
        });
    }
    const runSummaries = [];
    const byRole = new Map();
    const byModel = new Map();
    const byExecution = new Map();
    const byOutcome = new Map();
    const totalUsage = emptySubagentUsage();
    const totalRuntime = { durationMs: 0, activeRuntimeMs: 0 };
    let totalSteps = 0;
    let unresolvedLineageReferences = 0;
    for (const run of runs.values()) {
        const steps = effectiveRunSteps(run);
        const usage = runUsage(run, steps);
        const runtime = runRuntime(run, steps);
        const outcome = outcomeForRun(run, steps);
        const summary = {
            runId: run.runId,
            execution: run.execution,
            mode: run.mode,
            roles: [...new Set([...run.roles, ...steps.map((step) => step.role)])].sort(),
            models: [...run.models.values()].sort((a, b) => modelKey(a).localeCompare(modelKey(b))),
            outcome: outcome ? { ...outcome } : null,
            usage,
            runtime,
            steps,
            sourceKinds: [...run.sourceKinds].sort(),
            telemetryRecordCount: run.telemetryRecordCount,
            ...(runContinuation(run) ? { continuation: runContinuation(run) } : {}),
        };
        runSummaries.push(summary);
        totalSteps += steps.length;
        if (usage) {
            addSubagentUsage(totalUsage, usage);
        }
        if (runtime.durationMs !== null || runtime.activeRuntimeMs !== null) {
            if (runtime.durationMs !== null)
                totalRuntime.durationMs += runtime.durationMs;
            if (runtime.activeRuntimeMs !== null)
                totalRuntime.activeRuntimeMs += runtime.activeRuntimeMs;
        }
        const executionKey = run.execution;
        incrementAggregateMap(byExecution, executionKey, {
            steps,
            runUsage: usage,
            runRuntime: runtime,
        });
        const outcomeKey = outcome?.state ?? "unknown";
        incrementAggregateMap(byOutcome, outcomeKey, {
            steps,
            runUsage: usage,
            runRuntime: runtime,
        });
        for (const step of steps) {
            const roleAggregate = byRole.get(step.role) ?? createAggregate();
            roleAggregate.runs++;
            addStepMetrics(roleAggregate, [step]);
            byRole.set(step.role, roleAggregate);
            if (step.model) {
                const key = modelKey(step.model);
                const modelAggregate = byModel.get(key) ?? createAggregate();
                modelAggregate.runs++;
                addStepMetrics(modelAggregate, [step]);
                byModel.set(key, modelAggregate);
            }
        }
        unresolvedLineageReferences += collectRunLineage(run, runs, continuationEdges, nestedEdges);
    }
    // The role/model maps above receive one increment per observed step. Rebuild
    // their run cardinality without retaining any internal marker on output.
    const roleRunSets = new Map();
    const modelRunSets = new Map();
    const roleRuntimeRunSets = new Map();
    const modelRuntimeRunSets = new Map();
    for (const summary of runSummaries) {
        const runHasRuntime = summary.runtime.durationMs !== null || summary.runtime.activeRuntimeMs !== null;
        for (const role of summary.roles) {
            const roleRuns = roleRunSets.get(role) ?? new Set();
            roleRuns.add(summary.runId);
            roleRunSets.set(role, roleRuns);
            if (runHasRuntime) {
                const roleRuntimeRuns = roleRuntimeRunSets.get(role) ?? new Set();
                roleRuntimeRuns.add(summary.runId);
                roleRuntimeRunSets.set(role, roleRuntimeRuns);
            }
        }
        for (const model of summary.models) {
            const key = modelKey(model);
            const modelRuns = modelRunSets.get(key) ?? new Set();
            modelRuns.add(summary.runId);
            modelRunSets.set(key, modelRuns);
            if (runHasRuntime) {
                const modelRuntimeRuns = modelRuntimeRunSets.get(key) ?? new Set();
                modelRuntimeRuns.add(summary.runId);
                modelRuntimeRunSets.set(key, modelRuntimeRuns);
            }
        }
        for (const step of summary.steps) {
            const roleRuns = roleRunSets.get(step.role) ?? new Set();
            roleRuns.add(summary.runId);
            roleRunSets.set(step.role, roleRuns);
            if (runHasRuntime ||
                step.runtime?.durationMs !== undefined ||
                step.runtime?.activeRuntimeMs !== undefined) {
                const roleRuntimeRuns = roleRuntimeRunSets.get(step.role) ?? new Set();
                roleRuntimeRuns.add(summary.runId);
                roleRuntimeRunSets.set(step.role, roleRuntimeRuns);
            }
            if (step.model) {
                const key = modelKey(step.model);
                const modelRuns = modelRunSets.get(key) ?? new Set();
                modelRuns.add(summary.runId);
                modelRunSets.set(key, modelRuns);
                if (runHasRuntime ||
                    step.runtime?.durationMs !== undefined ||
                    step.runtime?.activeRuntimeMs !== undefined) {
                    const modelRuntimeRuns = modelRuntimeRunSets.get(key) ?? new Set();
                    modelRuntimeRuns.add(summary.runId);
                    modelRuntimeRunSets.set(key, modelRuntimeRuns);
                }
            }
        }
    }
    for (const [role, roleRuns] of roleRunSets) {
        const aggregate = byRole.get(role) ?? createAggregate();
        aggregate.runs = roleRuns.size;
        aggregate.runtimeReportedRuns = roleRuntimeRunSets.get(role)?.size ?? 0;
        byRole.set(role, aggregate);
    }
    for (const [model, modelRuns] of modelRunSets) {
        const aggregate = byModel.get(model) ?? createAggregate();
        aggregate.runs = modelRuns.size;
        aggregate.runtimeReportedRuns = modelRuntimeRunSets.get(model)?.size ?? 0;
        byModel.set(model, aggregate);
    }
    runSummaries.sort((a, b) => a.runId.localeCompare(b.runId));
    // Run IDs are useful for correlating records inside one report, but they are
    // still raw transcript identifiers. Keep the correlation while ensuring the
    // default diagnostic output never publishes them verbatim.
    const publicRunIds = new Map();
    const publicRunId = (runId) => {
        const existing = publicRunIds.get(runId);
        if (existing)
            return existing;
        const assigned = options.publicRunId?.(runId) ?? `run-${publicRunIds.size + 1}`;
        publicRunIds.set(runId, assigned);
        return assigned;
    };
    const publicContinuation = (continuation) => {
        if (!continuation)
            return undefined;
        return {
            ...(continuation.from
                ? {
                    from: {
                        ...continuation.from,
                        sourceRunId: publicRunId(continuation.from.sourceRunId),
                    },
                }
                : {}),
            ...(continuation.to
                ? {
                    to: continuation.to.map((entry) => ({
                        ...entry,
                        continuationRunId: publicRunId(entry.continuationRunId),
                    })),
                }
                : {}),
            ...(continuation.nested
                ? {
                    nested: {
                        ...continuation.nested,
                        rootRunId: publicRunId(continuation.nested.rootRunId),
                        parentRunId: publicRunId(continuation.nested.parentRunId),
                        childRunId: publicRunId(continuation.nested.childRunId),
                    },
                }
                : {}),
        };
    };
    for (const summary of runSummaries) {
        summary.runId = publicRunId(summary.runId);
        summary.continuation = publicContinuation(summary.continuation);
    }
    for (const execution of ["foreground", "async", "unknown"]) {
        const bucket = runBuckets[execution];
        for (const run of runSummaries.filter((candidate) => candidate.execution === execution)) {
            bucket.runs++;
            if (run.usage)
                bucket.withUsage++;
            else
                bucket.withoutUsage++;
            if (run.outcome)
                bucket.withOutcome++;
            else
                bucket.withoutOutcome++;
            if (run.runtime.durationMs !== null || run.runtime.activeRuntimeMs !== null)
                bucket.withRuntime++;
            else
                bucket.withoutRuntime++;
            if (run.telemetryRecordCount > 0)
                bucket.withTelemetry++;
            else
                bucket.withoutTelemetry++;
        }
    }
    // Coverage totals describe the canonical merged telemetry for each run, not
    // every valid snapshot that contributed to it. Record counters above remain
    // per-record evidence counters, while steps and usage are derived once here.
    for (const run of runs.values()) {
        const telemetry = run.telemetry;
        if (!telemetry)
            continue;
        const bucket = telemetryBuckets[telemetry.run.execution];
        bucket.runs++;
        bucket.steps += telemetry.steps.length;
        bucket.stepsWithUsage += telemetry.steps.filter((step) => step.usage !== undefined).length;
        if (telemetry.usage !== undefined || telemetry.steps.some((step) => step.usage !== undefined)) {
            bucket.runsWithUsage++;
        }
    }
    const attributedWakeupUsage = emptySubagentUsage();
    for (const wakeup of wakeups) {
        if (wakeup.attributed && wakeup.assistantUsage)
            addSubagentUsage(attributedWakeupUsage, wakeup.assistantUsage);
    }
    const lineageOutput = {
        continuationEdges: [...continuationEdges.values()].sort((a, b) => tupleKey(a.sourceRunId, a.continuationRunId, a.sourceStepIndex).localeCompare(tupleKey(b.sourceRunId, b.continuationRunId, b.sourceStepIndex))),
        nestedEdges: [...nestedEdges.values()].sort((a, b) => tupleKey(a.rootRunId, a.parentRunId, a.childRunId, a.parentStepIndex).localeCompare(tupleKey(b.rootRunId, b.parentRunId, b.childRunId, b.parentStepIndex))),
    };
    const coverage = {
        ...baseCoverage,
        runsObserved: runSummaries.length,
        runsWithTelemetry: runSummaries.filter((run) => run.telemetryRecordCount > 0).length,
        runsWithoutTelemetry: runSummaries.filter((run) => run.telemetryRecordCount === 0).length,
        foreground: runBuckets.foreground,
        async: runBuckets.async,
        unknownExecution: runBuckets.unknown,
        telemetry: {
            recordsObserved: counters.telemetryRecordsObserved,
            recordsValid: counters.telemetryRecordsValid,
            recordsInvalid: counters.telemetryRecordsInvalid,
            recordsDeduplicated: counters.telemetryRecordsDeduplicated,
            uniqueSourceIdentities: telemetrySourceIdentities.size,
            foreground: telemetryBuckets.foreground,
            async: telemetryBuckets.async,
            unknownExecution: telemetryBuckets.unknown,
        },
        evidence: {
            launchCalls: counters.launchCalls,
            launchesWithoutRunId: counters.launchesWithoutRunId,
            managementCalls: counters.managementCalls,
            completionNotifications: counters.completionNotifications,
            controlNotifications: counters.controlNotifications,
            legacyProseNotifications: counters.legacyProseNotifications,
            malformedTelemetryRecords: counters.malformedTelemetryRecords,
            malformedCompletionDetails: counters.malformedCompletionDetails,
            malformedControlDetails: counters.malformedControlDetails,
            unmatchedEvidence: counters.unmatchedEvidence,
            completionBatchesObserved: counters.completionBatchesObserved,
            completionBatchesComplete: counters.completionBatchesComplete,
            completionBatchesIncomplete: counters.completionBatchesIncomplete,
            completionBatchesMixedLegacy: counters.completionBatchesMixedLegacy,
            completionBatchChunksObserved: counters.completionBatchChunksObserved,
            completionBatchChunksValid: counters.completionBatchChunksValid,
            completionBatchChunksInvalid: counters.completionBatchChunksInvalid,
            completionBatchStateEvictions: counters.completionBatchStateEvictions,
            completionFlushStateEvictions: counters.completionFlushStateEvictions,
            completionBatchChunksDeduplicated: counters.completionBatchChunksDeduplicated,
            completionBatchChunksDuplicate: counters.completionBatchChunksDuplicate,
            completionBatchChunksMissing: counters.completionBatchChunksMissing,
            completionBatchEntriesObserved: counters.completionBatchEntriesObserved,
            completionBatchEntriesWithoutTelemetry: counters.completionBatchEntriesWithoutTelemetry,
        },
        wakeups: {
            observed: counters.wakeupsObserved,
            attributed: counters.wakeupsAttributed,
            unattributed: counters.wakeupsUnattributed,
            interruptedByHumanInput: counters.wakeupsInterruptedByHumanInput,
            missingAssistantTurn: counters.wakeupsMissingAssistantTurn,
            missingRunId: counters.wakeupsMissingRunId,
            missingNudge: counters.wakeupsMissingNudge,
            unmatchedNudges: counters.unmatchedNudges,
        },
        missingEvidence: {
            telemetryForRun: runSummaries.filter((run) => run.telemetryRecordCount === 0).length,
            usageForStep: runSummaries.reduce((total, run) => total + run.steps.filter((step) => step.usage === undefined).length, 0),
            runtimeForRun: runSummaries.filter((run) => run.runtime.durationMs === null && run.runtime.activeRuntimeMs === null).length,
            outcomeForRun: runSummaries.filter((run) => run.outcome === null).length,
            completionDetails: counters.completionDetailsMissing,
            controlDetails: counters.controlDetailsMissing,
            completionBatchChunks: counters.completionBatchChunksMissing,
            completionBatchTelemetry: counters.completionBatchEntriesWithoutTelemetry,
            syntheticNudge: counters.wakeupsMissingNudge,
            wakeupAssistantTurn: counters.wakeupsMissingAssistantTurn,
            managementTarget: counters.unresolvedManagementTargets,
        },
        lineage: {
            continuationEdges: continuationEdges.size,
            nestedEdges: nestedEdges.size,
            unresolvedReferences: unresolvedLineageReferences,
        },
    };
    counters.unresolvedManagementTargets = managementTargetRunIds.filter((target) => !runs.has(target)).length;
    coverage.missingEvidence.managementTarget = counters.unresolvedManagementTargets;
    const publicLineage = {
        continuationEdges: lineageOutput.continuationEdges.map((edge) => ({
            ...edge,
            sourceRunId: publicRunId(edge.sourceRunId),
            continuationRunId: publicRunId(edge.continuationRunId),
        })),
        nestedEdges: lineageOutput.nestedEdges.map((edge) => ({
            ...edge,
            rootRunId: publicRunId(edge.rootRunId),
            parentRunId: publicRunId(edge.parentRunId),
            childRunId: publicRunId(edge.childRunId),
        })),
    };
    const publicWakeups = wakeups.map((wakeup) => ({
        ...wakeup,
        ...(wakeup.runId ? { runId: publicRunId(wakeup.runId) } : {}),
        ...(wakeup.runIds ? { runIds: wakeup.runIds.map((runId) => publicRunId(runId)) } : {}),
    }));
    return {
        schemaVersion: "1",
        mode: "subagents",
        coverage,
        runs: runSummaries,
        aggregates: {
            runs: runSummaries.length,
            steps: totalSteps,
            usage: totalUsage,
            attributedWakeupUsage,
            runtime: totalRuntime,
            byRole: groupMapToObject(byRole),
            byModel: groupMapToObject(byModel),
            byExecution: groupMapToObject(byExecution),
            byOutcome: groupMapToObject(byOutcome),
        },
        operations: {
            launches: operationLaunches,
            management: {
                total: counters.managementCalls,
                byAction: Object.fromEntries([...operationManagementByAction.entries()].sort(([a], [b]) => a.localeCompare(b))),
                withTarget: counters.managementTargets,
                targetingKnownRun: Math.max(0, counters.managementTargets - counters.unresolvedManagementTargets),
                unresolvedTargets: counters.unresolvedManagementTargets,
            },
            unclassified: counters.unclassifiedOperations,
            malformedArguments: counters.malformedArguments,
        },
        lineage: publicLineage,
        wakeups: publicWakeups,
    };
}
/** Short alias for callers that use the CLI mode name as the function name. */
export const analyzeSubagents = analyzeSubagentSessions;
