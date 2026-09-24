/** Status-driven progress projection for awaited async subagent runs. */

import type { AwaitedRunOwnerOptions, AwaitedRunResult } from "./awaited-run-owner.ts";
import type { RunnerSubagentStep, SubagentRunPlan } from "../shared/parallel-utils.ts";
import { sanitizeSummary } from "../shared/nested-events.ts";
import { canonicalLifecycleStepState } from "./async-status-boundary.ts";
import type {
  AgentProgress,
  AsyncStatus,
  Details,
  NestedRunSummary,
  SingleResult,
  Usage,
} from "../../shared/types.ts";

type AwaitedProgressInput = Pick<
  AwaitedRunOwnerOptions,
  "id" | "asyncDir" | "mode" | "plan" | "timeoutMs" | "deadlineAt"
>;

type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];
type AsyncStatusStepStatus = AsyncStatusStep["status"];

type ProgressFlags = {
  paused: boolean;
  failed: boolean;
  complete: boolean;
};

type AwaitedProgressResult = SingleResult & {
  totalCost?: AsyncStatusStep["totalCost"];
};

function progressStatusForStep(status: AsyncStatusStepStatus): AgentProgress["status"] {
  switch (canonicalLifecycleStepState(status)) {
    case "pending":
      return "pending";
    case "failed":
    case "cancelled":
      return "failed";
    case "complete":
      return "completed";
    case "running":
    case "pausing":
    case "paused":
      return "running";
  }
}

function progressFlags(
  step: AsyncStatusStep | undefined,
  status: AsyncStatusStepStatus,
): ProgressFlags {
  return {
    paused: step?.status === "paused" || step?.status === "pausing",
    failed:
      canonicalLifecycleStepState(status) === "failed" ||
      canonicalLifecycleStepState(status) === "cancelled",
    complete: canonicalLifecycleStepState(status) === "complete",
  };
}

function progressUsageForStep(step: AsyncStatusStep | undefined): Usage {
  return {
    input: step?.tokens?.input ?? 0,
    output: step?.tokens?.output ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: step?.totalCost?.costUsd ?? 0,
    turns: step?.turnCount ?? 0,
  };
}

function progressTokensForStep(step: AsyncStatusStep | undefined): number {
  return step?.tokens?.total ?? 0;
}

function emptyProgressUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function nestedChildren(value: unknown): NestedRunSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const children = value
    .map((child) => sanitizeSummary(child))
    .filter((child): child is NestedRunSummary => Boolean(child));
  return children.length > 0 ? children : undefined;
}

function plannedStepsForPlan(plan: SubagentRunPlan): RunnerSubagentStep[] {
  return plan.kind === "single" ? [plan.task] : plan.tasks;
}

function buildProgressItem(input: {
  index: number;
  agent: string;
  task: string;
  stepStatus: AsyncStatusStepStatus;
  step: AsyncStatusStep | undefined;
  recentOutput: string[];
  durationMs: number;
  skills: string[] | undefined;
}): AgentProgress {
  const { index, agent, task, stepStatus, step, recentOutput, durationMs, skills } = input;
  const progress: AgentProgress = {
    index,
    agent,
    status: progressStatusForStep(stepStatus),
    task,
    lastActivityAt:
      step?.lastActivityAt !== undefined && step.startedAt !== undefined
        ? Math.max(step.lastActivityAt, step.startedAt)
        : (step?.lastActivityAt ?? step?.startedAt),
    currentTool: step?.currentTool,
    currentToolArgs: step?.currentToolArgs,
    currentToolStartedAt: step?.currentToolStartedAt,
    currentPath: step?.currentPath,
    recentTools: step?.recentTools?.map((tool) => ({ ...tool })) ?? [],
    recentOutput,
    toolCount: step?.toolCount ?? 0,
    turnCount: step?.turnCount,
    tokens: progressTokensForStep(step),
    durationMs,
    error: step?.error,
  };
  if (skills) progress.skills = [...skills];
  return progress;
}

function applyProgressOutcome(
  result: AwaitedProgressResult,
  flags: ProgressFlags,
  step: AsyncStatusStep | undefined,
  skills: string[] | undefined,
  skillsWarning: string | undefined,
): void {
  if (flags.paused) result.interrupted = true;
  if (step?.timedOut) result.timedOut = true;
  if (step?.error) result.error = step.error;
  if (skills) result.skills = [...skills];
  if (skillsWarning) result.skillsWarning = skillsWarning;
}

function applyProgressModelProjection(
  result: AwaitedProgressResult,
  step: AsyncStatusStep | undefined,
  planned: RunnerSubagentStep | undefined,
): void {
  if (step?.model ?? planned?.model) result.model = step?.model ?? planned?.model;
  if (step?.thinking ?? planned?.thinking) result.thinking = step?.thinking ?? planned?.thinking;
  if (step?.modelIdentity ?? planned?.modelIdentity)
    result.modelIdentity = step?.modelIdentity ?? planned?.modelIdentity;
  if (step?.modelResolution) result.modelResolution = step.modelResolution;
  if (step?.attemptedModels) result.attemptedModels = [...step.attemptedModels];
  if (step?.modelAttempts) {
    result.modelAttempts = step.modelAttempts.map((attempt) => ({
      ...attempt,
      usage: attempt.usage ? { ...attempt.usage } : undefined,
    }));
  }
  if (step?.modelFallbackNotice) result.modelFallbackNotice = step.modelFallbackNotice;
}

