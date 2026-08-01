/**
 * Read-only session analysis module.
 *
 * Parses Pi session JSONL files and exposes a normalized read model.
 * All operations are strictly read-only — nothing in this module may
 * write to, mutate, or rewrite any file under the sessions directory.
 *
 * IMPORTANT: Do not import run-history.jsonl via any path.  Its
 * loadRunsForAgent reader performs a destructive truncation on read.
 *
 * This module is for out-of-process CLI use only.  Do NOT import it
 * from the extension startup path.
 */

import { createReadStream, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { pairToolCalls } from "../../extensions/the-last-harness/tool-pairing.js";
import type { SubagentDetails, SubagentResultEntry, ToolPair } from "../../extensions/the-last-harness/tool-pairing.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Session header — the first entry in every session JSONL file. */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
}

/** Cost breakdown from an assistant message's usage object. */
export interface MessageUsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Token/cost usage from an assistant message. */
export interface MessageUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning: number;
	cost: MessageUsageCost;
}

// Re-export pairing types so this module's public API is unchanged.
export type { SubagentDetails, SubagentResultEntry, ToolPair } from "../../extensions/the-last-harness/tool-pairing.js";

/** Result of scanning a single session JSONL file. */
export interface SessionScanResult {
	filePath: string;
	sessionHeader: SessionHeader | null;
	toolPairs: ToolPair[];
	/** Lines that could not be parsed as JSON or were not valid entries. */
	malformedLines: number;
	/** Tool calls with no matching tool result (session may still be active). */
	unmatchedToolCallCount: number;
	/** Tool results with no matching tool call (e.g. call was in a prior file). */
	unmatchedToolResultCount: number;
	/** True if the file's byte size changed between the stat before and after reading. */
	fileSizeChangedDuringScan: boolean;
	/**
	 * Total number of tool-call occurrences observed in the file, including
	 * unmatched and duplicate IDs.  Always >= toolPairs.length.
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

/**
 * A correlation linking a parent session to a child session via a subagent
 * tool result.  All fields come from data already present in the corpus —
 * nothing is synthesised.
 */
export interface SubagentCorrelation {
	parentSessionFile: string;
	parentSessionId: string;
	toolCallId: string;
	runId: string;
	agent?: string | undefined;
	childSessionFile: string;
	/**
	 * True when the child session file was readable and its header was loaded.
	 * False when the file did not exist, was unreadable, or lay outside the
	 * sessions directory being scanned (path safety boundary).
	 */
	childResolved: boolean;
	/** Session ID from the child session header, when resolved. */
	childSessionId?: string | undefined;
	/** Start timestamp from the child session header, when resolved. */
	childStartedAt?: string | undefined;
}

/** Coverage summary aggregated across multiple scan results. */
export interface ScanCoverage {
	/** Total JSONL files discovered (before filtering run-history.jsonl). */
	filesDiscovered: number;
	/** Files successfully scanned (toolPairs + malformed lines accumulated). */
	filesScanned: number;
	/** Files that threw an error during scanning (not counted in filesScanned). */
	failedScans: number;
	/** Directories that could not be read during enumeration. */
	unreadableDirectories: number;
	totalMalformedLines: number;
	totalUnmatchedToolCalls: number;
	totalUnmatchedToolResults: number;
	filesWithSizeChange: number;
	/** Sum of duplicateToolCallIdCount across all scanned files. */
	totalDuplicateToolCallIds: number;
	/** Sum of invalidTimestampPairCount across all scanned files. */
	totalInvalidTimestampPairs: number;
}

/**
 * Extra counters gathered outside the per-file scan that belong in coverage.
 */
export interface ExtraCoverageData {
	filesDiscovered?: number;
	failedScans?: number;
	unreadableDirectories?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Throw if `filePath` resolves (following symlinks) to `run-history.jsonl`.
 *
 * The Pi runtime's `loadRunsForAgent` reader truncates that file on open,
 * making a read destructive.  Defend at the module boundary so no consumer
 * can accidentally open it regardless of how the path was constructed.
 */
function assertNotRunHistory(filePath: string): void {
	let resolved: string;
	try {
		resolved = realpathSync(filePath);
	} catch {
		// File may not exist yet (e.g. a path being validated before creation).
		// Fall back to the literal path for the basename check.
		resolved = filePath;
	}
	if (basename(resolved) === "run-history.jsonl") {
		throw new Error(
			`Refusing to open run-history.jsonl: the Pi runtime truncates that file on read. ` +
				`Resolve using a session-specific path instead. Attempted path: ${filePath}`,
		);
	}
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

/** Tolerant streaming JSONL line reader.  Does not load whole files. */
async function* readJsonlLines(filePath: string): AsyncGenerator<unknown> {
	assertNotRunHistory(filePath);
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue; // blank / trailing newline
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			yield { __malformed: true };
			continue;
		}
		yield parsed;
	}
}

/** Safely read the file size; returns -1 on any error. */
function safeFileSize(filePath: string): number {
	try {
		return statSync(filePath).size;
	} catch {
		return -1;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a single session JSONL file in a streaming, read-only manner.
 *
 * - Malformed lines are counted and skipped, never thrown.
 * - An unterminated trailing line (live session append) is tolerated.
 * - Tool calls and results are paired by `toolCallId` only — never by
 *   adjacency or tool name.
 * - The file is never written to or mutated.
 * - Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function scanSessionFile(filePath: string): Promise<SessionScanResult> {
	// Fix 1: reject run-history.jsonl at the public API boundary as well, so
	// any direct caller gets a clear error even if readJsonlLines is bypassed.
	assertNotRunHistory(filePath);

	const sizeBefore = safeFileSize(filePath);

	let sessionHeader: SessionHeader | null = null;
	let malformedLines = 0;
	const entries: unknown[] = [];

	for await (const parsed of readJsonlLines(filePath)) {
		if (!isObject(parsed)) {
			malformedLines++;
			continue;
		}

		// Sentinel set by the generator for unparseable lines
		if (parsed["__malformed"] === true) {
			malformedLines++;
			continue;
		}

		const entryType = parsed["type"];

		if (entryType === "session" && sessionHeader === null) {
			if (
				typeof parsed["version"] === "number" &&
				typeof parsed["id"] === "string" &&
				typeof parsed["timestamp"] === "string" &&
				typeof parsed["cwd"] === "string"
			) {
				sessionHeader = {
					type: "session",
					version: parsed["version"],
					id: parsed["id"],
					timestamp: parsed["timestamp"],
					cwd: parsed["cwd"],
				};
			}
			continue;
		}

		if (entryType !== "message") continue;

		const message = parsed["message"];
		if (!isObject(message)) {
			malformedLines++;
			continue;
		}

		entries.push(parsed);
	}

	const sizeAfter = safeFileSize(filePath);

	const {
		toolPairs,
		unmatchedToolCallCount,
		unmatchedToolResultCount,
		observedToolCallCount,
		duplicateToolCallIdCount,
		invalidTimestampPairCount,
	} = pairToolCalls(entries);

	return {
		filePath,
		sessionHeader,
		toolPairs,
		malformedLines,
		unmatchedToolCallCount,
		unmatchedToolResultCount,
		fileSizeChangedDuringScan: sizeBefore !== sizeAfter,
		observedToolCallCount,
		duplicateToolCallIdCount,
		invalidTimestampPairCount,
	};
}

/**
 * Read only the session header from a JSONL file without scanning
 * all entries.  Returns null when no valid session header is found.
 *
 * Stops reading as soon as the header is found.
 * Throws immediately if the resolved path is `run-history.jsonl`.
 */
export async function readSessionHeader(filePath: string): Promise<SessionHeader | null> {
	// Fix 1: also guard the header-only reader.
	assertNotRunHistory(filePath);

	for await (const parsed of readJsonlLines(filePath)) {
		if (!isObject(parsed) || parsed["__malformed"] === true) continue;
		if (
			parsed["type"] === "session" &&
			typeof parsed["version"] === "number" &&
			typeof parsed["id"] === "string" &&
			typeof parsed["timestamp"] === "string" &&
			typeof parsed["cwd"] === "string"
		) {
			return {
				type: "session",
				version: parsed["version"],
				id: parsed["id"],
				timestamp: parsed["timestamp"],
				cwd: parsed["cwd"],
			};
		}
	}
	return null;
}

/**
 * Extract subagent correlations from a scan result.
 *
 * A correlation is emitted for every tool pair where:
 *   - `toolName === "subagent"` (Fix 2: only trust subagent tool results)
 *   - the tool result has both a `runId` and a `sessionFile` in its details.
 *
 * When `sessionsDir` is provided, child files are only resolved when they
 * live under that directory (path safety boundary).  Each resolved child has
 * its session header read and attached.  Unresolvable children are still
 * included with `childResolved: false` so callers can count the gap.
 *
 * Only existing fields are used — nothing is inferred.
 */
export async function extractSubagentCorrelations(
	scanResult: SessionScanResult,
	sessionsDir?: string,
): Promise<SubagentCorrelation[]> {
	if (!scanResult.sessionHeader) return [];
	const parentSessionId = scanResult.sessionHeader.id;

	const correlations: SubagentCorrelation[] = [];

	for (const pair of scanResult.toolPairs) {
		// Fix 2: only trust subagent tool results.
		if (pair.toolName !== "subagent") continue;

		const details = pair.details;
		if (!details?.runId) continue;
		const results = details.results ?? [];
		for (const r of results) {
			if (!r.sessionFile) continue;

			// Fix 2: safety boundary — only resolve paths under sessionsDir.
			const underSessionsDir =
				sessionsDir !== undefined && r.sessionFile.startsWith(sessionsDir + "/");

			let childResolved = false;
			let childSessionId: string | undefined;
			let childStartedAt: string | undefined;

			if (underSessionsDir) {
				try {
					const header = await readSessionHeader(r.sessionFile);
					if (header) {
						childResolved = true;
						childSessionId = header.id;
						childStartedAt = header.timestamp;
					}
				} catch {
					// Unreadable file: childResolved stays false.
				}
			}

			correlations.push({
				parentSessionFile: scanResult.filePath,
				parentSessionId,
				toolCallId: pair.toolCallId,
				runId: details.runId,
				agent: r.agent,
				childSessionFile: r.sessionFile,
				childResolved,
				...(childSessionId !== undefined ? { childSessionId } : {}),
				...(childStartedAt !== undefined ? { childStartedAt } : {}),
			});
		}
	}

	return correlations;
}

/**
 * Aggregate coverage statistics across multiple scan results.
 *
 * Pass `extra` to include counters gathered outside the per-file scan
 * (e.g. files discovered, failed scans, unreadable directories).
 */
export function aggregateCoverage(
	results: SessionScanResult[],
	extra: ExtraCoverageData = {},
): ScanCoverage {
	let totalMalformedLines = 0;
	let totalUnmatchedToolCalls = 0;
	let totalUnmatchedToolResults = 0;
	let filesWithSizeChange = 0;
	let totalDuplicateToolCallIds = 0;
	let totalInvalidTimestampPairs = 0;

	for (const r of results) {
		totalMalformedLines += r.malformedLines;
		totalUnmatchedToolCalls += r.unmatchedToolCallCount;
		totalUnmatchedToolResults += r.unmatchedToolResultCount;
		if (r.fileSizeChangedDuringScan) filesWithSizeChange++;
		totalDuplicateToolCallIds += r.duplicateToolCallIdCount;
		totalInvalidTimestampPairs += r.invalidTimestampPairCount;
	}

	return {
		filesDiscovered: extra.filesDiscovered ?? results.length,
		filesScanned: results.length,
		failedScans: extra.failedScans ?? 0,
		unreadableDirectories: extra.unreadableDirectories ?? 0,
		totalMalformedLines,
		totalUnmatchedToolCalls,
		totalUnmatchedToolResults,
		filesWithSizeChange,
		totalDuplicateToolCallIds,
		totalInvalidTimestampPairs,
	};
}
