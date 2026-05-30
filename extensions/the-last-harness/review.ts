import type { Stats } from "node:fs";
import { lstat, open, readdir, readFile, type FileHandle } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { DynamicBorder, getSelectListTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

// --- Constants ---

const REVIEW_TITLE = "Choose a review mode";
const REVIEW_PICKER_HINT = "↑/↓ to move  Enter to confirm  Esc to cancel";
const REVIEW_DEFAULT_BRANCH_BASE = "main";
const REVIEW_PICKER_ONLY_GUIDANCE =
	"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.";
const REVIEW_TUI_REQUIRED_MESSAGE =
	"/review requires the interactive TUI picker. Re-run /review in the TLH UI.";

export const REVIEW_MODES = ["uncommitted", "branch", "commit", "pr", "folder"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

const REVIEW_MODE_DESCRIPTIONS: Record<ReviewMode, string> = {
	uncommitted: "Review staged/unstaged changes plus untracked non-gitignored files",
	branch: "Review commits on the current branch vs a chosen base (prompted; blank defaults to main)",
	commit: "Review a single commit by SHA",
	pr: "Review a pull request by number or URL",
	folder: "Review files in one or more folders",
};

const REVIEW_UNTRACKED_BEGIN_DELIMITER = "--- begin untracked files ---";
const REVIEW_UNTRACKED_END_DELIMITER = "--- end untracked files ---";

// --- Types ---

/** Action returned by the pure branch-mismatch decision helper. */
export type BranchDecisionAction = "proceed" | "abort-dirty" | "switch" | "abort-cancelled";

export type ParsedReviewArgs =
	| { pickerRequested: true }
	| { pickerRequested: false; message: string };

export type ReviewDispatchArgs =
	| { mode: "uncommitted"; extra: string | undefined }
	| { mode: "branch"; base: string | undefined; extra: string | undefined }
	| { mode: "commit"; sha: string | undefined; extra: string | undefined }
	| { mode: "pr"; nOrUrl: string | undefined; extra: string | undefined }
	| { mode: "folder"; paths: string[]; extra: string | undefined };

// --- Pure helpers ---

/**
 * Pure branch-mismatch decision function for PR mode.
 * Maps the current state + user confirmation to an action.
 * Has no knowledge of git, gh, or any I/O.
 */
export function decideBranchAction(params: {
	currentBranch: string;
	prHead: string;
	isDirty: boolean;
	userConfirm: boolean;
}): BranchDecisionAction {
	const { currentBranch, prHead, isDirty, userConfirm } = params;
	if (currentBranch === prHead) return "proceed";
	if (isDirty) return "abort-dirty";
	return userConfirm ? "switch" : "abort-cancelled";
}

/**
 * Tokenise a raw args string from the command handler, respecting single- and
 * double-quoted groups so that quoted picker follow-up input stays grouped.
 * Unquoted whitespace, including newlines from editor prompts, splits tokens.
 */
function tokenizeArgs(raw: string): string[] {
	if (!raw.trim()) return [];

	const tokens: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (const ch of raw) {
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
		} else if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
		} else if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
			if (current) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}

/**
 * /review is picker-only. Bare /review requests the picker; any typed
 * arguments are rejected with explicit guidance so users do not think the
 * command silently ignored meaningful input.
 */
export function parseReviewArgs(argv: string[]): ParsedReviewArgs {
	if (argv.length === 0) {
		return { pickerRequested: true };
	}

	return {
		pickerRequested: false,
		message: REVIEW_PICKER_ONLY_GUIDANCE,
	};
}

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

// --- Helpers for picker integration ---

/** Construct full dispatch args for a mode chosen interactively with defaults applied. */
function makePickedArgs(mode: "uncommitted"): ReviewDispatchArgs {
	return { mode, extra: undefined };
}

async function promptForRequiredReviewInput(
	ctx: ExtensionCommandContext,
	title: string,
): Promise<string | undefined> {
	const response = await ctx.ui.editor(title);
	const trimmed = response?.trim();
	return trimmed ? trimmed : undefined;
}

async function promptForBranchBase(
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const response = await ctx.ui.editor(
		"Review branch: enter base branch (blank defaults to main)",
		REVIEW_DEFAULT_BRANCH_BASE,
	);
	if (response === undefined) {
		return undefined;
	}

	const trimmed = response.trim();
	return trimmed || REVIEW_DEFAULT_BRANCH_BASE;
}

async function completePickedArgs(
	ctx: ExtensionCommandContext,
	mode: ReviewMode,
): Promise<ReviewDispatchArgs | undefined> {
	if (mode === "uncommitted") {
		return makePickedArgs(mode);
	}

	if (mode === "branch") {
		const base = await promptForBranchBase(ctx);
		return base ? { mode: "branch", base, extra: undefined } : undefined;
	}

	if (mode === "commit") {
		const sha = await promptForRequiredReviewInput(ctx, "Review commit: enter commit SHA");
		return sha ? { mode: "commit", sha, extra: undefined } : undefined;
	}

	if (mode === "pr") {
		const nOrUrl = await promptForRequiredReviewInput(ctx, "Review PR: enter PR number or URL");
		return nOrUrl ? { mode: "pr", nOrUrl, extra: undefined } : undefined;
	}

	const rawPaths = await promptForRequiredReviewInput(
		ctx,
		"Review folder: enter one or more paths (quote paths with spaces)",
	);
	if (!rawPaths) {
		return undefined;
	}

	const paths = tokenizeArgs(rawPaths);
	return paths.length > 0 ? { mode: "folder", paths, extra: undefined } : undefined;
}

// --- Interactive picker ---

async function showReviewPicker(ctx: ExtensionCommandContext): Promise<ReviewMode | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}

	const items = REVIEW_MODES.map((mode) => ({
		value: mode,
		label: mode,
		description: REVIEW_MODE_DESCRIPTIONS[mode],
	}));

	const selected = await ctx.ui.custom<ReviewMode | undefined>((_tui, theme, _kb, done) => {
		const selectTheme = getSelectListTheme();
		const selectList = new SelectList(items, items.length, selectTheme);

		selectList.onSelect = (item) => done(item.value as ReviewMode);
		selectList.onCancel = () => done(undefined);

		const container = new Container();
		const border = new DynamicBorder((segment: string) => theme.fg("accent", segment));

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold(REVIEW_TITLE)), 1, 0));
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", REVIEW_PICKER_HINT), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
			},
		};
	});

	return selected;
}

