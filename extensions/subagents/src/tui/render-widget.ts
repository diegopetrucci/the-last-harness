/**
 * Async subagent widget rendering, including adaptive layout state.
 */

import * as path from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { type SubagentLiveDetailController } from "../shared/subagent-shortcuts.ts";
import {
  type ActivityState,
  type AsyncJobState,
  type AsyncJobStep,
  type NestedRunSummary,
  type NestedStepSummary,
  MAX_WIDGET_JOBS,
  WIDGET_KEY,
} from "../shared/types.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { countNestedRuns } from "../runs/shared/nested-render.ts";
import { normalizeTkTicketMetadata } from "../runs/shared/tk-ticket.ts";
import { isProtectedPausedLifecycle } from "../runs/shared/lifecycle-privacy.ts";
import { safeTerminalText } from "../shared/display-text.ts";
import {
  buildLiveStatusLine,
  compactThinkingPhrase,
  isHealthActivityState,
  fitInlineActivity,
  fitInlineThinkingActivity,
  fitCompactToolStatus,
  formatCurrentToolLines,
  formatTokenStat,
  formatToolUseStat,
  getTermWidth,
  liveDetailHintText,
  liveDetailKeyText,
  modelThinkingBadge,
  runningGlyph,
  runningSeed,
  statJoin,
  themeBold,
  type Theme,
  wrapDisplayLine,
  wrapDisplayLines,
} from "./render-primitives.ts";

const WIDGET_ACTIVITY_PREFIX = "    ⎿  ";
const WIDGET_ACTIVITY_CONTINUATION_PREFIX = "       ";

export function widgetRenderKey(job: AsyncJobState): string {
  return JSON.stringify({
    asyncDir: job.asyncDir,
    status: job.status,
    activityState: job.activityState,
    lastActivityAt: job.lastActivityAt,
    currentTool: job.currentTool,
    currentToolStartedAt: job.currentToolStartedAt,
    currentPath: job.currentPath,
    turnCount: job.turnCount,
    toolCount: job.toolCount,
    mode: job.mode,
    agents: job.agents,
    currentStep: job.currentStep,
    steps: job.steps,
    nestedChildren: job.nestedChildren,
    stepsTotal: job.stepsTotal,
    runningSteps: job.runningSteps,
    completedSteps: job.completedSteps,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    activeRuntimeMs: job.activeRuntimeMs,
    activeRuntimeCheckpointAt: job.activeRuntimeCheckpointAt,
    totalTokens: job.totalTokens,
    tkTicket: job.tkTicket,
  });
}

function formatWidgetAgents(agents: string[]): string {
  const safeAgents = agents.map((agent) => safeTerminalText(agent));
  const distinct = [...new Set(safeAgents)];
  if (distinct.length === 1 && safeAgents.length > 1) return `${distinct[0]} ×${safeAgents.length}`;
  if (safeAgents.length > 3)
    return `${safeAgents.slice(0, 2).join(", ")} +${safeAgents.length - 2} more`;
  return safeAgents.join(", ");
}

function widgetJobName(job: AsyncJobState): string {
  if (job.mode === "parallel") return "parallel";
  if (job.mode === "single" && job.agents?.length === 1) return safeTerminalText(job.agents[0]!);
  if (job.agents?.length) return formatWidgetAgents(job.agents);
  return safeTerminalText(job.mode ?? "subagent");
}

function isProtectedWidgetLifecycle(state: string, interruptRequestedAt?: number): boolean {
  return (
    state === "paused" ||
    isProtectedPausedLifecycle({
      state: state === "running" && interruptRequestedAt !== undefined ? "pausing" : state,
    })
  );
}

function isCompletedWidgetStepStatus(status: AsyncJobStep["status"]): boolean {
  return status === "complete" || status === "completed" || status === "continued";
}

function projectContinuedWidgetStep(
  job: Pick<AsyncJobState, "status">,
  step: AsyncJobStep,
): AsyncJobStep {
  if (job.status !== "continued") return step;
  const status =
    step.status === "running" || step.status === "pausing" || step.status === "paused"
      ? ("continued" as const)
      : step.status;
  return {
    ...step,
    status,
    activityState: undefined,
    idleEpisodeId: undefined,
    compaction: undefined,
    lastActivityAt: undefined,
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    currentPath: undefined,
    interruptRequestedAt: undefined,
  };
}

function widgetRunningStep(job: AsyncJobState): AsyncJobStep | undefined {
  return job.steps?.find((step) => step.status === "running");
}

function widgetActiveStep(job: AsyncJobState): AsyncJobStep | undefined {
  return job.steps?.find((step) => step.status === "running" && Boolean(step.currentTool));
}

function widgetActivityState(
  job: AsyncJobState,
  runningStep?: AsyncJobStep,
): ActivityState | undefined {
  // Job summaries use the aggregate projection. Per-child rows read each step's
  // own projection in widgetParallelAgentDetails and foregroundStyleWidgetDetails.
  return (
    job.activityState ??
    job.steps?.find(
      (step) => step.status === "running" && isHealthActivityState(step.activityState),
    )?.activityState ??
    runningStep?.activityState
  );
}

function widgetHasPausingStep(job: AsyncJobState): boolean {
  return (
    job.status === "running" &&
    (job.steps?.some((step) => step.interruptRequestedAt !== undefined) ?? false)
  );
}

function widgetInlineThinkingActivity(
  job: AsyncJobState,
): { phrase: string; freshness: string } | undefined {
  if (
    job.status !== "running" ||
    job.interruptRequestedAt !== undefined ||
    job.currentTool ||
    widgetActiveStep(job) ||
    widgetHasPausingStep(job)
  )
    return undefined;
  const runningStep = widgetRunningStep(job);
  const activityState = widgetActivityState(job, runningStep);
  if (isHealthActivityState(activityState)) return undefined;
  const freshness = buildLiveStatusLine(
    {
      activityState,
      lastActivityAt: job.lastActivityAt ?? runningStep?.lastActivityAt,
    },
    job.updatedAt,
  );
  if (!freshness) return undefined;
  return {
    phrase: compactThinkingPhrase(activityState, job.turnCount ?? runningStep?.turnCount)!,
    freshness,
  };
}

function widgetActivityLines(job: AsyncJobState, expanded = false): string[] {
  if (job.status === "continued") return ["continued"];
  const privacySafe = isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt);
  const runningStep = widgetRunningStep(job);
  if (job.interruptRequestedAt !== undefined && job.status === "running") {
    const facts: string[] = [];
    const currentTool = job.currentTool ? safeTerminalText(job.currentTool) : undefined;
    if (currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined)
      facts.push(
        `${currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`,
      );
    else if (currentTool) facts.push(currentTool);
    return [facts.length > 0 ? `pausing… · ${facts.join(" · ")}` : "pausing…"];
  }
  if (widgetHasPausingStep(job)) return ["pausing…"];
  const activeStep = widgetActiveStep(job);
  const activityStep = activeStep ?? runningStep;
  const currentToolValue = job.currentTool ?? activeStep?.currentTool;
  const currentTool = currentToolValue ? safeTerminalText(currentToolValue) : undefined;
  const currentToolStartedAt = job.currentToolStartedAt ?? activeStep?.currentToolStartedAt;
  const currentPath = job.currentPath ?? activeStep?.currentPath;
  const lastActivityAt = job.lastActivityAt ?? activityStep?.lastActivityAt;
  const activityState = widgetActivityState(job, runningStep);
  const turnCount = job.turnCount ?? activityStep?.turnCount;
  const facts: string[] = [];
  if (currentTool && currentToolStartedAt !== undefined && job.updatedAt !== undefined)
    facts.push(
      `${currentTool} ${formatDuration(Math.max(0, job.updatedAt - currentToolStartedAt))}`,
    );
  else if (currentTool) facts.push(currentTool);
  if (!privacySafe && currentPath) facts.push(safeTerminalText(shortenPath(currentPath)));
  if (expanded) {
    if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
    if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
    if (job.totalTokens?.total) facts.push(formatTokenStat(job.totalTokens.total));
  }
  const activity = buildLiveStatusLine({ activityState, lastActivityAt }, job.updatedAt);
  if (!currentTool && !expanded && job.status === "running") {
    return [compactThinkingPhrase(activityState, turnCount), activity, ...facts].filter(
      (line): line is string => Boolean(line),
    );
  }
  if (activity && facts.length) return [`${activity} · ${facts.join(" · ")}`];
  if (activity) return [activity];
  if (facts.length) return [facts.join(" · ")];
  if (job.status === "running")
    return [
      expanded ? "thinking…" : (compactThinkingPhrase(activityState, turnCount) ?? "thinking…"),
    ];
  if (job.status === "queued") return ["queued…"];
  if (job.status === "paused") return ["Paused"];
  if (job.status === "failed") return ["Failed"];
  return ["Done"];
}

