import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
	REVIEW_MODES,
	REVIEW_MODE_DESCRIPTIONS,
	decideBranchAction,
	tokenizeArgs,
	parseReviewArgs,
} from "./review-args.js";
import type { ReviewMode, ReviewDispatchArgs } from "./review-args.js";
export { REVIEW_MODES, decideBranchAction, parseReviewArgs } from "./review-args.js";
export type { ReviewMode, BranchDecisionAction, ParsedReviewArgs, ReviewDispatchArgs } from "./review-args.js";
import {
	buildReviewEnvelope,
	parseNullDelimitedGitPaths,
	buildSnapshotParts,
	appendUntrackedSnapshot,
} from "./review-envelope.js";
import type { ReviewGatheredContext } from "./review-envelope.js";
export type { ReviewGatheredContext } from "./review-envelope.js";
export { buildReviewEnvelope } from "./review-envelope.js";
import {
	isGhGraphqlQuotaFailure,
	resolveGitHubPrRef,
	fetchPrMetadataViaRest,
	fetchPrDiffViaRest,
} from "./review-github.js";
import type { GitHubPrRef } from "./review-github.js";

import {
	DynamicBorder,
	getAgentDir,
	getSelectListTheme,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

import { primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig } from "../the-last-harness-primary-agent.mjs";

// --- Constants ---

const REVIEW_TITLE = "Choose a review mode";
const REVIEW_PICKER_HINT = "↑/↓ to move  Enter to confirm  Esc to cancel";
const REVIEW_DEFAULT_BRANCH_BASE = "main";
const REVIEW_TUI_REQUIRED_MESSAGE = "/review requires the interactive TUI picker. Re-run /review in the TLH UI.";

type ReviewPrimaryAgentSelection = "architect" | "rush" | "product" | "bug-hunter" | "disabled";
type ReviewSettings = {
	tlh?: {
		primaryAgent?: {
			enabled?: boolean;
			selected?: string;
		};
	};
};

const REVIEW_REQUIRED_PRIMARY: ReviewPrimaryAgentSelection = "architect";

// Intentionally not imported from "./common.js" (see issue #296): keep review.ts
// source-level tests isolated from unrelated shared-runtime dependencies.
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTlhGlobalSettings(cwd: string): ReviewSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return isRecord(settings) ? (settings as ReviewSettings) : {};
	} catch {
		return {};
	}
}

function currentReviewPrimaryAgentSelection(ctx: ExtensionCommandContext): ReviewPrimaryAgentSelection {
	const defaultResolution = resolvePrimaryAgentConfig(getTlhGlobalSettings(ctx.cwd).tlh?.primaryAgent) as {
		selection: ReviewPrimaryAgentSelection;
	};
	const branchEntries = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
	const sessionResolution = primaryAgentSelectionFromBranch(branchEntries) as {
		selection?: ReviewPrimaryAgentSelection;
	};
	return sessionResolution.selection ?? defaultResolution.selection;
}

function reviewPrimaryBlockedMessage(activePrimary: ReviewPrimaryAgentSelection): string {
	return `/review only works while the architect primary agent is active. Current primary agent: ${activePrimary}. Switch to architect with /switch-primary-agent architect (or Shift+Tab), then rerun /review.`;
}

// --- Helpers for picker integration ---

/** Construct full dispatch args for a mode chosen interactively with defaults applied. */
function makePickedArgs(mode: "uncommitted"): ReviewDispatchArgs {
	return { mode, extra: undefined };
}

async function promptForRequiredReviewInput(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
	const response = await ctx.ui.editor(title);
	const trimmed = response?.trim();
	return trimmed ? trimmed : undefined;
}

