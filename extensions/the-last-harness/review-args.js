const REVIEW_PICKER_ONLY_GUIDANCE = "/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.";
export const REVIEW_MODES = ["uncommitted", "branch", "commit", "pr", "folder"];
export const REVIEW_MODE_DESCRIPTIONS = {
    uncommitted: "Review staged/unstaged changes plus untracked non-gitignored files",
    branch: "Review commits on the current branch vs a chosen base (prompted; blank defaults to main)",
    commit: "Review a single commit by SHA",
    pr: "Review a pull request by number or URL",
    folder: "Review files in one or more folders",
};
export function decideBranchAction(params) {
    const { currentBranch, prHead, isDirty, userConfirm } = params;
    if (currentBranch === prHead)
        return "proceed";
    if (isDirty)
        return "abort-dirty";
    return userConfirm ? "switch" : "abort-cancelled";
}
export function tokenizeArgs(raw) {
    if (!raw.trim())
        return [];
    const tokens = [];
    let current = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (const ch of raw) {
        if (ch === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        }
        else if (ch === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        }
        else if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
            if (current) {
                tokens.push(current);
                current = "";
            }
        }
        else {
            current += ch;
        }
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}
export function parseReviewArgs(argv) {
    if (argv.length === 0) {
        return { pickerRequested: true };
    }
    return {
        pickerRequested: false,
        message: REVIEW_PICKER_ONLY_GUIDANCE,
    };
}
