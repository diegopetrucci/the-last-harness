#!/usr/bin/env node
/**
 * Temporary-directory leak guard for npm test / npm run test:verbose.
 *
 * Creates a fresh isolated TMPDIR per run, executes the root Node tests and
 * the imported subagent suites inside it, then fails with the leaked names if
 * any entries remain outside the documented allowlist. The per-run root is
 * always removed.
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
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {Promise<{code: number | null, signal: string | null}>}
 */
function childClose(child) {
  return new Promise((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

/**
 * Run the root Node tests and imported subagent suites inside an isolated
 * TMPDIR, report leaked entries, then always remove the per-run root.
 *
 * The child exit code is preserved: a test failure still returns non-zero even
 * when there are no leaks. Leaks add an additional non-zero exit if tests
 * otherwise passed.
 *
 * Signal handling: SIGINT/SIGTERM received while a child is running are
 * forwarded to that child and recorded. After the child closes the guard
 * performs cleanup and returns 128+signal_number. Because the guard uses
 * async spawn (not spawnSync) the event loop stays alive while children run,
 * so signal handlers fire reliably without any setImmediate tricks.
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
  const root = mkdtempSync(join(tmpdir(), "tlh-test-run-"));
  const guardEnv = { ...env, TMPDIR: root, TMP: root, TEMP: root };

  let pendingSignal = /** @type {string | null} */ (null);
  /** @type {import("node:child_process").ChildProcess | null} */
  let currentChild = null;

  const onSigint = () => {
    if (pendingSignal !== null) {
      // Second signal while child is still running — escalate to SIGKILL.
      // The first recorded signal is kept as the exit-code basis.
      currentChild?.kill("SIGKILL");
      return;
    }
    pendingSignal = "SIGINT";
    currentChild?.kill("SIGINT");
  };
  const onSigterm = () => {
    if (pendingSignal !== null) {
      currentChild?.kill("SIGKILL");
      return;
    }
    pendingSignal = "SIGTERM";
    currentChild?.kill("SIGTERM");
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let exitCode = 0;
  try {
    // 1. Root Node tests
    if (!pendingSignal) {
      const reporterArgs = dot ? ["--test-reporter=dot"] : [];
      const child1 = spawn(process.execPath, ["--test", ...reporterArgs, testGlob], {
        cwd: repoRoot,
        env: guardEnv,
        stdio: "inherit",
      });
      currentChild = child1;
      const r1 = await childClose(child1);
      currentChild = null;
      exitCode = r1.signal != null ? signalExitCode(r1.signal) : (r1.code ?? 1);
    }

    // 2. Imported subagent suites — only when root tests pass and no signal received
    if (exitCode === 0 && !pendingSignal) {
      const child2 = spawn(npmCommand, ["run", "test:subagents"], {
        cwd: repoRoot,
        env: guardEnv,
        stdio: "inherit",
        // npm.cmd on Windows is a CMD batch script and requires shell:true
        ...(process.platform === "win32" ? { shell: true } : {}),
      });
      currentChild = child2;
      const r2 = await childClose(child2);
      currentChild = null;
      exitCode = r2.signal != null ? signalExitCode(r2.signal) : (r2.code ?? 1);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Report leaks before removal so the names are visible even on failure.
    const leaks = findLeaks(root);
    if (leaks.length > 0) {
      process.stderr.write(
        `[tlh] temp-dir leaks detected under ${root}:\n${leaks.map((n) => `  ${n}`).join("\n")}\n`,
      );
      if (exitCode === 0) exitCode = 1;
    }
    rmSync(root, { recursive: true, force: true });
  }

  // After cleanup, honour any recorded signal with the conventional exit code.
  if (pendingSignal !== null) {
    return signalExitCode(pendingSignal);
  }

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
