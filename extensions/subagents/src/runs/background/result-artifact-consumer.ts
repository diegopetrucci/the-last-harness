/**
 * Cross-consumer arbitration for terminal result artifacts.
 *
 * The result watcher is the only public completion-delivery owner, while an
 * awaited run may consume its own artifact internally. A small exclusive
 * sidecar is the single durable claim: it prevents those two consumers (and
 * separate extension processes) from reading and delivering the same artifact
 * concurrently without moving or rewriting the result itself.
 *
 * The sidecar is removed when a consumer releases an unconsumed claim or when
 * a consumed artifact has been deleted. A process crash can leave a sidecar
 * behind; keeping that claim is intentional because retrying after an unknown
 * delivery outcome is more dangerous than dropping a possibly already-delivered
 * notification.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CLAIM_SUFFIX = ".claim";

/**
 * Cleanup attempts are deliberately finite. A retained claim is a manual
 * recovery marker after these attempts, rather than permission to spin and
 * spam logs forever when an artifact cannot be unlinked.
 */
export const RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS = 5;
const RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export function resultArtifactClaimCleanupDelayMs(attempt: number): number {
  const index = Math.max(
    0,
    Math.min(attempt, RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS.length - 1),
  );
  return RESULT_ARTIFACT_CLAIM_CLEANUP_RETRY_DELAYS_MS[index] ?? 100;
}

/** Filesystem operations needed by the cross-consumer claim. */
export type ResultArtifactFs = Pick<
  typeof fs,
  "existsSync" | "openSync" | "closeSync" | "unlinkSync" | "readFileSync"
>;

export interface ResultArtifactClaim {
  readonly path: string;
  /** Release an unconsumed claim so another attempt may read the artifact. */
  release(): boolean;
  /**
   * Mark delivery complete. Returns false while the artifact still exists, or
   * throws when artifact/sidecar cleanup fails; callers should retry either
   * case without releasing the claim.
   */
  commit(): boolean;
}

interface ClaimOperationError extends Error {
  readonly resultArtifactOperation: string;
}

function claimErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrapClaimError(
  operation: string,
  normalizedPath: string,
  error: unknown,
): ClaimOperationError {
  const wrapped = new Error(
    `Could not ${operation} result artifact '${normalizedPath}': ${errorText(error)}`,
    { cause: error },
  ) as ClaimOperationError;
  Object.defineProperty(wrapped, "resultArtifactOperation", {
    configurable: false,
    enumerable: false,
    value: operation,
    writable: false,
  });
  const code = claimErrorCode(error);
  if (code) {
    Object.defineProperty(wrapped, "code", {
      configurable: true,
      enumerable: false,
      value: code,
      writable: false,
    });
  }
  return wrapped;
}

function removeClaimMarker(
  fsApi: ResultArtifactFs,
  claimPath: string,
  normalizedPath: string,
): boolean {
  try {
    fsApi.unlinkSync(claimPath);
    return true;
  } catch (error) {
    // A previous cleanup attempt may already have removed the marker. This is
    // the only cleanup race that is safely idempotent; every other error must
    // remain visible to the owner so it can retry rather than replay.
    if (claimErrorCode(error) === "ENOENT") return true;
    throw wrapClaimError("remove claim sidecar", normalizedPath, error);
  }
}

/**
 * Try to reserve one result path for exactly one filesystem consumer.
 *
 * `wx`/`O_EXCL` is the ownership boundary. EEXIST means another consumer
 * already owns the artifact and is intentionally silent. All other filesystem
 * failures are surfaced to the caller so it can diagnose and rescan instead
 * of silently treating an inaccessible artifact as already consumed.
 */
export function claimResultArtifact(
  resultPath: string,
  fsApi: ResultArtifactFs = fs,
): ResultArtifactClaim | undefined {
  const normalizedPath = path.resolve(resultPath);
  const claimPath = `${normalizedPath}${CLAIM_SUFFIX}`;

  // Avoid leaving a claim for an event whose result has already disappeared.
  // existsSync normally returns false for an inaccessible path; injected seams
  // may throw, and those exceptions intentionally reach the caller.
  let resultExists: boolean;
  try {
    resultExists = fsApi.existsSync(normalizedPath);
  } catch (error) {
    throw wrapClaimError("check", normalizedPath, error);
  }
  if (!resultExists) return undefined;

  let descriptor: number;
  try {
    // O_EXCL makes this an atomic cross-process claim. The marker is private
    // to the isolated profile and contains no result data or user text.
    descriptor = fsApi.openSync(claimPath, "wx", 0o600);
  } catch (error) {
    if (claimErrorCode(error) === "EEXIST") return undefined;
    throw wrapClaimError("claim", normalizedPath, error);
  }
  try {
    fsApi.closeSync(descriptor);
  } catch (error) {
    // The descriptor is no longer usable as an ownership handle if close fails.
    // Release the marker when possible so a later retry can make a fresh claim;
    // if that cleanup also fails, the retained marker is the safe outcome.
    try {
      removeClaimMarker(fsApi, claimPath, normalizedPath);
    } catch {
      // Preserve the original close diagnostic; the sidecar remains a replay
      // barrier and can be inspected/removed deliberately by an operator.
    }
    throw wrapClaimError("close claim sidecar", normalizedPath, error);
  }

  let decision: "held" | "released" | "committed" = "held";
  return {
    path: normalizedPath,
    release(): boolean {
      if (decision === "committed" || decision === "released") return true;
      try {
        const released = removeClaimMarker(fsApi, claimPath, normalizedPath);
        decision = "released";
        return released;
      } catch (error) {
        // Keep the claim held so the caller can retry marker cleanup without
        // allowing a second consumer into an unresolved artifact.
        decision = "held";
        throw error;
      }
    },
    commit(): boolean {
      // Once delivery has been decided, never release the marker merely
      // because cleanup is temporarily unavailable.
      decision = "committed";
      let artifactExists: boolean;
      try {
        artifactExists = fsApi.existsSync(normalizedPath);
      } catch (error) {
        throw wrapClaimError("verify delivered", normalizedPath, error);
      }
      if (artifactExists) return false;
      return removeClaimMarker(fsApi, claimPath, normalizedPath);
    },
  };
}

export function isResultArtifactClaimError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "resultArtifactOperation" in error &&
    typeof (error as Partial<ClaimOperationError>).resultArtifactOperation === "string"
  );
}
