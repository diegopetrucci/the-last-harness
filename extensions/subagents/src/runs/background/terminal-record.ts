import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { truncateWithMarker } from "../../shared/string-utils.ts";
import {
  RESULTS_DIR,
  type AsyncResultArtifact,
  type AsyncStatus,
  type SubagentRunMode,
} from "../../shared/types.ts";
import {
  checkPidLiveness,
  isCompletedLifecycleStepState,
  isTerminalLifecycleState,
} from "../shared/lifecycle-state.ts";
import type { KillFn } from "./stale-run-reconciler.ts";

/**
 * Durable, bounded terminal record kept in each run's asyncDir. It is written at
 * finalization and is independent of the results-dir notification file that the
 * result watcher unlinks after emitting. The `result` action reads it.
 */
export const TERMINAL_RECORD_FILE = "terminal-record.json";
/** Per-session retrieval marker; removed whenever a new terminal record is written. */
export const TERMINAL_RETRIEVAL_FILE = "terminal-record.retrieved.json";
const TERMINAL_RECORD_VERSION = 2;

/** Stored per-child output cap (each child is bounded independently). */
export const TERMINAL_RECORD_CHILD_OUTPUT_CHARS = 16_000;
const TERMINAL_RECORD_ERROR_CHARS = 2_000;
const TERMINAL_RECORD_SUMMARY_CHARS = 2_000;
const TERMINAL_RECORD_PATH_CHARS = 1_024;
const TERMINAL_RECORD_MAX_CHILDREN = 64;
const OUTPUT_MARKER = "… [output truncated; see artifact path for full output]";
const TEXT_MARKER = "… [truncated]";

export type TerminalRecordChildStatus =
  | "completed"
  | "failed"
  | "paused"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface TerminalRecordChild {
  index: number;
  agent: string;
  status: TerminalRecordChildStatus;
  output: string;
  outputTruncated?: boolean;
  error?: string;
  sessionFile?: string;
  /** Path holding the child's full output, when one was saved. */
  artifactPath?: string;
}

export interface TerminalRecord {
  version: typeof TERMINAL_RECORD_VERSION;
  runId: string;
  /**
   * Unique identity of this write. A re-finalization produces a new revision, so a
   * retrieval marker only counts for the record revision it was created against.
   */
  revision: string;
  state: AsyncStatus["state"];
  mode: SubagentRunMode;
  agent: string;
  success: boolean;
  summary: string;
  error?: string;
  sessionId?: string;
  endedAt: number;
  /** True when rebuilt from status.json because no result artifact existed. */
  synthesized?: boolean;
  childrenOmitted?: number;
  children: TerminalRecordChild[];
}

function bound(value: unknown, max: number, marker = TEXT_MARKER): string | undefined {
  return typeof value === "string" && value.length > 0
    ? truncateWithMarker(value, max, marker)
    : undefined;
}

function childStatusFromResult(
  item: AsyncResultArtifact["results"][number],
): TerminalRecordChildStatus {
  if (item.skipped) return "skipped";
  if (item.cancel) return "cancelled";
  if (item.interrupted || item.pause) return "paused";
  return item.success ? "completed" : "failed";
}

export function terminalRecordFromArtifact(
  artifact: AsyncResultArtifact,
  options: { synthesized?: boolean } = {},
): TerminalRecord {
  const items = artifact.results.slice(0, TERMINAL_RECORD_MAX_CHILDREN);
  const children = items.map((item, index): TerminalRecordChild => {
    const raw = item.finalOutput ?? item.output ?? "";
    const output = truncateWithMarker(raw, TERMINAL_RECORD_CHILD_OUTPUT_CHARS, OUTPUT_MARKER);
    return {
      index,
      agent: item.agent,
      status: childStatusFromResult(item),
      output,
      ...(output.length < raw.length || item.truncated ? { outputTruncated: true } : {}),
      ...optionalField("error", bound(item.error, TERMINAL_RECORD_ERROR_CHARS)),
      ...optionalField("sessionFile", bound(item.sessionFile, TERMINAL_RECORD_PATH_CHARS, "")),
      ...optionalField(
        "artifactPath",
        bound(
          item.artifactPaths?.outputPath ?? item.savedOutputPath,
          TERMINAL_RECORD_PATH_CHARS,
          "",
        ),
      ),
    };
  });
  return {
    version: TERMINAL_RECORD_VERSION,
    runId: artifact.id,
    revision: randomUUID(),
    state: artifact.state,
    mode: artifact.mode,
    agent: artifact.agent,
    success: artifact.success,
    summary: bound(artifact.summary, TERMINAL_RECORD_SUMMARY_CHARS) ?? "",
    ...optionalField("error", bound(artifact.error, TERMINAL_RECORD_ERROR_CHARS)),
    ...optionalField("sessionId", artifact.sessionId ?? undefined),
    endedAt: artifact.timestamp,
    ...(options.synthesized ? { synthesized: true } : {}),
    ...(artifact.results.length > items.length
      ? { childrenOmitted: artifact.results.length - items.length }
      : {}),
    children,
  };
}

