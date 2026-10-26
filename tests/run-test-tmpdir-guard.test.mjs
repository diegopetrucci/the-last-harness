import assert from "node:assert/strict";
import { spawn as childSpawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  parseTestConcurrency,
  resolveTestConcurrency,
  testConcurrencyArgs,
} from "../scripts/test-concurrency.mjs";
import { isProcessAlive as processIsAlive } from "./process-liveness.mjs";

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
// Shared test concurrency policy
// ---------------------------------------------------------------------------

test("test concurrency policy projects an explicit override", () => {
  assert.deepEqual(
    testConcurrencyArgs({
      env: { GITHUB_ACTIONS: "true", TLH_TEST_CONCURRENCY: "7" },
    }),
    ["--test-concurrency=7"],
  );
});

test("test concurrency policy rejects invalid explicit overrides", () => {
  for (const value of ["", "0", "-1", "1.5", "2x", "9007199254740992"]) {
    assert.throws(
      () => parseTestConcurrency(value),
      /TLH_TEST_CONCURRENCY must be a positive integer or unset it/,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
  assert.equal(parseTestConcurrency("3"), 3);
});

test("test concurrency policy adapts local limits and protects low-core hosts", () => {
  assert.equal(
    resolveTestConcurrency({ env: {}, availableParallelism: () => 8 }),
    4,
    "local runs use half of available parallelism",
  );
  assert.equal(
    resolveTestConcurrency({ env: {}, availableParallelism: () => 1 }),
    1,
    "one-core hosts must still run tests",
  );
  assert.equal(
    resolveTestConcurrency({ env: {}, availableParallelism: () => 3 }),
    1,
    "odd low-core hosts use the floored half with a minimum of one",
  );
});

test("test concurrency policy leaves GitHub Actions unbounded by default", () => {
  assert.equal(
    resolveTestConcurrency({ env: { GITHUB_ACTIONS: "true" }, availableParallelism: () => 8 }),
    undefined,
  );
  assert.equal(
    resolveTestConcurrency({
      env: { GITHUB_ACTIONS: "true", TLH_TEST_CONCURRENCY: "2" },
      availableParallelism: () => 8,
    }),
    2,
    "an explicit override still applies on GitHub Actions",
  );
});

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

test("TMPDIR_ALLOWLIST includes node-compile-cache", () => {
  assert.ok(TMPDIR_ALLOWLIST.includes("node-compile-cache"));
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
  mkdirSync(join(dir, "node-compile-cache"));
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
  function spawn(cmd, args, opts) {
    const { code = 0, signal = null } = results[calls.length] ?? {};
    calls.push({ cmd, args, opts });
    return fakeChild(code, signal);
  }
  spawn.calls = calls;
  return spawn;
}

test("runWithTmpdirGuard returns 0 when both suites pass and no leaks occur", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  const code = await runWithTmpdirGuard({ spawn });
  assert.equal(code, 0);
  assert.equal(spawn.calls.length, 4);
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
  // Later suites must not run after a failing suite.
  assert.equal(spawn.calls.length, 2);
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

test("runWithTmpdirGuard projects the shared concurrency override to root tests", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
  await runWithTmpdirGuard({
    env: { GITHUB_ACTIONS: "true", TLH_TEST_CONCURRENCY: "5" },
    spawn,
  });
  const [mainCall] = spawn.calls;
  assert.ok(mainCall.args.includes("--test-concurrency=5"));
});

test("runWithTmpdirGuard runs subagent suites in order with fail-fast semantics", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 0 }]);
  await runWithTmpdirGuard({ spawn });
  assert.deepEqual(
    spawn.calls.slice(1).map(({ args }) => args),
    [
      ["run", "test:subagents:unit"],
      ["run", "test:subagents:integration"],
      ["run", "test:subagents:e2e"],
    ],
  );
});

