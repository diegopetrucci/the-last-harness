import * as fs from "node:fs";
import * as path from "node:path";
import { getArtifactPaths } from "../../shared/artifacts.js";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, } from "../../shared/types.js";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.js";
import { boundChildError, claimChildTerminalReason, formatProtocolOutputLimit, } from "../shared/child-protocol.js";
import { buildSkippedAcceptanceLedger } from "../shared/acceptance.js";
import { ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS, TERMINAL_RUN_STATES, applyActiveRuntimeCheckpoint, boundedActiveRuntimeMs, lifecycleGeneration, mergeAndWriteSourceRunnerStatus, normalizeActiveRuntimeCheckpointAt, normalizeActiveRuntimeMs, transitionLifecycleStatus, writeNormalizedLifecycleStatus, } from "../shared/lifecycle-state.js";
import { initialToolBudgetState } from "../shared/tool-budget.js";
import { parseContextPressureCrossedThresholds, parseContextPressureProjection, } from "../../shared/context-diagnostics.js";
import { sanitizeModelFallbackNotice } from "../shared/model-fallback.js";
import { readStatus } from "../../shared/utils.js";
function projectInitialModelFallbackFilterNotice(notice) {
    const sanitized = sanitizeModelFallbackNotice(notice);
    return sanitized ? { modelFallbackNotice: sanitized } : {};
}
function resolveAsyncStepTranscriptPath(input) {
    if (!input.artifactsDir ||
        input.artifactConfig.enabled === false ||
        input.artifactConfig.includeTranscript === false)
        return undefined;
    return getArtifactPaths(input.artifactsDir, input.runId, input.agent, input.flatStepCount > 1 ? input.flatIndex : undefined).transcriptPath;
}
export function createBackgroundRunStatusOwner(input) {
    const { id, asyncDir, cwd, plan, overallStartTime, shareEnabled, artifactConfig, artifactsDir, sessionDir, sessionId, deadlineAt, toolBudget, tkTicket, projectAgents, nestedRoute, nestedSelf, timeoutMessage, appendEvent, } = input;
    const flatSteps = plan.kind === "single" ? [plan.task] : plan.tasks;
    for (const step of flatSteps) {
        step.contextPressure = parseContextPressureProjection(step.contextPressure);
        step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(step.contextPressureCrossedThresholds);
    }
    const initialStatusSteps = flatSteps.map((task, taskFlatIndex) => {
        const transcriptPath = resolveAsyncStepTranscriptPath({
            artifactsDir,
            artifactConfig,
            runId: id,
            agent: task.agent,
            flatIndex: taskFlatIndex,
            flatStepCount: flatSteps.length,
        });
        return {
            agent: task.agent,
            ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
            status: "pending",
            ...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
            ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
            ...(normalizeActiveRuntimeMs(task.activeRuntimeMs) !== undefined
                ? { activeRuntimeMs: normalizeActiveRuntimeMs(task.activeRuntimeMs) }
                : {}),
            ...(normalizeActiveRuntimeCheckpointAt(task.activeRuntimeCheckpointAt) !== undefined
                ? {
                    activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(task.activeRuntimeCheckpointAt),
                }
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
        };
    });
    const sessionEnabled = Boolean(sessionDir) || shareEnabled || flatSteps.some((step) => Boolean(step.sessionFile));
    const initialActiveRuntimeValues = initialStatusSteps
        .map((step) => normalizeActiveRuntimeMs(step.activeRuntimeMs))
        .filter((value) => value !== undefined);
    const initialActiveRuntimeMs = initialActiveRuntimeValues.reduce((total, value) => total + value, 0);
    const initialActiveRuntimeCheckpointValues = initialStatusSteps
        .map((step) => normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt))
        .filter((value) => value !== undefined);
    const initialActiveRuntimeCheckpointAt = initialActiveRuntimeCheckpointValues.length > 0
        ? Math.max(...initialActiveRuntimeCheckpointValues)
        : undefined;
    const statusPayload = {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        runId: id,
        ...(sessionId ? { sessionId } : {}),
        mode: plan.kind,
        state: "running",
        lastActivityAt: overallStartTime,
        startedAt: overallStartTime,
        lastUpdate: overallStartTime,
        ...(initialActiveRuntimeValues.length > 0 ? { activeRuntimeMs: initialActiveRuntimeMs } : {}),
        ...(initialActiveRuntimeCheckpointAt !== undefined
            ? { activeRuntimeCheckpointAt: initialActiveRuntimeCheckpointAt }
            : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(toolBudget ? { toolBudget: initialToolBudgetState(toolBudget) } : {}),
        pid: process.pid,
        cwd,
        currentStep: 0,
        steps: initialStatusSteps,
        ...(tkTicket ? { tkTicket } : {}),
        ...(projectAgents ? { projectAgents } : {}),
        artifactsDir,
        sessionDir,
        outputFile: path.join(asyncDir, "output-0.log"),
    };
    fs.mkdirSync(asyncDir, { recursive: true });
    writeNormalizedLifecycleStatus(asyncDir, statusPayload);
    const activeRuntimeTrackers = new Map();
    const flatStepAcceptances = flatSteps.map((step) => step.effectiveAcceptance);
    const terminalReason = {};
    const controlHooks = {
        clearActivityState: () => undefined,
        interruptNestedDescendants: () => undefined,
        timeoutNestedDescendants: () => undefined,
        interruptActiveChildren: () => undefined,
        timeoutActiveChildren: () => undefined,
        abortInterrupt: () => undefined,
        abortTimeout: () => undefined,
    };
    let latestSessionFile;
    const trackedStepSessions = initialStatusSteps.map((step) => step.sessionFile
        ? {
            sessionDir: path.dirname(step.sessionFile),
            baselineSessionFiles: new Set(listTrackedSessionFiles(path.dirname(step.sessionFile))),
            discoveredSessionFile: path.resolve(step.sessionFile),
        }
        : undefined);
    let supervisorPauseRequest;
    let supervisorPauseTransitionFailed = false;
    let durablePausingCheckpointPersisted = false;
    let concurrentTerminalStatusAdopted = false;
    let pausedCheckpointCommitted = false;
    let interrupted = false;
    let timedOut = false;
    let runtimeCheckpointTimer;
    function listTrackedSessionFiles(dir) {
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
        catch (error) {
            console.error("Failed to emit nested async status event:", error);
        }
    }
    function beginTrackedSessionStep(flatIndex, stepSessionDir, sessionFile) {
        trackedStepSessions[flatIndex] = {
            sessionDir: stepSessionDir,
            baselineSessionFiles: new Set(listTrackedSessionFiles(stepSessionDir)),
            ...(sessionFile ? { discoveredSessionFile: path.resolve(sessionFile) } : {}),
        };
    }
    function refreshTrackedSessionFile(flatIndex) {
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
    }
    function resolveTrackedSessionFile(flatIndex, fallback) {
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
    }
    function writeStatusPayload(options = {}) {
        if (statusPayload.currentStep !== undefined)
            refreshTrackedSessionFile(statusPayload.currentStep);
        if (options.lifecycleLocked === true ||
            concurrentTerminalStatusAdopted ||
            (interrupted && pausedCheckpointCommitted)) {
            const merged = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
            if (TERMINAL_RUN_STATES.has(merged.state) && merged.state !== statusPayload.state) {
                adoptConcurrentTerminalStatus();
            }
            else {
                statusPayload.lifecycle = merged.lifecycle;
                for (let index = 0; index < (merged.steps?.length ?? 0); index++) {
                    const mergedStep = merged.steps?.[index];
                    const localStep = statusPayload.steps[index];
                    if (!mergedStep || !localStep)
                        continue;
                    const mergedRuntime = normalizeActiveRuntimeMs(mergedStep.activeRuntimeMs);
                    const localRuntime = normalizeActiveRuntimeMs(localStep.activeRuntimeMs);
                    if (mergedRuntime !== undefined &&
                        (localRuntime === undefined || mergedRuntime > localRuntime))
                        localStep.activeRuntimeMs = mergedRuntime;
                    const mergedCheckpoint = normalizeActiveRuntimeCheckpointAt(mergedStep.activeRuntimeCheckpointAt);
                    const localCheckpoint = normalizeActiveRuntimeCheckpointAt(localStep.activeRuntimeCheckpointAt);
                    if (mergedCheckpoint !== undefined &&
                        (localCheckpoint === undefined || mergedCheckpoint > localCheckpoint))
                        localStep.activeRuntimeCheckpointAt = mergedCheckpoint;
                }
            }
        }
        else {
            writeNormalizedLifecycleStatus(asyncDir, statusPayload);
        }
        if (options.projectNested !== false) {
            emitNestedSelfEvent(statusPayload.state === "running" || statusPayload.state === "queued"
                ? "subagent.nested.updated"
                : "subagent.nested.completed");
        }
    }
    function checkpointActiveRuntime(now = Date.now(), freeze = false) {
        const candidates = [...activeRuntimeTrackers].flatMap(([index, tracker]) => {
            const step = statusPayload.steps[index];
            if (!step || step.status !== "running")
                return [];
            return [
                {
                    tracker,
                    previousActiveRuntimeMs: step.activeRuntimeMs,
                    previousActiveRuntimeCheckpointAt: step.activeRuntimeCheckpointAt,
                    apply: ({ activeRuntimeMs, activeRuntimeCheckpointAt, }) => {
                        step.activeRuntimeMs = activeRuntimeMs;
                        step.activeRuntimeCheckpointAt = activeRuntimeCheckpointAt;
                    },
                },
            ];
        });
        return applyActiveRuntimeCheckpoint(candidates, {
            now,
            freeze,
            persist: () => {
                const aggregateRuntime = statusPayload.steps.reduce((total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0), 0);
                const previousAggregateRuntime = normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs);
                statusPayload.activeRuntimeMs = Math.max(previousAggregateRuntime ?? 0, aggregateRuntime);
                statusPayload.activeRuntimeCheckpointAt = Math.max(normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) ?? 0, normalizeActiveRuntimeCheckpointAt(now) ?? 0);
                statusPayload.lastUpdate = now;
                writeStatusPayload({ projectNested: false, lifecycleLocked: true });
            },
        });
    }
    function adoptConcurrentTerminalStatus() {
        const persisted = readStatus(asyncDir);
        if (!persisted || persisted.state === "running" || persisted.state === "pausing")
            return undefined;
        const adoptedAt = Date.now();
        const localRuntimeByIndex = new Map();
        for (const [index, tracker] of activeRuntimeTrackers) {
            localRuntimeByIndex.set(index, tracker.freeze(adoptedAt));
        }
        const adoptedSteps = persisted.steps?.map((step, index) => {
            const localStep = statusPayload.steps[index];
            const localRuntime = localRuntimeByIndex.get(index) ?? normalizeActiveRuntimeMs(localStep?.activeRuntimeMs);
            const persistedRuntime = normalizeActiveRuntimeMs(step.activeRuntimeMs);
            const localCheckpoint = normalizeActiveRuntimeCheckpointAt(localStep?.activeRuntimeCheckpointAt);
            const persistedCheckpoint = normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt);
            return {
                ...step,
                ...(localRuntime !== undefined || persistedRuntime !== undefined
                    ? { activeRuntimeMs: Math.max(localRuntime ?? 0, persistedRuntime ?? 0) }
                    : {}),
                ...(localCheckpoint !== undefined || persistedCheckpoint !== undefined
                    ? { activeRuntimeCheckpointAt: Math.max(localCheckpoint ?? 0, persistedCheckpoint ?? 0) }
                    : {}),
            };
        });
        const localAggregateRuntime = statusPayload.steps.reduce((total, step, index) => total +
            (localRuntimeByIndex.get(index) ?? normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0), 0);
        const persistedAggregateRuntime = persisted.steps?.reduce((total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0), 0);
        const adoptedStatus = {
            ...persisted,
            ...(adoptedSteps ? { steps: adoptedSteps } : {}),
            ...(localAggregateRuntime > 0 ||
                persistedAggregateRuntime !== undefined ||
                persisted.activeRuntimeMs !== undefined
                ? {
                    activeRuntimeMs: Math.max(normalizeActiveRuntimeMs(persisted.activeRuntimeMs) ?? 0, persistedAggregateRuntime ?? 0, localAggregateRuntime),
                }
                : {}),
            ...(localRuntimeByIndex.size > 0 || persisted.activeRuntimeCheckpointAt !== undefined
                ? {
                    activeRuntimeCheckpointAt: Math.max(normalizeActiveRuntimeCheckpointAt(persisted.activeRuntimeCheckpointAt) ?? 0, ...[...localRuntimeByIndex.keys()].map((index) => normalizeActiveRuntimeCheckpointAt(statusPayload.steps[index]?.activeRuntimeCheckpointAt) ?? adoptedAt)),
                }
                : {}),
        };
        Object.assign(statusPayload, adoptedStatus);
        interrupted = persisted.state === "paused";
        if (persisted.state === "paused")
            pausedCheckpointCommitted = true;
        concurrentTerminalStatusAdopted = true;
        controlHooks.interruptNestedDescendants();
        controlHooks.interruptActiveChildren();
        return persisted;
    }
    function onChildProtocolOutputLimit(limit) {
        if (concurrentTerminalStatusAdopted ||
            statusPayload.state !== "running" ||
            timedOut ||
            interrupted)
            return;
        if (!claimChildTerminalReason(terminalReason, "output_limit"))
            return;
        const now = Date.now();
        checkpointActiveRuntime(now, true);
        const message = boundChildError(formatProtocolOutputLimit(limit));
        statusPayload.state = "failed";
        statusPayload.activityState = undefined;
        statusPayload.error = message;
        statusPayload.lastUpdate = now;
        appendEvent(JSON.stringify({
            type: "subagent.child.protocol_output_limit",
            ts: now,
            runId: id,
            stream: limit.stream,
            limitBytes: limit.limitBytes,
            observedBytes: limit.observedBytes,
        }));
        writeStatusPayload();
    }
    function pausedAcceptanceLedger(acceptance) {
        return acceptance
            ? buildSkippedAcceptanceLedger({
                acceptance,
                ledgerStatus: "skipped",
                runtimeCheckStatus: "not-applicable",
                id: "paused",
                message: "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
            })
            : undefined;
    }
    function pauseMetadataForIndex(index, pausedAt) {
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
    }
    function requestSupervisorPause(requesterIndex, pause) {
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
        checkpointActiveRuntime(now, true);
        if (concurrentTerminalStatusAdopted) {
            interrupted = true;
            controlHooks.abortInterrupt();
            return;
        }
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
                        const activeRuntimeMs = boundedActiveRuntimeMs(step.activeRuntimeMs);
                        return {
                            ...step,
                            status: "pausing",
                            activeRuntimeMs,
                            activeRuntimeCheckpointAt: now,
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
        controlHooks.clearActivityState();
        appendEvent(JSON.stringify({
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
        controlHooks.interruptNestedDescendants();
        controlHooks.abortInterrupt();
        controlHooks.interruptActiveChildren();
    }
    function interrupt() {
        if (interrupted || statusPayload.state !== "running")
            return;
        if (!claimChildTerminalReason(terminalReason, "interrupted"))
            return;
        interrupted = true;
        const now = Date.now();
        checkpointActiveRuntime(now, true);
        statusPayload.state = "paused";
        controlHooks.clearActivityState();
        statusPayload.activityState = undefined;
        statusPayload.lastUpdate = now;
        for (let flatIndex = 0; flatIndex < statusPayload.steps.length; flatIndex++) {
            const step = statusPayload.steps[flatIndex];
            if (step.status !== "running")
                continue;
            step.status = "paused";
            step.activityState = undefined;
            step.endedAt = now;
            step.durationMs = step.startedAt ? now - step.startedAt : undefined;
            step.lastActivityAt = now;
            if (!step.acceptance)
                step.acceptance = pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
            refreshTrackedSessionFile(flatIndex);
        }
        writeStatusPayload();
        pausedCheckpointCommitted = true;
        appendEvent(JSON.stringify({ type: "subagent.run.paused", ts: now, runId: id }));
        controlHooks.interruptNestedDescendants();
        controlHooks.abortInterrupt();
        controlHooks.interruptActiveChildren();
    }
    function timeout() {
        if (timedOut || interrupted || statusPayload.state !== "running")
            return;
        if (!claimChildTerminalReason(terminalReason, "timed_out"))
            return;
        timedOut = true;
        const now = Date.now();
        checkpointActiveRuntime(now, true);
        const message = timeoutMessage ?? "Subagent timed out.";
        statusPayload.state = "failed";
        statusPayload.timedOut = true;
        statusPayload.error = message;
        controlHooks.clearActivityState();
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
        appendEvent(JSON.stringify({
            type: "subagent.run.timed_out",
            ts: now,
            runId: id,
            deadlineAt,
            message,
        }));
        controlHooks.abortTimeout();
        controlHooks.timeoutNestedDescendants();
        controlHooks.timeoutActiveChildren();
    }
    function pausedStepResult(task) {
        return {
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
        };
    }
    function timedOutStepResult(task) {
        return {
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
        };
    }
    function ownedPauseProcessesConfirmedStopped() {
        return statusPayload.steps.every((step) => {
            if (step.status !== "pausing" && step.status !== "paused")
                return true;
            if (!step.startedAt)
                return true;
            return step.processCleanup?.terminated === true;
        });
    }
    function isPersistedAwaitingSupervisorPause(status) {
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
    }
    function applyPausedStepMetadata(flatIndex, endedAt) {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        const sessionFile = refreshTrackedSessionFile(flatIndex);
        if (sessionFile)
            step.sessionFile = sessionFile;
        step.pause = pauseMetadataForIndex(flatIndex, endedAt);
        step.acceptance = step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
        step.interruptRequestedAt = supervisorPauseRequest?.requestedAt ?? step.interruptRequestedAt;
    }
    function startRuntimeCheckpointTimer() {
        runtimeCheckpointTimer = setInterval(() => {
            if (statusPayload.state !== "running")
                return;
            checkpointActiveRuntime(Date.now());
        }, ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS);
        runtimeCheckpointTimer.unref?.();
    }
    function disposeRuntimeCheckpointTimer() {
        if (runtimeCheckpointTimer)
            clearInterval(runtimeCheckpointTimer);
        runtimeCheckpointTimer = undefined;
    }
    const owner = {
        flatSteps,
        initialStatusSteps,
        sessionEnabled,
        statusPayload,
        activeRuntimeTrackers,
        flatStepAcceptances,
        terminalReason,
        get latestSessionFile() {
            return latestSessionFile;
        },
        set latestSessionFile(value) {
            latestSessionFile = value;
        },
        get interrupted() {
            return interrupted;
        },
        set interrupted(value) {
            interrupted = value;
        },
        get timedOut() {
            return timedOut;
        },
        set timedOut(value) {
            timedOut = value;
        },
        get supervisorPauseRequest() {
            return supervisorPauseRequest;
        },
        set supervisorPauseRequest(value) {
            supervisorPauseRequest = value;
        },
        get supervisorPauseTransitionFailed() {
            return supervisorPauseTransitionFailed;
        },
        set supervisorPauseTransitionFailed(value) {
            supervisorPauseTransitionFailed = value;
        },
        get durablePausingCheckpointPersisted() {
            return durablePausingCheckpointPersisted;
        },
        set durablePausingCheckpointPersisted(value) {
            durablePausingCheckpointPersisted = value;
        },
        get concurrentTerminalStatusAdopted() {
            return concurrentTerminalStatusAdopted;
        },
        set concurrentTerminalStatusAdopted(value) {
            concurrentTerminalStatusAdopted = value;
        },
        get pausedCheckpointCommitted() {
            return pausedCheckpointCommitted;
        },
        set pausedCheckpointCommitted(value) {
            pausedCheckpointCommitted = value;
        },
        setControlHooks(hooks) {
            Object.assign(controlHooks, hooks);
        },
        claimTerminalReason(reason) {
            return claimChildTerminalReason(terminalReason, reason);
        },
        beginTrackedSessionStep,
        refreshTrackedSessionFile,
        resolveTrackedSessionFile,
        writeStatusPayload,
        checkpointActiveRuntime,
        onChildProtocolOutputLimit,
        pausedAcceptanceLedger,
        pausedStepResult,
        timedOutStepResult,
        pauseMetadataForIndex,
        adoptConcurrentTerminalStatus,
        requestSupervisorPause,
        interrupt,
        timeout,
        ownedPauseProcessesConfirmedStopped,
        isPersistedAwaitingSupervisorPause,
        applyPausedStepMetadata,
        startRuntimeCheckpointTimer,
        disposeRuntimeCheckpointTimer,
        emitNestedSelfEvent,
    };
    return owner;
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
