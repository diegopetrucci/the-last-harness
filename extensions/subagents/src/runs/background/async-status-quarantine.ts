import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeAsyncLifecycleStatus } from "../shared/lifecycle-state.ts";
import { type AsyncRunCorruptEntryIssue, validatePersistedAsyncStatus } from "./async-status.ts";
import { fingerprintAsyncStatusContent } from "./async-status-corruption.ts";
import type { AsyncStatus } from "../../shared/types.ts";

export const QUARANTINED_ASYNC_RUNS_DIRNAME = "quarantined-async-subagent-runs";

export interface AsyncStatusQuarantineFs {
	statSync(path: string): fs.Stats;
	readFileSync(path: string, encoding: BufferEncoding): string;
	mkdirSync(path: string, options?: fs.MakeDirectoryOptions): string | undefined;
	renameSync(oldPath: string, newPath: string): void;
}

export interface AsyncStatusQuarantineOptions {
	fs?: AsyncStatusQuarantineFs;
	now?: () => number;
	createUniqueSuffix?: () => string;
}

export type AsyncStatusQuarantineResult =
	| { outcome: "quarantined"; kind: AsyncRunCorruptEntryIssue["kind"]; quarantineDir: string }
	| { outcome: "skipped"; reason: "missing" | "repaired"; kind: AsyncRunCorruptEntryIssue["kind"] }
	| {
			outcome: "deferred";
			reason: "missing_fingerprint" | "changed" | "unstable";
			kind: AsyncRunCorruptEntryIssue["kind"];
			dedupeKey: string;
	  }
	| {
			outcome: "failed";
			reason: "invalid_path" | "stat" | "read" | "mkdir" | "rename";
			kind: AsyncRunCorruptEntryIssue["kind"];
			dedupeKey: string;
	  };

interface StatusSnapshot {
	dev?: number;
	ino?: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function snapshotStatus(stat: fs.Stats): StatusSnapshot {
	return {
		...(Number.isFinite(stat.dev) ? { dev: stat.dev } : {}),
		...(Number.isFinite(stat.ino) ? { ino: stat.ino } : {}),
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ctimeMs: stat.ctimeMs,
	};
}

function sameSnapshot(left: StatusSnapshot, right: StatusSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function confirmCorruption(issue: AsyncRunCorruptEntryIssue, content: string): "confirmed" | "repaired" | "changed" {
	if (issue.kind === "json_parse") {
		try {
			JSON.parse(content);
			return "repaired";
		} catch {
			return "confirmed";
		}
	}

	let parsed: AsyncStatus;
	try {
		parsed = normalizeAsyncLifecycleStatus(JSON.parse(content) as AsyncStatus);
	} catch {
		return "changed";
	}
	try {
		validatePersistedAsyncStatus(issue.asyncDir, parsed as AsyncStatus & { cwd?: string });
		return "repaired";
	} catch {
		return "confirmed";
	}
}

function buildQuarantinePath(asyncDirRoot: string, entry: string, suffix: string): string {
	return path.join(path.dirname(asyncDirRoot), QUARANTINED_ASYNC_RUNS_DIRNAME, `${entry}.${suffix}`);
}

function buildDedupeKey(issue: AsyncRunCorruptEntryIssue, reason: string): string {
	return `${issue.entry}\u0000${issue.fingerprint?.value ?? "missing-fingerprint"}\u0000${reason}`;
}

function isValidFingerprint(
	issue: AsyncRunCorruptEntryIssue,
): issue is AsyncRunCorruptEntryIssue & { fingerprint: { algorithm: "sha256"; value: string } } {
	return issue.fingerprint?.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(issue.fingerprint.value);
}

function validateIssuePaths(asyncDirRoot: string, issue: AsyncRunCorruptEntryIssue): boolean {
	const resolvedRoot = path.resolve(asyncDirRoot);
	if (!issue.entry || issue.entry !== path.basename(issue.entry)) return false;
	const expectedAsyncDir = path.resolve(asyncDirRoot, issue.entry);
	const expectedStatusPath = path.resolve(expectedAsyncDir, "status.json");
	const asyncDirWithinRoot = path.relative(resolvedRoot, expectedAsyncDir);
	if (asyncDirWithinRoot === "" || asyncDirWithinRoot.startsWith("..") || path.isAbsolute(asyncDirWithinRoot))
		return false;
	return path.resolve(issue.asyncDir) === expectedAsyncDir && path.resolve(issue.statusPath) === expectedStatusPath;
}

export function quarantineCorruptAsyncRun(
	asyncDirRoot: string,
	issue: AsyncRunCorruptEntryIssue,
	options: AsyncStatusQuarantineOptions = {},
): AsyncStatusQuarantineResult {
	const fsApi = options.fs ?? fs;
	const now = options.now ?? Date.now;
	const createUniqueSuffix = options.createUniqueSuffix ?? (() => `${now()}-${Math.random().toString(36).slice(2, 8)}`);
	if (!isValidFingerprint(issue)) {
		return {
			outcome: "deferred",
			reason: "missing_fingerprint",
			kind: issue.kind,
			dedupeKey: buildDedupeKey(issue, "missing_fingerprint"),
		};
	}
	if (!validateIssuePaths(asyncDirRoot, issue)) {
		return {
			outcome: "failed",
			reason: "invalid_path",
			kind: issue.kind,
			dedupeKey: buildDedupeKey(issue, "invalid_path"),
		};
	}

	let before: StatusSnapshot;
	try {
		before = snapshotStatus(fsApi.statSync(issue.statusPath));
	} catch (error) {
		if (isNotFoundError(error)) return { outcome: "skipped", reason: "missing", kind: issue.kind };
		return { outcome: "failed", reason: "stat", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "stat") };
	}

	let content: string;
	try {
		content = fsApi.readFileSync(issue.statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return { outcome: "skipped", reason: "missing", kind: issue.kind };
		return { outcome: "failed", reason: "read", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "read") };
	}

	let after: StatusSnapshot;
	try {
		after = snapshotStatus(fsApi.statSync(issue.statusPath));
	} catch (error) {
		if (isNotFoundError(error)) return { outcome: "skipped", reason: "missing", kind: issue.kind };
		return { outcome: "failed", reason: "stat", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "stat") };
	}

	if (!sameSnapshot(before, after))
		return { outcome: "deferred", reason: "unstable", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "unstable") };
	const fingerprint = fingerprintAsyncStatusContent(content);
	if (fingerprint.value !== issue.fingerprint.value)
		return { outcome: "deferred", reason: "changed", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "changed") };
	const confirmation = confirmCorruption(issue, content);
	if (confirmation === "repaired") return { outcome: "skipped", reason: "repaired", kind: issue.kind };
	if (confirmation === "changed")
		return { outcome: "deferred", reason: "changed", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "changed") };

	const quarantineDir = buildQuarantinePath(asyncDirRoot, issue.entry, createUniqueSuffix());
	// This minimizes, but cannot remove, the final TOCTOU gap between confirming
	// unchanged corruption and renaming the run directory.
	try {
		fsApi.mkdirSync(path.dirname(quarantineDir), { recursive: true });
	} catch {
		return { outcome: "failed", reason: "mkdir", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "mkdir") };
	}
	try {
		fsApi.renameSync(issue.asyncDir, quarantineDir);
	} catch (error) {
		if (isNotFoundError(error)) return { outcome: "skipped", reason: "missing", kind: issue.kind };
		return { outcome: "failed", reason: "rename", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "rename") };
	}
	return { outcome: "quarantined", kind: issue.kind, quarantineDir };
}
