import { requestInterruptAllRunningSubagentRuns } from "../runs/foreground/subagent-executor.js";
function formatRunCount(total, foreground, async) {
    const parts = [];
    if (foreground > 0)
        parts.push(`${foreground} foreground`);
    if (async > 0)
        parts.push(`${async} async`);
    return `Pause requested for ${total} subagent run${total === 1 ? "" : "s"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
}
export function handlePauseAllShortcut(state, ctx) {
    const summary = requestInterruptAllRunningSubagentRuns(state);
    const interruptedTotal = summary.foregroundRunIds.length + summary.asyncRunIds.length;
    const skippedTotal = summary.skippedForegroundRunIds.length + summary.skippedAsyncRunIds.length;
    const failedTotal = summary.errors.length;
    let result;
    if (interruptedTotal === 0) {
        result = {
            level: "warning",
            message: failedTotal > 0
                ? `Failed to request a pause for running subagent work. ${summary.errors[0]}`
                : skippedTotal > 0
                    ? "No running subagent work exposed an interrupt path to pause."
                    : "No running subagent work to pause.",
        };
    }
    else {
        const notes = [];
        if (skippedTotal > 0)
            notes.push(`skipped ${skippedTotal}`);
        if (failedTotal > 0)
            notes.push(`failed ${failedTotal}`);
        result = {
            level: notes.length > 0 ? "warning" : "info",
            message: `${formatRunCount(interruptedTotal, summary.foregroundRunIds.length, summary.asyncRunIds.length)}${notes.length > 0 ? ` ${notes.join(" · ")}.` : ""}`,
        };
    }
    if (ctx.hasUI)
        ctx.ui.notify(result.message, result.level);
    return result;
}
