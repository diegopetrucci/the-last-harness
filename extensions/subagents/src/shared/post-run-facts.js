import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_ATTRIBUTION_STATUS_BYTES, boundSubagentAttemptFacts } from "./terminal-result.js";
import { checkPidLiveness as defaultCheckPidLiveness, } from "../runs/shared/lifecycle-state.js";
export { MAX_ATTRIBUTION_STATUS_BYTES };
const MAX_GIT_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_GIT_PROCESS_OUTPUT_BYTES = MAX_GIT_COMMAND_OUTPUT_BYTES * 4;
const GIT_COMMAND_TIMEOUT_MS = 2_000;
const MAX_ATTRIBUTION_STATUS_FILES = 2048;
export const MAX_ATTRIBUTION_LIVE_STATUS_AGE_MS = 60_000;
const EMPTY_TOOL_CALLS = { edit: 0, write: 0, bash: 0 };
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function runGitCommand(cwd, args) {
    try {
        const result = spawnSync("git", args, {
            cwd,
            encoding: "buffer",
            timeout: GIT_COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_GIT_PROCESS_OUTPUT_BYTES,
            windowsHide: true,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        });
        return {
            status: result.status,
            stdout: result.stdout ?? Buffer.alloc(0),
            stderr: result.stderr ?? Buffer.alloc(0),
            failed: Boolean(result.error),
        };
    }
    catch {
        return { status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), failed: true };
    }
}
function isNotGitRepository(result) {
    if (result.status !== 128 || result.failed)
        return false;
    const diagnostic = Buffer.concat([result.stderr, result.stdout]).toString("utf-8");
    return /not a git repository|not a git repo/i.test(diagnostic);
}
function unavailableSnapshot(reason) {
    return { status: "unavailable", reason };
}
function boundedUtf8(value, maxBytes = MAX_GIT_COMMAND_OUTPUT_BYTES) {
    let bounded = value.subarray(0, maxBytes).toString("utf-8");
    while (Buffer.byteLength(bounded, "utf-8") > maxBytes)
        bounded = bounded.slice(0, -1);
    return bounded;
}
function boundPorcelainZ(value) {
    const records = [];
    let start = 0;
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0)
            continue;
        const record = value.subarray(start, index).toString("utf-8");
        const recordBytes = Buffer.byteLength(record, "utf-8") + 1;
        if (bytes + recordBytes > MAX_GIT_COMMAND_OUTPUT_BYTES)
            break;
        records.push(record);
        bytes += recordBytes;
        start = index + 1;
    }
    return records.length > 0 ? `${records.join("\0")}\0` : "";
}
function boundText(value) {
    return boundedUtf8(value);
}
export function captureGitWorkspaceSnapshot(cwd) {
    const status = runGitCommand(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    if (status.failed || status.status !== 0) {
        return unavailableSnapshot(isNotGitRepository(status) ? "not_git_repository" : "command_failed");
    }
    const worktreeDiff = runGitCommand(cwd, ["diff", "--stat"]);
    const indexDiff = runGitCommand(cwd, ["diff", "--cached", "--stat"]);
    if (worktreeDiff.failed ||
        worktreeDiff.status !== 0 ||
        indexDiff.failed ||
        indexDiff.status !== 0) {
        return unavailableSnapshot("command_failed");
    }
    return {
        status: "available",
        statusPorcelainZ: boundPorcelainZ(status.stdout),
        worktreeDiffStat: boundText(worktreeDiff.stdout),
        indexDiffStat: boundText(indexDiff.stdout),
    };
}
function canonicalizeWorkspaceCwd(cwd) {
    if (typeof cwd !== "string" || cwd.trim() === "")
        return undefined;
    try {
        const resolved = fs.realpathSync.native(cwd);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    }
    catch {
        try {
            const resolved = path.resolve(cwd);
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        }
        catch {
            return undefined;
        }
    }
}
function finiteTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function readBoundedStatus(statusPath) {
    let stat;
    try {
        stat = fs.statSync(statusPath);
    }
    catch {
        return null;
    }
    if (!stat.isFile())
        return null;
    if (stat.size > MAX_ATTRIBUTION_STATUS_BYTES)
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function statusFileCandidates(root, ownDir) {
    try {
        const own = path.resolve(ownDir);
        const files = [];
        let enumerationIncomplete = false;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const asyncDir = path.resolve(root, entry.name);
            const statusPath = path.join(asyncDir, "status.json");
            try {
                const stat = fs.statSync(statusPath);
                if (!stat.isFile())
                    continue;
                files.push({
                    path: statusPath,
                    asyncDir,
                    mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
                });
            }
            catch (error) {
                const code = error?.code;
                if (code !== "ENOENT" && code !== "ENOTDIR") {
                    enumerationIncomplete = true;
                }
            }
        }
        files.sort((left, right) => (left.asyncDir === own ? 0 : 1) - (right.asyncDir === own ? 0 : 1) ||
            right.mtimeMs - left.mtimeMs ||
            left.asyncDir.localeCompare(right.asyncDir));
        const truncated = files.length > MAX_ATTRIBUTION_STATUS_FILES;
        return {
            files: files.slice(0, MAX_ATTRIBUTION_STATUS_FILES),
            truncated: truncated || enumerationIncomplete,
        };
    }
    catch {
        return { files: [], truncated: true };
    }
}
function statusIsLive(status) {
    return status === "running" || status === "pausing" || status === "queued";
}
function safePid(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function latestObservedTimestamp(start, ...values) {
    let latest = start;
    for (const value of values) {
        if (value === undefined || value === null)
            continue;
        const timestamp = finiteTimestamp(value);
        if (timestamp === undefined)
            return undefined;
        latest = Math.max(latest, timestamp);
    }
    return latest;
}
function buildStatusInterval(canonicalCwd, start, end, stepIndex) {
    if (end < start)
        return undefined;
    return {
        cwd: canonicalCwd,
        startedAt: start,
        endedAt: end,
        ...(stepIndex !== undefined ? { stepIndex } : {}),
    };
}
function intervalForValues(input) {
    if (typeof input.cwd !== "string")
        return { uncertain: false };
    const canonicalCwd = canonicalizeWorkspaceCwd(input.cwd);
    const start = finiteTimestamp(input.startedAt);
    if (!canonicalCwd || start === undefined)
        return { uncertain: false };
    const explicitEnd = finiteTimestamp(input.endedAt);
    if (input.endedAt !== undefined && input.endedAt !== null && explicitEnd === undefined)
        return { uncertain: statusIsLive(input.state) };
    if (explicitEnd !== undefined) {
        return {
            interval: buildStatusInterval(canonicalCwd, start, explicitEnd, input.stepIndex),
            uncertain: false,
        };
    }
    if (!statusIsLive(input.state))
        return { uncertain: false };
    const observedEnd = latestObservedTimestamp(start, input.lastUpdate, input.lastActivityAt);
    if (observedEnd === undefined || observedEnd > input.now)
        return { uncertain: true };
    const pid = safePid(input.pid);
    if (pid === undefined)
        return { uncertain: true };
    let liveness;
    try {
        liveness = input.checkPidLiveness(pid);
    }
    catch {
        return { uncertain: true };
    }
    if (liveness !== "alive" && liveness !== "dead")
        return { uncertain: true };
    if (liveness === "dead") {
        return {
            interval: buildStatusInterval(canonicalCwd, start, observedEnd, input.stepIndex),
            uncertain: false,
        };
    }
    const hasHeartbeat = (input.lastUpdate !== undefined && input.lastUpdate !== null) ||
        (input.lastActivityAt !== undefined && input.lastActivityAt !== null);
    const age = input.now - observedEnd;
    if (!hasHeartbeat || age < 0 || age > input.liveStatusFreshnessMs)
        return { uncertain: true };
    return {
        interval: buildStatusInterval(canonicalCwd, start, input.now, input.stepIndex),
        uncertain: false,
    };
}
function statusIntervals(status, now, skipStepIndex, options) {
    const intervals = [];
    let uncertain = false;
    if (Array.isArray(status.steps)) {
        for (const [stepIndex, value] of status.steps.entries()) {
            if (skipStepIndex !== undefined && stepIndex === skipStepIndex)
                continue;
            if (!isRecord(value)) {
                uncertain = true;
                continue;
            }
            const resolution = intervalForValues({
                cwd: value.cwd ?? status.cwd,
                startedAt: value.startedAt,
                endedAt: value.endedAt,
                state: value.status ?? value.state,
                pid: value.pid ?? status.pid,
                lastUpdate: value.lastUpdate ?? status.lastUpdate,
                lastActivityAt: value.lastActivityAt ?? status.lastActivityAt,
                now,
                stepIndex,
                checkPidLiveness: options.checkPidLiveness,
                liveStatusFreshnessMs: options.liveStatusFreshnessMs,
            });
            if (resolution.interval)
                intervals.push(resolution.interval);
            uncertain ||= resolution.uncertain;
        }
        if (intervals.length > 0 || options.allowRunFallback !== true)
            return { intervals, uncertain };
    }
    if (options.allowRunFallback !== true)
        return { intervals, uncertain };
    const fallback = intervalForValues({
        cwd: status.cwd,
        startedAt: status.startedAt,
        endedAt: status.endedAt,
        state: status.state,
        pid: status.pid,
        lastUpdate: status.lastUpdate,
        lastActivityAt: status.lastActivityAt,
        now,
        checkPidLiveness: options.checkPidLiveness,
        liveStatusFreshnessMs: options.liveStatusFreshnessMs,
    });
    if (fallback.interval)
        intervals.push(fallback.interval);
    return { intervals, uncertain: uncertain || fallback.uncertain };
}
function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    return leftStart <= rightEnd && rightStart <= leftEnd;
}
function hasOverlappingPersistedWorkspaceRun(input) {
    const ownAsyncDir = input.asyncDir;
    if (!ownAsyncDir)
        return { overlap: false, uncertain: true };
    const root = path.dirname(path.resolve(ownAsyncDir));
    const targetCwd = canonicalizeWorkspaceCwd(input.cwd);
    if (!targetCwd)
        return { overlap: false, uncertain: true };
    const now = input.now ?? Date.now();
    if (finiteTimestamp(now) === undefined)
        return { overlap: false, uncertain: true };
    const currentStart = finiteTimestamp(input.startedAt);
    const currentEnd = finiteTimestamp(input.endedAt);
    if (currentStart === undefined || currentEnd === undefined || currentEnd < currentStart)
        return { overlap: false, uncertain: true };
    const candidates = statusFileCandidates(root, ownAsyncDir);
    const checkPidLiveness = input.checkPidLiveness ?? defaultCheckPidLiveness;
    const liveStatusFreshnessMs = input.liveStatusFreshnessMs ?? MAX_ATTRIBUTION_LIVE_STATUS_AGE_MS;
    if (!Number.isFinite(liveStatusFreshnessMs) || liveStatusFreshnessMs < 0)
        return { overlap: false, uncertain: true };
    let uncertain = candidates.truncated;
    for (const candidate of candidates.files) {
        const isOwnRun = path.resolve(candidate.asyncDir) === path.resolve(ownAsyncDir);
        if (isOwnRun && input.stepIndex === undefined)
            continue;
        const status = readBoundedStatus(candidate.path);
        if (status === null)
            continue;
        if (status === undefined) {
            uncertain = true;
            continue;
        }
        const intervalResult = statusIntervals(status, now, isOwnRun ? input.stepIndex : undefined, {
            allowRunFallback: !isOwnRun,
            checkPidLiveness,
            liveStatusFreshnessMs,
        });
        uncertain ||= intervalResult.uncertain;
        for (const interval of intervalResult.intervals) {
            if (interval.cwd === targetCwd &&
                intervalsOverlap(currentStart, currentEnd, interval.startedAt, interval.endedAt)) {
                return { overlap: true, uncertain: false };
            }
        }
    }
    return { overlap: false, uncertain };
}
export function classifyWorkspaceAttribution(input) {
    if (input.baseline.status !== "available" || input.post.status !== "available")
        return "unknown";
    const overlap = hasOverlappingPersistedWorkspaceRun(input);
    if (overlap.overlap)
        return "shared";
    return overlap.uncertain ? "unknown" : "exclusive";
}
function safeNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
export function providerTokensFromUsage(usage) {
    const input = safeNonNegativeInteger(usage?.input);
    const output = safeNonNegativeInteger(usage?.output);
    if (input === undefined || output === undefined || input > Number.MAX_SAFE_INTEGER - output)
        return { status: "unavailable" };
    return { status: "available", usage: { input, output, total: input + output } };
}
export function captureSubagentAttemptFacts(input) {
    const post = captureGitWorkspaceSnapshot(input.cwd);
    const requestedToolCalls = input.requestedToolCalls ?? EMPTY_TOOL_CALLS;
    const durationMs = Math.max(0, input.durationMs ?? input.endedAt - input.startedAt);
    const attempt = {
        attempt: input.attempt,
        exit: { code: input.exitCode, signal: input.exitSignal ?? null },
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        providerTokens: input.providerTokens.status === "available"
            ? { status: "available", usage: { ...input.providerTokens.usage } }
            : { status: "unavailable" },
        requestedToolCalls: {
            edit: requestedToolCalls.edit,
            write: requestedToolCalls.write,
            bash: requestedToolCalls.bash,
        },
        workspace: {
            baseline: { ...input.baseline },
            post: { ...post },
            attribution: classifyWorkspaceAttribution({
                cwd: input.cwd,
                startedAt: input.startedAt,
                endedAt: input.endedAt,
                baseline: input.baseline,
                post,
                asyncDir: input.asyncDir,
                stepIndex: input.stepIndex,
                now: input.now,
                checkPidLiveness: input.checkPidLiveness,
                liveStatusFreshnessMs: input.liveStatusFreshnessMs,
            }),
        },
    };
    return boundSubagentAttemptFacts([attempt])[0];
}
