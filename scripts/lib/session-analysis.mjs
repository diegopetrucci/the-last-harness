/**
 * Read-only session analysis module.
 *
 * Parses Pi session JSONL files and exposes a normalized read model.
 * All operations are strictly read-only — nothing in this module may
 * write to, mutate, or rewrite any file under the sessions directory.
 *
 * IMPORTANT: Do not import run-history.jsonl via any path.  Its
 * loadRunsForAgent reader performs a destructive truncation on read.
 *
 * This module is for out-of-process CLI use only.  Do NOT import it
 * from the extension startup path.
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Throw if `filePath` resolves (following symlinks) to `run-history.jsonl`.
 *
 * The Pi runtime's `loadRunsForAgent` reader truncates that file on open,
 * making a read destructive.  Defend at the module boundary so no consumer
 * can accidentally open it regardless of how the path was constructed.
 */
function assertNotRunHistory(filePath) {
    let resolved;
    try {
        resolved = realpathSync(filePath);
    }
    catch {
        // File may not exist yet (e.g. a path being validated before creation).
        // Fall back to the literal path for the basename check.
        resolved = filePath;
    }
    if (basename(resolved) === "run-history.jsonl") {
        throw new Error(`Refusing to open run-history.jsonl: the Pi runtime truncates that file on read. ` +
            `Resolve using a session-specific path instead. Attempted path: ${filePath}`);
    }
}
/**
 * Return the best available timestamp from a message entry.
 *
 * The real corpus stores `timestamp` on `.message` (the assistant message
 * object).  Some fixtures and edge-cases store it on the outer entry.
 * Accept both to remain tolerant.
 */