async function promptForBranchBase(ctx: ExtensionCommandContext): Promise<string | undefined> {
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

function formatPostCheckoutPrFailure(
	message: string,
	checkoutCtx: ReviewGatheredContext["checkout"] | undefined,
	currentBranch: string,
): string {
	if (!checkoutCtx?.performed) {
		return message;
	}

	return `${message}\n/review already switched from '${checkoutCtx.priorBranch}' to '${currentBranch}' before the failure. Use \`git checkout -\` to return to '${checkoutCtx.priorBranch}'.`;
}

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
		return {
			ok: false,
			message: `${fieldName} cannot start with '-' (got '${value}'). If this is intentional, run the underlying command manually.`,
		};
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
	if (repoRootResult.ok === false) {
		return { ok: false, message: repoRootResult.message };
	}

	// Include untracked, non-gitignored files so the reviewer can see newly added content.
	const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", "."], {
		cwd: repoRootResult.root,
	});
	if (untrackedResult.code !== 0) {
		const message = detectNotGitRepo(untrackedResult.stderr)
			? "Not inside a git repository. Run /review from a directory that contains a .git folder."
			: `git ls-files for untracked files failed: ${untrackedResult.stderr.trim()}`;
		return { ok: false, message };
	}

	const untrackedFiles = parseNullDelimitedGitPaths(untrackedResult.stdout).map((filePath) =>
		resolve(repoRootResult.root, filePath),
	);
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
	if (baseCheck.ok === false) {
		return { ok: false, message: baseCheck.message };
	}

	const cwd = cmdCtx.cwd;

	// Refuse if HEAD is detached
	const symRefResult = await pi.exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd });
	if (symRefResult.code !== 0) {
		if (detectNotGitRepo(symRefResult.stderr)) {
			return {
				ok: false,
				message: "Not inside a git repository. Run /review from a directory that contains a .git folder.",
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
	if (shaCheck.ok === false) {
		return { ok: false, message: shaCheck.message };
	}

	// Validate that the ref resolves to an actual commit object
	const verifyResult = await pi.exec("git", ["rev-parse", "--verify", `${sha}^{commit}`], { cwd });
	if (verifyResult.code !== 0) {
		if (detectNotGitRepo(verifyResult.stderr)) {
			return {
				ok: false,
				message: "Not inside a git repository. Run /review from a directory that contains a .git folder.",
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

/**
 * Build a snapshot payload from the given paths for the folder mode.
 * Directories are walked; binary files are skipped with an annotation.
 */
async function gatherFolder(pi: ExtensionAPI, cmdCtx: ExtensionCommandContext, paths: string[]): Promise<GatherResult> {
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
			const lsResult = await pi.exec(
				"git",
				["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
				{ cwd: absPath },
			);
			if (lsResult.code === 0) {
				filePaths = parseNullDelimitedGitPaths(lsResult.stdout).map((filePath) => join(absPath, filePath));
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
	if (nOrUrlCheck.ok === false) {
		return { ok: false, message: nOrUrlCheck.message };
	}

	// 3. gh CLI availability check
	const ghCheckResult = await pi.exec("gh", ["--version"], { cwd });
	if (ghCheckResult.code !== 0) {
		return {
			ok: false,
			message: "PR mode requires the GitHub CLI. Install: https://cli.github.com — then run `gh auth login`.",
		};
	}

	// 4. PR metadata resolution
	const prViewResult = await pi.exec(
		"gh",
		["pr", "view", nOrUrl, "--json", "number,headRefName,baseRefName,isCrossRepository,headRepository"],
		{ cwd },
	);
	let prRef: GitHubPrRef | undefined;
	let prData: { number: number; headRefName: string; baseRefName: string; isCrossRepository: boolean };
	if (prViewResult.code !== 0) {
		const firstLine = prViewResult.stderr.split("\n")[0]?.trim() ?? "";
		if (!isGhGraphqlQuotaFailure(prViewResult.stderr)) {
			return {
				ok: false,
				message: `Could not resolve PR '${nOrUrl}': ${firstLine}`,
			};
		}

		const prNumberHint = /^\d+$/u.test(nOrUrl.trim()) ? Number.parseInt(nOrUrl.trim(), 10) : undefined;
		const prRefResult = await resolveGitHubPrRef(pi, cwd, nOrUrl, prNumberHint);
		if (prRefResult.ok === false) {
			return {
				ok: false,
				message: `gh pr view hit a GraphQL quota/rate-limit error for '${nOrUrl}': ${firstLine}. REST fallback could not resolve the PR target: ${prRefResult.message}`,
			};
		}
		prRef = prRefResult.prRef;

		const restPrResult = await fetchPrMetadataViaRest(pi, cwd, prRef);
		if (restPrResult.ok === false) {
			return {
				ok: false,
				message: `gh pr view hit a GraphQL quota/rate-limit error for '${nOrUrl}': ${firstLine}. REST fallback also failed: ${restPrResult.message}`,
			};
		}
		prData = restPrResult.prData;
	} else {
		try {
			prData = JSON.parse(prViewResult.stdout) as typeof prData;
		} catch {
			return {
				ok: false,
				message: `Could not parse PR metadata for '${nOrUrl}'.`,
			};
		}
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
			message: "Not inside a git repository. Run /review from a directory that contains the PR's repo.",
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
					message: `Branch switch confirmation requires the TUI. You're on '${currentBranch}'; PR head is '${headRefName}'. Run \`gh pr checkout ${prNumber}\` manually, then re-run /review and choose PR mode.`,
				};
			}
			userConfirm = await showBranchSwitchConfirm(cmdCtx, currentBranch, headRefName, baseRefName);
		}

		const action = decideBranchAction({ currentBranch, prHead: headRefName, isDirty, userConfirm });

		if (action === "abort-dirty") {
			return {
				ok: false,
				message: `Working tree has uncommitted changes. Commit or stash them, then re-run /review and choose PR mode.\nCurrent branch: ${currentBranch}\nPR head:        ${headRefName}`,
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
	let diffBody: string;
	if (diffResult.code !== 0) {
		const firstLine = diffResult.stderr.split("\n")[0]?.trim() ?? "";
		if (!isGhGraphqlQuotaFailure(diffResult.stderr)) {
			return {
				ok: false,
				message: formatPostCheckoutPrFailure(
					`gh pr diff failed for PR #${prNumber}: ${firstLine}`,
					checkoutCtx,
					effectiveBranch,
				),
			};
		}

		if (!prRef) {
			const prRefResult = await resolveGitHubPrRef(pi, cwd, nOrUrl, prNumber);
			if (prRefResult.ok === false) {
				return {
					ok: false,
					message: formatPostCheckoutPrFailure(
						`gh pr diff hit a GraphQL quota/rate-limit error for PR #${prNumber}: ${firstLine}. REST fallback could not resolve the PR target: ${prRefResult.message}`,
						checkoutCtx,
						effectiveBranch,
					),
				};
			}
			prRef = prRefResult.prRef;
		}

		const restDiffResult = await fetchPrDiffViaRest(pi, cwd, prRef);
		if (restDiffResult.ok === false) {
			return {
				ok: false,
				message: formatPostCheckoutPrFailure(
					`gh pr diff hit a GraphQL quota/rate-limit error for PR #${prNumber}: ${firstLine}. REST fallback also failed: ${restDiffResult.message}`,
					checkoutCtx,
					effectiveBranch,
				),
			};
		}
		diffBody = restDiffResult.diff;
	} else {
		diffBody = diffResult.stdout;
	}

	const ctx: ReviewGatheredContext = {
		currentBranch: effectiveBranch,
		body: diffBody,
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
	if (result.ok === false) {
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

export const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";

export function getReviewArgumentCompletions() {
	return null;
}

export function createReviewCommandHandler(pi: ExtensionAPI) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const activePrimary = currentReviewPrimaryAgentSelection(ctx);
		if (activePrimary !== REVIEW_REQUIRED_PRIMARY) {
			ctx.ui.notify(reviewPrimaryBlockedMessage(activePrimary), "error");
			return;
		}

		const argv = tokenizeArgs(args);
		const parsed = parseReviewArgs(argv);

		if (parsed.pickerRequested === false) {
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
	};
}

// --- Command registration ---

export function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: REVIEW_COMMAND_DESCRIPTION,
		getArgumentCompletions: getReviewArgumentCompletions,
		handler: createReviewCommandHandler(pi),
	});
}
