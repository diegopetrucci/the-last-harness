/**
 * Subagent completion notifications.
 *
 * Successful (completed) async results are held briefly and emitted as a
 * single grouped message when sibling jobs finish within a short window (see
 * `completion-batcher.ts`). Failed and paused results bypass grouping and fire
 * immediately, flushing any held successes first, so failure and attention
 * signals are never delayed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	type CompletionBatcher,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentState } from "../../shared/types.ts";
import { isProtectedPausedLifecycle } from "../shared/lifecycle-privacy.ts";
import { BACKGROUND_COMPLETION_NUDGE_TEXT } from "../shared/nudge-texts.ts";

// --- Injection / context bounds on child-controlled text ---
// These constants limit text that originates from child subagents and enters
// the parent transcript, message envelope, or TUI. They are a trust boundary,
// not token-tuning knobs. Do not raise them without considering the injection
// surface. Sanitization helpers (normalizeAsyncIdentifier, boundedReference,
// boundedLabel, MAX_LABEL_CHARS, MAX_REFERENCE_CHARS, MAX_ASYNC_ID_CHARS,
// MAX_SESSION_PATH_CHARS) are the primary control-character and path-traversal
// fence; the char-count caps below are a secondary depth limit on the same
// surface.
//
// MAX_SUMMARY_CHARS is a PER-CHILD budget, not a shared pool. Each child's
// result is an independent unit of information, so a child's report must not
// shrink merely because it has siblings. The same constant applies to the
// single-result sites and to each displayed child in the grouped shape.
//
// Sizing is empirical. Across 158 subagent output artifacts on disk, the share
// arriving complete and inline under each candidate cap was:
//   750 -> 23%   1 200 -> 35%   3 000 -> 73%
//   6 000 -> 88%  8 000 -> 96%  12 000 -> 98%  16 000 -> 99%
// Distribution: p50 1 772, p75 3 064, p90 6 267, p95 7 556, max 16 672.
// 8 000 is the knee of that curve; beyond it buys 2-3 points for 1.5-2x the size.
//
// MAX_COMPLETION_MESSAGE_CHARS is a pure ceiling on the assembled message, not a
// routinely-binding cap. Under per-child sizing the ceiling MUST exceed the
// per-child budget, otherwise one full-size result overflows an equal-sized
// envelope on its own. 32 000 covers up to 4 children at full size. Calibration:
// the foreground path already allows 200 KB per result (DEFAULT_MAX_OUTPUT in
// shared/types.ts), so 32 000 is still ~6x tighter than foreground for the same
// work; the previous 8 000 was ~25x tighter, and that asymmetry was the defect.
//
// Wide fan-out overflow rule: when displayedChildren * MAX_SUMMARY_CHARS would
// exceed the ceiling, fall back to an equal share floored at
// MIN_PER_CHILD_SUMMARY_CHARS so no child is starved. At MAX_DISPLAYED_CHILDREN=8
// that yields 4 000 per child (81% coverage) versus the old 1 200 (35%).
//
// MAX_DISPLAY_SUMMARY_CHARS is the TUI-only cap; it is applied both at send
// time (structuredDetails.resultPreview) and at render time so a larger content
// string does not produce a wall of text in the terminal.
export const MAX_COMPLETION_MESSAGE_CHARS = 32_000;
const MAX_DISPLAYED_CHILDREN = 8;
// Cap on simultaneous-completion entries shown in a grouped notice. Bounds both the
// assembled message size and the reserved scaffolding so those fixed costs never
// exceed the ceiling regardless of how many completions batch together.
const MAX_GROUPED_ENTRIES = 8;
const MAX_SUMMARY_CHARS = 8_000;
export const MAX_DISPLAY_SUMMARY_CHARS = 1_200;
// Overflow floor: the guarantee that a child is never starved below ~60%
// coverage when a wide fan-out forces the equal-share fallback.
const MIN_PER_CHILD_SUMMARY_CHARS = 2_000;
const MAX_REFERENCE_CHARS = 500;
const MAX_NESTED_ENTRIES = 8;
const MAX_NESTED_DEPTH = 2;
const MAX_LABEL_CHARS = 160;
const MAX_ASYNC_ID_CHARS = 200;
const MAX_SESSION_PATH_CHARS = 4_096;

interface NestedNotifyChild {
	id?: string;
	agent?: string;
	state?: string;
	children?: NestedNotifyChild[];
}

interface ChainStepResult {
	agent: string;
	output?: string;
	success?: boolean;
	status?: "completed" | "failed" | "paused" | "detached";
	summary?: string;
	artifactPath?: string;
	sessionPath?: string;
	index?: number;
	children?: NestedNotifyChild[];
}

interface ResumeTarget {
	sessionPath: string;
	index?: number;
	childCount?: number;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "paused";
	taskInfo?: string;
	resultPreview: string;
	durationMs?: number;
	asyncId?: string;
	resumeTarget?: ResumeTarget;
	sessionLabel?: string;
	sessionValue?: string;
	awaitingSupervisor?: boolean;
}

interface SubagentResult {
	id: string | null;
	runId?: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	exitCode?: number;
	state?: string;
	timestamp: number;
	durationMs?: number;
	cwd?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
	sessionId?: string | null;
}

interface NotifyTimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RegisterSubagentNotifyOptions {
	batchConfig?: CompletionBatchConfig;
	timers?: NotifyTimerApi;
	now?: () => number;
}

function truncateWithMarker(value: string, maxChars: number, marker: string): string {
	if (value.length <= maxChars) return value;
	if (marker.length >= maxChars) return marker.slice(0, maxChars);
	return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function boundedSummary(value: string, maxChars: number): string {
	return truncateWithMarker(value, maxChars, "… [summary truncated]");
}

/**
 * Per-child summary budget for the grouped shape.
 *
 * Every displayed child gets the full MAX_SUMMARY_CHARS budget in the normal
 * case — a child's report must not shrink merely because it has siblings. Only
 * when a wide fan-out would push collective summary text past the ceiling do we
 * fall back to an equal share, floored at MIN_PER_CHILD_SUMMARY_CHARS.
 */
