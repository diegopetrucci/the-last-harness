import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";

const tempRoots: string[] = [];

function seedRun(asyncRoot: string, runId: string, sessionId: string | undefined): void {
  fs.mkdirSync(path.join(asyncRoot, runId), { recursive: true });
  fs.writeFileSync(
    path.join(asyncRoot, runId, "status.json"),
    JSON.stringify({
      runId,
      mode: "single",
      state: "running",
      startedAt: 1,
      ...(sessionId ? { sessionId } : {}),
    }),
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe("subagent run id resolver", () => {
  it("resolves an exact async run id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-id-resolver-"));
    tempRoots.push(root);
    const asyncRoot = path.join(root, "runs");
    const resultsDir = path.join(root, "results");
    fs.mkdirSync(path.join(asyncRoot, "shared-id"), { recursive: true });

    const resolved = resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir });
    assert.equal(resolved?.kind, "async");
  });

  it("reports ambiguity for async id prefixes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-id-ambiguous-"));
    tempRoots.push(root);
    const asyncRoot = path.join(root, "runs");
    const resultsDir = path.join(root, "results");
    seedRun(asyncRoot, "dupe-one", "me");
    seedRun(asyncRoot, "dupe-two", "me");
    seedRun(asyncRoot, "dupe-three", "other");

    assert.throws(
      () => resolveSubagentRunId("dupe", { asyncDirRoot: asyncRoot, resultsDir, callerKey: "me" }),
      (error: Error) =>
        /Ambiguous subagent run id prefix 'dupe' matched: async:dupe-one, async:dupe-two\./.test(
          error.message,
        ) && !error.message.includes("dupe-three"),
    );
  });

  describe("session-scoped prefixes", () => {
    function setup() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-run-id-scoped-"));
      tempRoots.push(root);
      return {
        asyncDirRoot: path.join(root, "runs"),
        resultsDir: path.join(root, "results"),
      };
    }

    it("resolves an own+foreign prefix collision to the owned run", () => {
      const deps = setup();
      seedRun(deps.asyncDirRoot, "run-aa", "other");
      seedRun(deps.asyncDirRoot, "run-ab", "me");
      const resolved = resolveSubagentRunId("run-a", { ...deps, callerKey: "me" });
      assert.equal(resolved?.id, "run-ab");
    });

    it("uses state.currentSessionId when no callerKey is given", () => {
      const deps = setup();
      seedRun(deps.asyncDirRoot, "run-aa", "me");
      const resolved = resolveSubagentRunId("run-a", {
        ...deps,
        state: { currentSessionId: "me" },
      });
      assert.equal(resolved?.id, "run-aa");
    });

    it("reports no match for foreign-only, ownerless and caller-less prefixes", () => {
      const deps = setup();
      seedRun(deps.asyncDirRoot, "run-aa", "other");
      seedRun(deps.asyncDirRoot, "run-ab", undefined);
      assert.equal(resolveSubagentRunId("run-a", { ...deps, callerKey: "me" }), undefined);
      assert.equal(resolveSubagentRunId("run-a", deps), undefined);
      assert.equal(resolveSubagentRunId("run-a", { ...deps, callerKey: "" }), undefined);
    });

    it("includes result-only runs by their result owner", () => {
      const deps = setup();
      fs.mkdirSync(deps.resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(deps.resultsDir, "run-rr.json"),
        JSON.stringify({ runId: "run-rr", sessionId: "me" }),
      );
      assert.equal(resolveSubagentRunId("run-r", { ...deps, callerKey: "me" })?.id, "run-rr");
      assert.equal(resolveSubagentRunId("run-r", { ...deps, callerKey: "you" }), undefined);
    });

    it("does not match result records whose embedded identity names another run", () => {
      const deps = setup();
      fs.mkdirSync(deps.resultsDir, { recursive: true });
      fs.writeFileSync(
        path.join(deps.resultsDir, "run-mm.json"),
        JSON.stringify({ runId: "run-other", sessionId: "me" }),
      );
      fs.writeFileSync(
        path.join(deps.resultsDir, "run-ml.json"),
        JSON.stringify({ id: "run-other", sessionId: "me" }),
      );
      assert.equal(resolveSubagentRunId("run-m", { ...deps, callerKey: "me" }), undefined);
    });

    it("still resolves exact foreign ids unfiltered (action paths owner-check)", () => {
      const deps = setup();
      seedRun(deps.asyncDirRoot, "run-aa", "other");
      assert.equal(resolveSubagentRunId("run-aa", { ...deps, callerKey: "me" })?.id, "run-aa");
      assert.equal(resolveSubagentRunId("run-aa", deps)?.id, "run-aa");
    });
  });

  it("rejects unsafe id tokens before lookup", () => {
    assert.throws(() => resolveSubagentRunId("../run"), /safe id token/);
    assert.throws(() => resolveSubagentRunId("a/b"), /safe id token/);
    assert.throws(() => resolveSubagentRunId(""), /safe id token/);
  });
});
