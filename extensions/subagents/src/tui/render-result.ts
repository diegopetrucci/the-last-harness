/**
 * Engine-neutral subagent tool-result rendering.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { type Details, type SubagentToolResult } from "../shared/types.ts";
import { parsePersistedChildLocationSnapshot } from "../shared/child-location.ts";
import {
  formatDuration,
  formatTokens,
  formatToolCall,
  formatUsage,
  shortenPath,
} from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { extractSingleOutputInstructionTarget } from "../runs/shared/single-output.ts";
import { safeTerminalDocumentLeaf, safeTerminalText } from "../shared/display-text.ts";
import {
  childLocationLine,
  getTermWidth,
  liveDetailKeyText,
  modelThinkingBadge,
  statJoin,
  themeBold,
  type Theme,
  wrapDisplayLine,
  wrapDisplayLines,
} from "./render-primitives.ts";

// Detail column = agent-name column + 2. Single results start at column 0
// ("<glyph> <agent>"), so details sit at 4; multi rows are indented under the
// header ("  <glyph> <label>"), so collapsed details sit at 6. Expanded multi
// rows start at column 0, so they use the single-result column.
const RESULT_DETAIL_INDENT = "    ";
const MULTI_DETAIL_INDENT = "      ";

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
): string[] {
  if (result.messages) {
    return getDisplayItems(result.messages)
      .filter(
        (item): item is { type: "tool"; name: string; args: Record<string, unknown> } =>
          item.type === "tool",
      )
      .map((item) => safeTerminalDocumentLeaf(formatToolCall(item.name, item.args)));
  }
  return (
    result.toolCalls?.map((toolCall) =>
      safeTerminalDocumentLeaf(toolCall.expandedText ?? toolCall.text),
    ) ?? []
  );
}
function addWrappedText(container: Container, text: string, maxWidth: number): void {
  for (const line of wrapDisplayLine(text, maxWidth)) container.addChild(new Text(line, 0, 0));
}

function collapsedResultLineBudget(): number {
  const rows = process.stdout.rows || 30;
  return Math.max(5, Math.min(14, Math.floor(rows * 0.4)));
}

function collapsedResultSummaryLines(
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

function fitCollapsedResultLines(contentLines: string[], theme: Theme, width: number): string[] {
  const budget = collapsedResultLineBudget();
  if (contentLines.length <= budget) return contentLines;

  for (
    let visibleCount = Math.min(contentLines.length, budget - 1);
    visibleCount >= 0;
    visibleCount--
  ) {
    const hiddenCount = contentLines.length - visibleCount;
    const summaryLines = wrapDisplayLine(
      theme.fg("dim", `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`),
      width,
    );
    if (visibleCount + summaryLines.length <= budget) {
      return [...contentLines.slice(0, visibleCount), ...summaryLines];
    }
  }

  return collapsedResultSummaryLines(contentLines.length, theme, width, budget).slice(0, budget);
}

function collapsedResultComponent(logicalLines: readonly string[], theme: Theme): Component {
  return {
    render(width: number): string[] {
      const contentWidth = Math.max(1, width);
      return fitCollapsedResultLines(
        wrapDisplayLines(logicalLines, contentWidth),
        theme,
        contentWidth,
      );
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
  const preview = firstOutputLine(safeTerminalDocumentLeaf(text));
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
      : firstOutputLine(safeTerminalDocumentLeaf(output)) || `exit ${result.exitCode}`;
    return `Error: ${error}`;
  }
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, safeTerminalDocumentLeaf(output)))
    return "Done (no text output)";
  return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme): string {
  if (result.interrupted) return theme.fg("warning", "■");
  if (result.exitCode !== 0) return theme.fg("error", "✗");
  if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
  return theme.fg("success", "✓");
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
  return results.flatMap((result, index) => {
    if (!isRenderableResult(result)) return [];
    // Normalise childLocation through the same persisted-snapshot parser used
    // by the status.json path. A malformed value (e.g. { displayPath: {} }) is
    // dropped — only the field, never the whole result card.
    const normalized: RenderResult = {
      ...result,
      childLocation: parsePersistedChildLocationSnapshot(result.childLocation),
    };
    return [{ index, result: normalized }];
  });
}

interface MultiProgressLabel {
  headerLabel: string;
  itemTitle: "Step" | "Agent";
  totalCount: number;
}

function buildMultiProgressLabel(
  details: Pick<Details, "mode" | "progress" | "totalSteps">,
  entries: IndexedResultEntry[],
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
  return {
    headerLabel: `${done}/${totalCount}`,
    itemTitle,
    totalCount,
  };
}

function resultRowLabel(label: MultiProgressLabel, stepNumber: number): string {
  return label.itemTitle === "Agent"
    ? `Agent ${stepNumber}/${label.totalCount}`
    : `Step ${stepNumber}`;
}
function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme): Component {
  const rawOutput = r.truncation?.text || getSingleResultOutput(r);
  const output = safeTerminalText(rawOutput);
  const lines: string[] = [];
  const modelDisplay = modelThinkingBadge(theme, r.model);
  lines.push(
    `${resultGlyph(r, output, theme)} ${theme.fg("toolTitle", theme.bold(safeTerminalText(r.agent)))}${modelDisplay}`,
  );
  const childLocLine = childLocationLine(r.childLocation, theme, RESULT_DETAIL_INDENT);
  if (childLocLine) lines.push(childLocLine);

  const preview = compactOutputPreview(rawOutput);
  lines.push(theme.fg("dim", `${RESULT_DETAIL_INDENT}${resultStatusLine(r, preview)}`));
  if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
    lines.push(theme.fg("dim", `${RESULT_DETAIL_INDENT}${preview}`));
  }
  if (r.sessionFile)
    lines.push(
      theme.fg(
        "dim",
        `${RESULT_DETAIL_INDENT}session: ${safeTerminalText(shortenPath(r.sessionFile))}`,
      ),
    );
  return collapsedResultComponent(lines, theme);
}

function renderMultiCompact(d: Details, entries: IndexedResultEntry[], theme: Theme): Component {
  const failed =
    d.progress?.some((p) => p.status === "failed") ||
    entries.some(
      ({ result: r }) =>
        r.progress?.status === "failed" || (r.exitCode !== 0 && r.progress?.status !== "pending"),
    );
  const paused = entries.some(({ result: r }) => Boolean(r.interrupted || r.pause));
  const multiLabel = buildMultiProgressLabel(d, entries);
  const stats = statJoin(theme, [multiLabel.headerLabel, formatTotalCostStat(d.totalCost, false)]);
  const glyph = failed
    ? theme.fg("error", "✗")
    : paused
      ? theme.fg("warning", "■")
      : theme.fg("success", "✓");
  const lines: string[] = [];
  lines.push(
    `${glyph} ${theme.fg("toolTitle", theme.bold(safeTerminalText(d.mode)))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
  );
  for (const { index: resultIndex, result: r } of entries) {
    const agentName = safeTerminalText(r.agent);
    const rawOutput = getSingleResultOutput(r);
    const output = safeTerminalText(rawOutput);
    const progressFromArray =
      d.progress?.find((p) => p.index === resultIndex) ||
      d.progress?.find((p) => p.agent === r.agent && p.status === "running");
    const liveProgress = r.progress ?? progressFromArray;
    const rPending = liveProgress?.status === "pending";
    const stepNumber = liveProgress?.index !== undefined ? liveProgress.index + 1 : resultIndex + 1;
    const rFailed = liveProgress?.status === "failed" || (r.exitCode !== 0 && !rPending);
    const rPaused = Boolean(r.interrupted || r.pause);
    const glyph = rPending
      ? theme.fg("dim", "◦")
      : rFailed
        ? theme.fg("error", "✗")
        : rPaused
          ? theme.fg("warning", "■")
          : resultGlyph(r, output, theme);
    const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
    const stepLabel = resultRowLabel(multiLabel, stepNumber);
    const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${pendingLabel}`;
    lines.push(`  ${line}`);
    const childLocLineMulti = childLocationLine(r.childLocation, theme, MULTI_DETAIL_INDENT);
    if (childLocLineMulti) lines.push(childLocLineMulti);
    if (
      !rPending &&
      (rFailed || rPaused || hasEmptyTextOutputWithoutOutputTarget(r.task, output))
    ) {
      lines.push(
        theme.fg(
          rFailed ? "error" : "dim",
          `${MULTI_DETAIL_INDENT}${resultStatusLine(r, rawOutput)}`,
        ),
      );
    }
  }
  if (d.artifacts)
    lines.push(theme.fg("dim", `  artifacts: ${safeTerminalText(shortenPath(d.artifacts.dir))}`));
  return collapsedResultComponent(lines, theme);
}

function renderZeroResult(
  result: SubagentToolResult<Details>,
  d: Details | undefined,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const t = result.content[0];
  const text = safeTerminalDocumentLeaf(t?.type === "text" ? t.text : "(no output)");
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
): Component {
  const rawOutput = r.truncation?.text || getSingleResultOutput(r);
  const output = safeTerminalText(rawOutput);
  const icon =
    r.pause?.kind === "awaiting_supervisor" || r.interrupted
      ? theme.fg("warning", "paused")
      : r.exitCode === 0
        ? theme.fg("success", "ok")
        : theme.fg("error", "failed");

  const progressInfo = r.progressSummary
    ? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
    : "";

  const toolCallLines = getToolCallLines(r);
  const c = new Container();
  c.addChild(
    new Text(
      `${icon} ${theme.fg("toolTitle", theme.bold(safeTerminalText(r.agent)))}${progressInfo}`,
      0,
      0,
    ),
  );
  const childLocLineSingle = childLocationLine(r.childLocation, theme, RESULT_DETAIL_INDENT);
  if (childLocLineSingle) c.addChild(new Text(childLocLineSingle, 0, 0));
  c.addChild(new Spacer(1));
  c.addChild(new Text(theme.fg("dim", `Task: ${safeTerminalDocumentLeaf(r.task)}`), 0, 0));
  c.addChild(new Spacer(1));

  const outputTarget = extractOutputTarget(r.task);
  if (outputTarget) {
    c.addChild(new Text(theme.fg("dim", `Output: ${safeTerminalText(outputTarget)}`), 0, 0));
  }

  for (const line of toolCallLines) {
    c.addChild(new Text(theme.fg("muted", line), 0, 0));
  }
  if (toolCallLines.length) c.addChild(new Spacer(1));

  if (output) {
    const outputDocument = safeTerminalDocumentLeaf(rawOutput);
    c.addChild(new Markdown(outputDocument, 0, 0, mdTheme));
  }
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

  if (r.artifactPaths || r.truncation?.artifactPath) {
    c.addChild(new Spacer(1));
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
): Component {
  const ok = entries.filter(
    ({ result: r }) => r.progress?.status === "completed" || r.exitCode === 0,
  ).length;
  const hasEmptyWithoutTarget = entries.some(
    ({ result: r }) =>
      r.exitCode === 0 && hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
  );
  const hasFailure =
    d.progress?.some((p) => p.status === "failed") ||
    entries.some(
      ({ result: r }) =>
        r.progress?.status === "failed" || (r.exitCode !== 0 && r.progress?.status !== "pending"),
    );
  const hasPause = entries.some(({ result: r }) => Boolean(r.interrupted || r.pause));
  const icon = hasEmptyWithoutTarget
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
  const multiLabel = buildMultiProgressLabel(d, entries);

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
    const rPending = liveProgress?.status === "pending";
    const stepNumber =
      typeof liveProgress?.index === "number" ? liveProgress.index + 1 : resultIndex + 1;

    const resultOutput = safeTerminalText(getSingleResultOutput(r));
    const rFailed = liveProgress?.status === "failed" || (r.exitCode !== 0 && !rPending);
    const rPaused = Boolean(r.interrupted || r.pause);
    const statusIcon = rFailed
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
    const stepHeader = `${statusIcon} ${stepLabel}: ${theme.bold(safeTerminalText(r.agent))}${modelDisplay}${stats}`;
    const toolCallLines = getToolCallLines(r);
    c.addChild(new Text(stepHeader, 0, 0));
    const childLocLineExpanded = childLocationLine(r.childLocation, theme, RESULT_DETAIL_INDENT);
    if (childLocLineExpanded) c.addChild(new Text(childLocLineExpanded, 0, 0));

    c.addChild(new Text(theme.fg("dim", `    task: ${safeTerminalDocumentLeaf(r.task)}`), 0, 0));

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

    for (const line of toolCallLines) {
      c.addChild(new Text(theme.fg("muted", `      ${line}`), 0, 0));
    }
    if (toolCallLines.length) c.addChild(new Spacer(1));

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
    if (!expanded) return renderSingleCompact(d, r, theme);
    return renderExpandedSingleResult(d, r, theme, mdTheme);
  }

  if (!expanded) return renderMultiCompact(d, entries, theme);
  return renderExpandedMultiResult(d, entries, theme);
}
