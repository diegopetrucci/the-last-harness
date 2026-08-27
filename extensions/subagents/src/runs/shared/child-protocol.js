import { Buffer } from "node:buffer";
export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
export const MAX_CHILD_STDERR_LINE_BYTES = 64 * 1024;
export const MAX_CHILD_RAW_STDOUT_BYTES = 64 * 1024;
export const CHILD_PROTOCOL_HARD_KILL_GRACE_MS = 3000;
export const MAX_CHILD_ERROR_BYTES = 8 * 1024;
export const MAX_CHILD_RETAINED_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;
const CHILD_ERROR_TRUNCATION_MARKER = " … [child error truncated; full diagnostic is unavailable]";
const STDERR_TRUNCATION_MARKER = "[stderr truncated: showing the bounded tail; earlier diagnostic bytes were dropped]";
const STDERR_ERROR_TRUNCATION_MARKER = " … [stderr error truncated; showing the bounded tail]";
const STDERR_TAIL_ERROR_TRUNCATION_MARKER = " … [stderr truncated; earlier diagnostic bytes were dropped]";
const RAW_STDOUT_TRUNCATION_MARKER = "[stdout truncated: showing the bounded prefix; later child output was dropped]";
export function claimChildTerminalReason(latch, reason) {
    if (latch.reason !== undefined)
        return false;
    latch.reason = reason;
    return true;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isTextContent(value) {
    return isRecord(value) && value.type === "text" && typeof value.text === "string";
}
function isThinkingContent(value) {
    return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}
function isImageContent(value) {
    return (isRecord(value) &&
        value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string");
}
function isToolCall(value) {
    return (isRecord(value) &&
        value.type === "toolCall" &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        isRecord(value.arguments));
}
function isMessageContent(role, value) {
    if (role === "user") {
        return (typeof value === "string" ||
            (Array.isArray(value) && value.every((part) => isTextContent(part) || isImageContent(part))));
    }
    if (role === "assistant") {
        return (Array.isArray(value) &&
            value.every((part) => isTextContent(part) || isThinkingContent(part) || isToolCall(part)));
    }
    return Array.isArray(value) && value.every((part) => isTextContent(part) || isImageContent(part));
}
function isValidUsage(value, required) {
    if (!isRecord(value))
        return !required && value === undefined;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        if (!isFiniteNumber(value[key]))
            return false;
    }
    if (!isRecord(value.cost))
        return false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
        if (!isFiniteNumber(value.cost[key]))
            return false;
    }
    for (const key of ["cacheWrite1h", "reasoning"]) {
        if (value[key] !== undefined && !isFiniteNumber(value[key]))
            return false;
    }
    return true;
}
function isStopReason(value) {
    return (value === "pending" ||
        value === "stop" ||
        value === "length" ||
        value === "toolUse" ||
        value === "error" ||
        value === "aborted" ||
        value === "deferred");
}
function isChildProtocolMessage(value) {
    if (!isRecord(value) || !isFiniteNumber(value.timestamp))
        return false;
    const role = value.role;
    if (role === "user") {
        return isMessageContent(role, value.content);
    }
    if (role === "assistant") {
        return (isMessageContent(role, value.content) &&
            typeof value.api === "string" &&
            typeof value.provider === "string" &&
            typeof value.model === "string" &&
            isStopReason(value.stopReason) &&
            isValidUsage(value.usage, true) &&
            (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
            (value.responseModel === undefined || typeof value.responseModel === "string") &&
            (value.responseId === undefined || typeof value.responseId === "string") &&
            (value.rawStopReason === undefined || typeof value.rawStopReason === "string") &&
            (value.endTurn === undefined || typeof value.endTurn === "boolean"));
    }
    if (role === "toolResult") {
        return (isMessageContent(role, value.content) &&
            typeof value.toolCallId === "string" &&
            typeof value.toolName === "string" &&
            typeof value.isError === "boolean" &&
            isValidUsage(value.usage, false) &&
            (value.addedToolNames === undefined ||
                (Array.isArray(value.addedToolNames) &&
                    value.addedToolNames.every((name) => typeof name === "string"))));
    }
    return false;
}
export function appendBoundedChildMessage(messages, message, encodedBytes, ledger, maxBytes = MAX_CHILD_RETAINED_MESSAGE_BYTES) {
    const size = Math.max(0, Number.isFinite(encodedBytes) ? encodedBytes : 0);
    messages.push(message);
    ledger.sizes.push(size);
    ledger.bytes += size;
    while (messages.length > 1 && ledger.bytes > maxBytes) {
        messages.shift();
        ledger.bytes -= ledger.sizes.shift() ?? 0;
    }
}
export function childUsageNumber(value, ...keys) {
    if (!isRecord(value))
        return 0;
    for (const key of keys) {
        if (isFiniteNumber(value[key]))
            return value[key];
    }
    return 0;
}
export function isChildProtocolEvent(value) {
    if (!isRecord(value) || typeof value.type !== "string")
        return false;
    switch (value.type) {
        case "tool_execution_start":
            return (typeof value.toolName === "string" &&
                value.toolName.length > 0 &&
                (value.args === undefined || (isRecord(value.args) && !Array.isArray(value.args))));
        case "tool_execution_end":
            return value.toolName === undefined || typeof value.toolName === "string";
        case "message_end":
        case "tool_result_end":
            return isChildProtocolMessage(value.message);
        default:
            return false;
    }
}
export function parseChildProtocolInput(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return { kind: "raw" };
    }
    if (!isRecord(parsed))
        return { kind: "raw" };
    return isChildProtocolEvent(parsed)
        ? { kind: "event", event: parsed }
        : { kind: "unknown", value: parsed };
}
export function parseChildProtocolLine(line) {
    const parsed = parseChildProtocolInput(line);
    return parsed.kind === "event" ? parsed.event : undefined;
}
export function formatProtocolOutputLimit(limit) {
    return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}
