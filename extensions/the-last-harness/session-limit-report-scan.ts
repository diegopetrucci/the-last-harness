import { type Dirent, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TlhSubscriptionUsageSnapshot } from "./types.js";

// Default session-limit window duration: 5 hours in milliseconds.
const DEFAULT_WINDOW_DURATION_MS = 5 * 60 * 60 * 1000;

// Subagent artifacts directory name — never treated as session content.
const SUBAGENT_ARTIFACTS_DIR = "subagent-artifacts";

/**
 * Resolved session-limit time window.
 *
 * - `source: "snapshot"` — derived from a real subscription usage snapshot.
 * - `source: "fallback"` — no snapshot or unusable resetsAt; trailing 5h ending now.
 *   Callers should caveat results when source is "fallback".
 */
export type SessionLimitWindow = {
	startMs: number;
	endMs: number;
	source: "snapshot" | "fallback";
};

/**
 * A raw JSONL entry parsed from a session file.
 * The `type` field is always present on well-formed entries; other fields are
 * preserved as-is from JSON.parse so callers can safely access `message.usage`.
 */
export type RawSessionEntry = Record<string, unknown> & { type: string };

/**
 * Result of parsing a session JSONL file.
 */
export type ParsedSessionFile = {
	/** Entries that parsed successfully (all have a `type` string field). */
	entries: RawSessionEntry[];
	/** Number of lines that could not be parsed (empty lines excluded from count). */
	malformedLineCount: number;
};

/**
 * Result of enumerating candidate session files.
 */
export type SessionFileScanResult = {
	/** Absolute paths to .jsonl files whose mtime is at or after `windowStartMs`. */
	files: string[];
	/** Non-fatal observations recorded during the scan. */
	caveats: string[];
};

/**
 * Resolve the active session-limit window from an optional subscription usage snapshot.
 *
 * Window semantics:
 *   startMs = Date.parse(resetsAt) - durationMs
 *   endMs   = Date.parse(resetsAt)
 *
 * Falls back to a trailing 5-hour window ending at `nowMs` when:
 *   - no snapshot is provided,
 *   - the snapshot has no session window,
 *   - resetsAt is absent or unparseable.
 *
 * @param snapshot  Optional subscription usage snapshot (anthropic or openai-codex).
 * @param nowMs     Current time in ms since epoch (defaults to Date.now()).
 */
export function resolveSessionLimitWindow(
	snapshot: TlhSubscriptionUsageSnapshot | undefined,
	nowMs: number = Date.now(),
): SessionLimitWindow {
	const sessionWindow = snapshot?.windows?.session;
	if (sessionWindow) {
		const resetsAtMs = sessionWindow.resetsAt ? Date.parse(sessionWindow.resetsAt) : NaN;
		if (Number.isFinite(resetsAtMs)) {
			const durationMs = sessionWindow.durationMs ?? DEFAULT_WINDOW_DURATION_MS;
			return {
				startMs: resetsAtMs - durationMs,
				endMs: resetsAtMs,
				source: "snapshot",
			};
		}
	}

	// Fallback: trailing 5h ending now.
	return {
		startMs: nowMs - DEFAULT_WINDOW_DURATION_MS,
		endMs: nowMs,
		source: "fallback",
	};
}

/**
 * Enumerate candidate session `.jsonl` files under `sessionsRoot`.
 *
 * Layout conventions:
 *   Primary sessions:       `<sessionsRoot>/<proj>/<timestamp>_<uuid>.jsonl`
 *   Subagent child sessions: `<sessionsRoot>/<proj>/<parent-basename>/<runId>/run-N/session.jsonl`
 *   Excluded entirely:       `<sessionsRoot>/<proj>/subagent-artifacts/` subtree
 *
 * Files whose `mtime` is strictly before `windowStartMs` are pruned (they cannot
 * contain entries within the window).
 *
 * This function is strictly read-only — it never writes to or modifies the sessions root.
 *
 * @param sessionsRoot  Absolute path to the sessions root directory.
 * @param windowStartMs  Window start timestamp in ms since epoch; files older than this are pruned.
 */
export function discoverSessionFiles(sessionsRoot: string, windowStartMs: number): SessionFileScanResult {
	const files: string[] = [];
	const caveats: string[] = [];

	let projectDirs: string[];
	try {
		projectDirs = readdirSync(sessionsRoot, { withFileTypes: true, encoding: "utf8" })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		caveats.push(`Could not read sessions root: ${message}`);
		return { files, caveats };
	}

	for (const projectDir of projectDirs) {
		collectSessionFilesFromProjectDir(projectDir, windowStartMs, files, caveats);
	}

	return { files, caveats };
}

/**
 * Recursively collect session .jsonl files from a project directory, honouring
 * the subagent-artifacts exclusion and mtime pruning.
 */
function collectSessionFilesFromProjectDir(
	projectDir: string,
	windowStartMs: number,
	files: string[],
	caveats: string[],
): void {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(projectDir, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		caveats.push(`Could not read project directory: ${message}`);
		return;
	}

	for (const entry of entries) {
		const entryPath = join(projectDir, entry.name);

		if (entry.isDirectory()) {
			// Never descend into subagent-artifacts.
			if (entry.name === SUBAGENT_ARTIFACTS_DIR) {
				continue;
			}
			collectSessionFilesRecursive(entryPath, windowStartMs, files, caveats);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			collectIfFresh(entryPath, windowStartMs, files, caveats);
		}
	}
}

/**
 * Recursively collect .jsonl files from a subdirectory (used for subagent child sessions).
 * Excludes subagent-artifacts at every level.
 */
function collectSessionFilesRecursive(dir: string, windowStartMs: number, files: string[], caveats: string[]): void {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		caveats.push(`Could not read directory: ${message}`);
		return;
	}

	for (const entry of entries) {
		const entryPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			if (entry.name === SUBAGENT_ARTIFACTS_DIR) {
				continue;
			}
			collectSessionFilesRecursive(entryPath, windowStartMs, files, caveats);
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			collectIfFresh(entryPath, windowStartMs, files, caveats);
		}
	}
}

/**
 * Stat a file and add it to `files` only if its mtime is at or after `windowStartMs`.
 */
function collectIfFresh(filePath: string, windowStartMs: number, files: string[], caveats: string[]): void {
	try {
		const st = statSync(filePath);
		if (st.mtimeMs >= windowStartMs) {
			files.push(filePath);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		caveats.push(`Could not stat file ${filePath}: ${message}`);
	}
}

/**
 * Parse a session `.jsonl` file into raw entry records.
 *
 * Each non-empty line is parsed as JSON. Lines that fail to parse, or that
 * parse to a value that is not a plain object with a `type` string field, are
 * counted as malformed and skipped.
 *
 * This function reads the entire file into memory; it is suitable for session
 * files of typical size (up to a few MB). Very large files will incur higher
 * memory usage but will not throw.
 *
 * @param filePath  Absolute path to the `.jsonl` session file.
 */
export async function parseSessionJsonl(filePath: string): Promise<ParsedSessionFile> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read session file ${filePath}: ${message}`, { cause: error });
	}

	const entries: RawSessionEntry[] = [];
	let malformedLineCount = 0;

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			// Empty lines are not counted as malformed.
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				typeof (parsed as Record<string, unknown>).type === "string"
			) {
				entries.push(parsed as RawSessionEntry);
			} else {
				malformedLineCount += 1;
			}
		} catch {
			malformedLineCount += 1;
		}
	}

	return { entries, malformedLineCount };
}
