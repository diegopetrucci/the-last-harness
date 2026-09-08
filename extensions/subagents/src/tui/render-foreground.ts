/**
 * Foreground subagent tool-result rendering.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  stripTerminalSequences,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { type AgentProgress, type Details, type SubagentToolResult } from "../shared/types.ts";
import {
  formatDuration,
  formatTokens,
  formatToolCall,
  formatUsage,
  shortenPath,
} from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { extractSingleOutputInstructionTarget } from "../runs/shared/single-output.ts";
import { normalizeTkTicketMetadata } from "../runs/shared/tk-ticket.ts";
import { safeTerminalText } from "../shared/display-text.ts";
import {
  buildLiveStatusLine,
  childLocationLine,
  compactThinkingPhrase,
  fitCompactToolStatus,
  formatCurrentToolLines,
  getTermWidth,
  liveDetailHintText,
  liveDetailKeyText,
  modelThinkingBadge,
  progressRunningSeed,
  runningGlyph,
  runningSeed,
  snapshotNowForProgress,
  statJoin,
  themeBold,
  type Theme,
  wrapDisplayLine,
  wrapDisplayLines,
} from "./render-primitives.ts";

interface LegacyResultAnimationContext {
  state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

const TK_TICKET_WIDGET_PREFIX = "ticket: ";
const WIDGET_ACTIVITY_PREFIX = "    ⎿  ";
const WIDGET_ACTIVITY_CONTINUATION_PREFIX = "       ";

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
  const timer = context.state.subagentResultAnimationTimer;
  if (!timer) return;
  clearInterval(timer);
  context.state.subagentResultAnimationTimer = undefined;
}

function extractOutputTarget(task: string): string | undefined {
  const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
  if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
  const findingsMatch = extractSingleOutputInstructionTarget(task);
  if (findingsMatch) return findingsMatch;
  const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
  if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
  return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
  if (output.trim()) return false;
  return !extractOutputTarget(task);
}

function getToolCallLines(
  result: Pick<Details["results"][number], "messages" | "toolCalls">,
  expanded: boolean,
): string[] {
  if (result.messages) {
    return getDisplayItems(result.messages)
      .filter(
        (item): item is { type: "tool"; name: string; args: Record<string, unknown> } =>
          item.type === "tool",
      )
      .map((item) => safeTerminalText(formatToolCall(item.name, item.args, expanded)));
  }
  return (
    result.toolCalls?.map((toolCall) =>
      safeTerminalText(expanded ? (toolCall.expandedText ?? toolCall.text) : toolCall.text),
    ) ?? []
  );
}
function addWrappedText(container: Container, text: string, maxWidth: number): void {
  for (const line of wrapDisplayLine(text, maxWidth)) container.addChild(new Text(line, 0, 0));
}

function collapsedForegroundLineBudget(): number {
  const rows = process.stdout.rows || 30;
  return Math.max(5, Math.min(14, Math.floor(rows * 0.4)));
}

function collapsedForegroundSummaryLines(
  hiddenCount: number,
  theme: Theme,
  width: number,
  maxLines: number,
): string[] {
  const key = liveDetailKeyText();
  const variants = [
    `… ${hiddenCount} lines hidden · ${key} expands`,
    `… ${hiddenCount} hidden · ${key} expands`,
    `${hiddenCount} ${key}`,
    `${key} expands`,
    key,
  ];
  const firstLines = wrapDisplayLine(theme.fg("dim", variants[0]!), width);
  for (const variant of variants) {
    const summaryLines = wrapDisplayLine(theme.fg("dim", variant), width);
    if (summaryLines.length <= maxLines) return summaryLines;
  }
  return firstLines;
}

function fitCollapsedForegroundLines(
  contentLines: string[],
  theme: Theme,
  width: number,
  footerLines: readonly string[] = [],
): string[] {
  const budget = collapsedForegroundLineBudget();
  if (footerLines.length > budget) {
    const summaryLines = collapsedForegroundSummaryLines(contentLines.length, theme, width, budget);
    return summaryLines.slice(0, budget);
  }
  if (contentLines.length + footerLines.length <= budget) {
    return [...contentLines, ...footerLines];
  }

  const contentBudget = budget - footerLines.length;
  for (
    let visibleCount = Math.min(contentLines.length, contentBudget - 1);
    visibleCount >= 0;
    visibleCount--
  ) {
    const hiddenCount = contentLines.length - visibleCount;
    const summaryLines = wrapDisplayLine(
      theme.fg("dim", `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`),
      width,
    );
    if (visibleCount + summaryLines.length <= contentBudget) {
      return [...contentLines.slice(0, visibleCount), ...summaryLines, ...footerLines];
    }
  }

  const summaryLines =
    contentBudget > 0
      ? collapsedForegroundSummaryLines(contentLines.length, theme, width, contentBudget)
      : [];
  return [...summaryLines.slice(0, contentBudget), ...footerLines];
}

function collapsedForegroundComponent(logicalLines: readonly string[], theme: Theme): Component {
  return {
    render(width: number): string[] {
      const contentWidth = Math.max(1, width);
      const trailingLiveDetailFooter = logicalLines.at(-1);
      const hasLiveDetailFooter =
        trailingLiveDetailFooter !== undefined &&
        stripTerminalSequences(trailingLiveDetailFooter).trim() === liveDetailHintText();
      const contentLogicalLines = hasLiveDetailFooter ? logicalLines.slice(0, -1) : logicalLines;
      const contentLines = wrapDisplayLines(contentLogicalLines, contentWidth);
      const footerLines = hasLiveDetailFooter
        ? wrapDisplayLine(trailingLiveDetailFooter!, contentWidth)
        : [];
      return fitCollapsedForegroundLines(contentLines, theme, contentWidth, footerLines);
    },
    invalidate(): void {},
  };
}
function formatTotalCostStat(
  totalCost: Details["totalCost"] | undefined,
  includeTokenCounts = true,
): string {
  if (
    !totalCost ||
    (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0)
  )
    return "";
  const parts: string[] = [];
  if (includeTokenCounts && totalCost.inputTokens)
    parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
  if (includeTokenCounts && totalCost.outputTokens)
    parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
  if (totalCost.costUsd) parts.push(`$${totalCost.costUsd.toFixed(4)}`);
  return parts.join(" ");
}

function firstOutputLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function compactOutputPreview(text: string): string {
  const preview = firstOutputLine(safeTerminalText(text));
  const withoutTruncationPath = preview.replace(
    / - full output at (?:\/|[A-Za-z]:[\\/]|\\\\).*\]$/,
    "]",
  );
  const savedOutput = withoutTruncationPath.match(
    /^Output saved to: (?:\/|[A-Za-z]:[\\/]|\\\\).* \(([^()]*)\)\. Read this file if needed\.$/,
  );
  if (savedOutput) return `Output saved (${savedOutput[1]}). Read this file if needed.`;
  if (/^Output file error: (?:\/|[A-Za-z]:[\\/]|\\\\)/.test(withoutTruncationPath)) {
    return "Output file error (expand for details)";
  }
  return withoutTruncationPath;
}

function resultStatusLine(result: Details["results"][number], output: string): string {
  if (result.pause?.kind === "awaiting_supervisor")
    return "Paused awaiting supervisor · no child process running";
  if (result.interrupted) return "Paused";
  if (result.exitCode !== 0) {
    const error = result.error
      ? safeTerminalText(result.error)
      : firstOutputLine(safeTerminalText(output)) || `exit ${result.exitCode}`;
    return `Error: ${error}`;
  }
  if (result.acceptance?.status && result.acceptance.status !== "not-required")
    return `Done · acceptance: ${safeTerminalText(result.acceptance.status)}`;
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
  return "Done";
}

function resultGlyph(
  result: Details["results"][number],
  output: string,
  theme: Theme,
  running = result.progress?.status === "running",
  seed = progressRunningSeed(result.progress ?? result.progressSummary),
  frame?: number,
): string {
  if (running) {
    if (frame !== undefined) return theme.fg("accent", runningGlyph((seed ?? 0) + frame));
    return theme.fg("accent", runningGlyph(seed));
  }
  if (result.interrupted) return theme.fg("warning", "■");
  if (result.exitCode !== 0) return theme.fg("error", "✗");
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
  return theme.fg("success", "✓");
}
const FOREGROUND_ACTIVITY_PREFIX = "  ⎿  ";
const FOREGROUND_ACTIVITY_CONTINUATION_PREFIX = "     ";

function compactProgressActivityLines(
  progress: AgentProgress,
  width: number,
  firstPrefix: string,
  continuationPrefix: string,
): string[] {
  const snapshotNow = snapshotNowForProgress(progress);
  const toolLines = formatCurrentToolLines(
    progress,
    width - visibleWidth(firstPrefix),
    width - visibleWidth(continuationPrefix),
    false,
    snapshotNow,
  );
  const liveStatus = buildLiveStatusLine(progress, snapshotNow);
  if (toolLines) {
    return fitCompactToolStatus(
      toolLines,
      liveStatus,
      width - visibleWidth(firstPrefix),
      width - visibleWidth(continuationPrefix),
    );
  }
  const phrase = compactThinkingPhrase(progress.activityState, progress.turnCount);
  return [phrase, liveStatus].filter((line): line is string => Boolean(line));
}
type RenderResult = Details["results"][number];

interface IndexedResultEntry {
  index: number;
  result: RenderResult;
}

function isRenderableResult(value: unknown): value is RenderResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const usage = candidate.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  if (
    typeof candidate.agent !== "string" ||
    typeof candidate.task !== "string" ||
    typeof candidate.exitCode !== "number" ||
    !Number.isFinite(candidate.exitCode)
  )
    return false;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"]) {
    if (typeof (usage as Record<string, unknown>)[field] !== "number") return false;
  }
  if (candidate.finalOutput !== undefined && typeof candidate.finalOutput !== "string")
    return false;
  if (candidate.error !== undefined && typeof candidate.error !== "string") return false;
  if (candidate.messages !== undefined && !Array.isArray(candidate.messages)) return false;
  if (candidate.toolCalls !== undefined && !Array.isArray(candidate.toolCalls)) return false;
  return true;
}

function indexedRenderableResults(results: unknown): IndexedResultEntry[] {
  if (!Array.isArray(results)) return [];
  return results.flatMap((result, index) =>
    isRenderableResult(result) ? [{ index, result }] : [],
  );
}

interface MultiProgressLabel {
  headerLabel: string;
  itemTitle: "Step" | "Agent";
  totalCount: number;
}

function buildMultiProgressLabel(
  details: Pick<Details, "mode" | "progress" | "totalSteps">,
  entries: IndexedResultEntry[],
  hasRunning: boolean,
): MultiProgressLabel {
  const itemTitle: "Step" | "Agent" = details.mode === "parallel" ? "Agent" : "Step";
  const totalCount = Math.max(1, details.totalSteps ?? entries.length);
  if (details.mode === "parallel") {
    const statuses = Array.from(
      { length: totalCount },
      () => "pending" as "pending" | "running" | "completed" | "failed" | "paused",
    );
    for (const progress of details.progress ?? []) {
      if (progress.index >= 0 && progress.index < totalCount)
        statuses[progress.index] = progress.status;
    }
    for (const entry of entries) {
      const { index: resultIndex, result } = entry;
      const progressFromArray =
        details.progress?.find((progress) => progress.index === resultIndex) ||
        details.progress?.find(
          (progress) => progress.agent === result.agent && progress.status === "running",
        );
      const index = result.progress?.index ?? progressFromArray?.index ?? resultIndex;
      if (index < 0 || index >= totalCount) continue;
      statuses[index] =
        result.progress?.status ??
        (result.interrupted ? "paused" : result.exitCode === 0 ? "completed" : "failed");
    }
    const done = statuses.filter((status) => status === "completed").length;
    return { headerLabel: `${done}/${totalCount} done`, itemTitle, totalCount };
  }

  const done = entries.filter(({ result }) => {
    const status = result.progress?.status;
    return (
      status === "completed" ||
      (status !== "running" && status !== "pending" && !result.interrupted && result.exitCode === 0)
    );
  }).length;
  const currentStep = Math.min(totalCount, done + (hasRunning ? 1 : 0));
  return {
    headerLabel: `${hasRunning ? currentStep : done}/${totalCount}`,
    itemTitle,
    totalCount,
  };
}

function resultRowLabel(label: MultiProgressLabel, stepNumber: number): string {
  return label.itemTitle === "Agent"
    ? `Agent ${stepNumber}/${label.totalCount}`
    : `Step ${stepNumber}`;
}
function foregroundTkTicketText(result: Details["results"][number]): string | undefined {
  const normalizedTkTicket = normalizeTkTicketMetadata(result.tkTicket);
  return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}

function foregroundTkTicketLine(
  result: Details["results"][number],
  theme: Theme,
  active: boolean,
  indent = "  ",
): string | undefined {
  if (!active) return undefined;
  const ticket = foregroundTkTicketText(result);
  return ticket ? `${indent}${theme.fg("dim", ticket)}` : undefined;
}
function renderSingleCompact(
  d: Details,
  r: Details["results"][number],
  theme: Theme,
  frame?: number,
): Component {
  const output = safeTerminalText(r.truncation?.text || getSingleResultOutput(r));
  const isRunning = r.progress?.status === "running";
  const lines: string[] = [];
  const width = getTermWidth() - 4;
  const modelDisplay = modelThinkingBadge(theme, r.model);
  lines.push(
    `${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(safeTerminalText(r.agent)))}${modelDisplay}`,
  );
  const ticketLine = foregroundTkTicketLine(r, theme, isRunning);
  if (ticketLine) lines.push(ticketLine);
  const childLocLine = childLocationLine(r.childLocation, theme);
  if (childLocLine) lines.push(childLocLine);

  if (isRunning && r.progress) {
    for (const [activityIndex, activity] of compactProgressActivityLines(
      r.progress,
      width,
      FOREGROUND_ACTIVITY_PREFIX,
      FOREGROUND_ACTIVITY_CONTINUATION_PREFIX,
    ).entries()) {
      const prefix =
        activityIndex === 0 ? FOREGROUND_ACTIVITY_PREFIX : FOREGROUND_ACTIVITY_CONTINUATION_PREFIX;
      lines.push(theme.fg("dim", `${prefix}${activity}`));
    }
    lines.push(theme.fg("dim", `  ${liveDetailHintText()}`));
    return collapsedForegroundComponent(lines, theme);
  }

  const preview = compactOutputPreview(output);
  lines.push(theme.fg("dim", `  ⎿  ${resultStatusLine(r, preview)}`));
  if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
    lines.push(theme.fg("dim", `     ${preview}`));
  }
  if (r.sessionFile)
    lines.push(theme.fg("dim", `  session: ${safeTerminalText(shortenPath(r.sessionFile))}`));
  return collapsedForegroundComponent(lines, theme);
}

function renderMultiCompact(
  d: Details,
  entries: IndexedResultEntry[],
  theme: Theme,
  frame?: number,
): Component {
  const hasRunning =
    d.progress?.some((p) => p.status === "running") ||
    entries.some(({ result }) => result.progress?.status === "running");
  const failed =
    d.progress?.some((p) => p.status === "failed") ||
    entries.some(
      ({ result: r }) =>
        r.progress?.status === "failed" ||
        (r.exitCode !== 0 && r.progress?.status !== "running" && r.progress?.status !== "pending"),
    );
  const paused = entries.some(
    ({ result: r }) => Boolean(r.interrupted || r.pause) && r.progress?.status !== "running",
  );
  let totalSummary = d.progressSummary;
  if (!totalSummary) {
    let sawProgress = false;
    const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
    for (const { result: r } of entries) {
      const prog = r.progress || r.progressSummary;
      if (!prog) continue;
      sawProgress = true;
      summary.toolCount += prog.toolCount;
      summary.tokens += prog.tokens;
      summary.durationMs = Math.max(summary.durationMs, prog.durationMs);
    }
    if (sawProgress) totalSummary = summary;
  }
  const multiLabel = buildMultiProgressLabel(d, entries, hasRunning);
  const stats = statJoin(theme, [multiLabel.headerLabel, formatTotalCostStat(d.totalCost, false)]);
  const glyph = hasRunning
    ? theme.fg(
        "accent",
        runningGlyph(
          frame !== undefined
            ? (runningSeed(progressRunningSeed(totalSummary)) ?? 0) + frame
            : runningSeed(progressRunningSeed(totalSummary)),
        ),
      )
    : failed
      ? theme.fg("error", "✗")
      : paused
        ? theme.fg("warning", "■")
        : theme.fg("success", "✓");
  const lines: string[] = [];
  const width = getTermWidth() - 4;
  lines.push(
    `${glyph} ${theme.fg("toolTitle", theme.bold(safeTerminalText(d.mode)))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  );
  let hasRunningResult = false;
  for (const { index: resultIndex, result: r } of entries) {
    const agentName = safeTerminalText(r.agent);
    const output = safeTerminalText(getSingleResultOutput(r));
    const progressFromArray =
      d.progress?.find((p) => p.index === resultIndex) ||
      d.progress?.find((p) => p.agent === r.agent && p.status === "running");
    const liveProgress = r.progress ?? progressFromArray;
    const summaryProgress = liveProgress ?? r.progressSummary;
    const rRunning = liveProgress?.status === "running";
    const rPending = liveProgress?.status === "pending";
    const stepNumber = liveProgress?.index !== undefined ? liveProgress.index + 1 : resultIndex + 1;
    const rFailed =
      liveProgress?.status === "failed" || (r.exitCode !== 0 && !rRunning && !rPending);
    const rPaused = Boolean(r.interrupted || r.pause) && !rRunning;
    const glyph = rPending
      ? theme.fg("dim", "◦")
      : rFailed
        ? theme.fg("error", "✗")
        : rPaused
          ? theme.fg("warning", "■")
          : resultGlyph(r, output, theme, rRunning, progressRunningSeed(summaryProgress), frame);
    const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
    const stepLabel = resultRowLabel(multiLabel, stepNumber);
    const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${pendingLabel}`;
    lines.push(`  ${line}`);
    const ticketLine = foregroundTkTicketLine(r, theme, rRunning, "    ");
    if (ticketLine) lines.push(ticketLine);
    const childLocLineMulti = childLocationLine(r.childLocation, theme, "    ");
    if (childLocLineMulti) lines.push(childLocLineMulti);
    if (rRunning && liveProgress) {
      hasRunningResult = true;
      for (const [activityIndex, activity] of compactProgressActivityLines(
        liveProgress,
        width,
        WIDGET_ACTIVITY_PREFIX,
        WIDGET_ACTIVITY_CONTINUATION_PREFIX,
      ).entries()) {
        const prefix =
          activityIndex === 0 ? WIDGET_ACTIVITY_PREFIX : WIDGET_ACTIVITY_CONTINUATION_PREFIX;
        lines.push(theme.fg("dim", `${prefix}${activity}`));
      }
    } else if (
      !rPending &&
      (rFailed || rPaused || hasEmptyTextOutputWithoutOutputTarget(r.task, output))
    ) {
      lines.push(theme.fg(rFailed ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`));
    }
  }
  if (d.artifacts)
    lines.push(theme.fg("dim", `  artifacts: ${safeTerminalText(shortenPath(d.artifacts.dir))}`));
  if (hasRunningResult) lines.push(theme.fg("dim", `    ${liveDetailHintText()}`));
  return collapsedForegroundComponent(lines, theme);
}

function renderZeroResult(
  result: SubagentToolResult<Details>,
  d: Details | undefined,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const t = result.content[0];
  const text = safeTerminalText(t?.type === "text" ? t.text : "(no output)");
  const width = getTermWidth() - 4;
  if (!text.includes("\n")) {
    const c = new Container();
    addWrappedText(c, text, width);
    return c;
  }
  if (d && !options.expanded && !result.isError) {
    const lines = text.split(/\r?\n/);
    const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";
    const c = new Container();
    addWrappedText(c, `${firstNonEmptyLine} · ${lines.length} lines`, width);
    addWrappedText(c, theme.fg("dim", `  Press ${liveDetailKeyText()} for full output`), width);
    return c;
  }
  const c = new Container();
  for (const line of wrapDisplayLine(text, width)) c.addChild(new Text(line, 0, 0));
  return c;
}

function renderExpandedSingleResult(
  d: Details,
  r: Details["results"][number],
  theme: Theme,
  mdTheme: ReturnType<typeof getMarkdownTheme>,
  frame?: number,
): Component {
  const isRunning = r.progress?.status === "running";
  const output = safeTerminalText(r.truncation?.text || getSingleResultOutput(r));
  const icon = isRunning
    ? resultGlyph(
        r,
        output,
        theme,
        true,
        progressRunningSeed(r.progress ?? r.progressSummary),
        frame,
      )
    : r.pause?.kind === "awaiting_supervisor" || r.interrupted
      ? theme.fg("warning", "paused")
      : r.exitCode === 0
        ? theme.fg("success", "ok")
        : theme.fg("error", "failed");

  const progressInfo =
    isRunning && r.progress
      ? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
      : r.progressSummary
        ? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
        : "";

  const w = getTermWidth() - 4;
  const toolCallLines = getToolCallLines(r, true);
  const c = new Container();
  c.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(safeTerminalText(r.agent)))}${progressInfo}`,
      0,
      0,
    ),
  );
  const ticketLine = foregroundTkTicketLine(r, theme, isRunning);
  if (ticketLine) c.addChild(new Text(ticketLine, 0, 0));
  const childLocLineSingle = childLocationLine(r.childLocation, theme);
  if (childLocLineSingle) c.addChild(new Text(childLocLineSingle, 0, 0));
  c.addChild(new Spacer(1));
  c.addChild(new Text(theme.fg("dim", `Task: ${safeTerminalText(r.task)}`), 0, 0));
  c.addChild(new Spacer(1));

  const outputTarget = extractOutputTarget(r.task);
  if (outputTarget) {
    c.addChild(new Text(theme.fg("dim", `Output: ${safeTerminalText(outputTarget)}`), 0, 0));
  }

  if (isRunning && r.progress) {
    const progressSnapshotNow = snapshotNowForProgress(r.progress);
    const toolLines = formatCurrentToolLines(
      r.progress,
      w - visibleWidth("> "),
      w - visibleWidth("  "),
      true,
      progressSnapshotNow,
    );
    for (const [toolLineIndex, toolLine] of (toolLines ?? []).entries()) {
      const prefix = toolLineIndex === 0 ? "> " : "  ";
      c.addChild(new Text(theme.fg("warning", `${prefix}${toolLine}`), 0, 0));
    }
    const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
    if (liveStatusLine) {
      c.addChild(new Text(theme.fg("accent", liveStatusLine), 0, 0));
    }
    c.addChild(new Text(theme.fg("dim", liveDetailHintText()), 0, 0));
    if (r.artifactPaths) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `Artifacts: ${safeTerminalText(shortenPath(r.artifactPaths.outputPath))}`,
          ),
          0,
          0,
        ),
      );
    }
    if (r.progress.recentTools?.length) {
      for (const t of r.progress.recentTools.slice(-3)) {
        c.addChild(
          new Text(
            theme.fg("dim", `${safeTerminalText(t.tool)}: ${safeTerminalText(t.args)}`),
            0,
            0,
          ),
        );
      }
    }
    for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
      c.addChild(new Text(theme.fg("dim", `  ${safeTerminalText(line)}`), 0, 0));
    }
    if (
      toolLines?.length ||
      liveStatusLine ||
      r.progress.recentTools?.length ||
      r.progress.recentOutput?.length ||
      r.artifactPaths
    ) {
      c.addChild(new Spacer(1));
    }
  }

  for (const line of toolCallLines) {
    c.addChild(new Text(theme.fg("muted", line), 0, 0));
  }
  if (toolCallLines.length) c.addChild(new Spacer(1));

  if (output) c.addChild(new Markdown(safeTerminalText(output), 0, 0, mdTheme));
  c.addChild(new Spacer(1));
  if (r.skills?.length) {
    c.addChild(
      new Text(
        theme.fg("dim", `Skills: ${r.skills.map((skill) => safeTerminalText(skill)).join(", ")}`),
        0,
        0,
      ),
    );
  }
  if (r.skillsWarning) {
    c.addChild(
      new Text(theme.fg("warning", `Warning: ${safeTerminalText(r.skillsWarning)}`), 0, 0),
    );
  }
  if (r.attemptedModels && r.attemptedModels.length > 1) {
    c.addChild(
      new Text(
        theme.fg(
          "dim",
          `Fallbacks: ${r.attemptedModels.map((model) => safeTerminalText(model)).join(" → ")}`,
        ),
        0,
        0,
      ),
    );
  }
  c.addChild(
    new Text(
      theme.fg(
        "dim",
        safeTerminalText(formatUsage(r.usage, r.model ? safeTerminalText(r.model) : r.model)),
      ),
      0,
      0,
    ),
  );
  if (r.sessionFile) {
    c.addChild(
      new Text(theme.fg("dim", `Session: ${safeTerminalText(shortenPath(r.sessionFile))}`), 0, 0),
    );
  }

  if ((!isRunning && r.artifactPaths) || r.truncation?.artifactPath) {
    c.addChild(new Spacer(1));
    if (!isRunning && r.artifactPaths) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `Artifacts: ${safeTerminalText(shortenPath(r.artifactPaths.outputPath))}`,
          ),
          0,
          0,
        ),
      );
    }
    if (r.truncation?.artifactPath) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `Full output: ${safeTerminalText(shortenPath(r.truncation.artifactPath))}`,
          ),
          0,
          0,
        ),
      );
    }
  }
  return c;
}

function renderExpandedMultiResult(
  d: Details,
  entries: IndexedResultEntry[],
  theme: Theme,
  frame?: number,
): Component {
  const hasRunning =
    d.progress?.some((p) => p.status === "running") ||
    entries.some(({ result }) => result.progress?.status === "running");
  const ok = entries.filter(
    ({ result: r }) =>
      r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running"),
  ).length;
  const hasEmptyWithoutTarget = entries.some(
    ({ result: r }) =>
      r.exitCode === 0 &&
      r.progress?.status !== "running" &&
      hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
  );
  const hasFailure =
    d.progress?.some((p) => p.status === "failed") ||
    entries.some(
      ({ result: r }) =>
        r.progress?.status === "failed" ||
        (r.exitCode !== 0 && r.progress?.status !== "running" && r.progress?.status !== "pending"),
    );
  const hasPause = entries.some(
    ({ result: r }) => Boolean(r.interrupted || r.pause) && r.progress?.status !== "running",
  );
  const icon = hasRunning
    ? theme.fg("accent", runningGlyph(frame))
    : hasEmptyWithoutTarget
      ? theme.fg("warning", "warning")
      : hasFailure
        ? theme.fg("error", "failed")
        : hasPause
          ? theme.fg("warning", "paused")
          : ok === entries.length
            ? theme.fg("success", "ok")
            : theme.fg("error", "failed");

  const totalSummary =
    d.progressSummary ||
    entries.reduce(
      (acc, { result: r }) => {
        const prog = r.progress || r.progressSummary;
        if (prog) {
          acc.toolCount += prog.toolCount;
          acc.tokens += prog.tokens;
          acc.durationMs = Math.max(acc.durationMs, prog.durationMs);
        }
        return acc;
      },
      { toolCount: 0, tokens: 0, durationMs: 0 },
    );

  const totalTurnCount = entries.reduce(
    (sum, { result }) => sum + (result.progress?.turnCount ?? result.usage?.turns ?? 0),
    0,
  );
  const summaryParts = [
    totalTurnCount ? `${totalTurnCount} turns` : "",
    totalSummary.toolCount || totalSummary.tokens || totalSummary.durationMs
      ? `${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
      : "",
    formatTotalCostStat(d.totalCost),
  ].filter(Boolean);
  const summaryStr = summaryParts.length ? ` | ${summaryParts.join(", ")}` : "";

  const modeLabel = safeTerminalText(d.mode);
  const multiLabel = buildMultiProgressLabel(d, entries, hasRunning);

  const w = getTermWidth() - 4;
  const c = new Container();
  c.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))} · ${multiLabel.headerLabel}${summaryStr}`,
      0,
      0,
    ),
  );

  c.addChild(new Spacer(1));

  for (const { index: resultIndex, result: r } of entries) {
    const progressFromArray =
      d.progress?.find((p) => p.index === resultIndex) ||
      d.progress?.find((p) => p.agent === r.agent && p.status === "running");
    const liveProgress = r.progress ?? progressFromArray;
    const summaryProgress = liveProgress ?? r.progressSummary;
    const rRunning = liveProgress?.status === "running";
    const rPending = liveProgress?.status === "pending";
    const stepNumber =
      typeof liveProgress?.index === "number" ? liveProgress.index + 1 : resultIndex + 1;

    const resultOutput = safeTerminalText(getSingleResultOutput(r));
    const rFailed =
      liveProgress?.status === "failed" || (r.exitCode !== 0 && !rRunning && !rPending);
    const rPaused = Boolean(r.interrupted || r.pause) && !rRunning;
    const statusIcon = rRunning
      ? resultGlyph(r, resultOutput, theme, true, progressRunningSeed(summaryProgress), frame)
      : rFailed
        ? theme.fg("error", "failed")
        : rPaused
          ? theme.fg("warning", "paused")
          : hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
            ? theme.fg("warning", "warning")
            : theme.fg("success", "done");
    const stats = summaryProgress
      ? ` | ${summaryProgress.toolCount} tools, ${formatDuration(summaryProgress.durationMs)}`
      : "";
    const modelDisplay = modelThinkingBadge(theme, r.model);
    const stepLabel = resultRowLabel(multiLabel, stepNumber);
    const stepHeader = rRunning
      ? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", safeTerminalText(r.agent)))}${modelDisplay}${stats}`
      : `${statusIcon} ${stepLabel}: ${theme.bold(safeTerminalText(r.agent))}${modelDisplay}${stats}`;
    const toolCallLines = getToolCallLines(r, true);
    c.addChild(new Text(stepHeader, 0, 0));
    const ticketLine = foregroundTkTicketLine(r, theme, rRunning, "    ");
    if (ticketLine) c.addChild(new Text(ticketLine, 0, 0));
    const childLocLineExpanded = childLocationLine(r.childLocation, theme, "    ");
    if (childLocLineExpanded) c.addChild(new Text(childLocLineExpanded, 0, 0));

    c.addChild(new Text(theme.fg("dim", `    task: ${safeTerminalText(r.task)}`), 0, 0));

    const outputTarget = extractOutputTarget(r.task);
    if (outputTarget) {
      c.addChild(new Text(theme.fg("dim", `    output: ${safeTerminalText(outputTarget)}`), 0, 0));
    }

    if (r.skills?.length) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `    skills: ${r.skills.map((skill) => safeTerminalText(skill)).join(", ")}`,
          ),
          0,
          0,
        ),
      );
    }
    if (r.skillsWarning) {
      c.addChild(
        new Text(theme.fg("warning", `    Warning: ${safeTerminalText(r.skillsWarning)}`), 0, 0),
      );
    }
    if (r.attemptedModels && r.attemptedModels.length > 1) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `    fallbacks: ${r.attemptedModels.map((model) => safeTerminalText(model)).join(" → ")}`,
          ),
          0,
          0,
        ),
      );
    }

    if (rRunning && liveProgress) {
      if (liveProgress.skills?.length) {
        c.addChild(
          new Text(
            theme.fg(
              "accent",
              `    skills: ${liveProgress.skills.map((skill) => safeTerminalText(skill)).join(", ")}`,
            ),
            0,
            0,
          ),
        );
      }
      const progressSnapshotNow = snapshotNowForProgress(liveProgress);
      const toolLines = formatCurrentToolLines(
        liveProgress,
        w - visibleWidth("    > "),
        w - visibleWidth("      "),
        true,
        progressSnapshotNow,
      );
      for (const [toolLineIndex, toolLine] of (toolLines ?? []).entries()) {
        const prefix = toolLineIndex === 0 ? "    > " : "      ";
        c.addChild(new Text(theme.fg("warning", `${prefix}${toolLine}`), 0, 0));
      }
      const liveStatusLine = buildLiveStatusLine(liveProgress, progressSnapshotNow);
      if (liveStatusLine) {
        c.addChild(new Text(theme.fg("accent", `    ${liveStatusLine}`), 0, 0));
      }
      c.addChild(new Text(theme.fg("dim", `    ${liveDetailHintText()}`), 0, 0));
      if (r.artifactPaths) {
        c.addChild(
          new Text(
            theme.fg(
              "dim",
              `    artifacts: ${safeTerminalText(shortenPath(r.artifactPaths.outputPath))}`,
            ),
            0,
            0,
          ),
        );
      }
      if (liveProgress.recentTools.length) {
        for (const t of liveProgress.recentTools.slice(-3)) {
          c.addChild(
            new Text(
              theme.fg("dim", `      ${safeTerminalText(t.tool)}: ${safeTerminalText(t.args)}`),
              0,
              0,
            ),
          );
        }
      }
      const recentLines = liveProgress.recentOutput.slice(-5);
      for (const line of recentLines) {
        c.addChild(new Text(theme.fg("dim", `      ${safeTerminalText(line)}`), 0, 0));
      }
    }

    if (!rRunning && r.artifactPaths) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `    artifacts: ${safeTerminalText(shortenPath(r.artifactPaths.outputPath))}`,
          ),
          0,
          0,
        ),
      );
    }
    if (r.truncation?.artifactPath) {
      c.addChild(
        new Text(
          theme.fg(
            "dim",
            `    full output: ${safeTerminalText(shortenPath(r.truncation.artifactPath))}`,
          ),
          0,
          0,
        ),
      );
    }

    if (!rRunning) {
      for (const line of toolCallLines) {
        c.addChild(new Text(theme.fg("muted", `      ${safeTerminalText(line)}`), 0, 0));
      }
      if (toolCallLines.length) c.addChild(new Spacer(1));
    }

    c.addChild(new Spacer(1));
  }

  if (d.artifacts) {
    c.addChild(new Spacer(1));
    c.addChild(
      new Text(
        theme.fg("dim", `Artifacts dir: ${safeTerminalText(shortenPath(d.artifacts.dir))}`),
        0,
        0,
      ),
    );
  }
  return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
  result: SubagentToolResult<Details>,
  options: { expanded: boolean },
  theme: Theme,
  frame?: number,
): Component {
  const d = result.details;
  const entries = indexedRenderableResults(d?.results);
  const hideAsyncPlaceholderBody = Boolean(
    d?.asyncId && entries.length === 0 && d.mode !== "management" && !result.isError,
  );
  if (hideAsyncPlaceholderBody) return new Container();
  if (!d || entries.length === 0) return renderZeroResult(result, d, options, theme);

  const expanded = options.expanded;
  const mdTheme = getMarkdownTheme();

  if (d.mode === "single" && entries.length === 1) {
    const r = entries[0]!.result;
    if (!expanded) return renderSingleCompact(d, r, theme, frame);
    return renderExpandedSingleResult(d, r, theme, mdTheme, frame);
  }

  if (!expanded) return renderMultiCompact(d, entries, theme, frame);
  return renderExpandedMultiResult(d, entries, theme, frame);
}
