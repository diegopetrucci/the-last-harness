// Generated from scripts/lib/session-analysis-async-lineage.mts by scripts/runtime-typescript.mjs; edit the source, not this file.
/**
 * Async-run lineage helpers for session analysis.
 *
 * Async completions persist complete per-child machine records in
 * `details.childRecords` (epic contract C8); the bounded display `children` and
 * `sessionPaths` are never consulted for lineage.
 */
import { realpathSync } from "node:fs";
import { SUBAGENT_NOTIFY_TYPE } from "./subagent-analysis-parser.mjs";
/** Bound on child records read from one completion message. */
export const MAX_ASYNC_CHILD_RECORDS = 64;
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asyncCompletionRecords(entry, parse) {
    if (entry.customType !== SUBAGENT_NOTIFY_TYPE || !isObject(entry.details))
        return [];
    const details = entry.details;
    if (!Array.isArray(details.childRecords))
        return [];
    const fallbackRunId = parse.legacyId(details.asyncId);
    const records = [];
    for (const child of details.childRecords.slice(0, MAX_ASYNC_CHILD_RECORDS)) {
        if (!isObject(child))
            continue;
        const runId = parse.legacyId(child.runId) ?? fallbackRunId;
        const sessionFile = parse.path(child.sessionFile);
        if (runId === undefined || sessionFile === undefined)
            continue;
        const agent = parse.metadata(child.agent);
        const index = typeof child.index === "number" && Number.isInteger(child.index) && child.index >= 0
            ? child.index
            : undefined;
        records.push({
            runId,
            sessionFile,
            ...(agent !== undefined ? { agent } : {}),
            ...(index !== undefined ? { index } : {}),
        });
    }
    return records;
}
/** Resolve a child session header only after canonicalizing it beneath sessionsDir. */
export async function resolveChildSession(childSessionFile, sessionsDir, readHeader) {
    if (sessionsDir === undefined)
        return { childResolved: false };
    try {
        const realChild = realpathSync(childSessionFile);
        const realSessions = realpathSync(sessionsDir);
        if (!realChild.startsWith(realSessions + "/"))
            return { childResolved: false };
        const header = await readHeader(childSessionFile);
        if (header)
            return {
                childResolved: true,
                childSessionId: header.id,
                childStartedAt: header.timestamp,
            };
    }
    catch {
        // Keep unresolved on missing or unreadable child files.
    }
    return { childResolved: false };
}
