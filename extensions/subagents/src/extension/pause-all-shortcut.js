// Generated from extensions/subagents/src/extension/pause-all-shortcut.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { requestInterruptAllRunningSubagentRuns } from "./subagent-executor.js";
import { resolveCurrentSessionId } from "../shared/session-identity.js";
function formatRunCount(total) {
    return `Pause requested for ${total} subagent run${total === 1 ? "" : "s"}.`;
}
export function handlePauseAllShortcut(state, ctx) {
    let callerKey;
    try {
        callerKey = resolveCurrentSessionId(ctx.sessionManager);
    }
    catch {
        callerKey = undefined;
    }
    const summary = requestInterruptAllRunningSubagentRuns(state, callerKey);
    const interruptedTotal = summary.asyncRunIds.length;
    const skippedTotal = summary.skippedAsyncRunIds.length;
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
            message: `${formatRunCount(interruptedTotal)}${notes.length > 0 ? ` ${notes.join(" · ")}.` : ""}`,
        };
    }
    if (ctx.hasUI)
        ctx.ui.notify(result.message, result.level);
    return result;
}