function resolvePerChildSummaryBudget(displayedChildCount: number): number {
	const count = Math.max(displayedChildCount, 1);
	if (count * MAX_SUMMARY_CHARS <= MAX_COMPLETION_MESSAGE_CHARS) return MAX_SUMMARY_CHARS;
	return Math.max(Math.floor(MAX_COMPLETION_MESSAGE_CHARS / count), MIN_PER_CHILD_SUMMARY_CHARS);
}

export function boundedReference(value: string): string {
	return truncateWithMarker(value, MAX_REFERENCE_CHARS, "… [reference truncated]");
}

function boundedLabel(value: string): string {
	return truncateWithMarker(value, MAX_LABEL_CHARS, "… [label truncated]");
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	const value = boundedReference(details.sessionValue);
	return details.sessionLabel ? `${details.sessionLabel}: ${value}` : value;
}

function hasUnsafeIdentifierCharacters(value: string): boolean {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
	});
}

function normalizeAsyncIdentifier(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.trim() === "" || value.length > MAX_ASYNC_ID_CHARS || hasUnsafeIdentifierCharacters(value))
		return undefined;
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) return undefined;
	return value;
}

function formatAsyncIdLine(details: SubagentNotifyDetails): string | undefined {
	const asyncId = normalizeAsyncIdentifier(details.asyncId);
	return asyncId ? `Async id: ${asyncId}` : undefined;
}

