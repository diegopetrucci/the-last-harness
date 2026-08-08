import * as path from "node:path";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { liveDetailShortcutDisplay } from "../shared/subagent-shortcuts.js";
import { MAX_WIDGET_JOBS, WIDGET_KEY, } from "../shared/types.js";
import { formatTokens, formatUsage, formatDuration, formatModelThinking, formatToolCall, shortenPath, } from "../shared/formatters.js";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.js";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.js";
import { extractSingleOutputInstructionTarget } from "../runs/shared/single-output.js";
import { formatNestedAggregate } from "../runs/shared/nested-render.js";
import { normalizeTkTicketMetadata } from "../runs/shared/tk-ticket.js";
import { aggregateStepStatus, formatActivityLabel, formatAgentRunningLabel, formatParallelOutcome, } from "../shared/status-format.js";
import { isProtectedPausedLifecycle } from "../runs/shared/lifecycle-privacy.js";
function liveDetailKeyText() {
    return liveDetailShortcutDisplay();
}
function liveDetailHintText() {
    return `Press ${liveDetailKeyText()} for live detail`;
}
function getTermWidth() {
    return process.stdout.columns || 120;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ANSI_SGR_PATTERN = new RegExp(`^${String.fromCharCode(0x1b)}\\[[0-9;]*m`);
const ANSI_ESCAPE = String.fromCharCode(0x1b);
function truncLine(text, maxWidth) {
    if (visibleWidth(text) <= maxWidth)
        return text;
    const targetWidth = maxWidth - 1;
    let result = "";
    let currentWidth = 0;
    let activeStyles = [];
    let i = 0;
    while (i < text.length) {
        const ansiMatch = text.slice(i).match(ANSI_SGR_PATTERN);
        if (ansiMatch) {
            const code = ansiMatch[0];
            result += code;
            if (code === `${ANSI_ESCAPE}[0m` || code === `${ANSI_ESCAPE}[m`) {
                activeStyles = [];
            }
            else {
                activeStyles.push(code);
            }
            i += code.length;
            continue;
        }
        let end = i;
        while (end < text.length && !text.slice(end).match(ANSI_SGR_PATTERN)) {
            end++;
        }
        const textPortion = text.slice(i, end);
        for (const seg of segmenter.segment(textPortion)) {
            const grapheme = seg.segment;
            const graphemeWidth = visibleWidth(grapheme);
            if (currentWidth + graphemeWidth > targetWidth) {
                return result + activeStyles.join("") + "…";
            }
            result += grapheme;
            currentWidth += graphemeWidth;
        }
        i = end;
    }
    return result + activeStyles.join("") + "…";
}
function wrapPlainText(text, maxWidth) {
    if (maxWidth <= 0)
        return [""];
    const lines = [];
    for (const rawLine of text.split("\n")) {
        if (rawLine.length === 0) {
            lines.push("");
            continue;
        }
        let current = "";
        let currentWidth = 0;
        for (const seg of segmenter.segment(rawLine)) {
            const grapheme = seg.segment;
            const graphemeWidth = visibleWidth(grapheme);
            if (currentWidth > 0 && currentWidth + graphemeWidth > maxWidth) {
                lines.push(current);
                current = grapheme;
                currentWidth = graphemeWidth;
                continue;
            }
            current += grapheme;
            currentWidth += graphemeWidth;
        }
        lines.push(current);
    }
    return lines;
}
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";
function runningSeed(...values) {
    let seed;
    for (const value of values) {
        if (value === undefined || !Number.isFinite(value))
            continue;
        seed = (seed ?? 0) + Math.trunc(value);
    }
    return seed;
}
function runningGlyph(seed) {
    if (seed === undefined)
        return STATIC_RUNNING_GLYPH;
    return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length];
}
function progressRunningSeed(progress) {
    if (!progress)
        return undefined;
    return runningSeed(progress.index, progress.toolCount, progress.tokens, progress.durationMs, progress.lastActivityAt, progress.currentToolStartedAt, progress.turnCount);
}
export function clearLegacyResultAnimationTimer(context) {
    const timer = context.state.subagentResultAnimationTimer;
    if (!timer)
        return;
    clearInterval(timer);
    context.state.subagentResultAnimationTimer = undefined;
}
function extractOutputTarget(task) {
    const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
    if (writeToMatch?.[1]?.trim())
        return writeToMatch[1].trim();
    const findingsMatch = extractSingleOutputInstructionTarget(task);
    if (findingsMatch)
        return findingsMatch;
    const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
    if (outputMatch?.[1]?.trim())
        return outputMatch[1].trim();
    return undefined;
}
function hasEmptyTextOutputWithoutOutputTarget(task, output) {
    if (output.trim())
        return false;
    return !extractOutputTarget(task);
}
function getToolCallLines(result, expanded) {
    if (result.messages) {
        return getDisplayItems(result.messages)
            .filter((item) => item.type === "tool")
            .map((item) => formatToolCall(item.name, item.args, expanded));
    }
    return result.toolCalls?.map((toolCall) => (expanded ? toolCall.expandedText : toolCall.text)) ?? [];
}
function snapshotNowForProgress(progress) {
    if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined)
        return progress.currentToolStartedAt + progress.durationMs;
    return progress.lastActivityAt;
}
function formatCurrentToolLine(progress, availableWidth, expanded, snapshotNow) {
    if (!progress.currentTool)
        return undefined;
    const maxToolArgsLen = Math.max(50, availableWidth - 20);
    const toolArgsPreview = progress.currentToolArgs
        ? expanded || progress.currentToolArgs.length <= maxToolArgsLen
            ? progress.currentToolArgs
            : `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`
        : "";
    const durationSuffix = progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
        ? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
        : "";
    return toolArgsPreview
        ? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
        : `${progress.currentTool}${durationSuffix}`;
}
function buildLiveStatusLine(progress, snapshotNow) {
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
function themeBold(theme, text) {
    return theme.bold?.(text) ?? text;
}
function statJoin(theme, parts) {
    return parts
        .filter(Boolean)
        .map((part) => theme.fg("dim", part))
        .join(` ${theme.fg("dim", "·")} `);
}
function formatTokenStat(tokens) {
    return `${formatTokens(tokens)} token`;
}
function formatToolUseStat(count) {
    return `${count} tool use${count === 1 ? "" : "s"}`;
}
function formatTotalCostStat(totalCost) {
    if (!totalCost || (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0))
        return "";
    const parts = [];
    if (totalCost.inputTokens)
        parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
    if (totalCost.outputTokens)
        parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
    if (totalCost.costUsd)
        parts.push(`$${totalCost.costUsd.toFixed(4)}`);
    return parts.join(" ");
}
function formatProgressStats(theme, progress, includeDuration = true) {
    if (!progress)
        return "";
    const parts = [];
    if (progress.toolCount > 0)
        parts.push(formatToolUseStat(progress.toolCount));
    if (progress.tokens > 0)
        parts.push(formatTokenStat(progress.tokens));
    if (includeDuration && progress.durationMs > 0)
        parts.push(formatDuration(progress.durationMs));
    return statJoin(theme, parts);
}
function firstOutputLine(text) {
    return (text
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ?? "");
}
function compactOutputPreview(text) {
    const preview = firstOutputLine(text);
    const withoutTruncationPath = preview.replace(/ - full output at (?:\/|[A-Za-z]:[\\/]|\\\\).*\]$/, "]");
    const savedOutput = withoutTruncationPath.match(/^Output saved to: (?:\/|[A-Za-z]:[\\/]|\\\\).* \(([^()]*)\)\. Read this file if needed\.$/);
    if (savedOutput)
        return `Output saved (${savedOutput[1]}). Read this file if needed.`;
    if (/^Output file error: (?:\/|[A-Za-z]:[\\/]|\\\\)/.test(withoutTruncationPath)) {
        return "Output file error (expand for details)";
    }
    return withoutTruncationPath;
}
function resultStatusLine(result, output) {
    if (result.pause?.kind === "awaiting_supervisor")
        return "Paused awaiting supervisor · no child process running";
    if (result.detached)
        return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
    if (result.interrupted)
        return "Paused";
    if (result.exitCode !== 0)
        return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
    if (result.acceptance?.status && result.acceptance.status !== "not-required")
        return `Done · acceptance: ${result.acceptance.status}`;
    if (hasEmptyTextOutputWithoutOutputTarget(result.task, output))
        return "Done (no text output)";
    return "Done";
}
function resultGlyph(result, output, theme, running = result.progress?.status === "running", seed = progressRunningSeed(result.progress ?? result.progressSummary), frame) {
    if (running) {
        if (frame !== undefined)
            return theme.fg("accent", runningGlyph((seed ?? 0) + frame));
        return theme.fg("accent", runningGlyph(seed));
    }
    if (result.detached)
        return theme.fg("warning", "■");
    if (result.interrupted)
        return theme.fg("warning", "■");
    if (result.exitCode !== 0)
        return theme.fg("error", "✗");
    if (hasEmptyTextOutputWithoutOutputTarget(result.task, output))
        return theme.fg("warning", "✓");
    return theme.fg("success", "✓");
}
function compactCurrentActivity(progress) {
    const snapshotNow = snapshotNowForProgress(progress);
    return (formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ??
        buildLiveStatusLine(progress, snapshotNow) ??
        "thinking…");
}
export function widgetRenderKey(job) {
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
        chainStepCount: job.chainStepCount,
        parallelGroups: job.parallelGroups,
        steps: job.steps,
        nestedChildren: job.nestedChildren,
        stepsTotal: job.stepsTotal,
        runningSteps: job.runningSteps,
        completedSteps: job.completedSteps,
        activeParallelGroup: job.activeParallelGroup,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        totalTokens: job.totalTokens,
        tkTicket: job.tkTicket,
    });
}
function formatWidgetAgents(agents) {
    const distinct = [...new Set(agents)];
    if (distinct.length === 1 && agents.length > 1)
        return `${distinct[0]} ×${agents.length}`;
    if (agents.length > 3)
        return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
    return agents.join(", ");
}
function widgetJobName(job) {
    if (job.mode === "parallel")
        return "parallel";
    if (job.mode === "chain")
        return "chain";
    if (job.mode === "single" && job.agents?.length === 1)
        return job.agents[0];
    if (job.agents?.length)
        return formatWidgetAgents(job.agents);
    return job.mode ?? "subagent";
}
function isProtectedWidgetLifecycle(state, interruptRequestedAt) {
    return (state === "paused" ||
        isProtectedPausedLifecycle({ state: state === "running" && interruptRequestedAt !== undefined ? "pausing" : state }));
}
function widgetActivity(job) {
    const privacySafe = isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt);
    if (job.interruptRequestedAt !== undefined && job.status === "running") {
        const facts = [];
        if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined)
            facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
        else if (job.currentTool)
            facts.push(job.currentTool);
        return facts.length > 0 ? `pausing… · ${facts.join(" · ")}` : "pausing…";
    }
    const facts = [];
    if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined)
        facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
    else if (job.currentTool)
        facts.push(job.currentTool);
    if (!privacySafe && job.currentPath)
        facts.push(shortenPath(job.currentPath));
    if (job.turnCount !== undefined)
        facts.push(`${job.turnCount} turns`);
    if (job.toolCount !== undefined)
        facts.push(`${job.toolCount} tools`);
    const activity = buildLiveStatusLine(job, job.updatedAt);
    if (activity && facts.length)
        return `${activity} · ${facts.join(" · ")}`;
    if (activity)
        return activity;
    if (facts.length)
        return facts.join(" · ");
    if (job.status === "running")
        return "thinking…";
    if (job.status === "queued")
        return "queued…";
    if (job.status === "paused")
        return "Paused";
    if (job.status === "failed")
        return "Failed";
    return "Done";
}
function widgetStepRunningSeed(step, fallbackIndex) {
    return runningSeed(fallbackIndex, step.index, step.toolCount, step.turnCount, step.tokens?.total, step.lastActivityAt, step.currentToolStartedAt, step.durationMs);
}
function widgetStepsRunningSeed(steps) {
    let seed;
    for (const [index, step] of (steps ?? []).entries())
        seed = runningSeed(seed, widgetStepRunningSeed(step, index));
    return seed;
}
function widgetJobRunningSeed(job) {
    return runningSeed(job.updatedAt, job.lastActivityAt, job.toolCount, job.turnCount, job.totalTokens?.total, job.currentStep, job.runningSteps, job.completedSteps, widgetStepsRunningSeed(job.steps));
}
function widgetJobsRunningSeed(jobs) {
    let seed;
    for (const job of jobs)
        seed = runningSeed(seed, widgetJobRunningSeed(job));
    return seed;
}
function widgetStatusGlyph(job, theme) {
    if (job.status === "running")
        return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
    if (job.status === "queued")
        return theme.fg("muted", "◦");
    if (job.status === "complete")
        return theme.fg("success", "✓");
    if (job.status === "paused")
        return theme.fg("warning", "■");
    return theme.fg("error", "✗");
}
function widgetStepGlyph(status, theme, seed) {
    if (status === "running")
        return theme.fg("accent", runningGlyph(seed));
    if (status === "complete" || status === "completed")
        return theme.fg("success", "✓");
    if (status === "failed")
        return theme.fg("error", "✗");
    if (status === "paused")
        return theme.fg("warning", "■");
    return theme.fg("muted", "◦");
}
function widgetStepStatus(status, theme, interruptRequestedAt) {
    if (status === "running" && interruptRequestedAt !== undefined)
        return theme.fg("accent", "pausing");
    if (status === "running")
        return theme.fg("accent", "running");
    if (status === "complete" || status === "completed")
        return theme.fg("success", "complete");
    if (status === "failed")
        return theme.fg("error", "failed");
    if (status === "paused")
        return theme.fg("warning", "paused");
    return theme.fg("dim", status);
}
const TK_TICKET_WIDGET_PREFIX = "working on tk: ";
function widgetTkTicketText(job, maxWidth = 72) {
    if (!job.tkTicket || (job.status !== "running" && job.status !== "queued"))
        return undefined;
    const titleWidth = Math.max(1, maxWidth - visibleWidth(TK_TICKET_WIDGET_PREFIX));
    const normalizedTkTicket = normalizeTkTicketMetadata(job.tkTicket, titleWidth);
    return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}
