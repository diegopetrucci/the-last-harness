// Generated from extensions/subagents/src/runs/shared/session-record.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAtomicJsonWriter } from "../../shared/atomic-json.js";
import { parseContextUsageDiagnostics } from "../../shared/context-diagnostics.js";
import { acquireDirectoryLock, checkPidLiveness, LifecycleLockExhaustedError, } from "./lifecycle-state.js";
import { supportsOwnedProcessGroupCleanup } from "./process-group-cleanup.js";
export const SESSION_RECORD_SCHEMA_VERSION = 1;
const RECORD_SUFFIX = ".owner.json";
const RECORD_MODE = 0o600;
const writeRecordFile = createAtomicJsonWriter({
    fs: {
        mkdirSync: fs.mkdirSync,
        renameSync: fs.renameSync,
        rmSync: fs.rmSync,
        writeFileSync: (file, data) => fs.writeFileSync(file, data, { encoding: "utf-8", mode: RECORD_MODE }),
    },
});
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value) => isCount(value) && value > 0;
const isMs = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const toError = (error) => error instanceof Error ? error : new Error(String(error));
const errorCode = (error) => isObject(error) && typeof error.code === "string" ? error.code : undefined;
function resolveRecordFile(sessionFile) {
    try {
        if (fs.lstatSync(sessionFile, { throwIfNoEntry: false })?.isSymbolicLink()) {
            return {
                ok: false,
                failure: {
                    status: "unreadable",
                    error: new Error(`Session file is a symlink: ${sessionFile}`),
                },
            };
        }
        const parent = fs.realpathSync(path.dirname(path.resolve(sessionFile)));
        return { ok: true, file: path.join(parent, path.basename(sessionFile) + RECORD_SUFFIX) };
    }
    catch (error) {
        return {
            ok: false,
            failure: errorCode(error) === "ENOENT"
                ? { status: "missing" }
                : { status: "unreadable", error: toError(error) },
        };
    }
}
export function sessionRecordPath(sessionFile) {
    const resolved = resolveRecordFile(sessionFile);
    if (!resolved.ok) {
        throw resolved.failure.status === "unreadable"
            ? resolved.failure.error
            : new Error(`Session directory does not exist for ${sessionFile}`);
    }
    return resolved.file;
}
function parseLease(value) {
    if (!isObject(value))
        return undefined;
    const { token, runnerPid, processGroups, acquiredAt } = value;
    if (typeof token !== "string" || token.length === 0)
        return undefined;
    if (!isPositiveInt(runnerPid) || !isMs(acquiredAt))
        return undefined;
    if (!Array.isArray(processGroups) || !processGroups.every(isPositiveInt))
        return undefined;
    return { token, runnerPid, processGroups: [...processGroups], acquiredAt };
}
function parseRecord(value) {
    const corrupt = (reason) => ({ status: "corrupt", reason });
    if (!isObject(value))
        return corrupt("record is not an object");
    if (value.schemaVersion !== SESSION_RECORD_SCHEMA_VERSION) {
        return typeof value.schemaVersion === "number"
            ? { status: "wrong-schema", schemaVersion: value.schemaVersion }
            : corrupt("schemaVersion missing or not a number");
    }
    if (!isCount(value.generation))
        return corrupt("invalid generation");
    if (!isMs(value.activeRuntimeMs))
        return corrupt("invalid activeRuntimeMs");
    if (typeof value.retired !== "boolean")
        return corrupt("invalid retired flag");
    const record = {
        schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
        generation: value.generation,
        activeRuntimeMs: value.activeRuntimeMs,
        retired: value.retired,
    };
    if (value.retiredReason !== undefined) {
        if (typeof value.retiredReason !== "string")
            return corrupt("invalid retiredReason");
        record.retiredReason = value.retiredReason;
    }
    if (value.latestRunId !== undefined) {
        if (typeof value.latestRunId !== "string")
            return corrupt("invalid latestRunId");
        record.latestRunId = value.latestRunId;
    }
    if (value.contextUsage !== undefined) {
        const cu = value.contextUsage;
        const usage = isObject(cu) ? parseContextUsageDiagnostics(cu.usage) : undefined;
        if (!isObject(cu) || !isCount(cu.generation) || !usage)
            return corrupt("invalid contextUsage");
        record.contextUsage = { generation: cu.generation, usage };
    }
    if (value.cleanFinal !== undefined) {
        const cf = value.cleanFinal;
        if (!isObject(cf) || typeof cf.runId !== "string" || !isCount(cf.generation))
            return corrupt("invalid cleanFinal");
        record.cleanFinal = { runId: cf.runId, generation: cf.generation };
    }
    if (value.lease !== undefined) {
        const lease = parseLease(value.lease);
        if (!lease)
            return corrupt("invalid lease");
        record.lease = lease;
    }
    return record;
}
function readRecordFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, "utf-8");
    }
    catch (error) {
        return errorCode(error) === "ENOENT"
            ? { status: "missing" }
            : { status: "unreadable", error: toError(error) };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { status: "corrupt", reason: "invalid JSON" };
    }
    const result = parseRecord(parsed);
    return "status" in result ? result : { status: "ok", record: result };
}
export function readSessionRecord(sessionFile) {
    const resolved = resolveRecordFile(sessionFile);
    return resolved.ok ? readRecordFile(resolved.file) : resolved.failure;
}
function probeProcessGroup(pgid, kill) {
    try {
        kill(-pgid, 0);
        return "alive";
    }
    catch (error) {
        const code = errorCode(error);
        if (code === "ESRCH")
            return "dead";
        return code === "EPERM" ? "alive" : "unknown";
    }
}
export function isSessionLeaseStale(lease, deps = {}) {
    const kill = deps.kill ?? process.kill.bind(process);
    if (checkPidLiveness(lease.runnerPid, kill) !== "dead")
        return false;
    if (lease.processGroups.length === 0)
        return true;
    if (!supportsOwnedProcessGroupCleanup(deps.platform))
        return false;
    return lease.processGroups.every((pgid) => probeProcessGroup(pgid, kill) === "dead");
}
function withRecordLock(file, deps, operation) {
    let release;
    try {
        release = acquireDirectoryLock(`${file}.lock`, deps.lockOptions ?? {}, (held) => `Session record ${path.basename(file)} is locked (pid ${held.pid ?? "unknown"}).`);
    }
    catch (error) {
        if (error instanceof LifecycleLockExhaustedError)
            return { status: "busy" };
        return { status: "unreadable", error: toError(error) };
    }
    try {
        return operation();
    }
    finally {
        release();
    }
}
export function createSessionRecord(sessionFile, init = {}, deps = {}) {
    const resolved = resolveRecordFile(sessionFile);
    if (!resolved.ok) {
        return {
            status: "unreadable",
            error: resolved.failure.status === "unreadable"
                ? resolved.failure.error
                : new Error(`Session directory does not exist for ${sessionFile}`),
        };
    }
    const file = resolved.file;
    const result = withRecordLock(file, deps, () => {
        if (fs.existsSync(file))
            return { status: "exists" };
        if (init.requireSessionAbsent && fs.lstatSync(sessionFile, { throwIfNoEntry: false })) {
            return { status: "session-exists" };
        }
        const record = {
            schemaVersion: SESSION_RECORD_SCHEMA_VERSION,
            generation: 0,
            activeRuntimeMs: 0,
            retired: false,
            ...(init.latestRunId === undefined ? {} : { latestRunId: init.latestRunId }),
        };
        writeRecordFile(file, record);
        return { status: "created", record };
    });
    return result;
}
export function acquireSessionLease(sessionFile, holder, deps = {}) {
    const resolved = resolveRecordFile(sessionFile);
    if (!resolved.ok)
        return resolved.failure;
    const file = resolved.file;
    const result = withRecordLock(file, deps, () => {
        const read = readRecordFile(file);
        if (read.status !== "ok")
            return read;
        const { record } = read;
        if (record.retired) {
            return {
                status: "retired",
                ...(record.retiredReason ? { reason: record.retiredReason } : {}),
            };
        }
        if (record.lease) {
            return isSessionLeaseStale(record.lease, deps)
                ? { status: "abandoned", generation: record.generation, staleLease: record.lease }
                : { status: "held", holder: record.lease };
        }
        if (record.generation > 0 && record.cleanFinal?.generation !== record.generation) {
            return { status: "abandoned", generation: record.generation };
        }
        const token = randomUUID();
        const next = {
            ...record,
            generation: record.generation + 1,
            lease: {
                token,
                runnerPid: holder.runnerPid,
                processGroups: [...new Set(holder.processGroups ?? [])],
                acquiredAt: (deps.now ?? Date.now)(),
            },
        };
        delete next.cleanFinal;
        writeRecordFile(file, next);
        return { status: "acquired", handle: { token, generation: next.generation }, record: next };
    });
    return result;
}
function fencedMutate(sessionFile, handle, deps, mutate) {
    const resolved = resolveRecordFile(sessionFile);
    if (!resolved.ok)
        return resolved.failure;
    const file = resolved.file;
    const result = withRecordLock(file, deps, () => {
        const read = readRecordFile(file);
        if (read.status !== "ok")
            return read;
        const { record } = read;
        if (record.lease?.token !== handle.token || record.generation !== handle.generation) {
            return { status: "not-holder" };
        }
        const next = mutate(record);
        writeRecordFile(file, next);
        return { status: "ok", record: next };
    });
    return result;
}
export function updateSessionLease(sessionFile, handle, update, deps = {}) {
    return fencedMutate(sessionFile, handle, deps, (record) => {
        const lease = record.lease;
        const next = { ...record };
        if (update.activeRuntimeMs !== undefined && isMs(update.activeRuntimeMs)) {
            next.activeRuntimeMs = Math.max(record.activeRuntimeMs, update.activeRuntimeMs);
        }
        if (update.contextUsage !== undefined &&
            handle.generation >= (record.contextUsage?.generation ?? 0)) {
            next.contextUsage = { generation: handle.generation, usage: { ...update.contextUsage } };
        }
        if (update.latestRunId !== undefined)
            next.latestRunId = update.latestRunId;
        if (update.processGroups !== undefined) {
            next.lease = {
                ...lease,
                processGroups: [
                    ...new Set([...lease.processGroups, ...update.processGroups.filter(isPositiveInt)]),
                ],
            };
        }
        return next;
    });
}
export function markSessionCleanFinal(sessionFile, handle, runId, deps = {}) {
    return fencedMutate(sessionFile, handle, deps, (record) => ({
        ...record,
        latestRunId: runId,
        cleanFinal: { runId, generation: handle.generation },
    }));
}
export function retireSession(sessionFile, handle, reason, deps = {}) {
    return fencedMutate(sessionFile, handle, deps, (record) => ({
        ...record,
        retired: true,
        retiredReason: reason,
    }));
}
export function releaseSessionLease(sessionFile, handle, deps = {}) {
    return fencedMutate(sessionFile, handle, deps, (record) => {
        const next = { ...record };
        delete next.lease;
        return next;
    });
}
