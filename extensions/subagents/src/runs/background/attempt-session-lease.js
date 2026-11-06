// Generated from extensions/subagents/src/runs/background/attempt-session-lease.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireSessionLease, createSessionRecord, markSessionCleanFinal, releaseSessionLease, retireSession, updateSessionLease, } from "../shared/session-record.js";
import { describeSessionRefusal } from "../shared/session-admission.js";
import { supportsOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.js";
const describeFailure = (result) => {
    switch (result.status) {
        case "not-holder":
            return "the session lease is no longer ours";
        case "busy":
            return "the session record is busy";
        case "unreadable":
            return `the session record is unreadable (${result.error.message})`;
        case "corrupt":
            return `the session record is corrupt (${result.reason})`;
        case "wrong-schema":
            return "the session record has an unsupported schema";
        case "missing":
            return "the session record is missing";
    }
};
function groupGone(pgid, deps) {
    const kill = deps.kill ?? process.kill.bind(process);
    try {
        kill(-pgid, 0);
        return false;
    }
    catch (error) {
        return error?.code === "ESRCH";
    }
}
export function openAttemptSessionLease(sessionFile, runId, deps = {}) {
    const refuse = (detail) => ({
        ok: false,
        error: `Refusing to launch child: ${detail}`,
    });
    const refuseWith = (refusal) => refuse(describeSessionRefusal(refusal));
    try {
        fs.mkdirSync(path.dirname(path.resolve(sessionFile)), { recursive: true });
    }
    catch (error) {
        return refuse(`cannot prepare the session directory (${error instanceof Error ? error.message : String(error)})`);
    }
    let present;
    try {
        present = fs.lstatSync(sessionFile, { throwIfNoEntry: false }) !== undefined;
    }
    catch (error) {
        return refuse(`cannot inspect the session file (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!present) {
        const created = createSessionRecord(sessionFile, { latestRunId: runId, requireSessionAbsent: true }, deps);
        if (created.status === "session-exists") {
            return refuseWith({ kind: "missing" });
        }
        if (created.status === "busy")
            return refuseWith({ kind: "busy" });
        if (created.status === "unreadable") {
            return refuse(`cannot create the session record (${created.error.message})`);
        }
    }
    const acquired = acquireSessionLease(sessionFile, { runnerPid: process.pid }, deps);
    switch (acquired.status) {
        case "acquired":
            return {
                ok: true,
                lease: createLease(sessionFile, runId, acquired.handle, deps),
                record: acquired.record,
            };
        case "held":
            return refuseWith({ kind: "held", runnerPid: acquired.holder.runnerPid });
        case "abandoned":
            return refuseWith({ kind: "abandoned" });
        case "retired":
            return refuseWith({ kind: "retired", reason: acquired.reason });
        case "busy":
            return refuseWith({ kind: "busy" });
        case "missing":
            return refuseWith({ kind: "missing" });
        case "corrupt":
            return refuseWith({ kind: "corrupt", reason: acquired.reason });
        case "unreadable":
            return refuseWith({ kind: "unreadable", detail: acquired.error.message });
        case "wrong-schema":
            return refuseWith({ kind: "wrong-schema" });
    }
}
function createLease(sessionFile, runId, handle, deps) {
    const recordedGroups = new Set();
    let released = false;
    const lease = {
        sessionFile,
        recordProcessGroup(processGroupId) {
            recordedGroups.add(processGroupId);
            const result = updateSessionLease(sessionFile, handle, { processGroups: [processGroupId], latestRunId: runId }, deps);
            if (result.status !== "ok")
                throw new Error(describeFailure(result));
        },
        checkpoint(progress) {
            try {
                updateSessionLease(sessionFile, handle, { ...progress, latestRunId: runId }, deps);
            }
            catch {
            }
        },
        finish(progress) {
            if (released)
                return { released: true };
            try {
                const { retireReason, ...evidence } = progress;
                const steps = [
                    () => updateSessionLease(sessionFile, handle, { ...evidence, latestRunId: runId }, deps),
                    ...(retireReason ? [() => retireSession(sessionFile, handle, retireReason, deps)] : []),
                ];
                for (const step of steps) {
                    const result = step();
                    if (result.status !== "ok")
                        return { released: false, reason: describeFailure(result) };
                }
                if (recordedGroups.size > 0 &&
                    (!supportsOwnedProcessGroupCleanup(deps.platform) ||
                        [...recordedGroups].some((pgid) => !groupGone(pgid, deps)))) {
                    return { released: false, reason: "a child process group is still running" };
                }
                for (const step of [
                    () => markSessionCleanFinal(sessionFile, handle, runId, deps),
                    () => releaseSessionLease(sessionFile, handle, deps),
                ]) {
                    const result = step();
                    if (result.status !== "ok")
                        return { released: false, reason: describeFailure(result) };
                }
                released = true;
                return { released: true };
            }
            catch (error) {
                return { released: false, reason: error instanceof Error ? error.message : String(error) };
            }
        },
    };
    return lease;
}