function sliceUtf8Prefix(value, maxBytes) {
    if (maxBytes <= 0)
        return "";
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let low = 0;
    let high = Math.min(value.length, maxBytes);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes)
            low = middle;
        else
            high = middle - 1;
    }
    let prefix = value.slice(0, low);
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff)
        prefix = prefix.slice(0, -1);
    return prefix;
}
function sliceUtf8Suffix(value, maxBytes) {
    if (maxBytes <= 0)
        return "";
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    let start = Math.max(0, value.length - maxBytes);
    while (start < value.length &&
        value.charCodeAt(start) >= 0xdc00 &&
        value.charCodeAt(start) <= 0xdfff)
        start++;
    while (Buffer.byteLength(value.slice(start), "utf8") > maxBytes) {
        start++;
        while (start < value.length &&
            value.charCodeAt(start) >= 0xdc00 &&
            value.charCodeAt(start) <= 0xdfff)
            start++;
    }
    return value.slice(start);
}
export function boundChildError(value, maxBytes = MAX_CHILD_ERROR_BYTES) {
    if (value === undefined)
        return undefined;
    const text = typeof value === "string" ? value : String(value);
    if (maxBytes < 1)
        return "";
    if (Buffer.byteLength(text, "utf8") <= maxBytes)
        return text;
    const marker = CHILD_ERROR_TRUNCATION_MARKER;
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= maxBytes)
        return sliceUtf8Prefix(marker, maxBytes);
    const prefix = sliceUtf8Prefix(text, maxBytes - markerBytes);
    return `${prefix}${marker}`;
}
export function boundChildStderrError(value, stderrTruncated, maxBytes = MAX_CHILD_ERROR_BYTES) {
    if (maxBytes < 1)
        return "";
    if (Buffer.byteLength(value, "utf8") <= maxBytes)
        return value;
    const marker = stderrTruncated
        ? STDERR_TAIL_ERROR_TRUNCATION_MARKER
        : STDERR_ERROR_TRUNCATION_MARKER;
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const separatorBytes = Buffer.byteLength("\n", "utf8");
    if (markerBytes + separatorBytes >= maxBytes)
        return sliceUtf8Prefix(marker, maxBytes);
    const suffix = sliceUtf8Suffix(value, maxBytes - markerBytes - separatorBytes);
    return `${marker}\n${suffix}`;
}
function trimBufferToUtf8Prefix(buffer, maxBytes) {
    if (buffer.length <= maxBytes)
        return buffer;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (buffer[end - 1] & 0xc0) === 0x80)
        end--;
    if (end > 0) {
        const lead = buffer[end - 1];
        const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
        const codePointEnd = end - 1 + width;
        if (codePointEnd > maxBytes)
            end--;
        else if (codePointEnd === maxBytes)
            end = maxBytes;
    }
    return buffer.subarray(0, end);
}
function trimBufferToUtf8Suffix(buffer, maxBytes) {
    if (buffer.length <= maxBytes)
        return buffer;
    let start = Math.max(0, buffer.length - maxBytes);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80)
        start++;
    return buffer.subarray(start);
}
export function createBoundedLineReader(options) {
    const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_PENDING_LINE_BYTES;
    if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
        throw new Error("maxPendingLineBytes must be a positive integer.");
    }
    let pending = [];
    let pendingBytes = 0;
    let limitExceeded = false;
    const boundedDiagnostic = (value) => trimBufferToUtf8Suffix(value, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
    const buildDiagnosticPrefix = (prior, segment) => trimBufferToUtf8Prefix(Buffer.concat([prior, segment]), MAX_PROTOCOL_DIAGNOSTIC_BYTES);
    const buildDiagnosticTail = (prior, segment) => trimBufferToUtf8Suffix(Buffer.concat([boundedDiagnostic(prior), boundedDiagnostic(segment)]), MAX_PROTOCOL_DIAGNOSTIC_BYTES);
    const failLimit = (observedBytes, prior, segment) => {
        limitExceeded = true;
        pending = [];
        pendingBytes = 0;
        options.onLimit({
            code: "protocol_output_limit",
            stream: options.stream ?? "stdout",
            limitBytes: maxPendingLineBytes,
            observedBytes,
            diagnosticPrefix: buildDiagnosticPrefix(prior, segment).toString("utf8"),
            diagnosticTail: buildDiagnosticTail(prior, segment).toString("utf8"),
        });
    };
    const finishLine = () => {
        if (pendingBytes > 0) {
            const line = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
            options.onLine(line.toString("utf8"));
        }
        pending = [];
        pendingBytes = 0;
    };
    const append = (segment) => {
        if (segment.length === 0)
            return true;
        const observedBytes = pendingBytes + segment.length;
        if (observedBytes > maxPendingLineBytes) {
            const prior = pendingBytes > 0 ? Buffer.concat(pending, pendingBytes) : Buffer.alloc(0);
            failLimit(observedBytes, prior, segment);
            return false;
        }
        pending.push(segment);
        pendingBytes = observedBytes;
        return true;
    };
    return {
        push(chunk) {
            if (limitExceeded)
                return;
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            let start = 0;
            for (let index = 0; index < bytes.length; index++) {
                if (bytes[index] !== 0x0a)
                    continue;
                if (!append(bytes.subarray(start, index)))
                    return;
                finishLine();
                start = index + 1;
            }
            append(bytes.subarray(start));
        },
        end() {
            if (!limitExceeded)
                finishLine();
        },
        exceeded: () => limitExceeded,
    };
}
function trimToUtf8Boundary(buffer, maxBytes) {
    if (buffer.length <= maxBytes)
        return buffer;
    let start = buffer.length - maxBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80)
        start++;
    return buffer.subarray(start);
}
export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new Error("maxBytes must be a positive integer.");
    }
    let tail = Buffer.alloc(0);
    let totalBytes = 0;
    let truncated = false;
    return {
        push(chunk) {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + bytes.length);
            if (bytes.length > maxBytes) {
                tail = trimToUtf8Boundary(bytes, maxBytes);
                truncated = true;
                return;
            }
            const combined = Buffer.concat([tail, bytes]);
            if (combined.length > maxBytes)
                truncated = true;
            tail = trimToUtf8Boundary(combined, maxBytes);
        },
        text: () => tail.toString("utf8"),
        byteLength: () => tail.length,
        totalByteLength: () => totalBytes,
        wasTruncated: () => truncated,
        maxBytes: () => maxBytes,
    };
}
export function createBoundedBytePrefix(maxBytes = MAX_CHILD_RAW_STDOUT_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new Error("maxBytes must be a positive integer.");
    }
    let prefix = Buffer.alloc(0);
    let totalBytes = 0;
    let truncated = false;
    return {
        push(chunk) {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + bytes.length);
            if (prefix.length >= maxBytes) {
                if (bytes.length > 0)
                    truncated = true;
                return;
            }
            const remaining = maxBytes - prefix.length;
            if (bytes.length > remaining)
                truncated = true;
            const addition = bytes.subarray(0, remaining);
            prefix = trimBufferToUtf8Prefix(Buffer.concat([prefix, addition]), maxBytes);
        },
        text: () => prefix.toString("utf8"),
        byteLength: () => prefix.length,
        totalByteLength: () => totalBytes,
        wasTruncated: () => truncated,
        maxBytes: () => maxBytes,
    };
}
export function formatBoundedStderr(tail) {
    const text = tail.text();
    if (!tail.wasTruncated())
        return text;
    return `${STDERR_TRUNCATION_MARKER}\n${text}`;
}
export function formatBoundedRawStdout(prefix) {
    const text = prefix.text();
    if (!prefix.wasTruncated())
        return text;
    return `${text}${text.endsWith("\n") ? "" : "\n"}${RAW_STDOUT_TRUNCATION_MARKER}`;
}
export function formatStderrTailOverflow(tail) {
    return `stderr truncated: child output exceeded ${tail.maxBytes()} bytes; retained the bounded tail in this result (and the transcript artifact when enabled).`;
}
export function formatStderrLineOverflow(limit) {
    return `stderr overflow: a child stderr line exceeded ${limit.limitBytes} bytes; stderr events after that line may be omitted while the bounded tail remains available.`;
}
