/**
 * Shared helpers for parallel-dispatch executor tests.
 *
 * Provides a collision-error predicate and fixture helpers for async run state.
 * Spawn/kill/reap helpers were removed when collision tests switched to the
 * executeAsyncParallel seam (see async-only-rejections.test.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, type AsyncJobState } from "../../src/shared/types.ts";
import { makeSubagentState } from "./helpers.ts";
import { writeAsyncArtifactJson as writeJson } from "./async-artifact-fixtures.ts";

/** Returns true when the result is not a collision error (accepts any other error or success). */
export function notCollisionError(r: {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}): boolean {
  return (
    !r.isError ||
    !/same path|resolve.*same|duplicate/i.test(r.content.map((c) => c.text ?? "").join(""))
  );
}

/** Registers a running async job in state and writes its status to ASYNC_DIR. */
export function setupLiveAsyncRun(
  state: ReturnType<typeof makeSubagentState>,
  root: string,
): { runId: string; cleanup: () => void } {
  const runId = `live-async-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const asyncDir = path.join(ASYNC_DIR, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    state: "running",
    mode: "single",
    cwd: root,
    steps: [],
  } as any);
  state.asyncJobs.set(runId, { asyncId: runId, asyncDir, status: "running" } as AsyncJobState);
  return {
    runId,
    cleanup: () => {
      state.asyncJobs.delete(runId);
      fs.rmSync(asyncDir, { recursive: true, force: true });
    },
  };
}

/** Writes a paused async run to ASYNC_DIR only (not in-memory state). */
export function setupPersistedAsyncRun(root: string): { runId: string; cleanup: () => void } {
  const runId = `persisted-async-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const asyncDir = path.join(ASYNC_DIR, runId);
  fs.mkdirSync(asyncDir, { recursive: true });
  writeJson(path.join(asyncDir, "status.json"), {
    runId,
    state: "paused",
    mode: "single",
    cwd: root,
    steps: [],
  } as any);
  return { runId, cleanup: () => fs.rmSync(asyncDir, { recursive: true, force: true }) };
}
