// Generated from extensions/subagents/src/runs/background/run-id-resolver.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.js";
import { findAsyncRunPrefixMatches } from "./async-resume.js";
function isSafeRunId(value) {
    return (typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        !path.isAbsolute(value) &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes(".."));
}
function assertSafeRunId(label, value) {
    if (!isSafeRunId(value))
        throw new Error(`${label} must be a non-empty safe id token.`);
}
function exactAsyncLocation(id, asyncDirRoot, resultsDir) {
    const asyncDir = path.join(asyncDirRoot, id);
    const resultPath = path.join(resultsDir, `${id}.json`);
    if (!fs.existsSync(asyncDir) && !fs.existsSync(resultPath))
        return undefined;
    return {
        asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
        resultPath: fs.existsSync(resultPath) ? resultPath : null,
        resolvedId: id,
    };
}
export function resolveSubagentRunId(id, deps = {}) {
    assertSafeRunId("id", id);
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
    if (exactAsync)
        return { kind: "async", id, location: exactAsync };
    const callerKey = deps.callerKey ?? deps.state?.currentSessionId ?? undefined;
    const matches = [];
    for (const match of findAsyncRunPrefixMatches(id, asyncDirRoot, resultsDir, callerKey)) {
        matches.push({ kind: "async", id: match.id, location: match.location });
    }
    const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
    const values = [...unique.values()];
    if (values.length > 1) {
        throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
    }
    return values[0];
}
