/**
 * Tests for the detached runtime-cleanup scheduler in registerSubagentExtension.
 *
 * Validates marker-throttle logic and spawn-failure resilience without
 * launching real detached cleanup children.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { scheduleDetachedRuntimeCleanup, type SpawnRunnerFn } from "../../src/extension/index.ts";
import { RUNTIME_CLEANUP_MARKER_NAME } from "../../src/extension/runtime-cleanup-constants.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-detached-cleanup-test-"));
}

interface SpawnCall {
  command: string;
  args: string[];
}

function recordingSpawn(calls: SpawnCall[]): SpawnRunnerFn {
  return (command, args) => {
    calls.push({ command: String(command), args: Array.from(args) });
    const proc = {
      on(_event: string, _handler: (err: Error) => void) {
        return proc;
      },
      unref() {},
    };
    return proc;
  };
}

function throwingSpawn(): SpawnRunnerFn {
  return () => {
    throw new Error("spawn ENOENT");
  };
}

function errorEmittingSpawn(): SpawnRunnerFn {
  return (_command, _args) => {
    let errorHandler: ((err: Error) => void) | undefined;
    const proc = {
      on(event: string, handler: (err: Error) => void) {
        if (event === "error") errorHandler = handler;
        return proc;
      },
      unref() {
        // Simulate async error after unref (like ENOENT on detached spawn)
        setImmediate(() => errorHandler?.(new Error("spawn ENOENT")));
      },
    };
    return proc;
  };
}

describe("scheduleDetachedRuntimeCleanup", () => {
  it("spawns when marker is missing", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const calls: SpawnCall[] = [];
      const now = Date.now();

      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn(calls),
        markerPath,
      });

      assert.equal(calls.length, 1, "should spawn exactly once when marker is missing");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("backdates the marker as a short lease before spawning", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn([]),
        markerPath,
      });

      const stat = fs.statSync(markerPath);
      // Lease = now - (24h - 10min) = 10min before the 24h boundary
      const expectedMtime = now - (ONE_DAY_MS - TEN_MIN_MS);
      assert.ok(
        Math.abs(stat.mtimeMs - expectedMtime) < 2000,
        `marker mtime should be near the lease time (got ${stat.mtimeMs}, expected ~${expectedMtime})`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not spawn when marker is fresh (just written)", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      // Write a fresh marker (age = 0)
      fs.writeFileSync(markerPath, "");
      const freshDate = new Date(now);
      fs.utimesSync(markerPath, freshDate, freshDate);

      const calls: SpawnCall[] = [];
      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn(calls),
        markerPath,
      });

      assert.equal(calls.length, 0, "should not spawn when marker is fresh");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not spawn when marker is within the 24h window", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      // Marker is 12h old (within 24h window)
      fs.writeFileSync(markerPath, "");
      const markerTime = new Date(now - 12 * 60 * 60 * 1000);
      fs.utimesSync(markerPath, markerTime, markerTime);

      const calls: SpawnCall[] = [];
      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn(calls),
        markerPath,
      });

      assert.equal(calls.length, 0, "should not spawn when marker is within 24h window");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("spawns when marker is stale (older than 24h)", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      // Marker is 25h old (stale)
      fs.writeFileSync(markerPath, "");
      const staleDate = new Date(now - 25 * 60 * 60 * 1000);
      fs.utimesSync(markerPath, staleDate, staleDate);

      const calls: SpawnCall[] = [];
      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn(calls),
        markerPath,
      });

      assert.equal(calls.length, 1, "should spawn when marker is stale");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a future marker mtime as stale and spawns", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      // Marker mtime is in the future (e.g. clock skew)
      fs.writeFileSync(markerPath, "");
      const futureDate = new Date(now + 60 * 60 * 1000);
      fs.utimesSync(markerPath, futureDate, futureDate);

      const calls: SpawnCall[] = [];
      scheduleDetachedRuntimeCleanup({
        now: () => now,
        spawnFn: recordingSpawn(calls),
        markerPath,
      });

      assert.equal(calls.length, 1, "should spawn when marker mtime is in the future");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("repeated calls within the lease window do not spawn again", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      const calls: SpawnCall[] = [];
      const spawnFn = recordingSpawn(calls);

      // First call: marker missing → spawns and writes lease
      scheduleDetachedRuntimeCleanup({ now: () => now, spawnFn, markerPath });
      assert.equal(calls.length, 1, "first call should spawn");

      // Second call at same time: lease is fresh (age ≈ 23h50min < 24h) → no spawn
      scheduleDetachedRuntimeCleanup({ now: () => now, spawnFn, markerPath });
      assert.equal(calls.length, 1, "second call within lease window should not spawn");

      // Third call 5 min later: still within 10-min lease → no spawn
      scheduleDetachedRuntimeCleanup({ now: () => now + 5 * 60 * 1000, spawnFn, markerPath });
      assert.equal(calls.length, 1, "call 5min after lease write should not spawn");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("retries after the lease window (10min) expires", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      const calls: SpawnCall[] = [];
      const spawnFn = recordingSpawn(calls);

      // First call: spawns
      scheduleDetachedRuntimeCleanup({ now: () => now, spawnFn, markerPath });
      assert.equal(calls.length, 1, "first call should spawn");

      // Call 10min + 1ms later: lease has expired → spawns again
      scheduleDetachedRuntimeCleanup({
        now: () => now + TEN_MIN_MS + 1,
        spawnFn,
        markerPath,
      });
      assert.equal(calls.length, 2, "call after lease expiry should spawn again");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw when spawn throws synchronously", () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      assert.doesNotThrow(() => {
        scheduleDetachedRuntimeCleanup({
          now: () => now,
          spawnFn: throwingSpawn(),
          markerPath,
        });
      }, "sync spawn failure must not throw from scheduleDetachedRuntimeCleanup");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not throw when the spawned process emits an error event", async () => {
    const root = tempDir();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const now = Date.now();

      assert.doesNotThrow(() => {
        scheduleDetachedRuntimeCleanup({
          now: () => now,
          spawnFn: errorEmittingSpawn(),
          markerPath,
        });
      }, "scheduleDetachedRuntimeCleanup itself must not throw on error-emitting spawn");

      // Let the setImmediate fire (simulated async 'error' event)
      await new Promise<void>((resolve) => setImmediate(resolve));

      // No uncaught exception should have been thrown (test runner would catch it)
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: importing / registering the extension must NOT sweep stale dirs
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("extension import must not run cleanup synchronously", () => {
  it("stale complete run dir survives a full registerSubagentExtension call (fresh marker)", () => {
    // Reproduce the original bug: if index.ts imports runtime-cleanup-runner.ts,
    // its top-level run() call sweeps stale dirs in the parent process.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-regression-cleanup-"));
    const asyncDir = path.join(root, "async-subagent-runs");
    const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);

    try {
      // Create a stale completed run dir (8 days old — past the 7-day terminal window)
      const staleRunDir = path.join(asyncDir, "stale-regression-run");
      fs.mkdirSync(staleRunDir, { recursive: true });
      fs.writeFileSync(
        path.join(staleRunDir, "status.json"),
        JSON.stringify({ state: "complete", runId: "stale-regression-run", startedAt: 0 }),
      );
      const eightDaysAgo = new Date(Date.now() - 8 * ONE_DAY_MS);
      fs.utimesSync(path.join(staleRunDir, "status.json"), eightDaysAgo, eightDaysAgo);
      fs.utimesSync(staleRunDir, eightDaysAgo, eightDaysAgo);

      // Seed a fresh marker so scheduleDetachedRuntimeCleanup is a no-op
      fs.writeFileSync(markerPath, "");

      // Register the extension in a subprocess with our isolated root
      const script = String.raw`
        import registerSubagentExtension from "./src/extension/index.ts";
        const events = { on() { return () => {}; }, emit() {} };
        const fakePi = new Proxy({
          events,
          registerTool() {},
          registerCommand() {},
          registerShortcut() {},
          registerMessageRenderer() {},
          sendMessage() {},
          getSessionName() { return undefined; },
        }, { get(t, p) { return p in t ? t[p] : () => undefined; } });
        registerSubagentExtension(fakePi);
      `;

      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          "./test/support/register-loader.mjs",
          "--input-type=module",
          "--eval",
          script,
        ],
        { cwd: projectRoot, env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: root }, stdio: "pipe" },
      );

      // The stale dir must NOT have been removed — no in-process sweep
      assert.ok(
        fs.existsSync(staleRunDir),
        "stale run dir was unexpectedly removed during extension registration (synchronous cleanup bug)",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
