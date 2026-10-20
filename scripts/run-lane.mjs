#!/usr/bin/env node
/**
 * Concurrent lane runner.
 *
 * Exports runLanes, runLane, and spawnBuffered for use by CI entrypoints.
 * See scripts/run-ci-test-shard.mjs for the CI test-shard entrypoint.
 *
 * Lane model:
 *   - Multiple lanes run concurrently via Promise.allSettled.
 *   - Commands within a lane run sequentially; a failure stops that lane but not others.
 *   - Each lane gets its own HOME subdirectory (baseHomeDir/lane-<name>) created on startup.
 *   - Command output (stdout + stderr) is buffered and written atomically as one framed
 *     labeled block to stdout on completion, so diagnostics are never separated from
 *     their identifying header.
 *   - SIGINT/SIGTERM terminate active child process trees (SIGTERM + bounded SIGKILL
 *     escalation) and then flush all in-flight buffers to process.stdout before exit.
 *   - All lanes run to completion (including after errors); exit code is non-zero if any failed.
 *
 * @module run-lane
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Maximum bytes buffered per stream per command (matches run-subagents-tests.mjs). */
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {{
 *   name: string;
 *   commands: string[][];
 *   env?: Record<string, string | undefined>;
 *   commandEnvs?: Array<Record<string, string | undefined> | undefined>;
 *   timingCommands?: Array<{ suite: string; eventFile: string } | undefined>;
 * }} Lane
 */

// ---------------------------------------------------------------------------
// Signal handling: terminate children and flush active buffers on SIGINT / SIGTERM
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   outChunks: Buffer[];
 *   errChunks: Buffer[];
 *   label: string | undefined;
 *   child: import("node:child_process").ChildProcess | null;
 *   groupPid: number | null;
 *   stdout: import("node:stream").Writable;
 *   cmd: string;
 *   frameWritten: boolean;
 *   settled: boolean;
 *   spawnError: string | null;
 * }} SpawnContext
 */

/** @type {Set<SpawnContext>} */
const _activeSpawns = new Set();
let _signalHandlersInstalled = false;
let _shutdownRequested = false;
/** @type {Promise<void> | null} */
let _shutdownComplete = null;
/** @type {Set<(signal: string) => void>} */
const _shutdownCallbacks = new Set();

/**
 * Grace period (ms) between SIGTERM and SIGKILL when terminating child trees.
 * Short enough not to add meaningful latency; long enough for clean shutdown.
 */
const KILL_GRACE_MS = 500;

/**
 * Send `signal` to an owned process group, ignoring ESRCH / permission errors
 * from already-exited processes.  The group id is snapshotted before shutdown
 * begins so a leader's close event cannot remove descendants from escalation.
 *
 * Children are spawned with `detached: true` so each one leads its own process
 * group, making `-pid` the reliable handle for the whole tree.
 *
 * @param {number | null} groupPid
 * @param {NodeJS.Signals} signal
 */
function _killProcessGroup(groupPid, signal) {
  if (groupPid == null) return;
  try {
    process.kill(-groupPid, signal);
  } catch {
    // ESRCH: process already gone; EPERM: race with exit — both are safe to ignore.
  }
}

/**
 * Build one command's complete diagnostic frame.  During shutdown normal close
 * handlers do not write their frames; the shutdown snapshot writes them once
 * after escalation so a leader close cannot remove its diagnostics or group.
 *
 * @param {SpawnContext} ctx
 * @param {string | undefined} interruptedBy
 * @returns {Buffer[]}
 */
function _takeFrameParts(ctx, interruptedBy) {
  if (ctx.frameWritten) return [];
  ctx.frameWritten = true;

  const parts = [];
  if (ctx.label) {
    if (interruptedBy !== undefined) {
      parts.push(Buffer.from(`=== ${ctx.label} (interrupted by ${interruptedBy}) ===\n`));
    } else if (ctx.spawnError !== null) {
      parts.push(Buffer.from(`=== ${ctx.label} (spawn error) ===\n`));
    } else {
      parts.push(Buffer.from(`=== ${ctx.label} ===\n`));
    }
  }
  parts.push(...ctx.outChunks);
  parts.push(...ctx.errChunks);
  if (ctx.spawnError !== null) {
    parts.push(Buffer.from(`spawn error for ${ctx.cmd}: ${ctx.spawnError}\n`));
  }
  return parts;
}

/**
 * Write one completed command's frame to its configured output stream.
 *
 * @param {SpawnContext} ctx
 */
function _writeFrame(ctx) {
  const parts = _takeFrameParts(ctx, undefined);
  if (parts.length > 0) ctx.stdout.write(Buffer.concat(parts));
}

/**
 * Install process-level signal handlers (once) that latch shutdown, terminate
 * the snapshotted child process groups (SIGTERM then bounded SIGKILL), flush
 * buffered output as one framed block to process.stdout, then exit.
 */
