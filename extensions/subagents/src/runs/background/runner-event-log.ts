import * as fs from "node:fs";
import * as path from "node:path";
import { appendJsonl as appendRawJsonl } from "../../shared/artifacts.ts";

const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 50 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const TRUNCATED_EVENT_TYPE = "subagent.events.truncated";
const TRUNCATION_MARKER_RESERVE_BYTES = 512;

interface AsyncEventLogState {
  bytes: number;
  diagnosticsTruncated: boolean;
}

const asyncEventLogStates = new Map<string, AsyncEventLogState>();

function maxAsyncEventsBytes(): number {
  const raw = process.env[ASYNC_EVENTS_MAX_BYTES_ENV];
  if (!raw) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
  return Math.floor(parsed);
}

function eventLogState(filePath: string): AsyncEventLogState {
  let state = asyncEventLogStates.get(filePath);
  if (state) return state;
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Diagnostic event accounting is best-effort; writes below are also safe.
      void 0;
    }
  }
  state = { bytes, diagnosticsTruncated: false };
  asyncEventLogStates.set(filePath, state);
  return state;
}

export function appendJsonl(filePath: string, line: string): void {
  try {
    appendRawJsonl(filePath, line);
    const state = asyncEventLogStates.get(filePath);
    if (state) state.bytes += Buffer.byteLength(`${line}\n`, "utf-8");
  } catch {
    // Async event logging is diagnostic and must not fail the run.
  }
}

export function appendDiagnosticJsonl(
  filePath: string,
  line: string,
  droppedEventType?: string,
): void {
  if (!line.trim()) return;
  const state = eventLogState(filePath);
  if (state.diagnosticsTruncated) return;
  const maxBytes = maxAsyncEventsBytes();
  const chunkBytes = Buffer.byteLength(`${line}\n`, "utf-8");
  const diagnosticBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE_BYTES);
  if (state.bytes + chunkBytes <= diagnosticBudget) {
    appendJsonl(filePath, line);
    return;
  }

  const marker = JSON.stringify({
    type: TRUNCATED_EVENT_TYPE,
    ts: Date.now(),
    maxBytes,
    droppedEventType,
  });
  if (state.bytes + Buffer.byteLength(`${marker}\n`, "utf-8") <= maxBytes) {
    appendJsonl(filePath, marker);
  }
  state.diagnosticsTruncated = true;
}

export function findLatestSessionFile(sessionDir: string): string | null {
  try {
    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(sessionDir, f));
    if (files.length === 0) return null;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    // Session lookup is optional metadata.
    return null;
  }
}