function formatResumeLine(details: SubagentNotifyDetails): string | undefined {
	const asyncId = normalizeAsyncIdentifier(details.asyncId);
	const target = details.resumeTarget;
	if (!asyncId || !target || !hasExistingSessionFile(target.sessionPath)) return undefined;
	if (target.index !== undefined) {
		if (
			typeof target.childCount !== "number" ||
			!Number.isInteger(target.childCount) ||
			!isValidChildIndex(target.index, target.childCount)
		)
			return undefined;
	}
	const idLiteral = JSON.stringify(asyncId);
	return target.index === undefined
		? `Revive: subagent({ action: "resume", id: ${idLiteral}, message: "..." })`
		: `Revive child: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "..." })`;
}

function formatPausedSupervisorActionLines(details: SubagentNotifyDetails): string[] {
	const asyncId = normalizeAsyncIdentifier(details.asyncId);
	const target = details.resumeTarget;
	if (!details.awaitingSupervisor || !asyncId || !target || !hasExistingSessionFile(target.sessionPath)) return [];
	const idLiteral = JSON.stringify(asyncId);
	if (target.index === undefined) {
		return [
			"No child process is running.",
			`Resume unchanged: subagent({ action: "resume", id: ${idLiteral} })`,
			`Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, message: "Supervisor replied: ..." })`,
			`Cancel: subagent({ action: "interrupt", id: ${idLiteral} })`,
		];
	}
	if (
		typeof target.childCount !== "number" ||
		!Number.isInteger(target.childCount) ||
		!isValidChildIndex(target.index, target.childCount)
	)
		return [];
	return [
		"No child process is running.",
		`Resume unchanged: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index} })`,
		`Resume with guidance: subagent({ action: "resume", id: ${idLiteral}, index: ${target.index}, message: "Supervisor replied: ..." })`,
		`Cancel: subagent({ action: "interrupt", id: ${idLiteral}, index: ${target.index} })`,
	];
}

function normalizeSessionPath(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_PATH_CHARS ? value : undefined;
}

function hasExistingSessionFile(value: unknown): value is string {
	const sessionPath = normalizeSessionPath(value);
	return sessionPath !== undefined && fs.existsSync(sessionPath);
}

function resolveAsyncIdentifier(result: SubagentResult): string | undefined {
	return normalizeAsyncIdentifier(result.id) ?? normalizeAsyncIdentifier(result.runId);
}

function isValidChildIndex(value: unknown, childCount: number): value is number {
	return (
		typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value < childCount
	);
}

function resolveResumeTarget(result: SubagentResult, asyncId: string | undefined): ResumeTarget | undefined {
	if (!asyncId) return undefined;
	const children = Array.isArray(result.results) ? result.results : [];
	if (children.length <= 1) {
		const sessionPath = normalizeSessionPath(children[0]?.sessionPath ?? result.sessionFile);
		return sessionPath && fs.existsSync(sessionPath) ? { sessionPath } : undefined;
	}
	const statusPriority: Array<NonNullable<ChainStepResult["status"]>> = ["failed", "paused", "completed", "detached"];
	const resumableChild = statusPriority
		.map((status) =>
			children.find(
				(child) =>
					resolveChildStatus(child) === status &&
					isValidChildIndex(child.index, children.length) &&
					hasExistingSessionFile(child.sessionPath),
			),
		)
		.find((child) => child !== undefined);
	const sessionPath = normalizeSessionPath(resumableChild?.sessionPath);
	if (!resumableChild || sessionPath === undefined || !isValidChildIndex(resumableChild.index, children.length))
		return undefined;
	return { sessionPath, index: resumableChild.index, childCount: children.length };
}

function resolveChildStatus(child: ChainStepResult): NonNullable<ChainStepResult["status"]> {
	return child.status ?? (child.success === false ? "failed" : "completed");
}

function resolveOuterStatus(result: SubagentResult): SubagentNotifyDetails["status"] {
	const summary = typeof result.summary === "string" ? result.summary : "";
	const paused =
		result.state === "paused" ||
		(result.state !== "failed" &&
			!result.success &&
			(result.exitCode === 0 || summary.startsWith("Paused after interrupt.")));
	if (paused) return "paused";
	if (!result.success || result.state === "failed" || (typeof result.exitCode === "number" && result.exitCode !== 0))
		return "failed";
	return "completed";
}

