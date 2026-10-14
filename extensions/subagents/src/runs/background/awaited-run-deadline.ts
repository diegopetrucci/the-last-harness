/**
 * Hard-deadline arithmetic for the awaited-run owner.
 *
 * Extracted so `awaited-run-owner.ts` stays within the 2,000-line limit while
 * keeping this pure utility independently testable.
 */

import { PROCESS_GROUP_CLEANUP_MAX_WAIT_MS } from "../shared/process-group-cleanup.ts";

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Compute the point in time at which the awaited owner should give up waiting
 * for the child process and cleanup to settle.
 *
 * Returns `undefined` when no deadline or abort start is available (i.e. the
 * run has no enforced time cap).
 */
export function computeAwaitedHardDeadlineAt(input: {
  deadlineAt?: number;
  abortStartedAt?: number;
  cleanupGraceMs: number;
  artifactGraceMs: number;
  /** Maximum wait for the cleanup primitive; defaults to its production bound. */
  cleanupMaxWaitMs?: number;
}): number | undefined {
  const base = finite(input.abortStartedAt) ?? finite(input.deadlineAt);
  if (base === undefined) return undefined;
  const cleanupMaxWaitMs = Math.max(
    0,
    finite(input.cleanupMaxWaitMs) ?? PROCESS_GROUP_CLEANUP_MAX_WAIT_MS,
  );
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    base +
      cleanupMaxWaitMs +
      Math.max(0, finite(input.cleanupGraceMs) ?? 0) +
      Math.max(0, finite(input.artifactGraceMs) ?? 0),
  );
}
