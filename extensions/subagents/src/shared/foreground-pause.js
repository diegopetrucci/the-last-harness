export const UNCHANGED_SUPERVISOR_RESUME_MESSAGE = "Continue under the existing task and instructions. If the unresolved supervisor decision is still required, pause again rather than guess.";
export const FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE = "Foreground supervisor lifecycle update failed. Check status for the paused run and retry resume or cancel if needed.";
export function formatForegroundPauseMessage(input) {
    const resumeLine = input.resume.kind === "single"
        ? `Resume: subagent({ action: "resume", id: "${input.runId}", message: "..." })`
        : input.resume.example
            ? `Resume a paused child by index, e.g. subagent({ action: "resume", id: "${input.runId}", index: ${input.resume.index}, message: "..." })`
            : `Resume the paused child: subagent({ action: "resume", id: "${input.runId}", index: ${input.resume.index}, message: "..." })`;
    return [
        input.headline,
        "Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error.",
        "Note: doctor/status may show no active run after a foreground pause because the child process has stopped.",
        "Use status and the canonical child session for ordinary recovery; compact mode may omit the optional diagnostic child transcript.",
        "Next actions:",
        `- ${resumeLine}`,
        `- Replace/re-dispatch: ${input.redispatch}`,
        "- Stop: leave the run paused if no follow-up is needed.",
    ].join("\n");
}
export function formatForegroundSupervisorPauseMessage(input) {
    const targetSuffix = input.index === undefined ? "" : `, index: ${input.index}`;
    const pausedTarget = input.index === undefined ? "run" : "child";
    return [
        input.headline,
        "Pause succeeded; this run is durably paused awaiting supervisor guidance.",
        "No child process is running.",
        "Use status and the canonical child session for ordinary recovery; compact mode may omit the optional diagnostic child transcript.",
        ...(input.requestSummary ? [`Request: ${input.requestSummary}`] : []),
        "Next actions:",
        ...(input.claimUnavailable
            ? [
                `- Resume unchanged: unavailable; this paused ${pausedTarget} is already claimed for continuation.`,
                `- Resume with guidance: unavailable; this paused ${pausedTarget} is already claimed for continuation.`,
                "- Cancel: unavailable while continuation launch is finalizing.",
            ]
            : [
                `- Resume unchanged: subagent({ action: "resume", id: "${input.runId}"${targetSuffix} })`,
                `- Resume with guidance: subagent({ action: "resume", id: "${input.runId}"${targetSuffix}, message: "Supervisor replied: ..." })`,
                `- Cancel: subagent({ action: "interrupt", id: "${input.runId}"${targetSuffix} })`,
            ]),
    ].join("\n");
}
