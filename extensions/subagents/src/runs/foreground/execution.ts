/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
	formatErrorWithOutput,
	synthesizeChildExitDiagnostic,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { buildSubagentSpawnEnv, getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { scheduleDeadline, type DeadlineTimer } from "../shared/deadline-timer.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir, getThinkingLevelDropNote } from "../shared/pi-args.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import {
	captureSingleOutputSnapshot,
	formatSavedOutputReference,
	injectOutputPathSystemPrompt,
	resolveSingleOutput,
	validateFileOnlyOutputMode,
	type SingleOutputSnapshot,
} from "../shared/single-output.ts";
import {
	buildFallbackModelList,
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
	sanitizeModelFallbackNotice,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import {
	acceptanceFailureMessage,
	appendAcceptanceReportDigest,
	buildSkippedAcceptanceLedger,
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";
import {
	appendTurnBudgetSystemPrompt,
	formatTurnBudgetOutput,
	initialTurnBudgetState,
	shouldAbortForTurnBudget,
	turnBudgetExceededMessage,
	turnBudgetSoftNote,
	turnBudgetState,
} from "../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { boundSupervisorSummary } from "../shared/lifecycle-state.ts";
import {
	FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
	formatForegroundSupervisorPauseMessage,
} from "../../shared/foreground-pause.ts";
import { resolveSupervisorChannelDir } from "../../intercom/native-supervisor-channel.ts";
import {
	cleanupOwnedProcessGroup,
	skipOwnedProcessGroupCleanup,
	supportsOwnedProcessGroupCleanup,
} from "../shared/process-group-cleanup.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();
const FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE =
	"Foreground pause process cleanup could not be confirmed. Status does not claim the child stopped.";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function formatTimeoutMessage(timeoutMs: number): string {
	return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveEffectiveSingleTimeout(
	callerTimeoutMs: number | undefined,
	agentTimeoutCeilingMs: number | undefined,
): number | undefined {
	if (callerTimeoutMs === undefined) return agentTimeoutCeilingMs;
	if (agentTimeoutCeilingMs === undefined) return callerTimeoutMs;
	return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}

function resolveEffectiveTimeoutDeadline(
	deadlineAt: number | undefined,
	timeoutMs: number | undefined,
): number | undefined {
	if (timeoutMs === undefined) return deadlineAt;
	const timeoutDeadlineAt = Date.now() + timeoutMs;
	if (deadlineAt === undefined) return timeoutDeadlineAt;
	return Math.min(deadlineAt, timeoutDeadlineAt);
}

const TIMEOUT_RECENT_OUTPUT_LINES = 5;
const TIMEOUT_RECENT_TOOLS = 3;
const TIMEOUT_LINE_MAX_CHARS = 160;

function truncateDiagnosticLine(value: string, maxChars = TIMEOUT_LINE_MAX_CHARS): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatTimeoutDiagnostics(
	result: SingleResult,
	options: RunSyncOptions,
	artifactPaths?: ArtifactPaths,
): string {
	const timeoutMessage = result.error ?? formatTimeoutMessage(options.timeoutMs ?? 0);
	const progress = result.progress;
	const details: string[] = [];
	const recentTools = progress?.recentTools.slice(-TIMEOUT_RECENT_TOOLS) ?? [];
	const recentOutput =
		progress?.recentOutput
			.filter((line) => typeof line === "string" && line.trim().length > 0)
			.slice(-TIMEOUT_RECENT_OUTPUT_LINES)
			.map((line) => truncateDiagnosticLine(line)) ?? [];

	if (options.runId) details.push(`Run id: ${options.runId}`);
	details.push(`Agent: ${result.agent}`);
	if (options.index !== undefined) details.push(`Child index: ${options.index}`);
	if (typeof progress?.durationMs === "number" && Number.isFinite(progress.durationMs)) {
		details.push(`Elapsed: ${progress.durationMs}ms`);
	}
	if (result.sessionFile) details.push(`Session file: ${result.sessionFile}`);
	if (options.artifactConfig?.includeOutput !== false && artifactPaths?.outputPath) {
		details.push(`Artifact output: ${artifactPaths.outputPath}`);
	}
	if (options.artifactConfig?.includeJsonl !== false && artifactPaths?.jsonlPath) {
		details.push(`Artifact jsonl: ${artifactPaths.jsonlPath}`);
	}
	if (progress?.activityState) details.push(`Activity: ${progress.activityState}`);
	if (progress?.currentTool) details.push(`Current tool: ${progress.currentTool}`);
	if (progress?.currentPath) details.push(`Current path: ${progress.currentPath}`);

	const sections = [timeoutMessage, "", "Recovery diagnostics:", ...details.map((detail) => `- ${detail}`)];
	if (recentTools.length > 0) {
		sections.push("", "Recent tools:");
		for (const tool of recentTools) {
			const suffix = tool.args ? ` ${truncateDiagnosticLine(tool.args)}` : "";
			sections.push(`- ${tool.tool}${suffix}`);
		}
	}
	if (recentOutput.length > 0) {
		sections.push("", "Recent child output:");
		for (const line of recentOutput) sections.push(`- ${line}`);
	}
	sections.push(
		"",
		"Recovery guidance:",
		"- Inspect the session/jsonl artifacts above for the full transcript.",
		"- Re-dispatch or resume the subagent after addressing the blocking tool, path, or workspace state.",
	);
	return sections.join("\n");
}

function resolveAttemptTimeout(
	options: RunSyncOptions,
): { timeoutMs: number; deadlineAt: number; remainingMs: number; message: string } | undefined {
	if (options.timeoutMs === undefined) return undefined;
	const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
	return {
		timeoutMs: options.timeoutMs,
		deadlineAt,
		remainingMs: Math.max(0, deadlineAt - Date.now()),
		message: formatTimeoutMessage(options.timeoutMs),
	};
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages:
			result.outputMode === "file-only" && result.savedOutputPath
				? undefined
				: result.messages
					? [...result.messages]
					: undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
					...attempt,
					usage: attempt.usage ? { ...attempt.usage } : undefined,
				}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

function findSupervisorRequestMetadata(input: {
	runId: string;
	agent: string;
	index: number;
	reason?: "need_decision" | "interview_request";
	requestedAt: number;
}): { requestId?: string; summary?: string } {
	try {
		const requestsDir = path.join(resolveSupervisorChannelDir(input.runId, input.agent, input.index), "requests");
		const files = readdirSync(requestsDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => path.join(requestsDir, name));
		for (const file of files) {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
				id?: unknown;
				runId?: unknown;
				agent?: unknown;
				childIndex?: unknown;
				reason?: unknown;
				message?: unknown;
				createdAt?: unknown;
			};
			if (parsed.runId !== input.runId || parsed.agent !== input.agent || parsed.childIndex !== input.index) continue;
			if (input.reason && parsed.reason !== input.reason) continue;
			const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : undefined;
			if (createdAt !== undefined && createdAt + 5_000 < input.requestedAt) continue;
			return {
				...(typeof parsed.id === "string" && parsed.id ? { requestId: parsed.id } : {}),
				...(boundSupervisorSummary(parsed.message) ? { summary: boundSupervisorSummary(parsed.message) } : {}),
			};
		}
	} catch {
		// Best-effort metadata capture only.
	}
	return {};
}

function resolveSupervisorPauseMetadata(input: {
	runId: string;
	agent: string;
	index: number;
	toolName: string;
	toolArgs: Record<string, unknown>;
	requestedAt: number;
}): SingleResult["pause"] | undefined {
	if (input.toolName === "intercom" && input.toolArgs.action === "ask") {
		const summary = boundSupervisorSummary(input.toolArgs.message);
		return {
			kind: "awaiting_supervisor",
			requestedAt: input.requestedAt,
			...(summary ? { summary } : {}),
			request: {
				tool: "intercom",
				action: "ask",
				...(summary ? { summary } : {}),
			},
		};
	}
	if (
		input.toolName === "contact_supervisor" &&
		(input.toolArgs.reason === "need_decision" || input.toolArgs.reason === "interview_request")
	) {
		const request = findSupervisorRequestMetadata({
			runId: input.runId,
			agent: input.agent,
			index: input.index,
			reason: input.toolArgs.reason,
			requestedAt: input.requestedAt,
		});
		const summary = request.summary ?? boundSupervisorSummary(input.toolArgs.message);
		return {
			kind: "awaiting_supervisor",
			requestedAt: input.requestedAt,
			...(summary ? { summary } : {}),
			request: {
				tool: "contact_supervisor",
				reason: input.toolArgs.reason,
				...(request.requestId ? { requestId: request.requestId } : {}),
				...(summary ? { summary } : {}),
			},
		};
	}
	return undefined;
}

function resolveResultSessionFile(result: SingleResult, options: RunSyncOptions, shareEnabled: boolean): void {
	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	const effectiveThinking = options.thinkingOverride ?? agent.thinking;
	const thinkingSuffixOptions = {
		availableModels: options.availableModels,
		preferredModelProvider: options.preferredModelProvider,
	};
	const thinkingDropNote = getThinkingLevelDropNote(
		model,
		effectiveThinking,
		options.thinkingOverride !== undefined,
		thinkingSuffixOptions,
	);
	if (thinkingDropNote && !shared.attemptNotes.includes(thinkingDropNote)) shared.attemptNotes.push(thinkingDropNote);
	const modelArg = applyThinkingSuffix(
		model,
		effectiveThinking,
		options.thinkingOverride !== undefined,
		thinkingSuffixOptions,
	);
	const {
		args,
		env: sharedEnv,
		tempDir,
	} = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model: modelArg,
		thinking: effectiveThinking,
		availableModels: options.availableModels,
		preferredModelProvider: options.preferredModelProvider,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		requireReadTool: Boolean(shared.resolvedSkillNames?.length),
		tools: agent.tools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		blockingSupervisorReplyPath: "unavailable",
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentSessionId: options.parentSessionId,
		structuredOutput: options.structuredOutput,
		steerInboxDir: options.steerInboxDir,
		toolBudget: options.toolBudget,
	});

	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		...(options.tkTicket ? { tkTicket: options.tkTicket } : {}),
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
		...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
		...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const attemptTimeout = resolveAttemptTimeout(options);
	if (attemptTimeout?.remainingMs === 0) {
		result.exitCode = 1;
		result.timedOut = true;
		result.error = attemptTimeout.message;
		result.finalOutput = attemptTimeout.message;
		progress.status = "failed";
		progress.error = attemptTimeout.message;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	const spawnEnv = buildSubagentSpawnEnv(process.env, sharedEnv, getSubagentDepthEnv(options.maxSubagentDepth));
	let observedMutationAttempt = false;
	let supervisorPauseRequested = false;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			...(ownsProcessGroup ? { detached: true } : {}),
		});
		// This id is owned only because it comes from the child spawned above in
		// this execution. Never reconstruct it from persisted lifecycle state.
		const processGroupId = ownsProcessGroup && typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : undefined;
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		let intercomStarted = false;
		let pendingSupervisorPause: SingleResult["pause"] | undefined;
		let assistantError: string | undefined;
		let supervisorPauseCleanupPromise: Promise<NonNullable<SingleResult["processCleanup"]>> | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: DeadlineTimer | undefined;
		let timeoutTerminationTimer: NodeJS.Timeout | undefined;
		let timeoutHardKillTimer: NodeJS.Timeout | undefined;
		let turnBudgetSoftReached = false;
		let turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
		let turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
		const clearTurnBudgetTimers = () => {
			if (turnBudgetTerminationTimer) {
				clearTimeout(turnBudgetTerminationTimer);
				turnBudgetTerminationTimer = undefined;
			}
			if (turnBudgetHardKillTimer) {
				clearTimeout(turnBudgetHardKillTimer);
				turnBudgetHardKillTimer = undefined;
			}
		};
		const clearTimeoutTimers = () => {
			if (timeoutTimer) {
				timeoutTimer.cancel();
				timeoutTimer = undefined;
			}
			if (timeoutTerminationTimer) {
				clearTimeout(timeoutTerminationTimer);
				timeoutTerminationTimer = undefined;
			}
			if (timeoutHardKillTimer) {
				clearTimeout(timeoutHardKillTimer);
				timeoutHardKillTimer = undefined;
			}
		};

		const detachForIntercom = () => {
			detached = true;
			processClosed = true;
			result.detached = true;
			result.detachedReason = "intercom coordination";
			progress.status = "detached";
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = {
				toolCount: progress.toolCount,
				tokens: progress.tokens,
				durationMs: progress.durationMs,
			};
			finish(-2);
		};

		const beginSupervisorPauseCleanup = (): Promise<NonNullable<SingleResult["processCleanup"]>> => {
			if (supervisorPauseCleanupPromise) return supervisorPauseCleanupPromise;
			if (processGroupId) {
				supervisorPauseCleanupPromise = cleanupOwnedProcessGroup(processGroupId);
			} else {
				// Portable direct-child signaling is best effort only. Without a
				// verified owned process group, pause publication must fail closed.
				trySignalChild(proc, "SIGINT");
				setTimeout(() => {
					if (!processClosed && !settled) trySignalChild(proc, "SIGTERM");
				}, 1000).unref?.();
				setTimeout(() => {
					if (!processClosed && !settled) trySignalChild(proc, "SIGKILL");
				}, 3000).unref?.();
				supervisorPauseCleanupPromise = Promise.resolve(
					skipOwnedProcessGroupCleanup(
						ownsProcessGroup ? "process_group_unavailable" : "unsupported_platform",
						undefined,
						ownsProcessGroup,
					),
				);
			}
			return supervisorPauseCleanupPromise;
		};

		const pauseForSupervisor = (pause: NonNullable<SingleResult["pause"]>) => {
			if (supervisorPauseRequested || detached || processClosed || settled) return;
			const ownerPid = processGroupId;
			result.pause = {
				...pause,
				ownerPid,
			};
			result.interrupted = true;
			result.error = undefined;
			result.finalOutput = formatForegroundSupervisorPauseMessage({
				headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
				runId: options.runId,
				agent: agent.name,
				requestSummary: pause.summary,
			});
			progress.activityState = undefined;
			progress.durationMs = Date.now() - startTime;
			try {
				options.onSupervisorPauseTransition?.({
					stage: "pausing",
					result: snapshotResult(result, snapshotProgress(progress)),
					ownerPid,
				});
			} catch {
				result.pause = undefined;
				result.interrupted = false;
				result.exitCode = 1;
				result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
				result.finalOutput = result.error;
				progress.status = "failed";
				progress.error = result.error;
				fireUpdate();
				void beginSupervisorPauseCleanup();
				return;
			}
			supervisorPauseRequested = true;
			fireUpdate();
			void beginSupervisorPauseCleanup();
		};

		// If the child emits a terminal assistant stop but never exits,
		// give it a short grace period to flush naturally, then clean it up.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed || detached) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !assistantError) {
					result.error =
						result.error ??
						`Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed || detached) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed || !intercomStarted) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			if (options.pauseBlockingSupervisor && pendingSupervisorPause?.kind === "awaiting_supervisor") {
				pauseForSupervisor(pendingSupervisorPause);
				return;
			}
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			clearTimeoutTimers();
			clearTurnBudgetTimers();
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
			resolve(code);
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		let activeLongRunningNotified = false;
		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		const mutatingFailures = createMutatingFailureState();
		const mutatingFailureWindowMs = 5 * 60_000;
		const currentToolDurationMs = (now: number) =>
			progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
		const emitNeedsAttention = (
			now: number,
			input: {
				message?: string;
				reason?: ControlEvent["reason"];
				recentFailureSummary?: string;
				currentTool?: string;
				currentPath?: string;
				currentToolDurationMs?: number;
			} = {},
		): boolean => {
			if (!controlConfig.enabled) return false;
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			const event = buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				message: input.message,
				reason: input.reason ?? "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: input.currentTool ?? progress.currentTool,
				currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
				currentPath: input.currentPath ?? progress.currentPath,
				recentFailureSummary: input.recentFailureSummary,
			});
			emitControlEvent(event);
			return previous !== "needs_attention";
		};
		const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
			if (!controlConfig.enabled || activeLongRunningNotified || progress.activityState === "needs_attention")
				return false;
			activeLongRunningNotified = true;
			const previous = progress.activityState;
			progress.activityState = "active_long_running";
			emitControlEvent(
				buildControlEvent({
					type: "active_long_running",
					from: previous,
					to: "active_long_running",
					runId: options.runId,
					agent: agent.name,
					index: options.index,
					ts: now,
					message: `${agent.name} is still active but long-running`,
					reason,
					turns: result.usage.turns,
					tokens: progress.tokens,
					toolCount: progress.toolCount,
					currentTool: progress.currentTool,
					currentToolDurationMs: currentToolDurationMs(now),
					currentPath: progress.currentPath,
					elapsedMs: now - startTime,
				}),
			);
			return true;
		};
		const requestTurnBudgetAbort = (turnCount: number) => {
			const budget = options.turnBudget;
			if (
				!budget ||
				result.timedOut ||
				result.turnBudgetExceeded ||
				interruptedByControl ||
				processClosed ||
				settled ||
				detached
			)
				return;
			const message = turnBudgetExceededMessage(budget, turnCount);
			result.turnBudgetExceeded = true;
			result.wrapUpRequested = true;
			result.turnBudget = turnBudgetState(budget, turnCount, true);
			result.error = message;
			result.finalOutput = message;
			progress.status = "failed";
			progress.error = message;
			progress.durationMs = Date.now() - startTime;
			fireUpdate();
			trySignalChild(proc, "SIGINT");
			turnBudgetTerminationTimer = setTimeout(() => {
				if (processClosed || settled || detached || result.timedOut) return;
				trySignalChild(proc, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (processClosed || settled || detached || result.timedOut) return;
				trySignalChild(proc, "SIGKILL");
			}, 4000);
			turnBudgetHardKillTimer.unref?.();
		};

		const updateTurnBudget = (turnCount: number, terminalAssistantStop: boolean) => {
			const budget = options.turnBudget;
			if (!budget || result.timedOut || result.turnBudgetExceeded) return;
			if (turnCount < budget.maxTurns) {
				result.turnBudget = { ...budget, outcome: "within-budget", turnCount };
				return;
			}
			if (!turnBudgetSoftReached) {
				turnBudgetSoftReached = true;
				result.wrapUpRequested = true;
				appendRecentOutput(progress, [turnBudgetSoftNote(budget, turnCount)]);
			}
			result.turnBudget = turnBudgetState(budget, turnCount, false);
			if (shouldAbortForTurnBudget(budget, turnCount, terminalAssistantStop)) {
				requestTurnBudgetAbort(turnCount);
			}
		};

		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				toolCallInFlight: Boolean(progress.currentTool),
				now,
			});
			if (idleState === "needs_attention") {
				return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: startTime,
				now,
				turns: result.usage.turns,
				tokens: progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		};

		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			const controlEvents = drainPendingControlEvents();
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents,
				},
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			const output =
				(result.timedOut || result.turnBudgetExceeded) && result.finalOutput
					? result.finalOutput
					: getFinalOutput(result.messages ?? []);
			emitUpdateSnapshot(output || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				shared.transcriptWriter?.writeStdoutLine(line);
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				shared.transcriptWriter?.writeStdoutLine(line);
				return;
			}
			const evt = parsed as { type?: string; message?: Message; toolName?: string; args?: unknown };
			shared.transcriptWriter?.writeChildEvent(evt);

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const toolArgs =
					evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
						? (evt.args as Record<string, unknown>)
						: {};
				let shouldDetachForBlockingIntercom = false;
				let supervisorPause: SingleResult["pause"] | undefined;
				if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {
					intercomStarted = true;
					shouldDetachForBlockingIntercom =
						(evt.toolName === "intercom" && toolArgs.action === "ask") ||
						(evt.toolName === "contact_supervisor" &&
							(toolArgs.reason === "need_decision" || toolArgs.reason === "interview_request"));
					if (options.pauseBlockingSupervisor && shouldDetachForBlockingIntercom && typeof evt.toolName === "string") {
						supervisorPause = resolveSupervisorPauseMetadata({
							runId: options.runId,
							agent: agent.name,
							index: options.index ?? 0,
							toolName: evt.toolName,
							toolArgs,
							requestedAt: now,
						});
						pendingSupervisorPause = supervisorPause;
					}
				}
				progress.toolCount++;
				if (options.toolBudget) {
					result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount);
				}
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				const mutates = isMutatingTool(evt.toolName, toolArgs);
				observedMutationAttempt = observedMutationAttempt || mutates;
				pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates, startedAt: now };
				fireUpdate();
				if (
					options.pauseBlockingSupervisor &&
					supervisorPause?.kind === "awaiting_supervisor" &&
					!detached &&
					!processClosed
				) {
					pauseForSupervisor(supervisorPause);
				} else if (shouldDetachForBlockingIntercom && !detached && !processClosed) {
					detachForIntercom();
				}
			}

			if (evt.type === "tool_execution_end") {
				pendingSupervisorPause = undefined;
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				(result.messages ??= []).push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall =
						Array.isArray(evt.message.content) &&
						evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
					updateTurnBudget(result.usage.turns, terminalAssistantStop);
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (!result.model && evt.message.model) result.model = evt.message.model;
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					if (terminalAssistantStop) {
						if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						startFinalDrain();
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				(result.messages ??= []).push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
				if (options.toolBudget && pendingToolResult && resultText.includes("Tool budget hard limit reached")) {
					result.toolBudgetBlocked = true;
					result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount, pendingToolResult.tool);
				}
				appendRecentOutput(progress, resultText.split("\n").slice(-10));
				const toolSnapshot = pendingToolResult;
				pendingToolResult = undefined;
				if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
					recordMutatingFailure(
						mutatingFailures,
						{
							tool: toolSnapshot.tool,
							path: toolSnapshot.path,
							error:
								resultText
									.split("\n")
									.find((line) => line.trim())
									?.trim()
									.slice(0, 180) ?? "mutating tool failed",
							ts: now,
						},
						mutatingFailureWindowMs,
					);
					if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
						emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							currentTool: toolSnapshot.tool,
							currentPath: toolSnapshot.path,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					}
				} else if (toolSnapshot?.mutates) {
					resetMutatingFailureState(mutatingFailures);
				}
				fireUpdate();
			}
		};

		if (controlConfig.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled || detached) return;
				const now = Date.now();
				if (updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		if (attemptTimeout) {
			timeoutTimer = scheduleDeadline(attemptTimeout.deadlineAt, () => {
				if (processClosed || settled || detached || interruptedByControl) return;
				result.timedOut = true;
				result.error = attemptTimeout.message;
				result.finalOutput = attemptTimeout.message;
				progress.status = "failed";
				progress.error = attemptTimeout.message;
				progress.durationMs = Date.now() - startTime;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				timeoutTerminationTimer = setTimeout(() => {
					if (processClosed || settled || detached) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000);
				timeoutTerminationTimer.unref?.();
				timeoutHardKillTimer = setTimeout(() => {
					if (processClosed || settled || detached) return;
					trySignalChild(proc, "SIGKILL");
				}, 4000);
				timeoutHardKillTimer.unref?.();
			});
		}

		let stderrBuf = "";

		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			childExited = true;
			clearFinalDrainTimers();
		});
		proc.on("close", (code, signal) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			result.exitSignal = signal ?? undefined;
			if (buf.trim()) processLine(buf);
			if (stderrBuf.trim()) shared.transcriptWriter?.writeStderrText(stderrBuf);
			if (!result.error && assistantError) result.error = assistantError;
			const forcedDrainAfterFinalSuccess =
				forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
				result.error = stderrBuf.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess
				? 0
				: forcedTerminationSignal || signal
					? (code ?? 1)
					: (code ?? 0);
			if (supervisorPauseRequested) {
				void (async () => {
					const cleanup = await beginSupervisorPauseCleanup();
					result.processCleanup = cleanup;
					if (!cleanup.terminated) {
						supervisorPauseRequested = false;
						result.pause = undefined;
						result.interrupted = false;
						result.exitCode = 1;
						result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
						result.finalOutput = result.error;
						result.exitSignal = undefined;
						progress.status = "failed";
						progress.error = result.error;
						finish(1);
						return;
					}
					result.exitCode = 0;
					result.interrupted = true;
					result.error = undefined;
					result.exitSignal = undefined;
					if (result.pause) result.pause = { ...result.pause, pausedAt: Date.now(), ownerPid: undefined };
					progress.durationMs = Date.now() - startTime;
					result.progressSummary = {
						toolCount: progress.toolCount,
						tokens: progress.tokens,
						durationMs: progress.durationMs,
					};
					resolveResultSessionFile(result, options, shared.sessionEnabled);
					try {
						options.onSupervisorPauseTransition?.({
							stage: "paused",
							result: snapshotResult(result, snapshotProgress(progress)),
						});
					} catch {
						supervisorPauseRequested = false;
						result.pause = undefined;
						result.interrupted = false;
						result.exitCode = 1;
						result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
						result.finalOutput = result.error;
						progress.status = "failed";
						progress.error = result.error;
						finish(1);
						return;
					}
					finish(0);
				})();
				return;
			}
			if (interruptedByControl) {
				void (async () => {
					const cleanup = await beginSupervisorPauseCleanup();
					result.processCleanup = cleanup;
					if (!cleanup.terminated) {
						interruptedByControl = false;
						result.interrupted = false;
						result.exitCode = 1;
						result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
						result.finalOutput = result.error;
						progress.status = "failed";
						progress.error = result.error;
						finish(1);
						return;
					}
					processClosed = true;
					finish(finalCode);
				})();
				return;
			}
			if (detached) {
				result.exitCode = result.error && finalCode === 0 ? 1 : finalCode;
				progress.status = result.exitCode === 0 ? "completed" : "failed";
				progress.durationMs = Date.now() - startTime;
				if (result.error) progress.error = result.error;
				result.progressSummary = {
					toolCount: progress.toolCount,
					tokens: progress.tokens,
					durationMs: progress.durationMs,
				};
				const finalOutput = getFinalOutput(result.messages ?? []);
				result.finalOutput =
					finalOutput.trim() || result.error || result.finalOutput || "Detached child exited without final output.";
				if (
					result.artifactPaths &&
					options.artifactConfig?.enabled !== false &&
					options.artifactConfig?.includeOutput !== false
				) {
					try {
						writeArtifact(result.artifactPaths.outputPath, result.finalOutput);
					} catch {
						// Detached children may outlive test/temp cleanup; recovered status is best-effort.
					}
				}
				options.onDetachedExit?.(snapshotResult(result, snapshotProgress(progress)));
				finish(-2);
				return;
			}
			processClosed = true;
			finish(finalCode);
		});
		proc.on("error", (error) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (stderrBuf.trim()) shared.transcriptWriter?.writeStderrText(stderrBuf);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || detached) return;
				if (options.pauseBlockingSupervisor && pendingSupervisorPause?.kind === "awaiting_supervisor") {
					pauseForSupervisor(pendingSupervisorPause);
					return;
				}
				if (options.allowIntercomDetach && intercomStarted && !detached) {
					detachForIntercom();
					return;
				}
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (processClosed || detached || settled) return;
				if (result.timedOut) return;
				interruptedByControl = true;
				clearTimeoutTimers();
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				void beginSupervisorPauseCleanup();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}
	});
	result.exitCode = exitCode;
	if (supervisorPauseRequested) {
		resolveResultSessionFile(result, options, shared.sessionEnabled);
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		if (result.pause) result.pause = { ...result.pause, ownerPid: undefined };
		result.finalOutput =
			result.finalOutput ||
			formatForegroundSupervisorPauseMessage({
				headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
				runId: options.runId,
				agent: agent.name,
				requestSummary: result.pause?.summary,
			});
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (interruptedByControl) {
		resolveResultSessionFile(result, options, shared.sessionEnabled);
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.detached) {
		result.exitCode = 0;
		result.finalOutput =
			result.pause?.kind === "awaiting_supervisor"
				? formatForegroundSupervisorPauseMessage({
						headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
						runId: options.runId,
						agent: agent.name,
						requestSummary: result.pause.summary,
						...(options.index !== undefined ? { index: options.index } : {}),
					})
				: "Legacy detached supervisor coordination. Inspect status/artifacts, then resume or replace work explicitly if needed.";
		return result;
	}

	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode !== 0 && !result.error) {
		result.error = synthesizeChildExitDiagnostic({
			exitCode: result.exitCode,
			signal: result.exitSignal,
		});
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages ?? []);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (result.exitCode === 0 && !result.error) {
		const finalText = getFinalOutput(result.messages ?? []);
		const missingStructuredOutput = options.structuredOutput ? !existsSync(options.structuredOutput.outputPath) : false;
		if (!finalText?.trim() && (!options.structuredOutput || missingStructuredOutput)) {
			result.exitCode = 1;
			result.error = "Subagent produced no output (possible model cold-start or empty response).";
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const acceptanceOutput = getFinalOutput(result.messages ?? []);
	const { report: finalAcceptanceReport } = parseAcceptanceReport(acceptanceOutput);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if (result.timedOut) {
		const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
		fullOutput = fullOutput.trim()
			? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
			: timeoutMessage;
	} else if (result.turnBudgetExceeded && result.turnBudget) {
		fullOutput = formatTurnBudgetOutput(
			turnBudgetExceededMessage(result.turnBudget, result.turnBudget.turnCount),
			fullOutput,
		);
	} else if (result.wrapUpRequested && result.turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(
			result.turnBudget,
			result.turnBudget.wrapUpRequestedAtTurn ?? result.turnBudget.turnCount,
		);
		fullOutput = fullOutput.trim() ? `${note}\n\n${fullOutput}` : note;
	}
	const completionGuard =
		result.exitCode === 0 && !result.error && agent.completionGuard !== false
			? evaluateCompletionMutationGuard({
					agent: agent.name,
					task: shared.originalTask ?? task,
					messages: result.messages ?? [],
					tools: agent.tools,
				})
			: undefined;
	if (completionGuard?.triggered && !observedMutationAttempt) {
		result.exitCode = 1;
		result.error =
			"Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
		progress.status = "failed";
		progress.error = result.error;
		emitControlEvent(
			buildControlEvent({
				from: progress.activityState,
				to: "needs_attention",
				runId: options.runId ?? agent.name,
				agent: agent.name,
				index: options.index,
				ts: Date.now(),
				message: `${agent.name} completed without making edits for an implementation task`,
				reason: "completion_guard",
			}),
		);
	}
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	// The artifact file is the supervisor-facing surface (it is what gets read back
	// as *_output.md). Append the validation-evidence digest there only, so the
	// acceptance evidence survives stripAcceptanceReport without touching
	// result.finalOutput, which is a semantic value feeding user-requested output
	// files and chain/parallel output references.
	//
	// Exception: when the run saved a user-requested output file, the artifact is a
	// verbatim archive of that deliverable, so it stays byte-exact.
	const artifactBaseOutput = result.timedOut
		? fullOutput
		: result.exitCode !== 0 && !result.interrupted
			? formatErrorWithOutput(result.error, fullOutput)
			: fullOutput;
	artifactOutputByResult.set(
		result,
		finalAcceptanceReport && !result.savedOutputPath
			? appendAcceptanceReportDigest(artifactBaseOutput, finalAcceptanceReport)
			: artifactBaseOutput,
	);
	acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	const preservedFinalOutput = result.finalOutput;
	result.finalOutput =
		options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
			? result.outputReference.message
			: fullOutput;
	if (
		result.exitCode !== 0 &&
		!result.finalOutput.trim() &&
		typeof preservedFinalOutput === "string" &&
		preservedFinalOutput.trim()
	) {
		result.finalOutput = preservedFinalOutput;
	}
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: allControlEvents.length ? allControlEvents : undefined,
			},
		});
	}
	return result;
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const effectiveTimeoutMs = resolveEffectiveSingleTimeout(options.timeoutMs, agent.maxExecutionTimeMs);
	options = {
		...options,
		timeoutMs: effectiveTimeoutMs,
		deadlineAt: resolveEffectiveTimeoutDeadline(options.deadlineAt, effectiveTimeoutMs),
	};
	const outputModeValidationError = validateFileOnlyOutputMode(
		options.outputMode,
		options.outputPath,
		`Single run (${agentName})`,
	);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		acceptanceRole: agent.acceptanceRole,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		skillCwd,
		runtimeCwd,
	);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath);

	const fallbackModels = buildFallbackModelList(options.fallbackModels, agent.fallbackModels);
	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);
	const modelFallbackNotice = sanitizeModelFallbackNotice(options.modelFallbackNotice);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
		if (options.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPathsResult.transcriptPath,
				source: "foreground",
				runId: options.runId,
				agent: agentName,
				childIndex: options.index,
				cwd: options.cwd ?? runtimeCwd,
			});
			transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, options, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			transcriptWriter,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		});
		lastResult = result;
		if (result.model) attemptedModels.push(result.model);
		else if (candidate) attemptedModels.push(candidate);
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: result.model ?? candidate ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (result.timedOut || result.turnBudgetExceeded) {
			break;
		}
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result =
		lastResult ??
		({
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Subagent did not produce a result.",
		} satisfies SingleResult);

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	if (modelFallbackNotice && modelAttempts.length > 1) result.modelFallbackNotice = modelFallbackNotice;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	result.activeRuntimeMs = totalDurationMs;
	if (attemptNotes.length > 0 && result.progress) {
		const existingNotes = new Set(result.progress.recentOutput);
		result.progress.recentOutput = [
			...attemptNotes.filter((note) => !existingNotes.has(note)),
			...result.progress.recentOutput,
		];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	resolveResultSessionFile(result, options, shareEnabled);
	if (result.timedOut) {
		const timeoutDiagnostics = formatTimeoutDiagnostics(result, options, artifactPathsResult ?? result.artifactPaths);
		result.finalOutput = timeoutDiagnostics;
		// Append the acceptance digest to the artifact copy only; result.finalOutput must
		// remain exactly timeoutDiagnostics so it does not corrupt output-file or chain
		// output references. The savedOutputPath exception (no digest) is preserved.
		const storedAcceptanceOutput = acceptanceOutputByResult.get(result);
		const { report: timeoutReport } = storedAcceptanceOutput
			? parseAcceptanceReport(storedAcceptanceOutput)
			: { report: undefined };
		artifactOutputByResult.set(
			result,
			timeoutReport && !result.savedOutputPath
				? appendAcceptanceReportDigest(timeoutDiagnostics, timeoutReport)
				: timeoutDiagnostics,
		);
	}
	if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
	if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				exitSignal: result.exitSignal,
				timedOut: result.timedOut,
				...(result.timedOut && result.sessionFile && existsSync(result.sessionFile)
					? { sessionFile: result.sessionFile }
					: {}),
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				modelFallbackNotice: result.modelFallbackNotice,
				durationMs: result.progressSummary?.durationMs,
				activeRuntimeMs: result.activeRuntimeMs,
				timeoutMs: options.timeoutMs,
				deadlineAt: options.deadlineAt,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
				transcriptError: result.transcriptError,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	const interruptedAcceptance = buildSkippedAcceptanceLedger({
		acceptance: effectiveAcceptance,
		ledgerStatus: "skipped",
		runtimeCheckStatus: "not-applicable",
		id: "paused",
		message:
			"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
	});
	const interruptedBeforeAcceptance = result.interrupted || options.interruptSignal?.aborted === true;
	result.acceptance = result.timedOut
		? buildSkippedAcceptanceLedger({
				acceptance: effectiveAcceptance,
				ledgerStatus: "rejected",
				runtimeCheckStatus: "failed",
				id: "timeout",
				message: "Acceptance was not evaluated because the subagent timed out.",
			})
		: result.turnBudgetExceeded
			? buildSkippedAcceptanceLedger({
					acceptance: effectiveAcceptance,
					ledgerStatus: "rejected",
					runtimeCheckStatus: "failed",
					id: "turn-budget",
					message: "Acceptance was not evaluated because the subagent exceeded its turn budget.",
				})
			: interruptedBeforeAcceptance
				? interruptedAcceptance
				: await evaluateAcceptance({
						acceptance: effectiveAcceptance,
						output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
						cwd: options.cwd ?? runtimeCwd,
						signal: options.interruptSignal,
						abortMessage: "Interrupted. Waiting for explicit next action.",
					});
	if (!result.timedOut && !result.turnBudgetExceeded && !result.interrupted && options.interruptSignal?.aborted) {
		result.interrupted = true;
		result.exitCode = 0;
		result.error = undefined;
		result.finalOutput = "Interrupted. Waiting for explicit next action.";
		result.acceptance = interruptedAcceptance;
		if (result.progress) {
			result.progress.activityState = undefined;
			result.progress.error = undefined;
		}
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (
		acceptanceFailure &&
		result.acceptance.explicit &&
		result.exitCode === 0 &&
		!result.detached &&
		!result.interrupted &&
		!result.timedOut
	) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}

	return result;
}
