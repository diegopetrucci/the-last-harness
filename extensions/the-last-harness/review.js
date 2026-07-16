import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DynamicBorder, getAgentDir, getSelectListTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig } from "../the-last-harness-primary-agent.mjs";
// --- Constants ---
const REVIEW_TITLE = "Choose a review mode";
const REVIEW_PICKER_HINT = "↑/↓ to move  Enter to confirm  Esc to cancel";
const REVIEW_DEFAULT_BRANCH_BASE = "main";
const REVIEW_PICKER_ONLY_GUIDANCE = "/review is picker-only. Run /review with no arguments, then choose a mode in the picker. Typed shortcuts like `/review pr 123` and `--extra` are no longer supported.";
const REVIEW_TUI_REQUIRED_MESSAGE = "/review requires the interactive TUI picker. Re-run /review in the TLH UI.";
const REVIEW_REQUIRED_PRIMARY = "architect";
// Intentionally not imported from "./common.js" (see issue #296): review.ts is loaded
// in tests via a native Node strip-types `import`, which — unlike the jiti.import()
// loader used by other extension tests — does not remap "./common.js" to "./common.ts",
// so that import would fail with ERR_MODULE_NOT_FOUND.
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
function currentReviewPrimaryAgentSelection(ctx) {
    const defaultResolution = resolvePrimaryAgentConfig(getTlhGlobalSettings(ctx.cwd).tlh?.primaryAgent);
    const branchEntries = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
    const sessionResolution = primaryAgentSelectionFromBranch(branchEntries);
    return sessionResolution.selection ?? defaultResolution.selection;
}
function reviewPrimaryBlockedMessage(activePrimary) {
    return `/review only works while the architect primary agent is active. Current primary agent: ${activePrimary}. Switch to architect with /switch-primary-agent architect (or Shift+Tab), then rerun /review.`;
}
export const REVIEW_MODES = ["uncommitted", "branch", "commit", "pr", "folder"];
const REVIEW_MODE_DESCRIPTIONS = {
    uncommitted: "Review staged/unstaged changes plus untracked non-gitignored files",
    branch: "Review commits on the current branch vs a chosen base (prompted; blank defaults to main)",
    commit: "Review a single commit by SHA",
    pr: "Review a pull request by number or URL",
    folder: "Review files in one or more folders",
};
const REVIEW_UNTRACKED_BEGIN_DELIMITER = "--- begin untracked files ---";
const REVIEW_UNTRACKED_END_DELIMITER = "--- end untracked files ---";
// --- Pure helpers ---
/**
 * Pure branch-mismatch decision function for PR mode.
 * Maps the current state + user confirmation to an action.
 * Has no knowledge of git, gh, or any I/O.
 */
export function decideBranchAction(params) {
    const { currentBranch, prHead, isDirty, userConfirm } = params;
    if (currentBranch === prHead)
        return "proceed";
    if (isDirty)
        return "abort-dirty";
    return userConfirm ? "switch" : "abort-cancelled";
}
/**
 * Tokenise a raw args string from the command handler, respecting single- and
 * double-quoted groups so that quoted picker follow-up input stays grouped.
 * Unquoted whitespace, including newlines from editor prompts, splits tokens.
 */
