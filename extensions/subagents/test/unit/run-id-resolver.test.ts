import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";

const tempRoots: string[] = [];

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
