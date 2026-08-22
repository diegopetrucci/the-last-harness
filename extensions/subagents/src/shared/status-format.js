function formatActivityAge(ms) {
    if (ms < 1000)
        return "now";
    if (ms < 60000)
        return `${Math.floor(ms / 1000)}s`;
    return `${Math.floor(ms / 60000)}m`;
}
function agelessActivityLabel(activityState) {
    if (activityState === undefined)
        return undefined;
    if (activityState === "needs_attention")
        return "needs attention";
    if (activityState === "active_long_running")
        return "active but long-running";
    void activityState;
}
export function formatActivityLabel(lastActivityAt, activityState, now = Date.now()) {
    if (lastActivityAt === undefined)
        return agelessActivityLabel(activityState);
    const age = formatActivityAge(Math.max(0, now - lastActivityAt));
    if (age === "now")
        return agelessActivityLabel(activityState) ?? "active now";
    if (activityState === "needs_attention")
        return `no activity for ${age}`;
    if (activityState === "active_long_running")
        return `active but long-running · last activity ${age} ago`;
    if (activityState !== undefined)
        void activityState;
    return `active ${age} ago`;
}
function isCompletedStepStatus(status) {
    return status === "complete" || status === "completed";
}
export function aggregateStepStatus(steps) {
    if (steps.some((step) => step.status === "running"))
        return "running";
    if (steps.some((step) => step.status === "failed"))
        return "failed";
    if (steps.some((step) => step.status === "paused"))
        return "paused";
    if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status)))
        return "complete";
    return "pending";
}
function formatAgentRunningLabel(count) {
    return count === 1 ? "1 agent running" : `${count} agents running`;
}
export function formatParallelOutcome(steps, total, options = {}) {
    const running = steps.filter((step) => step.status === "running").length;
    const done = steps.filter((step) => isCompletedStepStatus(step.status)).length;
    const failed = steps.filter((step) => step.status === "failed").length;
    const paused = steps.filter((step) => step.status === "paused").length;
    const parts = [`${done}/${total} done`];
    if (options.showRunning !== false && running > 0)
        parts.unshift(formatAgentRunningLabel(running));
    if (failed > 0)
        parts.push(`${failed} failed`);
    if (paused > 0)
        parts.push(`${paused} paused`);
    return parts.join(" · ");
}
