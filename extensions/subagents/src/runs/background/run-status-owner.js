import * as fs from "node:fs";
import * as path from "node:path";
import { getArtifactPaths } from "../../shared/artifacts.js";
import { readStatus } from "../../shared/utils.js";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.js";
import { boundChildError, claimChildTerminalReason, formatProtocolOutputLimit, } from "../shared/child-protocol.js";
import { isActiveLifecycleState, isCompletedLifecycleStepState, isLifecycleTransitionContentionError, isTerminalLifecycleState, lifecycleGeneration, mergeAndWriteSourceRunnerStatus, transitionLifecycleStatus, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { appendBoundedSubagentAttemptFact, boundSubagentAttemptFacts, parseSubagentTerminalResult, terminalResultForStatusStep, } from "../../shared/terminal-result.js";
import { persistedTicketId } from "../shared/ticket-context.js";
import { sanitizeModelFallbackNotice } from "../shared/model-fallback.js";
export const RUNNER_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const LIFECYCLE_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
function lifecycleErrorDetail(error) {
    try {
        const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const record = typeof error === "object" && error !== null ? error : {};
        const cause = error instanceof Error && error.cause && typeof error.cause === "object"
            ? error.cause
            : {};
        const details = [
            typeof record.code === "string" ? `code=${record.code}` : undefined,
            typeof record.syscall === "string" ? `syscall=${record.syscall}` : undefined,
            typeof cause.code === "string"
                ? `cause code=${cause.code}`
                : typeof cause.message === "string"
                    ? `cause=${cause.message}`
                    : undefined,
        ].filter((value) => Boolean(value));
        return (boundChildError(`${details.length ? `${details.join("; ")}; ` : ""}${base}`, LIFECYCLE_DIAGNOSTIC_MAX_BYTES) ?? "unknown");
    }
    catch {
        return "unavailable";
    }
}
function appendLifecycleDiagnostic(append, runId, phase, error) {
    try {
        append(JSON.stringify({
            type: "subagent.run.lifecycle_transition_failed",
            ts: Date.now(),
            runId,
            phase,
            cause: lifecycleErrorDetail(error),
        }), "subagent.run.lifecycle_transition_failed");
    }
    catch {
    }
}
export function appendUnexpectedLifecycleTransitionDiagnostic(append, runId, phase, error) {
    if (!isLifecycleTransitionContentionError(error))
        appendLifecycleDiagnostic(append, runId, phase, error);
}
function validatedTicketId(step) {
    return persistedTicketId(step.ticketId);
}
function resolveTranscriptPath(input) {
    if (!input.artifactsDir ||
        !input.artifactConfig.enabled ||
        !input.artifactConfig.includeTranscript)
        return undefined;
    return getArtifactPaths(input.artifactsDir, input.runId, input.agent, input.count > 1 ? input.index : undefined).transcriptPath;
}
function normalizeAttemptResult(result) {
    const parsed = result ? parseSubagentTerminalResult(result) : undefined;
    return parsed
        ? { state: parsed.state, facts: { attempts: boundSubagentAttemptFacts(parsed.facts.attempts) } }
        : undefined;
}
const statusStepIsTerminal = (status) => isCompletedLifecycleStepState(status) || status === "failed" || status === "cancelled";
export function createBackgroundRunStatusOwner(input) {
    const { id, asyncDir, cwd, plan, overallStartTime, shareEnabled, artifactConfig, artifactsDir, sessionDir, sessionId, deadlineAt, projectAgents, nestedRoute, nestedSelf, timeoutMessage, appendEvent, appendDiagnosticEvent, } = input;
    const flatSteps = plan.kind === "single" ? [plan.task] : plan.tasks;
    const initialStatusSteps = flatSteps.map((task, index) => {
        const terminalResult = normalizeAttemptResult(task.terminalResult);
        const ticketId = validatedTicketId(task);
        const transcriptPath = resolveTranscriptPath({
            artifactsDir,
            artifactConfig,
            runId: id,
            agent: task.agent,
            index,
            count: flatSteps.length,
        });
        return {
            agent: task.agent,
            ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
            ...(ticketId ? { ticketId } : {}),
            status: "pending",
            ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
            ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
            ...(task.cwd && path.resolve(task.cwd) !== path.resolve(cwd) ? { cwd: task.cwd } : {}),
            ...(terminalResult ? { terminalResult } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
            skills: task.skills,
            ...(task.skillsWarning ? { skillsWarning: task.skillsWarning } : {}),
            model: task.model,
            thinking: task.thinking,
            ...(task.modelIdentity ? { modelIdentity: task.modelIdentity } : {}),
            ...(task.modelResolution ? { modelResolution: task.modelResolution } : {}),
            modelFallbackNotice: sanitizeModelFallbackNotice(task.modelFallbackNotice),
            ...(task.contextUsage ? { contextUsage: task.contextUsage } : {}),
            ...(task.contextPressure ? { contextPressure: { ...task.contextPressure } } : {}),
            ...(task.contextPressureCrossedThresholds
                ? { contextPressureCrossedThresholds: [...task.contextPressureCrossedThresholds] }
                : {}),
            attemptedModels: task.modelCandidates?.length
                ? task.modelCandidates
                : task.model
                    ? [task.model]
                    : undefined,
            ...(task.childLocation ? { childLocation: task.childLocation } : {}),
            recentTools: [],
            recentOutput: [],
        };
    });
    const sessionEnabled = Boolean(sessionDir) || shareEnabled || flatSteps.some((step) => Boolean(step.sessionFile));
    const statusPayload = {
        lifecycleArtifactVersion: 1,
        ...(input.awaited ? { awaited: true } : {}),
        runId: id,
        ...(sessionId ? { sessionId } : {}),
        mode: plan.kind,
        state: "running",
        lastActivityAt: overallStartTime,
        startedAt: overallStartTime,
        lastUpdate: overallStartTime,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        pid: process.pid,
        cwd,
        currentStep: 0,
        steps: initialStatusSteps,
        ...(projectAgents ? { projectAgents } : {}),
        artifactsDir,
        sessionDir,
        outputFile: path.join(asyncDir, "output-0.log"),
    };
    fs.mkdirSync(asyncDir, { recursive: true });
    writeNormalizedLifecycleStatus(asyncDir, statusPayload);
    const terminalReason = {};
    const trackedSessions = initialStatusSteps.map((step) => step.sessionFile
        ? {
            sessionDir: path.dirname(step.sessionFile),
            baseline: new Set(listSessionFiles(path.dirname(step.sessionFile))),
            discovered: path.resolve(step.sessionFile),
        }
        : undefined);
    const hooks = {
        clearActivityState: () => undefined,
        interruptNestedDescendants: () => undefined,
        timeoutNestedDescendants: () => undefined,
        interruptActiveChildren: () => undefined,
        timeoutActiveChildren: () => undefined,
        abortInterrupt: () => undefined,
        abortTimeout: () => undefined,
    };
    let owner;
    function listSessionFiles(dir) {
        if (!dir)
            return [];
        try {
            return fs
                .readdirSync(dir)
                .filter((name) => name.endsWith(".jsonl"))
                .map((name) => path.resolve(dir, name));
        }
        catch {
            return [];
        }
    }
    function emitNestedSelfEvent(type) {
        if (!nestedRoute || !nestedSelf)
            return;
        try {
            writeNestedEvent(nestedRoute, {
                type,
                ts: Date.now(),
                parentRunId: nestedSelf.parentRunId,
                parentStepIndex: nestedSelf.parentStepIndex,
                child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
                    id,
                    parentRunId: nestedSelf.parentRunId,
                    parentStepIndex: nestedSelf.parentStepIndex,
                    depth: nestedSelf.depth,
                    path: nestedSelf.path,
                    mode: statusPayload.mode,
                    ts: Date.now(),
                }),
            });
        }
        catch {
        }
    }
    function beginTrackedSessionStep(index, dir, file) {
        trackedSessions[index] = {
            sessionDir: dir,
            baseline: new Set(listSessionFiles(dir)),
            ...(file ? { discovered: path.resolve(file) } : {}),
        };
    }
    function refreshTrackedSessionFile(index, fallback) {
        const step = statusPayload.steps[index];
        const tracked = trackedSessions[index];
        if (fallback) {
            if (tracked)
                tracked.discovered = path.resolve(fallback);
            if (step && !step.sessionFile)
                step.sessionFile = fallback;
            latestSessionFile = fallback;
            if (!statusPayload.sessionFile)
                statusPayload.sessionFile = statusPayload.steps.length === 1 ? fallback : latestSessionFile;
            return fallback;
        }
        if (!step || !tracked?.sessionDir)
            return step?.sessionFile;
        const files = listSessionFiles(tracked.sessionDir).sort((a, b) => {
            try {
                return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
            }
            catch {
                return 0;
            }
        });
        const discovered = files.find((file) => !tracked.baseline.has(file));
        if (discovered)
            tracked.discovered = discovered;
        if (tracked.discovered && !step.sessionFile)
            step.sessionFile = tracked.discovered;
        if (tracked.discovered)
            latestSessionFile = tracked.discovered;
        if (!statusPayload.sessionFile)
            statusPayload.sessionFile =
                statusPayload.steps.length === 1
                    ? (step.sessionFile ?? latestSessionFile)
                    : latestSessionFile;
        return step.sessionFile ?? tracked.discovered;
    }
    function adoptConcurrentTerminalStatus() {
        let persisted;
        try {
            persisted = readStatus(asyncDir, { cache: false });
        }
        catch {
            return undefined;
        }
        if (!persisted || !isTerminalLifecycleState(persisted.state))
            return undefined;
        let adopted = persisted;
        try {
            adopted = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
        }
        catch {
        }
        if (!isTerminalLifecycleState(adopted.state))
            adopted = persisted;
        Object.assign(statusPayload, adopted);
        owner.concurrentTerminalStatusAdopted = true;
        owner.interrupted = adopted.state === "paused";
        if (adopted.state === "paused")
            owner.durablePausingCheckpointPersisted = true;
        clearHeartbeatTimer();
        hooks.interruptNestedDescendants();
        hooks.interruptActiveChildren();
        return statusPayload;
    }
    function writeStatusPayload(options = {}) {
        if (statusPayload.currentStep !== undefined)
            refreshTrackedSessionFile(statusPayload.currentStep);
        statusPayload.activityState =
            isActiveLifecycleState(statusPayload.state) &&
                statusPayload.steps.some((step) => step.activityState === "needs_attention")
                ? "needs_attention"
                : undefined;
        const previousState = statusPayload.state;
        const merged = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
        Object.assign(statusPayload, merged);
        if (isTerminalLifecycleState(merged.state) && merged.state !== previousState)
            adoptConcurrentTerminalStatus();
        if (options.projectNested !== false)
            emitNestedSelfEvent(isActiveLifecycleState(statusPayload.state)
                ? "subagent.nested.updated"
                : "subagent.nested.completed");
    }
    function transition(phase, mutate) {
        try {
            Object.assign(statusPayload, transitionLifecycleStatus({
                asyncDir,
                expectedGeneration: lifecycleGeneration(statusPayload),
                mutate,
            }).status);
            return true;
        }
        catch (error) {
            appendUnexpectedLifecycleTransitionDiagnostic(appendDiagnosticEvent ?? appendEvent, id, phase, error);
            return Boolean(adoptConcurrentTerminalStatus());
        }
    }
    function pauseMetadataForIndex(index, pausedAt) {
        const request = owner.supervisorPauseRequest;
        if (!request)
            return undefined;
        if (index === request.requesterIndex)
            return {
                ...request.pause,
                ...(pausedAt !== undefined ? { pausedAt, ownerPid: undefined } : {}),
            };
        return {
            kind: "cohort_pause",
            summary: "Paused because another child in this cohort is awaiting supervisor.",
            requestedAt: request.requestedAt,
            ...(pausedAt !== undefined ? { pausedAt } : { ownerPid: process.pid }),
        };
    }
    let heartbeatTimer;
    let activeTimerFns = null;
    function clearHeartbeatTimer() {
        if (heartbeatTimer !== undefined) {
            (activeTimerFns?.clearInterval ?? clearInterval)(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    }
    function writeHeartbeat() {
        if (statusPayload.state !== "running") {
            clearHeartbeatTimer();
            return;
        }
        statusPayload.lastUpdate = Date.now();
        try {
            writeStatusPayload({ projectNested: false });
        }
        catch {
        }
        if (statusPayload.state !== "running") {
            clearHeartbeatTimer();
        }
    }
    function startHeartbeat(intervalMs = RUNNER_HEARTBEAT_INTERVAL_MS, timerFns) {
        clearHeartbeatTimer();
        activeTimerFns = timerFns ?? null;
        if (timerFns) {
            heartbeatTimer = timerFns.setInterval(() => writeHeartbeat(), intervalMs);
        }
        else {
            const timer = setInterval(() => writeHeartbeat(), intervalMs);
            timer.unref();
            heartbeatTimer = timer;
        }
    }
    function stopHeartbeat() {
        clearHeartbeatTimer();
    }
    function projectTerminal(state, now, options = {}) {
        const succeeded = transition("running->terminal", (status) => ({
            ...status,
            state,
            pid: undefined,
            activityState: undefined,
            currentTool: undefined,
            currentToolStartedAt: undefined,
            currentPath: undefined,
            ...(options.error !== undefined ? { error: options.error } : {}),
            ...(options.timedOut ? { timedOut: true } : {}),
            ...(options.cancel ? { cancel: options.cancel } : {}),
            endedAt: status.endedAt ?? now,
            lastUpdate: now,
            steps: status.steps?.map((step) => {
                if (!options.stepState ||
                    (options.onlyRunning && step.status !== "running") ||
                    statusStepIsTerminal(step.status))
                    return step.compaction ? { ...step, compaction: undefined } : step;
                return {
                    ...step,
                    status: options.stepState,
                    activityState: undefined,
                    compaction: undefined,
                    ...(options.step ? options.step(step, now) : {}),
                };
            }),
        }));
        if (succeeded)
            clearHeartbeatTimer();
        return succeeded;
    }
    function onChildProtocolOutputLimit(limit) {
        if (owner.concurrentTerminalStatusAdopted ||
            !isActiveLifecycleState(statusPayload.state) ||
            owner.timedOut ||
            owner.interrupted ||
            owner.cancelled ||
            !claimChildTerminalReason(terminalReason, "output_limit"))
            return;
        const now = Date.now();
        const error = boundChildError(formatProtocolOutputLimit(limit));
        if (!projectTerminal("failed", now, {
            stepState: "failed",
            error,
            step: (step) => ({
                error,
                exitCode: 1,
                endedAt: now,
                terminalResult: terminalResultForStatusStep(step, "failed"),
            }),
        }))
            return;
        appendEvent(JSON.stringify({
            type: "subagent.child.protocol_output_limit",
            ts: now,
            runId: id,
            stream: limit.stream,
            limitBytes: limit.limitBytes,
            observedBytes: limit.observedBytes,
        }));
    }
    function requestSupervisorPause(index, pause) {
        if (owner.supervisorPauseRequest ||
            owner.interrupted ||
            owner.cancelled ||
            owner.timedOut ||
            statusPayload.state !== "running" ||
            !claimChildTerminalReason(terminalReason, "paused"))
            return;
        const requestedAt = pause.requestedAt ?? Date.now();
        owner.supervisorPauseRequest = {
            requesterIndex: index,
            pause: { ...pause, ownerPid: process.pid },
            requestedAt,
        };
        const now = Date.now();
        const checkpointed = transition("running->pausing", (status) => ({
            ...status,
            state: "pausing",
            pid: process.pid,
            pause: { ...owner.supervisorPauseRequest.pause, ownerPid: process.pid },
            currentStep: index,
            currentTool: undefined,
            currentToolStartedAt: undefined,
            currentPath: undefined,
            activityState: undefined,
            lastUpdate: now,
            sessionFile: refreshTrackedSessionFile(index) ?? status.sessionFile,
            steps: status.steps?.map((step, stepIndex) => step.status !== "running"
                ? step
                : {
                    ...step,
                    status: "pausing",
                    activityState: undefined,
                    compaction: undefined,
                    interruptRequestedAt: now,
                    ...(stepIndex === index
                        ? { pause: { ...owner.supervisorPauseRequest.pause, ownerPid: process.pid } }
                        : { pause: pauseMetadataForIndex(stepIndex) }),
                }),
        }));
        owner.supervisorPauseTransitionFailed = !checkpointed;
        owner.durablePausingCheckpointPersisted =
            checkpointed && statusPayload.state === "pausing";
        owner.interrupted = true;
        clearHeartbeatTimer();
        hooks.clearActivityState();
        appendEvent(JSON.stringify({
            type: "subagent.run.pausing",
            ts: now,
            runId: id,
            stepIndex: index,
            pause: { kind: pause.kind, summary: pause.summary, request: pause.request },
        }));
        hooks.interruptNestedDescendants();
        hooks.abortInterrupt();
        hooks.interruptActiveChildren();
    }
    function cancel() {
        if (owner.supervisorPauseRequest &&
            (statusPayload.state === "pausing" || statusPayload.state === "paused")) {
            owner.interrupted = true;
            hooks.abortInterrupt();
            hooks.interruptActiveChildren();
            return;
        }
        if (owner.cancelled || isTerminalLifecycleState(statusPayload.state))
            return;
        const now = Date.now();
        const summary = "Cancelled by parent abort.";
        projectTerminal("cancelled", now, {
            stepState: "cancelled",
            error: summary,
            cancel: { summary, cancelledAt: now },
            step: (step) => ({
                cancel: { summary, cancelledAt: now },
                error: summary,
                exitCode: 1,
                terminationReason: "cancelled",
                endedAt: step.endedAt ?? now,
            }),
        });
        if (statusPayload.state !== "cancelled")
            return;
        owner.cancelled = true;
        owner.interrupted = false;
        owner.supervisorPauseRequest = undefined;
        clearHeartbeatTimer();
        hooks.clearActivityState();
        hooks.abortInterrupt();
        hooks.abortTimeout();
        hooks.interruptNestedDescendants();
        hooks.interruptActiveChildren();
        appendEvent(JSON.stringify({
            type: "subagent.run.cancelled",
            ts: now,
            runId: id,
            reason: "parent_abort",
        }));
    }
    function interrupt() {
        if (owner.cancelled ||
            owner.interrupted ||
            statusPayload.state !== "running" ||
            !claimChildTerminalReason(terminalReason, "interrupted"))
            return;
        const now = Date.now();
        projectTerminal("paused", now, {
            stepState: "paused",
            onlyRunning: true,
            step: (_step, at) => ({ endedAt: at, exitCode: 0, terminationReason: "paused" }),
        });
        owner.interrupted = true;
        clearHeartbeatTimer();
        hooks.clearActivityState();
        hooks.interruptNestedDescendants();
        hooks.abortInterrupt();
        hooks.interruptActiveChildren();
        appendEvent(JSON.stringify({ type: "subagent.run.paused", ts: now, runId: id }));
    }
    function timeout() {
        if (owner.timedOut ||
            owner.interrupted ||
            owner.cancelled ||
            statusPayload.state !== "running" ||
            !claimChildTerminalReason(terminalReason, "timed_out"))
            return;
        const now = Date.now();
        const message = timeoutMessage ?? "Subagent timed out.";
        projectTerminal("failed", now, {
            stepState: "failed",
            error: message,
            timedOut: true,
            step: (step, at) => ({
                error: message,
                exitCode: 1,
                timedOut: true,
                terminationReason: "timed_out",
                endedAt: at,
            }),
        });
        owner.timedOut = true;
        clearHeartbeatTimer();
        hooks.clearActivityState();
        hooks.abortTimeout();
        hooks.timeoutNestedDescendants();
        hooks.timeoutActiveChildren();
        appendEvent(JSON.stringify({ type: "subagent.run.timed_out", ts: now, runId: id, deadlineAt, message }));
    }
    function recordAttemptFacts(index, facts) {
        const step = statusPayload.steps[index];
        if (!step || facts.attempt < 1)
            return;
        const previous = step.terminalResult?.facts.attempts ?? [];
        if (previous.some((attempt) => attempt.attempt === facts.attempt))
            return;
        step.terminalResult = {
            state: facts.exit.signal
                ? statusPayload.state === "paused" || statusPayload.state === "pausing"
                    ? "paused"
                    : "failed"
                : facts.exit.code === 0
                    ? "completed"
                    : "failed",
            facts: { attempts: appendBoundedSubagentAttemptFact(previous, facts) },
        };
        statusPayload.lastUpdate = Date.now();
        writeStatusPayload();
    }
    function syntheticStepResult(task, paused) {
        const ticketId = validatedTicketId(task);
        return {
            agent: task.agent,
            ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
            ...(ticketId ? { ticketId } : {}),
            output: paused
                ? "Paused after interrupt. Waiting for explicit next action."
                : (timeoutMessage ?? "Subagent timed out."),
            ...(paused ? {} : { error: timeoutMessage ?? "Subagent timed out.", timedOut: true }),
            exitCode: paused ? 0 : 1,
            ...(paused
                ? { interrupted: true, terminationReason: "paused" }
                : { terminationReason: "timed_out" }),
            model: task.model,
            modelIdentity: task.modelIdentity,
            modelResolution: task.modelResolution,
        };
    }
    function pausedStepResult(task) {
        return syntheticStepResult(task, true);
    }
    function timedOutStepResult(task) {
        return syntheticStepResult(task, false);
    }
    function ownedPauseProcessesConfirmedStopped() {
        return statusPayload.steps.every((step) => (step.status !== "pausing" && step.status !== "paused") ||
            step.processCleanup?.terminated === true);
    }
    function isPersistedAwaitingSupervisorPause(status) {
        if (!status || !owner.supervisorPauseRequest)
            return false;
        const requester = status.steps[owner.supervisorPauseRequest.requesterIndex];
        return (status.state === "paused" &&
            status.pid === undefined &&
            status.pause?.kind === "awaiting_supervisor" &&
            status.pause.ownerPid === undefined &&
            requester?.status === "paused");
    }
    function applyPausedStepMetadata(index, endedAt) {
        const step = statusPayload.steps[index];
        if (!step)
            return;
        const sessionFile = refreshTrackedSessionFile(index);
        if (sessionFile)
            step.sessionFile = sessionFile;
        step.pause = pauseMetadataForIndex(index, endedAt);
        step.interruptRequestedAt =
            owner.supervisorPauseRequest?.requestedAt ?? step.interruptRequestedAt;
    }
    let latestSessionFile;
    owner = {
        flatSteps,
        sessionEnabled,
        statusPayload,
        terminalReason,
        get latestSessionFile() {
            return latestSessionFile;
        },
        set latestSessionFile(value) {
            latestSessionFile = value;
        },
        interrupted: false,
        cancelled: false,
        timedOut: false,
        supervisorPauseRequest: undefined,
        supervisorPauseTransitionFailed: false,
        durablePausingCheckpointPersisted: false,
        concurrentTerminalStatusAdopted: false,
        setControlHooks(value) {
            Object.assign(hooks, value);
        },
        beginTrackedSessionStep,
        refreshTrackedSessionFile,
        writeStatusPayload,
        recordAttemptFacts,
        onChildProtocolOutputLimit,
        pausedStepResult,
        timedOutStepResult,
        pauseMetadataForIndex,
        adoptConcurrentTerminalStatus,
        requestSupervisorPause,
        cancel,
        interrupt,
        timeout,
        ownedPauseProcessesConfirmedStopped,
        isPersistedAwaitingSupervisorPause,
        applyPausedStepMetadata,
        emitNestedSelfEvent,
        startHeartbeat,
        stopHeartbeat,
    };
    return owner;
}
