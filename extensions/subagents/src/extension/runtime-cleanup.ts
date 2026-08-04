import * as fs from "node:fs";
import * as path from "node:path";
import { checkPidLiveness } from "../runs/background/stale-run-reconciler.ts";
import { NESTED_EVENTS_DIR } from "../runs/shared/nested-events.ts";
import { ASYNC_DIR, TEMP_ROOT_DIR, type AsyncStatus } from "../shared/types.ts";

const EMPTY_ASYNC_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_ASYNC_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNREFERENCED_NESTED_EVENT_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NESTED_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
const ROUTE_FILE = "route.json";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface RuntimeCleanupPaths {
	asyncDir: string;
	nestedRunsDir: string;
	nestedEventsDir: string;
}

export interface RuntimeCleanupResult {
	removedAsyncDirs: number;
	removedNestedEventDirs: number;
}

export interface RuntimeDirCounts {
	topLevelAsyncDirs: number;
	nestedAsyncDirs: number;
	retainedAsyncDirs: number;
	activeOrLiveAsyncDirs: number;
	staleAsyncDirs: number;
	nestedEventDirs: number;
	unreferencedNestedEventDirs: number;
}

interface RuntimeCleanupDeps {
	now?: () => number;
	kill?: KillFn;
}

interface AsyncRunDirEntry {
	asyncDir: string;
	rootRunId: string;
	nested: boolean;
}

interface AsyncStatusReadResult {
	status: AsyncStatus | null;
	statusMtimeMs?: number;
	invalid: boolean;
}

interface AsyncDirInspection {
	entry: AsyncRunDirEntry;
	rootRunId: string;
	keep: boolean;
	activeOrLive: boolean;
}

interface NestedEventRouteEntry {
	dirPath: string;
	rootRunId?: string;
	referenceMtimeMs: number;
}

interface NestedEventRouteInspection extends NestedEventRouteEntry {
	keep: boolean;
}

const DEFAULT_PATHS: RuntimeCleanupPaths = {
	asyncDir: ASYNC_DIR,
	nestedRunsDir: NESTED_RUNS_DIR,
	nestedEventsDir: NESTED_EVENTS_DIR,
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
		entries.push({
			asyncDir: path.join(paths.asyncDir, entry.name),
			rootRunId: entry.name,
			nested: false,
		});
	}
	for (const rootEntry of listDirectoryEntries(paths.nestedRunsDir, strict)) {
		if (!rootEntry.isDirectory()) continue;
		const rootDir = path.join(paths.nestedRunsDir, rootEntry.name);
		for (const runEntry of listDirectoryEntries(rootDir, strict)) {
			if (!runEntry.isDirectory()) continue;
			entries.push({
				asyncDir: path.join(rootDir, runEntry.name),
				rootRunId: rootEntry.name,
				nested: true,
			});
		}
	}
	return entries;
}

function listNestedEventRoutes(nestedEventsDir: string, strict: boolean): NestedEventRouteEntry[] {
	const entries: NestedEventRouteEntry[] = [];
	for (const entry of listDirectoryEntries(nestedEventsDir, strict)) {
		if (!entry.isDirectory()) continue;
		const dirPath = path.join(nestedEventsDir, entry.name);
		let rootRunId: string | undefined;
		try {
			const route = JSON.parse(fs.readFileSync(path.join(dirPath, ROUTE_FILE), "utf-8")) as { rootRunId?: unknown };
			if (typeof route.rootRunId === "string" && route.rootRunId) rootRunId = route.rootRunId;
		} catch {
			// Leave invalid route dirs untouched during cleanup; they may still be inspected manually.
		}
		entries.push({ dirPath, rootRunId, referenceMtimeMs: newestTreeMtimeMs(dirPath) });
	}
	return entries;
}

function readAsyncStatus(asyncDir: string): AsyncStatusReadResult {
	const statusPath = path.join(asyncDir, "status.json");
	let stat: fs.Stats;
	try {
		stat = fs.statSync(statusPath);
		if (!stat.isFile()) return { status: null, invalid: true };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ENOENT") return { status: null, invalid: false };
		return { status: null, invalid: true };
	}
	try {
		return {
			status: JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus,
			statusMtimeMs: stat.mtimeMs,
			invalid: false,
		};
	} catch {
		return { status: null, statusMtimeMs: stat.mtimeMs, invalid: true };
	}
}

