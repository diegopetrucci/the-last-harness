import * as path from "node:path";
import { ASYNC_DIR, } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { lifecycleContinuationForIndex, lifecycleGeneration, normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, transitionLifecycleStatus, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { canonicalSubagentModelIdentity } from "../shared/model-fallback.js";
export function indexedLifecycleContinuation(status, index = 0) {
    return lifecycleContinuationForIndex(status, index);
}
export function isClaimedPausedLifecycle(status, index = 0) {
    const continuation = indexedLifecycleContinuation(status, index);
    return (status?.state === "paused" &&
        typeof continuation?.claimToken === "string" &&
        continuation.claimToken.length > 0);
}
export function pausedForegroundStatusPath(runId) {
    return path.join(ASYNC_DIR, runId);
}
function pausedForegroundStepStatus(result) {
    if (result.cancel?.cancelledAt)
        return "cancelled";
    if (result.pause)
        return "paused";
    if (result.interrupted && !result.sessionFile && !result.pause)
        return "pending";
    if (result.interrupted)
        return "paused";
    if (result.exitCode === 0)
        return "completed";
    return "failed";
}
export function isTerminalForegroundResultSnapshot(result, progress) {
    if (result.cancel?.cancelledAt || result.pause || result.interrupted)
        return true;
    if (progress?.status === "completed" || progress?.status === "failed")
        return true;
    return result.exitCode !== 0;
}
export function persistPausedForegroundCohortRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const now = Date.now();
    const derivedPause = input.pause ??
        input.results?.find((result) => result.pause?.kind === "awaiting_supervisor")?.pause;
    const pause = derivedPause
        ? {
            kind: derivedPause.kind,
            ...(derivedPause.summary ? { summary: derivedPause.summary } : {}),
            ...(derivedPause.requestedAt !== undefined
                ? { requestedAt: derivedPause.requestedAt }
                : {}),
            ...(input.stage === "pausing" && input.ownerPid !== undefined
                ? { ownerPid: input.ownerPid }
                : {}),
            ...(input.stage === "paused"
                ? { pausedAt: derivedPause.pausedAt ?? now, ownerPid: undefined }
                : {}),
            ...(derivedPause.request ? { request: derivedPause.request } : {}),
        }
        : undefined;
    const steps = (input.steps ??
        input.results?.map((result) => ({
            agent: result.agent,
            ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
            status: input.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result),
            sessionFile: result.sessionFile,
            transcriptPath: result.transcriptPath,
            transcriptError: result.transcriptError,
            startedAt: result.progress?.durationMs !== undefined
                ? Math.max(0, now - result.progress.durationMs)
                : undefined,
            endedAt: input.stage === "paused" ? now : undefined,
            durationMs: result.progress?.durationMs,
            activeRuntimeMs: normalizeActiveRuntimeMs(result.activeRuntimeMs) ??
                normalizeActiveRuntimeMs(result.progress?.durationMs),
            ...(normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt) !== undefined
                ? {
                    activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt),
                }
                : {}),
            model: result.model,
            thinking: result.modelIdentity?.thinking ?? result.thinking,
            ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
            ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
            ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
            ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
            ...(result.contextPressureCrossedThresholds
                ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
                : {}),
            ...(pausedForegroundTerminationReason(result)
                ? { terminationReason: pausedForegroundTerminationReason(result) }
                : {}),
            exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
            ...(result.acceptance ? { acceptance: result.acceptance } : {}),
            ...(result.pause
                ? {
                    pause: {
                        kind: result.pause.kind,
                        ...(result.pause.summary ? { summary: result.pause.summary } : {}),
                        ...(result.pause.requestedAt !== undefined
                            ? { requestedAt: result.pause.requestedAt }
                            : {}),
                        ...(input.stage === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
                        ...(result.pause.request ? { request: result.pause.request } : {}),
                    },
                }
                : {}),
            ...(result.cancel ? { cancel: result.cancel } : {}),
        })) ??
        []).map((step) => (step.status === "pausing" || step.status === "paused") && step.pause
        ? { ...step, terminationReason: "paused" }
        : step);
    const activeRuntimeValues = steps
        .map((step) => normalizeActiveRuntimeMs(step.activeRuntimeMs))
        .filter((value) => value !== undefined);
    const activeRuntimeCheckpointValues = steps
        .map((step) => normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt))
        .filter((value) => value !== undefined);
    const activeRuntimeMs = activeRuntimeValues.length > 0
        ? activeRuntimeValues.reduce((sum, value) => sum + value, 0)
        : undefined;
    const activeRuntimeCheckpointAt = activeRuntimeCheckpointValues.length > 0
        ? Math.max(...activeRuntimeCheckpointValues)
        : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = readStatus(asyncDir);
        if (!current) {
            writeNormalizedLifecycleStatus(asyncDir, {
                runId: input.runId,
                ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                mode: input.mode,
                state: input.stage,
                startedAt: input.startedAt ?? now,
                lastUpdate: now,
                ...(input.stage === "paused" ? { endedAt: now } : {}),
                cwd: input.cwd,
                ...(pause ? { pause } : {}),
                ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
                ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
                ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
                pid: input.stage === "pausing" ? input.ownerPid : undefined,
                steps,
            });
            return;
        }
        try {
            transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(current),
                mutate: (status) => {
                    const nextStage = status.state === "paused" && input.stage === "pausing" ? "paused" : input.stage;
                    return {
                        ...status,
                        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                        state: nextStage,
                        pid: nextStage === "pausing" ? input.ownerPid : undefined,
                        lastUpdate: now,
                        ...(nextStage === "paused" ? { endedAt: now } : {}),
                        cwd: input.cwd,
                        ...(pause ? { pause } : {}),
                        ...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
                        ...(activeRuntimeMs !== undefined
                            ? {
                                activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(status.activeRuntimeMs) ?? 0, activeRuntimeMs),
                            }
                            : {}),
                        ...(activeRuntimeCheckpointAt !== undefined
                            ? {
                                activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt) ?? 0, activeRuntimeCheckpointAt),
                            }
                            : {}),
                        steps,
                    };
                },
            });
            return;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes("expected generation") &&
                !message.includes("persisted status was not found"))
                throw error;
        }
    }
    throw new Error(`Foreground cohort lifecycle update failed for run '${input.runId}'.`);
}
export function pausedForegroundTerminationReason(result, pauseProjected = false) {
    return pauseProjected || result.pause ? "paused" : result.terminationReason;
}
export function buildPausedStepFromResult(result, now, options = { stage: "paused" }) {
    const status = options.status ??
        (options.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result));
    return {
        agent: result.agent,
        ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
        status,
        sessionFile: result.sessionFile,
        transcriptPath: result.transcriptPath,
        transcriptError: result.transcriptError,
        startedAt: result.progress?.durationMs !== undefined
            ? Math.max(0, now - result.progress.durationMs)
            : undefined,
        endedAt: options.stage === "paused" ||
            status === "paused" ||
            status === "completed" ||
            status === "failed" ||
            status === "cancelled"
            ? now
            : undefined,
        durationMs: result.progress?.durationMs,
        activeRuntimeMs: normalizeActiveRuntimeMs(result.activeRuntimeMs) ??
            normalizeActiveRuntimeMs(result.progress?.durationMs),
        ...(normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt) !== undefined
            ? {
                activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(result.activeRuntimeCheckpointAt),
            }
            : {}),
        model: result.model,
        thinking: result.modelIdentity?.thinking ?? result.thinking,
        ...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
        ...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
        exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
        ...(result.acceptance ? { acceptance: result.acceptance } : {}),
        ...(result.pause
            ? {
                pause: {
                    kind: result.pause.kind,
                    ...(result.pause.summary ? { summary: result.pause.summary } : {}),
                    ...(result.pause.requestedAt !== undefined
                        ? { requestedAt: result.pause.requestedAt }
                        : {}),
                    ...(status === "pausing" &&
                        options.ownerPid !== undefined &&
                        result.pause.kind === "awaiting_supervisor"
                        ? { ownerPid: options.ownerPid }
                        : {}),
                    ...(status === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
                    ...(result.pause.request ? { request: result.pause.request } : {}),
                },
            }
            : {}),
        ...(result.cancel ? { cancel: result.cancel } : {}),
        ...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
        ...(result.contextPressure ? { contextPressure: { ...result.contextPressure } } : {}),
        ...(result.contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...result.contextPressureCrossedThresholds] }
            : {}),
        ...(pausedForegroundTerminationReason(result, status === "paused" || status === "pausing")
            ? {
                terminationReason: pausedForegroundTerminationReason(result, status === "paused" || status === "pausing"),
            }
            : {}),
    };
}
export function buildCohortPauseStep(input) {
    const modelIdentity = input.modelIdentity ?? canonicalSubagentModelIdentity(input.model, input.thinking);
    return {
        agent: input.agent,
        ...(input.projectAgent ? { projectAgent: input.projectAgent } : {}),
        status: input.status,
        sessionFile: input.sessionFile,
        ...(input.model ? { model: input.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(modelIdentity ? { modelIdentity } : {}),
        ...(input.modelResolution ? { modelResolution: input.modelResolution } : {}),
        ...(input.contextUsage ? { contextUsage: input.contextUsage } : {}),
        ...(input.contextPressure ? { contextPressure: { ...input.contextPressure } } : {}),
        ...(input.contextPressureCrossedThresholds
            ? { contextPressureCrossedThresholds: [...input.contextPressureCrossedThresholds] }
            : {}),
        ...(input.status === "pausing" || input.status === "paused"
            ? {
                pause: {
                    kind: "cohort_pause",
                    summary: "Paused because another child in this cohort is awaiting supervisor.",
                    requestedAt: input.now,
                    ...(input.status === "paused" ? { pausedAt: input.now } : {}),
                },
                terminationReason: "paused",
            }
            : {}),
    };
}
export function persistPausedForegroundSingleRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const now = input.stage === "paused"
        ? (input.result.pause?.pausedAt ?? Date.now())
        : (input.result.pause?.requestedAt ?? Date.now());
    const pause = input.result.pause
        ? {
            kind: input.result.pause.kind,
            ...(input.result.pause.summary ? { summary: input.result.pause.summary } : {}),
            ...(input.result.pause.requestedAt !== undefined
                ? { requestedAt: input.result.pause.requestedAt }
                : {}),
            ...(input.stage === "paused" ? { pausedAt: now } : {}),
            ...(input.stage === "pausing" && input.ownerPid !== undefined
                ? { ownerPid: input.ownerPid }
                : {}),
            ...(input.result.pause.request ? { request: input.result.pause.request } : {}),
        }
        : undefined;
    const activeRuntimeMs = normalizeActiveRuntimeMs(input.result.activeRuntimeMs);
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(input.result.activeRuntimeCheckpointAt);
    const current = readStatus(asyncDir);
    if (!current) {
        if (input.stage !== "pausing")
            throw new Error(`Cannot finalize paused foreground run '${input.runId}' before its pausing checkpoint exists.`);
        writeNormalizedLifecycleStatus(asyncDir, {
            runId: input.runId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            mode: "single",
            state: input.stage,
            startedAt: input.result.progress?.durationMs !== undefined
                ? Math.max(0, now - input.result.progress.durationMs)
                : now,
            lastUpdate: now,
            cwd: input.cwd,
            ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
            ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
            ...(pause ? { pause } : {}),
            steps: [
                {
                    agent: input.result.agent,
                    ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
                    status: input.stage,
                    sessionFile: input.result.sessionFile,
                    transcriptPath: input.result.transcriptPath,
                    transcriptError: input.result.transcriptError,
                    durationMs: input.result.progress?.durationMs,
                    model: input.result.model,
                    thinking: input.result.modelIdentity?.thinking ?? input.result.thinking,
                    ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
                    ...(input.result.modelResolution
                        ? { modelResolution: input.result.modelResolution }
                        : {}),
                    exitCode: 0,
                    ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                    ...(input.result.contextPressure
                        ? { contextPressure: { ...input.result.contextPressure } }
                        : {}),
                    ...(input.result.contextPressureCrossedThresholds
                        ? {
                            contextPressureCrossedThresholds: [
                                ...input.result.contextPressureCrossedThresholds,
                            ],
                        }
                        : {}),
                    ...(pausedForegroundTerminationReason(input.result)
                        ? { terminationReason: pausedForegroundTerminationReason(input.result) }
                        : {}),
                    ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                    ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
                    ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
                },
            ],
            sessionFile: input.result.sessionFile,
            ...(input.stage === "pausing" && input.ownerPid !== undefined ? { pid: input.ownerPid } : {}),
        });
        return;
    }
    transitionLifecycleStatus({
        asyncDir,
        expectedGeneration: lifecycleGeneration(current),
        mutate: (status) => ({
            ...status,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            state: input.stage,
            pid: input.stage === "pausing" ? input.ownerPid : undefined,
            lastUpdate: now,
            ...(input.stage === "paused" ? { endedAt: now } : {}),
            cwd: input.cwd,
            ...(activeRuntimeMs !== undefined
                ? {
                    activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(status.activeRuntimeMs) ?? 0, activeRuntimeMs),
                }
                : {}),
            ...(activeRuntimeCheckpointAt !== undefined
                ? {
                    activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt) ?? 0, activeRuntimeCheckpointAt),
                }
                : {}),
            ...(pause ? { pause } : {}),
            sessionFile: input.result.sessionFile ?? status.sessionFile,
            steps: status.steps?.map((step, index) => index === 0
                ? {
                    ...step,
                    agent: input.result.agent,
                    ...(input.result.projectAgent ? { projectAgent: input.result.projectAgent } : {}),
                    status: input.stage,
                    sessionFile: input.result.sessionFile ?? step.sessionFile,
                    transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
                    transcriptError: input.result.transcriptError ?? step.transcriptError,
                    ...(input.stage === "paused" ? { endedAt: now } : {}),
                    durationMs: input.result.progress?.durationMs ?? step.durationMs,
                    model: input.result.model ?? step.model,
                    thinking: input.result.modelIdentity?.thinking ?? input.result.thinking ?? step.thinking,
                    ...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
                    ...(input.result.modelResolution
                        ? { modelResolution: input.result.modelResolution }
                        : {}),
                    exitCode: 0,
                    ...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
                    ...(input.result.contextPressure
                        ? { contextPressure: { ...input.result.contextPressure } }
                        : {}),
                    ...(input.result.contextPressureCrossedThresholds
                        ? {
                            contextPressureCrossedThresholds: [
                                ...input.result.contextPressureCrossedThresholds,
                            ],
                        }
                        : {}),
                    ...(pausedForegroundTerminationReason(input.result)
                        ? { terminationReason: pausedForegroundTerminationReason(input.result) }
                        : {}),
                    ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                    ...(activeRuntimeMs !== undefined
                        ? {
                            activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0, activeRuntimeMs),
                        }
                        : {}),
                    ...(activeRuntimeCheckpointAt !== undefined
                        ? {
                            activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt) ?? 0, activeRuntimeCheckpointAt),
                        }
                        : {}),
                }
                : step),
        }),
    });
}