function widgetActivity(job: AsyncJobState, expanded = false): string {
  return widgetActivityLines(job, expanded).join(" · ");
}

function widgetActivityDetailLines(job: AsyncJobState, theme: Theme, expanded = false): string[] {
  return widgetActivityLines(job, expanded).map(
    (activity, index) => `  ${theme.fg("dim", index === 0 ? `⎿  ${activity}` : `   ${activity}`)}`,
  );
}

function widgetStepRunningSeed(
  step: NonNullable<AsyncJobState["steps"]>[number],
  fallbackIndex?: number,
): number | undefined {
  return runningSeed(
    fallbackIndex,
    step.index,
    step.toolCount,
    step.turnCount,
    step.tokens?.total,
    step.lastActivityAt,
    step.currentToolStartedAt,
    step.durationMs,
  );
}

function widgetStepsRunningSeed(
  steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined,
): number | undefined {
  let seed: number | undefined;
  for (const [index, step] of (steps ?? []).entries())
    seed = runningSeed(seed, widgetStepRunningSeed(step, index));
  return seed;
}

function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
  return runningSeed(
    job.updatedAt,
    job.lastActivityAt,
    job.toolCount,
    job.turnCount,
    job.totalTokens?.total,
    job.currentStep,
    job.runningSteps,
    job.completedSteps,
    widgetStepsRunningSeed(job.steps),
  );
}

function widgetJobsRunningSeed(jobs: AsyncJobState[]): number | undefined {
  let seed: number | undefined;
  for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
  return seed;
}

function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
  if (job.status === "running") return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
  if (job.status === "queued") return theme.fg("muted", "◦");
  if (job.status === "complete" || job.status === "continued") return theme.fg("success", "✓");
  if (job.status === "paused") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number): string {
  if (status === "running") return theme.fg("accent", runningGlyph(seed));
  if (status === "complete" || status === "completed" || status === "continued")
    return theme.fg("success", "✓");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "paused") return theme.fg("warning", "■");
  return theme.fg("muted", "◦");
}

function widgetStepStatus(
  status: AsyncJobStep["status"],
  theme: Theme,
  interruptRequestedAt?: number,
): string {
  if (status === "running" && interruptRequestedAt !== undefined)
    return theme.fg("accent", "pausing");
  if (status === "running") return "";
  if (status === "complete" || status === "completed") return theme.fg("success", "complete");
  if (status === "continued") return theme.fg("success", "continued");
  if (status === "failed") return theme.fg("error", "failed");
  if (status === "paused") return theme.fg("warning", "paused");
  return theme.fg("dim", safeTerminalText(status));
}

const TK_TICKET_WIDGET_PREFIX = "ticket: ";

function widgetTkTicketText(job: AsyncJobState): string | undefined {
  if (!job.tkTicket || (job.status !== "running" && job.status !== "queued")) return undefined;
  const normalizedTkTicket = normalizeTkTicketMetadata(job.tkTicket);
  return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}

function widgetTkTicketLine(job: AsyncJobState, theme: Theme, indent = "  "): string | undefined {
  const ticket = widgetTkTicketText(job);
  return ticket ? `${indent}${theme.fg("dim", ticket)}` : undefined;
}

function widgetTkTicketLines(job: AsyncJobState, theme: Theme, indent = "  "): string[] {
  const line = widgetTkTicketLine(job, theme, indent);
  return line ? [line] : [];
}

function widgetStepActivity(
  step: NonNullable<AsyncJobState["steps"]>[number],
  snapshotNow?: number,
  expanded = false,
): string {
  if (step.status === "continued") return "";
  const privacySafe = isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt);
  if (step.interruptRequestedAt !== undefined) return "pausing…";
  const facts: string[] = [];
  const currentTool = step.currentTool ? safeTerminalText(step.currentTool) : undefined;
  if (currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined)
    facts.push(
      `${currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`,
    );
  else if (currentTool) facts.push(currentTool);
  if (!privacySafe && step.currentPath) facts.push(safeTerminalText(shortenPath(step.currentPath)));
  if (expanded) {
    if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
    if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
    if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
    if (step.durationMs !== undefined) facts.push(formatDuration(step.durationMs));
  }
  const activity = buildLiveStatusLine(step, snapshotNow);
  if (!step.currentTool && !expanded && step.status === "running") {
    return [compactThinkingPhrase(step.activityState, step.turnCount), activity, ...facts]
      .filter(Boolean)
      .join(" · ");
  }
  if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
  if (activity) return activity;
  if (facts.length) return facts.join(" · ");
  return step.status === "running"
    ? expanded
      ? "thinking…"
      : (compactThinkingPhrase(step.activityState, step.turnCount) ?? "thinking…")
    : "";
}

function widgetParallelAgentDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded = false,
  width = getTermWidth(),
): string[] {
  if (!job.steps?.length) return [];
  if (job.mode !== "parallel") return [];
  const total = job.stepsTotal ?? job.steps.length;
  const lines: string[] = [];
  for (const [index, step] of job.steps.entries()) {
    const displayStep = projectContinuedWidgetStep(job, step);
    const marker = index === job.steps.length - 1 ? "└" : "├";
    const activity = widgetStepActivity(displayStep, job.updatedAt, expanded);
    const itemTitle = "Agent";
    const modelDisplay = modelThinkingBadge(theme, displayStep.model, displayStep.thinking);
    const healthWarning =
      displayStep.interruptRequestedAt === undefined &&
      !displayStep.currentTool &&
      isHealthActivityState(displayStep.activityState)
        ? buildLiveStatusLine(displayStep, job.updatedAt)
        : undefined;
    const freshness =
      !expanded &&
      displayStep.status === "running" &&
      displayStep.interruptRequestedAt === undefined &&
      !displayStep.currentTool &&
      !healthWarning
        ? buildLiveStatusLine(displayStep, job.updatedAt)
        : undefined;
    const stepStatus = widgetStepStatus(
      displayStep.status,
      theme,
      displayStep.interruptRequestedAt,
    );
    const statusSuffix = stepStatus ? ` ${theme.fg("dim", "·")} ${stepStatus}` : "";
    const prefix = `  ${theme.fg("dim", `${marker} ${widgetStepGlyph(displayStep.status, theme, widgetStepRunningSeed(displayStep, index))} ${itemTitle} ${index + 1}/${total}: ${safeTerminalText(displayStep.agent)}${statusSuffix}${modelDisplay}`)}`;
    if (!expanded && healthWarning) {
      lines.push(...fitInlineActivity(prefix, healthWarning, theme, Math.max(1, width - 6)));
    } else if (freshness) {
      lines.push(
        ...fitInlineThinkingActivity(
          prefix,
          compactThinkingPhrase(displayStep.activityState, displayStep.turnCount)!,
          freshness,
          theme,
          Math.max(1, width - 6),
        ),
      );
    } else {
      lines.push(`${prefix}${activity ? ` · ${theme.fg("dim", activity)}` : ""}`);
    }
    for (const nestedLine of formatNestedWidgetLines(
      step.children,
      theme,
      width,
      expanded,
      job.updatedAt,
      expanded ? 8 : 1,
      isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt),
    ))
      lines.push(`    ${nestedLine}`);
  }
  return lines;
}
function widgetStats(
  job: AsyncJobState,
  theme: Theme,
  includeStepProgress = true,
  expanded = false,
): string {
  const parts: string[] = [];
  const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
  const projectedSteps =
    job.status === "continued"
      ? job.steps?.map((step) => projectContinuedWidgetStep(job, step))
      : undefined;
  const running =
    job.status === "continued" ? 0 : (job.runningSteps ?? (job.status === "running" ? 1 : 0));
  const done =
    job.status === "continued"
      ? (projectedSteps?.filter((step) => isCompletedWidgetStepStatus(step.status)).length ??
        stepsTotal)
      : (job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0));
  if (includeStepProgress && job.mode === "parallel") {
    if (job.status === "running" && running > 0 && job.interruptRequestedAt !== undefined)
      parts.push(`${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`);
    if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
  } else if (includeStepProgress && job.currentStep !== undefined) {
    parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
  } else if (includeStepProgress && stepsTotal > 1) {
    parts.push(`steps ${stepsTotal}`);
  }
  if (expanded) {
    if (job.turnCount !== undefined) parts.push(`${job.turnCount} turns`);
    if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
    if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
    if (job.startedAt !== undefined && job.updatedAt !== undefined)
      parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
  }
  return statJoin(theme, parts);
}

