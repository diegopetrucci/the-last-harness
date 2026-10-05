import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.js";
import { createFileCoalescer } from "../../shared/file-coalescer.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, } from "../../shared/types.js";
import { resolveSubagentResultStatus } from "../../shared/result-formatting.js";
import { lifecycleContinuationForIndex, withLifecycleStatusLock, } from "../shared/lifecycle-state.js";
import { readStatus } from "../../shared/utils.js";
import { PROJECT_AGENT_TERMINAL_RETENTION_MS, lookupProjectAgentRunReference, releaseProjectAgentRunReference, } from "../../agents/project-agent-snapshot.js";
import { normalizeSubagentRunTelemetry } from "../../shared/telemetry.js";
const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
function getErrorCode(error) {
    return typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
}
function isNotFoundError(error) {
    return getErrorCode(error) === "ENOENT";
}
function shouldFallBackToPolling(error) {
    const code = getErrorCode(error);
    return code === "EMFILE" || code === "ENOSPC";
}
function resolveNativeWatchDir(fsApi, resultsDir) {
    try {
        return fsApi.realpathSync.native(resultsDir);
    }
    catch {
        return resultsDir;
    }
}
function resolveResultFileChildStatus(result, parentState) {
    const hasChildStatusMetadata = typeof result.success === "boolean" || typeof result.exitCode === "number";
    const interrupted = result.interrupted === true ||
        (result.interrupted === undefined &&
            parentState === "paused" &&
            result.success === false &&
            result.exitCode === 0);
    return resolveSubagentResultStatus({
        interrupted,
        success: result.success,
        exitCode: result.exitCode,
        state: !hasChildStatusMetadata && parentState !== "paused" ? parentState : undefined,
    });
}
function resolvePausedArtifactTargetIndex(data) {
    const children = Array.isArray(data.results) ? data.results : [];
    if (children.length <= 1)
        return 0;
    const pausedChild = children.find((child) => resolveResultFileChildStatus(child, data.state) === "paused" &&
        typeof child.sessionFile === "string" &&
        child.sessionFile.length > 0);
    return pausedChild ? children.indexOf(pausedChild) : undefined;
}
function hasUsableProjectSessionFile(sessionFile, fsApi) {
    if (typeof sessionFile !== "string" || sessionFile.trim().length === 0)
        return false;
    const resolved = path.resolve(sessionFile);
    return path.extname(resolved) === ".jsonl" && fsApi.existsSync(resolved);
}
function hasResumableProjectSibling(data, fsApi, includeTerminalProjectSibling = true) {
    if (typeof data.asyncDir !== "string" || data.asyncDir.length === 0) {
        return true;
    }
    let status;
    try {
        status = readStatus(data.asyncDir);
    }
    catch {
        return true;
    }
    if (!status || !status.steps || status.steps.length === 0)
        return true;
    return status.steps.some((step) => {
        const stepStatus = step.status;
        if (stepStatus === "paused" ||
            stepStatus === "pausing" ||
            stepStatus === "pending" ||
            stepStatus === "running" ||
            stepStatus === "queued") {
            return true;
        }
        if (stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed") {
            return (includeTerminalProjectSibling &&
                step.projectAgent !== undefined &&
                hasUsableProjectSessionFile(step.sessionFile, fsApi));
        }
        if (stepStatus === "continued" || stepStatus === "cancelled")
            return false;
        return true;
    });
}
function resolvePausedArtifactDecision(data) {
    if (data.state !== "paused")
        return "compat";
    if (typeof data.asyncDir !== "string" ||
        data.asyncDir.length === 0 ||
        data.lifecycleArtifactVersion !== 1)
        return "compat";
    try {
        return withLifecycleStatusLock(data.asyncDir, (status) => {
            if (!status || status.state === "pausing")
                return "retry";
            if (status.state === "continued" || status.state === "cancelled")
                return "discard";
            if (status.state !== "paused")
                return "retry";
            const targetIndex = resolvePausedArtifactTargetIndex(data);
            if (targetIndex === undefined)
                return "retry";
            const targetStep = status.steps?.[targetIndex];
            if (targetStep?.status === "continued" || targetStep?.status === "cancelled")
                return "discard";
            if (targetStep?.status === "pausing")
                return "retry";
            const continuation = lifecycleContinuationForIndex(status, targetIndex);
            if (continuation?.phase === "continued")
                return "discard";
            if (continuation?.phase === "claimed" ||
                continuation?.phase === "reserved" ||
                continuation?.phase === "launched")
                return "retry";
            if (!targetStep || targetStep.status === "paused")
                return "notify";
            return "retry";
        }, { retryDelaysMs: [] });
    }
    catch {
        return "retry";
    }
}
export function createResultWatcher(pi, state, resultsDir, completionTtlMs, deps = {}) {
    const fsApi = deps.fs ?? fs;
    const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    const projectAgentTerminalRetentionMs = deps.projectAgentTerminalRetentionMs ?? PROJECT_AGENT_TERMINAL_RETENTION_MS;
    const projectReferenceReleaseTimers = new Map();
    const cancelProjectReferenceRelease = (runId) => {
        const timer = projectReferenceReleaseTimers.get(runId);
        if (!timer)
            return;
        timers.clearTimeout(timer);
        projectReferenceReleaseTimers.delete(runId);
    };
    const scheduleProjectReferenceRelease = (data, runId) => {
        const lookup = lookupProjectAgentRunReference(runId);
        if (lookup.status !== "found" || lookup.runId !== runId)
            return;
        cancelProjectReferenceRelease(runId);
        const timer = timers.setTimeout(() => {
            projectReferenceReleaseTimers.delete(runId);
            if (!data.asyncDir)
                return;
            if (hasResumableProjectSibling(data, fsApi, false)) {
                scheduleProjectReferenceRelease(data, runId);
                return;
            }
            releaseProjectAgentRunReference(runId);
        }, projectAgentTerminalRetentionMs);
        timer.unref?.();
        projectReferenceReleaseTimers.set(runId, timer);
    };
    const retainOrReleaseProjectReference = (data, runId) => {
        const lookup = lookupProjectAgentRunReference(runId);
        if (lookup.status !== "found" || lookup.runId !== runId)
            return;
        if (hasResumableProjectSibling(data, fsApi)) {
            scheduleProjectReferenceRelease(data, runId);
            return;
        }
        releaseProjectAgentRunReference(runId);
    };
    const handleResult = (file) => {
        const resultPath = path.join(resultsDir, file);
        if (!fsApi.existsSync(resultPath))
            return;
        try {
            const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8"));
            if (typeof data.sessionId !== "string" || data.sessionId !== state.currentSessionId)
                return;
            const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
            const now = Date.now();
            const pausedDecision = resolvePausedArtifactDecision(data);
            if (pausedDecision === "retry")
                return;
            if (pausedDecision === "discard") {
                retainOrReleaseProjectReference(data, runId);
                fsApi.unlinkSync(resultPath);
                return;
            }
            const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
            const resultChildren = hasResultChildren
                ? data.results
                : [
                    {
                        agent: data.agent,
                        output: data.summary,
                        success: data.success,
                    },
                ];
            const normalizedChildren = resultChildren.map((result = {}, arrayIndex) => {
                const baseOutput = result.output ?? data.summary;
                const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
                const output = hasRealOutput ? baseOutput : "(no output)";
                const summary = result.success === false && result.error
                    ? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
                    : output;
                const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
                return {
                    agent: result.agent ?? data.agent ?? `step-${arrayIndex + 1}`,
                    status: resolveResultFileChildStatus(result, data.state),
                    summary,
                    index: arrayIndex,
                    artifactPath: result.artifactPaths?.outputPath,
                    ...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath)
                        ? { sessionPath }
                        : {}),
                };
            });
            const completionKey = buildCompletionKey(data, `result:${file}`);
            if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
                if (data.state === "cancelled" || data.state === "continued") {
                    retainOrReleaseProjectReference(data, runId);
                }
                fsApi.unlinkSync(resultPath);
                return;
            }
            const telemetry = normalizeSubagentRunTelemetry(data.telemetry);
            pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
                ...data,
                runId,
                ...(telemetry ? { telemetry } : { telemetry: undefined }),
                ...(Array.isArray(data.results)
                    ? {
                        results: hasResultChildren
                            ? normalizedChildren.map((child, index) => ({
                                ...data.results[index],
                                agent: child.agent,
                                status: child.status,
                                summary: child.summary,
                                index: child.index,
                                artifactPath: child.artifactPath,
                                sessionPath: child.sessionPath,
                            }))
                            : [],
                    }
                    : {}),
            });
            if (data.state === "cancelled" || data.state === "continued") {
                retainOrReleaseProjectReference(data, runId);
            }
            else if (data.state === "complete" || data.state === "failed") {
                scheduleProjectReferenceRelease(data, runId);
            }
            fsApi.unlinkSync(resultPath);
        }
        catch (error) {
            if (isNotFoundError(error))
                return;
            console.error(`Failed to process subagent result file '${resultPath}':`, error);
        }
    };
    state.resultFileCoalescer = createFileCoalescer((file) => {
        void handleResult(file);
    }, 50);
    const primeExistingResults = () => {
        try {
            fsApi
                .readdirSync(resultsDir)
                .filter((f) => f.endsWith(".json"))
                .forEach((file) => state.resultFileCoalescer.schedule(file, 0));
        }
        catch (error) {
            if (isNotFoundError(error))
                return;
            console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
        }
    };
    const startPollingFallback = (reason) => {
        state.watcher?.close();
        state.watcher = null;
        if (state.watcherRestartTimer)
            return;
        console.error(`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`);
        primeExistingResults();
        state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
        state.watcherRestartTimer.unref?.();
    };
    const scheduleRestart = () => {
        if (state.watcherRestartTimer)
            return;
        state.watcherRestartTimer = timers.setTimeout(() => {
            state.watcherRestartTimer = null;
            try {
                fsApi.mkdirSync(resultsDir, { recursive: true });
                startResultWatcher();
            }
            catch (error) {
                if (shouldFallBackToPolling(error)) {
                    startPollingFallback(error);
                    return;
                }
                console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
                scheduleRestart();
            }
        }, WATCHER_RESTART_DELAY_MS);
        state.watcherRestartTimer.unref?.();
    };
    const startResultWatcher = () => {
        if (state.watcher)
            return;
        if (state.watcherRestartTimer) {
            timers.clearTimeout(state.watcherRestartTimer);
            timers.clearInterval(state.watcherRestartTimer);
            state.watcherRestartTimer = null;
        }
        try {
            const watchDir = resolveNativeWatchDir(fsApi, resultsDir);
            state.watcher = fsApi.watch(watchDir, (ev, file) => {
                if (ev !== "rename" || !file)
                    return;
                const fileName = file.toString();
                if (!fileName.endsWith(".json"))
                    return;
                state.resultFileCoalescer.schedule(fileName);
            });
            state.watcher.on("error", (error) => {
                if (shouldFallBackToPolling(error)) {
                    startPollingFallback(error);
                    return;
                }
                console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
                state.watcher?.close();
                state.watcher = null;
                scheduleRestart();
            });
            state.watcher.unref?.();
        }
        catch (error) {
            if (shouldFallBackToPolling(error)) {
                startPollingFallback(error);
                return;
            }
            console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
            state.watcher = null;
            scheduleRestart();
        }
    };
    const stopResultWatcher = () => {
        state.watcher?.close();
        state.watcher = null;
        if (state.watcherRestartTimer) {
            timers.clearTimeout(state.watcherRestartTimer);
            timers.clearInterval(state.watcherRestartTimer);
        }
        state.watcherRestartTimer = null;
        state.resultFileCoalescer.clear();
    };
    return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
