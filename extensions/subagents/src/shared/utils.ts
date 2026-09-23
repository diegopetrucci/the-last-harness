/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  getConfigDirName,
  getProjectConfigDir,
  PI_CODING_AGENT_PACKAGE_ROOT_ENV,
  resolveConfigDirName,
} from "./config-dir.ts";
import { getPiAgentDir } from "./profile.ts";
import type {
  AsyncStatus,
  Details,
  DisplayItem,
  ErrorInfo,
  NestedRunSummary,
  SingleResult,
  Usage,
} from "./types.ts";
import { waitSync } from "./atomic-json.ts";
import { MAX_ATTRIBUTION_STATUS_BYTES } from "./terminal-result.ts";
import {
  AsyncStatusReadError,
  formatUnreadableStatus,
  parsePersistedAsyncStatus,
  type AsyncStatusReadErrorInput,
} from "../runs/background/async-status-boundary.ts";
import { normalizeAsyncLifecycleStatus } from "../runs/shared/lifecycle-state.ts";

export { AsyncStatusReadError, formatUnreadableStatus };

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

interface StatusMetadata {
  mtime: number;
  ctime: number;
  size: number;
  ino: number;
}

const statusCache = new Map<string, StatusMetadata & { status: AsyncStatus }>();
const statusFailureCache = new Map<string, StatusMetadata & { error: AsyncStatusReadError }>();
const MAX_STATUS_CACHE_ENTRIES = 50;
const MAX_STATUS_FAILURE_CACHE_ENTRIES = 256;

/** Ordinary status reads use the same envelope as workspace attribution scans. */
export const MAX_ASYNC_STATUS_BYTES = MAX_ATTRIBUTION_STATUS_BYTES;
/** Fixed 50 MiB source-byte cap, independent of the per-file read limit. */
export const MAX_STATUS_CACHE_BYTES = 50 * 1024 * 1024;
export const ASYNC_STATUS_RETRY_DELAY_MS = 10;

let statusCacheBytes = 0;

export interface AsyncStatusReadOptions {
  /** Test seam for status-file metadata reads. */
  statSync?: (statusPath: string) => fs.Stats;
  /** Test seam for status-file content reads. */
  readFileSync?: (statusPath: string, encoding: BufferEncoding) => string | Buffer;
  /** Test seam for the bounded retry delay. */
  sleep?: (delayMs: number) => void;
  /** Test seam for the retry duration; production values are clamped. */
  retryDelayMs?: number;
  /** Reconciliation bypasses success and deterministic-failure caches. */
  cache?: boolean;
}

export function invalidateStatusCache(asyncDirOrStatusPath: string): void {
  const statusPath =
    path.basename(asyncDirOrStatusPath) === "status.json"
      ? path.resolve(asyncDirOrStatusPath)
      : path.join(path.resolve(asyncDirOrStatusPath), "status.json");
  deleteStatusCacheEntry(statusPath);
  statusFailureCache.delete(statusPath);
}

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

function statusMetadata(stat: fs.Stats): StatusMetadata {
  return {
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    size: stat.size,
    ino: stat.ino,
  };
}

function sameStatusMetadata(left: StatusMetadata, right: StatusMetadata): boolean {
  return (
    left.mtime === right.mtime &&
    left.ctime === right.ctime &&
    left.size === right.size &&
    left.ino === right.ino
  );
}

function deleteStatusCacheEntry(statusPath: string): void {
  const cached = statusCache.get(statusPath);
  if (!cached) return;
  statusCache.delete(statusPath);
  statusCacheBytes -= cached.size;
}

function cacheStatus(statusPath: string, metadata: StatusMetadata, status: AsyncStatus): void {
  deleteStatusCacheEntry(statusPath);
  if (metadata.size > MAX_STATUS_CACHE_BYTES) return;

  statusCache.set(statusPath, { ...metadata, status });
  statusCacheBytes += metadata.size;
  while (statusCache.size > MAX_STATUS_CACHE_ENTRIES || statusCacheBytes > MAX_STATUS_CACHE_BYTES) {
    const firstKey = statusCache.keys().next().value;
    if (firstKey === undefined) break;
    deleteStatusCacheEntry(firstKey);
  }
}

function statusReadError(input: AsyncStatusReadErrorInput): AsyncStatusReadError {
  return new AsyncStatusReadError(input);
}

function statusReadFailure(
  asyncDir: string,
  statusPath: string,
  failure: AsyncStatusReadErrorInput["failure"],
  message: string,
  cause?: unknown,
): AsyncStatusReadError {
  return statusReadError({ asyncDir, statusPath, failure, message, cause });
}

function isCacheableStatusFailure(error: AsyncStatusReadError): boolean {
  return error.failure === "invalid" || error.failure === "oversize";
}

/**
 * Read async job status from disk with one bounded retry. The JSON value is
 * unknown until the boundary parser validates and narrows it. Invalid or
 * unreadable status files are never repaired by this function.
 */