function newestTreeMtimeMs(dirPath: string): number {
	let newest = 0;
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

function isActiveOrLive(status: AsyncStatus, kill: KillFn): boolean {
	if (status.activityState === "needs_attention") return true;
	if (status.state === "queued" || status.state === "running" || status.state === "paused") return true;
	if (!isSignalSafePid(status.pid)) return false;
	return checkPidLiveness(status.pid, kill) !== "dead";
}

function terminalReferenceMs(status: AsyncStatus, statusMtimeMs: number | undefined, dirMtimeMs: number): number {
	return Math.max(
		dirMtimeMs,
		statusMtimeMs ?? 0,
		status.endedAt ?? 0,
		status.lastUpdate ?? 0,
		status.startedAt ?? 0,
	);
}

function inspectAsyncDir(entry: AsyncRunDirEntry, now: number, kill: KillFn): AsyncDirInspection {
	const dirMtimeMs = newestTreeMtimeMs(entry.asyncDir);
	const { status, statusMtimeMs, invalid } = readAsyncStatus(entry.asyncDir);
	if (invalid) {
		return {
			entry,
			rootRunId: entry.rootRunId,
			keep: true,
			activeOrLive: false,
		};
	}
	if (!status) {
		return {
			entry,
			rootRunId: entry.rootRunId,
			keep: now - dirMtimeMs < EMPTY_ASYNC_DIR_MAX_AGE_MS,
			activeOrLive: false,
		};
	}
	const rootRunId = entry.nested ? entry.rootRunId : status.runId || entry.rootRunId;
	if (isActiveOrLive(status, kill)) {
		return {
			entry,
			rootRunId,
			keep: true,
			activeOrLive: true,
		};
	}
	if (status.state === "complete" || status.state === "failed") {
		return {
			entry,
			rootRunId,
			keep: now - terminalReferenceMs(status, statusMtimeMs, dirMtimeMs) < TERMINAL_ASYNC_DIR_MAX_AGE_MS,
			activeOrLive: false,
		};
	}
	return {
		entry,
		rootRunId,
		keep: true,
		activeOrLive: false,
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

function removeIfEmpty(dirPath: string): boolean {
	try {
		if (!fs.existsSync(dirPath)) return true;
		const stat = fs.statSync(dirPath);
		if (!stat.isDirectory()) return false;
		if (fs.readdirSync(dirPath).length > 0) return false;
		fs.rmdirSync(dirPath);
		return true;
	} catch {
		return false;
	}
}

function resolvePaths(paths?: Partial<RuntimeCleanupPaths>): RuntimeCleanupPaths {
	return {
		asyncDir: paths?.asyncDir ?? DEFAULT_PATHS.asyncDir,
		nestedRunsDir: paths?.nestedRunsDir ?? DEFAULT_PATHS.nestedRunsDir,
		nestedEventsDir: paths?.nestedEventsDir ?? DEFAULT_PATHS.nestedEventsDir,
	};
}

function inspectRuntimeDirsInternal(paths: RuntimeCleanupPaths, now: number, kill: KillFn, strict: boolean): {
	asyncDirs: AsyncDirInspection[];
	nestedEventRoutes: NestedEventRouteInspection[];
} {
	const asyncDirs = listAsyncRunDirs(paths, strict).map((entry) => inspectAsyncDir(entry, now, kill));
	const retainedRootRunIds = new Set(asyncDirs.filter((entry) => entry.keep).map((entry) => entry.rootRunId));
	const nestedEventRoutes = listNestedEventRoutes(paths.nestedEventsDir, strict).map((entry) => ({
		...entry,
		keep: !entry.rootRunId
			|| retainedRootRunIds.has(entry.rootRunId)
			|| now - entry.referenceMtimeMs < UNREFERENCED_NESTED_EVENT_DIR_MAX_AGE_MS,
	}));
	return {
		asyncDirs,
		nestedEventRoutes,
	};
}

export function inspectRuntimeDirs(paths?: Partial<RuntimeCleanupPaths>, deps: RuntimeCleanupDeps = {}): RuntimeDirCounts {
	const now = deps.now?.() ?? Date.now();
	const kill = deps.kill ?? process.kill;
	const resolvedPaths = resolvePaths(paths);
	const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, true);
	return {
		topLevelAsyncDirs: inspection.asyncDirs.filter((entry) => !entry.entry.nested).length,
		nestedAsyncDirs: inspection.asyncDirs.filter((entry) => entry.entry.nested).length,
		retainedAsyncDirs: inspection.asyncDirs.filter((entry) => entry.keep).length,
		activeOrLiveAsyncDirs: inspection.asyncDirs.filter((entry) => entry.activeOrLive).length,
		staleAsyncDirs: inspection.asyncDirs.filter((entry) => !entry.keep).length,
		nestedEventDirs: inspection.nestedEventRoutes.length,
		unreferencedNestedEventDirs: inspection.nestedEventRoutes.filter((entry) => !entry.keep).length,
	};
}

export function cleanupRuntimeDirs(paths?: Partial<RuntimeCleanupPaths>, deps: RuntimeCleanupDeps = {}): RuntimeCleanupResult {
	const now = deps.now?.() ?? Date.now();
	const kill = deps.kill ?? process.kill;
	const resolvedPaths = resolvePaths(paths);
	const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, false);
	const retainedRootRunIds = new Set<string>();
	let removedAsyncDirs = 0;
	for (const entry of inspection.asyncDirs) {
		if (entry.keep) {
			retainedRootRunIds.add(entry.rootRunId);
			continue;
		}
		if (!removeDir(entry.entry.asyncDir)) {
			retainedRootRunIds.add(entry.rootRunId);
			continue;
		}
		removedAsyncDirs += 1;
		if (entry.entry.nested) {
			removeIfEmpty(path.dirname(entry.entry.asyncDir));
			removeIfEmpty(resolvedPaths.nestedRunsDir);
		}
	}
	let removedNestedEventDirs = 0;
	for (const route of inspection.nestedEventRoutes) {
		if (route.keep || (route.rootRunId && retainedRootRunIds.has(route.rootRunId))) continue;
		if (!removeDir(route.dirPath)) continue;
		removedNestedEventDirs += 1;
	}
	return { removedAsyncDirs, removedNestedEventDirs };
}
