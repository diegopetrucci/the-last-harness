/**
 * Heartbeat JSONL logger.
 *
 * Appends one structured record per beat (or significant skip) to
 * <agent-dir>/subagents/heartbeat.jsonl.  All writes are best-effort:
 * errors are swallowed so the logger never throws into the host process.
 *
 * Log file location: <agent-dir>/subagents/heartbeat.jsonl
 * (created lazily; parent directories are created on first write)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HeartbeatOutcome, HeartbeatUsage } from "./heartbeat-state.ts";

// ---------------------------------------------------------------------------
// Record shape
// ---------------------------------------------------------------------------

export interface HeartbeatLogRecord {
  /** ISO-8601 wall-clock timestamp at beat completion. */
  ts: number;
  /** Session ID of the parent Pi session. */
  sessionId: string;
  /** Opaque gap identifier. */
  gapId: string;
  /** Zero-based beat index within the gap. */
  beatIndex: number;
  /** Model ID used in the ghost request. */
  model: string;
  /** Provider ID used in the ghost request. */
  provider: string;
  /** Outcome of the beat or loggable skip. */
  outcome: HeartbeatOutcome;
  /** Token counts observed from the first usage-bearing stream event. */
  usage?: HeartbeatUsage;
  /** Estimated cost in USD for the ghost request. */
  estCostUsd?: number;
  /** Round-trip latency of the ghost stream in ms. */
  latencyMs?: number;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface HeartbeatLogger {
  /** Append a record. Never throws. */
  append(record: HeartbeatLogRecord): void;
}

interface HeartbeatLoggerDeps {
  /** Override fs.mkdirSync for tests. */
  mkdirSync?: (dir: string, options: { recursive: true }) => void;
  /** Override fs.appendFileSync for tests. */
  appendFileSync?: (file: string, data: string) => void;
}

export function createHeartbeatLogger(
  logPath: string | undefined,
  deps: HeartbeatLoggerDeps = {},
): HeartbeatLogger {
  if (!logPath) {
    return { append() {} };
  }

  const mkdir = deps.mkdirSync ?? ((dir, options) => fs.mkdirSync(dir, options));
  const appendFile = deps.appendFileSync ?? ((file, data) => fs.appendFileSync(file, data));

  return {
    append(record: HeartbeatLogRecord): void {
      try {
        mkdir(path.dirname(logPath), { recursive: true });
        appendFile(logPath, JSON.stringify(record) + "\n");
      } catch {
        // Best-effort: never throw into the host process.
      }
    },
  };
}
