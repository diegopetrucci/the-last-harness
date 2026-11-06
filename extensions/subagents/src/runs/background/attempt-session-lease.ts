/**
 * Session lease held by the runner for one child attempt.
 *
 * The runner process takes the lease itself, with its own pid, immediately
 * before it spawns Pi, so there is no dispatcher-to-runner grant to lose: the
 * lease names a live runner from the moment it exists. Each attempt records its
 * child process group synchronously after spawn, and releases only once every
 * recorded group is proven gone. Anything short of a fully written clean-final
 * record leaves the lease held, which becomes `abandoned` (permanent refusal)
 * once the owners die. Nothing here ever signals a process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextUsageDiagnostics } from "../../shared/types.ts";
import {
  acquireSessionLease,
  createSessionRecord,
  markSessionCleanFinal,
  releaseSessionLease,
  retireSession,
  updateSessionLease,
  type FencedResult,
  type SessionLeaseHandle,
  type SessionRecord,
  type SessionRecordDeps,
} from "../shared/session-record.ts";
import { describeSessionRefusal, type SessionRefusal } from "../shared/session-admission.ts";
import { supportsOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.ts";

export interface AttemptLeaseProgress {
  activeRuntimeMs?: number;
  contextUsage?: ContextUsageDiagnostics;
}

export interface AttemptSessionLease {
  readonly sessionFile: string;
  /** Record a spawned child's process group; throws when the fenced write fails. */
  recordProcessGroup(processGroupId: number): void;
  /** Best-effort runtime/context checkpoint; never throws. */
  checkpoint(progress: AttemptLeaseProgress): void;
  /**
   * Write final evidence, optionally retire, then mark clean-final and release
   * once every recorded group is gone. Returns `released: false` with a reason
   * (lease left held) when any step cannot be completed. Never throws.
   */
  finish(progress: AttemptLeaseProgress & { retireReason?: string }): {
    released: boolean;
    reason?: string;
  };
}

export type OpenAttemptSessionLeaseResult =
  | {
      ok: true;
      lease: AttemptSessionLease;
      /** The record as it was when this runner took the lease (the authoritative snapshot). */
      record: SessionRecord;
    }
  | { ok: false; error: string };

const describeFailure = (result: Exclude<FencedResult, { status: "ok" }>): string => {
  switch (result.status) {
    case "not-holder":
      return "the session lease is no longer ours";
    case "busy":
      return "the session record is busy";
    case "unreadable":
      return `the session record is unreadable (${result.error.message})`;
    case "corrupt":
      return `the session record is corrupt (${result.reason})`;
    case "wrong-schema":
      return "the session record has an unsupported schema";
    case "missing":
      return "the session record is missing";
  }
};

function groupGone(pgid: number, deps: SessionRecordDeps): boolean {
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(-pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Create the record when the session has none yet (fresh or legacy file), then
 * take the lease. Refuses rather than waits: a held, abandoned, retired or
 * unreadable session never gets a second writer.
 */
export function openAttemptSessionLease(
  sessionFile: string,
  runId: string,
  deps: SessionRecordDeps = {},
): OpenAttemptSessionLeaseResult {
  const refuse = (detail: string): OpenAttemptSessionLeaseResult => ({
    ok: false,
    error: `Refusing to launch child: ${detail}`,
  });
  const refuseWith = (refusal: SessionRefusal): OpenAttemptSessionLeaseResult =>
    refuse(describeSessionRefusal(refusal));
  try {
    fs.mkdirSync(path.dirname(path.resolve(sessionFile)), { recursive: true });
  } catch (error) {
    return refuse(
      `cannot prepare the session directory (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  // Only a session file that does not exist yet (Pi creates it lazily) may get a
  // new record. An existing file without a record is never adopted: pre-upgrade,
  // deleted-record and moved sessions need a fresh dispatch.
  let present: boolean;
  try {
    // lstat so a dangling symlink counts as present (and is refused below).
    present = fs.lstatSync(sessionFile, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    return refuse(
      `cannot inspect the session file (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!present) {
    const created = createSessionRecord(
      sessionFile,
      { latestRunId: runId, requireSessionAbsent: true },
      deps,
    );
    if (created.status === "session-exists") {
      return refuseWith({ kind: "missing" });
    }
    if (created.status === "busy") return refuseWith({ kind: "busy" });
    if (created.status === "unreadable") {
      return refuse(`cannot create the session record (${created.error.message})`);
    }
  }
  const acquired = acquireSessionLease(sessionFile, { runnerPid: process.pid }, deps);
  switch (acquired.status) {
    case "acquired":
      return {
        ok: true,
        lease: createLease(sessionFile, runId, acquired.handle, deps),
        record: acquired.record,
      };
    case "held":
      return refuseWith({ kind: "held", runnerPid: acquired.holder.runnerPid });
    case "abandoned":
      return refuseWith({ kind: "abandoned" });
    case "retired":
      return refuseWith({ kind: "retired", reason: acquired.reason });
    case "busy":
      return refuseWith({ kind: "busy" });
    case "missing":
      return refuseWith({ kind: "missing" });
    case "corrupt":
      return refuseWith({ kind: "corrupt", reason: acquired.reason });
    case "unreadable":
      return refuseWith({ kind: "unreadable", detail: acquired.error.message });
    case "wrong-schema":
      return refuseWith({ kind: "wrong-schema" });
  }
}

function createLease(
  sessionFile: string,
  runId: string,
  handle: SessionLeaseHandle,
  deps: SessionRecordDeps,
): AttemptSessionLease {
  const recordedGroups = new Set<number>();
  let released = false;
  const lease: AttemptSessionLease = {
    sessionFile,
    recordProcessGroup(processGroupId) {
      recordedGroups.add(processGroupId);
      const result = updateSessionLease(
        sessionFile,
        handle,
        { processGroups: [processGroupId], latestRunId: runId },
        deps,
      );
      if (result.status !== "ok") throw new Error(describeFailure(result));
    },
    checkpoint(progress) {
      try {
        updateSessionLease(sessionFile, handle, { ...progress, latestRunId: runId }, deps);
      } catch {
        // Retried at the next checkpoint; the final write is the one that matters.
      }
    },
    finish(progress) {
      // At most one successful finish; a failed one may be retried.
      if (released) return { released: true };
      try {
        const { retireReason, ...evidence } = progress;
        const steps: Array<() => FencedResult> = [
          () => updateSessionLease(sessionFile, handle, { ...evidence, latestRunId: runId }, deps),
          ...(retireReason ? [() => retireSession(sessionFile, handle, retireReason, deps)] : []),
        ];
        for (const step of steps) {
          const result = step();
          if (result.status !== "ok") return { released: false, reason: describeFailure(result) };
        }
        if (
          recordedGroups.size > 0 &&
          (!supportsOwnedProcessGroupCleanup(deps.platform) ||
            [...recordedGroups].some((pgid) => !groupGone(pgid, deps)))
        ) {
          return { released: false, reason: "a child process group is still running" };
        }
        for (const step of [
          () => markSessionCleanFinal(sessionFile, handle, runId, deps),
          () => releaseSessionLease(sessionFile, handle, deps),
        ]) {
          const result = step();
          if (result.status !== "ok") return { released: false, reason: describeFailure(result) };
        }
        released = true;
        return { released: true };
      } catch (error) {
        return { released: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return lease;
}