// --- Gather helpers ---

type GatherResult = { ok: true; ctx: ReviewGatheredContext } | { ok: false; message: string };

function detectNotGitRepo(stderr: string): boolean {
	return /not a git repository/i.test(stderr);
}

async function resolveRepoRoot(
	pi: ExtensionAPI,
	cwd: string,
	context: string,
): Promise<{ ok: true; root: string } | { ok: false; message: string }> {
	const repoRootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (repoRootResult.code !== 0) {
		const message = detectNotGitRepo(repoRootResult.stderr)
			? "Not inside a git repository. Run /review from a directory that contains a .git folder."
			: `Could not determine repository root for ${context}: ${repoRootResult.stderr.trim() || "git rev-parse --show-toplevel failed"}`;
		return { ok: false, message };
	}

	return { ok: true, root: repoRootResult.stdout.trim() };
}

/**
 * Reject values that look like git/gh flags (start with '-').
 * pi.exec is argv-based (no shell injection), but a leading dash could still
 * cause the value to be interpreted as a git or gh option rather than a ref,
 * SHA, or PR identifier.
 */
function rejectFlagLike(value: string, fieldName: string): { ok: true } | { ok: false; message: string } {
	if (value.startsWith("-")) {
		return { ok: false, message: `${fieldName} cannot start with '-' (got '${value}'). If this is intentional, run the underlying command manually.` };
	}
	return { ok: true };
}

