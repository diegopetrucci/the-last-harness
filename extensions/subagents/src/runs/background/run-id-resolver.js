import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.js";
import { findAsyncRunPrefixMatches } from "./async-resume.js";
import { assertSafeNestedId, findNestedRunMatchesById } from "../shared/nested-events.js";
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
    return [...new Set([...state.foregroundControls.keys(), ...(state.foregroundRuns?.keys() ?? [])])];
}
function nestedScopeFromState(state) {
    if (!state)
        return undefined;
    const routes = [];
    const seen = new Set();
    const add = (route) => {
        if (!route)
            return;
        const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
        if (seen.has(key))
            return;
        seen.add(key);
        routes.push(route);
    };
    for (const control of state.foregroundControls.values())
        add(control.nestedRoute);
    for (const job of state.asyncJobs.values())
        add(job.nestedRoute);
    return { routes };
}
function asyncPrefixMatches(prefix, asyncDirRoot, resultsDir) {
    return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir);
}
export function resolveSubagentRunId(id, deps = {}) {
    assertSafeNestedId("id", id);
    const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
    const resultsDir = deps.resultsDir ?? RESULTS_DIR;
    const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
    if (deps.state?.foregroundControls.has(id) || deps.state?.foregroundRuns?.has(id))
        return { kind: "foreground", id };
    const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
    if (exactAsync)
        return { kind: "async", id, location: exactAsync };
    const exactNested = findNestedRunMatchesById(id, nestedScope ? { scope: nestedScope } : {});
    if (exactNested.length > 1)
        throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
    if (exactNested[0])
        return { kind: "nested", id, match: exactNested[0] };
    const matches = [];
    for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
        matches.push({ kind: "foreground", id: foregroundId });
    }
    for (const match of asyncPrefixMatches(id, asyncDirRoot, resultsDir)) {
        matches.push({ kind: "async", id: match.id, location: match.location });
    }
    for (const match of findNestedRunMatchesById(id, nestedScope ? { prefix: true, scope: nestedScope } : { prefix: true })) {
        matches.push({ kind: "nested", id: match.run.id, match });
    }
    const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
    const values = [...unique.values()];
    if (values.length > 1) {
        throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
    }
    return values[0];
}
