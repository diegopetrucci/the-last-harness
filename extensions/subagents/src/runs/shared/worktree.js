import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;
function runGit(cwd, args) {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
    };
}
function runGitChecked(cwd, args) {
    const result = runGit(cwd, args);
    if (result.status !== 0) {
        const command = `git -C ${cwd} ${args.join(" ")}`;
        const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
        throw new Error(message);
    }
    return result.stdout;
}
function resolveRepoState(cwd) {
    const cwdRelative = resolveRepoCwdRelative(cwd);
    const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
    const status = runGitChecked(toplevel, ["status", "--porcelain"]);
    if (status.trim().length > 0) {
        throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
    }
    const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
    return { toplevel, cwdRelative, baseCommit };
}
function normalizeComparableCwd(cwd) {
    const resolved = path.resolve(cwd);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        return resolved;
    }
}
export function findWorktreeTaskCwdConflict(tasks, sharedCwd) {
    const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
    for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        if (!task.cwd)
            continue;
        const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
        if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd)
            continue;
        return { index, agent: task.agent, cwd: task.cwd };
    }
    return undefined;
}
export function formatWorktreeTaskCwdConflict(conflict, sharedCwd) {
    return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}
function safePatchAgentName(agent) {
    return agent.replace(/[^\w.-]/g, "_");
}
function buildWorktreeBranch(runId, index) {
    return `pi-parallel-${runId}-${index}`;
}
function resolveWorktreeBaseDir(configuredBaseDir, repoRoot) {
    const rawBaseDir = configuredBaseDir ?? process.env.PI_SUBAGENTS_WORKTREE_DIR;
    if (rawBaseDir === undefined)
        return os.tmpdir();
    const trimmed = rawBaseDir.trim();
    if (!trimmed)
        throw new Error("worktree base directory cannot be empty");
    const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
    try {
        fs.mkdirSync(resolved, { recursive: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to create worktree base directory ${resolved}: ${message}`, { cause: error });
    }
    return resolved;
}
function buildWorktreePath(baseDir, runId, index) {
    return path.join(baseDir, `pi-worktree-${runId}-${index}`);
}
function resolveRepoCwdRelative(cwd) {
    const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
        throw new Error("worktree isolation requires a git repository");
    }
    const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
    const normalizedPrefix = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
    return normalizedPrefix === "." ? "" : normalizedPrefix;
}
export function resolveExpectedWorktreeAgentCwd(cwd, runId, index, baseDir) {
    const cwdRelative = resolveRepoCwdRelative(cwd);
    const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
    const worktreePath = buildWorktreePath(resolveWorktreeBaseDir(baseDir, repoRoot), runId, index);
    return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}
function linkNodeModulesIfPresent(toplevel, worktreePath) {
    const nodeModulesPath = path.join(toplevel, "node_modules");
    const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
    if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath))
        return false;
    try {
        fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
        return true;
    }
    catch {
        return false;
    }
}
function parseHookTimeout(timeoutMs) {
    if (timeoutMs === undefined)
        return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("worktree setup hook timeout must be an integer greater than 0");
    }
    return timeoutMs;
}
function resolveWorktreeSetupHook(repoRoot, config) {
    if (!config)
        return undefined;
    const hookPath = config.hookPath.trim();
    if (!hookPath) {
        throw new Error("worktree setup hook path cannot be empty");
    }
    const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
    let resolvedPath;
    if (path.isAbsolute(expandedHookPath)) {
        resolvedPath = expandedHookPath;
    }
    else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
        resolvedPath = path.resolve(repoRoot, expandedHookPath);
    }
    else {
        throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
    }
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`worktree setup hook not found: ${resolvedPath}`);
    }
    if (fs.statSync(resolvedPath).isDirectory()) {
        throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
    }
    return {
        hookPath: resolvedPath,
        timeoutMs: parseHookTimeout(config.timeoutMs),
    };
}
function normalizeSyntheticPath(worktreePath, rawPath) {
    const trimmed = rawPath.trim();
    if (!trimmed)
        throw new Error("synthetic path cannot be empty");
    if (path.isAbsolute(trimmed))
        throw new Error(`synthetic path must be relative: ${rawPath}`);
    const resolved = path.resolve(worktreePath, trimmed);
    const relative = path.relative(worktreePath, resolved);
    if (!relative || relative === ".") {
        throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
    }
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
    }
    return path.normalize(relative);
}
function hasTrackedEntries(worktreePath, relativePath) {
    const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
    return result.status === 0 && result.stdout.trim().length > 0;
}
function parseWorktreeSetupHookOutput(rawStdout) {
    const trimmed = rawStdout.trim();
    if (!trimmed) {
        throw new Error("worktree setup hook returned empty stdout; expected JSON object");
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`worktree setup hook returned invalid JSON: ${message}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("worktree setup hook stdout must be a JSON object");
    }
    return parsed;
}
function runWorktreeSetupHook(hook, input) {
    const result = spawnSync(hook.hookPath, [], {
        cwd: input.worktreePath,
        encoding: "utf-8",
        input: JSON.stringify(input),
        timeout: hook.timeoutMs,
        shell: false,
    });
    if (result.error) {
        const code = "code" in result.error ? result.error.code : undefined;
        if (code === "ETIMEDOUT") {
            throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
        }
        throw new Error(`worktree setup hook failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const details = result.stderr.trim() || result.stdout.trim() || "no output";
        throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
    }
    const output = parseWorktreeSetupHookOutput(result.stdout);
    if (output.syntheticPaths === undefined)
        return [];
    if (!Array.isArray(output.syntheticPaths)) {
        throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
    }
    const uniquePaths = new Set();
    for (const candidate of output.syntheticPaths) {
        if (typeof candidate !== "string") {
            throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
        }
        const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
        if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
            throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
        }
        uniquePaths.add(normalizedPath);
    }
    return [...uniquePaths];
}
function createSingleWorktree(toplevel, cwdRelative, runId, index, baseCommit, setupHook, agent, baseDir) {
    const branch = buildWorktreeBranch(runId, index);
    const worktreePath = buildWorktreePath(baseDir, runId, index);
    const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
    if (add.status !== 0) {
        const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
        throw new Error(message);
    }
    const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
    try {
        const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
        const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];
        if (setupHook) {
            const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
                version: 1,
                repoRoot: toplevel,
                worktreePath,
                agentCwd,
                branch,
                index,
                runId,
                baseCommit,
                agent,
            });
            syntheticPaths.push(...hookSyntheticPaths);
        }
        return {
            path: worktreePath,
            agentCwd,
            branch,
            index,
            nodeModulesLinked,
            syntheticPaths,
        };
    }
    catch (error) {
        try {
            runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]);
        }
        catch {
        }
        try {
            runGitChecked(toplevel, ["branch", "-D", branch]);
        }
        catch {
        }
        throw error;
    }
}
function removeSyntheticPath(worktree, syntheticPath) {
    const resolved = path.resolve(worktree.path, syntheticPath);
    const relative = path.relative(worktree.path, resolved);
    if (!relative ||
        relative === "." ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        return;
    }
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "ENOENT")
            return;
        throw error;
    }
    if (stat.isSymbolicLink()) {
        fs.unlinkSync(resolved);
        return;
    }
    if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true });
        return;
    }
    fs.rmSync(resolved, { force: true });
}
function removeSyntheticPathsBeforeDiff(worktree) {
    if (worktree.syntheticPaths.length === 0)
        return;
    const seen = new Set();
    for (const syntheticPath of worktree.syntheticPaths) {
        if (seen.has(syntheticPath))
            continue;
        seen.add(syntheticPath);
        removeSyntheticPath(worktree, syntheticPath);
    }
}
function emptyDiff(index, agent, branch, patchPath) {
    return {
        index,
        agent,
        branch,
        diffStat: "",
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        patchPath,
    };
}
function parseNumstat(numstat) {
    const lines = numstat
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines) {
        const [rawInsertions, rawDeletions] = line.split("\t");
        if (rawInsertions === undefined || rawDeletions === undefined)
            continue;
        filesChanged++;
        if (/^\d+$/.test(rawInsertions))
            insertions += parseInt(rawInsertions, 10);
        if (/^\d+$/.test(rawDeletions))
            deletions += parseInt(rawDeletions, 10);
    }
    return { filesChanged, insertions, deletions };
}
function captureWorktreeDiff(setup, worktree, agent, patchPath) {
    removeSyntheticPathsBeforeDiff(worktree);
    runGitChecked(worktree.path, ["add", "-A"]);
    const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
    const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
    const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
    fs.writeFileSync(patchPath, patch, "utf-8");
    if (!patch.trim()) {
        return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
    }
    const parsed = parseNumstat(numstat);
    return {
        index: worktree.index,
        agent,
        branch: worktree.branch,
        diffStat,
        filesChanged: parsed.filesChanged,
        insertions: parsed.insertions,
        deletions: parsed.deletions,
        patchPath,
    };
}
function writeEmptyPatch(patchPath) {
    try {
        fs.writeFileSync(patchPath, "", "utf-8");
    }
    catch {
    }
}
function cleanupSingleWorktree(repoCwd, worktree) {
    try {
        runGitChecked(repoCwd, ["worktree", "remove", "--force", worktree.path]);
    }
    catch {
    }
    try {
        runGitChecked(repoCwd, ["branch", "-D", worktree.branch]);
    }
    catch {
    }
}
function hasWorktreeChanges(diff) {
    return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}
export function createWorktrees(cwd, runId, count, options) {
    const repo = resolveRepoState(cwd);
    const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
    const baseDir = resolveWorktreeBaseDir(options?.baseDir, repo.toplevel);
    const worktrees = [];
    try {
        for (let index = 0; index < count; index++) {
            worktrees.push(createSingleWorktree(repo.toplevel, repo.cwdRelative, runId, index, repo.baseCommit, setupHook, options?.agents?.[index], baseDir));
        }
    }
    catch (error) {
        cleanupWorktrees({
            cwd: repo.toplevel,
            worktrees,
            baseCommit: repo.baseCommit,
        });
        throw error;
    }
    return {
        cwd: repo.toplevel,
        worktrees,
        baseCommit: repo.baseCommit,
    };
}
export function diffWorktrees(setup, agents, diffsDir) {
    try {
        fs.mkdirSync(diffsDir, { recursive: true });
    }
    catch {
        return [];
    }
    const diffs = [];
    for (let index = 0; index < setup.worktrees.length; index++) {
        const worktree = setup.worktrees[index];
        const agent = agents[index] ?? `task-${index + 1}`;
        const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
        try {
            diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
        }
        catch {
            writeEmptyPatch(patchPath);
            diffs.push(emptyDiff(index, agent, worktree.branch, patchPath));
        }
    }
    return diffs;
}
export function cleanupWorktrees(setup) {
    for (let index = setup.worktrees.length - 1; index >= 0; index--) {
        cleanupSingleWorktree(setup.cwd, setup.worktrees[index]);
    }
    try {
        runGitChecked(setup.cwd, ["worktree", "prune"]);
    }
    catch {
    }
}
export function formatWorktreeDiffSummary(diffs) {
    const changed = diffs.filter(hasWorktreeChanges);
    if (changed.length === 0)
        return "";
    const lines = ["=== Worktree Changes ===", ""];
    for (const diff of changed) {
        lines.push(`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`);
        if (diff.diffStat.trim().length > 0) {
            lines.push(diff.diffStat);
        }
        lines.push("");
    }
    const patchesDir = path.dirname(changed[0].patchPath);
    lines.push(`Full patches: ${patchesDir}`);
    return lines.join("\n").trimEnd();
}
