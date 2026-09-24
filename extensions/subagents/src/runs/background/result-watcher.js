import * as fs from "node:fs";
import * as path from "node:path";
import { createFileCoalescer } from "../../shared/file-coalescer.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, } from "../../shared/types.js";
import { attachNestedChildrenToResultChildren, compactNestedResultChildren, resolveSubagentResultStatus, } from "../../shared/result-formatting.js";
import { isCompletedLifecycleState, isCompletedLifecycleStepState, lifecycleContinuationForIndex, withLifecycleStatusLock, } from "../shared/lifecycle-state.js";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.js";
import { parseSubagentTerminalResult } from "../../shared/terminal-result.js";
import { dispatchAwaitedRunCompletion } from "./awaited-run-registry.js";
import { claimResultArtifact, resultArtifactClaimCleanupDelayMs, RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS, } from "./result-artifact-consumer.js";
const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
const RESULT_RETRY_MAX_ATTEMPTS = RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS;
function sanitizeNestedResultChildren(value, resultPath, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
        return undefined;
    }
    const children = value
        .map((child) => sanitizeSummary(child))
        .filter((child) => Boolean(child));
    if (children.length !== value.length) {
        console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
    }
    return children.length ? children : undefined;
}
function sanitizeResultChildren(value, resultPath) {
    if (!Array.isArray(value))
        return [];
    let invalidCount = 0;
    const children = value.map((child) => {
        if (typeof child === "object" && child !== null && !Array.isArray(child))
            return child;
        invalidCount += 1;
        return {};
    });
    if (invalidCount > 0) {
        console.error(`Ignoring ${invalidCount} invalid child record(s) in subagent result file '${resultPath}'.`);
    }
    return children;
}
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
            if (isCompletedLifecycleState(status.state) || status.state === "cancelled")
                return "discard";
            if (status.state !== "paused")
                return "retry";
            const targetIndex = resolvePausedArtifactTargetIndex(data);
            if (targetIndex === undefined)
                return "retry";
            const targetStep = status.steps?.[targetIndex];
            if (isCompletedLifecycleStepState(targetStep?.status) || targetStep?.status === "cancelled")
                return "discard";
            if (targetStep?.status === "pausing")
                return "retry";
            const continuation = lifecycleContinuationForIndex(status, targetIndex);
            if (continuation?.phase === "completed" || continuation?.phase === "continued")
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
export function createResultWatcher(pi, state, resultsDir, deps = {}) {
    const fsApi = deps.fs ?? fs;
    const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    let stopped = false;
    const resultRetryStates = new Map();
    const resultRetryDiagnostics = new Set();
    const claimCleanupTimers = new Map();
    const claimCleanupDiagnostics = new Set();
    const resetResultRetry = (resultPath) => {
        const retry = resultRetryStates.get(resultPath);
        if (retry?.timer)
            timers.clearTimeout(retry.timer);
        resultRetryStates.delete(resultPath);
        resultRetryDiagnostics.delete(resultPath);
    };
    const reportResultRetryExhausted = (retryPath, retry) => {
        if (resultRetryDiagnostics.has(retryPath))
            return;
        resultRetryDiagnostics.add(retryPath);
        console.error(`Could not ${retry.operation} subagent result artifact '${retryPath}' after ${RESULT_RETRY_MAX_ATTEMPTS} retry attempts; leaving it inspectable for manual recovery.`, ...(retry.error === undefined ? [] : [retry.error]));
    };
    const reportClaimCleanupExhausted = (claim, mode, error) => {
        if (claimCleanupDiagnostics.has(claim.path))
            return;
        claimCleanupDiagnostics.add(claim.path);
        const operation = mode === "commit" ? "complete delivered result" : "release result";
        console.error(`Could not ${operation} claim cleanup for '${claim.path}' after ${RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS} attempts; retained the claim sidecar for manual recovery.`, ...(error === undefined ? [] : [error]));
    };
    const scheduleResultRetry = (file, operation, error) => {
        if (stopped)
            return;
        const retryPath = path.resolve(path.join(resultsDir, file));
        const existing = resultRetryStates.get(retryPath);
        if (existing?.timer)
            return;
        const attempts = existing?.attempts ?? 0;
        if (attempts >= RESULT_RETRY_MAX_ATTEMPTS) {
            reportResultRetryExhausted(retryPath, existing ?? { attempts, operation, ready: false, error });
            return;
        }
        const retry = {
            attempts: attempts + 1,
            operation,
            ready: false,
            ...(error === undefined ? {} : { error }),
        };
        const timer = timers.setTimeout(() => {
            const pending = resultRetryStates.get(retryPath);
            if (!pending || pending.timer !== timer)
                return;
            pending.timer = undefined;
            pending.ready = true;
            if (stopped)
                return;
            state.resultFileCoalescer.schedule(file, 0);
        }, resultArtifactClaimCleanupDelayMs(attempts));
        timer.unref?.();
        retry.timer = timer;
        resultRetryStates.set(retryPath, retry);
    };
    const scheduleClaimCleanup = (claim, mode, attempts = 0) => {
        if (stopped)
            return;
        const existing = claimCleanupTimers.get(claim.path);
        if (existing) {
            if (mode === "commit" && existing.mode !== "commit")
                existing.mode = "commit";
            return;
        }
        const timer = timers.setTimeout(() => {
            const pending = claimCleanupTimers.get(claim.path);
            claimCleanupTimers.delete(claim.path);
            if (stopped)
                return;
            const cleanupMode = pending?.mode ?? mode;
            const cleanupClaim = pending?.claim ?? claim;
            const cleanupAttempts = (pending?.attempts ?? attempts) + 1;
            try {
                if (cleanupMode === "commit" && fsApi.existsSync(cleanupClaim.path))
                    fsApi.unlinkSync(cleanupClaim.path);
                const cleaned = cleanupMode === "commit" ? cleanupClaim.commit() : cleanupClaim.release();
                if (cleaned)
                    return;
                if (cleanupAttempts >= RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS) {
                    reportClaimCleanupExhausted(cleanupClaim, cleanupMode);
                    return;
                }
                scheduleClaimCleanup(cleanupClaim, "commit", cleanupAttempts);
            }
            catch (error) {
                if (cleanupAttempts >= RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS) {
                    reportClaimCleanupExhausted(cleanupClaim, cleanupMode, error);
                    return;
                }
                scheduleClaimCleanup(cleanupClaim, cleanupMode, cleanupAttempts);
            }
        }, resultArtifactClaimCleanupDelayMs(attempts));
        timer.unref?.();
        claimCleanupTimers.set(claim.path, { claim, mode, attempts, timer });
    };
    const diagnoseAndRetry = (file, operation, error) => {
        scheduleResultRetry(file, operation, error);
    };
    const handleResult = (file) => {
        if (stopped)
            return;
        const resultPath = path.resolve(path.join(resultsDir, file));
        const retryState = resultRetryStates.get(resultPath);
        if (retryState) {
            if (retryState.attempts >= RESULT_RETRY_MAX_ATTEMPTS && !retryState.ready)
                return;
            if (retryState.timer) {
                timers.clearTimeout(retryState.timer);
                retryState.timer = undefined;
            }
            retryState.ready = false;
        }
        let claim;
        try {
            claim = claimResultArtifact(resultPath, fsApi);
        }
        catch (error) {
            diagnoseAndRetry(file, "claim", error);
            return;
        }
        if (!claim)
            return;
        let deliveryDecided = false;
        try {
            let resultExists;
            try {
                resultExists = fsApi.existsSync(resultPath);
            }
            catch (error) {
                diagnoseAndRetry(file, "check", error);
                return;
            }
            if (!resultExists) {
                resetResultRetry(resultPath);
                return;
            }
            let raw;
            try {
                raw = fsApi.readFileSync(resultPath, "utf-8");
            }
            catch (error) {
                diagnoseAndRetry(file, "read", error);
                return;
            }
            try {
                const data = JSON.parse(raw);
                if (typeof data.sessionId !== "string" || data.sessionId !== state.currentSessionId) {
                    resetResultRetry(resultPath);
                    return;
                }
                if (Array.isArray(data.results)) {
                    data.results = sanitizeResultChildren(data.results, resultPath);
                }
                const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
                const hasExplicitNestedChildren = data.nestedChildren !== undefined;
                let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
                if (!nestedChildren?.length && !hasExplicitNestedChildren) {
                    try {
                        nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
                    }
                    catch (error) {
                        diagnoseAndRetry(file, "enrich", error);
                        return;
                    }
                }
                const pausedDecision = resolvePausedArtifactDecision(data);
                if (pausedDecision === "retry") {
                    diagnoseAndRetry(file, "wait for lifecycle decision", undefined);
                    return;
                }
                if (pausedDecision === "discard") {
                    try {
                        fsApi.unlinkSync(resultPath);
                    }
                    catch (error) {
                        if (!isNotFoundError(error))
                            scheduleClaimCleanup(claim, "commit", 1);
                    }
                    try {
                        if (!claim.commit())
                            scheduleClaimCleanup(claim, "commit");
                    }
                    catch {
                        scheduleClaimCleanup(claim, "commit", 1);
                    }
                    resetResultRetry(resultPath);
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
                const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, arrayIndex) => {
                    const baseOutput = result.output ?? data.summary;
                    const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
                    const output = hasRealOutput ? baseOutput : "(no output)";
                    const summary = result.success === false && result.error
                        ? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
                        : output;
                    const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
                    const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${arrayIndex}].children`);
                    const terminalResult = parseSubagentTerminalResult(result.terminalResult);
                    return {
                        agent: result.agent ?? data.agent ?? `step-${arrayIndex + 1}`,
                        status: resolveResultFileChildStatus(result, data.state),
                        summary,
                        index: arrayIndex,
                        artifactPath: result.artifactPaths?.outputPath,
                        ...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath)
                            ? { sessionPath }
                            : {}),
                        ...(terminalResult ? { terminalResult } : {}),
                        ...(childNestedChildren ? { children: childNestedChildren } : {}),
                    };
                }), nestedChildren);
                const completionEvent = {
                    ...data,
                    runId,
                    ...(nestedChildren?.length ? { nestedChildren } : {}),
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
                                    terminalResult: child.terminalResult,
                                    children: child.children,
                                }))
                                : [],
                        }
                        : {}),
                };
                const consumedByAwaitedOwner = dispatchAwaitedRunCompletion(runId, completionEvent);
                deliveryDecided = true;
                resetResultRetry(resultPath);
                if (!consumedByAwaitedOwner) {
                    pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionEvent);
                }
                try {
                    fsApi.unlinkSync(resultPath);
                }
                catch (error) {
                    if (!isNotFoundError(error))
                        scheduleClaimCleanup(claim, "commit", 1);
                }
                try {
                    if (!claim.commit())
                        scheduleClaimCleanup(claim, "commit");
                }
                catch {
                    scheduleClaimCleanup(claim, "commit", 1);
                }
            }
            catch (error) {
                if (deliveryDecided) {
                    console.error(`Failed to finish delivered subagent result '${resultPath}'; will retry cleanup:`, error);
                    scheduleClaimCleanup(claim, "commit");
                    return;
                }
                if (isNotFoundError(error)) {
                    resetResultRetry(resultPath);
                    return;
                }
                if (getErrorCode(error)) {
                    diagnoseAndRetry(file, "process", error);
                }
                else {
                    resetResultRetry(resultPath);
                    console.error(`Failed to process subagent result file '${resultPath}':`, error);
                }
            }
        }
        finally {
            if (!deliveryDecided) {
                try {
                    claim.release();
                }
                catch (error) {
                    console.error(`Failed to release subagent result claim for '${resultPath}'; will retry:`, error);
                    scheduleClaimCleanup(claim, "release");
                }
            }
        }
    };
    state.resultFileCoalescer = createFileCoalescer((file) => {
        void handleResult(file);
    }, 50);
    const orphanClaimDiagnostics = new Set();
    const reportOrphanClaimCleanupFailure = (claimPath, error) => {
        if (orphanClaimDiagnostics.has(claimPath))
            return;
        orphanClaimDiagnostics.add(claimPath);
        console.error(`Failed to remove orphan subagent result claim '${claimPath}'; manual recovery may be required:`, error);
    };
    const readResultEntries = () => {
        try {
            return fsApi.readdirSync(resultsDir);
        }
        catch (error) {
            if (!isNotFoundError(error))
                console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
            return undefined;
        }
    };
    const cleanupOrphanClaims = (entries) => {
        for (const file of entries) {
            if (stopped || !file.endsWith(".json.claim"))
                continue;
            const claimPath = path.join(resultsDir, file);
            const resultPath = path.join(resultsDir, file.slice(0, -".claim".length));
            let resultExists;
            try {
                resultExists = fsApi.existsSync(resultPath);
            }
            catch (error) {
                reportOrphanClaimCleanupFailure(claimPath, error);
                continue;
            }
            if (resultExists)
                continue;
            try {
                fsApi.unlinkSync(claimPath);
            }
            catch (error) {
                if (!isNotFoundError(error))
                    reportOrphanClaimCleanupFailure(claimPath, error);
            }
        }
    };
    const primeExistingResults = () => {
        if (stopped)
            return;
        const entries = readResultEntries();
        if (!entries)
            return;
        cleanupOrphanClaims(entries);
        entries
            .filter((file) => file.endsWith(".json"))
            .filter((file) => {
            const retry = resultRetryStates.get(path.resolve(path.join(resultsDir, file)));
            return retry === undefined || retry.attempts < RESULT_RETRY_MAX_ATTEMPTS || retry.ready;
        })
            .forEach((file) => state.resultFileCoalescer.schedule(file, 0));
    };
    const startPollingFallback = (reason) => {
        if (stopped)
            return;
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
        if (stopped || state.watcherRestartTimer)
            return;
        state.watcherRestartTimer = timers.setTimeout(() => {
            state.watcherRestartTimer = null;
            if (stopped)
                return;
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
        stopped = false;
        if (state.watcherRestartTimer) {
            timers.clearTimeout(state.watcherRestartTimer);
            timers.clearInterval(state.watcherRestartTimer);
            state.watcherRestartTimer = null;
        }
        const startupEntries = readResultEntries();
        if (startupEntries)
            cleanupOrphanClaims(startupEntries);
        try {
            const watchDir = resolveNativeWatchDir(fsApi, resultsDir);
            state.watcher = fsApi.watch(watchDir, (ev, file) => {
                if (stopped || ev !== "rename" || !file)
                    return;
                const fileName = file.toString();
                if (!fileName.endsWith(".json"))
                    return;
                state.resultFileCoalescer.schedule(fileName);
            });
            state.watcher.on("error", (error) => {
                if (stopped)
                    return;
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
            if (stopped)
                return;
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
        stopped = true;
        state.watcher?.close();
        state.watcher = null;
        if (state.watcherRestartTimer) {
            timers.clearTimeout(state.watcherRestartTimer);
            timers.clearInterval(state.watcherRestartTimer);
        }
        state.watcherRestartTimer = null;
        for (const retry of resultRetryStates.values()) {
            if (retry.timer)
                timers.clearTimeout(retry.timer);
        }
        resultRetryStates.clear();
        resultRetryDiagnostics.clear();
        for (const { timer } of claimCleanupTimers.values())
            timers.clearTimeout(timer);
        claimCleanupTimers.clear();
        state.resultFileCoalescer.clear();
    };
    return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
