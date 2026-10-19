import * as fs from "node:fs";
import * as path from "node:path";
import { formatDuration, formatModelThinking, formatTokens, shortenPath, } from "../../shared/formatters.js";
import { formatActivityLabel, formatParallelOutcome } from "../../shared/status-format.js";
import { parsePersistedChildLocationSnapshot, } from "../../shared/child-location.js";
import { normalizeSubagentRunMode, } from "../../shared/types.js";
import { readInterruptRequest } from "./control-channel.js";
import { readStatus } from "../../shared/utils.js";
import { reconcileAsyncRun } from "./stale-run-reconciler.js";
import { formatUnreadableStatus, isAsyncStatusReadError, MAX_UNREADABLE_STATUS_REPORTS, } from "./async-status-boundary.js";
import { isProtectedPausedLifecycle, protectedLifecycleText } from "../shared/lifecycle-privacy.js";
import { isCompletedLifecycleStepState } from "../shared/lifecycle-state.js";
import { safeTerminalDocument, safeTerminalText } from "../../shared/display-text.js";
import { normalizeSubagentRunTelemetry } from "../../shared/telemetry.js";
function sanitizeTkTicketTitle(raw) {
    let cleaned = "";
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        if (code === 0x1b) {
            const next = raw.charCodeAt(++i);
            if (next === 0x5b) {
                while (++i < raw.length) {
                    const fc = raw.charCodeAt(i);
                    if (fc >= 0x40 && fc <= 0x7e)
                        break;
                }
            }
            else if (next === 0x5d) {
                while (++i < raw.length) {
                    const sc = raw.charCodeAt(i);
                    if (sc === 0x07)
                        break;
                    if (sc === 0x1b && raw.charCodeAt(i + 1) === 0x5c) {
                        i++;
                        break;
                    }
                }
            }
            continue;
        }
        if (code <= 0x08 ||
            code === 0x0b ||
            code === 0x0c ||
            (code >= 0x0e && code <= 0x1f) ||
            (code >= 0x7f && code <= 0x9f)) {
            cleaned += " ";
            continue;
        }
        cleaned += raw[i];
    }
    const trimmed = cleaned.replace(/\s+/g, " ").trim();
    return trimmed || undefined;
}
function normalizeTkTicketMetadata(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const r = raw;
    const id = typeof r.id === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(r.id) ? r.id : undefined;
    if (!id)
        return undefined;
    if (typeof r.title !== "string")
        return undefined;
    const title = sanitizeTkTicketTitle(r.title);
    if (!title)
        return undefined;
    return { id, title };
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isNotFoundError(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
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
function latestTimestamp(...values) {
    const finite = values.filter((value) => value !== undefined && Number.isFinite(value));
    return finite.length ? Math.max(...finite) : undefined;
}
function deriveAsyncActivityState(asyncDir, status) {
    if (status.state !== "running")
        return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
    const outputPath = status.outputFile
        ? path.isAbsolute(status.outputFile)
            ? status.outputFile
            : path.join(asyncDir, status.outputFile)
        : undefined;
    const currentStep = typeof status.currentStep === "number" ? status.steps?.[status.currentStep] : undefined;
    return {
        activityState: status.activityState,
        lastActivityAt: latestTimestamp(status.startedAt, status.lastActivityAt, outputFileMtime(outputPath), currentStep?.startedAt, currentStep?.lastActivityAt),
    };
}
export function validatePersistedAsyncStatus(asyncDir, status) {
    status.telemetry = normalizeSubagentRunTelemetry(status.telemetry);
    for (const step of status.steps ?? []) {
        step.childLocation = parsePersistedChildLocationSnapshot(step.childLocation);
    }
}
function statusToSummary(asyncDir, status) {
    const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
    const interruptRequestedAt = status.state === "running" ? readInterruptRequest(asyncDir)?.ts : undefined;
    const steps = status.steps ?? [];
    const summarizedSteps = steps.map((step, index) => {
        const stepActivityState = step.activityState;
        const stepLastActivityAt = latestTimestamp(step.startedAt, step.lastActivityAt);
        return {
            index,
            agent: step.agent,
            ...(step.ticketId ? { ticketId: step.ticketId } : {}),
            status: step.status,
            ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
            ...(stepActivityState ? { activityState: stepActivityState } : {}),
            ...(step.idleEpisodeId ? { idleEpisodeId: step.idleEpisodeId } : {}),
            ...(step.compaction ? { compaction: { ...step.compaction } } : {}),
            ...(stepLastActivityAt !== undefined ? { lastActivityAt: stepLastActivityAt } : {}),
            ...(step.currentTool ? { currentTool: step.currentTool } : {}),
            ...(step.currentToolArgs ? { currentToolArgs: step.currentToolArgs } : {}),
            ...(step.currentToolStartedAt ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
            ...(step.currentPath ? { currentPath: step.currentPath } : {}),
            ...(interruptRequestedAt !== undefined && step.status === "running"
                ? { interruptRequestedAt }
                : {}),
            ...(step.recentTools ? { recentTools: step.recentTools.map((tool) => ({ ...tool })) } : {}),
            ...(step.recentOutput ? { recentOutput: [...step.recentOutput] } : {}),
            ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
            ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
            ...(step.steerCount !== undefined ? { steerCount: step.steerCount } : {}),
            ...(step.lastSteerAt !== undefined ? { lastSteerAt: step.lastSteerAt } : {}),
            ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
            ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
            ...(step.deadlineAt !== undefined ? { deadlineAt: step.deadlineAt } : {}),
            ...(step.tokens ? { tokens: step.tokens } : {}),
            ...(step.totalCost ? { totalCost: step.totalCost } : {}),
            ...(step.skills ? { skills: step.skills } : {}),
            ...(step.skillsWarning ? { skillsWarning: step.skillsWarning } : {}),
            ...(step.model ? { model: step.model } : {}),
            ...(step.thinking ? { thinking: step.thinking } : {}),
            ...(step.modelIdentity ? { modelIdentity: step.modelIdentity } : {}),
            ...(step.modelResolution ? { modelResolution: step.modelResolution } : {}),
            ...(step.contextUsage ? { contextUsage: step.contextUsage } : {}),
            ...(step.contextPressure ? { contextPressure: step.contextPressure } : {}),
            ...(step.contextPressureCrossedThresholds
                ? { contextPressureCrossedThresholds: [...step.contextPressureCrossedThresholds] }
                : {}),
            ...(step.terminationReason ? { terminationReason: step.terminationReason } : {}),
            ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
            ...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
            ...(step.error ? { error: step.error } : {}),
            ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
            ...(step.childLocation ? { childLocation: step.childLocation } : {}),
        };
    });
    const normalizedTkTicket = normalizeTkTicketMetadata(status.tkTicket);
    const telemetry = normalizeSubagentRunTelemetry(status.telemetry);
    return {
        id: status.runId || path.basename(asyncDir),
        asyncDir,
        ...(status.awaited ? { awaited: true } : {}),
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        ...(typeof status.pid === "number" ? { pid: status.pid } : {}),
        state: status.state,
        ...(status.lifecycle ? { lifecycle: status.lifecycle } : {}),
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
        mode: normalizeSubagentRunMode(status.mode),
        cwd: status.cwd,
        startedAt: status.startedAt,
        lastUpdate: status.lastUpdate,
        endedAt: status.endedAt,
        ...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
        ...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
        ...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
        currentStep: status.currentStep,
        ...(status.pendingAppends !== undefined ? { pendingAppends: status.pendingAppends } : {}),
        steps: summarizedSteps,
        ...(status.sessionDir ? { sessionDir: status.sessionDir } : {}),
        ...(status.outputFile ? { outputFile: status.outputFile } : {}),
        ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
        ...(status.totalCost ? { totalCost: status.totalCost } : {}),
        ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
        ...(status.pause ? { pause: status.pause } : {}),
        ...(status.projectAgents ? { projectAgents: status.projectAgents } : {}),
        ...(telemetry ? { telemetry } : {}),
        ...(normalizedTkTicket !== undefined ? { tkTicket: normalizedTkTicket } : {}),
    };
}
function sortRuns(runs) {
    const rank = (state) => {
        switch (state) {
            case "running":
                return 0;
            case "pausing":
                return 0;
            case "queued":
                return 1;
            case "failed":
                return 2;
            case "paused":
                return 2;
            case "cancelled":
                return 2;
            case "complete":
            default:
                return 3;
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
    const reportUnreadable = (entry, error) => {
        const issue = Object.freeze({
            entry,
            asyncDir: error.asyncDir,
            statusPath: error.statusPath,
        });
        options.onUnreadable?.(issue);
    };
    const collectEntry = (entry) => {
        const asyncDir = path.join(asyncDirRoot, entry);
        try {
            const reconciliation = options.reconcile === false
                ? undefined
                : reconcileAsyncRun(asyncDir, {
                    resultsDir: options.resultsDir,
                    kill: options.kill,
                    now: options.now,
                    statusRead: options.statusRead,
                });
            const status = (reconciliation?.status ?? readStatus(asyncDir, options.statusRead));
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
            runs.push(statusToSummary(asyncDir, status));
        }
        catch (error) {
            if (!isAsyncStatusReadError(error))
                throw error;
            if (error.failure === "non_regular") {
                options.onUnsafe?.(Object.freeze({ entry }));
            }
            reportUnreadable(entry, error);
        }
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
    const issues = [];
    const unsafeIssues = [];
    const collector = buildRunCollector(asyncDirRoot, {
        ...options,
        onUnreadable: (issue) => {
            issues.push(issue);
            options.onUnreadable?.(issue);
        },
        onUnsafe: (issue) => {
            unsafeIssues.push(issue);
            options.onUnsafe?.(issue);
        },
    });
    for (const entry of entries)
        collector.collectEntry(entry);
    return { runs: finalizeRunList(collector.runs, options.limit), issues, unsafeIssues };
}
function formatActivityFacts(input) {
    if (input.interruptRequestedAt !== undefined)
        return "pausing…";
    const facts = [];
    const currentTool = input.currentTool ? safeTerminalText(input.currentTool) : undefined;
    if (currentTool && input.currentToolStartedAt !== undefined)
        facts.push(`tool ${currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
    else if (currentTool)
        facts.push(`tool ${currentTool}`);
    if (!input.privacySafe && input.currentPath)
        facts.push(safeTerminalText(shortenPath(input.currentPath)));
    if (input.turnCount !== undefined)
        facts.push(`${input.turnCount} turns`);
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
    const agent = safeTerminalText(step.agent);
    const parts = [
        `${step.index + 1}. ${agent}`,
        step.interruptRequestedAt !== undefined && step.status === "running"
            ? "pausing"
            : safeTerminalText(step.status),
    ];
    const activity = formatActivityFacts({ ...step, privacySafe });
    if (activity)
        parts.push(activity);
    const modelThinking = safeTerminalText(formatModelThinking(step.model, step.thinking));
    if (modelThinking)
        parts.push(modelThinking);
    if (step.modelResolution?.reason)
        parts.push(`model decision: ${safeTerminalText(step.modelResolution.reason)}`);
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
    if (run.mode === "parallel") {
        if (run.interruptRequestedAt !== undefined) {
            const pausing = run.steps.filter((step) => step.status === "running").length;
            const done = run.steps.filter((step) => isCompletedLifecycleStepState(step.status)).length;
            return `${pausing === 1 ? "1 agent pausing" : `${pausing} agents pausing`} · ${done}/${stepCount} done`;
        }
        return formatParallelOutcome(run.steps, stepCount, { showRunning: run.state === "running" });
    }
    return run.currentStep !== undefined
        ? `step ${run.currentStep + 1}/${stepCount}`
        : `steps ${stepCount}`;
}
function formatRunHeader(run) {
    const privacySafe = isProtectedPausedLifecycle(run);
    const stepLabel = safeTerminalText(formatAsyncRunProgressLabel(run));
    const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
    const activity = formatActivityFacts({ ...run, privacySafe });
    const runId = safeTerminalText(run.id);
    const mode = safeTerminalText(normalizeSubagentRunMode(run.mode));
    const pending = run.pendingAppends
        ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}`
        : "";
    const lifecycleState = run.state === "pausing" || (run.interruptRequestedAt !== undefined && run.state === "running")
        ? "pausing"
        : safeTerminalText(run.state);
    const ownership = run.awaited ? " | awaited" : "";
    return privacySafe
        ? `${runId} | ${lifecycleState}${ownership}${activity ? ` | ${activity}` : ""} | ${mode} | ${stepLabel}${pending}`
        : `${runId} | ${lifecycleState}${ownership}${activity ? ` | ${activity}` : ""} | ${mode} | ${stepLabel}${pending} | ${safeTerminalText(cwd)}`;
}
export function formatAsyncRunList(runs, heading = "Active async runs", unreadableStatuses = []) {
    if (runs.length === 0 && unreadableStatuses.length === 0)
        return `No ${safeTerminalText(heading.toLowerCase())}.`;
    const lines = [`${safeTerminalText(heading)}: ${runs.length}`, ""];
    for (const run of runs) {
        const privacySafe = isProtectedPausedLifecycle(run);
        lines.push(`- ${formatRunHeader(run)}`);
        for (const step of run.steps) {
            lines.push(`  ${formatStepLine(step, privacySafe)}`);
        }
        if (run.error)
            lines.push(`  Error: ${privacySafe ? protectedLifecycleText("error") : safeTerminalText(run.error)}`);
        const outputPath = formatAsyncRunOutputPath(run);
        if (!privacySafe && outputPath)
            lines.push(`  output: ${safeTerminalText(shortenPath(outputPath))}`);
        if (!privacySafe && run.sessionFile)
            lines.push(`  session: ${safeTerminalText(shortenPath(run.sessionFile))}`);
        lines.push("");
    }
    for (const issue of unreadableStatuses.slice(0, MAX_UNREADABLE_STATUS_REPORTS)) {
        lines.push(`- ${formatUnreadableStatus(issue.statusPath)}`, "");
    }
    const remaining = unreadableStatuses.length - MAX_UNREADABLE_STATUS_REPORTS;
    if (remaining > 0)
        lines.push(`- and ${remaining} more unreadable statuses`, "");
    return safeTerminalDocument(lines.join("\n").trimEnd());
}
