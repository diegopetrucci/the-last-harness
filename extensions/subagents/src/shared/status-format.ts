import type { ActivityState, AsyncJobStep } from "./types.ts";

type StepStatusLike = Pick<AsyncJobStep, "status">;

function formatActivityAge(ms: number): string {
  if (ms < 1000) return "now";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m`;
}

/** Activity label with no age clause, used when the age is unknown or too small to be meaningful. */
function agelessActivityLabel(activityState: ActivityState | undefined): string | undefined {
  if (activityState === undefined) return undefined;
  if (activityState === "needs_attention") return "needs attention";
  if (activityState === "active_long_running") return "active but long-running";
  // Exhaustiveness guard: a future ActivityState member is a compile error here
  // rather than silently falling through to 'active now'.
  void (activityState satisfies never);
}

export function formatActivityLabel(
  lastActivityAt: number | undefined,
  activityState?: ActivityState,
  now = Date.now(),
): string | undefined {
  if (lastActivityAt === undefined) return agelessActivityLabel(activityState);
  const age = formatActivityAge(Math.max(0, now - lastActivityAt));
  // A sub-second age is too small to be meaningful, so omit the age clause entirely and reuse the
  // ageless label rather than asserting an age. This invents no new vocabulary and stays consistent
  // across branches. The information loss is negligible: the sub-second window is transient, and the
  // next render shows a real age (e.g. "last activity 2s ago").
  if (age === "now") return agelessActivityLabel(activityState) ?? "active now";
  if (activityState === "needs_attention") return `no activity for ${age}`;
  if (activityState === "active_long_running")
    return `active but long-running · last activity ${age} ago`;
  // Non-health activityState is undefined here (checked above). A future member would
  // be a compile error rather than a silent fallback.
  if (activityState !== undefined) void (activityState satisfies never);
  return `active ${age} ago`;
}

function isCompletedStepStatus(status: AsyncJobStep["status"]): boolean {
  return status === "complete" || status === "completed";
}

export function aggregateStepStatus(steps: StepStatusLike[]): AsyncJobStep["status"] {
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "paused")) return "paused";
  if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status)))
    return "complete";
  return "pending";
}

function formatAgentRunningLabel(count: number): string {
  return count === 1 ? "1 agent running" : `${count} agents running`;
}

export function formatParallelOutcome(
  steps: StepStatusLike[],
  total: number,
  options: { showRunning?: boolean } = {},
): string {
  const running = steps.filter((step) => step.status === "running").length;
  const done = steps.filter((step) => isCompletedStepStatus(step.status)).length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const paused = steps.filter((step) => step.status === "paused").length;
  const parts = [`${done}/${total} done`];
  if (options.showRunning !== false && running > 0) parts.unshift(formatAgentRunningLabel(running));
  if (failed > 0) parts.push(`${failed} failed`);
  if (paused > 0) parts.push(`${paused} paused`);
  return parts.join(" · ");
}
