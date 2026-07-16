import { spawn } from "node:child_process";
import { parseGitStatusPorcelainV2 } from "./footer-git.js";
const DEFAULT_REFRESH_INTERVAL_MS = 8_000;
const DEFAULT_GIT_TIMEOUT_MS = 1_500;
const DEFAULT_GH_TIMEOUT_MS = 3_000;
const GIT_STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch"];
const GH_PR_VIEW_ARGS = ["pr", "view", "--json", "number,state,isDraft,url,title"];
function defaultRunner(command, args, options) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(command, [...args], {
                cwd: options.cwd,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
        }
        catch (error) {
            reject(error);
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            options.signal.removeEventListener("abort", onAbort);
            if (result instanceof Error) {
                reject(result);
            }
            else {
                resolve(result);
            }
        };
        const onAbort = () => {
            try {
                child.kill("SIGTERM");
            }
            catch {
                // Ignore: process may already be gone.
            }
            finish(new Error("aborted"));
        };
        // Attach child listeners before checking a pre-aborted signal so a
        // delayed ENOENT/close cannot escape as an uncaught exception that
        // would terminate the host Pi process. The `settled` guard inside
        // `finish()` makes any post-abort close/error a safe no-op.
        child.stdout?.on("data", (chunk) => {
            stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        child.on("error", (error) => {
            finish(error);
        });
        child.on("close", (code) => {
            finish({ stdout, stderr, exitCode: code });
        });
        if (options.signal.aborted) {
            onAbort();
            return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
    });
}
function defaultClock() {
    return {
        setInterval(callback, ms) {
            const handle = setInterval(callback, ms);
            handle.unref?.();
            return handle;
        },
        clearInterval(handle) {
            clearInterval(handle);
        },
    };
}
function parsePullRequestJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return undefined;
    }
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
    }
    const record = parsed;
    const snapshot = {};
    if (typeof record.number === "number" || typeof record.number === "string") {
        snapshot.number = record.number;
    }
    if (typeof record.state === "string") {
        snapshot.state = record.state;
    }
    if (typeof record.isDraft === "boolean") {
        snapshot.isDraft = record.isDraft;
    }
    if (typeof record.url === "string") {
        snapshot.url = record.url;
    }
    if (typeof record.title === "string") {
        snapshot.title = record.title;
    }
    return snapshot;
}
function gitStatusSnapshotsEqual(left, right) {
    return (left?.branch === right?.branch
        && left?.staged === right?.staged
        && left?.unstaged === right?.unstaged
        && left?.untracked === right?.untracked
        && left?.conflict === right?.conflict
        && left?.ahead === right?.ahead
        && left?.behind === right?.behind);
}
function pullRequestSnapshotsEqual(left, right) {
    return (left?.number === right?.number
        && left?.state === right?.state
        && left?.isDraft === right?.isDraft
        && left?.url === right?.url
        && left?.title === right?.title);
}
/**
 * Background cache for the TLH footer's git status and (best-effort) GitHub PR
 * metadata. Refreshes asynchronously and exposes synchronous snapshot getters
 * so footer `render()` never spawns subprocesses.
 */
