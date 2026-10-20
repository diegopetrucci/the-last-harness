import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import { makeAgent, makeMinimalCtx, makeSubagentState } from "../support/helpers.ts";

// The ownership key is the parent session FILE (gnosis mgzmfy), never the UUID.
const PARENT_FILE = "/sessions/parent-a.jsonl";
const PARENT_UUID = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_FILE = "/sessions/parent-b.jsonl";
const OTHER_UUID = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Parent {
  file: string | null;
  uuid: string;
}
const PARENT_A: Parent = { file: PARENT_FILE, uuid: PARENT_UUID };
const PARENT_B: Parent = { file: OTHER_FILE, uuid: OTHER_UUID };

let root: string;
const runIds: string[] = [];
let launches: Array<Record<string, any>>;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tlh-ordinary-owner-")));
  launches = [];
});

afterEach(() => {
  for (const runId of runIds.splice(0)) {
    fs.rmSync(path.join(ASYNC_DIR, runId), { recursive: true, force: true });
    fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

type Owner = string | number | null | undefined;

function newRunId(label: string): string {
  const runId = `ordown-${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  runIds.push(runId);
  return runId;
}

/** Writes a terminal ordinary run; `statusOwner`/`resultOwner` of undefined omit the field. */
function writeRun(
  label: string,
  opts: {
    state?: "complete" | "running" | "paused";
    statusOwner?: Owner;
    resultOwner?: Owner;
    withStatus?: boolean;
    withResult?: boolean;
    pid?: number;
  } = {},
): { runId: string; asyncDir: string; resultPath: string } {
  const runId = newRunId(label);
  const state = opts.state ?? "complete";
  const asyncDir = path.join(ASYNC_DIR, runId);
  const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
  const sessionFile = path.join(asyncDir, "child.jsonl");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(sessionFile, "", "utf-8");
  if (opts.withStatus !== false) {
    const pause = { kind: "awaiting_supervisor" };
    writeJson(path.join(asyncDir, "status.json"), {
      runId,
      mode: "single",
      state,
      ...(opts.pid ? { pid: opts.pid } : {}),
      ...(opts.statusOwner !== undefined ? { sessionId: opts.statusOwner } : {}),
      cwd: root,
      startedAt: 100,
      lastUpdate: 200,
      sessionFile,
      ...(state === "paused" ? { pause } : {}),
      steps: [
        {
          agent: "code-reviewer",
          status: state,
          startedAt: 100,
          sessionFile,
          cwd: root,
          ...(state === "paused" ? { pause } : {}),
        },
      ],
    } as any);
  }
  if (opts.withResult) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    writeJson(resultPath, {
      id: runId,
      agent: "code-reviewer",
      mode: "single",
      success: true,
      state: "complete",
      cwd: root,
      asyncDir,
      ...(opts.resultOwner !== undefined ? { sessionId: opts.resultOwner } : {}),
      results: [{ agent: "code-reviewer", success: true, output: "done", sessionFile }],
    } as any);
  }
  return { runId, asyncDir, resultPath };
}

function snapshot(...targets: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (target: string) => {
    if (!fs.existsSync(target)) {
      out[target] = "<absent>";
    } else if (fs.statSync(target).isDirectory()) {
      out[target] = "<dir>";
      for (const entry of fs.readdirSync(target).sort()) visit(path.join(target, entry));
    } else {
      out[target] = fs.readFileSync(target, "utf-8");
    }
  };
  targets.forEach(visit);
  return out;
}

function makeExecutor(
  kill: (pid: number, signal?: NodeJS.Signals | 0) => boolean = () => true,
  onDiscover?: () => void,
) {
  return createSubagentExecutor({
    pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "parent" } as any,
    state: makeSubagentState({ baseCwd: root }),
    config: { maxSubagentDepth: 2, control: {} } as any,
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => path.join(root, "sessions"),
    expandTilde: (value) => value,
    discoverAgents: () => {
      onDiscover?.();
      return { agents: [makeAgent("code-reviewer")] };
    },
    kill,
    executeAsyncSingle: ((runId: string, options: Record<string, any>) => {
      launches.push({ runId, ...options });
      return {
        content: [{ type: "text", text: "dispatched" }],
        details: { mode: "single", results: [], asyncId: runId },
      };
    }) as any,
  });
}

function ctxFor(parent: Parent) {
  const ctx = makeMinimalCtx(root);
  (ctx.sessionManager as any).getSessionId = () => parent.uuid;
  (ctx.sessionManager as any).getSessionFile = () => parent.file;
  return ctx;
}

async function resume(
  executor: ReturnType<typeof makeExecutor>,
  params: Record<string, unknown>,
  parent: Parent,
) {
  return executor.execute(
    "resume",
    { action: "resume", message: "continue", ...params } as any,
    new AbortController().signal,
    undefined,
    ctxFor(parent),
  );
}

const text = (result: { content: Array<{ type: string }> }) => {
  const first = result.content[0] as { text?: string } | undefined;
  return first?.text ?? "";
};

describe("durable revival owner gate for ordinary runs", () => {
  it("revives for the owning parent keyed by session file and launches with that key", async () => {
    const { runId } = writeRun("same", { statusOwner: PARENT_FILE });
    const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
    assert.equal(result.isError, undefined, text(result));
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.ctx.currentSessionId, PARENT_FILE);
  });

  it("keys on the session id when the parent has no session file", async () => {
    const parent: Parent = { file: null, uuid: PARENT_UUID };
    const { runId } = writeRun("idonly", { statusOwner: PARENT_UUID });
    const result = await resume(makeExecutor(), { id: runId }, parent);
    assert.equal(result.isError, undefined, text(result));
    assert.equal(launches[0]!.ctx.currentSessionId, PARENT_UUID);
  });

  it("rejects a run persisted under the parent UUID when the caller key is its file", async () => {
    const { runId } = writeRun("uuid", { statusOwner: PARENT_UUID });
    const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.equal(launches.length, 0);
  });

  it("allows the reopened original parent and rejects a fork or new parent", async () => {
    const { runId } = writeRun("reopen", { statusOwner: PARENT_FILE });
    const executor = makeExecutor();
    // A fork/new parent has a different file and UUID.
    const forked = await resume(executor, { id: runId }, PARENT_B);
    assert.equal(forked.isError, true);
    assert.equal(launches.length, 0);
    // Reopening the original file yields a fresh UUID but the same file key.
    const reopened = await resume(
      executor,
      { id: runId },
      { file: PARENT_FILE, uuid: "33333333-cccc-4ccc-8ccc-cccccccccccc" },
    );
    assert.equal(reopened.isError, undefined, text(reopened));
    assert.equal(launches.length, 1);
  });

  const rejectedOwners: Array<[string, Owner]> = [
    ["foreign", OTHER_FILE],
    ["missing", undefined],
    ["empty", ""],
  ];
  for (const [label, owner] of rejectedOwners) {
    it(`rejects a ${label} persisted owner without mutating anything`, async () => {
      const { runId, asyncDir, resultPath } = writeRun(label, {
        statusOwner: owner,
        withResult: true,
        resultOwner: owner,
      });
      const before = snapshot(asyncDir, resultPath);
      const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
      assert.equal(result.isError, true);
      assert.match(text(result), /recovering-ownerless-or-foreign-runs/);
      assert.equal(launches.length, 0);
      assert.deepEqual(snapshot(asyncDir, resultPath), before);
    });
  }

  it("rejects a malformed persisted owner", async () => {
    const status = writeRun("malformed-status", { statusOwner: 42 });
    const result = writeRun("malformed-result", {
      withStatus: false,
      withResult: true,
      resultOwner: 42,
    });
    for (const { runId } of [status, result]) {
      const response = await resume(makeExecutor(), { id: runId }, PARENT_A);
      assert.equal(response.isError, true, runId);
    }
    assert.equal(launches.length, 0);
  });

  it("rejects conflicting status and result owners for either caller", async () => {
    const { runId, asyncDir, resultPath } = writeRun("conflict", {
      statusOwner: PARENT_FILE,
      withResult: true,
      resultOwner: OTHER_FILE,
    });
    const before = snapshot(asyncDir, resultPath);
    for (const parent of [PARENT_A, PARENT_B]) {
      const result = await resume(makeExecutor(), { id: runId }, parent);
      assert.equal(result.isError, true);
    }
    assert.equal(launches.length, 0);
    assert.deepEqual(snapshot(asyncDir, resultPath), before);
  });

  it("applies to unique id prefixes and explicit directories", async () => {
    const foreign = writeRun("prefix", { statusOwner: OTHER_FILE });
    const byPrefix = await resume(makeExecutor(), { id: foreign.runId.slice(0, -2) }, PARENT_A);
    assert.equal(byPrefix.isError, true);
    const byDir = await resume(makeExecutor(), { dir: foreign.asyncDir }, PARENT_A);
    assert.equal(byDir.isError, true);
    assert.equal(launches.length, 0);

    const owned = writeRun("prefix-own", { statusOwner: PARENT_FILE });
    const okPrefix = await resume(makeExecutor(), { id: owned.runId.slice(0, -2) }, PARENT_A);
    assert.equal(okPrefix.isError, undefined, text(okPrefix));
    const okDir = await resume(makeExecutor(), { dir: owned.asyncDir }, PARENT_A);
    assert.equal(okDir.isError, undefined, text(okDir));
    assert.equal(launches.length, 2);
  });

  it("gates result-only recovery on the result owner", async () => {
    const foreign = writeRun("result-foreign", {
      withStatus: false,
      withResult: true,
      resultOwner: OTHER_FILE,
    });
    const missing = writeRun("result-missing", { withStatus: false, withResult: true });
    for (const { runId } of [foreign, missing]) {
      const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
      assert.equal(result.isError, true, runId);
    }
    assert.equal(launches.length, 0);
    const owned = writeRun("result-owned", {
      withStatus: false,
      withResult: true,
      resultOwner: PARENT_FILE,
    });
    const result = await resume(makeExecutor(), { id: owned.runId }, PARENT_A);
    assert.equal(result.isError, undefined, text(result));
    assert.equal(launches.length, 1);
  });

  for (const [label, message] of [
    ["with a message", "keep going"],
    ["without a message", ""],
  ] as const) {
    it(`rejects foreign supervisor continuation ${label} before any claim`, async () => {
      const { runId, asyncDir } = writeRun(`paused-${label.length}`, {
        state: "paused",
        statusOwner: OTHER_FILE,
      });
      const before = snapshot(asyncDir);
      const result = await resume(makeExecutor(), { id: runId, message }, PARENT_A);
      assert.equal(result.isError, true);
      assert.match(text(result), /owned by another session/);
      assert.equal(launches.length, 0);
      assert.deepEqual(snapshot(asyncDir), before);
    });

    it(`claims supervisor continuation ${label} for the owner`, async () => {
      const { runId } = writeRun(`paused-own-${label.length}`, {
        state: "paused",
        statusOwner: PARENT_FILE,
      });
      const result = await resume(makeExecutor(), { id: runId, message }, PARENT_A);
      assert.equal(result.isError, undefined, text(result));
      assert.equal(launches.length, 1);
      assert.equal(launches[0]!.ctx.currentSessionId, PARENT_FILE);
      assert.ok(launches[0]!.continuationSource.claimToken);
    });
  }

  it("does not reconcile a stale running run for a foreign caller", async () => {
    const dead = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const { runId, asyncDir } = writeRun("stale", {
      state: "running",
      statusOwner: OTHER_FILE,
      pid: 2_147_483_000,
    });
    const before = snapshot(asyncDir, path.join(RESULTS_DIR, `${runId}.json`));
    const result = await resume(makeExecutor(dead), { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.equal(launches.length, 0);
    assert.deepEqual(snapshot(asyncDir, path.join(RESULTS_DIR, `${runId}.json`)), before);
  });

  it("revalidates the owner at the locked claim and refuses a handoff after preflight", async () => {
    const { runId, asyncDir } = writeRun("handoff", {
      state: "paused",
      statusOwner: PARENT_FILE,
    });
    const statusPath = path.join(asyncDir, "status.json");
    // discoverAgents runs after the preflight gate and before the claim lock.
    const executor = makeExecutor(undefined, () => {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
      status.sessionId = OTHER_FILE;
      fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
    });
    const result = await resume(executor, { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.match(text(result), /owned by another session/);
    assert.equal(launches.length, 0);
    const persisted = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    assert.equal(persisted.lifecycle?.continuations, undefined);
    assert.equal(persisted.state, "paused");
  });

  it("reports ownership before any later policy check such as agent discovery", async () => {
    const { runId, asyncDir } = writeRun("ghost", { statusOwner: OTHER_FILE });
    const statusPath = path.join(asyncDir, "status.json");
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
    status.steps[0].agent = "ghost-agent";
    fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
    const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.match(text(result), /owned by another session/);
  });

  it("does not reconcile a stale running run whose status and result owners conflict", async () => {
    const dead = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const { runId, asyncDir, resultPath } = writeRun("stale-conflict", {
      state: "running",
      statusOwner: PARENT_FILE,
      withResult: true,
      resultOwner: OTHER_FILE,
      pid: 2_147_483_000,
    });
    const before = snapshot(asyncDir, resultPath);
    const result = await resume(makeExecutor(dead), { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.equal(launches.length, 0);
    assert.deepEqual(snapshot(asyncDir, resultPath), before);
  });

  it("revalidates the result owner at the locked claim of a paused run", async () => {
    const { runId, asyncDir, resultPath } = writeRun("handoff-result", {
      state: "paused",
      statusOwner: PARENT_FILE,
    });
    const before = snapshot(asyncDir);
    // After preflight, a result record naming a conflicting owner appears.
    const executor = makeExecutor(undefined, () => {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      writeJson(resultPath, {
        id: runId,
        agent: "code-reviewer",
        success: true,
        state: "complete",
        sessionId: OTHER_FILE,
      } as any);
    });
    const result = await resume(executor, { id: runId }, PARENT_A);
    assert.equal(result.isError, true);
    assert.match(text(result), /owned by another session/);
    assert.equal(launches.length, 0);
    assert.deepEqual(snapshot(asyncDir), before);
  });

  for (const keepDir of [true, false]) {
    it(`revalidates a result-only run's owner immediately before launch (lifecycle dir ${keepDir ? "present" : "absent"})`, async () => {
      const { runId, asyncDir, resultPath } = writeRun(`handoff-result-only-${keepDir}`, {
        withStatus: false,
        withResult: true,
        resultOwner: PARENT_FILE,
      });
      if (!keepDir) {
        // Keep the child session outside the lifecycle dir that is about to vanish.
        const keptSession = path.join(root, "child.jsonl");
        fs.writeFileSync(keptSession, "", "utf-8");
        const record = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        record.results[0].sessionFile = keptSession;
        fs.writeFileSync(resultPath, JSON.stringify(record), "utf-8");
        fs.rmSync(asyncDir, { recursive: true, force: true });
      }
      const executor = makeExecutor(undefined, () => {
        const record = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        record.sessionId = OTHER_FILE;
        fs.writeFileSync(resultPath, JSON.stringify(record), "utf-8");
      });
      const result = await resume(executor, { dir: asyncDir, id: runId }, PARENT_A);
      assert.equal(result.isError, true);
      assert.match(text(result), /owned by another session/);
      assert.equal(launches.length, 0);
    });
  }

  for (const state of ["running", "paused"] as const) {
    it(`ignores a traversal runId in a ${state} run's status when reading the result owner`, async () => {
      const { runId, asyncDir } = writeRun(`traversal-${state}`, {
        state,
        statusOwner: PARENT_FILE,
        ...(state === "running" ? { pid: 2_147_483_000 } : {}),
      });
      const outsideDir = `tlh-outside-${runId}`;
      const traversal = `../${outsideDir}/x`;
      const outsideFile = path.join(RESULTS_DIR, `${traversal}.json`);
      const outsideRoot = path.dirname(outsideFile);
      fs.mkdirSync(outsideRoot, { recursive: true });
      try {
        // The escaped file names the caller as owner; honoring it would admit the resume.
        fs.writeFileSync(outsideFile, JSON.stringify({ sessionId: PARENT_FILE }), "utf-8");
        const statusPath = path.join(asyncDir, "status.json");
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        status.runId = traversal;
        fs.writeFileSync(statusPath, JSON.stringify(status), "utf-8");
        const before = snapshot(asyncDir, outsideFile);
        const result = await resume(makeExecutor(), { id: runId }, PARENT_A);
        assert.equal(result.isError, true, text(result));
        assert.match(text(result), /recovering-ownerless-or-foreign-runs|owned by another session/);
        assert.equal(launches.length, 0);
        assert.deepEqual(snapshot(asyncDir, outsideFile), before);
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  }
});
