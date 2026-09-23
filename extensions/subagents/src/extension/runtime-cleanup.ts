import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "../shared/utils.ts";
import { NESTED_EVENTS_DIR } from "../runs/shared/nested-events.ts";
import { isSafeNestedPathId } from "../runs/shared/nested-path.ts";
import { isTerminalLifecycleState } from "../runs/shared/lifecycle-state.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus } from "../shared/types.ts";

const EMPTY_ASYNC_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_ASYNC_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const UNREFERENCED_NESTED_EVENT_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NESTED_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");

const ROUTE_FILE = "route.json";

type RuntimeCleanupPaths = {
  asyncDir: string;
  nestedRunsDir: string;
  nestedEventsDir: string;
};

type RuntimeCleanupResult = {
  removedAsyncDirs: number;
  removedNestedEventDirs: number;
};

type RuntimeDirCounts = {
  topLevelAsyncDirs: number;
  nestedAsyncDirs: number;
  retainedAsyncDirs: number;
  activeOrLiveAsyncDirs: number;
  staleAsyncDirs: number;
  nestedEventDirs: number;
  unreferencedNestedEventDirs: number;
};

type RuntimeCleanupDeps = {
  now?: () => number;
};

type AsyncRunDirEntry = {
  asyncDir: string;
  rootRunId: string;
  nested: boolean;
};

type AsyncDirInspection = AsyncRunDirEntry & {
  keep: boolean;
  activeOrLive: boolean;
};

type NestedEventRouteInspection = {
  dirPath: string;
  rootRunId?: string;
  keep: boolean;
};

const DEFAULT_PATHS: RuntimeCleanupPaths = {
  asyncDir: ASYNC_DIR,
  nestedRunsDir: NESTED_RUNS_DIR,
  nestedEventsDir: NESTED_EVENTS_DIR,
};

function directoryEntries(dirPath: string, strict: boolean): fs.Dirent[] {
  if (!fs.existsSync(dirPath)) return [];
  try {
    if (!fs.statSync(dirPath).isDirectory()) throw new Error(`not a directory: ${dirPath}`);
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

function asyncRunDirs(paths: RuntimeCleanupPaths, strict: boolean): AsyncRunDirEntry[] {
  const result: AsyncRunDirEntry[] = [];
  for (const item of directoryEntries(paths.asyncDir, strict))
    if (item.isDirectory())
      result.push({
        asyncDir: path.join(paths.asyncDir, item.name),
        rootRunId: item.name,
        nested: false,
      });

  for (const root of directoryEntries(paths.nestedRunsDir, strict)) {
    if (!root.isDirectory()) continue;
    const rootDir = path.join(paths.nestedRunsDir, root.name);
    for (const run of directoryEntries(rootDir, strict))
      if (run.isDirectory())
        result.push({ asyncDir: path.join(rootDir, run.name), rootRunId: root.name, nested: true });
  }
  return result;
}

function newestMtime(dirPath: string): number {
  let newest: number;
  try {
    newest = fs.statSync(dirPath).mtimeMs;
  } catch {
    return 0;
  }

  for (const entry of directoryEntries(dirPath, false)) {
    try {
      const child = path.join(dirPath, entry.name);
      const mtime = fs.statSync(child).mtimeMs;
      newest = Math.max(newest, entry.isDirectory() ? newestMtime(child) : mtime);
    } catch {
      /* Unreadable/disappearing children retain their parent. */
    }
  }
  return newest;
}

function readAsyncStatus(asyncDir: string): {
  status?: AsyncStatus;
  mtimeMs?: number;
  readable: boolean;
} {
  const statusPath = path.join(asyncDir, "status.json");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(statusPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { readable: true }
      : { readable: false };
  }

  if (!stat.isFile()) return { readable: false };

  try {
    const status = readStatus(asyncDir, { cache: false });
    return status ? { status, mtimeMs: stat.mtimeMs, readable: true } : { readable: false };
  } catch {
    return { readable: false };
  }
}

const terminalReferenceMs = (
  status: AsyncStatus,
  statusMtimeMs: number | undefined,
  dirMtimeMs: number,
): number =>
  Math.max(
    dirMtimeMs,
    statusMtimeMs ?? 0,
    status.endedAt ?? 0,
    status.lastUpdate ?? 0,
    status.startedAt ?? 0,
  );

function inspectAsyncDir(entry: AsyncRunDirEntry, now: number): AsyncDirInspection {
  const dirMtimeMs = newestMtime(entry.asyncDir);
  const read = readAsyncStatus(entry.asyncDir);

  if (!read.readable) return { ...entry, keep: true, activeOrLive: false };
  if (!read.status)
    return { ...entry, keep: now - dirMtimeMs < EMPTY_ASYNC_DIR_MAX_AGE_MS, activeOrLive: false };
  const rootRunId = entry.nested ? entry.rootRunId : read.status.runId || entry.rootRunId;

  if (read.status.state === "paused" || !isTerminalLifecycleState(read.status.state))
    return { ...entry, rootRunId, keep: true, activeOrLive: true };
  return {
    ...entry,
    rootRunId,
    keep:
      now - terminalReferenceMs(read.status, read.mtimeMs, dirMtimeMs) <
      TERMINAL_ASYNC_DIR_MAX_AGE_MS,
    activeOrLive: false,
  };
}

function inspectRoutes(
  nestedEventsDir: string,
  retainedRoots: Set<string>,
  now: number,
  strict: boolean,
): NestedEventRouteInspection[] {
  return directoryEntries(nestedEventsDir, strict)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(nestedEventsDir, entry.name);
      let rootRunId: string | undefined;

      try {
        const route = JSON.parse(fs.readFileSync(path.join(dirPath, ROUTE_FILE), "utf8")) as Record<
          string,
          unknown
        >;
        if (isSafeNestedPathId(route.rootRunId) && isSafeNestedPathId(route.capabilityToken))
          rootRunId = route.rootRunId;
      } catch {
        /* Invalid route metadata cannot prove ownership. */
      }

      const referenceMtimeMs = newestMtime(dirPath);
      return {
        dirPath,
        rootRunId,
        keep:
          rootRunId === undefined ||
          retainedRoots.has(rootRunId) ||
          now - referenceMtimeMs < UNREFERENCED_NESTED_EVENT_DIR_MAX_AGE_MS,
      };
    });
}

