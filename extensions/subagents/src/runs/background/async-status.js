import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../shared/formatters.js";
import { formatActivityLabel, formatParallelOutcome } from "../../shared/status-format.js";
import {} from "../../shared/types.js";
import { readInterruptRequest } from "./control-channel.js";
import { readStatus } from "../../shared/utils.js";
import { attachRootChildrenToSteps, buildNestedRouteIndex, projectNestedEvents } from "../shared/nested-events.js";
import { formatNestedRunStatusLines } from "../shared/nested-render.js";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.js";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.js";
import { createAsyncStatusValidationError, fingerprintAsyncStatusFile, isAsyncStatusCorruptionError } from "./async-status-corruption.js";
import { isProtectedPausedLifecycle, protectedLifecycleText } from "../shared/lifecycle-privacy.js";
import { normalizeTkTicketMetadata } from "../shared/tk-ticket.js";
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNotFoundError(error) {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT";
}
function isAsyncRunDir(root, entry) {
    const entryPath = path.join(root, entry);
    try {
        return fs.statSync(entryPath).isDirectory();
    }
    catch (error) {
        if (isNotFoundError(error))
            return false;
        throw new Error(`Failed to inspect async run path '${entryPath}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
}
function outputFileMtime(outputFile) {
    if (!outputFile)
        return undefined;
    try {
        return fs.statSync(outputFile).mtimeMs;
    }
    catch (error) {
        if (isNotFoundError(error))
            return undefined;
        throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
}
function deriveAsyncActivityState(asyncDir, status) {
    if (status.state !== "running")
        return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
    const outputPath = status.outputFile ? (path.isAbsolute(status.outputFile) ? status.outputFile : path.join(asyncDir, status.outputFile)) : undefined;
    const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
    return {
        activityState: status.activityState,
        lastActivityAt: status.lastActivityAt ?? outputFileMtime(outputPath) ?? currentStep?.lastActivityAt ?? currentStep?.startedAt ?? status.startedAt,
    };
}
export function validatePersistedAsyncStatus(asyncDir, status) {
    if (status.sessionId !== undefined && typeof status.sessionId !== "string") {
        throw createAsyncStatusValidationError({
            asyncDir,
            message: "sessionId must be a string.",
            fingerprint: fingerprintAsyncStatusFile(asyncDir),
        });
    }
    if (status.tkTicket !== undefined) {
        const normalizedTkTicket = normalizeTkTicketMetadata(status.tkTicket);
        if (!normalizedTkTicket) {
            throw createAsyncStatusValidationError({
                asyncDir,
                message: "tkTicket must include a valid id and terminal-safe title.",
                fingerprint: fingerprintAsyncStatusFile(asyncDir),
            });
        }
        status.tkTicket = normalizedTkTicket;
    }
}
function statusToSummary(asyncDir, status, nestedWarnings = [], nestedRoute) {
    const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
    const interruptRequestedAt = status.state === "running" ? readInterruptRequest(asyncDir)?.ts : undefined;
    const steps = status.steps ?? [];
    const chainStepCount = status.chainStepCount ?? steps.length;
    const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
    let nestedChildren = [];
    if (nestedWarnings.length === 0 && nestedRoute) {
        try {
            nestedChildren = projectNestedEvents(nestedRoute)?.children ?? [];
        }
        catch (error) {
            nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
        }
    }
    const summarizedSteps = steps.map((step, index) => {
        const stepActivityState = step.activityState;
        const stepLastActivityAt = step.lastActivityAt;
        return {
            index,
            agent: step.agent,
            ...(step.label ? { label: step.label } : {}),
            ...(step.phase ? { phase: step.phase } : {}),
            ...(step.outputName ? { outputName: step.outputName } : {}),
            ...(step.structured ? { structured: step.structured } : {}),
            status: step.status,
            ...(stepActivityState ? { activityState: stepActivityState } : {}),
            ...(stepLastActivityAt ? { lastActivityAt: stepLastActivityAt } : {}),
            ...(step.currentTool ? { currentTool: step.currentTool } : {}),
            ...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
            ...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
            ...(step.currentPath ? { currentPath: step.currentPath } : {}),
            ...(interruptRequestedAt !== undefined && step.status === "running" ? { interruptRequestedAt } : {}),
            ...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
            ...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
            ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
            ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
            ...(step.steerCount !== undefined ? { steerCount: step.steerCount } : {}),
            ...(step.lastSteerAt !== undefined ? { lastSteerAt: step.lastSteerAt } : {}),
            ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
            ...(step.activeRuntimeMs !== undefined ? { activeRuntimeMs: step.activeRuntimeMs } : {}),
            ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
            ...(step.deadlineAt !== undefined ? { deadlineAt: step.deadlineAt } : {}),
            ...(step.tokens ? { tokens: step.tokens } : {}),
            ...(step.totalCost ? { totalCost: step.totalCost } : {}),
            ...(step.skills ? { skills: step.skills } : {}),
            ...(step.model ? { model: step.model } : {}),
            ...(step.thinking ? { thinking: step.thinking } : {}),
            ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
            ...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
            ...(step.error ? { error: step.error } : {}),
            ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
            ...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
            ...(step.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: step.turnBudgetExceeded } : {}),
            ...(step.wrapUpRequested !== undefined ? { wrapUpRequested: step.wrapUpRequested } : {}),
            ...(step.children?.length ? { children: step.children } : {}),
        };
    });
    attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
    const normalizedTkTicket = normalizeTkTicketMetadata(status.tkTicket);
    return {
        id: status.runId || path.basename(asyncDir),
        asyncDir,
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        state: status.state,
        ...(status.error ? { error: status.error } : {}),
        activityState,
        lastActivityAt,
        currentTool: status.currentTool,
        currentToolStartedAt: status.currentToolStartedAt,
        currentPath: status.currentPath,
        ...(interruptRequestedAt !== undefined ? { interruptRequestedAt } : {}),
        turnCount: status.turnCount,
        toolCount: status.toolCount,
        steerCount: status.steerCount,
        lastSteerAt: status.lastSteerAt,
        mode: status.mode,
        cwd: status.cwd,
        startedAt: status.startedAt,
        lastUpdate: status.lastUpdate,
        endedAt: status.endedAt,
        ...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
        ...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
        ...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
        ...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
        ...(status.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: status.turnBudgetExceeded } : {}),
        ...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
        currentStep: status.currentStep,
        ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
        ...(status.pendingAppends !== undefined ? { pendingAppends: status.pendingAppends } : {}),
        ...(parallelGroups.length ? { parallelGroups } : {}),
        steps: summarizedSteps,
        ...(nestedChildren.length ? { nestedChildren } : {}),
        ...(nestedWarnings.length ? { nestedWarnings } : {}),
        ...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
        ...(status.outputFile ? { outputFile: status.outputFile } : {}),
        ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
        ...(status.totalCost ? { totalCost: status.totalCost } : {}),
        ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
        ...(status.pause ? { pause: status.pause } : {}),
        ...(normalizedTkTicket ? { tkTicket: normalizedTkTicket } : {}),
    };
}
function sortRuns(runs) {
    const rank = (state) => {
        switch (state) {
            case "running": return 0;
            case "pausing": return 0;
            case "queued": return 1;
            case "failed": return 2;
            case "paused": return 2;
            case "cancelled": return 2;
            case "continued": return 2;
            case "complete": return 3;
        }
    };
    return [...runs].sort((a, b) => {
        const byState = rank(a.state) - rank(b.state);
        if (byState !== 0)
            return byState;
        const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
        const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
        return bTime - aTime;
    });
}
function listAsyncRunEntries(asyncDirRoot) {
    try {
        return fs.readdirSync(asyncDirRoot).filter((entry) => isAsyncRunDir(asyncDirRoot, entry));
    }
    catch (error) {
        if (isNotFoundError(error))
            return [];
        throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
}
function buildRunCollector(asyncDirRoot, options = {}, validationOrder = "strict") {
    const allowedStates = options.states ? new Set(options.states) : undefined;
    const runs = [];
    let nestedRouteIndex;
    const resolveNestedRoute = (rootRunId) => {
        if (!nestedRouteIndex)
            nestedRouteIndex = buildNestedRouteIndex();
        return nestedRouteIndex.get(rootRunId);
    };
    const collectEntry = (entry) => {
        const asyncDir = path.join(asyncDirRoot, entry);
        const reconciliation = options.reconcile === false
            ? undefined
            : reconcileAsyncRun(asyncDir, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
        const status = (reconciliation?.status ?? readStatus(asyncDir));
        if (!status)
            return;
        if (validationOrder === "restore_scan")
            validatePersistedAsyncStatus(asyncDir, status);
        if (allowedStates && !allowedStates.has(status.state))
            return;
        if (options.sessionId && status.sessionId !== options.sessionId)
            return;
        if (validationOrder === "strict")
            validatePersistedAsyncStatus(asyncDir, status);
        const nestedWarnings = [];
        let nestedRoute;
        try {
            nestedRoute = resolveNestedRoute(status.runId || path.basename(asyncDir));
            if (nestedRoute)
                reconcileNestedAsyncDescendants(nestedRoute, { resultsDir: options.resultsDir, kill: options.kill, now: options.now });
        }
        catch (error) {
            nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
        }
        runs.push(statusToSummary(asyncDir, status, nestedWarnings, nestedRoute));
    };
    return { runs, collectEntry };
}
function finalizeRunList(runs, limit) {
    const sorted = sortRuns(runs);
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
}
export function listAsyncRuns(asyncDirRoot, options = {}) {
    const entries = listAsyncRunEntries(asyncDirRoot);
    const collector = buildRunCollector(asyncDirRoot, options);
    for (const entry of entries)
        collector.collectEntry(entry);
    return finalizeRunList(collector.runs, options.limit);
}
export function scanAsyncRunsForRestore(asyncDirRoot, options = {}) {
    const entries = listAsyncRunEntries(asyncDirRoot);
    const collector = buildRunCollector(asyncDirRoot, options, "restore_scan");
    const issues = [];
    for (const entry of entries) {
        try {
            collector.collectEntry(entry);
        }
        catch (error) {
            if (!isAsyncStatusCorruptionError(error))
                throw error;
            issues.push(Object.freeze({
                entry,
                asyncDir: error.asyncDir,
                statusPath: error.statusPath,
                kind: error.kind,
                message: error.message,
                ...(error.fingerprint ? { fingerprint: error.fingerprint } : {}),
            }));
        }
    }
    return { runs: finalizeRunList(collector.runs, options.limit), issues };
}
function formatActivityFacts(input) {
    if (input.interruptRequestedAt !== undefined)
        return "pausing…";
    const facts = [];
    if (input.currentTool && input.currentToolStartedAt !== undefined)
        facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
    else if (input.currentTool)
        facts.push(`tool ${input.currentTool}`);
    if (!input.privacySafe && input.currentPath)
        facts.push(shortenPath(input.currentPath));
    if (input.turnCount !== undefined)
        facts.push(`${input.turnCount} turns`);
    if (input.turnBudgetExceeded && input.turnBudget)
        facts.push(`turn budget exceeded ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
    else if (input.wrapUpRequested && input.turnBudget)
        facts.push(`wrap-up requested ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}`);
    else if (input.turnBudget)
        facts.push(`turn budget ${input.turnBudget.turnCount}/${input.turnBudget.maxTurns}+${input.turnBudget.graceTurns}`);
    if (input.toolCount !== undefined)
        facts.push(`${input.toolCount} tools`);
    if (input.steerCount !== undefined)
        facts.push(`${input.steerCount} steers`);
    if (typeof input.lastSteerAt === "number" && Number.isFinite(input.lastSteerAt))
        facts.push(`last steer ${new Date(input.lastSteerAt).toISOString()}`);
    const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
    return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}
function formatStepLine(step, privacySafe = false) {
    const display = step.label ? `${step.label} (${step.agent})` : step.agent;
    const phase = step.phase ? `[${step.phase}] ` : "";
    const parts = [`${step.index + 1}. ${phase}${display}`, step.interruptRequestedAt !== undefined && step.status === "running" ? "pausing" : step.status];
    const activity = formatActivityFacts({ ...step, privacySafe });
    if (activity)
        parts.push(activity);
    const modelThinking = formatModelThinking(step.model, step.thinking);
    if (modelThinking)
        parts.push(modelThinking);
    if (step.durationMs !== undefined)
        parts.push(formatDuration(step.durationMs));
    if (step.tokens)
        parts.push(`${formatTokens(step.tokens.total)} tok`);
    return parts.join(" | ");
}
export function formatAsyncRunOutputPath(run) {
    if (!run.outputFile)
        return undefined;
    return path.isAbsolute(run.outputFile) ? run.outputFile : path.join(run.asyncDir, run.outputFile);
}
export function formatAsyncRunProgressLabel(run) {
    const stepCount = run.steps.length || 1;
    const chainStepCount = run.chainStepCount ?? stepCount;
    const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, chainStepCount);
    const activeGroup = run.currentStep !== undefined
        ? groups.find((group) => run.currentStep >= group.start && run.currentStep < group.start + group.count)
        : undefined;
    if (activeGroup) {
        const groupSteps = run.steps.slice(activeGroup.start, activeGroup.start + activeGroup.count);
        if (run.interruptRequestedAt !== undefined) {
            const pausing = groupSteps.filter((step) => step.status === "running").length;
            const done = groupSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
            const groupLabel = `${pausing === 1 ? "1 agent pausing" : `${pausing} agents pausing`} · ${done}/${activeGroup.count} done`;
            return run.mode === "parallel" ? groupLabel : `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
        }
        const groupLabel = formatParallelOutcome(groupSteps, activeGroup.count, { showRunning: run.state === "running" });
        if (run.mode === "parallel")
            return groupLabel;
        return `step ${activeGroup.stepIndex + 1}/${chainStepCount} · parallel group: ${groupLabel}`;
    }
    if (run.mode === "parallel") {
        if (run.interruptRequestedAt !== undefined) {
            const pausing = run.steps.filter((step) => step.status === "running").length;
            const done = run.steps.filter((step) => step.status === "complete" || step.status === "completed").length;
            return `${pausing === 1 ? "1 agent pausing" : `${pausing} agents pausing`} · ${done}/${stepCount} done`;
        }
        return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
    }
    if (run.mode === "chain" && run.currentStep !== undefined && groups.length > 0) {
        const logicalStep = flatToLogicalStepIndex(run.currentStep, chainStepCount, groups);
        return `step ${logicalStep + 1}/${chainStepCount}`;
    }
    return run.currentStep !== undefined ? `step ${run.currentStep + 1}/${stepCount}` : `steps ${stepCount}`;
}
function formatRunHeader(run) {
    const privacySafe = isProtectedPausedLifecycle(run);
    const stepLabel = formatAsyncRunProgressLabel(run);
    const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
    const activity = formatActivityFacts({ ...run, privacySafe });
    const pending = run.pendingAppends ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}` : "";
    const lifecycleState = run.state === "pausing" || (run.interruptRequestedAt !== undefined && run.state === "running") ? "pausing" : run.state;
    return privacySafe
        ? `${run.id} | ${lifecycleState}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel}${pending}`
        : `${run.id} | ${lifecycleState}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${stepLabel}${pending} | ${cwd}`;
}
export function formatAsyncRunList(runs, heading = "Active async runs") {
    if (runs.length === 0)
        return `No ${heading.toLowerCase()}.`;
    const lines = [`${heading}: ${runs.length}`, ""];
    for (const run of runs) {
        const privacySafe = isProtectedPausedLifecycle(run);
        lines.push(`- ${formatRunHeader(run)}`);
        for (const step of run.steps) {
            lines.push(`  ${formatStepLine(step, privacySafe)}`);
            lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", maxLines: 12, redactSensitiveDetails: privacySafe }));
        }
        const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
        const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
        lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", maxLines: 12, redactSensitiveDetails: privacySafe }));
        if (run.error)
            lines.push(`  Error: ${privacySafe ? protectedLifecycleText("error") : run.error}`);
        for (const warning of run.nestedWarnings ?? [])
            lines.push(`  Warning: ${privacySafe ? protectedLifecycleText("nested_warning") : warning}`);
        const outputPath = formatAsyncRunOutputPath(run);
        if (!privacySafe && outputPath)
            lines.push(`  output: ${shortenPath(outputPath)}`);
        if (!privacySafe && run.sessionFile)
            lines.push(`  session: ${shortenPath(run.sessionFile)}`);
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
