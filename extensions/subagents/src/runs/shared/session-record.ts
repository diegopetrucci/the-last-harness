import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { parseContextUsageDiagnostics } from "../../shared/context-diagnostics.ts";
import type { ContextUsageDiagnostics } from "../../shared/types.ts";
import {
  acquireDirectoryLock,
  checkPidLiveness,
  LifecycleLockExhaustedError,
  type LifecycleLockOptions,
} from "./lifecycle-state.ts";
import { supportsOwnedProcessGroupCleanup } from "./process-group-cleanup.ts";

/**
 * Per-child-session ownership record, stored as a sidecar next to the canonical
 * session file. It identifies a subagent instance by that file and holds an
 * exclusive lease so only one live writer drives the session.
 *
 * The sidecar name ends in `.owner.json`, never `.jsonl`, so `tlh sessions` and
 * Pi's session listing (both scan `*.jsonl`) ignore it. It holds no transcript
 * content. Retention follows the session file; moved, copied or hard-linked
 * session files are unsupported. The session file itself need not exist yet
 * (Pi creates it lazily), but its parent directory must.
 *
 * Mutual exclusion for read-modify-write uses the lifecycle directory lock
 * (token-scoped stale recovery) at `<sidecar>.lock`. That lock is short-lived;
 * the lease itself is data in the record and is proven stale only by liveness
 * probes, never by lock age. Nothing here ever signals a process.
 */
export const SESSION_RECORD_SCHEMA_VERSION = 1;

export interface SessionLease {
  /** Holder token; every fenced call must present it. */
  token: string;
  runnerPid: number;
  /** Child process-group ids recorded as data (positive; probed, never signalled). */
  processGroups: number[];
  acquiredAt: number;
}

export interface SessionRecord {
  schemaVersion: typeof SESSION_RECORD_SCHEMA_VERSION;
  /** Monotonic; incremented by every lease acquisition. */
  generation: number;
  /** Cumulative active runtime, merged by max. */
  activeRuntimeMs: number;
  retired: boolean;
  retiredReason?: string;
  /** Latest-by-generation, never max-merged. */
  contextUsage?: { generation: number; usage: ContextUsageDiagnostics };
  latestRunId?: string;
  /** Set when the latest attempt (`generation`) finished cleanly; cleared on acquire. */
  cleanFinal?: { runId: string; generation: number };
  lease?: SessionLease;
}

export type SessionRecordReadResult =
  | { status: "ok"; record: SessionRecord }
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unreadable"; error: Error }
  | { status: "wrong-schema"; schemaVersion: unknown };

export type SessionRecordReadFailure = Exclude<SessionRecordReadResult, { status: "ok" }>;

/** Identifies the lease a caller was granted; required by every mutation. */
export interface SessionLeaseHandle {
  token: string;
  generation: number;
}

export type FencedResult =
  | { status: "ok"; record: SessionRecord }
  | { status: "not-holder" }
  | { status: "busy" }
  | SessionRecordReadFailure;

export type AcquireResult =
  | { status: "acquired"; handle: SessionLeaseHandle; record: SessionRecord }
  | { status: "held"; holder: SessionLease }
  | { status: "retired"; reason?: string }
  | {
      /** Last attempt ended without a clean final record; permanently refused. */
      status: "abandoned";
      generation: number;
      /** Present when the lease was never released (proven stale). */
      staleLease?: SessionLease;
    }
  | { status: "busy" }
  | SessionRecordReadFailure;

export type CreateResult =
  | { status: "created"; record: SessionRecord }
  /** `requireSessionAbsent` was set and the session file already exists (no record). */
  | { status: "session-exists" }
  | { status: "exists" }
  | { status: "busy" }
  | { status: "unreadable"; error: Error };

export interface SessionRecordDeps {
  lockOptions?: LifecycleLockOptions;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  /** Platform used for the process-group capability check. */
  platform?: NodeJS.Platform;
}

export interface SessionLeaseUpdate {
  /** Merged by max with the stored value. */
  activeRuntimeMs?: number;
  contextUsage?: ContextUsageDiagnostics;
  latestRunId?: string;
  /** Unioned into the recorded groups. */
  processGroups?: readonly number[];
}

const RECORD_SUFFIX = ".owner.json";
const RECORD_MODE = 0o600;

