var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { createChildTranscriptWriter, } from "../../shared/child-transcript.js";
import { acceptChildMessageRequest, consumeInterruptRequest, deliverInterruptRequest, deliverTimeoutRequest, enqueueStepChildMessage, stepSteerInboxDir, watchAsyncControlInbox, writeChildMessageAcceptanceForRequest, } from "./control-channel.js";
import { appendJsonl as appendRawJsonl, getArtifactPaths, writeArtifactWithFloor, } from "../../shared/artifacts.js";
import { buildSubagentSpawnEnv, PI_CODING_AGENT_PACKAGE, getPiSpawnCommand, resolveInstalledPiPackageRoot, } from "../shared/pi-spawn.js";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, } from "../shared/single-output.js";
import { DEFAULT_MAX_OUTPUT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, truncateOutput, getSubagentDepthEnv, } from "../../shared/types.js";
import { DEFAULT_CONTROL_CONFIG, buildControlEvent, deriveActivityState, claimControlNotification, formatControlNoticeMessage, } from "../shared/subagent-control.js";
import { isParallelGroup, flattenSteps, mapConcurrent, aggregateParallelOutputs, MAX_PARALLEL_CONCURRENCY, DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore, } from "../shared/parallel-utils.js";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.js";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.js";
import { createStructuredOutputRuntime, readStructuredOutput, } from "../shared/structured-output.js";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, } from "../shared/nested-events.js";
import { appendRuntimeFallbackResolution, canonicalSubagentModelIdentity, combineModelFallbackNotices, formatModelAttemptNote, resolveRuntimeModelContext, isRetryableModelFailure, sanitizeModelFallbackNotice, } from "../shared/model-fallback.js";
import { CHILD_PROTOCOL_HARD_KILL_GRACE_MS, appendBoundedChildMessage, boundChildError, boundChildStderrError, claimChildTerminalReason, childUsageNumber, createBoundedBytePrefix, createBoundedByteTail, createBoundedLineReader, formatBoundedRawStdout, formatBoundedStderr, formatProtocolOutputLimit, formatStderrLineOverflow, formatStderrTailOverflow, MAX_CHILD_ERROR_BYTES, MAX_CHILD_RAW_STDOUT_BYTES, MAX_CHILD_STDERR_LINE_BYTES, parseChildProtocolInput, } from "../shared/child-protocol.js";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.js";
import { appendRecentProgressItem } from "../../shared/recent-progress.js";
import { scheduleDeadline } from "../shared/deadline-timer.js";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, formatErrorWithOutput, getFinalOutput, readStatus, synthesizeChildExitDiagnostic, } from "../../shared/utils.js";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.js";
import { createMutatingFailureState, didMutatingToolFail, isMutatingTool, nextLongRunningTrigger, recordMutatingFailure, resetMutatingFailureState, resolveCurrentPath, shouldEscalateMutatingFailures, summarizeRecentMutatingFailures, } from "../shared/long-running-guard.js";
import { parseSessionTokens } from "../../shared/session-tokens.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { acceptanceFailureMessage, appendAcceptanceReportDigest, buildSkippedAcceptanceLedger, composeAcceptanceFailureError, evaluateAcceptance, formatAcceptancePrompt, parseAndStripAcceptanceReport, } from "../shared/acceptance.js";
import { cleanupOwnedProcessGroup, formatOwnedProcessGroupCleanup, skipOwnedProcessGroupCleanup, supportsOwnedProcessGroupCleanup, } from "../shared/process-group-cleanup.js";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.js";
import { TERMINAL_RUN_STATES, boundSupervisorSummary, finalizeLifecycleContinuationLaunch, lifecycleGeneration, mergeAndWriteSourceRunnerStatus, transitionLifecycleStatus, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.js";
import { assistantStopReason, classifyContextExhaustedTermination, CONTEXT_EXHAUSTED_TERMINATION_MESSAGE, hasUsableSessionArtifact, parseContextPressureCrossedThresholds, parseContextPressureProjection, parseContextUsageDiagnostics, mergeContextUsageDiagnostics, resolveSubagentTerminationReason, updateContextUsageDiagnostics, detectContextPressureCrossing, formatContextPressureGuidance, } from "../../shared/context-diagnostics.js";
import { splitKnownThinkingSuffix } from "../../shared/model-info.js";
const ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE = "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";
const ASYNC_INTERRUPT_SIGNAL = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 50 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const TRUNCATED_EVENT_TYPE = "subagent.events.truncated";
const TRUNCATION_MARKER_RESERVE_BYTES = 512;
const asyncEventLogStates = new Map();
function maxAsyncEventsBytes() {
    const raw = process.env[ASYNC_EVENTS_MAX_BYTES_ENV];
    if (!raw)
        return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
        return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
    return Math.floor(parsed);
}
function eventLogState(filePath) {
    let state = asyncEventLogStates.get(filePath);
    if (state)
        return state;
    let bytes = 0;
    try {
        bytes = fs.statSync(filePath).size;
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            void 0;
        }
    }
    state = { bytes, diagnosticsTruncated: false };
    asyncEventLogStates.set(filePath, state);
    return state;
}
function appendJsonl(filePath, line) {
    try {
        appendRawJsonl(filePath, line);
        const state = asyncEventLogStates.get(filePath);
        if (state)
            state.bytes += Buffer.byteLength(`${line}\n`, "utf-8");
    }
    catch {
    }
}
function appendDiagnosticJsonl(filePath, line, droppedEventType) {
    if (!line.trim())
        return;
    const state = eventLogState(filePath);
    if (state.diagnosticsTruncated)
        return;
    const maxBytes = maxAsyncEventsBytes();
    const chunkBytes = Buffer.byteLength(`${line}\n`, "utf-8");
    const diagnosticBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE_BYTES);
    if (state.bytes + chunkBytes <= diagnosticBudget) {
        appendJsonl(filePath, line);
        return;
    }
    const marker = JSON.stringify({
        type: TRUNCATED_EVENT_TYPE,
        ts: Date.now(),
        maxBytes,
        droppedEventType,
    });
    if (state.bytes + Buffer.byteLength(`${marker}\n`, "utf-8") <= maxBytes) {
        appendJsonl(filePath, marker);
    }
    state.diagnosticsTruncated = true;
}
function shouldPersistChildEvent(event) {
    return event.type !== "message_update";
}
function findLatestSessionFile(sessionDir) {
    try {
        const files = fs
            .readdirSync(sessionDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => path.join(sessionDir, f));
        if (files.length === 0)
            return null;
        files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return files[0] ?? null;
    }
    catch {
        return null;
    }
}
function emptyUsage() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function tokenUsageFromAttempts(attempts) {
    if (!attempts || attempts.length === 0)
        return null;
    let input = 0;
    let output = 0;
    for (const attempt of attempts) {
        input += attempt.usage?.input ?? 0;
        output += attempt.usage?.output ?? 0;
    }
    const total = input + output;
    return total > 0 ? { input, output, total } : null;
}
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
function appendRecentStepOutput(step, lines) {
    const nonEmpty = lines.filter((line) => line.trim());
    if (nonEmpty.length === 0)
        return;
    step.recentOutput ??= [];
    step.recentOutput.push(...nonEmpty);
    if (step.recentOutput.length > 50) {
        step.recentOutput.splice(0, step.recentOutput.length - 50);
    }
}
function isTerminalAssistantStop(message) {
    const stopReason = message.stopReason;
    const hasToolCall = Array.isArray(message.content) &&
        message.content.some((part) => part.type === "toolCall");
    return stopReason === "stop" && !hasToolCall;
}
function resetStepLiveDetail(step) {
    step.currentTool = undefined;
    step.currentToolArgs = undefined;
    step.currentToolStartedAt = undefined;
    step.currentPath = undefined;
    step.recentTools = [];
    step.recentOutput = [];
}
function resolveSupervisorPauseMetadata(input) {
    if (input.toolName === "contact_supervisor" &&
        (input.toolArgs?.reason === "need_decision" || input.toolArgs?.reason === "interview_request")) {
        const summary = boundSupervisorSummary(input.toolArgs.message);
        return {
            kind: "awaiting_supervisor",
            requestedAt: input.requestedAt,
            ...(summary ? { summary } : {}),
            request: {
                tool: "contact_supervisor",
                reason: input.toolArgs.reason,
                ...(summary ? { summary } : {}),
            },
        };
    }
    return undefined;
}
function contextWindowForModel(model, contextWindows) {
    if (!model || !contextWindows)
        return undefined;
    const baseModel = splitKnownThinkingSuffix(model).baseModel;
    const value = contextWindows[baseModel];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function runtimeModelReference(identity) {
    return `${identity.provider}/${identity.model}${identity.thinking ? `:${identity.thinking}` : ""}`;
}
function runPiStreaming(args, cwd, outputFile, env, piPackageRoot, piArgv1, maxSubagentDepth, childEventContext, registerInterrupt, onChildEvent, transcriptWriter, registerTimeout, timeoutMessage, onChildProtocolOutputLimit, context) {
    return new Promise((resolve) => {
        const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
        const spawnEnv = buildSubagentSpawnEnv(process.env, env, getSubagentDepthEnv(maxSubagentDepth));
        const spawnSpec = getPiSpawnCommand(args, {
            ...(piPackageRoot ? { piPackageRoot } : {}),
            ...(piArgv1 ? { argv1: piArgv1 } : {}),
        });
        const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
        const child = spawn(spawnSpec.command, spawnSpec.args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env: spawnEnv,
            windowsHide: true,
            ...(ownsProcessGroup ? { detached: true } : {}),
        });
        const processGroupId = ownsProcessGroup && typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
        const stderrTail = createBoundedByteTail();
        const messages = [];
        const messageLedger = { bytes: 0, sizes: [] };
        const usage = emptyUsage();
        let model;
        let error;
        let assistantError;
        let protocolOutputLimit;
        let stderrLineOverflow = false;
        const terminalReason = {};
        let interrupted = false;
        let timedOut = false;
        let observedMutationAttempt = false;
        let contextUsage;
        let runtimeModelIdentity;
        let finalAssistantStopReason;
        let wroteHumanReadableOutput = false;
        const rawStdout = createBoundedBytePrefix(MAX_CHILD_RAW_STDOUT_BYTES);
        const writeOutputLine = (line) => {
            if (!line.trim())
                return;
            wroteHumanReadableOutput = true;
            outputStream.write(`${line}\n`);
        };
        const writeOutputText = (text) => {
            for (const line of text.split("\n")) {
                writeOutputLine(line);
            }
        };
        const appendChildEvent = (event) => {
            if (!childEventContext)
                return;
            if (!shouldPersistChildEvent(event))
                return;
            appendDiagnosticJsonl(childEventContext.eventsPath, JSON.stringify({
                ...event,
                subagentSource: "child",
                subagentRunId: childEventContext.runId,
                subagentStepIndex: childEventContext.stepIndex,
                subagentAgent: childEventContext.agent,
                observedAt: Date.now(),
            }), typeof event.type === "string" ? event.type : undefined);
        };
        const appendChildLine = (type, line) => {
            appendChildEvent({ type, line });
            if (type === "subagent.child.stdout")
                transcriptWriter?.writeStdoutLine(line);
        };
        const processStdoutLine = (line) => {
            if (!line.trim())
                return;
            const writeRawStdoutLine = () => {
                rawStdout.push(`${line}\n`);
                writeOutputLine(line);
                appendChildLine("subagent.child.stdout", line);
            };
            const parsed = parseChildProtocolInput(line);
            if (parsed.kind === "raw") {
                writeRawStdoutLine();
                return;
            }
            if (parsed.kind === "unknown") {
                appendChildEvent(parsed.value);
                transcriptWriter?.writeStdoutLine(line);
                return;
            }
            const event = parsed.event;
            appendChildEvent(event);
            transcriptWriter?.writeChildEvent(event);
            onChildEvent?.(event);
            if (event.type === "tool_execution_start" && event.toolName) {
                observedMutationAttempt =
                    observedMutationAttempt || isMutatingTool(event.toolName, event.args);
                const toolArgs = extractToolArgsPreview(event.args ?? {});
                writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
                return;
            }
            if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
                appendBoundedChildMessage(messages, event.message, Buffer.byteLength(line, "utf8"), messageLedger);
                const text = extractTextFromContent(event.message.content);
                if (text)
                    writeOutputText(text);
                if (event.type !== "message_end" || event.message.role !== "assistant")
                    return;
                if (context && !context.configuredModel && runtimeModelIdentity === undefined) {
                    const reportedModel = resolveRuntimeModelContext(event.message.provider, event.message.model, context.contextWindows);
                    if (reportedModel) {
                        runtimeModelIdentity = reportedModel.identity;
                        context.contextWindow = reportedModel.contextWindow;
                        model = runtimeModelReference(reportedModel.identity);
                    }
                }
                if (event.message.model && runtimeModelIdentity === undefined)
                    model = event.message.model;
                if (event.message.errorMessage)
                    assistantError = boundChildError(event.message.errorMessage);
                finalAssistantStopReason = assistantStopReason(event.message);
                contextUsage = updateContextUsageDiagnostics(contextUsage, event.message, {
                    restored: context?.restored === true,
                    contextWindow: context?.contextWindow,
                });
                const eventUsage = event.message.usage;
                if (eventUsage) {
                    usage.turns++;
                    usage.input += childUsageNumber(eventUsage, "input", "inputTokens");
                    usage.output += childUsageNumber(eventUsage, "output", "outputTokens");
                    usage.cacheRead += childUsageNumber(eventUsage, "cacheRead");
                    usage.cacheWrite += childUsageNumber(eventUsage, "cacheWrite");
                    usage.cost += childUsageNumber(eventUsage.cost, "total");
                }
                if (isTerminalAssistantStop(event.message)) {
                    if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim())
                        assistantError = undefined;
                    cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
                    startFinalDrain();
                }
            }
        };
        const processStderrChunk = (chunk) => {
            const wasTruncated = stderrTail.wasTruncated();
            stderrTail.push(chunk);
            if (!wasTruncated && stderrTail.wasTruncated()) {
                appendChildEvent({
                    type: "subagent.child.stderr.truncated",
                    message: formatStderrTailOverflow(stderrTail),
                });
            }
            if (chunk.length > 0)
                wroteHumanReadableOutput = true;
            outputStream.write(chunk);
            transcriptWriter?.writeStderrChunk(chunk);
            if (childEventContext)
                stderrLineReader.push(chunk);
        };
        const FINAL_STOP_GRACE_MS = 1000;
        const HARD_KILL_MS = 3000;
        const CLOSE_FALLBACK_MS = 1000;
        const INTERRUPT_HARD_KILL_MS = 4000;
        const TIMEOUT_HARD_KILL_MS = 3000;
        let childExited = false;
        let forcedTerminationSignal = false;
        let cleanTerminalAssistantStopReceived = false;
        let finalDrainTimer;
        let finalHardKillTimer;
        let closeFallbackTimer;
        let interruptTerminationTimer;
        let interruptHardKillTimer;
        let timeoutHardKillTimer;
        let protocolLimitHardKillTimer;
        let settled = false;
        let softInterruptsEnabled = true;
        let interruptRegistered = false;
        let exitCodeFromExit = null;
        let exitSignalFromExit = null;
        let processCleanup;
        let cleanupPromise;
        const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
        const clearCloseFallbackTimer = () => {
            if (!closeFallbackTimer)
                return;
            clearTimeout(closeFallbackTimer);
            closeFallbackTimer = undefined;
        };
        const clearProtocolLimitHardKillTimer = () => {
            if (!protocolLimitHardKillTimer)
                return;
            clearTimeout(protocolLimitHardKillTimer);
            protocolLimitHardKillTimer = undefined;
        };
        const clearRegisteredInterrupt = () => {
            if (!interruptRegistered)
                return;
            interruptRegistered = false;
            registerInterrupt?.(undefined);
            registerTimeout?.(undefined);
        };
        const disableSoftInterrupts = () => {
            softInterruptsEnabled = false;
            clearRegisteredInterrupt();
        };
        const resolveProcessCleanup = () => {
            disableSoftInterrupts();
            if (processCleanup)
                return Promise.resolve(processCleanup);
            if (cleanupPromise)
                return cleanupPromise;
            cleanupPromise = (async () => {
                processCleanup = processGroupId
                    ? await cleanupOwnedProcessGroup(processGroupId)
                    : skipOwnedProcessGroupCleanup(supportsOwnedProcessGroupCleanup()
                        ? "process_group_unavailable"
                        : "unsupported_platform", processGroupId);
                return processCleanup;
            })();
            return cleanupPromise;
        };
        const finalize = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            disableSoftInterrupts();
            clearDrainTimers();
            clearCloseFallbackTimer();
            clearProtocolLimitHardKillTimer();
            clearStdioGuard();
            stdoutReader.end();
            stderrLineReader.end();
            transcriptWriter?.finishStderr();
            const stderrText = formatBoundedStderr(stderrTail);
            const finalOutput = getFinalOutput(messages) || formatBoundedRawStdout(rawStdout).trim();
            const resolvedExitCode = protocolOutputLimit
                ? (exitCode ?? 1)
                : interrupted
                    ? 0
                    : forcedTerminationSignal || signal
                        ? (exitCode ?? 1)
                        : exitCode;
            const forcedDrainAfterFinalSuccess = !protocolOutputLimit &&
                forcedTerminationSignal &&
                cleanTerminalAssistantStopReceived &&
                !(error ?? assistantError);
            const finalError = boundChildError(error ??
                assistantError ??
                (resolvedExitCode !== 0
                    ? boundChildStderrError(stderrText.trim(), stderrTail.wasTruncated() || stderrLineOverflow)
                    : undefined) ??
                synthesizeChildExitDiagnostic({ exitCode: resolvedExitCode, signal }));
            const resultExitCode = protocolOutputLimit
                ? 1
                : timedOut
                    ? 1
                    : forcedDrainAfterFinalSuccess
                        ? 0
                        : resolvedExitCode;
            const resultTerminationReason = resolveSubagentTerminationReason({
                assistantStopReason: finalAssistantStopReason,
                effectiveExitCode: resultExitCode ?? undefined,
                processCompleted: true,
            });
            const contextExhausted = protocolOutputLimit
                ? undefined
                : classifyContextExhaustedTermination({
                    messages,
                    contextUsage,
                    exitCode: resultExitCode ?? undefined,
                    error: finalError,
                    terminationReason: resultTerminationReason,
                });
            if (!interrupted &&
                !forcedDrainAfterFinalSuccess &&
                resolvedExitCode !== 0 &&
                finalError &&
                finalError !== stderrText.trim()) {
                outputStream.write(`${wroteHumanReadableOutput ? "\n" : ""}${finalError}\n`);
            }
            outputStream.end();
            resolve({
                stderr: stderrText,
                stderrTruncated: stderrTail.wasTruncated() || stderrLineOverflow,
                protocolOutputLimit,
                exitCode: contextExhausted ? 1 : resultExitCode,
                exitSignal: signal ?? undefined,
                messages,
                usage,
                model,
                error: contextExhausted
                    ? CONTEXT_EXHAUSTED_TERMINATION_MESSAGE
                    : protocolOutputLimit
                        ? finalError
                        : timedOut
                            ? (timeoutMessage ?? "Subagent timed out.")
                            : interrupted || forcedDrainAfterFinalSuccess
                                ? undefined
                                : finalError,
                finalOutput: protocolOutputLimit
                    ? (finalError ?? formatProtocolOutputLimit(protocolOutputLimit))
                    : timedOut && !finalOutput.trim()
                        ? (timeoutMessage ?? "Subagent timed out.")
                        : finalOutput,
                interrupted,
                timedOut,
                observedMutationAttempt,
                processGroupId,
                processCleanup,
                contextUsage,
                runtimeModelIdentity,
                configuredModel: context?.configuredModel,
                assistantStopReason: finalAssistantStopReason,
                contextExhausted: contextExhausted === "context_exhausted" || undefined,
            });
        };
        const stdoutReader = createBoundedLineReader({
            stream: "stdout",
            onLine: processStdoutLine,
            onLimit: (limit) => {
                if (protocolOutputLimit)
                    return;
                if (!claimChildTerminalReason(terminalReason, "output_limit"))
                    return;
                protocolOutputLimit = limit;
                interrupted = false;
                error = boundChildError(formatProtocolOutputLimit(limit));
                onChildProtocolOutputLimit?.(limit);
                if (settled || childExited)
                    return;
                trySignalChild(child, "SIGTERM");
                protocolLimitHardKillTimer = setTimeout(() => {
                    protocolLimitHardKillTimer = undefined;
                    if (!settled && !childExited)
                        trySignalChild(child, "SIGKILL");
                }, CHILD_PROTOCOL_HARD_KILL_GRACE_MS);
                protocolLimitHardKillTimer.unref?.();
            },
        });
        const stderrLineReader = createBoundedLineReader({
            stream: "stderr",
            maxPendingLineBytes: MAX_CHILD_STDERR_LINE_BYTES,
            onLine: (line) => {
                if (!line.trim())
                    return;
                appendChildEvent({ type: "subagent.child.stderr", line });
            },
            onLimit: (limit) => {
                stderrLineOverflow = true;
                appendChildEvent({
                    type: "subagent.child.stderr.overflow",
                    message: formatStderrLineOverflow(limit),
                });
            },
        });
        child.stdout.on("data", (chunk) => {
            stdoutReader.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            processStderrChunk(chunk);
        });
        interruptRegistered = true;
        registerInterrupt?.(() => {
            if (settled || timedOut || !softInterruptsEnabled || protocolOutputLimit)
                return;
            if (!claimChildTerminalReason(terminalReason, "interrupted"))
                return;
            interrupted = true;
            if (!error)
                error = "Interrupted. Waiting for explicit next action.";
            trySignalChild(child, "SIGINT");
            interruptTerminationTimer = setTimeout(() => {
                if (!settled && !timedOut && softInterruptsEnabled)
                    trySignalChild(child, "SIGTERM");
            }, 1000);
            interruptTerminationTimer.unref?.();
            interruptHardKillTimer = setTimeout(() => {
                if (!settled && !timedOut && softInterruptsEnabled)
                    trySignalChild(child, "SIGKILL");
            }, INTERRUPT_HARD_KILL_MS);
            interruptHardKillTimer.unref?.();
        });
        registerTimeout?.(() => {
            if (settled || timedOut || protocolOutputLimit)
                return;
            if (!claimChildTerminalReason(terminalReason, "timed_out"))
                return;
            timedOut = true;
            interrupted = false;
            error = boundChildError(timeoutMessage ?? "Subagent timed out.");
            trySignalChild(child, "SIGTERM");
            timeoutHardKillTimer = setTimeout(() => {
                if (!settled)
                    trySignalChild(child, "SIGKILL");
            }, TIMEOUT_HARD_KILL_MS);
            timeoutHardKillTimer.unref?.();
        });
        const clearDrainTimers = () => {
            if (finalDrainTimer) {
                clearTimeout(finalDrainTimer);
                finalDrainTimer = undefined;
            }
            if (finalHardKillTimer) {
                clearTimeout(finalHardKillTimer);
                finalHardKillTimer = undefined;
            }
            if (interruptTerminationTimer) {
                clearTimeout(interruptTerminationTimer);
                interruptTerminationTimer = undefined;
            }
            if (interruptHardKillTimer) {
                clearTimeout(interruptHardKillTimer);
                interruptHardKillTimer = undefined;
            }
            if (timeoutHardKillTimer) {
                clearTimeout(timeoutHardKillTimer);
                timeoutHardKillTimer = undefined;
            }
            clearProtocolLimitHardKillTimer();
        };
        function startFinalDrain() {
            if (childExited || finalDrainTimer || settled)
                return;
            finalDrainTimer = setTimeout(() => {
                if (settled)
                    return;
                const termSent = trySignalChild(child, "SIGTERM");
                if (!termSent)
                    return;
                forcedTerminationSignal = true;
                if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
                    error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
                }
                finalHardKillTimer = setTimeout(() => {
                    if (settled)
                        return;
                    forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
                }, HARD_KILL_MS);
                finalHardKillTimer.unref?.();
            }, FINAL_STOP_GRACE_MS);
            finalDrainTimer.unref?.();
        }
        child.on("exit", (exitCode, signal) => {
            childExited = true;
            exitCodeFromExit = exitCode;
            exitSignalFromExit = signal;
            clearDrainTimers();
            disableSoftInterrupts();
            void resolveProcessCleanup().finally(() => {
                if (settled)
                    return;
                closeFallbackTimer = setTimeout(() => {
                    if (settled)
                        return;
                    try {
                        child.stdout?.destroy();
                    }
                    catch {
                        void 0;
                    }
                    try {
                        child.stderr?.destroy();
                    }
                    catch {
                        void 0;
                    }
                    finalize(exitCodeFromExit, exitSignalFromExit);
                }, CLOSE_FALLBACK_MS);
                closeFallbackTimer.unref?.();
            });
        });
        child.on("close", (exitCode, signal) => {
            disableSoftInterrupts();
            void resolveProcessCleanup().finally(() => {
                finalize(exitCode, signal);
            });
        });
        child.on("error", (spawnError) => {
            processCleanup = skipOwnedProcessGroupCleanup(supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform", processGroupId);
            settled = true;
            disableSoftInterrupts();
            registerInterrupt?.(undefined);
            registerTimeout?.(undefined);
            clearDrainTimers();
            clearCloseFallbackTimer();
            clearStdioGuard();
            outputStream.end();
            const finalOutput = getFinalOutput(messages) || formatBoundedRawStdout(rawStdout).trim();
            const spawnErrorMessage = boundChildError(spawnError instanceof Error ? spawnError.message : String(spawnError));
            resolve({
                stderr: formatBoundedStderr(stderrTail),
                stderrTruncated: stderrTail.wasTruncated() || stderrLineOverflow,
                protocolOutputLimit,
                exitCode: 1,
                messages,
                usage,
                model,
                error: timedOut
                    ? (timeoutMessage ?? "Subagent timed out.")
                    : (error ?? assistantError ?? spawnErrorMessage),
                finalOutput: timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput,
                timedOut,
                observedMutationAttempt,
                processGroupId,
                processCleanup,
                contextUsage,
                runtimeModelIdentity,
                configuredModel: context?.configuredModel,
                assistantStopReason: finalAssistantStopReason,
            });
        });
    });
}
function resolvePiPackageRootFallback() {
    const root = resolveInstalledPiPackageRoot();
    if (root)
        return root;
    throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}
