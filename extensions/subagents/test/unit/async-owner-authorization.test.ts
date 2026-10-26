import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { authorizeAsyncRunOwner } from "../../src/runs/background/async-owner-authorization.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";

const CALLER = "/sessions/a.jsonl";
const OTHER = "/sessions/b.jsonl";
const RUN = "abc12345";

let root: string;
let resultsDir: string;
let asyncDir: string;

const resultFile = (id = RUN) => path.join(resultsDir, `${id}.json`);
const writeStatus = (fields: Record<string, unknown> = {}, dir = asyncDir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "status.json"),
    JSON.stringify({ runId: RUN, mode: "single", state: "running", startedAt: 1, ...fields }),
  );
};
const writeResult = (fields: Record<string, unknown> = {}) =>
  writeJson(resultFile(), {
    id: RUN,
    agent: "x",
    success: true,
    state: "complete",
    ...fields,
  } as any);
const auth = (extra: Record<string, unknown> = {}) =>
  authorizeAsyncRunOwner({ callerKey: CALLER, asyncDir, resultsDir, ...extra });

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}:${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, "utf-8")}`);
    }
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tlh-owner-auth-")));
  resultsDir = path.join(root, "results");
  asyncDir = path.join(root, "async", RUN);
  fs.mkdirSync(resultsDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("authorizeAsyncRunOwner", () => {
  it("owns via status only, result only, and both agreeing", () => {
    writeStatus({ sessionId: CALLER });
    assert.equal(auth().outcome, "owned");
    fs.rmSync(asyncDir, { recursive: true });
    writeResult({ sessionId: CALLER });
    assert.equal(auth({ asyncDir: undefined, runId: RUN }).outcome, "owned");
    assert.equal(auth({ asyncDir: undefined, resultPath: resultFile() }).outcome, "owned");
    writeStatus({ sessionId: CALLER });
    assert.deepEqual(auth(), { outcome: "owned", runId: RUN, owner: CALLER });
  });

  it("reports foreign for a known different owner", () => {
    writeStatus({ sessionId: OTHER });
    assert.deepEqual(auth(), { outcome: "foreign", runId: RUN, owner: OTHER });
  });

  it("is unverifiable with no evidence, bad owners, or conflicts", () => {
    writeStatus();
    assert.equal(auth().outcome, "unverifiable");
    for (const bad of ["", 5, { value: "x" }]) {
      writeStatus({ sessionId: bad });
      assert.equal(auth().outcome, "unverifiable");
    }
    writeStatus({ sessionId: CALLER });
    writeResult({ sessionId: OTHER });
    assert.equal(auth().outcome, "unverifiable");
    writeStatus({ sessionId: CALLER });
    writeResult({ sessionId: "" });
    assert.equal(auth().outcome, "unverifiable");
  });

  it("is unverifiable for unreadable, invalid or non-object result records", () => {
    writeStatus({ sessionId: CALLER });
    for (const raw of ["{not json", "[]", "null", '"s"']) {
      fs.writeFileSync(resultFile(), raw);
      assert.equal(auth().outcome, "unverifiable", raw);
    }
    fs.rmSync(resultFile());
    fs.mkdirSync(resultFile());
    assert.equal(auth().outcome, "unverifiable");
  });

  it("is unverifiable for an invalid status file", () => {
    fs.mkdirSync(asyncDir, { recursive: true });
    fs.writeFileSync(path.join(asyncDir, "status.json"), "{bad");
    writeResult({ sessionId: CALLER });
    assert.equal(auth().outcome, "unverifiable");
  });

  it("rejects dir/status/result identity mismatches and never follows status runId", () => {
    writeStatus({ sessionId: CALLER, runId: "other999" });
    writeJson(resultFile("other999"), {
      id: "other999",
      agent: "x",
      success: true,
      state: "complete",
      sessionId: CALLER,
    } as any);
    assert.deepEqual(auth(), { outcome: "unverifiable", reason: "identity-mismatch", runId: RUN });
    writeStatus({ sessionId: CALLER });
    assert.equal(auth({ runId: "different" }).outcome, "unverifiable");
    assert.equal(auth({ resultPath: resultFile("different") }).outcome, "unverifiable");
    assert.equal(auth({ resultPath: path.join(root, `${RUN}.json`) }).outcome, "unverifiable");
    assert.deepEqual(auth({ asyncDir: undefined }), {
      outcome: "unverifiable",
      reason: "no-run-identity",
    });
  });

  it("requires an embedded result runId/legacy id to match the run id", () => {
    const mismatch = { outcome: "unverifiable", reason: "identity-mismatch", runId: RUN };
    writeResult({ id: undefined, runId: "other-run", sessionId: CALLER });
    assert.deepEqual(auth({ asyncDir: undefined, runId: RUN }), mismatch);
    writeResult({ id: "other-run", sessionId: CALLER });
    assert.deepEqual(auth({ asyncDir: undefined, runId: RUN }), mismatch);
    writeResult({ id: RUN, runId: "other-run", sessionId: CALLER });
    assert.deepEqual(auth({ asyncDir: undefined, runId: RUN }), mismatch);
    writeStatus({ sessionId: CALLER });
    assert.deepEqual(auth(), mismatch);
    writeResult({ id: RUN, runId: RUN, sessionId: CALLER });
    assert.equal(auth().outcome, "owned");
    writeResult({ id: undefined, runId: undefined, sessionId: CALLER });
    assert.equal(auth({ asyncDir: undefined, runId: RUN }).outcome, "owned");
  });

  it("fails closed for empty or missing caller keys", () => {
    writeStatus({ sessionId: "" });
    for (const callerKey of ["", undefined]) {
      assert.equal(
        authorizeAsyncRunOwner({ callerKey, asyncDir, resultsDir }).outcome,
        "unverifiable",
      );
    }
  });

  it("rechecks with an already-read status without reading status.json", () => {
    writeStatus({ sessionId: OTHER });
    assert.equal(auth({ status: { runId: RUN, sessionId: CALLER } }).outcome, "owned");
    assert.equal(auth({ status: null }).outcome, "unverifiable");
    assert.equal(auth({ status: { runId: "x", sessionId: CALLER } }).outcome, "unverifiable");
  });

  it("performs no filesystem writes", () => {
    writeStatus({ sessionId: CALLER });
    writeResult({ sessionId: CALLER });
    const before = snapshot(root);
    auth();
    auth({ resultPath: resultFile() });
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(asyncDir, "status.json.lock")), false);
  });
});
