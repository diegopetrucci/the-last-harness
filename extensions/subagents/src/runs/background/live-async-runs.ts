/**
 * Live-run predicate for async jobs.
 *
 * Used by the async-started event handler and other callers that need to
 * distinguish genuinely active jobs from retained-terminal and paused jobs
 * that the async-job-tracker keeps around briefly for UX continuity.
 */

import type { AsyncJobState } from "../../shared/types.ts";

/**
 * Statuses where the async-job-tracker retains completed jobs (~10 s).
 * A job is "genuinely live" only when its status is NOT in this set.
 */
const ASYNC_TERMINAL_STATUSES = new Set(["complete", "failed", "paused", "cancelled", "continued"]);

/** Count genuinely live async jobs (not in a terminal retention status). */
export function countLiveAsyncRuns(asyncJobs: Map<string, AsyncJobState>): number {
  let count = 0;
  for (const job of asyncJobs.values()) {
    if (!ASYNC_TERMINAL_STATUSES.has(job.status)) count++;
  }
  return count;
}
