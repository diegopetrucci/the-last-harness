import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { RESULTS_DIR } from "../../shared/types.js";
import { createAsyncStatusJsonParseError } from "./async-status-corruption.js";
import { normalizeParallelGroups } from "./parallel-groups.js";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent } from "../shared/nested-events.js";
import { checkPidLiveness, normalizeAsyncLifecycleStatus, recoverStoppedLifecycleOwnership } from "../shared/lifecycle-state.js";
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function readRunnerStartupDiagnostics(asyncDir) {
    const stderrPath = path.join(asyncDir, "runner.stderr.log");
    const maxBytes = 64 * 1024;
    let content;
    try {
        const stat = fs.statSync(stderrPath);
        if (stat.size <= 0)
            return undefined;
        const fd = fs.openSync(stderrPath, "r");
        try {
            const bytesToRead = Math.min(stat.size, maxBytes);
            const start = Math.max(0, stat.size - bytesToRead);
            const buffer = Buffer.alloc(bytesToRead);
            fs.readSync(fd, buffer, 0, bytesToRead, start);
            content = buffer.toString("utf-8").trim();
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
    if (!content)
        return undefined;
    const lines = content.split(/\r?\n/).slice(-30).join("\n");
    return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}
function isNotFoundError(error) {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT";
}
function appendJsonlBestEffort(filePath, payload) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
    }
    catch {
    }
}
function readStatusFile(asyncDir) {
    const statusPath = path.join(asyncDir, "status.json");
    let content;
    try {
        content = fs.readFileSync(statusPath, "utf-8");
    }
    catch (error) {
        if (isNotFoundError(error))
            return null;
        throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
    try {
        return normalizeAsyncLifecycleStatus(JSON.parse(content));
    }
    catch (error) {
        throw createAsyncStatusJsonParseError({
            asyncDir,
            statusPath,
            content,
            cause: error,
        });
    }
}
function readResultRepairData(resultPath) {
    try {
        const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        const state = data.success
            ? "complete"
            : data.state === "cancelled" || data.state === "continued" || data.state === "pausing"
                ? data.state
                : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
        return { state, ...(Array.isArray(data.results) ? { results: data.results } : {}) };
    }
    catch (error) {
        if (isNotFoundError(error))
            return undefined;
        throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
            cause: error,
        });
    }
}
function childState(overallState, child) {
    if (child?.success === true)
        return "complete";
    if (child?.success === false)
        return "failed";
    return overallState === "cancelled" ? "paused" : overallState;
}
function terminalStatusFromResult(status, resultPath, now) {
    const repair = readResultRepairData(resultPath);
    if (!repair)
        return undefined;
    const steps = (status.steps ?? []).map((step, index) => {
        if (step.status !== "running" && step.status !== "pending")
            return step;
        const child = repair.results?.[index];
        const state = childState(repair.state, child);
        return {
            ...step,
            status: state === "complete" ? "complete" : state === "continued" ? "continued" : state === "pausing" ? "pausing" : state,
            endedAt: step.endedAt ?? now,
            durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
            activeRuntimeMs: child?.activeRuntimeMs ?? ((step.activeRuntimeMs ?? 0) + (step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0)),
            exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
            error: state === "failed" ? step.error ?? child?.error : step.error,
            sessionFile: step.sessionFile ?? child?.sessionFile,
            model: step.model ?? child?.model,
            attemptedModels: step.attemptedModels ?? child?.attemptedModels,
            modelAttempts: step.modelAttempts ?? child?.modelAttempts,
        };
    });
    return {
        ...status,
        state: repair.state,
        activityState: undefined,
        lastUpdate: now,
        endedAt: status.endedAt ?? now,
        steps,
    };
}
function buildStartedStatus(asyncDir, startedRun, now) {
    const startedAt = startedRun.startedAt ?? now;
    const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
    const chainStepCount = startedRun.chainStepCount;
    const parallelGroups = chainStepCount !== undefined
        ? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
        : [];
    return {
        runId: startedRun.runId || path.basename(asyncDir),
        ...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
        mode: startedRun.mode ?? "single",
        state: "running",
        pid: startedRun.pid,
        startedAt,
        lastUpdate: now,
        currentStep: 0,
        ...(chainStepCount !== undefined ? { chainStepCount } : {}),
        ...(parallelGroups.length ? { parallelGroups } : {}),
        steps: agents.map((agent) => ({
            agent,
            status: "running",
            startedAt,
        })),
        ...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
    };
}
function buildFailedRepair(status, asyncDir, now, reason) {
    const runId = status.runId || path.basename(asyncDir);
    const pid = typeof status.pid === "number" ? status.pid : "unknown";
    const baseMessage = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
    const diagnostics = readRunnerStartupDiagnostics(asyncDir);
    const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
    const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" }];
    const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending" || step.status === "pausing"
        ? {
            ...step,
            status: "failed",
            activityState: undefined,
            endedAt: step.endedAt ?? now,
            durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
            activeRuntimeMs: step.status === "pausing" && step.activeRuntimeMs !== undefined
                ? step.activeRuntimeMs
                : (step.activeRuntimeMs ?? 0) + (step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0),
            exitCode: step.exitCode ?? 1,
            error: step.error ?? message,
        }
        : step);
    const repairedStatus = {
        ...status,
        state: "failed",
        activityState: undefined,
        lastUpdate: now,
        endedAt: now,
        steps: repairedSteps,
    };
    const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
    return {
        status: repairedStatus,
        message,
        result: {
            id: runId,
            agent: resultAgent,
            mode: status.mode,
            success: false,
            state: "failed",
            summary: message,
            results: repairedSteps.map((step) => ({
                agent: step.agent,
                output: step.status === "complete" || step.status === "completed" ? "" : message,
                error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
                success: step.status === "complete" || step.status === "completed",
                model: step.model,
                attemptedModels: step.attemptedModels,
                modelAttempts: step.modelAttempts,
                sessionFile: step.sessionFile,
                activeRuntimeMs: step.activeRuntimeMs,
            })),
            exitCode: 1,
            timestamp: now,
            durationMs: Math.max(0, now - status.startedAt),
            asyncDir,
            sessionId: status.sessionId,
            sessionFile: status.sessionFile,
        },
    };
}
function writeFailedRepair(asyncDir, status, resultPath, now, reason) {
    const repair = buildFailedRepair(status, asyncDir, now, reason);
    writeAtomicJson(resultPath, repair.result);
    writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
    appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
        type: "subagent.run.repaired_stale",
        ts: now,
        runId: repair.status.runId,
        pid: status.pid,
        resultPath,
        message: repair.message,
    });
    return { status: repair.status, repaired: true, resultPath, message: repair.message };
}
function terminal(state) {
    return state === "complete" || state === "failed" || state === "paused" || state === "cancelled" || state === "continued";
}
function* nestedRuns(children) {
    for (const child of children ?? []) {
        yield child;
        yield* nestedRuns(child.children);
        yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
    }
}
export function reconcileNestedAsyncDescendants(route, options = {}) {
    const registry = projectNestedEvents(route);
    for (const run of nestedRuns(registry.children)) {
        if (run.state !== "running" && run.state !== "queued")
            continue;
        const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
        if (!asyncDir)
            continue;
        const result = reconcileAsyncRun(asyncDir, {
            ...options,
            resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
        });
        const status = result.status;
        if (!status)
            continue;
        if (!result.repaired && !terminal(status.state))
            continue;
        const ts = options.now?.() ?? Date.now();
        writeNestedEvent(route, {
            type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
            ts,
            parentRunId: run.parentRunId,
            parentStepIndex: run.parentStepIndex,
            child: nestedSummaryFromAsyncStatus(status, asyncDir, {
                id: run.id,
                parentRunId: run.parentRunId,
                parentStepIndex: run.parentStepIndex,
                depth: run.depth,
                path: run.path,
                mode: run.mode,
                ts,
            }),
        });
    }
}
export { checkPidLiveness };
export function reconcileAsyncRun(asyncDir, options = {}) {
    const now = options.now?.() ?? Date.now();
    const status = readStatusFile(asyncDir);
    const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
    const effectiveStatus = status ?? startedStatus;
    if (!effectiveStatus)
        return { status: null, repaired: false };
    const runId = effectiveStatus.runId || path.basename(asyncDir);
    const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
    if (effectiveStatus.state === "paused" || effectiveStatus.state === "cancelled" || effectiveStatus.state === "continued" || effectiveStatus.state === "pausing") {
        const recovered = recoverStoppedLifecycleOwnership(effectiveStatus, { kill: options.kill, now: options.now });
        if (recovered.repaired) {
            writeAtomicJson(path.join(asyncDir, "status.json"), recovered.status);
            return {
                status: recovered.status,
                repaired: true,
                resultPath,
                message: effectiveStatus.state === "pausing"
                    ? `Stale pausing lifecycle finalized to paused after child pid ${effectiveStatus.pid} exited.`
                    : recovered.pidLiveness === "alive"
                        ? `Stopped lifecycle state discarded persisted pid ${effectiveStatus.pid} because ownership could not be verified after pause/cancel recovery.`
                        : recovered.pidLiveness === "unknown"
                            ? `Stopped lifecycle state discarded persisted pid ${effectiveStatus.pid} because ownership could not be verified.`
                            : `Stopped lifecycle state cleared dead persisted pid ${effectiveStatus.pid}.`,
            };
        }
        if (effectiveStatus.state === "pausing" && recovered.pidLiveness === "dead") {
            const terminalFromResult = terminalStatusFromResult(effectiveStatus, resultPath, now);
            if (terminalFromResult) {
                writeAtomicJson(path.join(asyncDir, "status.json"), terminalFromResult);
                return { status: terminalFromResult, repaired: true, resultPath, message: "Existing async result file was used to finalize a stale pausing status." };
            }
            return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, `Persisted pausing run '${runId}' could not be finalized to paused because safe resume metadata was incomplete.`);
        }
    }
    if (fs.existsSync(resultPath)) {
        const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
            ? terminalStatusFromResult(effectiveStatus, resultPath, now)
            : undefined;
        if (terminalStatus) {
            writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
            return { status: terminalStatus, repaired: true, resultPath, message: "Existing async result file was used to repair stale running status." };
        }
        return { status: effectiveStatus, repaired: false, resultPath };
    }
    if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
        return { status: status ?? null, repaired: false, resultPath };
    }
    if (!status) {
        const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
        if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
            return { status: null, repaired: false, resultPath };
        }
    }
    const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
    if (liveness !== "dead") {
        const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
        const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
        if (now - lastUpdate <= staleAfterMs)
            return { status: status ?? null, repaired: false, resultPath };
        const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
        return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
    }
    return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
