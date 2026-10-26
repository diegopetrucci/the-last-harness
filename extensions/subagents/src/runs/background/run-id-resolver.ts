import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../shared/types.ts";
import { findAsyncRunPrefixMatches, type AsyncRunLocation } from "./async-resume.ts";
import { assertSafeNestedId } from "../shared/nested-events.ts";

export type ResolvedSubagentRunId = { kind: "async"; id: string; location: AsyncRunLocation };

interface ResolveSubagentRunIdDeps {
  /** Caller scope for prefix matching: state.currentSessionId unless callerKey is given. */
  state?: Pick<SubagentState, "currentSessionId">;
  callerKey?: string;
  asyncDirRoot?: string;
  resultsDir?: string;
}

function exactAsyncLocation(
  id: string,
  asyncDirRoot: string,
  resultsDir: string,
): AsyncRunLocation | undefined {
  const asyncDir = path.join(asyncDirRoot, id);
  const resultPath = path.join(resultsDir, `${id}.json`);
  if (!fs.existsSync(asyncDir) && !fs.existsSync(resultPath)) return undefined;
  return {
    asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
    resultPath: fs.existsSync(resultPath) ? resultPath : null,
    resolvedId: id,
  };
}

export function resolveSubagentRunId(
  id: string,
  deps: ResolveSubagentRunIdDeps = {},
): ResolvedSubagentRunId | undefined {
  assertSafeNestedId("id", id);
  const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
  const resultsDir = deps.resultsDir ?? RESULTS_DIR;
  const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
  if (exactAsync) return { kind: "async", id, location: exactAsync };

  // Exact ids resolve unfiltered (action paths owner-check them); prefixes are
  // scoped to caller-owned runs before the ambiguity check.
  const callerKey = deps.callerKey ?? deps.state?.currentSessionId ?? undefined;
  const matches: ResolvedSubagentRunId[] = [];
  for (const match of findAsyncRunPrefixMatches(id, asyncDirRoot, resultsDir, callerKey)) {
    matches.push({ kind: "async", id: match.id, location: match.location });
  }
  const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
  const values = [...unique.values()];
  if (values.length > 1) {
    throw new Error(
      `Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`,
    );
  }
  return values[0];
}
