import { existsSync } from "node:fs";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeArtifactWithFloor, writeMetadata, } from "../../shared/artifacts.js";
import { createChildTranscriptWriter, } from "../../shared/child-transcript.js";
import { DEFAULT_MAX_OUTPUT, truncateOutput, } from "../../shared/types.js";
import { buildControlEvent } from "../shared/subagent-control.js";
import { boundChildError, formatProtocolOutputLimit } from "../shared/child-protocol.js";
import { getFinalOutput, findLatestSessionFile, detectSubagentError, formatErrorWithOutput, synthesizeChildExitDiagnostic, } from "../../shared/utils.js";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.js";
import { formatSavedOutputReference, resolveSingleOutput, } from "../shared/single-output.js";
import { appendAcceptanceReportDigest, buildSkippedAcceptanceLedger, evaluateAcceptance, parseAndStripAcceptanceReport, } from "../shared/acceptance.js";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.js";
import { assistantStopReason, classifyContextExhaustedTermination, CONTEXT_EXHAUSTED_TERMINATION_MESSAGE, resolveSubagentTerminationReason, } from "../../shared/context-diagnostics.js";
import { transitionHealth, } from "../shared/health-transition.js";
const artifactOutputByResult = new WeakMap();
const acceptanceOutputByResult = new WeakMap();
function ignoredHealthTransition(state) {
    return {
        state,
        changed: false,
        projectionChanged: false,
        projection: state.activityState,
        idleEpisodeStarted: false,
        idleEpisodeEnded: false,
        idleAttentionEligible: false,
    };
}
export function applyHealthProgressProjection(progress, state) {
    progress.activityState = state.activityState;
    progress.idleEpisodeId = state.idleEpisodeId;
    progress.durableAttentionReasons = state.durableAttentionReasons.length
        ? [...state.durableAttentionReasons]
        : undefined;
    progress.compaction = state.compaction ? { ...state.compaction } : undefined;
}
export function transitionHealthForProgress(box, progress, action) {
    const closed = box.closed;
    if (closed && action.type !== "durable_attention")
        return ignoredHealthTransition(box.value);
    const transition = transitionHealth(box.value, action);
    const publishedState = closed
        ? {
            ...transition.state,
            activityState: undefined,
            idleEpisodeId: undefined,
            compaction: undefined,
        }
        : transition.state;
    const publishedTransition = closed
        ? {
            ...transition,
            state: publishedState,
            projection: undefined,
            projectionChanged: false,
        }
        : transition;
    box.value = publishedState;
    applyHealthProgressProjection(progress, publishedState);
    return publishedTransition;
}
export function clearHealthForProgress(box, progress) {
    if (box.closed)
        return;
    transitionHealthForProgress(box, progress, { type: "clear_ephemeral" });
    box.closed = true;
}
function finalAssistantStopReason(messages) {
    for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
        const stopReason = assistantStopReason(messages[index]);
        if (stopReason !== undefined)
            return stopReason;
    }
    return undefined;
}
function finalizeTerminationReason(result) {
    if (result.protocolOutputLimit) {
        result.terminationReason = "output_limit";
        return;
    }
    result.terminationReason = resolveSubagentTerminationReason({
        cancelled: Boolean(result.cancel),
        paused: Boolean(result.pause),
        timedOut: result.timedOut,
        toolBudgetBlocked: result.toolBudgetBlocked,
        interrupted: result.interrupted,
        assistantStopReason: finalAssistantStopReason(result.messages),
        effectiveExitCode: result.exitCode,
        processCompleted: true,
    });
}
export const CONFIGURED_RUN_DEADLINE_TIMEOUT_MESSAGE = "Subagent exceeded the configured maximum execution time.";
export function formatTimeoutMessage(timeoutMs) {
    return `Subagent timed out after ${timeoutMs}ms.`;
}
const TIMEOUT_RECENT_OUTPUT_LINES = 5;
const TIMEOUT_RECENT_TOOLS = 3;
const TIMEOUT_LINE_MAX_CHARS = 160;
function truncateDiagnosticLine(value, maxChars = TIMEOUT_LINE_MAX_CHARS) {
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= maxChars)
        return singleLine;
    return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
