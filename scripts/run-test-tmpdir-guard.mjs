#!/usr/bin/env node
/**
 * Temporary-directory leak guard for npm test / npm run test:verbose.
 *
 * Creates a fresh isolated TMPDIR per run, executes the root Node tests and
 * the imported subagent suites inside it, then fails with the leaked names if
 * any entries remain outside the documented allowlist. The per-run root is
 * removed after every owned process tree exits (and retained for diagnosis if
 * a bounded teardown cannot prove that it is safe to remove).
 *
 * Usage:
 *   node scripts/run-test-tmpdir-guard.mjs [--dot]
 *
 * Flags:
 *   --dot  Use the dot reporter for root Node tests (npm test default).
 *          Omit for the verbose/spec reporter (npm run test:verbose).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testConcurrencyArgs } from "./test-concurrency.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(scriptPath), "..");

/**
 * Map a signal name to the conventional shell exit code (128 + signal number).
 * Uses os.constants.signals so the numbers are correct on every platform
 * (e.g. SIGUSR1/SIGUSR2/SIGBUS differ between Linux and macOS).
 * Returns 128 for unrecognised signal names.
 *
 * @param {string} signal
 * @returns {number}
 */
export function signalExitCode(signal) {
  const num = osConstants.signals[signal] ?? 0;
  return 128 + num;
}

/** npm executable name — npm.cmd on Windows, npm elsewhere. */
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * POSIX detached children become process-group leaders.  The negative-PID
 * signal below is deliberately limited to POSIX: Windows has no equivalent
 * Node API, so its explicit fallback targets the direct child only.
 */
const supportsOwnedProcessGroups = process.platform !== "win32";
const PROCESS_GROUP_GRACE_MS = 500;
const PROCESS_GROUP_KILL_GRACE_MS = 1000;
const PROCESS_GROUP_DRAIN_MS = 1000;
const PROCESS_GROUP_POLL_MS = 25;

/**
 * Direct-child names inside the per-run TMPDIR root that are created by the
 * test toolchain and are not considered leaks.
 *
 * - "jiti": jiti's transform cache directory. jiti compiles TypeScript test
 *   support files at runtime and stores the results in a directory named
 *   "jiti" directly inside TMPDIR.
 * - "node-compile-cache": Node's module compile cache directory.
 */
export const TMPDIR_ALLOWLIST = [
  "jiti", // jiti transform cache
  "node-compile-cache", // Node module compile cache
];

/**
 * List the direct-child names inside `dir` that are absent from the
 * allowlist — these are considered leaked temp entries.
 *
 * @param {string} dir - the per-run TMPDIR root to inspect
 * @param {readonly string[]} [allowlist] - names to skip; defaults to TMPDIR_ALLOWLIST
 * @returns {string[]} leaked entry names (sorted)
 */
export function findLeaks(dir, allowlist = TMPDIR_ALLOWLIST) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const allowSet = new Set(allowlist);
  return entries.filter((name) => !allowSet.has(name)).sort();
}

/**
 * Wrap a ChildProcess in a promise that resolves with {code, signal} on close.
 * The close observer is installed synchronously by the caller, before any
 * cancellation signal can be forwarded to the owned process group.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<{code: number | null, signal: string | null, error?: Error}>}
 */