export class FooterGitCache {
    cwd;
    runner;
    clock;
    refreshIntervalMs;
    gitTimeoutMs;
    ghTimeoutMs;
    onChange;
    intervalHandle;
    inflightControllers = new Set();
    disposed = false;
    refreshInFlight;
    branchChangeUnsubscribe;
    statusSnapshot;
    pullRequestSnapshot;
    lastSeenBranch;
    constructor(options) {
        this.cwd = options.cwd;
        this.runner = options.runner ?? defaultRunner;
        this.clock = options.clock ?? defaultClock();
        this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
        this.gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
        this.ghTimeoutMs = options.ghTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
        this.onChange = options.onChange;
        this.intervalHandle = this.clock.setInterval(() => {
            void this.refresh();
        }, this.refreshIntervalMs);
        if (!options.skipInitialRefresh) {
            void this.refresh();
        }
        // Subscribe to external branch-change notifications, if any. Each
        // callback invocation schedules a refresh; the existing in-flight
        // promise sharing automatically dedupes overlapping callbacks.
        if (options.onBranchChangeSource) {
            this.branchChangeUnsubscribe = options.onBranchChangeSource(() => {
                void this.refresh();
            });
        }
    }
    getStatusSnapshot() {
        return this.statusSnapshot;
    }
    getPullRequestSnapshot() {
        return this.pullRequestSnapshot;
    }
    /**
     * Trigger a refresh. Concurrent calls share the in-flight promise. Safe to
     * call after `dispose()` (resolves immediately as a no-op).
     */
    refresh() {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
        // Refresh is best-effort; swallow rejections at the cache boundary so
        // `void this.refresh()` callers (interval tick, branch-change, initial
        // kick) never produce unhandled rejections that could terminate the
        // host Pi process under Node's default unhandled-rejection policy.
        const run = this.runRefresh()
            .finally(() => {
            this.refreshInFlight = undefined;
        })
            .catch(() => undefined);
        this.refreshInFlight = run;
        return run;
    }
    async runRefresh() {
        const previousStatusSnapshot = this.statusSnapshot;
        const previousPullRequestSnapshot = this.pullRequestSnapshot;
        const result = await this.fetchGitStatus();
        if (this.disposed) {
            return;
        }
        if (result.kind === "transient") {
            // Timeout, spawn error, or exit-0-but-unparseable. Likely transient;
            // keep last-known snapshots and retry on the next tick.
            return;
        }
        if (result.kind === "not-a-repo") {
            // cwd is no longer inside a git worktree (e.g. user cd'd to /tmp).
            // Drop stale state so the footer renders just the path; otherwise the
            // 8s poll would never recover because exit 128 is persistent.
            this.statusSnapshot = undefined;
            this.pullRequestSnapshot = undefined;
            this.lastSeenBranch = undefined;
            this.emitChangeIfSnapshotsChanged(previousStatusSnapshot, previousPullRequestSnapshot);
            return;
        }
        const status = result.status;
        this.statusSnapshot = status;
        const branch = typeof status.branch === "string" ? status.branch : undefined;
        const isValidBranch = !!branch && branch !== "detached";
        const branchChanged = branch !== this.lastSeenBranch;
        if (branchChanged) {
            // Stale PR data belongs to the previous branch; clear it before
            // attempting a fresh lookup for the new branch.
            this.pullRequestSnapshot = undefined;
        }
        this.lastSeenBranch = branch;
        if (!isValidBranch) {
            this.pullRequestSnapshot = undefined;
            this.emitChangeIfSnapshotsChanged(previousStatusSnapshot, previousPullRequestSnapshot);
            return;
        }
        const pr = await this.fetchPullRequest();
        if (this.disposed) {
            return;
        }
        if (pr !== undefined) {
            this.pullRequestSnapshot = pr;
        }
        else if (branchChanged) {
            // Branch changed and PR lookup failed; leave snapshot cleared above.
            this.pullRequestSnapshot = undefined;
        }
        // Otherwise (same branch, gh failed): keep prior PR snapshot.
        this.emitChangeIfSnapshotsChanged(previousStatusSnapshot, previousPullRequestSnapshot);
    }
    emitChangeIfSnapshotsChanged(previousStatusSnapshot, previousPullRequestSnapshot) {
        if (this.disposed) {
            return;
        }
        if (gitStatusSnapshotsEqual(previousStatusSnapshot, this.statusSnapshot)
            && pullRequestSnapshotsEqual(previousPullRequestSnapshot, this.pullRequestSnapshot)) {
            return;
        }
        try {
            this.onChange?.();
        }
        catch {
            // Silent: rendering hooks must not break refreshes.
        }
    }
    // Three-way split so runRefresh can distinguish persistent "not a repo"
    // failures (cwd left the worktree, exit 128) from transient ones (timeout,
    // spawn error, or exit-0-but-unparseable). Collapsing them caused the
    // footer to keep showing the previous repo's branch/PR forever after cd'ing
    // out of a git directory.
    async fetchGitStatus() {
        const result = await this.runCommandSafely("git", GIT_STATUS_ARGS, this.gitTimeoutMs);
        if (!result) {
            return { kind: "transient" };
        }
        if (result.exitCode !== 0) {
            return { kind: "not-a-repo" };
        }
        const parsed = parseGitStatusPorcelainV2(result.stdout);
        if (!parsed) {
            return { kind: "transient" };
        }
        return { kind: "ok", status: parsed };
    }
    async fetchPullRequest() {
        const result = await this.runCommandSafely("gh", GH_PR_VIEW_ARGS, this.ghTimeoutMs);
        if (!result || result.exitCode !== 0) {
            return undefined;
        }
        return parsePullRequestJson(result.stdout);
    }
    async runCommandSafely(command, args, timeoutMs) {
        if (this.disposed) {
            return undefined;
        }
        const controller = new AbortController();
        this.inflightControllers.add(controller);
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, timeoutMs);
        try {
            return await this.runner(command, args, { cwd: this.cwd(), signal: controller.signal });
        }
        catch {
            // Silent: missing binary, abort, spawn error, non-zero stderr, etc.
            return undefined;
        }
        finally {
            clearTimeout(timeoutId);
            this.inflightControllers.delete(controller);
        }
    }
    /**
     * Stop background refreshes and cancel any in-flight subprocesses.
     * Idempotent. After disposal the snapshot getters keep returning the
     * last-known values but no further refreshes occur.
     */
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.intervalHandle !== undefined) {
            this.clock.clearInterval(this.intervalHandle);
            this.intervalHandle = undefined;
        }
        if (this.branchChangeUnsubscribe) {
            try {
                this.branchChangeUnsubscribe();
            }
            catch {
                // Ignore: a misbehaving notifier must not block disposal.
            }
            this.branchChangeUnsubscribe = undefined;
        }
        for (const controller of this.inflightControllers) {
            controller.abort();
        }
        this.inflightControllers.clear();
    }
}