function widgetSummaryStats(job: AsyncJobState, theme: Theme, expanded = false): string {
  return widgetStats(job, theme, job.mode !== "single", expanded);
}

function widgetStepStats(
  theme: Theme,
  step: NonNullable<AsyncJobState["steps"]>[number],
  durationFallbackMs?: number,
  expanded = false,
): string {
  if (!expanded) return "";
  const durationMs = step.durationMs ?? durationFallbackMs;
  return statJoin(theme, [
    step.turnCount !== undefined ? `${step.turnCount} turns` : "",
    step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
    step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
    durationMs !== undefined ? formatDuration(durationMs) : "",
  ]);
}
function widgetStepActivityLines(
  step: NonNullable<AsyncJobState["steps"]>[number],
  firstWidth: number,
  continuationWidth: number,
  expanded: boolean,
  snapshotNow?: number,
  fitTrailingStatus = false,
): string[] {
  if (step.status === "continued") return [];
  if (step.interruptRequestedAt !== undefined) return ["pausing…"];
  const toolLines = formatCurrentToolLines(
    step,
    firstWidth,
    continuationWidth,
    expanded,
    snapshotNow,
  );
  const activity = buildLiveStatusLine(step, snapshotNow);
  if (toolLines) {
    if (fitTrailingStatus)
      return fitCompactToolStatus(toolLines, activity, firstWidth, continuationWidth);
    return [...toolLines, ...(activity && !toolLines.includes(activity) ? [activity] : [])];
  }
  if (!expanded && step.status === "running")
    return [
      compactThinkingPhrase(step.activityState, step.turnCount),
      ...(activity ? [activity] : []),
    ].filter((line): line is string => Boolean(line));
  if (activity) return [activity];
  if (step.status === "running") return ["thinking…"];
  return [];
}

function widgetOutputPath(
  job: AsyncJobState,
  step: NonNullable<AsyncJobState["steps"]>[number],
): string | undefined {
  if (typeof step.index !== "number") return undefined;
  return path.join(job.asyncDir, `output-${step.index}.log`);
}

function nestedRunName(run: NestedRunSummary): string {
  if (run.agent) return safeTerminalText(run.agent);
  if (run.agents?.length) return formatWidgetAgents(run.agents);
  return safeTerminalText(run.id);
}

