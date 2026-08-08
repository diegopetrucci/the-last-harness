import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeAsyncLifecycleStatus } from "../shared/lifecycle-state.js";
import { validatePersistedAsyncStatus } from "./async-status.js";
import { fingerprintAsyncStatusContent } from "./async-status-corruption.js";
export const QUARANTINED_ASYNC_RUNS_DIRNAME = "quarantined-async-subagent-runs";
function isNotFoundError(error) {
    return (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
}
function snapshotStatus(stat) {
    return {
        ...(Number.isFinite(stat.dev) ? { dev: stat.dev } : {}),
        ...(Number.isFinite(stat.ino) ? { ino: stat.ino } : {}),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
    };
}
function sameSnapshot(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs);
}
function confirmCorruption(issue, content) {
    if (issue.kind === "json_parse") {
        try {
            JSON.parse(content);
            return "repaired";
        }
        catch {
            return "confirmed";
        }
    }
    let parsed;
    try {
        parsed = normalizeAsyncLifecycleStatus(JSON.parse(content));
    }
    catch {
        return "changed";
    }
    try {
        validatePersistedAsyncStatus(issue.asyncDir, parsed);
        return "repaired";
    }
    catch {
        return "confirmed";
    }
}
function buildQuarantinePath(asyncDirRoot, entry, suffix) {
    return path.join(path.dirname(asyncDirRoot), QUARANTINED_ASYNC_RUNS_DIRNAME, `${entry}.${suffix}`);
}
function buildDedupeKey(issue, reason) {
    return `${issue.entry}\u0000${issue.fingerprint?.value ?? "missing-fingerprint"}\u0000${reason}`;
}
function isValidFingerprint(issue) {
    return issue.fingerprint?.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(issue.fingerprint.value);
}
function validateIssuePaths(asyncDirRoot, issue) {
    const resolvedRoot = path.resolve(asyncDirRoot);
    if (!issue.entry || issue.entry !== path.basename(issue.entry))
        return false;
    const expectedAsyncDir = path.resolve(asyncDirRoot, issue.entry);
    const expectedStatusPath = path.resolve(expectedAsyncDir, "status.json");
    const asyncDirWithinRoot = path.relative(resolvedRoot, expectedAsyncDir);
    if (asyncDirWithinRoot === "" || asyncDirWithinRoot.startsWith("..") || path.isAbsolute(asyncDirWithinRoot))
        return false;
    return path.resolve(issue.asyncDir) === expectedAsyncDir && path.resolve(issue.statusPath) === expectedStatusPath;
}
export function quarantineCorruptAsyncRun(asyncDirRoot, issue, options = {}) {
    const fsApi = options.fs ?? fs;
    const now = options.now ?? Date.now;
    const createUniqueSuffix = options.createUniqueSuffix ?? (() => `${now()}-${Math.random().toString(36).slice(2, 8)}`);
    if (!isValidFingerprint(issue)) {
        return {
            outcome: "deferred",
            reason: "missing_fingerprint",
            kind: issue.kind,
            dedupeKey: buildDedupeKey(issue, "missing_fingerprint"),
        };
    }
    if (!validateIssuePaths(asyncDirRoot, issue)) {
        return {
            outcome: "failed",
            reason: "invalid_path",
            kind: issue.kind,
            dedupeKey: buildDedupeKey(issue, "invalid_path"),
        };
    }
    let before;
    try {
        before = snapshotStatus(fsApi.statSync(issue.statusPath));
    }
    catch (error) {
        if (isNotFoundError(error))
            return { outcome: "skipped", reason: "missing", kind: issue.kind };
        return { outcome: "failed", reason: "stat", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "stat") };
    }
    let content;
    try {
        content = fsApi.readFileSync(issue.statusPath, "utf-8");
    }
    catch (error) {
        if (isNotFoundError(error))
            return { outcome: "skipped", reason: "missing", kind: issue.kind };
        return { outcome: "failed", reason: "read", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "read") };
    }
    let after;
    try {
        after = snapshotStatus(fsApi.statSync(issue.statusPath));
    }
    catch (error) {
        if (isNotFoundError(error))
            return { outcome: "skipped", reason: "missing", kind: issue.kind };
        return { outcome: "failed", reason: "stat", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "stat") };
    }
    if (!sameSnapshot(before, after))
        return { outcome: "deferred", reason: "unstable", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "unstable") };
    const fingerprint = fingerprintAsyncStatusContent(content);
    if (fingerprint.value !== issue.fingerprint.value)
        return { outcome: "deferred", reason: "changed", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "changed") };
    const confirmation = confirmCorruption(issue, content);
    if (confirmation === "repaired")
        return { outcome: "skipped", reason: "repaired", kind: issue.kind };
    if (confirmation === "changed")
        return { outcome: "deferred", reason: "changed", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "changed") };
    const quarantineDir = buildQuarantinePath(asyncDirRoot, issue.entry, createUniqueSuffix());
    try {
        fsApi.mkdirSync(path.dirname(quarantineDir), { recursive: true });
    }
    catch {
        return { outcome: "failed", reason: "mkdir", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "mkdir") };
    }
    try {
        fsApi.renameSync(issue.asyncDir, quarantineDir);
    }
    catch (error) {
        if (isNotFoundError(error))
            return { outcome: "skipped", reason: "missing", kind: issue.kind };
        return { outcome: "failed", reason: "rename", kind: issue.kind, dedupeKey: buildDedupeKey(issue, "rename") };
    }
    return { outcome: "quarantined", kind: issue.kind, quarantineDir };
}
