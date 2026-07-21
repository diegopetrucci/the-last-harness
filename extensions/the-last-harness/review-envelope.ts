import type { Stats } from "node:fs";
import { lstat, open, readFile, type FileHandle } from "node:fs/promises";
import { relative } from "node:path";

import type { ReviewDispatchArgs } from "./review-args.js";

// --- Delimiter constants ---

export const REVIEW_UNTRACKED_BEGIN_DELIMITER = "--- begin untracked files ---";
export const REVIEW_UNTRACKED_END_DELIMITER = "--- end untracked files ---";

// --- Types ---

/**
 * Optional context gathered at command time (filled progressively by T2/T3).
 * All fields are optional so T2 and T3 can each contribute without ordering
 * constraints between them.
 */
export interface ReviewGatheredContext {
	/** The branch checked out when the command ran. */
	currentBranch?: string;
	/** Set by T3 when a branch checkout was performed to satisfy the review. */
	checkout?: { performed: boolean; priorBranch: string };
	/** The diff text (uncommitted/branch/commit) or folder snapshot, or the output of `gh pr diff`. */
	body?: string;
	/** Describes the content type of `body`. */
	bodyKind?: "diff" | "snapshot";
}

// --- Envelope building ---

/**
 * Build the canonical [/review] envelope string to send as a user message.
 *
 * The first line is always exactly `[/review]` so the architect can detect it.
 * Structured metadata follows, then the `extra` block, then a fenced section
 * holding the diff or snapshot body.
 *
 * T2 populates `ctx.body` / `ctx.bodyKind` for local modes; T3 does the same
 * for PR mode and also fills `ctx.checkout` when it switches branches.
 */
export function buildReviewEnvelope(
	parsed: ReviewDispatchArgs,
	ctx?: ReviewGatheredContext,
): string {
	const { mode, extra } = parsed;
	const lines: string[] = [];

	// ── Line 1: hard-coded trigger token ──────────────────────────────────────
	lines.push("[/review]");

	// ── Metadata ──────────────────────────────────────────────────────────────
	lines.push(`mode: ${mode}`);

	// Mode-specific refs
	if (parsed.mode === "branch" && parsed.base) {
		lines.push(`base: ${parsed.base}`);
	} else if (parsed.mode === "commit" && parsed.sha) {
		lines.push(`sha: ${parsed.sha}`);
	} else if (parsed.mode === "pr" && parsed.nOrUrl) {
		lines.push(`pr: ${parsed.nOrUrl}`);
	} else if (parsed.mode === "folder" && parsed.paths.length > 0) {
		lines.push(`paths: ${parsed.paths.join(" ")}`);
	}

	// Branch context
	if (ctx?.currentBranch !== undefined) {
		lines.push(`current-branch: ${ctx.currentBranch}`);
	}

	// Checkout notice (set by T3 when it had to switch branches)
	if (ctx?.checkout?.performed) {
		lines.push(`checkout: switched-from ${ctx.checkout.priorBranch}`);
		lines.push(`note: previously on ${ctx.checkout.priorBranch}; run \`git checkout -\` to return.`);
	}

	// ── Extra block ───────────────────────────────────────────────────────────
	if (extra === undefined) {
		lines.push("extra: (none)");
	} else {
		lines.push("extra:");
		lines.push(extra);
	}

	// ── Body fenced section ───────────────────────────────────────────────────
	const hasBody = ctx?.body !== undefined;
	const fenceKind = hasBody ? (ctx?.bodyKind ?? "diff") : "(pending)";
	const bodyText = hasBody ? escapeEnvelopeFenceLines(ctx?.body as string, fenceKind) : "(no body gathered)";

	lines.push(`--- begin ${fenceKind} ---`);
	lines.push(bodyText);
	lines.push(`--- end ${fenceKind} ---`);

	return lines.join("\n");
}

// --- Content escaping helpers ---

