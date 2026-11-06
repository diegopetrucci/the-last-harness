import assert from "node:assert/strict";
import fsMutable from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  acquireSessionLease,
  createSessionRecord,
  isSessionLeaseStale,
  markSessionCleanFinal,
  readSessionRecord,
  releaseSessionLease,
  retireSession,
  sessionRecordPath,
  updateSessionLease,
  type SessionLeaseHandle,
  type SessionRecordDeps,
} from "../../src/runs/shared/session-record.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** Fake kill: pids/groups listed as dead throw ESRCH; listed as `unknown` throw EIO. */
const fakeKill =
  (opts: { dead?: number[]; unknown?: number[] } = {}) =>
  (pid: number): boolean => {
    const id = Math.abs(pid);
    if (opts.dead?.includes(id)) throw errno("ESRCH");
    if (opts.unknown?.includes(id)) throw errno("EIO");
    return true;
  };

let dir: string;
let session: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-record-"));
  session = path.join(dir, "2026-01-01T00-00-00-000Z_x.jsonl");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function acquired(
  deps: SessionRecordDeps = {},
  holder = { runnerPid: 111, processGroups: [] as number[] },
): SessionLeaseHandle {
  const result = acquireSessionLease(session, holder, deps);
  assert.equal(result.status, "acquired");
  return (result as { handle: SessionLeaseHandle }).handle;
}