function formatNestedWidgetAggregate(
  children: NestedRunSummary[] | undefined,
  theme: Theme,
): string | undefined {
  const counts = countNestedRuns(children);
  if (counts.total === 0) return undefined;
  const liveGlyph =
    counts.running > 0
      ? `${nestedStatusGlyph("running", theme, runningSeed(counts.running, counts.total))} `
      : "";
  const parts = [
    counts.paused > 0 ? `${counts.paused} paused` : "",
    counts.failed > 0 ? `${counts.failed} failed` : "",
    counts.complete > 0 ? `${counts.complete} complete` : "",
    counts.queued > 0 ? `${counts.queued} queued` : "",
  ].filter(Boolean);
  return `${liveGlyph}+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function nestedStatusGlyph(
  state: NestedRunSummary["state"] | NestedStepSummary["status"],
  theme: Theme,
  seed?: number,
): string {
  if (state === "running") return theme.fg("accent", runningGlyph(seed));
  if (state === "complete" || state === "completed") return theme.fg("success", "✓");
  if (state === "failed") return theme.fg("error", "✗");
  if (state === "paused") return theme.fg("warning", "■");
  return theme.fg("muted", "◦");
}

function nestedRunSeed(run: NestedRunSummary): number | undefined {
  return runningSeed(
    run.lastUpdate,
    run.lastActivityAt,
    run.currentStep,
    run.toolCount,
    run.turnCount,
    run.totalTokens?.total,
    run.currentToolStartedAt,
  );
}

function nestedActivity(
  input: Pick<
    NestedRunSummary | NestedStepSummary,
    | "activityState"
    | "lastActivityAt"
    | "currentTool"
    | "currentToolStartedAt"
    | "currentPath"
    | "turnCount"
    | "toolCount"
  > & { totalTokens?: NestedRunSummary["totalTokens"] },
  state: NestedRunSummary["state"] | NestedStepSummary["status"],
  snapshotNow?: number,
  privacySafe = false,
  expanded = false,
): string {
  const facts: string[] = [];
  const currentTool = input.currentTool ? safeTerminalText(input.currentTool) : undefined;
  if (currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined)
    facts.push(
      `${currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`,
    );
  else if (currentTool) facts.push(currentTool);
  if (!privacySafe && input.currentPath)
    facts.push(safeTerminalText(shortenPath(input.currentPath)));
  if (expanded) {
    if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
    if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
    if (input.totalTokens?.total) facts.push(formatTokenStat(input.totalTokens.total));
  }
  const activity = buildLiveStatusLine(input, snapshotNow);
  if (!input.currentTool && !expanded && state === "running") {
    return [compactThinkingPhrase(input.activityState, input.turnCount), activity, ...facts]
      .filter(Boolean)
      .join(" · ");
  }
  if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
  if (activity) return activity;
  if (facts.length) return facts.join(" · ");
  if (state === "running")
    return expanded
      ? "thinking…"
      : (compactThinkingPhrase(input.activityState, input.turnCount) ?? "thinking…");
  if (state === "queued" || state === "pending") return "queued…";
  if (state === "paused") return "Paused";
  if (state === "failed") return "Failed";
  return "Done";
}

function formatNestedWidgetLines(
  children: NestedRunSummary[] | undefined,
  theme: Theme,
  width: number,
  expanded: boolean,
  snapshotNow?: number,
  lineBudget = expanded ? 12 : 1,
  privacySafe = false,
): string[] {
  if (!children?.length || lineBudget <= 0) return [];
  if (!expanded) {
    const aggregate = formatNestedWidgetAggregate(children, theme);
    return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
  }
  const lines: string[] = [];
  const maxDepth = 2;
  const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
    if (!items?.length || lines.length >= lineBudget) return;
    if (depth > maxDepth) {
      const aggregate = formatNestedWidgetAggregate(items, theme);
      if (aggregate && lines.length < lineBudget)
        lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
      return;
    }
    for (let index = 0; index < items.length; index++) {
      const child = items[index]!;
      if (lines.length >= lineBudget) {
        const aggregate = formatNestedWidgetAggregate(items.slice(index), theme);
        if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
        return;
      }
      const activity = nestedActivity(
        child,
        child.state,
        snapshotNow ?? child.lastUpdate,
        privacySafe,
        expanded,
      );
      const error = child.error
        ? ` · ${privacySafe ? "lifecycle status requires attention" : safeTerminalText(child.error)}`
        : "";
      const status = child.state === "running" ? "" : ` · ${safeTerminalText(child.state)}`;
      lines.push(
        theme.fg(
          "dim",
          `${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)}${status} · ${activity}${error}`,
        ),
      );
      if (depth === maxDepth) {
        const aggregate = formatNestedWidgetAggregate(
          [
            ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
            ...(child.children ?? []),
          ],
          theme,
        );
        if (aggregate && lines.length < lineBudget)
          lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
        continue;
      }
      for (const step of child.steps ?? []) {
        if (lines.length >= lineBudget) return;
        const status = step.status === "running" ? "" : ` · ${safeTerminalText(step.status)}`;
        const stepAgent = safeTerminalText(step.agent);
        lines.push(
          theme.fg(
            "dim",
            `${prefix}  ↳ ${nestedStatusGlyph(step.status, theme)} ${stepAgent}${status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate, privacySafe, expanded)}`,
          ),
        );
        append(step.children, depth + 1, `${prefix}    `);
      }
      append(child.children, depth + 1, `${prefix}  `);
    }
  };
  append(children, 0, "");
  return wrapDisplayLines(lines, width);
}

function singleWidgetStepDisplayStatus(
  job: AsyncJobState,
  step: NonNullable<AsyncJobState["steps"]>[number],
): AsyncJobStep["status"] {
  const projectedStep = projectContinuedWidgetStep(job, step);
  if (projectedStep.status !== "running") return projectedStep.status;
  if (job.status === "complete" || job.status === "failed") return job.status;
  return projectedStep.status;
}

function foregroundStyleWidgetStepLines(
  job: AsyncJobState,
  theme: Theme,
  step: NonNullable<AsyncJobState["steps"]>[number],
  itemTitle: "Agent" | "Step" | undefined,
  index: number,
  total: number,
  expanded: boolean,
  width: number,
  displayStatus?: AsyncJobStep["status"],
): string[] {
  const displayStep = projectContinuedWidgetStep(job, step);
  const resolvedDisplayStatus = displayStatus ?? displayStep.status;
  const status = widgetStepStatus(
    resolvedDisplayStatus,
    theme,
    resolvedDisplayStatus === "running" ? displayStep.interruptRequestedAt : undefined,
  );
  const durationFallbackMs =
    itemTitle === undefined &&
    displayStep.status === "running" &&
    displayStep.durationMs === undefined &&
    job.startedAt !== undefined &&
    job.updatedAt !== undefined
      ? Math.max(0, job.updatedAt - job.startedAt)
      : undefined;
  const stats = widgetStepStats(theme, displayStep, durationFallbackMs, expanded);
  const modelDisplay = modelThinkingBadge(theme, displayStep.model, displayStep.thinking);
  const itemLabel = itemTitle ? `${itemTitle} ${index}/${total}: ` : "";
  const statusSuffix = status ? ` ${theme.fg("dim", "·")} ${status}` : "";
  const lines = [
    `  ${widgetStepGlyph(resolvedDisplayStatus, theme, widgetStepRunningSeed(displayStep, index - 1))} ${itemLabel}${themeBold(theme, safeTerminalText(displayStep.agent))}${statusSuffix}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  ];
  const activityLines =
    resolvedDisplayStatus === displayStep.status
      ? widgetStepActivityLines(
          displayStep,
          width - visibleWidth(WIDGET_ACTIVITY_PREFIX),
          width - visibleWidth(WIDGET_ACTIVITY_CONTINUATION_PREFIX),
          expanded,
          job.updatedAt,
        )
      : [];
  for (const [activityIndex, activity] of activityLines.entries()) {
    const prefix =
      activityIndex === 0 ? WIDGET_ACTIVITY_PREFIX : WIDGET_ACTIVITY_CONTINUATION_PREFIX;
    lines.push(theme.fg("dim", `${prefix}${activity}`));
  }
  for (const nestedLine of formatNestedWidgetLines(
    step.children,
    theme,
    width,
    expanded,
    job.updatedAt,
    expanded ? 12 : 1,
    isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt),
  )) {
    lines.push(`    ${nestedLine}`);
  }
  if (resolvedDisplayStatus === "running") {
    if (!expanded) lines.push(`    ${theme.fg("dim", liveDetailHintText())}`);
    if (expanded) {
      const output = widgetOutputPath(job, step);
      if (output)
        lines.push(`    ${theme.fg("dim", `output: ${safeTerminalText(shortenPath(output))}`)}`);
      for (const tool of step.recentTools?.slice(-3) ?? []) {
        const toolName = safeTerminalText(tool.tool);
        const toolArgs = safeTerminalText(tool.args);
        lines.push(`      ${theme.fg("dim", `${toolName}${toolArgs ? `: ${toolArgs}` : ""}`)}`);
      }
      for (const line of step.recentOutput?.slice(-5) ?? []) {
        lines.push(`      ${theme.fg("dim", safeTerminalText(line))}`);
      }
    }
  }
  return lines;
}

function foregroundStyleWidgetDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded: boolean,
  width: number,
): string[] {
  if (!job.steps?.length)
    return [
      ...widgetTkTicketLines(job, theme),
      ...widgetActivityDetailLines(job, theme, expanded),
      ...formatNestedWidgetLines(
        job.nestedChildren,
        theme,
        width,
        expanded,
        job.updatedAt,
        expanded ? 12 : 1,
        isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt),
      ).map((line) => `  ${line}`),
    ];
  const total = job.stepsTotal ?? job.steps.length;
  const itemTitle = job.mode === "parallel" ? "Agent" : "Step";
  const lines: string[] = [...widgetTkTicketLines(job, theme)];
  for (const [index, step] of job.steps.entries()) {
    lines.push(
      ...foregroundStyleWidgetStepLines(
        job,
        theme,
        step,
        itemTitle,
        index + 1,
        total,
        expanded,
        width,
      ),
    );
  }
  const attached = new Set(
    job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []),
  );
  const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
  for (const nestedLine of formatNestedWidgetLines(
    unattached,
    theme,
    width,
    expanded,
    job.updatedAt,
    expanded ? 12 : 1,
    isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt),
  )) {
    lines.push(`  ${nestedLine}`);
  }
  return lines;
}

function singleWidgetAgentDetails(
  job: AsyncJobState,
  theme: Theme,
  expanded: boolean,
  width: number,
): string[] {
  const step = job.steps?.[0];
  if (step) {
    const stepLines = foregroundStyleWidgetStepLines(
      job,
      theme,
      step,
      undefined,
      1,
      1,
      expanded,
      width,
      singleWidgetStepDisplayStatus(job, step),
    );
    const ticketLines = widgetTkTicketLines(job, theme, "    ");
    const lines = [stepLines[0], ...ticketLines, ...stepLines.slice(1)];
    const attached = new Set(step.children?.map((child) => child.id) ?? []);
    const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
    for (const nestedLine of formatNestedWidgetLines(
      unattached,
      theme,
      width,
      expanded,
      job.updatedAt,
      expanded ? 12 : 1,
      isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt),
    )) {
      lines.push(`  ${nestedLine}`);
    }
    return lines;
  }

  const agent = job.agents?.[0] ? safeTerminalText(job.agents[0]) : widgetJobName(job);
  const stats = widgetSummaryStats(job, theme, expanded);
  const status = job.status === "running" ? "" : theme.fg("dim", safeTerminalText(job.status));
  const statusSuffix = status ? ` ${theme.fg("dim", "·")} ${status}` : "";
  return [
    `${widgetStatusGlyph(job, theme)} ${themeBold(theme, agent)}${statusSuffix}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
    ...widgetTkTicketLines(job, theme),
    ...widgetActivityDetailLines(job, theme, expanded),
    ...formatNestedWidgetLines(
      job.nestedChildren,
      theme,
      width,
      expanded,
      job.updatedAt,
      expanded ? 12 : 1,
      isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt),
    ).map((line) => `  ${line}`),
  ];
}

function parallelWidgetAggregateStats(job: AsyncJobState, theme: Theme, expanded = false): string {
  const stats = widgetSummaryStats(job, theme, expanded);
  if (stats) return stats;
  if (job.status === "running") return "";
  return job.status === "complete" ? "done" : safeTerminalText(job.status);
}

function singleWidgetHeaderLines(job: AsyncJobState, theme: Theme, expanded: boolean): string[] {
  if (job.mode === "single") {
    return [`${theme.fg("toolTitle", themeBold(theme, "async subagent"))}`];
  }
  if (job.mode === "parallel") {
    const count = job.stepsTotal ?? job.agents?.length ?? job.steps?.length ?? 0;
    const stats = parallelWidgetAggregateStats(job, theme, expanded);
    return [
      `${theme.fg("toolTitle", themeBold(theme, `async subagents (${count})`))}`,
      `${widgetStatusGlyph(job, theme)}${stats ? ` ${stats}` : ""}`,
    ];
  }
  const stats = widgetSummaryStats(job, theme, expanded);
  const count = job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
  const mode = safeTerminalText(widgetJobName(job));
  const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
  return [
    `${theme.fg("toolTitle", themeBold(theme, title))}`,
    `${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  ];
}

