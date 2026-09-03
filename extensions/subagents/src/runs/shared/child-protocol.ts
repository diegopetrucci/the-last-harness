/**
 * Bounded child-process protocol I/O primitives.
 *
 * Child stdout is a newline-delimited protocol, but the process at the other
 * end of the pipe is not trusted. Keep bytes bounded before decoding/parsing,
 * and only expose protocol events after their consumed fields have been
 * validated. Stderr is diagnostic data: retain a bounded UTF-8 tail while
 * allowing the async output stream to receive raw bytes. The optional debug
 * profile also records those bytes in the diagnostic child transcript.
 */

import { Buffer } from "node:buffer";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ProtocolOutputLimit } from "../../shared/types.ts";

export type { ProtocolOutputLimit } from "../../shared/types.ts";

/** Maximum retained bytes for one child stdout protocol line. */
export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;

/** Maximum retained bytes for a returned stderr diagnostic tail. */
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;

/** Maximum retained bytes for one async stderr event-log projection line. */
export const MAX_CHILD_STDERR_LINE_BYTES = 64 * 1024;

/** Maximum retained bytes for raw stdout fallback output. */
export const MAX_CHILD_RAW_STDOUT_BYTES = 64 * 1024;

/** Grace period between SIGTERM and SIGKILL for protocol overflow. */
export const CHILD_PROTOCOL_HARD_KILL_GRACE_MS = 3000;

/** Maximum bytes retained in a surfaced child error string. */
export const MAX_CHILD_ERROR_BYTES = 8 * 1024;

/** Maximum encoded bytes retained in the in-memory message history per child. */
export const MAX_CHILD_RETAINED_MESSAGE_BYTES = 32 * 1024 * 1024;

const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;
const CHILD_ERROR_TRUNCATION_MARKER = " … [child error truncated; full diagnostic is unavailable]";
const STDERR_TRUNCATION_MARKER =
  "[stderr truncated: showing the bounded tail; earlier diagnostic bytes were dropped]";
const STDERR_ERROR_TRUNCATION_MARKER = " … [stderr error truncated; showing the bounded tail]";
const STDERR_TAIL_ERROR_TRUNCATION_MARKER =
  " … [stderr truncated; earlier diagnostic bytes were dropped]";
const RAW_STDOUT_TRUNCATION_MARKER =
  "[stdout truncated: showing the bounded prefix; later child output was dropped]";

export type ChildTerminalReason = "output_limit" | "timed_out" | "interrupted" | "paused";

export interface ChildTerminalReasonLatch {
  reason?: ChildTerminalReason;
}

/** Claim the first terminal reason; later races cannot overwrite it. */
export function claimChildTerminalReason(
  latch: ChildTerminalReasonLatch,
  reason: ChildTerminalReason,
): boolean {
  if (latch.reason !== undefined) return false;
  latch.reason = reason;
  return true;
}

/**
 * The subset of the upstream child protocol consumed by the runners. Unknown
 * fields remain on the object so raw durable artifacts stay useful, but the
 * fields used by orchestration are narrowed before a runner sees the event.
 */
export type ChildProtocolMessage = Message & {
  provider?: string;
  model?: string;
  errorMessage?: string;
  stopReason?: string;
  usage?: Usage;
};

export type ChildProtocolEvent =
  | ({ type: "tool_execution_start"; toolName: string; args?: Record<string, unknown> } & Record<
      string,
      unknown
    >)
  | ({ type: "tool_execution_end"; toolName?: string } & Record<string, unknown>)
  | ({ type: "message_end" | "tool_result_end"; message: ChildProtocolMessage } & Record<
      string,
      unknown
    >);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTextContent(value: unknown): boolean {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isThinkingContent(value: unknown): boolean {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isImageContent(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string"
  );
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  );
}

function isMessageContent(role: string, value: unknown): boolean {
  if (role === "user") {
    return (
      typeof value === "string" ||
      (Array.isArray(value) && value.every((part) => isTextContent(part) || isImageContent(part)))
    );
  }
  if (role === "assistant") {
    return (
      Array.isArray(value) &&
      value.every((part) => isTextContent(part) || isThinkingContent(part) || isToolCall(part))
    );
  }
  return Array.isArray(value) && value.every((part) => isTextContent(part) || isImageContent(part));
}

function isValidUsage(value: unknown, required: boolean): value is Usage {
  if (!isRecord(value)) return !required && value === undefined;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (!isFiniteNumber(value[key])) return false;
  }
  if (!isRecord(value.cost)) return false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    if (!isFiniteNumber(value.cost[key])) return false;
  }
  for (const key of ["cacheWrite1h", "reasoning"]) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  }
  return true;
}

