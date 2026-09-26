import { writeAtomicJson } from "../../shared/atomic-json.js";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, } from "../../shared/types.js";
import { resolveSubagentTelemetryOutcome, telemetryFromRunnerResults, } from "../../shared/telemetry.js";
import { normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
function buildRunnerTelemetry(input, state, endedAt, success) {
    return telemetryFromRunnerResults({
        runId: input.config.id,
        mode: input.plan.kind,
        results: input.results,
        provenance: input.config.telemetry?.provenance,
        controls: input.controlConfig,
        startedAt: input.overallStartTime,
        endedAt,
        activeRuntimeMs: input.statusPayload.activeRuntimeMs,
        statusSteps: input.statusPayload.steps,
        lineage: input.config.telemetry?.lineage,
        outcome: resolveSubagentTelemetryOutcome({
            state,
            timedOut: input.statusOwner.timedOut,
            interrupted: input.statusOwner.interrupted,
            success,
            terminationReason: input.statusOwner.terminalReason.reason,
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
    return input.results.every((result) => result.success) ? "complete" : "failed";
}
function applyTerminalStatus(input) {
    const { statusPayload } = input;
    statusPayload.state = terminalStatus(input);
    statusPayload.activityState = undefined;
    if (input.statusOwner.timedOut) {
        statusPayload.timedOut = true;
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
    statusPayload.shareUrl = input.shareUrl;
    statusPayload.gistUrl = input.gistUrl;
    statusPayload.shareError = input.shareError;
    if (statusPayload.state === "failed" && !statusPayload.error) {
        const failedStep = statusPayload.steps.find((step) => step.status === "failed");
        if (failedStep?.agent)
            statusPayload.error = failedStep.error ?? `Step failed: ${failedStep.agent}`;
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
    return input.results.every((result) => result.success) ? "complete" : "failed";
}
function resultSummary(input, state, paused) {
    if (state === "failed" &&
        (input.statusPayload.timedOut ||
            (!input.statusOwner.concurrentTerminalStatusAdopted && input.statusOwner.timedOut)))
        return input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.";
    if (paused) {
        const requesterIndex = input.statusOwner.supervisorPauseRequest?.requesterIndex ?? 0;
        const requesterAgent = input.statusPayload.steps[requesterIndex]?.agent ?? input.agentName;
        return input.pausedOutputForIndex(requesterIndex, requesterAgent);
    }
    if (state === "failed") {
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
function resultItems(results) {
    return results.map((result) => ({
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        tkTicketId: result.tkTicketId,
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
        toolBudget: result.toolBudget,
        toolBudgetBlocked: result.toolBudgetBlocked || undefined,
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
        acceptance: result.acceptance,
        pause: result.pause,
        activeRuntimeMs: result.activeRuntimeMs,
        activeRuntimeCheckpointAt: result.activeRuntimeCheckpointAt,
        activityState: result.activityState,
        idleEpisodeId: result.idleEpisodeId,
        durableAttentionReasons: result.durableAttentionReasons,
        compaction: result.compaction,
    }));
}
function writeResultArtifact(input, telemetry, state, paused, startedAt, endedAt) {
    const timedOut = input.statusPayload.timedOut ||
        (!input.statusOwner.concurrentTerminalStatusAdopted && input.statusOwner.timedOut);
    const deadlineAt = canonicalStatusValue(input, input.statusPayload.deadlineAt, input.config.deadlineAt);
    const totalCost = canonicalStatusValue(input, input.statusPayload.totalCost, input.finalTotalCost);
    const sessionFile = canonicalStatusValue(input, input.statusPayload.sessionFile, input.effectiveSessionFile);
    const shareUrl = canonicalStatusValue(input, input.statusPayload.shareUrl, input.shareUrl);
    const gistUrl = canonicalStatusValue(input, input.statusPayload.gistUrl, input.gistUrl);
    const shareError = canonicalStatusValue(input, input.statusPayload.shareError, input.shareError);
    const artifactsDir = canonicalStatusValue(input, input.statusPayload.artifactsDir, input.artifactsDir);
    const cwd = canonicalStatusValue(input, input.statusPayload.cwd, input.cwd) ?? input.cwd;
    const sessionId = canonicalStatusValue(input, input.statusPayload.sessionId, input.config.sessionId ?? undefined);
    const projectAgents = canonicalStatusValue(input, input.statusPayload.projectAgents, input.config.projectAgents);
    const result = {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        id: input.config.id,
        agent: input.agentName,
        mode: input.statusPayload.mode,
        success: state === "complete",
        state,
        summary: resultSummary(input, state, paused),
        ...(telemetry ? { telemetry } : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(input.statusPayload.toolBudget ? { toolBudget: input.statusPayload.toolBudget } : {}),
        ...(input.statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
        ...(timedOut && state === "failed"
            ? {
                timedOut: true,
                error: input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.",
            }
            : state === "failed"
                ? {
                    error: input.statusPayload.error ??
                        "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
                }
                : {}),
        ...(paused ? { pause: paused } : {}),
        ...(normalizeActiveRuntimeMs(input.statusPayload.activeRuntimeMs) !== undefined
            ? { activeRuntimeMs: normalizeActiveRuntimeMs(input.statusPayload.activeRuntimeMs) }
            : {}),
        ...(normalizeActiveRuntimeCheckpointAt(input.statusPayload.activeRuntimeCheckpointAt) !==
            undefined
            ? {
                activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(input.statusPayload.activeRuntimeCheckpointAt),
            }
            : {}),
        results: resultItems(input.results),
        exitCode: state === "failed" ? 1 : 0,
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
        sessionFile,
        shareUrl,
        gistUrl,
        shareError,
        ...(input.taskIndex !== undefined ? { taskIndex: input.taskIndex } : {}),
        ...(input.totalTasks !== undefined ? { totalTasks: input.totalTasks } : {}),
    };
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
        writeAtomicJson(input.resultPath, {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            id: input.config.id,
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
                    tkTicketId: firstStep?.tkTicketId,
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
        });
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
        input.statusOwner.writeStatusPayload({ lifecycleLocked: true });
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
    const shareUrl = canonicalStatusValue(input, input.statusPayload.shareUrl, input.shareUrl);
    const shareError = canonicalStatusValue(input, input.statusPayload.shareError, input.shareError);
    input.statusOwner.emitNestedSelfEvent("subagent.nested.completed");
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
        shareUrl,
        shareError,
    });
    writeResultArtifact(input, finalTelemetry, state, resultPaused, startedAt, endedAt);
}
