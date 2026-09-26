import assert from "node:assert/strict";
import { spawn as childSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  findLeaks,
  main,
  signalExitCode,
  TMPDIR_ALLOWLIST,
  runWithTmpdirGuard,
} from "../scripts/run-test-tmpdir-guard.mjs";

// Absolute path to the guard script — used by subprocess signal tests to
// construct harness code that imports it by absolute path.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const guardScriptPath = resolve(__dirname, "../scripts/run-test-tmpdir-guard.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const _tmpDirs = [];
after(() => {
  for (const d of _tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tlh-guard-test-"));
  _tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// TMPDIR_ALLOWLIST
// ---------------------------------------------------------------------------

test("TMPDIR_ALLOWLIST is a non-empty array", () => {
  assert.ok(Array.isArray(TMPDIR_ALLOWLIST));
  assert.ok(TMPDIR_ALLOWLIST.length > 0);
});

test("TMPDIR_ALLOWLIST includes jiti", () => {
  assert.ok(TMPDIR_ALLOWLIST.includes("jiti"));
});

// ---------------------------------------------------------------------------
// findLeaks
// ---------------------------------------------------------------------------

test("findLeaks returns empty array for an empty directory", () => {
  const dir = tempDir();
  assert.deepEqual(findLeaks(dir), []);
});

test("findLeaks returns empty array when only allowlisted entries are present", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "jiti"));
  assert.deepEqual(findLeaks(dir), []);
});

test("findLeaks returns the leaked entry name", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "leaked-dir"));
  assert.deepEqual(findLeaks(dir), ["leaked-dir"]);
});

test("findLeaks reports files as well as directories", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "leaked-file.txt"), "oops");
  assert.deepEqual(findLeaks(dir), ["leaked-file.txt"]);
});

test("findLeaks excludes allowlisted entries and reports only leaked ones", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "jiti"));
  mkdirSync(join(dir, "leaked-a"));
  mkdirSync(join(dir, "leaked-b"));
  const leaks = findLeaks(dir);
  assert.deepEqual(leaks, ["leaked-a", "leaked-b"]);
});

test("findLeaks returns results in sorted order", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "zzz"));
  mkdirSync(join(dir, "aaa"));
  mkdirSync(join(dir, "mmm"));
  assert.deepEqual(findLeaks(dir), ["aaa", "mmm", "zzz"]);
});

test("findLeaks accepts a custom allowlist", () => {
  const dir = tempDir();
  mkdirSync(join(dir, "custom-allowed"));
  mkdirSync(join(dir, "leaked-entry"));
  const leaks = findLeaks(dir, ["custom-allowed"]);
  assert.deepEqual(leaks, ["leaked-entry"]);
});

test("findLeaks returns empty array when the directory does not exist", () => {
  assert.deepEqual(findLeaks(join(tmpdir(), "tlh-nonexistent-guard-dir-xyz")), []);
});

// ---------------------------------------------------------------------------
// runWithTmpdirGuard — behaviour via injectable spawn
//
// The guard now uses async child_process.spawn. The injectable spawn option
// must return a ChildProcess-like EventEmitter with a kill() method. The
// fakeChild/fakeSpawn helpers satisfy this interface synchronously.
// ---------------------------------------------------------------------------

/**
 * Build a fake ChildProcess-like EventEmitter that emits 'close' asynchronously.
 *
 * @param {number | null} code
 * @param {string | null} signal
 */
function fakeChild(code = 0, signal = null) {
  const child = new EventEmitter();
  child.kill = (_sig) => {};
  setImmediate(() => child.emit("close", code, signal));
  return child;
}

/**
 * Build a minimal fake spawn that records calls and returns a fixed result
 * per invocation (adapted for the async ChildProcess API).
 *
 * @param {Array<{ code?: number; signal?: string | null }>} results
 */
function fakeSpawn(results) {
  const calls = [];
  function spawn(cmd, args, _opts) {
    const { code = 0, signal = null } = results[calls.length] ?? {};
    calls.push({ cmd, args });
    return fakeChild(code, signal);
  }
  spawn.calls = calls;
  return spawn;
}

