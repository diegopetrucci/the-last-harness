import { tupleKey } from "./subagent-analysis-keys.mjs";
import { resolveParallelTelemetryOutcome } from "./subagent-analysis-parser.mjs";
export function emptySubagentUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
    };
}
export function cloneSubagentUsage(value) {
    return { ...value };
}
export function addSubagentUsage(target, source) {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.cacheWriteTokens += source.cacheWriteTokens;
    target.costUsd += source.costUsd;
}
export function createTelemetryCoverageBucket() {
    return {
        records: 0,
        validRecords: 0,
        invalidRecords: 0,
        runs: 0,
        runsWithUsage: 0,
        steps: 0,
        stepsWithUsage: 0,
    };
}
export function createRunCoverageBucket() {
    return {
        runs: 0,
        withTelemetry: 0,
        withoutTelemetry: 0,
        withUsage: 0,
        withoutUsage: 0,
        withOutcome: 0,
        withoutOutcome: 0,
        withRuntime: 0,
        withoutRuntime: 0,
    };
}
export function createAggregate() {
    return {
        runs: 0,
        steps: 0,
        usageReportedSteps: 0,
        runtimeReportedRuns: 0,
        usage: emptySubagentUsage(),
        runtime: { durationMs: 0, activeRuntimeMs: 0 },
    };
}
export function incrementAggregateMap(map, key, input) {
    const aggregate = map.get(key) ?? createAggregate();
    aggregate.runs++;
    aggregate.steps += input.steps.length;
    if (input.runUsage)
        addSubagentUsage(aggregate.usage, input.runUsage);
    if (input.runRuntime.durationMs !== null) {
        aggregate.runtime.durationMs += input.runRuntime.durationMs;
    }
    if (input.runRuntime.activeRuntimeMs !== null) {
        aggregate.runtime.activeRuntimeMs += input.runRuntime.activeRuntimeMs;
    }
    if (input.runRuntime.durationMs !== null || input.runRuntime.activeRuntimeMs !== null) {
        aggregate.runtimeReportedRuns++;
    }
    for (const step of input.steps) {
        if (step.usage)
            aggregate.usageReportedSteps++;
    }
    map.set(key, aggregate);
}
export function addStepMetrics(aggregate, steps) {
    aggregate.steps += steps.length;
    for (const step of steps) {
        if (step.usage) {
            aggregate.usageReportedSteps++;
            addSubagentUsage(aggregate.usage, step.usage);
        }
        if (step.runtime?.durationMs !== undefined)
            aggregate.runtime.durationMs += step.runtime.durationMs;
        if (step.runtime?.activeRuntimeMs !== undefined)
            aggregate.runtime.activeRuntimeMs += step.runtime.activeRuntimeMs;
    }
}
export function groupMapToObject(map) {
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]));
}
export function modelKey(model) {
    return tupleKey(model.provider, model.model);
}
export function outcomeForRun(run, steps) {
    if (run.telemetry?.outcome)
        return run.telemetry.outcome;
    if (run.telemetry?.run.mode === "parallel") {
        const parallelOutcome = resolveParallelTelemetryOutcome(run.telemetry.steps.map((step) => ({
            index: step.index,
            agent: step.agent,
            state: step.outcome?.state,
            terminationReason: step.outcome?.terminationReason,
        })));
        if (parallelOutcome)
            return parallelOutcome;
    }
    if (run.legacyOutcome)
        return run.legacyOutcome;
    const outcomes = steps
        .map((step) => step.outcome)
        .filter((value) => Boolean(value));
    if (outcomes.length === 0)
        return undefined;
    const first = outcomes[0];
    if (outcomes.every((value) => value.state === first.state))
        return first;
    const statePriority = ["failed", "paused", "cancelled", "running", "queued", "continued"];
    const selectedState = statePriority.find((state) => outcomes.some((value) => value.state === state));
    const selected = selectedState
        ? outcomes.find((value) => value.state === selectedState)
        : undefined;
    return selected ?? { state: "completed" };
}
export function effectiveRunSteps(run) {
    const telemetrySteps = run.telemetry?.steps ?? [];
    const telemetryIndexes = new Set(telemetrySteps.map((step) => step.index));
    const steps = telemetrySteps.map((step) => ({
        index: step.index,
        role: step.agent,
        ...(step.model ? { model: { ...step.model } } : {}),
        ...(step.outcome ? { outcome: { ...step.outcome } } : {}),
        ...(step.usage ? { usage: cloneSubagentUsage(step.usage) } : {}),
        ...(step.timing &&
            (step.timing.durationMs !== undefined || step.timing.activeRuntimeMs !== undefined)
            ? {
                runtime: {
                    ...(step.timing.durationMs !== undefined ? { durationMs: step.timing.durationMs } : {}),
                    ...(step.timing.activeRuntimeMs !== undefined
                        ? { activeRuntimeMs: step.timing.activeRuntimeMs }
                        : {}),
                },
            }
            : {}),
    }));
    for (const legacy of run.legacySteps.values()) {
        if (telemetryIndexes.has(legacy.index) || !legacy.role)
            continue;
        steps.push({
            index: legacy.index,
            role: legacy.role,
            ...(legacy.model ? { model: { ...legacy.model } } : {}),
            ...(legacy.outcome ? { outcome: { ...legacy.outcome } } : {}),
            ...(legacy.usage ? { usage: cloneSubagentUsage(legacy.usage) } : {}),
            ...(legacy.timing ? { runtime: { ...legacy.timing } } : {}),
        });
    }
    steps.sort((a, b) => a.index - b.index);
    return steps;
}
export function runUsage(run, steps) {
    const stepUsages = steps
        .map((step) => step.usage)
        .filter((value) => Boolean(value));
    if (run.telemetry) {
        if (run.telemetry.usage)
            return cloneSubagentUsage(run.telemetry.usage);
        if (stepUsages.length > 0) {
            const total = emptySubagentUsage();
            for (const usage of stepUsages)
                addSubagentUsage(total, usage);
            return total;
        }
        return null;
    }
    if (stepUsages.length > 0) {
        const total = emptySubagentUsage();
        for (const usage of stepUsages)
            addSubagentUsage(total, usage);
        return total;
    }
    return run.legacyUsage ? cloneSubagentUsage(run.legacyUsage) : null;
}
export function runRuntime(run, steps) {
    const stepDurationMs = steps.reduce((total, step) => total + (step.runtime?.durationMs ?? 0), 0);
    const stepActiveRuntimeMs = steps.reduce((total, step) => total + (step.runtime?.activeRuntimeMs ?? 0), 0);
    return {
        durationMs: run.telemetry?.timing?.durationMs ??
            run.legacyRuntime?.durationMs ??
            (steps.some((step) => step.runtime?.durationMs !== undefined) ? stepDurationMs : null),
        activeRuntimeMs: run.telemetry?.timing?.activeRuntimeMs ??
            run.legacyRuntime?.activeRuntimeMs ??
            (steps.some((step) => step.runtime?.activeRuntimeMs !== undefined)
                ? stepActiveRuntimeMs
                : null),
    };
}
export function runContinuation(run) {
    const lineage = run.telemetry?.lineage;
    if (!lineage)
        return undefined;
    return {
        ...(lineage.continuationFrom ? { from: { ...lineage.continuationFrom } } : {}),
        ...(lineage.continuations?.length
            ? { to: lineage.continuations.map((entry) => ({ ...entry })) }
            : {}),
        ...(lineage.nested ? { nested: { ...lineage.nested } } : {}),
    };
}
export function collectRunLineage(run, runs, continuationEdges, nestedEdges) {
    const lineage = run.telemetry?.lineage;
    if (!lineage)
        return 0;
    let unresolvedReferences = 0;
    if (lineage.continuationFrom) {
        const edge = {
            sourceRunId: lineage.continuationFrom.sourceRunId,
            continuationRunId: run.runId,
            ...(lineage.continuationFrom.sourceStepIndex !== undefined
                ? { sourceStepIndex: lineage.continuationFrom.sourceStepIndex }
                : {}),
        };
        continuationEdges.set(tupleKey(edge.sourceRunId, edge.continuationRunId, edge.sourceStepIndex), edge);
        if (!runs.has(edge.sourceRunId))
            unresolvedReferences++;
    }
    for (const continuation of lineage.continuations ?? []) {
        const edge = {
            sourceRunId: run.runId,
            continuationRunId: continuation.continuationRunId,
            ...(continuation.sourceStepIndex !== undefined
                ? { sourceStepIndex: continuation.sourceStepIndex }
                : {}),
        };
        continuationEdges.set(tupleKey(edge.sourceRunId, edge.continuationRunId, edge.sourceStepIndex), edge);
        if (!runs.has(edge.continuationRunId))
            unresolvedReferences++;
    }
    if (lineage.nested) {
        const nested = { ...lineage.nested };
        nestedEdges.set(tupleKey(nested.rootRunId, nested.parentRunId, nested.childRunId, nested.parentStepIndex), nested);
        if (!runs.has(nested.rootRunId) ||
            !runs.has(nested.parentRunId) ||
            !runs.has(nested.childRunId))
            unresolvedReferences++;
    }
    return unresolvedReferences;
}