async function exportSessionHtml(sessionFile, outputDir, piPackageRoot) {
    const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
    const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
    const moduleUrl = pathToFileURL(exportModulePath).href;
    const mod = await import(__rewriteRelativeImportExtension(moduleUrl));
    const exportFromFile = mod.exportFromFile;
    if (typeof exportFromFile !== "function") {
        throw new Error("exportFromFile not available");
    }
    const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
    return exportFromFile(sessionFile, { outputPath });
}
function createShareLink(htmlPath) {
    try {
        const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
        if (auth.status !== 0) {
            return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
        }
    }
    catch {
        return { error: "GitHub CLI (gh) is not installed." };
    }
    try {
        const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
        if (result.status !== 0) {
            const err = boundChildError((result.stderr || "").trim()) || "Failed to create gist.";
            return { error: err };
        }
        const gistUrl = (result.stdout || "").trim();
        const gistId = gistUrl.split("/").pop();
        if (!gistId)
            return { error: "Failed to parse gist ID." };
        const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
        return { shareUrl, gistUrl };
    }
    catch (err) {
        return { error: boundChildError(String(err)) ?? "Failed to create gist." };
    }
}
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m${seconds}s`;
}
function writeRunLog(logPath, input) {
    const lines = [];
    lines.push(`# Subagent run ${input.id}`);
    lines.push("");
    lines.push(`- **Mode:** ${input.mode}`);
    lines.push(`- **CWD:** ${input.cwd}`);
    lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
    lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
    lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
    if (input.sessionFile)
        lines.push(`- **Session:** ${input.sessionFile}`);
    if (input.shareUrl)
        lines.push(`- **Share:** ${input.shareUrl}`);
    if (input.shareError)
        lines.push(`- **Share error:** ${input.shareError}`);
    if (input.artifactsDir)
        lines.push(`- **Artifacts:** ${input.artifactsDir}`);
    lines.push("");
    lines.push("## Steps");
    lines.push("| Step | Agent | Status | Duration |");
    lines.push("| --- | --- | --- | --- |");
    input.steps.forEach((step, i) => {
        const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
        lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
    });
    const cleanupSteps = input.steps
        .map((step, index) => ({ step, index }))
        .filter(({ step }) => step.processCleanup);
    if (cleanupSteps.length > 0) {
        lines.push("");
        lines.push("## Process cleanup");
        for (const { step, index } of cleanupSteps) {
            const cleanup = step.processCleanup;
            if (!cleanup)
                continue;
            lines.push(`${index + 1}. ${step.agent}: ${formatOwnedProcessGroupCleanup(cleanup)}`);
            for (const warning of cleanup.warnings ?? [])
                lines.push(`   - Warning: ${warning}`);
        }
    }
    lines.push("");
    lines.push("## Summary");
    if (input.truncated) {
        lines.push("_Output truncated_");
        lines.push("");
    }
    lines.push(input.summary.trim() || "(no output)");
    lines.push("");
    fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}