// Job-level health state (active_long_running / needs_attention) is a staleness
// signal, not flavour text: it tells the user a run may be stuck. The step-detail
// render paths (singleWidgetAgentDetails' `if (step)` branch,
// foregroundStyleWidgetDetails' steps branch, and compactSingleWidgetLines' own
// loop) build rows per step and never call widgetActivityDetailLines(job, ...),
// so a job-level health state with no step-level counterpart would be dropped
// entirely. The no-steps branches already surface it via widgetActivityDetailLines,
// and multi-job rows surface it per job, so only the with-steps case needs this.
//
// fitWidgetLineBudget is a prefix-keep truncator: it keeps a prefix of the
// already-wrapped physical lines and appends a "N lines hidden" hint. The
// collapsed budget floor is 10 physical rows and the expanded floor is 12, but
// these are physical rows after wrapping, so no fixed logical line position is
// unconditionally safe at every terminal width.
//
// For multi-agent and parallel jobs the warning is emitted unconditionally
// (subject only to the pausing guard below) and placed directly under the
// header. These jobs may enter the progressive tier or accumulate many step rows
// that fitWidgetLineBudget truncates; a step carrying the same health state may
// be scrolled off, making a step-level dedup unsound for those modes.
//
// For single-agent jobs (job.mode === 'single') the health line is the 3rd
// logical line in the render — only the header and the agent row precede it.
// At normal terminal widths it is far inside the kept prefix. buildSingleWidgetLines
// splices it immediately after the agent row, and singleModeHealthWarningLines
// handles placement (nested under the agent row at 4-space indent) with
// step-level dedup: when the step's widgetStepActivityLines already surfaces the
// same health text, the job-level line is suppressed to avoid a duplicate.
function jobHealthWarningLines(job: AsyncJobState, theme: Theme): string[] {
  if (job.status === "continued") return [];
  if (!isHealthActivityState(job.activityState)) return [];
  if (!job.steps?.length) return [];
  // Pausing/interruption takes precedence: do not add a competing health line
  // alongside the "pausing…" signal.
  if (job.interruptRequestedAt !== undefined || widgetHasPausingStep(job)) return [];
  const warning = buildLiveStatusLine(
    { activityState: job.activityState, lastActivityAt: job.lastActivityAt },
    job.updatedAt,
  );
  return warning ? [`  ${theme.fg("dim", `⎿  ${warning}`)}`] : [];
}

// Health warning for single-agent (job.mode === 'single') jobs with steps. Emits
// the line at 4-space indent (one level deeper than the agent row at 2-space indent)
// so it visually belongs to the agent rather than the header. buildSingleWidgetLines
// splices this output immediately after details[0] (the agent row): the health line
// is the 3rd logical line of the render (after the header and the agent row), so at
// normal terminal widths it is well inside the kept prefix. Deduplicates against
// the step's own widgetStepActivityLines: if the step already surfaces the same
// health text, the job-level line is suppressed to avoid a duplicate.
//
// Known limitation: in the dedup case the retained health text is the step's own
// activity line, which sits after the ticket line. At very narrow widths, wrapping
// of the preceding agent row and ticket line can push the step-level health line out
// of the kept prefix; the dedup does not protect against that. This risk is accepted
// because it requires an unusually narrow terminal, and the pre-existing multi-agent
// path carries the same class of exposure.
function singleModeHealthWarningLines(
  job: AsyncJobState,
  theme: Theme,
  contentWidth: number,
  expanded: boolean,
): string[] {
  if (job.status === "continued") return [];
  if (!isHealthActivityState(job.activityState)) return [];
  if (!job.steps?.length) return [];
  if (job.interruptRequestedAt !== undefined || widgetHasPausingStep(job)) return [];
  const warning = buildLiveStatusLine(
    { activityState: job.activityState, lastActivityAt: job.lastActivityAt },
    job.updatedAt,
  );
  if (!warning) return [];
  // Dedup: if the step is already rendering the same health text via
  // widgetStepActivityLines, do not emit a second identical line.
  const step = job.steps[0]!;
  const displayStep = projectContinuedWidgetStep(job, step);
  const displayStatus = singleWidgetStepDisplayStatus(job, step);
  if (displayStatus === displayStep.status) {
    const stepActivityLines = widgetStepActivityLines(
      displayStep,
      contentWidth - visibleWidth(WIDGET_ACTIVITY_PREFIX),
      contentWidth - visibleWidth(WIDGET_ACTIVITY_CONTINUATION_PREFIX),
      expanded,
      job.updatedAt,
    );
    if (stepActivityLines.includes(warning)) return [];
  }
  return [`    ${theme.fg("dim", `⎿  ${warning}`)}`];
}

function buildSingleWidgetLines(
  job: AsyncJobState,
  theme: Theme,
  contentWidth: number,
  expanded: boolean,
): string[] {
  // Single-agent jobs route the health warning under the agent row (via
  // singleModeHealthWarningLines) rather than under the header. Multi-agent and
  // parallel jobs keep the header-level placement via jobHealthWarningLines.
  if (job.mode === "single") {
    const details = singleWidgetAgentDetails(job, theme, expanded, contentWidth);
    const healthLines = singleModeHealthWarningLines(job, theme, contentWidth, expanded);
    // Splice the health line immediately after the agent row (details[0]) so it lands
    // as the 3rd logical line of the render – before the ticket line, step activity
    // lines, nested child lines, and the live-detail hint (which stays last).
    // singleWidgetAgentDetails always returns at least the agent row, and
    // singleModeHealthWarningLines returns [] when job.steps is empty, so both the
    // no-steps and the no-health-state paths are safe.
    return wrapDisplayLines(
      [
        ...singleWidgetHeaderLines(job, theme, expanded),
        details[0]!,
        ...healthLines,
        ...details.slice(1),
      ],
      contentWidth,
    );
  }
  const details = foregroundStyleWidgetDetails(job, theme, expanded, contentWidth);
  return wrapDisplayLines(
    [
      ...singleWidgetHeaderLines(job, theme, expanded),
      ...jobHealthWarningLines(job, theme),
      ...details,
    ],
    contentWidth,
  );
}

