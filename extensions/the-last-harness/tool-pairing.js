export function computeMedian(values) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
const MAX_SUBAGENT_RESULTS = 64;
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resolveTimestamp(entry, message) {
    if (typeof message["timestamp"] === "string" && message["timestamp"]) {
        return message["timestamp"];
    }
    if (typeof entry["timestamp"] === "string" && entry["timestamp"]) {
        return entry["timestamp"];
    }
    return null;
}
export function pairToolCalls(entries) {
    let observedToolCallCount = 0;
    let duplicateToolCallIdCount = 0;
    let invalidTimestampPairCount = 0;
    const pendingCalls = new Map();
    const pendingResults = new Map();
    for (const parsed of entries) {
        if (!isObject(parsed))
            continue;
        if (parsed["type"] !== "message")
            continue;
        const message = parsed["message"];
        if (!isObject(message))
            continue;
        const role = message["role"];
        if (role === "assistant") {
            const ts = resolveTimestamp(parsed, message);
            if (!ts)
                continue;
            const content = message["content"];
            if (!Array.isArray(content))
                continue;
            for (const item of content) {
                if (!isObject(item))
                    continue;
                if (item["type"] !== "toolCall")
                    continue;
                const toolCallId = typeof item["toolCallId"] === "string"
                    ? item["toolCallId"]
                    : typeof item["id"] === "string"
                        ? item["id"]
                        : null;
                if (!toolCallId)
                    continue;
                const toolName = typeof item["toolName"] === "string"
                    ? item["toolName"]
                    : typeof item["name"] === "string"
                        ? item["name"]
                        : "";
                observedToolCallCount++;
                if (pendingCalls.has(toolCallId)) {
                    duplicateToolCallIdCount++;
                }
                pendingCalls.set(toolCallId, { toolName, callTimestamp: ts });
            }
            continue;
        }
        if (role === "toolResult") {
            const toolCallId = typeof message["toolCallId"] === "string" ? message["toolCallId"] : null;
            if (!toolCallId)
                continue;
            const ts = resolveTimestamp(parsed, message);
            if (!ts)
                continue;
            const isError = Boolean(message["isError"]);
            let details;
            if (isObject(message["details"])) {
                const rawDetails = message["details"];
                details = {};
                if (typeof rawDetails["runId"] === "string") {
                    details.runId = rawDetails["runId"];
                }
                if (Array.isArray(rawDetails["results"])) {
                    const resultsArr = rawDetails["results"];
                    const boundedResults = [];
                    const limit = Math.min(resultsArr.length, MAX_SUBAGENT_RESULTS);
                    for (let i = 0; i < limit; i++) {
                        const r = resultsArr[i];
                        if (!isObject(r))
                            continue;
                        boundedResults.push({
                            agent: typeof r["agent"] === "string" ? r["agent"] : undefined,
                            sessionFile: typeof r["sessionFile"] === "string" ? r["sessionFile"] : undefined,
                        });
                    }
                    details.results = boundedResults;
                }
            }
            pendingResults.set(toolCallId, { resultTimestamp: ts, isError, details });
        }
    }
    const toolPairs = [];
    let unmatchedToolCallCount = 0;
    let unmatchedToolResultCount = 0;
    for (const [toolCallId, call] of pendingCalls) {
        const result = pendingResults.get(toolCallId);
        if (result) {
            const callMs = new Date(call.callTimestamp).getTime();
            const resultMs = new Date(result.resultTimestamp).getTime();
            if (!isFinite(callMs) || !isFinite(resultMs)) {
                invalidTimestampPairCount++;
                continue;
            }
            const latencyMs = resultMs - callMs;
            if (latencyMs < 0) {
                invalidTimestampPairCount++;
                continue;
            }
            toolPairs.push({
                toolCallId,
                toolName: call.toolName,
                callTimestamp: call.callTimestamp,
                resultTimestamp: result.resultTimestamp,
                observedLatencyMs: latencyMs,
                isError: result.isError,
                details: result.details,
            });
        }
        else {
            unmatchedToolCallCount++;
        }
    }
    for (const toolCallId of pendingResults.keys()) {
        if (!pendingCalls.has(toolCallId)) {
            unmatchedToolResultCount++;
        }
    }
    return {
        toolPairs,
        unmatchedToolCallCount,
        unmatchedToolResultCount,
        observedToolCallCount,
        duplicateToolCallIdCount,
        invalidTimestampPairCount,
    };
}
