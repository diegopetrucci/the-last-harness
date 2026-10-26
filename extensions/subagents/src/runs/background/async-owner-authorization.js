// Generated from extensions/subagents/src/runs/background/async-owner-authorization.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as path from "node:path";
import { readStatus } from "../../shared/utils.js";
import { RESULTS_DIR } from "../../shared/types.js";
import { readPersistedResultEvidence, resolvePersistedOwner } from "./async-resume.js";
export function isOwnedByCaller(owner, callerKey) {
    return (typeof callerKey === "string" &&
        callerKey.length > 0 &&
        typeof owner === "string" &&
        owner === callerKey);
}
export function authorizeAsyncRunOwner(input) {
    const { callerKey, asyncDir, resultPath, status: suppliedStatus } = input;
    const resultsDir = input.resultsDir ?? RESULTS_DIR;
    if (typeof callerKey !== "string" || callerKey.length === 0)
        return { outcome: "unverifiable", reason: "no-caller-key" };
    const ids = [];
    if (input.runId !== undefined)
        ids.push(input.runId);
    if (asyncDir !== undefined)
        ids.push(path.basename(path.resolve(asyncDir)));
    if (resultPath !== undefined) {
        const resolved = path.resolve(resultPath);
        if (path.dirname(resolved) !== path.resolve(resultsDir) || !resolved.endsWith(".json"))
            return { outcome: "unverifiable", reason: "identity-mismatch" };
        ids.push(path.basename(resolved, ".json"));
    }
    const runId = ids[0];
    if (runId === undefined || runId.trim() === "")
        return { outcome: "unverifiable", reason: "no-run-identity" };
    if (ids.some((id) => id !== runId))
        return { outcome: "unverifiable", reason: "identity-mismatch", runId };
    let status = suppliedStatus;
    if (status === undefined && asyncDir !== undefined) {
        try {
            status = readStatus(asyncDir, { cache: false });
        }
        catch {
            return { outcome: "unverifiable", reason: "status-unreadable", runId };
        }
    }
    if (status && status.runId !== runId)
        return { outcome: "unverifiable", reason: "identity-mismatch", runId };
    const resultEvidence = readPersistedResultEvidence(resultsDir, runId);
    if (resultEvidence.identityMismatch)
        return { outcome: "unverifiable", reason: "identity-mismatch", runId };
    const owner = resolvePersistedOwner(status?.sessionId, resultEvidence.owner);
    if (owner === undefined)
        return { outcome: "unverifiable", reason: "owner-evidence-missing-or-invalid", runId };
    return isOwnedByCaller(owner, callerKey)
        ? { outcome: "owned", runId, owner }
        : { outcome: "foreign", runId, owner };
}
export function asyncRunOwnerRejectionMessage(authorization, runId, verb) {
    return authorization.outcome === "foreign"
        ? `Async run '${runId}' is owned by another session and cannot be ${verb} from this session.`
        : `Async run '${runId}' ownership cannot be verified; it cannot be ${verb} from this session.`;
}