test("runWithTmpdirGuard returns 0 when both suites pass and no leaks occur", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 0);
  assert.equal(spawn.calls.length, 2);
});

test("runWithTmpdirGuard preserves non-zero exit from root Node tests", async () => {
  const spawn = fakeSpawn([{ code: 7 }]);
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 7);
  // subagents must not run when root tests fail
  assert.equal(spawn.calls.length, 1);
});

test("runWithTmpdirGuard skips subagent suite when root tests fail", async () => {
  const spawn = fakeSpawn([{ code: 1 }]);
  await runWithTmpdirGuard({ spawn });
  assert.equal(spawn.calls.length, 1);
});

test("runWithTmpdirGuard preserves non-zero exit from subagent suite", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 3 }]);
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 3);
});

test("runWithTmpdirGuard passes --test-reporter=dot when dot flag is set", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  await runWithTmpdirGuard({ dot: true, spawn });
  const [mainCall] = spawn.calls;
  assert.ok(mainCall.args.includes("--test-reporter=dot"));
});

test("runWithTmpdirGuard omits --test-reporter=dot when dot flag is not set", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  await runWithTmpdirGuard({ dot: false, spawn });
  const [mainCall] = spawn.calls;
  assert.ok(!mainCall.args.includes("--test-reporter=dot"));
});

test("runWithTmpdirGuard sets TMPDIR/TMP/TEMP in child env", async () => {
  /** @type {Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined> }>} */
  const calls = [];
  function spawn(cmd, args, opts) {
    calls.push({ cmd, args, env: opts?.env });
    return fakeChild(0);
  }
  await runWithTmpdirGuard({ spawn });
  for (const call of calls) {
    assert.ok(typeof call.env?.TMPDIR === "string" && call.env.TMPDIR.length > 0);
    assert.equal(call.env?.TMPDIR, call.env?.TMP);
    assert.equal(call.env?.TMPDIR, call.env?.TEMP);
  }
});

test("runWithTmpdirGuard removes the per-run root even when tests fail", async () => {
  let capturedRoot;
  function spawn(_cmd, _args, opts) {
    capturedRoot = opts?.env?.TMPDIR;
    return fakeChild(1);
  }
  await runWithTmpdirGuard({ spawn });
  assert.ok(capturedRoot, "expected TMPDIR to be captured");
  assert.equal(existsSync(capturedRoot), false, "per-run root must be removed");
});

test("runWithTmpdirGuard maps a signal-killed child to the conventional exit code", async () => {
  // When the child is killed by a signal the guard should return 128+signal_number.
  const spawn = fakeSpawn([{ code: null, signal: "SIGINT" }]);
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 130);
});

test("runWithTmpdirGuard returns 1 for a deliberately leaked directory", async () => {
  function spawn(_cmd, _args, opts) {
    // Create a leaked entry in the guard TMPDIR
    const root = opts?.env?.TMPDIR;
    if (root) mkdirSync(join(root, "deliberate-leak"), { recursive: true });
    return fakeChild(0);
  }
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// signalExitCode
// ---------------------------------------------------------------------------

test("signalExitCode maps SIGINT to 130", () => {
  // SIGINT is signal 2 on every POSIX platform; 128+2=130.
  assert.equal(signalExitCode("SIGINT"), 130);
});

test("signalExitCode maps SIGTERM to 143", () => {
  // SIGTERM is signal 15 on every POSIX platform; 128+15=143.
  assert.equal(signalExitCode("SIGTERM"), 143);
});

test("signalExitCode maps an unknown signal to 128", () => {
  assert.equal(signalExitCode("SIGUNKNOWN"), 128);
});

test("signalExitCode uses os.constants.signals for platform-specific signals", () => {
  // SIGUSR1 and SIGUSR2 differ between Linux (10, 12) and macOS (30, 31).
  // Verify the implementation delegates to os.constants.signals rather than
  // a hard-coded table so the exit codes are correct on every platform.
  for (const name of ["SIGUSR1", "SIGUSR2", "SIGBUS", "SIGALRM"]) {
    const platformNum = osConstants.signals[name];
    if (platformNum === undefined) continue; // signal not available on this platform
    assert.equal(
      signalExitCode(name),
      128 + platformNum,
      `${name}: expected 128+${platformNum}=${128 + platformNum}`,
    );
  }
});

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

test("main passes --dot flag through to runWithTmpdirGuard", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  await main(["--dot"], { spawn });
  const [mainCall] = spawn.calls;
  assert.ok(
    mainCall.args.includes("--test-reporter=dot"),
    "--dot should forward --test-reporter=dot",
  );
});

test("main omits --test-reporter=dot when --dot is absent", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  await main([], { spawn });
  const [mainCall] = spawn.calls;
  assert.ok(
    !mainCall.args.includes("--test-reporter=dot"),
    "no --dot should omit --test-reporter=dot",
  );
});

