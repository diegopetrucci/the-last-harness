export const ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE = "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";
export function isPausedStepStatus(status) {
    return status === "paused";
}
export function preservedCancellationStepStatus(priorStatus, childInterrupted, exitCode) {
    if (priorStatus === "complete" || priorStatus === "failed")
        return priorStatus;
    return !childInterrupted && exitCode === 0 ? "complete" : undefined;
}
export function applyCancelledStepProjection(result, cancel) {
    if (!cancel || result.success)
        return;
    result.output = "Cancelled by parent abort.";
    result.error = "Cancelled by parent abort.";
    result.cancel = cancel;
    result.success = false;
    result.exitCode = 1;
    result.interrupted = undefined;
    result.pause = undefined;
    result.terminationReason = "cancelled";
}
export function applyCancelledStatusStepProjection(step, cancel) {
    if (!cancel || step.status === "complete" || step.status === "failed")
        return;
    step.status = "cancelled";
    step.pause = undefined;
    step.cancel = cancel;
    step.error = cancel.summary || "Cancelled by parent abort.";
    step.exitCode = 1;
    step.terminationReason = "cancelled";
    step.interruptRequestedAt = undefined;
}
export function normalizeFailedSupervisorPauseResults(results, steps, requesterIndex, fallbackAgent) {
    for (const result of results) {
        if (result.interrupted ||
            result.pause?.kind === "awaiting_supervisor" ||
            result.pause?.kind === "cohort_pause") {
            result.output = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            result.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
            result.success = false;
            result.exitCode = 1;
            result.terminationReason = result.terminationReason ?? "process_exit";
            result.interrupted = undefined;
            result.pause = undefined;
            result.activityState = undefined;
        }
    }
    if (results.length === 0) {
        results.push({
            agent: steps[requesterIndex]?.agent ?? fallbackAgent,
            ...(steps[requesterIndex]?.projectAgent
                ? { projectAgent: steps[requesterIndex].projectAgent }
                : {}),
            ticketId: steps[requesterIndex]?.ticketId,
            output: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
            error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
            success: false,
            exitCode: 1,
            terminationReason: "process_exit",
        });
    }
}