function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** Bounded record synthesized from a finalized status when the result artifact is missing. */
export function terminalRecordFromStatus(status: AsyncStatus): TerminalRecord {
  const steps = (status.steps ?? []).slice(0, TERMINAL_RECORD_MAX_CHILDREN);
  const state = status.state;
  const fallbackOutput = status.error ?? "(no output recorded; result artifact was unavailable)";
  const children = steps.map((step, index): TerminalRecordChild => {
    const completed = isCompletedLifecycleStepState(step.status);
    const childStatus: TerminalRecordChildStatus = completed
      ? "completed"
      : step.status === "paused" || step.status === "pausing"
        ? "paused"
        : step.status === "cancelled"
          ? "cancelled"
          : step.status === "pending"
            ? "skipped"
            : "failed";
    const output =
      step.recentOutput?.join("\n") ||
      step.error ||
      (completed ? "(no output recorded; result artifact was unavailable)" : fallbackOutput);
    return {
      index,
      agent: step.agent,
      status: childStatus,
      output: truncateWithMarker(output, TERMINAL_RECORD_CHILD_OUTPUT_CHARS, OUTPUT_MARKER),
      // Recent output is only a tail of the child's output.
      outputTruncated: true,
      ...optionalField("error", bound(step.error, TERMINAL_RECORD_ERROR_CHARS)),
      ...optionalField("sessionFile", bound(step.sessionFile, TERMINAL_RECORD_PATH_CHARS, "")),
    };
  });
  return {
    version: TERMINAL_RECORD_VERSION,
    runId: status.runId,
    revision: randomUUID(),
    state,
    mode: status.mode,
    agent: steps[0]?.agent ?? "unknown",
    success: state === "complete",
    summary:
      bound(status.error, TERMINAL_RECORD_SUMMARY_CHARS) ??
      `Run ${state}; the result artifact was unavailable, so this record was synthesized from status.`,
    ...optionalField("error", bound(status.error, TERMINAL_RECORD_ERROR_CHARS)),
    ...optionalField("sessionId", status.sessionId),
    endedAt: status.endedAt ?? status.lastUpdate ?? Date.now(),
    synthesized: true,
    ...((status.steps?.length ?? 0) > steps.length
      ? { childrenOmitted: (status.steps?.length ?? 0) - steps.length }
      : {}),
    children,
  };
}

/** Persist the record and reset any retrieval marker from an earlier terminal state. */
export function writeTerminalRecord(asyncDir: string, record: TerminalRecord): void {
  writeAtomicJson(path.join(asyncDir, TERMINAL_RECORD_FILE), record);
  fs.rmSync(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), { force: true });
}

/**
 * Guarantee a durable record exists for a terminal results artifact before its
 * notification file may be unlinked. Throws when the record cannot be persisted so
 * callers keep the artifact. Returns false when the artifact has no usable asyncDir
 * (nothing durable to write to), true when a record exists afterwards.
 */
export function ensureTerminalRecordFromArtifact(candidate: unknown, runId: string): boolean {
  if (!isTerminalArtifactFor(candidate, runId)) return false;
  const artifact = candidate;
  const asyncDir = artifact.asyncDir;
  if (typeof asyncDir !== "string" || asyncDir.length === 0) return false;
  if (!fs.existsSync(asyncDir)) return false;
  if (readTerminalRecord(asyncDir, artifact.id)) return true;
  writeTerminalRecord(asyncDir, terminalRecordFromArtifact(artifact));
  return true;
}

/** Best-effort write used by finalization; never throws into the runner. */
export function tryWriteTerminalRecordFromArtifact(
  asyncDir: string,
  artifact: AsyncResultArtifact,
): void {
  try {
    writeTerminalRecord(asyncDir, terminalRecordFromArtifact(artifact));
  } catch (error) {
    console.error(`Failed to write terminal record in ${asyncDir}:`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalRecordFor(value: unknown, runId: string): value is TerminalRecord {
  return (
    isRecord(value) &&
    value.version === TERMINAL_RECORD_VERSION &&
    value.runId === runId &&
    typeof value.revision === "string" &&
    value.revision.length > 0 &&
    Array.isArray(value.children)
  );
}

function isTerminalArtifactFor(value: unknown, runId: string): value is AsyncResultArtifact {
  return (
    isRecord(value) &&
    value.id === runId &&
    isTerminalLifecycleState(value.state) &&
    Array.isArray(value.results)
  );
}

export function readTerminalRecord(asyncDir: string, runId: string): TerminalRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(asyncDir, TERMINAL_RECORD_FILE), "utf-8"),
    );
    if (isTerminalRecordFor(parsed, runId)) return parsed;
  } catch {
    // Missing or corrupt: callers fall back to the artifact or status.
  }
  return undefined;
}

