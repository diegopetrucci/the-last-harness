import * as fs from "node:fs";
import * as path from "node:path";
import { acceptChildMessageRequest, enqueueStepChildMessage, watchAsyncControlInbox, writeChildMessageAcceptanceForRequest, } from "./control-channel.js";
import { contextWindowForModel, runtimeModelReference } from "./pi-streaming.js";
import { buildControlEvent, claimControlNotification, deriveActivityState, formatControlNoticeMessage, } from "../shared/subagent-control.js";
import { projectNestedEvents, resolveNestedAsyncDir } from "../shared/nested-events.js";
import { deliverInterruptRequest, deliverTimeoutRequest } from "./control-channel.js";
import { childUsageNumber } from "../shared/child-protocol.js";
import { appendRecentProgressItem } from "../../shared/recent-progress.js";
import { createMutatingFailureState, didMutatingToolFail, isMutatingTool, nextLongRunningTrigger, recordMutatingFailure, resetMutatingFailureState, resolveCurrentPath, shouldEscalateMutatingFailures, summarizeRecentMutatingFailures, } from "../shared/long-running-guard.js";
import { extractTextFromContent, extractToolArgsPreview } from "../../shared/utils.js";
import { canonicalSubagentModelIdentity, resolveRuntimeModelContext, } from "../shared/model-fallback.js";
import { detectContextPressureCrossing, formatContextPressureGuidance, updateContextUsageDiagnostics, } from "../../shared/context-diagnostics.js";
import { parseAndStripAcceptanceReport } from "../shared/acceptance.js";
import { boundSupervisorSummary } from "../shared/lifecycle-state.js";
import { toolBudgetState } from "../shared/tool-budget.js";
import { ACTIVITY_MONITOR_INTERVAL_MS, getActivityMonitorGap, observeActivityWindow, } from "../shared/health-transition.js";
const MONITOR_GAP_DIAGNOSTIC_TYPE = "subagent.run.monitor_gap";
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
export function createBackgroundRunControlOwner(input) {
    const { status, id, asyncDir, overallStartTime, controlConfig, nestedRoute, appendEvent, appendDiagnosticEvent, } = input;
    const statusPayload = status.statusPayload;
    const flatSteps = status.flatSteps;
    const activeChildInterrupts = new Map();
    const activeChildTimeouts = new Map();
    const pendingStepSteers = [];
    const emittedControlEventKeys = new Set();
    const observedIdleSince = status.initialStatusSteps.map(() => undefined);
    const observedActivityAt = status.initialStatusSteps.map(() => undefined);
    const mutatingFailureStates = status.initialStatusSteps.map(() => createMutatingFailureState());
    const runtimeModelContexts = status.initialStatusSteps.map(() => undefined);
    const activeConfiguredModels = status.initialStatusSteps.map(() => undefined);
    const pendingToolResults = status.initialStatusSteps.map(() => undefined);
    const mutatingFailureWindowMs = 5 * 60_000;
    let activityTimer;
    let lastMonitorTickAt;
    function registerStepInterrupt(flatIndex, interrupt) {
        if (!interrupt) {
            activeChildInterrupts.delete(flatIndex);
            return;
        }
        activeChildInterrupts.set(flatIndex, interrupt);
        if (status.interrupted)
            interrupt();
    }
    function registerStepTimeout(flatIndex, interrupt) {
        if (!interrupt) {
            activeChildTimeouts.delete(flatIndex);
            return;
        }
        activeChildTimeouts.set(flatIndex, interrupt);
        if (status.timedOut)
            interrupt();
    }
    function interruptActiveChildren() {
        for (const interrupt of Array.from(activeChildInterrupts.values()))
            interrupt();
    }
    function timeoutActiveChildren() {
        for (const interrupt of Array.from(activeChildTimeouts.values()))
            interrupt();
    }
    function* nestedRuns(children) {
        for (const child of children ?? []) {
            yield child;
            yield* nestedRuns(child.children);
            yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
        }
    }
    function interruptNestedAsyncDescendants() {
        if (!nestedRoute)
            return;
        let registry;
        try {
            registry = projectNestedEvents(nestedRoute);
        }
        catch (error) {
            appendEvent(JSON.stringify({
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
            const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(nestedRoute.rootRunId, run);
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
                appendEvent(JSON.stringify({
                    type: "subagent.nested.interrupt_failed",
                    ts: Date.now(),
                    runId: id,
                    targetRunId: run.id,
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    }
    function hasLiveNestedAsyncDescendants() {
        if (!nestedRoute)
            return false;
        try {
            return [...nestedRuns(projectNestedEvents(nestedRoute).children)].some((run) => run.state === "running" || run.state === "queued");
        }
        catch {
            return true;
        }
    }
    function timeoutNestedAsyncDescendants() {
        if (!nestedRoute)
            return;
        let registry;
        try {
            registry = projectNestedEvents(nestedRoute);
        }
        catch (error) {
            appendEvent(JSON.stringify({
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
            const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(nestedRoute.rootRunId, run);
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
                appendEvent(JSON.stringify({
                    type: "subagent.nested.timeout_failed",
                    ts: Date.now(),
                    runId: id,
                    targetRunId: run.id,
                    message: error instanceof Error ? error.message : String(error),
                }));
            }
        }
    }
    function appendControlEvent(event) {
        if (!controlConfig.enabled)
            return;
        const channels = controlConfig.notifyChannels;
        if (channels.length === 0 ||
            !claimControlNotification(controlConfig, event, emittedControlEventKeys))
            return;
        appendEvent(JSON.stringify({
            type: "subagent.control",
            event,
            channels,
            noticeText: formatControlNoticeMessage(event),
        }));
    }
    function syncTopLevelCurrentTool() {
        const activeStep = statusPayload.steps
            .filter((step) => step.status === "running" &&
            typeof step.currentTool === "string" &&
            step.currentTool.length > 0)
            .sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
        statusPayload.currentTool = activeStep?.currentTool;
        statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
        statusPayload.currentPath = activeStep?.currentPath;
    }
    function maybeEmitActiveLongRunning(flatIndex, now) {
        if (!controlConfig.enabled)
            return false;
        const step = statusPayload.steps[flatIndex];
        if (!step || step.status !== "running")
            return false;
        const reason = nextLongRunningTrigger(controlConfig, {
            startedAt: step.startedAt ?? overallStartTime,
            now,
            turns: step.turnCount ?? 0,
            tokens: step.tokens?.total ?? 0,
        });
        if (!reason)
            return false;
        const previous = step.activityState;
        const transition = status.transitionStepHealth(flatIndex, { type: "active_long_running" });
        if (!transition.activeLongRunningNotice)
            return false;
        appendControlEvent(buildControlEvent({
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
        }));
        return true;
    }
    function deliverChildMessageRequest(request) {
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
            status.writeStatusPayload();
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
        appendEvent(JSON.stringify({
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
    }
    function flushPendingStepSteers(flatIndex) {
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
    }
    function updateStepModel(flatIndex, attempt, now = Date.now()) {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        status.resetStepHealth(flatIndex);
        observedIdleSince[flatIndex] = now;
        observedActivityAt[flatIndex] = step.lastActivityAt;
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
        status.writeStatusPayload();
    }
    function updateStepFromChildEvent(flatIndex, event) {
        const step = statusPayload.steps[flatIndex];
        if (!step)
            return;
        const now = Date.now();
        observedIdleSince[flatIndex] = now;
        status.transitionStepHealth(flatIndex, { type: "validated_activity" });
        if (event.type === "compaction_start") {
            status.transitionStepHealth(flatIndex, { type: "compaction_start", reason: event.reason });
        }
        else if (event.type === "compaction_end") {
            status.transitionStepHealth(flatIndex, { type: "compaction_end" });
        }
        statusPayload.currentStep = flatIndex;
        if (event.type === "tool_execution_start" && event.toolName) {
            const supervisorPause = resolveSupervisorPauseMetadata({
                toolName: event.toolName,
                toolArgs: event.args,
                requestedAt: now,
            });
            if (supervisorPause?.kind === "awaiting_supervisor")
                status.requestSupervisorPause(flatIndex, supervisorPause);
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
                    shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention)) {
                    const previous = step.activityState;
                    status.transitionStepHealth(flatIndex, {
                        type: "durable_attention",
                        reason: "tool_failures",
                    });
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
                status.writeStatusPayload();
                if (controlConfig.enabled) {
                    const previousActivityState = step.activityState;
                    status.transitionStepHealth(flatIndex, {
                        type: "durable_attention",
                        reason: "context_pressure",
                    });
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
                const inputTokens = childUsageNumber(usage, "input", "inputTokens");
                const outputTokens = childUsageNumber(usage, "output", "outputTokens");
                const previousInput = step.tokens?.input ?? 0;
                const previousOutput = step.tokens?.output ?? 0;
                step.tokens = {
                    input: previousInput + inputTokens,
                    output: previousOutput + outputTokens,
                    total: previousInput + previousOutput + inputTokens + outputTokens,
                };
                const totalInput = statusPayload.totalTokens?.input ?? 0;
                const totalOutput = statusPayload.totalTokens?.output ?? 0;
                statusPayload.totalTokens = {
                    input: totalInput + inputTokens,
                    output: totalOutput + outputTokens,
                    total: totalInput + totalOutput + inputTokens + outputTokens,
                };
            }
            statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
        }
        syncTopLevelCurrentTool();
        step.lastActivityAt = now;
        observedActivityAt[flatIndex] = now;
        statusPayload.lastActivityAt = now;
        statusPayload.lastUpdate = now;
        maybeEmitActiveLongRunning(flatIndex, now);
        status.syncTopLevelHealthProjection();
        status.writeStatusPayload();
    }
    function appendRecentStepOutput(step, lines) {
        const nonEmpty = lines.filter((line) => line.trim());
        if (nonEmpty.length === 0)
            return;
        step.recentOutput ??= [];
        step.recentOutput.push(...nonEmpty);
        if (step.recentOutput.length > 50)
            step.recentOutput.splice(0, step.recentOutput.length - 50);
    }
    function stepOutputActivityAt(index) {
        const step = statusPayload.steps[index];
        let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
        const outputPath = path.join(asyncDir, `output-${index}.log`);
        try {
            lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                console.error(`Failed to inspect async output file '${outputPath}':`, error);
        }
        return lastActivityAt;
    }
    function appendMonitorGapDiagnostic(now, gapMs) {
        const line = JSON.stringify({
            type: MONITOR_GAP_DIAGNOSTIC_TYPE,
            ts: now,
            runId: id,
            gapMs,
        });
        if (appendDiagnosticEvent)
            appendDiagnosticEvent(line, MONITOR_GAP_DIAGNOSTIC_TYPE);
        else
            appendEvent(line);
    }
    function updateRunnerActivityState(now) {
        if (!controlConfig.enabled)
            return false;
        const previousMonitorTickAt = lastMonitorTickAt;
        const { gapMs: monitorGapMs, detected: monitorGapDetected } = getActivityMonitorGap(previousMonitorTickAt, now);
        lastMonitorTickAt = now;
        let changed = false;
        let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
        if (monitorGapDetected && statusPayload.steps.some((step) => step.status === "running"))
            appendMonitorGapDiagnostic(now, monitorGapMs);
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
            const observation = observeActivityWindow({
                previousMonitorTickAt,
                now,
                startedAt: step.startedAt ?? overallStartTime,
                activityAt: lastActivityAt,
                observedIdleSince: observedIdleSince[index],
                observedActivityAt: observedActivityAt[index],
            });
            observedIdleSince[index] = observation.observedIdleSince;
            observedActivityAt[index] = observation.observedActivityAt;
            const observedActivitySince = observation.observedIdleSince;
            const healthState = status.healthStateForStep(index);
            const idleState = healthState.compaction
                ? undefined
                : deriveActivityState({
                    config: controlConfig,
                    startedAt: step.startedAt ?? overallStartTime,
                    lastActivityAt: observedActivitySince,
                    toolCallInFlight: Boolean(step.currentTool),
                    now,
                });
            if (idleState === "needs_attention") {
                const previous = step.activityState;
                const transition = status.transitionStepHealth(index, { type: "enter_idle" });
                if (transition.idleEpisodeStarted) {
                    if (transition.idleAttentionEligible) {
                        appendControlEvent(buildControlEvent({
                            from: previous,
                            to: "needs_attention",
                            runId: id,
                            agent: step.agent,
                            index,
                            ts: now,
                            lastActivityAt,
                            elapsedMs: Math.max(0, now - observedActivitySince),
                            idleEpisodeId: transition.state.idleEpisodeId,
                        }));
                    }
                    changed = true;
                }
            }
            else if (maybeEmitActiveLongRunning(index, now))
                changed = true;
        }
        if (statusPayload.lastActivityAt !== runLastActivityAt) {
            statusPayload.lastActivityAt = runLastActivityAt;
            changed = true;
        }
        if (status.syncTopLevelHealthProjection())
            changed = true;
        statusPayload.lastUpdate = now;
        if (changed)
            status.writeStatusPayload();
        return changed;
    }
    function clearActivityState() {
        statusPayload.activityState = undefined;
    }
    function startActivityTimer() {
        if (!controlConfig.enabled)
            return;
        lastMonitorTickAt = Date.now();
        activityTimer = setInterval(() => {
            if (statusPayload.state !== "running")
                return;
            updateRunnerActivityState(Date.now());
        }, ACTIVITY_MONITOR_INTERVAL_MS);
        activityTimer.unref?.();
    }
    function disposeActivityTimer() {
        if (activityTimer)
            clearInterval(activityTimer);
        activityTimer = undefined;
    }
    function routeControlRequest(request) {
        const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
        if (targetStep?.status === "pending")
            pendingStepSteers.push(request);
        else if (request.targetIndex !== undefined ||
            statusPayload.steps.some((step) => step.status === "running"))
            deliverChildMessageRequest(request);
        else
            pendingStepSteers.push(request);
    }
    function watchControlInbox(input) {
        return watchAsyncControlInbox(asyncDir, {
            onInterrupt: input.onInterrupt,
            onTimeout: input.onTimeout,
            onSteer: routeControlRequest,
            onResume: routeControlRequest,
        });
    }
    return {
        registerStepInterrupt,
        registerStepTimeout,
        interruptActiveChildren,
        timeoutActiveChildren,
        interruptNestedAsyncDescendants,
        timeoutNestedAsyncDescendants,
        hasLiveNestedAsyncDescendants,
        appendControlEvent,
        updateStepModel,
        updateStepFromChildEvent,
        flushPendingStepSteers,
        clearActivityState,
        startActivityTimer,
        disposeActivityTimer,
        watchControlInbox,
    };
}
