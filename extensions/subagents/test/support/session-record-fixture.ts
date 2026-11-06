import type { ContextUsageDiagnostics } from "../../src/shared/types.ts";
import {
  acquireSessionLease,
  createSessionRecord,
  markSessionCleanFinal,
  releaseSessionLease,
  retireSession,
  updateSessionLease,
} from "../../src/runs/shared/session-record.ts";

export interface SeedSessionRecordOptions {
  /** Cumulative runtime the earlier attempts left in the record. */
  activeRuntimeMs?: number;
  /** Latest context usage the earlier attempts left in the record. */
  contextUsage?: ContextUsageDiagnostics;
  /** Retire the session, as a role-timeout would. */
  retireReason?: string;
}

/**
 * Give an existing fixture session file the ownership record a previously
 * finished attempt would have left (clean-final, lease released). The runner
 * refuses to resume a session file that has no valid record.
 */
export function seedSessionRecord(
  sessionFile: string,
  options: SeedSessionRecordOptions = {},
): void {
  const created = createSessionRecord(sessionFile, { latestRunId: "seed-run" });
  if (created.status !== "created" && created.status !== "exists") {
    throw new Error(`Cannot seed session record: ${created.status}`);
  }
  const acquired = acquireSessionLease(sessionFile, { runnerPid: process.pid });
  if (acquired.status !== "acquired") {
    throw new Error(`Cannot seed session record: ${acquired.status}`);
  }
  if (options.activeRuntimeMs !== undefined || options.contextUsage !== undefined) {
    updateSessionLease(sessionFile, acquired.handle, {
      ...(options.activeRuntimeMs === undefined
        ? {}
        : { activeRuntimeMs: options.activeRuntimeMs }),
      ...(options.contextUsage === undefined ? {} : { contextUsage: options.contextUsage }),
    });
  }
  if (options.retireReason) retireSession(sessionFile, acquired.handle, options.retireReason);
  markSessionCleanFinal(sessionFile, acquired.handle, "seed-run");
  releaseSessionLease(sessionFile, acquired.handle);
}

/**
 * Leave the record the way a crashed attempt would: a lease that was never
 * released, held by `runnerPid`. A dead pid makes the session `abandoned`; a live
 * one (e.g. this process) makes it `held`.
 */
export function seedUnreleasedLease(sessionFile: string, runnerPid: number): void {
  const created = createSessionRecord(sessionFile, { latestRunId: "seed-run" });
  if (created.status !== "created" && created.status !== "exists") {
    throw new Error(`Cannot seed session record: ${created.status}`);
  }
  const acquired = acquireSessionLease(sessionFile, { runnerPid });
  if (acquired.status !== "acquired") {
    throw new Error(`Cannot seed session record: ${acquired.status}`);
  }
}