function readResultsDirArtifact(
  resultsDir: string,
  runId: string,
): AsyncResultArtifact | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(resultsDir, `${runId}.json`), "utf-8"),
    );
    if (isTerminalArtifactFor(parsed, runId)) return parsed;
  } catch {
    // Unlinked by the watcher or never written.
  }
  return undefined;
}

/** A terminal status is finalized once it has an end time and its runner is gone. */
function finalizedForSynthesis(status: AsyncStatus, kill?: KillFn): boolean {
  if (!isTerminalLifecycleState(status.state)) return false;
  if (typeof status.endedAt !== "number" || !Number.isFinite(status.endedAt)) return false;
  if (status.pid === undefined) return true;
  return checkPidLiveness(status.pid, kill) === "dead";
}

/**
 * Return the durable terminal record for a terminal run, creating it when absent:
 * first from a surviving results-dir artifact, otherwise synthesized from a
 * finalized status. Returns undefined when the run is not yet finalized.
 */
export function ensureTerminalRecord(
  asyncDir: string,
  status: AsyncStatus,
  options: { resultsDir?: string; kill?: KillFn } = {},
): TerminalRecord | undefined {
  if (!isTerminalLifecycleState(status.state)) return undefined;
  const runId = status.runId || path.basename(asyncDir);
  const existing = readTerminalRecord(asyncDir, runId);
  if (existing) return existing;
  const artifact = readResultsDirArtifact(options.resultsDir ?? RESULTS_DIR, runId);
  try {
    if (artifact) {
      const record = terminalRecordFromArtifact(artifact);
      writeTerminalRecord(asyncDir, record);
      return record;
    }
    if (!finalizedForSynthesis(status, options.kill)) return undefined;
    const record = terminalRecordFromStatus(status);
    writeTerminalRecord(asyncDir, record);
    return record;
  } catch {
    return undefined;
  }
}

interface RetrievalMarker {
  revision?: string;
  retrievedIndices: number[];
}

function readRetrievalMarker(asyncDir: string, revision: string): RetrievalMarker {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), "utf-8"),
    );
    // A marker created against a different record revision never counts.
    if (isRecord(parsed) && parsed.revision === revision && Array.isArray(parsed.retrievedIndices))
      return {
        revision,
        retrievedIndices: parsed.retrievedIndices.filter(
          (value): value is number => Number.isInteger(value) && value >= 0,
        ),
      };
  } catch {
    // No marker yet.
  }
  return { retrievedIndices: [] };
}

function hasRetrievalMarker(asyncDir: string, revision: string): boolean {
  return readRetrievalMarker(asyncDir, revision).revision === revision;
}

/**
 * Record that the given child indices (all when omitted) were returned to the session.
 * Ignored when the on-disk record was re-finalized since `record` was read.
 */
export function markTerminalRecordRetrieved(
  asyncDir: string,
  record: TerminalRecord,
  indices?: readonly number[],
): void {
  if (readTerminalRecord(asyncDir, record.runId)?.revision !== record.revision) return;
  const next = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
  for (const index of indices ?? record.children.map((child) => child.index)) next.add(index);
  writeAtomicJson(path.join(asyncDir, TERMINAL_RETRIEVAL_FILE), {
    revision: record.revision,
    retrievedAt: Date.now(),
    retrievedIndices: [...next].sort((a, b) => a - b),
  });
}

/** True while some child's output has not yet been returned through `result`. */
export function hasUnretrievedTerminalRecord(asyncDir: string, record: TerminalRecord): boolean {
  const retrieved = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
  return record.children.length === 0
    ? !hasRetrievalMarker(asyncDir, record.revision)
    : record.children.some((child) => !retrieved.has(child.index));
}

/** Child indices not yet returned through `result` (all indices when no marker exists). */
export function unretrievedChildIndices(asyncDir: string, record: TerminalRecord): number[] {
  const retrieved = new Set(readRetrievalMarker(asyncDir, record.revision).retrievedIndices);
  return record.children.map((child) => child.index).filter((index) => !retrieved.has(index));
}
