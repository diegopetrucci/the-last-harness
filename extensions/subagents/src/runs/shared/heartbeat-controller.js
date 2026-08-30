import * as fs from "node:fs";
import * as path from "node:path";
import {} from "./heartbeat-config.js";
import { beginBeat, CACHE_WRITE_MISMATCH_THRESHOLD, closeGap, completeBeat, createHeartbeatState, decideBeat, MIN_REARM_DELAY_MS, openGap, recordProviderRequest, } from "./heartbeat-state.js";
import { createHeartbeatLogger, } from "./heartbeat-logger.js";
import { getAgentDir } from "../../shared/utils.js";
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const BEAT_TIMEOUT_MS = 30_000;
function defaultLogPath() {
    return path.join(getAgentDir(), "subagents", "heartbeat.jsonl");
}
function extractEventUsage(event) {
    let raw;
    if (event.type === "done") {
        raw = event.message.usage;
    }
    else if (event.type === "error") {
        raw = event.error.usage;
    }
    else {
        raw = event.partial.usage;
    }
    return {
        input: raw.input,
        cacheRead: raw.cacheRead,
        cacheWrite: raw.cacheWrite,
        output: raw.output,
    };
}
function isUsageBearing(usage) {
    return usage.input > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.output > 0;
}
function estimateCost(usage, cost) {
    return ((usage.input * cost.input +
        usage.cacheRead * cost.cacheRead +
        usage.cacheWrite * cost.cacheWrite +
        usage.output * cost.output) /
        1_000_000);
}
export function createHeartbeatController(config, deps = {}) {
    if (!config.enabled) {
        return {
            onProviderRequest() { },
            onIdle() { },
            startGap() { },
            endGap() { },
            destroy() { },
            resetSession() { },
        };
    }
    const now = deps.now ?? Date.now;
    const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const cancel = deps.clearTimeout ?? clearTimeout;
    const resolvedLogPath = Object.hasOwn(deps, "logPath")
        ? (deps.logPath ?? undefined)
        : defaultLogPath();
    const logger = createHeartbeatLogger(resolvedLogPath, {
        mkdirSync: deps.mkdirSync ?? ((dir, options) => fs.mkdirSync(dir, options)),
        appendFileSync: deps.appendFileSync ?? ((file, data) => fs.appendFileSync(file, data)),
    });
    const state = createHeartbeatState();
    let timerHandle;
    let sessionId = "";
    let isIdle = false;
    let destroyed = false;
    let capture = null;
    let beatAbortController = null;
    let gapGeneration = 0;
    function armTimer() {
        if (timerHandle !== undefined) {
            cancel(timerHandle);
            timerHandle = undefined;
        }
        if (destroyed || !state.gap)
            return;
        const elapsed = Math.max(0, now() - state.gap.lastRequestAt);
        const delay = Math.max(0, config.intervalMs - elapsed);
        timerHandle = schedule(onTimerFire, delay);
    }
    function cancelTimer() {
        if (timerHandle !== undefined) {
            cancel(timerHandle);
            timerHandle = undefined;
        }
    }
    function rearmAfterSkip() {
        if (timerHandle !== undefined) {
            cancel(timerHandle);
            timerHandle = undefined;
        }
        if (destroyed || !state.gap)
            return;
        const elapsed = Math.max(0, now() - state.gap.lastRequestAt);
        const delay = Math.max(MIN_REARM_DELAY_MS, Math.max(0, config.intervalMs - elapsed));
        timerHandle = schedule(onTimerFire, delay);
    }
    function abortInFlight() {
        if (beatAbortController) {
            beatAbortController.abort("lifecycle");
            beatAbortController = null;
        }
    }
    async function executeBeat(currentCapture, capturedGapId, capturedSessionId, capturedGeneration, capturedBeatIndex) {
        const beatStartMs = now();
        const gapId = capturedGapId;
        const sessionId = capturedSessionId;
        const beatIndex = capturedBeatIndex;
        const model = currentCapture.model;
        let outcome = "error";
        let classifyFromUsage = true;
        let usage;
        let estCostUsd;
        let lifecycleCancelled = false;
        const abortCtrl = new AbortController();
        beatAbortController = abortCtrl;
        deps.onBeatIssued?.(gapId, model);
        try {
            let stream;
            if (deps.streamProvider) {
                stream = deps.streamProvider(model, { messages: [] }, {
                    onPayload: () => currentCapture.payload,
                    signal: abortCtrl.signal,
                    maxRetries: 0,
                    timeoutMs: BEAT_TIMEOUT_MS,
                    ...(sessionId ? { sessionId } : {}),
                });
            }
            else {
                const registry = deps.getModelRegistry?.();
                if (!registry)
                    throw new Error("heartbeat: no modelRegistry or streamProvider available");
                const provider = registry.getProvider(model.provider);
                if (!provider)
                    throw new Error(`heartbeat: provider not found: ${model.provider}`);
                const auth = await registry.getApiKeyAndHeaders(model);
                if (abortCtrl.signal.aborted ||
                    destroyed ||
                    gapGeneration !== capturedGeneration ||
                    state.gap?.gapId !== capturedGapId) {
                    if (!abortCtrl.signal.aborted)
                        abortCtrl.abort("lifecycle");
                    throw new Error("heartbeat: beat invalidated during auth lookup");
                }
                if (!auth.ok)
                    throw new Error(`heartbeat: auth failed: ${auth.error}`);
                const options = {
                    onPayload: () => currentCapture.payload,
                    signal: abortCtrl.signal,
                    maxRetries: 0,
                    timeoutMs: BEAT_TIMEOUT_MS,
                    ...(sessionId ? { sessionId } : {}),
                    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
                    ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
                    ...(auth.env !== undefined ? { env: auth.env } : {}),
                };
                const streamModel = auth.baseUrl !== undefined ? { ...model, baseUrl: auth.baseUrl } : model;
                stream = provider.stream(streamModel, { messages: [] }, options);
            }
            for await (const event of stream) {
                if (abortCtrl.signal.aborted)
                    break;
                if (event.type === "start")
                    continue;
                if (event.type === "error") {
                    const eventUsage = extractEventUsage(event);
                    if (isUsageBearing(eventUsage)) {
                        usage = eventUsage;
                    }
                    classifyFromUsage = false;
                    abortCtrl.abort();
                    break;
                }
                const eventUsage = extractEventUsage(event);
                if (isUsageBearing(eventUsage)) {
                    usage = eventUsage;
                    abortCtrl.abort();
                    break;
                }
                if (event.type === "done") {
                    usage = eventUsage;
                    break;
                }
            }
            if (classifyFromUsage && usage) {
                if (usage.cacheWrite > CACHE_WRITE_MISMATCH_THRESHOLD) {
                    outcome = "cache_write_mismatch";
                }
                else if (usage.cacheRead > 0) {
                    outcome = "cache_read";
                }
            }
            try {
                if (usage) {
                    estCostUsd = estimateCost(usage, model.cost);
                }
            }
            catch {
            }
        }
        catch {
            outcome = "error";
        }
        finally {
            if (beatAbortController === abortCtrl) {
                beatAbortController = null;
            }
            abortCtrl.abort();
            lifecycleCancelled = abortCtrl.signal.reason === "lifecycle";
        }
        if (lifecycleCancelled) {
            const record = {
                ts: beatStartMs,
                sessionId,
                gapId,
                beatIndex,
                model: model.id,
                provider: model.provider,
                outcome: "cancelled",
                latencyMs: now() - beatStartMs,
            };
            logger.append(record);
            deps.onBeatCancelled?.(gapId);
            if (capturedGeneration === gapGeneration) {
                state.inFlight = false;
            }
            return;
        }
        const latencyMs = now() - beatStartMs;
        const record = {
            ts: beatStartMs,
            sessionId,
            gapId,
            beatIndex,
            model: model.id,
            provider: model.provider,
            outcome,
            ...(usage ? { usage } : {}),
            ...(estCostUsd !== undefined ? { estCostUsd } : {}),
            latencyMs,
        };
        logger.append(record);
        if (destroyed)
            return;
        if (state.gap?.gapId !== capturedGapId || gapGeneration !== capturedGeneration) {
            return;
        }
        const result = completeBeat(state, outcome, now());
        deps.onBeatResult?.({
            gapId,
            outcome,
            usage,
            estCostUsd,
            model,
            sessionDisabled: state.disabled,
        });
        if (result.stopGap) {
            closeGap(state);
            cancelTimer();
            return;
        }
        armTimer();
    }
    function onTimerFire() {
        timerHandle = undefined;
        if (destroyed)
            return;
        const decision = decideBeat(config, state, isIdle, now());
        if (decision.fire) {
            if (!capture) {
                rearmAfterSkip();
                return;
            }
            beginBeat(state);
            const currentCapture = capture;
            const capturedGapId = state.gap?.gapId ?? "unknown";
            const capturedSessionId = sessionId;
            const capturedGeneration = gapGeneration;
            const capturedBeatIndex = state.gap?.beatCount ?? 0;
            executeBeat(currentCapture, capturedGapId, capturedSessionId, capturedGeneration, capturedBeatIndex).catch(() => {
            });
            return;
        }
        if (decision.stopGap) {
            const loggableOutcomes = new Set(["lost", "capped"]);
            if (loggableOutcomes.has(decision.outcome)) {
                const gapId = state.gap?.gapId ?? "unknown";
                const record = {
                    ts: now(),
                    sessionId,
                    gapId,
                    beatIndex: state.gap?.beatCount ?? 0,
                    model: capture?.model.id ?? "",
                    provider: capture?.model.provider ?? "",
                    outcome: decision.outcome,
                };
                logger.append(record);
                if (decision.outcome === "lost") {
                    deps.onGapLost?.(gapId);
                }
            }
            closeGap(state);
            cancelTimer();
            return;
        }
        rearmAfterSkip();
    }
    return {
        onProviderRequest(payload, model) {
            if (destroyed || state.disabled)
                return;
            let serialized;
            try {
                serialized = JSON.stringify(payload);
            }
            catch {
                capture = null;
                return;
            }
            if (typeof serialized !== "string") {
                capture = null;
                return;
            }
            if (Buffer.byteLength(serialized, "utf-8") > MAX_PAYLOAD_BYTES) {
                capture = null;
                return;
            }
            try {
                capture = {
                    payload: JSON.parse(serialized),
                    model,
                    capturedAt: now(),
                };
            }
            catch {
                capture = null;
                return;
            }
            if (state.gap) {
                recordProviderRequest(state, now());
                armTimer();
            }
        },
        onIdle(idle) {
            isIdle = idle;
        },
        startGap(gapId, sid) {
            if (destroyed || state.disabled)
                return;
            sessionId = sid;
            gapGeneration++;
            state.inFlight = false;
            openGap(state, gapId, now());
            if (capture && state.gap) {
                state.gap.lastRequestAt = capture.capturedAt;
            }
            armTimer();
        },
        endGap() {
            abortInFlight();
            capture = null;
            closeGap(state);
            cancelTimer();
        },
        destroy() {
            destroyed = true;
            cancelTimer();
            abortInFlight();
        },
        resetSession() {
            gapGeneration++;
            cancelTimer();
            abortInFlight();
            capture = null;
            sessionId = "";
            isIdle = false;
            state.disabled = false;
            state.consecutiveErrors = 0;
            state.inFlight = false;
            state.gap = null;
        },
    };
}
