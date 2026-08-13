/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { liveDetailShortcutDisplay, type SubagentLiveDetailController } from "../shared/subagent-shortcuts.ts";
import {
	type ActivityState,
	type AgentProgress,
	type AsyncJobState,
	type AsyncJobStep,
	type AsyncParallelGroupStatus,
	type Details,
	type NestedRunSummary,
	type NestedStepSummary,
	type SubagentToolResult,
	type WorkflowNodeStatus,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "../shared/types.ts";
import {
	formatTokens,
	formatUsage,
	formatDuration,
	formatModelThinking,
	formatToolCall,
	shortenPath,
} from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { extractSingleOutputInstructionTarget } from "../runs/shared/single-output.ts";
import { countNestedRuns } from "../runs/shared/nested-render.ts";
import { normalizeTkTicketMetadata } from "../runs/shared/tk-ticket.ts";
import { aggregateStepStatus, formatActivityLabel, formatParallelOutcome } from "../shared/status-format.ts";
import { isProtectedPausedLifecycle } from "../runs/shared/lifecycle-privacy.ts";
import { whimsicalThinkingPhrase } from "./whimsical-phrases.ts";

type Theme = ExtensionContext["ui"]["theme"];

function liveDetailKeyText(): string {
	return liveDetailShortcutDisplay();
}

function liveDetailHintText(): string {
	return `Press ${liveDetailKeyText()} for live detail`;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function wrapDisplayLine(text: string, maxWidth: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, maxWidth));
}

function wrapDisplayLines(lines: readonly string[], maxWidth: number): string[] {
	return lines.flatMap((line) => wrapDisplayLine(line, maxWidth));
}

function addWrappedText(container: Container, text: string, maxWidth: number): void {
	for (const line of wrapDisplayLine(text, maxWidth)) container.addChild(new Text(line, 0, 0));
}

function collapsedForegroundLineBudget(): number {
	const rows = process.stdout.rows || 30;
	return Math.max(5, Math.min(14, Math.floor(rows * 0.4)));
}