// ---------------------------------------------------------------------------
// Real subprocess signal tests
//
// These tests launch a small harness process (via node --input-type=module
// with piped stdin) that invokes runWithTmpdirGuard with an injected spawn.
// The injected spawn starts a long-running child and writes "ready:<pid>\n"
// to stdout after the child's 'spawn' event fires. The test polls for that
// marker, extracts the child PID, sends the required signal(s) to the
// harness, waits for it to finish, then asserts:
//   - exit code matches expectedCode
//   - child PID is gone (process.kill(pid,0) throws ESRCH)
//   - no tlh-test-run-* dirs were leaked
// Each test is wrapped in try/finally that kills any surviving processes.
// ---------------------------------------------------------------------------

/**
 * Build ESM harness source code. The inner child runs childScript.
 *
 * readyViaChildStdout=false (default): harness announces "ready:<pid>" after
 * the child's 'spawn' event. Suitable when the child will die on the first
 * signal (default SIGINT/SIGTERM disposition).
 *
 * readyViaChildStdout=true: inner child's stdout is piped; harness announces
 * only after it receives the first byte from the child. The child script must
 * write something to stdout once its signal handlers are registered. Use this
 * when the child must survive the first signal (e.g. SIGINT ignored).
 *
 * @param {string} [childScript]
 * @param {{ readyViaChildStdout?: boolean }} [opts]
 */
function buildHarnessCode(
  childScript = "setTimeout(()=>{},30000)",
  { readyViaChildStdout = false } = {},
) {
  const childStdio = readyViaChildStdout
    ? '["ignore","pipe","ignore"]'
    : '["ignore","ignore","ignore"]';
  const announceBlock = readyViaChildStdout
    ? [
        `    child.stdout.once("data", () => {`,
        `      process.stdout.write("ready:" + child.pid + "\\n");`,
        `    });`,
      ].join("\n")
    : [
        `    child.once("spawn", () => {`,
        `      process.stdout.write("ready:" + child.pid + "\\n");`,
        `    });`,
      ].join("\n");

  return [
    `import { runWithTmpdirGuard } from ${JSON.stringify(guardScriptPath)};`,
    `import { spawn as nodeSpawn } from "node:child_process";`,
    `let announced = false;`,
    `const customSpawn = (cmd, args, opts) => {`,
    `  const child = nodeSpawn(`,
    `    process.execPath,`,
    `    ["-e", ${JSON.stringify(childScript)}],`,
    `    { ...opts, stdio: ${childStdio} }`,
    `  );`,
    `  if (!announced) {`,
    `    announced = true;`,
    announceBlock,
    `  }`,
    `  return child;`,
    `};`,
    `const code = await runWithTmpdirGuard({ spawn: customSpawn });`,
    `process.exitCode = code;`,
  ].join("\n");
}

/**
 * Spawn the harness, wait for "ready:<pid>", run signalFn, wait for exit,
 * then assert exit code, child gone, and no leaked tlh-test-run-* dirs.
 *
 * @param {number} expectedCode
 * @param {string} harnessCode
 * @param {(harness: import("node:child_process").ChildProcess) => Promise<void>} signalFn
 */
