import * as fs from "node:fs";
import * as path from "node:path";
import { RESULTS_DIR, } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, } from "../shared/nested-events.js";
import { checkPidLiveness, isCompletedLifecycleStepState, isTerminalLifecycleState, lifecycleGeneration, transitionLifecycleStatus, } from "../shared/lifecycle-state.js";
import { terminalResultForStatusStep } from "../../shared/terminal-result.js";
import { boundChildError } from "../shared/child-protocol.js";
import { isAsyncStatusReadError } from "./async-status-boundary.js";
const STALE_MESSAGE_PREFIX = "Async runner process";
const STALE_MESSAGE_SUFFIX = "exited before writing a result. Marked run failed by stale-run reconciliation.";
const DEFAULT_STALE_ALIVE_PID_MS = 24 * 60 * 60 * 1000;
const STALE_REPAIR_GUARD_FAILED = Symbol("stale-repair-guard-failed");
function safeStatus(asyncDir, options = {}) {
    try {
        return readStatus(asyncDir, { ...options, cache: false });
    }
    catch (error) {
        if (isAsyncStatusReadError(error))
            throw error;
        return null;
    }
}
function appendRepairEvent(filePath, payload) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    }
    catch {
    }
}
const validPid = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const staleMessage = (pid) => boundChildError(`${STALE_MESSAGE_PREFIX} ${pid} ${STALE_MESSAGE_SUFFIX}`);
const staleAlivePidMessage = (pid, ageMs) => boundChildError(`Async runner process ${pid} still has a live PID, but status has not updated for ${ageMs}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`);
function failedStatus(status, now, message) {
    const steps = status.steps?.map((step) => isCompletedLifecycleStepState(step.status) ||
        step.status === "failed" ||
        step.status === "cancelled"
        ? step
        : {
            ...step,
            status: "failed",
            endedAt: step.endedAt ?? now,
            durationMs: step.durationMs ??
                (step.startedAt === undefined ? undefined : Math.max(0, now - step.startedAt)),
            exitCode: step.exitCode ?? 1,
            error: message,
            terminationReason: step.terminationReason ?? "process_exit",
            terminalResult: terminalResultForStatusStep(step, "failed"),
        });
    return {
        ...status,
        state: "failed",
        pid: undefined,
        pause: undefined,
        error: message,
        endedAt: status.endedAt ?? now,
        lastUpdate: now,
        ...(steps ? { steps } : {}),
    };
}
function resultStep(step, message) {
    const complete = isCompletedLifecycleStepState(step.status);
    return {
        agent: step.agent,
        output: "",
        success: complete,
        ...(complete ? {} : { error: message }),
        ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
        ...(step.ticketId ? { ticketId: step.ticketId } : {}),
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(step.exitSignal ? { exitSignal: step.exitSignal } : {}),
        ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
        ...(step.model ? { model: step.model } : {}),
        ...(step.modelIdentity ? { modelIdentity: step.modelIdentity } : {}),
        ...(step.modelResolution ? { modelResolution: step.modelResolution } : {}),
        ...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
        ...(step.modelAttempts ? { modelAttempts: step.modelAttempts } : {}),
        ...(step.terminationReason ? { terminationReason: step.terminationReason } : {}),
        ...(step.terminalResult ? { terminalResult: step.terminalResult } : {}),
    };
}
function resultArtifact(status, asyncDir, now, message) {
    const steps = status.steps ?? [];
    return {
        id: status.runId || path.basename(asyncDir),
        agent: steps[status.currentStep ?? 0]?.agent ?? steps[0]?.agent ?? "subagent",
        mode: status.mode,
        generation: lifecycleGeneration(status),
        success: false,
        state: "failed",
        summary: message,
        error: message,
        results: steps.map((step) => resultStep(step, message)),
        exitCode: 1,
        timestamp: now,
        durationMs: Math.max(0, now - status.startedAt),
        asyncDir,
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        ...(status.projectAgents ? { projectAgents: status.projectAgents } : {}),
    };
}
const protectedLifecycle = (status) => status.state === "pausing" || status.pause?.kind === "awaiting_supervisor";
function commitStaleFailure(asyncDir, observed, resultPath, now, message, guard) {
    let committed;
    try {
        committed = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(observed),
            mutate: (current) => {
                if (guard && !guard(current))
                    throw STALE_REPAIR_GUARD_FAILED;
                return failedStatus(current, now, message);
            },
        }).status;
    }
    catch {
        const latest = safeStatus(asyncDir);
        return {
            status: latest,
            repaired: false,
            resultPath,
            protectedLifecycle: latest ? protectedLifecycle(latest) : protectedLifecycle(observed),
        };
    }
    const artifact = resultArtifact(committed, asyncDir, now, message);
    if (!fs.existsSync(resultPath))
        try {
            writeAtomicJson(resultPath, artifact);
        }
        catch {
        }
    appendRepairEvent(path.join(asyncDir, "events.jsonl"), {
        type: "subagent.run.repaired_stale",
        ts: now,
        runId: committed.runId,
        pid: observed.pid,
        resultPath,
        message,
    });
    return {
        status: committed,
        repaired: true,
        resultPath,
        message,
        protectedLifecycle: protectedLifecycle(observed),
    };
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
        if (isTerminalLifecycleState(run.state))
            continue;
        const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
        if (!asyncDir)
            continue;
        const result = reconcileAsyncRun(asyncDir, {
            ...options,
            resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
        });
        if (!result.status || (!result.repaired && isTerminalLifecycleState(result.status.state)))
            continue;
        const ts = options.now?.() ?? Date.now();
        writeNestedEvent(route, {
            type: isTerminalLifecycleState(result.status.state)
                ? "subagent.nested.completed"
                : "subagent.nested.updated",
            ts,
            parentRunId: run.parentRunId,
            parentStepIndex: run.parentStepIndex,
            child: nestedSummaryFromAsyncStatus(result.status, asyncDir, {
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
    const observed = safeStatus(asyncDir, options.statusRead);
    if (!observed)
        return { status: null, repaired: false };
    const runId = observed.runId || path.basename(asyncDir);
    const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
    if (isTerminalLifecycleState(observed.state) || !validPid(observed.pid))
        return { status: observed, repaired: false, resultPath };
    const liveness = checkPidLiveness(observed.pid, options.kill);
    if (liveness !== "dead" && observed.state !== "running")
        return { status: observed, repaired: false, resultPath };
    const now = options.now?.() ?? Date.now();
    if (liveness !== "dead") {
        const staleAfterMs = options.staleAlivePidMs ?? DEFAULT_STALE_ALIVE_PID_MS;
        const lastUpdate = observed.lastUpdate ?? observed.startedAt;
        const ageMs = now - lastUpdate;
        if (ageMs <= staleAfterMs)
            return { status: observed, repaired: false, resultPath };
        return commitStaleFailure(asyncDir, observed, resultPath, now, staleAlivePidMessage(observed.pid, ageMs), (current) => current.state === "running" &&
            current.pid === observed.pid &&
            lifecycleGeneration(current) === lifecycleGeneration(observed) &&
            now - (current.lastUpdate ?? current.startedAt) > staleAfterMs);
    }
    return commitStaleFailure(asyncDir, observed, resultPath, now, staleMessage(observed.pid));
}
