/**
 * Resume admission and refusal wording for the one-live-writer session contract.
 *
 * Admission (the dispatcher, before it claims anything or spawns a runner) and
 * the runner (which takes the lease and is the authoritative boundary) describe
 * the same refusals with the same text from this module. Read-only: nothing
 * here takes a lease, writes a record or signals a process.
 */
import * as fs from "node:fs";
import {
  assessDurableResumeContext,
  formatDurableResumeContextBlock,
} from "../../shared/context-diagnostics.ts";
import type { ContextUsageDiagnostics } from "../../shared/types.ts";
import {
  classifySessionForResume,
  isSessionLeaseStale,
  readSessionRecord,
  type SessionRecord,
  type SessionRecordDeps,
} from "./session-record.ts";

export type SessionRefusal =
  | { kind: "retired"; reason?: string }
  | { kind: "held"; runnerPid: number }
  | { kind: "abandoned" }
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "unreadable"; detail: string }
  | { kind: "wrong-schema" }
  | { kind: "busy" };

const FRESH_DISPATCH =
  "Inspect the partial work in the session and start a fresh dispatch instead of resuming it.";

/** The single source of refusal wording, shared by admission and the runner. */
export function describeSessionRefusal(refusal: SessionRefusal): string {
  switch (refusal.kind) {
    case "retired":
      return `The session is retired${refusal.reason ? ` (${refusal.reason})` : ""}: its execution budget is permanently exhausted. ${FRESH_DISPATCH}`;
    case "held":
      return `The session is held by a live owner (runner pid ${refusal.runnerPid}). Wait for that run to finish, or interrupt the live owner, then retry. Do not start a second writer on the same session.`;
    case "abandoned":
      return `The session's last attempt did not finish cleanly and its owners are gone, so its state cannot be trusted. ${FRESH_DISPATCH}`;
    case "missing":
      return `The session has no ownership record (it was created before ownership records existed, or the record was deleted or moved). ${FRESH_DISPATCH}`;
    case "corrupt":
      return `The session's ownership record is corrupt (${refusal.reason}). ${FRESH_DISPATCH}`;
    case "unreadable":
      return `The session's ownership record cannot be read (${refusal.detail}). ${FRESH_DISPATCH}`;
    case "wrong-schema":
      return `The session's ownership record has an unsupported schema version. ${FRESH_DISPATCH}`;
    case "busy":
      return "The session's ownership record is busy. Retry shortly.";
  }
}

export type SessionAdmission =
  | { ok: true; record: SessionRecord }
  | { ok: false; refusal: SessionRefusal };

/** Classify a session for resume without mutating its ownership record. */
export function admitSessionForResume(
  sessionFile: string,
  deps: SessionRecordDeps = {},
): SessionAdmission {
  const read = readSessionRecord(sessionFile);
  switch (read.status) {
    case "missing":
      return { ok: false, refusal: { kind: "missing" } };
    case "corrupt":
      return { ok: false, refusal: { kind: "corrupt", reason: read.reason } };
    case "unreadable":
      return { ok: false, refusal: { kind: "unreadable", detail: read.error.message } };
    case "wrong-schema":
      return { ok: false, refusal: { kind: "wrong-schema" } };
    case "ok":
      break;
  }
  const { record } = read;
  const refusal = classifySessionForResume(
    record,
    !record.retired && !!record.lease && isSessionLeaseStale(record.lease, deps),
  );
  switch (refusal?.status) {
    case "retired":
      return {
        ok: false,
        refusal: { kind: "retired", ...(refusal.reason ? { reason: refusal.reason } : {}) },
      };
    case "held":
      return { ok: false, refusal: { kind: "held", runnerPid: refusal.holder.runnerPid } };
    case "abandoned":
      return { ok: false, refusal: { kind: "abandoned" } };
  }
  return { ok: true, record };
}

/**
 * A session is a resume checkpoint only when Pi wrote the file and the last
 * attempt left a clean-final ownership record. A runner that died mid-attempt
 * leaves an abandoned session, which must never be advertised as resumable.
 */
export function isResumableSessionCheckpoint(
  sessionFile: string,
  deps: SessionRecordDeps = {},
): boolean {
  try {
    if (!fs.lstatSync(sessionFile, { throwIfNoEntry: false })) return false;
  } catch {
    return false;
  }
  return admitSessionForResume(sessionFile, deps).ok;
}

/** Shared wording: a role budget with no remaining active runtime. */
export function roleBudgetExhaustedMessage(agent: string, activeRuntimeMs: number): string {
  return `Agent '${agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`;
}

/** Shared 80% context gate: the block message, or undefined when the resume may proceed. */
export function durableContextBlockMessage(
  contextUsage: ContextUsageDiagnostics | undefined,
  effectiveContextWindow?: number,
): string | undefined {
  const assessment = assessDurableResumeContext(contextUsage, effectiveContextWindow);
  return assessment.blocked ? formatDurableResumeContextBlock(assessment) : undefined;
}
