// Generated from extensions/subagents/src/extension/runtime-cleanup.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { checkPidLiveness } from "../runs/background/stale-run-reconciler.js";
import { isResumableSessionCheckpoint } from "../runs/shared/session-admission.js";
import { recoverStoppedLifecycleOwnership } from "../runs/shared/lifecycle-state.js";
import { MAX_ASYNC_STATUS_BYTES } from "../shared/utils.js";
import { ASYNC_DIR } from "../shared/types.js";
const EMPTY_ASYNC_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_ASYNC_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PATHS = {
    asyncDir: ASYNC_DIR,
};
function listDirectoryEntries(dirPath, strict) {
    if (!fs.existsSync(dirPath))
        return [];
    try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory())
            throw new Error(`not a directory: ${dirPath}`);
        return fs.readdirSync(dirPath, { withFileTypes: true });
    }
    catch (error) {
        if (strict)
            throw error;
        return [];
    }
}
function listAsyncRunDirs(paths, strict) {
    const entries = [];
    for (const entry of listDirectoryEntries(paths.asyncDir, strict)) {
        if (!entry.isDirectory())
            continue;
        entries.push({ asyncDir: path.join(paths.asyncDir, entry.name) });
    }
    return entries;
}
const CLEANUP_OPEN_FLAGS = fs.constants.O_RDONLY |
    (fs.constants.O_NONBLOCK ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);