async function runHarnessTest(expectedCode, harnessCode, signalFn) {
  const harnessTmpdir = mkdtempSync(join(tmpdir(), "tlh-sig-test-"));
  _tmpDirs.push(harnessTmpdir);

  /** @type {import("node:child_process").ChildProcess | null} */
  let harness = null;
  let childPid = /** @type {number | null} */ (null);

  try {
    harness = childSpawn(process.execPath, ["--input-type=module"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMPDIR: harnessTmpdir, TMP: harnessTmpdir, TEMP: harnessTmpdir },
    });
    harness.stdin.end(harnessCode);

    let stderrBuf = "";
    harness.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    // Wait for "ready:<pid>" marker emitted after child's 'spawn' event.
    childPid = await new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = "";
      harness.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const m = stdoutBuf.match(/ready:(\d+)\n/);
        if (m && !settled) {
          settled = true;
          resolve(parseInt(m[1], 10));
        }
      });
      harness.once("close", (code) => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `Harness exited (code=${code}) before writing "ready:<pid>".\nstderr:\n${stderrBuf}`,
            ),
          );
        }
      });
    });

    // Run caller-defined signal sequence.
    await signalFn(harness);

    // Wait for the harness to finish.
    const exitCode = await new Promise((resolve) => {
      harness.once("close", (code) => resolve(code));
    });

    assert.equal(exitCode, expectedCode, `Guard must exit ${expectedCode}.\nstderr:\n${stderrBuf}`);

    // Child process must be gone.
    assert.throws(
      () => process.kill(childPid, 0),
      { code: "ESRCH" },
      `Child process ${childPid} must not be alive after guard exits`,
    );

    // No tlh-test-run-* dirs should remain.
    const leaked = readdirSync(harnessTmpdir).filter((e) => e.startsWith("tlh-test-run-"));
    assert.deepEqual(
      leaked,
      [],
      `No tlh-test-run-* dirs should remain in TMPDIR.\nstderr:\n${stderrBuf}`,
    );
  } finally {
    // Kill the harness if it is still alive (e.g. an assertion threw early).
    harness?.kill("SIGKILL");
    // Kill the child PID if still alive.
    if (childPid !== null) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // ESRCH means already gone — expected in normal flow.
      }
    }
  }
}

test("guard exits 130 and removes per-run root on SIGINT", { timeout: 8000 }, async () => {
  await runHarnessTest(130, buildHarnessCode(), async (harness) => {
    harness.kill("SIGINT");
  });
});

test("guard exits 143 and removes per-run root on SIGTERM", { timeout: 8000 }, async () => {
  await runHarnessTest(143, buildHarnessCode(), async (harness) => {
    harness.kill("SIGTERM");
  });
});

test(
  "guard escalates to SIGKILL and exits 130 when child ignores SIGINT and second SIGINT arrives",
  { timeout: 8000 },
  async () => {
    // Child registers a no-op SIGINT handler so the first forwarded SIGINT is
    // ignored, keeping the child alive. The second SIGINT sent to the guard
    // triggers SIGKILL escalation, terminating the child immediately.
    //
    // We use readyViaChildStdout=true so the harness announces "ready:<pid>"
    // only AFTER the child writes to its stdout — which happens after
    // process.on('SIGINT') is registered. This avoids the race where 'spawn'
    // fires before the child's SIGINT handler is set up, causing the child to
    // exit on the first forwarded SIGINT via the default disposition.
    const childScript =
      "process.on('SIGINT',()=>{}); process.stdout.write('r'); setTimeout(()=>{},30000)";
    await runHarnessTest(
      130,
      buildHarnessCode(childScript, { readyViaChildStdout: true }),
      async (harness) => {
        // First SIGINT: guard records it and forwards to child (child ignores it).
        harness.kill("SIGINT");
        // Brief pause so the guard's event loop processes the first signal and
        // sets pendingSignal before the second arrives (POSIX standard signals
        // are not queued, so rapid delivery could collapse into one).
        await new Promise((r) => setTimeout(r, 100));
        // Second SIGINT: guard escalates to SIGKILL.
        harness.kill("SIGINT");
      },
    );
  },
);
