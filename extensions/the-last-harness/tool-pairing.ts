/**
 * Pure tool-call pairing logic.
 *
 * Takes an array of already-parsed session entries and returns matched
 * call/result pairs plus pairing statistics.
 *
 * This module is intentionally pure: no fs, path, or stream imports.
 * It may be used both by the disk-based session-analysis CLI and by
 * in-memory analyzers running inside the extension startup path.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One entry in the `results` array of a subagent tool result's details. */
export interface SubagentResultEntry {
  agent?: string | undefined;
  sessionFile?: string | undefined;
}

/** The `details` object present on tool result messages where toolName == "subagent". */
export interface SubagentDetails {
  runId?: string | undefined;
  results?: SubagentResultEntry[] | undefined;
}

/**
 * A matched pair of an assistant tool-call and its corresponding tool-result,
 * keyed on toolCallId.
 *
 * `observedLatencyMs` is the wall-clock interval between the assistant message
 * timestamp and the tool-result message timestamp.  It includes queueing,
 * subprocess startup, streaming, supervisor pauses, and in-tool retries.
 * It is intentionally named `observedLatencyMs` (never `durationMs`) because
 * the real corpus contains intervals exceeding 8 million ms for paused runs.
 */
export interface ToolPair {
  toolCallId: string;
  toolName: string;
  callTimestamp: string;
  resultTimestamp: string;
  /** Wall-clock ms between the assistant call and the tool result. */
  observedLatencyMs: number;
  isError: boolean;
  details?: SubagentDetails | undefined;
}

/** Result returned by {@link pairToolCalls}. */
interface PairingResult {
  toolPairs: ToolPair[];
  /** Tool calls with no matching tool result (session may still be active). */
  unmatchedToolCallCount: number;
  /** Tool results with no matching tool call (e.g. call was in a prior file). */
  unmatchedToolResultCount: number;
  /**
   * Total number of tool-call occurrences observed, including unmatched and
   * duplicate IDs.  Always >= toolPairs.length.
   */
  observedToolCallCount: number;
  /**
   * Number of tool-call IDs that appeared more than once on the call side.
   * These create pairing ambiguity; the last occurrence wins in the map.
   */
  duplicateToolCallIdCount: number;
  /**
   * Number of matched call+result pairs skipped because one or both timestamps
   * could not be parsed as a finite value or produced a negative interval.
   */
  invalidTimestampPairCount: number;
}

// ---------------------------------------------------------------------------
// Shared statistical helpers
// ---------------------------------------------------------------------------

/**
 * Compute the median of a sorted or unsorted array of numbers.
 *
 * Returns `null` for empty input so callers can distinguish "no data" from
 * a zero result.  For even-sized arrays the two middle values are averaged,
 * matching the standard statistical definition.
 *
 * This is the single authoritative median implementation shared between
 * the `/tokens` extension command and the `tlh-sessions` CLI.  Both callers
 * adapt the `null` empty-input contract at their own call site:
 * - `/tokens` yields `0` via `computeMedian(latencies) ?? 0`
 * - CLI yields `null` directly
 */
export function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of items read from any subagent results array inside tool-result details.
 * Keeps iteration bounded to match the same boundary enforced in the session analyzer.
 */
const MAX_SUBAGENT_RESULTS = 64;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the best available timestamp from a message entry.
 *
 * The real corpus stores `timestamp` on `.message` (the assistant message
 * object).  Some fixtures and edge-cases store it on the outer entry.
 * Accept both to remain tolerant.
 */
function resolveTimestamp(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): string | null {
  if (typeof message["timestamp"] === "string" && message["timestamp"]) {
    return message["timestamp"];
  }
  if (typeof entry["timestamp"] === "string" && entry["timestamp"]) {
    return entry["timestamp"];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pair assistant tool-calls to tool-results within an array of already-parsed
 * session entries.
 *
 * Pairing is keyed on `toolCallId` only — never adjacency or tool name.
 * A single assistant message may contain multiple interleaved tool calls.
 *
 * Both timestamps must parse to finite values and yield a non-negative
 * interval for a pair to be emitted.  Invalid pairs are counted separately.
 *
 * Duplicate `toolCallId` occurrences on the call side are surfaced as an
 * explicit statistic rather than silently overwriting.
 *
 * @param entries Already-parsed (valid JSON) session-entry objects from a
 *   JSONL stream.  Malformed or unparseable lines must be filtered out by
 *   the caller before passing here.
 */
export function pairToolCalls(entries: unknown[]): PairingResult {
  let observedToolCallCount = 0;
  let duplicateToolCallIdCount = 0;
  let invalidTimestampPairCount = 0;

  // pending tool calls: toolCallId -> { toolName, callTimestamp }
  const pendingCalls = new Map<string, { toolName: string; callTimestamp: string }>();
  // pending tool results: toolCallId -> { resultTimestamp, isError, details }
  const pendingResults = new Map<
    string,
    { resultTimestamp: string; isError: boolean; details?: SubagentDetails }
  >();

  for (const parsed of entries) {
    if (!isObject(parsed)) continue;
    if (parsed["type"] !== "message") continue;

    const message = parsed["message"];
    if (!isObject(message)) continue;

    const role = message["role"];

    if (role === "assistant") {
      const ts = resolveTimestamp(parsed, message);
      if (!ts) continue;

      const content = message["content"];
      if (!Array.isArray(content)) continue;

      for (const item of content) {
        if (!isObject(item)) continue;
        if (item["type"] !== "toolCall") continue;

        // Accept both "toolCallId" (corpus) and "id" (some fixtures)
        const toolCallId =
          typeof item["toolCallId"] === "string"
            ? item["toolCallId"]
            : typeof item["id"] === "string"
              ? item["id"]
              : null;
        if (!toolCallId) continue;

        // Accept both "toolName" (corpus) and "name" (some fixtures)
        const toolName =
          typeof item["toolName"] === "string"
            ? item["toolName"]
            : typeof item["name"] === "string"
              ? item["name"]
              : "";

        // Count every occurrence; track duplicates explicitly.
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
      if (!toolCallId) continue;

      const ts = resolveTimestamp(parsed, message);
      if (!ts) continue;

      const isError = Boolean(message["isError"]);

      let details: SubagentDetails | undefined;
      if (isObject(message["details"])) {
        const rawDetails = message["details"] as Record<string, unknown>;
        details = {};
        if (typeof rawDetails["runId"] === "string") {
          details.runId = rawDetails["runId"];
        }
        if (Array.isArray(rawDetails["results"])) {
          const resultsArr = rawDetails["results"] as unknown[];
          const boundedResults: SubagentResultEntry[] = [];
          const limit = Math.min(resultsArr.length, MAX_SUBAGENT_RESULTS);
          for (let i = 0; i < limit; i++) {
            const r = resultsArr[i];
            if (!isObject(r)) continue;
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

  // Pair calls with results
  const toolPairs: ToolPair[] = [];
  let unmatchedToolCallCount = 0;
  let unmatchedToolResultCount = 0;

  for (const [toolCallId, call] of pendingCalls) {
    const result = pendingResults.get(toolCallId);
    if (result) {
      // Validate timestamps before computing latency.
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
    } else {
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