function readAsyncStatus(asyncDir) {
    const statusPath = path.join(asyncDir, "status.json");
    let fd;
    try {
        try {
            fd = fs.openSync(statusPath, CLEANUP_OPEN_FLAGS);
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT")
                return { status: null, invalid: false };
            return { status: null, invalid: true };
        }
        let stat;
        try {
            stat = fs.fstatSync(fd);
        }
        catch {
            return { status: null, invalid: true };
        }
        if (!stat.isFile())
            return { status: null, invalid: true };
        if (stat.size > MAX_ASYNC_STATUS_BYTES)
            return { status: null, invalid: true };
        let content;
        try {
            const chunks = [];
            let bytesRead = 0;
            const chunkSize = 64 * 1024;
            while (bytesRead <= MAX_ASYNC_STATUS_BYTES) {
                const remaining = MAX_ASYNC_STATUS_BYTES + 1 - bytesRead;
                const buffer = Buffer.allocUnsafe(Math.min(chunkSize, remaining));
                const n = fs.readSync(fd, buffer, 0, buffer.byteLength, null);
                if (n === 0)
                    break;
                chunks.push(buffer.subarray(0, n));
                bytesRead += n;
            }
            if (bytesRead > MAX_ASYNC_STATUS_BYTES)
                return { status: null, invalid: true };
            content = Buffer.concat(chunks, bytesRead).toString("utf-8");
        }
        catch {
            return { status: null, invalid: true };
        }
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            return { status: null, statusMtimeMs: stat.mtimeMs, invalid: true };
        }
        if (parsed === null) {
            return { status: null, statusMtimeMs: stat.mtimeMs, invalid: false };
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            return { status: null, statusMtimeMs: stat.mtimeMs, invalid: true };
        }
        return { status: parsed, statusMtimeMs: stat.mtimeMs, invalid: false };
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
function newestTreeMtimeMs(dirPath) {
    let newest;
    try {
        newest = fs.statSync(dirPath).mtimeMs;
    }
    catch {
        return 0;
    }
    for (const entry of listDirectoryEntries(dirPath, false)) {
        const childPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(newest, newestTreeMtimeMs(childPath));
            continue;
        }
        try {
            newest = Math.max(newest, fs.statSync(childPath).mtimeMs);
        }
        catch {
            continue;
        }
    }
    return newest;
}
function isSignalSafePid(pid) {
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}
function pidRetentionState(status, kill) {
    if (!isSignalSafePid(status.pid))
        return "ownerless";
    return checkPidLiveness(status.pid, kill);
}
function lifecycleTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function retentionReferenceMs(status, statusMtimeMs, dirMtimeMs) {
    return Math.max(dirMtimeMs, statusMtimeMs ?? 0, lifecycleTimestamp(status.endedAt), lifecycleTimestamp(status.lastUpdate), lifecycleTimestamp(status.startedAt));
}
function isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now) {
    return (now - retentionReferenceMs(status, statusMtimeMs, dirMtimeMs) < TERMINAL_ASYNC_DIR_MAX_AGE_MS);
}
function inspectKnownLifecycleState(status, statusMtimeMs, dirMtimeMs, now, kill) {
    switch (status.state) {
        case "complete":
        case "failed":
        case "cancelled":
        case "continued":
            return {
                keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
                activeOrLive: false,
            };
        case "paused":
            return { keep: true, activeOrLive: true };
        case "queued":
        case "running": {
            const pidState = pidRetentionState(status, kill);
            if (pidState === "alive" || pidState === "unknown") {
                return { keep: true, activeOrLive: true };
            }
            return {
                keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
                activeOrLive: false,
            };
        }
        case "pausing": {
            let pidState;
            if (isSignalSafePid(status.pid)) {
                try {
                    const recovered = recoverStoppedLifecycleOwnership(status, {
                        kill,
                        now: () => now,
                        isResumableSession: (file) => isResumableSessionCheckpoint(file, { kill }),
                    });
                    if (recovered.repaired) {
                        return { keep: true, activeOrLive: true };
                    }
                    pidState = recovered.pidLiveness ?? "ownerless";
                }
                catch {
                    pidState = pidRetentionState(status, kill);
                }
            }
            else {
                pidState = "ownerless";
            }
            if (pidState === "alive" || pidState === "unknown") {
                return { keep: true, activeOrLive: true };
            }
            return {
                keep: isWithinRetentionWindow(status, statusMtimeMs, dirMtimeMs, now),
                activeOrLive: false,
            };
        }
        default:
            return { keep: true, activeOrLive: false };
    }
}
function inspectAsyncDir(entry, now, kill) {
    const dirMtimeMs = newestTreeMtimeMs(entry.asyncDir);
    const { status, statusMtimeMs, invalid } = readAsyncStatus(entry.asyncDir);
    if (invalid) {
        return {
            entry,
            keep: true,
            activeOrLive: false,
        };
    }
    if (!status) {
        return {
            entry,
            keep: now - dirMtimeMs < EMPTY_ASYNC_DIR_MAX_AGE_MS,
            activeOrLive: false,
        };
    }
    return {
        entry,
        ...inspectKnownLifecycleState(status, statusMtimeMs, dirMtimeMs, now, kill),
    };
}
function removeDir(dirPath) {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        return true;
    }
    catch {
        return false;
    }
}
function resolvePaths(paths) {
    return {
        asyncDir: paths?.asyncDir ?? DEFAULT_PATHS.asyncDir,
    };
}
function inspectRuntimeDirsInternal(paths, now, kill, strict) {
    return listAsyncRunDirs(paths, strict).map((entry) => inspectAsyncDir(entry, now, kill));
}
export function inspectRuntimeDirs(paths, deps = {}) {
    const now = deps.now?.() ?? Date.now();
    const kill = deps.kill ?? process.kill;
    const resolvedPaths = resolvePaths(paths);
    const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, true);
    return {
        asyncDirs: inspection.length,
        retainedAsyncDirs: inspection.filter((entry) => entry.keep).length,
        activeOrLiveAsyncDirs: inspection.filter((entry) => entry.activeOrLive).length,
        staleAsyncDirs: inspection.filter((entry) => !entry.keep).length,
    };
}
export function cleanupRuntimeDirs(paths, deps = {}) {
    const now = deps.now?.() ?? Date.now();
    const kill = deps.kill ?? process.kill;
    const resolvedPaths = resolvePaths(paths);
    const inspection = inspectRuntimeDirsInternal(resolvedPaths, now, kill, false);
    let removedAsyncDirs = 0;
    for (const entry of inspection) {
        if (entry.keep)
            continue;
        const latest = inspectAsyncDir(entry.entry, now, kill);
        if (latest.keep)
            continue;
        if (!removeDir(entry.entry.asyncDir))
            continue;
        removedAsyncDirs += 1;
    }
    return { removedAsyncDirs };
}