/**
 * Gather staged + unstaged changes vs HEAD for the uncommitted mode.
 * Also appends untracked, non-gitignored file contents so brand-new files are reviewable.
 */
async function gatherUncommitted(pi: ExtensionAPI, cmdCtx: ExtensionCommandContext): Promise<GatherResult> {
	const cwd = cmdCtx.cwd;

	// Resolve current branch (also validates we are inside a git repo)
	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	if (branchResult.code !== 0) {
		const message = detectNotGitRepo(branchResult.stderr)
			? "Not inside a git repository. Run /review from a directory that contains a .git folder."
			: `Could not determine current branch: ${branchResult.stderr.trim()}`;
		return { ok: false, message };
	}
	const currentBranch = branchResult.stdout.trim();

	// Gather full diff (staged + unstaged vs HEAD)
	const diffResult = await pi.exec("git", ["diff", "HEAD"], { cwd });
	if (diffResult.code !== 0) {
		const message = detectNotGitRepo(diffResult.stderr)
			? "Not inside a git repository. Run /review from a directory that contains a .git folder."
			: `git diff HEAD failed: ${diffResult.stderr.trim()}`;
		return { ok: false, message };
	}

	const repoRootResult = await resolveRepoRoot(pi, cwd, "the untracked file scan");
	if (!repoRootResult.ok) {
		return repoRootResult;
	}

	// Include untracked, non-gitignored files so the reviewer can see newly added content.
	const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", "."], { cwd: repoRootResult.root });
	if (untrackedResult.code !== 0) {
		const message = detectNotGitRepo(untrackedResult.stderr)
			? "Not inside a git repository. Run /review from a directory that contains a .git folder."
			: `git ls-files for untracked files failed: ${untrackedResult.stderr.trim()}`;
		return { ok: false, message };
	}

	const untrackedFiles = parseNullDelimitedGitPaths(untrackedResult.stdout)
		.map((filePath) => resolve(repoRootResult.root, filePath));
	const untrackedParts = await buildSnapshotParts(repoRootResult.root, untrackedFiles, "untracked file");
	const body = appendUntrackedSnapshot(diffResult.stdout, untrackedParts);

	return {
		ok: true,
		ctx: { currentBranch, body, bodyKind: "diff" },
	};
}

/**
 * Gather git diff <base>...HEAD (three-dot, vs merge-base) for the branch mode.
 */
async function gatherBranch(
	pi: ExtensionAPI,
	cmdCtx: ExtensionCommandContext,
	base: string | undefined,
): Promise<GatherResult> {
	const effectiveBase = base?.trim() || REVIEW_DEFAULT_BRANCH_BASE;

	// Reject flag-like values before passing anything to git.
	const baseCheck = rejectFlagLike(effectiveBase, "base");
	if (!baseCheck.ok) {
		return { ok: false, message: baseCheck.message };
	}

	const cwd = cmdCtx.cwd;

	// Refuse if HEAD is detached
	const symRefResult = await pi.exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd });
	if (symRefResult.code !== 0) {
		if (detectNotGitRepo(symRefResult.stderr)) {
			return {
				ok: false,
				message:
					"Not inside a git repository. Run /review from a directory that contains a .git folder.",
			};
		}
		return {
			ok: false,
			message: "HEAD is detached. Check out a branch before running /review.",
		};
	}

	// Resolve current branch
	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;

	// Validate that the base ref resolves
	const verifyResult = await pi.exec("git", ["rev-parse", "--verify", effectiveBase], { cwd });
	if (verifyResult.code !== 0) {
		return {
			ok: false,
			message: `Branch base '${effectiveBase}' does not resolve to a valid ref. Make sure the branch or commit exists locally.`,
		};
	}

	// Compute three-dot diff vs merge-base
	const diffResult = await pi.exec("git", ["diff", `${effectiveBase}...HEAD`], { cwd });
	if (diffResult.code !== 0) {
		return {
			ok: false,
			message: `git diff ${effectiveBase}...HEAD failed: ${diffResult.stderr.trim()}`,
		};
	}

	return {
		ok: true,
		ctx: { currentBranch, body: diffResult.stdout, bodyKind: "diff" },
	};
}

