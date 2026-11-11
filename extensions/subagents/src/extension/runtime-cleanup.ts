import * as fs from "node:fs";
import * as path from "node:path";
import { checkPidLiveness } from "../runs/background/stale-run-reconciler.ts";
import { isResumableSessionCheckpoint } from "../runs/shared/session-admission.ts";
import { recoverStoppedLifecycleOwnership } from "../runs/shared/lifecycle-state.ts";
import { readBoundedStatusFile } from "../shared/utils.ts";
import { ASYNC_DIR, type AsyncStatus } from "../shared/types.ts";

const EMPTY_ASYNC_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_ASYNC_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface RuntimeCleanupPaths {
  asyncDir: string;
}

interface RuntimeCleanupResult {
  removedAsyncDirs: number;
}

interface RuntimeDirCounts {
  asyncDirs: number;
  retainedAsyncDirs: number;
  activeOrLiveAsyncDirs: number;
  staleAsyncDirs: number;
}

interface RuntimeCleanupDeps {
  now?: () => number;
  kill?: KillFn;
}

interface AsyncRunDirEntry {
  asyncDir: string;
}

interface AsyncStatusReadResult {
  status: AsyncStatus | null;
  statusMtimeMs?: number;
  invalid: boolean;
}

interface AsyncDirInspection {
  entry: AsyncRunDirEntry;
  keep: boolean;
  activeOrLive: boolean;
}

type PidRetentionState = "ownerless" | "alive" | "dead" | "unknown";

const DEFAULT_PATHS: RuntimeCleanupPaths = {
  asyncDir: ASYNC_DIR,
};

function listDirectoryEntries(dirPath: string, strict: boolean): fs.Dirent[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

function listAsyncRunDirs(paths: RuntimeCleanupPaths, strict: boolean): AsyncRunDirEntry[] {
  const entries: AsyncRunDirEntry[] = [];
  for (const entry of listDirectoryEntries(paths.asyncDir, strict)) {
    if (!entry.isDirectory()) continue;
    entries.push({ asyncDir: path.join(paths.asyncDir, entry.name) });
  }
  return entries;
}

function readAsyncStatus(asyncDir: string): AsyncStatusReadResult {
  const result = readBoundedStatusFile(path.join(asyncDir, "status.json"));
  if (result === null) return { status: null, invalid: false };
  if (result === undefined) return { status: null, invalid: true };
  const { content, stat } = result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: null, statusMtimeMs: stat.mtimeMs, invalid: true };
  }

  // null is a sentinel written by some lifecycle transitions; not invalid.
  if (parsed === null) {
    return { status: null, statusMtimeMs: stat.mtimeMs, invalid: false };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: null, statusMtimeMs: stat.mtimeMs, invalid: true };
  }
  return { status: parsed as AsyncStatus, statusMtimeMs: stat.mtimeMs, invalid: false };
}

function newestTreeMtimeMs(dirPath: string): number {
  let newest: number;
  try {
    newest = fs.statSync(dirPath).mtimeMs;
  } catch {
    return 0;
  }
  for (const entry of listDirectoryEntries(dirPath, false)) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestTreeMtimeMs(childPath));
      continue;
    }
    try {
      newest = Math.max(newest, fs.statSync(childPath).mtimeMs);
    } catch {
      continue;
    }
  }
  return newest;
}

function isSignalSafePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function pidRetentionState(status: AsyncStatus, kill: KillFn): PidRetentionState {
  if (!isSignalSafePid(status.pid)) return "ownerless";
  return checkPidLiveness(status.pid, kill);
}

function lifecycleTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function retentionReferenceMs(
  status: AsyncStatus,
  statusMtimeMs: number | undefined,
  dirMtimeMs: number,
): number {
  return Math.max(
    dirMtimeMs,
    statusMtimeMs ?? 0,
    lifecycleTimestamp(status.endedAt),
    lifecycleTimestamp(status.lastUpdate),
    lifecycleTimestamp(status.startedAt),
  );
}

function isWithinRetentionWindow(
  status: AsyncStatus,
  statusMtimeMs: number | undefined,
  dirMtimeMs: number,
  now: number,
): boolean {
  return (
    now - retentionReferenceMs(status, statusMtimeMs, dirMtimeMs) < TERMINAL_ASYNC_DIR_MAX_AGE_MS
  );
}