const writeRecordFile = createAtomicJsonWriter({
  fs: {
    mkdirSync: fs.mkdirSync,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    writeFileSync: (file, data) =>
      fs.writeFileSync(file, data, { encoding: "utf-8", mode: RECORD_MODE }),
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value: unknown): value is number => isCount(value) && value > 0;
const isMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
const errorCode = (error: unknown): string | undefined =>
  isObject(error) && typeof error.code === "string" ? error.code : undefined;

type Resolved = { ok: true; file: string } | { ok: false; failure: SessionRecordReadFailure };

/** Canonicalize via realpath of the existing parent directory. */
function resolveRecordFile(sessionFile: string): Resolved {
  try {
    // A symlinked final component would give one session two ownership identities.
    if (fs.lstatSync(sessionFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return {
        ok: false,
        failure: {
          status: "unreadable",
          error: new Error(`Session file is a symlink: ${sessionFile}`),
        },
      };
    }
    const parent = fs.realpathSync(path.dirname(path.resolve(sessionFile)));
    return { ok: true, file: path.join(parent, path.basename(sessionFile) + RECORD_SUFFIX) };
  } catch (error) {
    return {
      ok: false,
      failure:
        errorCode(error) === "ENOENT"
          ? { status: "missing" }
          : { status: "unreadable", error: toError(error) },
    };
  }
}

/** Sidecar path for a session file (parent must exist). */
export function sessionRecordPath(sessionFile: string): string {
  const resolved = resolveRecordFile(sessionFile);
  if (!resolved.ok) {
    throw resolved.failure.status === "unreadable"
      ? resolved.failure.error
      : new Error(`Session directory does not exist for ${sessionFile}`);
  }
  return resolved.file;
}

function parseLease(value: unknown): SessionLease | undefined {
  if (!isObject(value)) return undefined;
  const { token, runnerPid, processGroups, acquiredAt } = value;
  if (typeof token !== "string" || token.length === 0) return undefined;
  if (!isPositiveInt(runnerPid) || !isMs(acquiredAt)) return undefined;
  if (!Array.isArray(processGroups) || !processGroups.every(isPositiveInt)) return undefined;
  return { token, runnerPid, processGroups: [...processGroups], acquiredAt };
}

function parseRecord(value: unknown): SessionRecord | SessionRecordReadFailure {
  const corrupt = (reason: string): SessionRecordReadFailure => ({ status: "corrupt", reason });
  if (!isObject(value)) return corrupt("record is not an object");
  if (value.schemaVersion !== SESSION_RECORD_SCHEMA_VERSION) {
    return typeof value.schemaVersion === "number"
      ? { status: "wrong-schema", schemaVersion: value.schemaVersion }
      : corrupt("schemaVersion missing or not a number");
  }
  if (!isCount(value.generation)) return corrupt("invalid generation");
  if (!isMs(value.activeRuntimeMs)) return corrupt("invalid activeRuntimeMs");
  if (typeof value.retired !== "boolean") return corrupt("invalid retired flag");
  const record: SessionRecord = {
    schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
    generation: value.generation,
    activeRuntimeMs: value.activeRuntimeMs,
    retired: value.retired,
  };
  if (value.retiredReason !== undefined) {
    if (typeof value.retiredReason !== "string") return corrupt("invalid retiredReason");
    record.retiredReason = value.retiredReason;
  }
  if (value.latestRunId !== undefined) {
    if (typeof value.latestRunId !== "string") return corrupt("invalid latestRunId");
    record.latestRunId = value.latestRunId;
  }
  if (value.contextUsage !== undefined) {
    const cu = value.contextUsage;
    const usage = isObject(cu) ? parseContextUsageDiagnostics(cu.usage) : undefined;
    if (!isObject(cu) || !isCount(cu.generation) || !usage) return corrupt("invalid contextUsage");
    record.contextUsage = { generation: cu.generation, usage };
  }
  if (value.cleanFinal !== undefined) {
    const cf = value.cleanFinal;
    if (!isObject(cf) || typeof cf.runId !== "string" || !isCount(cf.generation))
      return corrupt("invalid cleanFinal");
    record.cleanFinal = { runId: cf.runId, generation: cf.generation };
  }
  if (value.lease !== undefined) {
    const lease = parseLease(value.lease);
    if (!lease) return corrupt("invalid lease");
    record.lease = lease;
  }
  return record;
}

function readRecordFile(file: string): SessionRecordReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable", error: toError(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt", reason: "invalid JSON" };
  }
  const result = parseRecord(parsed);
  return "status" in result ? result : { status: "ok", record: result };
}

