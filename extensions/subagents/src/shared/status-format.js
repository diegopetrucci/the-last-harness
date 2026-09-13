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
    if (activityState !== undefined)
        void activityState;
    return `active ${age} ago`;
}
function isCompletedStepStatus(status) {
    return status === "complete" || status === "completed";
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
