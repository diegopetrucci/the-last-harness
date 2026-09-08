import {} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { liveDetailShortcutDisplay } from "../shared/subagent-shortcuts.js";
import {} from "../shared/types.js";
import { formatDuration, formatModelThinking, formatTokens } from "../shared/formatters.js";
import { formatActivityLabel } from "../shared/status-format.js";
import { safeTerminalText } from "../shared/display-text.js";
import { whimsicalThinkingPhrase } from "./whimsical-phrases.js";
export function liveDetailKeyText() {
    return liveDetailShortcutDisplay();
}
export function liveDetailHintText() {
    return `Press ${liveDetailKeyText()} for live detail`;
}
export function getTermWidth() {
    return process.stdout.columns || 120;
}
export function wrapDisplayLine(text, maxWidth) {
    return wrapTextWithAnsi(text, Math.max(1, maxWidth));
}
export function wrapDisplayLines(lines, maxWidth) {
    return lines.flatMap((line) => wrapDisplayLine(line, maxWidth));
}
export function fitInlineThinkingActivity(prefix, phrase, freshness, theme, maxWidth) {
    const separator = ` ${theme.fg("dim", "·")} `;
    const fullLine = `${prefix}${separator}${theme.fg("dim", phrase)}${separator}${theme.fg("dim", freshness)}`;
    return wrapDisplayLine(fullLine, maxWidth);
}
export function fitInlineActivity(prefix, activity, theme, maxWidth) {
    const separator = ` ${theme.fg("dim", "·")} `;
    return wrapDisplayLine(`${prefix}${separator}${theme.fg("dim", activity)}`, maxWidth);
}
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";
export function runningSeed(...values) {
    let seed;
    for (const value of values) {
        if (value === undefined || !Number.isFinite(value))
            continue;
        seed = (seed ?? 0) + Math.trunc(value);
    }
    return seed;
}
export function runningGlyph(seed) {
    if (seed === undefined)
        return STATIC_RUNNING_GLYPH;
    return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length];
}
export function progressRunningSeed(progress) {
    if (!progress)
        return undefined;
    return runningSeed(progress.index, progress.toolCount, progress.tokens, progress.durationMs, progress.lastActivityAt, progress.currentToolStartedAt, progress.turnCount);
}
export function snapshotNowForProgress(progress) {
    if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined)
        return progress.currentToolStartedAt + progress.durationMs;
    return progress.lastActivityAt;
}
const COLLAPSED_COMMAND_PREVIEW_ROWS = 3;
export function fitCompactToolStatus(toolLines, liveStatus, firstWidth, continuationWidth) {
    if (!liveStatus || toolLines.includes(liveStatus))
        return toolLines;
    const finalLineIndex = toolLines.length - 1;
    const finalWidth = finalLineIndex === 0 ? firstWidth : continuationWidth;
    const finalLine = `${toolLines[finalLineIndex]} · ${liveStatus}`;
    if (visibleWidth(finalLine) <= Math.max(1, finalWidth)) {
        return [...toolLines.slice(0, finalLineIndex), finalLine];
    }
    return [...toolLines, liveStatus];
}
function isDisplayWhitespace(character) {
    return character.trim().length === 0;
}
function stripBareTerminalControls(text) {
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
            if (previous !== undefined &&
                !isDisplayWhitespace(previous) &&
                !isDisplayWhitespace(character)) {
                sanitized += " ";
            }
            pendingControlSpace = false;
        }
        sanitized += character;
    }
    return sanitized;
}
function wrapCommandPreview(text, firstWidth, continuationWidth) {
    const firstLines = wrapDisplayLine(text, Math.max(1, firstWidth));
    if (firstLines.length <= 1)
        return firstLines;
    const firstLine = firstLines[0];
    const continuationSource = text.slice(firstLine.length).trimStart();
    return [firstLine, ...wrapDisplayLine(continuationSource, Math.max(1, continuationWidth))];
}
function fitCollapsedCommandPreview(commandText, durationSuffix, firstWidth, continuationWidth) {
    const reflowed = stripBareTerminalControls(stripTerminalSequences(commandText).replace(/\r\n|\r|\n/g, " "));
    const lines = wrapCommandPreview(`${reflowed}${durationSuffix}`, firstWidth, continuationWidth);
    if (lines.length <= COLLAPSED_COMMAND_PREVIEW_ROWS)
        return lines;
    const ellipsis = "…";
    const truncationSuffix = `${ellipsis}${durationSuffix}`;
    const truncationSuffixWidth = visibleWidth(truncationSuffix);
    if (truncationSuffixWidth >= Math.max(1, continuationWidth)) {
        return [...lines.slice(0, COLLAPSED_COMMAND_PREVIEW_ROWS - 1), ellipsis];
    }
    const commandLines = wrapCommandPreview(reflowed, firstWidth, continuationWidth);
    const finalLine = wrapDisplayLine(commandLines[COLLAPSED_COMMAND_PREVIEW_ROWS - 1] ?? "", Math.max(1, continuationWidth - truncationSuffixWidth))[0];
    return [
        ...commandLines.slice(0, COLLAPSED_COMMAND_PREVIEW_ROWS - 1),
        `${finalLine ?? ""}${truncationSuffix}`,
    ];
}
export function formatCurrentToolLines(progress, firstWidth, continuationWidth, expanded, snapshotNow) {
    if (!progress.currentTool)
        return undefined;
    const currentTool = safeTerminalText(progress.currentTool);
    const toolArgsPreview = safeTerminalText(progress.currentToolArgs ?? "");
    const durationSuffix = progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
        ? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
        : "";
    const toolLine = toolArgsPreview
        ? `${currentTool}: ${toolArgsPreview}${durationSuffix}`
        : `${currentTool}${durationSuffix}`;
    if (expanded)
        return toolLine.split(/\r\n|\r|\n/);
    const commandText = toolArgsPreview ? `${currentTool}: ${toolArgsPreview}` : currentTool;
    return fitCollapsedCommandPreview(commandText, durationSuffix, firstWidth, continuationWidth);
}
export function buildLiveStatusLine(progress, snapshotNow) {
    if (progress.lastActivityAt !== undefined && snapshotNow !== undefined)
        return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
    if (progress.activityState === "needs_attention")
        return "needs attention";
    if (progress.activityState === "active_long_running")
        return "active but long-running";
    if (progress.lastActivityAt !== undefined)
        return "active";
    return undefined;
}
export function isHealthActivityState(activityState) {
    return activityState === "needs_attention" || activityState === "active_long_running";
}
export function compactThinkingPhrase(activityState, turnCount) {
    return isHealthActivityState(activityState) ? undefined : whimsicalThinkingPhrase(turnCount);
}
export function themeBold(theme, text) {
    return theme.bold?.(text) ?? text;
}
export function statJoin(theme, parts) {
    return parts
        .filter(Boolean)
        .map((part) => theme.fg("dim", part))
        .join(` ${theme.fg("dim", "·")} `);
}
export function formatTokenStat(tokens) {
    return `${formatTokens(tokens)} token`;
}
export function formatToolUseStat(count) {
    return `${count} tool use${count === 1 ? "" : "s"}`;
}
export function modelThinkingBadge(theme, model, thinking) {
    const label = safeTerminalText(formatModelThinking(model ? safeTerminalText(model) : model, thinking));
    return label ? theme.fg("dim", ` (${label})`) : "";
}