function tokenizeArgs(raw) {
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
/**
 * /review is picker-only. Bare /review requests the picker; any typed
 * arguments are rejected with explicit guidance so users do not think the
 * command silently ignored meaningful input.
 */
export function parseReviewArgs(argv) {
    if (argv.length === 0) {
        return { pickerRequested: true };
    }
    return {
        pickerRequested: false,
        message: REVIEW_PICKER_ONLY_GUIDANCE,
    };
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
export function buildReviewEnvelope(parsed, ctx) {
    const { mode, extra } = parsed;
    const lines = [];
    // ── Line 1: hard-coded trigger token ──────────────────────────────────────
    lines.push("[/review]");
    // ── Metadata ──────────────────────────────────────────────────────────────
    lines.push(`mode: ${mode}`);
    // Mode-specific refs
    if (parsed.mode === "branch" && parsed.base) {
        lines.push(`base: ${parsed.base}`);
    }
    else if (parsed.mode === "commit" && parsed.sha) {
        lines.push(`sha: ${parsed.sha}`);
    }
    else if (parsed.mode === "pr" && parsed.nOrUrl) {
        lines.push(`pr: ${parsed.nOrUrl}`);
    }
    else if (parsed.mode === "folder" && parsed.paths.length > 0) {
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
    }
    else {
        lines.push("extra:");
        lines.push(extra);
    }
    // ── Body fenced section ───────────────────────────────────────────────────
    const hasBody = ctx?.body !== undefined;
    const fenceKind = hasBody ? (ctx?.bodyKind ?? "diff") : "(pending)";
    const bodyText = hasBody ? escapeEnvelopeFenceLines(ctx?.body, fenceKind) : "(no body gathered)";
    lines.push(`--- begin ${fenceKind} ---`);
    lines.push(bodyText);
    lines.push(`--- end ${fenceKind} ---`);
    return lines.join("\n");
}
// --- Helpers for picker integration ---
/** Construct full dispatch args for a mode chosen interactively with defaults applied. */
function makePickedArgs(mode) {
    return { mode, extra: undefined };
}
async function promptForRequiredReviewInput(ctx, title) {
    const response = await ctx.ui.editor(title);
    const trimmed = response?.trim();
    return trimmed ? trimmed : undefined;
}
async function promptForBranchBase(ctx) {
    const response = await ctx.ui.editor("Review branch: enter base branch (blank defaults to main)", REVIEW_DEFAULT_BRANCH_BASE);
    if (response === undefined) {
        return undefined;
    }
    const trimmed = response.trim();
    return trimmed || REVIEW_DEFAULT_BRANCH_BASE;
}
async function completePickedArgs(ctx, mode) {
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
    const rawPaths = await promptForRequiredReviewInput(ctx, "Review folder: enter one or more paths (quote paths with spaces)");
    if (!rawPaths) {
        return undefined;
    }
    const paths = tokenizeArgs(rawPaths);
    return paths.length > 0 ? { mode: "folder", paths, extra: undefined } : undefined;
}
// --- Interactive picker ---
async function showReviewPicker(ctx) {
    if (!ctx.hasUI) {
        return undefined;
    }
    const items = REVIEW_MODES.map((mode) => ({
        value: mode,
        label: mode,
        description: REVIEW_MODE_DESCRIPTIONS[mode],
    }));
    const selected = await ctx.ui.custom((_tui, theme, _kb, done) => {
        const selectTheme = getSelectListTheme();
        const selectList = new SelectList(items, items.length, selectTheme);
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(undefined);
        const container = new Container();
        const border = new DynamicBorder((segment) => theme.fg("accent", segment));
        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold(REVIEW_TITLE)), 1, 0));
        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", REVIEW_PICKER_HINT), 1, 0));
        container.addChild(border);
        return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
                selectList.handleInput(data);
            },
        };
    });
    return selected;
}
function formatPostCheckoutPrFailure(message, checkoutCtx, currentBranch) {
    if (!checkoutCtx?.performed) {
        return message;
    }
    return `${message}\n/review already switched from '${checkoutCtx.priorBranch}' to '${currentBranch}' before the failure. Use \`git checkout -\` to return to '${checkoutCtx.priorBranch}'.`;
}
function detectNotGitRepo(stderr) {
    return /not a git repository/i.test(stderr);
}
async function resolveRepoRoot(pi, cwd, context) {
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
function rejectFlagLike(value, fieldName) {
    if (value.startsWith("-")) {
        return { ok: false, message: `${fieldName} cannot start with '-' (got '${value}'). If this is intentional, run the underlying command manually.` };
    }
    return { ok: true };
}
function isGhGraphqlQuotaFailure(stderr) {
    return /graphql/i.test(stderr) && /(rate limit|quota|submitted too quickly)/i.test(stderr);
}
function parseGitHubPrUrl(value) {
    try {
        const url = new URL(value);
        if (url.hostname !== "github.com") {
            return undefined;
        }
        const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
        if (!match) {
            return undefined;
        }
        return { owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
    }
    catch {
        return undefined;
    }
}
function parseGitHubRepoSlug(value) {
    const match = value.trim().match(/^([^/\s]+)\/([^/\s]+)$/u);
    if (!match) {
        return undefined;
    }
    return { owner: match[1], repo: match[2] };
}
function parseGitHubRemoteUrl(value) {
    const trimmed = value.trim();
    const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (sshMatch) {
        return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    try {
        const url = new URL(trimmed);
        if (url.hostname !== "github.com") {
            return undefined;
        }
        const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
        if (!match) {
            return undefined;
        }
        return { owner: match[1], repo: match[2] };
    }
    catch {
        return undefined;
    }
}
async function resolveGitHubRepoRefFromGhDefault(pi, cwd) {
    const defaultRepoResult = await pi.exec("gh", ["repo", "set-default", "--view"], { cwd });
    if (defaultRepoResult.code !== 0) {
        return undefined;
    }
    for (const line of defaultRepoResult.stdout.split(/\r?\n/u)) {
        const repoRef = parseGitHubRepoSlug(line);
        if (repoRef) {
            return repoRef;
        }
    }
    return undefined;
}
async function resolveGitHubRepoRefFromLocalRemotes(pi, cwd) {
    const remoteListResult = await pi.exec("git", ["remote"], { cwd });
    if (remoteListResult.code !== 0) {
        const firstLine = remoteListResult.stderr.split("\n")[0]?.trim() || "git remote failed";
        return { ok: false, message: `could not list git remotes: ${firstLine}` };
    }
    const remoteNames = remoteListResult.stdout
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean);
    if (remoteNames.length === 0) {
        return { ok: false, message: "could not resolve GitHub repository because this repo has no git remotes" };
    }
    const orderedRemoteNames = Array.from(new Set(["origin", ...remoteNames]));
    const remoteFailures = [];
    for (const remoteName of orderedRemoteNames) {
        const remoteUrlResult = await pi.exec("git", ["remote", "get-url", remoteName], { cwd });
        if (remoteUrlResult.code !== 0) {
            const firstLine = remoteUrlResult.stderr.split("\n")[0]?.trim() || `git remote get-url ${remoteName} failed`;
            remoteFailures.push(`${remoteName}: ${firstLine}`);
            continue;
        }
        const repoRef = parseGitHubRemoteUrl(remoteUrlResult.stdout);
        if (repoRef) {
            return { ok: true, repoRef };
        }
        remoteFailures.push(`${remoteName}: unsupported remote URL '${remoteUrlResult.stdout.trim()}'`);
    }
    return {
        ok: false,
        message: `could not parse a GitHub owner/repo from local git remotes (${remoteFailures.join("; ")})`,
    };
}
async function resolveGitHubPrRef(pi, cwd, nOrUrl, prNumberHint) {
    const urlRef = parseGitHubPrUrl(nOrUrl);
    if (urlRef) {
        return { ok: true, prRef: urlRef };
    }
    if (prNumberHint === undefined) {
        return { ok: false, message: `could not resolve a PR number from '${nOrUrl}'` };
    }
    const ghDefaultRepoRef = await resolveGitHubRepoRefFromGhDefault(pi, cwd);
    if (ghDefaultRepoRef) {
        return { ok: true, prRef: { ...ghDefaultRepoRef, number: prNumberHint } };
    }
    const repoRefResult = await resolveGitHubRepoRefFromLocalRemotes(pi, cwd);
    if (repoRefResult.ok === false) {
        return { ok: false, message: repoRefResult.message };
    }
    return { ok: true, prRef: { ...repoRefResult.repoRef, number: prNumberHint } };
}
async function fetchPrMetadataViaRest(pi, cwd, prRef) {
    const result = await pi.exec("gh", ["api", `repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}`], { cwd });
    if (result.code !== 0) {
        const firstLine = result.stderr.split("\n")[0]?.trim() || "gh api failed";
        return { ok: false, message: firstLine };
    }
    try {
        const payload = JSON.parse(result.stdout);
        const number = typeof payload.number === "number" ? payload.number : prRef.number;
        const headRefName = payload.head?.ref;
        const baseRefName = payload.base?.ref;
        if (!headRefName || !baseRefName) {
            return { ok: false, message: "REST PR metadata response was missing head/base refs" };
        }
        return {
            ok: true,
            prData: {
                number,
                headRefName,
                baseRefName,
                isCrossRepository: typeof payload.head?.repo?.full_name === "string" && typeof payload.base?.repo?.full_name === "string"
                    ? payload.head.repo.full_name !== payload.base.repo.full_name
                    : false,
            },
        };
    }
    catch {
        return { ok: false, message: "Could not parse REST PR metadata response" };
    }
}
async function fetchPrDiffViaRest(pi, cwd, prRef) {
    const result = await pi.exec("gh", ["api", "-H", "Accept: application/vnd.github.v3.diff", `repos/${prRef.owner}/${prRef.repo}/pulls/${prRef.number}`], { cwd });
    if (result.code !== 0) {
        const firstLine = result.stderr.split("\n")[0]?.trim() || "gh api failed";
        return { ok: false, message: firstLine };
    }
    return { ok: true, diff: result.stdout };
}
/**
 * Gather staged + unstaged changes vs HEAD for the uncommitted mode.
 * Also appends untracked, non-gitignored file contents so brand-new files are reviewable.
 */
async function gatherUncommitted(pi, cmdCtx) {
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
async function gatherBranch(pi, cmdCtx, base) {
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
async function gatherCommit(pi, cmdCtx, sha) {
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
 * Return true when a file is likely binary.
 * Heuristic: read the first 8 KB and check for a NUL (0x00) byte.
 */
async function isBinaryFile(filePath) {
    let handle;
    try {
        handle = await open(filePath, "r");
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buf, 0, 8192, 0);
        return buf.subarray(0, bytesRead).includes(0);
    }
    finally {
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
async function walkDir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip well-known noisy directories during recursion.
            if (entry.name === "node_modules" || entry.name.startsWith(".")) {
                continue;
            }
            files.push(...(await walkDir(full)));
        }
        else {
            files.push(full);
        }
    }
    return files;
}
function parseNullDelimitedGitPaths(stdout) {
    return stdout.split("\0").filter((filePath) => filePath.length > 0);
}
function escapeDelimitedContentLine(line) {
    return `\\${line}`;
}
function escapeContentDelimiters(content) {
    return content
        .split("\n")
        .map((line) => {
        if (line === "--- begin snapshot ---"
            || line === "--- end snapshot ---"
            || line === REVIEW_UNTRACKED_BEGIN_DELIMITER
            || line === REVIEW_UNTRACKED_END_DELIMITER
            || /^--- (?:file|untracked file): .* ---$/.test(line)) {
            return escapeDelimitedContentLine(line);
        }
        return line;
    })
        .join("\n");
}
function escapeEnvelopeFenceLines(body, fenceKind) {
    const beginFence = `--- begin ${fenceKind} ---`;
    const endFence = `--- end ${fenceKind} ---`;
    return body
        .split("\n")
        .map((line) => (line === beginFence || line === endFence ? escapeDelimitedContentLine(line) : line))
        .join("\n");
}
function renderDelimitedPath(relPath) {
    return JSON.stringify(relPath)
        .replace(/[\u007f-\u009f\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .replace(/\[/g, "\\u005b")
        .replace(/\]/g, "\\u005d");
}
function getNonRegularSnapshotMarker(relPath, pathStat) {
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
async function buildSnapshotParts(cwd, filePaths, label) {
    const parts = [];
    for (const filePath of filePaths) {
        const relPath = relative(cwd, filePath);
        const renderedPath = renderDelimitedPath(relPath);
        let pathStat;
        try {
            pathStat = await lstat(filePath);
        }
        catch {
            parts.push(`[skipped lstat failure: ${renderedPath}]`);
            continue;
        }
        const nonRegularMarker = getNonRegularSnapshotMarker(relPath, pathStat);
        if (nonRegularMarker) {
            parts.push(nonRegularMarker);
            continue;
        }
        let bin;
        try {
            bin = await isBinaryFile(filePath);
        }
        catch {
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
        }
        catch {
            parts.push(`[skipped read failure: ${renderedPath}]`);
        }
    }
    return parts;
}
function appendUntrackedSnapshot(diffBody, untrackedParts) {
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
async function gatherFolder(pi, cmdCtx, paths) {
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
        }
        catch {
            return {
                ok: false,
                message: `Path does not exist: ${paths[i]}`,
            };
        }
    }
    // Resolve current branch (best-effort; folder mode may be used outside a git repo)
    let currentBranch;
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (branchResult.code === 0) {
        currentBranch = branchResult.stdout.trim();
    }
    const parts = [];
    for (let i = 0; i < absPaths.length; i++) {
        const absPath = absPaths[i];
        const pathStat = await lstat(absPath);
        let filePaths;
        if (pathStat.isDirectory()) {
            // Prefer git ls-files to respect .gitignore naturally;
            // --others --exclude-standard includes untracked-but-not-gitignored files.
            // If git reports zero files for this directory, keep that empty result instead of
            // walking the tree and accidentally snapshotting ignored files.
            const lsResult = await pi.exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: absPath });
            if (lsResult.code === 0) {
                filePaths = parseNullDelimitedGitPaths(lsResult.stdout)
                    .map((filePath) => join(absPath, filePath));
            }
            else if (detectNotGitRepo(lsResult.stderr)) {
                // Fall back to a plain recursive walk only when outside git entirely.
                filePaths = await walkDir(absPath);
            }
            else {
                return {
                    ok: false,
                    message: `git ls-files failed for folder path '${paths[i]}': ${lsResult.stderr.trim()}`,
                };
            }
        }
        else {
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
async function showBranchSwitchConfirm(cmdCtx, currentBranch, headRefName, baseRefName) {
    const confirmed = await cmdCtx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((segment) => theme.fg("accent", segment));
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
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
                if (matchesKey(data, "enter") || matchesKey(data, "y")) {
                    done(true);
                }
                else if (matchesKey(data, "n") || matchesKey(data, "escape")) {
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
async function gatherPr(pi, cmdCtx, nOrUrl) {
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
    const prViewResult = await pi.exec("gh", ["pr", "view", nOrUrl, "--json", "number,headRefName,baseRefName,isCrossRepository,headRepository"], { cwd });
    let prRef;
    let prData;
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
    }
    else {
        try {
            prData = JSON.parse(prViewResult.stdout);
        }
        catch {
            return {
                ok: false,
                message: `Could not parse PR metadata for '${nOrUrl}'.`,
            };
        }
    }
    if (prData.isCrossRepository === true) {
        return {
            ok: false,
            message: "Cross-repository PRs are not supported yet. Fetch the branch locally first, then re-run /review and choose branch mode.",
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
    let checkoutCtx;
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
    let diffBody;
    if (diffResult.code !== 0) {
        const firstLine = diffResult.stderr.split("\n")[0]?.trim() ?? "";
        if (!isGhGraphqlQuotaFailure(diffResult.stderr)) {
            return {
                ok: false,
                message: formatPostCheckoutPrFailure(`gh pr diff failed for PR #${prNumber}: ${firstLine}`, checkoutCtx, effectiveBranch),
            };
        }
        if (!prRef) {
            const prRefResult = await resolveGitHubPrRef(pi, cwd, nOrUrl, prNumber);
            if (prRefResult.ok === false) {
                return {
                    ok: false,
                    message: formatPostCheckoutPrFailure(`gh pr diff hit a GraphQL quota/rate-limit error for PR #${prNumber}: ${firstLine}. REST fallback could not resolve the PR target: ${prRefResult.message}`, checkoutCtx, effectiveBranch),
                };
            }
            prRef = prRefResult.prRef;
        }
        const restDiffResult = await fetchPrDiffViaRest(pi, cwd, prRef);
        if (restDiffResult.ok === false) {
            return {
                ok: false,
                message: formatPostCheckoutPrFailure(`gh pr diff hit a GraphQL quota/rate-limit error for PR #${prNumber}: ${firstLine}. REST fallback also failed: ${restDiffResult.message}`, checkoutCtx, effectiveBranch),
            };
        }
        diffBody = restDiffResult.diff;
    }
    else {
        diffBody = diffResult.stdout;
    }
    const ctx = {
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
async function dispatchReviewMode(pi, cmdCtx, parsed) {
    // --- Gather phase (all modes) ---
    let result;
    if (parsed.mode === "pr") {
        result = await gatherPr(pi, cmdCtx, parsed.nOrUrl);
    }
    else {
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
        cmdCtx.ui.notify(`Switched from '${result.ctx.checkout.priorBranch}' to '${result.ctx.currentBranch}'. Use \`git checkout -\` to return.`, "info");
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
export function createReviewCommandHandler(pi) {
    return async (args, ctx) => {
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
export function registerReviewCommand(pi) {
    pi.registerCommand("review", {
        description: REVIEW_COMMAND_DESCRIPTION,
        getArgumentCompletions: getReviewArgumentCompletions,
        handler: createReviewCommandHandler(pi),
    });
}