export function parseNullDelimitedGitPaths(stdout: string): string[] {
	return stdout.split("\0").filter((filePath) => filePath.length > 0);
}

export function escapeDelimitedContentLine(line: string): string {
	return `\\${line}`;
}

export function escapeContentDelimiters(content: string): string {
	return content
		.split("\n")
		.map((line) => {
			if (
				line === "--- begin snapshot ---"
				|| line === "--- end snapshot ---"
				|| line === REVIEW_UNTRACKED_BEGIN_DELIMITER
				|| line === REVIEW_UNTRACKED_END_DELIMITER
				|| /^--- (?:file|untracked file): .* ---$/.test(line)
			) {
				return escapeDelimitedContentLine(line);
			}
			return line;
		})
		.join("\n");
}

export function escapeEnvelopeFenceLines(body: string, fenceKind: string): string {
	const beginFence = `--- begin ${fenceKind} ---`;
	const endFence = `--- end ${fenceKind} ---`;
	return body
		.split("\n")
		.map((line) => (line === beginFence || line === endFence ? escapeDelimitedContentLine(line) : line))
		.join("\n");
}

export function renderDelimitedPath(relPath: string): string {
	return JSON.stringify(relPath)
		.replace(/[\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replace(/\[/g, "\\u005b")
		.replace(/\]/g, "\\u005d");
}

// --- Snapshot helpers ---

export function getNonRegularSnapshotMarker(relPath: string, pathStat: Stats): string | undefined {
	const renderedPath = renderDelimitedPath(relPath);
	if (pathStat.isSymbolicLink()) {
		return `[skipped symlink: ${renderedPath}]`;
	}
	if (pathStat.isDirectory()) {
		return `[skipped directory: ${renderedPath}]`;
	}
	if (!pathStat.isFile()) {
		return `[skipped non-regular entry: ${renderedPath}]`;
	}
	return undefined;
}

/**
 * Return true when a file is likely binary.
 * Heuristic: read the first 8 KB and check for a NUL (0x00) byte.
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(filePath, "r");
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle?.close();
	}
}

/**
 * Build snapshot entries for a set of file paths.
 * Binary files are skipped with an annotation instead of inline content.
 */
export async function buildSnapshotParts(cwd: string, filePaths: string[], label: string): Promise<string[]> {
	const parts: string[] = [];

	for (const filePath of filePaths) {
		const relPath = relative(cwd, filePath);
		const renderedPath = renderDelimitedPath(relPath);

		let pathStat: Stats;
		try {
			pathStat = await lstat(filePath);
		} catch {
			parts.push(`[skipped lstat failure: ${renderedPath}]`);
			continue;
		}

		const nonRegularMarker = getNonRegularSnapshotMarker(relPath, pathStat);
		if (nonRegularMarker) {
			parts.push(nonRegularMarker);
			continue;
		}

		let bin: boolean;
		try {
			bin = await isBinaryFile(filePath);
		} catch {
			parts.push(`[skipped binary detection failure: ${renderedPath}]`);
			continue;
		}
		if (bin) {
			parts.push(`[skipped binary: ${renderedPath}]`);
			continue;
		}

		try {
			const content = escapeContentDelimiters(await readFile(filePath, "utf8"));
			parts.push(`--- ${label}: ${renderedPath} ---\n${content}`);
		} catch {
			parts.push(`[skipped read failure: ${renderedPath}]`);
		}
	}

	return parts;
}

export function appendUntrackedSnapshot(diffBody: string, untrackedParts: string[]): string {
	if (untrackedParts.length === 0) {
		return diffBody;
	}

	const untrackedBody = [REVIEW_UNTRACKED_BEGIN_DELIMITER, ...untrackedParts, REVIEW_UNTRACKED_END_DELIMITER].join("\n");
	return diffBody.trim().length > 0 ? `${diffBody}\n\n${untrackedBody}` : untrackedBody;
}
