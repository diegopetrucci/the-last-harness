interface SupervisorPauseMessageInput {
  headline: string;
  runId: string;
  agent: string;
  requestSummary?: string;
  claimUnavailable?: boolean;
  index?: number;
}

export const UNCHANGED_SUPERVISOR_RESUME_MESSAGE =
  "Continue under the existing task and instructions. If the unresolved supervisor decision is still required, pause again rather than guess.";
export const SUPERVISOR_LIFECYCLE_ERROR_MESSAGE =
  "Supervisor lifecycle update failed. Check status for the paused run and retry resume or cancel if needed.";

export function formatSupervisorPauseMessage(input: SupervisorPauseMessageInput): string {
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
