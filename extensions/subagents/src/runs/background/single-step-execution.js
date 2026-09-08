import * as fs from "node:fs";
import * as path from "node:path";
import { createChildTranscriptWriter, } from "../../shared/child-transcript.js";
import { contextWindowForModel, emptyUsage, runPiStreaming, } from "./pi-streaming.js";
import { getArtifactPaths, writeArtifactWithFloor } from "../../shared/artifacts.js";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, } from "../shared/single-output.js";
import {} from "../../shared/types.js";
import {} from "../shared/parallel-utils.js";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { appendRuntimeFallbackResolution, canonicalSubagentModelIdentity, combineModelFallbackNotices, formatModelAttemptNote, isRetryableModelFailure, sanitizeModelFallbackNotice, } from "../shared/model-fallback.js";
import { boundChildError, boundChildStderrError, formatProtocolOutputLimit, } from "../shared/child-protocol.js";
import { scheduleDeadline } from "../shared/deadline-timer.js";
import { detectSubagentError, extractTextFromContent, formatErrorWithOutput, } from "../../shared/utils.js";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.js";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.js";
import { boundedActiveRuntimeMs, createActiveRuntimeTracker, normalizeActiveRuntimeCheckpointAt, } from "../shared/lifecycle-state.js";
import { acceptanceFailureMessage, appendAcceptanceReportDigest, buildSkippedAcceptanceLedger, composeAcceptanceFailureError, evaluateAcceptance, formatAcceptancePrompt, parseAndStripAcceptanceReport, } from "../shared/acceptance.js";
import { skipOwnedProcessGroupCleanup, supportsOwnedProcessGroupCleanup, } from "../shared/process-group-cleanup.js";
import { classifyContextExhaustedTermination, CONTEXT_EXHAUSTED_TERMINATION_MESSAGE, hasUsableSessionArtifact, mergeContextUsageDiagnostics, parseContextUsageDiagnostics, resolveSubagentTerminationReason, } from "../../shared/context-diagnostics.js";
function costSummaryFromAttempts(attempts) {
    if (!attempts || attempts.length === 0)
        return undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for (const attempt of attempts) {
        inputTokens += attempt.usage?.input ?? 0;
        outputTokens += attempt.usage?.output ?? 0;
        costUsd += attempt.usage?.cost ?? 0;
    }
    return inputTokens > 0 || outputTokens > 0 || costUsd > 0
        ? { inputTokens, outputTokens, costUsd }
        : undefined;
}
function dispatchThinkingDropped(step, model) {
    if (!model)
        return false;
    if (step.thinkingDroppedModels)
        return step.thinkingDroppedModels.includes(model);
    return Boolean(step.attemptNotes?.some((note) => note.includes(`model "${model}"`)));
}
export function saturatingStepDeadlineAt(stepStartedAt, stepTimeoutMs) {
    return Math.min(Number.MAX_SAFE_INTEGER, stepStartedAt + stepTimeoutMs);
}
function prepareSingleStepSetup(step, ctx) {
    const segmentStartedAt = normalizeActiveRuntimeCheckpointAt(ctx.startedAt) ?? Date.now();
    const priorActiveRuntimeMs = boundedActiveRuntimeMs(step.activeRuntimeMs);
    const runtimeTracker = ctx.runtimeTracker ??
        createActiveRuntimeTracker({
            priorActiveRuntimeMs,
            segmentStartedAt,
        });
    const stepTimeoutController = new AbortController();
    let activeTimeoutInterrupt;
    const inheritedTimeoutSignal = ctx.timeoutSignal;
    const relayInheritedTimeout = () => stepTimeoutController.abort();
    if (inheritedTimeoutSignal?.aborted)
        relayInheritedTimeout();
    else
        inheritedTimeoutSignal?.addEventListener("abort", relayInheritedTimeout, { once: true });
    const stepDeadlineAt = step.timeoutMs !== undefined
        ? saturatingStepDeadlineAt(segmentStartedAt, step.timeoutMs)
        : undefined;
    const childDeadlineAt = ctx.deadlineAt === undefined
        ? stepDeadlineAt
        : stepDeadlineAt === undefined
            ? ctx.deadlineAt
            : Math.min(ctx.deadlineAt, stepDeadlineAt);
    const stepOwnsDeadline = (step.timeoutOwner === "role" && step.timeoutMs !== undefined) ||
        (step.timeoutOwner !== "run" &&
            stepDeadlineAt !== undefined &&
            (ctx.deadlineAt === undefined || stepDeadlineAt <= ctx.deadlineAt));
    const stepTimeoutTimer = childDeadlineAt !== undefined
        ? scheduleDeadline(childDeadlineAt, () => {
            runtimeTracker.freeze(Date.now());
            stepTimeoutController.abort();
            activeTimeoutInterrupt?.();
        })
        : undefined;
    const parentRegisterTimeout = ctx.registerTimeout;
    const stepContext = {
        ...ctx,
        timeoutSignal: stepTimeoutController.signal,
        timeoutMessage: stepOwnsDeadline
            ? `Subagent timed out after ${step.timeoutMs}ms.`
            : ctx.timeoutMessage,
        registerTimeout: (interrupt) => {
            activeTimeoutInterrupt = interrupt;
            parentRegisterTimeout?.(interrupt);
        },
    };
    let task = step.task;
    const taskForCompletionGuard = task;
    if (step.effectiveAcceptance) {
        const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
        if (acceptancePrompt)
            task = `${task}\n${acceptancePrompt}`;
    }
    const sessionEnabled = Boolean(step.sessionFile) || stepContext.sessionEnabled;
    const sessionDir = step.sessionFile ? undefined : stepContext.sessionDir;
    let artifactPaths;
    let transcriptWriter;
    if (stepContext.artifactsDir && stepContext.artifactConfig?.enabled !== false) {
        const index = stepContext.flatStepCount > 1 ? stepContext.flatIndex : undefined;
        artifactPaths = getArtifactPaths(stepContext.artifactsDir, stepContext.id, step.agent, index);
        fs.mkdirSync(stepContext.artifactsDir, { recursive: true });
        if (stepContext.artifactConfig?.includeInput !== false) {
            fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
        }
        if (stepContext.artifactConfig?.includeTranscript !== false) {
            transcriptWriter = createChildTranscriptWriter({
                transcriptPath: artifactPaths.transcriptPath,
                source: "async",
                runId: stepContext.id,
                agent: step.agent,
                childIndex: stepContext.flatIndex,
                cwd: step.cwd ?? stepContext.cwd,
            });
        }
    }
    transcriptWriter?.writeInitialUserMessage(task);
    const candidates = step.modelCandidates && step.modelCandidates.length > 0
        ? step.modelCandidates
        : step.model
            ? [step.model]
            : [undefined];
    const attemptedModels = [];
    const modelAttempts = [];
    const attemptNotes = [...(step.attemptNotes ?? [])];
    let modelResolution = step.modelResolution;
    const eventsPath = path.join(path.dirname(stepContext.outputFile), "events.jsonl");
    const initialToolBudget = step.toolBudget ? initialToolBudgetState(step.toolBudget) : undefined;
    const restoredSession = hasUsableSessionArtifact(step.sessionFile);
    const persistedContextUsage = parseContextUsageDiagnostics(step.contextUsage);
    let aggregateContextUsage = persistedContextUsage
        ? {
            ...persistedContextUsage,
            ...(persistedContextUsage.restoredTokens === undefined &&
                persistedContextUsage.contextTokens !== undefined
                ? { restoredTokens: persistedContextUsage.contextTokens }
                : {}),
        }
        : undefined;
    return {
        runtimeTracker,
        stepTimeoutTimer,
        inheritedTimeoutSignal,
        relayInheritedTimeout,
        parentRegisterTimeout,
        childDeadlineAt,
        ctx: stepContext,
        task,
        taskForCompletionGuard,
        sessionEnabled,
        sessionDir,
        artifactPaths,
        transcriptWriter,
        eventsPath,
        restoredSession,
        state: {
            candidates,
            attemptedModels,
            modelAttempts,
            attemptNotes,
            modelResolution,
            finalResult: undefined,
            finalOutputSnapshot: undefined,
            completionGuardTriggeredFinal: false,
            toolBudget: initialToolBudget,
            toolBudgetBlocked: false,
            contextExhaustedDetected: false,
            firstAttemptIdentity: undefined,
            aggregateContextUsage,
            finalAttemptContextUsage: undefined,
        },
    };
}
function prepareSingleStepAttempt(input) {
    const { step, ctx, state, candidate, index, task, sessionEnabled, sessionDir } = input;
    const attemptThinking = dispatchThinkingDropped(step, candidate)
        ? undefined
        : resolveEffectiveThinking(candidate, step.thinking);
    const attemptIdentity = canonicalSubagentModelIdentity(candidate, attemptThinking);
    if (index === 0)
        state.firstAttemptIdentity = attemptIdentity;
    let attemptResolution = state.modelResolution;
    if (index > 0) {
        state.modelResolution = appendRuntimeFallbackResolution({
            previous: state.modelResolution,
            sourceAttempt: state.modelAttempts.at(-1),
            currentIdentity: attemptIdentity,
            originalIdentity: state.firstAttemptIdentity,
        });
        attemptResolution = state.modelResolution;
    }
    ctx.onAttemptStart?.({
        model: candidate,
        thinking: attemptThinking,
        modelIdentity: attemptIdentity,
        modelResolution: attemptResolution,
        attemptedModels: candidate ? [...state.attemptedModels, candidate] : undefined,
        modelAttempts: state.modelAttempts.length > 0 ? [...state.modelAttempts] : undefined,
    });
    const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
    let args;
    let env;
    let tempDir;
    let buildError;
    try {
        ({ args, env, tempDir } = buildPiArgs({
            parentSessionId: step.parentSessionId,
            baseArgs: ["--mode", "json", "-p"],
            task,
            sessionEnabled,
            sessionDir,
            sessionFile: step.sessionFile,
            model: candidate,
            inheritProjectContext: step.inheritProjectContext,
            inheritSkills: step.inheritSkills,
            requireReadTool: step.inheritSkills || Boolean(step.skills?.length),
            tools: step.tools,
            extensions: step.extensions,
            subagentOnlyExtensions: step.subagentOnlyExtensions,
            supervisorBridge: step.supervisorBridge,
            systemPrompt: step.systemPrompt ?? "",
            systemPromptMode: step.systemPromptMode,
            cwd: step.cwd ?? ctx.cwd,
            promptFileStem: step.agent,
            runId: ctx.id,
            childAgentName: step.agent,
            projectAgentGuidance: step.projectAgentGuidance === true,
            childIndex: ctx.flatIndex,
            steerInboxDir: ctx.steerInboxDir,
            toolBudget: step.toolBudget,
        }));
    }
    catch (error) {
        buildError =
            boundChildError(error instanceof Error ? error.message : String(error)) ??
                "Unknown child setup error.";
    }
    return { candidate, attemptThinking, outputSnapshot, args, env, tempDir, buildError };
}
function assessSingleStepAttempt(input) {
    const { step, state, run, candidate, outputSnapshot, tempDir, taskForCompletionGuard } = input;
    state.finalAttemptContextUsage = run.contextUsage;
    state.aggregateContextUsage = mergeContextUsageDiagnostics(state.aggregateContextUsage, run.contextUsage);
    cleanupTempDir(tempDir);
    const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
    const runTerminationReason = resolveSubagentTerminationReason({
        assistantStopReason: run.assistantStopReason,
        effectiveExitCode: run.exitCode ?? undefined,
        processCompleted: true,
    });
    const contextExhaustedSignature = run.protocolOutputLimit
        ? undefined
        : classifyContextExhaustedTermination({
            messages: run.messages,
            contextUsage: run.contextUsage,
            exitCode: run.exitCode ?? undefined,
            error: run.error,
            terminationReason: runTerminationReason,
        });
    state.contextExhaustedDetected =
        run.contextExhausted === true || contextExhaustedSignature === "context_exhausted";
    const emptyOutputError = run.exitCode === 0 &&
        !run.error &&
        !hiddenError?.hasError &&
        !contextExhaustedSignature &&
        !run.finalOutput.trim()
        ? "Subagent produced no output (possible model cold-start or empty response)."
        : undefined;
    const completionGuard = run.exitCode === 0 &&
        !run.error &&
        !hiddenError?.hasError &&
        !emptyOutputError &&
        step.completionGuard !== false
        ? evaluateCompletionMutationGuard({
            agent: step.agent,
            task: taskForCompletionGuard,
            messages: run.messages,
            tools: step.tools,
        })
        : undefined;
    const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
    const completionGuardError = completionGuardTriggered
        ? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
        : undefined;
    const effectiveExitCode = run.protocolOutputLimit
        ? 1
        : completionGuardTriggered
            ? 1
            : hiddenError?.hasError
                ? (hiddenError.exitCode ?? 1)
                : emptyOutputError
                    ? 1
                    : run.error && run.exitCode === 0
                        ? 1
                        : run.exitCode;
    const childFailureError = hiddenError?.hasError
        ? hiddenError.details
            ? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
            : `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
        : (emptyOutputError ??
            (run.error ||
                (run.exitCode !== 0
                    ? boundChildStderrError(run.stderr.trim(), run.stderrTruncated === true)
                    : undefined)));
    const error = boundChildError(run.protocolOutputLimit
        ? formatProtocolOutputLimit(run.protocolOutputLimit)
        : (completionGuardError ?? childFailureError));
    const attempt = {
        model: candidate ?? run.model ?? step.model ?? "default",
        success: effectiveExitCode === 0 && !error,
        exitCode: effectiveExitCode,
        error,
        usage: run.usage,
    };
    state.modelAttempts.push(attempt);
    if (candidate)
        state.attemptedModels.push(candidate);
    state.completionGuardTriggeredFinal = completionGuardTriggered;
    state.finalOutputSnapshot = outputSnapshot;
    if (step.toolBudget) {
        const toolMessages = run.messages.filter((message) => message.role === "toolResult");
        const blockedMessage = toolMessages.find((message) => extractTextFromContent(message.content).includes("Tool budget hard limit reached"));
        state.toolBudgetBlocked = Boolean(blockedMessage);
        state.toolBudget = toolBudgetState(step.toolBudget, toolMessages.length, blockedMessage ? blockedMessage.toolName : undefined);
    }
    state.finalResult = {
        ...run,
        exitCode: effectiveExitCode,
        model: candidate ?? run.model,
        error,
    };
    return { attempt, completionGuardTriggered };
}
function shouldStopSingleStepAttempt(input) {
    if (input.run.protocolOutputLimit)
        return true;
    if (input.run.timedOut || input.ctx.timeoutSignal?.aborted || input.ctx.skipAcceptance?.())
        return true;
    if (input.attempt.success || input.completionGuardTriggered)
        return true;
    return !isRetryableModelFailure(input.attempt.error) || input.index === input.candidateCount - 1;
}
function prepareSingleStepAcceptance(input) {
    const { step, ctx, finalResult, output, report } = input;
    const acceptanceAbortController = new AbortController();
    const acceptanceAbortListeners = [];
    const relayAcceptanceAbort = (signal, abort) => {
        if (!signal)
            return;
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener("abort", abort, { once: true });
        acceptanceAbortListeners.push(() => signal.removeEventListener("abort", abort));
    };
    let interruptedDuringAcceptance = false;
    relayAcceptanceAbort(ctx.timeoutSignal, () => acceptanceAbortController.abort());
    relayAcceptanceAbort(ctx.interruptSignal, () => {
        interruptedDuringAcceptance = true;
        acceptanceAbortController.abort();
    });
    ctx.registerInterrupt?.(() => {
        interruptedDuringAcceptance = true;
        acceptanceAbortController.abort();
    });
    const teardown = () => {
        ctx.registerInterrupt?.(undefined);
        for (const removeAbortListener of acceptanceAbortListeners)
            removeAbortListener();
    };
    const acceptance = step.effectiveAcceptance &&
        !finalResult?.interrupted &&
        !ctx.timeoutSignal?.aborted &&
        !ctx.interruptSignal?.aborted &&
        !acceptanceAbortController.signal.aborted &&
        !ctx.skipAcceptance?.()
        ? evaluateAcceptance({
            acceptance: step.effectiveAcceptance,
            output,
            report,
            cwd: step.cwd ?? ctx.cwd,
            signal: acceptanceAbortController.signal,
            abortMessage: interruptedDuringAcceptance
                ? (ctx.interruptMessage ?? "Interrupted. Waiting for explicit next action.")
                : (ctx.timeoutMessage ?? "Subagent timed out."),
        })
        : undefined;
    return {
        acceptance,
        wasInterrupted: () => interruptedDuringAcceptance,
        teardown,
    };
}
function finalizeSingleStepOutput(input) {
    const { step, ctx, state } = input;
    const finalResult = state.finalResult;
    const processCleanup = finalResult?.processCleanup ??
        skipOwnedProcessGroupCleanup(supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform", finalResult?.processGroupId);
    const modelFallbackNotice = combineModelFallbackNotices(state.modelAttempts.length > 1
        ? sanitizeModelFallbackNotice(step.modelFallbackNotice)
        : undefined, sanitizeModelFallbackNotice(step.modelFallbackFilterNotice));
    const finalModel = finalResult?.model;
    const finalConfiguredIdentity = finalResult?.configuredModel
        ? canonicalSubagentModelIdentity(finalResult.configuredModel, dispatchThinkingDropped(step, finalResult.configuredModel) ? undefined : step.thinking)
        : undefined;
    const finalModelIdentity = finalConfiguredIdentity ?? finalResult?.runtimeModelIdentity;
    let modelResolution = state.modelResolution;
    if (state.modelAttempts.length > 1 && finalConfiguredIdentity) {
        modelResolution = appendRuntimeFallbackResolution({
            previous: modelResolution,
            sourceAttempt: state.modelAttempts.at(-2),
            currentIdentity: finalConfiguredIdentity,
            originalIdentity: state.firstAttemptIdentity,
        });
    }
    else if (modelResolution && finalConfiguredIdentity) {
        modelResolution = { ...modelResolution, resumed: finalConfiguredIdentity };
    }
    state.modelResolution = modelResolution;
    if (modelResolution) {
        const resolutionNotice = `Notice: ${modelResolution.reason}`;
        if (!state.attemptNotes.some((note) => note.includes(modelResolution.reason)))
            state.attemptNotes.push(resolutionNotice);
    }
    const rawOutput = finalResult?.finalOutput ?? "";
    const { stripped: outputForPersistence, report: rawAcceptanceReport } = parseAndStripAcceptanceReport(rawOutput);
    const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
        ? resolveSingleOutput(step.outputPath, outputForPersistence, state.finalOutputSnapshot)
        : { fullOutput: outputForPersistence };
    const output = resolvedOutput.fullOutput;
    const outputReference = resolvedOutput.savedPath
        ? formatSavedOutputReference(resolvedOutput.savedPath, output)
        : undefined;
    let outputForSummary = output;
    if (modelFallbackNotice) {
        outputForSummary = `Notice: ${modelFallbackNotice}\n\n${outputForSummary}`.trim();
    }
    if (state.attemptNotes.length > 0) {
        outputForSummary = `${state.attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
    }
    const outputForAcceptance = rawOutput;
    const finalizedOutput = finalizeSingleOutput({
        fullOutput: outputForSummary,
        outputPath: step.outputPath,
        outputMode: step.outputMode,
        exitCode: finalResult?.exitCode ?? 1,
        savedPath: resolvedOutput.savedPath,
        outputReference,
        saveError: resolvedOutput.saveError,
    });
    outputForSummary = finalizedOutput.displayOutput;
    const acceptanceEvaluation = prepareSingleStepAcceptance({
        step,
        ctx,
        finalResult,
        output: outputForAcceptance,
        report: rawAcceptanceReport,
    });
    return {
        processCleanup,
        modelFallbackNotice,
        finalModel,
        finalModelIdentity,
        rawOutput,
        rawAcceptanceReport,
        resolvedOutput,
        output,
        outputForSummary,
        acceptance: acceptanceEvaluation.acceptance,
        acceptanceWasInterrupted: acceptanceEvaluation.wasInterrupted,
        acceptanceTeardown: acceptanceEvaluation.teardown,
    };
}
function finalizeSingleStepOutcome(input) {
    const { step, ctx, state, acceptance, acceptanceWasInterrupted } = input;
    const finalResult = state.finalResult;
    const effectiveInterrupted = !finalResult?.protocolOutputLimit &&
        (finalResult?.interrupted === true ||
            acceptanceWasInterrupted() ||
            (ctx.interruptSignal?.aborted === true &&
                !ctx.timeoutSignal?.aborted &&
                !ctx.skipAcceptance?.()));
    const interruptedAcceptance = effectiveInterrupted && step.effectiveAcceptance
        ? buildSkippedAcceptanceLedger({
            acceptance: step.effectiveAcceptance,
            ledgerStatus: "skipped",
            runtimeCheckStatus: "not-applicable",
            id: "paused",
            message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
        })
        : undefined;
    const timedOutAfterAcceptance = finalResult?.timedOut === true ||
        ctx.timeoutSignal?.aborted === true ||
        ctx.skipAcceptance?.() === true;
    const effectiveAcceptance = timedOutAfterAcceptance
        ? undefined
        : (interruptedAcceptance ?? acceptance);
    const acceptanceFailure = effectiveAcceptance
        ? acceptanceFailureMessage(effectiveAcceptance)
        : undefined;
    const acceptanceCanFailRun = acceptanceFailure &&
        effectiveAcceptance?.explicit &&
        (finalResult?.exitCode ?? 1) === 0 &&
        !effectiveInterrupted &&
        !timedOutAfterAcceptance;
    let effectiveFinalExitCode = finalResult?.protocolOutputLimit
        ? 1
        : timedOutAfterAcceptance
            ? 1
            : effectiveInterrupted
                ? 0
                : acceptanceCanFailRun
                    ? 1
                    : (finalResult?.exitCode ?? 1);
    let terminationReason = finalResult?.protocolOutputLimit
        ? "output_limit"
        : resolveSubagentTerminationReason({
            paused: effectiveInterrupted,
            timedOut: timedOutAfterAcceptance,
            toolBudgetBlocked: state.toolBudgetBlocked,
            interrupted: effectiveInterrupted,
            assistantStopReason: finalResult?.assistantStopReason,
            effectiveExitCode: effectiveFinalExitCode,
            processCompleted: true,
        });
    let effectiveFinalError = finalResult?.protocolOutputLimit
        ? boundChildError(formatProtocolOutputLimit(finalResult.protocolOutputLimit))
        : timedOutAfterAcceptance
            ? boundChildError(ctx.timeoutMessage ?? "Subagent timed out.")
            : effectiveInterrupted
                ? undefined
                : acceptanceCanFailRun
                    ? composeAcceptanceFailureError(finalResult?.error, acceptanceFailure)
                    : boundChildError(finalResult?.error);
    const contextExhaustedReason = finalResult?.protocolOutputLimit
        ? undefined
        : state.contextExhaustedDetected &&
            !timedOutAfterAcceptance &&
            !effectiveInterrupted &&
            !acceptanceCanFailRun &&
            finalResult?.error === CONTEXT_EXHAUSTED_TERMINATION_MESSAGE &&
            terminationReason === "process_exit"
            ? "context_exhausted"
            : classifyContextExhaustedTermination({
                messages: finalResult?.messages,
                contextUsage: state.finalAttemptContextUsage,
                exitCode: effectiveFinalExitCode,
                error: effectiveFinalError,
                terminationReason,
            });
    if (contextExhaustedReason) {
        effectiveFinalExitCode = 1;
        effectiveFinalError = CONTEXT_EXHAUSTED_TERMINATION_MESSAGE;
        terminationReason = contextExhaustedReason;
    }
    return {
        effectiveInterrupted,
        interruptedAcceptance,
        timedOutAfterAcceptance,
        effectiveAcceptance,
        effectiveFinalExitCode,
        terminationReason,
        effectiveFinalError,
    };
}
function finalizeSingleStepArtifacts(input) {
    const { step, ctx, state, output, outcome, artifactPaths, transcriptWriter, childDeadlineAt, task, activeRuntimeMs, } = input;
    const { finalResult } = state;
    if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
        if (ctx.artifactConfig?.includeOutput !== false) {
            const artifactBaseOutput = outcome.effectiveFinalExitCode !== 0 && !outcome.effectiveInterrupted
                ? formatErrorWithOutput(outcome.effectiveFinalError, output.output)
                : output.output;
            const artifactOutput = output.rawAcceptanceReport && !output.resolvedOutput.savedPath
                ? appendAcceptanceReportDigest(artifactBaseOutput, output.rawAcceptanceReport)
                : artifactBaseOutput;
            writeArtifactWithFloor(artifactPaths.outputPath, artifactOutput, output.rawOutput, !!output.resolvedOutput.savedPath);
        }
        if (ctx.artifactConfig?.includeMetadata !== false) {
            fs.writeFileSync(artifactPaths.metadataPath, JSON.stringify({
                runId: ctx.id,
                agent: step.agent,
                projectAgent: step.projectAgent,
                ...(ctx.artifactConfig.mode !== "compact" ? { task } : {}),
                exitCode: outcome.effectiveFinalExitCode,
                exitSignal: finalResult?.exitSignal,
                model: finalResult?.model,
                modelIdentity: output.finalModelIdentity,
                modelResolution: state.modelResolution,
                attemptedModels: state.attemptedModels.length > 0 ? state.attemptedModels : undefined,
                modelAttempts: state.modelAttempts,
                modelFallbackNotice: output.modelFallbackNotice,
                error: outcome.effectiveFinalError,
                stderr: finalResult?.stderr,
                stderrTruncated: finalResult?.stderrTruncated,
                protocolOutputLimit: finalResult?.protocolOutputLimit,
                terminationReason: outcome.terminationReason,
                contextUsage: state.aggregateContextUsage,
                contextPressure: step.contextPressure,
                contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
                processCleanup: output.processCleanup,
                ...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
                transcriptError: transcriptWriter?.getError(),
                skills: step.skills,
                activeRuntimeMs,
                timeoutMs: ctx.timeoutMs ?? step.timeoutMs,
                deadlineAt: childDeadlineAt,
                timestamp: Date.now(),
            }, null, 2), "utf-8");
        }
    }
}
function cleanupSingleStepSetup(setup) {
    setup.stepTimeoutTimer?.cancel();
    setup.inheritedTimeoutSignal?.removeEventListener("abort", setup.relayInheritedTimeout);
    setup.parentRegisterTimeout?.(undefined);
}
function buildSingleStepResult(input) {
    const { step, state, setup, output, outcome, activeRuntimeMs } = input;
    const finalResult = state.finalResult;
    return {
        agent: step.agent,
        ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
        output: output.outputForSummary,
        exitCode: outcome.effectiveFinalExitCode,
        exitSignal: finalResult?.exitSignal,
        error: outcome.effectiveFinalError,
        stderr: finalResult?.stderr,
        stderrTruncated: finalResult?.stderrTruncated,
        protocolOutputLimit: finalResult?.protocolOutputLimit,
        sessionFile: step.sessionFile,
        model: output.finalModel,
        modelIdentity: output.finalModelIdentity,
        modelResolution: state.modelResolution,
        attemptedModels: state.attemptedModels.length > 0 ? state.attemptedModels : undefined,
        modelAttempts: state.modelAttempts,
        modelFallbackNotice: output.modelFallbackNotice,
        totalCost: costSummaryFromAttempts(state.modelAttempts),
        artifactPaths: setup.artifactPaths,
        processCleanup: output.processCleanup,
        contextUsage: state.aggregateContextUsage,
        contextPressure: step.contextPressure,
        contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
        terminationReason: outcome.terminationReason,
        transcriptPath: setup.transcriptWriter ? setup.artifactPaths?.transcriptPath : undefined,
        transcriptError: setup.transcriptWriter?.getError(),
        interrupted: outcome.timedOutAfterAcceptance ? false : outcome.effectiveInterrupted,
        timedOut: outcome.timedOutAfterAcceptance ? true : finalResult?.timedOut,
        toolBudget: state.toolBudget,
        toolBudgetBlocked: state.toolBudgetBlocked || undefined,
        completionGuardTriggered: state.completionGuardTriggeredFinal,
        acceptance: outcome.effectiveAcceptance,
        activeRuntimeMs,
    };
}
export async function runSingleStep(step, ctx, appendDiagnosticJsonl) {
    const setup = prepareSingleStepSetup(step, ctx);
    const stepCtx = setup.ctx;
    const state = setup.state;
    for (let index = 0; index < state.candidates.length; index++) {
        if (stepCtx.timeoutSignal?.aborted || stepCtx.skipAcceptance?.())
            break;
        const candidate = state.candidates[index];
        const attempt = prepareSingleStepAttempt({
            step,
            ctx: stepCtx,
            state,
            candidate,
            index,
            task: setup.task,
            sessionEnabled: setup.sessionEnabled,
            sessionDir: setup.sessionDir,
        });
        if (attempt.buildError) {
            const attemptResult = {
                model: candidate ?? step.model ?? "default",
                success: false,
                exitCode: 1,
                error: attempt.buildError,
                usage: emptyUsage(),
            };
            state.modelAttempts.push(attemptResult);
            if (candidate)
                state.attemptedModels.push(candidate);
            state.finalOutputSnapshot = attempt.outputSnapshot;
            state.finalResult = {
                stderr: "",
                exitCode: 1,
                messages: [],
                usage: emptyUsage(),
                model: candidate,
                configuredModel: candidate,
                error: attempt.buildError,
                finalOutput: attempt.buildError,
            };
            break;
        }
        const run = await runPiStreaming(attempt.args, step.cwd ?? stepCtx.cwd, stepCtx.outputFile, appendDiagnosticJsonl, attempt.env, stepCtx.piPackageRoot, stepCtx.piArgv1, step.maxSubagentDepth, {
            eventsPath: setup.eventsPath,
            runId: stepCtx.id,
            stepIndex: stepCtx.flatIndex,
            agent: step.agent,
            includeChildEventProjections: stepCtx.artifactConfig.includeChildEventProjections,
        }, stepCtx.registerInterrupt, stepCtx.onChildEvent, setup.transcriptWriter, stepCtx.registerTimeout, stepCtx.timeoutMessage, stepCtx.onChildProtocolOutputLimit, {
            restored: setup.restoredSession,
            configuredModel: candidate,
            contextWindow: contextWindowForModel(candidate, step.contextWindows),
            contextWindows: step.contextWindows,
        });
        const assessment = assessSingleStepAttempt({
            step,
            state,
            run,
            candidate,
            outputSnapshot: attempt.outputSnapshot,
            tempDir: attempt.tempDir,
            taskForCompletionGuard: setup.taskForCompletionGuard,
        });
        if (shouldStopSingleStepAttempt({
            run,
            ctx: stepCtx,
            attempt: assessment.attempt,
            completionGuardTriggered: assessment.completionGuardTriggered,
            index,
            candidateCount: state.candidates.length,
        }))
            break;
        state.attemptNotes.push(formatModelAttemptNote(assessment.attempt, state.candidates[index + 1]));
    }
    const output = finalizeSingleStepOutput({ step, ctx: stepCtx, state });
    let acceptance;
    try {
        acceptance = output.acceptance instanceof Promise ? await output.acceptance : output.acceptance;
    }
    finally {
        output.acceptanceTeardown();
    }
    const outcome = finalizeSingleStepOutcome({
        step,
        ctx: stepCtx,
        state,
        acceptance,
        acceptanceWasInterrupted: output.acceptanceWasInterrupted,
    });
    const activeRuntimeMs = setup.runtimeTracker.finalize();
    finalizeSingleStepArtifacts({
        step,
        ctx: stepCtx,
        state,
        output,
        outcome,
        artifactPaths: setup.artifactPaths,
        transcriptWriter: setup.transcriptWriter,
        childDeadlineAt: setup.childDeadlineAt,
        task: setup.task,
        activeRuntimeMs,
    });
    cleanupSingleStepSetup(setup);
    return buildSingleStepResult({
        step,
        ctx: stepCtx,
        state,
        setup,
        output,
        outcome,
        activeRuntimeMs,
    });
}