const resolvePaths = (paths?: Partial<RuntimeCleanupPaths>): RuntimeCleanupPaths => ({
  ...DEFAULT_PATHS,
  ...paths,
});

function inspectRuntimeDirsInternal(paths: RuntimeCleanupPaths, now: number, strict: boolean) {
  const asyncDirs = asyncRunDirs(paths, strict).map((entry) => inspectAsyncDir(entry, now));

  const retainedRoots = new Set(
    asyncDirs.filter((entry) => entry.keep).map((entry) => entry.rootRunId),
  );
  return { asyncDirs, routes: inspectRoutes(paths.nestedEventsDir, retainedRoots, now, strict) };
}

function removeDirectory(dirPath: string): boolean {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function removeIfEmpty(dirPath: string): void {
  try {
    fs.rmdirSync(dirPath);
  } catch {
    /* Parent cleanup is best effort. */
  }
}

export function inspectRuntimeDirs(
  paths?: Partial<RuntimeCleanupPaths>,
  deps: RuntimeCleanupDeps = {},
): RuntimeDirCounts {
  const inspection = inspectRuntimeDirsInternal(
    resolvePaths(paths),
    deps.now?.() ?? Date.now(),
    true,
  );
  return {
    topLevelAsyncDirs: inspection.asyncDirs.filter((entry) => !entry.nested).length,
    nestedAsyncDirs: inspection.asyncDirs.filter((entry) => entry.nested).length,
    retainedAsyncDirs: inspection.asyncDirs.filter((entry) => entry.keep).length,
    activeOrLiveAsyncDirs: inspection.asyncDirs.filter((entry) => entry.activeOrLive).length,
    staleAsyncDirs: inspection.asyncDirs.filter((entry) => !entry.keep).length,
    nestedEventDirs: inspection.routes.length,
    unreferencedNestedEventDirs: inspection.routes.filter((entry) => !entry.keep).length,
  };
}

export function cleanupRuntimeDirs(
  paths?: Partial<RuntimeCleanupPaths>,
  deps: RuntimeCleanupDeps = {},
): RuntimeCleanupResult {
  const resolved = resolvePaths(paths);
  const inspection = inspectRuntimeDirsInternal(resolved, deps.now?.() ?? Date.now(), false);
  const retainedRoots = new Set<string>();
  let removedAsyncDirs = 0;

  for (const item of inspection.asyncDirs) {
    if (item.keep || !removeDirectory(item.asyncDir)) {
      retainedRoots.add(item.rootRunId);
      continue;
    }
    removedAsyncDirs++;
    if (item.nested) {
      removeIfEmpty(path.dirname(item.asyncDir));
      removeIfEmpty(resolved.nestedRunsDir);
    }
  }

  let removedNestedEventDirs = 0;
  for (const route of inspection.routes) {
    if (route.keep || (route.rootRunId && retainedRoots.has(route.rootRunId))) continue;
    if (removeDirectory(route.dirPath)) removedNestedEventDirs++;
  }
  return { removedAsyncDirs, removedNestedEventDirs };
}