/**
 * Gather git show --format=fuller <sha> (commit header + diff) for the commit mode.
 */
async function gatherCommit(
	pi: ExtensionAPI,
	cmdCtx: ExtensionCommandContext,
	sha: string | undefined,
): Promise<GatherResult> {
	if (!sha) {
		return {
			ok: false,
			message: "Commit review requires a SHA. Re-run /review and choose commit.",
		};
	}

	const cwd = cmdCtx.cwd;

	// Reject flag-like values before passing to git
	const shaCheck = rejectFlagLike(sha, "sha");
	if (!shaCheck.ok) {
		return { ok: false, message: shaCheck.message };
	}

	// Validate that the ref resolves to an actual commit object
	const verifyResult = await pi.exec("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd });
	if (verifyResult.code !== 0) {
		if (detectNotGitRepo(verifyResult.stderr)) {
			return {
				ok: false,
				message:
					"Not inside a git repository. Run /review from a directory that contains a .git folder.",
			};
		}
		return {
			ok: false,
			message: `Commit '${sha}' does not resolve to a valid commit. Check that the SHA is correct and reachable.`,
		};
	}

	// Gather the full commit diff including the message header
	const showResult = await pi.exec("git", ["show", "--format=fuller", sha], { cwd });
	if (showResult.code !== 0) {
		return {
			ok: false,
			message: `git show failed for '${sha}': ${showResult.stderr.trim()}`,
		};
	}

	// Resolve current branch (best-effort; irrelevant if we are reviewing an old commit)
	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;

	return {
		ok: true,
		ctx: { currentBranch, body: showResult.stdout, bodyKind: "diff" },
	};
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
 * Recursively collect all non-directory entries under a directory.
 *
 * Subdirectories named `node_modules` or starting with `.` are skipped
 * to avoid generating useless snapshots from tooling/VCS directories.
 * This filter applies only to entries discovered during recursion — the
 * user-specified top-level path is always walked regardless of its name.
 */
async function walkDir(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip well-known noisy directories during recursion.
			if (entry.name === "node_modules" || entry.name.startsWith(".")) {
				continue;
			}
			files.push(...(await walkDir(full)));
		} else {
			files.push(full);
		}
	}
	return files;
}

function parseNullDelimitedGitPaths(stdout: string): string[] {
	return stdout.split("\0").filter((filePath) => filePath.length > 0);
}

function escapeDelimitedContentLine(line: string): string {
	return `\\${line}`;
}