function formatTimeoutDiagnostics(result, options, artifactPaths) {
    const timeoutMessage = result.error ??
        options.timeoutMessage ??
        (options.deadlineAt !== undefined
            ? CONFIGURED_RUN_DEADLINE_TIMEOUT_MESSAGE
            : formatTimeoutMessage(options.timeoutMs ?? 0));
    const progress = result.progress;
    const details = [];
    const recentTools = progress?.recentTools.slice(-TIMEOUT_RECENT_TOOLS) ?? [];
    const recentOutput = progress?.recentOutput
        .filter((line) => typeof line === "string" && line.trim().length > 0)
        .slice(-TIMEOUT_RECENT_OUTPUT_LINES)
        .map((line) => truncateDiagnosticLine(line)) ?? [];
    if (options.runId)
        details.push(`Run id: ${options.runId}`);
    details.push(`Agent: ${result.agent}`);
    if (options.index !== undefined)
        details.push(`Child index: ${options.index}`);
    if (typeof progress?.durationMs === "number" && Number.isFinite(progress.durationMs)) {
        details.push(`Elapsed: ${progress.durationMs}ms`);
    }
    if (result.sessionFile)
        details.push(`Session file: ${result.sessionFile}`);
    if (options.artifactConfig?.includeOutput !== false && artifactPaths?.outputPath) {
        details.push(`Artifact output: ${artifactPaths.outputPath}`);
    }
    if (options.artifactConfig?.includeJsonl !== false && artifactPaths?.jsonlPath) {
        details.push(`Artifact jsonl: ${artifactPaths.jsonlPath}`);
    }
    if (progress?.activityState)
        details.push(`Activity: ${progress.activityState}`);
    if (progress?.currentTool)
        details.push(`Current tool: ${progress.currentTool}`);
    if (progress?.currentPath)
        details.push(`Current path: ${progress.currentPath}`);
    const sections = [
        timeoutMessage,
        "",
        "Recovery diagnostics:",
        ...details.map((detail) => `- ${detail}`),
    ];
    if (recentTools.length > 0) {
        sections.push("", "Recent tools:");
        for (const tool of recentTools) {
            const suffix = tool.args ? ` ${truncateDiagnosticLine(tool.args)}` : "";
            sections.push(`- ${tool.tool}${suffix}`);
        }
    }
    if (recentOutput.length > 0) {
        sections.push("", "Recent child output:");
        for (const line of recentOutput)
            sections.push(`- ${line}`);
    }
    sections.push("", "Recovery guidance:", "- Inspect the session and artifact paths listed above; compact mode may omit the diagnostic child transcript.", '- If exact child protocol or raw stderr is required, set artifacts.mode to "debug" and reproduce the failure before retrying.', "- Re-dispatch or resume the subagent after addressing the blocking tool, path, or workspace state.");
    return sections.join("\n");
}
function stripAcceptanceReportsFromMessages(messages) {
    for (const message of messages ?? []) {
        if (message.role !== "assistant" || !Array.isArray(message.content))
            continue;
        for (const part of message.content) {
            if (part.type === "text" && "text" in part && typeof part.text === "string") {
                part.text = parseAndStripAcceptanceReport(part.text).stripped;
            }
        }
    }
}
export function snapshotProgress(progress) {
    return {
        ...progress,
        skills: progress.skills ? [...progress.skills] : undefined,
        durableAttentionReasons: progress.durableAttentionReasons
            ? [...progress.durableAttentionReasons]
            : undefined,
        compaction: progress.compaction ? { ...progress.compaction } : undefined,
        recentTools: progress.recentTools.map((tool) => ({ ...tool })),
        recentOutput: [...progress.recentOutput],
    };
}
export function snapshotResult(result, progress) {
    return {
        ...result,
        messages: result.outputMode === "file-only" && result.savedOutputPath
            ? undefined
            : result.messages
                ? [...result.messages]
                : undefined,
        usage: { ...result.usage },
        contextPressure: result.contextPressure ? { ...result.contextPressure } : undefined,
        contextPressureCrossedThresholds: result.contextPressureCrossedThresholds
            ? [...result.contextPressureCrossedThresholds]
            : undefined,
        skills: result.skills ? [...result.skills] : undefined,
        attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
        modelAttempts: result.modelAttempts
            ? result.modelAttempts.map((attempt) => ({
                ...attempt,
                usage: attempt.usage ? { ...attempt.usage } : undefined,
            }))
            : undefined,
        controlEvents: result.controlEvents
            ? result.controlEvents.map((event) => ({ ...event }))
            : undefined,
        progress,
        progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
        artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
        truncation: result.truncation ? { ...result.truncation } : undefined,
        outputReference: result.outputReference ? { ...result.outputReference } : undefined,
    };
}
export function resolveResultSessionFile(result, options, shareEnabled) {
    if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
        result.sessionFile = options.sessionFile;
    }
    else if (shareEnabled && options.sessionDir) {
        const sessionFile = findLatestSessionFile(options.sessionDir);
        if (sessionFile)
            result.sessionFile = sessionFile;
    }
}
export function setupForegroundArtifacts(runtimeCwd, agentName, taskWithAcceptance, options) {
    let artifactPathsResult;
    let jsonlPath;
    let transcriptWriter;
    if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
        artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
        ensureArtifactsDir(options.artifactsDir);
        if (options.artifactConfig?.includeInput !== false) {
            writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
        }
        if (options.artifactConfig?.includeJsonl !== false) {
            jsonlPath = artifactPathsResult.jsonlPath;
        }
        if (options.artifactConfig?.includeTranscript !== false) {
            transcriptWriter = createChildTranscriptWriter({
                transcriptPath: artifactPathsResult.transcriptPath,
                source: "foreground",
                runId: options.runId,
                agent: agentName,
                childIndex: options.index,
                cwd: options.cwd ?? runtimeCwd,
            });
            transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
        }
    }
    return { artifactPathsResult, jsonlPath, transcriptWriter };
}
function normalizeSingleAttemptResult(result) {
    if (result.error && result.exitCode === 0) {
        result.exitCode = 1;
    }
    if (result.exitCode !== 0 && !result.error) {
        result.error = synthesizeChildExitDiagnostic({
            exitCode: result.exitCode,
            signal: result.exitSignal,
        });
    }
    if (result.exitCode === 0 && !result.error) {
        const errInfo = detectSubagentError(result.messages ?? []);
        if (errInfo.hasError) {
            result.exitCode = errInfo.exitCode ?? 1;
            result.error = boundChildError(errInfo.details
                ? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
                : `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`);
        }
    }
    const preNormalizationTerminationReason = result.protocolOutputLimit
        ? "output_limit"
        : result.timedOut
            ? "timed_out"
            : result.toolBudgetBlocked
                ? "tool_budget_blocked"
                : result.interrupted
                    ? "interrupted"
                    : "completed";
    const contextExhaustedSignature = classifyContextExhaustedTermination({
        messages: result.messages,
        contextUsage: result.contextUsage,
        exitCode: result.exitCode,
        error: result.error,
        terminationReason: preNormalizationTerminationReason,
    });
    if (result.exitCode === 0 && !result.error) {
        const finalText = getFinalOutput(result.messages ?? []);
        if (!contextExhaustedSignature && !finalText?.trim()) {
            result.exitCode = 1;
            result.error = "Subagent produced no output (possible model cold-start or empty response).";
        }
    }
}
function finalizeSingleAttemptOutput(input) {
    const { result, progress, agent, task, options, originalTask, outputSnapshot, observedMutationAttempt, allControlEvents, emitControlEvent, } = input;
    const acceptanceOutput = getFinalOutput(result.messages ?? []);
    const acceptanceParsed = parseAndStripAcceptanceReport(acceptanceOutput);
    const { report: finalAcceptanceReport } = acceptanceParsed;
    let fullOutput = result.protocolOutputLimit
        ? boundChildError(formatProtocolOutputLimit(result.protocolOutputLimit))
        : acceptanceParsed.stripped;
    if (result.timedOut) {
        const timeoutMessage = options.timeoutMessage ??
            (options.deadlineAt !== undefined
                ? CONFIGURED_RUN_DEADLINE_TIMEOUT_MESSAGE
                : formatTimeoutMessage(options.timeoutMs ?? 0));
        fullOutput = fullOutput.trim()
            ? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
            : timeoutMessage;
    }
    const completionGuard = result.exitCode === 0 && !result.error && agent.completionGuard !== false
        ? evaluateCompletionMutationGuard({
            agent: agent.name,
            task: originalTask ?? task,
            messages: result.messages ?? [],
            tools: agent.tools,
        })
        : undefined;
    if (completionGuard?.triggered && !observedMutationAttempt) {
        result.exitCode = 1;
        result.error =
            "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
        progress.status = "failed";
        progress.error = result.error;
        const previousActivityState = progress.activityState;
        transitionHealthForProgress(input.healthState, progress, {
            type: "durable_attention",
            reason: "completion_guard",
        });
        emitControlEvent(buildControlEvent({
            from: previousActivityState,
            to: "needs_attention",
            runId: options.runId ?? agent.name,
            agent: agent.name,
            index: options.index,
            ts: Date.now(),
            message: `${agent.name} completed without making edits for an implementation task`,
            reason: "completion_guard",
        }));
    }
    if (options.outputPath && result.exitCode === 0) {
        const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, outputSnapshot);
        fullOutput = parseAndStripAcceptanceReport(resolvedOutput.fullOutput).stripped;
        result.savedOutputPath = resolvedOutput.savedPath;
        result.outputSaveError = resolvedOutput.saveError;
        if (resolvedOutput.savedPath) {
            result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
        }
    }
    const artifactBaseOutput = result.timedOut
        ? fullOutput
        : result.exitCode !== 0 && !result.interrupted
            ? formatErrorWithOutput(result.error, fullOutput)
            : fullOutput;
    artifactOutputByResult.set(result, finalAcceptanceReport && !result.savedOutputPath
        ? appendAcceptanceReportDigest(artifactBaseOutput, finalAcceptanceReport)
        : artifactBaseOutput);
    acceptanceOutputByResult.set(result, acceptanceOutput);
    result.outputMode = options.outputMode ?? "inline";
    const preservedFinalOutput = result.finalOutput;
    result.finalOutput =
        options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
            ? result.outputReference.message
            : fullOutput;
    if (result.exitCode !== 0 &&
        !result.finalOutput.trim() &&
        typeof preservedFinalOutput === "string" &&
        preservedFinalOutput.trim()) {
        result.finalOutput = preservedFinalOutput;
    }
    if (result.error) {
        result.error = boundChildError(result.error);
        progress.error = result.error;
    }
    result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
    finalizeTerminationReason(result);
    if (options.onUpdate) {
        const finalText = result.finalOutput || result.error || "(no output)";
        const progressSnapshot = snapshotProgress(progress);
        const resultSnapshot = snapshotResult(result, progressSnapshot);
        options.onUpdate({
            content: [{ type: "text", text: finalText }],
            details: {
                mode: "single",
                results: [resultSnapshot],
                progress: [progressSnapshot],
                controlEvents: allControlEvents.length ? allControlEvents : undefined,
            },
        });
    }
    return result;
}
export function finalizeSingleAttempt(input) {
    const { result, progress, startTime, agent, options, sessionEnabled, supervisorPauseRequested, interruptedByControl, } = input;
    if (!result.protocolOutputLimit && supervisorPauseRequested) {
        resolveResultSessionFile(result, options, sessionEnabled);
        result.exitCode = 0;
        result.interrupted = true;
        result.error = undefined;
        if (result.pause)
            result.pause = { ...result.pause, ownerPid: undefined };
        result.finalOutput =
            result.finalOutput ||
                formatForegroundSupervisorPauseMessage({
                    headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
                    runId: options.runId,
                    agent: agent.name,
                    requestSummary: result.pause?.summary,
                });
        result.controlEvents = input.allControlEvents.length ? input.allControlEvents : undefined;
        clearHealthForProgress(input.healthState, progress);
        progress.durationMs = Date.now() - startTime;
        result.progressSummary = {
            toolCount: progress.toolCount,
            tokens: progress.tokens,
            durationMs: progress.durationMs,
        };
        return result;
    }
    if (!result.protocolOutputLimit && interruptedByControl) {
        resolveResultSessionFile(result, options, sessionEnabled);
        result.exitCode = 0;
        result.interrupted = true;
        result.error = undefined;
        result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
        result.controlEvents = input.allControlEvents.length ? input.allControlEvents : undefined;
        clearHealthForProgress(input.healthState, progress);
        progress.durationMs = Date.now() - startTime;
        result.progressSummary = {
            toolCount: progress.toolCount,
            tokens: progress.tokens,
            durationMs: progress.durationMs,
        };
        return result;
    }
    normalizeSingleAttemptResult(result);
    progress.status = result.exitCode === 0 ? "completed" : "failed";
    progress.durationMs = Date.now() - startTime;
    if (result.error) {
        progress.error = result.error;
        if (progress.currentTool) {
            progress.failedTool = progress.currentTool;
        }
    }
    result.progressSummary = {
        toolCount: progress.toolCount,
        tokens: progress.tokens,
        durationMs: progress.durationMs,
    };
    return finalizeSingleAttemptOutput(input);
}
export function prepareForegroundRunFinalization(input) {
    const { result, options, shareEnabled, artifactPathsResult, transcriptWriter } = input;
    resolveResultSessionFile(result, options, shareEnabled);
    if (result.timedOut) {
        const timeoutDiagnostics = formatTimeoutDiagnostics(result, options, artifactPathsResult ?? result.artifactPaths);
        result.finalOutput = timeoutDiagnostics;
        const storedAcceptanceOutput = acceptanceOutputByResult.get(result);
        const timeoutReport = storedAcceptanceOutput
            ? parseAndStripAcceptanceReport(storedAcceptanceOutput).report
            : undefined;
        artifactOutputByResult.set(result, timeoutReport && !result.savedOutputPath
            ? appendAcceptanceReportDigest(timeoutDiagnostics, timeoutReport)
            : timeoutDiagnostics);
    }
    if (transcriptWriter)
        result.transcriptPath = artifactPathsResult?.transcriptPath;
    if (transcriptWriter?.getError())
        result.transcriptError = transcriptWriter.getError();
    finalizeTerminationReason(result);
}
export function evaluateSingleAcceptance(input) {
    const { result, effectiveAcceptance, options, runtimeCwd } = input;
    const interruptedAcceptance = buildSkippedAcceptanceLedger({
        acceptance: effectiveAcceptance,
        ledgerStatus: "skipped",
        runtimeCheckStatus: "not-applicable",
        id: "paused",
        message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
    });
    const interruptedBeforeAcceptance = !result.protocolOutputLimit &&
        (result.interrupted || options.interruptSignal?.aborted === true);
    if (result.timedOut) {
        return {
            interruptedAcceptance,
            acceptance: buildSkippedAcceptanceLedger({
                acceptance: effectiveAcceptance,
                ledgerStatus: "rejected",
                runtimeCheckStatus: "failed",
                id: "timeout",
                message: "Acceptance was not evaluated because the subagent timed out.",
            }),
        };
    }
    if (interruptedBeforeAcceptance) {
        return { interruptedAcceptance, acceptance: interruptedAcceptance };
    }
    return {
        interruptedAcceptance,
        acceptance: evaluateAcceptance({
            acceptance: effectiveAcceptance,
            output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
            cwd: options.cwd ?? runtimeCwd,
            signal: options.interruptSignal,
            abortMessage: "Interrupted. Waiting for explicit next action.",
        }),
    };
}
export function finalizeForegroundArtifacts(input) {
    const { result, options, artifactPathsResult, transcriptWriter, agentName, task, finalAttemptContextUsage, } = input;
    finalizeTerminationReason(result);
    const contextExhaustedReason = result.protocolOutputLimit
        ? undefined
        : classifyContextExhaustedTermination({
            messages: result.messages,
            contextUsage: finalAttemptContextUsage,
            exitCode: result.exitCode,
            error: result.error,
            terminationReason: result.terminationReason,
        });
    if (contextExhaustedReason) {
        result.exitCode = 1;
        result.error = CONTEXT_EXHAUSTED_TERMINATION_MESSAGE;
        result.terminationReason = contextExhaustedReason;
        if (result.progress) {
            result.progress.status = "failed";
            result.progress.error = result.error;
        }
        artifactOutputByResult.set(result, formatErrorWithOutput(result.error, result.finalOutput ?? ""));
    }
    if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
        result.artifactPaths = artifactPathsResult;
        if (options.artifactConfig?.includeOutput !== false) {
            writeArtifactWithFloor(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "", acceptanceOutputByResult.get(result) ?? "", !!result.savedOutputPath);
        }
        if (options.maxOutput) {
            const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
            const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
            if (truncationResult.truncated)
                result.truncation = truncationResult;
        }
    }
    else if (options.maxOutput) {
        const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
        const truncationResult = truncateOutput(result.finalOutput ?? "", config);
        if (truncationResult.truncated)
            result.truncation = truncationResult;
    }
    stripAcceptanceReportsFromMessages(result.messages);
    if (artifactPathsResult &&
        options.artifactConfig?.enabled !== false &&
        options.artifactConfig?.includeMetadata !== false) {
        writeMetadata(artifactPathsResult.metadataPath, {
            runId: options.runId,
            agent: agentName,
            projectAgent: result.projectAgent,
            ...(options.artifactConfig?.mode !== "compact" ? { task } : {}),
            exitCode: result.exitCode,
            exitSignal: result.exitSignal,
            timedOut: result.timedOut,
            terminationReason: result.terminationReason,
            contextUsage: result.contextUsage,
            contextPressure: result.contextPressure,
            contextPressureCrossedThresholds: result.contextPressureCrossedThresholds,
            ...(result.timedOut && result.sessionFile && existsSync(result.sessionFile)
                ? { sessionFile: result.sessionFile }
                : {}),
            usage: result.usage,
            model: result.model,
            thinking: result.thinking,
            modelIdentity: result.modelIdentity,
            modelResolution: result.modelResolution,
            attemptedModels: result.attemptedModels,
            modelAttempts: result.modelAttempts,
            modelFallbackNotice: result.modelFallbackNotice,
            durationMs: result.progressSummary?.durationMs,
            activeRuntimeMs: result.activeRuntimeMs,
            timeoutMs: options.timeoutMs,
            deadlineAt: options.deadlineAt,
            toolCount: result.progressSummary?.toolCount,
            error: result.error,
            stderr: result.stderr,
            stderrTruncated: result.stderrTruncated,
            protocolOutputLimit: result.protocolOutputLimit,
            ...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
            transcriptError: result.transcriptError,
            skills: result.skills,
            skillsWarning: result.skillsWarning,
            timestamp: Date.now(),
        });
    }
}