function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const fullLines = buildSingleWidgetLines(job, theme, contentWidth, false);
  if (fullLines.length <= 10 || !job.steps?.length || job.mode !== "parallel") {
    return fullLines;
  }

  const total = job.stepsTotal ?? job.steps.length;
  const itemTitle = "Agent";
  const lines = [
    ...wrapDisplayLines(singleWidgetHeaderLines(job, theme, false), contentWidth),
    ...jobHealthWarningLines(job, theme),
    ...widgetTkTicketLines(job, theme),
  ];
  for (const [index, step] of job.steps.entries()) {
    const displayStep = projectContinuedWidgetStep(job, step);
    const status = widgetStepStatus(displayStep.status, theme, displayStep.interruptRequestedAt);
    const statusSuffix = status ? ` ${theme.fg("dim", "·")} ${status}` : "";
    const stepStats = widgetStepStats(theme, displayStep);
    const modelDisplay = modelThinkingBadge(theme, displayStep.model, displayStep.thinking);
    const rowPrefix = `  ${widgetStepGlyph(displayStep.status, theme, widgetStepRunningSeed(displayStep, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, safeTerminalText(displayStep.agent))}${statusSuffix}${modelDisplay}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`;
    const activitySeparator = ` ${theme.fg("dim", "·")} `;
    const activityContinuationPrefix = WIDGET_ACTIVITY_CONTINUATION_PREFIX;
    const inlineFirstWidth = contentWidth - visibleWidth(rowPrefix + activitySeparator);
    const minimumCommandWidth = displayStep.currentTool
      ? visibleWidth(`${displayStep.currentTool}${displayStep.currentToolArgs ? ": " : ""}`)
      : 0;
    const inlineCommand =
      Boolean(displayStep.currentTool) && inlineFirstWidth >= minimumCommandWidth;
    const activityLines = widgetStepActivityLines(
      displayStep,
      inlineCommand ? inlineFirstWidth : contentWidth - visibleWidth(WIDGET_ACTIVITY_PREFIX),
      inlineCommand
        ? contentWidth - visibleWidth(activityContinuationPrefix)
        : contentWidth - visibleWidth(WIDGET_ACTIVITY_CONTINUATION_PREFIX),
      false,
      job.updatedAt,
      true,
    );
    const activity = activityLines.join(" · ");
    const activitySuffix = activity ? `${activitySeparator}${theme.fg("dim", activity)}` : "";
    const healthWarning =
      displayStep.status === "running" &&
      displayStep.interruptRequestedAt === undefined &&
      !displayStep.currentTool &&
      isHealthActivityState(displayStep.activityState)
        ? activityLines.find(
            (activityLine) => activityLine === buildLiveStatusLine(displayStep, job.updatedAt),
          )
        : undefined;
    if (healthWarning) {
      lines.push(...fitInlineActivity(rowPrefix, healthWarning, theme, contentWidth));
    } else if (
      displayStep.status === "running" &&
      !displayStep.currentTool &&
      activityLines.length === 2
    ) {
      lines.push(
        ...fitInlineThinkingActivity(
          rowPrefix,
          activityLines[0]!,
          activityLines[1]!,
          theme,
          contentWidth,
        ),
      );
    } else if (displayStep.currentTool && activityLines.length > 0) {
      if (inlineCommand) {
        lines.push(`${rowPrefix}${activitySeparator}${theme.fg("dim", activityLines[0]!)}`);
        for (const activityLine of activityLines.slice(1)) {
          lines.push(`${activityContinuationPrefix}${theme.fg("dim", activityLine)}`);
        }
      } else {
        lines.push(...wrapDisplayLine(rowPrefix, contentWidth));
        for (const [activityIndex, activityLine] of activityLines.entries()) {
          const prefix =
            activityIndex === 0 ? WIDGET_ACTIVITY_PREFIX : WIDGET_ACTIVITY_CONTINUATION_PREFIX;
          lines.push(theme.fg("dim", `${prefix}${activityLine}`));
        }
      }
    } else {
      lines.push(`${rowPrefix}${activitySuffix}`);
    }
    for (const nestedLine of formatNestedWidgetLines(
      step.children,
      theme,
      contentWidth,
      false,
      job.updatedAt,
      1,
      isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt),
    ))
      lines.push(`    ${nestedLine}`);
  }
  if (job.steps.some((step) => projectContinuedWidgetStep(job, step).status === "running"))
    lines.push(theme.fg("dim", `  ${liveDetailHintText()}`));
  return wrapDisplayLines(lines, contentWidth);
}

type WidgetRenderTier = "full" | "single-line" | "progressive";

interface WidgetLayoutSession {
  expanded: boolean;
  rows: number;
  columns: number;
  tier: WidgetRenderTier;
  lockedRows?: number;
  visibleJobKeys: string[];
}

const RESERVED_NON_WIDGET_ROWS = 19;

let widgetLayoutSession: WidgetLayoutSession | undefined;

function resetWidgetLayoutSession(): void {
  widgetLayoutSession = undefined;
}

function estimateAvailableWidgetRows(): number {
  const rows = process.stdout.rows || 30;
  return Math.max(1, rows - RESERVED_NON_WIDGET_ROWS);
}

function currentTerminalRows(): number {
  return process.stdout.rows || 30;
}

function currentTerminalColumns(): number {
  return process.stdout.columns || 120;
}

function widgetSessionMatches(expanded: boolean): boolean {
  return (
    widgetLayoutSession?.expanded === expanded &&
    widgetLayoutSession.rows === currentTerminalRows() &&
    widgetLayoutSession.columns === currentTerminalColumns()
  );
}

function widgetHeaderCounts(jobs: AsyncJobState[]): {
  running: AsyncJobState[];
  queued: AsyncJobState[];
  complete: AsyncJobState[];
  failed: AsyncJobState[];
  paused: AsyncJobState[];
} {
  return {
    running: jobs.filter((job) => job.status === "running"),
    queued: jobs.filter((job) => job.status === "queued"),
    complete: jobs.filter((job) => job.status === "complete" || job.status === "continued"),
    failed: jobs.filter((job) => job.status === "failed"),
    paused: jobs.filter((job) => job.status === "paused"),
  };
}

function chooseWidgetSummaryVariant(variants: readonly string[], width: number): string {
  const contentWidth = Math.max(1, width);
  return (
    variants.find((variant) => visibleWidth(variant) <= contentWidth) ??
    variants[variants.length - 1]!
  );
}

function compactWidgetCountSummary(
  counts: ReturnType<typeof widgetHeaderCounts>,
  jobs: AsyncJobState[],
): string {
  if (counts.queued.length > 0) return `${counts.queued.length} queued`;
  if (counts.failed.length > 0) return `${counts.failed.length} failed`;
  if (counts.paused.length > 0) return `${counts.paused.length} paused`;
  if (counts.complete.length > 0) return `${counts.complete.length} done`;
  return counts.running.length > 0 ? "" : `${jobs.length} total`;
}

function buildSingleLineWidgetLines(jobs: AsyncJobState[], theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const counts = widgetHeaderCounts(jobs);
  const hasActive = counts.running.length > 0 || counts.queued.length > 0;
  const glyph =
    counts.running.length > 0
      ? runningGlyph(widgetJobsRunningSeed(counts.running))
      : hasActive
        ? "●"
        : "○";
  const coloredGlyph = theme.fg(hasActive ? "accent" : "dim", glyph);
  const coloredTitle = theme.fg(hasActive ? "accent" : "dim", "subagents");
  const parts: string[] = [];
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
  if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
  if (!hasActive && counts.complete.length > 0)
    parts.push(`${counts.complete.length}/${jobs.length} done`);
  const summary = parts.join(", ");
  const fallback = hasActive ? "" : `${jobs.length} total`;
  const detailed = `${coloredGlyph} ${coloredTitle}${summary ? ` (${summary})` : fallback ? ` (${fallback})` : ""}`;
  const withoutParenthetical =
    summary || fallback
      ? `${coloredGlyph} ${theme.fg(hasActive ? "accent" : "dim", summary || fallback)}`
      : coloredGlyph;
  const compactSummary = compactWidgetCountSummary(counts, jobs);
  const compact = `${coloredGlyph}${compactSummary ? ` ${theme.fg(hasActive ? "accent" : "dim", compactSummary)}` : ""}`;
  const titleOnly = `${coloredGlyph} ${coloredTitle}`;
  return [
    chooseWidgetSummaryVariant(
      [detailed, withoutParenthetical, compact, titleOnly, coloredGlyph],
      contentWidth,
    ),
  ];
}