function collapsedForegroundSummaryLines(hiddenCount: number, theme: Theme, width: number, maxLines: number): string[] {
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

function fitCollapsedForegroundLines(lines: string[], theme: Theme, width: number): string[] {
	const budget = collapsedForegroundLineBudget();
	if (lines.length <= budget) return lines;

	for (let visibleCount = Math.min(lines.length, budget - 1); visibleCount >= 0; visibleCount--) {
		const hiddenCount = lines.length - visibleCount;
		const summaryLines = wrapDisplayLine(
			theme.fg("dim", `… ${hiddenCount} lines hidden · ${liveDetailKeyText()} expands`),
			width,
		);
		if (visibleCount + summaryLines.length <= budget) {
			return [...lines.slice(0, visibleCount), ...summaryLines];
		}
	}

	return collapsedForegroundSummaryLines(lines.length, theme, width, budget);
}

function collapsedForegroundComponent(logicalLines: readonly string[], theme: Theme): Component {
	return {
		render(width: number): string[] {
			const contentWidth = Math.max(1, width);
			const physicalLines = wrapDisplayLines(logicalLines, contentWidth);
			return fitCollapsedForegroundLines(physicalLines, theme, contentWidth);
		},
		invalidate(): void {},
	};
}

function fitInlineThinkingActivity(
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

function fitInlineActivity(prefix: string, activity: string, theme: Theme, maxWidth: number): string[] {
	const separator = ` ${theme.fg("dim", "·")} `;
	return wrapDisplayLine(`${prefix}${separator}${theme.fg("dim", activity)}`, maxWidth);
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

type ProgressSeedSource = Partial<
	Pick<
		AgentProgress,
		"index" | "toolCount" | "tokens" | "durationMs" | "lastActivityAt" | "currentToolStartedAt" | "turnCount"
	>
>;

function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

function runningGlyph(seed?: number): string {
	if (seed === undefined) return STATIC_RUNNING_GLYPH;
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
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

interface LegacyResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

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
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return (
		result.toolCalls?.map((toolCall) => (expanded ? (toolCall.expandedText ?? toolCall.text) : toolCall.text)) ?? []
	);
}

function snapshotNowForProgress(
	progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">,
): number | undefined {
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined)
		return progress.currentToolStartedAt + progress.durationMs;
	return progress.lastActivityAt;
}

function formatCurrentToolLine(
	progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
	_availableWidth: number,
	_expanded: boolean,
	snapshotNow?: number,
): string | undefined {
	if (!progress.currentTool) return undefined;
	const toolArgsPreview = progress.currentToolArgs ?? "";
	const durationSuffix =
		progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
			? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
			: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(
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

function isHealthActivityState(activityState: ActivityState | undefined): boolean {
	return activityState === "needs_attention" || activityState === "active_long_running";
}

function compactThinkingPhrase(activityState: ActivityState | undefined, turnCount?: number): string | undefined {
	return isHealthActivityState(activityState) ? undefined : whimsicalThinkingPhrase(turnCount);
}

function themeBold(theme: Theme, text: string): string {
	return (theme as { bold?: (value: string) => string }).bold?.(text) ?? text;
}

function statJoin(theme: Theme, parts: string[]): string {
	return parts
		.filter(Boolean)
		.map((part) => theme.fg("dim", part))
		.join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatTotalCostStat(totalCost: Details["totalCost"] | undefined, includeTokenCounts = true): string {
	if (!totalCost || (totalCost.inputTokens === 0 && totalCost.outputTokens === 0 && totalCost.costUsd === 0)) return "";
	const parts: string[] = [];
	if (includeTokenCounts && totalCost.inputTokens) parts.push(`in:${formatTokens(totalCost.inputTokens)}`);
	if (includeTokenCounts && totalCost.outputTokens) parts.push(`out:${formatTokens(totalCost.outputTokens)}`);
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
	const preview = firstOutputLine(text);
	const withoutTruncationPath = preview.replace(/ - full output at (?:\/|[A-Za-z]:[\\/]|\\\\).*\]$/, "]");
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
	if (result.pause?.kind === "awaiting_supervisor") return "Paused awaiting supervisor · no child process running";
	if (result.detached) return result.detachedReason ? `Detached: ${result.detachedReason}` : "Detached";
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (result.acceptance?.status && result.acceptance.status !== "not-required")
		return `Done · acceptance: ${result.acceptance.status}`;
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
	if (result.detached) return theme.fg("warning", "■");
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

function compactProgressActivityLines(progress: AgentProgress, width = getTermWidth() - 4): string[] {
	const snapshotNow = snapshotNowForProgress(progress);
	const toolLine = formatCurrentToolLine(progress, width, false, snapshotNow);
	const liveStatus = buildLiveStatusLine(progress, snapshotNow);
	if (toolLine) return [toolLine, ...(liveStatus && liveStatus !== toolLine ? [liveStatus] : [])];
	const phrase = compactThinkingPhrase(progress.activityState, progress.turnCount);
	return [phrase, liveStatus].filter((line): line is string => Boolean(line));
}

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

function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} ×${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

function widgetJobName(job: AsyncJobState): string {
	if (job.mode === "parallel") return "parallel";
	if (job.mode === "chain") return "chain";
	if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
	if (job.agents?.length) return formatWidgetAgents(job.agents);
	return job.mode ?? "subagent";
}

function isProtectedWidgetLifecycle(state: string, interruptRequestedAt?: number): boolean {
	return (
		state === "paused" ||
		isProtectedPausedLifecycle({ state: state === "running" && interruptRequestedAt !== undefined ? "pausing" : state })
	);
}

function widgetRunningStep(job: AsyncJobState): AsyncJobStep | undefined {
	return job.steps?.find((step) => step.status === "running");
}

function widgetActiveStep(job: AsyncJobState): AsyncJobStep | undefined {
	return job.steps?.find((step) => step.status === "running" && Boolean(step.currentTool));
}

function widgetActivityState(job: AsyncJobState, runningStep?: AsyncJobStep): ActivityState | undefined {
	return (
		job.activityState ??
		job.steps?.find((step) => step.status === "running" && isHealthActivityState(step.activityState))?.activityState ??
		runningStep?.activityState
	);
}

function widgetHasPausingStep(job: AsyncJobState): boolean {
	return job.status === "running" && (job.steps?.some((step) => step.interruptRequestedAt !== undefined) ?? false);
}

function widgetInlineThinkingActivity(job: AsyncJobState): { phrase: string; freshness: string } | undefined {
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
	const privacySafe = isProtectedWidgetLifecycle(job.status, job.interruptRequestedAt);
	const runningStep = widgetRunningStep(job);
	if (job.interruptRequestedAt !== undefined && job.status === "running") {
		const facts: string[] = [];
		if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined)
			facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
		else if (job.currentTool) facts.push(job.currentTool);
		return [facts.length > 0 ? `pausing… · ${facts.join(" · ")}` : "pausing…"];
	}
	if (widgetHasPausingStep(job)) return ["pausing…"];
	const activeStep = widgetActiveStep(job);
	const activityStep = activeStep ?? runningStep;
	const currentTool = job.currentTool ?? activeStep?.currentTool;
	const currentToolStartedAt = job.currentToolStartedAt ?? activeStep?.currentToolStartedAt;
	const currentPath = job.currentPath ?? activeStep?.currentPath;
	const lastActivityAt = job.lastActivityAt ?? activityStep?.lastActivityAt;
	const activityState = widgetActivityState(job, runningStep);
	const turnCount = job.turnCount ?? activityStep?.turnCount;
	const facts: string[] = [];
	if (currentTool && currentToolStartedAt !== undefined && job.updatedAt !== undefined)
		facts.push(`${currentTool} ${formatDuration(Math.max(0, job.updatedAt - currentToolStartedAt))}`);
	else if (currentTool) facts.push(currentTool);
	if (!privacySafe && currentPath) facts.push(shortenPath(currentPath));
	if (expanded) {
		if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
		if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
		if (job.totalTokens?.total) facts.push(formatTokenStat(job.totalTokens.total));
	}
	const activity = buildLiveStatusLine({ activityState, lastActivityAt }, job.updatedAt);
	if (!currentTool && !expanded && job.status === "running") {
		return [compactThinkingPhrase(activityState, turnCount), activity, ...facts].filter((line): line is string =>
			Boolean(line),
		);
	}
	if (activity && facts.length) return [`${activity} · ${facts.join(" · ")}`];
	if (activity) return [activity];
	if (facts.length) return [facts.join(" · ")];
	if (job.status === "running")
		return [expanded ? "thinking…" : (compactThinkingPhrase(activityState, turnCount) ?? "thinking…")];
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
	for (const [index, step] of (steps ?? []).entries()) seed = runningSeed(seed, widgetStepRunningSeed(step, index));
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
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "complete" || status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme, interruptRequestedAt?: number): string {
	if (status === "running" && interruptRequestedAt !== undefined) return theme.fg("accent", "pausing");
	if (status === "running") return "";
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	return theme.fg("dim", status);
}

const TK_TICKET_WIDGET_PREFIX = "working on tk: ";

function widgetTkTicketText(job: AsyncJobState): string | undefined {
	if (!job.tkTicket || (job.status !== "running" && job.status !== "queued")) return undefined;
	const normalizedTkTicket = normalizeTkTicketMetadata(job.tkTicket);
	return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}

function widgetTkTicketLine(job: AsyncJobState, theme: Theme): string | undefined {
	const ticket = widgetTkTicketText(job);
	return ticket ? `  ${theme.fg("dim", ticket)}` : undefined;
}

function widgetTkTicketLines(job: AsyncJobState, theme: Theme): string[] {
	const line = widgetTkTicketLine(job, theme);
	return line ? [line] : [];
}

function foregroundTkTicketText(result: Details["results"][number]): string | undefined {
	const normalizedTkTicket = normalizeTkTicketMetadata(result.tkTicket);
	return normalizedTkTicket ? `${TK_TICKET_WIDGET_PREFIX}${normalizedTkTicket.title}` : undefined;
}

function foregroundTkTicketLine(result: Details["results"][number], theme: Theme, active: boolean): string | undefined {
	if (!active) return undefined;
	const ticket = foregroundTkTicketText(result);
	return ticket ? `  ${theme.fg("dim", ticket)}` : undefined;
}

function widgetStepActivity(
	step: NonNullable<AsyncJobState["steps"]>[number],
	snapshotNow?: number,
	expanded = false,
): string {
	const privacySafe = isProtectedWidgetLifecycle(step.status, step.interruptRequestedAt);
	if (step.interruptRequestedAt !== undefined) return "pausing…";
	const facts: string[] = [];
	if (step.currentTool && step.currentToolStartedAt !== undefined && snapshotNow !== undefined)
		facts.push(`${step.currentTool} ${formatDuration(Math.max(0, snapshotNow - step.currentToolStartedAt))}`);
	else if (step.currentTool) facts.push(step.currentTool);
	if (!privacySafe && step.currentPath) facts.push(shortenPath(step.currentPath));
	if (expanded) {
		if (step.turnCount !== undefined) facts.push(`${step.turnCount} turns`);
		if (step.toolCount !== undefined) facts.push(`${step.toolCount} tools`);
		if (step.tokens?.total) facts.push(formatTokenStat(step.tokens.total));
		if (step.durationMs !== undefined) facts.push(formatDuration(step.durationMs));
	}
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (!step.currentTool && !expanded && step.status === "running") {
		return [compactThinkingPhrase(step.activityState, step.turnCount), activity, ...facts].filter(Boolean).join(" · ");
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

function widgetChainDetails(job: AsyncJobState, theme: Theme, expanded = false, width = getTermWidth()): string[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: string[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			const status = aggregateStepStatus(steps);
			lines.push(
				`  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Step ${span.stepIndex + 1}/${total}: ${themeBold(theme, "parallel group")} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count, { showRunning: false }))}`,
			);
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

function widgetParallelAgentDetails(
	job: AsyncJobState,
	theme: Theme,
	expanded = false,
	width = getTermWidth(),
): string[] {
	if (!job.steps?.length) return [];
	if (job.mode !== "parallel" && job.mode !== "chain") return [];
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length)
		return widgetChainDetails(job, theme, expanded, width);
	const total = job.stepsTotal ?? job.steps.length;
	const lines: string[] = [];
	for (const [index, step] of job.steps.entries()) {
		const marker = index === job.steps.length - 1 ? "└" : "├";
		const activity = widgetStepActivity(step, job.updatedAt, expanded);
		const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		const healthWarning =
			step.interruptRequestedAt === undefined && !step.currentTool && isHealthActivityState(step.activityState)
				? buildLiveStatusLine(step, job.updatedAt)
				: undefined;
		const freshness =
			!expanded &&
			step.status === "running" &&
			step.interruptRequestedAt === undefined &&
			!step.currentTool &&
			!healthWarning
				? buildLiveStatusLine(step, job.updatedAt)
				: undefined;
		const stepStatus = widgetStepStatus(step.status, theme, step.interruptRequestedAt);
		const statusSuffix = stepStatus ? ` ${theme.fg("dim", "·")} ${stepStatus}` : "";
		const prefix = `  ${theme.fg("dim", `${marker} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${step.agent}${statusSuffix}${modelDisplay}`)}`;
		if (!expanded && healthWarning) {
			lines.push(...fitInlineActivity(prefix, healthWarning, theme, Math.max(1, width - 6)));
		} else if (freshness) {
			lines.push(
				...fitInlineThinkingActivity(
					prefix,
					compactThinkingPhrase(step.activityState, step.turnCount)!,
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

interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
	status?: WorkflowNodeStatus;
	label?: string;
	error?: string;
}

function buildChainStepSpans(details: Pick<Details, "workflowGraph">): ChainStepSpan[] {
	if (details.workflowGraph?.nodes?.length) {
		const spans: ChainStepSpan[] = [];
		let flatCursor = 0;
		for (const node of details.workflowGraph.nodes) {
			if (node.stepIndex === undefined) continue;
			if (node.kind === "parallel-group") {
				const childFlatIndexes = (node.children ?? [])
					.map((child) => child.flatIndex)
					.filter((value): value is number => typeof value === "number");
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
		if (spans.length) return spans.sort((left, right) => left.stepIndex - right.stepIndex);
	}

	return [];
}

function isChainParallelGroupActive(details: Pick<Details, "mode" | "currentStepIndex" | "workflowGraph">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	return buildChainStepSpans(details).some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
}

function buildAsyncChainStepSpans(
	total: number,
	stepCount: number,
	parallelGroups: AsyncParallelGroupStatus[] = [],
): ChainStepSpan[] {
	const spans: ChainStepSpan[] = [];
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

function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
}

function workflowGraphHasStatus(details: Pick<Details, "workflowGraph">, statuses: WorkflowNodeStatus[]): boolean {
	return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}

interface ChainRenderResultEntry {
	kind: "result";
	resultIndex: number;
	rowNumber: number;
	agentName: string;
}

interface ChainRenderPlaceholderEntry {
	kind: "placeholder";
	rowNumber: number;
	stepLabel: string;
	agentName: string;
	status: WorkflowNodeStatus;
	error?: string;
}

type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry;

function buildChainRenderEntries(details: Details, label: MultiProgressLabel): ChainRenderEntry[] | undefined {
	if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (span.isParallel && span.count === 0) {
			entries.push({
				kind: "placeholder",
				rowNumber: span.stepIndex + 1,
				stepLabel: `Step ${span.stepIndex + 1}`,
				agentName: span.label ?? `step-${span.stepIndex + 1}`,
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
				agentName: details.results[index]?.agent ?? `step-${span.stepIndex + 1}`,
			});
		}
	}
	return entries;
}

interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	activeParallelGroup: boolean;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

function buildMultiProgressLabel(
	details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "workflowGraph">,
	hasRunning: boolean,
): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<
			"pending" | "running" | "completed" | "failed" | "detached"
		>;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray =
				details.progress?.find((progress) => progress.index === i) ||
				details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status =
				result.progress?.status ??
				(result.interrupted || result.detached ? "detached" : result.exitCode === 0 ? "completed" : "failed");
			statuses[index] = status;
		}
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = `${done}/${totalCount} done`;
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
		const currentStepIndex = details.currentStepIndex!;
		const span = stepSpans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? 1;
		const headerLabel = `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
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

	if (details.mode === "chain" && stepSpans.length > 0) {
		const totalCount = details.totalSteps ?? stepSpans.length;
		const doneLogical = stepSpans.filter((span) => {
			if (span.status && span.status !== "completed") return false;
			if (span.count === 0) return span.status === "completed";
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry =
					details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (
					progressEntry?.status === "running" ||
					progressEntry?.status === "pending" ||
					progressEntry?.status === "failed"
				)
					return false;
				if (!resultEntry || !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep =
			details.currentStepIndex !== undefined
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
	const currentStep =
		details.currentStepIndex !== undefined
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

function resultRowLabel(
	details: Pick<Details, "mode" | "workflowGraph">,
	label: MultiProgressLabel,
	resultIndex: number,
	stepNumber: number,
): string {
	if (details.mode === "chain" && label.hasParallelInChain) {
		const span = buildChainStepSpans(details).find(
			(candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count,
		);
		if (span?.isParallel) return `Agent ${resultIndex - span.start + 1}/${span.count}`;
		if (span) return `Step ${span.stepIndex + 1}`;
	}
	if (label.itemTitle === "Agent") {
		const localStepNumber = label.activeParallelGroup ? Math.max(1, stepNumber - label.groupStartIndex) : stepNumber;
		return `Agent ${localStepNumber}/${label.totalCount}`;
	}
	return `Step ${stepNumber}`;
}

function widgetStats(job: AsyncJobState, theme: Theme, includeStepProgress = true, expanded = false): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? job.agents?.length ?? 1;
	if (includeStepProgress && job.activeParallelGroup) {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.mode === "parallel") {
			if (job.status === "running" && running > 0 && job.interruptRequestedAt !== undefined)
				parts.push(`${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`);
			if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
		} else {
			const activeGroup =
				job.currentStep !== undefined
					? job.parallelGroups?.find(
							(group) => job.currentStep! >= group.start && job.currentStep! < group.start + group.count,
						)
					: job.parallelGroups?.find((group) => group.start === 0);
			const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
			const total = job.chainStepCount ?? stepsTotal;
			const groupParts = [`${done}/${stepsTotal} done`];
			if (job.status === "running" && running > 0 && job.interruptRequestedAt !== undefined)
				groupParts.unshift(`${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`);
			parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
		}
	} else if (includeStepProgress && job.mode === "parallel") {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.status === "running" && running > 0 && job.interruptRequestedAt !== undefined)
			parts.push(`${running === 1 ? "1 agent pausing" : `${running} agents pausing`}`);
		if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
	} else if (includeStepProgress && job.currentStep !== undefined) {
		if (job.mode === "chain" && job.parallelGroups?.length) {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
		} else {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
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

function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

function widgetStepActivityLines(
	step: NonNullable<AsyncJobState["steps"]>[number],
	width: number,
	expanded: boolean,
	snapshotNow?: number,
): string[] {
	if (step.interruptRequestedAt !== undefined) return ["pausing…"];
	const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (toolLine) return [toolLine, ...(activity && activity !== toolLine ? [activity] : [])];
	if (!expanded && step.status === "running")
		return [compactThinkingPhrase(step.activityState, step.turnCount), ...(activity ? [activity] : [])].filter(
			(line): line is string => Boolean(line),
		);
	if (activity) return [activity];
	if (step.status === "running") return ["thinking…"];
	return [];
}

function widgetOutputPath(job: AsyncJobState, step: NonNullable<AsyncJobState["steps"]>[number]): string | undefined {
	if (typeof step.index !== "number") return undefined;
	return path.join(job.asyncDir, `output-${step.index}.log`);
}

function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.id;
}

function formatNestedWidgetAggregate(children: NestedRunSummary[] | undefined, theme: Theme): string | undefined {
	const counts = countNestedRuns(children);
	if (counts.total === 0) return undefined;
	const liveGlyph =
		counts.running > 0 ? `${nestedStatusGlyph("running", theme, runningSeed(counts.running, counts.total))} ` : "";
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
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined)
		facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (!privacySafe && input.currentPath) facts.push(shortenPath(input.currentPath));
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
		return expanded ? "thinking…" : (compactThinkingPhrase(input.activityState, input.turnCount) ?? "thinking…");
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
			if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}↳ ${aggregate}`));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= lineBudget) {
				const aggregate = formatNestedWidgetAggregate(items.slice(index), theme);
				if (aggregate) lines[lines.length - 1] = theme.fg("dim", `${prefix}↳ ${aggregate}`);
				return;
			}
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate, privacySafe, expanded);
			const error = child.error ? ` · ${privacySafe ? "lifecycle status requires attention" : child.error}` : "";
			const status = child.state === "running" ? "" : ` · ${child.state}`;
			lines.push(
				theme.fg(
					"dim",
					`${prefix}↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)}${status} · ${activity}${error}`,
				),
			);
			if (depth === maxDepth) {
				const aggregate = formatNestedWidgetAggregate(
					[...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])],
					theme,
				);
				if (aggregate && lines.length < lineBudget) lines.push(theme.fg("dim", `${prefix}  ↳ ${aggregate}`));
				continue;
			}
			for (const step of child.steps ?? []) {
				if (lines.length >= lineBudget) return;
				const status = step.status === "running" ? "" : ` · ${step.status}`;
				lines.push(
					theme.fg(
						"dim",
						`${prefix}  ↳ ${nestedStatusGlyph(step.status, theme)} ${step.agent}${status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate, privacySafe, expanded)}`,
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
	if (step.status !== "running") return step.status;
	if (job.status === "complete" || job.status === "failed") return job.status;
	return step.status;
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
	displayStatus: AsyncJobStep["status"] = step.status,
): string[] {
	const status = widgetStepStatus(
		displayStatus,
		theme,
		displayStatus === "running" ? step.interruptRequestedAt : undefined,
	);
	const durationFallbackMs =
		itemTitle === undefined &&
		step.status === "running" &&
		step.durationMs === undefined &&
		job.startedAt !== undefined &&
		job.updatedAt !== undefined
			? Math.max(0, job.updatedAt - job.startedAt)
			: undefined;
	const stats = widgetStepStats(theme, step, durationFallbackMs, expanded);
	const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
	const itemLabel = itemTitle ? `${itemTitle} ${index}/${total}: ` : "";
	const statusSuffix = status ? ` ${theme.fg("dim", "·")} ${status}` : "";
	const lines = [
		`  ${widgetStepGlyph(displayStatus, theme, widgetStepRunningSeed(step, index - 1))} ${itemLabel}${themeBold(theme, step.agent)}${statusSuffix}${modelDisplay}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
	];
	const activityLines =
		displayStatus === step.status ? widgetStepActivityLines(step, width, expanded, job.updatedAt) : [];
	for (const [activityIndex, activity] of activityLines.entries()) {
		lines.push(`    ${theme.fg("dim", activityIndex === 0 ? `⎿  ${activity}` : `   ${activity}`)}`);
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
	if (displayStatus === "running") {
		if (!expanded) lines.push(`    ${theme.fg("dim", liveDetailHintText())}`);
		if (expanded) {
			const output = widgetOutputPath(job, step);
			if (output) lines.push(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`);
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				lines.push(`      ${theme.fg("dim", `${tool.tool}${tool.args ? `: ${tool.args}` : ""}`)}`);
			}
			for (const line of step.recentOutput?.slice(-5) ?? []) {
				lines.push(`      ${theme.fg("dim", line)}`);
			}
		}
	}
	return lines;
}

function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number): string[] {
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
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) {
		return [...widgetTkTicketLines(job, theme), ...widgetChainDetails(job, theme, expanded, width)];
	}
	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines: string[] = [...widgetTkTicketLines(job, theme)];
	for (const [index, step] of job.steps.entries()) {
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width));
	}
	const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
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

function singleWidgetAgentDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number): string[] {
	const step = job.steps?.[0];
	if (step) {
		const lines = [
			...widgetTkTicketLines(job, theme),
			...foregroundStyleWidgetStepLines(
				job,
				theme,
				step,
				undefined,
				1,
				1,
				expanded,
				width,
				singleWidgetStepDisplayStatus(job, step),
			),
		];
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

	const agent = job.agents?.[0] ?? widgetJobName(job);
	const stats = widgetSummaryStats(job, theme, expanded);
	const status = job.status === "running" ? "" : theme.fg("dim", job.status);
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
	return job.status === "complete" ? "done" : job.status;
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
	const count = job.mode === "chain" ? job.chainStepCount : (job.stepsTotal ?? job.agents?.length ?? job.steps?.length);
	const mode = widgetJobName(job);
	const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	return [
		`${theme.fg("toolTitle", themeBold(theme, title))}`,
		`${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
	];
}

function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, contentWidth: number, expanded: boolean): string[] {
	const details =
		job.mode === "single"
			? singleWidgetAgentDetails(job, theme, expanded, contentWidth)
			: foregroundStyleWidgetDetails(job, theme, expanded, contentWidth);
	return wrapDisplayLines([...singleWidgetHeaderLines(job, theme, expanded), ...details], contentWidth);
}

function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number): string[] {
	const contentWidth = Math.max(1, width - 2);
	const fullLines = buildSingleWidgetLines(job, theme, contentWidth, false);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) {
		return fullLines;
	}

	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines = [
		...wrapDisplayLines(singleWidgetHeaderLines(job, theme, false), contentWidth),
		...widgetTkTicketLines(job, theme),
	];
	for (const [index, step] of job.steps.entries()) {
		const status = widgetStepStatus(step.status, theme, step.interruptRequestedAt);
		const statusSuffix = status ? ` ${theme.fg("dim", "·")} ${status}` : "";
		const activityLines = widgetStepActivityLines(step, contentWidth, false, job.updatedAt);
		const activity = activityLines.join(" · ");
		const stepStats = widgetStepStats(theme, step);
		const activitySuffix = activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
		const modelDisplay = modelThinkingBadge(theme, step.model, step.thinking);
		const rowPrefix = `  ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, step.agent)}${statusSuffix}${modelDisplay}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}`;
		const healthWarning =
			step.status === "running" &&
			step.interruptRequestedAt === undefined &&
			!step.currentTool &&
			isHealthActivityState(step.activityState)
				? activityLines.find((activityLine) => activityLine === buildLiveStatusLine(step, job.updatedAt))
				: undefined;
		if (healthWarning) {
			lines.push(...fitInlineActivity(rowPrefix, healthWarning, theme, contentWidth));
		} else if (step.status === "running" && !step.currentTool && activityLines.length === 2) {
			lines.push(...fitInlineThinkingActivity(rowPrefix, activityLines[0]!, activityLines[1]!, theme, contentWidth));
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
	if (job.steps.some((step) => step.status === "running")) lines.push(theme.fg("dim", `  ${liveDetailHintText()}`));
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
		complete: jobs.filter((job) => job.status === "complete"),
		failed: jobs.filter((job) => job.status === "failed"),
		paused: jobs.filter((job) => job.status === "paused"),
	};
}

function chooseWidgetSummaryVariant(variants: readonly string[], width: number): string {
	const contentWidth = Math.max(1, width);
	return variants.find((variant) => visibleWidth(variant) <= contentWidth) ?? variants[variants.length - 1]!;
}

function compactWidgetCountSummary(counts: ReturnType<typeof widgetHeaderCounts>, jobs: AsyncJobState[]): string {
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
	const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
	const coloredGlyph = theme.fg(hasActive ? "accent" : "dim", glyph);
	const coloredTitle = theme.fg(hasActive ? "accent" : "dim", "subagents");
	const parts: string[] = [];
	if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
	if (counts.failed.length > 0) parts.push(`${counts.failed.length} failed`);
	if (counts.paused.length > 0) parts.push(`${counts.paused.length} paused`);
	if (!hasActive && counts.complete.length > 0) parts.push(`${counts.complete.length}/${jobs.length} done`);
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
	return [chooseWidgetSummaryVariant([detailed, withoutParenthetical, compact, titleOnly, coloredGlyph], contentWidth)];
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

function selectProgressiveJobKeys(jobs: AsyncJobState[], previousKeys: string[], bodyRows: number): string[] {
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
	const glyph = counts.running.length > 0 ? runningGlyph(widgetJobsRunningSeed(counts.running)) : hasActive ? "●" : "○";
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
	const withoutTitle = coloredParts ? `${coloredGlyph} ${coloredParts}` : `${coloredGlyph} ${coloredTitle}`;
	const titleOnly = `${coloredGlyph} ${coloredTitle}`;
	return [
		chooseWidgetSummaryVariant(
			[detailed, withoutTitle, compact ? `${coloredGlyph} ${compact}` : titleOnly, titleOnly, coloredGlyph],
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
		return fitInlineThinkingActivity(prefix, thinkingActivity.phrase, thinkingActivity.freshness, theme, contentWidth);
	const runningStep = widgetRunningStep(job);
	const activityState = widgetActivityState(job, runningStep);
	const healthWarning =
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
		activity && activity.toLowerCase() !== status ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : "";
	return wrapDisplayLine(`${prefix}${activitySuffix}`, contentWidth);
}

function progressiveHiddenLine(hiddenJobs: AsyncJobState[], theme: Theme, width: number): string[] {
	const contentWidth = Math.max(1, width - 2);
	const counts = widgetHeaderCounts(hiddenJobs);
	const parts: string[] = [];
	if (counts.queued.length > 0) parts.push(`${counts.queued.length} queued`);
	const finished = counts.complete.length + counts.failed.length + counts.paused.length;
	if (finished > 0) parts.push(`${finished} finished`);
	const full = theme.fg("dim", `  +${hiddenJobs.length} more${parts.length ? ` (${parts.join(", ")})` : ""}`);
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
	if (rowCount === 1) return { lines: buildSingleLineWidgetLines(jobs, theme, width), visibleJobKeys: [] };

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
		const prospectiveHiddenJobs = jobs.filter((candidate) => !prospectiveKeys.includes(progressiveJobKey(candidate)));
		const prospectiveHiddenLines =
			prospectiveHiddenJobs.length > 0 ? progressiveHiddenLine(prospectiveHiddenJobs, theme, width) : [];
		if (headerLines.length + bodyLines.length + jobLines.length + prospectiveHiddenLines.length > rowCount) continue;
		visibleJobKeys.push(key);
		bodyLines.push(...jobLines);
	}

	const hiddenJobs = jobs.filter((job) => !visibleJobKeys.includes(progressiveJobKey(job)));
	const hiddenLines = hiddenJobs.length > 0 ? progressiveHiddenLine(hiddenJobs, theme, width) : [];
	const lines = [...headerLines, ...bodyLines, ...hiddenLines];
	if (lines.length > rowCount) {
		// Job rows are optional in a locked-height summary. Keep the one-line
		// header and explicit hidden-work count if a future detail variant wraps.
		const boundedLines = [headerLines[0]!, ...(hiddenLines.length > 0 ? [hiddenLines[0]!] : [])];
		while (boundedLines.length < rowCount) boundedLines.push("\u200c");
		return { lines: boundedLines.slice(0, rowCount), visibleJobKeys: [] };
	}
	while (lines.length < rowCount) lines.push("\u200c");
	return { lines, visibleJobKeys };
}

function collapsedWidgetLineBudget(rows: number): number {
	return Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
}

function fitWidgetLineBudget(lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
	const contentWidth = Math.max(1, width - 2);
	const rows = process.stdout.rows || 30;
	const budget = expanded ? Math.max(12, Math.min(24, Math.floor(rows * 0.55))) : collapsedWidgetLineBudget(rows);
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

	if (hasMatchingSession && widgetLayoutSession?.tier === "single-line") {
		return buildSingleLineWidgetLines(jobs, theme, width);
	}

	if (
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
	const headerGlyph = running.length > 0 ? runningGlyph(widgetJobsRunningSeed(running)) : hasActive ? "●" : "○";
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
		items.push([theme.fg("dim", `+${hiddenTotal} more${parts.length ? ` (${parts.join(", ")})` : ""}`)]);
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

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme, frame?: number): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const lines: string[] = [];
	const width = getTermWidth() - 4;
	const modelDisplay = modelThinkingBadge(theme, r.model);
	lines.push(
		`${resultGlyph(r, output, theme, isRunning, undefined, frame)} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelDisplay}${contextBadge}`,
	);
	const ticketLine = foregroundTkTicketLine(r, theme, isRunning);
	if (ticketLine) lines.push(ticketLine);

	if (isRunning && r.progress) {
		for (const [activityIndex, activity] of compactProgressActivityLines(r.progress, width).entries()) {
			lines.push(theme.fg("dim", activityIndex === 0 ? `  ⎿  ${activity}` : `     ${activity}`));
		}
		lines.push(theme.fg("dim", `  ${liveDetailHintText()}`));
		return collapsedForegroundComponent(lines, theme);
	}

	const preview = compactOutputPreview(output);
	lines.push(theme.fg("dim", `  ⎿  ${resultStatusLine(r, preview)}`));
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		lines.push(theme.fg("dim", `     ${preview}`));
	}
	if (r.sessionFile) lines.push(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`));
	return collapsedForegroundComponent(lines, theme);
}