function applyProgressDiagnostics(
  result: AwaitedProgressResult,
  step: AsyncStatusStep | undefined,
): void {
  if (step?.totalCost) result.totalCost = { ...step.totalCost };
  if (step?.contextUsage) result.contextUsage = step.contextUsage;
  if (step?.contextPressure) result.contextPressure = step.contextPressure;
  if (step?.contextPressureCrossedThresholds)
    result.contextPressureCrossedThresholds = [...step.contextPressureCrossedThresholds];
}

function applyProgressLifecycle(
  result: AwaitedProgressResult,
  status: AsyncStatusStepStatus,
  flags: ProgressFlags,
  step: AsyncStatusStep | undefined,
  planned: RunnerSubagentStep | undefined,
): void {
  if (step?.terminationReason) result.terminationReason = step.terminationReason;
  if (step?.sessionFile ?? planned?.sessionFile)
    result.sessionFile = step?.sessionFile ?? planned?.sessionFile;
  if (flags.paused && step?.pause) result.pause = step.pause;
  if (step?.cancel) result.cancel = step.cancel;
  if (step?.projectAgent ?? planned?.projectAgent)
    result.projectAgent = step?.projectAgent ?? planned?.projectAgent;
  if (step?.childLocation ?? planned?.childLocation)
    result.childLocation = step?.childLocation ?? planned?.childLocation;
  if (step?.children?.length) result.children = nestedChildren(step.children);
  if (status === "cancelled" && !result.terminationReason) result.terminationReason = "cancelled";
}

function buildProgressResult(input: {
  agent: string;
  task: string;
  status: AsyncStatusStepStatus;
  step: AsyncStatusStep | undefined;
  planned: RunnerSubagentStep | undefined;
  flags: ProgressFlags;
  skills: string[] | undefined;
  skillsWarning: string | undefined;
  usage: Usage;
  finalOutput: string;
}): AwaitedProgressResult {
  const { agent, task, status, step, planned, flags, skills, skillsWarning, usage, finalOutput } =
    input;
  const result: AwaitedProgressResult = {
    agent,
    task,
    exitCode: flags.complete ? 0 : flags.failed ? 1 : 0,
    usage,
    finalOutput,
  };
  applyProgressOutcome(result, flags, step, skills, skillsWarning);
  applyProgressModelProjection(result, step, planned);
  applyProgressDiagnostics(result, step);
  applyProgressLifecycle(result, status, flags, step, planned);
  return result;
}

function buildAwaitedProgressStep(
  status: AsyncStatus,
  index: number,
  planned: RunnerSubagentStep | undefined,
  persisted: AsyncStatusStep | undefined,
  now: () => number,
): { progress: AgentProgress; result: SingleResult } {
  const stepStatus = persisted?.status ?? "pending";
  const flags = progressFlags(persisted, stepStatus);
  const recentOutput = persisted?.recentOutput ? [...persisted.recentOutput] : [];
  const task = planned?.task ?? "";
  const agent = persisted?.agent ?? planned?.agent ?? `step-${index + 1}`;
  const skills = persisted?.skills ?? planned?.skills;
  const skillsWarning = persisted?.skillsWarning ?? planned?.skillsWarning;
  const finalOutput = recentOutput.join("\n") || persisted?.error || "";
  const durationMs =
    persisted?.durationMs ??
    (persisted?.startedAt !== undefined ? Math.max(0, now() - persisted.startedAt) : 0);
  const progress = buildProgressItem({
    index,
    agent,
    task,
    stepStatus,
    step: persisted,
    recentOutput,
    durationMs,
    skills,
  });
  const result = buildProgressResult({
    agent,
    task,
    status: stepStatus,
    step: persisted,
    planned,
    flags,
    skills,
    skillsWarning,
    usage: persisted ? progressUsageForStep(persisted) : emptyProgressUsage(),
    finalOutput,
  });
  if (progress.lastActivityAt === undefined) progress.lastActivityAt = status.startedAt;
  return { progress, result };
}

export function buildAwaitedProgressUpdate(
  input: AwaitedProgressInput,
  status: AsyncStatus,
  now: () => number,
): AwaitedRunResult {
  const plannedSteps = plannedStepsForPlan(input.plan);
  const persistedSteps = status.steps ?? [];
  const stepCount = Math.max(plannedSteps.length, persistedSteps.length);
  const progress: AgentProgress[] = [];
  const results: SingleResult[] = [];
  for (let index = 0; index < stepCount; index++) {
    const projected = buildAwaitedProgressStep(
      status,
      index,
      plannedSteps[index],
      persistedSteps[index],
      now,
    );
    progress.push(projected.progress);
    results.push(projected.result);
  }
  const isPausedRun = status.state === "paused" || status.state === "pausing";
  const statusText = isPausedRun ? "paused" : status.state === "running" ? "running" : status.state;
  const active = progress
    .filter((item) => item.status === "running")
    .map((item) => (item.currentTool ? `${item.agent}: ${item.currentTool}` : item.agent));
  const text = `Async ${input.mode} run ${input.id}: ${statusText}${active.length ? ` (${active.join(", ")})` : ""}`;
  const details: Details = {
    mode: input.mode,
    runId: input.id,
    results,
    progress,
    asyncId: input.id,
    asyncDir: input.asyncDir,
    totalSteps: stepCount,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    ...(status.totalTokens
      ? {
          totalChildUsage: {
            input: status.totalTokens.input,
            output: status.totalTokens.output,
            cacheRead: 0,
            cacheWrite: 0,
            cost: status.totalCost?.costUsd ?? 0,
            turns: 0,
          },
        }
      : {}),
    ...(status.totalCost ? { totalCost: { ...status.totalCost } } : {}),
  };
  return { content: [{ type: "text", text }], details };
}
