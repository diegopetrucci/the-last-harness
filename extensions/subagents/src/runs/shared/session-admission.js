// Generated from extensions/subagents/src/runs/shared/session-admission.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import { assessDurableResumeContext, formatDurableResumeContextBlock, } from "../../shared/context-diagnostics.js";
import { isSessionLeaseStale, readSessionRecord, } from "./session-record.js";
const FRESH_DISPATCH = "Inspect the partial work in the session and start a fresh dispatch instead of resuming it.";
export function describeSessionRefusal(refusal) {
    switch (refusal.kind) {
        case "retired":
            return `The session is retired${refusal.reason ? ` (${refusal.reason})` : ""}: its execution budget is permanently exhausted. ${FRESH_DISPATCH}`;
        case "held":
            return `The session is held by a live owner (runner pid ${refusal.runnerPid}). Wait for that run to finish, or interrupt the live owner, then retry. Do not start a second writer on the same session.`;
        case "abandoned":
            return `The session's last attempt did not finish cleanly and its owners are gone, so its state cannot be trusted. ${FRESH_DISPATCH}`;
        case "missing":
            return `The session has no ownership record (it was created before ownership records existed, or the record was deleted or moved). ${FRESH_DISPATCH}`;
        case "corrupt":
            return `The session's ownership record is corrupt (${refusal.reason}). ${FRESH_DISPATCH}`;
        case "unreadable":
            return `The session's ownership record cannot be read (${refusal.detail}). ${FRESH_DISPATCH}`;
        case "wrong-schema":
            return `The session's ownership record has an unsupported schema version. ${FRESH_DISPATCH}`;
        case "busy":
            return "The session's ownership record is busy. Retry shortly.";
    }
}
export function admitSessionForResume(sessionFile, deps = {}) {
    const read = readSessionRecord(sessionFile);
    switch (read.status) {
        case "missing":
            return { ok: false, refusal: { kind: "missing" } };
        case "corrupt":
            return { ok: false, refusal: { kind: "corrupt", reason: read.reason } };
        case "unreadable":
            return { ok: false, refusal: { kind: "unreadable", detail: read.error.message } };
        case "wrong-schema":
            return { ok: false, refusal: { kind: "wrong-schema" } };
        case "ok":
            break;
    }
    const { record } = read;
    if (record.retired) {
        return {
            ok: false,
            refusal: {
                kind: "retired",
                ...(record.retiredReason ? { reason: record.retiredReason } : {}),
            },
        };
    }
    if (record.lease) {
        return isSessionLeaseStale(record.lease, deps)
            ? { ok: false, refusal: { kind: "abandoned" } }
            : { ok: false, refusal: { kind: "held", runnerPid: record.lease.runnerPid } };
    }
    if (record.generation > 0 && record.cleanFinal?.generation !== record.generation) {
        return { ok: false, refusal: { kind: "abandoned" } };
    }
    return { ok: true, record };
}
export function isResumableSessionCheckpoint(sessionFile, deps = {}) {
    try {
        if (!fs.lstatSync(sessionFile, { throwIfNoEntry: false }))
            return false;
    }
    catch {
        return false;
    }
    return admitSessionForResume(sessionFile, deps).ok;
}
export function roleBudgetExhaustedMessage(agent, activeRuntimeMs) {
    return `Agent '${agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`;
}
export function durableContextBlockMessage(contextUsage, effectiveContextWindow) {
    const assessment = assessDurableResumeContext(contextUsage, effectiveContextWindow);
    return assessment.blocked ? formatDurableResumeContextBlock(assessment) : undefined;
}
