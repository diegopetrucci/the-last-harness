import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function stateWithForeground(id: string): SubagentState {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map([[id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 }]]),
    lastForegroundControlId: id,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear: () => {} },
  };
}

describe("subagent run id resolver", () => {
  it("prefers an exact foreground run before async prefix lookup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-id-resolver-"));
    tempRoots.push(root);
    const asyncRoot = path.join(root, "runs");
    const resultsDir = path.join(root, "results");
    fs.mkdirSync(path.join(asyncRoot, "shared-id"), { recursive: true });

    assert.equal(
      resolveSubagentRunId("shared-id", {
        state: stateWithForeground("shared-id"),
        asyncDirRoot: asyncRoot,
        resultsDir,
      })?.kind,
      "foreground",
    );
    assert.equal(
      resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir })?.kind,
      "async",
    );
  });

  it("reports ambiguity for async id prefixes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-id-ambiguous-"));
    tempRoots.push(root);
    const asyncRoot = path.join(root, "runs");
    const resultsDir = path.join(root, "results");
    fs.mkdirSync(path.join(asyncRoot, "dupe-one"), { recursive: true });
    fs.mkdirSync(path.join(asyncRoot, "dupe-two"), { recursive: true });

    assert.throws(
      () => resolveSubagentRunId("dupe", { asyncDirRoot: asyncRoot, resultsDir }),
      /Ambiguous subagent run id prefix 'dupe' matched: async:dupe-one, async:dupe-two/,
    );
  });

  it("rejects unsafe id tokens before lookup", () => {
    assert.throws(() => resolveSubagentRunId("../run"), /safe id token/);
    assert.throws(() => resolveSubagentRunId("a/b"), /safe id token/);
    assert.throws(() => resolveSubagentRunId(""), /safe id token/);
  });
});
