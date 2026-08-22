import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { REVIEW_MODES, REVIEW_MODE_DESCRIPTIONS, decideBranchAction, tokenizeArgs, parseReviewArgs, } from "./review-args.js";
export { REVIEW_MODES, decideBranchAction, parseReviewArgs } from "./review-args.js";
import { buildReviewEnvelope, parseNullDelimitedGitPaths, buildSnapshotParts, appendUntrackedSnapshot, } from "./review-envelope.js";
export { buildReviewEnvelope } from "./review-envelope.js";
import { isGhGraphqlQuotaFailure, resolveGitHubPrRef, fetchPrMetadataViaRest, fetchPrDiffViaRest, } from "./review-github.js";
import { DynamicBorder, getAgentDir, getSelectListTheme, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig, } from "../the-last-harness-primary-agent.mjs";
const REVIEW_TITLE = "Choose a review mode";
const REVIEW_PICKER_HINT = "↑/↓ to move  Enter to confirm  Esc to cancel";
const REVIEW_DEFAULT_BRANCH_BASE = "main";
const REVIEW_TUI_REQUIRED_MESSAGE = "/review requires the interactive TUI picker. Re-run /review in the TLH UI.";
const REVIEW_REQUIRED_PRIMARY = "architect";
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
function rejectFlagLike(value, fieldName) {
    if (value.startsWith("-")) {
        return {
            ok: false,
            message: `${fieldName} cannot start with '-' (got '${value}'). If this is intentional, run the underlying command manually.`,
        };
    }
    return { ok: true };
}
async function gatherUncommitted(pi, cmdCtx) {
    const cwd = cmdCtx.cwd;
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (branchResult.code !== 0) {
        const message = detectNotGitRepo(branchResult.stderr)
            ? "Not inside a git repository. Run /review from a directory that contains a .git folder."
            : `Could not determine current branch: ${branchResult.stderr.trim()}`;
        return { ok: false, message };
    }
    const currentBranch = branchResult.stdout.trim();
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
    const untrackedResult = await pi.exec("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", "."], {
        cwd: repoRootResult.root,
    });
    if (untrackedResult.code !== 0) {
        const message = detectNotGitRepo(untrackedResult.stderr)
            ? "Not inside a git repository. Run /review from a directory that contains a .git folder."
            : `git ls-files for untracked files failed: ${untrackedResult.stderr.trim()}`;
        return { ok: false, message };
    }
    const untrackedFiles = parseNullDelimitedGitPaths(untrackedResult.stdout).map((filePath) => resolve(repoRootResult.root, filePath));
    const untrackedParts = await buildSnapshotParts(repoRootResult.root, untrackedFiles, "untracked file");
    const body = appendUntrackedSnapshot(diffResult.stdout, untrackedParts);
    return {
        ok: true,
        ctx: { currentBranch, body, bodyKind: "diff" },
    };
}
async function gatherBranch(pi, cmdCtx, base) {
    const effectiveBase = base?.trim() || REVIEW_DEFAULT_BRANCH_BASE;
    const baseCheck = rejectFlagLike(effectiveBase, "base");
    if (baseCheck.ok === false) {
        return { ok: false, message: baseCheck.message };
    }
    const cwd = cmdCtx.cwd;
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
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
    const verifyResult = await pi.exec("git", ["rev-parse", "--verify", effectiveBase], { cwd });
    if (verifyResult.code !== 0) {
        return {
            ok: false,
            message: `Branch base '${effectiveBase}' does not resolve to a valid ref. Make sure the branch or commit exists locally.`,
        };
    }
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
async function gatherCommit(pi, cmdCtx, sha) {
    if (!sha) {
        return {
            ok: false,
            message: "Commit review requires a SHA. Re-run /review and choose commit.",
        };
    }
    const cwd = cmdCtx.cwd;
    const shaCheck = rejectFlagLike(sha, "sha");
    if (shaCheck.ok === false) {
        return { ok: false, message: shaCheck.message };
    }
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
    const showResult = await pi.exec("git", ["show", "--format=fuller", sha], { cwd });
    if (showResult.code !== 0) {
        return {
            ok: false,
            message: `git show failed for '${sha}': ${showResult.stderr.trim()}`,
        };
    }
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const currentBranch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
    return {
        ok: true,
        ctx: { currentBranch, body: showResult.stdout, bodyKind: "diff" },
    };
}
async function walkDir(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
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
async function gatherFolder(pi, cmdCtx, paths) {
    if (paths.length === 0) {
        return {
            ok: false,
            message: "Folder review requires at least one path. Re-run /review and choose folder.",
        };
    }
    const cwd = cmdCtx.cwd;
    const absPaths = paths.map((p) => resolve(cwd, p));
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
            const lsResult = await pi.exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], { cwd: absPath });
            if (lsResult.code === 0) {
                filePaths = parseNullDelimitedGitPaths(lsResult.stdout).map((filePath) => join(absPath, filePath));
            }
            else if (detectNotGitRepo(lsResult.stderr)) {
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
async function gatherPr(pi, cmdCtx, nOrUrl) {
    const cwd = cmdCtx.cwd;
    if (!nOrUrl || !nOrUrl.trim()) {
        return {
            ok: false,
            message: "PR review requires a PR number or URL. Re-run /review and choose PR.",
        };
    }
    const nOrUrlCheck = rejectFlagLike(nOrUrl, "pr");
    if (nOrUrlCheck.ok === false) {
        return { ok: false, message: nOrUrlCheck.message };
    }
    const ghCheckResult = await pi.exec("gh", ["--version"], { cwd });
    if (ghCheckResult.code !== 0) {
        return {
            ok: false,
            message: "PR mode requires the GitHub CLI. Install: https://cli.github.com — then run `gh auth login`.",
        };
    }
    const prViewResult = await pi.exec("gh", [
        "pr",
        "view",
        nOrUrl,
        "--json",
        "number,headRefName,baseRefName,isCrossRepository,headRepository",
    ], { cwd });
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
        const prNumberHint = /^\d+$/u.test(nOrUrl.trim())
            ? Number.parseInt(nOrUrl.trim(), 10)
            : undefined;
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
    const branchResult = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (branchResult.code !== 0) {
        return {
            ok: false,
            message: "Not inside a git repository. Run /review from a directory that contains the PR's repo.",
        };
    }
    const currentBranch = branchResult.stdout.trim();
    let effectiveBranch = currentBranch;
    let checkoutCtx;
    if (currentBranch !== headRefName) {
        const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd });
        if (statusResult.code !== 0) {
            const firstLine = statusResult.stderr.split("\n")[0]?.trim() ?? "git status failed";
            return {
                ok: false,
                message: `Could not determine whether the working tree is clean before switching branches: ${firstLine}`,
            };
        }
        const isDirty = statusResult.stdout.trim().length > 0;
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
async function dispatchReviewMode(pi, cmdCtx, parsed) {
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
    if (result.ok === false) {
        cmdCtx.ui.notify(result.message, "error");
        return;
    }
    if (parsed.mode === "pr" && result.ctx.checkout?.performed) {
        cmdCtx.ui.notify(`Switched from '${result.ctx.checkout.priorBranch}' to '${result.ctx.currentBranch}'. Use \`git checkout -\` to return.`, "info");
    }
    const envelope = buildReviewEnvelope(parsed, result.ctx);
    pi.sendUserMessage(envelope);
}
export const REVIEW_COMMAND_DESCRIPTION = "Review code changes via an interactive mode picker";
function getReviewArgumentCompletions() {
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
            return;
        }
        const completedArgs = await completePickedArgs(ctx, mode);
        if (completedArgs === undefined) {
            return;
        }
        await dispatchReviewMode(pi, ctx, completedArgs);
    };
}
export function registerReviewCommand(pi) {
    pi.registerCommand("review", {
        description: REVIEW_COMMAND_DESCRIPTION,
        getArgumentCompletions: getReviewArgumentCompletions,
        handler: createReviewCommandHandler(pi),
    });
}
