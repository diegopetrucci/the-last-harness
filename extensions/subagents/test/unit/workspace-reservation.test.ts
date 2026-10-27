import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeSubagentState } from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import {
  acquireWorkspaceReservations,
  canonicalWorkspaceKey,
  isWorkspaceWriterAgent,
  releaseWorkspaceReservationsForRun,
} from "../../src/runs/shared/workspace-reservation.ts";

const MODULE_PATH = fileURLToPath(
  new URL("../../src/runs/shared/workspace-reservation.ts", import.meta.url),
);
const ALIVE = () => true;
const DEAD = () => {
  const error = new Error("ESRCH") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
};

let root: string;
let repo: string;
let linked: string;
let plain: string;
let n = 0;

function fresh() {
  n += 1;
  const base = path.join(root, `state-${n}`);
  return { dir: path.join(base, "res"), asyncDir: path.join(base, "runs") };
}

function writeStatus(asyncDir: string, runId: string, state: string, pid?: number) {
  fs.mkdirSync(path.join(asyncDir, runId), { recursive: true });
  fs.writeFileSync(
    path.join(asyncDir, runId, "status.json"),
    JSON.stringify({ runId, state, mode: "single", startedAt: 1, lastUpdate: 1, pid }),
  );
}

const dev = (cwd: string, childIndex = 0, agent = "developer") => ({ agent, childIndex, cwd });

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wsres-")));
  repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "-q");
  git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  linked = path.join(root, "linked");
  git("worktree", "add", "-q", linked);
  plain = path.join(root, "plain");
  fs.mkdirSync(plain);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("workspace writer reservation", () => {
  it("classifies writers from the canonical role list", () => {
    for (const a of ["developer", "test-runner", "custom", "embedded.foo"])
      assert.equal(isWorkspaceWriterAgent(a), true, a);
    for (const a of [
      "code-reviewer",
      "contrarian",
      "diff-summarizer",
      "librarian",
      "oracle",
      "repo-scout",
      "web-scout",
    ])
      assert.equal(isWorkspaceWriterAgent(a), false, a);
  });

  it("keys nested cwds to one git root and linked worktrees apart", () => {
    assert.equal(
      canonicalWorkspaceKey(path.join(repo, "sub", "deep")),
      canonicalWorkspaceKey(repo),
    );
    assert.notEqual(canonicalWorkspaceKey(linked), canonicalWorkspaceKey(repo));
    assert.equal(canonicalWorkspaceKey(plain), plain);
  });

  it("rejects a second writer in the same or nested cwd, naming the holder", () => {
    const o = { ...fresh(), kill: ALIVE };
    const first = acquireWorkspaceReservations("run-a", "s1", [dev(repo)], o);
    assert.equal(first.ok, true);
    writeStatus(o.asyncDir, "run-a", "running", 1234);
    for (const cwd of [repo, path.join(repo, "sub", "deep")]) {
      const second = acquireWorkspaceReservations("run-b", "s2", [dev(cwd, 0, "test-runner")], o);
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.equal(second.holderRunId, "run-a");
        assert.match(second.message, /run-a/);
        assert.match(second.message, /interrupt/);
      }
    }
  });

  it("lets read-only roles run beside a writer and distinct worktrees run in parallel", () => {
    const o = { ...fresh(), kill: ALIVE };
    assert.equal(acquireWorkspaceReservations("run-a", "s", [dev(repo)], o).ok, true);
    writeStatus(o.asyncDir, "run-a", "running", 1);
    assert.equal(
      acquireWorkspaceReservations(
        "run-r",
        "s",
        [dev(repo, 0, "oracle"), dev(repo, 1, "repo-scout")],
        o,
      ).ok,
      true,
    );
    assert.equal(
      acquireWorkspaceReservations("run-w", "s", [dev(linked), dev(plain, 1)], o).ok,
      true,
    );
  });

  it("rejects a parallel batch with two writers on one workspace without leaving holds", () => {
    const o = { ...fresh(), kill: ALIVE };
    const batch = acquireWorkspaceReservations(
      "run-p",
      "s",
      [dev(plain, 0), dev(plain, 1, "custom-agent")],
      o,
    );
    assert.equal(batch.ok, false);
    assert.equal(acquireWorkspaceReservations("run-q", "s", [dev(plain)], o).ok, true);
    // all-or-nothing: a conflict on the second request releases the first
    writeStatus(o.asyncDir, "run-q", "running", 1);
    const mixed = acquireWorkspaceReservations("run-m", "s", [dev(linked), dev(plain, 1)], o);
    assert.equal(mixed.ok, false);
    assert.equal(acquireWorkspaceReservations("run-n", "s", [dev(linked)], o).ok, true);
  });

  it("releases on explicit release, terminal and pause evidence, and per-run release", () => {
    const o = { ...fresh(), kill: ALIVE };
    const held = acquireWorkspaceReservations("run-a", "s", [dev(plain)], o);
    assert.ok(held.ok);
    held.release();
    assert.equal(acquireWorkspaceReservations("run-b", "s", [dev(plain)], o).ok, true);
    releaseWorkspaceReservationsForRun("run-b", o);
    assert.equal(acquireWorkspaceReservations("run-c", "s", [dev(plain)], o).ok, true);
    for (const state of ["complete", "failed", "cancelled", "paused"]) {
      writeStatus(o.asyncDir, "run-c", state, 1);
      assert.equal(acquireWorkspaceReservations("run-d", "s", [dev(plain)], o).ok, true, state);
      releaseWorkspaceReservationsForRun("run-d", o);
      assert.equal(acquireWorkspaceReservations("run-c", "s", [dev(plain)], o).ok, true);
    }
  });

  it("recovers a dead holder but never a live one", () => {
    const o = fresh();
    assert.equal(acquireWorkspaceReservations("run-a", "s", [dev(plain)], o).ok, true);
    writeStatus(o.asyncDir, "run-a", "running", 4242);
    const live = acquireWorkspaceReservations("run-b", "s", [dev(plain)], { ...o, kill: ALIVE });
    assert.equal(live.ok, false);
    const unknown = acquireWorkspaceReservations("run-b", "s", [dev(plain)], {
      ...o,
      kill: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    assert.equal(unknown.ok, false);
    const recovered = acquireWorkspaceReservations("run-b", "s", [dev(plain)], {
      ...o,
      kill: DEAD,
    });
    assert.equal(recovered.ok, true);
  });

  it("recovers a holder that never produced lifecycle status only when the launcher is gone or overdue", () => {
    const o = fresh();
    let now = 1_000_000;
    assert.equal(
      acquireWorkspaceReservations("run-a", "s", [dev(plain)], {
        ...o,
        kill: ALIVE,
        now: () => now,
      }).ok,
      true,
    );
    assert.equal(
      acquireWorkspaceReservations("run-b", "s", [dev(plain)], {
        ...o,
        kill: ALIVE,
        now: () => now + 1000,
      }).ok,
      false,
    );
    assert.equal(
      acquireWorkspaceReservations("run-b", "s", [dev(plain)], {
        ...o,
        kill: DEAD,
        now: () => now + 1000,
      }).ok,
      true,
    );
    // A live launcher is never reclaimed, however old the hold is.
    now += 10 * 60_000;
    assert.equal(
      acquireWorkspaceReservations("run-c", "s", [dev(plain)], {
        ...o,
        kill: ALIVE,
        now: () => now,
      }).ok,
      false,
    );
    // Unknown liveness is reclaimed only once overdue.
    const EPERM = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    assert.equal(
      acquireWorkspaceReservations("run-d", "s", [dev(plain)], {
        ...o,
        kill: EPERM,
        now: () => now,
      }).ok,
      true,
    );
    assert.equal(
      acquireWorkspaceReservations("run-e", "s", [dev(plain)], {
        ...o,
        kill: EPERM,
        now: () => now + 1000,
      }).ok,
      false,
    );
  });

  it("serializes release against reclaim and never deletes a replacement hold", () => {
    const o = { ...fresh(), kill: ALIVE };
    const a = acquireWorkspaceReservations("run-a", "s", [dev(plain)], o);
    assert.ok(a.ok);
    writeStatus(o.asyncDir, "run-a", "complete", 1);
    // While A's release holds the lock, a reclaimer must not replace the hold.
    let duringRelease: ReturnType<typeof acquireWorkspaceReservations> | undefined;
    const hooked = {
      ...o,
      afterReleaseLock: () => {
        duringRelease ??= acquireWorkspaceReservations("run-b", "s", [dev(plain)], o);
      },
    };
    const again = acquireWorkspaceReservations("run-a", "s", [dev(plain)], hooked);
    assert.ok(again.ok);
    again.release();
    assert.equal(duringRelease?.ok, false);
    // After release the workspace is free; B's hold survives a late stale release by A.
    const b = acquireWorkspaceReservations("run-b", "s", [dev(plain)], o);
    assert.ok(b.ok);
    a.release();
    releaseWorkspaceReservationsForRun("run-a", o);
    assert.equal(acquireWorkspaceReservations("run-c", "s", [dev(plain)], o).ok, false);
    // Release is a no-op once the file names a different holder; the free workspace is reacquirable.
    b.release();
    assert.equal(acquireWorkspaceReservations("run-c", "s", [dev(plain, 1)], o).ok, true);
  });

  it("grants exactly one of many concurrent processes (atomic acquisition)", async () => {
    const o = fresh();
    const script = `
      import { acquireWorkspaceReservations } from ${JSON.stringify(MODULE_PATH)};
      const r = acquireWorkspaceReservations(process.argv[1], "s", [{agent:"developer",childIndex:0,cwd:${JSON.stringify(plain)}}], ${JSON.stringify({ ...o, pid: process.pid })});
      process.stdout.write(r.ok ? "WIN" : "LOSE");
    `;
    const outputs = await Promise.all(
      Array.from(
        { length: 8 },
        (_, i) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--input-type=module", "-e", script, `race-${i}`],
              {
                stdio: ["ignore", "pipe", "inherit"],
              },
            );
            let out = "";
            child.stdout.on("data", (c) => (out += c));
            child.on("error", reject);
            child.on("close", () => resolve(out));
          }),
      ),
    );
    assert.equal(outputs.filter((x) => x === "WIN").length, 1, outputs.join(","));
    assert.equal(outputs.filter((x) => x === "LOSE").length, 7);
  });
});