function orderedWidgetJobs(jobs: AsyncJobState[]): AsyncJobState[] {
  return [
    ...jobs.filter((job) => job.status === "running"),
    ...jobs.filter((job) => job.status === "queued"),
    ...jobs.filter((job) => job.status !== "running" && job.status !== "queued"),
  ];
}

function progressiveJobKey(job: AsyncJobState): string {
  return job.asyncId;
}

function isProgressiveActiveJob(job: AsyncJobState | undefined): boolean {
  return job?.status === "running" || job?.status === "queued";
}

function selectProgressiveJobKeys(
  jobs: AsyncJobState[],
  previousKeys: string[],
  bodyRows: number,
): string[] {
  if (bodyRows <= 0) return [];
  const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
  const selected: string[] = [];
  const append = (key: string): void => {
    if (selected.includes(key) || !jobsByKey.has(key)) return;
    selected.push(key);
  };
  for (const key of previousKeys) {
    if (!isProgressiveActiveJob(jobsByKey.get(key))) continue;
    append(key);
    if (selected.length >= bodyRows) return selected;
  }
  for (const job of orderedWidgetJobs(jobs)) {
    if (!isProgressiveActiveJob(job)) continue;
    const key = progressiveJobKey(job);
    append(key);
    if (selected.length >= bodyRows) break;
  }
  if (selected.length >= bodyRows) return selected;
  for (const key of previousKeys) {
    if (isProgressiveActiveJob(jobsByKey.get(key))) continue;
    append(key);
    if (selected.length >= bodyRows) return selected;
  }
  for (const job of orderedWidgetJobs(jobs)) {
    const key = progressiveJobKey(job);
    append(key);
    if (selected.length >= bodyRows) break;
  }
  return selected;
}

function progressiveHeaderLine(jobs: AsyncJobState[], theme: Theme, width: number): string[] {
  const counts = widgetHeaderCounts(jobs);
  const hasActive = counts.running.length > 0 || counts.queued.length > 0;
  const glyph =
    counts.running.length > 0
      ? runningGlyph(widgetJobsRunningSeed(counts.running))
      : hasActive
        ? "●"
        : "○";
  const coloredGlyph = theme.fg(hasActive ? "accent" : "dim", glyph);
  const coloredTitle = theme.fg(hasActive ? "accent" : "dim", "Async agents");
  const parts: string[] = [];
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  if (!hasActive) {
    if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
    if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
    if (counts.complete.length > 0) parts.push(`${counts.complete.length}/${jobs.length} done`);
  }
  const summary = parts.join(", ");
  const coloredParts = summary ? theme.fg("dim", summary) : "";
  const compactSummary = compactWidgetCountSummary(counts, jobs);
  const compact = compactSummary ? theme.fg(hasActive ? "accent" : "dim", compactSummary) : "";
  const contentWidth = Math.max(1, width - 2);
  const detailed = coloredParts
    ? `${coloredGlyph} ${coloredTitle} ${theme.fg("dim", "·")} ${coloredParts}`
    : `${coloredGlyph} ${coloredTitle}`;
  const withoutTitle = coloredParts
    ? `${coloredGlyph} ${coloredParts}`
    : `${coloredGlyph} ${coloredTitle}`;
  const titleOnly = `${coloredGlyph} ${coloredTitle}`;
  return [
    chooseWidgetSummaryVariant(
      [
        detailed,
        withoutTitle,
        compact ? `${coloredGlyph} ${compact}` : titleOnly,
        titleOnly,
        coloredGlyph,
      ],
      contentWidth,
    ),
  ];
}

