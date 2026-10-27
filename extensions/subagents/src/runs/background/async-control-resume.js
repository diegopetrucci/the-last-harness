// Generated from extensions/subagents/src/runs/background/async-control-resume.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { randomUUID } from "node:crypto";
import { appendSubagentTelemetryContinuation, continuationTelemetryMetadata, normalizeSubagentRunTelemetry, } from "../../shared/telemetry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { resolveCurrentMaxSubagentDepth, checkSubagentDepth } from "../../shared/types.js";
import { getArtifactsDir } from "../../shared/artifacts.js";
import { UNCHANGED_SUPERVISOR_RESUME_MESSAGE } from "../../shared/pause-messages.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { resolveControlConfig } from "../shared/subagent-control.js";
import { canonicalSubagentModelIdentity, modelReferenceFromIdentity, } from "../shared/model-fallback.js";
import { executeAsyncSingle, formatAsyncStartedMessage } from "../background/async-execution.js";
import { buildRevivedAsyncTask, continuationResumeBlock, readPersistedResultOwner, resolveAsyncResumeTarget, resolveAsyncRunLocation, resolvePersistedOwner, } from "../background/async-resume.js";
import { advanceLifecycleContinuation, checkPidLiveness, lifecycleContinuationForIndex, lifecycleGeneration, recoverStaleLifecycleContinuationStatus, transitionLifecycleStatus, withLifecycleContinuation, withLifecycleStatusLock, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { childMessageAckPath, requestAsyncResume, waitForChildMessageAcceptance, } from "../background/control-channel.js";
import { authorizeAsyncRunOwner, isOwnedByCaller, } from "../background/async-owner-authorization.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { assessDurableResumeContext, formatDurableResumeContextBlock, parseContextUsageDiagnostics, resolveEffectiveContextWindow, } from "../../shared/context-diagnostics.js";
import { readStatus } from "../../shared/utils.js";
import { isAsyncStatusReadError } from "./async-status-boundary.js";
import { readModelRegistrySnapshot, providerFallbackModelsForTarget, resolveSingleRunOutputBaseDir, unknownAgentMessage, } from "../shared/run-support.js";
import { ASYNC_DIR, RESULTS_DIR, } from "../../shared/types.js";
import { remainingExecutionTimeMs } from "../../agents/execution-ceiling.js";
import { normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, } from "../shared/active-runtime.js";
import { authorizePersistedProjectAgentRun, embeddedControlRestrictionError, } from "../shared/project-agent-control.js";
import { acquireWorkspaceReservations } from "../shared/workspace-reservation.js";
export function persistContinuationTelemetry(target, continuationRunId) {
    try {
        const sourceTelemetry = target.source === "async" && "telemetry" in target ? target.telemetry : undefined;
        const asyncDir = target.source === "async" && "asyncDir" in target ? target.asyncDir : undefined;
        if (!sourceTelemetry || !asyncDir)
            return;
        withLifecycleStatusLock(asyncDir, (current) => {
            if (!current)
                return;
            if (current.state === "paused")
                return;
            const baseTelemetry = normalizeSubagentRunTelemetry(current.telemetry) ?? sourceTelemetry;
            const telemetry = appendSubagentTelemetryContinuation(baseTelemetry, {
                sourceStepIndex: "index" in target ? target.index : undefined,
                continuationRunId,
            });
            if (!telemetry)
                return;
            writeNormalizedLifecycleStatus(asyncDir, { ...current, telemetry });
        });
    }
    catch {
    }
}
function priorTerminalResultForResume(target) {
    return target.kind === "revive" && target.terminalResult
        ? { priorTerminalResult: target.terminalResult }
        : {};
}
function resolveTargetTicketId(target) {
    return target.source === "async" && "ticketId" in target ? target.ticketId : undefined;
}
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
function indexedLifecycleContinuation(status, index = 0) {
    return lifecycleContinuationForIndex(status, index);
}
function isClaimedPausedLifecycle(status, index = 0) {
    const continuation = indexedLifecycleContinuation(status, index);
    return Boolean(continuation?.claimToken && continuation.phase === "reserved");
}
function resolveResumeTarget(params, state, options = {}) {
    return {
        source: "async",
        ...resolveAsyncResumeTarget(params, { callerKey: state.currentSessionId ?? undefined }, {
            requireSessionFile: options.asyncRequireSessionFile,
            readOnly: options.readOnly,
            deferPausedContinuationGate: options.deferPausedContinuationGate,
        }),
    };
}
const OWNER_RECOVERY_GUIDANCE = "See docs/subagents.md#recovering-ownerless-or-foreign-runs for human-approved recovery.";
function ownerRejectionMessage(runId) {
    return `Async run '${runId}' is owned by another session and cannot be resumed from this session (a missing, malformed or conflicting persisted owner is also rejected). Reopen the original parent session. ${OWNER_RECOVERY_GUIDANCE}`;
}
function ownerRejectionResult(runId) {
    return {
        content: [{ type: "text", text: ownerRejectionMessage(runId) }],
        isError: true,
        details: { mode: "management", results: [] },
    };
}
function revivedPressureOptions(target, claimedPause) {
    return {
        ...(target.kind === "revive" && !claimedPause && "contextPressure" in target
            ? { contextPressure: target.contextPressure }
            : {}),
        ...(target.kind === "revive" && !claimedPause && "contextPressureCrossedThresholds" in target
            ? { contextPressureCrossedThresholds: target.contextPressureCrossedThresholds }
            : {}),
    };
}
function revalidateOwnerEvidence(target, callerKey, statusOwner) {
    const owner = resolvePersistedOwner(statusOwner, readPersistedResultOwner(RESULTS_DIR, target.runId));
    if (owner === undefined || owner !== callerKey || owner !== target.ownerSessionId)
        throw new Error(ownerRejectionMessage(target.runId));
}
function claimPausedAwaitingSupervisorTarget(target, continuationRunId, callerKey, effectiveContextWindow, options = {}) {
    if (target.kind !== "revive")
        return undefined;
    if (!("asyncDir" in target) || !target.asyncDir) {
        revalidateOwnerEvidence(target, callerKey, undefined);
        return undefined;
    }
    const asyncDir = target.asyncDir;
    if (!fs.existsSync(asyncDir)) {
        if (target.state === "paused")
            throw new Error(`Paused run '${target.runId}' was not found.`);
        revalidateOwnerEvidence(target, callerKey, undefined);
        return undefined;
    }
    const decision = withLifecycleStatusLock(asyncDir, (persisted) => {
        if (!persisted) {
            if (target.state === "paused")
                throw new Error(`Paused run '${target.runId}' was not found.`);
            revalidateOwnerEvidence(target, callerKey, undefined);
            return undefined;
        }
        revalidateOwnerEvidence(target, callerKey, persisted.sessionId);
        let current = persisted;
        const recovered = recoverStaleLifecycleContinuationStatus(current, asyncDir, target.index);
        if (recovered.recovered)
            current = recovered.status;
        const currentStep = current.steps?.[target.index];
        if (current.state === "cancelled" || currentStep?.status === "cancelled")
            throw new Error(`Paused run '${target.runId}' child ${target.index} was cancelled and cannot be resumed.`);
        const continuation = indexedLifecycleContinuation(current, target.index);
        const continuationBlock = continuationResumeBlock(continuation);
        if (continuationBlock !== undefined) {
            const alreadyClaimed = continuationBlock === "claimed" || continuation?.phase === "reserved";
            throw new Error(alreadyClaimed
                ? `Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`
                : `Paused run '${target.runId}' child ${target.index} already launched its continuation and cannot be resumed again.`);
        }
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
        const persistedOwnerPids = [current.pid, current.pause?.ownerPid].filter((pid, index, pids) => typeof pid === "number" && pid > 0 && pids.indexOf(pid) === index);
        for (const persistedOwnerPid of persistedOwnerPids) {
            const liveness = checkPidLiveness(persistedOwnerPid, options.kill);
            if (liveness !== "dead")
                return {
                    blockedMessage: `Paused run '${target.runId}' is still stopping; persisted owner pid ${persistedOwnerPid} is ${liveness}. Retry resume after cleanup completes.`,
                };
        }
        if (isClaimedPausedLifecycle(current, target.index))
            throw new Error(`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`);
        const claimToken = `claim-${target.runId}-${target.index}-${Date.now()}`;
        const claimedAt = Date.now();
        const nextStatus = {
            ...current,
            pid: undefined,
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
        ownerSessionId: callerKey,
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
            advanceLifecycleContinuation(asyncDir, target.index, decision.claimToken, continuationRunId, false);
        },
    };
}
function asyncControlOwnedByCurrentSession(state, status) {
    return (typeof state.currentSessionId === "string" &&
        state.currentSessionId.length > 0 &&
        resolvePersistedOwner(status.sessionId, readPersistedResultOwner(RESULTS_DIR, status.runId)) ===
            state.currentSessionId);
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
function resumeControlTarget(target) {
    return {
        runId: target.runId,
        agent: target.agent,
        cwd: target.cwd,
        projectAgent: target.childProjectAgent,
        conflict: target.childIdentityConflict === true,
    };
}
async function resolveResumeActionTarget(input) {
    let target;
    try {
        const resolved = input.requestedId
            ? resolveSubagentRunId(input.requestedId, {
                state: input.deps.state,
                callerKey: input.callerKey,
            })
            : undefined;
        if (resolved?.kind === "async" || input.params.dir) {
            const preResolutionDir = resolved?.kind === "async"
                ? resolved.location.asyncDir
                : input.params.dir
                    ? path.resolve(input.params.dir)
                    : null;
            const preResolutionStatus = preResolutionDir ? readStatus(preResolutionDir) : undefined;
            const gateLocations = [
                resolveAsyncRunLocation(input.params, ASYNC_DIR, RESULTS_DIR, input.callerKey),
                ...(resolved?.kind === "async" ? [resolved.location] : []),
            ];
            for (const location of gateLocations) {
                const present = (location.asyncDir !== null && fs.existsSync(location.asyncDir)) ||
                    (location.resultPath !== null && fs.existsSync(location.resultPath));
                if (!present)
                    continue;
                const authorization = authorizeAsyncRunOwner({
                    callerKey: input.callerKey,
                    ...(location.asyncDir ? { asyncDir: location.asyncDir } : {}),
                    ...(location.resultPath ? { resultPath: location.resultPath } : {}),
                    ...(location.resolvedId ? { runId: location.resolvedId } : {}),
                    resultsDir: RESULTS_DIR,
                });
                if (authorization.outcome !== "owned")
                    return ownerRejectionResult(authorization.runId ?? location.resolvedId ?? "unknown");
            }
            const hadLiveResumeIntent = Boolean(input.requestedFollowUp && preResolutionStatus?.state === "running");
            const asyncTarget = {
                source: "async",
                ...resolveAsyncResumeTarget(input.params, { kill: input.deps.kill, resultsDir: RESULTS_DIR, callerKey: input.callerKey }, {
                    requireSessionFile: true,
                    readOnly: preResolutionStatus?.state !== "running",
                    deferPausedContinuationGate: true,
                }),
            };
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
                const restriction = await embeddedControlRestrictionError({
                    action: "resume",
                    targets: [resumeControlTarget(asyncTarget)],
                    ctx: input.ctx,
                    deps: input.deps,
                });
                if (restriction) {
                    return {
                        content: [{ type: "text", text: restriction }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                if (asyncTarget.projectAgent !== undefined) {
                    try {
                        await authorizePersistedProjectAgentRun({
                            target: asyncTarget,
                            ctx: input.ctx,
                            deps: input.deps,
                        });
                    }
                    catch (error) {
                        if (isAsyncStatusReadError(error))
                            throw error;
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
                deferPausedContinuationGate: true,
            });
        }
    }
    catch (error) {
        if (isAsyncStatusReadError(error))
            throw error;
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    return target;
}
function preflightResumeRuntimePolicy(target, agentConfig) {
    const normalizedTargetActiveRuntimeMs = normalizeActiveRuntimeMs(target.activeRuntimeMs);
    if (target.activeRuntimeMs !== undefined && normalizedTargetActiveRuntimeMs === undefined) {
        return {
            kind: "error",
            message: "Invalid active runtime evidence; continuation cannot start.",
        };
    }
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(target.activeRuntimeCheckpointAt);
    if (target.activeRuntimeCheckpointAt !== undefined && activeRuntimeCheckpointAt === undefined) {
        return {
            kind: "error",
            message: "Invalid active runtime checkpoint; continuation cannot start.",
        };
    }
    const activeRuntimeMs = normalizedTargetActiveRuntimeMs ?? 0;
    const roleTimeoutEvidence = target.timeoutOwner === "role" &&
        (target.timedOut === true || target.terminationReason === "timed_out");
    const remainingAgentTimeMs = remainingExecutionTimeMs(agentConfig.maxExecutionTimeMs, activeRuntimeMs);
    if (roleTimeoutEvidence || remainingAgentTimeMs === 0) {
        return {
            kind: "error",
            message: roleTimeoutEvidence
                ? `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling; persisted role-timeout evidence permanently retires this instance.`
                : `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
        };
    }
    return {
        kind: "ready",
        activeRuntimeMs,
        ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
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
    const callerKey = resolveCurrentSessionId(input.ctx.sessionManager);
    input.deps.state.currentSessionId = callerKey;
    const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
    let targetResolution;
    try {
        targetResolution = await resolveResumeActionTarget({
            params: input.params,
            requestedId: input.params.id,
            requestedFollowUp,
            ctx: input.ctx,
            deps: input.deps,
            requestCwd: input.requestCwd,
            parentSessionFile,
            callerKey,
        });
    }
    catch (error) {
        if (isAsyncStatusReadError(error)) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Awaited supervisor lifecycle update failed. The run was stopped safely and marked failed.",
                    },
                ],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        throw error;
    }
    if ("content" in targetResolution)
        return targetResolution;
    const target = targetResolution;
    if (target.kind === "revive" && !isOwnedByCaller(target.ownerSessionId, callerKey))
        return ownerRejectionResult(target.runId);
    const resumeRestriction = await embeddedControlRestrictionError({
        action: "resume",
        targets: [resumeControlTarget(target)],
        ctx: input.ctx,
        deps: input.deps,
    });
    if (resumeRestriction) {
        return {
            content: [{ type: "text", text: resumeRestriction }],
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
    const targetProjectIdentity = "projectAgent" in target ? target.projectAgent : undefined;
    if (targetProjectIdentity !== undefined) {
        try {
            persistedProjectAuthorization = await authorizePersistedProjectAgentRun({
                target,
                ctx: input.ctx,
                deps: input.deps,
            });
        }
        catch (error) {
            if (isAsyncStatusReadError(error)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Awaited supervisor lifecycle update failed. The run was stopped safely and marked failed.",
                        },
                    ],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
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
    const runtimePolicy = preflightResumeRuntimePolicy(target, agentConfig);
    if (runtimePolicy.kind === "error") {
        return {
            content: [{ type: "text", text: runtimePolicy.message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const { activeRuntimeMs, activeRuntimeCheckpointAt } = runtimePolicy;
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
    const reservation = acquireWorkspaceReservations(continuationRunId, callerKey, [
        {
            agent: target.agent,
            childIndex: "index" in target ? (target.index ?? 0) : 0,
            cwd: effectiveCwd,
        },
    ]);
    if (!reservation.ok) {
        return {
            content: [{ type: "text", text: reservation.message }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    let claimedPause;
    try {
        const claimDecision = claimPausedAwaitingSupervisorTarget(target, continuationRunId, callerKey, modelContextWindow, { kill: input.deps.kill });
        if (claimDecision && "blockedMessage" in claimDecision) {
            reservation.release();
            return {
                content: [{ type: "text", text: claimDecision.blockedMessage }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        claimedPause = claimDecision;
    }
    catch (error) {
        reservation.release();
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
    const sourceTelemetry = target.source === "async" && "telemetry" in target
        ? normalizeSubagentRunTelemetry(target.telemetry)
        : undefined;
    const continuationTelemetry = continuationTelemetryMetadata(sourceTelemetry, target.runId, "index" in target ? target.index : undefined);
    const continuationTelemetryProvenance = continuationTelemetry.provenance ?? input.deps.telemetryProvenance;
    const continuationTelemetryLineage = continuationTelemetry.lineage;
    try {
        persistContinuationTelemetry(target, runId);
    }
    catch (error) {
        reservation.release();
        claimedPause?.rollbackReserved();
        throw error;
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
                            ? { projectAgent: persistedProjectAuthorization.identity }
                            : {}),
                    },
                }
                : {}),
            ...(resolveTargetTicketId(target) ? { ticketId: resolveTargetTicketId(target) } : {}),
            task: buildRevivedAsyncTask(target, followUp),
            modelOverride: input.params.model,
            ...(restoredModelIdentity ? { restoredModelIdentity } : {}),
            ...(resumeModelResolution ? { modelResolution: resumeModelResolution } : {}),
            ...(target.kind === "revive" && "contextUsage" in target && target.contextUsage
                ? { contextUsage: target.contextUsage }
                : {}),
            ...revivedPressureOptions(target, claimedPause),
            agentConfig,
            projectAgent: persistedProjectAuthorization?.identity,
            ctx: {
                pi: input.deps.pi,
                cwd: persistedProjectAuthorization?.canonicalCwd ?? input.requestCwd,
                currentSessionId: claimedPause?.ownerSessionId ?? callerKey,
                parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
                currentModel: input.ctx.model,
                modelScope,
            },
            cwd: effectiveCwd,
            artifactsDir,
            artifactConfig: input.artifactConfig,
            sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
            sessionFile: target.sessionFile,
            ...priorTerminalResultForResume(target),
            activeRuntimeMs,
            ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
            outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, runId),
            maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
            controlConfig: resolveControlConfig(input.deps.config.control),
            availableModels,
            providerFallbackModels: providerFallbackModelsForTarget(input.params),
            modelFallbackNotice: input.params.modelFallbackNotice,
            ...(continuationTelemetryProvenance
                ? { telemetryProvenance: continuationTelemetryProvenance }
                : {}),
            ...(continuationTelemetryLineage ? { telemetryLineage: continuationTelemetryLineage } : {}),
        });
    }
    catch (error) {
        reservation.release();
        claimedPause?.rollbackReserved();
        throw error;
    }
    if (result.isError) {
        reservation.release();
        claimedPause?.rollbackReserved();
        return result;
    }
    const revivedId = result.details.asyncId ?? runId;
    claimedPause?.markSpawned();
    return {
        content: [
            {
                type: "text",
                text: formatRevivedAsyncResponse(target, revivedId, result.details),
            },
        ],
        details: result.details,
    };
}