function inspectKnownLifecycleState(
  status: AsyncStatus,
  statusMtimeMs: number | undefined,
  dirMtimeMs: number,
  now: number,
  kill: KillFn,
): Pick<AsyncDirInspection, "keep" | "activeOrLive"> {
  switch (status.state) {
    case "complete":
    case "completed":
    case "failed":
    case "cancelled":
    case "continued":
      // Lifecycle state is authoritative: stale health metadata must not turn a
      // terminal record back into an active one.
      return {
        keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
        activeOrLive: false,
      };
    case "paused":
      // Paused runs are durable resume records and remain eligible for recovery
      // even when their owner PID has exited or is no longer recorded.
      return { keep: true, activeOrLive: true };
    case "queued":
    case "running": {
      const pidState = pidRetentionState(status, kill);
      if (pidState === "alive" || pidState === "unknown") {
        return { keep: true, activeOrLive: true };
      }
      // A missing or dead owner may be a transient handoff/restart. Keep it for
      // the same grace window as terminal records, then allow stale cleanup.
      return {
        keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
        activeOrLive: false,
      };
    }
    case "pausing": {
      let pidState: PidRetentionState;
      if (isSignalSafePid(status.pid)) {
        try {
          const recovered = recoverStoppedLifecycleOwnership(status, {
            kill,
            now: () => now,
            isResumableSession: (file) => isResumableSessionCheckpoint(file, { kill }),
          });
          if (recovered.repaired) {
            // Lifecycle recovery would finalize this checkpoint to paused. Keep
            // the record even though cleanup itself must not rewrite its status.
            return { keep: true, activeOrLive: true };
          }
          pidState = recovered.pidLiveness ?? "ownerless";
        } catch {
          // Malformed optional lifecycle metadata must not make best-effort
          // cleanup fail; fall back to the existing PID retention policy.
          pidState = pidRetentionState(status, kill);
        }
      } else {
        pidState = "ownerless";
      }
      if (pidState === "alive" || pidState === "unknown") {
        return { keep: true, activeOrLive: true };
      }
      // A missing or dead owner may be a transient handoff/restart. Keep it for
      // the same grace window as terminal records, then allow stale cleanup.
      return {
        keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
        activeOrLive: false,
      };
    }
    default:
      // Unknown lifecycle states are not safe to classify as stale.
      return { keep: true, activeOrLive: false };
  }
}

function inspectAsyncDir(entry: AsyncRunDirEntry, now: number, kill: KillFn): AsyncDirInspection {
  const dirMtimeMs = newestTreeMtimeMs(entry.asyncDir);
  const { status, statusMtimeMs, invalid } = readAsyncStatus(entry.asyncDir);
  if (invalid) {
    return {
      entry,
      keep: true,
      activeOrLive: false,
    };
  }
  if (!status) {
    return {
      entry,
      keep: now - dirMtimeMs < EMPTY_ASYNC_DIR_MAX_AGE_MS,
      activeOrLive: false,
    };
  }
  return {
    entry,
    ...inspectKnownLifecycleState(status, statusMtimeMs, dirMtimeMs, now, kill),
  };
}

function removeDir(dirPath: string): boolean {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function resolvePaths(paths?: Partial<RuntimeCleanupPaths>): RuntimeCleanupPaths {
  return {
    asyncDir: paths?.asyncDir ?? DEFAULT_PATHS.asyncDir,
  };
}

function inspectRuntimeDirsInternal(
  paths: RuntimeCleanupPaths,
  now: number,
  kill: KillFn,
  strict: boolean,
): AsyncDirInspection[] {
  return listAsyncRunDirs(paths, strict).map((entry) => inspectAsyncDir(entry, now, kill));
}

export function inspectRuntimeDirs(
  paths?: Partial<RuntimeCleanupPaths>,
  deps: RuntimeCleanupDeps = {},
): RuntimeDirCounts {
  const now = deps.now?.() ?? Date.now();
  const kill = deps.kill ?? process.kill;
  const resolvedPaths = resolvePaths(paths);
  const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, true);
  return {
    asyncDirs: inspection.length,
    retainedAsyncDirs: inspection.filter((entry) => entry.keep).length,
    activeOrLiveAsyncDirs: inspection.filter((entry) => entry.activeOrLive).length,
    staleAsyncDirs: inspection.filter((entry) => !entry.keep).length,
  };
}

export function cleanupRuntimeDirs(
  paths?: Partial<RuntimeCleanupPaths>,
  deps: RuntimeCleanupDeps = {},
): RuntimeCleanupResult {
  const now = deps.now?.() ?? Date.now();
  const kill = deps.kill ?? process.kill;
  const resolvedPaths = resolvePaths(paths);
  const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, false);
  let removedAsyncDirs = 0;
  for (const entry of inspection) {
    if (entry.keep) continue;
    const latest = inspectAsyncDir(entry.entry, now, kill);
    if (latest.keep) continue;
    if (!removeDir(entry.entry.asyncDir)) continue;
    removedAsyncDirs += 1;
  }
  return { removedAsyncDirs };
}
