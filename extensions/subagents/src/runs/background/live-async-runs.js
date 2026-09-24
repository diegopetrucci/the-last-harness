const ASYNC_TERMINAL_STATUSES = new Set(["complete", "failed", "paused", "cancelled", "continued"]);
export function countLiveAsyncRuns(asyncJobs) {
    let count = 0;
    for (const job of asyncJobs.values()) {
        if (!ASYNC_TERMINAL_STATUSES.has(job.status))
            count++;
    }
    return count;
}