function resolveTimestamp(entry, message) {
    if (typeof message["timestamp"] === "string" && message["timestamp"]) {
        return message["timestamp"];
    }
    if (typeof entry["timestamp"] === "string" && entry["timestamp"]) {
        return entry["timestamp"];
    }
    return null;
}
/** Tolerant streaming JSONL line reader.  Does not load whole files. */
async function* readJsonlLines(filePath) {
    assertNotRunHistory(filePath);
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed)
            continue; // blank / trailing newline
        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        }
        catch {
            yield { __malformed: true };
            continue;
        }
        yield parsed;
    }
}
/** Safely read the file size; returns -1 on any error. */
function safeFileSize(filePath) {
    try {
        return statSync(filePath).size;
    }
    catch {
        return -1;
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Scan a single session JSONL file in a streaming, read-only manner.
 *
 * - Malformed lines are counted and skipped, never thrown.
 * - An unterminated trailing line (live session append) is tolerated.
 * - Tool calls and results are paired by `toolCallId` only — never by
 *   adjacency or tool name.
 * - The file is never written to or mutated.
 * - Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function scanSessionFile(filePath) {
    // Fix 1: reject run-history.jsonl at the public API boundary as well, so
    // any direct caller gets a clear error even if readJsonlLines is bypassed.
    assertNotRunHistory(filePath);
    const sizeBefore = safeFileSize(filePath);
    let sessionHeader = null;
    let malformedLines = 0;
    let observedToolCallCount = 0;
    let duplicateToolCallIdCount = 0;
    let invalidTimestampPairCount = 0;
    // pending tool calls: toolCallId -> { toolName, callTimestamp }
    const pendingCalls = new Map();
    // pending tool results: toolCallId -> { resultTimestamp, isError, details }
    const pendingResults = new Map();
    for await (const parsed of readJsonlLines(filePath)) {
        if (!isObject(parsed)) {
            malformedLines++;
            continue;
        }
        // Sentinel set by the generator for unparseable lines
        if (parsed["__malformed"] === true) {
            malformedLines++;
            continue;
        }
        const entryType = parsed["type"];
        if (entryType === "session" && sessionHeader === null) {
            if (typeof parsed["version"] === "number" &&
                typeof parsed["id"] === "string" &&
                typeof parsed["timestamp"] === "string" &&
                typeof parsed["cwd"] === "string") {
                sessionHeader = {
                    type: "session",
                    version: parsed["version"],
                    id: parsed["id"],
                    timestamp: parsed["timestamp"],
                    cwd: parsed["cwd"],
                };
            }
            continue;
        }
        if (entryType !== "message")
            continue;
        const message = parsed["message"];
        if (!isObject(message)) {
            malformedLines++;
            continue;
        }
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
                // Accept both "toolCallId" (corpus) and "id" (some fixtures)
                const toolCallId = typeof item["toolCallId"] === "string"
                    ? item["toolCallId"]
                    : typeof item["id"] === "string"
                        ? item["id"]
                        : null;
                if (!toolCallId)
                    continue;
                // Accept both "toolName" (corpus) and "name" (some fixtures)
                const toolName = typeof item["toolName"] === "string"
                    ? item["toolName"]
                    : typeof item["name"] === "string"
                        ? item["name"]
                        : "";
                // Fix 4: count every occurrence; track duplicates explicitly.
                observedToolCallCount++;
                if (pendingCalls.has(toolCallId)) {
                    duplicateToolCallIdCount++;
                }
                pendingCalls.set(toolCallId, { toolName, callTimestamp: ts });
            }
            continue;
        }
        if (role === "toolResult") {
            // Accept both "toolCallId" (corpus) and fallback
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
                    details.results = rawDetails["results"]
                        .filter(isObject)
                        .map((r) => ({
                        agent: typeof r["agent"] === "string" ? r["agent"] : undefined,
                        sessionFile: typeof r["sessionFile"] === "string" ? r["sessionFile"] : undefined,
                    }));
                }
            }
            pendingResults.set(toolCallId, { resultTimestamp: ts, isError, details });
        }
    }
    const sizeAfter = safeFileSize(filePath);
    // Pair calls with results
    const toolPairs = [];
    let unmatchedToolCallCount = 0;
    let unmatchedToolResultCount = 0;
    for (const [toolCallId, call] of pendingCalls) {
        const result = pendingResults.get(toolCallId);
        if (result) {
            // Fix 6: validate timestamps before computing latency.
            const callMs = new Date(call.callTimestamp).getTime();
            const resultMs = new Date(result.resultTimestamp).getTime();
            if (!isFinite(callMs) || !isFinite(resultMs)) {
                invalidTimestampPairCount++;
                continue;
            }
            const latencyMs = resultMs - callMs;
            if (latencyMs < 0) {
                // Negative latency is physically impossible; count as invalid.
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
        filePath,
        sessionHeader,
        toolPairs,
        malformedLines,
        unmatchedToolCallCount,
        unmatchedToolResultCount,
        fileSizeChangedDuringScan: sizeBefore !== sizeAfter,
        observedToolCallCount,
        duplicateToolCallIdCount,
        invalidTimestampPairCount,
    };
}
/**
 * Read only the session header from a JSONL file without scanning
 * all entries.  Returns null when no valid session header is found.
 *
 * Stops reading as soon as the header is found.
 * Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function readSessionHeader(filePath) {
    // Fix 1: also guard the header-only reader.
    assertNotRunHistory(filePath);
    for await (const parsed of readJsonlLines(filePath)) {
        if (!isObject(parsed) || parsed["__malformed"] === true)
            continue;
        if (parsed["type"] === "session" &&
            typeof parsed["version"] === "number" &&
            typeof parsed["id"] === "string" &&
            typeof parsed["timestamp"] === "string" &&
            typeof parsed["cwd"] === "string") {
            return {
                type: "session",
                version: parsed["version"],
                id: parsed["id"],
                timestamp: parsed["timestamp"],
                cwd: parsed["cwd"],
            };
        }
    }
    return null;
}
/**
 * Extract subagent correlations from a scan result.
 *
 * A correlation is emitted for every tool pair where:
 *   - `toolName === "subagent"` (Fix 2: only trust subagent tool results)
 *   - the tool result has both a `runId` and a `sessionFile` in its details.
 *
 * When `sessionsDir` is provided, child files are only resolved when they
 * live under that directory (path safety boundary).  Each resolved child has
 * its session header read and attached.  Unresolvable children are still
 * included with `childResolved: false` so callers can count the gap.
 *
 * Only existing fields are used — nothing is inferred.
 */
export async function extractSubagentCorrelations(scanResult, sessionsDir) {
    if (!scanResult.sessionHeader)
        return [];
    const parentSessionId = scanResult.sessionHeader.id;
    const correlations = [];
    for (const pair of scanResult.toolPairs) {
        // Fix 2: only trust subagent tool results.
        if (pair.toolName !== "subagent")
            continue;
        const details = pair.details;
        if (!details?.runId)
            continue;
        const results = details.results ?? [];
        for (const r of results) {
            if (!r.sessionFile)
                continue;
            // Fix 2: safety boundary — only resolve paths under sessionsDir.
            const underSessionsDir = sessionsDir !== undefined && r.sessionFile.startsWith(sessionsDir + "/");
            let childResolved = false;
            let childSessionId;
            let childStartedAt;
            if (underSessionsDir) {
                try {
                    const header = await readSessionHeader(r.sessionFile);
                    if (header) {
                        childResolved = true;
                        childSessionId = header.id;
                        childStartedAt = header.timestamp;
                    }
                }
                catch {
                    // Unreadable file: childResolved stays false.
                }
            }
            correlations.push({
                parentSessionFile: scanResult.filePath,
                parentSessionId,
                toolCallId: pair.toolCallId,
                runId: details.runId,
                agent: r.agent,
                childSessionFile: r.sessionFile,
                childResolved,
                ...(childSessionId !== undefined ? { childSessionId } : {}),
                ...(childStartedAt !== undefined ? { childStartedAt } : {}),
            });
        }
    }
    return correlations;
}
/**
 * Aggregate coverage statistics across multiple scan results.
 *
 * Pass `extra` to include counters gathered outside the per-file scan
 * (e.g. files discovered, failed scans, unreadable directories).
 */
export function aggregateCoverage(results, extra = {}) {
    let totalMalformedLines = 0;
    let totalUnmatchedToolCalls = 0;
    let totalUnmatchedToolResults = 0;
    let filesWithSizeChange = 0;
    let totalDuplicateToolCallIds = 0;
    let totalInvalidTimestampPairs = 0;
    for (const r of results) {
        totalMalformedLines += r.malformedLines;
        totalUnmatchedToolCalls += r.unmatchedToolCallCount;
        totalUnmatchedToolResults += r.unmatchedToolResultCount;
        if (r.fileSizeChangedDuringScan)
            filesWithSizeChange++;
        totalDuplicateToolCallIds += r.duplicateToolCallIdCount;
        totalInvalidTimestampPairs += r.invalidTimestampPairCount;
    }
    return {
        filesDiscovered: extra.filesDiscovered ?? results.length,
        filesScanned: results.length,
        failedScans: extra.failedScans ?? 0,
        unreadableDirectories: extra.unreadableDirectories ?? 0,
        totalMalformedLines,
        totalUnmatchedToolCalls,
        totalUnmatchedToolResults,
        filesWithSizeChange,
        totalDuplicateToolCallIds,
        totalInvalidTimestampPairs,
    };
}
