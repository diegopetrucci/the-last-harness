import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.js";
import { formatControlNoticeMessage, parseControlEvent } from "../shared/subagent-control.js";
import { normalizeSubagentRunMode, POLL_INTERVAL_MS, RESULTS_DIR, SUBAGENT_CONTROL_EVENT, } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.js";
import { hasLiveNestedDescendants, updateAsyncJobNestedProjection, } from "../shared/nested-events.js";
import { scanAsyncRunsForRestore } from "./async-status.js";
import { parsePersistedChildLocationSnapshot } from "../../shared/child-location.js";
import { isAwaitedRun } from "./awaited-run-registry.js";
import { canonicalLifecycleState } from "./async-status-boundary.js";
import { isCompletedLifecycleStepState } from "../shared/lifecycle-state.js";
const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
const COMPLETION_RETENTION_STATES = new Set(["complete", "failed", "paused", "cancelled"]);
function isRecordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function createAsyncJobTracker(pi, state, asyncDirRoot, options = {}) {
    const completionRetentionMs = options.completionRetentionMs ?? 10000;
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const resultsDir = options.resultsDir ?? RESULTS_DIR;
    const restoreWarningDedupe = new Set();
    const restoreControlEventProbeFailures = new Set();
    const eventFs = options.fs ?? fs;
    const rerenderWidget = (ctx, jobs = Array.from(state.asyncJobs.values())) => {
        renderWidget(ctx, jobs, state.liveDetailController);
    };
    const restoredControlEventCursor = (asyncDir) => {
        const eventsPath = path.join(asyncDir, "events.jsonl");
        try {
            const stat = eventFs.statSync(eventsPath);
            let skippingOversizedLine = false;
            if (stat.size > MAX_CONTROL_EVENT_LINE_BYTES) {
                const fd = eventFs.openSync(eventsPath, "r");
                try {
                    const probeStart = Math.max(0, stat.size - MAX_CONTROL_EVENT_LINE_BYTES - 1);
                    let readCursor = probeStart;
                    let lastNewline = -1;
                    while (readCursor < stat.size) {
                        const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, stat.size - readCursor);
                        const buffer = Buffer.alloc(toRead);
                        const bytesRead = eventFs.readSync(fd, buffer, 0, toRead, readCursor);
                        if (bytesRead <= 0)
                            break;
                        for (let index = 0; index < bytesRead; index++) {
                            if (buffer[index] === 0x0a)
                                lastNewline = readCursor + index;
                        }
                        readCursor += bytesRead;
                    }
                    skippingOversizedLine = stat.size - lastNewline - 1 > MAX_CONTROL_EVENT_LINE_BYTES;
                }
                finally {
                    eventFs.closeSync(fd);
                }
            }
            return { cursor: stat.size, identity: `${stat.dev}:${stat.ino}`, skippingOversizedLine };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { cursor: 0, identity: undefined, skippingOversizedLine: false };
            restoreControlEventProbeFailures.add(asyncDir);
            return { cursor: 0, identity: undefined, skippingOversizedLine: false };
        }
    };
    const summaryToJob = (run) => {
        const visibleSteps = run.steps.map((step, index) => ({ ...step, index }));
        return {
            asyncId: run.id,
            asyncDir: run.asyncDir,
            ...(run.awaited ? { awaited: true } : {}),
            status: run.state,
            ...(run.lifecycle ? { lifecycle: run.lifecycle } : {}),
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
            steps: visibleSteps,
            stepsTotal: visibleSteps.length,
            runningSteps: visibleSteps.filter((step) => step.status === "running").length,
            completedSteps: visibleSteps.filter((step) => isCompletedLifecycleStepState(step.status))
                .length,
            startedAt: run.startedAt,
            updatedAt: run.lastUpdate ?? run.startedAt,
            timeoutMs: run.timeoutMs,
            deadlineAt: run.deadlineAt,
            timedOut: run.timedOut,
            sessionDir: run.sessionDir,
            outputFile: run.outputFile,
            totalTokens: run.totalTokens,
            sessionFile: run.sessionFile,
            ...(() => {
                const restoredCursor = restoredControlEventCursor(run.asyncDir);
                return {
                    controlEventCursor: restoredCursor.cursor,
                    controlEventFileIdentity: restoredCursor.identity,
                    controlEventSkippingOversizedLine: restoredCursor.skippingOversizedLine,
                };
            })(),
            nestedChildren: run.nestedChildren,
            projectAgents: run.projectAgents,
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
            const fileIdentity = `${stat.dev}:${stat.ino}`;
            const savedCursor = job.controlEventCursor;
            const fileReplaced = job.controlEventFileIdentity !== undefined && job.controlEventFileIdentity !== fileIdentity;
            const cursorInvalid = fileReplaced || stat.size < (savedCursor ?? 0);
            let cursor = cursorInvalid ? 0 : (savedCursor ?? 0);
            const startedFromTail = !cursorInvalid && savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
            if (startedFromTail)
                cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
            job.controlEventFileIdentity = fileIdentity;
            if (cursorInvalid)
                job.controlEventSkippingOversizedLine = false;
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
                if (!isRecordValue(parsed) || parsed.type !== "subagent.control")
                    return;
                const channels = parsed.channels;
                const event = parseControlEvent(parsed.event);
                if (!event ||
                    !Array.isArray(channels) ||
                    channels.some((channel) => typeof channel !== "string"))
                    return;
                const noticeText = typeof parsed.noticeText === "string"
                    ? parsed.noticeText
                    : formatControlNoticeMessage(event);
                const payload = {
                    event,
                    source: "async",
                    asyncDir: job.asyncDir,
                    noticeText,
                };
                if (channels.includes("event")) {
                    pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
                }
            };
            let readCursor = cursor;
            let lastCompleteCursor = cursor;
            let lineParts = [];
            let lineBytes = 0;
            let skippingOversizedLine = cursorInvalid
                ? false
                : (job.controlEventSkippingOversizedLine ?? startedFromTail);
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
                if (skippingOversizedLine) {
                    job.controlEventCursor = readCursor;
                    job.controlEventSkippingOversizedLine = true;
                }
            }
            if (skippingOversizedLine) {
                job.controlEventCursor = readCursor;
                job.controlEventSkippingOversizedLine = true;
            }
            else if (lastCompleteCursor > cursor) {
                job.controlEventCursor = lastCompleteCursor;
                job.controlEventSkippingOversizedLine = false;
            }
            else if (scanEnd < stat.size || startedFromTail) {
                job.controlEventCursor = scanEnd;
            }
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
                            reconcileNestedAsyncDescendants(job.nestedRoute, {
                                resultsDir,
                                kill: options.kill,
                                now: options.now,
                                statusRead: options.statusRead,
                            });
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
                        statusRead: options.statusRead,
                    });
                    const status = reconciliation.status ?? readStatus(job.asyncDir, options.statusRead);
                    if (status) {
                        const previousStatus = job.status;
                        if (status.awaited)
                            job.awaited = true;
                        job.status = status.state;
                        job.lifecycle = status.lifecycle;
                        if (!COMPLETION_RETENTION_STATES.has(job.status))
                            cancelCleanup(job.asyncId);
                        job.sessionId = status.sessionId ?? job.sessionId;
                        job.activityState = status.activityState;
                        job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
                        job.currentTool = status.currentTool;
                        job.currentToolStartedAt = status.currentToolStartedAt;
                        job.currentPath = status.currentPath;
                        job.turnCount = status.turnCount ?? job.turnCount;
                        job.toolCount = status.toolCount ?? job.toolCount;
                        job.mode = normalizeSubagentRunMode(status.mode);
                        job.currentStep = status.currentStep ?? job.currentStep;
                        job.startedAt = status.startedAt ?? job.startedAt;
                        if (status.lastUpdate !== undefined)
                            job.updatedAt = status.lastUpdate;
                        if (status.steps?.length) {
                            const visibleSteps = status.steps.map((step, index) => ({
                                ...step,
                                index,
                                childLocation: parsePersistedChildLocationSnapshot(step.childLocation),
                            }));
                            job.agents = visibleSteps.map((step) => step.agent);
                            job.steps = visibleSteps;
                            refreshNestedProjection();
                            job.stepsTotal = visibleSteps.length;
                            job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
                            job.completedSteps = visibleSteps.filter((step) => isCompletedLifecycleStepState(step.status)).length;
                        }
                        job.sessionDir = status.sessionDir ?? job.sessionDir;
                        job.outputFile = status.outputFile ?? job.outputFile;
                        job.totalTokens = status.totalTokens ?? job.totalTokens;
                        job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
                        job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
                        job.timedOut = status.timedOut ?? job.timedOut;
                        job.sessionFile = status.sessionFile ?? job.sessionFile;
                        if (status.projectAgents !== undefined)
                            job.projectAgents = status.projectAgents;
                        const liveNestedDescendants = hasLiveNestedDescendants(job.nestedChildren);
                        if (liveNestedDescendants)
                            cancelCleanup(job.asyncId);
                        if (COMPLETION_RETENTION_STATES.has(job.status) &&
                            !nestedRefreshFailed &&
                            !liveNestedDescendants &&
                            (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))) {
                            scheduleCleanup(job.asyncId);
                        }
                        if (widgetRenderKey(job) !== widgetStateBefore)
                            widgetChanged = true;
                        continue;
                    }
                    const liveNestedDescendants = hasLiveNestedDescendants(job.nestedChildren);
                    if (liveNestedDescendants) {
                        cancelCleanup(job.asyncId);
                    }
                    else if (COMPLETION_RETENTION_STATES.has(job.status) &&
                        !state.cleanupTimers.has(job.asyncId)) {
                        scheduleCleanup(job.asyncId);
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
                    if (hasLiveNestedDescendants(job.nestedChildren)) {
                        cancelCleanup(job.asyncId);
                    }
                    else if (!state.cleanupTimers.has(job.asyncId)) {
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
        const agents = info.agents?.length ? info.agents : info.agent ? [info.agent] : undefined;
        state.asyncJobs.set(info.id, {
            asyncId: info.id,
            asyncDir,
            ...(isAwaitedRun(info.id) ? { awaited: true } : {}),
            status: "queued",
            pid: typeof info.pid === "number" ? info.pid : undefined,
            ...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
            mode: normalizeSubagentRunMode(info.mode),
            agents,
            nestedRoute: info.nestedRoute,
            stepsTotal: agents?.length,
            startedAt: now,
            updatedAt: now,
            timeoutMs: info.timeoutMs,
            deadlineAt: info.deadlineAt,
            controlEventCursor: 0,
            projectAgents: info.projectAgents,
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
            if (result.awaited)
                job.awaited = true;
            const eventState = canonicalLifecycleState(result.state);
            job.status =
                eventState === "cancelled"
                    ? "cancelled"
                    : result.success || eventState === "complete"
                        ? "complete"
                        : "failed";
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
        if (hasLiveNestedDescendants(job?.nestedChildren)) {
            cancelCleanup(asyncId);
        }
        else if (!nestedRefreshFailed) {
            scheduleCleanup(asyncId);
        }
    };
    const resetJobs = (ctx) => {
        for (const timer of state.cleanupTimers.values()) {
            clearTimeout(timer);
        }
        state.cleanupTimers.clear();
        state.asyncJobs.clear();
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
        restoreControlEventProbeFailures.clear();
        let runs;
        let issues;
        try {
            ({ runs, issues } = scanAsyncRunsForRestore(asyncDirRoot, {
                states: ["queued", "running"],
                sessionId: state.currentSessionId,
                resultsDir,
                kill: options.kill,
                now: options.now,
                statusRead: options.statusRead,
            }));
        }
        catch (error) {
            console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
            return;
        }
        const warnings = [formatRestoredActiveJobsCount(runs.length)];
        if (issues.length > 0) {
            warnings.push("left unreadable statuses in place");
            warnRestoreIssues(`Async restore skipped unreadable startup statuses: ${warnings.join("; ")}.`);
        }
        for (const run of runs) {
            state.asyncJobs.set(run.id, summaryToJob(run));
        }
        if (restoreControlEventProbeFailures.size > 0 &&
            !restoreWarningDedupe.has("control-event-probe-failure")) {
            restoreWarningDedupe.add("control-event-probe-failure");
            const count = restoreControlEventProbeFailures.size;
            warnRestoreIssues(`Async restore could not inspect persisted control events for ${count} active ${count === 1 ? "job" : "jobs"}; continued restoring active jobs.`);
        }
        if (runs.length === 0)
            return;
        ensurePoller();
        if (state.lastUiContext?.hasUI)
            rerenderWidget(state.lastUiContext);
    };
    return { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs };
}