export function readStatus(
  asyncDir: string,
  options: AsyncStatusReadOptions = {},
): AsyncStatus | null {
  const statusPath = path.resolve(asyncDir, "status.json");
  const statSync = options.statSync ?? fs.statSync;
  const readFileSync =
    options.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
  const sleep = options.sleep ?? waitSync;
  const requestedRetryDelayMs = options.retryDelayMs;
  const retryDelayMs =
    requestedRetryDelayMs !== undefined && Number.isFinite(requestedRetryDelayMs)
      ? Math.min(ASYNC_STATUS_RETRY_DELAY_MS, Math.max(0, Math.floor(requestedRetryDelayMs)))
      : ASYNC_STATUS_RETRY_DELAY_MS;
  const useCache = options.cache !== false;
  let lastFailure: AsyncStatusReadError | undefined;
  let lastMetadata: StatusMetadata | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    lastFailure = undefined;
    let stat: fs.Stats;
    let metadata: StatusMetadata | undefined;
    try {
      stat = statSync(statusPath);
      metadata = statusMetadata(stat);
      lastMetadata = metadata;
    } catch (error) {
      if (isNotFoundError(error)) {
        if (useCache) {
          deleteStatusCacheEntry(statusPath);
          statusFailureCache.delete(statusPath);
        }
        return null;
      }
      lastFailure = statusReadFailure(
        asyncDir,
        statusPath,
        "unreadable",
        "status metadata could not be read.",
        error,
      );
    }

    if (!lastFailure) {
      if (useCache && metadata) {
        const cachedFailure = statusFailureCache.get(statusPath);
        if (cachedFailure) {
          if (sameStatusMetadata(cachedFailure, metadata)) throw cachedFailure.error;
          statusFailureCache.delete(statusPath);
          deleteStatusCacheEntry(statusPath);
        }
      }
      const cached = useCache ? statusCache.get(statusPath) : undefined;
      if (cached && metadata && sameStatusMetadata(cached, metadata)) return cached.status;
      if (!Number.isFinite(stat!.size) || stat!.size < 0 || stat!.size > MAX_ASYNC_STATUS_BYTES) {
        lastFailure = statusReadFailure(
          asyncDir,
          statusPath,
          "oversize",
          `status exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`,
        );
      } else {
        let content: string | undefined;
        try {
          const raw = readFileSync(statusPath, "utf-8");
          content = typeof raw === "string" ? raw : raw.toString("utf-8");
        } catch (error) {
          if (isNotFoundError(error)) {
            if (useCache) {
              deleteStatusCacheEntry(statusPath);
              statusFailureCache.delete(statusPath);
            }
            return null;
          }
          lastFailure = statusReadFailure(
            asyncDir,
            statusPath,
            "unreadable",
            "status content could not be read.",
            error,
          );
        }
        if (!lastFailure && content !== undefined) {
          if (Buffer.byteLength(content, "utf-8") > MAX_ASYNC_STATUS_BYTES) {
            lastFailure = statusReadFailure(
              asyncDir,
              statusPath,
              "oversize",
              `status exceeds the ${MAX_ASYNC_STATUS_BYTES}-byte limit.`,
            );
          } else {
            try {
              const parsed: unknown = JSON.parse(content);
              const narrowed = parsePersistedAsyncStatus(parsed, asyncDir, statusPath);
              const status = normalizeAsyncLifecycleStatus(narrowed);
              if (useCache && metadata) {
                statusFailureCache.delete(statusPath);
                cacheStatus(statusPath, metadata, status);
              }
              return status;
            } catch (error) {
              if (error instanceof AsyncStatusReadError) lastFailure = error;
              else {
                lastFailure = statusReadFailure(
                  asyncDir,
                  statusPath,
                  "invalid",
                  "status JSON could not be parsed.",
                );
              }
            }
          }
        }
      }
    }

    if (attempt === 0) {
      try {
        sleep(retryDelayMs);
      } catch (error) {
        lastFailure = statusReadFailure(
          asyncDir,
          statusPath,
          "unreadable",
          "status retry delay could not be completed.",
          error,
        );
        break;
      }
    }
  }

  const failure =
    lastFailure ??
    statusReadFailure(asyncDir, statusPath, "unreadable", "status could not be read safely.");
  if (useCache) {
    // A read failure must never leave an older successful or deterministic
    // failure result available for a later call. Only the final deterministic
    // failure is eligible to be memoized below.
    deleteStatusCacheEntry(statusPath);
    statusFailureCache.delete(statusPath);
    if (lastMetadata && isCacheableStatusFailure(failure)) {
      statusFailureCache.set(statusPath, { ...lastMetadata, error: failure });
      if (statusFailureCache.size > MAX_STATUS_FAILURE_CACHE_ENTRIES) {
        const firstKey = statusFailureCache.keys().next().value;
        if (firstKey) statusFailureCache.delete(firstKey);
      }
    }
  }
  throw failure;
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

/**
 * Get the final text output from a list of messages.
 *
 * Fenced blocks are ordinary child output; no report-shaped text is parsed or
 * removed here so historical transcripts remain visible and safe to render.
 */
export function getFinalOutput(messages: Message[]): string {
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
      if (part.type === "text" && part.text.trim().length > 0) return part.text;
    }
  }
  return "";
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

function addNestedCost(
  total: NonNullable<Details["totalCost"]>,
  children: NestedRunSummary[] | undefined,
): void {
  for (const child of children ?? []) {
    if (child.totalCost) {
      total.inputTokens += child.totalCost.inputTokens;
      total.outputTokens += child.totalCost.outputTokens;
      total.costUsd += child.totalCost.costUsd;
      continue;
    }
    addNestedCost(total, child.children);
    for (const step of child.steps ?? []) addNestedCost(total, step.children);
  }
}

/** Sum input tokens, output tokens, and cost across a set of SingleResults. */
export function sumResultsCost(results: SingleResult[]): NonNullable<Details["totalCost"]> {
  const total = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const result of results) {
    total.inputTokens += result.usage.input;
    total.outputTokens += result.usage.output;
    total.costUsd += result.usage.cost;
    addNestedCost(total, result.children);
  }
  return total;
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