function isStopReason(value: unknown): boolean {
  return (
    value === "pending" ||
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted" ||
    value === "deferred"
  );
}

function isChildProtocolMessage(value: unknown): value is ChildProtocolMessage {
  if (!isRecord(value) || !isFiniteNumber(value.timestamp)) return false;
  const role = value.role;
  if (role === "user") {
    return isMessageContent(role, value.content);
  }
  if (role === "assistant") {
    return (
      isMessageContent(role, value.content) &&
      typeof value.api === "string" &&
      typeof value.provider === "string" &&
      typeof value.model === "string" &&
      isStopReason(value.stopReason) &&
      isValidUsage(value.usage, true) &&
      (value.errorMessage === undefined || typeof value.errorMessage === "string") &&
      (value.responseModel === undefined || typeof value.responseModel === "string") &&
      (value.responseId === undefined || typeof value.responseId === "string") &&
      (value.rawStopReason === undefined || typeof value.rawStopReason === "string") &&
      (value.endTurn === undefined || typeof value.endTurn === "boolean")
    );
  }
  if (role === "toolResult") {
    return (
      isMessageContent(role, value.content) &&
      typeof value.toolCallId === "string" &&
      typeof value.toolName === "string" &&
      typeof value.isError === "boolean" &&
      isValidUsage(value.usage, false) &&
      (value.addedToolNames === undefined ||
        (Array.isArray(value.addedToolNames) &&
          value.addedToolNames.every((name) => typeof name === "string")))
    );
  }
  return false;
}

export interface BoundedMessageLedger {
  bytes: number;
  sizes: number[];
}

/**
 * Retain recent validated messages without allowing a chatty child to grow the
 * parent process indefinitely. When configured, JSONL/transcript writers
 * receive the raw line before this in-memory retention policy is applied.
 */
export function appendBoundedChildMessage(
  messages: Message[],
  message: Message,
  encodedBytes: number,
  ledger: BoundedMessageLedger,
  maxBytes = MAX_CHILD_RETAINED_MESSAGE_BYTES,
): void {
  const size = Math.max(0, Number.isFinite(encodedBytes) ? encodedBytes : 0);
  messages.push(message);
  ledger.sizes.push(size);
  ledger.bytes += size;
  while (messages.length > 1 && ledger.bytes > maxBytes) {
    messages.shift();
    ledger.bytes -= ledger.sizes.shift() ?? 0;
  }
}

/**
 * Read a finite usage number. The legacy aliases are retained only for older
 * persisted session/status records; the child protocol predicate accepts the
 * current pi-ai Usage shape above.
 */
export function childUsageNumber(value: unknown, ...keys: string[]): number {
  if (!isRecord(value)) return 0;
  for (const key of keys) {
    if (isFiniteNumber(value[key])) return value[key];
  }
  return 0;
}

/** Validate the exact event shapes consumed by foreground/background runners. */
export function isChildProtocolEvent(value: unknown): value is ChildProtocolEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "tool_execution_start":
      return (
        typeof value.toolName === "string" &&
        value.toolName.length > 0 &&
        (value.args === undefined || (isRecord(value.args) && !Array.isArray(value.args)))
      );
    case "tool_execution_end":
      return value.toolName === undefined || typeof value.toolName === "string";
    case "message_end":
    case "tool_result_end":
      return isChildProtocolMessage(value.message);
    default:
      return false;
  }
}

/** Classification of one line at the child stdout boundary. */
export type ChildProtocolLine =
  | { kind: "event"; event: ChildProtocolEvent }
  | { kind: "unknown"; value: Record<string, unknown> }
  | { kind: "raw" };

/**
 * Parse one child stdout line without assigning protocol meaning to unknown
 * objects. Unknown objects are retained for diagnostic event logs, but callers
 * must not use their fields to drive orchestration state.
 */
export function parseChildProtocolInput(line: string): ChildProtocolLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "raw" };
  }
  if (!isRecord(parsed)) return { kind: "raw" };
  return isChildProtocolEvent(parsed)
    ? { kind: "event", event: parsed }
    : { kind: "unknown", value: parsed };
}

/** Parse and validate one known child protocol event. */
export function parseChildProtocolLine(line: string): ChildProtocolEvent | undefined {
  const parsed = parseChildProtocolInput(line);
  return parsed.kind === "event" ? parsed.event : undefined;
}