function _installSignalHandlers() {
  if (_signalHandlersInstalled) return;
  _signalHandlersInstalled = true;

  function flushAndExit(sig) {
    // The latch and snapshots happen synchronously before any await.  This
    // makes repeated signals idempotent and prevents a close continuation from
    // starting another lane command during grace, escalation, or output flush.
    if (_shutdownRequested) return;
    _shutdownRequested = true;
    // runLanes waits for this barrier before its caller can run cleanup.  The
    // barrier resolves only after the snapshotted groups have received their
    // escalation signal, so a lane leader cannot let shard cleanup overtake
    // descendant termination.
    /** @type {() => void} */
    let completeShutdown;
    _shutdownComplete = new Promise((resolve) => {
      completeShutdown = resolve;
    });

    const contexts = [..._activeSpawns];
    const groupPids = [
      ...new Set(contexts.map((ctx) => ctx.groupPid).filter((pid) => pid !== null)),
    ];

    // Step 1: SIGTERM to every process group owned at cancellation time.
    for (const groupPid of groupPids) _killProcessGroup(groupPid, "SIGTERM");

    void (async () => {
      // Step 2: Brief grace period, then SIGKILL every snapshotted group.  Do
      // not consult _activeSpawns here: its leader may already have closed.
      await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
      for (const groupPid of groupPids) _killProcessGroup(groupPid, "SIGKILL");
      // Notify opt-in observers after escalation has been dispatched to every
      // group captured at shutdown. Observers must be synchronous and bounded;
      // cancellation reporting must not delay the existing diagnostic flush.
      for (const callback of _shutdownCallbacks) {
        try {
          callback(sig);
        } catch (error) {
          process.stderr.write(
            `[tlh] shutdown observer failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
      // Let runLanes callers enter their finally blocks only after escalation
      // has been dispatched to every group captured at shutdown.
      completeShutdown();

      // Step 3: Serialize all snapshotted buffers into one framed block on
      // stdout.  Close/error handlers during shutdown only settle promises;
      // this is the single writer for interrupted diagnostics.
      const parts = [];
      for (const ctx of contexts) parts.push(..._takeFrameParts(ctx, sig));
      const buf = parts.length > 0 ? Buffer.concat(parts) : null;
      if (buf !== null) {
        process.stdout.write(buf, () => process.exit(1));
      } else {
        process.exit(1);
      }
    })();
  }

  process.on("SIGINT", () => flushAndExit("SIGINT"));
  process.on("SIGTERM", () => flushAndExit("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Signal observer registration
// ---------------------------------------------------------------------------

/**
 * Register a synchronous observer for the existing cancellation path.
 *
 * @param {(signal: string) => void} callback
 * @returns {() => void} unregister function
 */
export function registerShutdownCallback(callback) {
  _installSignalHandlers();
  _shutdownCallbacks.add(callback);
  return () => _shutdownCallbacks.delete(callback);
}

// ---------------------------------------------------------------------------
// spawnBuffered
// ---------------------------------------------------------------------------

/**
 * Shorten an argv entry for display. Absolute paths to .mjs/.js/.cjs files
 * are reduced to their basename; all other tokens are kept verbatim.
 *
 * @param {string} arg
 * @returns {string}
 */
function _displayArg(arg) {
  if (/^\/.+\.(mjs|js|cjs)$/.test(arg)) return basename(arg);
  return arg;
}

/**
 * Spawn a single command, buffer its stdout and stderr, then write them as one
 * framed labeled block to `stdout` when the command finishes.  Serialising both
 * streams into a single write prevents concurrent lanes' stderr diagnostics from
 * being separated from their identifying header on platforms that read descriptors
 * independently (e.g. GitHub Actions log streaming).
 *
 * Children are spawned with `detached: true` so the whole process group can be
 * terminated on interruption.
 *
 * @param {string[]} argv - [executable, ...args]
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   cwd?: string;
 *   stdout?: import("node:stream").Writable;
 *   stderr?: import("node:stream").Writable;
 *   label?: string;
 *   maxBufferBytes?: number;
 * }} [opts]
 * @returns {Promise<{ ok: boolean }>}
 */
export function spawnBuffered(
  argv,
  env,
  {
    cwd,
    stdout = process.stdout,
    stderr: _stderr = process.stderr,
    label,
    maxBufferBytes = MAX_BUFFER_BYTES,
  } = {},
) {
  _installSignalHandlers();
  if (_shutdownRequested) return Promise.resolve({ ok: false });

  const [cmd, ...args] = argv;

  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let outTruncated = false;
    let errTruncated = false;

    /** @type {SpawnContext} */
    const ctx = {
      outChunks,
      errChunks,
      label,
      child: null,
      groupPid: null,
      stdout,
      cmd,
      frameWritten: false,
      settled: false,
      spawnError: null,
    };
    _activeSpawns.add(ctx);

    const child = spawn(cmd, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached: own process group so -pid reaches the full tree.
      detached: true,
    });
    ctx.child = child;
    ctx.groupPid = child.pid ?? null;

    child.stdout.on("data", (chunk) => {
      outLen += chunk.length;
      if (outLen <= maxBufferBytes) {
        outChunks.push(chunk);
      } else if (!outTruncated) {
        outTruncated = true;
        outChunks.push(Buffer.from(`\n[TLH] stdout truncated at ${maxBufferBytes} bytes\n`));
      }
    });

    child.stderr.on("data", (chunk) => {
      errLen += chunk.length;
      if (errLen <= maxBufferBytes) {
        errChunks.push(chunk);
      } else if (!errTruncated) {
        errTruncated = true;
        errChunks.push(Buffer.from(`\n[TLH] stderr truncated at ${maxBufferBytes} bytes\n`));
      }
    });

    child.on("error", (error) => {
      _activeSpawns.delete(ctx);
      ctx.spawnError = error.message;
      if (ctx.settled) return;
      ctx.settled = true;
      // Frame the spawn error on stdout alongside any buffered output so the
      // label stays attached to the diagnostics.  During shutdown the
      // snapshot owns the one and only diagnostic write.
      if (!_shutdownRequested) _writeFrame(ctx);
      resolve({ ok: false });
    });

    child.on("close", (code, signal) => {
      _activeSpawns.delete(ctx);
      if (ctx.settled) return;
      ctx.settled = true;
      // Serialize header + stdout + stderr into one atomic write to stdout so
      // no concurrent lane's stderr can appear between this label and its payload.
      if (!_shutdownRequested) _writeFrame(ctx);
      resolve({ ok: code === 0 && signal == null });
    });
  });
}

// ---------------------------------------------------------------------------
// runLane
// ---------------------------------------------------------------------------

/**
 * Run a single lane: commands sequentially with per-lane HOME.
 * Stops the lane on the first command failure, but does not affect other lanes.
 *
 * @param {Lane} lane
 * @param {string} laneHomeDir - HOME directory for this lane (created if missing)
 * @param {{
 *   cwd?: string;
 *   stdout?: import("node:stream").Writable;
 *   stderr?: import("node:stream").Writable;
 *   timing?: import("./ci-timings.mjs").TimingCollector;
 * }} [opts]
 * @returns {Promise<boolean>} true if all commands passed
 */
export async function runLane(lane, laneHomeDir, opts = {}) {
  mkdirSync(laneHomeDir, { recursive: true });

  const laneEnv = { ...process.env, ...lane.env, HOME: laneHomeDir };
  const timing = opts.timing;
  let laneOk = false;
  timing?.startLane(lane.name);

  try {
    for (let index = 0; index < lane.commands.length; index += 1) {
      const argv = lane.commands[index];
      // A command may close successfully after cancellation (for example, a
      // TERM handler exits with status 0).  Re-check the latch before every
      // queued command so that close continuations cannot spawn during grace,
      // escalation, or buffered-output flush.
      if (_shutdownRequested) return false;
      const parts = [basename(argv[0]), ...argv.slice(1).map(_displayArg)].join(" ");
      const raw = `lane ${lane.name}: ${parts}`;
      const label = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
      const commandEnv = { ...laneEnv, ...lane.commandEnvs?.[index] };
      const timingMeta = lane.timingCommands?.[index];
      const commandTiming =
        timing && timingMeta
          ? timing.startCommand({
              lane: lane.name,
              suite: timingMeta.suite,
              index,
              eventFile: timingMeta.eventFile,
            })
          : null;
      let result;
      try {
        result = await spawnBuffered(argv, commandEnv, { ...opts, label });
      } catch (error) {
        if (commandTiming) timing.endCommand(commandTiming, { ok: false });
        throw error;
      }
      if (commandTiming) {
        timing.endCommand(commandTiming, { ...result, cancelled: _shutdownRequested });
      }
      if (!result.ok) return false;
    }
    laneOk = true;
    return true;
  } finally {
    timing?.endLane(lane.name, laneOk);
  }
}

// ---------------------------------------------------------------------------
// runLanes
// ---------------------------------------------------------------------------

/**
 * Run multiple lanes concurrently.
 *
 * Each lane gets `HOME = baseHomeDir/lane-<name>`.
 * All lanes run to completion regardless of individual failures or throws.
 * Returns non-zero if any lane failed or threw.
 *
 * @param {Lane[]} lanes
 * @param {{ baseHomeDir: string; cwd?: string }} options
 * @param {{
 *   stdout?: import("node:stream").Writable;
 *   stderr?: import("node:stream").Writable;
 *   timing?: import("./ci-timings.mjs").TimingCollector;
 * }} [opts]
 * @returns {Promise<number>} 0 if all passed, 1 if any failed
 */
export async function runLanes(lanes, { baseHomeDir, cwd }, opts = {}) {
  const unregister = opts.timing?.onCancellation
    ? registerShutdownCallback(opts.timing.onCancellation)
    : () => {};
  try {
    const results = await Promise.allSettled(
      lanes.map((lane) => {
        const laneHomeDir = join(baseHomeDir, `lane-${lane.name}`);
        return runLane(lane, laneHomeDir, { cwd, ...opts });
      }),
    );
    if (_shutdownRequested) {
      if (_shutdownComplete !== null) await _shutdownComplete;
      return 1;
    }
    return results.every((r) => r.status === "fulfilled" && r.value === true) ? 0 : 1;
  } finally {
    unregister();
  }
}