function countChildStatuses(children: ChainStepResult[]): string | undefined {
	if (children.length <= 1) return undefined;
	const counts = new Map<string, number>();
	for (const child of children) {
		const key = resolveChildStatus(child);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const ordered = ["completed", "failed", "paused", "detached"];
	const parts = ordered
		.map((status) => (counts.get(status) ? `${counts.get(status)} ${status}` : undefined))
		.filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : undefined;
}

interface NestedFormatBudget {
	remaining: number;
	omissionMarkers: Set<string>;
}

function formatNestedChildren(
	children: NestedNotifyChild[] | undefined,
	indent = "   ",
	budget: NestedFormatBudget = { remaining: MAX_NESTED_ENTRIES, omissionMarkers: new Set() },
): string[] {
	if (!children?.length) return [];
	const lines = ["Nested subagents:"];
	const markOmitted = (currentIndent: string, marker: string) => {
		if (budget.omissionMarkers.has(marker)) return;
		budget.omissionMarkers.add(marker);
		lines.push(`${currentIndent}${marker}`);
	};
	const append = (runs: NestedNotifyChild[] | undefined, currentIndent: string, depth: number) => {
		if (!runs?.length) return;
		if (depth >= MAX_NESTED_DEPTH) {
			markOmitted(currentIndent, "… [nested depth limit reached]");
			return;
		}
		for (const child of runs) {
			if (budget.remaining <= 0) {
				markOmitted(currentIndent, "… [additional nested entries omitted]");
				return;
			}
			budget.remaining--;
			const label = boundedLabel(child.agent ?? child.id ?? "nested");
			const state = child.state ? boundedLabel(child.state) : undefined;
			lines.push(`${currentIndent}↳ ${label}${state ? ` — ${state}` : ""}`);
			append(child.children, `${currentIndent}  `, depth + 1);
		}
	};
	append(children, indent, 0);
	return lines;
}

function formatChildReferences(child: ChainStepResult, privacySafe = false): string[] {
	if (privacySafe) return [];
	return [
		child.artifactPath ? `Output artifact: ${boundedReference(child.artifactPath)}` : undefined,
		child.sessionPath ? `Session: ${boundedReference(child.sessionPath)}` : undefined,
	].filter((line): line is string => Boolean(line));
}

function formatProtectedLifecyclePreview(result: SubagentResult): string {
	const children = Array.isArray(result.results) ? result.results : [];
	if (children.length <= 1) return "Paused awaiting supervisor.";
	const lines: string[] = [];
	const counts = countChildStatuses(children);
	if (counts) lines.push(`Children: ${counts}`, "");
	const displayedChildren = ["failed", "paused", "completed", "detached"]
		.flatMap((status) =>
			children
				.map((child, index) => ({ child, index, status: resolveChildStatus(child) }))
				.filter((entry) => entry.status === status),
		)
		.slice(0, MAX_DISPLAYED_CHILDREN);
	if (children.length > displayedChildren.length)
		lines.push(`… [${children.length - displayedChildren.length} child results omitted]`, "");
	for (const { child, index, status } of displayedChildren) {
		lines.push(`${index + 1}/${children.length}. ${boundedLabel(child.agent)} — ${status}`);
		lines.push(...formatNestedChildren(child.children, "   "));
		lines.push("");
	}
	return lines.join("\n").trimEnd() || "Paused awaiting supervisor.";
}

function formatResultPreview(result: SubagentResult): string {
	const privacySafe = isProtectedPausedLifecycle({
		state: result.state,
		pause: (result as { pause?: { kind?: string } }).pause,
	});
	if (privacySafe) return formatProtectedLifecyclePreview(result);
	const children = Array.isArray(result.results) ? result.results : [];
	const nestedBudget: NestedFormatBudget = { remaining: MAX_NESTED_ENTRIES, omissionMarkers: new Set() };
	if (children.length === 0)
		return boundedSummary(typeof result.summary === "string" ? result.summary : "", MAX_SUMMARY_CHARS);
	const outerFailureSummary =
		resolveOuterStatus(result) === "failed" && !children.some((child) => resolveChildStatus(child) === "failed")
			? boundedSummary(typeof result.summary === "string" ? result.summary : "", MAX_SUMMARY_CHARS)
			: "";
	if (children.length === 1) {
		const child = children[0]!;
		const childSummary = boundedSummary(
			child.summary ?? child.output ?? (outerFailureSummary ? "" : (result.summary ?? "")),
			MAX_SUMMARY_CHARS,
		);
		const lines = outerFailureSummary ? [outerFailureSummary, "", childSummary || "(no output)"] : [childSummary];
		lines.push(...formatChildReferences(child, privacySafe));
		lines.push(...formatNestedChildren(child.children, "   ", nestedBudget));
		return lines.join("\n").trim();
	}
	const lines: string[] = [];
	if (outerFailureSummary) lines.push(outerFailureSummary, "");
	const counts = countChildStatuses(children);
	if (counts) lines.push(`Children: ${counts}`, "");
	const displayedChildren = ["failed", "paused", "completed", "detached"]
		.flatMap((status) =>
			children
				.map((child, index) => ({ child, index, status: resolveChildStatus(child) }))
				.filter((entry) => entry.status === status),
		)
		.slice(0, MAX_DISPLAYED_CHILDREN);
	// Each displayed child gets the full per-child budget. Only when a wide fan-out
	// would push the collective summary text past the ceiling do we fall back to an
	// equal share, floored so no child is starved.
	// n=1,2,4 -> 8 000 each; n=8 -> 4 000 each.
	const perChildBudget = resolvePerChildSummaryBudget(displayedChildren.length);
	if (children.length > displayedChildren.length) {
		lines.push(`… [${children.length - displayedChildren.length} child results omitted]`, "");
	}
	for (const { child, index, status } of displayedChildren) {
		lines.push(`${index + 1}/${children.length}. ${boundedLabel(child.agent)} — ${status}`);
		lines.push(boundedSummary((child.summary ?? child.output ?? "").trim(), perChildBudget) || "(no output)");
		lines.push(...formatChildReferences(child, privacySafe));
		lines.push(...formatNestedChildren(child.children, "   ", nestedBudget));
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

/**
 * Character cost of a set of lines once joined with newlines, counted
 * conservatively (one extra char per line) so reserved space is never undersized.
 */
function joinedLineCost(lines: string[]): number {
	return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * Size a preview so the assembled message fits MAX_COMPLETION_MESSAGE_CHARS with the
 * surrounding scaffolding — in particular the TRAILING reference/session lines — reserved.
 *
 * The final truncateWithMarker in sendCompletion cuts from the END of the assembled
 * message. Since the session/share line is emitted last, a naive end-cut destroys exactly
 * the recovery pointer the architect needs to go read the full output, converting a
 * "truncated but recoverable" notice into a "truncated and unrecoverable" one. Reserving
 * the tail and shrinking the preview body instead keeps those pointers intact, which is
 * what makes an aggressive per-child summary budget safe.
 */
function fitPreviewWithinCeiling(preview: string, reservedChars: number, ceiling: number): string {
	const available = ceiling - reservedChars;
	if (preview.length <= available) return preview;
	return boundedSummary(preview, Math.max(available, 0));
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const asyncIdLine = formatAsyncIdLine(details);
	const resumeLine = formatResumeLine(details);
	const pausedSupervisorActionLines = formatPausedSupervisorActionLines(details);
	const sessionLine = formatSessionLine(details);
	const headLines = [
		`Background task ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		asyncIdLine,
		...(pausedSupervisorActionLines.length > 0 ? pausedSupervisorActionLines : [resumeLine]),
		asyncIdLine || pausedSupervisorActionLines.length > 0 || resumeLine ? "" : undefined,
	].filter((line): line is string => line !== undefined);
	const tailLines = [sessionLine ? "" : undefined, sessionLine].filter((line): line is string => line !== undefined);
	const preview = fitPreviewWithinCeiling(
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
		joinedLineCost(headLines) + joinedLineCost(tailLines),
		MAX_COMPLETION_MESSAGE_CHARS,
	);
	return [...headLines, preview, ...tailLines].join("\n");
}

export function formatGroupedCompletion(details: SubagentNotifyDetails[]): string {
	// Cap displayed entries so reserved scaffolding always fits within the ceiling and the
	// assembled message remains bounded regardless of how many completions batch together.
	const displayedDetails = details.slice(0, MAX_GROUPED_ENTRIES);
	const omittedCount = details.length - displayedDetails.length;
	const omissionMarker = omittedCount > 0 ? `… [${omittedCount} entries omitted]` : null;
	const header = `Background tasks completed (${details.length}): ${displayedDetails.map((d) => `**${d.agent}**${d.taskInfo ?? ""}`).join(", ")}`;
	// Reserve every entry's scaffolding — including each trailing session line — before
	// sizing previews, so an over-ceiling grouped notice loses preview body rather than the
	// per-entry recovery pointers.
	const entries = displayedDetails
		.map((detail, index) => {
			if (!detail) return undefined;
			const asyncIdLine = formatAsyncIdLine(detail);
			const resumeLine = formatResumeLine(detail);
			const pausedSupervisorActionLines = formatPausedSupervisorActionLines(detail);
			const sessionLine = formatSessionLine(detail);
			const headLines = [
				`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}`,
				...(asyncIdLine ? [asyncIdLine] : []),
				...(pausedSupervisorActionLines.length > 0 ? pausedSupervisorActionLines : resumeLine ? [resumeLine] : []),
			];
			const tailLines = [...(sessionLine ? [sessionLine] : []), ""];
			return { detail, headLines, tailLines };
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
	const reservedChars =
		joinedLineCost([header, ""]) +
		(omissionMarker ? joinedLineCost([omissionMarker, ""]) : 0) +
		entries.reduce((total, entry) => total + joinedLineCost(entry.headLines) + joinedLineCost(entry.tailLines), 0);
	// Distribute the remaining ceiling evenly across entries so one verbose entry cannot
	// starve the rest.
	//
	// Each preview block in blocks.join("\n") contributes one \n separator that reservedChars
	// does not account for (headLines/tailLines costs are covered, but the preview-adjacent
	// separator is not). Total unaccounted = entries.length - 2, the -2 for trimEnd removing
	// the trailing \n from the final empty-string block. Subtracting this before dividing
	// ensures the assembled string is always <= MAX_COMPLETION_MESSAGE_CHARS exactly.
	const previewSeparatorCost = Math.max(entries.length - 2, 0);
	const previewCeiling = Math.max(
		Math.floor((MAX_COMPLETION_MESSAGE_CHARS - reservedChars - previewSeparatorCost) / Math.max(entries.length, 1)),
		0,
	);
	const blocks: string[] = [header, ""];
	if (omissionMarker) {
		blocks.push(omissionMarker, "");
	}
	for (const entry of entries) {
		blocks.push(...entry.headLines);
		blocks.push(
			fitPreviewWithinCeiling(
				entry.detail.resultPreview.trim() ? entry.detail.resultPreview : "(no output)",
				0,
				previewCeiling,
			),
		);
		blocks.push(...entry.tailLines);
	}
	return blocks.join("\n").trimEnd();
}

const NUDGE_TEXT = BACKGROUND_COMPLETION_NUDGE_TEXT;

function sendCompletion(
	pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">,
	details: SubagentNotifyDetails[],
	options: { triggerTurn: boolean; isIdle?: () => boolean } = { triggerTurn: true },
): void {
	if (details.length === 0) return;
	const formatted = details.length === 1 ? formatSingleCompletion(details[0]!) : formatGroupedCompletion(details);
	const content = truncateWithMarker(formatted, MAX_COMPLETION_MESSAGE_CHARS, "\n… [completion message truncated]");
	const structuredDetails =
		details.length === 1
			? {
					...details[0]!,
					resultPreview: boundedSummary(details[0]!.resultPreview, MAX_DISPLAY_SUMMARY_CHARS),
					...(details[0]!.sessionValue ? { sessionValue: boundedReference(details[0]!.sessionValue) } : {}),
					...(details[0]!.awaitingSupervisor && details[0]!.resumeTarget
						? {
								resumeTarget: {
									...(details[0]!.resumeTarget.index !== undefined ? { index: details[0]!.resumeTarget.index } : {}),
									...(details[0]!.resumeTarget.childCount !== undefined
										? { childCount: details[0]!.resumeTarget.childCount }
										: {}),
								},
							}
						: {}),
				}
			: undefined;
	pi.sendMessage({
		customType: "subagent-notify",
		content,
		display: true,
		...(structuredDetails ? { details: structuredDetails } : {}),
	});
	// When the parent is idle and a turn is expected, wake the agent through
	// prompt() so before_agent_start fires and the TLH system prompt is
	// restored. deliverAs:'followUp' is safe under a streaming race: it
	// queues a benign followUp rather than throwing. When streaming, or during
	// a lifecycle flush (triggerTurn:false), the custom message alone is
	// sufficient — Pi steers a streaming turn, and the shutdown path sends no
	// new turn. Idleness is read live at send time; when no session context
	// has been captured yet, assume idle (the nudge degrades to a benign
	// followUp if that assumption is wrong).
	if (options.triggerTurn && (options.isIdle?.() ?? true)) {
		pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
	}
}

function completionBatchKey(result: SubagentResult): string {
	const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
	if (sessionId) return `session:${sessionId}`;
	const cwd = typeof result.cwd === "string" ? result.cwd.trim() : "";
	return cwd ? `cwd:${cwd}` : "unknown";
}

function resolveCompletionStatus(result: SubagentResult): SubagentNotifyDetails["status"] {
	const children = Array.isArray(result.results) ? result.results : [];
	if (children.length > 0) {
		const statuses = children.map(resolveChildStatus);
		if (statuses.includes("failed")) return "failed";
		const outerStatus = resolveOuterStatus(result);
		if (outerStatus === "failed") return "failed";
		if (statuses.includes("paused") || outerStatus === "paused") return "paused";
		if (statuses.includes("completed")) return "completed";
		// Native notices have no detached terminal label. Treat an all-detached
		// grouped result as failed so it receives immediate attention rather than
		// entering successful-completion batching.
		return "failed";
	}

	return resolveOuterStatus(result);
}

export function buildCompletionDetails(result: SubagentResult): SubagentNotifyDetails {
	const agent = boundedLabel(result.agent ?? "unknown");
	const status = resolveCompletionStatus(result);

	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: undefined;

	const hasNormalizedChildResults = Array.isArray(result.results) && result.results.length > 0;
	const privacySafe = isProtectedPausedLifecycle({
		state: result.state,
		pause: (result as { pause?: { kind?: string } }).pause,
	});
	const session = privacySafe
		? undefined
		: result.shareUrl
			? { label: "Session", value: result.shareUrl }
			: result.shareError
				? { label: "Session share error", value: result.shareError }
				: !hasNormalizedChildResults && result.sessionFile
					? { label: "Session file", value: result.sessionFile }
					: undefined;

	const asyncId = resolveAsyncIdentifier(result);
	const resumeTarget = resolveResumeTarget(result, asyncId);

	return {
		agent,
		status,
		...(taskInfo ? { taskInfo } : {}),
		resultPreview: formatResultPreview(result),
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(asyncId ? { asyncId } : {}),
		...(resumeTarget ? { resumeTarget } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
		...(result.state === "paused" && (result as { pause?: { kind?: string } }).pause?.kind === "awaiting_supervisor"
			? { awaitingSupervisor: true }
			: {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "currentSessionId">,
	options: RegisterSubagentNotifyOptions = {},
): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const batcherStoreKey = "__pi_subagents_notify_batcher__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}
	const previousBatcher = globalStore[batcherStoreKey];
	if (previousBatcher && typeof (previousBatcher as { dispose?: () => void }).dispose === "function") {
		try {
			(previousBatcher as { dispose: () => void }).dispose();
		} catch {
			// Best effort cleanup for a stale batcher from an older reload.
		}
	}

	// Capture a session context so idleness can be read live at send time.
	// Context methods are closures over the runner, so a context captured once
	// keeps returning current state. A hand-rolled streaming flag would stick
	// if prompt() threw between before_agent_start and the run starting,
	// silently suppressing every future nudge.
	let sessionContext: Pick<ExtensionContext, "isIdle"> | null = null;
	const isIdle = () => sessionContext?.isIdle() ?? true;
	pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
	});

	// Ensures at most one nudge per synchronous delivery burst: when a
	// non-completion signal flushes held successes and then emits itself, only
	// the trailing (unconditional) sendCompletion carries the nudge.
	let suppressFlushNudge = false;

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;
	const nowFn = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
	const batchers = new Map<string, { ownerSessionId: string; batcher: CompletionBatcher<SubagentNotifyDetails> }>();
	let shuttingDownSessionId: string | null = null;
	globalStore[batcherStoreKey] = {
		dispose() {
			for (const entry of batchers.values()) entry.batcher.dispose();
			batchers.clear();
		},
	};

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		if (typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return;
		const now = nowFn();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const details = buildCompletionDetails(result);
		const batchKey = completionBatchKey(result);
		let batcherEntry = batchers.get(batchKey);
		if (!batcherEntry) {
			const ownerSessionId = result.sessionId;
			const batcher = createCompletionBatcher<SubagentNotifyDetails>({
				config: batchConfig,
				emit: (items) => {
					const lifecycleFlush = shuttingDownSessionId === ownerSessionId;
					if (state.currentSessionId !== ownerSessionId && !lifecycleFlush) {
						batchers.delete(batchKey);
						return;
					}
					sendCompletion(pi, items, { triggerTurn: !lifecycleFlush && !suppressFlushNudge, isIdle });
				},
				...(options.timers ? { timers: options.timers } : {}),
				now: nowFn,
			});
			batcherEntry = { ownerSessionId, batcher };
			batchers.set(batchKey, batcherEntry);
		}
		if (details.status !== "completed") {
			// Failures and paused runs bypass grouping. Flush any held
			// successes for the same owner first so they are not stranded
			// behind this signal, then emit the non-completion result immediately.
			// The flush's nudge is suppressed so the burst produces exactly one
			// nudge, carried by the unconditional sendCompletion below.
			suppressFlushNudge = true;
			try {
				batcherEntry.batcher.flush();
			} finally {
				suppressFlushNudge = false;
			}
			sendCompletion(pi, [details], { triggerTurn: true, isIdle });
			return;
		}
		batcherEntry.batcher.push(details);
	};

	pi.on("session_shutdown", () => {
		const ownerSessionId = state.currentSessionId;
		if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0) {
			for (const entry of batchers.values()) entry.batcher.dispose();
			batchers.clear();
			return;
		}
		shuttingDownSessionId = ownerSessionId;
		try {
			for (const [key, entry] of batchers) {
				if (entry.ownerSessionId !== ownerSessionId) {
					entry.batcher.dispose();
					batchers.delete(key);
					continue;
				}
				entry.batcher.flush();
			}
		} finally {
			shuttingDownSessionId = null;
			for (const entry of batchers.values()) entry.batcher.dispose();
			batchers.clear();
		}
	});

	globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
