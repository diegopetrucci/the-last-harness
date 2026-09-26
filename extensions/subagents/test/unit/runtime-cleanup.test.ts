import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { cleanupRuntimeDirs, inspectRuntimeDirs } from "../../src/extension/runtime-cleanup.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

function tempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setTreeMtime(targetPath: string, mtimeMs: number): void {
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath))
      setTreeMtime(path.join(targetPath, entry), mtimeMs);
  }
  const time = new Date(mtimeMs);
  fs.utimesSync(targetPath, time, time);
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function writeRawStatus(asyncDir: string, status: unknown): void {
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
}

function writeRoute(nestedEventsDir: string, rootRunId: string, suffix: string): string {
  const routeDir = path.join(nestedEventsDir, `${rootRunId}-${suffix}`);
  fs.mkdirSync(path.join(routeDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(routeDir, "controls"), { recursive: true });
  fs.writeFileSync(
    path.join(routeDir, "route.json"),
    JSON.stringify({ rootRunId, capabilityToken: suffix }, null, 2),
    "utf-8",
  );
  return routeDir;
}

function createPaths(root: string): {
  asyncDir: string;
  nestedRunsDir: string;
  nestedEventsDir: string;
} {
  return {
    asyncDir: path.join(root, "async-subagent-runs"),
    nestedRunsDir: path.join(root, "nested-subagent-runs"),
    nestedEventsDir: path.join(root, "nested-subagent-events"),
  };
}

describe("runtime cleanup", () => {
  it("removes stale async dirs while preserving active and paused runs", () => {
    const root = tempRoot("pi-runtime-cleanup-async-");
    const now = 9 * ONE_DAY_MS;
    const paths = createPaths(root);
    try {
      const staleEmptyDir = path.join(paths.asyncDir, "stale-empty");
      fs.mkdirSync(staleEmptyDir, { recursive: true });
      setTreeMtime(staleEmptyDir, now - 2 * ONE_DAY_MS);

      const staleCompleteDir = path.join(paths.asyncDir, "stale-complete");
      writeStatus(staleCompleteDir, {
        runId: "stale-complete",
        mode: "single",
        state: "complete",
        startedAt: now - 10 * ONE_DAY_MS,
        endedAt: now - 8 * ONE_DAY_MS,
      });
      setTreeMtime(staleCompleteDir, now - 8 * ONE_DAY_MS);

      const pausedDir = path.join(paths.asyncDir, "paused-run");
      writeStatus(pausedDir, {
        runId: "paused-run",
        mode: "single",
        state: "paused",
        startedAt: now - 20 * ONE_DAY_MS,
        lastUpdate: now - 20 * ONE_DAY_MS,
      });
      setTreeMtime(pausedDir, now - 20 * ONE_DAY_MS);

      const runningDir = path.join(paths.asyncDir, "running-run");
      writeStatus(runningDir, {
        runId: "running-run",
        mode: "single",
        state: "running",
        startedAt: now - ONE_DAY_MS,
        lastUpdate: now - 1000,
      });

      const result = cleanupRuntimeDirs(paths, { now: () => now, kill: () => true });
      assert.equal(result.removedAsyncDirs, 2);
      assert.equal(fs.existsSync(staleEmptyDir), false);
      assert.equal(fs.existsSync(staleCompleteDir), false);
      assert.equal(fs.existsSync(pausedDir), true);
      assert.equal(fs.existsSync(runningDir), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats JSON null as missing status but retains invalid primitive and array status", () => {
    const root = tempRoot("pi-runtime-cleanup-status-shapes-");
    const now = 3 * ONE_DAY_MS;
    const paths = createPaths(root);
    const staleAt = now - 2 * ONE_DAY_MS;
    try {
      const staleNullDir = path.join(paths.asyncDir, "stale-null");
      writeRawStatus(staleNullDir, null);
      setTreeMtime(staleNullDir, staleAt);

      const recentNullDir = path.join(paths.asyncDir, "recent-null");
      writeRawStatus(recentNullDir, null);
      setTreeMtime(recentNullDir, now - 12 * 60 * 60 * 1000);

      const invalidDirs = [
        ["stale-array", []],
        ["stale-string", "complete"],
        ["stale-number", 1],
      ] as const;
      for (const [name, status] of invalidDirs) {
        const dir = path.join(paths.asyncDir, name);
        writeRawStatus(dir, status);
        setTreeMtime(dir, staleAt);
      }

      const result = cleanupRuntimeDirs(paths, { now: () => now, kill: () => true });
      assert.equal(result.removedAsyncDirs, 1);
      assert.equal(fs.existsSync(staleNullDir), false);
      assert.equal(fs.existsSync(recentNullDir), true);
      for (const [name] of invalidDirs) {
        assert.equal(fs.existsSync(path.join(paths.asyncDir, name)), true, name);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the exhaustive lifecycle and PID retention policy", () => {
    const root = tempRoot("pi-runtime-cleanup-policy-");
    const now = 10 * ONE_DAY_MS;
    const staleAt = now - (SEVEN_DAYS_MS + ONE_DAY_MS);
    const recentAt = now - (SEVEN_DAYS_MS - ONE_DAY_MS);
    const paths = createPaths(root);
    const staleDirs: string[] = [];
    const retainedDirs: string[] = [];
    const pidOutcomes = new Map<number, "alive" | "dead" | "unknown">([
      [101, "alive"],
      [102, "unknown"],
      [103, "dead"],
      [104, "dead"],
      [105, "dead"],
      [106, "dead"],
    ]);

    const kill = (pid: number): boolean => {
      const outcome = pidOutcomes.get(pid);
      if (outcome === "dead") throw Object.assign(new Error("dead"), { code: "ESRCH" });
      if (outcome === "unknown") throw Object.assign(new Error("unknown"), { code: "EPERM" });
      return true;
    };
    const createRun = (
      name: string,
      state: string,
      mtimeMs: number,
      options: { pid?: number; activityState?: string; timestamps?: boolean } = {},
    ): string => {
      const dir = path.join(paths.asyncDir, name);
      writeStatus(dir, {
        runId: name,
        mode: "single",
        state,
        ...(options.pid !== undefined ? { pid: options.pid } : {}),
        ...(options.activityState ? { activityState: options.activityState } : {}),
        ...(options.timestamps === false ? {} : { startedAt: mtimeMs, lastUpdate: mtimeMs }),
      });
      setTreeMtime(dir, mtimeMs);
      return dir;
    };

    try {
      for (const state of ["complete", "failed", "cancelled", "continued"]) {
        staleDirs.push(
          createRun(`stale-${state}`, state, staleAt, {
            pid: 101,
            activityState: "needs_attention",
            timestamps: false,
          }),
        );
      }
      retainedDirs.push(
        createRun("recent-cancelled", "cancelled", recentAt, {
          activityState: "needs_attention",
        }),
      );
      retainedDirs.push(
        createRun("recent-continued", "continued", recentAt, {
          activityState: "needs_attention",
        }),
      );

      // Paused records are resumable even when their owner is dead and all
      // lifecycle timestamps are absent.
      retainedDirs.push(createRun("paused", "paused", staleAt, { pid: 103, timestamps: false }));

      staleDirs.push(createRun("stale-queued-dead", "queued", staleAt, { pid: 104 }));
      staleDirs.push(
        createRun("stale-running-ownerless", "running", staleAt, { timestamps: false }),
      );
      staleDirs.push(createRun("stale-pausing-dead", "pausing", staleAt, { pid: 105 }));

      // Live and indeterminate owners are retained regardless of age.
      retainedDirs.push(createRun("live-queued", "queued", staleAt, { pid: 101 }));
      retainedDirs.push(createRun("unknown-running", "running", staleAt, { pid: 102 }));
      // Dead and ownerless active records receive the same seven-day grace as
      // terminal records before becoming cleanup-eligible.
      retainedDirs.push(createRun("recent-dead-pausing", "pausing", recentAt, { pid: 106 }));
      retainedDirs.push(createRun("recent-ownerless-queued", "queued", recentAt));

      // Unknown lifecycle states remain retained rather than being guessed stale.
      retainedDirs.push(createRun("unknown-state", "future", staleAt, { pid: 103 }));

      const result = cleanupRuntimeDirs(paths, { now: () => now, kill });
      assert.equal(result.removedAsyncDirs, staleDirs.length);
      for (const dir of staleDirs) assert.equal(fs.existsSync(dir), false, dir);
      for (const dir of retainedDirs) assert.equal(fs.existsSync(dir), true, dir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not age out a recent directory for malformed lifecycle timestamps", () => {
    const root = tempRoot("pi-runtime-cleanup-malformed-timestamps-");
    const now = 10 * ONE_DAY_MS;
    const recentAt = now - ONE_DAY_MS;
    const paths = createPaths(root);
    const recentDir = path.join(paths.asyncDir, "recent-malformed-timestamps");
    try {
      writeStatus(recentDir, {
        runId: "recent-malformed-timestamps",
        mode: "single",
        state: "failed",
        startedAt: "not-a-timestamp",
        lastUpdate: "also-not-a-timestamp",
        endedAt: "still-not-a-timestamp",
      });
      setTreeMtime(recentDir, recentAt);

      const result = cleanupRuntimeDirs(paths, { now: () => now, kill: () => true });
      assert.equal(result.removedAsyncDirs, 0);
      assert.equal(fs.existsSync(recentDir), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports runtime dir counts and unreferenced nested event routes", () => {
    const root = tempRoot("pi-runtime-cleanup-counts-");
    const now = Date.now();
    const paths = createPaths(root);
    try {
      writeStatus(path.join(paths.asyncDir, "run-live"), {
        runId: "run-live",
        mode: "single",
        state: "running",
        pid: process.pid,
        startedAt: now - 1000,
        lastUpdate: now - 500,
      });
      writeStatus(path.join(paths.nestedRunsDir, "run-live", "child-1"), {
        runId: "child-1",
        mode: "single",
        state: "failed",
        startedAt: now - 10 * ONE_DAY_MS,
        endedAt: now - 8 * ONE_DAY_MS,
      });
      setTreeMtime(path.join(paths.nestedRunsDir, "run-live", "child-1"), now - 8 * ONE_DAY_MS);
      writeRoute(paths.nestedEventsDir, "run-live", "kept");
      const staleRoute = writeRoute(paths.nestedEventsDir, "gone-root", "stale");
      setTreeMtime(staleRoute, now - 2 * ONE_DAY_MS);

      const inspectedPids: number[] = [];
      const counts = inspectRuntimeDirs(paths, {
        now: () => now,
        kill: (pid) => {
          inspectedPids.push(pid);
          return true;
        },
      });
      assert.deepEqual(inspectedPids, [process.pid]);
      assert.equal(counts.topLevelAsyncDirs, 1);
      assert.equal(counts.nestedAsyncDirs, 1);
      assert.equal(counts.retainedAsyncDirs, 1);
      assert.equal(counts.activeOrLiveAsyncDirs, 1);
      assert.equal(counts.staleAsyncDirs, 1);
      assert.equal(counts.nestedEventDirs, 2);
      assert.equal(counts.unreferencedNestedEventDirs, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
