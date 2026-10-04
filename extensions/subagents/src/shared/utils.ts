/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { formatToolCall } from "./formatters.ts";
import {
  getConfigDirName,
  getProjectConfigDir,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolveConfigDirName,
} from "./config-dir.ts";
import { getPiAgentDir } from "./profile.ts";
import type {
  AgentProgress,
  AsyncStatus,
  Details,
  DisplayItem,
  ErrorInfo,
  SingleResult,
  ToolCallSummary,
  Usage,
} from "./types.ts";
import {
  createAsyncStatusJsonParseError,
  createAsyncStatusUnsafeError,
} from "../runs/background/async-status-corruption.ts";
import { normalizeAsyncLifecycleStatus } from "../runs/shared/lifecycle-state.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export {
  getConfigDirName,
  getProjectConfigDir,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolveConfigDirName,
};

export function getAgentDir(): string {
  return getPiAgentDir();
}

const statusCache = new Map<
  string,
  { mtime: number; ctime: number; size: number; ino: number; status: AsyncStatus }
>();

/** Keep status reads bounded before persisted JSON is trusted. */
export const MAX_ASYNC_STATUS_BYTES = 16 * 1024 * 1024;
const STATUS_READ_CHUNK_BYTES = 64 * 1024;

type OptionalOpenConstants = {
  readonly O_NONBLOCK?: number;
  readonly O_NOFOLLOW?: number;
};

const optionalOpenConstants: OptionalOpenConstants = fs.constants;
const STATUS_NONBLOCK_FLAG = optionalOpenConstants.O_NONBLOCK ?? 0;
const STATUS_NOFOLLOW_FLAG = optionalOpenConstants.O_NOFOLLOW ?? 0;
const STATUS_OPEN_FLAGS = fs.constants.O_RDONLY | STATUS_NONBLOCK_FLAG | STATUS_NOFOLLOW_FLAG;

export function invalidateStatusCache(asyncDirOrStatusPath: string): void {
  const statusPath =
    path.basename(asyncDirOrStatusPath) === "status.json"
      ? path.resolve(asyncDirOrStatusPath)
      : path.join(path.resolve(asyncDirOrStatusPath), "status.json");
  statusCache.delete(statusPath);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusReadError(statusPath: string, error: unknown): Error {
  return new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
    cause: error,
  });
}