function progressiveJobLine(job: AsyncJobState, theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const stats = widgetSummaryStats(job, theme);
  const activity = widgetActivity(job);
  const status = job.status === "running" ? "" : job.status === "complete" ? "done" : job.status;
  const ticket = widgetTkTicketText(job);
  const prefixParts = [
    themeBold(theme, widgetJobName(job)),
    status ? theme.fg("dim", status) : "",
    stats,
    ticket ? theme.fg("dim", ticket) : "",
  ].filter(Boolean);
  const prefix = `  ${widgetStatusGlyph(job, theme)} ${prefixParts.join(` ${theme.fg("dim", "·")} `)}`;
  const thinkingActivity = widgetInlineThinkingActivity(job);
  if (thinkingActivity)
    return fitInlineThinkingActivity(
      prefix,
      thinkingActivity.phrase,
      thinkingActivity.freshness,
      theme,
      contentWidth,
    );
  const runningStep = widgetRunningStep(job);
  const activityState = widgetActivityState(job, runningStep);
  const healthWarning =
    job.status !== "continued" &&
    job.interruptRequestedAt === undefined &&
    !job.currentTool &&
    !widgetActiveStep(job) &&
    !widgetHasPausingStep(job) &&
    isHealthActivityState(activityState)
      ? buildLiveStatusLine(
          { activityState, lastActivityAt: job.lastActivityAt ?? runningStep?.lastActivityAt },
          job.updatedAt,
        )
      : undefined;
  if (healthWarning) return fitInlineActivity(prefix, healthWarning, theme, contentWidth);
  const activitySuffix =
    activity && activity.toLowerCase() !== status
      ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}`
      : "";
  return wrapDisplayLine(`${prefix}${activitySuffix}`, contentWidth);
}

function progressiveHiddenLine(hiddenJobs: AsyncJobState[], theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  const counts = widgetHeaderCounts(hiddenJobs);
  const parts: string[] = [];
  if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
  const finished = counts.complete.length + counts.failed.length + counts.paused.length;
  if (finished > 0) parts.push(`${finished} finished`);
  const full = theme.fg(
    "dim",
    `  +${hiddenJobs.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`,
  );
  const countSummary = theme.fg("dim", `  +${hiddenJobs.length} more`);
  const countOnly = theme.fg("dim", `+${hiddenJobs.length}`);
  const fallback = theme.fg("dim", "+");
  return [chooseWidgetSummaryVariant([full, countSummary, countOnly, fallback], contentWidth)];
}

function buildProgressiveWidgetLines(
  jobs: AsyncJobState[],
  theme: Theme,
  width: number,
  lockedRows: number,
  previousKeys: string[],
): { lines: string[]; visibleJobKeys: string[] } {
  const rowCount = Math.max(1, lockedRows);
  if (rowCount === 1)
    return { lines: buildSingleLineWidgetLines(jobs, theme, width), visibleJobKeys: [] };

  const headerLines = progressiveHeaderLine(jobs, theme, width);
  const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
  const candidateKeys = selectProgressiveJobKeys(jobs, previousKeys, jobs.length);
  const visibleJobKeys: string[] = [];
  const bodyLines: string[] = [];

  for (const key of candidateKeys) {
    const job = jobsByKey.get(key);
    if (!job) continue;
    const jobLines = progressiveJobLine(job, theme, width);
    const prospectiveKeys = [...visibleJobKeys, key];
    const prospectiveHiddenJobs = jobs.filter(
      (candidate) => !prospectiveKeys.includes(progressiveJobKey(candidate)),
    );
    const prospectiveHiddenLines =
      prospectiveHiddenJobs.length > 0
        ? progressiveHiddenLine(prospectiveHiddenJobs, theme, width)
        : [];
    if (
      headerLines.length + bodyLines.length + jobLines.length + prospectiveHiddenLines.length >
      rowCount
    )
      continue;
    visibleJobKeys.push(key);
    bodyLines.push(...jobLines);
  }

  const hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
  const hiddenLines = hiddenJobs.length > 0 ? progressiveHiddenLine(hiddenJobs, theme, width) : [];
  const lines = [...headerLines, ...bodyLines, ...hiddenLines];
  if (lines.length > rowCount) {
    // Job rows are optional when the cap is exceeded. Keep the one-line header
    // and explicit hidden-work count if a future detail variant wraps.
    // rowCount is a maximum, not a fixed height: degrade rather than pad.
    const boundedLines = [headerLines[0]!, ...(hiddenLines.length > 0 ? [hiddenLines[0]!] : [])];
    return { lines: boundedLines.slice(0, rowCount), visibleJobKeys: [] };
  }
  // rowCount is a maximum, not a fixed height: return the natural line count.
  return { lines, visibleJobKeys };
}

function collapsedWidgetLineBudget(rows: number): number {
  return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}

function fitWidgetLineBudget(
  lines: string[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const contentWidth = Math.max(1, width - 2);
  const rows = process.stdout.rows || 30;
  const budget = expanded
    ? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
    : collapsedWidgetLineBudget(rows);
  if (lines.length <= budget) return lines;

  let visibleCount = Math.max(0, budget - 1);
  while (true) {
    const hiddenCount = lines.length - visibleCount;
    const hint = expanded
      ? `… ${hiddenCount} live-detail lines hidden`
      : `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`;
    const hintLines = wrapDisplayLine(theme.fg("dim", hint), contentWidth);
    const nextVisibleCount = Math.max(0, budget - hintLines.length);
    if (nextVisibleCount === visibleCount) return [...lines.slice(0, visibleCount), ...hintLines];
    visibleCount = nextVisibleCount;
  }
}

function fitAdaptiveWidgetLines(
  jobs: AsyncJobState[],
  lines: string[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  if (expanded) {
    resetWidgetLayoutSession();
    return fitWidgetLineBudget(lines, theme, width, true);
  }

  const hasMatchingSession = widgetSessionMatches(expanded);
  const rows = currentTerminalRows();
  const columns = currentTerminalColumns();
  const availableRows = estimateAvailableWidgetRows();
  const singleJob = jobs.length === 1;

  if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
    return buildSingleLineWidgetLines(jobs, theme, width);
  }

  // Single-job renders must not enter or reuse the progressive tier: with one job
  // there is nothing to ration across jobs, and the progressive tier strips step
  // detail and the live-detail hint. A progressive lock taken while multiple jobs
  // were live must not persist after the set drains to one.
  if (
    !singleJob &&
    hasMatchingSession &&
    widgetLayoutSession?.tier === "progressive" &&
    widgetLayoutSession.lockedRows !== undefined
  ) {
    const rendered = buildProgressiveWidgetLines(
      jobs,
      theme,
      width,
      widgetLayoutSession.lockedRows,
      widgetLayoutSession.visibleJobKeys,
    );
    widgetLayoutSession.visibleJobKeys = rendered.visibleJobKeys;
    return rendered.lines;
  }

  if (lines.length <= availableRows) {
    widgetLayoutSession = { expanded, rows, columns, tier: "full", visibleJobKeys: [] };
    return fitWidgetLineBudget(lines, theme, width, false);
  }

  if (availableRows <= 2) {
    widgetLayoutSession = { expanded, rows, columns, tier: "single-line", visibleJobKeys: [] };
    return buildSingleLineWidgetLines(jobs, theme, width);
  }

  // Single-job: route through the full tier so fitWidgetLineBudget truncates with
  // the '… N lines hidden · <key> expands' hint. This preserves step detail and
  // makes the expand shortcut discoverable even when lines exceed availableRows.
  if (singleJob) {
    widgetLayoutSession = { expanded, rows, columns, tier: "full", visibleJobKeys: [] };
    return fitWidgetLineBudget(lines, theme, width, false);
  }

  const lockedRows = Math.min(availableRows, collapsedWidgetLineBudget(rows));
  const rendered = buildProgressiveWidgetLines(jobs, theme, width, lockedRows, []);
  widgetLayoutSession = {
    expanded,
    rows,
    columns,
    tier: "progressive",
    lockedRows,
    visibleJobKeys: rendered.visibleJobKeys,
  };
  return rendered.lines;
}

function liveDetailExpanded(controller: SubagentLiveDetailController | undefined): boolean {
  return controller?.isExpanded() ?? false;
}

function buildWidgetComponent(
  jobs: AsyncJobState[],
  controller: SubagentLiveDetailController | undefined,
): (_tui: unknown, theme: Theme) => Component {
  return (_tui, theme) => {
    const width = getTermWidth();
    const expanded = liveDetailExpanded(controller);
    const lines = expanded
      ? buildWidgetLines(jobs, theme, width, true)
      : jobs.length === 1
        ? compactSingleWidgetLines(jobs[0]!, theme, width)
        : buildWidgetLines(jobs, theme, width, false);
    const container = new Container();
    for (const line of fitAdaptiveWidgetLines(jobs, lines, theme, width, expanded))
      container.addChild(new Text(line, 1, 0));
    return container;
  };
}

export function buildWidgetLines(
  jobs: AsyncJobState[],
  theme: Theme,
  width = getTermWidth(),
  expanded = false,
): string[] {
  if (jobs.length === 0) return [];
  const contentWidth = Math.max(1, width - 2);
  if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, contentWidth, expanded);
  const running = jobs.filter((job) => job.status === "running");
  const queued = jobs.filter((job) => job.status === "queued");
  const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");

  const lines: string[] = [];
  const hasActive = running.length > 0 || queued.length > 0;
  const headerGlyph =
    running.length > 0 ? runningGlyph(widgetJobsRunningSeed(running)) : hasActive ? "●" : "○";
  lines.push(
    ...wrapDisplayLine(
      `${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")}`,
      contentWidth,
    ),
  );

  const items: string[][] = [];
  let hiddenRunning = 0;
  let hiddenFinished = 0;
  let queuedSummaryShown = false;
  let slots = MAX_WIDGET_JOBS;

  for (const job of running) {
    if (slots <= 0) {
      hiddenRunning++;
      continue;
    }
    const stats = widgetSummaryStats(job, theme, expanded);
    items.push([
      `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
      ...widgetTkTicketLines(job, theme),
      ...widgetActivityDetailLines(job, theme, expanded),
      ...widgetParallelAgentDetails(job, theme, expanded, width),
    ]);
    slots--;
  }

  if (queued.length > 0 && slots > 0) {
    items.push([`${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`]);
    queuedSummaryShown = true;
    slots--;
  }

  for (const job of finished) {
    if (slots <= 0) {
      hiddenFinished++;
      continue;
    }
    const stats = widgetSummaryStats(job, theme, expanded);
    items.push([
      `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
      ...widgetTkTicketLines(job, theme),
      ...widgetActivityDetailLines(job, theme, expanded),
      ...widgetParallelAgentDetails(job, theme, expanded, width),
    ]);
    slots--;
  }

  const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
  const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
  if (hiddenTotal > 0) {
    const parts: string[] = [];
    if (hiddenQueued > 0) parts.push(`${hiddenQueued} queued`);
    if (hiddenFinished > 0) parts.push(`${hiddenFinished} finished`);
    items.push([
      theme.fg("dim", `+${hiddenTotal} more${parts.length ? ` (${parts.join(", ")})` : ""}`),
    ]);
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const last = i === items.length - 1;
    const branch = last ? "└─" : "├─";
    const continuation = last ? "   " : "│  ";
    lines.push(...wrapDisplayLine(`${theme.fg("dim", branch)} ${item[0]}`, contentWidth));
    for (const detail of item.slice(1)) {
      lines.push(...wrapDisplayLine(`${theme.fg("dim", continuation)} ${detail}`, contentWidth));
    }
  }

  return lines;
}

/**
 * Render the async jobs widget
 */
export function renderWidget(
  ctx: ExtensionContext,
  jobs: AsyncJobState[],
  controller?: SubagentLiveDetailController,
): void {
  if (jobs.length === 0) {
    resetWidgetLayoutSession();
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, controller));
}
