// Generated from extensions/subagents/src/runs/background/terminal-persistence.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { lifecycleGeneration } from "../shared/lifecycle-state.js";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, } from "../../shared/types.js";
import { resolveSubagentTelemetryOutcome, telemetryFromRunnerResults, } from "../../shared/telemetry.js";
import { writeNormalizedLifecycleStatus } from "../shared/lifecycle-state.js";
import { tryWriteTerminalRecordFromArtifact } from "./terminal-record.js";
export function buildPausedRunnerTelemetry(input) {
    const provenance = input.config.telemetry?.provenance;
    if (!provenance)
        return undefined;
    return telemetryFromRunnerResults({
        runId: input.config.id,
        execution: input.config.awaited ? "foreground" : "async",
        mode: input.plan.kind,
        results: input.results,
        provenance,
        controls: input.controlConfig,
        startedAt: input.overallStartTime,
        endedAt: input.endedAt,
        activeRuntimeMs: input.activeRuntimeMs,
        statusSteps: input.statusSteps,
        lineage: input.config.telemetry?.lineage,
        outcome: { state: "paused", terminationReason: "paused" },
    });
}
function canonicalTimedOut(input) {
    return (input.statusPayload.timedOut === true ||
        input.statusOwner.timedOut ||
        input.statusPayload.steps.some((step) => step.timedOut === true) ||
        input.results.some((result) => result.timedOut === true));
}
function timeoutWonRun(input) {
    const reason = input.statusOwner.terminalReason.reason;
    if (input.statusOwner.concurrentTerminalStatusAdopted &&
        (input.statusPayload.state === "cancelled" ||
            input.statusPayload.state === "continued" ||
            input.statusPayload.state === "complete"))
        return false;
    return (canonicalTimedOut(input) &&
        input.statusPayload.state !== "paused" &&
        input.statusPayload.state !== "pausing" &&
        !input.statusOwner.interrupted &&
        reason !== "output_limit" &&
        reason !== "interrupted" &&
        reason !== "paused");
}
function buildRunnerTelemetry(input, state, endedAt, success) {
    return telemetryFromRunnerResults({
        runId: input.config.id,
        execution: input.config.awaited ? "foreground" : "async",
        mode: input.plan.kind,
        results: input.results,
        provenance: input.config.telemetry?.provenance,
        controls: input.controlConfig,
        startedAt: input.overallStartTime,
        endedAt,
        statusSteps: input.statusPayload.steps,
        lineage: input.config.telemetry?.lineage,
        outcome: resolveSubagentTelemetryOutcome({
            state,
            timedOut: timeoutWonRun(input),
            interrupted: input.statusOwner.interrupted,
            success,
            terminationReason: input.statusOwner.terminalReason.reason ?? (timeoutWonRun(input) ? "timed_out" : undefined),
        }),
    });
}
function terminalStatus(input) {
    if (input.statusOwner.terminalReason.reason === "output_limit")
        return "failed";
    if (input.statusOwner.supervisorPauseTransitionFailed)
        return "failed";
    if (input.statusOwner.timedOut)
        return "failed";
    if (input.statusOwner.interrupted)
        return "paused";
    if (canonicalTimedOut(input))
        return "failed";
    return input.results.every((result) => result.success) ? "complete" : "failed";
}
function clearPauseOwnerPid(pause) {
    return pause ? { ...pause, ownerPid: undefined } : undefined;
}
function releaseStoppedInterruptedOwnership(input) {
    if (input.statusPayload.state !== "paused" ||
        !input.statusOwner.interrupted ||
        input.pausedOwnershipConfirmedStopped !== true)
        return false;
    input.statusPayload.pid = undefined;
    input.statusPayload.pause = clearPauseOwnerPid(input.statusPayload.pause);
    input.statusPayload.steps = input.statusPayload.steps.map((step) => ({
        ...step,
        pause: clearPauseOwnerPid(step.pause),
    }));
    return true;
}
function applyTerminalStatus(input) {
    const { statusPayload } = input;
    const timedOut = timeoutWonRun(input);
    statusPayload.state = terminalStatus(input);
    statusPayload.activityState = undefined;
    releaseStoppedInterruptedOwnership(input);
    if (timedOut)
        statusPayload.timedOut = true;
    if (input.statusOwner.timedOut) {
        statusPayload.error = input.timeoutMessage ?? "Subagent timed out.";
    }
    if (input.statusOwner.supervisorPauseTransitionFailed && statusPayload.state === "failed") {
        statusPayload.error =
            statusPayload.error ??
                "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";
    }
    statusPayload.endedAt = input.runEndedAt;
    statusPayload.lastUpdate = input.runEndedAt;
    statusPayload.sessionFile = input.effectiveSessionFile;
    statusPayload.totalCost = input.finalTotalCost;
    if (statusPayload.state === "failed" && !statusPayload.error) {
        const failedStep = timedOut
            ? statusPayload.steps.find((step) => step.status === "failed" && step.timedOut === true)
            : statusPayload.steps.find((step) => step.status === "failed");
        if (failedStep?.agent)
            statusPayload.error =
                failedStep.error ??
                    (timedOut
                        ? (input.timeoutMessage ?? "Subagent timed out.")
                        : `Step failed: ${failedStep.agent}`);
        else if (timedOut)
            statusPayload.error = input.timeoutMessage ?? "Subagent timed out.";
    }
    const telemetry = buildRunnerTelemetry(input, statusPayload.state, input.runEndedAt, input.results.length > 0 && input.results.every((result) => result.success));
    if (telemetry)
        statusPayload.telemetry = telemetry;
    input.statusOwner.writeStatusPayload();
    return statusPayload.telemetry ?? telemetry;
}
function resultState(input, resultPausedAwaitingSupervisor) {
    if (input.statusOwner.concurrentTerminalStatusAdopted)
        return input.statusPayload.state;
    if (input.statusOwner.terminalReason.reason === "output_limit")
        return "failed";
    if (input.statusOwner.timedOut)
        return "failed";
    if (resultPausedAwaitingSupervisor)
        return "paused";
    if (input.statusOwner.supervisorPauseTransitionFailed)
        return "failed";
    if (input.statusPayload.state === "failed" ||
        input.statusPayload.state === "paused" ||
        input.statusPayload.state === "cancelled" ||
        input.statusPayload.state === "continued")
        return input.statusPayload.state;
    if (input.statusOwner.interrupted)
        return "paused";
    if (canonicalTimedOut(input))
        return "failed";
    return input.results.every((result) => result.success) ? "complete" : "failed";
}
function resultSummary(input, state, paused) {
    if (state === "failed" && timeoutWonRun(input))
        return input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.";
    if (paused) {
        const requesterIndex = input.statusOwner.supervisorPauseRequest?.requesterIndex ?? 0;
        const requesterAgent = input.statusPayload.steps[requesterIndex]?.agent ?? input.agentName;
        return input.pausedOutputForIndex(requesterIndex, requesterAgent);
    }
    if (state === "failed") {
        if (input.config.awaited) {
            return input.statusOwner.supervisorPauseTransitionFailed
                ? "Async supervisor lifecycle update failed. The run was stopped safely and marked failed."
                : input.summary;
        }
        return (input.statusPayload.error ??
            (input.statusOwner.supervisorPauseTransitionFailed
                ? "Async supervisor lifecycle update failed. The run was stopped safely and marked failed."
                : input.summary));
    }
    if (state === "paused")
        return "Paused after interrupt. Waiting for explicit next action.";
    return input.summary;
}
function resultPauseBeforeTerminalWrite(input) {
    if (input.pausedAwaitingSupervisor)
        return input.pausedAwaitingSupervisor;
    if (input.safePausedResultAfterReap &&
        !input.statusOwner.supervisorPauseTransitionFailed &&
        !input.statusOwner.concurrentTerminalStatusAdopted)
        return input.safePausedResultAfterReap;
    return undefined;
}
function resultPauseFromCanonicalStatus(input, fallback) {
    return input.statusPayload.state === "paused"
        ? (input.statusPayload.pause ?? fallback)
        : undefined;
}
function canonicalStatusValue(input, value, fallback) {
    return input.statusOwner.concurrentTerminalStatusAdopted ? value : (value ?? fallback);
}
function resultItems(results, clearPauseOwnerPids = false) {
    return results.map((result) => ({
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        ticketId: result.ticketId,
        output: result.output,
        error: result.error,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
        protocolOutputLimit: result.protocolOutputLimit,
        success: result.success,
        exitCode: result.exitCode,
        exitSignal: result.exitSignal,
        skipped: result.skipped || undefined,
        interrupted: result.interrupted || undefined,
        timedOut: result.timedOut || undefined,
        timeoutOwner: result.timeoutOwner,
        activeRuntimeMs: result.activeRuntimeMs,
        contextUsage: result.contextUsage,
        contextPressure: result.contextPressure,
        contextPressureCrossedThresholds: result.contextPressureCrossedThresholds,
        terminationReason: result.terminationReason,
        sessionFile: result.sessionFile,
        model: result.model,
        modelIdentity: result.modelIdentity,
        modelResolution: result.modelResolution,
        attemptedModels: result.attemptedModels,
        modelAttempts: result.modelAttempts,
        modelFallbackNotice: result.modelFallbackNotice,
        totalCost: result.totalCost,
        artifactPaths: result.artifactPaths,
        processCleanup: result.processCleanup,
        truncated: result.truncated,
        transcriptPath: result.transcriptPath,
        transcriptError: result.transcriptError,
        skills: result.skills,
        skillsWarning: result.skillsWarning,
        outputMode: result.outputMode,
        savedOutputPath: result.savedOutputPath,
        outputReference: result.outputReference,
        outputSaveError: result.outputSaveError,
        childLocation: result.childLocation,
        finalOutput: result.finalOutput,
        pause: clearPauseOwnerPids ? clearPauseOwnerPid(result.pause) : result.pause,
        ...(result.cancel ? { cancel: result.cancel } : {}),
        activityState: result.activityState,
        ...(result.terminalResult ? { terminalResult: result.terminalResult } : {}),
        ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
    }));
}
function writeResultArtifact(input, telemetry, state, paused, startedAt, endedAt) {
    const timedOut = timeoutWonRun(input);
    const deadlineAt = canonicalStatusValue(input, input.statusPayload.deadlineAt, input.config.deadlineAt);
    const totalCost = canonicalStatusValue(input, input.statusPayload.totalCost, input.finalTotalCost);
    const sessionFile = canonicalStatusValue(input, input.statusPayload.sessionFile, input.effectiveSessionFile);
    const shareUrl = canonicalStatusValue(input, input.statusPayload.shareUrl, undefined);
    const gistUrl = canonicalStatusValue(input, input.statusPayload.gistUrl, undefined);
    const shareError = canonicalStatusValue(input, input.statusPayload.shareError, undefined);
    const artifactsDir = canonicalStatusValue(input, input.statusPayload.artifactsDir, input.artifactsDir);
    const cwd = canonicalStatusValue(input, input.statusPayload.cwd, input.cwd) ?? input.cwd;
    const sessionId = canonicalStatusValue(input, input.statusPayload.sessionId, input.config.sessionId ?? undefined);
    const projectAgents = canonicalStatusValue(input, input.statusPayload.projectAgents, input.config.projectAgents);
    const clearPauseOwnerPids = state === "paused" &&
        input.statusOwner.interrupted &&
        input.pausedOwnershipConfirmedStopped === true;
    const result = {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        id: input.config.id,
        generation: lifecycleGeneration(input.statusPayload),
        agent: input.agentName,
        mode: input.statusPayload.mode,
        success: state === "complete",
        state,
        summary: resultSummary(input, state, paused),
        ...(input.config.awaited ? { awaited: true } : {}),
        ...(telemetry ? { telemetry } : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(state === "failed"
            ? {
                error: timeoutWonRun(input)
                    ? (input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.")
                    : (input.statusPayload.error ??
                        "Async supervisor lifecycle update failed. The run was stopped safely and marked failed."),
            }
            : {}),
        ...(paused ? { pause: paused } : {}),
        results: resultItems(input.results, clearPauseOwnerPids),
        exitCode: state === "failed" || state === "cancelled" ? 1 : 0,
        timestamp: endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        totalTokens: input.statusPayload.totalTokens,
        totalCost,
        truncated: input.truncated,
        artifactsDir,
        cwd,
        asyncDir: input.asyncDir,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(projectAgents ? { projectAgents } : {}),
        ...(sessionFile !== undefined ? { sessionFile } : {}),
        ...(shareUrl !== undefined ? { shareUrl } : {}),
        ...(gistUrl !== undefined ? { gistUrl } : {}),
        ...(shareError !== undefined ? { shareError } : {}),
        ...(input.taskIndex !== undefined ? { taskIndex: input.taskIndex } : {}),
        ...(input.totalTasks !== undefined ? { totalTasks: input.totalTasks } : {}),
    };
    tryWriteTerminalRecordFromArtifact(input.asyncDir, result);
    try {
        writeAtomicJson(input.resultPath, result);
    }
    catch (error) {
        console.error(`Failed to write result file ${input.resultPath}:`, error);
    }
}
export function persistContinuationGateRejection(input) {
    const { statusPayload } = input;
    const endedAt = Date.now();
    statusPayload.state = "failed";
    statusPayload.pid = undefined;
    statusPayload.endedAt = endedAt;
    statusPayload.lastUpdate = endedAt;
    statusPayload.error = `Continuation launch gate rejected for source run '${input.sourceRunId}' child ${input.sourceIndex}.`;
    statusPayload.steps = statusPayload.steps.map((step, index) => index === 0
        ? {
            ...step,
            status: "failed",
            endedAt,
            exitCode: 1,
            terminationReason: step.terminationReason ?? "process_exit",
            error: statusPayload.error,
        }
        : step);
    const firstStep = statusPayload.steps[0];
    const gateResults = statusPayload.steps.map((step, index) => ({
        index,
        agent: step.agent,
        ...(index === 0 ? { success: false, terminationReason: "process_exit" } : {}),
    }));
    const gateTelemetry = telemetryFromRunnerResults({
        runId: input.config.id,
        execution: input.config.awaited ? "foreground" : "async",
        mode: input.plan.kind,
        results: gateResults.length > 0
            ? gateResults
            : [
                {
                    index: 0,
                    agent: firstStep?.agent ?? "subagent",
                    success: false,
                    terminationReason: "process_exit",
                },
            ],
        provenance: input.config.telemetry?.provenance,
        controls: input.controlConfig,
        startedAt: input.overallStartTime,
        endedAt,
        statusSteps: statusPayload.steps,
        lineage: input.config.telemetry?.lineage,
        outcome: { state: "failed", terminationReason: "process_exit" },
    });
    if (gateTelemetry)
        statusPayload.telemetry = gateTelemetry;
    writeNormalizedLifecycleStatus(input.asyncDir, statusPayload);
    const agent = firstStep?.agent ?? "subagent";
    try {
        const gateArtifact = {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            id: input.config.id,
            generation: lifecycleGeneration(statusPayload),
            agent,
            mode: statusPayload.mode,
            success: false,
            state: "failed",
            summary: statusPayload.error,
            ...(gateTelemetry ? { telemetry: gateTelemetry } : {}),
            error: statusPayload.error,
            results: [
                {
                    agent,
                    ...(firstStep?.projectAgent ? { projectAgent: firstStep.projectAgent } : {}),
                    ticketId: firstStep?.ticketId,
                    output: statusPayload.error,
                    error: statusPayload.error,
                    success: false,
                    exitCode: 1,
                },
            ],
            exitCode: 1,
            timestamp: endedAt,
            durationMs: 0,
            asyncDir: input.asyncDir,
            sessionId: input.config.sessionId,
            ...(input.config.projectAgents ? { projectAgents: input.config.projectAgents } : {}),
        };
        tryWriteTerminalRecordFromArtifact(input.asyncDir, gateArtifact);
        writeAtomicJson(input.resultPath, gateArtifact);
    }
    catch (error) {
        console.error(`Failed to write gate-rejection result file ${input.resultPath}:`, error);
    }
}
export function persistRunnerTerminalRun(input) {
    let finalTelemetry;
    if (!input.pausedAwaitingSupervisor &&
        !input.skipFinalStatusWrite &&
        !input.statusOwner.concurrentTerminalStatusAdopted) {
        finalTelemetry = applyTerminalStatus(input);
    }
    const preWritePaused = resultPauseBeforeTerminalWrite(input);
    let state = resultState(input, preWritePaused);
    const preWriteEndedAt = input.statusPayload.endedAt ?? input.runEndedAt;
    finalTelemetry ??=
        (input.statusOwner.concurrentTerminalStatusAdopted
            ? input.statusPayload.telemetry
            : undefined) ?? buildRunnerTelemetry(input, state, preWriteEndedAt, state === "complete");
    if (input.pausedAwaitingSupervisor &&
        finalTelemetry &&
        !input.statusOwner.concurrentTerminalStatusAdopted) {
        input.statusPayload.telemetry = finalTelemetry;
        input.statusOwner.writeStatusPayload();
    }
    const resultPaused = resultPauseFromCanonicalStatus(input, preWritePaused);
    state = resultState(input, resultPaused);
    const startedAt = input.statusPayload.startedAt ?? input.overallStartTime;
    const endedAt = input.statusPayload.endedAt ?? input.runEndedAt;
    finalTelemetry =
        input.statusPayload.telemetry ??
            buildRunnerTelemetry(input, state, endedAt, state === "complete");
    const totalCost = canonicalStatusValue(input, input.statusPayload.totalCost, input.finalTotalCost);
    const artifactsDir = canonicalStatusValue(input, input.statusPayload.artifactsDir, input.artifactsDir);
    const cwd = canonicalStatusValue(input, input.statusPayload.cwd, input.cwd) ?? input.cwd;
    const sessionFile = canonicalStatusValue(input, input.statusPayload.sessionFile, input.effectiveSessionFile);
    input.appendEvent(JSON.stringify({
        type: "subagent.run.completed",
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        ts: endedAt,
        runId: input.config.id,
        status: state,
        durationMs: Math.max(0, endedAt - startedAt),
        totalTokens: input.statusPayload.totalTokens,
        totalCost,
    }));
    input.writeRunLog({
        id: input.config.id,
        mode: input.statusPayload.mode,
        cwd,
        startedAt,
        endedAt,
        steps: input.statusPayload.steps.map((step) => ({
            agent: step.agent,
            status: step.status,
            durationMs: step.durationMs,
            processCleanup: step.processCleanup,
        })),
        summary: input.summary,
        truncated: input.truncated,
        artifactsDir,
        sessionFile,
    });
    writeResultArtifact(input, finalTelemetry, state, resultPaused, startedAt, endedAt);
}
