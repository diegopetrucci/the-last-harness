import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { OWNER_SESSION, errno, ownerState, textContent } from "../support/run-status-fixtures.ts";

const FOREIGN = "foreign-session";

interface Fixture {
  root: string;
  asyncRoot: string;
  resultsDir: string;
  statusPath: string;
  statusBytes: string;
  killCalls: number;
}

function setup(
  runId: string,
  status: Record<string, unknown> | null,
  result?: Record<string, unknown>,
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-owner-gate-"));
  const asyncRoot = path.join(root, "runs");
  const resultsDir = path.join(root, "results");
  const asyncDir = path.join(asyncRoot, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  const statusPath = path.join(asyncDir, "status.json");
  if (status)
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        runId,
        mode: "single",
        state: "running",
        pid: 12345,
        startedAt: 100,
        lastUpdate: 100,
        sessionFile: path.join(root, "SECRET-session.jsonl"),
        steps: [{ agent: "scout", status: "running", startedAt: 100 }],
        ...status,
      }),
    );
  if (result)
    fs.writeFileSync(
      path.join(resultsDir, `${runId}.json`),
      JSON.stringify({ id: runId, ...result }),
    );
  return {
    root,
    asyncRoot,
    resultsDir,
    statusPath,
    statusBytes: status ? fs.readFileSync(statusPath, "utf-8") : "",
    killCalls: 0,
  };
}

function inspect(
  fx: Fixture,
  params: { id?: string; dir?: string },
  caller: string | null = OWNER_SESSION,
) {
  return inspectSubagentStatus(params, {
    asyncDirRoot: fx.asyncRoot,
    resultsDir: fx.resultsDir,
    state: (caller === OWNER_SESSION ? ownerState : { currentSessionId: caller }) as never,
    kill: () => {
      fx.killCalls++;
      throw errno("ESRCH");
    },
    now: () => 200,
  });
}

function assertNoLeak(text: string, fx: Fixture) {
  assert.doesNotMatch(text, /SECRET-session|Session|Result:|Log:|Events:|Revive|resume|\.jsonl/);
  assert.equal(text.includes(fx.root), false);
}

describe("status owner gate", () => {
  it("denies a foreign run by exact id without reconciling it", () => {
    const fx = setup("run-foreign", { sessionId: FOREIGN });
    try {
      const result = inspect(fx, { id: "run-foreign" });
      assert.equal(result.isError, true);
      assert.equal(
        textContent(result),
        "Async run 'run-foreign' is owned by another session and cannot be inspected from this session.",
      );
      assertNoLeak(textContent(result), fx);
      assert.equal(fs.readFileSync(fx.statusPath, "utf-8"), fx.statusBytes);
      assert.equal(fx.killCalls, 0);
      assert.equal(fs.existsSync(path.join(fx.resultsDir, "run-foreign.json")), false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("treats a foreign run as not found by prefix without naming it", () => {
    const fx = setup("run-foreign-abcdef", { sessionId: FOREIGN });
    try {
      const result = inspect(fx, { id: "run-foreign-ab" });
      assert.equal(result.isError, true);
      assert.doesNotMatch(textContent(result), /run-foreign-abcdef/);
      assertNoLeak(textContent(result), fx);
      assert.equal(fs.readFileSync(fx.statusPath, "utf-8"), fx.statusBytes);
      assert.equal(fx.killCalls, 0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("denies a foreign run by dir without reconciling it", () => {
    const fx = setup("run-foreign-dir", { sessionId: FOREIGN });
    try {
      const result = inspect(fx, { dir: path.join(fx.asyncRoot, "run-foreign-dir") });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /owned by another session/);
      assertNoLeak(textContent(result), fx);
      assert.equal(fs.readFileSync(fx.statusPath, "utf-8"), fx.statusBytes);
      assert.equal(fx.killCalls, 0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("denies a foreign result-only record", () => {
    const fx = setup("run-foreign-result", null, {
      sessionId: FOREIGN,
      success: false,
      state: "failed",
      sessionFile: "/tmp/SECRET-session.jsonl",
      summary: "SECRET-summary",
    });
    try {
      const result = inspect(fx, { id: "run-foreign-result" });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /owned by another session/);
      assert.doesNotMatch(textContent(result), /SECRET/);
      assertNoLeak(textContent(result), fx);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("denies a result-only record whose embedded id names another run", () => {
    const fx = setup("run-mismatch", null, {
      id: "run-foreign-id",
      sessionId: OWNER_SESSION,
      summary: "SECRET-summary",
    });
    try {
      const result = inspect(fx, { id: "run-mismatch" });
      assert.equal(result.isError, true);
      assert.match(textContent(result), /ownership cannot be verified/);
      assert.doesNotMatch(textContent(result), /SECRET|run-foreign-id/);
      assertNoLeak(textContent(result), fx);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("reports unverifiable ownership for ownerless and conflicting evidence", () => {
    const ownerless = setup("run-ownerless", {});
    const conflicting = setup("run-conflict", { sessionId: OWNER_SESSION }, { sessionId: FOREIGN });
    const resultOnly = setup("run-ownerless-result", null, { success: true, state: "complete" });
    try {
      for (const [fx, id] of [
        [ownerless, "run-ownerless"],
        [conflicting, "run-conflict"],
        [resultOnly, "run-ownerless-result"],
      ] as const) {
        const result = inspect(fx, { id });
        assert.equal(result.isError, true);
        assert.equal(
          textContent(result),
          `Async run '${id}' ownership cannot be verified; it cannot be inspected from this session.`,
        );
        assertNoLeak(textContent(result), fx);
        assert.equal(fx.killCalls, 0);
      }
      assert.equal(fs.readFileSync(ownerless.statusPath, "utf-8"), ownerless.statusBytes);
    } finally {
      for (const fx of [ownerless, conflicting, resultOnly])
        fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("denies when the caller has no session identity", () => {
    const fx = setup("run-no-caller", { sessionId: OWNER_SESSION });
    try {
      const result = inspect(fx, { id: "run-no-caller" }, null);
      assert.equal(result.isError, true);
      assert.match(textContent(result), /ownership cannot be verified/);
      assert.equal(fx.killCalls, 0);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("still reconciles and renders an owned run", () => {
    const fx = setup("run-owned", { sessionId: OWNER_SESSION });
    try {
      const result = inspect(fx, { id: "run-owned" });
      assert.equal(result.isError, undefined);
      assert.match(textContent(result), /State: failed/);
      assert.match(textContent(result), /Diagnosis: Async runner process 12345 exited/);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
