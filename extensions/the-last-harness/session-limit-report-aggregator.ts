import { basename, relative } from "node:path";

import type { TlhUsageCoverage, TlhUsageTotals } from "./tokens-analyzer.js";
import { addUsage, createUsageTotals, normalizeUsage } from "./tokens-analyzer.js";
import type { RawSessionEntry } from "./session-limit-report-scan.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Time window for in-window filtering.
 * Boundary convention: **both ends inclusive** — an entry whose timestamp
 * equals `startMs` or `endMs` is included. This matches the `[startMs, endMs]`
 * interval notation used throughout the session-limit report.
 */
export type AggregationWindow = {
	startMs: number;
	endMs: number;
};

/**
 * A parsed session file ready for aggregation.
 */
export type ParsedSessionFileInput = {
	/** Absolute path to the `.jsonl` session file. */
	filePath: string;
	/** Parsed entries from the file. */
	entries: RawSessionEntry[];
	/** Number of malformed lines encountered during parsing. */
	malformedLineCount: number;
};

/**
 * Per-provider usage totals within the aggregation window.
 */
export type SessionProviderTotals = {
	/** Provider identifier (e.g. `"anthropic"`, `"openai-codex"`).  Resolved from the
	 *  per-message `provider` field when present; otherwise from the most recent
	 *  `model_change` entry, or `"unknown"` when neither is available. */
	provider: string;
	/** Model identifier at the time of the last assistant message for this provider key,
	 *  or `undefined` when not available. */
	modelId?: string;
	/** Accumulated in-window usage for this provider. */
	usage: TlhUsageTotals;
};

/**
 * Per-session aggregation row, ready for rendering.
 */
export type SessionAggregateRow = {
	/** Absolute path to the source `.jsonl` file. */
	filePath: string;
	/**
	 * Whether this session file is a primary session or a subagent child.
	 *
	 * Classification rule (relative to sessionsRoot):
	 *   - `primary`: file sits at depth 2 — `<proj>/<file>.jsonl`
	 *   - `subagent-child`: file sits deeper — `<proj>/<parent>/…/session.jsonl`
	 */
	fileKind: "primary" | "subagent-child";
	/**
	 * Display-friendly project label for the session.
	 *
	 * Derived in order of preference:
	 *   1. `basename(cwd)` from the session header (`{"type":"session","cwd":"…"}`) or a
	 *      `session_info` entry — this is the real filesystem path and is unambiguous.
	 *   2. Fallback: decode the Pi-escaped project directory name (`--Users-foo-my-project--`
	 *      → `my-project`). The encoding is lossy (hyphens in path components are
	 *      indistinguishable from path separators), so this best-effort label takes the
	 *      last non-empty segment after replacing `-` with `/`.
	 */
	projectLabel: string;
	/** Session identifier from the `{"type":"session"}` header entry, if present. */
	sessionId?: string;
	/**
	 * Human-readable session name.
	 *
	 * Sourced from (in priority order):
	 *   1. The latest `{"type":"session_info","name":"…"}` entry (user rename; later wins).
	 *   2. The `name` field in the `{"type":"session"}` header entry.
	 */
	sessionName?: string;
	/** In-window usage broken down by provider. Sorted by usage.totalTokens descending. */
	providerTotals: SessionProviderTotals[];
	/** Sum of all provider usage within the window. */
	windowTotals: TlhUsageTotals;
	/** Coverage counters: how many assistant messages had/lacked usage data. */
	coverage: TlhUsageCoverage;
	/** Malformed lines from the source file (passed through from parseSessionJsonl). */
	malformedLineCount: number;
};

/**
 * Result of aggregating usage across all session files.
 */