describe("session record", () => {
  it("creates a 0600 sidecar without needing the session file, and refuses to overwrite", () => {
    const created = createSessionRecord(session, { latestRunId: "run-1" });
    assert.equal(created.status, "created");
    const file = sessionRecordPath(session);
    assert.equal(file, `${fs.realpathSync(dir)}/${path.basename(session)}.owner.json`);
    assert.equal(file.endsWith(".jsonl"), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(session), false);
    const read = readSessionRecord(session);
    assert.equal(read.status, "ok");
    if (read.status === "ok") {
      assert.deepEqual(
        [read.record.generation, read.record.activeRuntimeMs, read.record.latestRunId],
        [0, 0, "run-1"],
      );
    }
    assert.equal(createSessionRecord(session).status, "exists");
  });

  it("canonicalizes through a symlinked parent", () => {
    fs.mkdirSync(path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    createSessionRecord(path.join(dir, "link", "s.jsonl"));
    assert.equal(readSessionRecord(path.join(dir, "real", "s.jsonl")).status, "ok");
  });

  it("acquires, bumps generation, and refuses a live second holder", () => {
    createSessionRecord(session);
    const deps = { kill: fakeKill() };
    const handle = acquired(deps, { runnerPid: 111, processGroups: [222, 222] });
    assert.equal(handle.generation, 1);
    const second = acquireSessionLease(session, { runnerPid: 333 }, deps);
    assert.equal(second.status, "held");
    if (second.status === "held") {
      assert.equal(second.holder.runnerPid, 111);
      assert.deepEqual(second.holder.processGroups, [222]);
    }
  });

  it("does not initialize a missing record on acquire", () => {
    assert.equal(acquireSessionLease(session, { runnerPid: 1 }).status, "missing");
    assert.equal(fs.existsSync(sessionRecordPath(session)), false);
  });

  it("applies fenced updates: runtime by max, context latest, groups unioned", () => {
    createSessionRecord(session);
    const handle = acquired();
    updateSessionLease(session, handle, {
      activeRuntimeMs: 500,
      contextUsage: { contextTokens: 900, peakTokens: 900 },
      latestRunId: "r2",
      processGroups: [10, 11],
    });
    const result = updateSessionLease(session, handle, {
      activeRuntimeMs: 200,
      contextUsage: { contextTokens: 100 },
      processGroups: [11, 12],
    });
    assert.equal(result.status, "ok");
    const read = readSessionRecord(session);
    assert.equal(read.status, "ok");
    if (read.status !== "ok") return;
    assert.equal(read.record.activeRuntimeMs, 500);
    assert.deepEqual(read.record.contextUsage, {
      generation: 1,
      usage: { contextTokens: 100 },
    });
    assert.equal(read.record.latestRunId, "r2");
    assert.deepEqual(read.record.lease?.processGroups, [10, 11, 12]);
  });

  it("marks clean-final, clears it on next acquisition, and retires", () => {
    createSessionRecord(session);
    const first = acquired();
    markSessionCleanFinal(session, first, "run-a");
    let read = readSessionRecord(session);
    assert.ok(read.status === "ok" && read.record.cleanFinal?.generation === 1);
    assert.equal(releaseSessionLease(session, first).status, "ok");
    const second = acquired();
    read = readSessionRecord(session);
    assert.ok(read.status === "ok" && read.record.cleanFinal === undefined);
    assert.ok(read.status === "ok" && read.record.latestRunId === "run-a");
    assert.equal(retireSession(session, second, "context exhausted").status, "ok");
    assert.equal(releaseSessionLease(session, second).status, "ok");
    const again = acquireSessionLease(session, { runnerPid: 1 });
    assert.deepEqual(again, { status: "retired", reason: "context exhausted" });
  });

  it("releases only the holder's lease", () => {
    createSessionRecord(session);
    const handle = acquired();
    assert.equal(releaseSessionLease(session, { ...handle, token: "other" }).status, "not-holder");
    assert.equal(releaseSessionLease(session, handle).status, "ok");
    const read = readSessionRecord(session);
    assert.ok(read.status === "ok" && read.record.lease === undefined);
    assert.equal(releaseSessionLease(session, handle).status, "not-holder");
  });

  describe("staleness", () => {
    const lease = { token: "t", runnerPid: 111, processGroups: [222, 333], acquiredAt: 0 };
    it("is stale only when runner and every group are proven dead", () => {
      assert.equal(isSessionLeaseStale(lease, { kill: fakeKill({ dead: [111, 222, 333] }) }), true);
      assert.equal(isSessionLeaseStale(lease, { kill: fakeKill({ dead: [222, 333] }) }), false);
      assert.equal(isSessionLeaseStale(lease, { kill: fakeKill({ dead: [111, 222] }) }), false);
    });
    it("treats unknown liveness as held", () => {
      assert.equal(
        isSessionLeaseStale(lease, { kill: fakeKill({ dead: [111, 222], unknown: [333] }) }),
        false,
      );
      assert.equal(
        isSessionLeaseStale(lease, { kill: fakeKill({ dead: [222, 333], unknown: [111] }) }),
        false,
      );
    });
    it("treats EPERM on a group as alive", () => {
      const kill = (pid: number): boolean => {
        if (pid === -222) throw errno("EPERM");
        throw errno("ESRCH");
      };
      assert.equal(isSessionLeaseStale(lease, { kill }), false);
    });
    it("holds when groups cannot be probed on this platform", () => {
      assert.equal(
        isSessionLeaseStale(lease, {
          kill: fakeKill({ dead: [111, 222, 333] }),
          platform: "win32",
        }),
        false,
      );
    });
    it("a lease with no groups is stale once the runner is dead", () => {
      assert.equal(
        isSessionLeaseStale({ ...lease, processGroups: [] }, { kill: fakeKill({ dead: [111] }) }),
        true,
      );
    });
  });

  it("refuses a stale lease as abandoned without mutating the record", () => {
    createSessionRecord(session);
    const old = acquired({}, { runnerPid: 111, processGroups: [222] });
    const before = fs.readFileSync(sessionRecordPath(session), "utf-8");
    const result = acquireSessionLease(
      session,
      { runnerPid: 333 },
      { kill: fakeKill({ dead: [111, 222] }) },
    );
    assert.equal(result.status, "abandoned");
    if (result.status === "abandoned") {
      assert.equal(result.generation, 1);
      assert.equal(result.staleLease?.token, old.token);
    }
    assert.equal(fs.readFileSync(sessionRecordPath(session), "utf-8"), before);
    // The old holder is still the fenced holder; nothing was taken over.
    assert.equal(updateSessionLease(session, old, { activeRuntimeMs: 5 }).status, "ok");
  });

  it("refuses as abandoned after release without clean final", () => {
    createSessionRecord(session);
    const handle = acquired();
    releaseSessionLease(session, handle);
    const result = acquireSessionLease(session, { runnerPid: 2 });
    assert.deepEqual(result, { status: "abandoned", generation: 1 });
    const read = readSessionRecord(session);
    assert.ok(read.status === "ok" && read.record.generation === 1);
  });

  it("checks retired before held and abandoned", () => {
    createSessionRecord(session);
    const handle = acquired();
    retireSession(session, handle, "done");
    const result = acquireSessionLease(
      session,
      { runnerPid: 2 },
      { kill: fakeKill({ dead: [111] }) },
    );
    assert.deepEqual(result, { status: "retired", reason: "done" });
  });

  it("allows reacquire with a new generation after clean final and release", () => {
    createSessionRecord(session);
    const first = acquired();
    markSessionCleanFinal(session, first, "run-a");
    releaseSessionLease(session, first);
    const second = acquireSessionLease(session, { runnerPid: 2 });
    assert.equal(second.status, "acquired");
    if (second.status === "acquired") {
      assert.equal(second.handle.generation, 2);
      assert.equal(second.record.cleanFinal, undefined);
    }
  });

  it("reports held (not abandoned) when any group is still alive", () => {
    createSessionRecord(session);
    acquired({}, { runnerPid: 111, processGroups: [222] });
    const result = acquireSessionLease(
      session,
      { runnerPid: 333 },
      { kill: fakeKill({ dead: [111] }) },
    );
    assert.equal(result.status, "held");
  });

  it("lets exactly one of many competing acquisitions win", () => {
    createSessionRecord(session);
    const deps = { kill: fakeKill() };
    const results = Array.from({ length: 8 }, (_, i) =>
      acquireSessionLease(session, { runnerPid: 1000 + i }, deps),
    );
    assert.equal(results.filter((r) => r.status === "acquired").length, 1);
    assert.equal(results.filter((r) => r.status === "held").length, 7);
  });

  it("lets exactly one process win a real cross-process race", async () => {
    createSessionRecord(session);
    const { spawn } = await import("node:child_process");
    const moduleUrl = new URL("../../src/runs/shared/session-record.ts", import.meta.url).href;
    const script = `
      import { acquireSessionLease } from ${JSON.stringify(moduleUrl)};
      const r = acquireSessionLease(${JSON.stringify(session)}, { runnerPid: process.pid },
        { lockOptions: { retryDelaysMs: [5,10,20,40,80,160,320,640] } });
      process.stdout.write(r.status);
      // Stay alive until the parent kills us, so the lease stays held while siblings race.
      setInterval(() => {}, 1000);
    `;
    const children: ChildProcess[] = [];
    try {
      // Contenders stay alive (script timer) until the finally block reaps them, so
      // a dead winner cannot be (correctly) taken over mid-race.
      const outputs = await Promise.all(
        Array.from(
          { length: 4 },
          () =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
              children.push(child);
              const timer = setTimeout(
                () => fail(new Error(`contender timed out; output=${JSON.stringify(out)}`)),
                scaleTestTimeout(15_000),
              );
              let out = "";
              let settled = false;
              const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
              };
              child.stdout!.on("data", (chunk: Buffer) => {
                out += chunk.toString();
                if (/^(acquired|held|busy)$/.test(out)) {
                  if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(out);
                  }
                } else if (!["acquired", "held", "busy"].some((word) => word.startsWith(out))) {
                  fail(new Error(`unexpected contender output ${JSON.stringify(out)}`));
                }
              });
              child.stderr!.on("data", (chunk: Buffer) =>
                fail(new Error(`contender stderr: ${chunk.toString()}`)),
              );
              child.on("error", fail);
              child.on("exit", (code, signal) => {
                fail(new Error(`contender exited early (${code ?? signal})`));
              });
            }),
        ),
      );
      const tally = (status: string) => outputs.filter((o) => o.startsWith(status)).length;
      assert.equal(tally("acquired"), 1, outputs.join(","));
      assert.equal(tally("held") + tally("busy"), 3, outputs.join(","));
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once("exit", () => resolve());
              child.kill("SIGKILL");
            }),
        ),
      );
    }
  });

  it("rejects a final-component symlink on create, acquire and read", () => {
    const target = path.join(dir, "target.jsonl");
    const alias = path.join(dir, "alias.jsonl");
    fs.symlinkSync(target, alias);
    assert.equal(createSessionRecord(alias).status, "unreadable");
    assert.equal(acquireSessionLease(alias, { runnerPid: 1 }).status, "unreadable");
    assert.equal(readSessionRecord(alias).status, "unreadable");
    assert.deepEqual(fs.readdirSync(dir), ["alias.jsonl"]);
  });

  it("re-checks session-file absence inside the sidecar lock", () => {
    const realMkdir = fs.mkdirSync;
    let injected = false;
    fsMutable.mkdirSync = ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const result = realMkdir(target, options as never);
      if (!injected && String(target).endsWith(".owner.json.lock")) {
        injected = true;
        fs.writeFileSync(session, "{}\n"); // Pi/another writer creates the file mid-create
      }
      return result;
    }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    try {
      const result = createSessionRecord(session, { requireSessionAbsent: true });
      assert.equal(injected, true, "the interleaving ran");
      assert.deepEqual(result, { status: "session-exists" });
      assert.equal(readSessionRecord(session).status, "missing");
    } finally {
      fsMutable.mkdirSync = realMkdir;
      syncBuiltinESMExports();
    }
  });

  describe("typed read failures", () => {
    const sidecar = () => `${fs.realpathSync(dir)}/${path.basename(session)}.owner.json`;
    it("missing", () => {
      assert.equal(readSessionRecord(session).status, "missing");
      assert.equal(readSessionRecord(path.join(dir, "nope", "s.jsonl")).status, "missing");
    });
    it("corrupt", () => {
      fs.writeFileSync(sidecar(), "{not json");
      assert.equal(readSessionRecord(session).status, "corrupt");
      fs.writeFileSync(sidecar(), JSON.stringify({ schemaVersion: 1, generation: -1 }));
      assert.equal(readSessionRecord(session).status, "corrupt");
      fs.writeFileSync(sidecar(), JSON.stringify({ generation: 1 }));
      assert.equal(readSessionRecord(session).status, "corrupt");
    });
    it("wrong-schema", () => {
      fs.writeFileSync(sidecar(), JSON.stringify({ schemaVersion: 2 }));
      assert.deepEqual(readSessionRecord(session), { status: "wrong-schema", schemaVersion: 2 });
    });
    it("unreadable", () => {
      fs.mkdirSync(sidecar()); // reading a directory fails with EISDIR, not ENOENT
      assert.equal(readSessionRecord(session).status, "unreadable");
    });
    it("never initializes over bad records and refuses to create over them", () => {
      fs.writeFileSync(sidecar(), "{not json");
      assert.equal(createSessionRecord(session).status, "exists");
      for (const result of [
        acquireSessionLease(session, { runnerPid: 1 }),
        updateSessionLease(session, { token: "t", generation: 1 }, {}),
        releaseSessionLease(session, { token: "t", generation: 1 }),
      ]) {
        assert.equal(result.status, "corrupt");
      }
      assert.equal(fs.readFileSync(sidecar(), "utf-8"), "{not json");
    });
  });
});
