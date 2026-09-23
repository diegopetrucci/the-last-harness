import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { acceptChildMessageRequest, deliverInterruptRequest, deliverTimeoutRequest, enqueueStepChildMessage, watchAsyncControlInbox, writeChildMessageAcceptanceForRequest, } from "./control-channel.js";
import { contextWindowForModel, runtimeModelReference } from "./pi-streaming.js";
import { buildControlEvent, deriveActivityState, formatControlNoticeMessage, normalizeIdleEpisodeId, shouldNotifyControlEvent, } from "../shared/subagent-control.js";
import { projectNestedEvents, resolveNestedAsyncDir } from "../shared/nested-events.js";
import { childUsageNumber } from "../shared/child-protocol.js";
import { appendRecentProgressItem } from "../../shared/recent-progress.js";
import { resolveCurrentPath } from "../shared/long-running-guard.js";
import { extractTextFromContent, extractToolArgsPreview, readStatus } from "../../shared/utils.js";
import { canonicalSubagentModelIdentity } from "../shared/model-fallback.js";
import { resolveRuntimeModelContext } from "../../shared/model-info.js";
import { detectContextPressureCrossing, formatContextPressureGuidance, updateContextUsageDiagnostics, } from "../../shared/context-diagnostics.js";
import { boundSupervisorSummary, lifecycleGeneration } from "../shared/lifecycle-state.js";
const ACTIVITY_MONITOR_INTERVAL_MS = 1_000;
function latestTimestamp(...values) {
    const finite = values.filter((value) => value !== undefined && Number.isFinite(value));
    return finite.length ? Math.max(...finite) : undefined;
}
const MAX_ATTENTION_CLAIMS_PER_SCOPE = 32;
const SAFE_LIFECYCLE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function boundedEpisode(value) {
    const episode = normalizeIdleEpisodeId(value);
    if (!episode)
        return undefined;
    if (SAFE_LIFECYCLE_TOKEN.test(episode))
        return episode;
    return `legacy-${createHash("sha256").update(episode, "utf8").digest("hex")}`;
}
function pruneAttentionClaims(dir, prefix) {
    let files;
    try {
        files = fs
            .readdirSync(dir)
            .filter((name) => name.startsWith(prefix) && name.endsWith(".claim"));
    }
    catch {
        return;
    }
    if (files.length <= MAX_ATTENTION_CLAIMS_PER_SCOPE)
        return;
    files.sort((left, right) => {
        try {
            return fs.statSync(path.join(dir, left)).mtimeMs - fs.statSync(path.join(dir, right)).mtimeMs;
        }
        catch {
            return 0;
        }
    });
    for (const file of files.slice(0, -MAX_ATTENTION_CLAIMS_PER_SCOPE)) {
        try {
            fs.unlinkSync(path.join(dir, file));
        }
        catch {
        }
    }
}
export function claimAttentionNotification(asyncDir, input) {
    if (!Number.isSafeInteger(input.generation) || input.generation < 0)
        return false;
    const episode = boundedEpisode(input.episode);
    if (!episode)
        return false;
    const scope = `${input.generation}-${input.index ?? "run"}-`;
    const key = `${scope}${episode}`.replace(/[^A-Za-z0-9._:~-]/g, "_");
    try {
        const dir = path.join(asyncDir, "control", "attention-claims");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.closeSync(fs.openSync(path.join(dir, `${key}.claim`), "wx", 0o600));
        pruneAttentionClaims(dir, scope);
        return true;
    }
    catch {
        return false;
    }
}
function resolveSupervisorPauseMetadata(input) {
    if (input.toolName !== "contact_supervisor" ||
        (input.toolArgs?.reason !== "need_decision" && input.toolArgs?.reason !== "interview_request"))
        return undefined;
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
export function createBackgroundRunControlOwner(input) {
    const { status, id, asyncDir, overallStartTime, controlConfig, nestedRoute, appendEvent } = input;
    const statusPayload = status.statusPayload;
    const flatSteps = status.flatSteps;
    const activeChildInterrupts = new Map();
    const activeChildTimeouts = new Map();
    const pendingStepSteers = [];
    const observedIdleSince = statusPayload.steps.map((step) => latestTimestamp(step.lastActivityAt, step.startedAt, overallStartTime));
    const runtimeModelContexts = statusPayload.steps.map(() => undefined);
    const activeConfiguredModels = statusPayload.steps.map(() => undefined);
    let activityTimer;
    function register(map, index, interrupt, active) {
        if (!interrupt)
            map.delete(index);
        else {
            map.set(index, interrupt);
            if (active)
                interrupt();
        }
    }
    function registerStepInterrupt(index, interrupt) {
        register(activeChildInterrupts, index, interrupt, status.interrupted || status.cancelled);
    }
    function registerStepTimeout(index, interrupt) {
        register(activeChildTimeouts, index, interrupt, status.timedOut);
    }
    function interruptActiveChildren() {
        for (const interrupt of activeChildInterrupts.values())
            interrupt();
    }
    function timeoutActiveChildren() {
        for (const interrupt of activeChildTimeouts.values())
            interrupt();
    }
    function* nestedRuns(children) {
        for (const child of children ?? []) {
            yield child;
            yield* nestedRuns(child.children);
            yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
        }
    }
    function nestedSignalFailure(kind, targetRunId) {
        appendEvent(JSON.stringify({
            type: `subagent.nested.${kind}_failed`,
            ts: Date.now(),
            runId: id,
            ...(targetRunId ? { targetRunId } : { message: "Unable to inspect nested runs." }),
        }));
    }
    function signalNestedDescendants(kind) {
        if (!nestedRoute)
            return;
        let children;
        try {
            children = projectNestedEvents(nestedRoute).children;
        }
        catch {
            nestedSignalFailure(kind);
            return;
        }
        for (const run of nestedRuns(children)) {
            if (run.state !== "running" && run.state !== "queued")
                continue;
            const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(nestedRoute.rootRunId, run);
            if (!nestedAsyncDir)
                continue;
            try {
                const request = {
                    asyncDir: nestedAsyncDir,
                    pid: run.pid,
                    source: kind === "interrupt" ? "ancestor-interrupt" : "ancestor-timeout",
                };
                if (kind === "interrupt")
                    deliverInterruptRequest(request);
                else
                    deliverTimeoutRequest(request);
            }
            catch {
                nestedSignalFailure(kind, run.id);
            }
        }
    }
    function interruptNestedAsyncDescendants() {
        signalNestedDescendants("interrupt");
    }
    function timeoutNestedAsyncDescendants() {
        signalNestedDescendants("timeout");
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
    function appendControlEvent(event) {
        if (statusPayload.state !== "running" ||
            controlConfig.notifyChannels.length === 0 ||
            !shouldNotifyControlEvent(controlConfig, event))
            return;
        const withGeneration = { ...event, generation: lifecycleGeneration(statusPayload) };
        const episode = withGeneration.idleEpisodeId ??
            (withGeneration.reason === "context_pressure"
                ? `context-${withGeneration.contextPressureThreshold ?? "unknown"}`
                : `idle-${withGeneration.ts}`);
        if (!claimAttentionNotification(asyncDir, {
            generation: withGeneration.generation ?? 0,
            episode,
            index: withGeneration.index,
        }))
            return;
        appendEvent(JSON.stringify({
            type: "subagent.control",
            event: withGeneration,
            channels: controlConfig.notifyChannels,
            noticeText: formatControlNoticeMessage(withGeneration),
        }));
    }
    function syncTopLevelCurrentTool() {
        let active;
        for (const step of statusPayload.steps) {
            if (step.status !== "running" ||
                !step.currentTool ||
                (step.currentToolStartedAt ?? 0) < (active?.currentToolStartedAt ?? 0))
                continue;
            active = step;
        }
        statusPayload.currentTool = active?.currentTool;
        statusPayload.currentToolStartedAt = active?.currentToolStartedAt;
        statusPayload.currentPath = active?.currentPath;
    }
    function markActivity(index, now) {
        const step = statusPayload.steps[index];
        if (!step)
            return undefined;
        const previous = latestTimestamp(observedIdleSince[index], step.lastActivityAt, step.startedAt, overallStartTime) ?? 0;
        const activityAt = Math.max(now, step.lastActivityAt ?? 0, previous + 1);
        observedIdleSince[index] = activityAt;
        step.activityState = undefined;
        step.idleEpisodeId = undefined;
        step.lastActivityAt = activityAt;
        statusPayload.lastActivityAt = Math.max(statusPayload.lastActivityAt ?? 0, activityAt);
        return step;
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
        for (const index of accepted) {
            const step = markActivity(index, now);
            if (step && request.type === "steer") {
                step.steerCount = (step.steerCount ?? 0) + 1;
                step.lastSteerAt = now;
            }
        }
        if (accepted.length) {
            if (request.type === "steer") {
                statusPayload.steerCount = (statusPayload.steerCount ?? 0) + accepted.length;
                statusPayload.lastSteerAt = now;
            }
            statusPayload.lastUpdate = now;
            status.writeStatusPayload();
        }
        writeChildMessageAcceptanceForRequest(asyncDir, request, {
            status: accepted.length ? "accepted" : "rejected",
            ts: now,
            acceptedIndexes: accepted,
            ...(rejected.length ? { rejected } : {}),
            ...(accepted.length
                ? {}
                : { reason: rejected[0]?.reason ?? "no running child accepted the request" }),
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
    function flushPendingStepSteers(index) {
        const remaining = [];
        for (const request of pendingStepSteers.splice(0)) {
            if (request.targetIndex === undefined || request.targetIndex === index)
                deliverChildMessageRequest({ ...request, targetIndex: index });
            else
                remaining.push(request);
        }
        pendingStepSteers.push(...remaining);
    }
    function updateStepModel(index, attempt, now = Date.now()) {
        const step = markActivity(index, now);
        if (!step)
            return;
        step.compaction = undefined;
        runtimeModelContexts[index] = undefined;
        activeConfiguredModels[index] = attempt.model;
        step.model = attempt.model;
        step.thinking = attempt.modelIdentity ? attempt.modelIdentity.thinking : attempt.thinking;
        step.modelIdentity =
            attempt.modelIdentity ?? canonicalSubagentModelIdentity(attempt.model, attempt.thinking);
        if (attempt.modelResolution)
            step.modelResolution = attempt.modelResolution;
        if (attempt.attemptedModels?.length)
            step.attemptedModels = attempt.attemptedModels;
        if (attempt.modelAttempts?.length)
            step.modelAttempts = attempt.modelAttempts;
        statusPayload.lastUpdate = now;
        status.writeStatusPayload();
    }
    function updateStepFromChildEvent(index, event) {
        let step = markActivity(index, Date.now());
        if (!step)
            return;
        const now = step.lastActivityAt ?? Date.now();
        statusPayload.currentStep = index;
        const pressureCrossings = [];
        if (event.type === "compaction_start") {
            if (!step.compaction)
                step.compaction = { reason: event.reason };
        }
        else if (event.type === "compaction_end") {
            if (step.compaction?.reason === event.reason)
                step.compaction = undefined;
        }
        else if (event.type === "tool_execution_start" && event.toolName) {
            const pause = resolveSupervisorPauseMetadata({
                toolName: event.toolName,
                toolArgs: event.args,
                requestedAt: now,
            });
            if (pause?.kind === "awaiting_supervisor") {
                status.requestSupervisorPause(index, pause);
                step = statusPayload.steps[index];
                if (!step)
                    return;
            }
            step.toolCount = (step.toolCount ?? 0) + 1;
            step.currentTool = event.toolName;
            step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
            step.currentToolStartedAt = now;
            step.currentPath = resolveCurrentPath(event.toolName, event.args);
            statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
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
        }
        else if (event.type === "tool_result_end" && event.message)
            appendRecentStepOutput(step, extractTextFromContent(event.message.content).split("\n").slice(-10));
        else if (event.type === "message_end" && event.message?.role === "assistant") {
            appendRecentStepOutput(step, extractTextFromContent(event.message.content).split("\n").slice(-10));
            step.turnCount = (step.turnCount ?? 0) + 1;
            const configuredModel = activeConfiguredModels[index];
            const configuredContextWindow = contextWindowForModel(configuredModel, flatSteps[index]?.contextWindows);
            let runtimeModelContext = runtimeModelContexts[index];
            if (!configuredModel && runtimeModelContext === undefined) {
                runtimeModelContext = resolveRuntimeModelContext(event.message.provider, event.message.model, flatSteps[index]?.contextWindows);
                if (runtimeModelContext) {
                    runtimeModelContexts[index] = runtimeModelContext;
                    step.model = runtimeModelReference(runtimeModelContext.identity);
                    step.thinking = runtimeModelContext.identity.thinking;
                    step.modelIdentity = runtimeModelContext.identity;
                }
            }
            step.contextUsage = updateContextUsageDiagnostics(step.contextUsage, event.message, {
                restored: false,
                contextWindow: configuredContextWindow ?? runtimeModelContext?.contextWindow,
            });
            while (true) {
                const pressure = detectContextPressureCrossing(step.contextUsage, step.contextPressureCrossedThresholds ?? [], now);
                if (!pressure)
                    break;
                step.contextPressureCrossedThresholds = [
                    ...(step.contextPressureCrossedThresholds ?? []),
                    pressure.crossedThreshold,
                ];
                step.contextPressure = pressure;
                pressureCrossings.push(pressure);
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
        statusPayload.lastActivityAt = Math.max(statusPayload.lastActivityAt ?? 0, now);
        statusPayload.lastUpdate = now;
        status.writeStatusPayload();
        const persistedStep = statusPayload.steps[index];
        if (!persistedStep)
            return;
        const flatStep = flatSteps[index];
        if (flatStep) {
            flatStep.contextPressure = persistedStep.contextPressure
                ? { ...persistedStep.contextPressure }
                : undefined;
            flatStep.contextPressureCrossedThresholds = persistedStep.contextPressureCrossedThresholds
                ? [...persistedStep.contextPressureCrossedThresholds]
                : undefined;
        }
        for (const pressure of pressureCrossings)
            appendControlEvent(buildControlEvent({
                type: "needs_attention",
                to: "needs_attention",
                runId: id,
                agent: persistedStep.agent,
                index,
                ts: now,
                message: formatContextPressureGuidance(pressure),
                contextPressureSeverity: pressure.severity,
                contextPressureThreshold: pressure.crossedThreshold,
                reason: "context_pressure",
                turns: persistedStep.turnCount,
                tokens: persistedStep.tokens?.total,
                toolCount: persistedStep.toolCount,
            }));
    }
    function appendRecentStepOutput(step, lines) {
        const nonEmpty = lines.filter((line) => line.trim());
        if (!nonEmpty.length)
            return;
        step.recentOutput ??= [];
        step.recentOutput.push(...nonEmpty);
        if (step.recentOutput.length > 50)
            step.recentOutput.splice(0, step.recentOutput.length - 50);
    }
    function updateRunnerActivityState(now) {
        if (!controlConfig.enabled || statusPayload.state !== "running")
            return false;
        let persisted = null;
        try {
            persisted = readStatus(asyncDir, { cache: false });
        }
        catch {
        }
        if (persisted && persisted.state !== "running") {
            status.adoptConcurrentTerminalStatus();
            return false;
        }
        let changed = false;
        let runLastActivityAt = latestTimestamp(statusPayload.lastActivityAt, overallStartTime) ?? overallStartTime;
        for (const [index, step] of statusPayload.steps.entries()) {
            if (step.status !== "running")
                continue;
            const diskStep = persisted?.steps?.[index];
            const diskActivity = diskStep?.lastActivityAt;
            const idleSince = latestTimestamp(observedIdleSince[index], step.lastActivityAt, step.startedAt, overallStartTime) ?? overallStartTime;
            if (diskActivity !== undefined && diskActivity > idleSince) {
                observedIdleSince[index] = diskActivity;
                step.lastActivityAt = diskActivity;
                step.activityState = diskStep?.activityState;
                step.idleEpisodeId = diskStep?.idleEpisodeId;
                if (diskStep?.currentTool !== undefined)
                    step.currentTool = diskStep.currentTool;
                else if (step.currentTool && diskStep)
                    step.currentTool = undefined;
            }
            const activityAt = latestTimestamp(observedIdleSince[index], idleSince) ?? idleSince;
            runLastActivityAt = Math.max(runLastActivityAt, activityAt);
            if (deriveActivityState({
                config: controlConfig,
                startedAt: step.startedAt ?? overallStartTime,
                lastActivityAt: activityAt,
                toolCallInFlight: Boolean(step.currentTool),
                compactionInFlight: Boolean(step.compaction),
                now,
            }) !== "needs_attention" ||
                step.activityState === "needs_attention")
                continue;
            const idleEpisodeId = step.idleEpisodeId ?? `idle-${activityAt}`;
            step.idleEpisodeId = idleEpisodeId;
            step.activityState = "needs_attention";
            changed = true;
            appendControlEvent(buildControlEvent({
                to: "needs_attention",
                runId: id,
                agent: step.agent,
                index,
                ts: now,
                lastActivityAt: activityAt,
                elapsedMs: Math.max(0, now - activityAt),
                reason: "idle",
                idleEpisodeId,
            }));
        }
        if (statusPayload.lastActivityAt !== runLastActivityAt) {
            statusPayload.lastActivityAt = runLastActivityAt;
            changed = true;
        }
        statusPayload.lastUpdate = now;
        if (changed)
            status.writeStatusPayload();
        return changed;
    }
    function clearActivityState() {
        const now = Date.now();
        for (const step of statusPayload.steps) {
            step.activityState = undefined;
            step.idleEpisodeId = undefined;
            step.compaction = undefined;
        }
        for (let index = 0; index < observedIdleSince.length; index++)
            observedIdleSince[index] = now;
        statusPayload.activityState = undefined;
    }
    function startActivityTimer() {
        if (!controlConfig.enabled || activityTimer)
            return;
        activityTimer = setInterval(() => updateRunnerActivityState(Date.now()), ACTIVITY_MONITOR_INTERVAL_MS);
        activityTimer.unref?.();
    }
    function disposeActivityTimer() {
        if (activityTimer)
            clearInterval(activityTimer);
        activityTimer = undefined;
    }
    function routeControlRequest(request) {
        const target = request.targetIndex === undefined ? undefined : statusPayload.steps[request.targetIndex];
        if (target?.status === "pending" ||
            (request.targetIndex === undefined &&
                !statusPayload.steps.some((step) => step.status === "running")))
            pendingStepSteers.push(request);
        else
            deliverChildMessageRequest(request);
    }
    function watchControlInbox(watchInput) {
        return watchAsyncControlInbox(asyncDir, {
            onInterrupt: watchInput.onInterrupt,
            onTimeout: watchInput.onTimeout,
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
        updateStepModel,
        updateStepFromChildEvent,
        flushPendingStepSteers,
        clearActivityState,
        startActivityTimer,
        disposeActivityTimer,
        watchControlInbox,
    };
}
