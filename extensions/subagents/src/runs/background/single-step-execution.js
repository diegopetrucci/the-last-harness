import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { createChildTranscriptWriter, } from "../../shared/child-transcript.js";
import { contextWindowForModel, emptyUsage, runPiStreaming, } from "./pi-streaming.js";
import { getArtifactPaths, writeArtifactWithFloor } from "../../shared/artifacts.js";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, } from "../shared/single-output.js";
import {} from "../../shared/types.js";
import {} from "../shared/parallel-utils.js";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { appendRuntimeFallbackResolution, canonicalSubagentModelIdentity, formatModelAttemptNote, isRetryableModelFailure, sanitizeModelFallbackNotice, } from "../shared/model-fallback.js";
import { boundChildError, boundChildStderrError, formatProtocolOutputLimit, } from "../shared/child-protocol.js";
import { scheduleDeadline } from "../shared/deadline-timer.js";
import { detectSubagentError, formatErrorWithOutput } from "../../shared/utils.js";
import { captureGitWorkspaceSnapshot, captureSubagentAttemptFacts, providerTokensFromUsage, } from "../../shared/post-run-facts.js";
import { appendBoundedSubagentAttemptFact, boundSubagentAttemptFacts, } from "../../shared/terminal-result.js";
import { parseSessionFacts, snapshotSessionFiles, } from "../../shared/session-tokens.js";
import { injectTicketBody } from "../shared/ticket-context.js";
import { skipOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.js";
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
export function saturatingStepDeadlineAt(stepStartedAt, stepTimeoutMs) {
    return Math.min(Number.MAX_SAFE_INTEGER, stepStartedAt + stepTimeoutMs);
}
function prepareSingleStepSetup(step, ctx) {
    let activeTimeoutInterrupt;
    const inheritedTimeoutSignal = ctx.timeoutSignal;
    const relayInheritedTimeout = () => activeTimeoutInterrupt?.();
    if (inheritedTimeoutSignal?.aborted)
        relayInheritedTimeout();
    else
        inheritedTimeoutSignal?.addEventListener("abort", relayInheritedTimeout, { once: true });
    const parentRegisterTimeout = ctx.registerTimeout;
    const roleTimeoutMessage = step.timeoutOwner !== "run" && step.timeoutMs !== undefined
        ? `Subagent timed out after ${step.timeoutMs}ms.`
        : ctx.timeoutMessage;
    const stepContext = {
        ...ctx,
        timeoutSignal: inheritedTimeoutSignal,
        timeoutMessage: roleTimeoutMessage,
        registerTimeout: (interrupt) => {
            activeTimeoutInterrupt = interrupt;
            parentRegisterTimeout?.(interrupt);
            if (interrupt && inheritedTimeoutSignal?.aborted)
                interrupt();
        },
    };
    const task = step.task;
    const promptTask = step.ticketId !== undefined && step.ticketBody !== undefined
        ? injectTicketBody(task, step.ticketId, step.ticketBody)
        : task;
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
        triggerTimeout: () => activeTimeoutInterrupt?.(),
        inheritedTimeoutSignal,
        relayInheritedTimeout,
        parentRegisterTimeout,
        childDeadlineAt: undefined,
        ctx: stepContext,
        task,
        promptTask,
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
            contextExhaustedDetected: false,
            firstAttemptIdentity: undefined,
            aggregateContextUsage,
            finalAttemptContextUsage: undefined,
            attemptFacts: step.terminalResult
                ? boundSubagentAttemptFacts(step.terminalResult.facts.attempts)
                : [],
            seenToolCallIds: new Set(),
        },
    };
}
function prepareSingleStepAttempt(input) {
    const { step, ctx, state, candidate, index, task, sessionEnabled, sessionDir } = input;
    const attemptCwd = path.resolve(step.cwd ?? ctx.cwd);
    const baseline = captureGitWorkspaceSnapshot(attemptCwd);
    const attemptSessionPath = step.sessionFile ?? sessionDir;
    const sessionBaseline = attemptSessionPath ? snapshotSessionFiles(attemptSessionPath) : undefined;
    const startedAt = Date.now();
    const monotonicStartedAt = performance.now();
    const roleTimeoutMs = step.timeoutOwner !== "run" ? step.timeoutMs : undefined;
    const attemptDeadlineAt = roleTimeoutMs !== undefined ? saturatingStepDeadlineAt(startedAt, roleTimeoutMs) : undefined;
    const childDeadlineAt = ctx.deadlineAt === undefined
        ? attemptDeadlineAt
        : attemptDeadlineAt === undefined
            ? ctx.deadlineAt
            : Math.min(ctx.deadlineAt, attemptDeadlineAt);
    const attemptThinking = resolveEffectiveThinking(candidate, step.thinking);
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
        startedAt,
        model: candidate,
        thinking: attemptThinking,
        modelIdentity: attemptIdentity,
        modelResolution: attemptResolution,
        attemptedModels: candidate ? [...state.attemptedModels, candidate] : undefined,
        modelAttempts: state.modelAttempts.length > 0 ? [...state.modelAttempts] : undefined,
        ...(childDeadlineAt !== undefined ? { deadlineAt: childDeadlineAt } : {}),
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
            cwd: attemptCwd,
            promptFileStem: step.agent,
            runId: ctx.id,
            childAgentName: step.agent,
            projectAgentGuidance: step.projectAgentGuidance === true,
            childIndex: ctx.flatIndex,
            steerInboxDir: ctx.steerInboxDir,
        }));
    }
    catch (error) {
        buildError =
            boundChildError(error instanceof Error ? error.message : String(error)) ??
                "Unknown child setup error.";
    }
    return {
        candidate,
        attemptThinking,
        outputSnapshot,
        baseline,
        startedAt,
        attemptDeadlineAt,
        childDeadlineAt,
        monotonicStartedAt,
        sessionBaseline,
        args,
        env,
        tempDir,
        buildError,
    };
}
function assessSingleStepAttempt(input) {
    const { step, state, run, candidate, outputSnapshot, tempDir } = input;
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
    const effectiveExitCode = run.protocolOutputLimit
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
        : childFailureError);
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
    state.finalOutputSnapshot = outputSnapshot;
    state.finalResult = {
        ...run,
        exitCode: effectiveExitCode,
        model: candidate ?? run.model,
        error,
    };
    return { attempt };
}
function shouldStopSingleStepAttempt(input) {
    if (input.run.protocolOutputLimit)
        return true;
    if (input.run.timedOut || input.ctx.timeoutSignal?.aborted)
        return true;
    if (input.attempt.success)
        return true;
    return !isRetryableModelFailure(input.attempt.error) || input.index === input.candidateCount - 1;
}
function finalizeSingleStepOutput(input) {
    const { step, state } = input;
    const finalResult = state.finalResult;
    const processCleanup = finalResult?.processCleanup ??
        skipOwnedProcessGroupCleanup("process_group_unavailable", finalResult?.processGroupId);
    const modelFallbackNotice = state.modelAttempts.length > 1
        ? sanitizeModelFallbackNotice(step.modelFallbackNotice)
        : undefined;
    const finalModel = finalResult?.model;
    const finalConfiguredIdentity = finalResult?.configuredModel
        ? canonicalSubagentModelIdentity(finalResult.configuredModel, step.thinking)
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
    const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
        ? resolveSingleOutput(step.outputPath, rawOutput, state.finalOutputSnapshot)
        : { fullOutput: rawOutput };
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
    return {
        processCleanup,
        modelFallbackNotice,
        finalModel,
        finalModelIdentity,
        rawOutput,
        resolvedOutput,
        output,
        outputForSummary,
        ...(outputReference ? { outputReference } : {}),
    };
}
function finalizeSingleStepOutcome(input) {
    const { ctx, state } = input;
    const finalResult = state.finalResult;
    const effectiveInterrupted = !finalResult?.protocolOutputLimit &&
        (finalResult?.interrupted === true ||
            (ctx.interruptSignal?.aborted === true && !ctx.timeoutSignal?.aborted));
    const timedOut = finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true;
    let effectiveFinalExitCode = finalResult?.protocolOutputLimit
        ? 1
        : timedOut
            ? 1
            : effectiveInterrupted
                ? 0
                : (finalResult?.exitCode ?? 1);
    let terminationReason = finalResult?.protocolOutputLimit
        ? "output_limit"
        : resolveSubagentTerminationReason({
            paused: effectiveInterrupted,
            timedOut,
            interrupted: effectiveInterrupted,
            assistantStopReason: finalResult?.assistantStopReason,
            effectiveExitCode: effectiveFinalExitCode,
            processCompleted: true,
        });
    let effectiveFinalError = finalResult?.protocolOutputLimit
        ? boundChildError(formatProtocolOutputLimit(finalResult.protocolOutputLimit))
        : timedOut
            ? boundChildError(ctx.timeoutMessage ?? "Subagent timed out.")
            : effectiveInterrupted
                ? undefined
                : boundChildError(finalResult?.error);
    const contextExhaustedReason = finalResult?.protocolOutputLimit
        ? undefined
        : state.contextExhaustedDetected &&
            !timedOut &&
            !effectiveInterrupted &&
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
        timedOut,
        effectiveFinalExitCode,
        terminationReason,
        effectiveFinalError,
    };
}
function finalizeSingleStepArtifacts(input) {
    const { step, ctx, state, output, outcome, artifactPaths, transcriptWriter, childDeadlineAt, task, } = input;
    const { finalResult } = state;
    if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
        if (ctx.artifactConfig?.includeOutput !== false) {
            const artifactBaseOutput = outcome.effectiveFinalExitCode !== 0 && !outcome.effectiveInterrupted
                ? formatErrorWithOutput(outcome.effectiveFinalError, output.output)
                : output.output;
            writeArtifactWithFloor(artifactPaths.outputPath, artifactBaseOutput, output.rawOutput, !!output.resolvedOutput.savedPath);
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
                terminalResult: terminalResultForState(state, terminalStateForOutcome(outcome)),
                ...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
                transcriptError: transcriptWriter?.getError(),
                skills: step.skills,
                skillsWarning: step.skillsWarning,
                timeoutMs: ctx.timeoutMs ?? step.timeoutMs,
                deadlineAt: childDeadlineAt,
                timestamp: Date.now(),
            }, null, 2), "utf-8");
        }
    }
}
function terminalStateForOutcome(outcome) {
    if (outcome.effectiveInterrupted)
        return "paused";
    return outcome.effectiveFinalExitCode === 0 ? "completed" : "failed";
}
function terminalResultForState(state, terminalState) {
    if (state.attemptFacts.length === 0)
        return undefined;
    return {
        state: terminalState,
        facts: { attempts: boundSubagentAttemptFacts(state.attemptFacts) },
    };
}
function cleanupSingleStepSetup(setup) {
    setup.inheritedTimeoutSignal?.removeEventListener("abort", setup.relayInheritedTimeout);
    setup.parentRegisterTimeout?.(undefined);
}
function buildSingleStepResult(input) {
    const { step, state, setup, output, outcome } = input;
    const finalResult = state.finalResult;
    return {
        agent: step.agent,
        ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
        ...(step.ticketId ? { ticketId: step.ticketId } : {}),
        output: output.outputForSummary,
        finalOutput: output.output,
        skills: step.skills,
        skillsWarning: step.skillsWarning,
        outputMode: step.outputMode,
        savedOutputPath: output.resolvedOutput.savedPath,
        outputReference: output.outputReference,
        outputSaveError: output.resolvedOutput.saveError,
        childLocation: step.childLocation,
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
        interrupted: outcome.timedOut ? false : outcome.effectiveInterrupted,
        timedOut: outcome.timedOut ? true : finalResult?.timedOut,
        terminalResult: terminalResultForState(state, terminalStateForOutcome(outcome)),
    };
}
function providerTokensFromRuntimeUsage(usage) {
    if (!usage || usage.input + usage.output <= 0)
        return { status: "unavailable" };
    return providerTokensFromUsage(usage);
}
export function providerTokensForAttempt(input) {
    if (input.sessionFacts?.truncated)
        return { status: "unavailable" };
    return input.sessionFacts?.hasUsage
        ? providerTokensFromUsage(input.sessionFacts.tokens)
        : providerTokensFromRuntimeUsage(input.runtimeUsage);
}
function captureAttemptFactsForRun(input) {
    const { step, ctx, state, preparation, attemptIndex, run } = input;
    const sessionPath = step.sessionFile ?? ctx.sessionDir;
    const sessionFacts = sessionPath
        ? parseSessionFacts(sessionPath, {
            baseline: preparation.sessionBaseline,
            seenToolCallIds: state.seenToolCallIds,
        })
        : undefined;
    if (sessionFacts) {
        for (const id of sessionFacts.toolCallIds)
            state.seenToolCallIds.add(id);
    }
    const requestedToolCalls = sessionFacts?.requestedToolCalls ?? {
        edit: 0,
        write: 0,
        bash: 0,
    };
    const providerTokens = providerTokensForAttempt({
        sessionFacts,
        runtimeUsage: run?.usage,
    });
    const endedAt = Date.now();
    const durationMs = Math.max(0, performance.now() - preparation.monotonicStartedAt);
    const facts = captureSubagentAttemptFacts({
        attempt: attemptIndex,
        cwd: path.resolve(step.cwd ?? ctx.cwd),
        baseline: preparation.baseline,
        startedAt: preparation.startedAt,
        endedAt,
        durationMs,
        exitCode: input.effectiveExitCode,
        exitSignal: input.effectiveExitSignal,
        providerTokens,
        requestedToolCalls,
        asyncDir: ctx.asyncDir,
        stepIndex: ctx.flatIndex,
    });
    state.attemptFacts = appendBoundedSubagentAttemptFact(state.attemptFacts, facts);
    return facts;
}
export async function runSingleStep(step, ctx, appendDiagnosticJsonl) {
    const setup = prepareSingleStepSetup(step, ctx);
    const stepCtx = setup.ctx;
    const state = setup.state;
    for (let index = 0; index < state.candidates.length; index++) {
        if (stepCtx.timeoutSignal?.aborted)
            break;
        const candidate = state.candidates[index];
        const attempt = prepareSingleStepAttempt({
            step,
            ctx: stepCtx,
            state,
            candidate,
            index,
            task: setup.promptTask,
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
            const facts = captureAttemptFactsForRun({
                step,
                ctx: stepCtx,
                state,
                preparation: attempt,
                attemptIndex: state.attemptFacts.length + 1,
                effectiveExitCode: 1,
            });
            stepCtx.onAttemptEnd?.(facts);
            break;
        }
        const attemptDeadlineAt = attempt.attemptDeadlineAt;
        const childDeadlineAt = attempt.childDeadlineAt;
        const attemptOwnsDeadline = step.timeoutOwner !== "run" &&
            attemptDeadlineAt !== undefined &&
            (stepCtx.deadlineAt === undefined || attemptDeadlineAt <= stepCtx.deadlineAt);
        setup.childDeadlineAt = childDeadlineAt;
        const attemptTimeoutTimer = childDeadlineAt !== undefined
            ? scheduleDeadline(childDeadlineAt, () => {
                setup.triggerTimeout();
            })
            : undefined;
        let stopAttempt = false;
        let attemptFacts;
        let completedRun;
        try {
            const run = await runPiStreaming(attempt.args, path.resolve(step.cwd ?? stepCtx.cwd), stepCtx.outputFile, appendDiagnosticJsonl, attempt.env, stepCtx.piPackageRoot, stepCtx.piArgv1, step.maxSubagentDepth, {
                eventsPath: setup.eventsPath,
                runId: stepCtx.id,
                stepIndex: stepCtx.flatIndex,
                agent: step.agent,
                includeChildEventProjections: stepCtx.artifactConfig.includeChildEventProjections,
            }, stepCtx.registerInterrupt, stepCtx.onChildEvent, setup.transcriptWriter, stepCtx.registerTimeout, attemptOwnsDeadline
                ? `Subagent timed out after ${step.timeoutMs}ms.`
                : stepCtx.timeoutMessage, stepCtx.onChildProtocolOutputLimit, {
                restored: setup.restoredSession,
                configuredModel: candidate,
                contextWindow: contextWindowForModel(candidate, step.contextWindows),
                contextWindows: step.contextWindows,
            });
            completedRun = run;
            const assessment = assessSingleStepAttempt({
                step,
                state,
                run,
                candidate,
                outputSnapshot: attempt.outputSnapshot,
                tempDir: attempt.tempDir,
            });
            stopAttempt = shouldStopSingleStepAttempt({
                run,
                ctx: stepCtx,
                attempt: assessment.attempt,
                index,
                candidateCount: state.candidates.length,
            });
            if (!stopAttempt) {
                state.attemptNotes.push(formatModelAttemptNote(assessment.attempt, state.candidates[index + 1]));
            }
            attemptFacts = captureAttemptFactsForRun({
                step,
                ctx: stepCtx,
                state,
                preparation: attempt,
                attemptIndex: state.attemptFacts.length + 1,
                run,
                effectiveExitCode: assessment.attempt.exitCode ?? null,
                effectiveExitSignal: run.exitSignal,
            });
        }
        finally {
            attemptTimeoutTimer?.cancel();
            if (!attemptFacts) {
                attemptFacts = captureAttemptFactsForRun({
                    step,
                    ctx: stepCtx,
                    state,
                    preparation: attempt,
                    attemptIndex: state.attemptFacts.length + 1,
                    run: completedRun,
                    effectiveExitCode: completedRun?.exitCode ?? null,
                    effectiveExitSignal: completedRun?.exitSignal,
                });
            }
            stepCtx.onAttemptEnd?.(attemptFacts);
        }
        if (stopAttempt)
            break;
    }
    const output = finalizeSingleStepOutput({ step, state });
    const outcome = finalizeSingleStepOutcome({
        ctx: stepCtx,
        state,
    });
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
    });
    cleanupSingleStepSetup(setup);
    return buildSingleStepResult({
        step,
        ctx: stepCtx,
        state,
        setup,
        output,
        outcome,
    });
}
