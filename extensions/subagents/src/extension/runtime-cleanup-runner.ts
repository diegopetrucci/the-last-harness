/**
 * Detached runtime-cleanup runner.
 *
 * Spawned by the parent extension registration to perform cleanup without
 * blocking first render. Runs cleanupRuntimeDirs() then refreshes the
 * marker mtime so the throttle window resets. On error, exits non-zero
 * without touching the marker so the next launch retries sooner.
 *
 * This file is executed as a standalone Node process; importing it must have
 * no side effects — the entrypoint guard at the bottom ensures that.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRuntimeDirs } from "./runtime-cleanup.ts";
import { RUNTIME_CLEANUP_MARKER_NAME } from "./runtime-cleanup-constants.ts";
import { TEMP_ROOT_DIR } from "../shared/types.ts";

export interface RuntimeCleanupRunnerDeps {
  /** The cleanup function to call. Defaults to cleanupRuntimeDirs. */
  cleanup?: () => void;
  /** Path to the marker file. Defaults to TEMP_ROOT_DIR / RUNTIME_CLEANUP_MARKER_NAME. */
  markerPath?: string;
  /** Returns current time in ms. Defaults to Date.now. */
  now?: () => number;
  /** Exit the process with the given code. Defaults to process.exit. */
  exit?: (code: number) => never;
}

/**
 * Run the cleanup logic with injectable dependencies.
 *
 * Exported for deterministic unit testing. When called from the entrypoint
 * the defaults (real cleanupRuntimeDirs, real marker path, real clock) apply.
 */
export function runCleanupRunner(deps: RuntimeCleanupRunnerDeps = {}): void {
  const cleanup = deps.cleanup ?? cleanupRuntimeDirs;
  const markerPath = deps.markerPath ?? path.join(TEMP_ROOT_DIR, RUNTIME_CLEANUP_MARKER_NAME);
  const now = deps.now ?? (() => Date.now());
  const exit = deps.exit ?? ((code: number) => process.exit(code) as never);

  try {
    cleanup();
  } catch (error) {
    process.stderr.write(
      `[pi-subagents] runtime-cleanup-runner: cleanupRuntimeDirs failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    exit(1);
    return;
  }

  // Refresh marker to now to reset the 24h throttle window.
  try {
    const ts = new Date(now());
    fs.utimesSync(markerPath, ts, ts);
  } catch {
    // Best-effort: a missing marker is recoverable; the next launch will retry.
  }
}

// ---------------------------------------------------------------------------
// Entrypoint guard — only run when this file is the process entrypoint.
// Uses fs.realpathSync on both sides so that a symlinked launch path still
// matches the real path returned by fileURLToPath(import.meta.url) in Node
// ESM. Falls back to path.resolve if realpath throws (e.g. path does not
// exist yet on an unusual platform).
// ---------------------------------------------------------------------------
function _realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const _thisFile = fileURLToPath(import.meta.url);
if (_realpath(process.argv[1] ?? "") === _realpath(_thisFile)) {
  runCleanupRunner();
}
