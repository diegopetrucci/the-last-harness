// Generated from extensions/subagents/src/runs/background/subagent-runner.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { releaseWorkspaceReservationsForRun } from "../shared/workspace-reservation.js";
import { stepSteerInboxDir } from "./control-channel.js";
import { resolveArtifactConfig } from "../../shared/artifacts.js";
import { DEFAULT_MAX_OUTPUT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, truncateOutput, } from "../../shared/types.js";
import { DEFAULT_CONTROL_CONFIG } from "../shared/subagent-control.js";
import { mapConcurrent, MAX_PARALLEL_CONCURRENCY, DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore, } from "../shared/parallel-utils.js";
import { boundChildError, boundChildStderrError, MAX_CHILD_ERROR_BYTES, } from "../shared/child-protocol.js";
import { scheduleDeadline } from "../shared/deadline-timer.js";
import { formatErrorWithOutput } from "../../shared/utils.js";
import { parseSessionTokens } from "../../shared/session-tokens.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { formatOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.js";
import { persistedTicketId, TICKET_LOOKUP_MAX_OUTPUT_BYTES } from "../shared/ticket-context.js";
import { advanceLifecycleContinuation, isCompletedLifecycleStepState, lifecycleGeneration, transitionLifecycleStatus, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { formatSupervisorPauseMessage } from "../../shared/pause-messages.js";
import { retiredNestedLaunchError } from "../shared/pi-args.js";
import { boundedActiveRuntimeMs, createActiveRuntimeTracker, normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, } from "../shared/active-runtime.js";
import { ensureKillCleanup, runSingleStep, saturatingStepDeadlineAt, } from "./single-step-execution.js";
import { appendUnexpectedLifecycleTransitionDiagnostic, createBackgroundRunStatusOwner, } from "./run-status-owner.js";
import { finalizeSubagentRunTelemetry, normalizeSubagentRunTelemetry, } from "../../shared/telemetry.js";
import { createBackgroundRunControlOwner } from "./run-control-owner.js";
import { terminalResultForStatusStep } from "../../shared/terminal-result.js";
import { appendDiagnosticJsonl, appendJsonl } from "./runner-event-log.js";
import { ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE, applyCancelledStatusStepProjection, applyCancelledStepProjection, isPausedStepStatus, normalizeFailedSupervisorPauseResults, preservedCancellationStepStatus, } from "./cancellation-projection.js";
import { buildPausedRunnerTelemetry, persistContinuationGateRejection, persistRunnerTerminalRun, } from "./terminal-persistence.js";
const ASYNC_INTERRUPT_SIGNAL = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
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
function resetStepLiveDetail(step) {
    step.currentTool = undefined;
    step.currentToolArgs = undefined;
    step.currentToolStartedAt = undefined;
    step.currentPath = undefined;
    step.recentTools = [];
    step.recentOutput = [];
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
function normalizeTimedOutStepResult(step, result, timeoutMessage) {
    if (!step?.timedOut && !result.timedOut)
        return result;
    return {
        ...result,
        interrupted: false,
        timedOut: true,
        exitCode: 1,
        error: step?.error ?? result.error ?? timeoutMessage ?? "Subagent timed out.",
        terminationReason: "timed_out",
    };
}
const ASYNC_RUNNER_MISSING_PLAN_ERROR = "Async runner config must include a valid direct plan.";
const ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR = "Async runner config contains unsupported structuredOutput or structuredOutputSchema task properties. Structured output contracts are retired; restart with a new direct single or parallel run without those properties.";
const ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR = "Async runner config contains retired timeoutMs execution control. Remove timeoutMs and restart with a new direct single or parallel run; per-role execution budgets are applied automatically.";
const ASYNC_RUNNER_INVALID_CONFIG_ERROR = "Async runner config is malformed.";
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function hasRetiredStructuredOutputProperty(value) {
    return (isRecord(value) &&
        (Object.hasOwn(value, "structuredOutput") || Object.hasOwn(value, "structuredOutputSchema")));
}
function hasRetiredTimeoutProperty(value) {
    return isRecord(value) && Object.hasOwn(value, "timeoutMs");
}
function hasRetiredRunTimeoutProperty(value) {
    if (!isRecord(value))
        return false;
    return hasRetiredTimeoutProperty(value) || hasRetiredTimeoutProperty(value.plan);
}
function isPositiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isRunnerSubagentStepValue(value) {
    if (!isRecord(value) || hasRetiredStructuredOutputProperty(value))
        return false;
    const ticketId = persistedTicketId(value.ticketId);
    if (Object.hasOwn(value, "ticketId") && ticketId !== value.ticketId)
        return false;
    if (Object.hasOwn(value, "ticketBody")) {
        if (typeof value.ticketBody !== "string" ||
            value.ticketId === undefined ||
            value.ticketBody.trim().length === 0 ||
            Buffer.byteLength(value.ticketBody, "utf8") > TICKET_LOOKUP_MAX_OUTPUT_BYTES)
            return false;
    }
    const hasTimeoutMs = Object.hasOwn(value, "timeoutMs");
    if (hasTimeoutMs && !isPositiveSafeInteger(value.timeoutMs))
        return false;
    if ((Object.hasOwn(value, "activeRuntimeMs") &&
        normalizeActiveRuntimeMs(value.activeRuntimeMs) === undefined) ||
        (Object.hasOwn(value, "activeRuntimeCheckpointAt") &&
            normalizeActiveRuntimeCheckpointAt(value.activeRuntimeCheckpointAt) === undefined))
        return false;
    if (Object.hasOwn(value, "timeoutOwner")) {
        if (value.timeoutOwner !== "role" && value.timeoutOwner !== "run")
            return false;
        if (!hasTimeoutMs || !isPositiveSafeInteger(value.timeoutMs))
            return false;
    }
    return typeof value.agent === "string" && typeof value.task === "string";
}
function isDirectRunPlanValue(value) {
    if (!isRecord(value))
        return false;
    if (value.kind === "single")
        return isRunnerSubagentStepValue(value.task);
    return (value.kind === "parallel" &&
        Array.isArray(value.tasks) &&
        value.tasks.length > 0 &&
        value.tasks.every(isRunnerSubagentStepValue));
}
function directRunPlanValidationError(value) {
    if (isRecord(value)) {
        if (hasRetiredTimeoutProperty(value))
            return ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR;
        if (value.kind === "single" && hasRetiredStructuredOutputProperty(value.task)) {
            return ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR;
        }
        if (value.kind === "parallel" &&
            Array.isArray(value.tasks) &&
            value.tasks.some(hasRetiredStructuredOutputProperty)) {
            return ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR;
        }
    }
    return ASYNC_RUNNER_MISSING_PLAN_ERROR;
}
function rejectedPlanMode(value) {
    if (isRecord(value) && (value.kind === "single" || value.kind === "parallel")) {
        return value.kind;
    }
    return "single";
}
function isRunnerConfigEnvelope(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.resultPath === "string" &&
        typeof value.cwd === "string" &&
        typeof value.asyncDir === "string");
}
function hasValidRunnerDeadlineAt(value) {
    return !Object.hasOwn(value, "deadlineAt") || isPositiveSafeInteger(value.deadlineAt);
}
function parseRunnerConfig(value) {
    const retiredNestedError = retiredNestedLaunchError(value);
    if (retiredNestedError)
        throw new Error(retiredNestedError);
    if (!isRunnerConfigEnvelope(value))
        throw new Error(ASYNC_RUNNER_INVALID_CONFIG_ERROR);
    return value;
}
function resolveRunnerTimeoutMessage(plan) {
    if (plan.kind === "single" &&
        plan.task.timeoutOwner === "role" &&
        plan.task.timeoutMs !== undefined) {
        return `Subagent timed out after ${plan.task.timeoutMs}ms.`;
    }
    return "Subagent exceeded the configured maximum execution time.";
}
function resolveStepDeadlineAt(stepStartedAt, stepTimeoutMs, runDeadlineAt) {
    const stepDeadlineAt = stepTimeoutMs !== undefined
        ? saturatingStepDeadlineAt(stepStartedAt, stepTimeoutMs)
        : undefined;
    if (stepDeadlineAt === undefined)
        return runDeadlineAt;
    if (runDeadlineAt === undefined)
        return stepDeadlineAt;
    return Math.min(stepDeadlineAt, runDeadlineAt);
}
function persistMissingRunPlanFailure(config, error = ASYNC_RUNNER_MISSING_PLAN_ERROR) {
    const timestamp = Date.now();
    const telemetry = finalizeSubagentRunTelemetry(normalizeSubagentRunTelemetry(config.telemetry), { state: "failed", terminationReason: "process_exit" }, timestamp);
    const mode = rejectedPlanMode(config.plan);
    const deadlineAt = isPositiveSafeInteger(config.deadlineAt) ? config.deadlineAt : undefined;
    const status = {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        runId: config.id,
        ...(typeof config.sessionId === "string" ? { sessionId: config.sessionId } : {}),
        mode,
        state: "failed",
        error,
        startedAt: timestamp,
        endedAt: timestamp,
        lastUpdate: timestamp,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        cwd: config.cwd,
        currentStep: 0,
        steps: [],
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        ...(telemetry ? { telemetry } : {}),
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
        generation: lifecycleGeneration(status),
        success: false,
        state: "failed",
        summary: error,
        error,
        results: [],
        exitCode: 1,
        timestamp,
        durationMs: 0,
        asyncDir: config.asyncDir,
        ...(config.artifactsDir ? { artifactsDir: config.artifactsDir } : {}),
        cwd: config.cwd,
        sessionId: config.sessionId,
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        ...(telemetry ? { telemetry } : {}),
        ...(config.taskIndex !== undefined ? { taskIndex: config.taskIndex } : {}),
        ...(config.totalTasks !== undefined ? { totalTasks: config.totalTasks } : {}),
    });
}
async function runSubagent(config) {
    const retiredNestedError = retiredNestedLaunchError(config);
    if (retiredNestedError)
        throw new Error(retiredNestedError);
    if (hasRetiredRunTimeoutProperty(config)) {
        persistMissingRunPlanFailure(config, ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR);
        throw new Error(ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR);
    }
    if (!hasValidRunnerDeadlineAt(config)) {
        persistMissingRunPlanFailure(config, ASYNC_RUNNER_INVALID_CONFIG_ERROR);
        throw new Error(ASYNC_RUNNER_INVALID_CONFIG_ERROR);
    }
    const plan = isDirectRunPlanValue(config.plan) ? config.plan : undefined;
    if (!plan) {
        const error = directRunPlanValidationError(config.plan);
        persistMissingRunPlanFailure(config, error);
        throw new Error(error);
    }
    const artifactConfig = resolveArtifactConfig(config.artifactConfig, { legacy: true });
    const telemetry = normalizeSubagentRunTelemetry(config.telemetry);
    const { timeoutMs: _legacyTimeoutMs, plan: _unvalidatedPlan, artifactConfig: _rawArtifactConfig, deadlineAt: _unvalidatedDeadlineAt, telemetry: _rawTelemetry, ...currentConfig } = config;
    return runSubagentWithInput({
        ...currentConfig,
        ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
        ...(telemetry ? { telemetry } : {}),
        plan,
        artifactConfig,
    }, plan);
}
async function runSubagentWithInput(config, plan) {
    const { id, resultPath, cwd, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } = config;
    const globalSemaphore = new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
    const results = [];
    const overallStartTime = Date.now();
    const asyncDir = config.asyncDir;
    let interruptRunner;
    const interruptSignalTrampoline = () => {
        interruptRunner?.();
    };
    process.on(ASYNC_INTERRUPT_SIGNAL, interruptSignalTrampoline);
    ensureKillCleanup();
    const eventsPath = path.join(asyncDir, "events.jsonl");
    const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
    const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
    const timeoutMessage = config.deadlineAt !== undefined ? resolveRunnerTimeoutMessage(plan) : undefined;
    const timeoutAbortController = new AbortController();
    const interruptAbortController = new AbortController();
    let previousCumulativeTokens = { input: 0, output: 0, total: 0 };
    const appendEvent = (line) => appendJsonl(eventsPath, line);
    const appendDiagnosticEvent = (line, droppedEventType) => appendDiagnosticJsonl(eventsPath, line, droppedEventType);
    const statusOwner = createBackgroundRunStatusOwner({
        id,
        asyncDir,
        cwd,
        plan,
        overallStartTime,
        artifactConfig,
        artifactsDir,
        sessionDir: config.sessionDir,
        sessionId: config.sessionId,
        deadlineAt: config.deadlineAt,
        projectAgents: config.projectAgents,
        ...(config.telemetry ? { telemetry: config.telemetry } : {}),
        timeoutMessage,
        appendEvent,
        appendDiagnosticEvent,
    });
    const { sessionEnabled, statusPayload } = statusOwner;
    const settleActiveRuntime = (index, result, at) => {
        const tracker = statusOwner.activeRuntimeTrackers.get(index);
        statusOwner.activeRuntimeTrackers.delete(index);
        const step = statusPayload.steps[index];
        if (!step)
            return;
        const settled = Math.max(normalizeActiveRuntimeMs(result.activeRuntimeMs) ?? 0, normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0, tracker?.finalize(at) ?? 0);
        result.activeRuntimeMs = settled;
        result.activeRuntimeCheckpointAt = at;
        step.activeRuntimeMs = settled;
        step.activeRuntimeCheckpointAt = Math.max(normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt) ?? 0, at);
        statusPayload.activeRuntimeMs = Math.max(normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs) ?? 0, statusPayload.steps.reduce((total, candidate) => total + (normalizeActiveRuntimeMs(candidate.activeRuntimeMs) ?? 0), 0));
        statusPayload.activeRuntimeCheckpointAt = Math.max(normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) ?? 0, at);
    };
    const controlOwner = createBackgroundRunControlOwner({
        status: statusOwner,
        id,
        asyncDir,
        overallStartTime,
        controlConfig,
        appendEvent,
    });
    const pausedOutputForIndex = (index, agent) => statusOwner.supervisorPauseRequest &&
        index === statusOwner.supervisorPauseRequest.requesterIndex
        ? formatSupervisorPauseMessage({
            headline: `Async run ${id} paused awaiting supervisor (${agent}).`,
            runId: id,
            agent,
            requestSummary: statusOwner.supervisorPauseRequest.pause.summary,
        })
        : "Paused because another child in this cohort is awaiting supervisor.";
    let timeoutTimer;
    statusOwner.setControlHooks({
        clearActivityState: controlOwner.clearActivityState,
        interruptActiveChildren: controlOwner.interruptActiveChildren,
        timeoutActiveChildren: controlOwner.timeoutActiveChildren,
        abortInterrupt: () => interruptAbortController.abort(),
        abortTimeout: () => timeoutAbortController.abort(),
    });
    const rejectContinuationLaunch = () => {
        const continuationSource = config.continuationSource;
        if (!continuationSource)
            return false;
        const gate = advanceLifecycleContinuation(continuationSource.asyncDir, continuationSource.index, continuationSource.claimToken, id, true);
        if (gate.changed || gate.done)
            return false;
        persistContinuationGateRejection({
            config,
            plan,
            statusPayload,
            asyncDir,
            resultPath,
            controlConfig,
            overallStartTime,
            sourceRunId: continuationSource.runId,
            sourceIndex: continuationSource.index,
        });
        return true;
    };
    if (rejectContinuationLaunch())
        return;
    interruptRunner = (request) => {
        if (request?.reason === "parent_abort")
            statusOwner.cancel();
        else
            statusOwner.interrupt();
    };
    const timeoutRunner = () => {
        statusOwner.timeout();
    };
    controlOwner.startActivityTimer();
    statusOwner.startHeartbeat();
    statusOwner.startRuntimeCheckpointTimer();
    const disposeControlInbox = controlOwner.watchControlInbox({
        onInterrupt: (request) => interruptRunner?.(request),
        onTimeout: timeoutRunner,
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
    const settleParallelResults = (group, parallelResults, groupStartFlatIndex) => {
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
        statusOwner.writeStatusPayload();
        for (let t = 0; t < parallelResults.length; t++) {
            const pr = parallelResults[t];
            const fi = groupStartFlatIndex + t;
            const prTimedOut = pr.timedOut === true || statusPayload.steps[fi]?.timedOut === true;
            const persistedStepStatus = statusPayload.steps[fi]?.status;
            const preservedTerminalStep = Boolean(preservedCancellationStepStatus(persistedStepStatus, true, null));
            const cancelProjection = statusOwner.cancelled && !preservedTerminalStep ? statusPayload.cancel : undefined;
            const projectedResult = {
                agent: pr.agent,
                ...(pr.projectAgent ? { projectAgent: pr.projectAgent } : {}),
                ticketId: pr.ticketId,
                output: cancelProjection
                    ? "Cancelled by parent abort."
                    : pr.interrupted && !prTimedOut
                        ? pausedOutputForIndex(fi, pr.agent)
                        : pr.output,
                finalOutput: pr.finalOutput,
                error: cancelProjection ? "Cancelled by parent abort." : pr.error,
                cancel: cancelProjection ?? pr.cancel,
                stderr: pr.stderr,
                stderrTruncated: pr.stderrTruncated,
                protocolOutputLimit: pr.protocolOutputLimit,
                success: !cancelProjection && !prTimedOut && pr.interrupted !== true && pr.exitCode === 0,
                exitCode: cancelProjection ? 1 : prTimedOut ? 1 : pr.interrupted === true ? 0 : pr.exitCode,
                exitSignal: pr.exitSignal,
                skipped: pr.skipped,
                interrupted: prTimedOut ? undefined : pr.interrupted,
                timedOut: prTimedOut ? true : pr.timedOut,
                timeoutOwner: statusPayload.steps[fi]?.timeoutOwner ?? group.tasks[t]?.timeoutOwner,
                activeRuntimeMs: pr.activeRuntimeMs,
                contextUsage: pr.contextUsage,
                contextPressure: pr.contextPressure,
                contextPressureCrossedThresholds: pr.contextPressureCrossedThresholds,
                terminationReason: cancelProjection
                    ? "cancelled"
                    : prTimedOut
                        ? "timed_out"
                        : pr.terminationReason,
                sessionFile: statusOwner.refreshTrackedSessionFile(fi, pr.sessionFile),
                model: pr.model,
                modelIdentity: pr.modelIdentity,
                modelResolution: pr.modelResolution,
                attemptedModels: pr.attemptedModels,
                modelAttempts: pr.modelAttempts,
                modelFallbackNotice: pr.modelFallbackNotice,
                totalCost: pr.totalCost,
                artifactPaths: pr.artifactPaths,
                processCleanup: pr.processCleanup,
                truncated: pr.truncated,
                transcriptPath: pr.transcriptPath,
                transcriptError: pr.transcriptError,
                skills: pr.skills,
                skillsWarning: pr.skillsWarning,
                outputMode: pr.outputMode,
                savedOutputPath: pr.savedOutputPath,
                outputReference: pr.outputReference,
                outputSaveError: pr.outputSaveError,
                pause: !cancelProjection && pr.interrupted && !prTimedOut
                    ? statusOwner.pauseMetadataForIndex(fi, statusPayload.steps[fi]?.endedAt)
                    : undefined,
                activityState: statusPayload.steps[fi]?.activityState,
                cwd: statusPayload.steps[fi]?.cwd,
                terminalResult: terminalResultForStatusStep(pr, cancelProjection
                    ? "cancelled"
                    : statusOwner.timedOut
                        ? "failed"
                        : (statusPayload.steps[fi]?.status ?? "failed")),
            };
            applyCancelledStepProjection(projectedResult, cancelProjection);
            results.push(projectedResult);
        }
    };
    const settleSingleStep = (seqStep, stepStartTime, singleResult) => {
        const resolvedSeqSessionFile = statusOwner.refreshTrackedSessionFile(flatIndex, singleResult.sessionFile ?? seqStep.sessionFile);
        if (resolvedSeqSessionFile) {
            statusPayload.steps[flatIndex].sessionFile = resolvedSeqSessionFile;
            statusOwner.latestSessionFile = resolvedSeqSessionFile;
        }
        singleResult = normalizeTimedOutStepResult(statusPayload.steps[flatIndex], singleResult, timeoutMessage);
        settleActiveRuntime(flatIndex, singleResult, Date.now());
        const stepTimedOut = statusPayload.steps[flatIndex]?.timedOut === true || singleResult.timedOut === true;
        const timeoutOutput = statusPayload.steps[flatIndex]?.error ??
            singleResult.error ??
            timeoutMessage ??
            "Subagent timed out.";
        const projectSingleStepResult = () => {
            const projectedResult = {
                agent: singleResult.agent,
                ...(singleResult.projectAgent ? { projectAgent: singleResult.projectAgent } : {}),
                ticketId: singleResult.ticketId,
                output: statusOwner.cancelled
                    ? "Cancelled by parent abort."
                    : stepTimedOut || statusOwner.timedOut
                        ? (timeoutOutput ?? timeoutMessage ?? "Subagent timed out.")
                        : singleResult.interrupted
                            ? pausedOutputForIndex(flatIndex, singleResult.agent)
                            : singleResult.output,
                finalOutput: singleResult.finalOutput,
                error: statusOwner.cancelled
                    ? "Cancelled by parent abort."
                    : stepTimedOut || statusOwner.timedOut
                        ? boundChildError(timeoutOutput ?? timeoutMessage ?? "Subagent timed out.")
                        : singleResult.error,
                cancel: statusOwner.cancelled ? statusPayload.cancel : singleResult.cancel,
                stderr: singleResult.stderr,
                stderrTruncated: singleResult.stderrTruncated,
                protocolOutputLimit: singleResult.protocolOutputLimit,
                success: !statusOwner.cancelled &&
                    !stepTimedOut &&
                    !statusOwner.timedOut &&
                    singleResult.interrupted !== true &&
                    singleResult.exitCode === 0,
                exitCode: statusOwner.cancelled
                    ? 1
                    : stepTimedOut || statusOwner.timedOut
                        ? 1
                        : singleResult.interrupted === true
                            ? 0
                            : singleResult.exitCode,
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
                truncated: singleResult.truncated,
                transcriptPath: singleResult.transcriptPath,
                transcriptError: singleResult.transcriptError,
                skills: singleResult.skills,
                skillsWarning: singleResult.skillsWarning,
                outputMode: singleResult.outputMode,
                savedOutputPath: singleResult.savedOutputPath,
                outputReference: singleResult.outputReference,
                outputSaveError: singleResult.outputSaveError,
                pause: !statusOwner.cancelled && !stepTimedOut && singleResult.interrupted
                    ? statusOwner.pauseMetadataForIndex(flatIndex)
                    : undefined,
                interrupted: stepTimedOut ? undefined : singleResult.interrupted,
                timedOut: stepTimedOut || statusOwner.timedOut || singleResult.timedOut ? true : undefined,
                timeoutOwner: statusPayload.steps[flatIndex]?.timeoutOwner ?? seqStep.timeoutOwner,
                activeRuntimeMs: singleResult.activeRuntimeMs,
                contextUsage: singleResult.contextUsage,
                contextPressure: singleResult.contextPressure,
                contextPressureCrossedThresholds: singleResult.contextPressureCrossedThresholds,
                terminationReason: statusOwner.cancelled ? "cancelled" : singleResult.terminationReason,
                activityState: statusPayload.steps[flatIndex]?.activityState,
                cwd: statusPayload.steps[flatIndex]?.cwd,
                terminalResult: singleResult.terminalResult,
            };
            applyCancelledStepProjection(projectedResult, statusOwner.cancelled ? statusPayload.cancel : undefined);
            return projectedResult;
        };
        results.push(projectSingleStepResult());
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
        const stepDurationStart = statusPayload.steps[flatIndex].startedAt ?? stepStartTime;
        const childInterrupted = !stepTimedOut && singleResult.interrupted === true;
        if (childInterrupted && !statusOwner.cancelled)
            statusOwner.interrupted = true;
        const priorStepStatus = statusPayload.steps[flatIndex].status;
        const pausedStep = !stepTimedOut &&
            !statusOwner.cancelled &&
            (childInterrupted || isPausedStepStatus(priorStepStatus));
        statusPayload.steps[flatIndex].status = statusOwner.cancelled
            ? "cancelled"
            : stepTimedOut || statusOwner.timedOut
                ? "failed"
                : pausedStep
                    ? "paused"
                    : singleResult.exitCode === 0
                        ? "complete"
                        : "failed";
        statusPayload.steps[flatIndex].endedAt = stepEndTime;
        statusPayload.steps[flatIndex].durationMs = stepEndTime - stepDurationStart;
        statusPayload.steps[flatIndex].terminalResult = terminalResultForStatusStep(singleResult, statusPayload.steps[flatIndex].status);
        const settledTerminalResult = terminalResultForStatusStep(singleResult, statusPayload.steps[flatIndex].status);
        const settledStepResult = results.at(-1);
        if (settledStepResult)
            settledStepResult.terminalResult = settledTerminalResult;
        statusPayload.steps[flatIndex].exitCode = statusOwner.cancelled
            ? 1
            : stepTimedOut || statusOwner.timedOut
                ? 1
                : childInterrupted
                    ? 0
                    : singleResult.exitCode;
        statusPayload.steps[flatIndex].exitSignal = singleResult.exitSignal;
        statusPayload.steps[flatIndex].timedOut = stepTimedOut ? true : undefined;
        statusPayload.steps[flatIndex].timeoutOwner =
            statusPayload.steps[flatIndex].timeoutOwner ?? seqStep.timeoutOwner;
        statusPayload.steps[flatIndex].processCleanup = singleResult.processCleanup;
        statusPayload.steps[flatIndex].contextUsage =
            singleResult.contextUsage ?? statusPayload.steps[flatIndex].contextUsage;
        statusPayload.steps[flatIndex].contextPressure =
            singleResult.contextPressure ?? statusPayload.steps[flatIndex].contextPressure;
        statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
            singleResult.contextPressureCrossedThresholds ??
                statusPayload.steps[flatIndex].contextPressureCrossedThresholds;
        statusPayload.steps[flatIndex].terminationReason = statusOwner.cancelled
            ? "cancelled"
            : singleResult.terminationReason;
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
        statusPayload.steps[flatIndex].error = stepTimedOut
            ? boundChildError(timeoutOutput)
            : singleResult.error;
        statusPayload.steps[flatIndex].stderr = singleResult.stderr
            ? boundChildStderrError(singleResult.stderr, singleResult.stderrTruncated === true, MAX_CHILD_ERROR_BYTES)
            : undefined;
        statusPayload.steps[flatIndex].stderrTruncated = singleResult.stderrTruncated;
        statusPayload.steps[flatIndex].protocolOutputLimit = singleResult.protocolOutputLimit;
        statusPayload.steps[flatIndex].transcriptPath =
            singleResult.transcriptPath ?? statusPayload.steps[flatIndex].transcriptPath;
        statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
        statusPayload.steps[flatIndex].skills = singleResult.skills;
        statusPayload.steps[flatIndex].skillsWarning = singleResult.skillsWarning;
        if (pausedStep)
            statusOwner.applyPausedStepMetadata(flatIndex, stepEndTime);
        if (statusOwner.cancelled)
            applyCancelledStatusStepProjection(statusPayload.steps[flatIndex], statusPayload.cancel);
        if (stepTokens) {
            statusPayload.steps[flatIndex].tokens = stepTokens;
            statusPayload.totalTokens = { ...previousCumulativeTokens };
        }
        statusPayload.lastUpdate = stepEndTime;
        statusOwner.writeStatusPayload();
        appendJsonl(eventsPath, JSON.stringify({
            type: statusOwner.cancelled
                ? "subagent.step.cancelled"
                : stepTimedOut || statusOwner.timedOut
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
            exitCode: stepTimedOut || statusOwner.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
            durationMs: stepEndTime - stepDurationStart,
            tokens: stepTokens,
        }));
    };
    if (!statusOwner.interrupted &&
        !statusOwner.cancelled &&
        !statusOwner.timedOut &&
        !statusOwner.concurrentTerminalStatusAdopted) {
        const step = plan;
        if (step.kind === "parallel") {
            const group = step;
            const tasks = group.tasks;
            const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
            const groupStartFlatIndex = flatIndex;
            const parallelResults = await mapConcurrent(tasks, concurrency, async (task, taskIdx) => {
                const fi = groupStartFlatIndex + taskIdx;
                if (statusOwner.cancelled || statusOwner.timedOut) {
                    return statusOwner.cancelled
                        ? statusOwner.pausedStepResult(task)
                        : statusOwner.timedOutStepResult(task);
                }
                if (statusOwner.interrupted || statusOwner.concurrentTerminalStatusAdopted)
                    return statusOwner.pausedStepResult(task);
                const taskSessionDir = config.sessionDir
                    ? path.join(config.sessionDir, `parallel-${taskIdx}`)
                    : undefined;
                const taskStartTime = Date.now();
                const taskDeadlineAt = resolveStepDeadlineAt(taskStartTime, task.timeoutMs, config.deadlineAt);
                statusOwner.beginTrackedSessionStep(fi, task.sessionFile ? path.dirname(task.sessionFile) : taskSessionDir, task.sessionFile);
                statusPayload.currentStep = fi;
                statusPayload.steps[fi].status = "running";
                statusPayload.steps[fi].error = undefined;
                statusPayload.steps[fi].activityState = undefined;
                resetStepLiveDetail(statusPayload.steps[fi]);
                statusPayload.steps[fi].startedAt = taskStartTime;
                statusPayload.steps[fi].timeoutMs = task.timeoutMs;
                statusPayload.steps[fi].deadlineAt = taskDeadlineAt;
                statusPayload.steps[fi].endedAt = undefined;
                statusPayload.steps[fi].durationMs = undefined;
                statusPayload.steps[fi].lastActivityAt = taskStartTime;
                statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
                statusPayload.lastActivityAt = taskStartTime;
                statusPayload.lastUpdate = taskStartTime;
                appendRecentStepOutput(statusPayload.steps[fi], task.attemptNotes ?? []);
                statusPayload.steps[fi].activeRuntimeMs = boundedActiveRuntimeMs(statusPayload.steps[fi].activeRuntimeMs);
                statusOwner.activeRuntimeTrackers.set(fi, createActiveRuntimeTracker({
                    priorActiveRuntimeMs: statusPayload.steps[fi].activeRuntimeMs,
                    segmentStartedAt: taskStartTime,
                }));
                statusOwner.writeStatusPayload();
                appendJsonl(eventsPath, JSON.stringify({
                    type: "subagent.step.started",
                    ts: taskStartTime,
                    runId: id,
                    stepIndex: fi,
                    agent: task.agent,
                }));
                controlOwner.flushPendingStepSteers(fi);
                const runTelemetry = normalizeSubagentRunTelemetry(config.telemetry);
                const childTelemetry = runTelemetry && runTelemetry.steps.some((s) => s.index === fi)
                    ? { ...runTelemetry, steps: runTelemetry.steps.filter((s) => s.index === fi) }
                    : undefined;
                const rawSingleResult = await runSingleStep(task, {
                    cwd,
                    sessionEnabled,
                    sessionDir: taskSessionDir,
                    artifactsDir,
                    artifactConfig,
                    id,
                    flatIndex: fi,
                    childTelemetry,
                    flatStepCount: Math.max(statusPayload.steps.length, 1),
                    outputFile: path.join(asyncDir, `output-${fi}.log`),
                    steerInboxDir: stepSteerInboxDir(asyncDir, fi),
                    piPackageRoot: config.piPackageRoot,
                    piArgv1: config.piArgv1,
                    registerInterrupt: (interrupt) => controlOwner.registerStepInterrupt(fi, interrupt),
                    registerTimeout: (interrupt) => controlOwner.registerStepTimeout(fi, interrupt),
                    interruptSignal: interruptAbortController.signal,
                    interruptMessage: "Interrupted. Waiting for explicit next action.",
                    timeoutSignal: timeoutAbortController.signal,
                    timeoutMessage,
                    onTimeout: (message) => statusOwner.recordStepTimeout(fi, message),
                    timeoutMs: task.timeoutMs,
                    deadlineAt: config.deadlineAt,
                    startedAt: taskStartTime,
                    runtimeTracker: statusOwner.activeRuntimeTrackers.get(fi),
                    onAttemptStart: (attempt) => {
                        statusPayload.steps[fi].startedAt = attempt.startedAt;
                        statusPayload.steps[fi].durationMs = 0;
                        statusPayload.steps[fi].deadlineAt = attempt.deadlineAt;
                        statusPayload.lastUpdate = attempt.startedAt;
                        controlOwner.updateStepModel(fi, attempt);
                        statusOwner.writeStatusPayload();
                    },
                    onChildEvent: (event) => controlOwner.updateStepFromChildEvent(fi, event),
                    onAttemptEnd: (facts) => {
                        statusOwner.recordAttemptFacts(fi, facts);
                    },
                    asyncDir,
                    onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
                }, appendDiagnosticJsonl);
                const singleResult = normalizeTimedOutStepResult(statusPayload.steps[fi], rawSingleResult, timeoutMessage);
                if (task.sessionFile) {
                    statusOwner.latestSessionFile = task.sessionFile;
                }
                const taskEndTime = Date.now();
                settleActiveRuntime(fi, singleResult, taskEndTime);
                const stepTimedOut = statusPayload.steps[fi]?.timedOut === true || singleResult.timedOut === true;
                const timeoutOutput = statusPayload.steps[fi]?.error ??
                    singleResult.error ??
                    timeoutMessage ??
                    "Subagent timed out.";
                const taskDurationStart = statusPayload.steps[fi].startedAt ?? taskStartTime;
                const taskDuration = taskEndTime - taskDurationStart;
                const childInterrupted = !stepTimedOut && singleResult.interrupted === true;
                if (childInterrupted && !statusOwner.cancelled)
                    statusOwner.interrupted = true;
                const priorStepStatus = statusPayload.steps[fi].status;
                const preservedTerminalStatus = preservedCancellationStepStatus(priorStepStatus, childInterrupted, singleResult.exitCode);
                const cancelProjection = statusOwner.cancelled && !preservedTerminalStatus;
                const pausedStep = !stepTimedOut &&
                    !statusOwner.cancelled &&
                    (childInterrupted || isPausedStepStatus(priorStepStatus));
                statusPayload.steps[fi].status = cancelProjection
                    ? "cancelled"
                    : stepTimedOut || statusOwner.timedOut
                        ? "failed"
                        : (preservedTerminalStatus ??
                            (pausedStep ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed"));
                statusPayload.steps[fi].endedAt = taskEndTime;
                statusPayload.steps[fi].durationMs = taskDuration;
                statusPayload.steps[fi].terminalResult = terminalResultForStatusStep(singleResult, statusPayload.steps[fi].status);
                statusPayload.steps[fi].exitCode = cancelProjection
                    ? 1
                    : stepTimedOut || statusOwner.timedOut
                        ? 1
                        : preservedTerminalStatus === "complete"
                            ? 0
                            : childInterrupted
                                ? 0
                                : singleResult.exitCode;
                statusPayload.steps[fi].exitSignal = singleResult.exitSignal;
                statusPayload.steps[fi].timedOut = stepTimedOut ? true : undefined;
                statusPayload.steps[fi].timeoutOwner =
                    statusPayload.steps[fi].timeoutOwner ?? task.timeoutOwner;
                statusPayload.steps[fi].processCleanup = singleResult.processCleanup;
                statusPayload.steps[fi].contextUsage =
                    singleResult.contextUsage ?? statusPayload.steps[fi].contextUsage;
                statusPayload.steps[fi].contextPressure =
                    singleResult.contextPressure ?? statusPayload.steps[fi].contextPressure;
                statusPayload.steps[fi].contextPressureCrossedThresholds =
                    singleResult.contextPressureCrossedThresholds ??
                        statusPayload.steps[fi].contextPressureCrossedThresholds;
                statusPayload.steps[fi].terminationReason = cancelProjection
                    ? "cancelled"
                    : preservedTerminalStatus === "complete"
                        ? "completed"
                        :
                            stepTimedOut
                                ? (statusPayload.steps[fi].terminationReason ?? "timed_out")
                                : singleResult.terminationReason;
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
                statusPayload.steps[fi].error = cancelProjection
                    ? "Cancelled by parent abort."
                    : stepTimedOut || statusOwner.timedOut
                        ? boundChildError(timeoutOutput)
                        : singleResult.error;
                statusPayload.steps[fi].stderr = singleResult.stderr
                    ? boundChildStderrError(singleResult.stderr, singleResult.stderrTruncated === true, MAX_CHILD_ERROR_BYTES)
                    : undefined;
                statusPayload.steps[fi].stderrTruncated = singleResult.stderrTruncated;
                statusPayload.steps[fi].protocolOutputLimit = singleResult.protocolOutputLimit;
                statusPayload.steps[fi].transcriptPath =
                    singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
                statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
                statusPayload.steps[fi].skills = singleResult.skills;
                statusPayload.steps[fi].skillsWarning = singleResult.skillsWarning;
                if (pausedStep)
                    statusOwner.applyPausedStepMetadata(fi, taskEndTime);
                if (cancelProjection)
                    applyCancelledStatusStepProjection(statusPayload.steps[fi], statusPayload.cancel);
                statusPayload.lastUpdate = taskEndTime;
                statusOwner.writeStatusPayload();
                appendJsonl(eventsPath, JSON.stringify({
                    type: cancelProjection
                        ? "subagent.step.cancelled"
                        : stepTimedOut || statusOwner.timedOut
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
                    exitCode: cancelProjection
                        ? 1
                        : stepTimedOut || statusOwner.timedOut
                            ? 1
                            : preservedTerminalStatus === "complete"
                                ? 0
                                : childInterrupted
                                    ? 0
                                    : singleResult.exitCode,
                    durationMs: taskDuration,
                }));
                statusOwner.writeStatusPayload();
                return cancelProjection
                    ? {
                        ...singleResult,
                        output: "Cancelled by parent abort.",
                        error: "Cancelled by parent abort.",
                        exitCode: 1,
                        interrupted: undefined,
                        pause: undefined,
                        cancel: statusPayload.cancel,
                        terminationReason: "cancelled",
                        skipped: false,
                    }
                    : stepTimedOut || statusOwner.timedOut
                        ? {
                            ...singleResult,
                            output: timeoutOutput,
                            error: timeoutOutput,
                            exitCode: 1,
                            interrupted: false,
                            timedOut: true,
                            skipped: false,
                        }
                        : { ...singleResult, skipped: false };
            }, globalSemaphore);
            flatIndex += tasks.length;
            settleParallelResults(group, parallelResults, groupStartFlatIndex);
        }
        else {
            const seqStep = step.task;
            const stepStartTime = Date.now();
            const stepDeadlineAt = resolveStepDeadlineAt(stepStartTime, seqStep.timeoutMs, config.deadlineAt);
            statusOwner.beginTrackedSessionStep(flatIndex, seqStep.sessionFile ? path.dirname(seqStep.sessionFile) : config.sessionDir, seqStep.sessionFile);
            statusPayload.currentStep = flatIndex;
            statusPayload.steps[flatIndex].status = "running";
            statusPayload.steps[flatIndex].activityState = undefined;
            statusPayload.activityState = undefined;
            resetStepLiveDetail(statusPayload.steps[flatIndex]);
            statusPayload.steps[flatIndex].skills = seqStep.skills;
            statusPayload.steps[flatIndex].startedAt = stepStartTime;
            statusPayload.steps[flatIndex].timeoutMs = seqStep.timeoutMs;
            statusPayload.steps[flatIndex].deadlineAt = stepDeadlineAt;
            statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
            statusPayload.lastActivityAt = stepStartTime;
            statusPayload.lastUpdate = stepStartTime;
            statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
            appendRecentStepOutput(statusPayload.steps[flatIndex], seqStep.attemptNotes ?? []);
            statusPayload.steps[flatIndex].activeRuntimeMs = boundedActiveRuntimeMs(statusPayload.steps[flatIndex].activeRuntimeMs);
            statusOwner.activeRuntimeTrackers.set(flatIndex, createActiveRuntimeTracker({
                priorActiveRuntimeMs: statusPayload.steps[flatIndex].activeRuntimeMs,
                segmentStartedAt: stepStartTime,
            }));
            statusOwner.writeStatusPayload();
            appendJsonl(eventsPath, JSON.stringify({
                type: "subagent.step.started",
                ts: stepStartTime,
                runId: id,
                stepIndex: flatIndex,
                agent: seqStep.agent,
            }));
            controlOwner.flushPendingStepSteers(flatIndex);
            const singleResult = await runSingleStep(seqStep, {
                cwd,
                sessionEnabled,
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
                registerInterrupt: (interrupt) => controlOwner.registerStepInterrupt(flatIndex, interrupt),
                registerTimeout: (interrupt) => controlOwner.registerStepTimeout(flatIndex, interrupt),
                interruptSignal: interruptAbortController.signal,
                interruptMessage: "Interrupted. Waiting for explicit next action.",
                timeoutSignal: timeoutAbortController.signal,
                timeoutMessage,
                onTimeout: (message) => statusOwner.recordStepTimeout(flatIndex, message),
                timeoutMs: seqStep.timeoutMs,
                deadlineAt: config.deadlineAt,
                startedAt: stepStartTime,
                runtimeTracker: statusOwner.activeRuntimeTrackers.get(flatIndex),
                onAttemptStart: (attempt) => {
                    statusPayload.steps[flatIndex].startedAt = attempt.startedAt;
                    statusPayload.steps[flatIndex].durationMs = 0;
                    statusPayload.steps[flatIndex].deadlineAt = attempt.deadlineAt;
                    statusPayload.lastUpdate = attempt.startedAt;
                    controlOwner.updateStepModel(flatIndex, attempt);
                    statusOwner.writeStatusPayload();
                },
                onChildEvent: (event) => controlOwner.updateStepFromChildEvent(flatIndex, event),
                onAttemptEnd: (facts) => {
                    statusOwner.recordAttemptFacts(flatIndex, facts);
                },
                asyncDir,
                onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
            }, appendDiagnosticJsonl);
            settleSingleStep(seqStep, stepStartTime, singleResult);
            flatIndex++;
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
    const totalCost = results.reduce((sum, result) => ({
        inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
        costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const finalTotalCost = totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0
        ? totalCost
        : undefined;
    const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
    const agentName = finalFlatAgents.length === 1 ? finalFlatAgents[0] : `parallel:${finalFlatAgents.join("+")}`;
    controlOwner.disposeActivityTimer();
    statusOwner.stopHeartbeat();
    statusOwner.disposeRuntimeCheckpointTimer();
    if (timeoutTimer)
        timeoutTimer.cancel();
    disposeControlInbox();
    const effectiveSessionFile = statusOwner.latestSessionFile;
    const runEndedAt = Date.now();
    let pausedAwaitingSupervisor;
    let safePausedResultAfterReap;
    let skipFinalStatusWrite = false;
    if (statusOwner.supervisorPauseRequest && !statusOwner.cancelled) {
        const ownedProcessesStoppedBeforeFinalization = statusOwner.ownedPauseProcessesConfirmedStopped();
        if (statusOwner.isPersistedAwaitingSupervisorPause(statusPayload) &&
            ownedProcessesStoppedBeforeFinalization) {
            pausedAwaitingSupervisor = {
                ...statusPayload.pause,
                pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
                ownerPid: undefined,
            };
        }
        else if (statusPayload.state === "pausing") {
            if (ownedProcessesStoppedBeforeFinalization) {
                const pausedSessionFile = effectiveSessionFile ??
                    statusPayload.steps[statusOwner.supervisorPauseRequest.requesterIndex]?.sessionFile;
                try {
                    const transition = transitionLifecycleStatus({
                        asyncDir,
                        expectedGeneration: lifecycleGeneration(statusPayload),
                        mutate: (status) => {
                            const pausedSteps = status.steps?.map((step, index) => step.status === "pausing" || step.status === "paused"
                                ? {
                                    ...step,
                                    ...(statusOwner.refreshTrackedSessionFile(index)
                                        ? { sessionFile: statusOwner.refreshTrackedSessionFile(index) }
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
                                    pause: statusOwner.pauseMetadataForIndex(index, runEndedAt),
                                }
                                : step);
                            const pausedStatus = {
                                ...status,
                                state: "paused",
                                pid: undefined,
                                pause: {
                                    ...statusOwner.supervisorPauseRequest.pause,
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
                                steps: pausedSteps,
                            };
                            const pausedTelemetry = buildPausedRunnerTelemetry({
                                config,
                                plan,
                                results,
                                controlConfig,
                                overallStartTime,
                                endedAt: runEndedAt,
                                statusSteps: pausedSteps ?? [],
                            });
                            return {
                                ...pausedStatus,
                                ...(pausedTelemetry ? { telemetry: pausedTelemetry } : { telemetry: undefined }),
                            };
                        },
                    });
                    Object.assign(statusPayload, transition.status);
                }
                catch (error) {
                    appendUnexpectedLifecycleTransitionDiagnostic(appendDiagnosticEvent, id, "pausing->paused", error);
                    statusOwner.adoptConcurrentTerminalStatus();
                }
                const ownedProcessesStoppedAfterFinalization = statusOwner.ownedPauseProcessesConfirmedStopped();
                if (!statusOwner.concurrentTerminalStatusAdopted &&
                    ownedProcessesStoppedAfterFinalization &&
                    statusOwner.durablePausingCheckpointPersisted &&
                    !statusOwner.supervisorPauseTransitionFailed) {
                    safePausedResultAfterReap = {
                        ...(statusPayload.pause ?? statusOwner.supervisorPauseRequest.pause),
                        pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
                        ownerPid: undefined,
                    };
                    if (statusOwner.isPersistedAwaitingSupervisorPause(statusPayload))
                        pausedAwaitingSupervisor = safePausedResultAfterReap;
                }
                else if (!statusOwner.concurrentTerminalStatusAdopted) {
                    statusOwner.supervisorPauseTransitionFailed = true;
                    skipFinalStatusWrite = true;
                }
            }
            else if (!statusOwner.adoptConcurrentTerminalStatus()) {
                statusOwner.supervisorPauseTransitionFailed = true;
                skipFinalStatusWrite = true;
            }
        }
        else if (!statusOwner.adoptConcurrentTerminalStatus()) {
            statusOwner.supervisorPauseTransitionFailed = true;
        }
        if (!pausedAwaitingSupervisor &&
            statusOwner.supervisorPauseTransitionFailed &&
            !statusOwner.concurrentTerminalStatusAdopted) {
            skipFinalStatusWrite = false;
            statusPayload.state = "failed";
            statusPayload.pid = undefined;
            statusPayload.pause = undefined;
            statusPayload.activityState = undefined;
            statusPayload.currentTool = undefined;
            statusPayload.currentToolStartedAt = undefined;
            statusPayload.currentPath = undefined;
            statusPayload.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            statusPayload.endedAt = runEndedAt;
            statusPayload.lastUpdate = runEndedAt;
            statusPayload.lifecycle = {
                ...statusPayload.lifecycle,
                resumeBlockedReason: "supervisor_lifecycle_failure",
            };
            statusPayload.steps = statusPayload.steps.map((step) => isCompletedLifecycleStepState(step.status) ||
                step.status === "failed" ||
                step.status === "cancelled"
                ? step
                : {
                    ...step,
                    status: "failed",
                    pause: undefined,
                    activityState: undefined,
                    currentTool: undefined,
                    currentToolArgs: undefined,
                    currentToolStartedAt: undefined,
                    currentPath: undefined,
                    interruptRequestedAt: undefined,
                    exitCode: 1,
                    terminationReason: "process_exit",
                    error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
                    endedAt: step.endedAt ?? runEndedAt,
                    durationMs: step.durationMs ??
                        (step.startedAt === undefined
                            ? undefined
                            : Math.max(0, runEndedAt - step.startedAt)),
                    terminalResult: terminalResultForStatusStep(step, "failed"),
                });
            summary = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            normalizeFailedSupervisorPauseResults(results, statusPayload.steps, statusOwner.supervisorPauseRequest.requesterIndex, agentName);
        }
    }
    const pausedOwnershipConfirmedStopped = statusOwner.interrupted && statusOwner.ownedPauseProcessesConfirmedStopped();
    persistRunnerTerminalRun({
        config,
        plan,
        statusOwner,
        statusPayload,
        results,
        controlConfig,
        overallStartTime,
        runEndedAt,
        effectiveSessionFile,
        finalTotalCost,
        summary,
        truncated,
        agentName,
        timeoutMessage,
        resultPath,
        cwd,
        artifactsDir,
        asyncDir,
        taskIndex,
        totalTasks,
        pausedAwaitingSupervisor,
        safePausedResultAfterReap,
        pausedOwnershipConfirmedStopped,
        skipFinalStatusWrite,
        pausedOutputForIndex,
        appendEvent,
        writeRunLog: (input) => writeRunLog(logPath, input),
    });
    releaseWorkspaceReservationsForRun(id);
}
const configArg = process.argv[2];
if (configArg) {
    try {
        const configJson = fs.readFileSync(configArg, "utf-8");
        const configValue = JSON.parse(configJson);
        const retiredNestedError = retiredNestedLaunchError(configValue);
        if (retiredNestedError)
            throw new Error(retiredNestedError);
        try {
            fs.unlinkSync(configArg);
        }
        catch {
        }
        const config = parseRunnerConfig(configValue);
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
            const configValue = JSON.parse(input);
            const config = parseRunnerConfig(configValue);
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