describe("executor integration", () => {
  function makeExecutor(launches: string[]) {
    const agents = ["developer", "oracle", "custom-writer"].map((name) => ({
      name,
      description: name,
      systemPrompt: "",
      source: "builtin",
      filePath: `/x/${name}.md`,
    }));
    return createSubagentExecutor({
      pi: { events: { emit() {}, on: () => () => {} }, getSessionName: () => "p" } as any,
      state: makeSubagentState({ baseCwd: "" }),
      config: { maxSubagentDepth: 2, control: {} } as any,
      tempArtifactsDir: os.tmpdir(),
      getSubagentSessionRoot: () => os.tmpdir(),
      expandTilde: (v) => v,
      discoverAgents: () => ({ agents }) as any,
      executeAsyncSingle: ((id: string) => {
        launches.push(id);
        return {
          content: [{ type: "text", text: "started" }],
          details: { mode: "single", results: [], asyncId: id },
        };
      }) as any,
      executeAsyncParallel: ((id: string) => {
        launches.push(id);
        return {
          content: [{ type: "text", text: "started" }],
          details: { mode: "parallel", results: [], asyncId: id },
        };
      }) as any,
    });
  }
  const ctx = (cwd: string) =>
    ({
      cwd,
      hasUI: false,
      sessionManager: { getSessionId: () => "sess", getSessionFile: () => null },
      modelRegistry: { getAvailable: () => [] },
    }) as any;
  const call = (
    ex: ReturnType<typeof makeExecutor>,
    params: Record<string, unknown>,
    cwd: string,
  ) => ex.execute("t", params as any, new AbortController().signal, undefined, ctx(cwd));

  it("rejects a conflicting launch before spawn and still allows a reader", async () => {
    const dirCwd = fs.mkdtempSync(path.join(root, "exec-"));
    const launches: string[] = [];
    const ex = makeExecutor(launches);
    const first = await call(ex, { agent: "developer", task: "x", async: true }, dirCwd);
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    const holderId = launches[0]!;
    const conflict = await call(ex, { agent: "developer", task: "y", async: true }, dirCwd);
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), new RegExp(holderId));
    assert.equal(launches.length, 1);
    const reader = await call(ex, { agent: "oracle", task: "y", async: true }, dirCwd);
    assert.notEqual(reader.isError, true);
    const batch = await call(
      ex,
      {
        tasks: [
          { agent: "oracle", task: "a" },
          { agent: "custom-writer", task: "b" },
        ],
        async: true,
      },
      dirCwd,
    );
    assert.equal(batch.isError, true);
    assert.equal(launches.length, 2);
    releaseWorkspaceReservationsForRun(holderId);
  });
});
