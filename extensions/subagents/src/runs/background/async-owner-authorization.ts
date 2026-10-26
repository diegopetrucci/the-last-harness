import * as path from "node:path";
import { readStatus } from "../../shared/utils.ts";
import { RESULTS_DIR, type AsyncStatus } from "../../shared/types.ts";
import { readPersistedResultEvidence, resolvePersistedOwner } from "./async-resume.ts";

/** Caller ownership check shared by revival and run-control paths. Empty/absent keys never match. */
export function isOwnedByCaller(owner: unknown, callerKey: string | undefined): boolean {
  return (
    typeof callerKey === "string" &&
    callerKey.length > 0 &&
    typeof owner === "string" &&
    owner === callerKey
  );
}

export type AsyncRunOwnerUnverifiableReason =
  | "no-caller-key"
  | "no-run-identity"
  | "identity-mismatch"
  | "status-unreadable"
  | "owner-evidence-missing-or-invalid";

export type AsyncRunOwnerAuthorization =
  | { outcome: "owned"; runId: string; owner: string }
  | { outcome: "foreign"; runId: string; owner: string }
  | { outcome: "unverifiable"; reason: AsyncRunOwnerUnverifiableReason; runId?: string };

export interface AuthorizeAsyncRunOwnerInput {
  /** Caller ownership key (resolveCurrentSessionId: session file ?? session id). */
  callerKey: string | undefined;
  /** Resolved async run directory; its basename is the run id. */
  asyncDir?: string;
  /** Resolved result record path; must be `<resultsDir>/<runId>.json`. */
  resultPath?: string;
  /** Explicit run id; must agree with asyncDir/resultPath/status identity when present. */
  runId?: string;
  /**
   * Already-read status (e.g. inside a lifecycle-lock mutate callback). When
   * supplied, status.json is not read, so no lock is re-acquired. Pass `null`
   * for "read and found missing".
   */
  status?: Pick<AsyncStatus, "runId" | "sessionId"> | null;
  /** Override for tests; defaults to RESULTS_DIR. */
  resultsDir?: string;
}

/**
 * Authorize a resolved async run for a caller using the #822 owner rule:
 * resolvePersistedOwner(status.sessionId, result.sessionId) must equal a
 * nonempty caller key. Evidence is read fresh and never reconciled or written.
 * Identity (dir basename, status.runId, result file name) must agree, and the
 * result lookup uses only the trusted run id, never an untrusted status value.
 */
export function authorizeAsyncRunOwner(
  input: AuthorizeAsyncRunOwnerInput,
): AsyncRunOwnerAuthorization {
  const { callerKey, asyncDir, resultPath, status: suppliedStatus } = input;
  const resultsDir = input.resultsDir ?? RESULTS_DIR;
  if (typeof callerKey !== "string" || callerKey.length === 0)
    return { outcome: "unverifiable", reason: "no-caller-key" };

  const ids: string[] = [];
  if (input.runId !== undefined) ids.push(input.runId);
  if (asyncDir !== undefined) ids.push(path.basename(path.resolve(asyncDir)));
  if (resultPath !== undefined) {
    const resolved = path.resolve(resultPath);
    if (path.dirname(resolved) !== path.resolve(resultsDir) || !resolved.endsWith(".json"))
      return { outcome: "unverifiable", reason: "identity-mismatch" };
    ids.push(path.basename(resolved, ".json"));
  }
  const runId = ids[0];
  if (runId === undefined || runId.trim() === "")
    return { outcome: "unverifiable", reason: "no-run-identity" };
  if (ids.some((id) => id !== runId))
    return { outcome: "unverifiable", reason: "identity-mismatch", runId };

  let status: Pick<AsyncStatus, "runId" | "sessionId"> | null | undefined = suppliedStatus;
  if (status === undefined && asyncDir !== undefined) {
    try {
      status = readStatus(asyncDir, { cache: false });
    } catch {
      return { outcome: "unverifiable", reason: "status-unreadable", runId };
    }
  }
  if (status && status.runId !== runId)
    return { outcome: "unverifiable", reason: "identity-mismatch", runId };

  const resultEvidence = readPersistedResultEvidence(resultsDir, runId);
  if (resultEvidence.identityMismatch)
    return { outcome: "unverifiable", reason: "identity-mismatch", runId };
  const owner = resolvePersistedOwner(status?.sessionId, resultEvidence.owner);
  if (owner === undefined)
    return { outcome: "unverifiable", reason: "owner-evidence-missing-or-invalid", runId };
  return isOwnedByCaller(owner, callerKey)
    ? { outcome: "owned", runId, owner }
    : { outcome: "foreign", runId, owner };
}

/** Rejection text for a non-owned authorization; never names any run other than `runId`. */
export function asyncRunOwnerRejectionMessage(
  authorization: Exclude<AsyncRunOwnerAuthorization, { outcome: "owned" }>,
  runId: string,
  verb: string,
): string {
  return authorization.outcome === "foreign"
    ? `Async run '${runId}' is owned by another session and cannot be ${verb} from this session.`
    : `Async run '${runId}' ownership cannot be verified; it cannot be ${verb} from this session.`;
}