function escapeContentDelimiters(content: string): string {
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

function escapeEnvelopeFenceLines(body: string, fenceKind: string): string {
	const beginFence = `--- begin ${fenceKind} ---`;
	const endFence = `--- end ${fenceKind} ---`;
	return body
		.split("\n")
		.map((line) => (line === beginFence || line === endFence ? escapeDelimitedContentLine(line) : line))
		.join("\n");
}

function renderDelimitedPath(relPath: string): string {
	return JSON.stringify(relPath)
		.replace(/[\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
		.replace(/\[/g, "\\u005b")
		.replace(/\]/g, "\\u005d");
}

function getNonRegularSnapshotMarker(relPath: string, pathStat: Stats): string | undefined {
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
 * Build snapshot entries for a set of file paths.
 * Binary files are skipped with an annotation instead of inline content.
 */
async function buildSnapshotParts(cwd: string, filePaths: string[], label: string): Promise<string[]> {
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

function appendUntrackedSnapshot(diffBody: string, untrackedParts: string[]): string {
	if (untrackedParts.length === 0) {
		return diffBody;
	}

	const untrackedBody = [REVIEW_UNTRACKED_BEGIN_DELIMITER, ...untrackedParts, REVIEW_UNTRACKED_END_DELIMITER].join("\n");
	return diffBody.trim().length > 0 ? `${diffBody}\n\n${untrackedBody}` : untrackedBody;
}

/**
 * Build a snapshot payload from the given paths for the folder mode.
 * Directories are walked; binary files are skipped with an annotation.
 */
async function gatherFolder(
	pi: ExtensionAPI,
	cmdCtx: ExtensionCommandContext,
	paths: string[],
): Promise<GatherResult> {
	if (paths.length === 0) {
		return {
			ok: false,
			message: "Folder review requires at least one path. Re-run /review and choose folder.",
		};
	}

	const cwd = cmdCtx.cwd;
	const absPaths = paths.map((p) => resolve(cwd, p));

	// Validate all paths exist before doing any work
	for (let i = 0; i < absPaths.length; i++) {
		try {
			await lstat(absPaths[i]);
		} catch {
			return {
				ok: false,
				message: `Path does not exist: ${paths[i]}`,
			};
		}
	}

	// Resolve current branch (best-effort; folder mode may be used outside a git repo)
	let currentBranch: string | undefined;
	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	if (branchResult.code === 0) {
		currentBranch = branchResult.stdout.trim();
	}

	const parts: string[] = [];

	for (let i = 0; i < absPaths.length; i++) {
		const absPath = absPaths[i];
		const pathStat = await lstat(absPath);
		let filePaths: string[];

		if (pathStat.isDirectory()) {
			// Prefer git ls-files to respect .gitignore naturally;
			// --others --exclude-standard includes untracked-but-not-gitignored files.
			// If git reports zero files for this directory, keep that empty result instead of
			// walking the tree and accidentally snapshotting ignored files.
			const lsResult = await pi.exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: absPath });
			if (lsResult.code === 0) {
				filePaths = parseNullDelimitedGitPaths(lsResult.stdout)
					.map((filePath) => join(absPath, filePath));
			} else if (detectNotGitRepo(lsResult.stderr)) {
				// Fall back to a plain recursive walk only when outside git entirely.
				filePaths = await walkDir(absPath);
			} else {
				return {
					ok: false,
					message: `git ls-files failed for folder path '${paths[i]}': ${lsResult.stderr.trim()}`,
				};
			}
		} else {
			filePaths = [absPath];
		}

		parts.push(...(await buildSnapshotParts(cwd, filePaths, "file")));
	}

	return {
		ok: true,
		ctx: {
			currentBranch,
			body: parts.join("\n"),
			bodyKind: "snapshot",
		},
	};
}

/**
 * Show a confirm prompt asking the user whether to switch to the PR head branch.
 * Returns true if confirmed, false if cancelled.
 */
async function showBranchSwitchConfirm(
	cmdCtx: ExtensionCommandContext,
	currentBranch: string,
	headRefName: string,
	baseRefName: string,
): Promise<boolean> {
	const confirmed = await cmdCtx.ui.custom<boolean>((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((segment: string) => theme.fg("accent", segment));

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Switch Branch to Run Review")), 1, 0));
		container.addChild(new Text(`Current branch: ${currentBranch}`, 1, 0));
		container.addChild(new Text(`PR head:        ${headRefName}`, 1, 0));
		container.addChild(new Text(`PR base:        ${baseRefName}`, 1, 0));
		container.addChild(new Text("", 1, 0));
		container.addChild(new Text(`Switch to ${headRefName} to run the review? (y/n)`, 1, 0));
		container.addChild(new Text(theme.fg("dim", "Enter or y to confirm  n or Esc to cancel"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "y")) {
					done(true);
				} else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
					done(false);
				}
			},
		};
	});

	return confirmed;
}

/**
 * Gather PR diff for the pr mode.
 *
 * Steps:
 * 1. Validate nOrUrl argument.
 * 2. Reject flag-like nOrUrl.
 * 3. Check gh CLI availability.
 * 4. Resolve PR metadata with `gh pr view`.
 * 5. Resolve current branch.
 * 6. Branch-mismatch decision tree.
 * 7. Gather diff with `gh pr diff`.
 */
async function gatherPr(
	pi: ExtensionAPI,
	cmdCtx: ExtensionCommandContext,
	nOrUrl: string | undefined,
): Promise<GatherResult> {
	const cwd = cmdCtx.cwd;

	// 1. Argument validation
	if (!nOrUrl || !nOrUrl.trim()) {
		return {
			ok: false,
			message: "PR review requires a PR number or URL. Re-run /review and choose PR.",
		};
	}

	// 2. Reject flag-like nOrUrl
	const nOrUrlCheck = rejectFlagLike(nOrUrl, "pr");
	if (!nOrUrlCheck.ok) {
		return { ok: false, message: nOrUrlCheck.message };
	}

	// 3. gh CLI availability check
	const ghCheckResult = await pi.exec("gh", ["--version"], { cwd });
	if (ghCheckResult.code !== 0) {
		return {
			ok: false,
			message:
				"PR mode requires the GitHub CLI. Install: https://cli.github.com — then run `gh auth login`.",
		};
	}

	// 4. PR metadata resolution
	const prViewResult = await pi.exec(
		"gh",
		["pr", "view", nOrUrl, "--json", "number,headRefName,baseRefName,isCrossRepository,headRepository"],
		{ cwd },
	);
	if (prViewResult.code !== 0) {
		const firstLine = prViewResult.stderr.split("\n")[0]?.trim() ?? "";
		return {
			ok: false,
			message: `Could not resolve PR '${nOrUrl}': ${firstLine}`,
		};
	}

	let prData: { number: number; headRefName: string; baseRefName: string; isCrossRepository: boolean };
	try {
		prData = JSON.parse(prViewResult.stdout) as typeof prData;
	} catch {
		return {
			ok: false,
			message: `Could not parse PR metadata for '${nOrUrl}'.`,
		};
	}

	if (prData.isCrossRepository === true) {
		return {
			ok: false,
			message:
				"Cross-repository PRs are not supported yet. Fetch the branch locally first, then re-run /review and choose branch mode.",
		};
	}

	const { number: prNumber, headRefName, baseRefName } = prData;

	// 5. Current branch resolution
	const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	if (branchResult.code !== 0) {
		return {
			ok: false,
			message:
				"Not inside a git repository. Run /review from a directory that contains the PR's repo.",
		};
	}
	const currentBranch = branchResult.stdout.trim();

	// 6. Branch-mismatch decision tree
	let effectiveBranch = currentBranch;
	let checkoutCtx: ReviewGatheredContext["checkout"] | undefined;

	if (currentBranch !== headRefName) {
		// Check whether the working tree is dirty
		const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (statusResult.code !== 0) {
			const firstLine = statusResult.stderr.split("\n")[0]?.trim() ?? "git status failed";
			return {
				ok: false,
				message: `Could not determine whether the working tree is clean before switching branches: ${firstLine}`,
			};
		}
		const isDirty = statusResult.stdout.trim().length > 0;

		// Working tree is clean — confirm before switching
		let userConfirm = false;
		if (!isDirty) {
			if (!cmdCtx.hasUI) {
				return {
					ok: false,
					message:
						`Branch switch confirmation requires the TUI. You're on '${currentBranch}'; PR head is '${headRefName}'. Run \`gh pr checkout ${prNumber}\` manually, then re-run /review and choose PR mode.`,
				};
			}
			userConfirm = await showBranchSwitchConfirm(cmdCtx, currentBranch, headRefName, baseRefName);
		}

		const action = decideBranchAction({ currentBranch, prHead: headRefName, isDirty, userConfirm });

		if (action === "abort-dirty") {
			return {
				ok: false,
				message:
					`Working tree has uncommitted changes. Commit or stash them, then re-run /review and choose PR mode.\nCurrent branch: ${currentBranch}\nPR head:        ${headRefName}`,
			};
		}

		if (action === "abort-cancelled") {
			return { ok: false, message: "Review cancelled — branch was not switched." };
		}

		// action === "switch" — perform the checkout
		const checkoutResult = await pi.exec("gh", ["pr", "checkout", String(prNumber)], { cwd });
		if (checkoutResult.code !== 0) {
			const firstLine = checkoutResult.stderr.split("\n")[0]?.trim() ?? "";
			return {
				ok: false,
				message: `gh pr checkout ${prNumber} failed: ${firstLine}`,
			};
		}

		effectiveBranch = headRefName;
		checkoutCtx = { performed: true, priorBranch: currentBranch };
	}

	// 7. Diff gathering
	const diffResult = await pi.exec("gh", ["pr", "diff", String(prNumber)], { cwd });
	if (diffResult.code !== 0) {
		const firstLine = diffResult.stderr.split("\n")[0]?.trim() ?? "";
		return {
			ok: false,
			message: `gh pr diff failed for PR #${prNumber}: ${firstLine}`,
		};
	}

	const ctx: ReviewGatheredContext = {
		currentBranch: effectiveBranch,
		body: diffResult.stdout,
		bodyKind: "diff",
	};
	if (checkoutCtx !== undefined) {
		ctx.checkout = checkoutCtx;
	}

	return { ok: true, ctx };
}

// --- Mode handler ---

async function dispatchReviewMode(
	pi: ExtensionAPI,
	cmdCtx: ExtensionCommandContext,
	parsed: ReviewDispatchArgs,
): Promise<void> {
	// --- Gather phase (all modes) ---
	let result: GatherResult;

	if (parsed.mode === "pr") {
		result = await gatherPr(pi, cmdCtx, parsed.nOrUrl);
	} else {
		switch (parsed.mode) {
			case "uncommitted":
				result = await gatherUncommitted(pi, cmdCtx);
				break;
			case "branch":
				result = await gatherBranch(pi, cmdCtx, parsed.base);
				break;
			case "commit":
				result = await gatherCommit(pi, cmdCtx, parsed.sha);
				break;
			case "folder":
				result = await gatherFolder(pi, cmdCtx, parsed.paths);
				break;
		}
	}

	// --- Uniform error handling ---
	if (!result.ok) {
		cmdCtx.ui.notify(result.message, "error");
		return;
	}

	// --- PR-specific post-gather notification ---
	if (parsed.mode === "pr" && result.ctx.checkout?.performed) {
		cmdCtx.ui.notify(
			`Switched from '${result.ctx.checkout.priorBranch}' to '${result.ctx.currentBranch}'. Use \`git checkout -\` to return.`,
			"info",
		);
	}

	// --- Send envelope ---
	const envelope = buildReviewEnvelope(parsed, result.ctx);
	pi.sendUserMessage(envelope);
}

// --- Argument completions ---

function getReviewArgumentCompletions() {
	return null;
}

// --- Command registration ---

export function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Review code changes via an interactive mode picker",
		getArgumentCompletions: getReviewArgumentCompletions,
		handler: async (args, ctx) => {
			const argv = tokenizeArgs(args);
			const parsed = parseReviewArgs(argv);

			if (!parsed.pickerRequested) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(REVIEW_TUI_REQUIRED_MESSAGE, "error");
				return;
			}

			const mode = await showReviewPicker(ctx);
			if (mode === undefined) {
				// User cancelled — clean no-op.
				return;
			}
			const completedArgs = await completePickedArgs(ctx, mode);
			if (completedArgs === undefined) {
				// User cancelled or left required follow-up input blank.
				return;
			}
			await dispatchReviewMode(pi, ctx, completedArgs);
		},
	});
}
