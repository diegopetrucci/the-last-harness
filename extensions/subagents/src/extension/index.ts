/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), and management/control actions
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" } }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	CONFIG_DIR_NAME,
	defineTool,
	getAgentDir,
	keyText,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Spacer,
	Text,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { cleanupOldChainDirs } from "../shared/settings.ts";
import { handlePauseAllShortcut } from "./pause-all-shortcut.ts";
import { handleSubagentLiveDetailShortcut } from "./live-detail-shortcut.ts";
import {
	externalSubagentCoexistenceWarning,
	findConfiguredExternalSubagentPackages,
} from "./external-package-guard.ts";
import { cleanupRuntimeDirs } from "./runtime-cleanup.ts";
import {
	createSubagentLiveDetailController,
	SUBAGENT_LIVE_DETAIL_SHORTCUT,
	SUBAGENT_PAUSE_ALL_SHORTCUT,
	type SubagentLiveDetailController,
} from "../shared/subagent-shortcuts.ts";
import { clearLegacyResultAnimationTimer, renderWidget, renderSubagentResult } from "../tui/render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import {
	clearSlashSnapshots,
	getSlashRenderableSnapshot,
	resolveSlashMessageDetails,
	restoreSlashFinalSnapshots,
	type SlashMessageDetails,
} from "../slash/slash-live-state.ts";
import registerSubagentNotify, {
	boundedReference,
	MAX_DISPLAY_SUMMARY_CHARS,
	type SubagentNotifyDetails,
} from "../runs/background/notify.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/pi-args.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { loadConfig } from "./config.ts";
import { buildSubagentToolDescription } from "./tool-description.ts";
import {
	type Details,
	type SubagentState,
	type SubagentToolResult,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "../shared/types.ts";
import {
	clearPendingForegroundControlNotices,
	formatSubagentControlNotice,
	handleSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.ts";

export { loadConfig } from "./config.ts";

type PiToolWithInternalFailure = "subagent";

/**
 * Pi 0.83 represents tool failure separately from AgentToolResult. Keep the
 * extension's rich internal result until execute() returns, then strip the
 * private flag and restore it through the supported tool_result patch hook.
 */
export function createSubagentToolResultBridge() {
	const failedResults = new Map<string, { toolName: PiToolWithInternalFailure; details: unknown }>();

	return {
		normalize<T>(
			toolCallId: string,
			toolName: PiToolWithInternalFailure,
			result: SubagentToolResult<T>,
		): AgentToolResult<T> {
			const { isError, ...normalized } = result;
			if (isError === true) failedResults.set(toolCallId, { toolName, details: normalized.details });
			else failedResults.delete(toolCallId);
			return normalized;
		},
		errorPatch(toolCallId: string, toolName: string, details: unknown): { isError: true } | undefined {
			const failed = failedResults.get(toolCallId);
			if (!failed || failed.toolName !== toolName) return undefined;
			failedResults.delete(toolCallId);
			return failed.details === details ? { isError: true } : undefined;
		},
		clear(): void {
			failedResults.clear();
		},
	};
}

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort: retry mkdir/access even if cleanup fails.
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}

function isSlashResultRunning(result: { details?: Details }): boolean {
	return (
		result.details?.progress?.some((entry) => entry.status === "running") ||
		result.details?.results.some((entry) => entry.progress?.status === "running") ||
		false
	);
}

// Drives the inline running-indicator braille animation for foreground subagent
// results. Foreground runs receive progress only on child events, so the glyph
// (derived from progress fields) would freeze between events. While a result is
// running we tick a frame counter + invalidate() every 80ms so renderSubagentResult
// can blend the frame into runningGlyph and produce a smooth spinner.
function subagentResultIsRunning(result: { details?: Details }): boolean {
	return (
		result.details?.progress?.some((entry) => entry.status === "running") ||
		result.details?.results.some((entry) => entry.progress?.status === "running") ||
		false
	);
}

function ensureSubagentResultAnimation(context: { state: Record<string, unknown>; invalidate?: () => void }): void {
	const state = context.state as { subagentResultAnimationTimer?: ReturnType<typeof setInterval>; frame?: number };
	if (state.subagentResultAnimationTimer) return;
	if (typeof context.invalidate !== "function") return;
	if (state.frame === undefined) state.frame = 0;
	state.subagentResultAnimationTimer = setInterval(() => {
		state.frame = ((state.frame ?? 0) + 1) % 10;
		try {
			context.invalidate?.();
		} catch {
			void 0;
		}
	}, 80);
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Extension context no longer active");
}

function rebuildSlashResultContainer(
	container: Container,
	result: SubagentToolResult<Details>,
	expanded: boolean,
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result)
		? "toolPendingBg"
		: isSlashResultError(result)
			? "toolErrorBg"
			: "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, { expanded }, theme));
	container.addChild(box);
}