function renderMultiCompact(d: Details, theme: Theme, frame?: number): Component {
	const hasRunning =
		d.progress?.some((p) => p.status === "running") ||
		d.results.some((r) => r.progress?.status === "running") ||
		workflowGraphHasStatus(d, ["running"]);
	const failed =
		d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running") ||
		workflowGraphHasStatus(d, ["failed"]);
	const paused =
		d.results.some((r) => (r.interrupted || r.detached) && r.progress?.status !== "running") ||
		workflowGraphHasStatus(d, ["paused", "detached"]);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs =
				d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	const stats = statJoin(theme, [multiLabel.headerLabel, formatTotalCostStat(d.totalCost, false)]);
	const glyph = hasRunning
		? theme.fg(
				"accent",
				runningGlyph(
					frame !== undefined
						? (runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex) ?? 0) + frame
						: runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex),
				),
			)
		: failed
			? theme.fg("error", "✗")
			: paused
				? theme.fg("warning", "■")
				: theme.fg("success", "✓");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const lines: string[] = [];
	const width = getTermWidth() - 4;
	lines.push(
		`${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`,
	);

	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : d.results.length;
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries =
		chainEntries ??
		Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
			const i = displayStart + offset;
			const r = d.results[i];
			const fallbackLabel = itemTitle.toLowerCase();
			const rowNumber = multiLabel.showActiveGroupOnly ? i - multiLabel.groupStartIndex + 1 : i + 1;
			return {
				kind: "result",
				resultIndex: i,
				rowNumber,
				agentName: r?.agent || `${fallbackLabel}-${rowNumber}`,
			};
		});
	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const glyph = widgetStepGlyph(entry.status as AsyncJobStep["status"], theme);
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			const statusSuffix = statusLabel ? ` ${theme.fg("dim", "·")} ${statusLabel}` : "";
			lines.push(`  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)}${statusSuffix}`);
			if (entry.error) lines.push(theme.fg("error", `    ⎿  Error: ${entry.error}`));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			lines.push(theme.fg("dim", `  ◦ ${pendingLabel}: ${agentName} · pending`));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray =
			d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const liveProgress = r.progress ?? progressFromArray;
		const summaryProgress = liveProgress ?? r.progressSummary;
		const rRunning = liveProgress?.status === "running";
		const rPending = liveProgress?.status === "pending";
		const stepNumber = liveProgress?.index !== undefined ? liveProgress.index + 1 : i + 1;
		const glyph = rPending
			? theme.fg("dim", "◦")
			: resultGlyph(r, output, theme, rRunning, progressRunningSeed(summaryProgress), frame);
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${glyph} ${stepLabel}: ${themeBold(theme, agentName)}${pendingLabel}`;
		lines.push(`  ${line}`);
		const ticketLine = foregroundTkTicketLine(r, theme, rRunning);
		if (ticketLine) lines.push(ticketLine);
		if (rRunning && liveProgress) {
			for (const [activityIndex, activity] of compactProgressActivityLines(liveProgress, width).entries()) {
				lines.push(theme.fg("dim", activityIndex === 0 ? `    ⎿  ${activity}` : `       ${activity}`));
			}
			lines.push(theme.fg("dim", `    ${liveDetailHintText()}`));
		} else if (
			!rPending &&
			(r.exitCode !== 0 || r.interrupted || r.detached || hasEmptyTextOutputWithoutOutputTarget(r.task, output))
		) {
			lines.push(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`));
		}
	}
	if (d.artifacts) lines.push(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`));
	return collapsedForegroundComponent(lines, theme);
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
	const hideAsyncPlaceholderBody = Boolean(
		d?.asyncId && !d.results.length && d.mode !== "management" && !result.isError,
	);
	if (hideAsyncPlaceholderBody) return new Container();
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		const width = getTermWidth() - 4;
		if (!text.includes("\n")) {
			const c = new Container();
			addWrappedText(c, `${contextPrefix}${text}`, width);
			return c;
		}
		if (d && !options.expanded && !result.isError) {
			const lines = text.split(/\r?\n/);
			const firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";
			const c = new Container();
			addWrappedText(c, `${contextPrefix}${firstNonEmptyLine} · ${lines.length} lines`, width);
			addWrappedText(c, theme.fg("dim", `  Press ${liveDetailKeyText()} for full output`), width);
			return c;
		}
		const c = new Container();
		for (const line of wrapDisplayLine(`${contextPrefix}${text}`, width)) c.addChild(new Text(line, 0, 0));
		return c;
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme, frame);
		const isRunning = r.progress?.status === "running";
		const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
		const output = r.truncation?.text || getSingleResultOutput(r);
		const icon = isRunning
			? resultGlyph(r, output, theme, true, progressRunningSeed(r.progress ?? r.progressSummary), frame)
			: r.pause?.kind === "awaiting_supervisor"
				? theme.fg("warning", "paused")
				: r.detached
					? theme.fg("warning", "detached")
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
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${contextBadge}${progressInfo}`, 0, 0));
		const ticketLine = foregroundTkTicketLine(r, theme, isRunning);
		if (ticketLine) c.addChild(new Text(ticketLine, 0, 0));
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
		c.addChild(new Spacer(1));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(theme.fg("dim", `Output: ${outputTarget}`), 0, 0));
		}

		if (isRunning && r.progress) {
			const progressSnapshotNow = snapshotNowForProgress(r.progress);
			const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(theme.fg("warning", `> ${toolLine}`), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(theme.fg("accent", liveStatusLine), 0, 0));
			}
			c.addChild(new Text(theme.fg("dim", liveDetailHintText()), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					c.addChild(new Text(theme.fg("dim", `${t.tool}: ${t.args}`), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
			}
			if (
				toolLine ||
				liveStatusLine ||
				r.progress.recentTools?.length ||
				r.progress.recentOutput?.length ||
				r.artifactPaths
			) {
				c.addChild(new Spacer(1));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(theme.fg("muted", line), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(theme.fg("dim", `Skills: ${r.skills.join(", ")}`), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(theme.fg("warning", `Warning: ${r.skillsWarning}`), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`), 0, 0));
		}
		c.addChild(new Text(theme.fg("dim", formatUsage(r.usage, r.model)), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`), 0, 0));
		}

		if ((!isRunning && r.artifactPaths) || r.truncation?.artifactPath) {
			c.addChild(new Spacer(1));
			if (!isRunning && r.artifactPaths) {
				c.addChild(new Text(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
			}
			if (r.truncation?.artifactPath) {
				c.addChild(new Text(theme.fg("dim", `Full output: ${shortenPath(r.truncation.artifactPath)}`), 0, 0));
			}
		}
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme, frame);

	const hasRunning =
		d.progress?.some((p) => p.status === "running") ||
		d.results.some((r) => r.progress?.status === "running") ||
		workflowGraphHasStatus(d, ["running"]);
	const ok = d.results.filter(
		(r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running"),
	).length;
	const hasEmptyWithoutTarget = d.results.some(
		(r) =>
			r.exitCode === 0 &&
			r.progress?.status !== "running" &&
			hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
	const hasWorkflowPause = workflowGraphHasStatus(d, ["paused", "detached"]);
	const icon = hasRunning
		? theme.fg("accent", runningGlyph(frame))
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: hasWorkflowFailure
				? theme.fg("error", "failed")
				: hasWorkflowPause
					? theme.fg("warning", "paused")
					: ok === d.results.length
						? theme.fg("success", "ok")
						: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain" ? acc.durationMs + prog.durationMs : Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const totalTurnCount = d.results.reduce(
		(sum, result) => sum + (result.progress?.turnCount ?? result.usage?.turns ?? 0),
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

	const modeLabel = d.mode;
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;

	const w = getTermWidth() - 4;
	const c = new Container();
	c.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`,
			0,
			0,
		),
	);

	const displayStart = multiLabel.showActiveGroupOnly ? multiLabel.groupStartIndex : 0;
	const displayEnd = multiLabel.showActiveGroupOnly ? multiLabel.groupEndIndex : d.results.length;
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries =
		chainEntries ??
		Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
			const i = displayStart + offset;
			const r = d.results[i];
			const rowNumber = multiLabel.showActiveGroupOnly ? i - multiLabel.groupStartIndex + 1 : i + 1;
			return {
				kind: "result",
				resultIndex: i,
				rowNumber,
				agentName: r?.agent || `step-${rowNumber}`,
			};
		});

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "placeholder") {
			const status = entry.status as AsyncJobStep["status"];
			const statusLabel = widgetStepStatus(status, theme);
			const statusPrefix = statusLabel || widgetStepGlyph(status, theme);
			c.addChild(new Text(`  ${statusPrefix} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`, 0, 0));
			if (status !== "running")
				c.addChild(new Text(theme.fg(status === "failed" ? "error" : "dim", `    status: ${status}`), 0, 0));
			if (entry.error) c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;

		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(theme.fg("dim", `  ${pendingLabel}: ${agentName}`), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray =
			d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const liveProgress = r.progress ?? progressFromArray;
		const summaryProgress = liveProgress ?? r.progressSummary;
		const rRunning = liveProgress?.status === "running";
		const stepNumber = typeof liveProgress?.index === "number" ? liveProgress.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? resultGlyph(r, resultOutput, theme, true, progressRunningSeed(summaryProgress), frame)
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
		c.addChild(new Text(stepHeader, 0, 0));
		const ticketLine = foregroundTkTicketLine(r, theme, rRunning);
		if (ticketLine) c.addChild(new Text(ticketLine, 0, 0));

		c.addChild(new Text(theme.fg("dim", `    task: ${r.task}`), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(theme.fg("dim", `    output: ${outputTarget}`), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(theme.fg("dim", `    skills: ${r.skills.join(", ")}`), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(theme.fg("warning", `    Warning: ${r.skillsWarning}`), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`), 0, 0));
		}

		if (rRunning && liveProgress) {
			if (liveProgress.skills?.length) {
				c.addChild(new Text(theme.fg("accent", `    skills: ${liveProgress.skills.join(", ")}`), 0, 0));
			}
			const progressSnapshotNow = snapshotNowForProgress(liveProgress);
			const toolLine = formatCurrentToolLine(liveProgress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(theme.fg("warning", `    > ${toolLine}`), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(liveProgress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(theme.fg("accent", `    ${liveStatusLine}`), 0, 0));
			}
			c.addChild(new Text(theme.fg("dim", `    ${liveDetailHintText()}`), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
			}
			if (liveProgress.recentTools.length) {
				for (const t of liveProgress.recentTools.slice(-3)) {
					c.addChild(new Text(theme.fg("dim", `      ${t.tool}: ${t.args}`), 0, 0));
				}
			}
			const recentLines = liveProgress.recentOutput.slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(theme.fg("dim", `      ${line}`), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`), 0, 0));
		}
		if (r.truncation?.artifactPath) {
			c.addChild(new Text(theme.fg("dim", `    full output: ${shortenPath(r.truncation.artifactPath)}`), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(theme.fg("muted", `      ${line}`), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`), 0, 0));
	}
	return c;
}