export type SessionAggregateResult = {
	/**
	 * One row per session file that had at least one assistant message in the window
	 * (files with zero in-window assistant messages are included with zero totals to
	 * preserve coverage information). Sorted by `windowTotals.totalTokens` descending.
	 */
	rows: SessionAggregateRow[];
	/**
	 * Per-provider totals summed across all rows.
	 * Sorted by usage.totalTokens descending.
	 */
	perProviderTotals: SessionProviderTotals[];
	/** Grand totals across all providers and all rows. */
	grandTotals: TlhUsageTotals;
	/**
	 * Non-fatal observations: caveats passed in from the scan step, plus
	 * any per-file coverage warnings (assistant turns without usage data).
	 */
	caveats: string[];
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Aggregate in-window usage from a set of parsed session files.
 *
 * For each file this function:
 *   1. Identifies the session header (`type:"session"`) for metadata.
 *   2. Tracks the current provider/model via `type:"model_change"` entries.
 *   3. Selects `type:"message"` entries where `role === "assistant"` AND
 *      the entry timestamp falls within `[window.startMs, window.endMs]`
 *      (both ends **inclusive**).
 *   4. Normalises and accumulates usage per provider.
 *
 * Usage is counted **only** from entries in the provided files. Discovered-subagent
 * totals embedded in tokens-analyzer output are not included, which prevents
 * double-counting of child session usage.
 *
 * @param window       The resolved session-limit time window.
 * @param sessionsRoot Absolute path to the sessions root, used for path
 *                     classification and project label derivation.
 * @param parsedFiles  Files to aggregate; typically the output of calling
 *                     `parseSessionJsonl` on each path from `discoverSessionFiles`.
 * @param scanCaveats  Optional caveats forwarded from the scan step.
 */
export function aggregateSessionUsage(
	window: AggregationWindow,
	sessionsRoot: string,
	parsedFiles: ParsedSessionFileInput[],
	scanCaveats: string[] = [],
): SessionAggregateResult {
	const caveats: string[] = [...scanCaveats];
	const providerTotalsMap = new Map<string, SessionProviderTotals>();
	const grandTotals = createUsageTotals();
	const rows: SessionAggregateRow[] = [];

	for (const file of parsedFiles) {
		const row = aggregateFile(window, sessionsRoot, file, caveats);
		rows.push(row);

		// Accumulate into cross-session per-provider totals.
		for (const pt of row.providerTotals) {
			const existing = providerTotalsMap.get(pt.provider);
			if (existing) {
				addUsage(existing.usage, pt.usage);
			} else {
				providerTotalsMap.set(pt.provider, {
					provider: pt.provider,
					modelId: pt.modelId,
					usage: { ...pt.usage },
				});
			}
		}

		// Accumulate grand totals.
		addUsage(grandTotals, row.windowTotals);
	}

	// Sort rows by in-window total tokens descending.
	rows.sort((a, b) => b.windowTotals.totalTokens - a.windowTotals.totalTokens);

	// Sort per-provider totals descending.
	const perProviderTotals = [...providerTotalsMap.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

	return { rows, perProviderTotals, grandTotals, caveats };
}

// ---------------------------------------------------------------------------
// Per-file aggregation
// ---------------------------------------------------------------------------

function aggregateFile(
	window: AggregationWindow,
	sessionsRoot: string,
	file: ParsedSessionFileInput,
	caveats: string[],
): SessionAggregateRow {
	const { filePath, entries, malformedLineCount } = file;

	const fileKind = classifyFileKind(filePath, sessionsRoot);

	let sessionId: string | undefined;
	let sessionHeaderName: string | undefined;
	let sessionInfoName: string | undefined;
	let sessionCwd: string | undefined;
	let currentProvider = "unknown";
	let currentModelId: string | undefined;

	const providerUsageMap = new Map<string, SessionProviderTotals>();
	const windowTotals = createUsageTotals();
	const coverage: TlhUsageCoverage = { assistantMessages: 0, withUsage: 0, withoutUsage: 0 };

	for (const entry of entries) {
		if (entry.type === "session") {
			// Extract header metadata (first occurrence wins).
			if (sessionId === undefined && typeof entry.id === "string") {
				sessionId = entry.id;
			}
			if (sessionHeaderName === undefined && typeof entry.name === "string") {
				sessionHeaderName = entry.name;
			}
			if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
				sessionCwd = entry.cwd;
			}
			continue;
		}

		if (entry.type === "session_info") {
			// session_info records user-visible renames; later entry wins.
			if (typeof entry.name === "string" && entry.name.length > 0) {
				sessionInfoName = entry.name;
			}
			if (sessionCwd === undefined && typeof entry.cwd === "string" && entry.cwd.length > 0) {
				sessionCwd = entry.cwd;
			}
			continue;
		}

		if (entry.type === "model_change") {
			// Track current provider/model for subsequent messages.
			if (typeof entry.provider === "string" && entry.provider.length > 0) {
				currentProvider = entry.provider;
			}
			currentModelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
			continue;
		}

		if (entry.type !== "message") {
			continue;
		}

		// Only process assistant messages.
		const message = entry.message;
		if (!isRecord(message) || message.role !== "assistant") {
			continue;
		}

		// In-window filter: both ends inclusive.
		const entryTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
		if (!Number.isFinite(entryTs) || entryTs < window.startMs || entryTs > window.endMs) {
			continue;
		}

		coverage.assistantMessages += 1;

		const usage = normalizeUsage(message.usage);
		if (usage) {
			coverage.withUsage += 1;

			// Prefer per-message provider/model (authoritative, branch-aware); fall back
			// to the most recent model_change tracking when the message fields are absent.
			const msgProvider =
				typeof message.provider === "string" && (message.provider as string).length > 0
					? (message.provider as string)
					: undefined;
			const msgModel =
				typeof message.model === "string" && (message.model as string).length > 0
					? (message.model as string)
					: undefined;
			const turnProvider = msgProvider ?? currentProvider;
			const turnModelId = msgModel ?? currentModelId;

			// Accumulate into per-provider totals.
			const existing = providerUsageMap.get(turnProvider);
			if (existing) {
				addUsage(existing.usage, usage, { turns: 1, assistantMessages: 1 });
				existing.modelId = turnModelId;
			} else {
				const providerTotals = createUsageTotals();
				addUsage(providerTotals, usage, { turns: 1, assistantMessages: 1 });
				providerUsageMap.set(turnProvider, {
					provider: turnProvider,
					modelId: turnModelId,
					usage: providerTotals,
				});
			}

			addUsage(windowTotals, usage, { turns: 1, assistantMessages: 1 });
		} else {
			coverage.withoutUsage += 1;
			// Count the turn in totals even without usage data.
			windowTotals.turns += 1;
			windowTotals.assistantMessages += 1;
		}
	}

	// Emit a caveat when there were assistant turns missing usage data.
	if (coverage.withoutUsage > 0) {
		caveats.push(
			`${basename(filePath)}: ${coverage.withoutUsage} of ${coverage.assistantMessages} in-window assistant message(s) had no usage data`,
		);
	}
	if (malformedLineCount > 0) {
		caveats.push(`${basename(filePath)}: ${malformedLineCount} malformed line(s) skipped`);
	}

	// Sort per-provider totals descending.
	const providerTotals = [...providerUsageMap.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);

	// Derive project label: prefer basename of cwd (real path) from header/session_info;
	// fall back to decoding the Pi-escaped directory name when no cwd is available.
	const projectLabel = sessionCwd ? basename(sessionCwd) : deriveProjectLabel(filePath, sessionsRoot);

	// Session name: session_info name wins over header name (later renames take precedence).
	const sessionName = sessionInfoName ?? sessionHeaderName;

	return {
		filePath,
		fileKind,
		projectLabel,
		sessionId,
		sessionName,
		providerTotals,
		windowTotals,
		coverage,
		malformedLineCount,
	};
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

/**
 * Classify a session file as primary or subagent-child based on its depth
 * relative to `sessionsRoot`.
 *
 * - depth 2 from sessionsRoot (i.e. `<proj>/<file>.jsonl`) → `"primary"`
 * - deeper → `"subagent-child"`
 */
function classifyFileKind(filePath: string, sessionsRoot: string): "primary" | "subagent-child" {
	const rel = relative(sessionsRoot, filePath);
	// rel has the form  <proj>/<file>.jsonl  (primary)
	// or                <proj>/<parent>/…/session.jsonl  (child)
	// Split on forward slash; on Windows this would need adjustment but the
	// sessions root is always a POSIX-style path on macOS/Linux targets.
	const parts = rel.split("/").filter((p) => p.length > 0);
	return parts.length <= 2 ? "primary" : "subagent-child";
}

// ---------------------------------------------------------------------------
// Project label derivation
// ---------------------------------------------------------------------------

/**
 * Derive a display-friendly project label from the session file path.
 *
 * The Pi sessions layout places files under `<sessionsRoot>/<projDir>/…` where
 * `projDir` is the absolute CWD path encoded by replacing every `/` with `-`
 * and wrapping in `--` (e.g. `/Users/foo/my-project` → `--Users-foo-my-project--`).
 *
 * Because the encoding is lossy (project-name hyphens and path separators both
 * become `-`), this function returns a best-effort label:
 *   1. Extract the `projDir` segment (first component of `filePath` relative to
 *      `sessionsRoot`).
 *   2. If it matches the `--…--` pattern, strip the delimiters and replace `-`
 *      with `/`, then take the last non-empty segment.
 *   3. Otherwise return the raw `projDir` name.
 */
function deriveProjectLabel(filePath: string, sessionsRoot: string): string {
	const rel = relative(sessionsRoot, filePath);
	const parts = rel.split("/").filter((p) => p.length > 0);
	const projDir = parts[0] ?? "";
	return decodeProjectDirName(projDir);
}

/**
 * Decode a Pi-encoded project directory name into a human-readable label.
 *
 * `--Users-foo-my-project--` → `my-project` (best-effort: last segment after
 * replacing `-` with `/`).
 */
export function decodeProjectDirName(dirName: string): string {
	if (dirName.startsWith("--") && dirName.endsWith("--") && dirName.length > 4) {
		const inner = dirName.slice(2, -2);
		// Replace hyphens with slashes to recover the approximate path, then take
		// the last non-empty segment as the display label.
		const segments = inner.split("-").filter((s) => s.length > 0);
		const lastSegment = segments[segments.length - 1];
		return lastSegment ?? dirName;
	}
	return dirName;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