/** Read the record for a session file. Never creates or initializes anything. */
export function readSessionRecord(sessionFile: string): SessionRecordReadResult {
  const resolved = resolveRecordFile(sessionFile);
  return resolved.ok ? readRecordFile(resolved.file) : resolved.failure;
}

type Probe = "dead" | "alive" | "unknown";

function probeProcessGroup(pgid: number, kill: NonNullable<SessionRecordDeps["kill"]>): Probe {
  try {
    kill(-pgid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    return code === "EPERM" ? "alive" : "unknown";
  }
}

/**
 * A lease is stale only when the runner pid and every recorded process group are
 * proven dead. Alive or unknown liveness (including recorded groups on a
 * platform where groups cannot be probed) counts as held. Read-only: never signals.
 */
export function isSessionLeaseStale(lease: SessionLease, deps: SessionRecordDeps = {}): boolean {
  const kill = deps.kill ?? process.kill.bind(process);
  if (checkPidLiveness(lease.runnerPid, kill) !== "dead") return false;
  if (lease.processGroups.length === 0) return true;
  if (!supportsOwnedProcessGroupCleanup(deps.platform)) return false;
  return lease.processGroups.every((pgid) => probeProcessGroup(pgid, kill) === "dead");
}

/** Run `operation` under the sidecar lock; contention maps to `busy`. */
function withRecordLock<T>(
  file: string,
  deps: SessionRecordDeps,
  operation: () => T,
): T | { status: "busy" } | { status: "unreadable"; error: Error } {
  let release: () => void;
  try {
    release = acquireDirectoryLock(
      `${file}.lock`,
      deps.lockOptions ?? {},
      (held) => `Session record ${path.basename(file)} is locked (pid ${held.pid ?? "unknown"}).`,
    );
  } catch (error) {
    if (error instanceof LifecycleLockExhaustedError) return { status: "busy" };
    return { status: "unreadable", error: toError(error) };
  }
  try {
    return operation();
  } finally {
    release();
  }
}

/**
 * Create the record for a fresh session. Refuses (`exists`) when any sidecar is
 * already present, including corrupt ones; existing records are never overwritten.
 */
export function createSessionRecord(
  sessionFile: string,
  init: { latestRunId?: string; requireSessionAbsent?: boolean } = {},
  deps: SessionRecordDeps = {},
): CreateResult {
  const resolved = resolveRecordFile(sessionFile);
  if (!resolved.ok) {
    return {
      status: "unreadable",
      error:
        resolved.failure.status === "unreadable"
          ? resolved.failure.error
          : new Error(`Session directory does not exist for ${sessionFile}`),
    };
  }
  const file = resolved.file;
  const result = withRecordLock(file, deps, (): CreateResult => {
    if (fs.existsSync(file)) return { status: "exists" };
    if (init.requireSessionAbsent && fs.lstatSync(sessionFile, { throwIfNoEntry: false })) {
      return { status: "session-exists" };
    }
    const record: SessionRecord = {
      schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
      generation: 0,
      activeRuntimeMs: 0,
      retired: false,
      ...(init.latestRunId === undefined ? {} : { latestRunId: init.latestRunId }),
    };
    writeRecordFile(file, record);
    return { status: "created", record };
  });
  return result;
}

/** Classify ownership from a record and its observed lease liveness without writing. */
export function classifySessionForResume(
  record: SessionRecord,
  leaseIsStale: boolean,
): Extract<AcquireResult, { status: "retired" | "held" | "abandoned" }> | undefined {
  if (record.retired) {
    return {
      status: "retired",
      ...(record.retiredReason ? { reason: record.retiredReason } : {}),
    };
  }
  if (record.lease) {
    return leaseIsStale
      ? { status: "abandoned", generation: record.generation, staleLease: record.lease }
      : { status: "held", holder: record.lease };
  }
  if (record.generation > 0 && record.cleanFinal?.generation !== record.generation) {
    return { status: "abandoned", generation: record.generation };
  }
  return undefined;
}

/**
 * Take the exclusive lease. A record must already exist (never initialized
 * implicitly) and not be retired. Never takes over: a stale lease, or a
 * released/vanished holder without a clean-final marker for the last generation,
 * is `abandoned` and the record is left untouched as evidence. Only a live or
 * unknown-liveness lease is `held`. Generation 0 (never acquired) is acquirable.
 * Check order: read failure, retired, held, abandoned, acquire.
 */
export function acquireSessionLease(
  sessionFile: string,
  holder: { runnerPid: number; processGroups?: readonly number[] },
  deps: SessionRecordDeps = {},
): AcquireResult {
  const resolved = resolveRecordFile(sessionFile);
  if (!resolved.ok) return resolved.failure;
  const file = resolved.file;
  const result = withRecordLock(file, deps, (): AcquireResult => {
    const read = readRecordFile(file);
    if (read.status !== "ok") return read;
    const { record } = read;
    const refusal = classifySessionForResume(
      record,
      !record.retired && !!record.lease && isSessionLeaseStale(record.lease, deps),
    );
    if (refusal) return refusal;
    const token = randomUUID();
    const next: SessionRecord = {
      ...record,
      generation: record.generation + 1,
      lease: {
        token,
        runnerPid: holder.runnerPid,
        processGroups: [...new Set(holder.processGroups ?? [])],
        acquiredAt: (deps.now ?? Date.now)(),
      },
    };
    delete next.cleanFinal;
    writeRecordFile(file, next);
    return { status: "acquired", handle: { token, generation: next.generation }, record: next };
  });
  return result;
}

/** Apply `mutate` only while `handle` is still the record's current lease. */
function fencedMutate(
  sessionFile: string,
  handle: SessionLeaseHandle,
  deps: SessionRecordDeps,
  mutate: (record: SessionRecord) => SessionRecord,
): FencedResult {
  const resolved = resolveRecordFile(sessionFile);
  if (!resolved.ok) return resolved.failure;
  const file = resolved.file;
  const result = withRecordLock(file, deps, (): FencedResult => {
    const read = readRecordFile(file);
    if (read.status !== "ok") return read;
    const { record } = read;
    if (record.lease?.token !== handle.token || record.generation !== handle.generation) {
      return { status: "not-holder" };
    }
    const next = mutate(record);
    writeRecordFile(file, next);
    return { status: "ok", record: next };
  });
  return result;
}

/** Fenced update: runtime merges by max, context usage is latest-by-generation. */
export function updateSessionLease(
  sessionFile: string,
  handle: SessionLeaseHandle,
  update: SessionLeaseUpdate,
  deps: SessionRecordDeps = {},
): FencedResult {
  return fencedMutate(sessionFile, handle, deps, (record) => {
    const lease = record.lease as SessionLease;
    const next: SessionRecord = { ...record };
    if (update.activeRuntimeMs !== undefined && isMs(update.activeRuntimeMs)) {
      next.activeRuntimeMs = Math.max(record.activeRuntimeMs, update.activeRuntimeMs);
    }
    if (
      update.contextUsage !== undefined &&
      handle.generation >= (record.contextUsage?.generation ?? 0)
    ) {
      next.contextUsage = { generation: handle.generation, usage: { ...update.contextUsage } };
    }
    if (update.latestRunId !== undefined) next.latestRunId = update.latestRunId;
    if (update.processGroups !== undefined) {
      next.lease = {
        ...lease,
        processGroups: [
          ...new Set([...lease.processGroups, ...update.processGroups.filter(isPositiveInt)]),
        ],
      };
    }
    return next;
  });
}

/** Mark the latest attempt as having finished cleanly. */
export function markSessionCleanFinal(
  sessionFile: string,
  handle: SessionLeaseHandle,
  runId: string,
  deps: SessionRecordDeps = {},
): FencedResult {
  return fencedMutate(sessionFile, handle, deps, (record) => ({
    ...record,
    latestRunId: runId,
    cleanFinal: { runId, generation: handle.generation },
  }));
}

/** Permanently retire the session; the holder still releases its lease afterwards. */
export function retireSession(
  sessionFile: string,
  handle: SessionLeaseHandle,
  reason: string,
  deps: SessionRecordDeps = {},
): FencedResult {
  return fencedMutate(sessionFile, handle, deps, (record) => ({
    ...record,
    retired: true,
    retiredReason: reason,
  }));
}

/** Release the lease. A stale holder gets `not-holder` and changes nothing. */
export function releaseSessionLease(
  sessionFile: string,
  handle: SessionLeaseHandle,
  deps: SessionRecordDeps = {},
): FencedResult {
  return fencedMutate(sessionFile, handle, deps, (record) => {
    const next: SessionRecord = { ...record };
    delete next.lease;
    return next;
  });
}
