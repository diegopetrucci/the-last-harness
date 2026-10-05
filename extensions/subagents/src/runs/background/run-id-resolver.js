import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.js";
import { findAsyncRunPrefixMatches } from "./async-resume.js";
import { assertSafeNestedId } from "../shared/nested-events.js";
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
function foregroundIds(state) {
    if (!state)
        return [];
    return [
        ...new Set([...state.foregroundControls.keys(), ...(state.foregroundRuns?.keys() ?? [])]),
    ];
}
export function resolveSubagentRunId(id, deps = {}) {
    assertSafeNestedId("id", id);
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    if (deps.state?.foregroundControls.has(id) || deps.state?.foregroundRuns?.has(id))
        return { kind: "foreground", id };
    const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
    if (exactAsync)
        return { kind: "async", id, location: exactAsync };
    const matches = [];
    for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
        matches.push({ kind: "foreground", id: foregroundId });
    }
    for (const match of findAsyncRunPrefixMatches(id, asyncDirRoot, resultsDir)) {
        matches.push({ kind: "async", id: match.id, location: match.location });
    }
    const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
    const values = [...unique.values()];
    if (values.length > 1) {
        throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
    }
    return values[0];
}
