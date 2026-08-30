import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { resolveHeartbeatConfig } from "../runs/shared/heartbeat-config.js";
import { createHeartbeatController, } from "../runs/shared/heartbeat-controller.js";
import { getAgentDir } from "../shared/utils.js";
const ASYNC_TERMINAL_STATUSES = new Set(["complete", "failed", "paused", "cancelled", "continued"]);
export function countLiveAsyncRuns(asyncJobs) {
    let count = 0;
    for (const job of asyncJobs.values()) {
        if (!ASYNC_TERMINAL_STATUSES.has(job.status))
            count++;
    }
    return count;
}
function createAccumulator(gapId, sessionId) {
    return {
        gapId,
        sessionId,
        executedBeats: 0,
        cacheReadBeats: 0,
        totalBeatCostUsd: 0,
        totalCacheReadTokens: 0,
        avoidedCostUsd: 0,
        terminatedLost: false,
    };
}
function verdictFrom(acc) {
    if (acc.terminatedLost)
        return "lost";
    if (acc.cacheReadBeats > 0)
        return "saved";
    if (acc.executedBeats > 0)
        return "wasted";
    return "unneeded";
}
function appendGapSummaryRecord(acc, logPath, appendFile, mkdir) {
    const verdict = verdictFrom(acc);
    const record = {
        type: "gap_summary",
        ts: Date.now(),
        sessionId: acc.sessionId,
        gapId: acc.gapId,
        beats: acc.executedBeats,
        beatCostUsd: acc.totalBeatCostUsd,
        avoidedCostUsd: acc.avoidedCostUsd,
        verdict,
    };
    if (logPath) {
        try {
            mkdir(path.dirname(logPath), { recursive: true });
            appendFile(logPath, JSON.stringify(record) + "\n");
        }
        catch {
        }
    }
    return record;
}
function resolvedDefaultLogPath() {
    return path.join(getAgentDir(), "subagents", "heartbeat.jsonl");
}
export function createHeartbeatWiring(pi, config, deps = {}) {
    const resolved = resolveHeartbeatConfig(config.heartbeat);
    if (!resolved.enabled) {
        return {
            onProviderRequest() { },
            onIdle() { },
            notifyAsyncStarted() { },
            notifyAsyncComplete() {
                return false;
            },
            disarm() { },
            destroy() { },
            tryRearm() { },
            resetSession() { },
            getSessionSummary() {
                return {
                    enabled: false,
                    totalBeats: 0,
                    totalCacheReadTokens: 0,
                    totalBeatCostUsd: 0,
                    gapsSaved: 0,
                    gapsWasted: 0,
                    gapsLost: 0,
                    gapsUnneeded: 0,
                    breakerDisabled: false,
                };
            },
        };
    }
    const nowFn = deps.now ?? Date.now;
    const resolvedLogPath = Object.hasOwn(deps, "logPath")
        ? (deps.logPath ?? undefined)
        : resolvedDefaultLogPath();
    const appendFileSyncBase = deps.appendFileSync ?? ((file, data) => fs.appendFileSync(file, data));
    const mkdirSyncBase = deps.mkdirSync ?? ((dir, options) => fs.mkdirSync(dir, options));
    let sessionTotalBeats = 0;
    let sessionTotalCacheReadTokens = 0;
    let sessionTotalBeatCostUsd = 0;
    let sessionGapsSaved = 0;
    let sessionGapsWasted = 0;
    let sessionGapsLost = 0;
    let sessionGapsUnneeded = 0;
    let sessionBreakerDisabled = false;
    let currentGap = null;
    let isIdleState = false;
    pi.registerEntryRenderer("heartbeat-gap-summary", (entry, _options, theme) => {
        const d = entry.data;
        if (!d)
            return undefined;
        const verdictIcon = d.verdict === "saved" ? theme.fg("success", "♥") : theme.fg("dim", "♥");
        const beatsLabel = d.beats === 1 ? "1 beat" : `${d.beats} beats`;
        const parts = [beatsLabel];
        if (d.beatCostUsd > 0)
            parts.push(`$${d.beatCostUsd.toFixed(5)} cost`);
        if (d.avoidedCostUsd > 0)
            parts.push(`~$${d.avoidedCostUsd.toFixed(5)} saved`);
        const summary = parts.join(" · ");
        return new Text(`${verdictIcon} Heartbeat [${d.verdict}]: ${summary}`, 0, 0);
    });
    function onBeatIssued(gapId) {
        if (!currentGap || gapId !== currentGap.gapId)
            return;
        currentGap.executedBeats++;
    }
    function onGapLost(gapId) {
        if (!currentGap || gapId !== currentGap.gapId)
            return;
        currentGap.terminatedLost = true;
    }
    function onBeatAccounting(accounting) {
        if (!currentGap || accounting.gapId !== currentGap.gapId)
            return;
        const acc = currentGap;
        if (accounting.outcome === "cache_read") {
            acc.cacheReadBeats++;
            acc.totalCacheReadTokens += accounting.usage.cacheRead;
            const model = accounting.model;
            if (model.cost) {
                const savedPerToken = model.cost.input - model.cost.cacheRead;
                if (savedPerToken > 0) {
                    acc.avoidedCostUsd = (accounting.usage.cacheRead * savedPerToken) / 1_000_000;
                }
            }
            if (typeof accounting.estCostUsd === "number") {
                acc.totalBeatCostUsd += accounting.estCostUsd;
            }
        }
        else if (accounting.outcome === "error") {
            if (typeof accounting.estCostUsd === "number") {
                acc.totalBeatCostUsd += accounting.estCostUsd;
            }
        }
        else if (accounting.outcome === "cache_write_mismatch") {
            if (typeof accounting.estCostUsd === "number") {
                acc.totalBeatCostUsd += accounting.estCostUsd;
            }
        }
    }
    function onBeatResult(result) {
        if (!currentGap || result.gapId !== currentGap.gapId)
            return;
        if (result.sessionDisabled) {
            sessionBreakerDisabled = true;
        }
    }
    const controllerDeps = {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
        ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
        ...(deps.appendFileSync ? { appendFileSync: deps.appendFileSync } : {}),
        ...(deps.mkdirSync ? { mkdirSync: deps.mkdirSync } : {}),
        ...(resolvedLogPath !== undefined ? { logPath: resolvedLogPath } : { logPath: null }),
        ...(deps.streamProvider ? { streamProvider: deps.streamProvider } : {}),
        ...(deps.getModelRegistry ? { getModelRegistry: deps.getModelRegistry } : {}),
        onBeatIssued,
        onBeatAccounting,
        onBeatResult,
        onGapLost,
    };
    const controller = createHeartbeatController(resolved, controllerDeps);
    function closeGapWithSummary(emitSessionEntry) {
        if (!currentGap)
            return;
        const acc = currentGap;
        currentGap = null;
        controller.endGap();
        const record = appendGapSummaryRecord(acc, resolvedLogPath, appendFileSyncBase, mkdirSyncBase);
        sessionTotalBeats += acc.executedBeats;
        sessionTotalCacheReadTokens += acc.totalCacheReadTokens;
        sessionTotalBeatCostUsd += acc.totalBeatCostUsd;
        const verdict = record.verdict;
        if (verdict === "saved")
            sessionGapsSaved++;
        else if (verdict === "wasted")
            sessionGapsWasted++;
        else if (verdict === "lost")
            sessionGapsLost++;
        else
            sessionGapsUnneeded++;
        if (emitSessionEntry && acc.executedBeats > 0) {
            try {
                pi.appendEntry("heartbeat-gap-summary", {
                    ts: record.ts,
                    sessionId: acc.sessionId,
                    gapId: acc.gapId,
                    beats: record.beats,
                    beatCostUsd: record.beatCostUsd,
                    avoidedCostUsd: record.avoidedCostUsd,
                    verdict,
                });
            }
            catch {
            }
        }
    }
    function openGapIfNeeded(sessionId) {
        if (currentGap)
            return;
        const sid = sessionId ?? "";
        const gapId = `${sid}-${nowFn()}`;
        currentGap = createAccumulator(gapId, sid);
        controller.startGap(gapId, sid);
    }
    return {
        onProviderRequest(payload, model) {
            controller.onProviderRequest(payload, model);
        },
        onIdle(idle) {
            isIdleState = idle;
            controller.onIdle(idle);
        },
        notifyAsyncStarted(liveRunsBefore, sessionId) {
            if (liveRunsBefore === 0) {
                openGapIfNeeded(sessionId);
            }
        },
        notifyAsyncComplete(completingId, asyncJobs) {
            if (!currentGap)
                return false;
            let liveAfter = 0;
            for (const job of asyncJobs.values()) {
                if (completingId !== undefined && job.asyncId === completingId)
                    continue;
                if (!ASYNC_TERMINAL_STATUSES.has(job.status))
                    liveAfter++;
            }
            if (liveAfter === 0) {
                closeGapWithSummary(true);
                return true;
            }
            return false;
        },
        disarm() {
            closeGapWithSummary(true);
        },
        destroy() {
            if (currentGap) {
                const acc = currentGap;
                currentGap = null;
                appendGapSummaryRecord(acc, resolvedLogPath, appendFileSyncBase, mkdirSyncBase);
                sessionTotalBeats += acc.executedBeats;
                sessionTotalCacheReadTokens += acc.totalCacheReadTokens;
                sessionTotalBeatCostUsd += acc.totalBeatCostUsd;
                const verdict = verdictFrom(acc);
                if (verdict === "saved")
                    sessionGapsSaved++;
                else if (verdict === "wasted")
                    sessionGapsWasted++;
                else if (verdict === "lost")
                    sessionGapsLost++;
                else
                    sessionGapsUnneeded++;
            }
            controller.destroy();
        },
        tryRearm(liveRunCount, sessionId) {
            if (!isIdleState || liveRunCount <= 0 || currentGap)
                return;
            openGapIfNeeded(sessionId);
        },
        resetSession() {
            currentGap = null;
            isIdleState = false;
            sessionTotalBeats = 0;
            sessionTotalCacheReadTokens = 0;
            sessionTotalBeatCostUsd = 0;
            sessionGapsSaved = 0;
            sessionGapsWasted = 0;
            sessionGapsLost = 0;
            sessionGapsUnneeded = 0;
            sessionBreakerDisabled = false;
            controller.resetSession();
        },
        getSessionSummary() {
            const activeGap = currentGap;
            return {
                enabled: true,
                totalBeats: sessionTotalBeats + (activeGap?.executedBeats ?? 0),
                totalCacheReadTokens: sessionTotalCacheReadTokens + (activeGap?.totalCacheReadTokens ?? 0),
                totalBeatCostUsd: sessionTotalBeatCostUsd + (activeGap?.totalBeatCostUsd ?? 0),
                gapsSaved: sessionGapsSaved,
                gapsWasted: sessionGapsWasted,
                gapsLost: sessionGapsLost,
                gapsUnneeded: sessionGapsUnneeded,
                breakerDisabled: sessionBreakerDisabled,
            };
        },
    };
}
