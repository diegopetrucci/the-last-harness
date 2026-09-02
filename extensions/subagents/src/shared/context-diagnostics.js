import { closeSync, openSync, readSync } from "node:fs";
import { findModelInfo, splitKnownThinkingSuffix } from "./model-info.js";
const DURABLE_RESUME_CONTEXT_THRESHOLD_PERCENT = 80;
const CONTEXT_EXHAUSTED_CONTEXT_THRESHOLD_PERCENT = 95;
const DEFAULT_CONTEXT_PRESSURE_THRESHOLDS = Object.freeze([
    { severity: "warning", percent: DURABLE_RESUME_CONTEXT_THRESHOLD_PERCENT },
    { severity: "critical", percent: CONTEXT_EXHAUSTED_CONTEXT_THRESHOLD_PERCENT },
]);
export const CONTEXT_EXHAUSTED_TERMINATION_MESSAGE = "Subagent stopped with an unfinished tool interaction under high context pressure.";
const KNOWN_TERMINATION_REASONS = new Set([
    "completed",
    "output_limit",
    "model_error",
    "interrupted",
    "timed_out",
    "tool_budget_blocked",
    "paused",
    "cancelled",
    "process_exit",
    "context_exhausted",
    "unknown",
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function detectContextPressureCrossing(contextUsage, crossedThresholds = [], warnedAt = Date.now()) {
    const contextTokens = finiteNonNegativeNumber(contextUsage?.contextTokens);
    const contextWindow = finiteNonNegativeNumber(contextUsage?.contextWindow);
    if (contextTokens === undefined || contextWindow === undefined || contextWindow <= 0)
        return undefined;
    const contextPercent = (contextTokens / contextWindow) * 100;
    if (!Number.isFinite(contextPercent))
        return undefined;
    const crossed = new Set(crossedThresholds);
    const threshold = DEFAULT_CONTEXT_PRESSURE_THRESHOLDS.find((candidate) => contextPercent >= candidate.percent && !crossed.has(candidate.severity));
    if (!threshold)
        return undefined;
    return {
        severity: threshold.severity,
        crossedThreshold: threshold.severity,
        contextTokens,
        contextWindow,
        contextPercent,
        remainingTokens: Math.max(0, contextWindow - contextTokens),
        warnedAt,
    };
}
export function formatContextPressureGuidance(projection) {
    const measured = `measured usage ${formatMeasurement(projection.contextTokens)}/${formatMeasurement(projection.contextWindow)} tokens (${projection.contextPercent.toFixed(2)}%), ${formatMeasurement(projection.remainingTokens)} tokens remaining`;
    return projection.severity === "critical"
        ? `Critical context pressure: ${measured}. Finish and preserve the current work immediately; avoid additional broad work.`
        : `Context pressure warning: ${measured}. Preserve progress; if the child pauses, use a fresh narrowly scoped dispatch instead of resuming.`;
}
const SESSION_HEADER_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
function isUsableSessionHeader(line) {
    try {
        const header = JSON.parse(line);
        return (isRecord(header) &&
            header.type === "session" &&
            typeof header.id === "string" &&
            header.id.trim().length > 0);
    }
    catch {
        return false;
    }
}
export function hasUsableSessionArtifact(sessionFile) {
    if (!sessionFile)
        return false;
    let fd;
    try {
        fd = openSync(sessionFile, "r");
        let bytesScanned = 0;
        let lineParts = [];
        while (bytesScanned < MAX_SESSION_HEADER_SCAN_BYTES) {
            const bytesToRead = Math.min(SESSION_HEADER_READ_CHUNK_BYTES, MAX_SESSION_HEADER_SCAN_BYTES - bytesScanned);
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const bytesRead = readSync(fd, buffer, 0, bytesToRead, bytesScanned);
            if (bytesRead === 0)
                break;
            bytesScanned += bytesRead;
            let lineStart = 0;
            for (let index = 0; index < bytesRead; index++) {
                if (buffer[index] !== 0x0a)
                    continue;
                lineParts.push(Buffer.from(buffer.subarray(lineStart, index)));
                const line = Buffer.concat(lineParts).toString("utf-8");
                lineParts = [];
                lineStart = index + 1;
                if (line.trim().length > 0)
                    return isUsableSessionHeader(line);
            }
            if (lineStart < bytesRead)
                lineParts.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
        }
        if (bytesScanned >= MAX_SESSION_HEADER_SCAN_BYTES) {
            const lookahead = Buffer.allocUnsafe(1);
            if (readSync(fd, lookahead, 0, 1, bytesScanned) !== 0)
                return false;
        }
        const finalLine = Buffer.concat(lineParts).toString("utf-8");
        return finalLine.trim().length > 0 && isUsableSessionHeader(finalLine);
    }
    catch {
        return false;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
            }
        }
    }
}
export function parseContextPressureCrossedThresholds(value) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        return undefined;
    const parsed = value.filter((entry) => entry === "warning" || entry === "critical");
    return parsed.length === value.length ? [...new Set(parsed)] : undefined;
}
export function parseContextPressureProjection(value) {
    if (!isRecord(value))
        return undefined;
    const severity = value.severity;
    const crossedThreshold = value.crossedThreshold;
    const contextTokens = finiteNonNegativeNumber(value.contextTokens);
    const contextWindow = finiteNonNegativeNumber(value.contextWindow);
    const contextPercent = finiteNonNegativeNumber(value.contextPercent);
    const remainingTokens = finiteNonNegativeNumber(value.remainingTokens);
    const warnedAt = finiteNonNegativeNumber(value.warnedAt);
    if ((severity !== "warning" && severity !== "critical") ||
        (crossedThreshold !== "warning" && crossedThreshold !== "critical") ||
        contextTokens === undefined ||
        contextWindow === undefined ||
        contextWindow <= 0 ||
        contextPercent === undefined ||
        remainingTokens === undefined ||
        warnedAt === undefined)
        return undefined;
    return {
        severity,
        crossedThreshold,
        contextTokens,
        contextWindow,
        contextPercent,
        remainingTokens,
        warnedAt,
    };
}
export function parseContextUsageDiagnostics(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        return undefined;
    const parsed = {};
    for (const field of [
        "restoredTokens",
        "contextTokens",
        "peakTokens",
        "contextWindow",
        "contextPercent",
    ]) {
        const fieldValue = finiteNonNegativeNumber(value[field]);
        if (value[field] !== undefined && fieldValue === undefined)
            return undefined;
        if (fieldValue !== undefined)
            parsed[field] = fieldValue;
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
}
export function assessDurableResumeContext(contextUsage, effectiveContextWindow) {
    const usedTokens = finiteNonNegativeNumber(contextUsage?.contextTokens);
    const suppliedWindow = finiteNonNegativeNumber(effectiveContextWindow);
    const contextWindow = suppliedWindow !== undefined && suppliedWindow > 0
        ? suppliedWindow
        : finiteNonNegativeNumber(contextUsage?.contextWindow);
    if (usedTokens === undefined || contextWindow === undefined || contextWindow <= 0) {
        return { blocked: false, measured: false };
    }
    const contextPercent = (usedTokens / contextWindow) * 100;
    return {
        blocked: contextPercent >= DURABLE_RESUME_CONTEXT_THRESHOLD_PERCENT,
        measured: true,
        usedTokens,
        contextWindow,
        contextPercent,
        remainingTokens: Math.max(0, contextWindow - usedTokens),
    };
}
export function formatDurableResumeContextBlock(assessment) {
    if (!assessment.measured || !assessment.blocked)
        return "";
    return [
        `Durable resume blocked: measured used tokens ${formatMeasurement(assessment.usedTokens)}, context window ${formatMeasurement(assessment.contextWindow)}, context usage ${assessment.contextPercent.toFixed(2)}%, remaining tokens ${formatMeasurement(assessment.remainingTokens)}.`,
        "Recommendation: dispatch a fresh narrowly scoped child instead.",
    ].join(" ");
}
function formatMeasurement(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
export function parseSubagentTerminationReason(value) {
    return typeof value === "string" &&
        KNOWN_TERMINATION_REASONS.has(value)
        ? value
        : undefined;
}
export function assistantStopReason(message) {
    if (!isRecord(message) || message.role !== "assistant")
        return undefined;
    return typeof message.stopReason === "string" ? message.stopReason : undefined;
}
export function assistantContextTokens(message) {
    if (!isRecord(message) || message.role !== "assistant")
        return undefined;
    const stopReason = assistantStopReason(message);
    if (stopReason === "aborted" || stopReason === "error")
        return undefined;
    if (!isRecord(message.usage))
        return undefined;
    const totalTokens = finiteNonNegativeNumber(message.usage.totalTokens);
    let total;
    if (totalTokens !== undefined && totalTokens > 0) {
        total = totalTokens;
    }
    else {
        const input = finiteNonNegativeNumber(message.usage.input);
        const output = finiteNonNegativeNumber(message.usage.output);
        const cacheRead = finiteNonNegativeNumber(message.usage.cacheRead);
        const cacheWrite = finiteNonNegativeNumber(message.usage.cacheWrite);
        if (input === undefined ||
            output === undefined ||
            cacheRead === undefined ||
            cacheWrite === undefined)
            return undefined;
        total = input + output + cacheRead + cacheWrite;
    }
    return total > 0 ? total : undefined;
}
export function updateContextUsageDiagnostics(current, message, options) {
    const contextTokens = assistantContextTokens(message);
    if (contextTokens === undefined)
        return current;
    const next = {
        ...current,
        contextTokens,
        peakTokens: Math.max(current?.peakTokens ?? 0, contextTokens),
    };
    if (options.restored && next.restoredTokens === undefined)
        next.restoredTokens = contextTokens;
    const contextWindow = finiteNonNegativeNumber(options.contextWindow) ?? next.contextWindow;
    if (contextWindow !== undefined && contextWindow > 0) {
        next.contextWindow = contextWindow;
        next.contextPercent = (contextTokens / contextWindow) * 100;
    }
    return next;
}
export function mergeContextUsageDiagnostics(previous, latest) {
    if (!latest)
        return previous;
    return {
        ...(previous?.restoredTokens !== undefined
            ? { restoredTokens: previous.restoredTokens }
            : latest.restoredTokens !== undefined
                ? { restoredTokens: latest.restoredTokens }
                : {}),
        ...(latest.contextTokens !== undefined ? { contextTokens: latest.contextTokens } : {}),
        peakTokens: Math.max(previous?.peakTokens ?? 0, latest.peakTokens ?? 0),
        ...(latest.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}),
        ...(latest.contextPercent !== undefined ? { contextPercent: latest.contextPercent } : {}),
    };
}
function isNonEmptyIdentifier(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function canonicalToolCallIds(message) {
    if (!isRecord(message) ||
        message.role !== "assistant" ||
        !Array.isArray(message.content) ||
        message.content.length === 0)
        return undefined;
    const ids = [];
    const seenIds = new Set();
    for (const part of message.content) {
        if (!isRecord(part) ||
            part.type !== "toolCall" ||
            !isNonEmptyIdentifier(part.id) ||
            !isNonEmptyIdentifier(part.name) ||
            !isRecord(part.arguments))
            return undefined;
        if (seenIds.has(part.id))
            return undefined;
        seenIds.add(part.id);
        ids.push(part.id);
    }
    return ids;
}
function isGenuinelyEmptyAssistant(message) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
        return false;
    return message.content.every((part) => isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim() === "");
}
export function classifyContextExhaustedTermination(input) {
    if (input.exitCode !== 0 ||
        input.error ||
        input.terminationReason !== "completed" ||
        typeof input.contextUsage?.contextPercent !== "number" ||
        !Number.isFinite(input.contextUsage.contextPercent) ||
        input.contextUsage.contextPercent < CONTEXT_EXHAUSTED_CONTEXT_THRESHOLD_PERCENT)
        return undefined;
    const messages = input.messages ?? [];
    const finalIndex = messages.length - 1;
    const finalMessage = messages[finalIndex];
    if (!isGenuinelyEmptyAssistant(finalMessage) || assistantStopReason(finalMessage) !== "stop")
        return undefined;
    const callIndex = finalIndex - 1;
    const callIds = canonicalToolCallIds(messages[callIndex]);
    if (!callIds)
        return undefined;
    const unresolvedIds = new Set(callIds);
    for (const message of messages.slice(callIndex + 1, finalIndex)) {
        if (!isRecord(message) ||
            message.role !== "toolResult" ||
            !isNonEmptyIdentifier(message.toolCallId))
            return undefined;
        unresolvedIds.delete(message.toolCallId);
    }
    return unresolvedIds.size > 0 ? "context_exhausted" : undefined;
}
export function resolveEffectiveContextWindow(model, availableModels, preferredProvider) {
    const contextWindow = findModelInfo(splitKnownThinkingSuffix(model ?? "").baseModel, availableModels, preferredProvider)?.contextWindow;
    return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : undefined;
}
export function resolveSubagentTerminationReason(input) {
    if (input.cancelled)
        return "cancelled";
    if (input.paused)
        return "paused";
    if (input.timedOut)
        return "timed_out";
    if (input.toolBudgetBlocked)
        return "tool_budget_blocked";
    if (input.interrupted)
        return "interrupted";
    switch (input.assistantStopReason) {
        case "length":
            return "output_limit";
        case "error":
            return "model_error";
        case "aborted":
            return "interrupted";
        case "stop":
        case "toolUse":
        case "tool_use":
        case "pending":
        case undefined:
        case "deferred":
        default:
            return input.effectiveExitCode !== undefined && input.effectiveExitCode !== 0
                ? "process_exit"
                : input.assistantStopReason === "stop"
                    ? "completed"
                    : input.processCompleted
                        ? "process_exit"
                        : "unknown";
    }
}