/** Format a bounded protocol overflow without embedding unbounded child data. */
export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
  return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline); the line is not retained in full: a bounded prefix and tail remain in the protocol_output_limit record, and subsequent input on that stream is dropped. Inspect the bounded result/session diagnostics, and set artifacts.mode to "debug" before reproducing if the surrounding child protocol is required.`;
}

function sliceUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let prefix = value.slice(0, low);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

function sliceUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let start = Math.max(0, value.length - maxBytes);
  while (
    start < value.length &&
    value.charCodeAt(start) >= 0xdc00 &&
    value.charCodeAt(start) <= 0xdfff
  )
    start++;
  while (Buffer.byteLength(value.slice(start), "utf8") > maxBytes) {
    start++;
    while (
      start < value.length &&
      value.charCodeAt(start) >= 0xdc00 &&
      value.charCodeAt(start) <= 0xdfff
    )
      start++;
  }
  return value.slice(start);
}

/** Bound a child-derived error while retaining its beginning and a clear marker. */
export function boundChildError(value: string, maxBytes?: number): string;
export function boundChildError(value: undefined, maxBytes?: number): undefined;
export function boundChildError(value: string | undefined, maxBytes?: number): string | undefined;
export function boundChildError(
  value: unknown,
  maxBytes = MAX_CHILD_ERROR_BYTES,
): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : String(value);
  if (maxBytes < 1) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = CHILD_ERROR_TRUNCATION_MARKER;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return sliceUtf8Prefix(marker, maxBytes);
  const prefix = sliceUtf8Prefix(text, maxBytes - markerBytes);
  return `${prefix}${marker}`;
}

/** Bound a diagnostic while preserving its most recent bytes (stderr tail). */
export function boundChildStderrError(
  value: string,
  stderrTruncated: boolean,
  maxBytes = MAX_CHILD_ERROR_BYTES,
): string {
  if (maxBytes < 1) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = stderrTruncated
    ? STDERR_TAIL_ERROR_TRUNCATION_MARKER
    : STDERR_ERROR_TRUNCATION_MARKER;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const separatorBytes = Buffer.byteLength("\n", "utf8");
  if (markerBytes + separatorBytes >= maxBytes) return sliceUtf8Prefix(marker, maxBytes);
  const suffix = sliceUtf8Suffix(value, maxBytes - markerBytes - separatorBytes);
  return `${marker}\n${suffix}`;
}

function trimBufferToUtf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  const limit = Math.min(buffer.length, Math.max(0, maxBytes));
  if (limit === 0) return buffer.subarray(0, 0);
  let end = limit;
  while (end > 0 && (buffer[end - 1]! & 0xc0) === 0x80) end--;
  if (end === 0) return buffer.subarray(0, 0);
  const lead = buffer[end - 1]!;
  const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  if (end === limit) {
    if (width > 1) end--;
  } else {
    const codePointEnd = end - 1 + width;
    if (codePointEnd > limit) end--;
    else if (codePointEnd === limit) end = limit;
  }
  return buffer.subarray(0, end);
}

function trimBufferToUtf8Suffix(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

/**
 * Create a streaming bounded JSONL line reader. Bytes are accumulated until a
 * newline, so UTF-8 sequences split across pipe chunks are decoded together.
 * Once a line exceeds its cap, the reader drops that line and all subsequent
 * input; the caller is responsible for terminating stdout protocol producers.
 */
export function createBoundedLineReader(options: {
  stream?: "stdout" | "stderr";
  maxPendingLineBytes?: number;
  onLine: (line: string) => void;
  onLimit: (limit: ProtocolOutputLimit) => void;
}): {
  push(chunk: Buffer | string): void;
  end(): void;
  exceeded(): boolean;
} {
  const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_PENDING_LINE_BYTES;
  if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
    throw new Error("maxPendingLineBytes must be a positive integer.");
  }

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let limitExceeded = false;

  const boundedDiagnostic = (value: Buffer): Buffer =>
    trimBufferToUtf8Suffix(value, MAX_PROTOCOL_DIAGNOSTIC_BYTES);

  const buildDiagnosticPrefix = (prior: Buffer, segment: Buffer): Buffer =>
    trimBufferToUtf8Prefix(Buffer.concat([prior, segment]), MAX_PROTOCOL_DIAGNOSTIC_BYTES);

  const buildDiagnosticTail = (prior: Buffer, segment: Buffer): Buffer =>
    trimBufferToUtf8Suffix(
      Buffer.concat([boundedDiagnostic(prior), boundedDiagnostic(segment)]),
      MAX_PROTOCOL_DIAGNOSTIC_BYTES,
    );

  const failLimit = (observedBytes: number, prior: Buffer, segment: Buffer): void => {
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

  const finishLine = (): void => {
    if (pendingBytes > 0) {
      const line = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
      options.onLine(line.toString("utf8"));
    }
    pending = [];
    pendingBytes = 0;
  };

  const append = (segment: Buffer): boolean => {
    if (segment.length === 0) return true;
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
      if (limitExceeded) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        if (bytes[index] !== 0x0a) continue;
        if (!append(bytes.subarray(start, index))) return;
        finishLine();
        start = index + 1;
      }
      append(bytes.subarray(start));
    },
    end() {
      if (!limitExceeded) finishLine();
    },
    exceeded: () => limitExceeded,
  };
}

/** Trim a buffer to at most maxBytes, starting at a valid UTF-8 code point boundary. */
function trimToUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

export interface BoundedByteTail {
  push(chunk: Buffer | string): void;
  text(): string;
  byteLength(): number;
  totalByteLength(): number;
  wasTruncated(): boolean;
  maxBytes(): number;
}

/** Retain only the final maxBytes of a byte stream without unbounded memory. */
export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES): BoundedByteTail {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer.");
  }
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
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
      if (combined.length > maxBytes) truncated = true;
      tail = trimToUtf8Boundary(combined, maxBytes);
    },
    text: () => tail.toString("utf8"),
    byteLength: () => tail.length,
    totalByteLength: () => totalBytes,
    wasTruncated: () => truncated,
    maxBytes: () => maxBytes,
  };
}

export interface BoundedBytePrefix {
  push(chunk: Buffer | string): void;
  text(): string;
  byteLength(): number;
  totalByteLength(): number;
  wasTruncated(): boolean;
  maxBytes(): number;
}

/** Retain only the first maxBytes of a byte stream without unbounded memory. */
export function createBoundedBytePrefix(maxBytes = MAX_CHILD_RAW_STDOUT_BYTES): BoundedBytePrefix {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer.");
  }
  let prefix: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let capturedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  const completePrefix = (): Buffer => trimBufferToUtf8Prefix(prefix, maxBytes);
  return {
    push(chunk) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + bytes.length);
      if (capturedBytes >= maxBytes) {
        if (bytes.length > 0) truncated = true;
        return;
      }
      const remaining = maxBytes - capturedBytes;
      if (bytes.length > remaining) truncated = true;
      const addition = bytes.subarray(0, remaining);
      prefix = Buffer.concat([prefix, addition]);
      capturedBytes += addition.length;
    },
    text: () => completePrefix().toString("utf8"),
    byteLength: () => completePrefix().length,
    totalByteLength: () => totalBytes,
    wasTruncated: () => truncated,
    maxBytes: () => maxBytes,
  };
}

/** Prefix a bounded stderr tail with an explicit overflow diagnostic. */
export function formatBoundedStderr(tail: BoundedByteTail): string {
  const text = tail.text();
  if (!tail.wasTruncated()) return text;
  return `${STDERR_TRUNCATION_MARKER}\n${text}`;
}

/** Prefix a bounded raw stdout fallback with an explicit overflow diagnostic. */
export function formatBoundedRawStdout(prefix: BoundedBytePrefix): string {
  const text = prefix.text();
  if (!prefix.wasTruncated()) return text;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${RAW_STDOUT_TRUNCATION_MARKER}`;
}

/** Describe a non-fatal stderr tail overflow for diagnostic event logs. */
export function formatStderrTailOverflow(tail: BoundedByteTail): string {
  return `stderr truncated: child output exceeded ${tail.maxBytes()} bytes; the bounded tail remains available in this result. Inspect the existing async output-N.log for the raw stderr stream. Set artifacts.mode to "debug" before reproducing only if the diagnostic child transcript or surrounding child protocol is needed.`;
}

/** Describe a non-fatal stderr line overflow for diagnostic event logs. */
export function formatStderrLineOverflow(limit: ProtocolOutputLimit): string {
  return `stderr overflow: a child stderr line exceeded ${limit.limitBytes} bytes; this line and later per-line stderr events are omitted from events.jsonl while the bounded tail remains available. Inspect the existing async output-N.log for the raw stderr stream. Set artifacts.mode to "debug" before reproducing only if the diagnostic child transcript or surrounding child protocol is needed.`;
}