function childClose(child) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("close", (code, signal) => settle({ code, signal }));
    child.once("error", (error) =>
      settle({
        code: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    );
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/**
 * Check whether the process group owned by `pid` still exists.  A permission
 * error is treated as present: deleting a TMPDIR that may still be writable
 * is less safe than retaining it for diagnosis.
 *
 * @param {number | null | undefined} pid
 */
function ownedProcessGroupExists(pid) {
  if (!supportsOwnedProcessGroups || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * Send a signal to an owned process tree.  POSIX uses the detached child's
 * process group; the Windows fallback is intentionally explicit because
 * Node's portable ChildProcess API only targets the direct child there.
 *
 * @param {{ child: import("node:child_process").ChildProcess; pid: number | null }} owner
 * @param {NodeJS.Signals} signal
 */
function signalOwnedProcess(owner, signal) {
  const { child, pid } = owner;
  if (supportsOwnedProcessGroups && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      // The group may have disappeared between the close check and delivery.
      // For a permission or platform failure, still make the owned leader's
      // direct fallback explicit rather than silently abandoning cleanup.
      if (errorCode(error) !== "ESRCH") {
        try {
          child.kill(signal);
        } catch {
          // Cleanup reports the tree as incomplete if it remains observable.
        }
      }
      return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    // A child that already exited is safely handled by the close/group checks.
  }
}

/**
 * @typedef {{
 *   child: import("node:child_process").ChildProcess;
 *   pid: number | null;
 *   closed: boolean;
 *   closePromise: Promise<{code: number | null; signal: string | null; error?: Error}>;
 *   teardownPromise: Promise<boolean> | null;
 * }} OwnedChild
 */

/**
 * Wait until both the leader's close event and its owned POSIX process group
 * have disappeared.  On Windows the direct-child close event is the explicit
 * fallback boundary.
 *
 * @param {OwnedChild} owner
 * @param {number} timeoutMs
 */
async function waitForOwnedTreeGone(owner, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (owner.closed && !ownedProcessGroupExists(owner.pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_GROUP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Send one soft cancellation, then automatically escalate to SIGKILL after a
 * bounded grace period.  The escalation timer is independent of the leader's
 * close event, so a leader that exits while descendants remain cannot prevent
 * group teardown.
 *
 * @param {OwnedChild} owner
 * @param {NodeJS.Signals} initialSignal
 */
async function teardownOwnedTree(owner, initialSignal) {
  signalOwnedProcess(owner, initialSignal);
  await delay(PROCESS_GROUP_GRACE_MS);
  if (!(owner.closed && !ownedProcessGroupExists(owner.pid))) {
    signalOwnedProcess(owner, "SIGKILL");
  }
  return waitForOwnedTreeGone(owner, PROCESS_GROUP_KILL_GRACE_MS);
}

/**
 * Run the root Node tests and imported subagent suites inside an isolated
 * TMPDIR, report leaked entries, then remove the per-run root only after every
 * owned process tree has gone away.
 *
 * The child exit code is preserved: a test failure still returns non-zero even
 * when there are no leaks. Leaks add an additional non-zero exit if tests
 * otherwise passed. SIGINT/SIGTERM/SIGHUP are returned as 130/143/129, respectively.
 *
 * @param {{
 *   dot?: boolean;
 *   testGlob?: string;
 *   env?: Record<string, string | undefined>;
 *   spawn?: typeof nodeSpawn;
 * }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function runWithTmpdirGuard({
  dot = false,
  testGlob = "tests/**/*.test.mjs",
  env = process.env,
  spawn = nodeSpawn,
} = {}) {
  let concurrencyArgs;
  try {
    concurrencyArgs = testConcurrencyArgs({ env });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const root = mkdtempSync(join(tmpdir(), "tlh-test-run-"));
  const guardEnv = { ...env, TMPDIR: root, TMP: root, TEMP: root };
  // Ambient subagent-child markers (e.g. PI_SUBAGENT_CHILD) must not leak into
  // tests; tests that need child mode set these explicitly.
  for (const key of Object.keys(guardEnv)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_")) delete guardEnv[key];
  }

  let pendingSignal = /** @type {string | null} */ (null);
  /** @type {OwnedChild | null} */
  let currentOwner = null;
  let treeCleanupComplete = true;

  const requestTeardown = (owner, signal) => {
    if (owner.teardownPromise === null) {
      owner.teardownPromise = teardownOwnedTree(owner, signal);
    }
    return owner.teardownPromise;
  };

  const onSignal = (signal) => {
    if (pendingSignal === null) pendingSignal = signal;
    const owner = currentOwner;
    if (owner !== null) {
      if (owner.teardownPromise === null) requestTeardown(owner, signal);
      else signalOwnedProcess(owner, "SIGKILL");
    }
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  const onSighup = () => onSignal("SIGHUP");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  if (supportsOwnedProcessGroups) process.on("SIGHUP", onSighup);

  /**
   * Spawn one owned suite command and keep ownership until its whole tree is
   * gone, including the case where the leader closes before its descendants.
   *
   * @param {string} command
   * @param {string[]} args
   */
  const runChild = async (command, args) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: repoRoot,
        env: guardEnv,
        stdio: "inherit",
        ...(supportsOwnedProcessGroups ? { detached: true } : {}),
        // npm.cmd on Windows is a CMD batch script and requires shell:true.
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
    } catch (error) {
      process.stderr.write(
        `[tlh] could not spawn ${command}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { code: 1, signal: null, treeGone: true };
    }

    // Install the close observer before publishing ownership.  A signal can
    // be delivered as soon as the next event-loop turn begins.
    const closePromise = childClose(child);
    const owner = {
      child,
      pid: Number.isInteger(child.pid) ? child.pid : null,
      closed: false,
      closePromise,
      teardownPromise: /** @type {Promise<boolean> | null} */ (null),
    };
    currentOwner = owner;

    const result = await closePromise;
    owner.closed = true;

    if (owner.teardownPromise === null) {
      const drained = await waitForOwnedTreeGone(owner, PROCESS_GROUP_DRAIN_MS);
      if (!drained) requestTeardown(owner, "SIGTERM");
    }
    const treeGone = owner.teardownPromise === null ? true : await owner.teardownPromise;
    if (!treeGone) treeCleanupComplete = false;
    if (currentOwner === owner) currentOwner = null;

    return {
      code: result.error ? 1 : (result.code ?? 1),
      signal: result.signal,
      treeGone,
    };
  };

  let exitCode = 0;
  try {
    // 1. Root Node tests.
    if (!pendingSignal) {
      const reporterArgs = dot ? ["--test-reporter=dot"] : [];
      const result = await runChild(process.execPath, [
        "--test",
        ...reporterArgs,
        ...concurrencyArgs,
        testGlob,
      ]);
      exitCode = result.signal != null ? signalExitCode(result.signal) : result.code;
    }

    // 2. Imported subagent suites.  Spawn each npm script separately instead
    // of nesting an npm compound shell, preserving ordering and fail-fast
    // semantics while keeping each suite in its own owned process group.
    for (const suite of ["unit", "integration", "e2e"]) {
      if (exitCode !== 0 || pendingSignal || !treeCleanupComplete) break;
      const result = await runChild(npmCommand, ["run", `test:subagents:${suite}`]);
      exitCode = result.signal != null ? signalExitCode(result.signal) : result.code;
    }
  } catch (error) {
    process.stderr.write(
      `[tlh] test runner failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    exitCode = exitCode === 0 ? 1 : exitCode;
  } finally {
    // A teardown promise normally settles before runChild returns.  Keep the
    // final guard here for unexpected errors so TMPDIR is never removed while
    // an owned writer may still be alive.
    if (currentOwner !== null) {
      const owner = currentOwner;
      if (owner.teardownPromise === null) {
        requestTeardown(owner, pendingSignal ?? "SIGTERM");
      }
      if (!(await owner.teardownPromise)) treeCleanupComplete = false;
      currentOwner = null;
    }

    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (supportsOwnedProcessGroups) process.off("SIGHUP", onSighup);
    // Report leaks before removal so the names are visible even on failure.
    const leaks = findLeaks(root);
    if (leaks.length > 0) {
      process.stderr.write(
        `[tlh] temp-dir leaks detected under ${root}:\n${leaks.map((n) => `  ${n}`).join("\n")}\n`,
      );
      if (exitCode === 0) exitCode = 1;
    }
    if (treeCleanupComplete) {
      rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(`[tlh] retaining ${root}; an owned process tree did not exit\n`);
      if (exitCode === 0) exitCode = 1;
    }
  }

  // After cleanup, honour any recorded signal with the conventional exit code.
  if (pendingSignal !== null) return signalExitCode(pendingSignal);
  return exitCode;
}

/**
 * @param {string[]} [argv]
 * @param {Parameters<typeof runWithTmpdirGuard>[0]} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const dot = argv.includes("--dot");
  return runWithTmpdirGuard({ dot, ...opts });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await main();
}
