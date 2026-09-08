import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { resolveCurrentMaxSubagentDepth, checkSubagentDepth } from "../../shared/types.js";
import { PROJECT_AGENT_TERMINAL_RETENTION_MS, retainProjectAgentRunReference, retainProjectAgentRunReferenceFrom, releaseProjectAgentRunReference, } from "../../agents/project-agent-snapshot.js";
import { getArtifactsDir } from "../../shared/artifacts.js";
import { FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE, UNCHANGED_SUPERVISOR_RESUME_MESSAGE, } from "../../shared/foreground-pause.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { resolveControlConfig } from "../shared/subagent-control.js";
import { canonicalSubagentModelIdentity, modelReferenceFromIdentity, } from "../shared/model-fallback.js";
import { executeAsyncSingle, formatAsyncStartedMessage } from "../background/async-execution.js";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget } from "../background/async-resume.js";
import { lifecycleGeneration, markLifecycleContinuationSpawned, recoverStaleLifecycleContinuationStatus, transitionLifecycleStatus, withLifecycleContinuation, withLifecycleStatusLock, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { childMessageAckPath, requestAsyncResume, waitForChildMessageAcceptance, } from "../background/control-channel.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { assessDurableResumeContext, formatDurableResumeContextBlock, parseContextUsageDiagnostics, resolveEffectiveContextWindow, } from "../../shared/context-diagnostics.js";
import { readStatus } from "../../shared/utils.js";
import { readModelRegistrySnapshot, providerFallbackModelsForTarget, resolveSingleRunOutputBaseDir, unknownAgentMessage, } from "./foreground-support.js";
import { RESULTS_DIR, } from "../../shared/types.js";
import { remainingExecutionTimeMs, } from "../../agents/execution-ceiling.js";
import { lookupPrivateProjectActionReference, projectRunAuthorizationError, requirePersistedProjectCaptureForTarget, authorizePersistedProjectAgentRun, rejectMissingPrivateProjectReference, } from "./project-agent-control.js";
import { resolveForegroundResumeTarget } from "./foreground-run-state.js";
import { resolveNestedResumeTarget, resumeLiveNestedRun, } from "./foreground-nested-control.js";
import { indexedLifecycleContinuation, isClaimedPausedLifecycle, pausedForegroundHealthFromResult, pausedForegroundStatusPath, } from "./foreground-pause-state.js";
import { normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, } from "../shared/lifecycle-state.js";
function formatRevivedAsyncResponse(target, revivedId, details, notice) {
    const privacySafeSupervisorResume = target.kind === "revive" &&
        target.state === "paused" &&
        target.pauseKind === "awaiting_supervisor";
    const lines = [
        `Revived ${target.source} subagent from ${target.runId}.`,
        `Revived run: ${revivedId}`,
        `Agent: ${target.agent}`,
        notice ? `Notice: ${notice}` : undefined,
        privacySafeSupervisorResume ? undefined : `Session: ${target.sessionFile}`,
        !privacySafeSupervisorResume && details.asyncDir ? `Async dir: ${details.asyncDir}` : undefined,
        `Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
    ].filter((line) => Boolean(line));
    return formatAsyncStartedMessage(lines.join("\n"));
}
function releaseProjectSourceAfterContinuation(target) {
    if (!("projectAgent" in target) || !target.projectAgent)
        return;
    const sourceStatus = "asyncDir" in target && target.asyncDir ? readStatus(target.asyncDir) : undefined;
    const state = sourceStatus?.state ?? target.state;
    if (state === "paused" || state === "pausing" || state === "running" || state === "queued") {
        return;
    }
    if (state === "complete" || state === "failed") {
        const releaseTimer = setTimeout(() => releaseProjectAgentRunReference(target.runId), PROJECT_AGENT_TERMINAL_RETENTION_MS);
        releaseTimer.unref?.();
        return;
    }
    releaseProjectAgentRunReference(target.runId);
}
function isAsyncRunNotFound(error) {
    return error instanceof Error && error.message.startsWith("Async run not found.");
}
function isResumeAmbiguity(error) {
    return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}
function resumeTargetExact(target, requested) {
    return target?.runId === requested;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isExactResumeError(error, source, requested) {
    if (!(error instanceof Error) || !requested)
        return false;
    return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}
function resolveResumeTarget(params, state, options = {}) {
    const requested = params.id?.trim() ?? "";
    let foregroundTarget;
    let foregroundError;
    let asyncTarget;
    let asyncError;
    try {
        const target = resolveForegroundResumeTarget(params, state);
        if (target)
            foregroundTarget = { kind: "revive", source: "foreground", ...target };
    }
    catch (error) {
        foregroundError = error;
    }
    try {
        asyncTarget = {
            source: "async",
            ...resolveAsyncResumeTarget(params, {}, {
                requireSessionFile: options.asyncRequireSessionFile,
                readOnly: options.readOnly,
            }),
        };
    }
    catch (error) {
        asyncError = error;
    }
    if (foregroundTarget && asyncTarget) {
        const foregroundExact = resumeTargetExact(foregroundTarget, requested);
        const asyncExact = resumeTargetExact(asyncTarget, requested);
        if (foregroundExact && asyncExact && foregroundTarget.runId === asyncTarget.runId)
            return foregroundTarget;
        if (foregroundExact && !asyncExact)
            return foregroundTarget;
        if (asyncExact && !foregroundExact)
            return asyncTarget;
        throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
    }
    if (foregroundTarget) {
        if (isExactResumeError(asyncError, "async", requested) &&
            !resumeTargetExact(foregroundTarget, requested))
            throw asyncError;
        if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested))
            throw asyncError;
        return foregroundTarget;
    }
    if (asyncTarget) {
        if (isExactResumeError(foregroundError, "foreground", requested))
            throw foregroundError;
        if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested))
            throw foregroundError;
        return asyncTarget;
    }
    if (foregroundError && !isAsyncRunNotFound(asyncError))
        throw foregroundError;
    if (foregroundError)
        throw foregroundError;
    if (asyncError)
        throw asyncError;
    throw new Error("Run not found. Provide id.");
}
function claimPausedAwaitingSupervisorTarget(target, continuationRunId, effectiveContextWindow) {
    if (target.kind !== "revive" || !("asyncDir" in target) || !target.asyncDir)
        return undefined;
    const asyncDir = target.asyncDir;
    if (!fs.existsSync(asyncDir)) {
        if (target.state === "paused")
            throw new Error(`Paused run '${target.runId}' was not found.`);
        return undefined;
    }
    const decision = withLifecycleStatusLock(asyncDir, (persisted) => {
        if (!persisted) {
            if (target.state === "paused")
                throw new Error(`Paused run '${target.runId}' was not found.`);
            return undefined;
        }
        let current = persisted;
        const recovered = recoverStaleLifecycleContinuationStatus(current, asyncDir, target.index);
        if (recovered.recovered)
            current = recovered.status;
        const currentStep = current.steps?.[target.index];
        if (current.state === "cancelled" || currentStep?.status === "cancelled")
            throw new Error(`Paused run '${target.runId}' child ${target.index} was cancelled and cannot be resumed.`);
        if (current.state === "continued" || currentStep?.status === "continued")
            throw new Error(`Paused run '${target.runId}' child ${target.index} already launched its continuation and cannot be resumed again.`);
        const latestContextUsage = parseContextUsageDiagnostics(currentStep?.contextUsage) ?? target.contextUsage;
        const contextAssessment = assessDurableResumeContext(latestContextUsage, effectiveContextWindow);
        if (contextAssessment.blocked)
            return { blockedMessage: formatDurableResumeContextBlock(contextAssessment) };
        if (current.state !== "paused" ||
            !currentStep ||
            (currentStep.status !== "paused" && currentStep.status !== "pausing")) {
            if (isClaimedPausedLifecycle(current, target.index))
                throw new Error(`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`);
            if (target.state === "paused")
                throw new Error(`Paused run '${target.runId}' child ${target.index} is not paused and cannot be resumed.`);
            return undefined;
        }
        if (isClaimedPausedLifecycle(current, target.index))
            throw new Error(`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`);
        const claimToken = `claim-${target.runId}-${target.index}-${Date.now()}`;
        const claimedAt = Date.now();
        const nextStatus = {
            ...current,
            lastUpdate: claimedAt,
            pause: current.pause ? { ...current.pause, ownerPid: undefined } : current.pause,
            lifecycle: {
                ...withLifecycleContinuation(current, target.index, {
                    phase: "reserved",
                    claimToken,
                    claimedAt,
                    ownerPid: process.pid,
                    continuationRunId,
                }),
                generation: lifecycleGeneration(current) + 1,
            },
        };
        writeNormalizedLifecycleStatus(asyncDir, nextStatus);
        return { claimToken };
    });
    if (!decision || "blockedMessage" in decision)
        return decision;
    return {
        asyncDir,
        claimToken: decision.claimToken,
        rollbackReserved: () => {
            const latest = readStatus(asyncDir);
            if (!latest || latest.state !== "paused")
                return;
            const latestContinuation = indexedLifecycleContinuation(latest, target.index);
            if (latestContinuation?.claimToken !== decision.claimToken ||
                latestContinuation.continuationRunId !== continuationRunId ||
                latestContinuation.phase !== "reserved")
                return;
            transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(latest),
                mutate: (status) => ({
                    ...status,
                    lastUpdate: Date.now(),
                    lifecycle: withLifecycleContinuation(status, target.index, undefined),
                }),
            });
        },
        markSpawned: () => {
            markLifecycleContinuationSpawned(asyncDir, target.index, decision.claimToken, continuationRunId);
        },
    };
}
export function recoverFailedPausedForegroundTransition(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const message = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
    try {
        const current = readStatus(asyncDir);
        if (!current || current.state !== "pausing")
            return;
        const failedAt = Date.now();
        transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => ({
                ...status,
                state: "failed",
                pid: undefined,
                lastUpdate: failedAt,
                endedAt: failedAt,
                error: message,
                pause: status.pause ? { ...status.pause, ownerPid: undefined } : status.pause,
                steps: status.steps?.map((step, index) => index === 0 && (step.status === "pausing" || step.status === "paused")
                    ? {
                        ...step,
                        status: "failed",
                        endedAt: failedAt,
                        exitCode: 1,
                        terminationReason: "process_exit",
                        error: step.error ?? message,
                    }
                    : step),
            }),
        });
    }
    catch {
    }
}
export function enrichPersistedPausedForegroundSingleRun(input) {
    const asyncDir = pausedForegroundStatusPath(input.runId);
    const activeRuntimeMs = normalizeActiveRuntimeMs(input.result.activeRuntimeMs);
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(input.result.activeRuntimeCheckpointAt);
    const current = readStatus(asyncDir);
    if (current?.pause?.kind === "awaiting_supervisor" &&
        (current.state === "paused" || current.state === "pausing")) {
        transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(current),
            mutate: (status) => ({
                ...status,
                lastUpdate: Date.now(),
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
                sessionFile: input.result.sessionFile ?? status.sessionFile,
                steps: status.steps?.map((step, index) => index === 0
                    ? {
                        ...step,
                        projectAgent: input.result.projectAgent ?? step.projectAgent,
                        sessionFile: input.result.sessionFile ?? step.sessionFile,
                        transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
                        transcriptError: input.result.transcriptError ?? step.transcriptError,
                        terminationReason: step.terminationReason ?? "paused",
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
                        ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
                        ...pausedForegroundHealthFromResult(input.result, true),
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
}
function asyncControlOwnedByCurrentSession(state, status) {
    return (typeof state.currentSessionId === "string" &&
        state.currentSessionId.length > 0 &&
        typeof status.sessionId === "string" &&
        status.sessionId === state.currentSessionId);
}
async function queueLiveAsyncResume(input) {
    if (!input.target.asyncDir) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${input.target.runId}' has no live run directory to resume.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const status = reconcileAsyncRun(input.target.asyncDir, {
        kill: input.kill,
        resultsDir: RESULTS_DIR,
    }).status;
    if (!status || status.state !== "running") {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${input.target.runId}' is not running and cannot accept a live resume follow-up.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (!asyncControlOwnedByCurrentSession(input.state, status)) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' is owned by another session and cannot be resumed from this session.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const step = status.steps?.[input.target.index];
    if (!step) {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' no longer has child ${input.target.index}. Wait for completion, then retry action='resume' if revival is still needed.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (step.status !== "running") {
        return {
            content: [
                {
                    type: "text",
                    text: `Async run '${status.runId}' child ${input.target.index} is ${step.status} and cannot accept a live resume follow-up.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const requestId = randomUUID();
    const requestPath = requestAsyncResume(input.target.asyncDir, {
        id: requestId,
        message: input.followUp,
        targetIndex: input.target.index,
        source: "async-resume",
    });
    const acceptance = await waitForChildMessageAcceptance({
        asyncDir: input.target.asyncDir,
        requestId,
        isRunnerAlive: () => {
            if (typeof status.pid !== "number" || status.pid <= 0)
                return false;
            try {
                (input.kill ?? process.kill)(status.pid, 0);
                return true;
            }
            catch {
                return false;
            }
        },
    });
    if (acceptance.outcome !== "acknowledged" ||
        acceptance.acceptance.status !== "accepted" ||
        !acceptance.acceptance.acceptedIndexes.includes(input.target.index)) {
        try {
            fs.rmSync(requestPath, { force: true });
        }
        catch {
        }
        const lateAckPath = childMessageAckPath(input.target.asyncDir, requestId);
        try {
            fs.rmSync(lateAckPath, { force: true });
        }
        catch {
        }
        const lateAckCleanup = setTimeout(() => {
            try {
                fs.rmSync(lateAckPath, { force: true });
            }
            catch {
            }
        }, 2_500);
        lateAckCleanup.unref?.();
        const reason = acceptance.outcome === "runner_gone"
            ? "the runner disappeared before accepting it"
            : acceptance.outcome === "timeout"
                ? "the runner did not acknowledge it before the acceptance timeout"
                : (acceptance.acceptance.reason ??
                    acceptance.acceptance.rejected?.[0]?.reason ??
                    "the target child rejected it");
        return {
            content: [
                {
                    type: "text",
                    text: `Live resume follow-up for async run '${status.runId}' child ${input.target.index} was not accepted: ${reason}.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const tracked = input.state.asyncJobs.get(status.runId);
    if (tracked)
        tracked.updatedAt = Date.now();
    return {
        content: [
            {
                type: "text",
                text: `Resume follow-up accepted for live async run ${status.runId} child ${input.target.index} and queued in its native inbox.`,
            },
        ],
        details: { mode: "management", results: [] },
    };
}
function explicitResumeModel(value) {
    const trimmed = value?.trim();
    return trimmed && trimmed !== "inherit" ? trimmed : undefined;
}
export function buildResumeModelResolution(target, requestedModel) {
    const persisted = target.kind === "revive" ? target.modelResolution : undefined;
    const persistedEffective = target.kind === "revive" ? (target.modelIdentity ?? persisted?.resumed) : undefined;
    const persistedOriginal = target.kind === "revive" ? (persisted?.original ?? persistedEffective) : undefined;
    const explicit = explicitResumeModel(requestedModel);
    if (explicit) {
        const explicitIdentity = canonicalSubagentModelIdentity(explicit);
        const reference = persistedEffective ?? persistedOriginal;
        return {
            kind: "override",
            ...(reference ? { original: reference } : {}),
            ...(explicitIdentity ? { resumed: explicitIdentity } : {}),
            reason: [
                persisted?.reason,
                reference
                    ? `Caller explicitly overrode persisted selection ${reference.provider}/${reference.model}${reference.thinking ? `:${reference.thinking}` : ""} with '${explicit}'.`
                    : `Caller explicitly selected '${explicit}' for the resumed child.`,
            ]
                .filter(Boolean)
                .join(" "),
        };
    }
    if (!persistedEffective)
        return undefined;
    const restoration = `Restored persisted child selection ${persistedEffective.provider}/${persistedEffective.model}${persistedEffective.thinking ? `:${persistedEffective.thinking}` : ""} instead of the current parent model.`;
    return persisted?.kind === "fallback"
        ? {
            ...persisted,
            ...(persistedOriginal ? { original: persistedOriginal } : {}),
            resumed: persistedEffective,
            reason: [persisted.reason, restoration].join(" "),
        }
        : {
            kind: "restored",
            original: persistedOriginal,
            resumed: persistedEffective,
            reason: [persisted?.reason, restoration].filter(Boolean).join(" "),
        };
}
async function resolveResumeActionTarget(input) {
    let target;
    try {
        let resolved;
        try {
            resolved = input.requestedId
                ? resolveSubagentRunId(input.requestedId, { state: input.deps.state })
                : undefined;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "";
            const asyncMatches = message.match(/async:/g)?.length ?? 0;
            if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1)
                throw error;
        }
        if (resolved?.kind === "nested") {
            if (input.privateProjectLookup.status === "found") {
                throw projectRunAuthorizationError("the retained project-agent run resolved to an unsupported nested control target.");
            }
            if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
                return resumeLiveNestedRun(resolved);
            }
            const trustedSessionRoots = input.parentSessionFile
                ? [input.deps.getSubagentSessionRoot(input.parentSessionFile)]
                : [];
            target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
        }
        else if (resolved?.kind === "async" || input.params.dir) {
            const preResolutionDir = resolved?.kind === "async"
                ? resolved.location.asyncDir
                : input.params.dir
                    ? path.resolve(input.params.dir)
                    : null;
            const preResolutionStatus = preResolutionDir ? readStatus(preResolutionDir) : undefined;
            const hadLiveResumeIntent = Boolean(input.requestedFollowUp && preResolutionStatus?.state === "running");
            const asyncTarget = {
                source: "async",
                ...resolveAsyncResumeTarget(input.privateProjectLookup.status === "found"
                    ? { ...input.params, id: input.privateProjectLookup.runId }
                    : input.params, { kill: input.deps.kill, resultsDir: RESULTS_DIR }, { requireSessionFile: true, readOnly: preResolutionStatus?.state !== "running" }),
            };
            rejectMissingPrivateProjectReference(input.privateProjectLookup, asyncTarget, {
                allowFreshResume: asyncTarget.kind === "revive",
            });
            if (hadLiveResumeIntent && asyncTarget.kind !== "live") {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Async run '${asyncTarget.runId}' was running when resume began, but its runner or selected child went stale before the live follow-up could be accepted. No durable revival was started.`,
                        },
                    ],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            if (asyncTarget.kind === "live") {
                if (!input.requestedFollowUp)
                    return {
                        content: [{ type: "text", text: "action='resume' requires message." }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                if (input.privateProjectLookup.status === "found") {
                    try {
                        requirePersistedProjectCaptureForTarget(input.privateProjectLookup, asyncTarget);
                        await authorizePersistedProjectAgentRun({
                            target: asyncTarget,
                            ctx: input.ctx,
                            deps: input.deps,
                        });
                    }
                    catch (error) {
                        return {
                            content: [
                                { type: "text", text: error instanceof Error ? error.message : String(error) },
                            ],
                            isError: true,
                            details: { mode: "management", results: [] },
                        };
                    }
                }
                return queueLiveAsyncResume({
                    target: asyncTarget,
                    followUp: input.requestedFollowUp,
                    state: input.deps.state,
                    kill: input.deps.kill,
                });
            }
            target = asyncTarget;
        }
        else {
            target = resolveResumeTarget(input.params, input.deps.state, {
                asyncRequireSessionFile: true,
                readOnly: true,
            });
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    return target;
}
function resolveSuccessfulResumeCompletion(target) {
    return (("successfulCompletion" in target ? target.successfulCompletion : undefined) ??
        target.state === "complete");
}
function preflightResumeRuntimePolicy(target, agentConfig, executionPolicy) {
    const runTimeoutMs = executionPolicy.maxRunTimeMs === false ? undefined : executionPolicy.maxRunTimeMs;
    const successfulCompletion = resolveSuccessfulResumeCompletion(target);
    const normalizedTargetActiveRuntimeMs = normalizeActiveRuntimeMs(target.activeRuntimeMs);
    if (!successfulCompletion &&
        target.activeRuntimeMs !== undefined &&
        normalizedTargetActiveRuntimeMs === undefined) {
        return {
            kind: "error",
            message: "Invalid active runtime evidence; continuation cannot start.",
        };
    }
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(target.activeRuntimeCheckpointAt);
    if (!successfulCompletion &&
        target.activeRuntimeCheckpointAt !== undefined &&
        activeRuntimeCheckpointAt === undefined) {
        return {
            kind: "error",
            message: "Invalid active runtime checkpoint; continuation cannot start.",
        };
    }
    const activeRuntimeMs = successfulCompletion ? 0 : (normalizedTargetActiveRuntimeMs ?? 0);
    const remainingAgentTimeMs = remainingExecutionTimeMs(agentConfig.maxExecutionTimeMs, activeRuntimeMs);
    if (remainingAgentTimeMs === 0) {
        return {
            kind: "error",
            message: `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
        };
    }
    return {
        kind: "ready",
        activeRuntimeMs,
        ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
        successfulCompletion,
        ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
    };
}
function preflightResumeContextPolicy(target, agentConfig, modelOverride, currentModel, availableModels) {
    if (target.kind !== "revive")
        return { kind: "ready" };
    const selectedModel = explicitResumeModel(modelOverride) ??
        (target.modelIdentity ? modelReferenceFromIdentity(target.modelIdentity) : undefined) ??
        agentConfig.model ??
        (currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined);
    const modelContextWindow = resolveEffectiveContextWindow(selectedModel, availableModels, currentModel?.provider);
    const contextAssessment = assessDurableResumeContext(target.contextUsage, modelContextWindow ?? target.contextUsage?.contextWindow);
    if (contextAssessment.blocked) {
        return { kind: "error", message: formatDurableResumeContextBlock(contextAssessment) };
    }
    return { kind: "ready", modelContextWindow };
}
export async function resumeAsyncRun(input) {
    const requestedFollowUp = (input.params.message ?? input.params.task ?? "").trim();
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    const privateProjectLookup = lookupPrivateProjectActionReference(input.params);
    if (privateProjectLookup.status === "ambiguous") {
        return {
            content: [
                {
                    type: "text",
                    text: projectRunAuthorizationError(`the requested run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`).message,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const resolutionParams = privateProjectLookup.status === "found"
        ? { ...input.params, id: privateProjectLookup.runId }
        : input.params;
    const requestedId = resolutionParams.id;
    const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
    const targetResolution = await resolveResumeActionTarget({
        params: resolutionParams,
        requestedId,
        requestedFollowUp,
        privateProjectLookup,
        ctx: input.ctx,
        deps: input.deps,
        requestCwd: input.requestCwd,
        parentSessionFile,
    });
    if ("content" in targetResolution)
        return targetResolution;
    const target = targetResolution;
    try {
        rejectMissingPrivateProjectReference(privateProjectLookup, target, {
            allowFreshResume: target.kind === "revive",
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const followUp = requestedFollowUp ||
        (target.kind === "revive" &&
            target.state === "paused" &&
            target.pauseKind === "awaiting_supervisor"
            ? UNCHANGED_SUPERVISOR_RESUME_MESSAGE
            : "");
    if (!followUp) {
        return {
            content: [{ type: "text", text: "action='resume' requires message." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    let persistedProjectAuthorization;
    const targetProjectCapture = "projectAgent" in target ? target.projectAgent : undefined;
    if (privateProjectLookup.status === "found" || targetProjectCapture !== undefined) {
        try {
            requirePersistedProjectCaptureForTarget(privateProjectLookup, target);
            persistedProjectAuthorization = await authorizePersistedProjectAgentRun({
                target,
                ctx: input.ctx,
                deps: input.deps,
            });
        }
        catch (error) {
            return {
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
    if (blocked) {
        return {
            content: [
                {
                    type: "text",
                    text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`,
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    const effectiveCwd = persistedProjectAuthorization?.canonicalCwd ?? target.cwd ?? input.requestCwd;
    const scope = resolveExecutionAgentScope(input.params.agentScope);
    const discovered = persistedProjectAuthorization
        ? {
            agents: [persistedProjectAuthorization.agentConfig],
            modelScope: persistedProjectAuthorization.modelScope,
        }
        : input.deps.discoverAgents(effectiveCwd, scope);
    const discoveredAgents = discovered.agents;
    const modelScope = discovered.modelScope;
    const agents = discoveredAgents;
    const agentConfig = agents.find((agent) => agent.name === target.agent) ??
        persistedProjectAuthorization?.agentConfig;
    if (!agentConfig) {
        return {
            content: [
                {
                    type: "text",
                    text: unknownAgentMessage(target.agent, discovered.agentDiagnostics, "Unknown agent for resume"),
                },
            ],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const runtimePolicy = preflightResumeRuntimePolicy(target, agentConfig, input.executionPolicy);
    if (runtimePolicy.kind === "error") {
        return {
            content: [{ type: "text", text: runtimePolicy.message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const { activeRuntimeMs, activeRuntimeCheckpointAt, successfulCompletion, runTimeoutMs } = runtimePolicy;
    const modelRegistrySnapshot = readModelRegistrySnapshot(input.ctx);
    const { availableModels } = modelRegistrySnapshot;
    const contextPolicy = preflightResumeContextPolicy(target, agentConfig, input.params.model, input.ctx.model, availableModels);
    if (contextPolicy.kind === "error") {
        return {
            content: [{ type: "text", text: contextPolicy.message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const { modelContextWindow } = contextPolicy;
    const continuationRunId = randomUUID().slice(0, 8);
    let claimedPause;
    try {
        const claimDecision = claimPausedAwaitingSupervisorTarget(target, continuationRunId, modelContextWindow);
        if (claimDecision && "blockedMessage" in claimDecision) {
            return {
                content: [{ type: "text", text: claimDecision.blockedMessage }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        claimedPause = claimDecision;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const runId = continuationRunId;
    const artifactsDir = getArtifactsDir(parentSessionFile);
    const resumeModelResolution = buildResumeModelResolution(target, input.params.model);
    const restoredModelIdentity = explicitResumeModel(input.params.model) || target.kind !== "revive"
        ? undefined
        : target.modelIdentity;
    let projectRunTransferred = false;
    if (persistedProjectAuthorization) {
        try {
            if (persistedProjectAuthorization.freshRebind) {
                retainProjectAgentRunReference(persistedProjectAuthorization.capability, runId, [
                    persistedProjectAuthorization.capture,
                ]);
            }
            else {
                retainProjectAgentRunReferenceFrom(target.runId, runId);
            }
            projectRunTransferred = true;
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `TLH project-agent control rejected: could not retain the authorized generation: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
    }
    let result;
    try {
        result = (input.deps.executeAsyncSingle ?? executeAsyncSingle)(runId, {
            agent: target.agent,
            ...(claimedPause
                ? {
                    continuationSource: {
                        asyncDir: claimedPause.asyncDir,
                        runId: target.runId,
                        index: target.index,
                        claimToken: claimedPause.claimToken,
                        ...(persistedProjectAuthorization
                            ? { projectAgent: persistedProjectAuthorization.capture }
                            : {}),
                    },
                }
                : {}),
            ...(target.source === "async" && target.tkTicket
                ? { inheritedTkTicket: target.tkTicket }
                : {}),
            task: buildRevivedAsyncTask(target, followUp),
            modelOverride: input.params.model,
            ...(restoredModelIdentity ? { restoredModelIdentity } : {}),
            ...(resumeModelResolution ? { modelResolution: resumeModelResolution } : {}),
            ...(target.kind === "revive" && "contextUsage" in target && target.contextUsage
                ? { contextUsage: target.contextUsage }
                : {}),
            ...(target.kind === "revive" && !claimedPause && "contextPressure" in target
                ? { contextPressure: target.contextPressure }
                : {}),
            ...(target.kind === "revive" && !claimedPause && "contextPressureCrossedThresholds" in target
                ? { contextPressureCrossedThresholds: target.contextPressureCrossedThresholds }
                : {}),
            agentConfig,
            projectAgent: persistedProjectAuthorization?.capture,
            ctx: {
                pi: input.deps.pi,
                cwd: persistedProjectAuthorization?.canonicalCwd ?? input.requestCwd,
                currentSessionId: input.deps.state.currentSessionId,
                parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
                currentModelProvider: input.ctx.model?.provider,
                currentModel: input.ctx.model,
                modelScope,
            },
            cwd: effectiveCwd,
            maxOutput: input.params.maxOutput,
            artifactsDir,
            artifactConfig: input.artifactConfig,
            shareEnabled: input.params.share === true,
            sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
            sessionFile: target.sessionFile,
            acceptance: input.params.acceptance,
            continuationAcceptance: target.state === "paused" ? target.continuationAcceptance : undefined,
            activeRuntimeMs,
            ...(!successfulCompletion && activeRuntimeCheckpointAt !== undefined
                ? { activeRuntimeCheckpointAt }
                : {}),
            timeoutMs: runTimeoutMs,
            outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, runId),
            maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
            controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
            availableModels,
            modelRegistry: modelRegistrySnapshot.evidence,
            providerFallbackModels: providerFallbackModelsForTarget(input.params),
            modelFallbackNotice: input.params.modelFallbackNotice,
        });
    }
    catch (error) {
        claimedPause?.rollbackReserved();
        if (projectRunTransferred)
            releaseProjectAgentRunReference(runId);
        throw error;
    }
    if (result.isError) {
        claimedPause?.rollbackReserved();
        if (projectRunTransferred)
            releaseProjectAgentRunReference(runId);
        return result;
    }
    const revivedId = result.details.asyncId ?? runId;
    claimedPause?.markSpawned();
    if (persistedProjectAuthorization)
        releaseProjectSourceAfterContinuation(target);
    if (target.source === "foreground")
        input.deps.state.foregroundRuns?.delete(target.runId);
    return {
        content: [
            {
                type: "text",
                text: formatRevivedAsyncResponse(target, revivedId, result.details, persistedProjectAuthorization?.digestChangeNotice),
            },
        ],
        details: result.details,
    };
}