function unsafeStatusError(
  asyncDir: string,
  statusPath: string,
  reason: "non_regular" | "oversized",
  detail: string,
  cause?: unknown,
): Error {
  return createAsyncStatusUnsafeError({
    asyncDir,
    statusPath,
    reason,
    message: `Failed to read async status file '${statusPath}': ${detail}`,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isKnownUnsafeOpenError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EISDIR" || code === "ENXIO";
}

function isNonRegularStatusPath(statusPath: string): boolean {
  try {
    return !fs.lstatSync(statusPath).isFile();
  } catch {
    return false;
  }
}

class StatusFileTooLargeError extends Error {}

/**
 * Normalize a cwd for stable comparison across call sites.
 * On Windows paths are lowercased so drive-letter case differences are ignored.
 */
export function normalizeComparableCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
  if (!childCwd) return baseCwd;
  return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isStatusObject(value: unknown): value is AsyncStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readBoundedStatusContent(fd: number): string {
  const chunks: Buffer[] = [];
  let bytesRead = 0;

  while (bytesRead <= MAX_ASYNC_STATUS_BYTES) {
    const bytesRemaining = MAX_ASYNC_STATUS_BYTES + 1 - bytesRead;
    const buffer = Buffer.allocUnsafe(Math.min(STATUS_READ_CHUNK_BYTES, bytesRemaining));
    const chunkSize = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
    if (chunkSize === 0) break;
    chunks.push(buffer.subarray(0, chunkSize));
    bytesRead += chunkSize;
  }

  if (bytesRead > MAX_ASYNC_STATUS_BYTES) {
    throw new StatusFileTooLargeError(`status file exceeds ${MAX_ASYNC_STATUS_BYTES} bytes`);
  }
  return Buffer.concat(chunks, bytesRead).toString("utf-8");
}

/**
 * Read async job status from disk through one nonblocking, no-follow
 * descriptor. The descriptor is validated with fstat before it is read so a
 * path replacement cannot redirect the content read to another artifact.
 */
export function readStatus(asyncDir: string): AsyncStatus | null {
  const statusPath = path.resolve(asyncDir, "status.json");

  // On platforms without one of these flags, lstat avoids opening an already
  // known non-regular path. POSIX platforms use both flags below, so the open
  // itself remains the race-safe authority for metadata and content.
  if (STATUS_NONBLOCK_FLAG === 0 || STATUS_NOFOLLOW_FLAG === 0) {
    let pathStat: fs.Stats;
    try {
      pathStat = fs.lstatSync(statusPath);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw new Error(
        `Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    if (!pathStat.isFile()) {
      throw unsafeStatusError(
        asyncDir,
        statusPath,
        "non_regular",
        "status path is not a regular file",
      );
    }
  }

  let fd: number;
  try {
    fd = fs.openSync(statusPath, STATUS_OPEN_FLAGS);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    if (isKnownUnsafeOpenError(error) || isNonRegularStatusPath(statusPath)) {
      throw unsafeStatusError(
        asyncDir,
        statusPath,
        "non_regular",
        "status path is not a regular file",
        error,
      );
    }
    throw statusReadError(statusPath, error);
  }

  try {
    let stat: fs.Stats;
    try {
      stat = fs.fstatSync(fd);
    } catch (error) {
      throw statusReadError(statusPath, error);
    }
    if (!stat.isFile()) {
      throw unsafeStatusError(
        asyncDir,
        statusPath,
        "non_regular",
        "status path is not a regular file",
      );
    }
    if (!Number.isFinite(stat.size) || stat.size < 0 || stat.size > MAX_ASYNC_STATUS_BYTES) {
      throw unsafeStatusError(
        asyncDir,
        statusPath,
        "oversized",
        `status file exceeds ${MAX_ASYNC_STATUS_BYTES} bytes`,
      );
    }

    const cached = statusCache.get(statusPath);
    if (
      cached &&
      cached.mtime === stat.mtimeMs &&
      cached.ctime === stat.ctimeMs &&
      cached.size === stat.size &&
      cached.ino === stat.ino
    ) {
      return cached.status;
    }

    let content: string;
    try {
      content = readBoundedStatusContent(fd);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof StatusFileTooLargeError) {
        throw unsafeStatusError(asyncDir, statusPath, "oversized", error.message, error);
      }
      throw statusReadError(statusPath, error);
    }

    let status: AsyncStatus;
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isStatusObject(parsed)) throw new Error("status must be a valid JSON object");
      status = normalizeAsyncLifecycleStatus(parsed);
    } catch (error) {
      throw createAsyncStatusJsonParseError({
        asyncDir,
        statusPath,
        content,
        cause: error,
      });
    }

    statusCache.set(statusPath, {
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      size: stat.size,
      ino: stat.ino,
      status,
    });
    if (statusCache.size > 50) {
      const firstKey = statusCache.keys().next().value;
      if (firstKey) statusCache.delete(firstKey);
    }
    return status;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Find the latest session file in a directory
 */
export function findLatestSessionFile(sessionDir: string): string | null {
  if (!fs.existsSync(sessionDir)) return null;
  const files = fs
    .readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const filePath = path.join(sessionDir, f);
      return {
        path: filePath,
        mtime: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

/** True when a text part carries a structured acceptance report in any accepted form. */
function containsAcceptanceReport(text: string): boolean {
  if (/```acceptance-report\s*\n[\s\S]*?```/i.test(text)) return true;
  if (/ACCEPTANCE_REPORT\s*:/i.test(text)) return true;
  for (const match of text.matchAll(/```(?:json|jsonc|json5)\s*\n([\s\S]*?)```/gi)) {
    const body = match[1] ?? "";
    if (
      /"criteriaSatisfied"/.test(body) &&
      /"(?:changedFiles|testsAddedOrUpdated|commandsRun|validationOutput|residualRisks|noStagedFiles|diffSummary|reviewFindings|manualNotes)"/.test(
        body,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: Message[]): string {
  const validTextParts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const hasAssistantError =
      ("errorMessage" in msg &&
        typeof msg.errorMessage === "string" &&
        msg.errorMessage.length > 0) ||
      ("stopReason" in msg && msg.stopReason === "error");
    if (hasAssistantError) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part.type !== "text" || part.text.trim().length === 0) continue;
      validTextParts.push(part.text);
      if (containsAcceptanceReport(part.text)) {
        // Iteration is reverse, so text parts before this one were never visited.
        // Collect them in document order; otherwise prose written in an earlier
        // part is silently dropped and only the block-bearing part survives.
        // Scoped to this message on purpose: walking back further risks pulling
        // in unrelated intermediate chatter.
        const precedingParts: string[] = [];
        for (let k = 0; k < j; k++) {
          const precedingPart = msg.content[k];
          if (
            precedingPart.type === "text" &&
            precedingPart.text.trim().length > 0 &&
            !containsAcceptanceReport(precedingPart.text)
          ) {
            precedingParts.push(precedingPart.text);
          }
        }
        return precedingParts.length > 0
          ? `${precedingParts.join("\n\n")}\n\n${part.text}`
          : part.text;
      }
    }
  }
  return validTextParts[0] ?? "";
}

export function getSingleResultOutput(
  result: Pick<SingleResult, "finalOutput" | "messages">,
): string {
  return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}

export function formatErrorWithOutput(
  error: string | undefined,
  output: string | undefined,
): string {
  const normalizedOutput = typeof output === "string" ? output : "";
  if (error) {
    return normalizedOutput.trim().length > 0 ? `${error}\n\nOutput:\n${normalizedOutput}` : error;
  }
  return normalizedOutput || "(no output)";
}

export function synthesizeChildExitDiagnostic(input: {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}): string | undefined {
  const signal =
    typeof input.signal === "string" && input.signal.trim().length > 0 ? input.signal : undefined;
  if (signal) return `Child process exited after receiving ${signal}.`;
  const exitCode = input.exitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0)
    return undefined;
  if (exitCode === 143) return "Child process exited with code 143 (conventionally SIGTERM).";
  return `Child process exited with code ${exitCode}.`;
}

/**
 * Extract display items (text and tool calls) from messages
 */
export function getDisplayItems(messages: Message[] | undefined): DisplayItem[] {
  if (!messages || messages.length === 0) return [];
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({ type: "tool", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

function compactCompletedProgress(progress: AgentProgress): AgentProgress {
  if (progress.status === "running") return progress;
  return {
    index: progress.index,
    agent: progress.agent,
    status: progress.status,
    activityState: progress.activityState,
    idleEpisodeId: progress.idleEpisodeId,
    durableAttentionReasons: progress.durableAttentionReasons
      ? [...progress.durableAttentionReasons]
      : undefined,
    compaction: progress.compaction ? { ...progress.compaction } : undefined,
    task: progress.task,
    skills: progress.skills,
    toolCount: progress.toolCount,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
    error: progress.error,
    failedTool: progress.failedTool,
    recentTools: [],
    recentOutput: [],
  };
}

function toolCallSummary(text: string, expandedText: string): ToolCallSummary {
  return expandedText === text ? { text } : { text, expandedText };
}

function normalizeToolCallSummaries(toolCalls: ToolCallSummary[]): ToolCallSummary[] {
  return toolCalls.map((toolCall) =>
    toolCall.expandedText !== undefined && toolCall.expandedText === toolCall.text
      ? { text: toolCall.text }
      : { ...toolCall },
  );
}

function extractToolCallSummaries(messages: Message[] | undefined): ToolCallSummary[] {
  if (!messages?.length) return [];
  const summaries: ToolCallSummary[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type !== "toolCall") continue;
      const args =
        typeof part.arguments === "object" &&
        part.arguments !== null &&
        !Array.isArray(part.arguments)
          ? part.arguments
          : {};
      const text = formatToolCall(part.name, args);
      const expandedText = formatToolCall(part.name, args, true);
      summaries.push(toolCallSummary(text, expandedText));
    }
  }
  return summaries;
}

export function sumResultsUsage(results: SingleResult[]): Usage {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const result of results) {
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;
    usage.cacheWrite += result.usage.cacheWrite;
    usage.cost += result.usage.cost;
    usage.turns += result.usage.turns;
  }
  return usage;
}

/** Sum input tokens, output tokens, and cost across a set of SingleResults. */
export function sumResultsCost(results: SingleResult[]): NonNullable<Details["totalCost"]> {
  const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const result of results) {
    total.inputTokens += result.usage.input;
    total.outputTokens += result.usage.output;
    total.costUsd += result.usage.cost;
  }
  return total;
}

export function compactForegroundResult(result: SingleResult): SingleResult {
  if (result.progress?.status === "running") return result;
  const toolCalls = result.toolCalls?.length
    ? normalizeToolCallSummaries(result.toolCalls)
    : extractToolCallSummaries(result.messages);
  return {
    ...result,
    messages: undefined,
    progress: undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

export function compactForegroundDetails(details: Details): Details {
  return {
    ...details,
    results: details.results.map(compactForegroundResult),
    progress: details.progress ? details.progress.map(compactCompletedProgress) : undefined,
  };
}

/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
  let lastAssistantTextIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const hasText =
        Array.isArray(msg.content) &&
        msg.content.some(
          (c) =>
            c.type === "text" &&
            "text" in c &&
            typeof c.text === "string" &&
            c.text.trim().length > 0,
        );
      if (hasText) {
        lastAssistantTextIndex = i;
        break;
      }
    }
  }

  const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;

  for (let i = messages.length - 1; i >= scanStart; i--) {
    const msg = messages[i];
    if (msg.role !== "toolResult") continue;
    const toolName =
      "toolName" in msg && typeof msg.toolName === "string" ? msg.toolName : undefined;
    const isError = "isError" in msg && msg.isError === true;

    if (isError) {
      const text = msg.content.find((c) => c.type === "text");
      const details = text && "text" in text ? text.text : undefined;
      const exitMatch = details?.match(
        /exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i,
      );
      return {
        hasError: true,
        exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 1,
        errorType: toolName || "tool",
        details: details?.slice(0, 200),
      };
    }

    if (toolName !== "bash") continue;

    const text = msg.content.find((c) => c.type === "text");
    if (!text || !("text" in text)) continue;
    const output = text.text;

    const exitMatch = output.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
    if (exitMatch) {
      const code = parseInt(exitMatch[1], 10);
      if (code !== 0) {
        return { hasError: true, exitCode: code, errorType: "bash", details: output.slice(0, 200) };
      }
    }

    // NOTE: These patterns can match legitimate output (grep results, logs,
    // testing). With the assistant-message check above, most false positives
    // are mitigated since the agent will have responded after routine errors.
    const fatalPatterns = [
      /command not found/i,
      /permission denied/i,
      /no such file or directory/i,
      /segmentation fault/i,
      /killed|terminated/i,
      /out of memory/i,
      /connection refused/i,
      /timeout/i,
    ];
    for (const pattern of fatalPatterns) {
      if (pattern.test(output)) {
        return { hasError: true, exitCode: 1, errorType: "bash", details: output.slice(0, 200) };
      }
    }
  }

  return { hasError: false };
}

/**
 * Extract a semantic summary of tool arguments for display.
 *
 * Selected string values stay complete here so expanded renderers can show the
 * original argument. Callers that need to fit a terminal width should wrap the
 * rendered value while preserving the source value in progress state.
 */
export function extractToolArgsPreview(args: Record<string, unknown>): string {
  const stringifyPreviewValue = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
  };

  const previewArray = (value: unknown): string | undefined => {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const first = stringifyPreviewValue(value[0]);
    if (!first) return undefined;
    const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
    return `${first}${suffix}`;
  };

  // Handle MCP tool calls - show server/tool info
  if (args.tool && typeof args.tool === "string") {
    const server = args.server && typeof args.server === "string" ? `${args.server}/` : "";
    const toolArgs = args.args && typeof args.args === "string" ? ` ${args.args}` : "";
    return `${server}${args.tool}${toolArgs}`;
  }

  const queriesPreview = previewArray(args.queries);
  if (queriesPreview) return queriesPreview;
  if (typeof args.query === "string" && args.query.trim().length > 0) return args.query;
  if (typeof args.workflow === "string" && args.workflow.trim().length > 0)
    return `workflow=${args.workflow}`;

  if (typeof args.url === "string" && args.url.trim().length > 0) return args.url;
  const urlsPreview = previewArray(args.urls);
  if (urlsPreview) return urlsPreview;
  if (typeof args.prompt === "string" && args.prompt.trim().length > 0) return args.prompt;

  const previewKeys = [
    "command",
    "path",
    "file_path",
    "pattern",
    "query",
    "url",
    "task",
    "describe",
    "search",
  ];
  for (const key of previewKeys) {
    if (args[key] && typeof args[key] === "string") return args[key] as string;
  }

  // Fallback: show first string value found
  for (const [key, value] of Object.entries(args)) {
    const arrayPreview = previewArray(value);
    if (arrayPreview) return `${key}=${arrayPreview}`;
    if (typeof value === "string" && value.length > 0) return `${key}=${value}`;
  }
  return "";
}

/**
 * Extract text content from various message content formats
 */
export function extractTextFromContent(content: unknown): string {
  if (!content) return "";
  // Handle string content directly
  if (typeof content === "string") return content;
  // Handle array content
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      // Handle { type: "text", text: "..." }
      if ("type" in part && part.type === "text" && "text" in part) {
        texts.push(String(part.text));
      }
      // Handle { type: "tool_result", content: "..." }
      else if ("type" in part && part.type === "tool_result" && "content" in part) {
        const inner = extractTextFromContent(part.content);
        if (inner) texts.push(inner);
      }
      // Handle { text: "..." } without type
      else if ("text" in part) {
        texts.push(String(part.text));
      }
    }
  }
  return texts.join("\n");
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