test("runWithTmpdirGuard sets TMPDIR/TMP/TEMP in child env", async () => {
  /** @type {Array<{ cmd: string; args: string[]; env?: Record<string, string | undefined> }>} */
  const calls = [];
  function spawn(cmd, args, opts) {
    calls.push({ cmd, args, env: opts?.env });
    return fakeChild(0);
  }
  await runWithTmpdirGuard({ spawn });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.ok(typeof call.env?.TMPDIR === "string" && call.env.TMPDIR.length > 0);
    assert.equal(call.env?.TMPDIR, call.env?.TMP);
    assert.equal(call.env?.TMPDIR, call.env?.TEMP);
  }
});

test("runWithTmpdirGuard scrubs PI_SUBAGENT_* env but preserves other keys", async () => {
  const envs = [];
  function spawn(_cmd, _args, opts) {
    envs.push(opts?.env);
    return fakeChild(0);
  }
  await runWithTmpdirGuard({
    spawn,
    env: {
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENTS_FOO: "x",
      PI_SUBAGENTX: "keep",
      TLH_KEEP: "yes",
      TMPDIR: "/ambient",
    },
  });
  assert.equal(envs.length, 4);
  for (const env of envs) {
    assert.deepEqual(
      Object.keys(env).filter((k) => /^PI_SUBAGENTS?_/u.test(k)),
      [],
    );
    assert.equal(env.PI_SUBAGENTX, "keep");
    assert.equal(env.TLH_KEEP, "yes");
    assert.notEqual(env.TMPDIR, "/ambient");
    assert.equal(env.TMPDIR, env.TMP);
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

test("runWithTmpdirGuard uses detached POSIX process groups for owned children", async () => {
  const spawn = fakeSpawn([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 0 }]);
  await runWithTmpdirGuard({ spawn });
  if (process.platform === "win32") {
    assert.equal(spawn.calls[0].opts?.detached, undefined);
  } else {
    assert.equal(spawn.calls[0].opts?.detached, true);
  }
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

test("tmpdir guard reports invalid concurrency overrides without a stack", () => {
  const result = spawnSync(process.execPath, [guardScriptPath, "--dot"], {
    env: { ...process.env, TLH_TEST_CONCURRENCY: "invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    'TLH_TEST_CONCURRENCY must be a positive integer or unset it; received "invalid".\n',
  );
  assert.doesNotMatch(result.stderr, /\bat /u);
});

// ---------------------------------------------------------------------------
// Real subprocess signal tests
//
// These tests use bounded synthetic fixtures only.  The fixture leader starts
// a grandchild, both install soft-signal no-op handlers before the ready
// handshake, and one case exits early while its grandchild remains in the
// owned group.  Each helper owns its harness, PID record, HOME/profile, and
// TMPDIR, and independently cleans every discovered PID on all failure paths.
// ---------------------------------------------------------------------------

/**
 * Build ESM harness source code. The injected guard spawn runs childScript and
 * relays its complete `ready:<leader>:<grandchild>` handshake.
 *
 * @param {string} childScript
 */
function buildHarnessCode(childScript) {
  return [
    `import { runWithTmpdirGuard } from ${JSON.stringify(guardScriptPath)};`,
    `import { spawn as nodeSpawn } from "node:child_process";`,
    `let announced = false;`,
    `const customSpawn = (cmd, args, opts) => {`,
    `  const child = nodeSpawn(`,
    `    process.execPath,`,
    `    ["-e", ${JSON.stringify(childScript)}],`,
    `    { ...opts, stdio: ["ignore", "pipe", "ignore"] }`,
    `  );`,
    `  let output = "";`,
    `  child.stdout.on("data", (chunk) => {`,
    `    output += chunk.toString();`,
    `    const match = output.match(/ready:(\\d+):(\\d+)\\n/);`,
    `    if (match && !announced) {`,
    `      announced = true;`,
    `      process.stdout.write("ready:" + match[1] + ":" + match[2] + "\\n");`,
    `    }`,
    `  });`,
    `  return child;`,
    `};`,
    `const code = await runWithTmpdirGuard({ spawn: customSpawn });`,
    `process.exitCode = code;`,
  ].join("\n");
}

function isNumericPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function signalTestEnv(root, pidFile) {
  const env = { ...process.env };
  delete env.TICKETS_DIR;
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete env[key];
  }
  const home = join(root, "home");
  const profile = join(root, "profile");
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  env.HOME = home;
  env.PI_CODING_AGENT_DIR = profile;
  env.TMPDIR = root;
  env.TMP = root;
  env.TEMP = root;
  env.TLH_SIGNAL_PID_FILE = pidFile;
  return env;
}

async function waitForProcessGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

/**
 * Independently kill one owned PID and its POSIX group.  The direct PID kill
 * remains explicit for the Windows fallback and for a group that disappeared
 * during the teardown race.
 */
function killOwnedPid(pid) {
  if (!isNumericPid(pid)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The bounded liveness check reports any survivor.
        }
      }
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone is the expected case after group delivery.
  }
}

function readOwnedPids(pidFile) {
  try {
    const value = JSON.parse(readFileSync(pidFile, "utf8"));
    return [value.leaderPid, value.grandchildPid].filter(isNumericPid);
  } catch {
    return [];
  }
}

/**
 * Spawn the harness, install its close observer before signaling, wait for a
 * fixture-level ready handshake, deliver exactly one PID-targeted signal, and
 * then assert bounded exit, child+grandchild teardown, and TMPDIR cleanup.
 *
 * @param {number} expectedCode
 * @param {string} harnessCode
 * @param {(harness: import("node:child_process").ChildProcess) => void | Promise<void>} signalFn
 */
async function runHarnessTest(expectedCode, harnessCode, signalFn) {
  const harnessTmpdir = mkdtempSync(join(tmpdir(), "tlh-sig-test-"));
  const pidFile = join(harnessTmpdir, "owned-pids.json");
  const ownedPids = new Set();
  /** @type {import("node:child_process").ChildProcess | null} */
  let harness = null;
  let stderrBuf = "";
  let primaryError = null;
  let cleanupError = null;
  const closeWaitMs = 5000;

  let closePromise;
  try {
    harness = childSpawn(process.execPath, ["--input-type=module"], {
      ...(process.platform !== "win32" ? { detached: true } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: signalTestEnv(harnessTmpdir, pidFile),
    });

    // Install this observer immediately after spawn, before writing the
    // harness program, waiting for ready, or delivering the test signal.
    closePromise = new Promise((resolve) => {
      harness.once("close", (code, signal) => resolve({ code, signal }));
    });
    harness.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    harness.stdin.end(harnessCode);

    await new Promise((resolve, reject) => {
      let output = "";
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for fixture ready handshake.\nstderr:\n${stderrBuf}`));
      }, closeWaitMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        harness.stdout.off("data", onData);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk) => {
        output += chunk.toString();
        const match = output.match(/ready:(\d+):(\d+)\n/);
        if (!match) return;
        ownedPids.add(Number.parseInt(match[1], 10));
        ownedPids.add(Number.parseInt(match[2], 10));
        finish(null, true);
      };
      harness.stdout.on("data", onData);
      closePromise.then(({ code, signal }) => {
        if (!settled) {
          finish(
            new Error(
              `Harness exited (code=${code}, signal=${signal}) before ready.\nstderr:\n${stderrBuf}`,
            ),
          );
        }
      });
    });

    await signalFn(harness);
    const closeResult = await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`Timed out waiting for harness close.\nstderr:\n${stderrBuf}`)),
          closeWaitMs,
        );
      }),
    ]);
    assert.equal(
      closeResult.code,
      expectedCode,
      `Guard must exit ${expectedCode}; signal=${closeResult.signal}\nstderr:\n${stderrBuf}`,
    );

    const pids = [...ownedPids];
    assert.equal(await waitForProcessGone(pids[0]), true, `Child process ${pids[0]} must be gone`);
    assert.equal(
      await waitForProcessGone(pids[1]),
      true,
      `Grandchild process ${pids[1]} must be gone`,
    );

    const leaked = existsSync(harnessTmpdir)
      ? readdirSync(harnessTmpdir).filter((entry) => entry.startsWith("tlh-test-run-"))
      : [];
    assert.deepEqual(
      leaked,
      [],
      `No tlh-test-run-* dirs should remain in TMPDIR.\nstderr:\n${stderrBuf}`,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // PID publication is independent of ready/close assertions, so a failed
    // await cannot strand a child or grandchild.  Harness cleanup is separate
    // from fixture cleanup because the fixture owns a detached group.
    for (const pid of readOwnedPids(pidFile)) ownedPids.add(pid);
    if (harness?.pid) ownedPids.add(harness.pid);
    for (const pid of ownedPids) killOwnedPid(pid);
    const cleanupResults = await Promise.all(
      [...ownedPids].map(async (pid) => ({ pid, gone: await waitForProcessGone(pid) })),
    );
    const survivors = cleanupResults.filter(({ gone }) => !gone).map(({ pid }) => pid);
    if (survivors.length > 0) {
      cleanupError = new Error(
        `Owned signal-test processes survived cleanup: ${survivors.join(", ")}`,
      );
      if (primaryError !== null) process.stderr.write(`${cleanupError.message}\n`);
    } else {
      // Removing this owned root is safe only after every owned writer was
      // observed gone.  Leave it for diagnosis if cleanup itself failed.
      rmSync(harnessTmpdir, { recursive: true, force: true });
    }
  }
  if (cleanupError !== null && primaryError === null) throw cleanupError;
}

function buildStubbornTreeScript({ leaderClosesEarly = false } = {}) {
  const grandchildScript = [
    "process.on('SIGINT', () => {});",
    "process.on('SIGTERM', () => {});",
    "process.stdout.write('grandchild-ready\\n');",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGINT', () => {});",
    "process.on('SIGTERM', () => {});",
    `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: ['ignore', 'pipe', 'ignore'] });`,
    "writeFileSync(process.env.TLH_SIGNAL_PID_FILE, JSON.stringify({ leaderPid: process.pid, grandchildPid: grandchild.pid }));",
    "let output = '';",
    "grandchild.stdout.on('data', (chunk) => {",
    "  output += chunk.toString();",
    "  if (!output.includes('grandchild-ready')) return;",
    "  process.stdout.write('ready:' + process.pid + ':' + grandchild.pid + '\\n', () => {",
    leaderClosesEarly
      ? "    setImmediate(() => process.exit(0));"
      : "    setInterval(() => {}, 1000);",
    "  });",
    "});",
  ].join("\n");
}

const posixSignalTestOptions = {
  timeout: 10000,
  skip: process.platform === "win32" ? "POSIX process-group ownership is unavailable" : false,
};

test(
  "guard exits 130 and tears down a stubborn child tree on one SIGINT",
  posixSignalTestOptions,
  async () => {
    await runHarnessTest(130, buildHarnessCode(buildStubbornTreeScript()), (harness) => {
      assert.equal(harness.kill("SIGINT"), true);
    });
  },
);

test(
  "guard exits 143 and tears down a stubborn child tree on one SIGTERM",
  posixSignalTestOptions,
  async () => {
    await runHarnessTest(143, buildHarnessCode(buildStubbornTreeScript()), (harness) => {
      assert.equal(harness.kill("SIGTERM"), true);
    });
  },
);

test(
  "guard exits 129 and tears down an owned child tree on one SIGHUP",
  posixSignalTestOptions,
  async () => {
    await runHarnessTest(129, buildHarnessCode(buildStubbornTreeScript()), (harness) => {
      assert.equal(harness.kill("SIGHUP"), true);
    });
  },
);

test(
  "guard escalates after the group leader closes and removes the temp root",
  posixSignalTestOptions,
  async () => {
    await runHarnessTest(
      143,
      buildHarnessCode(buildStubbornTreeScript({ leaderClosesEarly: true })),
      (harness) => {
        assert.equal(harness.kill("SIGTERM"), true);
      },
    );
  },
);