export function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	liveDetailController?: SubagentLiveDetailController,
): Container {
	const container = new Container();
	let lastVersion = -1;
	let lastExpanded = options.expanded;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		const isRunning = isSlashResultRunning(snapshot.result);
		const expanded = liveDetailController?.isExpanded() ?? options.expanded;
		if (snapshot.version !== lastVersion || isRunning || expanded !== lastExpanded) {
			lastVersion = snapshot.version;
			lastExpanded = expanded;
			rebuildSlashResultContainer(container, snapshot.result, expanded, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

interface ParsedSubagentNotifyContent {
	details: SubagentNotifyDetails;
	referenceLines: string[];
}

function parseSubagentNotifyContent(content: string): ParsedSubagentNotifyContent | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const referenceLines: string[] = [];
	if (/^Async id:\s+\S/.test(resultLines[0] ?? "")) {
		referenceLines.push(resultLines.shift()!);
		if (/^Revive(?: child)?:\s+subagent\(/.test(resultLines[0] ?? "")) {
			referenceLines.push(resultLines.shift()!);
		}
		if (resultLines[0]?.trim() === "") resultLines.shift();
	}
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = boundedReference(sessionLine.slice(separator + 1).trim());
	}
	return {
		details: {
			agent: match[2]!,
			status: match[1] as SubagentNotifyDetails["status"],
			...(match[3] ? { taskInfo: match[3] } : {}),
			resultPreview,
			...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
		},
		referenceLines,
	};
}

class SubagentControlNoticeComponent implements Component {
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];

	constructor(details: SubagentControlMessageDetails, theme: ExtensionContext["ui"]["theme"]) {
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, width - 2);
		const borderChar = "─";
		const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] === "1") {
		return;
	}

	const externalPackages = findConfiguredExternalSubagentPackages({
		agentDir: getAgentDir(),
		cwd: process.cwd(),
		configDirName: CONFIG_DIR_NAME,
	});
	if (externalPackages.length > 0) {
		const warning = externalSubagentCoexistenceWarning(externalPackages);
		let warned = false;
		pi.on("session_start", (_event, ctx) => {
			if (warned) return;
			warned = true;
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			if (!ctx.hasUI || ctx.mode === "rpc") process.stderr.write(`${warning}\n`);
		});
		return;
	}

	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();
	cleanupRuntimeDirs();

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	const liveDetailController = createSubagentLiveDetailController();

	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		subagentInProgress: false,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		liveDetailController,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
	const toolResultBridge = createSubagentToolResultBridge();

	const toggleLiveDetail = (ctx: ExtensionContext): void => {
		handleSubagentLiveDetailShortcut(liveDetailController, ctx, () =>
			renderWidget(ctx, Array.from(state.asyncJobs.values()), liveDetailController),
		);
	};
	let liveDetailTerminalInputUnsubscribe: (() => void) | null = null;
	const removeLiveDetailTerminalInput = (): void => {
		const unsubscribe = liveDetailTerminalInputUnsubscribe;
		liveDetailTerminalInputUnsubscribe = null;
		if (!unsubscribe) return;
		try {
			unsubscribe();
		} catch {
			// Pi may already have cleared extension listeners while resetting its UI.
		}
	};
	const installLiveDetailTerminalInput = (ctx: ExtensionContext): void => {
		removeLiveDetailTerminalInput();
		if (!ctx.hasUI || typeof ctx.ui.onTerminalInput !== "function") return;
		// Raw listeners run before Pi's hard-coded Ctrl+Shift+D debug handler.
		// Consuming the match also prevents downstream shortcut dispatch from toggling twice.
		liveDetailTerminalInputUnsubscribe = ctx.ui.onTerminalInput((input) => {
			if (!matchesKey(input, SUBAGENT_LIVE_DETAIL_SHORTCUT)) return undefined;
			if (!isKeyRelease(input)) toggleLiveDetail(ctx);
			return { consume: true };
		});
	};

	const supervisorChannel = createNativeSupervisorChannel(pi, state);
	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	const runtimeCleanup = () => {
		removeLiveDetailTerminalInput();
		liveDetailController.clearToolRows();
		toolResultBridge.clear();
		stopResultWatcher();
		supervisorChannel.dispose();
		clearPendingForegroundControlNotices(state);
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs } = createAsyncJobTracker(
		pi,
		state,
		ASYNC_DIR,
	);
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, liveDetailController);
	});

	pi.registerMessageRenderer<undefined>(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((entry) => entry.type === "text")
						.map((entry) => entry.text)
						.join("\n");
		return new Text(content, 0, 0);
	});

	pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const parsedContent = parseSubagentNotifyContent(content);
		const structuredDetails = message.details as SubagentNotifyDetails | undefined;
		const parsedSession =
			parsedContent?.details.sessionLabel && parsedContent.details.sessionValue
				? { sessionLabel: parsedContent.details.sessionLabel, sessionValue: parsedContent.details.sessionValue }
				: undefined;
		// Bound the parsed content preview at render time so that a larger content
		// string (model-facing) does not produce a wall of text in the TUI.
		const rawParsedPreview = parsedContent?.details.resultPreview;
		const displayPreview =
			rawParsedPreview !== undefined
				? rawParsedPreview.length <= MAX_DISPLAY_SUMMARY_CHARS
					? rawParsedPreview
					: `${rawParsedPreview.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`
				: undefined;
		const details = structuredDetails
			? {
					...structuredDetails,
					resultPreview: displayPreview ?? structuredDetails.resultPreview,
					...(structuredDetails.sessionValue ? { sessionValue: boundedReference(structuredDetails.sessionValue) } : {}),
					...parsedSession,
				}
			: parsedContent?.details
				? { ...parsedContent.details, resultPreview: displayPreview ?? parsedContent.details.resultPreview }
				: undefined;
		// Fallback for content the parser cannot handle (e.g. grouped notices whose
		// header does not match the singular-completion regex, or future header shapes).
		// Bound display to MAX_DISPLAY_SUMMARY_CHARS so any unparsed content—regardless of
		// the model-facing envelope size—does not produce a wall of text in the TUI.
		if (!details) {
			const displayContent =
				content.length <= MAX_DISPLAY_SUMMARY_CHARS
					? content
					: `${content.slice(0, MAX_DISPLAY_SUMMARY_CHARS - "… [preview truncated]".length)}… [preview truncated]`;
			return new Text(displayContent, 0, 0);
		}
		const referenceLines = parsedContent?.referenceLines ?? [];
		const icon =
			details.status === "completed"
				? theme.fg("success", "✓")
				: details.status === "paused"
					? theme.fg("warning", "■")
					: theme.fg("error", "✗");
		const parts: string[] = [];
		if (details.taskInfo) parts.push(details.taskInfo);
		if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
		let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
		if (parts.length > 0)
			text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
		const trimmedPreview = details.resultPreview.trim();
		const previewLines = options.expanded
			? trimmedPreview.split("\n").filter((line) => line.trim())
			: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
		for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
			text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
		}
		if (options.expanded) {
			for (const line of referenceLines) {
				text += `\n  ${theme.fg("muted", line)}`;
			}
		} else if (trimmedPreview.includes("\n") || referenceLines.length > 0) {
			const expandKey = keyText("app.tools.expand");
			text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
		}
		if (details.sessionLabel && details.sessionValue) {
			text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer<SubagentControlMessageDetails>(
		SUBAGENT_CONTROL_MESSAGE_TYPE,
		(message, _options, theme) => {
			const details = message.details as SubagentControlMessageDetails | undefined;
			if (!details?.event) return undefined;
			const content = typeof message.content === "string" ? message.content : undefined;
			return new SubagentControlNoticeComponent(
				{ ...details, noticeText: formatSubagentControlNotice(details, content) },
				theme,
			);
		},
	);

	const executeSubagent = (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: SubagentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => {
		return executor.execute(id, params, signal, onUpdate, ctx);
	};

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) => executeSubagent(id, params, signal, onUpdate, ctx),
	});

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const parameters = SubagentParams;
	const tool = defineTool<typeof parameters, Details>({
		name: "subagent",
		label: "Subagent",
		description: buildSubagentToolDescription(config),
		parameters,

		async execute(id, params, signal, onUpdate, ctx) {
			if (!signal) throw new Error("Subagent tool execution requires an abort signal.");
			const result = await executeSubagent(id, params as SubagentParamsLike, signal, onUpdate, ctx);
			return toolResultBridge.normalize(id, "subagent", result);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0,
					0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})${asyncLabel}`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			// Pi gives the live ToolExecutionComponent and the HTML exporter separate,
			// stable renderer-state objects. Unknown states remain non-live for this render
			// and get one deferred probe: live rows re-enter and claim the controller after
			// container composition finishes, while export no-ops keep using expanded.
			const rendererState = context.state as unknown;
			const isLiveToolRow =
				state.lastUiContext?.hasUI === true &&
				Boolean(context.toolCallId) &&
				typeof rendererState === "object" &&
				rendererState !== null &&
				typeof context.invalidate === "function" &&
				liveDetailController.registerToolRow(context.toolCallId, rendererState, context.invalidate);
			if (subagentResultIsRunning(result) && isLiveToolRow) {
				ensureSubagentResultAnimation(context);
			} else {
				clearLegacyResultAnimationTimer(context);
			}
			const frame = (context.state as { frame?: number } | undefined)?.frame ?? 0;
			const expanded = isLiveToolRow ? liveDetailController.isExpanded() : options.expanded;
			return renderSubagentResult(
				{ ...result, ...(context.isError ? { isError: true } : {}) },
				{ expanded },
				theme,
				frame,
			);
		},
	});

	pi.registerTool(tool);
	pi.registerShortcut(SUBAGENT_LIVE_DETAIL_SHORTCUT, {
		description: "Toggle subagent live detail",
		handler: toggleLiveDetail,
	});
	pi.registerShortcut(SUBAGENT_PAUSE_ALL_SHORTCUT, {
		description: "Pause all running subagent work",
		handler: (ctx) => {
			handlePauseAllShortcut(state, ctx);
		},
	});

	registerSlashCommands(pi, state);

	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const controlNoticeSeenStoreKey = "__piSubagentVisibleControlNotices";
	const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
	if (Array.isArray(previousEventUnsubscribes)) {
		for (const unsubscribe of previousEventUnsubscribes) {
			if (typeof unsubscribe !== "function") continue;
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}
	registerSubagentNotify(pi, state, { batchConfig: config.completionBatch });

	const existingVisibleControlNotices = globalStore[controlNoticeSeenStoreKey];
	const visibleControlNotices =
		existingVisibleControlNotices instanceof Set ? (existingVisibleControlNotices as Set<string>) : new Set<string>();
	globalStore[controlNoticeSeenStoreKey] = visibleControlNotices;
	// Capture a session context so idleness can be read live at send time.
	// Mirrors the pattern in registerSubagentNotify (notify.ts): a hand-rolled
	// streaming flag would stick if prompt() threw between before_agent_start
	// and the run starting, silently suppressing every future nudge.
	let controlNoticeSessionContext: Pick<ExtensionContext, "isIdle"> | null = null;
	const isControlNoticeIdle = () => controlNoticeSessionContext?.isIdle() ?? true;
	const controlEventHandler = (payload: unknown) => {
		handleSubagentControlNotice({
			pi,
			state,
			visibleControlNotices,
			details: payload as SubagentControlMessageDetails,
			isIdle: isControlNoticeIdle,
		});
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		const errorPatch = toolResultBridge.errorPatch(event.toolCallId, event.toolName, event.details);
		if (ctx.hasUI) {
			state.lastUiContext = ctx;
			if (state.asyncJobs.size > 0) {
				renderWidget(ctx, Array.from(state.asyncJobs.values()), liveDetailController);
				ensurePoller();
			}
		}
		return errorPatch;
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		toolResultBridge.clear();
		state.baseCwd = ctx.cwd;
		state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		// Set PI_SUBAGENT_PARENT_SESSION for permission-system forwarding.
		// Only set in the root session (the interactive UI session), not in
		// child subagent processes — children inherit the parent's value
		// through the process environment at spawn time and must not overwrite
		// it with their own session identity.
		if (!process.env[SUBAGENT_CHILD_ENV]) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) {
				process.env[SUBAGENT_PARENT_SESSION_ENV] = sessionId;
			}
		}
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		clearPendingForegroundControlNotices(state);
		liveDetailController.clearToolRows();
		resetJobs(ctx);
		restoreActiveJobs(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
		primeExistingResults();
	};

	pi.on("session_start", (_event, ctx) => {
		controlNoticeSessionContext = ctx;
		removeLiveDetailTerminalInput();
		resetSessionState(ctx);
		installLiveDetailTerminalInput(ctx);
		supervisorChannel.start();
	});

	// Tree navigation and compaction rebuild ToolExecutionComponents with fresh
	// renderer state. Release old row identities before Pi renders the new chat.
	pi.on("session_tree", () => {
		liveDetailController.clearToolRows();
	});
	pi.on("session_compact", () => {
		liveDetailController.clearToolRows();
	});

	pi.on("session_shutdown", () => {
		removeLiveDetailTerminalInput();
		toolResultBridge.clear();
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
			delete globalStore[eventUnsubscribeStoreKey];
		}
		stopResultWatcher();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		clearPendingForegroundControlNotices(state);
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		liveDetailController.clearToolRows();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		supervisorChannel.dispose();
		if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
			delete globalStore[runtimeCleanupStoreKey];
		}
		try {
			if (state.lastUiContext?.hasUI) {
				state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
			}
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	});
}
