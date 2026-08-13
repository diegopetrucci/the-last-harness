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
 * }} SpawnContext
 */

/** @type {Set<SpawnContext>} */
const _activeSpawns = new Set();
let _signalHandlersInstalled = false;

/**
 * Grace period (ms) between SIGTERM and SIGKILL when terminating child trees.
 * Short enough not to add meaningful latency; long enough for clean shutdown.
 */
const KILL_GRACE_MS = 500;

/**
 * Send `signal` to the process group rooted at `child.pid` (the entire tree),
 * ignoring ESRCH / permission errors from already-exited processes.
 *
 * Children are spawned with `detached: true` so each one leads its own process
 * group, making `-pid` the reliable handle for the whole tree.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function _killTree(child, signal) {
	if (child.pid == null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		// ESRCH: process already gone; EPERM: race with exit — both are safe to ignore.
	}
}

/**
 * Install process-level signal handlers (once) that terminate all active child
 * trees (SIGTERM then bounded SIGKILL), flush buffered output as one framed block
 * to process.stdout, then exit.
 */
function _installSignalHandlers() {
	if (_signalHandlersInstalled) return;
	_signalHandlersInstalled = true;

	async function flushAndExit(sig) {
		// Step 1: SIGTERM to every active child process group.
		for (const ctx of _activeSpawns) {
			if (ctx.child !== null) _killTree(ctx.child, "SIGTERM");
		}

		// Step 2: Brief grace period, then SIGKILL any survivors.
		await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
		for (const ctx of _activeSpawns) {
			if (ctx.child !== null) _killTree(ctx.child, "SIGKILL");
		}

		// Step 3: Serialize all in-flight buffers into one framed block on stdout.
		const parts = [];
		for (const ctx of _activeSpawns) {
			if (ctx.label) {
				parts.push(Buffer.from(`=== ${ctx.label} (interrupted by ${sig}) ===\n`));
			}
			parts.push(...ctx.outChunks);
			parts.push(...ctx.errChunks);
		}

		const buf = parts.length > 0 ? Buffer.concat(parts) : null;
		if (buf !== null) {
			process.stdout.write(buf, () => process.exit(1));
		} else {
			process.exit(1);
		}
	}

	process.on("SIGINT", () => flushAndExit("SIGINT"));
	process.on("SIGTERM", () => flushAndExit("SIGTERM"));
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
 * terminated via `_killTree` on interruption.
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
	{ cwd, stdout = process.stdout, stderr: _stderr = process.stderr, label, maxBufferBytes = MAX_BUFFER_BYTES } = {},
) {
	_installSignalHandlers();
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
		const ctx = { outChunks, errChunks, label, child: null };
		_activeSpawns.add(ctx);

		const child = spawn(cmd, args, {
			env,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// detached: own process group so _killTree(-pid) reaches the full tree.
			detached: true,
		});
		ctx.child = child;

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
			// Frame the spawn error on stdout alongside any buffered output so the
			// label stays attached to the diagnostics.
			const parts = [];
			if (label) parts.push(Buffer.from(`=== ${label} (spawn error) ===\n`));
			parts.push(...errChunks);
			parts.push(Buffer.from(`spawn error for ${cmd}: ${error.message}\n`));
			stdout.write(Buffer.concat(parts));
			resolve({ ok: false });
		});

		child.on("close", (code, signal) => {
			_activeSpawns.delete(ctx);
			// Serialize header + stdout + stderr into one atomic write to stdout so
			// no concurrent lane's stderr can appear between this label and its payload.
			const parts = [];
			if (label) parts.push(Buffer.from(`=== ${label} ===\n`));
			parts.push(...outChunks);
			parts.push(...errChunks);
			if (parts.length > 0) stdout.write(Buffer.concat(parts));
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
 * }} [opts]
 * @returns {Promise<boolean>} true if all commands passed
 */
export async function runLane(lane, laneHomeDir, opts = {}) {
	mkdirSync(laneHomeDir, { recursive: true });

	const laneEnv = { ...process.env, ...lane.env, HOME: laneHomeDir };

	for (const argv of lane.commands) {
		const parts = [basename(argv[0]), ...argv.slice(1).map(_displayArg)].join(" ");
		const raw = `lane ${lane.name}: ${parts}`;
		const label = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
		const { ok } = await spawnBuffered(argv, laneEnv, { ...opts, label });
		if (!ok) return false;
	}
	return true;
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
 * }} [opts]
 * @returns {Promise<number>} 0 if all passed, 1 if any failed
 */
export async function runLanes(lanes, { baseHomeDir, cwd }, opts = {}) {
	const results = await Promise.allSettled(
		lanes.map((lane) => {
			const laneHomeDir = join(baseHomeDir, `lane-${lane.name}`);
			return runLane(lane, laneHomeDir, { cwd, ...opts });
		}),
	);
	return results.every((r) => r.status === "fulfilled" && r.value === true) ? 0 : 1;
}