function dispatchThinkingDropped(step, model) {
    if (!model)
        return false;
    if (step.thinkingDroppedModels)
        return step.thinkingDroppedModels.includes(model);
    return Boolean(step.attemptNotes?.some((note) => note.includes(`model "${model}"`)));
}
function prepareSingleStepSetup(step, ctx) {
    const segmentStartedAt = ctx.startedAt ?? Date.now();
    const priorActiveRuntimeMs = Math.max(0, step.activeRuntimeMs ?? 0);
    const stepTimeoutController = new AbortController();
    let activeTimeoutInterrupt;
    const inheritedTimeoutSignal = ctx.timeoutSignal;
    const relayInheritedTimeout = () => stepTimeoutController.abort();
    if (inheritedTimeoutSignal?.aborted)
        relayInheritedTimeout();
    else
        inheritedTimeoutSignal?.addEventListener("abort", relayInheritedTimeout, { once: true });
    const childDeadlineAt = ctx.deadlineAt ??
        (step.timeoutMs !== undefined ? segmentStartedAt + step.timeoutMs : undefined);
    const stepTimeoutTimer = step.timeoutMs !== undefined
        ? scheduleDeadline(childDeadlineAt ?? segmentStartedAt, () => {
            stepTimeoutController.abort();
            activeTimeoutInterrupt?.();
        })
        : undefined;
    const parentRegisterTimeout = ctx.registerTimeout;
    const stepContext = {
        ...ctx,
        timeoutSignal: stepTimeoutController.signal,
        timeoutMessage: step.timeoutMs !== undefined
            ? `Subagent timed out after ${step.timeoutMs}ms.`
            : ctx.timeoutMessage,
        registerTimeout: (interrupt) => {
            activeTimeoutInterrupt = interrupt;
            parentRegisterTimeout?.(interrupt);
        },
    };
    const effectiveStructuredOutput = step.structuredOutput ??
        (step.structuredOutputSchema
            ? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(stepContext.outputFile), "structured-output"))
            : undefined);
    const placeholderRegex = new RegExp(stepContext.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    let task = step.task.replace(placeholderRegex, () => stepContext.previousOutput);
    task = resolveOutputReferences(task, stepContext.outputs ?? {});
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
        segmentStartedAt,
        priorActiveRuntimeMs,
        stepTimeoutTimer,
        inheritedTimeoutSignal,
        relayInheritedTimeout,
        parentRegisterTimeout,
        childDeadlineAt,
        ctx: stepContext,
        effectiveStructuredOutput,
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
    const { step, ctx, state, candidate, index, effectiveStructuredOutput, task, sessionEnabled, sessionDir, } = input;
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
    if (effectiveStructuredOutput) {
        try {
            if (fs.existsSync(effectiveStructuredOutput.outputPath))
                fs.unlinkSync(effectiveStructuredOutput.outputPath);
        }
        catch {
        }
    }
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
            structuredOutput: effectiveStructuredOutput,
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
    const { step, state, run, candidate, outputSnapshot, tempDir, effectiveStructuredOutput, taskForCompletionGuard, } = input;
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
    const missingStructuredOutput = effectiveStructuredOutput
        ? !fs.existsSync(effectiveStructuredOutput.outputPath)
        : false;
    const emptyOutputError = run.exitCode === 0 &&
        !run.error &&
        !hiddenError?.hasError &&
        !contextExhaustedSignature &&
        !run.finalOutput.trim() &&
        (!effectiveStructuredOutput || missingStructuredOutput)
        ? "Subagent produced no output (possible model cold-start or empty response)."
        : undefined;
    let structuredOutput;
    let structuredError;
    if (effectiveStructuredOutput &&
        run.exitCode === 0 &&
        !run.error &&
        !hiddenError?.hasError &&
        !emptyOutputError) {
        const structured = readStructuredOutput({
            schema: effectiveStructuredOutput.schema,
            schemaPath: effectiveStructuredOutput.schemaPath,
            outputPath: effectiveStructuredOutput.outputPath,
        });
        if (structured.error)
            structuredError = structured.error;
        else
            structuredOutput = structured.value;
    }
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
            : structuredError
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
        : (completionGuardError ?? structuredError ?? childFailureError));
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
        structuredOutput,
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
    const { step, ctx, state, output, outcome, artifactPaths, transcriptWriter, childDeadlineAt, task, priorActiveRuntimeMs, segmentStartedAt, } = input;
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
                task,
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
                activeRuntimeMs: priorActiveRuntimeMs + (Date.now() - segmentStartedAt),
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
    const { step, state, setup, output, outcome } = input;
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
        structuredOutput: outcome.timedOutAfterAcceptance ? undefined : finalResult?.structuredOutput,
        structuredOutputPath: outcome.timedOutAfterAcceptance
            ? undefined
            : setup.effectiveStructuredOutput?.outputPath,
        structuredOutputSchemaPath: outcome.timedOutAfterAcceptance
            ? undefined
            : setup.effectiveStructuredOutput?.schemaPath,
        acceptance: outcome.effectiveAcceptance,
        activeRuntimeMs: setup.priorActiveRuntimeMs + (Date.now() - setup.segmentStartedAt),
    };
}
async function runSingleStep(step, ctx) {
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
            effectiveStructuredOutput: setup.effectiveStructuredOutput,
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
        const run = await runPiStreaming(attempt.args, step.cwd ?? stepCtx.cwd, stepCtx.outputFile, attempt.env, stepCtx.piPackageRoot, stepCtx.piArgv1, step.maxSubagentDepth, {
            eventsPath: setup.eventsPath,
            runId: stepCtx.id,
            stepIndex: stepCtx.flatIndex,
            agent: step.agent,
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
            effectiveStructuredOutput: setup.effectiveStructuredOutput,
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
        priorActiveRuntimeMs: setup.priorActiveRuntimeMs,
        segmentStartedAt: setup.segmentStartedAt,
    });
    cleanupSingleStepSetup(setup);
    return buildSingleStepResult({ step, ctx: stepCtx, state, setup, output, outcome });
}
function projectInitialModelFallbackFilterNotice(notice) {
    const sanitized = sanitizeModelFallbackNotice(notice);
    return sanitized ? { modelFallbackNotice: sanitized } : {};
}
function markParallelGroupRunning(input) {
    for (let taskIndex = 0; taskIndex < input.tasks.length; taskIndex++) {
        const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
        input.statusPayload.steps[flatTaskIndex].status = "pending";
        input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
        input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
        input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
        input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
        input.statusPayload.steps[flatTaskIndex].activityState = undefined;
        input.statusPayload.steps[flatTaskIndex].error = undefined;
    }
    input.statusPayload.currentStep = input.groupStartFlatIndex;
    input.statusPayload.activityState = undefined;
    input.statusPayload.lastActivityAt = input.groupStartTime;
    input.statusPayload.lastUpdate = input.groupStartTime;
    input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
    writeAtomicJson(input.statusPath, input.statusPayload);
    appendJsonl(input.eventsPath, JSON.stringify({
        type: "subagent.parallel.started",
        ts: input.groupStartTime,
        runId: input.runId,
        stepIndex: input.stepIndex,
        agents: input.tasks.map((task) => task.agent),
        count: input.tasks.length,
    }));
}
function resolveAsyncStepTranscriptPath(input) {
    if (!input.artifactsDir ||
        input.artifactConfig?.enabled === false ||
        input.artifactConfig?.includeTranscript === false)
        return undefined;
    return getArtifactPaths(input.artifactsDir, input.runId, input.agent, input.flatStepCount > 1 ? input.flatIndex : undefined).transcriptPath;
}
function isPausedStepStatus(status) {
    return status === "paused";
}
function legacyStepToRunPlan(step) {
    return isParallelGroup(step)
        ? {
            kind: "parallel",
            tasks: step.parallel,
            ...(step.concurrency !== undefined ? { concurrency: step.concurrency } : {}),
            ...(step.failFast !== undefined ? { failFast: step.failFast } : {}),
        }
        : { kind: "single", task: step };
}
const ASYNC_RUNNER_MISSING_PLAN_ERROR = "Async runner config must include a direct plan or a non-empty legacy steps array.";
function isRunnerSubagentStepValue(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return typeof candidate.agent === "string" && typeof candidate.task === "string";
}
function isDirectRunPlanValue(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    if (candidate.kind === "single")
        return isRunnerSubagentStepValue(candidate.task);
    return (candidate.kind === "parallel" &&
        Array.isArray(candidate.tasks) &&
        candidate.tasks.length > 0 &&
        candidate.tasks.every(isRunnerSubagentStepValue));
}
function isLegacyRunStepsValue(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    return value.every((step) => {
        if (!step || typeof step !== "object")
            return false;
        const candidate = step;
        if ("parallel" in candidate) {
            return (Array.isArray(candidate.parallel) &&
                candidate.parallel.length > 0 &&
                candidate.parallel.every(isRunnerSubagentStepValue));
        }
        return isRunnerSubagentStepValue(step);
    });
}
function persistMissingRunPlanFailure(config) {
    const timestamp = Date.now();
    const mode = config.resultMode ?? "single";
    const status = {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        runId: config.id,
        ...(typeof config.sessionId === "string" ? { sessionId: config.sessionId } : {}),
        mode,
        state: "failed",
        error: ASYNC_RUNNER_MISSING_PLAN_ERROR,
        startedAt: timestamp,
        endedAt: timestamp,
        lastUpdate: timestamp,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
        ...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
        cwd: config.cwd,
        currentStep: 0,
        chainStepCount: 0,
        parallelGroups: [],
        workflowGraph: config.workflowGraph,
        steps: [],
        ...(config.tkTicket ? { tkTicket: config.tkTicket } : {}),
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        sessionDir: config.sessionDir,
        outputFile: path.join(config.asyncDir, "output-0.log"),
    };
    fs.mkdirSync(config.asyncDir, { recursive: true });
    writeNormalizedLifecycleStatus(config.asyncDir, status);
    writeAtomicJson(config.resultPath, {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        id: config.id,
        agent: "subagent",
        mode,
        success: false,
        state: "failed",
        summary: ASYNC_RUNNER_MISSING_PLAN_ERROR,
        error: ASYNC_RUNNER_MISSING_PLAN_ERROR,
        results: [],
        exitCode: 1,
        timestamp,
        durationMs: 0,
        asyncDir: config.asyncDir,
        ...(config.artifactsDir ? { artifactsDir: config.artifactsDir } : {}),
        cwd: config.cwd,
        sessionId: config.sessionId,
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        ...(config.taskIndex !== undefined ? { taskIndex: config.taskIndex } : {}),
        ...(config.totalTasks !== undefined ? { totalTasks: config.totalTasks } : {}),
    });
}
async function runSubagent(config) {
    const plan = isDirectRunPlanValue(config.plan) ? config.plan : undefined;
    const legacySteps = isLegacyRunStepsValue(config.steps) ? config.steps : undefined;
    if (!plan && !legacySteps) {
        persistMissingRunPlanFailure(config);
        throw new Error(ASYNC_RUNNER_MISSING_PLAN_ERROR);
    }
    return runSubagentWithInput(config, plan, legacySteps);
}
async function runSubagentWithInput(config, plan, legacySteps) {
    const { id, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig, } = config;
    const globalSemaphore = new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
    let previousOutput = "";
    const outputs = {};
    const results = [];
    const overallStartTime = Date.now();
    const shareEnabled = config.share === true;
    const asyncDir = config.asyncDir;
    let interruptRunner;
    const interruptSignalTrampoline = () => {
        interruptRunner?.();
    };
    process.on(ASYNC_INTERRUPT_SIGNAL, interruptSignalTrampoline);
    const statusPath = path.join(asyncDir, "status.json");
    const eventsPath = path.join(asyncDir, "events.jsonl");
    const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
    const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
    const activeChildInterrupts = new Map();
    const activeChildTimeouts = new Map();
    const pendingStepSteers = [];
    let interrupted = false;
    const terminalReason = {};
    let currentActivityState;
    let activityTimer;
    let timeoutTimer;
    let timedOut = false;
    const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
    const timeoutAbortController = new AbortController();
    const interruptAbortController = new AbortController();
    let previousCumulativeTokens = { input: 0, output: 0, total: 0 };
    let latestSessionFile;
    const executionPlans = plan
        ? [plan]
        : (legacySteps ?? []).map((step) => legacyStepToRunPlan(step));
    const initializeRun = () => {
        const flatSteps = plan
            ? plan.kind === "single"
                ? [plan.task]
                : plan.tasks
            : flattenSteps(legacySteps ?? []);
        for (const step of flatSteps) {
            step.contextPressure = parseContextPressureProjection(step.contextPressure);
            step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(step.contextPressureCrossedThresholds);
        }
        const initialFlatStepCount = flatSteps.length;
        const parallelGroups = [];
        const initialStatusSteps = [];
        let flatStepCount = 0;
        for (let stepIndex = 0; stepIndex < executionPlans.length; stepIndex++) {
            const step = executionPlans[stepIndex];
            if (step.kind === "parallel") {
                parallelGroups.push({ start: flatStepCount, count: step.tasks.length, stepIndex });
                for (const task of step.tasks) {
                    const taskFlatIndex = flatStepCount;
                    const transcriptPath = resolveAsyncStepTranscriptPath({
                        artifactsDir,
                        artifactConfig,
                        runId: id,
                        agent: task.agent,
                        flatIndex: taskFlatIndex,
                        flatStepCount: initialFlatStepCount,
                    });
                    initialStatusSteps.push({
                        agent: task.agent,
                        ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
                        phase: task.phase,
                        label: task.label,
                        outputName: task.outputName,
                        structured: task.structured,
                        status: "pending",
                        ...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
                        ...(task.timeoutMs !== undefined || config.timeoutMs !== undefined
                            ? { timeoutMs: task.timeoutMs ?? config.timeoutMs }
                            : {}),
                        ...(task.activeRuntimeMs !== undefined
                            ? { activeRuntimeMs: task.activeRuntimeMs }
                            : {}),
                        ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
                        ...(transcriptPath ? { transcriptPath } : {}),
                        skills: task.skills,
                        model: task.model,
                        thinking: task.thinking,
                        ...(task.modelIdentity ? { modelIdentity: task.modelIdentity } : {}),
                        ...(task.modelResolution ? { modelResolution: task.modelResolution } : {}),
                        ...projectInitialModelFallbackFilterNotice(task.modelFallbackFilterNotice),
                        ...(task.contextUsage ? { contextUsage: task.contextUsage } : {}),
                        ...(task.contextPressure ? { contextPressure: { ...task.contextPressure } } : {}),
                        ...(task.contextPressureCrossedThresholds
                            ? { contextPressureCrossedThresholds: [...task.contextPressureCrossedThresholds] }
                            : {}),
                        attemptedModels: task.modelCandidates && task.modelCandidates.length > 0
                            ? task.modelCandidates
                            : task.model
                                ? [task.model]
                                : undefined,
                        recentTools: [],
                        recentOutput: [],
                    });
                    flatStepCount++;
                }
            }
            else {
                const task = step.task;
                const stepFlatIndex = flatStepCount;
                const transcriptPath = resolveAsyncStepTranscriptPath({
                    artifactsDir,
                    artifactConfig,
                    runId: id,
                    agent: task.agent,
                    flatIndex: stepFlatIndex,
                    flatStepCount: initialFlatStepCount,
                });
                initialStatusSteps.push({
                    agent: task.agent,
                    ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
                    phase: task.phase,
                    label: task.label,
                    outputName: task.outputName,
                    structured: task.structured,
                    status: "pending",
                    ...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
                    ...(task.timeoutMs !== undefined || config.timeoutMs !== undefined
                        ? { timeoutMs: task.timeoutMs ?? config.timeoutMs }
                        : {}),
                    ...(task.activeRuntimeMs !== undefined ? { activeRuntimeMs: task.activeRuntimeMs } : {}),
                    ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
                    ...(transcriptPath ? { transcriptPath } : {}),
                    skills: task.skills,
                    model: task.model,
                    thinking: task.thinking,
                    ...(task.modelIdentity ? { modelIdentity: task.modelIdentity } : {}),
                    ...(task.modelResolution ? { modelResolution: task.modelResolution } : {}),
                    ...projectInitialModelFallbackFilterNotice(task.modelFallbackFilterNotice),
                    ...(task.contextUsage ? { contextUsage: task.contextUsage } : {}),
                    ...(task.contextPressure ? { contextPressure: { ...task.contextPressure } } : {}),
                    ...(task.contextPressureCrossedThresholds
                        ? { contextPressureCrossedThresholds: [...task.contextPressureCrossedThresholds] }
                        : {}),
                    attemptedModels: task.modelCandidates && task.modelCandidates.length > 0
                        ? task.modelCandidates
                        : task.model
                            ? [task.model]
                            : undefined,
                    recentTools: [],
                    recentOutput: [],
                });
                flatStepCount++;
            }
        }
        const sessionEnabled = Boolean(config.sessionDir) ||
            shareEnabled ||
            flatSteps.some((step) => Boolean(step.sessionFile));
        const statusPayload = {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            runId: id,
            ...(config.sessionId ? { sessionId: config.sessionId } : {}),
            mode: config.resultMode ??
                (plan?.kind === "parallel"
                    ? "parallel"
                    : plan?.kind === "single"
                        ? "single"
                        : flatSteps.length > 1
                            ? "chain"
                            : "single"),
            state: "running",
            lastActivityAt: overallStartTime,
            startedAt: overallStartTime,
            lastUpdate: overallStartTime,
            ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
            ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
            ...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
            pid: process.pid,
            cwd,
            currentStep: 0,
            chainStepCount: executionPlans.length,
            parallelGroups,
            workflowGraph: config.workflowGraph,
            steps: initialStatusSteps,
            ...(config.tkTicket ? { tkTicket: config.tkTicket } : {}),
            ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
            artifactsDir,
            sessionDir: config.sessionDir,
            outputFile: path.join(asyncDir, "output-0.log"),
        };
        fs.mkdirSync(asyncDir, { recursive: true });
        writeNormalizedLifecycleStatus(asyncDir, statusPayload);
        return { flatSteps, initialStatusSteps, sessionEnabled, statusPayload };
    };
    const { flatSteps, initialStatusSteps, sessionEnabled, statusPayload } = initializeRun();
    if (config.continuationSource) {
        const gate = finalizeLifecycleContinuationLaunch(config.continuationSource.asyncDir, config.continuationSource.index, config.continuationSource.claimToken, id);
        if (!gate.finalized) {
            statusPayload.state = "failed";
            statusPayload.pid = undefined;
            statusPayload.endedAt = Date.now();
            statusPayload.lastUpdate = statusPayload.endedAt;
            statusPayload.error = `Continuation launch gate rejected for source run '${config.continuationSource.runId}' child ${config.continuationSource.index}.`;
            statusPayload.steps = statusPayload.steps?.map((step, index) => index === 0
                ? {
                    ...step,
                    status: "failed",
                    endedAt: statusPayload.endedAt,
                    exitCode: 1,
                    terminationReason: step.terminationReason ?? "process_exit",
                    error: statusPayload.error,
                }
                : step);
            writeNormalizedLifecycleStatus(asyncDir, statusPayload);
            const gateRejectAgent = statusPayload.steps?.[0]?.agent ?? "subagent";
            try {
                writeAtomicJson(resultPath, {
                    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
                    id,
                    agent: gateRejectAgent,
                    mode: statusPayload.mode,
                    success: false,
                    state: "failed",
                    summary: statusPayload.error,
                    error: statusPayload.error,
                    results: [
                        {
                            agent: gateRejectAgent,
                            ...(statusPayload.steps?.[0]?.projectAgent
                                ? { projectAgent: statusPayload.steps[0].projectAgent }
                                : {}),
                            output: statusPayload.error,
                            error: statusPayload.error,
                            success: false,
                            exitCode: 1,
                        },
                    ],
                    exitCode: 1,
                    timestamp: statusPayload.endedAt,
                    durationMs: 0,
                    asyncDir,
                    sessionId: config.sessionId,
                    ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
                });
            }
            catch (err) {
                console.error(`Failed to write gate-rejection result file ${resultPath}:`, err);
            }
            return;
        }
    }
    const emitNestedSelfEvent = (type) => {
        if (!config.nestedRoute || !config.nestedSelf)
            return;
        try {
            writeNestedEvent(config.nestedRoute, {
                type,
                ts: Date.now(),
                parentRunId: config.nestedSelf.parentRunId,
                parentStepIndex: config.nestedSelf.parentStepIndex,
                child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
                    id,
                    parentRunId: config.nestedSelf.parentRunId,
                    parentStepIndex: config.nestedSelf.parentStepIndex,
                    depth: config.nestedSelf.depth,
                    path: config.nestedSelf.path,
                    mode: statusPayload.mode,
                    ts: Date.now(),
                }),
            });
        }
        catch (error) {
            console.error("Failed to emit nested async status event:", error);
        }
    };
    const refreshWorkflowGraph = () => {
        if (!config.workflowGraph)
            return;
        const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
        const normalize = (status) => {
            if (status === "complete" || status === "completed")
                return "completed";
            if (status === "running" ||
                status === "failed" ||
                status === "paused" ||
                status === "pending")
                return status;
            return "pending";
        };
        const updateNode = (node) => {
            if (node.flatIndex !== undefined) {
                const step = statusPayload.steps[node.flatIndex];
                if (step) {
                    node.status = normalize(step.status);
                    node.error = step.error;
                    node.acceptanceStatus = step.acceptance?.status;
                }
                if (statusPayload.currentStep === node.flatIndex)
                    graph.currentNodeId = node.id;
            }
            for (const child of node.children ?? [])
                updateNode(child);
            if (node.children?.length && node.status !== "paused" && node.status !== "failed") {
                if (node.children.every((child) => child.status === "completed"))
                    node.status = "completed";
                else if (node.children.some((child) => child.status === "running"))
                    node.status = "running";
                else if (node.children.some((child) => child.status === "failed"))
                    node.status = "failed";
                else if (node.children.some((child) => child.status === "paused"))
                    node.status = "paused";
            }
            if (node.error)
                node.status = "failed";
        };
        for (const node of graph.nodes)
            updateNode(node);
        statusPayload.workflowGraph = graph;
    };
    const listTrackedSessionFiles = (sessionDir) => {
        if (!sessionDir)
            return [];
        try {
            return fs
                .readdirSync(sessionDir)
                .filter((name) => name.endsWith(".jsonl"))
                .map((name) => path.resolve(sessionDir, name));
        }
        catch {
            return [];
        }
    };
    const beginTrackedSessionStep = (flatIndex, sessionDir, sessionFile) => {
        trackedStepSessions[flatIndex] = {
            sessionDir,
            baselineSessionFiles: new Set(listTrackedSessionFiles(sessionDir)),
            ...(sessionFile ? { discoveredSessionFile: path.resolve(sessionFile) } : {}),
        };
    };
    const trackedStepSessions = initialStatusSteps.map((step) => step.sessionFile
        ? {
            sessionDir: path.dirname(step.sessionFile),
            baselineSessionFiles: new Set(listTrackedSessionFiles(path.dirname(step.sessionFile))),
            discoveredSessionFile: path.resolve(step.sessionFile),
        }
        : undefined);
    const refreshTrackedSessionFile = (flatIndex) => {
        const step = statusPayload.steps[flatIndex];
        const tracked = trackedStepSessions[flatIndex];
        if (!step || !tracked?.sessionDir)
            return step?.sessionFile;
        const latestDiscovered = findLatestSessionFile(tracked.sessionDir) ?? undefined;
        if (latestDiscovered) {
            const resolvedLatest = path.resolve(latestDiscovered);
            if (!tracked.baselineSessionFiles.has(resolvedLatest))
                tracked.discoveredSessionFile = resolvedLatest;
        }
        if (tracked.discoveredSessionFile && !step.sessionFile)
            step.sessionFile = tracked.discoveredSessionFile;
        if (tracked.discoveredSessionFile)
            latestSessionFile = tracked.discoveredSessionFile;
        if (!statusPayload.sessionFile) {
            statusPayload.sessionFile =
                statusPayload.steps.length === 1
                    ? (step.sessionFile ?? latestSessionFile)
                    : latestSessionFile;
        }
        return step.sessionFile ?? tracked.discoveredSessionFile;
    };
    const resolveTrackedSessionFile = (flatIndex, fallback) => {
        if (fallback) {
            const tracked = trackedStepSessions[flatIndex];
            if (tracked)
                tracked.discoveredSessionFile = path.resolve(fallback);
            return fallback;
        }
        const current = statusPayload.steps[flatIndex]?.sessionFile;
        if (current)
            return current;
        return refreshTrackedSessionFile(flatIndex);
    };
    const writeStatusPayload = () => {
        if (statusPayload.currentStep !== undefined)
            refreshTrackedSessionFile(statusPayload.currentStep);
        refreshWorkflowGraph();
        if (concurrentTerminalStatusAdopted || (interrupted && pausedCheckpointCommitted)) {
            const merged = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
            if (TERMINAL_RUN_STATES.has(merged.state) && merged.state !== statusPayload.state) {
                adoptConcurrentTerminalStatus();
            }
            else {
                statusPayload.lifecycle = merged.lifecycle;
            }
        }
        else {
            writeNormalizedLifecycleStatus(asyncDir, statusPayload);
        }
        emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued"
            ? "subagent.nested.updated"
            : "subagent.nested.completed");
    };
    const onChildProtocolOutputLimit = (limit) => {
        if (concurrentTerminalStatusAdopted ||
            statusPayload.state !== "running" ||
            timedOut ||
            interrupted)
            return;
        if (!claimChildTerminalReason(terminalReason, "output_limit"))
            return;
        const now = Date.now();
        const message = boundChildError(formatProtocolOutputLimit(limit));
        statusPayload.state = "failed";
        statusPayload.activityState = undefined;
        statusPayload.error = message;
        statusPayload.lastUpdate = now;
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.child.protocol_output_limit",
            ts: now,
            runId: id,
            stream: limit.stream,
            limitBytes: limit.limitBytes,
            observedBytes: limit.observedBytes,
        }));
        writeStatusPayload();
    };
    const registerStepInterrupt = (flatIndex, interrupt) => {
        if (!interrupt) {
            activeChildInterrupts.delete(flatIndex);
            return;
        }
        activeChildInterrupts.set(flatIndex, interrupt);
        if (interrupted)
            interrupt();
    };
    const registerStepTimeout = (flatIndex, interrupt) => {
        if (!interrupt) {
            activeChildTimeouts.delete(flatIndex);
            return;
        }
        activeChildTimeouts.set(flatIndex, interrupt);
        if (timedOut)
            interrupt();
    };
    const interruptActiveChildren = () => {
        for (const interrupt of Array.from(activeChildInterrupts.values()))
            interrupt();
    };
    const timeoutActiveChildren = () => {
        for (const interrupt of Array.from(activeChildTimeouts.values()))
            interrupt();
    };
    const nestedRuns = function* (children) {
        for (const child of children ?? []) {
            yield child;
            yield* nestedRuns(child.children);
            yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
        }
    };
    const interruptNestedAsyncDescendants = () => {
        if (!config.nestedRoute)
            return;
        let registry;
        try {
            registry = projectNestedEvents(config.nestedRoute);
        }
        catch (error) {
            appendJsonl(eventsPath, JSON.stringify({
                type: "subagent.nested.interrupt_failed",
                ts: Date.now(),
                runId: id,
                message: error instanceof Error ? error.message : String(error),
            }));
            return;
        }
        for (const run of nestedRuns(registry.children)) {
            if (run.state !== "running" && run.state !== "queued")
                continue;
            const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
            if (!nestedAsyncDir)
                continue;
            try {
                deliverInterruptRequest({
                    asyncDir: nestedAsyncDir,
                    pid: run.pid,
                    source: "ancestor-interrupt",
                });
            }
            catch (error) {
                appendJsonl(eventsPath, JSON.stringify({
                    type: "subagent.nested.interrupt_failed",
                    ts: Date.now(),
                    runId: id,
                    targetRunId: run.id,
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    };
    const timeoutNestedAsyncDescendants = () => {
        if (!config.nestedRoute)
            return;
        let registry;
        try {
            registry = projectNestedEvents(config.nestedRoute);
        }
        catch (error) {
            appendJsonl(eventsPath, JSON.stringify({
                type: "subagent.nested.timeout_failed",
                ts: Date.now(),
                runId: id,
                message: error instanceof Error ? error.message : String(error),
            }));
            return;
        }
        for (const run of nestedRuns(registry.children)) {
            if (run.state !== "running" && run.state !== "queued")
                continue;
            const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
            if (!nestedAsyncDir)
                continue;
            try {
                deliverTimeoutRequest({
                    asyncDir: nestedAsyncDir,
                    pid: run.pid,
                    source: "ancestor-timeout",
                });
            }
            catch (error) {
                appendJsonl(eventsPath, JSON.stringify({
                    type: "subagent.nested.timeout_failed",
                    ts: Date.now(),
                    runId: id,
                    targetRunId: run.id,
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    };
    const pausedAcceptanceLedger = (acceptance) => acceptance
        ? buildSkippedAcceptanceLedger({
            acceptance,
            ledgerStatus: "skipped",
            runtimeCheckStatus: "not-applicable",
            id: "paused",
            message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
        })
        : undefined;
    const pausedStepResult = (task) => ({
        agent: task.agent,
        ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
        output: "Paused after interrupt. Waiting for explicit next action.",
        exitCode: 0,
        interrupted: true,
        terminationReason: "paused",
        model: task.model,
        modelIdentity: task.modelIdentity,
        modelResolution: task.modelResolution,
        acceptance: pausedAcceptanceLedger(task.effectiveAcceptance),
    });
    const timedOutStepResult = (task) => ({
        agent: task.agent,
        ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
        output: timeoutMessage ?? "Subagent timed out.",
        error: timeoutMessage ?? "Subagent timed out.",
        exitCode: 1,
        timedOut: true,
        terminationReason: "timed_out",
        model: task.model,
        modelIdentity: task.modelIdentity,
        modelResolution: task.modelResolution,
    });
    let supervisorPauseRequest;
    let supervisorPauseTransitionFailed = false;
    let durablePausingCheckpointPersisted = false;
    let concurrentTerminalStatusAdopted = false;
    let pausedCheckpointCommitted = false;
    const pauseMetadataForIndex = (index, pausedAt) => {
        if (!supervisorPauseRequest)
            return undefined;
        if (index === supervisorPauseRequest.requesterIndex) {
            return {
                ...supervisorPauseRequest.pause,
                ...(pausedAt !== undefined ? { pausedAt, ownerPid: undefined } : {}),
            };
        }
        return {
            kind: "cohort_pause",
            summary: "Paused because another child in this cohort is awaiting supervisor.",
            requestedAt: supervisorPauseRequest.requestedAt,
            ...(pausedAt !== undefined ? { pausedAt } : { ownerPid: process.pid }),
        };
    };
    const adoptConcurrentTerminalStatus = () => {
        const persisted = readStatus(asyncDir);
        if (!persisted || persisted.state === "running" || persisted.state === "pausing")
            return undefined;
        Object.assign(statusPayload, persisted);
        interrupted = persisted.state === "paused";
        if (persisted.state === "paused")
            pausedCheckpointCommitted = true;
        concurrentTerminalStatusAdopted = true;
        return persisted;
    };
    const requestSupervisorPause = (requesterIndex, pause) => {
        if (supervisorPauseRequest || interrupted || timedOut || statusPayload.state !== "running")
            return;
        if (!claimChildTerminalReason(terminalReason, "paused"))
            return;
        supervisorPauseRequest = {
            requesterIndex,
            pause: { ...pause, ownerPid: process.pid },
            requestedAt: pause.requestedAt ?? Date.now(),
        };
        const now = Date.now();
        const requesterSessionFile = refreshTrackedSessionFile(requesterIndex);
        try {
            const transition = transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(statusPayload),
                mutate: (status) => ({
                    ...status,
                    state: "pausing",
                    pid: process.pid,
                    pause: { ...supervisorPauseRequest.pause, ownerPid: process.pid },
                    currentStep: requesterIndex,
                    currentTool: undefined,
                    currentToolStartedAt: undefined,
                    currentPath: undefined,
                    activityState: undefined,
                    lastUpdate: now,
                    sessionFile: requesterSessionFile ?? status.sessionFile,
                    steps: status.steps?.map((step, index) => {
                        if (step.status !== "running")
                            return step;
                        const stepSessionFile = refreshTrackedSessionFile(index);
                        const activeRuntimeMs = (step.activeRuntimeMs ?? 0) +
                            (step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0);
                        return {
                            ...step,
                            status: "pausing",
                            activeRuntimeMs,
                            activityState: undefined,
                            interruptRequestedAt: now,
                            ...(stepSessionFile ? { sessionFile: stepSessionFile } : {}),
                            ...(index === requesterIndex
                                ? { pause: { ...supervisorPauseRequest.pause, ownerPid: process.pid } }
                                : { pause: pauseMetadataForIndex(index) }),
                            acceptance: step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[index]),
                        };
                    }),
                }),
            });
            Object.assign(statusPayload, transition.status);
            supervisorPauseTransitionFailed = false;
            durablePausingCheckpointPersisted = true;
            pausedCheckpointCommitted = true;
        }
        catch {
            supervisorPauseTransitionFailed = !adoptConcurrentTerminalStatus();
        }
        interrupted = true;
        currentActivityState = undefined;
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.run.pausing",
            ts: now,
            runId: id,
            stepIndex: requesterIndex,
            pause: {
                kind: supervisorPauseRequest.pause.kind,
                summary: supervisorPauseRequest.pause.summary,
                request: supervisorPauseRequest.pause.request,
            },
        }));
        interruptNestedAsyncDescendants();
        interruptAbortController.abort();
        interruptActiveChildren();
    };
    const pausedOutputForIndex = (index, agent) => supervisorPauseRequest && index === supervisorPauseRequest.requesterIndex
        ? formatForegroundSupervisorPauseMessage({
            headline: `Async run ${id} paused awaiting supervisor (${agent}).`,
            runId: id,
            agent,
            requestSummary: supervisorPauseRequest.pause.summary,
        })
        : "Paused because another child in this cohort is awaiting supervisor.";
    const hasLiveNestedAsyncDescendants = () => {
        if (!config.nestedRoute)
            return false;
        try {
            return [...nestedRuns(projectNestedEvents(config.nestedRoute).children)].some((run) => run.state === "running" || run.state === "queued");
        }
        catch {
            return true;
        }
    };
    const waitForNestedAsyncDescendantsToStop = async (timeoutMs = 2_000, pollMs = 50) => {
        if (!config.nestedRoute)
            return true;
        const deadline = Date.now() + timeoutMs;
        while (true) {
            if (!hasLiveNestedAsyncDescendants())
                return true;
            if (Date.now() >= deadline)
                return false;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
    };
    const ownedPauseProcessesConfirmedStopped = () => statusPayload.steps.every((step) => {
        if (step.status !== "pausing" && step.status !== "paused")
            return true;
        if (!step.startedAt)
            return true;
        return step.processCleanup?.terminated === true;
    });
    const isPersistedAwaitingSupervisorPause = (status) => {
        if (!status || !supervisorPauseRequest)
            return false;
        const requester = status.steps[supervisorPauseRequest.requesterIndex];
        return (status.state === "paused" &&
            status.pid === undefined &&
            status.pause?.kind === "awaiting_supervisor" &&
            status.pause?.ownerPid === undefined &&
            requester?.status === "paused" &&
            requester.pause?.kind === "awaiting_supervisor" &&
            requester.pause?.ownerPid === undefined);
    };
    const applyPausedStepMetadata = (flatIndex, endedAt) => {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        const sessionFile = refreshTrackedSessionFile(flatIndex);
        if (sessionFile)
            step.sessionFile = sessionFile;
        step.pause = pauseMetadataForIndex(flatIndex, endedAt);
        step.acceptance = step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
        step.interruptRequestedAt = supervisorPauseRequest?.requestedAt ?? step.interruptRequestedAt;
    };
    const stepOutputActivityAt = (index) => {
        const step = statusPayload.steps[index];
        let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
        const outputPath = path.join(asyncDir, `output-${index}.log`);
        try {
            lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`Failed to inspect async output file '${outputPath}':`, error);
            }
        }
        return lastActivityAt;
    };
    const emittedControlEventKeys = new Set();
    const activeLongRunningSteps = new Set();
    const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
    const runtimeModelContexts = initialStatusSteps.map(() => undefined);
    const activeConfiguredModels = initialStatusSteps.map(() => undefined);
    const pendingToolResults = initialStatusSteps.map(() => undefined);
    const flatStepAcceptances = flatSteps.map((step) => step.effectiveAcceptance);
    const mutatingFailureWindowMs = 5 * 60_000;
    const appendControlEvent = (event) => {
        if (!controlConfig.enabled)
            return;
        const channels = controlConfig.notifyChannels;
        if (channels.length === 0 ||
            !claimControlNotification(controlConfig, event, emittedControlEventKeys))
            return;
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.control",
            event,
            channels,
            noticeText: formatControlNoticeMessage(event),
        }));
    };
    const syncTopLevelCurrentTool = () => {
        const activeStep = statusPayload.steps
            .filter((step) => step.status === "running" &&
            typeof step.currentTool === "string" &&
            step.currentTool.length > 0)
            .sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
        statusPayload.currentTool = activeStep?.currentTool;
        statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
        statusPayload.currentPath = activeStep?.currentPath;
    };
    const maybeEmitActiveLongRunning = (flatIndex, now) => {
        if (!controlConfig.enabled || activeLongRunningSteps.has(flatIndex))
            return false;
        const step = statusPayload.steps[flatIndex];
        if (!step || step.status !== "running" || step.activityState === "needs_attention")
            return false;
        const reason = nextLongRunningTrigger(controlConfig, {
            startedAt: step.startedAt ?? overallStartTime,
            now,
            turns: step.turnCount ?? 0,
            tokens: step.tokens?.total ?? 0,
        });
        if (!reason)
            return false;
        activeLongRunningSteps.add(flatIndex);
        const previous = step.activityState;
        step.activityState = "active_long_running";
        statusPayload.activityState =
            statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
        const event = buildControlEvent({
            type: "active_long_running",
            from: previous,
            to: "active_long_running",
            runId: id,
            agent: step.agent,
            index: flatIndex,
            ts: now,
            message: `${step.agent} is still active but long-running`,
            reason,
            turns: step.turnCount,
            tokens: step.tokens?.total,
            toolCount: step.toolCount,
            currentTool: step.currentTool,
            currentToolDurationMs: step.currentToolStartedAt
                ? Math.max(0, now - step.currentToolStartedAt)
                : undefined,
            currentPath: step.currentPath,
            elapsedMs: now - (step.startedAt ?? overallStartTime),
        });
        appendControlEvent(event);
        return true;
    };
    const deliverChildMessageRequest = (request) => {
        const now = Date.now();
        if (statusPayload.state !== "running") {
            writeChildMessageAcceptanceForRequest(asyncDir, request, {
                status: "rejected",
                ts: now,
                acceptedIndexes: [],
                reason: `run is ${statusPayload.state}`,
            });
            return;
        }
        const { acceptedIndexes: accepted, rejected } = acceptChildMessageRequest({
            request,
            steps: statusPayload.steps,
            enqueue: (index, childRequest) => enqueueStepChildMessage(asyncDir, index, childRequest),
            now: () => now,
        });
        if (request.type === "steer") {
            for (const index of accepted) {
                const step = statusPayload.steps[index];
                step.steerCount = (step.steerCount ?? 0) + 1;
                step.lastSteerAt = now;
            }
        }
        if (accepted.length > 0) {
            if (request.type === "steer") {
                statusPayload.steerCount = (statusPayload.steerCount ?? 0) + accepted.length;
                statusPayload.lastSteerAt = now;
            }
            statusPayload.lastUpdate = now;
            writeStatusPayload();
        }
        writeChildMessageAcceptanceForRequest(asyncDir, request, {
            status: accepted.length > 0 ? "accepted" : "rejected",
            ts: now,
            acceptedIndexes: accepted,
            ...(rejected.length ? { rejected } : {}),
            ...(accepted.length === 0
                ? { reason: rejected[0]?.reason ?? "no running child accepted the request" }
                : {}),
        });
        appendJsonl(eventsPath, JSON.stringify({
            type: request.type === "resume" ? "subagent.resume.requested" : "subagent.steer.requested",
            ts: now,
            runId: id,
            requestId: request.id,
            message: request.message,
            ...(request.source ? { source: request.source } : {}),
            ...(request.targetIndex !== undefined ? { targetIndex: request.targetIndex } : {}),
            acceptedIndexes: accepted,
            ...(rejected.length ? { rejected } : {}),
        }));
    };
    const flushPendingStepSteers = (flatIndex) => {
        const remaining = [];
        for (const request of pendingStepSteers.splice(0)) {
            if (request.targetIndex === undefined)
                deliverChildMessageRequest({ ...request, targetIndex: flatIndex });
            else if (request.targetIndex === flatIndex)
                deliverChildMessageRequest(request);
            else
                remaining.push(request);
        }
        pendingStepSteers.push(...remaining);
    };
    const updateStepModel = (flatIndex, attempt, now = Date.now()) => {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        runtimeModelContexts[flatIndex] = undefined;
        activeConfiguredModels[flatIndex] = attempt.model;
        step.model = attempt.model;
        step.thinking = attempt.modelIdentity ? attempt.modelIdentity.thinking : attempt.thinking;
        step.modelIdentity =
            attempt.modelIdentity ?? canonicalSubagentModelIdentity(attempt.model, attempt.thinking);
        if (attempt.modelResolution)
            step.modelResolution = attempt.modelResolution;
        if (attempt.attemptedModels && attempt.attemptedModels.length > 0)
            step.attemptedModels = attempt.attemptedModels;
        if (attempt.modelAttempts && attempt.modelAttempts.length > 0)
            step.modelAttempts = attempt.modelAttempts;
        statusPayload.lastUpdate = now;
        writeStatusPayload();
    };
    const updateStepFromChildEvent = (flatIndex, event) => {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        const now = Date.now();
        statusPayload.currentStep = flatIndex;
        if (event.type === "tool_execution_start" && event.toolName) {
            const supervisorPause = resolveSupervisorPauseMetadata({
                toolName: event.toolName,
                toolArgs: event.args,
                requestedAt: now,
            });
            if (supervisorPause?.kind === "awaiting_supervisor") {
                requestSupervisorPause(flatIndex, supervisorPause);
            }
            const mutates = isMutatingTool(event.toolName, event.args);
            const currentPath = resolveCurrentPath(event.toolName, event.args);
            step.toolCount = (step.toolCount ?? 0) + 1;
            const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
            if (configuredToolBudget) {
                step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
                statusPayload.toolBudget = step.toolBudget;
            }
            step.currentTool = event.toolName;
            step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
            step.currentToolStartedAt = now;
            step.currentPath = currentPath;
            pendingToolResults[flatIndex] = {
                tool: event.toolName,
                path: currentPath,
                mutates,
                startedAt: now,
            };
            statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
            syncTopLevelCurrentTool();
        }
        else if (event.type === "tool_execution_end") {
            if (step.currentTool) {
                step.recentTools ??= [];
                appendRecentProgressItem(step.recentTools, {
                    tool: step.currentTool,
                    args: step.currentToolArgs || "",
                    endMs: now,
                });
            }
            step.currentTool = undefined;
            step.currentToolArgs = undefined;
            step.currentToolStartedAt = undefined;
            step.currentPath = undefined;
            syncTopLevelCurrentTool();
        }
        else if (event.type === "tool_result_end" && event.message) {
            const toolSnapshot = pendingToolResults[flatIndex];
            pendingToolResults[flatIndex] = undefined;
            const resultText = extractTextFromContent(event.message.content);
            if (toolSnapshot && resultText.includes("Tool budget hard limit reached")) {
                const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
                if (configuredToolBudget) {
                    step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount ?? 0, toolSnapshot.tool);
                    step.toolBudgetBlocked = true;
                    statusPayload.toolBudget = step.toolBudget;
                    statusPayload.toolBudgetBlocked = true;
                }
            }
            appendRecentStepOutput(step, resultText.split("\n").slice(-10));
            if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
                const state = mutatingFailureStates[flatIndex];
                recordMutatingFailure(state, {
                    tool: toolSnapshot.tool,
                    path: toolSnapshot.path,
                    error: resultText
                        .split("\n")
                        .find((line) => line.trim())
                        ?.trim()
                        .slice(0, 180) ?? "mutating tool failed",
                    ts: now,
                }, mutatingFailureWindowMs);
                if (controlConfig.enabled &&
                    shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) &&
                    step.activityState !== "needs_attention") {
                    const previous = step.activityState;
                    step.activityState = "needs_attention";
                    statusPayload.activityState = "needs_attention";
                    appendControlEvent(buildControlEvent({
                        type: "needs_attention",
                        from: previous,
                        to: "needs_attention",
                        runId: id,
                        agent: step.agent,
                        index: flatIndex,
                        ts: now,
                        message: `${step.agent} needs attention after repeated mutating tool failures`,
                        reason: "tool_failures",
                        turns: step.turnCount,
                        tokens: step.tokens?.total,
                        toolCount: step.toolCount,
                        currentTool: toolSnapshot.tool,
                        currentToolDurationMs: toolSnapshot.startedAt
                            ? Math.max(0, now - toolSnapshot.startedAt)
                            : undefined,
                        currentPath: toolSnapshot.path,
                        recentFailureSummary: summarizeRecentMutatingFailures(state),
                    }));
                }
            }
            else if (toolSnapshot?.mutates) {
                resetMutatingFailureState(mutatingFailureStates[flatIndex]);
            }
        }
        else if (event.type === "message_end" && event.message?.role === "assistant") {
            appendRecentStepOutput(step, parseAndStripAcceptanceReport(extractTextFromContent(event.message.content))
                .stripped.split("\n")
                .slice(-10));
            step.turnCount = (step.turnCount ?? 0) + 1;
            const configuredModel = activeConfiguredModels[flatIndex];
            const configuredContextWindow = contextWindowForModel(configuredModel, flatSteps[flatIndex]?.contextWindows);
            let runtimeModelContext = runtimeModelContexts[flatIndex];
            if (!configuredModel && runtimeModelContext === undefined) {
                runtimeModelContext = resolveRuntimeModelContext(event.message.provider, event.message.model, flatSteps[flatIndex]?.contextWindows);
                if (runtimeModelContext) {
                    runtimeModelContexts[flatIndex] = runtimeModelContext;
                    step.model = runtimeModelReference(runtimeModelContext.identity);
                    step.thinking = runtimeModelContext.identity.thinking;
                    step.modelIdentity = runtimeModelContext.identity;
                }
            }
            step.contextUsage = updateContextUsageDiagnostics(step.contextUsage, event.message, {
                restored: false,
                contextWindow: configuredContextWindow ?? runtimeModelContext?.contextWindow,
            });
            statusPayload.steps[flatIndex].contextUsage = step.contextUsage;
            statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
                step.contextPressureCrossedThresholds;
            while (true) {
                const pressure = detectContextPressureCrossing(step.contextUsage, step.contextPressureCrossedThresholds ?? [], now);
                if (!pressure)
                    break;
                step.contextPressureCrossedThresholds = [
                    ...(step.contextPressureCrossedThresholds ?? []),
                    pressure.crossedThreshold,
                ];
                flatSteps[flatIndex].contextPressureCrossedThresholds =
                    step.contextPressureCrossedThresholds;
                flatSteps[flatIndex].contextPressure = pressure;
                statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
                    step.contextPressureCrossedThresholds;
                statusPayload.steps[flatIndex].contextPressure = pressure;
                statusPayload.lastUpdate = now;
                writeStatusPayload();
                if (controlConfig.enabled) {
                    const previousActivityState = step.activityState;
                    step.activityState = "needs_attention";
                    statusPayload.activityState = "needs_attention";
                    appendControlEvent(buildControlEvent({
                        type: "needs_attention",
                        from: previousActivityState,
                        to: "needs_attention",
                        runId: id,
                        agent: step.agent,
                        index: flatIndex,
                        ts: now,
                        message: formatContextPressureGuidance(pressure),
                        contextPressureSeverity: pressure.severity,
                        contextPressureThreshold: pressure.crossedThreshold,
                        reason: "context_pressure",
                        turns: step.turnCount,
                        tokens: step.tokens?.total,
                        toolCount: step.toolCount,
                    }));
                }
            }
            const usage = event.message.usage;
            if (usage) {
                const input = childUsageNumber(usage, "input", "inputTokens");
                const output = childUsageNumber(usage, "output", "outputTokens");
                const previousInput = step.tokens?.input ?? 0;
                const previousOutput = step.tokens?.output ?? 0;
                step.tokens = {
                    input: previousInput + input,
                    output: previousOutput + output,
                    total: previousInput + previousOutput + input + output,
                };
                const totalInput = statusPayload.totalTokens?.input ?? 0;
                const totalOutput = statusPayload.totalTokens?.output ?? 0;
                statusPayload.totalTokens = {
                    input: totalInput + input,
                    output: totalOutput + output,
                    total: totalInput + totalOutput + input + output,
                };
            }
            statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
        }
        syncTopLevelCurrentTool();
        step.lastActivityAt = now;
        statusPayload.lastActivityAt = now;
        statusPayload.lastUpdate = now;
        maybeEmitActiveLongRunning(flatIndex, now);
        writeStatusPayload();
    };
    const updateRunnerActivityState = (now) => {
        if (!controlConfig.enabled)
            return false;
        let changed = false;
        let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
        for (let index = 0; index < statusPayload.steps.length; index++) {
            const step = statusPayload.steps[index];
            if (step.status !== "running")
                continue;
            const lastActivityAt = stepOutputActivityAt(index);
            runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
            if (step.lastActivityAt !== lastActivityAt) {
                step.lastActivityAt = lastActivityAt;
                changed = true;
            }
            const idleState = deriveActivityState({
                config: controlConfig,
                startedAt: step.startedAt ?? overallStartTime,
                lastActivityAt,
                toolCallInFlight: Boolean(step.currentTool),
                now,
            });
            if (idleState === "needs_attention") {
                const previous = step.activityState;
                step.activityState = "needs_attention";
                if (previous !== "needs_attention") {
                    appendControlEvent(buildControlEvent({
                        from: previous,
                        to: "needs_attention",
                        runId: id,
                        agent: step.agent,
                        index,
                        ts: now,
                        lastActivityAt,
                    }));
                    changed = true;
                }
            }
            else if (maybeEmitActiveLongRunning(index, now)) {
                changed = true;
            }
        }
        if (statusPayload.lastActivityAt !== runLastActivityAt) {
            statusPayload.lastActivityAt = runLastActivityAt;
            changed = true;
        }
        const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
            ? "needs_attention"
            : statusPayload.steps.some((step) => step.activityState === "active_long_running")
                ? "active_long_running"
                : undefined;
        if (nextRunState !== currentActivityState) {
            currentActivityState = nextRunState;
            statusPayload.activityState = nextRunState;
            changed = true;
        }
        statusPayload.lastUpdate = now;
        if (changed)
            writeStatusPayload();
        return changed;
    };
    if (controlConfig.enabled) {
        activityTimer = setInterval(() => {
            if (statusPayload.state !== "running")
                return;
            const now = Date.now();
            updateRunnerActivityState(now);
        }, 1000);
        activityTimer.unref?.();
    }
    interruptRunner = () => {
        consumeInterruptRequest(asyncDir);
        if (interrupted || statusPayload.state !== "running")
            return;
        if (!claimChildTerminalReason(terminalReason, "interrupted"))
            return;
        interrupted = true;
        const now = Date.now();
        statusPayload.state = "paused";
        currentActivityState = undefined;
        statusPayload.activityState = undefined;
        statusPayload.lastUpdate = now;
        for (let flatIndex = 0; flatIndex < statusPayload.steps.length; flatIndex++) {
            const step = statusPayload.steps[flatIndex];
            if (step.status === "running") {
                step.status = "paused";
                step.activityState = undefined;
                step.endedAt = now;
                step.durationMs = step.startedAt ? now - step.startedAt : undefined;
                step.lastActivityAt = now;
                if (!step.acceptance)
                    step.acceptance = pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
                refreshTrackedSessionFile(flatIndex);
            }
        }
        writeStatusPayload();
        pausedCheckpointCommitted = true;
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.run.paused",
            ts: now,
            runId: id,
        }));
        interruptNestedAsyncDescendants();
        interruptAbortController.abort();
        interruptActiveChildren();
    };
    const timeoutRunner = () => {
        if (timedOut || interrupted || statusPayload.state !== "running")
            return;
        if (!claimChildTerminalReason(terminalReason, "timed_out"))
            return;
        timedOut = true;
        const now = Date.now();
        const message = timeoutMessage ?? "Subagent timed out.";
        statusPayload.state = "failed";
        statusPayload.timedOut = true;
        statusPayload.error = message;
        currentActivityState = undefined;
        statusPayload.activityState = undefined;
        statusPayload.lastUpdate = now;
        for (const step of statusPayload.steps) {
            if (step.status !== "running" && step.status !== "pending")
                continue;
            step.status = "failed";
            step.error = message;
            step.exitCode = 1;
            step.timedOut = true;
            step.terminationReason = "timed_out";
            step.activityState = undefined;
            step.endedAt = now;
            step.durationMs = step.startedAt ? now - step.startedAt : 0;
            step.lastActivityAt = now;
        }
        writeStatusPayload();
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.run.timed_out",
            ts: now,
            runId: id,
            timeoutMs: config.timeoutMs,
            deadlineAt: config.deadlineAt,
            message,
        }));
        timeoutAbortController.abort();
        timeoutNestedAsyncDescendants();
        timeoutActiveChildren();
    };
    const disposeControlInbox = watchAsyncControlInbox(asyncDir, {
        onInterrupt: interruptRunner,
        onTimeout: timeoutRunner,
        onSteer: (request) => {
            const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
            if (targetStep?.status === "pending")
                pendingStepSteers.push(request);
            else if (request.targetIndex !== undefined ||
                statusPayload.steps.some((step) => step.status === "running"))
                deliverChildMessageRequest(request);
            else
                pendingStepSteers.push(request);
        },
        onResume: (request) => {
            const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
            if (targetStep?.status === "pending")
                pendingStepSteers.push(request);
            else if (request.targetIndex !== undefined ||
                statusPayload.steps.some((step) => step.status === "running"))
                deliverChildMessageRequest(request);
            else
                pendingStepSteers.push(request);
        },
    });
    if (config.deadlineAt !== undefined) {
        timeoutTimer = scheduleDeadline(config.deadlineAt, timeoutRunner);
    }
    appendJsonl(eventsPath, JSON.stringify({
        type: "subagent.run.started",
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        ts: overallStartTime,
        runId: id,
        mode: statusPayload.mode,
        cwd,
        pid: process.pid,
    }));
    let flatIndex = 0;
    let stepCursor = 0;
    const settleParallelGroup = (group, parallelResults, groupStartFlatIndex, stepIndex) => {
        for (let t = 0; t < group.tasks.length; t++) {
            const fi = groupStartFlatIndex + t;
            const sessionTokens = config.sessionDir
                ? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
                : null;
            const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
            if (!taskTokens)
                continue;
            statusPayload.steps[fi].tokens = taskTokens;
            previousCumulativeTokens = {
                input: previousCumulativeTokens.input + taskTokens.input,
                output: previousCumulativeTokens.output + taskTokens.output,
                total: previousCumulativeTokens.total + taskTokens.total,
            };
        }
        statusPayload.totalTokens = { ...previousCumulativeTokens };
        statusPayload.lastUpdate = Date.now();
        writeStatusPayload();
        for (let t = 0; t < parallelResults.length; t++) {
            const pr = parallelResults[t];
            const fi = groupStartFlatIndex + t;
            results.push({
                agent: pr.agent,
                ...(pr.projectAgent ? { projectAgent: pr.projectAgent } : {}),
                output: pr.interrupted ? pausedOutputForIndex(fi, pr.agent) : pr.output,
                error: pr.error,
                stderr: pr.stderr,
                stderrTruncated: pr.stderrTruncated,
                protocolOutputLimit: pr.protocolOutputLimit,
                success: pr.interrupted !== true && pr.exitCode === 0,
                exitCode: pr.interrupted === true ? 0 : pr.exitCode,
                exitSignal: pr.exitSignal,
                skipped: pr.skipped,
                interrupted: pr.interrupted,
                timedOut: pr.timedOut,
                toolBudget: pr.toolBudget,
                toolBudgetBlocked: pr.toolBudgetBlocked,
                contextUsage: pr.contextUsage,
                contextPressure: pr.contextPressure,
                contextPressureCrossedThresholds: pr.contextPressureCrossedThresholds,
                terminationReason: pr.terminationReason,
                sessionFile: resolveTrackedSessionFile(fi, pr.sessionFile),
                model: pr.model,
                modelIdentity: pr.modelIdentity,
                modelResolution: pr.modelResolution,
                attemptedModels: pr.attemptedModels,
                modelAttempts: pr.modelAttempts,
                modelFallbackNotice: pr.modelFallbackNotice,
                totalCost: pr.totalCost,
                artifactPaths: pr.artifactPaths,
                processCleanup: pr.processCleanup,
                transcriptPath: pr.transcriptPath,
                transcriptError: pr.transcriptError,
                structuredOutput: pr.structuredOutput,
                structuredOutputPath: pr.structuredOutputPath,
                structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
                acceptance: pr.acceptance,
                pause: pr.interrupted
                    ? pauseMetadataForIndex(fi, statusPayload.steps[fi]?.endedAt)
                    : undefined,
                activeRuntimeMs: pr.activeRuntimeMs,
            });
        }
        for (let t = 0; t < group.tasks.length; t++) {
            const outputName = group.tasks[t]?.outputName;
            if (outputName)
                outputs[outputName] = outputEntryFromAsyncResult({
                    agent: parallelResults[t].agent,
                    output: parallelResults[t].output,
                    structuredOutput: parallelResults[t].structuredOutput,
                }, stepIndex);
        }
        statusPayload.outputs = outputs;
        previousOutput = aggregateParallelOutputs(parallelResults.map((r) => ({
            agent: r.agent,
            output: r.output,
            exitCode: r.exitCode,
            error: r.error,
            model: r.model,
            attemptedModels: r.attemptedModels,
        })));
    };
    const settleSequentialStep = (seqStep, stepIndex, stepStartTime, singleResult) => {
        const resolvedSeqSessionFile = resolveTrackedSessionFile(flatIndex, singleResult.sessionFile ?? seqStep.sessionFile);
        if (resolvedSeqSessionFile) {
            statusPayload.steps[flatIndex].sessionFile = resolvedSeqSessionFile;
            latestSessionFile = resolvedSeqSessionFile;
        }
        previousOutput = singleResult.output;
        results.push({
            agent: singleResult.agent,
            ...(singleResult.projectAgent ? { projectAgent: singleResult.projectAgent } : {}),
            output: timedOut
                ? (timeoutMessage ?? "Subagent timed out.")
                : singleResult.interrupted
                    ? pausedOutputForIndex(flatIndex, singleResult.agent)
                    : singleResult.output,
            error: timedOut
                ? boundChildError(timeoutMessage ?? "Subagent timed out.")
                : singleResult.error,
            stderr: singleResult.stderr,
            stderrTruncated: singleResult.stderrTruncated,
            protocolOutputLimit: singleResult.protocolOutputLimit,
            success: !timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
            exitCode: timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
            exitSignal: singleResult.exitSignal,
            sessionFile: resolvedSeqSessionFile,
            model: singleResult.model,
            modelIdentity: singleResult.modelIdentity,
            modelResolution: singleResult.modelResolution,
            attemptedModels: singleResult.attemptedModels,
            modelAttempts: singleResult.modelAttempts,
            modelFallbackNotice: singleResult.modelFallbackNotice,
            totalCost: singleResult.totalCost,
            artifactPaths: singleResult.artifactPaths,
            processCleanup: singleResult.processCleanup,
            transcriptPath: singleResult.transcriptPath,
            transcriptError: singleResult.transcriptError,
            structuredOutput: singleResult.structuredOutput,
            structuredOutputPath: singleResult.structuredOutputPath,
            structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
            acceptance: singleResult.acceptance,
            pause: singleResult.interrupted ? pauseMetadataForIndex(flatIndex) : undefined,
            interrupted: singleResult.interrupted,
            timedOut: timedOut || singleResult.timedOut ? true : undefined,
            toolBudget: singleResult.toolBudget,
            toolBudgetBlocked: singleResult.toolBudgetBlocked,
            contextUsage: singleResult.contextUsage,
            contextPressure: singleResult.contextPressure,
            contextPressureCrossedThresholds: singleResult.contextPressureCrossedThresholds,
            terminationReason: singleResult.terminationReason,
            activeRuntimeMs: singleResult.activeRuntimeMs,
        });
        if (seqStep.outputName) {
            outputs[seqStep.outputName] = outputEntryFromAsyncResult({
                agent: singleResult.agent,
                output: singleResult.output,
                structuredOutput: singleResult.structuredOutput,
            }, stepIndex);
        }
        statusPayload.outputs = outputs;
        const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
        let stepTokens = cumulativeTokens
            ? {
                input: cumulativeTokens.input - previousCumulativeTokens.input,
                output: cumulativeTokens.output - previousCumulativeTokens.output,
                total: cumulativeTokens.total - previousCumulativeTokens.total,
            }
            : null;
        if (cumulativeTokens) {
            previousCumulativeTokens = cumulativeTokens;
        }
        else {
            stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
            if (stepTokens) {
                previousCumulativeTokens = {
                    input: previousCumulativeTokens.input + stepTokens.input,
                    output: previousCumulativeTokens.output + stepTokens.output,
                    total: previousCumulativeTokens.total + stepTokens.total,
                };
            }
        }
        const stepEndTime = Date.now();
        const childInterrupted = singleResult.interrupted === true;
        if (childInterrupted)
            interrupted = true;
        const priorStepStatus = statusPayload.steps[flatIndex].status;
        const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
        statusPayload.steps[flatIndex].status = timedOut
            ? "failed"
            : pausedStep
                ? "paused"
                : singleResult.exitCode === 0
                    ? "complete"
                    : "failed";
        statusPayload.steps[flatIndex].endedAt = stepEndTime;
        statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
        statusPayload.steps[flatIndex].activeRuntimeMs = singleResult.activeRuntimeMs;
        statusPayload.steps[flatIndex].exitCode = timedOut
            ? 1
            : childInterrupted
                ? 0
                : singleResult.exitCode;
        statusPayload.steps[flatIndex].exitSignal = singleResult.exitSignal;
        statusPayload.steps[flatIndex].timedOut = timedOut || singleResult.timedOut ? true : undefined;
        statusPayload.steps[flatIndex].processCleanup = singleResult.processCleanup;
        statusPayload.steps[flatIndex].toolBudget = singleResult.toolBudget;
        statusPayload.steps[flatIndex].toolBudgetBlocked = singleResult.toolBudgetBlocked;
        statusPayload.steps[flatIndex].contextUsage = singleResult.contextUsage;
        statusPayload.steps[flatIndex].contextPressure = singleResult.contextPressure;
        statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
            singleResult.contextPressureCrossedThresholds;
        statusPayload.steps[flatIndex].terminationReason = singleResult.terminationReason;
        if (singleResult.toolBudget)
            statusPayload.toolBudget = singleResult.toolBudget;
        if (singleResult.toolBudgetBlocked)
            statusPayload.toolBudgetBlocked = true;
        statusPayload.steps[flatIndex].model = singleResult.model;
        statusPayload.steps[flatIndex].thinking = singleResult.modelIdentity
            ? singleResult.modelIdentity.thinking
            : resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
        statusPayload.steps[flatIndex].modelIdentity = singleResult.modelIdentity;
        statusPayload.steps[flatIndex].modelResolution = singleResult.modelResolution;
        statusPayload.steps[flatIndex].modelFallbackNotice = singleResult.modelFallbackNotice;
        statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
        statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
        statusPayload.steps[flatIndex].totalCost = singleResult.totalCost;
        statusPayload.steps[flatIndex].error = timedOut
            ? boundChildError(timeoutMessage ?? "Subagent timed out.")
            : singleResult.error;
        statusPayload.steps[flatIndex].stderr = singleResult.stderr
            ? boundChildStderrError(singleResult.stderr, singleResult.stderrTruncated === true, MAX_CHILD_ERROR_BYTES)
            : undefined;
        statusPayload.steps[flatIndex].stderrTruncated = singleResult.stderrTruncated;
        statusPayload.steps[flatIndex].protocolOutputLimit = singleResult.protocolOutputLimit;
        statusPayload.steps[flatIndex].transcriptPath =
            singleResult.transcriptPath ?? statusPayload.steps[flatIndex].transcriptPath;
        statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
        statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
        statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
        statusPayload.steps[flatIndex].structuredOutputSchemaPath =
            singleResult.structuredOutputSchemaPath;
        statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
        if (pausedStep)
            applyPausedStepMetadata(flatIndex, stepEndTime);
        if (stepTokens) {
            statusPayload.steps[flatIndex].tokens = stepTokens;
            statusPayload.totalTokens = { ...previousCumulativeTokens };
        }
        statusPayload.lastUpdate = stepEndTime;
        writeStatusPayload();
        appendJsonl(eventsPath, JSON.stringify({
            type: timedOut
                ? "subagent.step.failed"
                : childInterrupted
                    ? "subagent.step.paused"
                    : singleResult.exitCode === 0
                        ? "subagent.step.completed"
                        : "subagent.step.failed",
            ts: stepEndTime,
            runId: id,
            stepIndex: flatIndex,
            agent: seqStep.agent,
            exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
            durationMs: stepEndTime - stepStartTime,
            tokens: stepTokens,
        }));
        if (singleResult.completionGuardTriggered) {
            const event = buildControlEvent({
                from: statusPayload.steps[flatIndex].activityState,
                to: "needs_attention",
                runId: id,
                agent: seqStep.agent,
                index: flatIndex,
                ts: stepEndTime,
                message: `${seqStep.agent} completed without making edits for an implementation task`,
                reason: "completion_guard",
            });
            appendControlEvent(event);
        }
    };
    while (true) {
        if (interrupted || timedOut || concurrentTerminalStatusAdopted)
            break;
        if (stepCursor >= executionPlans.length)
            break;
        const stepIndex = stepCursor++;
        const step = executionPlans[stepIndex];
        if (step.kind === "parallel") {
            const group = step;
            const tasks = group.tasks;
            const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
            const failFast = group.failFast ?? false;
            const groupStartFlatIndex = flatIndex;
            let aborted = false;
            const groupStartTime = Date.now();
            markParallelGroupRunning({
                statusPayload,
                tasks,
                groupStartFlatIndex,
                groupStartTime,
                statusPath,
                eventsPath,
                asyncDir,
                runId: id,
                stepIndex,
            });
            const parallelResults = await mapConcurrent(tasks, concurrency, async (task, taskIdx) => {
                const fi = groupStartFlatIndex + taskIdx;
                if (timedOut)
                    return timedOutStepResult(task);
                if (interrupted || concurrentTerminalStatusAdopted)
                    return pausedStepResult(task);
                if (aborted && failFast) {
                    const skippedAt = Date.now();
                    statusPayload.steps[fi].status = "failed";
                    statusPayload.steps[fi].error = "Skipped due to fail-fast";
                    statusPayload.steps[fi].terminationReason = "process_exit";
                    statusPayload.steps[fi].startedAt = skippedAt;
                    statusPayload.steps[fi].endedAt = skippedAt;
                    statusPayload.steps[fi].durationMs = 0;
                    statusPayload.steps[fi].exitCode = -1;
                    statusPayload.steps[fi].activityState = undefined;
                    statusPayload.lastUpdate = skippedAt;
                    writeStatusPayload();
                    appendJsonl(eventsPath, JSON.stringify({
                        type: "subagent.step.failed",
                        ts: skippedAt,
                        runId: id,
                        stepIndex: fi,
                        agent: task.agent,
                        exitCode: -1,
                        durationMs: 0,
                    }));
                    return {
                        agent: task.agent,
                        ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
                        output: "(skipped — fail-fast)",
                        exitCode: -1,
                        skipped: true,
                        terminationReason: "process_exit",
                        model: task.model,
                        modelIdentity: task.modelIdentity,
                        modelResolution: task.modelResolution,
                    };
                }
                const taskSessionDir = config.sessionDir
                    ? path.join(config.sessionDir, `parallel-${taskIdx}`)
                    : undefined;
                const taskStartTime = Date.now();
                const taskDeadlineAt = task.timeoutMs !== undefined ? taskStartTime + task.timeoutMs : config.deadlineAt;
                beginTrackedSessionStep(fi, task.sessionFile ? path.dirname(task.sessionFile) : taskSessionDir, task.sessionFile);
                statusPayload.currentStep = fi;
                statusPayload.steps[fi].status = "running";
                statusPayload.steps[fi].error = undefined;
                statusPayload.steps[fi].activityState = undefined;
                resetStepLiveDetail(statusPayload.steps[fi]);
                statusPayload.steps[fi].startedAt = taskStartTime;
                statusPayload.steps[fi].timeoutMs = task.timeoutMs ?? config.timeoutMs;
                statusPayload.steps[fi].deadlineAt = taskDeadlineAt;
                statusPayload.steps[fi].endedAt = undefined;
                statusPayload.steps[fi].durationMs = undefined;
                statusPayload.steps[fi].lastActivityAt = taskStartTime;
                statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
                statusPayload.lastActivityAt = taskStartTime;
                statusPayload.lastUpdate = taskStartTime;
                appendRecentStepOutput(statusPayload.steps[fi], task.attemptNotes ?? []);
                writeStatusPayload();
                appendJsonl(eventsPath, JSON.stringify({
                    type: "subagent.step.started",
                    ts: taskStartTime,
                    runId: id,
                    stepIndex: fi,
                    agent: task.agent,
                }));
                flushPendingStepSteers(fi);
                const singleResult = await runSingleStep(task, {
                    previousOutput,
                    placeholder,
                    cwd,
                    sessionEnabled,
                    outputs,
                    sessionDir: taskSessionDir,
                    artifactsDir,
                    artifactConfig,
                    id,
                    flatIndex: fi,
                    flatStepCount: Math.max(statusPayload.steps.length, 1),
                    outputFile: path.join(asyncDir, `output-${fi}.log`),
                    steerInboxDir: stepSteerInboxDir(asyncDir, fi),
                    piPackageRoot: config.piPackageRoot,
                    piArgv1: config.piArgv1,
                    nestedRoute: config.nestedRoute,
                    registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
                    registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
                    interruptSignal: interruptAbortController.signal,
                    interruptMessage: "Interrupted. Waiting for explicit next action.",
                    timeoutSignal: timeoutAbortController.signal,
                    timeoutMessage,
                    timeoutMs: task.timeoutMs ?? config.timeoutMs,
                    deadlineAt: taskDeadlineAt,
                    startedAt: taskStartTime,
                    onAttemptStart: (attempt) => updateStepModel(fi, attempt),
                    onChildEvent: (event) => updateStepFromChildEvent(fi, event),
                    onChildProtocolOutputLimit,
                    skipAcceptance: () => timedOut,
                });
                if (task.sessionFile) {
                    latestSessionFile = task.sessionFile;
                }
                const taskEndTime = Date.now();
                const taskDuration = taskEndTime - taskStartTime;
                const childInterrupted = singleResult.interrupted === true;
                if (childInterrupted)
                    interrupted = true;
                const priorStepStatus = statusPayload.steps[fi].status;
                const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
                statusPayload.steps[fi].status = timedOut
                    ? "failed"
                    : pausedStep
                        ? "paused"
                        : singleResult.exitCode === 0
                            ? "complete"
                            : "failed";
                statusPayload.steps[fi].endedAt = taskEndTime;
                statusPayload.steps[fi].durationMs = taskDuration;
                statusPayload.steps[fi].activeRuntimeMs = singleResult.activeRuntimeMs;
                statusPayload.steps[fi].exitCode = timedOut
                    ? 1
                    : childInterrupted
                        ? 0
                        : singleResult.exitCode;
                statusPayload.steps[fi].exitSignal = singleResult.exitSignal;
                statusPayload.steps[fi].timedOut = timedOut || singleResult.timedOut ? true : undefined;
                statusPayload.steps[fi].processCleanup = singleResult.processCleanup;
                statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
                statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
                statusPayload.steps[fi].contextUsage = singleResult.contextUsage;
                statusPayload.steps[fi].contextPressure = singleResult.contextPressure;
                statusPayload.steps[fi].contextPressureCrossedThresholds =
                    singleResult.contextPressureCrossedThresholds;
                statusPayload.steps[fi].terminationReason = singleResult.terminationReason;
                if (singleResult.toolBudget)
                    statusPayload.toolBudget = singleResult.toolBudget;
                if (singleResult.toolBudgetBlocked)
                    statusPayload.toolBudgetBlocked = true;
                statusPayload.steps[fi].model = singleResult.model;
                statusPayload.steps[fi].thinking = singleResult.modelIdentity
                    ? singleResult.modelIdentity.thinking
                    : resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
                statusPayload.steps[fi].modelIdentity = singleResult.modelIdentity;
                statusPayload.steps[fi].modelResolution = singleResult.modelResolution;
                statusPayload.steps[fi].modelFallbackNotice = singleResult.modelFallbackNotice;
                statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
                statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
                statusPayload.steps[fi].totalCost = singleResult.totalCost;
                statusPayload.steps[fi].error = timedOut
                    ? boundChildError(timeoutMessage ?? "Subagent timed out.")
                    : singleResult.error;
                statusPayload.steps[fi].stderr = singleResult.stderr
                    ? boundChildStderrError(singleResult.stderr, singleResult.stderrTruncated === true, MAX_CHILD_ERROR_BYTES)
                    : undefined;
                statusPayload.steps[fi].stderrTruncated = singleResult.stderrTruncated;
                statusPayload.steps[fi].protocolOutputLimit = singleResult.protocolOutputLimit;
                statusPayload.steps[fi].transcriptPath =
                    singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
                statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
                statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
                statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
                statusPayload.steps[fi].structuredOutputSchemaPath =
                    singleResult.structuredOutputSchemaPath;
                statusPayload.steps[fi].acceptance = singleResult.acceptance;
                if (pausedStep)
                    applyPausedStepMetadata(fi, taskEndTime);
                statusPayload.lastUpdate = taskEndTime;
                writeStatusPayload();
                appendJsonl(eventsPath, JSON.stringify({
                    type: timedOut
                        ? "subagent.step.failed"
                        : childInterrupted
                            ? "subagent.step.paused"
                            : singleResult.exitCode === 0
                                ? "subagent.step.completed"
                                : "subagent.step.failed",
                    ts: taskEndTime,
                    runId: id,
                    stepIndex: fi,
                    agent: task.agent,
                    exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
                    durationMs: taskDuration,
                }));
                if (singleResult.completionGuardTriggered) {
                    const event = buildControlEvent({
                        from: statusPayload.steps[fi].activityState,
                        to: "needs_attention",
                        runId: id,
                        agent: task.agent,
                        index: fi,
                        ts: taskEndTime,
                        message: `${task.agent} completed without making edits for an implementation task`,
                        reason: "completion_guard",
                    });
                    appendControlEvent(event);
                }
                if (singleResult.exitCode !== 0 && failFast)
                    aborted = true;
                return timedOut
                    ? {
                        ...singleResult,
                        output: timeoutMessage ?? "Subagent timed out.",
                        error: timeoutMessage ?? "Subagent timed out.",
                        exitCode: 1,
                        interrupted: false,
                        timedOut: true,
                        skipped: false,
                    }
                    : { ...singleResult, skipped: false };
            }, globalSemaphore);
            flatIndex += tasks.length;
            settleParallelGroup(group, parallelResults, groupStartFlatIndex, stepIndex);
            const parallelGroupInterrupted = interrupted || parallelResults.some((result) => result.interrupted === true);
            if (!parallelGroupInterrupted) {
                appendJsonl(eventsPath, JSON.stringify({
                    type: "subagent.parallel.completed",
                    ts: Date.now(),
                    runId: id,
                    stepIndex,
                    success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
                }));
            }
            if (parallelGroupInterrupted ||
                parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
                break;
            }
        }
        else {
            const seqStep = step.task;
            const stepStartTime = Date.now();
            const stepDeadlineAt = seqStep.timeoutMs !== undefined ? stepStartTime + seqStep.timeoutMs : config.deadlineAt;
            beginTrackedSessionStep(flatIndex, seqStep.sessionFile ? path.dirname(seqStep.sessionFile) : config.sessionDir, seqStep.sessionFile);
            statusPayload.currentStep = flatIndex;
            statusPayload.steps[flatIndex].status = "running";
            statusPayload.steps[flatIndex].activityState = undefined;
            statusPayload.activityState = undefined;
            resetStepLiveDetail(statusPayload.steps[flatIndex]);
            statusPayload.steps[flatIndex].skills = seqStep.skills;
            statusPayload.steps[flatIndex].startedAt = stepStartTime;
            statusPayload.steps[flatIndex].timeoutMs = seqStep.timeoutMs ?? config.timeoutMs;
            statusPayload.steps[flatIndex].deadlineAt = stepDeadlineAt;
            statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
            statusPayload.lastActivityAt = stepStartTime;
            statusPayload.lastUpdate = stepStartTime;
            statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
            appendRecentStepOutput(statusPayload.steps[flatIndex], seqStep.attemptNotes ?? []);
            writeStatusPayload();
            appendJsonl(eventsPath, JSON.stringify({
                type: "subagent.step.started",
                ts: stepStartTime,
                runId: id,
                stepIndex: flatIndex,
                agent: seqStep.agent,
            }));
            flushPendingStepSteers(flatIndex);
            const singleResult = await runSingleStep(seqStep, {
                previousOutput,
                placeholder,
                cwd,
                sessionEnabled,
                outputs,
                sessionDir: config.sessionDir,
                artifactsDir,
                artifactConfig,
                id,
                flatIndex,
                flatStepCount: Math.max(statusPayload.steps.length, 1),
                outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
                steerInboxDir: stepSteerInboxDir(asyncDir, flatIndex),
                piPackageRoot: config.piPackageRoot,
                piArgv1: config.piArgv1,
                nestedRoute: config.nestedRoute,
                registerInterrupt: (interrupt) => registerStepInterrupt(flatIndex, interrupt),
                registerTimeout: (interrupt) => registerStepTimeout(flatIndex, interrupt),
                interruptSignal: interruptAbortController.signal,
                interruptMessage: "Interrupted. Waiting for explicit next action.",
                timeoutSignal: timeoutAbortController.signal,
                timeoutMessage,
                timeoutMs: seqStep.timeoutMs ?? config.timeoutMs,
                deadlineAt: stepDeadlineAt,
                startedAt: stepStartTime,
                onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt),
                onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
                onChildProtocolOutputLimit,
                skipAcceptance: () => timedOut,
            });
            settleSequentialStep(seqStep, stepIndex, stepStartTime, singleResult);
            flatIndex++;
            if (singleResult.exitCode !== 0) {
                break;
            }
        }
    }
    let summary = results
        .map((r) => {
        const body = r.success ? r.output : formatErrorWithOutput(r.error, r.output);
        return `${r.agent}:\n${body}`;
    })
        .join("\n\n");
    let truncated = false;
    if (maxOutput) {
        const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
        const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
        const truncResult = truncateOutput(summary, config, lastArtifactPath);
        if (truncResult.truncated) {
            summary = truncResult.text;
            truncated = true;
        }
    }
    const resultMode = config.resultMode ?? statusPayload.mode;
    const totalCost = results.reduce((sum, result) => ({
        inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
        costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const finalTotalCost = totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0
        ? totalCost
        : undefined;
    const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
    const agentName = finalFlatAgents.length === 1
        ? finalFlatAgents[0]
        : resultMode === "parallel"
            ? `parallel:${finalFlatAgents.join("+")}`
            : `chain:${finalFlatAgents.join("->")}`;
    let sessionFile;
    let shareUrl;
    let gistUrl;
    let shareError;
    if (shareEnabled) {
        sessionFile = config.sessionDir
            ? (findLatestSessionFile(config.sessionDir) ?? undefined)
            : undefined;
        if (!sessionFile && latestSessionFile) {
            sessionFile = latestSessionFile;
        }
        if (sessionFile) {
            try {
                const exportDir = config.sessionDir ?? path.dirname(sessionFile);
                const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
                const share = createShareLink(htmlPath);
                if ("error" in share)
                    shareError = share.error;
                else {
                    shareUrl = share.shareUrl;
                    gistUrl = share.gistUrl;
                }
            }
            catch (err) {
                shareError = boundChildError(String(err));
            }
        }
        else {
            shareError = "Session file not found.";
        }
    }
    if (activityTimer)
        clearInterval(activityTimer);
    if (timeoutTimer)
        timeoutTimer.cancel();
    disposeControlInbox();
    const effectiveSessionFile = sessionFile ?? latestSessionFile;
    const runEndedAt = Date.now();
    let pausedAwaitingSupervisor;
    let safePausedResultAfterReap;
    let skipFinalStatusWrite = false;
    if (supervisorPauseRequest) {
        const nestedDescendantsStoppedBeforeFinalization = await waitForNestedAsyncDescendantsToStop();
        const ownedProcessesStoppedBeforeFinalization = ownedPauseProcessesConfirmedStopped();
        if (isPersistedAwaitingSupervisorPause(statusPayload) &&
            nestedDescendantsStoppedBeforeFinalization &&
            ownedProcessesStoppedBeforeFinalization) {
            pausedAwaitingSupervisor = {
                ...statusPayload.pause,
                pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
                ownerPid: undefined,
            };
        }
        else if (statusPayload.state === "pausing") {
            if (nestedDescendantsStoppedBeforeFinalization && ownedProcessesStoppedBeforeFinalization) {
                const pausedSessionFile = effectiveSessionFile ??
                    statusPayload.steps[supervisorPauseRequest.requesterIndex]?.sessionFile;
                try {
                    const transition = transitionLifecycleStatus({
                        asyncDir,
                        expectedGeneration: lifecycleGeneration(statusPayload),
                        mutate: (status) => ({
                            ...status,
                            state: "paused",
                            pid: undefined,
                            pause: {
                                ...supervisorPauseRequest.pause,
                                pausedAt: runEndedAt,
                                ownerPid: undefined,
                            },
                            activityState: undefined,
                            currentTool: undefined,
                            currentToolStartedAt: undefined,
                            currentPath: undefined,
                            endedAt: runEndedAt,
                            lastUpdate: runEndedAt,
                            sessionFile: pausedSessionFile ?? status.sessionFile,
                            totalCost: finalTotalCost,
                            shareUrl,
                            gistUrl,
                            shareError,
                            steps: status.steps?.map((step, index) => step.status === "pausing" || step.status === "paused"
                                ? {
                                    ...step,
                                    ...(refreshTrackedSessionFile(index)
                                        ? { sessionFile: refreshTrackedSessionFile(index) }
                                        : {}),
                                    status: "paused",
                                    exitCode: 0,
                                    terminationReason: "paused",
                                    exitSignal: undefined,
                                    activityState: undefined,
                                    endedAt: step.endedAt ?? runEndedAt,
                                    durationMs: step.startedAt
                                        ? (step.endedAt ?? runEndedAt) - step.startedAt
                                        : step.durationMs,
                                    pause: pauseMetadataForIndex(index, runEndedAt),
                                    acceptance: step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[index]),
                                }
                                : step),
                        }),
                    });
                    Object.assign(statusPayload, transition.status);
                }
                catch {
                    adoptConcurrentTerminalStatus();
                }
                const nestedDescendantsStoppedAfterFinalization = await waitForNestedAsyncDescendantsToStop();
                const ownedProcessesStoppedAfterFinalization = ownedPauseProcessesConfirmedStopped();
                if (!concurrentTerminalStatusAdopted &&
                    nestedDescendantsStoppedAfterFinalization &&
                    ownedProcessesStoppedAfterFinalization &&
                    durablePausingCheckpointPersisted &&
                    !supervisorPauseTransitionFailed) {
                    safePausedResultAfterReap = {
                        ...(statusPayload.pause ?? supervisorPauseRequest.pause),
                        pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
                        ownerPid: undefined,
                    };
                    if (isPersistedAwaitingSupervisorPause(statusPayload))
                        pausedAwaitingSupervisor = safePausedResultAfterReap;
                }
                else if (!concurrentTerminalStatusAdopted) {
                    supervisorPauseTransitionFailed = true;
                    skipFinalStatusWrite = true;
                }
            }
            else if (!adoptConcurrentTerminalStatus()) {
                supervisorPauseTransitionFailed = true;
                skipFinalStatusWrite = true;
            }
        }
        else if (!adoptConcurrentTerminalStatus()) {
            supervisorPauseTransitionFailed = true;
        }
        if (!pausedAwaitingSupervisor &&
            supervisorPauseTransitionFailed &&
            !concurrentTerminalStatusAdopted) {
            skipFinalStatusWrite = false;
            statusPayload.state = "failed";
            statusPayload.pid = undefined;
            statusPayload.pause = undefined;
            statusPayload.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            statusPayload.steps = statusPayload.steps.map((step) => step.status === "pausing" || step.status === "paused"
                ? {
                    ...step,
                    status: "failed",
                    pause: undefined,
                    terminationReason: step.terminationReason ?? "process_exit",
                    error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
                }
                : step);
            summary = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            for (const result of results) {
                if (result.interrupted ||
                    result.pause?.kind === "awaiting_supervisor" ||
                    result.pause?.kind === "cohort_pause") {
                    result.output = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
                    result.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
                    result.success = false;
                    result.exitCode = 1;
                    result.terminationReason = result.terminationReason ?? "process_exit";
                    result.interrupted = undefined;
                    result.pause = undefined;
                }
            }
            if (results.length === 0) {
                results.push({
                    agent: statusPayload.steps[supervisorPauseRequest.requesterIndex]?.agent ?? agentName,
                    ...(statusPayload.steps[supervisorPauseRequest.requesterIndex]?.projectAgent
                        ? {
                            projectAgent: statusPayload.steps[supervisorPauseRequest.requesterIndex].projectAgent,
                        }
                        : {}),
                    output: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
                    error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
                    success: false,
                    exitCode: 1,
                    terminationReason: "process_exit",
                });
            }
        }
    }
    const persistTerminalRun = () => {
        if (!pausedAwaitingSupervisor && !skipFinalStatusWrite && !concurrentTerminalStatusAdopted) {
            statusPayload.state =
                terminalReason.reason === "output_limit"
                    ? "failed"
                    : supervisorPauseTransitionFailed
                        ? "failed"
                        : timedOut
                            ? "failed"
                            : interrupted
                                ? "paused"
                                : results.every((r) => r.success)
                                    ? "complete"
                                    : "failed";
            statusPayload.activityState = undefined;
            if (timedOut) {
                statusPayload.timedOut = true;
                statusPayload.error = timeoutMessage ?? "Subagent timed out.";
            }
            if (supervisorPauseTransitionFailed && statusPayload.state === "failed") {
                statusPayload.error = statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            }
            statusPayload.endedAt = runEndedAt;
            statusPayload.lastUpdate = runEndedAt;
            statusPayload.sessionFile = effectiveSessionFile;
            statusPayload.totalCost = finalTotalCost;
            statusPayload.shareUrl = shareUrl;
            statusPayload.gistUrl = gistUrl;
            statusPayload.shareError = shareError;
            if (statusPayload.state === "failed" && !statusPayload.error) {
                const failedStep = statusPayload.steps.find((s) => s.status === "failed");
                if (failedStep?.agent) {
                    statusPayload.error = failedStep.error ?? `Step failed: ${failedStep.agent}`;
                }
            }
            writeStatusPayload();
        }
        if (pausedAwaitingSupervisor)
            emitNestedSelfEvent("subagent.nested.completed");
        appendJsonl(eventsPath, JSON.stringify({
            type: "subagent.run.completed",
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            ts: runEndedAt,
            runId: id,
            status: statusPayload.state,
            durationMs: runEndedAt - overallStartTime,
            totalTokens: statusPayload.totalTokens,
            totalCost: finalTotalCost,
        }));
        writeRunLog(logPath, {
            id,
            mode: statusPayload.mode,
            cwd,
            startedAt: overallStartTime,
            endedAt: runEndedAt,
            steps: statusPayload.steps.map((step) => ({
                agent: step.agent,
                status: step.status,
                durationMs: step.durationMs,
                processCleanup: step.processCleanup,
            })),
            summary,
            truncated,
            artifactsDir,
            sessionFile: effectiveSessionFile,
            shareUrl,
            shareError,
        });
        const resultPausedAwaitingSupervisor = pausedAwaitingSupervisor ??
            (safePausedResultAfterReap &&
                !supervisorPauseTransitionFailed &&
                !concurrentTerminalStatusAdopted
                ? safePausedResultAfterReap
                : undefined);
        const resultState = concurrentTerminalStatusAdopted
            ? statusPayload.state
            : terminalReason.reason === "output_limit"
                ? "failed"
                : timedOut
                    ? "failed"
                    : resultPausedAwaitingSupervisor
                        ? "paused"
                        : supervisorPauseTransitionFailed
                            ? "failed"
                            : statusPayload.state === "failed" ||
                                statusPayload.state === "paused" ||
                                statusPayload.state === "cancelled" ||
                                statusPayload.state === "continued"
                                ? statusPayload.state
                                : interrupted
                                    ? "paused"
                                    : results.every((r) => r.success)
                                        ? "complete"
                                        : "failed";
        const resultSuccess = resultState === "complete";
        const resultSummary = !concurrentTerminalStatusAdopted && timedOut
            ? (timeoutMessage ?? "Subagent timed out.")
            : resultPausedAwaitingSupervisor
                ? pausedOutputForIndex(supervisorPauseRequest?.requesterIndex ?? 0, statusPayload.steps[supervisorPauseRequest?.requesterIndex ?? 0]?.agent ?? agentName)
                : resultState === "failed"
                    ? (statusPayload.error ??
                        (supervisorPauseTransitionFailed
                            ? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE
                            : summary))
                    : resultState === "paused"
                        ? "Paused after interrupt. Waiting for explicit next action."
                        : summary;
        try {
            writeAtomicJson(resultPath, {
                lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
                id,
                agent: agentName,
                mode: resultMode,
                success: resultSuccess,
                state: resultState,
                summary: resultSummary,
                ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
                ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
                ...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
                ...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
                ...(!concurrentTerminalStatusAdopted && timedOut
                    ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." }
                    : resultState === "failed"
                        ? { error: statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE }
                        : {}),
                ...(resultPausedAwaitingSupervisor ? { pause: resultPausedAwaitingSupervisor } : {}),
                results: results.map((r) => ({
                    agent: r.agent,
                    ...(r.projectAgent ? { projectAgent: r.projectAgent } : {}),
                    output: r.output,
                    error: r.error,
                    stderr: r.stderr,
                    stderrTruncated: r.stderrTruncated,
                    protocolOutputLimit: r.protocolOutputLimit,
                    success: r.success,
                    exitCode: r.exitCode,
                    exitSignal: r.exitSignal,
                    skipped: r.skipped || undefined,
                    interrupted: r.interrupted || undefined,
                    timedOut: r.timedOut || undefined,
                    toolBudget: r.toolBudget,
                    toolBudgetBlocked: r.toolBudgetBlocked || undefined,
                    contextUsage: r.contextUsage,
                    contextPressure: r.contextPressure,
                    contextPressureCrossedThresholds: r.contextPressureCrossedThresholds,
                    terminationReason: r.terminationReason,
                    sessionFile: r.sessionFile,
                    model: r.model,
                    modelIdentity: r.modelIdentity,
                    modelResolution: r.modelResolution,
                    attemptedModels: r.attemptedModels,
                    modelAttempts: r.modelAttempts,
                    modelFallbackNotice: r.modelFallbackNotice,
                    totalCost: r.totalCost,
                    artifactPaths: r.artifactPaths,
                    processCleanup: r.processCleanup,
                    truncated: r.truncated,
                    transcriptPath: r.transcriptPath,
                    transcriptError: r.transcriptError,
                    structuredOutput: r.structuredOutput,
                    structuredOutputPath: r.structuredOutputPath,
                    structuredOutputSchemaPath: r.structuredOutputSchemaPath,
                    acceptance: r.acceptance,
                    pause: r.pause,
                    activeRuntimeMs: r.activeRuntimeMs,
                })),
                outputs,
                workflowGraph: statusPayload.workflowGraph,
                exitCode: resultState === "failed" ? 1 : 0,
                timestamp: runEndedAt,
                durationMs: runEndedAt - overallStartTime,
                totalTokens: statusPayload.totalTokens,
                totalCost: finalTotalCost,
                truncated,
                artifactsDir,
                cwd,
                asyncDir,
                sessionId: config.sessionId,
                ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
                sessionFile: effectiveSessionFile,
                shareUrl,
                gistUrl,
                shareError,
                ...(taskIndex !== undefined && { taskIndex }),
                ...(totalTasks !== undefined && { totalTasks }),
            });
        }
        catch (err) {
            console.error(`Failed to write result file ${resultPath}:`, err);
        }
    };
    persistTerminalRun();
}
const configArg = process.argv[2];
if (configArg) {
    try {
        const configJson = fs.readFileSync(configArg, "utf-8");
        const config = JSON.parse(configJson);
        try {
            fs.unlinkSync(configArg);
        }
        catch {
        }
        runSubagent(config).catch((runErr) => {
            console.error("Subagent runner error:", runErr);
            process.exit(1);
        });
    }
    catch (err) {
        console.error("Subagent runner error:", err);
        process.exit(1);
    }
}
else {
    let input = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
        input += chunk;
    });
    process.stdin.on("end", () => {
        try {
            const config = JSON.parse(input);
            runSubagent(config).catch((runErr) => {
                console.error("Subagent runner error:", runErr);
                process.exit(1);
            });
        }
        catch (err) {
            console.error("Subagent runner error:", err);
            process.exit(1);
        }
    });
}
