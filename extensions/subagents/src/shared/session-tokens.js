import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
const baselineToolCallIds = new WeakMap();
const MAX_SESSION_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_FILES = 128;
const SESSION_TOKEN_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_LINE_BYTES = MAX_SESSION_SCAN_BYTES;
const EMPTY_TOOL_CALLS = { edit: 0, write: 0, bash: 0 };
function findLatestSessionFile(sessionDir) {
    try {
        const files = fs
            .readdirSync(sessionDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => path.join(sessionDir, f))
            .map((filePath) => {
            try {
                return { path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
            }
            catch {
                return undefined;
            }
        })
            .filter((entry) => entry !== undefined);
        if (files.length === 0)
            return null;
        files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
        return files[0]?.path ?? null;
    }
    catch {
        return null;
    }
}
function listSessionFiles(sessionPathOrDir) {
    try {
        const resolved = path.resolve(sessionPathOrDir);
        let stat;
        try {
            stat = fs.statSync(resolved);
        }
        catch {
            return { paths: [], truncated: false };
        }
        if (stat.isFile())
            return { paths: resolved.endsWith(".jsonl") ? [resolved] : [], truncated: false };
        if (!stat.isDirectory())
            return { paths: [], truncated: false };
        const names = fs
            .readdirSync(resolved)
            .filter((name) => name.endsWith(".jsonl"))
            .sort();
        return {
            paths: names.slice(0, MAX_SESSION_FILES).map((name) => path.join(resolved, name)),
            truncated: names.length > MAX_SESSION_FILES,
        };
    }
    catch {
        return { paths: [], truncated: true };
    }
}
function baselineOffset(baseline, filePath) {
    if (!baseline)
        return 0;
    const resolved = path.resolve(filePath);
    const value = baseline instanceof Map
        ? baseline.get(resolved)
        : baseline[resolved];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
export function snapshotSessionFiles(sessionPathOrDir) {
    const snapshot = new Map();
    const ids = new Set();
    for (const filePath of listSessionFiles(sessionPathOrDir).paths) {
        try {
            const resolved = path.resolve(filePath);
            const size = fs.statSync(filePath).size;
            if (Number.isSafeInteger(size) && size >= 0)
                snapshot.set(resolved, size);
            const range = readSessionRange(resolved, 0);
            if (range.readable) {
                for (const id of scanSessionContent(range.content, ids).toolCallIds)
                    ids.add(id);
            }
        }
        catch {
        }
    }
    baselineToolCallIds.set(snapshot, ids);
    return snapshot;
}
function readSessionRange(filePath, requestedOffset) {
    let handle;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile())
            return { content: "", readable: false, truncated: false };
        const offset = Math.min(requestedOffset, stat.size);
        const length = Math.min(Math.max(stat.size - offset, 0), MAX_SESSION_SCAN_BYTES);
        if (length === 0)
            return { content: "", readable: true, truncated: false };
        handle = fs.openSync(filePath, "r");
        let startsAtLineBoundary = offset === 0;
        if (offset > 0) {
            const previous = Buffer.alloc(1);
            fs.readSync(handle, previous, 0, 1, offset - 1);
            startsAtLineBoundary = previous[0] === 0x0a;
        }
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(handle, buffer, 0, length, offset);
        let content = buffer.subarray(0, bytesRead).toString("utf-8");
        if (offset > 0 && !startsAtLineBoundary) {
            const firstNewline = content.indexOf("\n");
            content = firstNewline < 0 ? "" : content.slice(firstNewline + 1);
        }
        const truncated = offset + bytesRead < stat.size;
        if (truncated) {
            const lastNewline = content.lastIndexOf("\n");
            content = lastNewline < 0 ? "" : content.slice(0, lastNewline + 1);
        }
        return { content, readable: true, truncated };
    }
    catch {
        return { content: "", readable: false, truncated: false };
    }
    finally {
        if (handle !== undefined) {
            try {
                fs.closeSync(handle);
            }
            catch {
            }
        }
    }
}
function finiteNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function usageNumber(value) {
    const number = finiteNonNegativeNumber(value);
    return number === undefined ? 0 : number;
}
function usageFromEntry(entry) {
    const usageValue = entry.usage ?? (isRecord(entry.message) ? entry.message.usage : undefined);
    if (!isRecord(usageValue))
        return { input: 0, output: 0, present: false };
    return {
        input: usageNumber(usageValue.inputTokens ?? usageValue.input),
        output: usageNumber(usageValue.outputTokens ?? usageValue.output),
        present: true,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toolCallsFromEntry(entry, seenToolCallIds, counts, toolCallIds) {
    if (!isRecord(entry.message) || entry.message.role !== "assistant")
        return;
    if (!Array.isArray(entry.message.content))
        return;
    for (const part of entry.message.content) {
        if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string")
            continue;
        if (part.id.length === 0 || seenToolCallIds.has(part.id))
            continue;
        seenToolCallIds.add(part.id);
        toolCallIds.push(part.id);
        if (part.name === "edit")
            counts.edit++;
        else if (part.name === "write")
            counts.write++;
        else if (part.name === "bash")
            counts.bash++;
    }
}
function scanSessionContent(content, seenToolCallIds) {
    let input = 0;
    let output = 0;
    let hasUsage = false;
    const requestedToolCalls = { ...EMPTY_TOOL_CALLS };
    const toolCallIds = [];
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (!isRecord(parsed))
                continue;
            const usage = usageFromEntry(parsed);
            if (usage.present) {
                hasUsage = true;
                input += usage.input;
                output += usage.output;
            }
            toolCallsFromEntry(parsed, seenToolCallIds, requestedToolCalls, toolCallIds);
        }
        catch {
        }
    }
    return {
        tokens: { input, output, total: input + output },
        requestedToolCalls,
        toolCallIds,
        hasUsage,
        truncated: false,
    };
}
function parseCompleteSessionTokens(filePath) {
    let handle;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile())
            return null;
        handle = fs.openSync(filePath, "r");
        const decoder = new StringDecoder("utf8");
        const lineParts = [];
        let lineBytes = 0;
        let lineTooLong = false;
        let input = 0;
        let output = 0;
        const finishLine = () => {
            if (!lineTooLong) {
                const line = lineParts.join("");
                if (line.trim()) {
                    try {
                        const parsed = JSON.parse(line);
                        if (isRecord(parsed)) {
                            const usage = usageFromEntry(parsed);
                            if (usage.present) {
                                input += usage.input;
                                output += usage.output;
                            }
                        }
                    }
                    catch {
                    }
                }
            }
            lineParts.length = 0;
            lineBytes = 0;
            lineTooLong = false;
        };
        const appendText = (text) => {
            let start = 0;
            while (true) {
                const newline = text.indexOf("\n", start);
                const end = newline < 0 ? text.length : newline;
                const part = text.slice(start, end);
                if (!lineTooLong) {
                    lineBytes += Buffer.byteLength(part, "utf8");
                    if (lineBytes > MAX_SESSION_LINE_BYTES) {
                        lineTooLong = true;
                        lineParts.length = 0;
                    }
                    else if (part) {
                        lineParts.push(part);
                    }
                }
                if (newline < 0)
                    break;
                finishLine();
                start = newline + 1;
            }
        };
        let offset = 0;
        while (offset < stat.size) {
            const length = Math.min(SESSION_TOKEN_READ_CHUNK_BYTES, stat.size - offset);
            const buffer = Buffer.allocUnsafe(length);
            const bytesRead = fs.readSync(handle, buffer, 0, length, offset);
            if (bytesRead === 0)
                break;
            offset += bytesRead;
            appendText(decoder.write(buffer.subarray(0, bytesRead)));
        }
        appendText(decoder.end());
        if (lineTooLong || lineParts.length > 0 || lineBytes > 0)
            finishLine();
        return {
            tokens: { input, output, total: input + output },
            hasSession: true,
        };
    }
    catch {
        return null;
    }
    finally {
        if (handle !== undefined) {
            try {
                fs.closeSync(handle);
            }
            catch {
            }
        }
    }
}
export function parseSessionFacts(sessionPathOrDir, options = {}) {
    const fileList = listSessionFiles(sessionPathOrDir);
    const files = fileList.paths;
    const baselineIds = options.baseline instanceof Map ? baselineToolCallIds.get(options.baseline) : undefined;
    const seenToolCallIds = new Set([...(baselineIds ?? []), ...(options.seenToolCallIds ?? [])]);
    let input = 0;
    let output = 0;
    let hasUsage = false;
    let hasSession = false;
    let truncated = fileList.truncated;
    const requestedToolCalls = { ...EMPTY_TOOL_CALLS };
    const toolCallIds = [];
    for (const filePath of files) {
        const range = readSessionRange(filePath, baselineOffset(options.baseline, filePath));
        if (!range.readable)
            continue;
        hasSession = true;
        truncated ||= range.truncated;
        const facts = scanSessionContent(range.content, seenToolCallIds);
        input += facts.tokens.input;
        output += facts.tokens.output;
        hasUsage ||= facts.hasUsage;
        requestedToolCalls.edit += facts.requestedToolCalls.edit;
        requestedToolCalls.write += facts.requestedToolCalls.write;
        requestedToolCalls.bash += facts.requestedToolCalls.bash;
        toolCallIds.push(...facts.toolCallIds);
    }
    return {
        tokens: { input, output, total: input + output },
        requestedToolCalls,
        toolCallIds,
        hasUsage,
        hasSession,
        truncated,
    };
}
export function parseSessionTokens(sessionDir) {
    const sessionFile = findLatestSessionFile(sessionDir);
    if (!sessionFile)
        return null;
    const facts = parseCompleteSessionTokens(sessionFile);
    return facts?.hasSession ? facts.tokens : null;
}
