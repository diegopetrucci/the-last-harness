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
            }
            finish(new Error("aborted"));
        };
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
    refresh() {
        if (this.disposed) {
            return Promise.resolve();
        }
        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }
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
            return;
        }
        if (result.kind === "not-a-repo") {
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
            this.pullRequestSnapshot = undefined;
        }
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
        }
    }
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
            return undefined;
        }
        finally {
            clearTimeout(timeoutId);
            this.inflightControllers.delete(controller);
        }
    }
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
            }
            this.branchChangeUnsubscribe = undefined;
        }
        for (const controller of this.inflightControllers) {
            controller.abort();
        }
        this.inflightControllers.clear();
    }
}
