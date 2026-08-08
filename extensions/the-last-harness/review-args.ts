// Argument-parsing and review-mode declarations extracted from the main review module (slice 4 of gh-297).
// This module is intentionally self-contained: it does NOT import from the parent review module.

const REVIEW_PICKER_ONLY_GUIDANCE =
	"/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.";

export const REVIEW_MODES = ["uncommitted", "branch", "commit", "pr", "folder"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const REVIEW_MODE_DESCRIPTIONS: Record<ReviewMode, string> = {
	uncommitted: "Review staged/unstaged changes plus untracked non-gitignored files",
	branch: "Review commits on the current branch vs a chosen base (prompted; blank defaults to main)",
	commit: "Review a single commit by SHA",
	pr: "Review a pull request by number or URL",
	folder: "Review files in one or more folders",
};

// --- Types ---

/** Action returned by the pure branch-mismatch decision helper. */
export type BranchDecisionAction = "proceed" | "abort-dirty" | "switch" | "abort-cancelled";

export type ParsedReviewArgs = { pickerRequested: true } | { pickerRequested: false; message: string };

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
export function tokenizeArgs(raw: string): string[] {
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
