import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.js";
import { formatControlNoticeMessage } from "../shared/subagent-control.js";
import { POLL_INTERVAL_MS, RESULTS_DIR, SUBAGENT_CONTROL_EVENT, SUBAGENT_CONTROL_INTERCOM_EVENT, } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { normalizeParallelGroups } from "./parallel-groups.js";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.js";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection } from "../shared/nested-events.js";
import { scanAsyncRunsForRestore } from "./async-status.js";
import { quarantineCorruptAsyncRun } from "./async-status-quarantine.js";
import { normalizeTkTicketMetadata } from "../shared/tk-ticket.js";
const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
export function createAsyncJobTracker(pi, state, asyncDirRoot, options = {}) {
    const completionRetentionMs = options.completionRetentionMs ?? 10000;
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const resultsDir = options.resultsDir ?? RESULTS_DIR;
    const restoreWarningDedupe = new Set();
    const rerenderWidget = (ctx, jobs = Array.from(state.asyncJobs.values())) => {
        renderWidget(ctx, jobs, state.liveDetailController);
    };
    const restoredControlEventCursor = (asyncDir) => {
        try {
            return fs.statSync(path.join(asyncDir, "events.jsonl")).size;
        }
        catch (error) {
            if (error.code === "ENOENT")
                return 0;
            throw error;
        }
    };
    const summaryToJob = (run) => {
        const groups = normalizeParallelGroups(run.parallelGroups, run.steps.length, run.chainStepCount ?? run.steps.length);
        const activeGroup = run.currentStep !== undefined
            ? groups.find((group) => run.currentStep >= group.start && run.currentStep < group.start + group.count)
            : undefined;
        const visibleSteps = activeGroup
            ? run.steps
                .slice(activeGroup.start, activeGroup.start + activeGroup.count)
                .map((step, index) => ({ ...step, index: activeGroup.start + index }))
            : run.steps.map((step, index) => ({ ...step, index }));
        return {
            asyncId: run.id,
            asyncDir: run.asyncDir,
            status: run.state,
            sessionId: run.sessionId,
            activityState: run.activityState,
            lastActivityAt: run.lastActivityAt,
            currentTool: run.currentTool,
            currentToolStartedAt: run.currentToolStartedAt,
            currentPath: run.currentPath,
            turnCount: run.turnCount,
            toolCount: run.toolCount,
            mode: run.mode,
            agents: visibleSteps.map((step) => step.agent),
            currentStep: run.currentStep,
            chainStepCount: run.chainStepCount,
            parallelGroups: groups,
            steps: visibleSteps,
            stepsTotal: visibleSteps.length,
            runningSteps: visibleSteps.filter((step) => step.status === "running").length,
            completedSteps: visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length,
            hasParallelGroups: groups.length > 0,
            activeParallelGroup: Boolean(activeGroup),
            startedAt: run.startedAt,
            updatedAt: run.lastUpdate ?? run.startedAt,
            timeoutMs: run.timeoutMs,
            deadlineAt: run.deadlineAt,
            timedOut: run.timedOut,
            turnBudget: run.turnBudget,
            turnBudgetExceeded: run.turnBudgetExceeded,
            wrapUpRequested: run.wrapUpRequested,
            sessionDir: run.sessionDir,
            outputFile: run.outputFile,
            totalTokens: run.totalTokens,
            sessionFile: run.sessionFile,
            controlEventCursor: restoredControlEventCursor(run.asyncDir),
            nestedChildren: run.nestedChildren,
            tkTicket: run.tkTicket,
        };
    };
    const cancelCleanup = (asyncId) => {
        const existingTimer = state.cleanupTimers.get(asyncId);
        if (!existingTimer)
            return;
        clearTimeout(existingTimer);
        state.cleanupTimers.delete(asyncId);
    };
    const scheduleCleanup = (asyncId) => {
        cancelCleanup(asyncId);
        const timer = setTimeout(() => {
            state.cleanupTimers.delete(asyncId);
            state.asyncJobs.delete(asyncId);
            if (state.lastUiContext) {
                rerenderWidget(state.lastUiContext);
            }
        }, completionRetentionMs);
        state.cleanupTimers.set(asyncId, timer);
    };
    const formatRestoreIssueCounts = (counts) => {
        const parts = [];
        if (counts.jsonParse > 0)
            parts.push(`${counts.jsonParse} malformed JSON`);
        if (counts.persistedValidation > 0)
            parts.push(`${counts.persistedValidation} invalid persisted status`);
        return parts.join(", ");
    };
    const formatRestoredActiveJobsCount = (count) => `restored ${count} valid active ${count === 1 ? "job" : "jobs"}`;
    const warnRestoreIssues = (message) => {
        console.warn(message);
    };
    const emitNewControlEvents = (job) => {
        const eventsPath = path.join(job.asyncDir, "events.jsonl");
        let fd;
        try {
            fd = fs.openSync(eventsPath, "r");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
            return;
        }
        try {
            const stat = fs.fstatSync(fd);
            const savedCursor = job.controlEventCursor;
            let cursor = stat.size < (savedCursor ?? 0) ? 0 : (savedCursor ?? 0);
            const startedFromTail = savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
            if (startedFromTail)
                cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
            if (stat.size <= cursor)
                return;
            const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
            const handleLine = (line) => {
                if (!line.trim())
                    return;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch (error) {
                    console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
                    return;
                }
                if (!parsed || typeof parsed !== "object" || parsed.type !== "subagent.control")
                    return;
                const record = parsed;
                if (!record.event || !Array.isArray(record.channels))
                    return;
                const payload = {
                    event: record.event,
                    source: "async",
                    asyncDir: job.asyncDir,
                    childIntercomTarget: record.childIntercomTarget,
                    noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
                };
                if (record.channels.includes("event")) {
                    pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
                }
                if (record.event.type !== "active_long_running" &&
                    record.channels.includes("intercom") &&
                    record.intercom?.to &&
                    record.intercom.message) {
                    pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
                        ...payload,
                        to: record.intercom.to,
                        message: record.intercom.message,
                    });
                }
            };
            let readCursor = cursor;
            let lastCompleteCursor = cursor;
            let lineParts = [];
            let lineBytes = 0;
            let skippingOversizedLine = startedFromTail;
            const appendLineSegment = (segment) => {
                if (segment.length === 0 || skippingOversizedLine)
                    return;
                if (lineBytes + segment.length > MAX_CONTROL_EVENT_LINE_BYTES) {
                    lineParts = [];
                    lineBytes = 0;
                    skippingOversizedLine = true;
                    return;
                }
                lineParts.push(segment);
                lineBytes += segment.length;
            };
            while (readCursor < scanEnd) {
                const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, scanEnd - readCursor);
                const buffer = Buffer.alloc(toRead);
                const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
                if (bytesRead <= 0)
                    break;
                const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
                let lineStart = 0;
                for (let index = 0; index < chunk.length; index++) {
                    if (chunk[index] !== 0x0a)
                        continue;
                    appendLineSegment(chunk.subarray(lineStart, index));
                    if (!skippingOversizedLine && lineBytes > 0) {
                        handleLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
                    }
                    lineParts = [];
                    lineBytes = 0;
                    skippingOversizedLine = false;
                    lastCompleteCursor = readCursor + index + 1;
                    lineStart = index + 1;
                }
                appendLineSegment(chunk.subarray(lineStart));
                readCursor += bytesRead;
                if (skippingOversizedLine)
                    job.controlEventCursor = readCursor;
            }
            if (lastCompleteCursor > cursor)
                job.controlEventCursor = lastCompleteCursor;
            else if (scanEnd < stat.size || startedFromTail)
                job.controlEventCursor = scanEnd;
        }
        catch (error) {
            console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
        }
        finally {
            fs.closeSync(fd);
        }
    };
    const ensurePoller = () => {
        if (state.poller)
            return;
        state.poller = setInterval(() => {
            if (state.asyncJobs.size === 0) {
                if (state.lastUiContext?.hasUI)
                    rerenderWidget(state.lastUiContext, []);
                if (state.poller) {
                    clearInterval(state.poller);
                    state.poller = null;
                }
                return;
            }
            let widgetChanged = false;
            for (const job of state.asyncJobs.values()) {
                const widgetStateBefore = widgetRenderKey(job);
                let nestedRefreshFailed = false;
                const refreshNestedProjection = () => {
                    try {
                        updateAsyncJobNestedProjection(job);
                    }
                    catch (error) {
                        nestedRefreshFailed = true;
                        console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
                    }
                };
                const reconcileNestedDescendants = () => {
                    try {
                        if (job.nestedRoute)
                            reconcileNestedAsyncDescendants(job.nestedRoute, { resultsDir, kill: options.kill, now: options.now });
                    }
                    catch (error) {
                        nestedRefreshFailed = true;
                        console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
                    }
                    refreshNestedProjection();
                };
                try {
                    emitNewControlEvents(job);
                    reconcileNestedDescendants();
                    const reconciliation = reconcileAsyncRun(job.asyncDir, {
                        resultsDir,
                        kill: options.kill,
                        now: options.now,
                        startedRun: {
                            runId: job.asyncId,
                            pid: job.pid,
                            sessionId: job.sessionId,
                            mode: job.mode,
                            agents: job.agents,
                            chainStepCount: job.chainStepCount,
                            parallelGroups: job.parallelGroups,
                            startedAt: job.startedAt,
                            sessionFile: job.sessionFile,
                        },
                    });
                    const status = reconciliation.status ?? readStatus(job.asyncDir);
                    if (status) {
                        const previousStatus = job.status;
                        job.status = status.state;
                        if (job.status !== "complete" && job.status !== "failed" && job.status !== "paused")
                            cancelCleanup(job.asyncId);
                        job.sessionId = status.sessionId ?? job.sessionId;
                        job.activityState = status.activityState;
                        job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
                        job.currentTool = status.currentTool;
                        job.currentToolStartedAt = status.currentToolStartedAt;
                        job.currentPath = status.currentPath;
                        job.turnCount = status.turnCount ?? job.turnCount;
                        job.toolCount = status.toolCount ?? job.toolCount;
                        job.mode = status.mode;
                        job.currentStep = status.currentStep ?? job.currentStep;
                        job.chainStepCount = status.chainStepCount ?? job.chainStepCount;
                        job.startedAt = status.startedAt ?? job.startedAt;
                        if (status.lastUpdate !== undefined)
                            job.updatedAt = status.lastUpdate;
                        if (status.steps?.length) {
                            const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length, status.chainStepCount ?? status.steps.length);
                            job.parallelGroups = groups.length ? groups : job.parallelGroups;
                            job.hasParallelGroups = groups.length > 0 || job.hasParallelGroups;
                            const activeGroup = status.currentStep !== undefined
                                ? groups.find((group) => status.currentStep >= group.start && status.currentStep < group.start + group.count)
                                : undefined;
                            const visibleSteps = activeGroup
                                ? status.steps
                                    .slice(activeGroup.start, activeGroup.start + activeGroup.count)
                                    .map((step, index) => ({ ...step, index: activeGroup.start + index }))
                                : status.steps.map((step, index) => ({ ...step, index }));
                            job.activeParallelGroup = Boolean(activeGroup);
                            job.agents = visibleSteps.map((step) => step.agent);
                            job.steps = visibleSteps;
                            refreshNestedProjection();
                            job.stepsTotal = visibleSteps.length;
                            job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
                            job.completedSteps = visibleSteps.filter((step) => step.status === "complete" || step.status === "completed").length;
                            if (status.state === "complete")
                                job.completedSteps = visibleSteps.length;
                        }
                        job.sessionDir = status.sessionDir ?? job.sessionDir;
                        job.outputFile = status.outputFile ?? job.outputFile;
                        job.totalTokens = status.totalTokens ?? job.totalTokens;
                        job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
                        job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
                        job.timedOut = status.timedOut ?? job.timedOut;
                        job.turnBudget = status.turnBudget ?? job.turnBudget;
                        job.turnBudgetExceeded = status.turnBudgetExceeded ?? job.turnBudgetExceeded;
                        job.wrapUpRequested = status.wrapUpRequested ?? job.wrapUpRequested;
                        job.sessionFile = status.sessionFile ?? job.sessionFile;
                        if (status.tkTicket !== undefined)
                            job.tkTicket = normalizeTkTicketMetadata(status.tkTicket);
                        if ((job.status === "complete" || job.status === "failed" || job.status === "paused") &&
                            !nestedRefreshFailed &&
                            !hasLiveNestedDescendants(job.nestedChildren) &&
                            (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
                            scheduleCleanup(job.asyncId);
                        }
                        if (widgetRenderKey(job) !== widgetStateBefore)
                            widgetChanged = true;
                        continue;
                    }
                    if (job.status === "queued") {
                        job.status = "running";
                        job.updatedAt = Date.now();
                    }
                }
                catch (error) {
                    if (job.status !== "failed") {
                        console.error(`Failed to read async status for '${job.asyncDir}':`, error);
                        job.status = "failed";
                        job.updatedAt = Date.now();
                    }
                    if (!hasLiveNestedDescendants(job.nestedChildren) && !state.cleanupTimers.has(job.asyncId)) {
                        scheduleCleanup(job.asyncId);
                    }
                }
                if (widgetRenderKey(job) !== widgetStateBefore)
                    widgetChanged = true;
            }
            if (widgetChanged && state.lastUiContext?.hasUI)
                rerenderWidget(state.lastUiContext);
        }, pollIntervalMs);
        state.poller.unref?.();
    };
    const handleStarted = (data) => {
        const info = data;
        if (!info.id)
            return;
        if (typeof state.currentSessionId === "string" && info.sessionId !== state.currentSessionId)
            return;
        const now = Date.now();
        const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
        const rawAgents = info.agents?.length
            ? info.agents
            : info.chain && info.chain.length > 0
                ? info.chain
                : info.agent
                    ? [info.agent]
                    : undefined;
        const validParallelGroups = normalizeParallelGroups(info.parallelGroups, Number.MAX_SAFE_INTEGER, info.chainStepCount ?? Number.MAX_SAFE_INTEGER);
        const firstGroup = validParallelGroups.find((group) => group.start === 0);
        const firstGroupCount = firstGroup?.count;
        const agents = firstGroupCount && firstGroupCount > 0 ? rawAgents?.slice(0, firstGroupCount) : rawAgents;
        const normalizedTkTicket = normalizeTkTicketMetadata(info.tkTicket);
        state.asyncJobs.set(info.id, {
            asyncId: info.id,
            asyncDir,
            status: "queued",
            pid: typeof info.pid === "number" ? info.pid : undefined,
            ...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
            mode: info.mode ?? (info.chain ? "chain" : "single"),
            agents,
            chainStepCount: info.chainStepCount,
            parallelGroups: validParallelGroups,
            nestedRoute: info.nestedRoute,
            stepsTotal: firstGroupCount ?? agents?.length,
            hasParallelGroups: validParallelGroups.length > 0,
            activeParallelGroup: Boolean(firstGroupCount && firstGroupCount > 0),
            startedAt: now,
            updatedAt: now,
            timeoutMs: info.timeoutMs,
            deadlineAt: info.deadlineAt,
            turnBudget: info.turnBudget,
            controlEventCursor: 0,
            tkTicket: normalizedTkTicket,
        });
        ensurePoller();
        if (state.lastUiContext) {
            rerenderWidget(state.lastUiContext);
        }
    };
    const handleComplete = (data) => {
        const result = data;
        if (typeof state.currentSessionId === "string" && result.sessionId !== state.currentSessionId)
            return;
        const asyncId = result.id;
        if (!asyncId)
            return;
        const job = state.asyncJobs.get(asyncId);
        let nestedRefreshFailed = false;
        if (job) {
            job.status = result.success ? "complete" : "failed";
            job.updatedAt = Date.now();
            if (result.asyncDir)
                job.asyncDir = result.asyncDir;
            try {
                updateAsyncJobNestedProjection(job);
            }
            catch (error) {
                nestedRefreshFailed = true;
                console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
            }
        }
        if (state.lastUiContext) {
            rerenderWidget(state.lastUiContext);
        }
        if (!nestedRefreshFailed && !hasLiveNestedDescendants(job?.nestedChildren))
            scheduleCleanup(asyncId);
    };
    const resetJobs = (ctx) => {
        for (const timer of state.cleanupTimers.values()) {
            clearTimeout(timer);
        }
        state.cleanupTimers.clear();
        state.asyncJobs.clear();
        state.foregroundControls?.clear();
        state.lastForegroundControlId = null;
        state.resultFileCoalescer.clear();
        if (ctx?.hasUI) {
            state.lastUiContext = ctx;
            rerenderWidget(ctx, []);
        }
    };
    const restoreActiveJobs = (ctx) => {
        if (ctx?.hasUI)
            state.lastUiContext = ctx;
        if (!state.currentSessionId)
            return;
        let runs;
        let issues;
        try {
            ({ runs, issues } = scanAsyncRunsForRestore(asyncDirRoot, {
                states: ["queued", "running"],
                sessionId: state.currentSessionId,
                resultsDir,
                kill: options.kill,
                now: options.now,
            }));
        }
        catch (error) {
            console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
            return;
        }
        const quarantined = { jsonParse: 0, persistedValidation: 0 };
        const deferred = { jsonParse: 0, persistedValidation: 0 };
        const failed = { jsonParse: 0, persistedValidation: 0 };
        for (const issue of issues) {
            const result = quarantineCorruptAsyncRun(asyncDirRoot, issue, options.quarantine);
            if (result.outcome === "quarantined") {
                if (result.kind === "json_parse")
                    quarantined.jsonParse += 1;
                else
                    quarantined.persistedValidation += 1;
                continue;
            }
            if ((result.outcome === "deferred" || result.outcome === "failed") &&
                !restoreWarningDedupe.has(result.dedupeKey)) {
                restoreWarningDedupe.add(result.dedupeKey);
                const bucket = result.outcome === "deferred" ? deferred : failed;
                if (result.kind === "json_parse")
                    bucket.jsonParse += 1;
                else
                    bucket.persistedValidation += 1;
            }
        }
        const warnings = [formatRestoredActiveJobsCount(runs.length)];
        const quarantinedSummary = formatRestoreIssueCounts(quarantined);
        if (quarantinedSummary)
            warnings.push(`quarantined ${quarantinedSummary}`);
        const deferredSummary = formatRestoreIssueCounts(deferred);
        if (deferredSummary)
            warnings.push(`deferred ${deferredSummary}`);
        const failedSummary = formatRestoreIssueCounts(failed);
        if (failedSummary)
            warnings.push(`left ${failedSummary} in place`);
        if (warnings.length > 1)
            warnRestoreIssues(`Async restore skipped corrupt startup runs: ${warnings.join("; ")}.`);
        for (const run of runs) {
            state.asyncJobs.set(run.id, summaryToJob(run));
        }
        if (runs.length === 0)
            return;
        ensurePoller();
        if (state.lastUiContext?.hasUI)
            rerenderWidget(state.lastUiContext);
    };
    return { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs };
}