function widgetTkTicketLine(job, theme) {
    const ticket = widgetTkTicketText(job);
    return ticket ? `  ${theme.fg("dim", ticket)}` : undefined;
}
function widgetTkTicketLines(job, theme) {
    const line = widgetTkTicketLine(job, theme);
    return line ? [line] : [];
}
function foregroundTkTicketText(result, maxWidth = 72) {
    const titleWidth = Math.max(1, maxWidth - visibleWidth("  ") - visibleWidth(TK_TICKET_WIDGET_PREFIX));
    const normalizedTkTicket = normalizeTkTicketMetadata(result.tkTicket, titleWidth);
    return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}
function foregroundTkTicketLine(result, theme, active, maxWidth) {
    if (!active)
        return undefined;
    const ticket = foregroundTkTicketText(result, maxWidth);
    return ticket ? `  ${theme.fg("dim", ticket)}` : undefined;
}
function widgetStepActivity(step, snapshotNow) {
    const privacySafe = isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt);
    if (step.interruptRequestedAt !== undefined && step.status === "running")
        return "pausing…";
    const facts = [];
    if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined)
        facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
    else if (step.currentTool)
        facts.push(step.currentTool);
    if (!privacySafe && step.currentPath)
        facts.push(shortenPath(step.currentPath));
    if (step.turnCount !== undefined)
        facts.push(`${step.turnCount} turns`);
    if (step.toolCount !== undefined)
        facts.push(`${step.toolCount} tools`);
    if (step.tokens?.total)
        facts.push(formatTokenStat(step.tokens.total));
    const activity = buildLiveStatusLine(step, snapshotNow);
    if (activity && facts.length)
        return `${activity} · ${facts.join(" · ")}`;
    if (activity)
        return activity;
    return facts.join(" · ");
}
function widgetChainDetails(job, theme, expanded = false, width = getTermWidth()) {
    if (!job.steps?.length)
        return [];
    const total = job.chainStepCount ?? job.steps.length;
    const lines = [];
    for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
        const steps = job.steps.slice(span.start, span.start + span.count);
        if (span.isParallel) {
            const status = aggregateStepStatus(steps);
            lines.push(`  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`);
            continue;
        }
        const step = steps[0];
        if (!step) {
            lines.push(`  ${theme.fg("dim", `◦ Step ${span.stepIndex + 1}/${total}: pending`)}`);
            continue;
        }
        lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width));
    }
    return lines;
}
function widgetParallelAgentDetails(job, theme, expanded = false, width = getTermWidth()) {
    if (!job.steps?.length)
        return [];
    if (job.mode !== "parallel" && job.mode !== "chain")
        return [];
    if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length)
        return widgetChainDetails(job, theme, expanded, width);
    const total = job.stepsTotal ?? job.steps.length;
    const lines = [];
    for (const [index, step] of job.steps.entries()) {
        const marker = index === job.steps.length - 1 ? "└" : "├";
        const activity = widgetStepActivity(step, job.updatedAt);
        const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
        const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
        lines.push(`  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${step.agent} · ${widgetStepStatus(step.status, theme)}${modelDisplay}${activity ? ` · ${activity}` : ""}`)}`);
        for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 8 : 1, isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt)))
            lines.push(`    ${nestedLine}`);
    }
    return lines;
}
function parseParallelGroupAgentCount(label) {
    if (!label || !label.startsWith("[") || !label.endsWith("]"))
        return undefined;
    const inner = label.slice(1, -1).trim();
    if (!inner)
        return 0;
    return inner
        .split("+")
        .map((part) => part.trim())
        .filter(Boolean).length;
}
function buildChainStepSpans(details) {
    if (details.workflowGraph?.nodes?.length) {
        const spans = [];
        let flatCursor = 0;
        for (const node of details.workflowGraph.nodes) {
            if (node.stepIndex === undefined)
                continue;
            if (node.kind === "parallel-group") {
                const childFlatIndexes = (node.children ?? [])
                    .map((child) => child.flatIndex)
                    .filter((value) => typeof value === "number");
                const start = childFlatIndexes.length ? Math.min(...childFlatIndexes) : flatCursor;
                const count = node.children?.length ?? 0;
                spans.push({
                    stepIndex: node.stepIndex,
                    start,
                    count,
                    isParallel: true,
                    status: node.status,
                    label: node.label,
                    error: node.error,
                });
                flatCursor = Math.max(flatCursor, start + count);
                continue;
            }
            const start = node.flatIndex ?? flatCursor;
            spans.push({
                stepIndex: node.stepIndex,
                start,
                count: 1,
                isParallel: false,
                status: node.status,
                label: node.label,
                error: node.error,
            });
            flatCursor = Math.max(flatCursor, start + 1);
        }
        if (spans.length)
            return spans.sort((left, right) => left.stepIndex - right.stepIndex);
    }
    if (!details.chainAgents?.length)
        return [];
    const spans = [];
    let start = 0;
    for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
        const label = details.chainAgents[stepIndex];
        const parsedCount = parseParallelGroupAgentCount(label);
        const count = parsedCount ?? 1;
        spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
        start += count;
    }
    return spans;
}
function isChainParallelGroupActive(details) {
    if (details.mode !== "chain")
        return false;
    if (details.currentStepIndex === undefined)
        return false;
    return buildChainStepSpans(details).some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
}
function buildAsyncChainStepSpans(total, stepCount, parallelGroups = []) {
    const spans = [];
    let flatIndex = 0;
    for (let stepIndex = 0; stepIndex < total; stepIndex++) {
        const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
        if (group) {
            spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
            flatIndex = Math.max(flatIndex, group.start + group.count);
            continue;
        }
        spans.push({ stepIndex, start: flatIndex, count: flatIndex < stepCount ? 1 : 0, isParallel: false });
        flatIndex++;
    }
    return spans;
}
function isDoneResult(result) {
    const status = result.progress?.status;
    if (status === "completed")
        return true;
    if (status === "running" || status === "pending")
        return false;
    if (result.interrupted || result.detached)
        return false;
    return result.exitCode === 0;
}
function workflowGraphHasStatus(details, statuses) {
    return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}
function buildChainRenderEntries(details, label) {
    if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly)
        return undefined;
    const entries = [];
    for (const span of buildChainStepSpans(details)) {
        if (span.isParallel && span.count === 0) {
            entries.push({
                kind: "placeholder",
                rowNumber: span.stepIndex + 1,
                stepLabel: `Step ${span.stepIndex + 1}`,
                agentName: span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
                status: span.status ?? "pending",
                error: span.error,
            });
            continue;
        }
        for (let index = span.start; index < span.start + span.count; index++) {
            entries.push({
                kind: "result",
                resultIndex: index,
                rowNumber: index + 1,
                agentName: details.results[index]?.agent ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
            });
        }
    }
    return entries;
}
function buildMultiProgressLabel(details, hasRunning) {
    const stepSpans = buildChainStepSpans(details);
    const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
    const activeParallelGroup = isChainParallelGroupActive(details);
    const itemTitle = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";
    if (details.mode === "parallel") {
        const totalCount = details.totalSteps ?? details.results.length;
        const statuses = new Array(totalCount).fill("pending");
        for (const progress of details.progress ?? []) {
            if (progress.index >= 0 && progress.index < totalCount)
                statuses[progress.index] = progress.status;
        }
        for (let i = 0; i < details.results.length; i++) {
            const result = details.results[i];
            const progressFromArray = details.progress?.find((progress) => progress.index === i) ||
                details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
            const index = result.progress?.index ?? progressFromArray?.index ?? i;
            if (index < 0 || index >= totalCount)
                continue;
            const status = result.progress?.status ??
                (result.interrupted || result.detached ? "detached" : result.exitCode === 0 ? "completed" : "failed");
            statuses[index] = status;
        }
        const running = statuses.filter((status) => status === "running").length;
        const done = statuses.filter((status) => status === "completed").length;
        const headerLabel = hasRunning
            ? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
            : `${done}/${totalCount} done`;
        return {
            headerLabel,
            itemTitle,
            totalCount,
            hasParallelInChain,
            activeParallelGroup,
            groupStartIndex: 0,
            groupEndIndex: totalCount,
            showActiveGroupOnly: false,
        };
    }
    if (activeParallelGroup) {
        const currentStepIndex = details.currentStepIndex;
        const span = stepSpans[currentStepIndex];
        const groupSize = span?.count ?? 1;
        const groupStart = span?.start ?? 0;
        const groupEnd = groupStart + groupSize;
        let running = 0;
        let done = 0;
        for (let index = groupStart; index < groupEnd; index++) {
            const progressEntry = details.progress?.find((progress) => progress.index === index);
            const resultEntry = details.results.find((result) => result.progress?.index === index);
            if (progressEntry?.status === "running") {
                running++;
                continue;
            }
            if (progressEntry?.status === "completed") {
                done++;
                continue;
            }
            if (resultEntry && isDoneResult(resultEntry))
                done++;
        }
        const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
        const headerLabel = hasRunning
            ? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
            : `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
        return {
            headerLabel,
            itemTitle,
            totalCount: groupSize,
            hasParallelInChain,
            activeParallelGroup,
            groupStartIndex: groupStart,
            groupEndIndex: groupEnd,
            showActiveGroupOnly: true,
        };
    }
    if (details.mode === "chain" && details.chainAgents?.length) {
        const totalCount = details.totalSteps ?? details.chainAgents.length;
        const doneLogical = stepSpans.filter((span) => {
            if (span.status && span.status !== "completed")
                return false;
            if (span.count === 0)
                return span.status === "completed";
            for (let index = span.start; index < span.start + span.count; index++) {
                const progressEntry = details.progress?.find((progress) => progress.index === index);
                const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
                if (progressEntry?.status === "running" ||
                    progressEntry?.status === "pending" ||
                    progressEntry?.status === "failed")
                    return false;
                if (!resultEntry || !isDoneResult(resultEntry))
                    return false;
            }
            return true;
        }).length;
        const currentStep = details.currentStepIndex !== undefined
            ? details.currentStepIndex + 1
            : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
        const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
        return {
            headerLabel,
            itemTitle,
            totalCount,
            hasParallelInChain,
            activeParallelGroup,
            groupStartIndex: 0,
            groupEndIndex: details.results.length,
            showActiveGroupOnly: false,
        };
    }
    const totalCount = details.totalSteps ?? details.results.length;
    const currentStep = details.currentStepIndex !== undefined
        ? details.currentStepIndex + 1
        : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
    const done = details.results.filter(isDoneResult).length;
    const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
    return {
        headerLabel,
        itemTitle,
        totalCount,
        hasParallelInChain,
        activeParallelGroup,
        groupStartIndex: 0,
        groupEndIndex: details.results.length,
        showActiveGroupOnly: false,
    };
}
function resultRowLabel(details, label, resultIndex, stepNumber) {
    if (details.mode === "chain" && label.hasParallelInChain) {
        const span = buildChainStepSpans(details).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
        if (span?.isParallel)
            return `Agent ${resultIndex - span.start + 1}/${span.count}`;
        if (span)
            return `Step ${span.stepIndex + 1}`;
    }
    if (label.itemTitle === "Agent") {
        const localStepNumber = label.activeParallelGroup ? Math.max(1, stepNumber - label.groupStartIndex) : stepNumber;
        return `Agent ${localStepNumber}/${label.totalCount}`;
    }
    return `Step ${stepNumber}`;
}
function widgetStats(job, theme, includeStepProgress = true) {
    const parts = [];
    const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
    if (includeStepProgress && job.activeParallelGroup) {
        const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
        const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
        if (job.mode === "parallel") {
            if (job.status === "running" && running > 0)
                parts.push(job.interruptRequestedAt !== undefined
                    ? `${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`
                    : formatAgentRunningLabel(running));
            if (stepsTotal > 0)
                parts.push(`${done}/${stepsTotal} done`);
        }
        else {
            const activeGroup = job.currentStep !== undefined
                ? job.parallelGroups?.find((group) => job.currentStep >= group.start && job.currentStep < group.start + group.count)
                : job.parallelGroups?.find((group) => group.start === 0);
            const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
            const total = job.chainStepCount ?? stepsTotal;
            const groupParts = [`${done}/${stepsTotal} done`];
            if (job.status === "running" && running > 0)
                groupParts.unshift(formatAgentRunningLabel(running));
            parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
        }
    }
    else if (includeStepProgress && job.mode === "parallel") {
        const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
        const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
        if (job.status === "running" && running > 0)
            parts.push(job.interruptRequestedAt !== undefined
                ? `${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`
                : formatAgentRunningLabel(running));
        if (stepsTotal > 0)
            parts.push(`${done}/${stepsTotal} done`);
    }
    else if (includeStepProgress && job.currentStep !== undefined) {
        if (job.mode === "chain" && job.parallelGroups?.length) {
            const total = job.chainStepCount ?? stepsTotal;
            parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
        }
        else {
            parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
        }
    }
    else if (includeStepProgress && stepsTotal > 1) {
        parts.push(`steps ${stepsTotal}`);
    }
    if (job.toolCount !== undefined)
        parts.push(formatToolUseStat(job.toolCount));
    if (job.totalTokens?.total)
        parts.push(formatTokenStat(job.totalTokens.total));
    if (job.startedAt !== undefined && job.updatedAt !== undefined)
        parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
    return statJoin(theme, parts);
}
function widgetSummaryStats(job, theme) {
    return widgetStats(job, theme, job.mode !== "single");
}
function widgetStepStats(theme, step, durationFallbackMs) {
    const durationMs = step.durationMs ?? durationFallbackMs;
    return statJoin(theme, [
        step.turnCount !== undefined ? `${step.turnCount} turns` : "",
        step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
        step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
        durationMs !== undefined ? formatDuration(durationMs) : "",
    ]);
}
function modelThinkingBadge(theme, model, thinking) {
    const label = formatModelThinking(model, thinking);
    return label ? theme.fg("dim", ` (${label})`) : "";
}
function widgetStepActivityLine(step, width, expanded, snapshotNow) {
    const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
    if (toolLine)
        return toolLine;
    const activity = buildLiveStatusLine(step, snapshotNow);
    if (activity)
        return activity;
    if (step.status === "running")
        return "thinking…";
    return "";
}
function widgetOutputPath(job, step) {
    if (typeof step.index !== "number")
        return undefined;
    return path.join(job.asyncDir, `output-${step.index}.log`);
}
function nestedRunName(run) {
    if (run.agent)
        return run.agent;
    if (run.agents?.length)
        return formatWidgetAgents(run.agents);
    return run.id;
}
function nestedStatusGlyph(state, theme, seed) {
    if (state === "running")
        return theme.fg("accent", runningGlyph(seed));
    if (state === "complete" || state === "completed")
        return theme.fg("success", "✓");
    if (state === "failed")
        return theme.fg("error", "✗");
    if (state === "paused")
        return theme.fg("warning", "■");
    return theme.fg("muted", "◦");
}
function nestedRunSeed(run) {
    return runningSeed(run.lastUpdate, run.lastActivityAt, run.currentStep, run.toolCount, run.turnCount, run.totalTokens?.total, run.currentToolStartedAt);
}
function nestedActivity(input, state, snapshotNow, privacySafe = false) {
    const facts = [];
    if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined)
        facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
    else if (input.currentTool)
        facts.push(input.currentTool);
    if (!privacySafe && input.currentPath)
        facts.push(shortenPath(input.currentPath));
    if (input.turnCount !== undefined)
        facts.push(`${input.turnCount} turns`);
    if (input.toolCount !== undefined)
        facts.push(`${input.toolCount} tools`);
    const activity = buildLiveStatusLine(input, snapshotNow);
    if (activity && facts.length)
        return `${activity} · ${facts.join(" · ")}`;
    if (activity)
        return activity;
    if (facts.length)
        return facts.join(" · ");
    if (state === "running")
        return "thinking…";
    if (state === "queued" || state === "pending")
        return "queued…";
    if (state === "paused")
        return "Paused";
    if (state === "failed")
        return "Failed";
    return "Done";
}
function formatNestedWidgetLines(children, theme, width, expanded, snapshotNow, lineBudget = expanded ? 12 : 1, privacySafe = false) {
    if (!children?.length || lineBudget <= 0)
        return [];
    if (!expanded) {
        const aggregate = formatNestedAggregate(children);
        return aggregate ? [theme.fg("dim", `↳ ${aggregate}`)] : [];
    }
    const lines = [];
    const maxDepth = 2;
    const append = (items, depth, prefix) => {
        if (!items?.length || lines.length >= lineBudget)
            return;
        if (depth > maxDepth) {
            const aggregate = formatNestedAggregate(items);
            if (aggregate && lines.length < lineBudget)
                lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
            return;
        }
        for (let index = 0; index < items.length; index++) {
            const child = items[index];
            if (lines.length >= lineBudget) {
                const aggregate = formatNestedAggregate(items.slice(index));
                if (aggregate)
                    lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
                return;
            }
            const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate, privacySafe);
            const error = child.error ? ` · ${privacySafe ? "lifecycle status requires attention" : child.error}` : "";
            lines.push(theme.fg("dim", `${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state} · ${activity}${error}`));
            if (depth === maxDepth) {
                const aggregate = formatNestedAggregate([
                    ...(child.steps?.flatMap((step) => step.children ?? []) ?? []),
                    ...(child.children ?? []),
                ]);
                if (aggregate && lines.length < lineBudget)
                    lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
                continue;
            }
            for (const step of child.steps ?? []) {
                if (lines.length >= lineBudget)
                    return;
                lines.push(theme.fg("dim", `${prefix}  ↳ ${nestedStatusGlyph(step.status, theme)} ${step.agent} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate, privacySafe)}`));
                append(step.children, depth + 1, `${prefix}    `);
            }
            append(child.children, depth + 1, `${prefix}  `);
        }
    };
    append(children, 0, "");
    return lines.map((line) => truncLine(line, width));
}
function singleWidgetStepDisplayStatus(job, step) {
    if (step.status !== "running")
        return step.status;
    if (job.status === "complete" || job.status === "failed")
        return job.status;
    return step.status;
}
function foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index, total, expanded, width, displayStatus = step.status) {
    const status = widgetStepStatus(displayStatus, theme, displayStatus === "running" ? step.interruptRequestedAt : undefined);
    const durationFallbackMs = itemTitle === undefined &&
        step.status === "running" &&
        step.durationMs === undefined &&
        job.startedAt !== undefined &&
        job.updatedAt !== undefined
        ? Math.max(0, job.updatedAt - job.startedAt)
        : undefined;
    const stats = widgetStepStats(theme, step, durationFallbackMs);
    const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
    const itemLabel = itemTitle ? `${itemTitle} ${index}/${total}: ` : "";
    const lines = [
        `  ${widgetStepGlyph(displayStatus, theme, widgetStepRunningSeed(step, index - 1))} ${itemLabel}${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
    ];
    const activity = displayStatus === step.status ? widgetStepActivityLine(step, width, expanded, job.updatedAt) : "";
    if (activity)
        lines.push(`    ${theme.fg("dim", `⎿  ${activity}`)}`);
    for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt, expanded ? 12 : 1, isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt))) {
        lines.push(`    ${nestedLine}`);
    }
    if (displayStatus === "running") {
        if (!expanded)
            lines.push(`    ${theme.fg("accent", liveDetailHintText())}`);
        if (expanded) {
            const output = widgetOutputPath(job, step);
            if (output)
                lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
            const liveStatus = buildLiveStatusLine(step, job.updatedAt);
            if (liveStatus && liveStatus !== activity)
                lines.push(`    ${theme.fg("accent", liveStatus)}`);
            for (const tool of step.recentTools?.slice(-3) ?? []) {
                const maxArgsLen = Math.max(40, width - 30);
                const argsPreview = tool.args.length <= maxArgsLen ? tool.args : `${tool.args.slice(0, maxArgsLen)}...`;
                lines.push(`      ${theme.fg("dim", `${tool.tool}${argsPreview ? `: ${argsPreview}` : ""}`)}`);
            }
            for (const line of step.recentOutput?.slice(-5) ?? []) {
                lines.push(`      ${theme.fg("dim", line)}`);
            }
        }
    }
    return lines;
}
function foregroundStyleWidgetDetails(job, theme, expanded, width) {
    if (!job.steps?.length)
        return [
            ...widgetTkTicketLines(job, theme),
            `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
            ...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt, expanded ? 12 : 1, isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt)).map((line) => `  ${line}`),
        ];
    if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) {
        return [...widgetTkTicketLines(job, theme), ...widgetChainDetails(job, theme, expanded, width)];
    }
    const total = job.stepsTotal ?? job.steps.length;
    const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
    const lines = [...widgetTkTicketLines(job, theme)];
    for (const [index, step] of job.steps.entries()) {
        lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width));
    }
    const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
    const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
    for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt, expanded ? 12 : 1, isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt))) {
        lines.push(`  ${nestedLine}`);
    }
    return lines;
}
function singleWidgetAgentDetails(job, theme, expanded, width) {
    const step = job.steps?.[0];
    if (step) {
        const lines = [
            ...widgetTkTicketLines(job, theme),
            ...foregroundStyleWidgetStepLines(job, theme, step, undefined, 1, 1, expanded, width, singleWidgetStepDisplayStatus(job, step)),
        ];
        const attached = new Set(step.children?.map((child) => child.id) ?? []);
        const unattached = job.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
        for (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt, expanded ? 12 : 1, isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt))) {
            lines.push(`  ${nestedLine}`);
        }
        return lines;
    }
    const agent = job.agents?.[0] ?? widgetJobName(job);
    const stats = widgetSummaryStats(job, theme);
    return [
        `${widgetStatusGlyph(job, theme)} ${themeBold(theme, agent)} ${theme.fg("dim", "·")} ${theme.fg("dim", job.status)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
        ...widgetTkTicketLines(job, theme),
        `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
        ...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt, expanded ? 12 : 1, isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt)).map((line) => `  ${line}`),
    ];
}
function parallelWidgetAggregateStats(job, theme) {
    const stats = widgetSummaryStats(job, theme);
    if (stats)
        return stats;
    return job.status === "complete" ? "done" : job.status;
}
function buildSingleWidgetLines(job, theme, width, expanded) {
    if (job.mode === "single") {
        return [
            `${theme.fg("toolTitle", themeBold(theme, "async subagent"))} ${theme.fg("dim", "· background")}`,
            ...singleWidgetAgentDetails(job, theme, expanded, width),
        ].map((line) => truncLine(line, width));
    }
    if (job.mode === "parallel") {
        const count = job.stepsTotal ?? job.agents?.length ?? job.steps?.length ?? 0;
        const stats = parallelWidgetAggregateStats(job, theme);
        return [
            `${theme.fg("toolTitle", themeBold(theme, `async subagents (${count})`))} ${theme.fg("dim", "· background")}`,
            `${widgetStatusGlyph(job, theme)}${stats ? ` ${stats}` : ""}`,
            ...foregroundStyleWidgetDetails(job, theme, expanded, width),
        ].map((line) => truncLine(line, width));
    }
    const stats = widgetSummaryStats(job, theme);
    const count = job.mode === "chain" ? job.chainStepCount : (job.stepsTotal ?? job.agents?.length ?? job.steps?.length);
    const mode = widgetJobName(job);
    const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
    return [
        `${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`,
        `${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
        ...foregroundStyleWidgetDetails(job, theme, expanded, width),
    ].map((line) => truncLine(line, width));
}
function compactSingleWidgetLines(job, theme, width) {
    const fullLines = buildSingleWidgetLines(job, theme, width, false);
    if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup))
        return fullLines;
    const total = job.stepsTotal ?? job.steps.length;
    const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
    const lines = [...fullLines.slice(0, 2), ...widgetTkTicketLines(job, theme)];
    for (const [index, step] of job.steps.entries()) {
        const status = widgetStepStatus(step.status, theme, step.interruptRequestedAt);
        const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
        const stepStats = widgetStepStats(theme, step);
        const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
        const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
        lines.push(`  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)} ${theme.fg("dim", "·")} ${status}${modelDisplay}${activitySuffix}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`);
        for (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt, 1, isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt)))
            lines.push(`    ${nestedLine}`);
    }
    if (job.steps.some((step) => step.status === "running"))
        lines.push(theme.fg("accent", `  ${liveDetailHintText()}`));
    return lines.map((line) => truncLine(line, width));
}
const RESERVED_NON_WIDGET_ROWS = 19;
let widgetLayoutSession;
function resetWidgetLayoutSession() {
    widgetLayoutSession = undefined;
}
function estimateAvailableWidgetRows() {
    const rows = process.stdout.rows || 30;
    return Math.max(1, rows - RESERVED_NON_WIDGET_ROWS);
}
function currentTerminalRows() {
    return process.stdout.rows || 30;
}
function currentTerminalColumns() {
    return process.stdout.columns || 120;
}
function widgetSessionMatches(expanded) {
    return (widgetLayoutSession?.expanded === expanded &&
        widgetLayoutSession.rows === currentTerminalRows() &&
        widgetLayoutSession.columns === currentTerminalColumns());
}
function widgetHeaderCounts(jobs) {
    return {
        running: jobs.filter((job) => job.status === "running"),
        queued: jobs.filter((job) => job.status === "queued"),
        complete: jobs.filter((job) => job.status === "complete"),
        failed: jobs.filter((job) => job.status === "failed"),
        paused: jobs.filter((job) => job.status === "paused"),
    };
}
function buildSingleLineWidgetLines(jobs, theme, width) {
    const counts = widgetHeaderCounts(jobs);
    const hasActive = counts.running.length > 0 || counts.queued.length > 0;
    const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
    const parts = [];
    if (counts.running.length > 0)
        parts.push(`${counts.running.length}/${jobs.length} running`);
    if (counts.queued.length > 0)
        parts.push(`${counts.queued.length} queued`);
    if (counts.failed.length > 0)
        parts.push(`${counts.failed.length} failed`);
    if (counts.paused.length > 0)
        parts.push(`${counts.paused.length} paused`);
    if (!hasActive && counts.complete.length > 0)
        parts.push(`${counts.complete.length}/${jobs.length} done`);
    return [
        truncLine(`${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "subagents")} (${parts.join(", ") || `${jobs.length} total`})`, width),
    ];
}
function orderedWidgetJobs(jobs) {
    return [
        ...jobs.filter((job) => job.status === "running"),
        ...jobs.filter((job) => job.status === "queued"),
        ...jobs.filter((job) => job.status !== "running" && job.status !== "queued"),
    ];
}
function progressiveJobKey(job) {
    return job.asyncId;
}
function isProgressiveActiveJob(job) {
    return job?.status === "running" || job?.status === "queued";
}
function selectProgressiveJobKeys(jobs, previousKeys, bodyRows) {
    if (bodyRows <= 0)
        return [];
    const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
    const selected = [];
    const append = (key) => {
        if (selected.includes(key) || !jobsByKey.has(key))
            return;
        selected.push(key);
    };
    for (const key of previousKeys) {
        if (!isProgressiveActiveJob(jobsByKey.get(key)))
            continue;
        append(key);
        if (selected.length >= bodyRows)
            return selected;
    }
    for (const job of orderedWidgetJobs(jobs)) {
        if (!isProgressiveActiveJob(job))
            continue;
        const key = progressiveJobKey(job);
        append(key);
        if (selected.length >= bodyRows)
            break;
    }
    if (selected.length >= bodyRows)
        return selected;
    for (const key of previousKeys) {
        if (isProgressiveActiveJob(jobsByKey.get(key)))
            continue;
        append(key);
        if (selected.length >= bodyRows)
            return selected;
    }
    for (const job of orderedWidgetJobs(jobs)) {
        const key = progressiveJobKey(job);
        append(key);
        if (selected.length >= bodyRows)
            break;
    }
    return selected;
}
function progressiveHeaderLine(jobs, theme, width) {
    const counts = widgetHeaderCounts(jobs);
    const hasActive = counts.running.length > 0 || counts.queued.length > 0;
    const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
    const parts = [];
    if (counts.running.length > 0)
        parts.push(formatAgentRunningLabel(counts.running.length));
    if (counts.queued.length > 0)
        parts.push(`${counts.queued.length} queued`);
    if (!hasActive) {
        if (counts.failed.length > 0)
            parts.push(`${counts.failed.length} failed`);
        if (counts.paused.length > 0)
            parts.push(`${counts.paused.length} paused`);
        if (counts.complete.length > 0)
            parts.push(`${counts.complete.length}/${jobs.length} done`);
    }
    return truncLine(`${theme.fg(hasActive ? "accent" : "dim", glyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(", ") || `${jobs.length} total`)}`, width);
}
function progressiveJobLine(job, theme, width) {
    const stats = widgetSummaryStats(job, theme);
    const activity = widgetActivity(job);
    const status = job.status === "complete" ? "done" : job.status;
    const ticket = widgetTkTicketText(job, Math.max(24, width - 32));
    const parts = [
        themeBold(theme, widgetJobName(job)),
        theme.fg("dim", status),
        stats,
        ticket ? theme.fg("dim", ticket) : "",
        activity && activity.toLowerCase() !== status ? theme.fg("dim", activity) : "",
    ].filter(Boolean);
    return truncLine(`  ${widgetStatusGlyph(job, theme)} ${parts.join(` ${theme.fg("dim", "·")} `)}`, width);
}
function progressiveHiddenLine(hiddenJobs, theme, width) {
    const counts = widgetHeaderCounts(hiddenJobs);
    const parts = [];
    if (counts.running.length > 0)
        parts.push(`${counts.running.length} running`);
    if (counts.queued.length > 0)
        parts.push(`${counts.queued.length} queued`);
    const finished = counts.complete.length + counts.failed.length + counts.paused.length;
    if (finished > 0)
        parts.push(`${finished} finished`);
    return truncLine(theme.fg("dim", `  +${hiddenJobs.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`), width);
}
function buildProgressiveWidgetLines(jobs, theme, width, lockedRows, previousKeys) {
    const rowCount = Math.max(1, lockedRows);
    if (rowCount === 1)
        return { lines: buildSingleLineWidgetLines(jobs, theme, width), visibleJobKeys: [] };
    const bodyRows = rowCount - 1;
    let visibleJobKeys = selectProgressiveJobKeys(jobs, previousKeys, bodyRows);
    const jobsByKey = new Map(jobs.map((job) => [progressiveJobKey(job), job]));
    let visibleJobs = visibleJobKeys.map((key) => jobsByKey.get(key)).filter((job) => Boolean(job));
    let hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
    const needsHiddenLine = hiddenJobs.length > 0;
    if (needsHiddenLine && visibleJobs.length >= bodyRows && bodyRows > 0) {
        visibleJobs = visibleJobs.slice(0, bodyRows - 1);
        visibleJobKeys = visibleJobs.map(progressiveJobKey);
        hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
    }
    const lines = [
        progressiveHeaderLine(jobs, theme, width),
        ...visibleJobs.map((job) => progressiveJobLine(job, theme, width)),
    ];
    if (hiddenJobs.length > 0 && lines.length < rowCount)
        lines.push(progressiveHiddenLine(hiddenJobs, theme, width));
    while (lines.length < rowCount)
        lines.push("\u200c");
    return { lines: lines.slice(0, rowCount), visibleJobKeys };
}
function collapsedWidgetLineBudget(rows) {
    return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}
function fitWidgetLineBudget(lines, theme, width, expanded) {
    const rows = process.stdout.rows || 30;
    const budget = expanded ? Math.max(12, Math.min(24, Math.floor(rows * 0.55))) : collapsedWidgetLineBudget(rows);
    if (lines.length <= budget)
        return lines;
    const visibleLines = Math.max(1, budget - 1);
    const hiddenCount = lines.length - visibleLines;
    const hint = expanded
        ? `… ${hiddenCount} live-detail lines hidden`
        : `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`;
    return [...lines.slice(0, visibleLines), truncLine(theme.fg("dim", hint), width)];
}
function fitAdaptiveWidgetLines(jobs, lines, theme, width, expanded) {
    if (expanded) {
        resetWidgetLayoutSession();
        return fitWidgetLineBudget(lines, theme, width, true);
    }
    const hasMatchingSession = widgetSessionMatches(expanded);
    const rows = currentTerminalRows();
    const columns = currentTerminalColumns();
    const availableRows = estimateAvailableWidgetRows();
    if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
        return buildSingleLineWidgetLines(jobs, theme, width);
    }
    if (hasMatchingSession &&
        widgetLayoutSession?.tier === "progressive" &&
        widgetLayoutSession.lockedRows !== undefined) {
        const rendered = buildProgressiveWidgetLines(jobs, theme, width, widgetLayoutSession.lockedRows, widgetLayoutSession.visibleJobKeys);
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
function liveDetailExpanded(controller) {
    return controller?.isExpanded() ?? false;
}
function buildWidgetComponent(jobs, controller) {
    return (_tui, theme) => {
        const width = getTermWidth();
        const expanded = liveDetailExpanded(controller);
        const lines = expanded
            ? buildWidgetLines(jobs, theme, width, true)
            : jobs.length === 1
                ? compactSingleWidgetLines(jobs[0], theme, width)
                : buildWidgetLines(jobs, theme, width, false);
        const container = new Container();
        for (const line of fitAdaptiveWidgetLines(jobs, lines, theme, width, expanded))
            container.addChild(new Text(line, 1, 0));
        return container;
    };
}
export function buildWidgetLines(jobs, theme, width = getTermWidth(), expanded = false) {
    if (jobs.length === 0)
        return [];
    if (jobs.length === 1)
        return buildSingleWidgetLines(jobs[0], theme, width, expanded);
    const running = jobs.filter((job) => job.status === "running");
    const queued = jobs.filter((job) => job.status === "queued");
    const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");
    const lines = [];
    const hasActive = running.length > 0 || queued.length > 0;
    const headerGlyph = running.length > 0 ? runningGlyph(widgetJobsRunningSeed(running)) : hasActive ? "●" : "○";
    lines.push(truncLine(`${theme.fg(hasActive ? "accent" : "dim", headerGlyph)} ${theme.fg(hasActive ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`, width));
    const items = [];
    let hiddenRunning = 0;
    let hiddenFinished = 0;
    let queuedSummaryShown = false;
    let slots = MAX_WIDGET_JOBS;
    for (const job of running) {
        if (slots <= 0) {
            hiddenRunning++;
            continue;
        }
        const stats = widgetSummaryStats(job, theme);
        items.push([
            `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
            ...widgetTkTicketLines(job, theme),
            `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
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
        const stats = widgetSummaryStats(job, theme);
        items.push([
            `${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
            ...widgetTkTicketLines(job, theme),
            `  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`,
            ...widgetParallelAgentDetails(job, theme, expanded, width),
        ]);
        slots--;
    }
    const hiddenQueued = queued.length > 0 && !queuedSummaryShown ? queued.length : 0;
    const hiddenTotal = hiddenRunning + hiddenFinished + hiddenQueued;
    if (hiddenTotal > 0) {
        const parts = [];
        if (hiddenRunning > 0)
            parts.push(`${hiddenRunning} running`);
        if (hiddenQueued > 0)
            parts.push(`${hiddenQueued} queued`);
        if (hiddenFinished > 0)
            parts.push(`${hiddenFinished} finished`);
        items.push([theme.fg("dim", `+${hiddenTotal} more (${parts.join(", ")})`)]);
    }
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const last = i === items.length - 1;
        const branch = last ? "└─" : "├─";
        const continuation = last ? "   " : "│  ";
        lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
        for (const detail of item.slice(1)) {
            lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
        }
    }
    return lines;
}
export function renderWidget(ctx, jobs, controller) {
    if (jobs.length === 0) {
        resetWidgetLayoutSession();
        if (ctx.hasUI)
            ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
    }
    if (!ctx.hasUI)
        return;
    ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, controller));
}
function renderSingleCompact(d, r, theme, frame) {
    const output = r.truncation?.text || getSingleResultOutput(r);
    const progress = r.progress || r.progressSummary;
    const isRunning = r.progress?.status === "running";
    const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
    const stats = statJoin(theme, [r.usage?.turns ? `⟳ ${r.usage.turns}` : "", formatProgressStats(theme, progress)]);
    const c = new Container();
    const width = getTermWidth() - 4;
    const modelDisplay = modelThinkingBadge(theme, r.model);
    c.addChild(new Text(truncLine(`${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));
    const ticketLine = foregroundTkTicketLine(r, theme, isRunning, width);
    if (ticketLine)
        c.addChild(new Text(truncLine(ticketLine, width), 0, 0));
    if (isRunning && r.progress) {
        const progressSnapshotNow = snapshotNowForProgress(r.progress);
        const activity = compactCurrentActivity(r.progress);
        c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
        const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
        if (liveStatus && liveStatus !== activity)
            c.addChild(new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0));
        c.addChild(new Text(truncLine(theme.fg("accent", `  ${liveDetailHintText()}`), width), 0, 0));
        return c;
    }
    const preview = compactOutputPreview(output);
    c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, preview)}`), width), 0, 0));
    if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
        c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
    }
    if (r.sessionFile)
        c.addChild(new Text(truncLine(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
    return c;
}
function renderMultiCompact(d, theme, frame) {
    const hasRunning = d.progress?.some((p) => p.status === "running") ||
        d.results.some((r) => r.progress?.status === "running") ||
        workflowGraphHasStatus(d, ["running"]);
    const failed = d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running") ||
        workflowGraphHasStatus(d, ["failed"]);
    const paused = d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running") ||
        workflowGraphHasStatus(d, ["paused", "detached"]);
    let totalSummary = d.progressSummary;
    if (!totalSummary) {
        let sawProgress = false;
        const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
        for (const r of d.results) {
            const prog = r.progress || r.progressSummary;
            if (!prog)
                continue;
            sawProgress = true;
            summary.toolCount += prog.toolCount;
            summary.tokens += prog.tokens;
            summary.durationMs =
                d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
        }
        if (sawProgress)
            totalSummary = summary;
    }
    const multiLabel = buildMultiProgressLabel(d, hasRunning);
    const itemTitle = multiLabel.itemTitle;
    const stats = statJoin(theme, [
        multiLabel.headerLabel,
        formatProgressStats(theme, totalSummary),
        formatTotalCostStat(d.totalCost),
    ]);
    const glyph = hasRunning
        ? theme.fg("accent", runningGlyph(frame !== undefined
            ? (runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex) ?? 0) + frame
            : runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex)))
        : failed
            ? theme.fg("error", "✗")
            : paused
                ? theme.fg("warning", "■")
                : theme.fg("success", "✓");
    const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
    const c = new Container();
    const width = getTermWidth() - 4;
    c.addChild(new Text(truncLine(`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));
    const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
    const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
    const displayEnd = multiLabel.showActiveGroupOnly
        ? multiLabel.groupEndIndex
        : useResultsDirectly
            ? d.results.length
            : d.chainAgents.length;
    const chainEntries = buildChainRenderEntries(d, multiLabel);
    const renderEntries = chainEntries ??
        Array.from({ length: displayEnd - displayStart }, (_, offset) => {
            const i = displayStart + offset;
            const r = d.results[i];
            const fallbackLabel = itemTitle.toLowerCase();
            const rowNumber = multiLabel.showActiveGroupOnly ? i - multiLabel.groupStartIndex + 1 : i + 1;
            return {
                kind: "result",
                resultIndex: i,
                rowNumber,
                agentName: useResultsDirectly
                    ? r?.agent || `${fallbackLabel}-${rowNumber}`
                    : d.chainAgents[i] || r?.agent || `${fallbackLabel}-${rowNumber}`,
            };
        });
    for (const entry of renderEntries) {
        if (entry.kind === "placeholder") {
            const glyph = widgetStepGlyph(entry.status, theme);
            const statusLabel = widgetStepStatus(entry.status, theme);
            c.addChild(new Text(truncLine(`  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${statusLabel}`, width), 0, 0));
            if (entry.error)
                c.addChild(new Text(truncLine(theme.fg("error", `    ⎿  Error: ${entry.error}`), width), 0, 0));
            continue;
        }
        const i = entry.resultIndex;
        const r = d.results[i];
        const rowNumber = entry.rowNumber;
        const agentName = entry.agentName;
        if (!r) {
            const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
            c.addChild(new Text(truncLine(theme.fg("dim", `  ◦ ${pendingLabel}: ${agentName} · pending`), width), 0, 0));
            continue;
        }
        const output = getSingleResultOutput(r);
        const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
        const liveProgress = r.progress ?? progressFromArray;
        const summaryProgress = liveProgress ?? r.progressSummary;
        const rRunning = liveProgress?.status === "running";
        const rPending = liveProgress?.status === "pending";
        const stepNumber = liveProgress?.index !== undefined ? liveProgress.index + 1 : i + 1;
        const stepStats = formatProgressStats(theme, summaryProgress);
        const glyph = rPending
            ? theme.fg("dim", "◦")
            : resultGlyph(r, output, theme, rRunning, progressRunningSeed(summaryProgress), frame);
        const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
        const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
        const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
        c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
        const ticketLine = foregroundTkTicketLine(r, theme, rRunning, width);
        if (ticketLine)
            c.addChild(new Text(truncLine(ticketLine, width), 0, 0));
        if (rRunning && liveProgress) {
            const activity = compactCurrentActivity(liveProgress);
            c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
            c.addChild(new Text(truncLine(theme.fg("accent", `    ${liveDetailHintText()}`), width), 0, 0));
        }
        else if (!rPending &&
            (r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
            c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
        }
    }
    if (d.artifacts)
        c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
    return c;
}
export function renderSubagentResult(result, options, theme, frame) {
    const d = result.details;
    const hideAsyncPlaceholderBody = Boolean(d?.asyncId && !d.results.length && d.mode !== "management" && !result.isError);
    if (hideAsyncPlaceholderBody)
        return new Container();
    if (!d || !d.results.length) {
        const t = result.content[0];
        const text = t?.type === "text" ? t.text : "(no output)";
        const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
        const width = getTermWidth() - 4;
        if (!text.includes("\n"))
            return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);
        if (d && !options.expanded && !result.isError) {
            const lines = text.split(/\r?\n/);
            const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";
            const c = new Container();
            c.addChild(new Text(truncLine(`${contextPrefix}${firstNonEmptyLine} · ${lines.length} lines`, width), 0, 0));
            c.addChild(new Text(truncLine(theme.fg("accent", `  Press ${liveDetailKeyText()} for full output`), width), 0, 0));
            return c;
        }
        const c = new Container();
        const wrapped = wrapPlainText(`${contextPrefix}${text}`, width);
        for (const line of wrapped)
            c.addChild(new Text(line, 0, 0));
        return c;
    }
    const expanded = options.expanded;
    const mdTheme = getMarkdownTheme();
    if (d.mode === "single" && d.results.length === 1) {
        const r = d.results[0];
        if (!expanded)
            return renderSingleCompact(d, r, theme, frame);
        const isRunning = r.progress?.status === "running";
        const icon = isRunning
            ? theme.fg("warning", "running")
            : r.pause?.kind === "awaiting_supervisor"
                ? theme.fg("warning", "paused")
                : r.detached
                    ? theme.fg("warning", "detached")
                    : r.exitCode === 0
                        ? theme.fg("success", "ok")
                        : theme.fg("error", "failed");
        const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
        const output = r.truncation?.text || getSingleResultOutput(r);
        const progressInfo = isRunning && r.progress
            ? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
            : r.progressSummary
                ? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
                : "";
        const w = getTermWidth() - 4;
        const fit = (text) => (expanded ? text : truncLine(text, w));
        const toolCallLines = getToolCallLines(r, expanded);
        const c = new Container();
        c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`), 0, 0));
        const ticketLine = foregroundTkTicketLine(r, theme, isRunning, w);
        if (ticketLine)
            c.addChild(new Text(fit(ticketLine), 0, 0));
        c.addChild(new Spacer(1));
        const taskMaxLen = Math.max(20, w - 8);
        const taskPreview = expanded || r.task.length <= taskMaxLen ? r.task : `${r.task.slice(0, taskMaxLen)}...`;
        c.addChild(new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0));
        c.addChild(new Spacer(1));
        const outputTarget = extractOutputTarget(r.task);
        if (outputTarget) {
            c.addChild(new Text(fit(theme.fg("dim", `Output: ${outputTarget}`)), 0, 0));
        }
        if (isRunning && r.progress) {
            const progressSnapshotNow = snapshotNowForProgress(r.progress);
            const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
            if (toolLine) {
                c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
            }
            const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
            if (liveStatusLine) {
                c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
            }
            c.addChild(new Text(fit(theme.fg("accent", liveDetailHintText())), 0, 0));
            if (r.artifactPaths) {
                c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
            }
            if (r.progress.recentTools?.length) {
                for (const t of r.progress.recentTools.slice(-3)) {
                    const maxArgsLen = Math.max(40, w - 24);
                    const argsPreview = expanded || t.args.length <= maxArgsLen ? t.args : `${t.args.slice(0, maxArgsLen)}...`;
                    c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
                }
            }
            for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
                c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
            }
            if (toolLine ||
                liveStatusLine ||
                r.progress.recentTools?.length ||
                r.progress.recentOutput?.length ||
                r.artifactPaths) {
                c.addChild(new Spacer(1));
            }
        }
        if (expanded) {
            for (const line of toolCallLines) {
                c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
            }
            if (toolCallLines.length)
                c.addChild(new Spacer(1));
        }
        if (output)
            c.addChild(new Markdown(output, 0, 0, mdTheme));
        c.addChild(new Spacer(1));
        if (r.skills?.length) {
            c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
        }
        if (r.skillsWarning) {
            c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
        }
        if (r.attemptedModels && r.attemptedModels.length > 1) {
            c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
        }
        c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
        if (r.sessionFile) {
            c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
        }
        if ((!isRunning && r.artifactPaths) || r.truncation?.artifactPath) {
            c.addChild(new Spacer(1));
            if (!isRunning && r.artifactPaths) {
                c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
            }
            if (r.truncation?.artifactPath) {
                c.addChild(new Text(fit(theme.fg("dim", `Full output: ${shortenPath(r.truncation.artifactPath)}`)), 0, 0));
            }
        }
        return c;
    }
    if (!expanded)
        return renderMultiCompact(d, theme, frame);
    const hasRunning = d.progress?.some((p) => p.status === "running") ||
        d.results.some((r) => r.progress?.status === "running") ||
        workflowGraphHasStatus(d, ["running"]);
    const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
    const hasEmptyWithoutTarget = d.results.some((r) => r.exitCode === 0 &&
        r.progress?.status !== "running" &&
        hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)));
    const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
    const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
    const icon = hasRunning
        ? theme.fg("warning", "running")
        : hasEmptyWithoutTarget
            ? theme.fg("warning", "warning")
            : hasWorkflowFailure
                ? theme.fg("error", "failed")
                : hasWorkflowPause
                    ? theme.fg("warning", "paused")
                    : ok === d.results.length
                        ? theme.fg("success", "ok")
                        : theme.fg("error", "failed");
    const totalSummary = d.progressSummary ||
        d.results.reduce((acc, r) => {
            const prog = r.progress || r.progressSummary;
            if (prog) {
                acc.toolCount += prog.toolCount;
                acc.tokens += prog.tokens;
                acc.durationMs =
                    d.mode === "chain" ? acc.durationMs + prog.durationMs : Math.max(acc.durationMs, prog.durationMs);
            }
            return acc;
        }, { toolCount: 0, tokens: 0, durationMs: 0 });
    const summaryParts = [
        totalSummary.toolCount || totalSummary.tokens
            ? `${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
            : "",
        formatTotalCostStat(d.totalCost),
    ].filter(Boolean);
    const summaryStr = summaryParts.length ? ` | ${summaryParts.join(", ")}` : "";
    const modeLabel = d.mode;
    const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
    const multiLabel = buildMultiProgressLabel(d, hasRunning);
    const itemTitle = multiLabel.itemTitle;
    const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
        ? d.chainAgents
            .map((agent, i) => {
            const result = d.results[i];
            const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
            const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
            const isEmptyWithoutTarget = Boolean(result) &&
                Boolean(isComplete) &&
                hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
            const isCurrent = i === (d.currentStepIndex ?? d.results.length);
            const stepIcon = isFailed
                ? theme.fg("error", "failed")
                : isEmptyWithoutTarget
                    ? theme.fg("warning", "warning")
                    : isComplete
                        ? theme.fg("success", "done")
                        : isCurrent && hasRunning
                            ? theme.fg("warning", "running")
                            : theme.fg("dim", "pending");
            return `${stepIcon} ${agent}`;
        })
            .join(theme.fg("dim", " → "))
        : null;
    const w = getTermWidth() - 4;
    const fit = (text) => (expanded ? text : truncLine(text, w));
    const c = new Container();
    c.addChild(new Text(fit(`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`), 0, 0));
    if (chainVis) {
        c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
    }
    const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
    const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
    const displayEnd = multiLabel.showActiveGroupOnly
        ? multiLabel.groupEndIndex
        : useResultsDirectly
            ? d.results.length
            : d.chainAgents.length;
    const chainEntries = buildChainRenderEntries(d, multiLabel);
    const renderEntries = chainEntries ??
        Array.from({ length: displayEnd - displayStart }, (_, offset) => {
            const i = displayStart + offset;
            const r = d.results[i];
            const rowNumber = multiLabel.showActiveGroupOnly ? i - multiLabel.groupStartIndex + 1 : i + 1;
            return {
                kind: "result",
                resultIndex: i,
                rowNumber,
                agentName: useResultsDirectly
                    ? r?.agent || `step-${rowNumber}`
                    : d.chainAgents[i] || r?.agent || `step-${rowNumber}`,
            };
        });
    c.addChild(new Spacer(1));
    for (const entry of renderEntries) {
        if (entry.kind === "placeholder") {
            const statusLabel = widgetStepStatus(entry.status, theme);
            c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`), 0, 0));
            c.addChild(new Text(theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`), 0, 0));
            if (entry.error)
                c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
            c.addChild(new Spacer(1));
            continue;
        }
        const i = entry.resultIndex;
        const r = d.results[i];
        const rowNumber = entry.rowNumber;
        const agentName = entry.agentName;
        if (!r) {
            const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
            c.addChild(new Text(fit(theme.fg("dim", `  ${pendingLabel}: ${agentName}`)), 0, 0));
            c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
            c.addChild(new Spacer(1));
            continue;
        }
        const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
        const liveProgress = r.progress ?? progressFromArray;
        const summaryProgress = liveProgress ?? r.progressSummary;
        const rRunning = liveProgress?.status === "running";
        const stepNumber = typeof liveProgress?.index === "number" ? liveProgress.index + 1 : i + 1;
        const resultOutput = getSingleResultOutput(r);
        const statusIcon = rRunning
            ? theme.fg("warning", "running")
            : r.exitCode !== 0
                ? theme.fg("error", "failed")
                : hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
                    ? theme.fg("warning", "warning")
                    : theme.fg("success", "done");
        const stats = summaryProgress
            ? ` | ${summaryProgress.toolCount} tools, ${formatDuration(summaryProgress.durationMs)}`
            : "";
        const modelDisplay = modelThinkingBadge(theme, r.model);
        const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
        const stepHeader = rRunning
            ? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.agent))}${modelDisplay}${stats}`
            : `${statusIcon} ${stepLabel}: ${theme.bold(r.agent)}${modelDisplay}${stats}`;
        const toolCallLines = getToolCallLines(r, expanded);
        c.addChild(new Text(fit(stepHeader), 0, 0));
        const ticketLine = foregroundTkTicketLine(r, theme, rRunning, w);
        if (ticketLine)
            c.addChild(new Text(fit(ticketLine), 0, 0));
        const taskMaxLen = Math.max(20, w - 12);
        const taskPreview = expanded || r.task.length <= taskMaxLen ? r.task : `${r.task.slice(0, taskMaxLen)}...`;
        c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));
        const outputTarget = extractOutputTarget(r.task);
        if (outputTarget) {
            c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
        }
        if (r.skills?.length) {
            c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
        }
        if (r.skillsWarning) {
            c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
        }
        if (r.attemptedModels && r.attemptedModels.length > 1) {
            c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
        }
        if (rRunning && liveProgress) {
            if (liveProgress.skills?.length) {
                c.addChild(new Text(fit(theme.fg("accent", `    skills: ${liveProgress.skills.join(", ")}`)), 0, 0));
            }
            const progressSnapshotNow = snapshotNowForProgress(liveProgress);
            const toolLine = formatCurrentToolLine(liveProgress, w, expanded, progressSnapshotNow);
            if (toolLine) {
                c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
            }
            const liveStatusLine = buildLiveStatusLine(liveProgress, progressSnapshotNow);
            if (liveStatusLine) {
                c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
            }
            c.addChild(new Text(fit(theme.fg("accent", `    ${liveDetailHintText()}`)), 0, 0));
            if (r.artifactPaths) {
                c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
            }
            if (liveProgress.recentTools.length) {
                for (const t of liveProgress.recentTools.slice(-3)) {
                    const maxArgsLen = Math.max(40, w - 30);
                    const argsPreview = expanded || t.args.length <= maxArgsLen ? t.args : `${t.args.slice(0, maxArgsLen)}...`;
                    c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
                }
            }
            const recentLines = liveProgress.recentOutput.slice(-5);
            for (const line of recentLines) {
                c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
            }
        }
        if (!rRunning && r.artifactPaths) {
            c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
        }
        if (r.truncation?.artifactPath) {
            c.addChild(new Text(fit(theme.fg("dim", `    full output: ${shortenPath(r.truncation.artifactPath)}`)), 0, 0));
        }
        if (expanded && !rRunning) {
            for (const line of toolCallLines) {
                c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
            }
            if (toolCallLines.length)
                c.addChild(new Spacer(1));
        }
        c.addChild(new Spacer(1));
    }
    if (d.artifacts) {
        c.addChild(new Spacer(1));
        c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
    }
    return c;
}
