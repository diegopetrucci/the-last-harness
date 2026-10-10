/**
 * Tests for the detached runtime-cleanup-runner.
 *
 * Unit tests use injectable deps for determinism; one subprocess test proves
 * the entrypoint still sweeps a stale dir and refreshes the marker.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { RUNTIME_CLEANUP_MARKER_NAME } from "../../src/extension/runtime-cleanup-constants.ts";
import { runCleanupRunner } from "../../src/extension/runtime-cleanup-runner.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerPath = path.join(projectRoot, "src", "extension", "runtime-cleanup-runner.ts");

function makeIsolatedRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-root-"));
}

function makeMarker(root: string, ageMsAgo: number): { markerPath: string; staleMtimeMs: number } {
  const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
  fs.writeFileSync(markerPath, "");
  const staleDate = new Date(Date.now() - ageMsAgo);
  fs.utimesSync(markerPath, staleDate, staleDate);
  const staleMtimeMs = fs.statSync(markerPath).mtimeMs;
  return { markerPath, staleMtimeMs };
}

function runRunner(
  tempRoot: string,
  opts: { runnerOverride?: string; cwdOverride?: string } = {},
): { exitCode: number | null; stderr: string } {
  const runner = opts.runnerOverride ?? runnerPath;
  const cwd = opts.cwdOverride ?? projectRoot;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", runner],
    {
      cwd,
      env: { ...process.env, PI_SUBAGENTS_TEMP_ROOT: tempRoot },
      encoding: "utf-8",
    },
  );
  return {
    exitCode: result.status,
    stderr: result.stderr ?? "",
  };
}

function createStaleAsyncDir(asyncDir: string, name: string, mtimeMs: number): void {
  const dirPath = path.join(asyncDir, name);
  fs.mkdirSync(dirPath, { recursive: true });
  // Write a terminal status so cleanupRuntimeDirs knows it's safe to remove
  fs.writeFileSync(
    path.join(dirPath, "status.json"),
    JSON.stringify({ state: "complete", runId: name, startedAt: 0 }),
  );
  const date = new Date(mtimeMs);
  fs.utimesSync(dirPath, date, date);
  fs.utimesSync(path.join(dirPath, "status.json"), date, date);
}

// ---------------------------------------------------------------------------
// Side-effect guard: importing the module must not run any cleanup or exit
// ---------------------------------------------------------------------------

it("importing runtime-cleanup-runner has no side effects", async () => {
  // If the module ran at import time it would have called process.exit() or
  // modified the file system. The mere fact that this file imported the module
  // above (and the test suite is still running) proves there are no side effects.
  // Verify the export is a function as an additional sanity check.
  assert.strictEqual(typeof runCleanupRunner, "function");
});

// ---------------------------------------------------------------------------
// Unit tests using injectable deps (deterministic, no subprocess)
// ---------------------------------------------------------------------------

describe("runCleanupRunner (unit, injectable deps)", () => {
  it("calls cleanup and refreshes the marker on success", () => {
    const root = makeIsolatedRoot();
    try {
      const { markerPath, staleMtimeMs } = makeMarker(root, 25 * ONE_DAY_MS);
      let cleanupCalled = false;
      const before = Date.now();

      let capturedExitCode: number | undefined;
      runCleanupRunner({
        cleanup: () => {
          cleanupCalled = true;
        },
        markerPath,
        now: () => Date.now(),
        exit: (code) => {
          capturedExitCode = code;
          throw new Error(`process.exit(${code})`);
        },
      });

      const after = Date.now();
      assert.ok(cleanupCalled, "cleanup should have been called");
      assert.strictEqual(capturedExitCode, undefined, "exit should not have been called");

      const newMtime = fs.statSync(markerPath).mtimeMs;
      assert.ok(newMtime > staleMtimeMs, "marker mtime should be updated after success");
      assert.ok(
        newMtime >= before - 2000 && newMtime <= after + 2000,
        `marker mtime should be approximately now (got ${newMtime}, window [${before - 2000}, ${after + 2000}])`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits non-zero and leaves marker mtime unchanged when cleanup throws", () => {
    const root = makeIsolatedRoot();
    try {
      const { markerPath, staleMtimeMs } = makeMarker(root, 25 * ONE_DAY_MS);

      let capturedExitCode: number | undefined;
      let threw = false;
      try {
        runCleanupRunner({
          cleanup: () => {
            throw new Error("injected cleanup failure");
          },
          markerPath,
          exit: (code) => {
            capturedExitCode = code;
            // Simulate process.exit by throwing so the function returns
            threw = true;
            throw new Error(`process.exit(${code})`);
          },
        });
      } catch {
        // Expected: our exit mock throws to stop execution
      }

      assert.ok(threw, "exit mock should have been called");
      assert.strictEqual(capturedExitCode, 1, "exit code should be 1 on cleanup failure");

      const markerMtimeAfter = fs.statSync(markerPath).mtimeMs;
      assert.strictEqual(
        markerMtimeAfter,
        staleMtimeMs,
        "marker mtime must be unchanged after runner failure",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Subprocess test: entrypoint wires up the real cleanupRuntimeDirs
// ---------------------------------------------------------------------------

describe("runtime-cleanup-runner (subprocess entrypoint)", () => {
  it("exits zero and refreshes the marker after a successful sweep", () => {
    const root = makeIsolatedRoot();
    try {
      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);

      fs.writeFileSync(markerPath, "");
      const staleDate = new Date(Date.now() - 25 * ONE_DAY_MS);
      fs.utimesSync(markerPath, staleDate, staleDate);
      const staleMtimeMs = fs.statSync(markerPath).mtimeMs;

      const before = Date.now();
      const { exitCode } = runRunner(root);
      const after = Date.now();

      assert.equal(exitCode, 0, "runner should exit zero on success");

      const newMtime = fs.statSync(markerPath).mtimeMs;
      assert.ok(newMtime > staleMtimeMs, "marker mtime should be updated after successful sweep");
      assert.ok(
        newMtime >= before - 2000 && newMtime <= after + 2000,
        `marker mtime should be approximately now (got ${newMtime}, window [${before - 2000}, ${after + 2000}])`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale async dirs via cleanupRuntimeDirs", () => {
    const root = makeIsolatedRoot();
    try {
      const asyncDir = path.join(root, "async-subagent-runs");
      fs.mkdirSync(asyncDir, { recursive: true });

      // Create a stale completed run (> 7 days old)
      const staleAge = 8 * ONE_DAY_MS;
      createStaleAsyncDir(asyncDir, "stale-run-1", Date.now() - staleAge);
      createStaleAsyncDir(asyncDir, "stale-run-2", Date.now() - staleAge);

      const { exitCode } = runRunner(root);
      assert.equal(exitCode, 0, "runner should exit zero");

      // Both stale dirs should have been removed
      const remaining = fs.existsSync(asyncDir) ? fs.readdirSync(asyncDir) : [];
      assert.equal(remaining.length, 0, "stale async dirs should be removed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("sweeps stale dir and refreshes marker when launched via a symlinked directory", () => {
    // Skip on Windows where symlink creation typically requires elevated rights.
    if (process.platform === "win32") return;

    // Create a symlink that points at the project root.
    const symlinkBase = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-symlink-"));
    const root = makeIsolatedRoot();
    try {
      const symlinkDir = path.join(symlinkBase, "link");
      fs.symlinkSync(projectRoot, symlinkDir);

      const markerPath = path.join(root, RUNTIME_CLEANUP_MARKER_NAME);
      const asyncDir = path.join(root, "async-subagent-runs");

      // Stale marker
      fs.writeFileSync(markerPath, "");
      const staleDate = new Date(Date.now() - 25 * ONE_DAY_MS);
      fs.utimesSync(markerPath, staleDate, staleDate);
      const staleMtimeMs = fs.statSync(markerPath).mtimeMs;

      // Stale async dir
      fs.mkdirSync(asyncDir, { recursive: true });
      createStaleAsyncDir(asyncDir, "stale-via-symlink", Date.now() - 8 * ONE_DAY_MS);

      // Launch the runner through the symlinked path
      const symlinkRunner = path.join(symlinkDir, "src", "extension", "runtime-cleanup-runner.ts");

      const before = Date.now();
      const { exitCode, stderr } = runRunner(root, {
        runnerOverride: symlinkRunner,
        // Keep cwd as real project root so register-loader.mjs resolves correctly
        cwdOverride: projectRoot,
      });
      const after = Date.now();

      assert.equal(exitCode, 0, `runner via symlink should exit zero (stderr: ${stderr})`);

      // Stale dir must be gone
      const remaining = fs.existsSync(asyncDir) ? fs.readdirSync(asyncDir) : [];
      assert.equal(
        remaining.length,
        0,
        "stale async dir should be removed when launched via symlink",
      );

      // Marker must be refreshed
      const newMtime = fs.statSync(markerPath).mtimeMs;
      assert.ok(
        newMtime > staleMtimeMs,
        "marker mtime should be updated when launched via symlink",
      );
      assert.ok(
        newMtime >= before - 2000 && newMtime <= after + 2000,
        `marker mtime should be approximately now (got ${newMtime})`,
      );
    } finally {
      fs.rmSync(symlinkBase, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
