/**
 * Stateless display primitives shared by the async widget and foreground result cards.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { liveDetailShortcutDisplay } from "../shared/subagent-shortcuts.ts";
import { type ActivityState, type AgentProgress } from "../shared/types.ts";
import { formatDuration, formatModelThinking, formatTokens } from "../shared/formatters.ts";
import { formatActivityLabel } from "../shared/status-format.ts";
import { safeTerminalText } from "../shared/display-text.ts";
import { whimsicalThinkingPhrase } from "./whimsical-phrases.ts";
import type { ChildLocationSnapshot } from "../shared/child-location.ts";

export type Theme = ExtensionContext["ui"]["theme"];

export function liveDetailKeyText(): string {
  return liveDetailShortcutDisplay();
}

export function liveDetailHintText(): string {
  return `Press ${liveDetailKeyText()} for live detail`;
}

export function getTermWidth(): number {
  return process.stdout.columns || 120;
}

export function wrapDisplayLine(text: string, maxWidth: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, maxWidth));
}

export function wrapDisplayLines(lines: readonly string[], maxWidth: number): string[] {
  return lines.flatMap((line) => wrapDisplayLine(line, maxWidth));
}
export function fitInlineThinkingActivity(
  prefix: string,
  phrase: string,
  freshness: string,
  theme: Theme,
  maxWidth: number,
): string[] {
  const separator = ` ${theme.fg("dim", "·")} `;
  const fullLine = `${prefix}${separator}${theme.fg("dim", phrase)}${separator}${theme.fg("dim", freshness)}`;
  return wrapDisplayLine(fullLine, maxWidth);
}

export function fitInlineActivity(
  prefix: string,
  activity: string,
  theme: Theme,
  maxWidth: number,
): string[] {
  const separator = ` ${theme.fg("dim", "·")} `;
  return wrapDisplayLine(`${prefix}${separator}${theme.fg("dim", activity)}`, maxWidth);
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

type ProgressSeedSource = Partial<
  Pick<
    AgentProgress,
    | "index"
    | "toolCount"
    | "tokens"
    | "durationMs"
    | "lastActivityAt"
    | "currentToolStartedAt"
    | "turnCount"
  >
>;

export function runningSeed(...values: Array<number | undefined>): number | undefined {
  let seed: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    seed = (seed ?? 0) + Math.trunc(value);
  }
  return seed;
}

export function runningGlyph(seed?: number): string {
  if (seed === undefined) return STATIC_RUNNING_GLYPH;
  return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

export function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
  if (!progress) return undefined;
  return runningSeed(
    progress.index,
    progress.toolCount,
    progress.tokens,
    progress.durationMs,
    progress.lastActivityAt,
    progress.currentToolStartedAt,
    progress.turnCount,
  );
}
export function snapshotNowForProgress(
  progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">,
): number | undefined {
  if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined)
    return progress.currentToolStartedAt + progress.durationMs;
  return progress.lastActivityAt;
}
const COLLAPSED_COMMAND_PREVIEW_ROWS = 3;

export function fitCompactToolStatus(
  toolLines: string[],
  liveStatus: string | undefined,
  firstWidth: number,
  continuationWidth: number,
): string[] {
  if (!liveStatus || toolLines.includes(liveStatus)) return toolLines;
  const finalLineIndex = toolLines.length - 1;
  const finalWidth = finalLineIndex === 0 ? firstWidth : continuationWidth;
  const finalLine = `${toolLines[finalLineIndex]!} · ${liveStatus}`;
  if (visibleWidth(finalLine) <= Math.max(1, finalWidth)) {
    return [...toolLines.slice(0, finalLineIndex), finalLine];
  }
  return [...toolLines, liveStatus];
}

function isDisplayWhitespace(character: string): boolean {
  return character.trim().length === 0;
}

function stripBareTerminalControls(text: string): string {
  let sanitized = "";
  let pendingControlSpace = false;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      pendingControlSpace = true;
      continue;
    }
    if (pendingControlSpace) {
      const previous = sanitized.at(-1);
      if (
        previous !== undefined &&
        !isDisplayWhitespace(previous) &&
        !isDisplayWhitespace(character)
      ) {
        sanitized += " ";
      }
      pendingControlSpace = false;
    }
    sanitized += character;
  }
  return sanitized;
}

function wrapCommandPreview(text: string, firstWidth: number, continuationWidth: number): string[] {
  const firstLines = wrapDisplayLine(text, Math.max(1, firstWidth));
  if (firstLines.length <= 1) return firstLines;
  const firstLine = firstLines[0]!;
  const continuationSource = text.slice(firstLine.length).trimStart();
  return [firstLine, ...wrapDisplayLine(continuationSource, Math.max(1, continuationWidth))];
}

function fitCollapsedCommandPreview(
  commandText: string,
  durationSuffix: string,
  firstWidth: number,
  continuationWidth: number,
): string[] {
  const reflowed = stripBareTerminalControls(
    stripTerminalSequences(commandText).replace(/\r\n|\r|\n/g, " "),
  );
  const lines = wrapCommandPreview(`${reflowed}${durationSuffix}`, firstWidth, continuationWidth);
  if (lines.length <= COLLAPSED_COMMAND_PREVIEW_ROWS) return lines;

  const ellipsis = "…";
  const truncationSuffix = `${ellipsis}${durationSuffix}`;
  const truncationSuffixWidth = visibleWidth(truncationSuffix);
  if (truncationSuffixWidth >= Math.max(1, continuationWidth)) {
    return [...lines.slice(0, COLLAPSED_COMMAND_PREVIEW_ROWS - 1), ellipsis];
  }
  const commandLines = wrapCommandPreview(reflowed, firstWidth, continuationWidth);
  const finalLine = wrapDisplayLine(
    commandLines[COLLAPSED_COMMAND_PREVIEW_ROWS - 1] ?? "",
    Math.max(1, continuationWidth - truncationSuffixWidth),
  )[0];
  return [
    ...commandLines.slice(0, COLLAPSED_COMMAND_PREVIEW_ROWS - 1),
    `${finalLine ?? ""}${truncationSuffix}`,
  ];
}

export function formatCurrentToolLines(
  progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
  firstWidth: number,
  continuationWidth: number,
  expanded: boolean,
  snapshotNow?: number,
): string[] | undefined {
  if (!progress.currentTool) return undefined;
  const currentTool = safeTerminalText(progress.currentTool);
  const toolArgsPreview = safeTerminalText(progress.currentToolArgs ?? "");
  const durationSuffix =
    progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
      ? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
      : "";
  const toolLine = toolArgsPreview
    ? `${currentTool}: ${toolArgsPreview}${durationSuffix}`
    : `${currentTool}${durationSuffix}`;
  if (expanded) return toolLine.split(/\r\n|\r|\n/);
  const commandText = toolArgsPreview ? `${currentTool}: ${toolArgsPreview}` : currentTool;
  return fitCollapsedCommandPreview(commandText, durationSuffix, firstWidth, continuationWidth);
}

export function buildLiveStatusLine(
  progress: Pick<AgentProgress, "activityState" | "lastActivityAt">,
  snapshotNow?: number,
): string | undefined {
  if (progress.lastActivityAt !== undefined && snapshotNow !== undefined)
    return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
  if (progress.activityState === "needs_attention") return "needs attention";
  if (progress.activityState === "active_long_running") return "active but long-running";
  if (progress.lastActivityAt !== undefined) return "active";
  return undefined;
}
export function isHealthActivityState(activityState: ActivityState | undefined): boolean {
  return activityState === "needs_attention" || activityState === "active_long_running";
}

export function compactThinkingPhrase(
  activityState: ActivityState | undefined,
  turnCount?: number,
): string | undefined {
  return isHealthActivityState(activityState) ? undefined : whimsicalThinkingPhrase(turnCount);
}

export function themeBold(theme: Theme, text: string): string {
  return (theme as { bold?: (value: string) => string }).bold?.(text) ?? text;
}

export function statJoin(theme: Theme, parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => theme.fg("dim", part))
    .join(` ${theme.fg("dim", "·")} `);
}

export function formatTokenStat(tokens: number): string {
  return `${formatTokens(tokens)} token`;
}

export function formatToolUseStat(count: number): string {
  return `${count} tool use${count === 1 ? "" : "s"}`;
}
export function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
  const label = safeTerminalText(
    formatModelThinking(model ? safeTerminalText(model) : model, thinking),
  );
  return label ? theme.fg("dim", ` (${label})`) : "";
}

// ---------------------------------------------------------------------------
// Child-location line helpers
// ---------------------------------------------------------------------------

/**
 * Build the display text for a child-location snapshot.
 * Parts are joined with " · " in broad-to-narrow order:
 * cwd → repo (different repo only) → linked worktree → branch / detached HEAD → no git repo.
 * Returns undefined when the snapshot is absent (same-cwd run, the common case).
 */
export function childLocationText(loc: ChildLocationSnapshot | undefined): string | undefined {
  if (!loc) return undefined;
  const parts: string[] = [`cwd: ${safeTerminalText(loc.displayPath)}`];
  if (loc.repoName) parts.push(`repo: ${safeTerminalText(loc.repoName)}`);
  if (loc.linkedWorktree) parts.push("linked worktree");
  if (loc.detachedHead) parts.push(`branch: detached@${safeTerminalText(loc.detachedHead)}`);
  else if (loc.branch) parts.push(`branch: ${safeTerminalText(loc.branch)}`);
  if (loc.notAGitRepo) parts.push("no git repo");
  return parts.join(" \u00b7 ");
}

export function childLocationLine(
  loc: ChildLocationSnapshot | undefined,
  theme: Theme,
  indent = "  ",
): string | undefined {
  const text = childLocationText(loc);
  return text ? `${indent}${theme.fg("dim", text)}` : undefined;
}
