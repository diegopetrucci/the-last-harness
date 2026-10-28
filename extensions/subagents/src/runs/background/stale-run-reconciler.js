// Generated from extensions/subagents/src/runs/background/stale-run-reconciler.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { RESULTS_DIR } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { checkPidLiveness, isCompletedLifecycleStepState, isTerminalLifecycleState, lifecycleGeneration, transitionLifecycleStatus, } from "../shared/lifecycle-state.js";
import { terminalResultForStatusStep } from "../../shared/terminal-result.js";
import { boundChildError } from "../shared/child-protocol.js";
import { isAsyncStatusReadError } from "./async-status-boundary.js";
import { finalizeSubagentRunTelemetry, mergeSubagentRunTelemetry, normalizeSubagentRunTelemetry, resolveSubagentTelemetryOutcome, resolveParallelSubagentTelemetryOutcome, } from "../../shared/telemetry.js";
const STALE_MESSAGE_PREFIX = "Async runner process";
const STALE_MESSAGE_SUFFIX = "exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.";
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
    const existingTelemetry = normalizeSubagentRunTelemetry(status.telemetry);
    const repairedTelemetry = existingTelemetry
        ? finalizeSubagentRunTelemetry(existingTelemetry, existingTelemetry.outcome?.state !== undefined &&
            !["queued", "running"].includes(existingTelemetry.outcome.state)
            ? existingTelemetry.outcome
            : { state: "failed", terminationReason: "process_exit" }, now)
        : undefined;
    return {
        ...status,
        state: "failed",
        pid: undefined,
        pause: undefined,
        error: message,
        endedAt: status.endedAt ?? now,
        lastUpdate: now,
        ...(steps ? { steps } : {}),
        ...(repairedTelemetry ? { telemetry: repairedTelemetry } : {}),
    };
}
function resultStep(step, message) {
    const complete = isCompletedLifecycleStepState(step.status);
    return {
        agent: step.agent,
        ...(typeof step.cwd === "string" && step.cwd.length > 0 ? { cwd: step.cwd } : {}),
        output: "",
        success: complete,
        ...(complete ? {} : { error: message }),
        ...(step.promptVariant ? { promptVariant: step.promptVariant } : {}),
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
        ...(status.telemetry ? { telemetry: status.telemetry } : {}),
    };
}
const protectedLifecycle = (status) => status.state === "pausing" || status.pause?.kind === "awaiting_supervisor";
function commitStaleFailure(asyncDir, observed, resultPath, now, message, guard) {
    let committed;
    try {
        committed = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(observed),
            carryMalformedAccounting: true,
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
export { checkPidLiveness };
function readResultForRepair(resultPath) {
    try {
        if (!fs.existsSync(resultPath))
            return undefined;
        const parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            return undefined;
        const rec = parsed;
        if (typeof rec.state !== "string")
            return undefined;
        return {
            id: typeof rec.id === "string" ? rec.id : undefined,
            generation: typeof rec.generation === "number" && Number.isSafeInteger(rec.generation)
                ? rec.generation
                : undefined,
            state: rec.state,
            success: typeof rec.success === "boolean" ? rec.success : undefined,
            results: Array.isArray(rec.results)
                ? rec.results
                : undefined,
            telemetry: normalizeSubagentRunTelemetry(rec.telemetry),
        };
    }
    catch {
        return undefined;
    }
}
function repairStatusFromResult(asyncDir, observed, resultPath, now) {
    const repair = readResultForRepair(resultPath);
    if (!repair)
        return undefined;
    const expectedRunId = observed.runId || path.basename(asyncDir);
    if (repair.id !== undefined && repair.id !== expectedRunId)
        return undefined;
    const isComplete = repair.state === "complete" || repair.state === "completed";
    const isFailed = repair.state === "failed";
    if (!isComplete && !isFailed)
        return undefined;
    const observedGeneration = lifecycleGeneration(observed);
    if (typeof repair.generation === "number" && repair.generation !== observedGeneration)
        return undefined;
    const mergedTelemetry = mergeSubagentRunTelemetry(repair.telemetry, observed.telemetry);
    const isTerminalTelemetryState = (state) => state === "completed" || state === "failed" || state === "cancelled" || state === "paused";
    const resultOutcome = mergedTelemetry?.outcome;
    const runOutcome = resultOutcome && isTerminalTelemetryState(resultOutcome.state)
        ? resultOutcome
        : resolveSubagentTelemetryOutcome({
            state: repair.state,
            success: isComplete,
            terminationReason: isFailed ? "process_exit" : undefined,
        });
    let repairedTelemetry = mergedTelemetry;
    if (repairedTelemetry) {
        const updatedSteps = repairedTelemetry.steps.map((step) => {
            if (step.outcome && isTerminalTelemetryState(step.outcome.state))
                return step;
            const child = repair.results?.[step.index];
            if (!child)
                return { ...step, ...(runOutcome ? { outcome: runOutcome } : {}) };
            const childOutcome = resolveSubagentTelemetryOutcome({
                success: child.success === true,
                terminationReason: typeof child.terminationReason === "string"
                    ? child.terminationReason
                    : isFailed
                        ? "process_exit"
                        : undefined,
            });
            return { ...step, ...(childOutcome ? { outcome: childOutcome } : {}) };
        });
        const aggregateOutcome = updatedSteps.length > 1
            ? (resolveParallelSubagentTelemetryOutcome(updatedSteps.map((s) => (s.outcome ? { ...s.outcome } : {}))) ?? runOutcome)
            : runOutcome;
        repairedTelemetry = {
            ...repairedTelemetry,
            steps: updatedSteps,
            ...(aggregateOutcome ? { outcome: aggregateOutcome } : {}),
        };
    }
    const repairedSteps = observed.steps?.map((step) => {
        if (isCompletedLifecycleStepState(step.status) || step.status === "failed")
            return step;
        const child = repair.results?.[observed.steps.indexOf(step)];
        const childSuccess = child?.success === true;
        return {
            ...step,
            status: childSuccess ? "complete" : "failed",
            endedAt: step.endedAt ?? now,
            exitCode: childSuccess ? (step.exitCode ?? 0) : (step.exitCode ?? 1),
            ...(typeof child?.error === "string" ? { error: child.error } : {}),
            terminationReason: step.terminationReason ?? (childSuccess ? undefined : "process_exit"),
            terminalResult: terminalResultForStatusStep(step, childSuccess ? "complete" : "failed"),
        };
    });
    const observedPid = observed.pid;
    let committed;
    try {
        committed = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: observedGeneration,
            carryMalformedAccounting: true,
            mutate: (current) => {
                if (isTerminalLifecycleState(current.state))
                    throw STALE_REPAIR_GUARD_FAILED;
                if (current.pid !== observedPid)
                    throw STALE_REPAIR_GUARD_FAILED;
                return {
                    ...current,
                    state: isComplete ? "complete" : "failed",
                    pid: undefined,
                    error: isFailed ? (current.error ?? "Async run failed.") : undefined,
                    endedAt: current.endedAt ?? now,
                    lastUpdate: now,
                    ...(repairedSteps ? { steps: repairedSteps } : {}),
                    ...(repairedTelemetry ? { telemetry: repairedTelemetry } : {}),
                };
            },
        }).status;
    }
    catch {
        const latest = safeStatus(asyncDir);
        return { status: latest ?? observed, repaired: false, resultPath };
    }
    appendRepairEvent(path.join(asyncDir, "events.jsonl"), {
        type: "subagent.run.repaired_stale",
        ts: now,
        runId: committed.runId,
        resultPath,
        message: `Stale run repaired from existing result artifact (state=${committed.state}).`,
    });
    return { status: committed, repaired: true, resultPath };
}
export function reconcileAsyncRun(asyncDir, options = {}) {
    const observed = safeStatus(asyncDir, options.statusRead);
    if (!observed)
        return { status: null, repaired: false };
    const runId = observed.runId || path.basename(asyncDir);
    const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
    if (isTerminalLifecycleState(observed.state) || !validPid(observed.pid)) {
        if (!isTerminalLifecycleState(observed.state) && !validPid(observed.pid)) {
            const resultRepair = repairStatusFromResult(asyncDir, observed, resultPath, options.now?.() ?? Date.now());
            if (resultRepair)
                return resultRepair;
        }
        return { status: observed, repaired: false, resultPath };
    }
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
