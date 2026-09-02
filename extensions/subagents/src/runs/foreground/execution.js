import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeArtifactWithFloor, writeMetadata, } from "../../shared/artifacts.js";
import { createChildTranscriptWriter, } from "../../shared/child-transcript.js";
import { DEFAULT_MAX_OUTPUT, truncateOutput, getSubagentDepthEnv, } from "../../shared/types.js";
import { DEFAULT_CONTROL_CONFIG, buildControlEvent, claimControlNotification, deriveActivityState, shouldNotifyControlEvent, } from "../shared/subagent-control.js";
import { getFinalOutput, findLatestSessionFile, detectSubagentError, extractToolArgsPreview, extractTextFromContent, formatErrorWithOutput, synthesizeChildExitDiagnostic, } from "../../shared/utils.js";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.js";
import { CHILD_PROTOCOL_HARD_KILL_GRACE_MS, appendBoundedChildMessage, boundChildError, boundChildStderrError, claimChildTerminalReason, childUsageNumber, createBoundedByteTail, createBoundedLineReader, formatBoundedStderr, formatProtocolOutputLimit, parseChildProtocolInput, } from "../shared/child-protocol.js";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.js";
import { buildSubagentSpawnEnv, getPiSpawnCommand } from "../shared/pi-spawn.js";
import { createJsonlWriter } from "../../shared/jsonl-writer.js";
import { appendRecentProgressItem } from "../../shared/recent-progress.js";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.js";
import { scheduleDeadline } from "../shared/deadline-timer.js";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, getThinkingLevelDropNote, } from "../shared/pi-args.js";
import { readStructuredOutput } from "../shared/structured-output.js";
import { captureSingleOutputSnapshot, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, } from "../shared/single-output.js";
import { buildFallbackModelList, buildModelCandidatePlan, appendRuntimeFallbackResolution, canonicalSubagentModelIdentity, combineModelFallbackNotices, formatModelAttemptNote, isRetryableModelFailure, sanitizeModelFallbackNotice, } from "../shared/model-fallback.js";
import { isCanonicalPackagedMinorAgent } from "../../../../shared/project-agent-guidance.js";
import { createMutatingFailureState, didMutatingToolFail, isMutatingTool, nextLongRunningTrigger, recordMutatingFailure, resetMutatingFailureState, resolveCurrentPath, shouldEscalateMutatingFailures, summarizeRecentMutatingFailures, } from "../shared/long-running-guard.js";
import { acceptanceFailureMessage, appendAcceptanceReportDigest, buildSkippedAcceptanceLedger, composeAcceptanceFailureError, evaluateAcceptance, formatAcceptancePrompt, parseAndStripAcceptanceReport, resolveEffectiveAcceptance, } from "../shared/acceptance.js";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.js";
import { boundSupervisorSummary } from "../shared/lifecycle-state.js";
import { FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE, formatForegroundSupervisorPauseMessage, } from "../../shared/foreground-pause.js";
import { resolveSupervisorChannelDir } from "../../supervisor/native-supervisor-channel.js";
import { cleanupOwnedProcessGroup, skipOwnedProcessGroupCleanup, supportsOwnedProcessGroupCleanup, } from "../shared/process-group-cleanup.js";
import { assistantStopReason, classifyContextExhaustedTermination, CONTEXT_EXHAUSTED_TERMINATION_MESSAGE, hasUsableSessionArtifact, mergeContextUsageDiagnostics, resolveEffectiveContextWindow, resolveSubagentTerminationReason, updateContextUsageDiagnostics, detectContextPressureCrossing, formatContextPressureGuidance, parseContextPressureCrossedThresholds, parseContextPressureProjection, } from "../../shared/context-diagnostics.js";
const artifactOutputByResult = new WeakMap();
const acceptanceOutputByResult = new WeakMap();
const FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE = "Foreground pause process cleanup could not be confirmed. Status does not claim the child stopped.";
function emptyUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function sumUsage(target, source) {
    target.input += source.input;
    target.output += source.output;
    target.cacheRead += source.cacheRead;
    target.cacheWrite += source.cacheWrite;
    target.cost += source.cost;
    target.turns += source.turns;
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
function formatTimeoutMessage(timeoutMs) {
    return `Subagent timed out after ${timeoutMs}ms.`;
}
function resolveEffectiveSingleTimeout(callerTimeoutMs, agentTimeoutCeilingMs) {
    if (callerTimeoutMs === undefined)
        return agentTimeoutCeilingMs;
    if (agentTimeoutCeilingMs === undefined)
        return callerTimeoutMs;
    return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}
function resolveEffectiveTimeoutDeadline(deadlineAt, timeoutMs) {
    if (timeoutMs === undefined)
        return deadlineAt;
    const timeoutDeadlineAt = Date.now() + timeoutMs;
    if (deadlineAt === undefined)
        return timeoutDeadlineAt;
    return Math.min(deadlineAt, timeoutDeadlineAt);
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
    const timeoutMessage = result.error ?? formatTimeoutMessage(options.timeoutMs ?? 0);
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
    sections.push("", "Recovery guidance:", "- Inspect the session/jsonl artifacts above for the full transcript.", "- Re-dispatch or resume the subagent after addressing the blocking tool, path, or workspace state.");
    return sections.join("\n");
}
function resolveAttemptTimeout(options) {
    if (options.timeoutMs === undefined)
        return undefined;
    const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
    return {
        timeoutMs: options.timeoutMs,
        deadlineAt,
        remainingMs: Math.max(0, deadlineAt - Date.now()),
        message: formatTimeoutMessage(options.timeoutMs),
    };
}
function appendRecentOutput(progress, lines) {
    if (lines.length === 0)
        return;
    progress.recentOutput.push(...lines.filter((line) => line.trim()));
    if (progress.recentOutput.length > 50) {
        progress.recentOutput.splice(0, progress.recentOutput.length - 50);
    }
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
function snapshotProgress(progress) {
    return {
        ...progress,
        skills: progress.skills ? [...progress.skills] : undefined,
        recentTools: progress.recentTools.map((tool) => ({ ...tool })),
        recentOutput: [...progress.recentOutput],
    };
}
function snapshotResult(result, progress) {
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
function findSupervisorRequestMetadata(input) {
    try {
        const requestsDir = path.join(resolveSupervisorChannelDir(input.runId, input.agent, input.index), "requests");
        const files = readdirSync(requestsDir)
            .filter((name) => name.endsWith(".json"))
            .map((name) => path.join(requestsDir, name));
        for (const file of files) {
            const parsed = JSON.parse(readFileSync(file, "utf-8"));
            if (parsed.runId !== input.runId ||
                parsed.agent !== input.agent ||
                parsed.childIndex !== input.index)
                continue;
            if (input.reason && parsed.reason !== input.reason)
                continue;
            const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : undefined;
            if (createdAt !== undefined && createdAt + 5_000 < input.requestedAt)
                continue;
            return {
                ...(typeof parsed.id === "string" && parsed.id ? { requestId: parsed.id } : {}),
                ...(boundSupervisorSummary(parsed.message)
                    ? { summary: boundSupervisorSummary(parsed.message) }
                    : {}),
            };
        }
    }
    catch {
    }
    return {};
}
function resolveSupervisorPauseMetadata(input) {
    if (input.toolName === "contact_supervisor" &&
        (input.toolArgs.reason === "need_decision" || input.toolArgs.reason === "interview_request")) {
        const request = findSupervisorRequestMetadata({
            runId: input.runId,
            agent: input.agent,
            index: input.index,
            reason: input.toolArgs.reason,
            requestedAt: input.requestedAt,
        });
        const summary = request.summary ?? boundSupervisorSummary(input.toolArgs.message);
        return {
            kind: "awaiting_supervisor",
            requestedAt: input.requestedAt,
            ...(summary ? { summary } : {}),
            request: {
                tool: "contact_supervisor",
                reason: input.toolArgs.reason,
                ...(request.requestId ? { requestId: request.requestId } : {}),
                ...(summary ? { summary } : {}),
            },
        };
    }
    return undefined;
}
function resolveResultSessionFile(result, options, shareEnabled) {
    if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
        result.sessionFile = options.sessionFile;
    }
    else if (shareEnabled && options.sessionDir) {
        const sessionFile = findLatestSessionFile(options.sessionDir);
        if (sessionFile)
            result.sessionFile = sessionFile;
    }
}
function setupForegroundArtifacts(runtimeCwd, agentName, taskWithAcceptance, options) {
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
function normalizeSingleAttemptResult(result, options) {
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
        const missingStructuredOutput = options.structuredOutput
            ? !existsSync(options.structuredOutput.outputPath)
            : false;
        if (!contextExhaustedSignature &&
            !finalText?.trim() &&
            (!options.structuredOutput || missingStructuredOutput)) {
            result.exitCode = 1;
            result.error = "Subagent produced no output (possible model cold-start or empty response).";
        }
    }
    if (options.structuredOutput && result.exitCode === 0 && !result.error) {
        const structured = readStructuredOutput({
            schema: options.structuredOutput.schema,
            schemaPath: options.structuredOutput.schemaPath,
            outputPath: options.structuredOutput.outputPath,
        });
        result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
        result.structuredOutputPath = options.structuredOutput.outputPath;
        if (structured.error) {
            result.exitCode = 1;
            result.error = structured.error;
        }
        else {
            result.structuredOutput = structured.value;
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
        const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
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
        emitControlEvent(buildControlEvent({
            from: progress.activityState,
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
function finalizeSingleAttempt(input) {
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
        progress.activityState = undefined;
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
        progress.activityState = undefined;
        progress.durationMs = Date.now() - startTime;
        result.progressSummary = {
            toolCount: progress.toolCount,
            tokens: progress.tokens,
            durationMs: progress.durationMs,
        };
        return result;
    }
    normalizeSingleAttemptResult(result, options);
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
function prepareForegroundRunFinalization(input) {
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
function evaluateSingleAcceptance(input) {
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
function finalizeForegroundArtifacts(input) {
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
            task,
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
async function runSingleAttempt(runtimeCwd, agent, task, model, options, shared) {
    const effectiveThinking = agent.thinking;
    const thinkingSuffixOptions = {
        availableModels: options.availableModels,
        preferredModelProvider: options.preferredModelProvider,
    };
    const thinkingDropNote = getThinkingLevelDropNote(model, effectiveThinking, false, thinkingSuffixOptions);
    if (thinkingDropNote && !shared.attemptNotes.includes(thinkingDropNote))
        shared.attemptNotes.push(thinkingDropNote);
    const modelArg = applyThinkingSuffix(model, effectiveThinking, false, thinkingSuffixOptions);
    const modelIdentity = canonicalSubagentModelIdentity(modelArg, thinkingDropNote || typeof effectiveThinking !== "string" ? undefined : effectiveThinking);
    let args;
    let sharedEnv;
    let tempDir;
    try {
        ({
            args,
            env: sharedEnv,
            tempDir,
        } = buildPiArgs({
            baseArgs: ["--mode", "json", "-p"],
            task,
            sessionEnabled: shared.sessionEnabled,
            sessionDir: options.sessionDir,
            sessionFile: options.sessionFile,
            model: modelArg,
            thinking: effectiveThinking,
            availableModels: options.availableModels,
            preferredModelProvider: options.preferredModelProvider,
            systemPromptMode: agent.systemPromptMode,
            inheritProjectContext: agent.inheritProjectContext,
            inheritSkills: agent.inheritSkills,
            requireReadTool: agent.inheritSkills || Boolean(shared.resolvedSkillNames?.length),
            tools: agent.tools,
            extensions: agent.extensions,
            subagentOnlyExtensions: agent.subagentOnlyExtensions,
            supervisorBridge: agent.supervisorBridge,
            systemPrompt: shared.systemPrompt,
            cwd: options.cwd ?? runtimeCwd,
            promptFileStem: agent.name,
            runId: options.runId,
            childAgentName: agent.name,
            projectAgentGuidance: isCanonicalPackagedMinorAgent(agent),
            childIndex: options.index ?? 0,
            parentSessionId: options.parentSessionId,
            structuredOutput: options.structuredOutput,
            steerInboxDir: options.steerInboxDir,
            toolBudget: options.toolBudget,
        }));
    }
    catch (error) {
        const message = boundChildError(error instanceof Error ? error.message : String(error)) ??
            "Unknown child setup error.";
        const now = Date.now();
        const progress = {
            index: options.index ?? 0,
            agent: agent.name,
            status: "failed",
            task,
            skills: shared.resolvedSkillNames,
            recentTools: [],
            recentOutput: [...shared.attemptNotes, message],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
            lastActivityAt: now,
            error: message,
        };
        return {
            agent: agent.name,
            task: shared.originalTask ?? task,
            exitCode: 1,
            ...(options.tkTicket ? { tkTicket: options.tkTicket } : {}),
            messages: [],
            usage: emptyUsage(),
            model: modelArg,
            ...(modelIdentity ? { thinking: modelIdentity.thinking, modelIdentity } : {}),
            artifactPaths: shared.artifactPaths,
            transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
            skills: shared.resolvedSkillNames,
            skillsWarning: shared.skillsWarning,
            ...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
            error: message,
            finalOutput: message,
            outputMode: options.outputMode ?? "inline",
            progress,
            progressSummary: { toolCount: 0, tokens: 0, durationMs: 0 },
        };
    }
    const result = {
        agent: agent.name,
        task: shared.originalTask ?? task,
        exitCode: 0,
        ...(options.tkTicket ? { tkTicket: options.tkTicket } : {}),
        messages: [],
        usage: emptyUsage(),
        model: modelArg,
        ...(modelIdentity ? { thinking: modelIdentity.thinking, modelIdentity } : {}),
        artifactPaths: shared.artifactPaths,
        transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
        skills: shared.resolvedSkillNames,
        skillsWarning: shared.skillsWarning,
        ...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
    };
    const startTime = Date.now();
    if (options.structuredOutput) {
        try {
            if (existsSync(options.structuredOutput.outputPath))
                unlinkSync(options.structuredOutput.outputPath);
        }
        catch {
        }
    }
    const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
    let interruptedByControl = false;
    const allControlEvents = [];
    let pendingControlEvents = [];
    const emittedControlEventKeys = new Set();
    const emitControlEvent = (event) => {
        if (!shouldNotifyControlEvent(controlConfig, event))
            return;
        if (!claimControlNotification(controlConfig, event, emittedControlEventKeys))
            return;
        allControlEvents.push(event);
        pendingControlEvents.push(event);
        options.onControlEvent?.(event);
    };
    const progress = {
        index: options.index ?? 0,
        agent: agent.name,
        status: "running",
        task,
        skills: shared.resolvedSkillNames,
        recentTools: [],
        recentOutput: [...shared.attemptNotes],
        toolCount: 0,
        tokens: 0,
        durationMs: 0,
        lastActivityAt: startTime,
    };
    result.progress = progress;
    const attemptTimeout = resolveAttemptTimeout(options);
    if (attemptTimeout?.remainingMs === 0) {
        result.exitCode = 1;
        result.timedOut = true;
        result.error = attemptTimeout.message;
        result.finalOutput = attemptTimeout.message;
        progress.status = "failed";
        progress.error = attemptTimeout.message;
        result.progressSummary = {
            toolCount: progress.toolCount,
            tokens: progress.tokens,
            durationMs: progress.durationMs,
        };
        return result;
    }
    const spawnEnv = buildSubagentSpawnEnv(process.env, sharedEnv, getSubagentDepthEnv(options.maxSubagentDepth));
    let observedMutationAttempt = false;
    const messageLedger = { bytes: 0, sizes: [] };
    let supervisorPauseRequested = false;
    const exitCode = await new Promise((resolve) => {
        const spawnSpec = getPiSpawnCommand(args);
        const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
        const proc = spawn(spawnSpec.command, spawnSpec.args, {
            cwd: options.cwd ?? runtimeCwd,
            env: spawnEnv,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            ...(ownsProcessGroup ? { detached: true } : {}),
        });
        const processGroupId = ownsProcessGroup && typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : undefined;
        const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
        let processClosed = false;
        let settled = false;
        let pendingSupervisorPause;
        let assistantError;
        let supervisorPauseCleanupPromise;
        let removeAbortListener;
        let removeInterruptListener;
        let activityTimer;
        let timeoutTimer;
        let timeoutTerminationTimer;
        let timeoutHardKillTimer;
        let protocolLimitHardKillTimer;
        let protocolOutputLimit;
        const terminalReason = {};
        const clearTimeoutTimers = () => {
            if (timeoutTimer) {
                timeoutTimer.cancel();
                timeoutTimer = undefined;
            }
            if (timeoutTerminationTimer) {
                clearTimeout(timeoutTerminationTimer);
                timeoutTerminationTimer = undefined;
            }
            if (timeoutHardKillTimer) {
                clearTimeout(timeoutHardKillTimer);
                timeoutHardKillTimer = undefined;
            }
        };
        const clearProtocolLimitHardKillTimer = () => {
            if (!protocolLimitHardKillTimer)
                return;
            clearTimeout(protocolLimitHardKillTimer);
            protocolLimitHardKillTimer = undefined;
        };
        const beginSupervisorPauseCleanup = () => {
            if (supervisorPauseCleanupPromise)
                return supervisorPauseCleanupPromise;
            if (processGroupId) {
                supervisorPauseCleanupPromise = cleanupOwnedProcessGroup(processGroupId);
            }
            else {
                trySignalChild(proc, "SIGINT");
                setTimeout(() => {
                    if (!processClosed && !settled)
                        trySignalChild(proc, "SIGTERM");
                }, 1000).unref?.();
                setTimeout(() => {
                    if (!processClosed && !settled)
                        trySignalChild(proc, "SIGKILL");
                }, 3000).unref?.();
                supervisorPauseCleanupPromise = Promise.resolve(skipOwnedProcessGroupCleanup(ownsProcessGroup ? "process_group_unavailable" : "unsupported_platform", undefined, ownsProcessGroup));
            }
            return supervisorPauseCleanupPromise;
        };
        const pauseForSupervisor = (pause) => {
            if (supervisorPauseRequested || processClosed || settled)
                return;
            if (!claimChildTerminalReason(terminalReason, "paused"))
                return;
            const ownerPid = processGroupId;
            result.pause = {
                ...pause,
                ownerPid,
            };
            result.interrupted = true;
            result.error = undefined;
            result.finalOutput = formatForegroundSupervisorPauseMessage({
                headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
                runId: options.runId,
                agent: agent.name,
                requestSummary: pause.summary,
            });
            progress.activityState = undefined;
            progress.durationMs = Date.now() - startTime;
            try {
                options.onSupervisorPauseTransition?.({
                    stage: "pausing",
                    result: snapshotResult(result, snapshotProgress(progress)),
                    ownerPid,
                });
            }
            catch {
                result.pause = undefined;
                result.interrupted = false;
                result.exitCode = 1;
                result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
                result.finalOutput = result.error;
                progress.status = "failed";
                progress.error = result.error;
                fireUpdate();
                void beginSupervisorPauseCleanup();
                return;
            }
            supervisorPauseRequested = true;
            fireUpdate();
            void beginSupervisorPauseCleanup();
        };
        const FINAL_STOP_GRACE_MS = 1000;
        const HARD_KILL_MS = 3000;
        let childExited = false;
        let forcedTerminationSignal = false;
        let cleanTerminalAssistantStopReceived = false;
        let finalDrainTimer;
        let finalHardKillTimer;
        const clearFinalDrainTimers = () => {
            if (finalDrainTimer) {
                clearTimeout(finalDrainTimer);
                finalDrainTimer = undefined;
            }
            if (finalHardKillTimer) {
                clearTimeout(finalHardKillTimer);
                finalHardKillTimer = undefined;
            }
        };
        const startFinalDrain = () => {
            if (childExited || finalDrainTimer || settled || processClosed)
                return;
            finalDrainTimer = setTimeout(() => {
                if (settled || processClosed)
                    return;
                const termSent = trySignalChild(proc, "SIGTERM");
                if (!termSent)
                    return;
                forcedTerminationSignal = true;
                if (!cleanTerminalAssistantStopReceived && !assistantError) {
                    result.error =
                        result.error ??
                            `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
                }
                finalHardKillTimer = setTimeout(() => {
                    if (settled || processClosed)
                        return;
                    forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
                }, HARD_KILL_MS);
                finalHardKillTimer.unref?.();
            }, FINAL_STOP_GRACE_MS);
            finalDrainTimer.unref?.();
        };
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearFinalDrainTimers();
            clearProtocolLimitHardKillTimer();
            clearStdioGuard();
            clearTimeoutTimers();
            if (activityTimer) {
                clearInterval(activityTimer);
                activityTimer = undefined;
            }
            removeAbortListener?.();
            removeInterruptListener?.();
            resolve(code);
        };
        const drainPendingControlEvents = () => {
            if (pendingControlEvents.length === 0)
                return undefined;
            const events = pendingControlEvents;
            pendingControlEvents = [];
            return events;
        };
        let activeLongRunningNotified = false;
        let pendingToolResult;
        const mutatingFailures = createMutatingFailureState();
        const mutatingFailureWindowMs = 5 * 60_000;
        const currentToolDurationMs = (now) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
        const emitNeedsAttention = (now, input = {}) => {
            if (!controlConfig.enabled)
                return false;
            const previous = progress.activityState;
            progress.activityState = "needs_attention";
            const event = buildControlEvent({
                type: "needs_attention",
                from: previous,
                to: "needs_attention",
                runId: options.runId,
                agent: agent.name,
                index: options.index,
                ts: now,
                lastActivityAt: progress.lastActivityAt,
                message: input.message,
                contextPressureSeverity: input.contextPressureSeverity,
                contextPressureThreshold: input.contextPressureThreshold,
                reason: input.reason ?? "idle",
                turns: result.usage.turns,
                tokens: progress.tokens,
                toolCount: progress.toolCount,
                currentTool: input.currentTool ?? progress.currentTool,
                currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
                currentPath: input.currentPath ?? progress.currentPath,
                recentFailureSummary: input.recentFailureSummary,
            });
            emitControlEvent(event);
            return previous !== "needs_attention";
        };
        const emitActiveLongRunning = (now, reason) => {
            if (!controlConfig.enabled ||
                activeLongRunningNotified ||
                progress.activityState === "needs_attention")
                return false;
            activeLongRunningNotified = true;
            const previous = progress.activityState;
            progress.activityState = "active_long_running";
            emitControlEvent(buildControlEvent({
                type: "active_long_running",
                from: previous,
                to: "active_long_running",
                runId: options.runId,
                agent: agent.name,
                index: options.index,
                ts: now,
                message: `${agent.name} is still active but long-running`,
                reason,
                turns: result.usage.turns,
                tokens: progress.tokens,
                toolCount: progress.toolCount,
                currentTool: progress.currentTool,
                currentToolDurationMs: currentToolDurationMs(now),
                currentPath: progress.currentPath,
                elapsedMs: now - startTime,
            }));
            return true;
        };
        const updateActivityState = (now) => {
            if (!controlConfig.enabled)
                return false;
            const idleState = deriveActivityState({
                config: controlConfig,
                startedAt: startTime,
                lastActivityAt: progress.lastActivityAt,
                toolCallInFlight: Boolean(progress.currentTool),
                now,
            });
            if (idleState === "needs_attention") {
                return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
            }
            const activeReason = nextLongRunningTrigger(controlConfig, {
                startedAt: startTime,
                now,
                turns: result.usage.turns,
                tokens: progress.tokens,
            });
            return activeReason ? emitActiveLongRunning(now, activeReason) : false;
        };
        const emitUpdateSnapshot = (text) => {
            if (!options.onUpdate || processClosed)
                return;
            const progressSnapshot = snapshotProgress(progress);
            const resultSnapshot = snapshotResult(result, progressSnapshot);
            const controlEvents = drainPendingControlEvents();
            options.onUpdate({
                content: [{ type: "text", text }],
                details: {
                    mode: "single",
                    results: [resultSnapshot],
                    progress: [progressSnapshot],
                    controlEvents,
                },
            });
        };
        const fireUpdate = () => {
            if (!options.onUpdate || processClosed)
                return;
            progress.durationMs = Date.now() - startTime;
            const output = result.timedOut && result.finalOutput
                ? result.finalOutput
                : getFinalOutput(result.messages ?? []);
            emitUpdateSnapshot(output || "(running...)");
        };
        const processLine = (line) => {
            if (!line.trim())
                return;
            jsonlWriter.writeLine(line);
            const parsed = parseChildProtocolInput(line);
            if (parsed.kind === "raw") {
                shared.transcriptWriter?.writeStdoutLine(line);
                return;
            }
            if (parsed.kind === "unknown") {
                shared.transcriptWriter?.writeStdoutLine(line);
                return;
            }
            const evt = parsed.event;
            shared.transcriptWriter?.writeChildEvent(evt);
            const now = Date.now();
            progress.durationMs = now - startTime;
            progress.lastActivityAt = now;
            updateActivityState(now);
            if (evt.type === "tool_execution_start") {
                const toolArgs = evt.args ?? {};
                let supervisorPause;
                if (options.pauseBlockingSupervisor &&
                    evt.toolName === "contact_supervisor" &&
                    (toolArgs.reason === "need_decision" || toolArgs.reason === "interview_request")) {
                    supervisorPause = resolveSupervisorPauseMetadata({
                        runId: options.runId,
                        agent: agent.name,
                        index: options.index ?? 0,
                        toolName: evt.toolName,
                        toolArgs,
                        requestedAt: now,
                    });
                    pendingSupervisorPause = supervisorPause;
                }
                progress.toolCount++;
                if (options.toolBudget) {
                    result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount);
                }
                progress.currentTool = evt.toolName;
                progress.currentToolArgs = extractToolArgsPreview(toolArgs);
                progress.currentToolStartedAt = now;
                progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
                const mutates = isMutatingTool(evt.toolName, toolArgs);
                observedMutationAttempt = observedMutationAttempt || mutates;
                pendingToolResult = {
                    tool: evt.toolName ?? "tool",
                    path: progress.currentPath,
                    mutates,
                    startedAt: now,
                };
                fireUpdate();
                if (supervisorPause?.kind === "awaiting_supervisor" && !processClosed) {
                    pauseForSupervisor(supervisorPause);
                }
            }
            if (evt.type === "tool_execution_end") {
                pendingSupervisorPause = undefined;
                if (progress.currentTool) {
                    appendRecentProgressItem(progress.recentTools, {
                        tool: progress.currentTool,
                        args: progress.currentToolArgs || "",
                        endMs: now,
                    });
                }
                progress.currentTool = undefined;
                progress.currentToolArgs = undefined;
                progress.currentToolStartedAt = undefined;
                progress.currentPath = undefined;
                fireUpdate();
            }
            if (evt.type === "message_end" && evt.message) {
                result.messages ??= [];
                appendBoundedChildMessage(result.messages, evt.message, Buffer.byteLength(line, "utf8"), messageLedger);
                if (evt.message.role === "assistant") {
                    result.usage.turns++;
                    progress.turnCount = result.usage.turns;
                    const stopReason = evt.message.stopReason;
                    const hasToolCall = Array.isArray(evt.message.content) &&
                        evt.message.content.some((part) => part.type === "toolCall");
                    const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
                    result.contextUsage = updateContextUsageDiagnostics(result.contextUsage, evt.message, {
                        restored: shared.restoredSession,
                        contextWindow: resolveEffectiveContextWindow(result.model ?? model, options.availableModels, options.preferredModelProvider),
                    });
                    while (true) {
                        const pressure = detectContextPressureCrossing(result.contextUsage, [...shared.contextPressureCrossedThresholds], now);
                        if (!pressure)
                            break;
                        shared.contextPressureCrossedThresholds.add(pressure.crossedThreshold);
                        shared.contextPressure = pressure;
                        result.contextPressure = pressure;
                        result.contextPressureCrossedThresholds = [...shared.contextPressureCrossedThresholds];
                        emitNeedsAttention(now, {
                            message: formatContextPressureGuidance(pressure),
                            contextPressureSeverity: pressure.severity,
                            contextPressureThreshold: pressure.crossedThreshold,
                            reason: "context_pressure",
                        });
                    }
                    const u = evt.message.usage;
                    if (u) {
                        result.usage.input += childUsageNumber(u, "input", "inputTokens");
                        result.usage.output += childUsageNumber(u, "output", "outputTokens");
                        result.usage.cacheRead += childUsageNumber(u, "cacheRead");
                        result.usage.cacheWrite += childUsageNumber(u, "cacheWrite");
                        result.usage.cost += childUsageNumber(u.cost, "total");
                        progress.tokens = result.usage.input + result.usage.output;
                    }
                    if (!result.model && evt.message.model)
                        result.model = evt.message.model;
                    if (evt.message.errorMessage)
                        assistantError = boundChildError(evt.message.errorMessage);
                    const assistantText = extractTextFromContent(evt.message.content);
                    appendRecentOutput(progress, assistantText.split("\n").slice(-10));
                    if (terminalAssistantStop) {
                        if (!evt.message.errorMessage && assistantText.trim())
                            assistantError = undefined;
                        cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
                        startFinalDrain();
                    }
                }
                updateActivityState(now);
                fireUpdate();
            }
            if (evt.type === "tool_result_end" && evt.message) {
                result.messages ??= [];
                appendBoundedChildMessage(result.messages, evt.message, Buffer.byteLength(line, "utf8"), messageLedger);
                const resultText = extractTextFromContent(evt.message.content);
                if (options.toolBudget &&
                    pendingToolResult &&
                    resultText.includes("Tool budget hard limit reached")) {
                    result.toolBudgetBlocked = true;
                    result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount, pendingToolResult.tool);
                }
                appendRecentOutput(progress, resultText.split("\n").slice(-10));
                const toolSnapshot = pendingToolResult;
                pendingToolResult = undefined;
                if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
                    recordMutatingFailure(mutatingFailures, {
                        tool: toolSnapshot.tool,
                        path: toolSnapshot.path,
                        error: resultText
                            .split("\n")
                            .find((line) => line.trim())
                            ?.trim()
                            .slice(0, 180) ?? "mutating tool failed",
                        ts: now,
                    }, mutatingFailureWindowMs);
                    if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
                        emitNeedsAttention(now, {
                            message: `${agent.name} needs attention after repeated mutating tool failures`,
                            reason: "tool_failures",
                            currentTool: toolSnapshot.tool,
                            currentPath: toolSnapshot.path,
                            currentToolDurationMs: toolSnapshot.startedAt
                                ? Math.max(0, now - toolSnapshot.startedAt)
                                : undefined,
                            recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
                        });
                    }
                }
                else if (toolSnapshot?.mutates) {
                    resetMutatingFailureState(mutatingFailures);
                }
                fireUpdate();
            }
        };
        if (controlConfig.enabled) {
            activityTimer = setInterval(() => {
                if (processClosed || settled)
                    return;
                const now = Date.now();
                if (updateActivityState(now)) {
                    progress.durationMs = now - startTime;
                    fireUpdate();
                }
            }, 1000);
            activityTimer.unref?.();
        }
        if (attemptTimeout) {
            timeoutTimer = scheduleDeadline(attemptTimeout.deadlineAt, () => {
                if (processClosed || settled || interruptedByControl || protocolOutputLimit)
                    return;
                if (!claimChildTerminalReason(terminalReason, "timed_out"))
                    return;
                result.timedOut = true;
                result.error = boundChildError(attemptTimeout.message);
                result.finalOutput = result.error;
                progress.status = "failed";
                progress.error = attemptTimeout.message;
                progress.durationMs = Date.now() - startTime;
                fireUpdate();
                trySignalChild(proc, "SIGINT");
                timeoutTerminationTimer = setTimeout(() => {
                    if (processClosed || settled)
                        return;
                    trySignalChild(proc, "SIGTERM");
                }, 1000);
                timeoutTerminationTimer.unref?.();
                timeoutHardKillTimer = setTimeout(() => {
                    if (processClosed || settled)
                        return;
                    trySignalChild(proc, "SIGKILL");
                }, 4000);
                timeoutHardKillTimer.unref?.();
            });
        }
        const stderrTail = createBoundedByteTail();
        const stdoutReader = createBoundedLineReader({
            stream: "stdout",
            onLine: processLine,
            onLimit: (limit) => {
                if (protocolOutputLimit)
                    return;
                if (!claimChildTerminalReason(terminalReason, "output_limit"))
                    return;
                protocolOutputLimit = limit;
                const message = boundChildError(formatProtocolOutputLimit(limit));
                result.protocolOutputLimit = limit;
                result.error = message;
                result.finalOutput = result.error;
                result.terminationReason = "output_limit";
                result.interrupted = false;
                progress.status = "failed";
                progress.error = message;
                progress.durationMs = Date.now() - startTime;
                emitUpdateSnapshot(message);
                if (settled || childExited)
                    return;
                trySignalChild(proc, "SIGTERM");
                protocolLimitHardKillTimer = setTimeout(() => {
                    protocolLimitHardKillTimer = undefined;
                    if (!settled && !childExited)
                        trySignalChild(proc, "SIGKILL");
                }, CHILD_PROTOCOL_HARD_KILL_GRACE_MS);
                protocolLimitHardKillTimer.unref?.();
            },
        });
        const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
        proc.stdout.on("data", (d) => {
            stdoutReader.push(d);
        });
        proc.stderr.on("data", (d) => {
            stderrTail.push(d);
            shared.transcriptWriter?.writeStderrChunk(d);
        });
        proc.on("exit", () => {
            childExited = true;
            clearFinalDrainTimers();
            clearProtocolLimitHardKillTimer();
        });
        proc.on("close", (code, signal) => {
            clearFinalDrainTimers();
            clearProtocolLimitHardKillTimer();
            clearStdioGuard();
            result.exitSignal = signal ?? undefined;
            stdoutReader.end();
            shared.transcriptWriter?.finishStderr();
            const stderrText = formatBoundedStderr(stderrTail);
            result.stderr = stderrText;
            result.stderrTruncated = stderrTail.wasTruncated();
            processClosed = true;
            void (async () => {
                await jsonlWriter.close().catch(() => {
                });
                cleanupTempDir(tempDir);
                if (!result.error && assistantError)
                    result.error = boundChildError(assistantError);
                const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
                if (code !== 0 && stderrText.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
                    result.error = boundChildStderrError(stderrText.trim(), stderrTail.wasTruncated());
                }
                const finalCode = protocolOutputLimit
                    ? 1
                    : forcedDrainAfterFinalSuccess
                        ? 0
                        : forcedTerminationSignal || signal
                            ? (code ?? 1)
                            : (code ?? 0);
                if (protocolOutputLimit) {
                    supervisorPauseRequested = false;
                    interruptedByControl = false;
                    result.pause = undefined;
                    result.interrupted = false;
                    result.exitCode = 1;
                    result.error = boundChildError(formatProtocolOutputLimit(protocolOutputLimit));
                    result.finalOutput = result.error;
                    progress.status = "failed";
                    progress.error = result.error;
                    finish(1);
                    return;
                }
                if (supervisorPauseRequested) {
                    void (async () => {
                        const cleanup = await beginSupervisorPauseCleanup();
                        result.processCleanup = cleanup;
                        if (!cleanup.terminated) {
                            supervisorPauseRequested = false;
                            result.pause = undefined;
                            result.interrupted = false;
                            result.exitCode = 1;
                            result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
                            result.finalOutput = result.error;
                            result.exitSignal = undefined;
                            progress.status = "failed";
                            progress.error = result.error;
                            finish(1);
                            return;
                        }
                        result.exitCode = 0;
                        result.interrupted = true;
                        result.error = undefined;
                        result.exitSignal = undefined;
                        if (result.pause)
                            result.pause = { ...result.pause, pausedAt: Date.now(), ownerPid: undefined };
                        progress.durationMs = Date.now() - startTime;
                        result.progressSummary = {
                            toolCount: progress.toolCount,
                            tokens: progress.tokens,
                            durationMs: progress.durationMs,
                        };
                        resolveResultSessionFile(result, options, shared.sessionEnabled);
                        try {
                            options.onSupervisorPauseTransition?.({
                                stage: "paused",
                                result: snapshotResult(result, snapshotProgress(progress)),
                            });
                        }
                        catch {
                            supervisorPauseRequested = false;
                            result.pause = undefined;
                            result.interrupted = false;
                            result.exitCode = 1;
                            result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
                            result.finalOutput = result.error;
                            progress.status = "failed";
                            progress.error = result.error;
                            finish(1);
                            return;
                        }
                        finish(0);
                    })();
                    return;
                }
                if (interruptedByControl) {
                    void (async () => {
                        const cleanup = await beginSupervisorPauseCleanup();
                        result.processCleanup = cleanup;
                        if (!cleanup.terminated) {
                            interruptedByControl = false;
                            result.interrupted = false;
                            result.exitCode = 1;
                            result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
                            result.finalOutput = result.error;
                            progress.status = "failed";
                            progress.error = result.error;
                            finish(1);
                            return;
                        }
                        processClosed = true;
                        finish(finalCode);
                    })();
                    return;
                }
                finish(finalCode);
            })();
        });
        proc.on("error", (error) => {
            clearFinalDrainTimers();
            clearProtocolLimitHardKillTimer();
            clearStdioGuard();
            stdoutReader.end();
            shared.transcriptWriter?.finishStderr();
            const stderrText = formatBoundedStderr(stderrTail);
            result.stderr = stderrText;
            result.stderrTruncated = stderrTail.wasTruncated();
            if (!result.error) {
                result.error = boundChildError(error instanceof Error ? error.message : String(error));
            }
            processClosed = true;
            void (async () => {
                await jsonlWriter.close().catch(() => {
                });
                cleanupTempDir(tempDir);
                finish(1);
            })();
        });
        if (options.signal) {
            const kill = () => {
                if (processClosed)
                    return;
                if (options.pauseBlockingSupervisor &&
                    pendingSupervisorPause?.kind === "awaiting_supervisor") {
                    pauseForSupervisor(pendingSupervisorPause);
                    return;
                }
                proc.kill("SIGTERM");
                setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
            };
            if (options.signal.aborted)
                kill();
            else {
                options.signal.addEventListener("abort", kill, { once: true });
                removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
            }
        }
        if (options.interruptSignal) {
            const interrupt = () => {
                if (processClosed || settled || protocolOutputLimit)
                    return;
                if (result.timedOut)
                    return;
                if (!claimChildTerminalReason(terminalReason, "interrupted"))
                    return;
                interruptedByControl = true;
                clearTimeoutTimers();
                progress.status = "running";
                progress.durationMs = Date.now() - startTime;
                result.interrupted = true;
                result.finalOutput = "Interrupted. Waiting for explicit next action.";
                progress.activityState = undefined;
                fireUpdate();
                void beginSupervisorPauseCleanup();
            };
            if (options.interruptSignal.aborted)
                interrupt();
            else {
                options.interruptSignal.addEventListener("abort", interrupt, { once: true });
                removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
            }
        }
    });
    result.exitCode = exitCode;
    return finalizeSingleAttempt({
        result,
        progress,
        startTime,
        agent,
        task,
        options,
        sessionEnabled: shared.sessionEnabled,
        originalTask: shared.originalTask,
        outputSnapshot: shared.outputSnapshot,
        supervisorPauseRequested,
        interruptedByControl,
        observedMutationAttempt,
        allControlEvents,
        emitControlEvent,
    });
}
export async function runSync(runtimeCwd, agents, agentName, task, options) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
        return {
            agent: agentName,
            task,
            exitCode: 1,
            messages: [],
            usage: emptyUsage(),
            error: `Unknown agent: ${agentName}`,
        };
    }
    const effectiveTimeoutMs = resolveEffectiveSingleTimeout(options.timeoutMs, agent.maxExecutionTimeMs);
    options = {
        ...options,
        timeoutMs: effectiveTimeoutMs,
        deadlineAt: resolveEffectiveTimeoutDeadline(options.deadlineAt, effectiveTimeoutMs),
        ...(agent.supervisorBridge === false ? { pauseBlockingSupervisor: false } : {}),
    };
    const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
    if (outputModeValidationError) {
        return {
            agent: agentName,
            task,
            exitCode: 1,
            messages: [],
            usage: emptyUsage(),
            outputMode: options.outputMode,
            error: outputModeValidationError,
        };
    }
    const shareEnabled = options.share === true;
    const effectiveAcceptance = resolveEffectiveAcceptance({
        explicit: options.acceptance,
        agentName,
        acceptanceRole: agent.acceptanceRole,
        task,
        mode: options.acceptanceContext?.mode ?? "single",
        async: options.acceptanceContext?.async,
    });
    const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
    const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
    const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
    const restoredSession = hasUsableSessionArtifact(options.sessionFile);
    const skillNames = options.skills ?? agent.skills ?? [];
    const skillCwd = options.cwd ?? runtimeCwd;
    const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
    if (skillNames.some((skill) => skill.trim() === "pi-subagents") &&
        missingSkills.includes("pi-subagents")) {
        return {
            agent: agentName,
            task,
            exitCode: 1,
            messages: [],
            usage: emptyUsage(),
            error: "Skills not found: pi-subagents",
        };
    }
    let systemPrompt = agent.systemPrompt?.trim() || "";
    if (resolvedSkills.length > 0) {
        const skillInjection = buildSkillInjection(resolvedSkills);
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
    }
    systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath);
    const fallbackModels = buildFallbackModelList(options.fallbackModels, agent.fallbackModels);
    const candidatePlan = buildModelCandidatePlan(options.modelOverride ?? agent.model, fallbackModels, options.availableModels, options.preferredModelProvider, { scope: options.modelScope, registry: options.modelRegistry });
    const candidates = candidatePlan.candidates;
    const filteringNotice = candidatePlan.filteringNotice;
    const configuredFallbackNotice = sanitizeModelFallbackNotice(options.modelFallbackNotice);
    const attemptedModels = [];
    const modelAttempts = [];
    const aggregateUsage = emptyUsage();
    const attemptNotes = [];
    const contextPressureCrossedThresholds = new Set(parseContextPressureCrossedThresholds(options.contextPressureCrossedThresholds) ?? []);
    let contextPressure = parseContextPressureProjection(options.contextPressure);
    let totalToolCount = 0;
    let totalDurationMs = 0;
    const { artifactPathsResult, jsonlPath, transcriptWriter } = setupForegroundArtifacts(runtimeCwd, agentName, taskWithAcceptance, options);
    let lastResult;
    let aggregateContextUsage;
    let finalAttemptContextUsage;
    let firstAttemptModelIdentity;
    let modelResolution = options.modelResolution;
    const modelsToTry = candidates.length > 0 ? candidates : [undefined];
    for (let i = 0; i < modelsToTry.length; i++) {
        const candidate = modelsToTry[i];
        const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
        const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, options, {
            sessionEnabled,
            systemPrompt,
            resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
            skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
            jsonlPath,
            artifactPaths: artifactPathsResult,
            transcriptWriter,
            attemptNotes,
            restoredSession,
            outputSnapshot,
            originalTask: task,
            contextPressureCrossedThresholds,
            contextPressure,
        });
        lastResult = result;
        contextPressure = result.contextPressure ?? contextPressure;
        finalAttemptContextUsage = result.contextUsage;
        aggregateContextUsage = mergeContextUsageDiagnostics(aggregateContextUsage, result.contextUsage);
        if (i === 0)
            firstAttemptModelIdentity = result.modelIdentity;
        if (i > 0) {
            modelResolution = appendRuntimeFallbackResolution({
                previous: modelResolution,
                sourceAttempt: modelAttempts.at(-1),
                currentIdentity: result.modelIdentity,
                originalIdentity: firstAttemptModelIdentity,
            });
        }
        if (result.model)
            attemptedModels.push(result.model);
        else if (candidate)
            attemptedModels.push(candidate);
        sumUsage(aggregateUsage, result.usage);
        totalToolCount += result.progressSummary?.toolCount ?? 0;
        totalDurationMs += result.progressSummary?.durationMs ?? 0;
        const attemptSucceeded = result.exitCode === 0 && !result.error;
        const attempt = {
            model: result.model ?? candidate ?? agent.model ?? "default",
            success: attemptSucceeded,
            exitCode: result.exitCode,
            error: result.error,
            usage: { ...result.usage },
        };
        modelAttempts.push(attempt);
        if (result.protocolOutputLimit || result.timedOut) {
            break;
        }
        if (attemptSucceeded) {
            break;
        }
        if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
            break;
        }
        attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
    }
    const result = lastResult ??
        {
            agent: agentName,
            task,
            exitCode: 1,
            messages: [],
            usage: emptyUsage(),
            error: "Subagent did not produce a result.",
        };
    if (options.projectAgent)
        result.projectAgent = options.projectAgent;
    if (modelAttempts.length > 1 && result.modelIdentity) {
        modelResolution = appendRuntimeFallbackResolution({
            previous: modelResolution,
            sourceAttempt: modelAttempts.at(-2),
            currentIdentity: result.modelIdentity,
            originalIdentity: firstAttemptModelIdentity,
        });
    }
    else if (modelResolution && result.modelIdentity) {
        modelResolution = { ...modelResolution, resumed: result.modelIdentity };
    }
    result.modelResolution = modelResolution;
    result.usage = aggregateUsage;
    result.contextUsage = aggregateContextUsage;
    result.contextPressure = contextPressure;
    result.contextPressureCrossedThresholds = contextPressureCrossedThresholds.size
        ? [...contextPressureCrossedThresholds]
        : undefined;
    result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
    result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
    const modelFallbackNotice = combineModelFallbackNotices(modelAttempts.length > 1 ? configuredFallbackNotice : undefined, filteringNotice);
    if (modelFallbackNotice)
        result.modelFallbackNotice = modelFallbackNotice;
    result.progressSummary = {
        toolCount: totalToolCount,
        tokens: aggregateUsage.input + aggregateUsage.output,
        durationMs: totalDurationMs,
    };
    result.activeRuntimeMs = totalDurationMs;
    if (attemptNotes.length > 0 && result.progress) {
        const existingNotes = new Set(result.progress.recentOutput);
        result.progress.recentOutput = [
            ...attemptNotes.filter((note) => !existingNotes.has(note)),
            ...result.progress.recentOutput,
        ];
        if (result.progress.recentOutput.length > 50) {
            result.progress.recentOutput.splice(50);
        }
    }
    prepareForegroundRunFinalization({
        result,
        options,
        shareEnabled,
        artifactPathsResult,
        transcriptWriter,
    });
    const acceptanceEvaluation = evaluateSingleAcceptance({
        result,
        effectiveAcceptance,
        options,
        runtimeCwd,
    });
    const { interruptedAcceptance, acceptance } = acceptanceEvaluation;
    result.acceptance = acceptance instanceof Promise ? await acceptance : acceptance;
    if (!result.protocolOutputLimit &&
        !result.timedOut &&
        !result.interrupted &&
        options.interruptSignal?.aborted) {
        result.interrupted = true;
        result.exitCode = 0;
        result.error = undefined;
        result.finalOutput = "Interrupted. Waiting for explicit next action.";
        result.acceptance = interruptedAcceptance;
        if (result.progress) {
            result.progress.activityState = undefined;
            result.progress.error = undefined;
        }
    }
    const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
    if (acceptanceFailure &&
        result.acceptance.explicit &&
        result.exitCode === 0 &&
        !result.interrupted &&
        !result.timedOut &&
        !result.protocolOutputLimit) {
        result.exitCode = 1;
        result.error = composeAcceptanceFailureError(result.error, acceptanceFailure);
        if (result.progress) {
            result.progress.status = "failed";
            result.progress.error = result.error;
        }
    }
    finalizeForegroundArtifacts({
        result,
        options,
        artifactPathsResult,
        transcriptWriter,
        agentName,
        task,
        finalAttemptContextUsage,
    });
    return result;
}
