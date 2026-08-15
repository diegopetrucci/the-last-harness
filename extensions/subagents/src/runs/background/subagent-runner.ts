import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import {
	acceptChildMessageRequest,
	consumeInterruptRequest,
	deliverInterruptRequest,
	deliverTimeoutRequest,
	enqueueStepChildMessage,
	stepSteerInboxDir,
	watchAsyncControlInbox,
	writeChildMessageAcceptanceForRequest,
	type ChildMessageRequest,
} from "./control-channel.ts";
import { appendJsonl as appendRawJsonl, getArtifactPaths } from "../../shared/artifacts.ts";
import {
	buildSubagentSpawnEnv,
	PI_CODING_AGENT_PACKAGE,
	getPiSpawnCommand,
	resolveInstalledPiPackageRoot,
} from "../shared/pi-spawn.ts";
import {
	captureSingleOutputSnapshot,
	finalizeSingleOutput,
	formatSavedOutputReference,
	resolveSingleOutput,
	type SingleOutputSnapshot,
} from "../shared/single-output.ts";
import {
	type ActivityState,
	type ArtifactConfig,
	type ArtifactPaths,
	type AsyncParallelGroupStatus,
	type AsyncResultArtifact,
	type AsyncStatus,
	type ChainOutputMap,
	type ChildProcessCleanupResult,
	type CostSummary,
	type ContextPressureProjection,
	type ContextPressureThreshold,
	type ContextUsageDiagnostics,
	type ModelAttempt,
	type NestedRouteInfo,
	type NestedRunSummary,
	type TkTicketMetadata,
	type SubagentModelIdentity,
	type SubagentModelResolution,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SubagentRunMode,
	type SubagentTerminationReason,
	type ToolBudgetState,
	type TurnBudgetState,
	type Usage,
	type WorkflowGraphSnapshot,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	deriveActivityState,
	claimControlNotification,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
} from "../shared/subagent-control.ts";
import {
	type RunnerSubagentStep as SubagentStep,
	type RunnerStep,
	isParallelGroup,
	flattenSteps,
	mapConcurrent,
	aggregateParallelOutputs,
	MAX_PARALLEL_CONCURRENCY,
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	Semaphore,
} from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime, readStructuredOutput } from "../shared/structured-output.ts";
import {
	nestedSummaryFromAsyncStatus,
	projectNestedEvents,
	resolveNestedAsyncDir,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import {
	appendRuntimeFallbackResolution,
	canonicalSubagentModelIdentity,
	formatModelAttemptNote,
	resolveRuntimeModelContext,
	isRetryableModelFailure,
	sanitizeModelFallbackNotice,
} from "../shared/model-fallback.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { appendRecentProgressItem } from "../../shared/recent-progress.ts";
import { scheduleDeadline, type DeadlineTimer } from "../shared/deadline-timer.ts";
import {
	detectSubagentError,
	extractTextFromContent,
	extractToolArgsPreview,
	formatErrorWithOutput,
	getFinalOutput,
	readStatus,
	synthesizeChildExitDiagnostic,
} from "../../shared/utils.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
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
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";

import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
	acceptanceFailureMessage,
	appendAcceptanceReportDigest,
	buildSkippedAcceptanceLedger,
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	stripAcceptanceReport,
} from "../shared/acceptance.ts";
import {
	cleanupOwnedProcessGroup,
	formatOwnedProcessGroupCleanup,
	skipOwnedProcessGroupCleanup,
	supportsOwnedProcessGroupCleanup,
} from "../shared/process-group-cleanup.ts";
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
import {
	TERMINAL_RUN_STATES,
	boundSupervisorSummary,
	finalizeLifecycleContinuationLaunch,
	lifecycleGeneration,
	mergeAndWriteSourceRunnerStatus,
	transitionLifecycleStatus,
	writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.ts";
import {
	assistantStopReason,
	classifyContextExhaustedTermination,
	CONTEXT_EXHAUSTED_TERMINATION_MESSAGE,
	hasUsableSessionArtifact,
	parseContextPressureCrossedThresholds,
	parseContextPressureProjection,
	parseContextUsageDiagnostics,
	mergeContextUsageDiagnostics,
	resolveSubagentTerminationReason,
	updateContextUsageDiagnostics,
	detectContextPressureCrossing,
	formatContextPressureGuidance,
} from "../../shared/context-diagnostics.ts";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";

const ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE =
	"Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";

interface SubagentRunConfig {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	taskIndex?: number;
	totalTasks?: number;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	continuationSource?: { asyncDir: string; runId: string; index: number; claimToken: string };
	sessionId?: string | null;
	piPackageRoot?: string;
	piArgv1?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTargets?: Array<string | undefined>;
	resultMode?: SubagentRunMode;
	workflowGraph?: WorkflowGraphSnapshot;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: {
		parentRunId: string;
		parentStepIndex?: number;
		depth: number;
		path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
	};
	tkTicket?: TkTicketMetadata;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
}

interface StepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals;
	skipped?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	contextUsage?: ContextUsageDiagnostics;
	contextPressure?: ContextPressureProjection;
	contextPressureCrossedThresholds?: ContextPressureThreshold[];
	terminationReason?: SubagentTerminationReason;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	modelIdentity?: SubagentModelIdentity;
	modelResolution?: SubagentModelResolution;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	modelFallbackNotice?: string;
	totalCost?: CostSummary;
	artifactPaths?: ArtifactPaths;
	processCleanup?: ChildProcessCleanupResult;
	truncated?: boolean;
	transcriptPath?: string;
	transcriptError?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
	pause?: AsyncStatus["pause"];
	activeRuntimeMs?: number;
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 50 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const TRUNCATED_EVENT_TYPE = "subagent.events.truncated";
const TRUNCATION_MARKER_RESERVE_BYTES = 512;

interface AsyncEventLogState {
	bytes: number;
	diagnosticsTruncated: boolean;
}

const asyncEventLogStates = new Map<string, AsyncEventLogState>();

function maxAsyncEventsBytes(): number {
	const raw = process.env[ASYNC_EVENTS_MAX_BYTES_ENV];
	if (!raw) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
	return Math.floor(parsed);
}

function eventLogState(filePath: string): AsyncEventLogState {
	let state = asyncEventLogStates.get(filePath);
	if (state) return state;
	let bytes = 0;
	try {
		bytes = fs.statSync(filePath).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// Diagnostic event accounting is best-effort; writes below are also safe.
			void 0;
		}
	}
	state = { bytes, diagnosticsTruncated: false };
	asyncEventLogStates.set(filePath, state);
	return state;
}

function appendJsonl(filePath: string, line: string): void {
	try {
		appendRawJsonl(filePath, line);
		const state = asyncEventLogStates.get(filePath);
		if (state) state.bytes += Buffer.byteLength(`${line}\n`, "utf-8");
	} catch {
		// Async event logging is diagnostic and must not fail the run.
	}
}

function appendDiagnosticJsonl(filePath: string, line: string, droppedEventType?: string): void {
	if (!line.trim()) return;
	const state = eventLogState(filePath);
	if (state.diagnosticsTruncated) return;
	const maxBytes = maxAsyncEventsBytes();
	const chunkBytes = Buffer.byteLength(`${line}\n`, "utf-8");
	const diagnosticBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE_BYTES);
	if (state.bytes + chunkBytes <= diagnosticBudget) {
		appendJsonl(filePath, line);
		return;
	}

	const marker = JSON.stringify({
		type: TRUNCATED_EVENT_TYPE,
		ts: Date.now(),
		maxBytes,
		droppedEventType,
	});
	if (state.bytes + Buffer.byteLength(`${marker}\n`, "utf-8") <= maxBytes) {
		appendJsonl(filePath, marker);
	}
	state.diagnosticsTruncated = true;
}

function shouldPersistChildEvent(event: Record<string, unknown>): boolean {
	return event.type !== "message_update";
}

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session lookup is optional metadata.
		return null;
	}
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	for (const attempt of attempts) {
		input += attempt.usage?.input ?? 0;
		output += attempt.usage?.output ?? 0;
	}
	const total = input + output;
	return total > 0 ? { input, output, total } : null;
}

function costSummaryFromAttempts(attempts: ModelAttempt[] | undefined): CostSummary | undefined {
	if (!attempts || attempts.length === 0) return undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (const attempt of attempts) {
		inputTokens += attempt.usage?.input ?? 0;
		outputTokens += attempt.usage?.output ?? 0;
		costUsd += attempt.usage?.cost ?? 0;
	}
	return inputTokens > 0 || outputTokens > 0 || costUsd > 0 ? { inputTokens, outputTokens, costUsd } : undefined;
}

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}

function isTerminalAssistantStop(message: Message): boolean {
	const stopReason = (message as { stopReason?: string }).stopReason;
	const hasToolCall =
		Array.isArray(message.content) && message.content.some((part) => (part as { type?: string }).type === "toolCall");
	return stopReason === "stop" && !hasToolCall;
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
	step.recentTools = [];
	step.recentOutput = [];
}

interface ChildEventContext {
	eventsPath: string;
	runId: string;
	stepIndex: number;
	agent: string;
}

interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

type ChildMessage = Message & {
	provider?: unknown;
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

interface ChildEvent extends Record<string, unknown> {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

function resolveSupervisorPauseMetadata(input: {
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	requestedAt: number;
}): AsyncStatus["pause"] | undefined {
	if (input.toolName === "intercom" && input.toolArgs?.action === "ask") {
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
		(input.toolArgs?.reason === "need_decision" || input.toolArgs?.reason === "interview_request")
	) {
		const summary = boundSupervisorSummary(input.toolArgs.message);
		return {
			kind: "awaiting_supervisor",
			requestedAt: input.requestedAt,
			...(summary ? { summary } : {}),
			request: {
				tool: "contact_supervisor",
				reason: input.toolArgs.reason,
				...(summary ? { summary } : {}),
			},
		};
	}
	return undefined;
}

interface RunPiStreamingResult {
	stderr: string;
	exitCode: number | null;
	exitSignal?: NodeJS.Signals;
	messages: Message[];
	usage: Usage;
	model?: string;
	runtimeModelIdentity?: SubagentModelIdentity;
	configuredModel?: string;
	error?: string;
	finalOutput: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	observedMutationAttempt?: boolean;
	processGroupId?: number;
	processCleanup?: ChildProcessCleanupResult;
	contextUsage?: ContextUsageDiagnostics;
	assistantStopReason?: string;
	contextExhausted?: boolean;
}

function contextWindowForModel(
	model: string | undefined,
	contextWindows: Record<string, number> | undefined,
): number | undefined {
	if (!model || !contextWindows) return undefined;
	const baseModel = splitKnownThinkingSuffix(model).baseModel;
	const value = contextWindows[baseModel];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function runtimeModelReference(identity: SubagentModelIdentity): string {
	return `${identity.provider}/${identity.model}${identity.thinking ? `:${identity.thinking}` : ""}`;
}

function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piArgv1?: string,
	maxSubagentDepth?: number,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
	transcriptWriter?: ChildTranscriptWriter,
	registerTimeout?: (interrupt: (() => void) | undefined) => void,
	timeoutMessage?: string,
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void,
	context?: {
		restored: boolean;
		configuredModel?: string;
		contextWindow?: number;
		contextWindows?: Record<string, number>;
	},
): Promise<RunPiStreamingResult> {
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		const spawnEnv = buildSubagentSpawnEnv(process.env, env, getSubagentDepthEnv(maxSubagentDepth));
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
			...(ownsProcessGroup ? { detached: true } : {}),
		});
		const processGroupId = ownsProcessGroup && typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let timedOut = false;
		let turnBudgetExceeded = false;
		let turnBudgetMessage: string | undefined;
		let turnBudget: TurnBudgetState | undefined;
		let observedMutationAttempt = false;
		let contextUsage: ContextUsageDiagnostics | undefined;
		let runtimeModelIdentity: SubagentModelIdentity | undefined;
		let finalAssistantStopReason: string | undefined;
		let wroteHumanReadableOutput = false;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			wroteHumanReadableOutput = true;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown>) => {
			if (!childEventContext) return;
			if (!shouldPersistChildEvent(event)) return;
			appendDiagnosticJsonl(
				childEventContext.eventsPath,
				JSON.stringify({
					...event,
					subagentSource: "child",
					subagentRunId: childEventContext.runId,
					subagentStepIndex: childEventContext.stepIndex,
					subagentAgent: childEventContext.agent,
					observedAt: Date.now(),
				}),
				typeof event.type === "string" ? event.type : undefined,
			);
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
			if (type === "subagent.child.stdout") transcriptWriter?.writeStdoutLine(line);
			else transcriptWriter?.writeStderrLine(line);
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			const writeRawStdoutLine = () => {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
			};
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				writeRawStdoutLine();
				return;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				writeRawStdoutLine();
				return;
			}
			const event = parsed as ChildEvent;

			appendChildEvent(event);
			transcriptWriter?.writeChildEvent(event);
			onChildEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (context && !context.configuredModel && runtimeModelIdentity === undefined) {
					const reportedModel = resolveRuntimeModelContext(
						event.message.provider,
						event.message.model,
						context.contextWindows,
					);
					if (reportedModel) {
						runtimeModelIdentity = reportedModel.identity;
						context.contextWindow = reportedModel.contextWindow;
						model = runtimeModelReference(reportedModel.identity);
					}
				}
				if (event.message.model && runtimeModelIdentity === undefined) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				finalAssistantStopReason = assistantStopReason(event.message);
				contextUsage = updateContextUsageDiagnostics(contextUsage, event.message, {
					restored: context?.restored === true,
					contextWindow: context?.contextWindow,
				});
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				if (isTerminalAssistantStop(event.message)) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim())
						assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					startFinalDrain();
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			if (text.length > 0) wroteHumanReadableOutput = true;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		// Guard both cases that can leave the parent waiting on `close` forever:
		// a lingering stdio holder after `exit`, or a child that never exits.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		const CLOSE_FALLBACK_MS = 1000;
		const INTERRUPT_HARD_KILL_MS = 4000;
		const TIMEOUT_HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let closeFallbackTimer: NodeJS.Timeout | undefined;
		let interruptTerminationTimer: NodeJS.Timeout | undefined;
		let interruptHardKillTimer: NodeJS.Timeout | undefined;
		let timeoutHardKillTimer: NodeJS.Timeout | undefined;
		let turnBudgetTerminationTimer: NodeJS.Timeout | undefined;
		let turnBudgetHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		let softInterruptsEnabled = true;
		let interruptRegistered = false;
		let exitCodeFromExit: number | null = null;
		let exitSignalFromExit: NodeJS.Signals | null = null;
		let processCleanup: ChildProcessCleanupResult | undefined;
		let cleanupPromise: Promise<ChildProcessCleanupResult> | undefined;
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		const clearCloseFallbackTimer = () => {
			if (!closeFallbackTimer) return;
			clearTimeout(closeFallbackTimer);
			closeFallbackTimer = undefined;
		};
		const clearRegisteredInterrupt = () => {
			if (!interruptRegistered) return;
			interruptRegistered = false;
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerTurnBudgetAbort?.(undefined);
		};
		const disableSoftInterrupts = () => {
			softInterruptsEnabled = false;
			clearRegisteredInterrupt();
		};
		const resolveProcessCleanup = (): Promise<ChildProcessCleanupResult> => {
			disableSoftInterrupts();
			if (processCleanup) return Promise.resolve(processCleanup);
			if (cleanupPromise) return cleanupPromise;
			cleanupPromise = (async () => {
				processCleanup = processGroupId
					? await cleanupOwnedProcessGroup(processGroupId)
					: skipOwnedProcessGroupCleanup(
							supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform",
							processGroupId,
						);
				return processCleanup;
			})();
			return cleanupPromise;
		};
		const finalize = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			disableSoftInterrupts();
			clearDrainTimers();
			clearCloseFallbackTimer();
			clearStdioGuard();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const resolvedExitCode = interrupted ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode;
			const forcedDrainAfterFinalSuccess =
				forcedTerminationSignal && cleanTerminalAssistantStopReceived && !(error ?? assistantError);
			const finalError =
				error ??
				assistantError ??
				(resolvedExitCode !== 0 && stderr.trim() ? stderr.trim() : undefined) ??
				synthesizeChildExitDiagnostic({ exitCode: resolvedExitCode, signal });
			const resultExitCode = timedOut
				? 1
				: turnBudgetExceeded
					? 1
					: forcedDrainAfterFinalSuccess
						? 0
						: resolvedExitCode;
			const resultTerminationReason = resolveSubagentTerminationReason({
				assistantStopReason: finalAssistantStopReason,
				effectiveExitCode: resultExitCode ?? undefined,
				processCompleted: true,
			});
			const contextExhausted = classifyContextExhaustedTermination({
				messages,
				contextUsage,
				exitCode: resultExitCode ?? undefined,
				error: finalError,
				terminationReason: resultTerminationReason,
			});
			if (
				!interrupted &&
				!forcedDrainAfterFinalSuccess &&
				resolvedExitCode !== 0 &&
				finalError &&
				finalError !== stderr.trim()
			) {
				outputStream.write(`${wroteHumanReadableOutput ? "\n" : ""}${finalError}\n`);
			}
			outputStream.end();
			resolve({
				stderr,
				exitCode: contextExhausted ? 1 : resultExitCode,

				exitSignal: signal ?? undefined,
				messages,
				usage,
				model,
				error: contextExhausted
					? CONTEXT_EXHAUSTED_TERMINATION_MESSAGE
					: timedOut
						? (timeoutMessage ?? "Subagent timed out.")
						: turnBudgetExceeded
							? turnBudgetMessage
							: interrupted || forcedDrainAfterFinalSuccess
								? undefined
								: finalError,
				finalOutput: timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput,
				interrupted,
				timedOut,
				turnBudget,
				turnBudgetExceeded,
				wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined,
				observedMutationAttempt,
				processGroupId,
				processCleanup,
				contextUsage,
				runtimeModelIdentity,
				configuredModel: context?.configuredModel,
				assistantStopReason: finalAssistantStopReason,
				contextExhausted: contextExhausted === "context_exhausted" || undefined,
			});
		};
		child.stdout.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			processStderrText(chunk.toString());
		});
		interruptRegistered = true;
		registerInterrupt?.(() => {
			if (settled || timedOut || !softInterruptsEnabled) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			interruptTerminationTimer = setTimeout(() => {
				if (!settled && !timedOut && softInterruptsEnabled) trySignalChild(child, "SIGTERM");
			}, 1000);
			interruptTerminationTimer.unref?.();
			interruptHardKillTimer = setTimeout(() => {
				if (!settled && !timedOut && softInterruptsEnabled) trySignalChild(child, "SIGKILL");
			}, INTERRUPT_HARD_KILL_MS);
			interruptHardKillTimer.unref?.();
		});
		registerTimeout?.(() => {
			if (settled || timedOut) return;
			timedOut = true;
			interrupted = false;
			error = timeoutMessage ?? "Subagent timed out.";
			trySignalChild(child, "SIGTERM");
			timeoutHardKillTimer = setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGKILL");
			}, TIMEOUT_HARD_KILL_MS);
			timeoutHardKillTimer.unref?.();
		});
		registerTurnBudgetAbort?.((message, state) => {
			if (settled || timedOut || turnBudgetExceeded) return;
			turnBudgetExceeded = true;
			turnBudgetMessage = message;
			turnBudget = state;
			interrupted = false;
			error = message;
			trySignalChild(child, "SIGINT");
			turnBudgetTerminationTimer = setTimeout(() => {
				if (!settled && !timedOut) trySignalChild(child, "SIGTERM");
			}, 1000);
			turnBudgetTerminationTimer.unref?.();
			turnBudgetHardKillTimer = setTimeout(() => {
				if (!settled && !timedOut) trySignalChild(child, "SIGKILL");
			}, 4000);
			turnBudgetHardKillTimer.unref?.();
		});
		const clearDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
			if (interruptTerminationTimer) {
				clearTimeout(interruptTerminationTimer);
				interruptTerminationTimer = undefined;
			}
			if (interruptHardKillTimer) {
				clearTimeout(interruptHardKillTimer);
				interruptHardKillTimer = undefined;
			}
			if (timeoutHardKillTimer) {
				clearTimeout(timeoutHardKillTimer);
				timeoutHardKillTimer = undefined;
			}
			if (turnBudgetTerminationTimer) {
				clearTimeout(turnBudgetTerminationTimer);
				turnBudgetTerminationTimer = undefined;
			}
			if (turnBudgetHardKillTimer) {
				clearTimeout(turnBudgetHardKillTimer);
				turnBudgetHardKillTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		child.on("exit", (exitCode, signal) => {
			childExited = true;
			exitCodeFromExit = exitCode;
			exitSignalFromExit = signal;
			clearDrainTimers();
			disableSoftInterrupts();
			void resolveProcessCleanup().finally(() => {
				if (settled) return;
				closeFallbackTimer = setTimeout(() => {
					if (settled) return;
					try {
						child.stdout?.destroy();
					} catch {
						void 0;
					}
					try {
						child.stderr?.destroy();
					} catch {
						void 0;
					}
					finalize(exitCodeFromExit, exitSignalFromExit);
				}, CLOSE_FALLBACK_MS);
				closeFallbackTimer.unref?.();
			});
		});
		child.on("close", (exitCode, signal) => {
			disableSoftInterrupts();
			void resolveProcessCleanup().finally(() => {
				finalize(exitCode, signal);
			});
		});

		child.on("error", (spawnError) => {
			processCleanup = skipOwnedProcessGroupCleanup(
				supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform",
				processGroupId,
			);
			settled = true;
			disableSoftInterrupts();
			registerInterrupt?.(undefined);
			registerTimeout?.(undefined);
			registerTurnBudgetAbort?.(undefined);
			clearDrainTimers();
			clearCloseFallbackTimer();
			clearStdioGuard();
			outputStream.end();
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const spawnErrorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
			resolve({
				stderr,
				exitCode: 1,
				messages,
				usage,
				model,
				error: timedOut
					? (timeoutMessage ?? "Subagent timed out.")
					: turnBudgetExceeded
						? turnBudgetMessage
						: (error ?? assistantError ?? spawnErrorMessage),
				finalOutput: timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput,
				timedOut,
				turnBudget,
				turnBudgetExceeded,
				wrapUpRequested: turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined,
				observedMutationAttempt,
				processGroupId,
				processCleanup,
				contextUsage,
				runtimeModelIdentity,
				configuredModel: context?.configuredModel,
				assistantStopReason: finalAssistantStopReason,
			});
		});
	});
}

function resolvePiPackageRootFallback(): string {
	const root = resolveInstalledPiPackageRoot();
	if (root) return root;
	throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}

async function exportSessionHtml(sessionFile: string, outputDir: string, piPackageRoot?: string): Promise<string> {
	const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
	const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
	const moduleUrl = pathToFileURL(exportModulePath).href;
	const mod = await import(moduleUrl);
	const exportFromFile = (mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string })
		.exportFromFile;
	if (typeof exportFromFile !== "function") {
		throw new Error("exportFromFile not available");
	}
	const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
	return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(htmlPath: string): { shareUrl: string; gistUrl: string } | { error: string } {
	try {
		const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (auth.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed." };
	}

	try {
		const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
		if (result.status !== 0) {
			const err = (result.stderr || "").trim() || "Failed to create gist.";
			return { error: err };
		}
		const gistUrl = (result.stdout || "").trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) return { error: "Failed to parse gist ID." };
		const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
		return { shareUrl, gistUrl };
	} catch (err) {
		return { error: String(err) };
	}
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60000);
	const seconds = Math.floor((ms % 60000) / 1000);
	return `${minutes}m${seconds}s`;
}

function writeRunLog(
	logPath: string,
	input: {
		id: string;
		mode: SubagentRunMode;
		cwd: string;
		startedAt: number;
		endedAt: number;
		steps: Array<{
			agent: string;
			status: string;
			durationMs?: number;
			processCleanup?: ChildProcessCleanupResult;
		}>;
		summary: string;
		truncated: boolean;
		artifactsDir?: string;
		sessionFile?: string;
		shareUrl?: string;
		shareError?: string;
	},
): void {
	const lines: string[] = [];
	lines.push(`# Subagent run ${input.id}`);
	lines.push("");
	lines.push(`- **Mode:** ${input.mode}`);
	lines.push(`- **CWD:** ${input.cwd}`);
	lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
	lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
	lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
	if (input.sessionFile) lines.push(`- **Session:** ${input.sessionFile}`);
	if (input.shareUrl) lines.push(`- **Share:** ${input.shareUrl}`);
	if (input.shareError) lines.push(`- **Share error:** ${input.shareError}`);
	if (input.artifactsDir) lines.push(`- **Artifacts:** ${input.artifactsDir}`);
	lines.push("");
	lines.push("## Steps");
	lines.push("| Step | Agent | Status | Duration |");
	lines.push("| --- | --- | --- | --- |");
	input.steps.forEach((step, i) => {
		const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
		lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
	});
	const cleanupSteps = input.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.processCleanup);
	if (cleanupSteps.length > 0) {
		lines.push("");
		lines.push("## Process cleanup");
		for (const { step, index } of cleanupSteps) {
			const cleanup = step.processCleanup;
			if (!cleanup) continue;
			lines.push(`${index + 1}. ${step.agent}: ${formatOwnedProcessGroupCleanup(cleanup)}`);
			for (const warning of cleanup.warnings ?? []) lines.push(`   - Warning: ${warning}`);
		}
	}
	lines.push("");
	lines.push("## Summary");
	if (input.truncated) {
		lines.push("_Output truncated_");
		lines.push("");
	}
	lines.push(input.summary.trim() || "(no output)");
	lines.push("");
	fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}

/** Context for running a single step */
interface SingleStepContext {
	previousOutput: string;
	outputs?: ChainOutputMap;
	placeholder: string;
	cwd: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	id: string;
	flatIndex: number;
	flatStepCount: number;
	outputFile: string;
	steerInboxDir?: string;
	transcriptPath?: string;
	piPackageRoot?: string;
	piArgv1?: string;
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	registerTimeout?: (interrupt: (() => void) | undefined) => void;
	registerTurnBudgetAbort?: (abort: ((message: string, state?: TurnBudgetState) => void) | undefined) => void;
	interruptSignal?: AbortSignal;
	interruptMessage?: string;
	timeoutSignal?: AbortSignal;
	timeoutMessage?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	startedAt?: number;
	turnBudget?: ResolvedTurnBudget;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: NestedRouteInfo;
	onAttemptStart?: (attempt: ModelAttemptStart) => void;
	onChildEvent?: (event: ChildEvent) => void;
	skipAcceptance?: () => boolean;
}

/**
 * Whether dispatch preparation dropped the configured thinking level for this
 * model. Explicit per-candidate metadata is authoritative: duplicate
 * human-facing drop notes are deduplicated across chain/parallel steps, so
 * note inference is only a fallback for legacy runner inputs without the field.
 */
function dispatchThinkingDropped(step: SubagentStep, model: string | undefined): boolean {
	if (!model) return false;
	if (step.thinkingDroppedModels) return step.thinkingDroppedModels.includes(model);
	return Boolean(step.attemptNotes?.some((note) => note.includes(`model "${model}"`)));
}

/** Crash-window snapshot persisted to status when a model attempt starts. */
interface ModelAttemptStart {
	model?: string;
	thinking?: string;
	modelIdentity?: SubagentModelIdentity;
	modelResolution?: SubagentModelResolution;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
}

/** Run a single pi agent step, returning output and metadata */
async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	agent: string;
	output: string;
	exitCode: number | null;
	exitSignal?: NodeJS.Signals;
	error?: string;
	model?: string;
	modelIdentity?: SubagentModelIdentity;
	modelResolution?: SubagentModelResolution;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	totalCost?: CostSummary;
	artifactPaths?: ArtifactPaths;
	processCleanup?: ChildProcessCleanupResult;
	transcriptPath?: string;
	transcriptError?: string;
	interrupted?: boolean;
	timedOut?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	toolBudget?: ToolBudgetState;
	toolBudgetBlocked?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	completionGuardTriggered?: boolean;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
	modelFallbackNotice?: string;
	contextUsage?: ContextUsageDiagnostics;
	contextPressure?: ContextPressureProjection;
	contextPressureCrossedThresholds?: ContextPressureThreshold[];
	terminationReason?: SubagentTerminationReason;
	activeRuntimeMs?: number;
}> {
	const segmentStartedAt = ctx.startedAt ?? Date.now();
	const priorActiveRuntimeMs = Math.max(0, step.activeRuntimeMs ?? 0);
	const stepTimeoutController = new AbortController();
	let activeTimeoutInterrupt: (() => void) | undefined;
	const inheritedTimeoutSignal = ctx.timeoutSignal;
	const relayInheritedTimeout = () => stepTimeoutController.abort();
	if (inheritedTimeoutSignal?.aborted) relayInheritedTimeout();
	else inheritedTimeoutSignal?.addEventListener("abort", relayInheritedTimeout, { once: true });
	const childDeadlineAt =
		ctx.deadlineAt ?? (step.timeoutMs !== undefined ? segmentStartedAt + step.timeoutMs : undefined);
	const stepTimeoutTimer =
		step.timeoutMs !== undefined
			? scheduleDeadline(childDeadlineAt ?? segmentStartedAt, () => {
					stepTimeoutController.abort();
					activeTimeoutInterrupt?.();
				})
			: undefined;
	const parentRegisterTimeout = ctx.registerTimeout;
	ctx = {
		...ctx,
		timeoutSignal: stepTimeoutController.signal,
		timeoutMessage: step.timeoutMs !== undefined ? `Subagent timed out after ${step.timeoutMs}ms.` : ctx.timeoutMessage,
		registerTimeout: (interrupt) => {
			activeTimeoutInterrupt = interrupt;
			parentRegisterTimeout?.(interrupt);
		},
	};
	const effectiveStructuredOutput =
		step.structuredOutput ??
		(step.structuredOutputSchema
			? createStructuredOutputRuntime(
					step.structuredOutputSchema,
					path.join(path.dirname(ctx.outputFile), "structured-output"),
				)
			: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	const taskForCompletionGuard = task;
	if (step.effectiveAcceptance) {
		const acceptancePrompt = formatAcceptancePrompt(step.effectiveAcceptance);
		if (acceptancePrompt) task = `${task}\n${acceptancePrompt}`;
	}
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
		if (ctx.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPaths.transcriptPath,
				source: "async",
				runId: ctx.id,
				agent: step.agent,
				childIndex: ctx.flatIndex,
				cwd: step.cwd ?? ctx.cwd,
			});
		}
	}
	transcriptWriter?.writeInitialUserMessage(task);

	const candidates =
		step.modelCandidates && step.modelCandidates.length > 0
			? step.modelCandidates
			: step.model
				? [step.model]
				: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [...(step.attemptNotes ?? [])];
	let modelResolution = step.modelResolution;
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;
	let completionGuardTriggeredFinal = false;
	let turnBudget = ctx.turnBudget ? initialTurnBudgetState(ctx.turnBudget) : undefined;
	let toolBudget = step.toolBudget ? initialToolBudgetState(step.toolBudget) : undefined;
	let toolBudgetBlocked = false;
	let contextExhaustedDetected = false;
	let firstAttemptIdentity: SubagentModelIdentity | undefined;
	// Async fresh runs commonly receive a preallocated session path. Snapshot
	// whether its artifact existed before the first child is spawned so fallback
	// attempts in this invocation cannot become restored attempts.
	const restoredSession = hasUsableSessionArtifact(step.sessionFile);
	const persistedContextUsage = parseContextUsageDiagnostics(step.contextUsage);
	let aggregateContextUsage: ContextUsageDiagnostics | undefined = persistedContextUsage
		? {
				...persistedContextUsage,
				...(persistedContextUsage.restoredTokens === undefined && persistedContextUsage.contextTokens !== undefined
					? { restoredTokens: persistedContextUsage.contextTokens }
					: {}),
			}
		: undefined;
	let finalAttemptContextUsage: ContextUsageDiagnostics | undefined;

	for (let index = 0; index < candidates.length; index++) {
		if (ctx.timeoutSignal?.aborted || ctx.skipAcceptance?.()) break;
		const candidate = candidates[index];
		// Support-aware effective identity for this attempt: never persist a
		// thinking level that dispatch preparation already dropped as unsupported.
		const attemptThinking = dispatchThinkingDropped(step, candidate)
			? undefined
			: resolveEffectiveThinking(candidate, step.thinking);
		const attemptIdentity = canonicalSubagentModelIdentity(candidate, attemptThinking);
		if (index === 0) firstAttemptIdentity = attemptIdentity;
		// If the process dies mid-attempt, the last status write must still carry
		// the original identity, fallback reason, and completed attempt history so
		// durable resume does not mistake a runtime fallback for the original
		// selection. Persist the full transition in one status write.
		let attemptResolution = modelResolution;
		if (index > 0) {
			modelResolution = appendRuntimeFallbackResolution({
				previous: modelResolution,
				sourceAttempt: modelAttempts.at(-1),
				currentIdentity: attemptIdentity,
				originalIdentity: firstAttemptIdentity,
			});
			attemptResolution = modelResolution;
		}
		ctx.onAttemptStart?.({
			model: candidate,
			thinking: attemptThinking,
			modelIdentity: attemptIdentity,
			modelResolution: attemptResolution,
			attemptedModels: candidate ? [...attemptedModels, candidate] : undefined,
			modelAttempts: modelAttempts.length > 0 ? [...modelAttempts] : undefined,
		});
		const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
		if (effectiveStructuredOutput) {
			try {
				if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
			} catch {
				// Missing/stale structured-output files are handled after the child exits.
			}
		}
		const { args, env, tempDir } = buildPiArgs({
			parentSessionId: step.parentSessionId,
			baseArgs: ["--mode", "json", "-p"],
			task,
			sessionEnabled,
			sessionDir,
			sessionFile: step.sessionFile,
			model: candidate,
			inheritProjectContext: step.inheritProjectContext,
			inheritSkills: step.inheritSkills,
			requireReadTool: Boolean(step.skills?.length),
			tools: step.tools,
			extensions: step.extensions,
			subagentOnlyExtensions: step.subagentOnlyExtensions,
			systemPrompt: appendTurnBudgetSystemPrompt(step.systemPrompt ?? "", ctx.turnBudget),
			systemPromptMode: step.systemPromptMode,
			cwd: step.cwd ?? ctx.cwd,
			promptFileStem: step.agent,
			intercomSessionName: ctx.childIntercomTarget,
			orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
			runId: ctx.id,
			childAgentName: step.agent,
			childIndex: ctx.flatIndex,
			steerInboxDir: ctx.steerInboxDir,
			structuredOutput: effectiveStructuredOutput,
			toolBudget: step.toolBudget,
		});
		const run = await runPiStreaming(
			args,
			step.cwd ?? ctx.cwd,
			ctx.outputFile,
			env,
			ctx.piPackageRoot,
			ctx.piArgv1,
			step.maxSubagentDepth,
			{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
			ctx.registerInterrupt,
			ctx.onChildEvent,
			transcriptWriter,
			ctx.registerTimeout,
			ctx.timeoutMessage,
			ctx.registerTurnBudgetAbort,
			{
				restored: restoredSession,
				configuredModel: candidate,
				contextWindow: contextWindowForModel(candidate, step.contextWindows),
				contextWindows: step.contextWindows,
			},
		);
		finalAttemptContextUsage = run.contextUsage;
		aggregateContextUsage = mergeContextUsageDiagnostics(aggregateContextUsage, run.contextUsage);
		if (run.turnBudget) turnBudget = run.turnBudget;
		else if (ctx.turnBudget) {
			const assistantMessages = run.messages.filter((message) => message.role === "assistant");
			const turnCount = assistantMessages.length;
			const lastAssistantMessage = assistantMessages.at(-1);
			if (turnCount > 0 && turnCount < ctx.turnBudget.maxTurns) {
				turnBudget = { ...ctx.turnBudget, outcome: "within-budget", turnCount };
			} else if (turnCount >= ctx.turnBudget.maxTurns) {
				turnBudget = turnBudgetState(
					ctx.turnBudget,
					turnCount,
					shouldAbortForTurnBudget(
						ctx.turnBudget,
						turnCount,
						lastAssistantMessage ? isTerminalAssistantStop(lastAssistantMessage) : false,
					),
				);
			}
		}
		cleanupTempDir(tempDir);

		const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
		const runTerminationReason = resolveSubagentTerminationReason({
			assistantStopReason: run.assistantStopReason,
			effectiveExitCode: run.exitCode ?? undefined,
			processCompleted: true,
		});
		const contextExhaustedSignature = classifyContextExhaustedTermination({
			messages: run.messages,
			// A retry is a new diagnostic scope; prior attempts remain aggregate
			// reporting data but cannot pressure-classify this attempt.
			contextUsage: run.contextUsage,
			exitCode: run.exitCode ?? undefined,
			error: run.error,
			terminationReason: runTerminationReason,
		});
		// Keep this scoped to the current attempt; a failed prior attempt must
		// never make a later fallback look context-exhausted.
		contextExhaustedDetected = run.contextExhausted === true || contextExhaustedSignature === "context_exhausted";
		const missingStructuredOutput = effectiveStructuredOutput
			? !fs.existsSync(effectiveStructuredOutput.outputPath)
			: false;
		const emptyOutputError =
			run.exitCode === 0 &&
			!run.error &&
			!hiddenError?.hasError &&
			!contextExhaustedSignature &&
			!run.finalOutput.trim() &&
			(!effectiveStructuredOutput || missingStructuredOutput)
				? "Subagent produced no output (possible model cold-start or empty response)."
				: undefined;
		let structuredOutput: unknown;
		let structuredError: string | undefined;
		if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError && !emptyOutputError) {
			const structured = readStructuredOutput({
				schema: effectiveStructuredOutput.schema,
				schemaPath: effectiveStructuredOutput.schemaPath,
				outputPath: effectiveStructuredOutput.outputPath,
			});
			if (structured.error) structuredError = structured.error;
			else structuredOutput = structured.value;
		}
		const completionGuard =
			run.exitCode === 0 && !run.error && !hiddenError?.hasError && !emptyOutputError && step.completionGuard !== false
				? evaluateCompletionMutationGuard({
						agent: step.agent,
						task: taskForCompletionGuard,
						messages: run.messages,
						tools: step.tools,
					})
				: undefined;
		const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
		const completionGuardError = completionGuardTriggered
			? "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes."
			: undefined;
		const effectiveExitCode = completionGuardTriggered
			? 1
			: structuredError
				? 1
				: hiddenError?.hasError
					? (hiddenError.exitCode ?? 1)
					: emptyOutputError
						? 1
						: run.error && run.exitCode === 0
							? 1
							: run.exitCode;
		const error =
			completionGuardError ??
			structuredError ??
			(hiddenError?.hasError
				? hiddenError.details
					? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
					: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
				: (emptyOutputError ??
					(run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined))));
		const attempt: ModelAttempt = {
			model: candidate ?? run.model ?? step.model ?? "default",
			success: effectiveExitCode === 0 && !error,
			exitCode: effectiveExitCode,
			error,
			usage: run.usage,
		};
		modelAttempts.push(attempt);
		if (candidate) attemptedModels.push(candidate);
		completionGuardTriggeredFinal = completionGuardTriggered;
		finalOutputSnapshot = outputSnapshot;
		if (step.toolBudget) {
			const toolMessages = run.messages.filter((message) => message.role === "toolResult");
			const blockedMessage = toolMessages.find((message) =>
				extractTextFromContent(message.content).includes("Tool budget hard limit reached"),
			);
			toolBudgetBlocked = Boolean(blockedMessage);
			toolBudget = toolBudgetState(
				step.toolBudget,
				toolMessages.length,
				blockedMessage ? (blockedMessage as { toolName?: string }).toolName : undefined,
			);
		}
		finalResult = {
			...run,
			exitCode: effectiveExitCode,
			model: candidate ?? run.model,
			error,
			structuredOutput,
		} as RunPiStreamingResult & { structuredOutput?: unknown };
		if (run.turnBudgetExceeded) break;
		if (run.timedOut || ctx.timeoutSignal?.aborted || ctx.skipAcceptance?.()) break;
		if (attempt.success || completionGuardTriggered) break;
		if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
	}

	const processCleanup =
		finalResult?.processCleanup ??
		skipOwnedProcessGroupCleanup(
			supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform",
			finalResult?.processGroupId,
		);
	const modelFallbackNotice =
		modelAttempts.length > 1 ? sanitizeModelFallbackNotice(step.modelFallbackNotice) : undefined;
	const finalModel = finalResult?.model;
	// A dispatched candidate is authoritative. For an unconfigured run, only the
	// first validated child report is eligible to become the effective identity;
	// runtime observation is not a model-resolution override or fallback.
	const finalConfiguredIdentity = finalResult?.configuredModel
		? canonicalSubagentModelIdentity(
				finalResult.configuredModel,
				dispatchThinkingDropped(step, finalResult.configuredModel) ? undefined : step.thinking,
			)
		: undefined;
	const finalModelIdentity = finalConfiguredIdentity ?? finalResult?.runtimeModelIdentity;
	if (modelAttempts.length > 1 && finalConfiguredIdentity) {
		modelResolution = appendRuntimeFallbackResolution({
			previous: modelResolution,
			sourceAttempt: modelAttempts.at(-2),
			currentIdentity: finalConfiguredIdentity,
			originalIdentity: firstAttemptIdentity,
		});
	} else if (modelResolution && finalConfiguredIdentity) {
		modelResolution = { ...modelResolution, resumed: finalConfiguredIdentity };
	}
	if (modelResolution) {
		const resolutionNotice = `Notice: ${modelResolution.reason}`;
		if (!attemptNotes.some((note) => note.includes(modelResolution!.reason))) attemptNotes.push(resolutionNotice);
	}
	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = stripAcceptanceReport(rawOutput);
	const { report: rawAcceptanceReport } = parseAcceptanceReport(rawOutput);
	const resolvedOutput =
		step.outputPath && finalResult?.exitCode === 0
			? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
			: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath
		? formatSavedOutputReference(resolvedOutput.savedPath, output)
		: undefined;
	let outputForSummary = output;
	if (modelFallbackNotice) {
		outputForSummary = `Notice: ${modelFallbackNotice}\n\n${outputForSummary}`.trim();
	}
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	if (!finalResult?.timedOut && finalResult?.turnBudgetExceeded && turnBudget) {
		outputForSummary = formatTurnBudgetOutput(
			turnBudgetExceededMessage(turnBudget, turnBudget.turnCount),
			outputForSummary,
		);
	} else if (!finalResult?.timedOut && turnBudget?.outcome === "wrap-up-requested") {
		const note = turnBudgetSoftNote(turnBudget, turnBudget.wrapUpRequestedAtTurn ?? turnBudget.turnCount);
		outputForSummary = outputForSummary.trim() ? `${note}\n\n${outputForSummary}` : note;
	}
	const outputForAcceptance = rawOutput;
	const finalizedOutput = finalizeSingleOutput({
		fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const acceptanceAbortController = new AbortController();
	const acceptanceAbortListeners: Array<() => void> = [];
	const relayAcceptanceAbort = (signal: AbortSignal | undefined, abort: () => void) => {
		if (!signal) return;
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		acceptanceAbortListeners.push(() => signal.removeEventListener("abort", abort));
	};
	let interruptedDuringAcceptance = false;
	relayAcceptanceAbort(ctx.timeoutSignal, () => acceptanceAbortController.abort());
	relayAcceptanceAbort(ctx.interruptSignal, () => {
		interruptedDuringAcceptance = true;
		acceptanceAbortController.abort();
	});
	ctx.registerInterrupt?.(() => {
		interruptedDuringAcceptance = true;
		acceptanceAbortController.abort();
	});
	const acceptance =
		step.effectiveAcceptance &&
		!finalResult?.interrupted &&
		!finalResult?.turnBudgetExceeded &&
		!ctx.timeoutSignal?.aborted &&
		!ctx.interruptSignal?.aborted &&
		!acceptanceAbortController.signal.aborted &&
		!ctx.skipAcceptance?.()
			? await evaluateAcceptance({
					acceptance: step.effectiveAcceptance,
					output: outputForAcceptance,
					cwd: step.cwd ?? ctx.cwd,
					signal: acceptanceAbortController.signal,
					abortMessage: interruptedDuringAcceptance
						? (ctx.interruptMessage ?? "Interrupted. Waiting for explicit next action.")
						: (ctx.timeoutMessage ?? "Subagent timed out."),
				})
			: undefined;
	ctx.registerInterrupt?.(undefined);
	for (const removeAbortListener of acceptanceAbortListeners) removeAbortListener();
	const effectiveInterrupted =
		finalResult?.interrupted === true ||
		interruptedDuringAcceptance ||
		(ctx.interruptSignal?.aborted === true && !ctx.timeoutSignal?.aborted && !ctx.skipAcceptance?.());
	const interruptedAcceptance =
		effectiveInterrupted && step.effectiveAcceptance
			? buildSkippedAcceptanceLedger({
					acceptance: step.effectiveAcceptance,
					ledgerStatus: "skipped",
					runtimeCheckStatus: "not-applicable",
					id: "paused",
					message:
						"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
				})
			: undefined;
	const timedOutAfterAcceptance =
		finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true || ctx.skipAcceptance?.() === true;
	const turnBudgetExceeded = finalResult?.turnBudgetExceeded === true;
	const effectiveAcceptance =
		timedOutAfterAcceptance || turnBudgetExceeded ? undefined : (interruptedAcceptance ?? acceptance);
	const acceptanceFailure = effectiveAcceptance ? acceptanceFailureMessage(effectiveAcceptance) : undefined;
	const acceptanceCanFailRun =
		acceptanceFailure &&
		effectiveAcceptance?.explicit &&
		(finalResult?.exitCode ?? 1) === 0 &&
		!effectiveInterrupted &&
		!timedOutAfterAcceptance &&
		!turnBudgetExceeded;
	let effectiveFinalExitCode =
		timedOutAfterAcceptance || turnBudgetExceeded
			? 1
			: effectiveInterrupted
				? 0
				: acceptanceCanFailRun
					? 1
					: (finalResult?.exitCode ?? 1);
	let terminationReason = resolveSubagentTerminationReason({
		paused: effectiveInterrupted,
		timedOut: timedOutAfterAcceptance,
		turnBudgetExceeded,
		toolBudgetBlocked,
		interrupted: effectiveInterrupted,
		assistantStopReason: finalResult?.assistantStopReason,
		effectiveExitCode: effectiveFinalExitCode,
		processCompleted: true,
	});
	let effectiveFinalError = timedOutAfterAcceptance
		? (ctx.timeoutMessage ?? "Subagent timed out.")
		: turnBudgetExceeded
			? (finalResult?.error ??
				(turnBudget ? turnBudgetExceededMessage(turnBudget, turnBudget.turnCount) : "Subagent exceeded turn budget."))
			: effectiveInterrupted
				? undefined
				: acceptanceCanFailRun
					? finalResult?.error
						? `${finalResult.error}\n${acceptanceFailure}`
						: acceptanceFailure
					: finalResult?.error;
	const contextExhaustedReason =
		contextExhaustedDetected &&
		!timedOutAfterAcceptance &&
		!turnBudgetExceeded &&
		!effectiveInterrupted &&
		!acceptanceCanFailRun &&
		finalResult?.error === CONTEXT_EXHAUSTED_TERMINATION_MESSAGE &&
		terminationReason === "process_exit"
			? "context_exhausted"
			: classifyContextExhaustedTermination({
					messages: finalResult?.messages,
					// Use only the final attempt for false-success classification;
					// aggregateContextUsage remains the persisted reporting diagnostic.
					contextUsage: finalAttemptContextUsage,
					exitCode: effectiveFinalExitCode,
					error: effectiveFinalError,
					terminationReason,
				});
	if (contextExhaustedReason) {
		effectiveFinalExitCode = 1;
		effectiveFinalError = CONTEXT_EXHAUSTED_TERMINATION_MESSAGE;
		terminationReason = contextExhaustedReason;
	}

	if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			const artifactBaseOutput =
				effectiveFinalExitCode !== 0 && !effectiveInterrupted
					? formatErrorWithOutput(effectiveFinalError, output)
					: output;
			// The artifact file is the supervisor-facing surface; the digest goes here
			// only, keeping `output`/`outputForSummary` (the returned semantic value and
			// any persisted output file) free of appended text.
			//
			// Exception: when the run saved a user-requested output file, the artifact is
			// a verbatim archive of that deliverable, so it stays byte-exact.
			const artifactOutput =
				rawAcceptanceReport && !resolvedOutput.savedPath
					? appendAcceptanceReportDigest(artifactBaseOutput, rawAcceptanceReport)
					: artifactBaseOutput;
			fs.writeFileSync(artifactPaths.outputPath, artifactOutput, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify(
					{
						runId: ctx.id,
						agent: step.agent,
						task,
						exitCode: effectiveFinalExitCode,
						exitSignal: finalResult?.exitSignal,
						model: finalResult?.model,
						modelIdentity: finalModelIdentity,
						modelResolution,
						attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
						modelAttempts,
						modelFallbackNotice,
						error: effectiveFinalError,
						terminationReason,
						contextUsage: aggregateContextUsage,
						contextPressure: step.contextPressure,
						contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
						processCleanup,
						...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
						transcriptError: transcriptWriter?.getError(),
						skills: step.skills,
						activeRuntimeMs: priorActiveRuntimeMs + (Date.now() - segmentStartedAt),
						timeoutMs: ctx.timeoutMs ?? step.timeoutMs,
						deadlineAt: childDeadlineAt,
						timestamp: Date.now(),
					},
					null,
					2,
				),
				"utf-8",
			);
		}
	}

	stepTimeoutTimer?.cancel();
	inheritedTimeoutSignal?.removeEventListener("abort", relayInheritedTimeout);
	parentRegisterTimeout?.(undefined);

	return {
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		exitSignal: finalResult?.exitSignal,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalModel,
		modelIdentity: finalModelIdentity,
		modelResolution,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		modelFallbackNotice,
		totalCost: costSummaryFromAttempts(modelAttempts),
		artifactPaths,
		processCleanup,
		contextUsage: aggregateContextUsage,
		contextPressure: step.contextPressure,
		contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
		terminationReason,
		transcriptPath: transcriptWriter ? artifactPaths?.transcriptPath : undefined,
		transcriptError: transcriptWriter?.getError(),
		interrupted: timedOutAfterAcceptance || turnBudgetExceeded ? false : effectiveInterrupted,
		timedOut: timedOutAfterAcceptance ? true : finalResult?.timedOut,
		turnBudget,
		turnBudgetExceeded: turnBudgetExceeded || undefined,
		wrapUpRequested:
			finalResult?.wrapUpRequested || turnBudget?.outcome === "wrap-up-requested" || turnBudgetExceeded || undefined,
		toolBudget,
		toolBudgetBlocked: toolBudgetBlocked || undefined,
		completionGuardTriggered: completionGuardTriggeredFinal,
		structuredOutput:
			timedOutAfterAcceptance || turnBudgetExceeded
				? undefined
				: (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath:
			timedOutAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath:
			timedOutAfterAcceptance || turnBudgetExceeded ? undefined : effectiveStructuredOutput?.schemaPath,
		acceptance: effectiveAcceptance,
		activeRuntimeMs: priorActiveRuntimeMs + (Date.now() - segmentStartedAt),
	};
}

type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	exitCode?: number | null;
};

type RunnerStatusPayload = Omit<
	AsyncStatus,
	"steps" | "parallelGroups" | "pid" | "cwd" | "currentStep" | "chainStepCount" | "lastUpdate"
> & {
	pid?: number;
	cwd: string;
	currentStep: number;
	chainStepCount: number;
	parallelGroups: AsyncParallelGroupStatus[];
	steps: RunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	error?: string;
};

function markParallelGroupRunning(input: {
	statusPayload: RunnerStatusPayload;
	group: Extract<RunnerStep, { parallel: SubagentStep[] }>;
	groupStartFlatIndex: number;
	groupStartTime: number;
	statusPath: string;
	eventsPath: string;
	asyncDir: string;
	runId: string;
	stepIndex: number;
}): void {
	for (let taskIndex = 0; taskIndex < input.group.parallel.length; taskIndex++) {
		const flatTaskIndex = input.groupStartFlatIndex + taskIndex;
		input.statusPayload.steps[flatTaskIndex].status = "pending";
		input.statusPayload.steps[flatTaskIndex].startedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].endedAt = undefined;
		input.statusPayload.steps[flatTaskIndex].durationMs = undefined;
		input.statusPayload.steps[flatTaskIndex].lastActivityAt = undefined;
		input.statusPayload.steps[flatTaskIndex].activityState = undefined;
		input.statusPayload.steps[flatTaskIndex].error = undefined;
	}
	input.statusPayload.currentStep = input.groupStartFlatIndex;
	input.statusPayload.activityState = undefined;
	input.statusPayload.lastActivityAt = input.groupStartTime;
	input.statusPayload.lastUpdate = input.groupStartTime;
	input.statusPayload.outputFile = path.join(input.asyncDir, `output-${input.groupStartFlatIndex}.log`);
	writeAtomicJson(input.statusPath, input.statusPayload);
	appendJsonl(
		input.eventsPath,
		JSON.stringify({
			type: "subagent.parallel.started",
			ts: input.groupStartTime,
			runId: input.runId,
			stepIndex: input.stepIndex,
			agents: input.group.parallel.map((task) => task.agent),
			count: input.group.parallel.length,
		}),
	);
}

function resolveAsyncStepTranscriptPath(input: {
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	runId: string;
	agent: string;
	flatIndex: number;
	flatStepCount: number;
}): string | undefined {
	if (
		!input.artifactsDir ||
		input.artifactConfig?.enabled === false ||
		input.artifactConfig?.includeTranscript === false
	)
		return undefined;
	return getArtifactPaths(
		input.artifactsDir,
		input.runId,
		input.agent,
		input.flatStepCount > 1 ? input.flatIndex : undefined,
	).transcriptPath;
}

type SingleStepResult = Awaited<ReturnType<typeof runSingleStep>>;
type ParallelStepExecutionResult = SingleStepResult & { skipped?: boolean };

function isPausedStepStatus(status: RunnerStatusStep["status"]): boolean {
	return status === "paused";
}

async function runSubagent(config: SubagentRunConfig): Promise<void> {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
		config;
	const globalSemaphore = new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
	let previousOutput = "";
	const outputs: ChainOutputMap = {};
	const results: StepResult[] = [];
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const activeChildInterrupts = new Map<number, () => void>();
	const activeChildTimeouts = new Map<number, () => void>();
	const activeChildTurnBudgetAborts = new Map<number, (message: string, state?: TurnBudgetState) => void>();
	const pendingStepSteers: ChildMessageRequest[] = [];
	let interrupted = false;
	let currentActivityState: ActivityState | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: DeadlineTimer | undefined;
	let timedOut = false;
	let turnBudgetExceeded = false;
	const timeoutMessage = config.timeoutMs !== undefined ? `Subagent timed out after ${config.timeoutMs}ms.` : undefined;
	const timeoutAbortController = new AbortController();
	const interruptAbortController = new AbortController();
	let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
	let latestSessionFile: string | undefined;

	const flatSteps = flattenSteps(steps);
	for (const step of flatSteps) {
		step.contextPressure = parseContextPressureProjection(step.contextPressure);
		step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
			step.contextPressureCrossedThresholds,
		);
	}
	const initialFlatStepCount = flatSteps.length;
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) {
				const taskFlatIndex = flatStepCount;
				const transcriptPath = resolveAsyncStepTranscriptPath({
					artifactsDir,
					artifactConfig,
					runId: id,
					agent: task.agent,
					flatIndex: taskFlatIndex,
					flatStepCount: initialFlatStepCount,
				});
				initialStatusSteps.push({
					agent: task.agent,
					phase: task.phase,
					label: task.label,
					outputName: task.outputName,
					structured: task.structured,
					status: "pending",
					...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
					...(task.timeoutMs !== undefined || config.timeoutMs !== undefined
						? { timeoutMs: task.timeoutMs ?? config.timeoutMs }
						: {}),
					...(task.activeRuntimeMs !== undefined ? { activeRuntimeMs: task.activeRuntimeMs } : {}),
					...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
					...(transcriptPath ? { transcriptPath } : {}),
					skills: task.skills,
					model: task.model,
					thinking: task.thinking,
					...(task.modelIdentity ? { modelIdentity: task.modelIdentity } : {}),
					...(task.modelResolution ? { modelResolution: task.modelResolution } : {}),
					...(task.contextUsage ? { contextUsage: task.contextUsage } : {}),
					...(task.contextPressure ? { contextPressure: { ...task.contextPressure } } : {}),
					...(task.contextPressureCrossedThresholds
						? { contextPressureCrossedThresholds: [...task.contextPressureCrossedThresholds] }
						: {}),
					attemptedModels:
						task.modelCandidates && task.modelCandidates.length > 0
							? task.modelCandidates
							: task.model
								? [task.model]
								: undefined,
					recentTools: [],
					recentOutput: [],
				});
				flatStepCount++;
			}
		} else {
			const stepFlatIndex = flatStepCount;
			const transcriptPath = resolveAsyncStepTranscriptPath({
				artifactsDir,
				artifactConfig,
				runId: id,
				agent: step.agent,
				flatIndex: stepFlatIndex,
				flatStepCount: initialFlatStepCount,
			});
			initialStatusSteps.push({
				agent: step.agent,
				phase: step.phase,
				label: step.label,
				outputName: step.outputName,
				structured: step.structured,
				status: "pending",
				...(step.toolBudget ? { toolBudget: initialToolBudgetState(step.toolBudget) } : {}),
				...(step.timeoutMs !== undefined || config.timeoutMs !== undefined
					? { timeoutMs: step.timeoutMs ?? config.timeoutMs }
					: {}),
				...(step.activeRuntimeMs !== undefined ? { activeRuntimeMs: step.activeRuntimeMs } : {}),
				...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
				...(transcriptPath ? { transcriptPath } : {}),
				skills: step.skills,
				model: step.model,
				thinking: step.thinking,
				...(step.modelIdentity ? { modelIdentity: step.modelIdentity } : {}),
				...(step.modelResolution ? { modelResolution: step.modelResolution } : {}),
				...(step.contextUsage ? { contextUsage: step.contextUsage } : {}),
				...(step.contextPressure ? { contextPressure: { ...step.contextPressure } } : {}),
				...(step.contextPressureCrossedThresholds
					? { contextPressureCrossedThresholds: [...step.contextPressureCrossedThresholds] }
					: {}),
				attemptedModels:
					step.modelCandidates && step.modelCandidates.length > 0
						? step.modelCandidates
						: step.model
							? [step.model]
							: undefined,
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		}
	}
	const sessionEnabled =
		Boolean(config.sessionDir) || shareEnabled || flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
		...(config.turnBudget ? { turnBudget: initialTurnBudgetState(config.turnBudget) } : {}),
		...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		...(config.tkTicket ? { tkTicket: config.tkTicket } : {}),
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};

	fs.mkdirSync(asyncDir, { recursive: true });
	writeNormalizedLifecycleStatus(asyncDir, statusPayload);
	if (config.continuationSource) {
		const gate = finalizeLifecycleContinuationLaunch(
			config.continuationSource.asyncDir,
			config.continuationSource.index,
			config.continuationSource.claimToken,
			id,
		);
		if (!gate.finalized) {
			statusPayload.state = "failed";
			statusPayload.pid = undefined;
			statusPayload.endedAt = Date.now();
			statusPayload.lastUpdate = statusPayload.endedAt;
			statusPayload.error = `Continuation launch gate rejected for source run '${config.continuationSource.runId}' child ${config.continuationSource.index}.`;
			statusPayload.steps = statusPayload.steps?.map((step, index) =>
				index === 0
					? {
							...step,
							status: "failed",
							endedAt: statusPayload.endedAt,
							exitCode: 1,
							terminationReason: step.terminationReason ?? "process_exit",
							error: statusPayload.error,
						}
					: step,
			);
			writeNormalizedLifecycleStatus(asyncDir, statusPayload);
			// Option (b): explicit inline failure artifact. The terminal result writer at
			// the bottom of runSubagent is unreachable from this early return, so any waiter
			// blocking on RESULTS_DIR/${id}.json would hang until its own timeout without
			// this write. Consumer contract verified against result-watcher.ts handleResult:
			//   - sessionId    CRITICAL: delivery gate; result-watcher drops the file if absent
			//                  or mismatched against state.currentSessionId.
			//   - id           Primary dedup key; buildCompletionKey uses `id:${id}` when present.
			//   - state/success Drive child-status resolution and resolvePausedArtifactDecision
			//                  (returns "compat" for state !== "paused", so delivery proceeds).
			//   - summary/error User-visible failure message surfaced in the UI.
			//   - results       Child array consumed by the normalizedChildren path.
			//   - asyncDir      Read by resolvePausedArtifactDecision only when state === "paused";
			//                  included for forward compatibility.
			// Safe to omit: outputs (empty map, unused), workflowGraph, durationMs,
			//   totalTokens, totalCost, truncated, cwd, sessionFile, shareUrl,
			//   intercomTarget — none are load-bearing for delivery or failure surfacing.
			const gateRejectAgent = statusPayload.steps?.[0]?.agent ?? "subagent";
			try {
				writeAtomicJson(resultPath, {
					lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
					id,
					agent: gateRejectAgent,
					mode: statusPayload.mode,
					success: false,
					state: "failed" as const,
					summary: statusPayload.error,
					error: statusPayload.error,
					results: [
						{
							agent: gateRejectAgent,
							output: statusPayload.error,
							error: statusPayload.error,
							success: false,
							exitCode: 1,
						},
					],
					exitCode: 1,
					timestamp: statusPayload.endedAt,
					durationMs: 0,
					asyncDir,
					sessionId: config.sessionId,
				} satisfies AsyncResultArtifact);
			} catch (err) {
				console.error(`Failed to write gate-rejection result file ${resultPath}:`, err);
			}
			return;
		}
	}
	const emitNestedSelfEvent = (type: "subagent.nested.updated" | "subagent.nested.completed"): void => {
		if (!config.nestedRoute || !config.nestedSelf) return;
		try {
			writeNestedEvent(config.nestedRoute, {
				type,
				ts: Date.now(),
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
					id,
					parentRunId: config.nestedSelf.parentRunId,
					parentStepIndex: config.nestedSelf.parentStepIndex,
					depth: config.nestedSelf.depth,
					path: config.nestedSelf.path,
					mode: statusPayload.mode,
					ts: Date.now(),
				}),
			});
		} catch (error) {
			console.error("Failed to emit nested async status event:", error);
		}
	};
	const refreshWorkflowGraph = (): void => {
		if (!config.workflowGraph) return;
		const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
		const normalize = (
			status: RunnerStatusStep["status"],
		): "pending" | "running" | "completed" | "failed" | "paused" | "detached" => {
			if (status === "complete" || status === "completed") return "completed";
			if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
			return "pending";
		};
		const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
			if (node.flatIndex !== undefined) {
				const step = statusPayload.steps[node.flatIndex];
				if (step) {
					node.status = normalize(step.status);
					node.error = step.error;
					node.acceptanceStatus = step.acceptance?.status;
				}
				if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
			}
			for (const child of node.children ?? []) updateNode(child);
			if (node.children?.length && node.status !== "paused" && node.status !== "failed") {
				if (node.children.every((child) => child.status === "completed")) node.status = "completed";
				else if (node.children.some((child) => child.status === "running")) node.status = "running";
				else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
				else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
			}
			if (node.error) node.status = "failed";
		};
		for (const node of graph.nodes) updateNode(node);
		statusPayload.workflowGraph = graph;
	};
	type TrackedStepSessionState = {
		sessionDir?: string;
		baselineSessionFiles: Set<string>;
		discoveredSessionFile?: string;
	};
	const listTrackedSessionFiles = (sessionDir: string | undefined): string[] => {
		if (!sessionDir) return [];
		try {
			return fs
				.readdirSync(sessionDir)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => path.resolve(sessionDir, name));
		} catch {
			return [];
		}
	};
	const beginTrackedSessionStep = (flatIndex: number, sessionDir: string | undefined, sessionFile?: string): void => {
		trackedStepSessions[flatIndex] = {
			sessionDir,
			baselineSessionFiles: new Set(listTrackedSessionFiles(sessionDir)),
			...(sessionFile ? { discoveredSessionFile: path.resolve(sessionFile) } : {}),
		};
	};
	const trackedStepSessions: Array<TrackedStepSessionState | undefined> = initialStatusSteps.map((step) =>
		step.sessionFile
			? {
					sessionDir: path.dirname(step.sessionFile),
					baselineSessionFiles: new Set(listTrackedSessionFiles(path.dirname(step.sessionFile))),
					discoveredSessionFile: path.resolve(step.sessionFile),
				}
			: undefined,
	);
	const refreshTrackedSessionFile = (flatIndex: number): string | undefined => {
		const step = statusPayload.steps[flatIndex];
		const tracked = trackedStepSessions[flatIndex];
		if (!step || !tracked?.sessionDir) return step?.sessionFile;
		const latestDiscovered = findLatestSessionFile(tracked.sessionDir) ?? undefined;
		if (latestDiscovered) {
			const resolvedLatest = path.resolve(latestDiscovered);
			if (!tracked.baselineSessionFiles.has(resolvedLatest)) tracked.discoveredSessionFile = resolvedLatest;
		}
		if (tracked.discoveredSessionFile && !step.sessionFile) step.sessionFile = tracked.discoveredSessionFile;
		if (tracked.discoveredSessionFile) latestSessionFile = tracked.discoveredSessionFile;
		if (!statusPayload.sessionFile) {
			statusPayload.sessionFile =
				statusPayload.steps.length === 1 ? (step.sessionFile ?? latestSessionFile) : latestSessionFile;
		}
		return step.sessionFile ?? tracked.discoveredSessionFile;
	};
	const resolveTrackedSessionFile = (flatIndex: number, fallback?: string): string | undefined => {
		if (fallback) {
			const tracked = trackedStepSessions[flatIndex];
			if (tracked) tracked.discoveredSessionFile = path.resolve(fallback);
			return fallback;
		}
		const current = statusPayload.steps[flatIndex]?.sessionFile;
		if (current) return current;
		return refreshTrackedSessionFile(flatIndex);
	};
	const writeStatusPayload = (): void => {
		if (statusPayload.currentStep !== undefined) refreshTrackedSessionFile(statusPayload.currentStep);
		refreshWorkflowGraph();
		// Once ANY concurrent lifecycle state has been adopted from disk, every
		// subsequent write must go through the lifecycle lock and merge against the
		// persisted record. `mergeAndWriteStatus` guarantees a persisted terminal run
		// state (and persisted terminal step statuses, with their cancel metadata)
		// always beats this process's in-memory state, so routing through the merge
		// makes the no-clobber property hold BY CONSTRUCTION rather than depending on
		// several unrelated mechanisms happening to coincide.
		//
		// Why `concurrentTerminalStatusAdopted` and not the other flags:
		//   - `interrupted` is unreliable here: adoptConcurrentTerminalStatus CLEARS it
		//     for a non-paused adoption (the step loop then stops via
		//     `concurrentTerminalStatusAdopted`). Today the step handlers happen to
		//     restore it via `if (childInterrupted) interrupted = true;`, but that is
		//     incidental to this invariant and must not be relied on.
		//   - `pausedCheckpointCommitted` is unreliable here: interruptRunner() sets it
		//     BEFORE any adoption and it is never reset to false, so it says nothing
		//     about what was adopted.
		//
		// Deliberately NOT an early `return`: skipping the write would discard late
		// per-step settlement data (tokens, model/attempts, acceptance ledger,
		// processCleanup) that the merge folds into the authoritative terminal record
		// safely, since the persisted terminal state wins regardless.
		//
		// Adopted `paused` behaves exactly as before: adoptConcurrentTerminalStatus
		// sets `interrupted = true` and `pausedCheckpointCommitted = true` for a paused
		// adoption, so that case already satisfied the second disjunct and still takes
		// this same locked-merge path with the continuation reservation preserved.
		//
		// Re-entrancy: this is safe because no lifecycle-lock-holding callback reaches
		// writeStatusPayload. The only lock-holding callbacks in this runner are the
		// `mutate` functions passed to transitionLifecycleStatus, which touch in-memory
		// state only (refreshTrackedSessionFile / pauseMetadataForIndex /
		// pausedAcceptanceLedger), and adoptConcurrentTerminalStatus() is invoked only
		// AFTER mergeAndWriteSourceRunnerStatus has returned and released the lock.
		if (concurrentTerminalStatusAdopted || (interrupted && pausedCheckpointCommitted)) {
			// Post-interrupt writes that follow a durable paused checkpoint go through
			// the lifecycle lock and merge against the currently persisted status so
			// that a concurrent continuation reservation (committed by the resuming
			// actor after the first paused checkpoint) is never clobbered by the
			// stale in-memory statusPayload. The locked merge is synchronous
			// (Atomics.wait); no new await window is introduced between the lock
			// acquisition, disk read, and write.
			//
			// The gating condition `pausedCheckpointCommitted` is necessary: before
			// a paused checkpoint exists (and with nothing adopted), no resume actor
			// can hold the lifecycle lock, so a bare write is correct. More importantly,
			// when the supervisor-pause transition fails (e.g. lock held by an external
			// entity at the time of the transition) AND nothing could be adopted from
			// disk, both `concurrentTerminalStatusAdopted` and `pausedCheckpointCommitted`
			// are false and the runner must be able to write a `failed` state through the
			// bare path even while the lock is held; skip-on-exhaustion would leave the
			// run stuck in `running` state forever.
			//
			// Lock exhaustion inside mergeAndWriteSourceRunnerStatus SKIPS the write and
			// returns the persisted status; it never degrades to a lockless
			// read-merge-write. Losing an observability update is strictly preferable to
			// erasing a concurrent reservation or terminal record.
			//
			// We update statusPayload.lifecycle from the returned merged status so
			// subsequent writes see the correct generation and any continuation that
			// was preserved.
			const merged = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
			if (TERMINAL_RUN_STATES.has(merged.state) && merged.state !== statusPayload.state) {
				// A concurrent terminal winner was committed to disk while we were
				// running. Adopt it in memory immediately so that result computation
				// and artifact writes reflect the authoritative state — without relying
				// on the finalization CAS inside the supervisorPauseRequest block, which
				// is skipped entirely for an ordinary interrupt (no supervisorPauseRequest).
				adoptConcurrentTerminalStatus();
			} else {
				statusPayload.lifecycle = merged.lifecycle;
			}
		} else {
			writeNormalizedLifecycleStatus(asyncDir, statusPayload);
		}
		emitNestedSelfEvent(
			statusPayload.state === "running" || statusPayload.state === "queued"
				? "subagent.nested.updated"
				: "subagent.nested.completed",
		);
	};
	const registerStepInterrupt = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildInterrupts.delete(flatIndex);
			return;
		}
		activeChildInterrupts.set(flatIndex, interrupt);
		if (interrupted) interrupt();
	};
	const registerStepTimeout = (flatIndex: number, interrupt: (() => void) | undefined): void => {
		if (!interrupt) {
			activeChildTimeouts.delete(flatIndex);
			return;
		}
		activeChildTimeouts.set(flatIndex, interrupt);
		if (timedOut) interrupt();
	};
	const registerStepTurnBudgetAbort = (
		flatIndex: number,
		abort: ((message: string, state?: TurnBudgetState) => void) | undefined,
	): void => {
		if (!abort) {
			activeChildTurnBudgetAborts.delete(flatIndex);
			return;
		}
		activeChildTurnBudgetAborts.set(flatIndex, abort);
	};
	const interruptActiveChildren = (): void => {
		for (const interrupt of [...activeChildInterrupts.values()]) interrupt();
	};
	const timeoutActiveChildren = (): void => {
		for (const interrupt of [...activeChildTimeouts.values()]) interrupt();
	};
	const nestedRuns = function* (children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
		for (const child of children ?? []) {
			yield child;
			yield* nestedRuns(child.children);
			yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
		}
	};
	const interruptNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(
				eventsPath,
				JSON.stringify({
					type: "subagent.nested.interrupt_failed",
					ts: Date.now(),
					runId: id,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverInterruptRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-interrupt" });
			} catch (error) {
				appendJsonl(
					eventsPath,
					JSON.stringify({
						type: "subagent.nested.interrupt_failed",
						ts: Date.now(),
						runId: id,
						targetRunId: run.id,
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
	};
	const timeoutNestedAsyncDescendants = (): void => {
		if (!config.nestedRoute) return;
		let registry: ReturnType<typeof projectNestedEvents>;
		try {
			registry = projectNestedEvents(config.nestedRoute);
		} catch (error) {
			appendJsonl(
				eventsPath,
				JSON.stringify({
					type: "subagent.nested.timeout_failed",
					ts: Date.now(),
					runId: id,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		for (const run of nestedRuns(registry.children)) {
			if (run.state !== "running" && run.state !== "queued") continue;
			const nestedAsyncDir = run.asyncDir ?? resolveNestedAsyncDir(config.nestedRoute.rootRunId, run);
			if (!nestedAsyncDir) continue;
			try {
				deliverTimeoutRequest({ asyncDir: nestedAsyncDir, pid: run.pid, source: "ancestor-timeout" });
			} catch (error) {
				appendJsonl(
					eventsPath,
					JSON.stringify({
						type: "subagent.nested.timeout_failed",
						ts: Date.now(),
						runId: id,
						targetRunId: run.id,
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
	};
	const pausedAcceptanceLedger = (
		acceptance: SubagentStep["effectiveAcceptance"],
	): import("../../shared/types.ts").AcceptanceLedger | undefined =>
		acceptance
			? buildSkippedAcceptanceLedger({
					acceptance,
					ledgerStatus: "skipped",
					runtimeCheckStatus: "not-applicable",
					id: "paused",
					message:
						"Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
				})
			: undefined;
	const pausedStepResult = (
		task: Pick<SubagentStep, "agent" | "effectiveAcceptance" | "model" | "modelIdentity" | "modelResolution">,
	): SingleStepResult => ({
		agent: task.agent,
		output: "Paused after interrupt. Waiting for explicit next action.",
		exitCode: 0,
		interrupted: true,
		terminationReason: "paused",
		model: task.model,
		modelIdentity: task.modelIdentity,
		modelResolution: task.modelResolution,
		acceptance: pausedAcceptanceLedger(task.effectiveAcceptance),
	});
	const timedOutStepResult = (
		task: Pick<SubagentStep, "agent" | "model" | "modelIdentity" | "modelResolution">,
	): SingleStepResult => ({
		agent: task.agent,
		output: timeoutMessage ?? "Subagent timed out.",
		error: timeoutMessage ?? "Subagent timed out.",
		exitCode: 1,
		timedOut: true,
		terminationReason: "timed_out",
		model: task.model,
		modelIdentity: task.modelIdentity,
		modelResolution: task.modelResolution,
	});
	let supervisorPauseRequest:
		| {
				requesterIndex: number;
				pause: NonNullable<AsyncStatus["pause"]>;
				requestedAt: number;
		  }
		| undefined;
	let supervisorPauseTransitionFailed = false;
	let durablePausingCheckpointPersisted = false;
	let concurrentTerminalStatusAdopted = false;
	// Set to true once a durable paused checkpoint is known to exist on disk —
	// either because this process wrote it, or because adoptConcurrentTerminalStatus
	// found a persisted `paused` state written by another process.
	// writeStatusPayload uses this flag to decide whether subsequent writes must go
	// through the lifecycle lock/merge path: before a paused checkpoint exists,
	// no resume actor can hold the lock, so a bare write is safe and must not
	// be skipped on lock exhaustion.
	//
	// INVARIANT — every code path that produces a durable paused checkpoint on disk
	// must set this flag to true BEFORE the next writeStatusPayload call:
	//   1. interruptRunner: set after writeStatusPayload() writes the first
	//      paused checkpoint (~line 2764).
	//   2. requestSupervisorPause success path: set inside the try block that
	//      calls transitionLifecycleStatus (~line 2215).
	//   3. adoptConcurrentTerminalStatus: set when persisted.state === "paused"
	//      — another process may have written the checkpoint; we must still route
	//      subsequent writes through the locked merge path (~line 2165).
	let pausedCheckpointCommitted = false;
	const pauseMetadataForIndex = (index: number, pausedAt?: number): AsyncStatus["pause"] | undefined => {
		if (!supervisorPauseRequest) return undefined;
		if (index === supervisorPauseRequest.requesterIndex) {
			return {
				...supervisorPauseRequest.pause,
				...(pausedAt !== undefined ? { pausedAt, ownerPid: undefined } : {}),
			};
		}
		return {
			kind: "cohort_pause",
			summary: "Paused because another child in this cohort is awaiting supervisor.",
			requestedAt: supervisorPauseRequest.requestedAt,
			...(pausedAt !== undefined ? { pausedAt } : { ownerPid: process.pid }),
		};
	};
	const adoptConcurrentTerminalStatus = (): RunnerStatusPayload | undefined => {
		const persisted = readStatus(asyncDir) as RunnerStatusPayload | null;
		if (!persisted || persisted.state === "running" || persisted.state === "pausing") return undefined;
		Object.assign(statusPayload, persisted);
		// INVARIANT — once a concurrent terminal state has been adopted, this run is
		// over and disk is authoritative:
		//
		//   paused adoption: interrupted = true so the step loop stops via the
		//     existing `if (interrupted)` check, writes go through the locked
		//     merge path (pausedCheckpointCommitted = true), and the resume actor's
		//     reservation is never clobbered.
		//
		//   non-paused terminal (cancelled / complete / failed / continued):
		//     interrupted stays false, so the step loop must consult
		//     concurrentTerminalStatusAdopted directly to stop iterating. All
		//     subsequent writeStatusPayload calls are forced through the locked merge
		//     so the persisted terminal record wins over stale in-memory state while
		//     late per-step settlement fields are still folded in.
		interrupted = persisted.state === "paused";
		// A paused checkpoint written by another process is still a durable paused
		// checkpoint on disk. Route all subsequent writeStatusPayload calls through
		// the locked merge path so that a reservation committed by the resume actor
		// after the adoption is never clobbered by a stale in-memory statusPayload.
		if (persisted.state === "paused") pausedCheckpointCommitted = true;
		// Every subsequent writeStatusPayload call must now route through the locked
		// merge so the persisted record wins by construction. See writeStatusPayload.
		concurrentTerminalStatusAdopted = true;
		return persisted;
	};
	const requestSupervisorPause = (requesterIndex: number, pause: NonNullable<AsyncStatus["pause"]>): void => {
		if (supervisorPauseRequest || interrupted || timedOut || turnBudgetExceeded || statusPayload.state !== "running")
			return;
		supervisorPauseRequest = {
			requesterIndex,
			pause: { ...pause, ownerPid: process.pid },
			requestedAt: pause.requestedAt ?? Date.now(),
		};
		const now = Date.now();
		const requesterSessionFile = refreshTrackedSessionFile(requesterIndex);
		try {
			const transition = transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: lifecycleGeneration(statusPayload),
				mutate: (status) => ({
					...status,
					state: "pausing",
					pid: process.pid,
					pause: { ...supervisorPauseRequest!.pause, ownerPid: process.pid },
					currentStep: requesterIndex,
					currentTool: undefined,
					currentToolStartedAt: undefined,
					currentPath: undefined,
					activityState: undefined,
					lastUpdate: now,
					sessionFile: requesterSessionFile ?? status.sessionFile,
					steps: status.steps?.map((step, index) => {
						if (step.status !== "running") return step;
						const stepSessionFile = refreshTrackedSessionFile(index);
						const activeRuntimeMs =
							(step.activeRuntimeMs ?? 0) + (step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : 0);
						return {
							...step,
							status: "pausing",
							activeRuntimeMs,
							activityState: undefined,
							interruptRequestedAt: now,
							...(stepSessionFile ? { sessionFile: stepSessionFile } : {}),
							...(index === requesterIndex
								? { pause: { ...supervisorPauseRequest!.pause, ownerPid: process.pid } }
								: { pause: pauseMetadataForIndex(index) }),
							acceptance: step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[index]),
						};
					}),
				}),
			});
			Object.assign(statusPayload, transition.status);
			supervisorPauseTransitionFailed = false;
			durablePausingCheckpointPersisted = true;
			pausedCheckpointCommitted = true;
		} catch {
			supervisorPauseTransitionFailed = !adoptConcurrentTerminalStatus();
		}
		interrupted = true;
		currentActivityState = undefined;
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.run.pausing",
				ts: now,
				runId: id,
				stepIndex: requesterIndex,
				pause: {
					kind: supervisorPauseRequest.pause.kind,
					summary: supervisorPauseRequest.pause.summary,
					request: supervisorPauseRequest.pause.request,
				},
			}),
		);
		interruptNestedAsyncDescendants();
		interruptAbortController.abort();
		interruptActiveChildren();
	};
	const pausedOutputForIndex = (index: number, agent: string): string =>
		supervisorPauseRequest && index === supervisorPauseRequest.requesterIndex
			? formatForegroundSupervisorPauseMessage({
					headline: `Async run ${id} paused awaiting supervisor (${agent}).`,
					runId: id,
					agent,
					requestSummary: supervisorPauseRequest.pause.summary,
				})
			: "Paused because another child in this cohort is awaiting supervisor.";
	const hasLiveNestedAsyncDescendants = (): boolean => {
		if (!config.nestedRoute) return false;
		try {
			return [...nestedRuns(projectNestedEvents(config.nestedRoute).children)].some(
				(run) => run.state === "running" || run.state === "queued",
			);
		} catch {
			return true;
		}
	};
	const waitForNestedAsyncDescendantsToStop = async (timeoutMs = 2_000, pollMs = 50): Promise<boolean> => {
		if (!config.nestedRoute) return true;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			if (!hasLiveNestedAsyncDescendants()) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	};
	const ownedPauseProcessesConfirmedStopped = (): boolean =>
		statusPayload.steps.every((step) => {
			if (step.status !== "pausing" && step.status !== "paused") return true;
			// Pending cohort members never spawned a process and need no cleanup.
			if (!step.startedAt) return true;
			return step.processCleanup?.terminated === true;
		});
	const isPersistedAwaitingSupervisorPause = (status: RunnerStatusPayload | undefined): boolean => {
		if (!status || !supervisorPauseRequest) return false;
		const requester = status.steps[supervisorPauseRequest.requesterIndex];
		return (
			status.state === "paused" &&
			status.pid === undefined &&
			status.pause?.kind === "awaiting_supervisor" &&
			status.pause?.ownerPid === undefined &&
			requester?.status === "paused" &&
			requester.pause?.kind === "awaiting_supervisor" &&
			requester.pause?.ownerPid === undefined
		);
	};
	const applyPausedStepMetadata = (flatIndex: number, endedAt: number): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const sessionFile = refreshTrackedSessionFile(flatIndex);
		if (sessionFile) step.sessionFile = sessionFile;
		step.pause = pauseMetadataForIndex(flatIndex, endedAt);
		step.acceptance = step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
		step.interruptRequestedAt = supervisorPauseRequest?.requestedAt ?? step.interruptRequestedAt;
	};
	const stepOutputActivityAt = (index: number): number => {
		const step = statusPayload.steps[index];
		let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? overallStartTime;
		const outputPath = path.join(asyncDir, `output-${index}.log`);
		try {
			lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`Failed to inspect async output file '${outputPath}':`, error);
			}
		}
		return lastActivityAt;
	};
	const emittedControlEventKeys = new Set<string>();
	const activeLongRunningSteps = new Set<number>();
	const mutatingFailureStates = initialStatusSteps.map(() => createMutatingFailureState());
	// Runtime-reported identity is trusted only after exact registry validation and
	// is scoped to the currently dispatched child attempt. A fallback invokes
	// onAttemptStart again, which deliberately clears the prior observation.
	const runtimeModelContexts: Array<{ identity: SubagentModelIdentity; contextWindow: number } | undefined> =
		initialStatusSteps.map(() => undefined);
	const activeConfiguredModels: Array<string | undefined> = initialStatusSteps.map(() => undefined);
	const pendingToolResults: Array<{ tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined> =
		initialStatusSteps.map(() => undefined);
	const flatStepAcceptances: Array<SubagentStep["effectiveAcceptance"]> = flatSteps.map(
		(step) => step.effectiveAcceptance,
	);
	const mutatingFailureWindowMs = 5 * 60_000;
	const appendControlEvent = (event: ReturnType<typeof buildControlEvent>) => {
		if (!controlConfig.enabled) return;
		const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
		const channels =
			event.type === "active_long_running"
				? controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
				: controlConfig.notifyChannels;
		if (
			channels.length === 0 ||
			!claimControlNotification(controlConfig, event, emittedControlEventKeys, childIntercomTarget)
		)
			return;
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.control",
				event,
				channels,
				childIntercomTarget,
				noticeText: formatControlNoticeMessage(event, childIntercomTarget),
				...(config.controlIntercomTarget && channels.includes("intercom")
					? {
							intercom: {
								to: config.controlIntercomTarget,
								message: formatControlIntercomMessage(event, childIntercomTarget),
							},
						}
					: {}),
			}),
		);
	};
	const syncTopLevelCurrentTool = (): void => {
		const activeStep = statusPayload.steps
			.filter(
				(step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0,
			)
			.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
		statusPayload.currentTool = activeStep?.currentTool;
		statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
		statusPayload.currentPath = activeStep?.currentPath;
	};
	const maybeEmitActiveLongRunning = (flatIndex: number, now: number): boolean => {
		if (!controlConfig.enabled || activeLongRunningSteps.has(flatIndex)) return false;
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
		const reason = nextLongRunningTrigger(controlConfig, {
			startedAt: step.startedAt ?? overallStartTime,
			now,
			turns: step.turnCount ?? 0,
			tokens: step.tokens?.total ?? 0,
		});
		if (!reason) return false;
		activeLongRunningSteps.add(flatIndex);
		const previous = step.activityState;
		step.activityState = "active_long_running";
		statusPayload.activityState =
			statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
		const event = buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: `${step.agent} is still active but long-running`,
			reason,
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: now - (step.startedAt ?? overallStartTime),
		});
		appendControlEvent(event);
		return true;
	};
	const deliverChildMessageRequest = (request: ChildMessageRequest): void => {
		const now = Date.now();
		if (statusPayload.state !== "running") {
			writeChildMessageAcceptanceForRequest(asyncDir, request, {
				status: "rejected",
				ts: now,
				acceptedIndexes: [],
				reason: `run is ${statusPayload.state}`,
			});
			return;
		}
		const { acceptedIndexes: accepted, rejected } = acceptChildMessageRequest({
			request,
			steps: statusPayload.steps,
			enqueue: (index, childRequest) => enqueueStepChildMessage(asyncDir, index, childRequest),
			now: () => now,
		});
		if (request.type === "steer") {
			for (const index of accepted) {
				const step = statusPayload.steps[index]!;
				step.steerCount = (step.steerCount ?? 0) + 1;
				step.lastSteerAt = now;
			}
		}
		if (accepted.length > 0) {
			if (request.type === "steer") {
				statusPayload.steerCount = (statusPayload.steerCount ?? 0) + accepted.length;
				statusPayload.lastSteerAt = now;
			}
			statusPayload.lastUpdate = now;
			writeStatusPayload();
		}
		writeChildMessageAcceptanceForRequest(asyncDir, request, {
			status: accepted.length > 0 ? "accepted" : "rejected",
			ts: now,
			acceptedIndexes: accepted,
			...(rejected.length ? { rejected } : {}),
			...(accepted.length === 0 ? { reason: rejected[0]?.reason ?? "no running child accepted the request" } : {}),
		});
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: request.type === "resume" ? "subagent.resume.requested" : "subagent.steer.requested",
				ts: now,
				runId: id,
				requestId: request.id,
				message: request.message,
				...(request.source ? { source: request.source } : {}),
				...(request.targetIndex !== undefined ? { targetIndex: request.targetIndex } : {}),
				acceptedIndexes: accepted,
				...(rejected.length ? { rejected } : {}),
			}),
		);
	};
	const flushPendingStepSteers = (flatIndex: number): void => {
		const remaining: ChildMessageRequest[] = [];
		for (const request of pendingStepSteers.splice(0)) {
			if (request.targetIndex === undefined) deliverChildMessageRequest({ ...request, targetIndex: flatIndex });
			else if (request.targetIndex === flatIndex) deliverChildMessageRequest(request);
			else remaining.push(request);
		}
		pendingStepSteers.push(...remaining);
	};
	const updateStepModel = (flatIndex: number, attempt: ModelAttemptStart, now = Date.now()): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		// This callback is the attempt boundary: only a dispatched candidate starts
		// a new scope. Arbitrary child message model changes never do.
		runtimeModelContexts[flatIndex] = undefined;
		activeConfiguredModels[flatIndex] = attempt.model;
		step.model = attempt.model;
		step.thinking = attempt.modelIdentity ? attempt.modelIdentity.thinking : attempt.thinking;
		step.modelIdentity = attempt.modelIdentity ?? canonicalSubagentModelIdentity(attempt.model, attempt.thinking);
		// Preserve any restored/override resolution already persisted for the step
		// when the attempt carries no resolution of its own.
		if (attempt.modelResolution) step.modelResolution = attempt.modelResolution;
		if (attempt.attemptedModels && attempt.attemptedModels.length > 0) step.attemptedModels = attempt.attemptedModels;
		if (attempt.modelAttempts && attempt.modelAttempts.length > 0) step.modelAttempts = attempt.modelAttempts;
		statusPayload.lastUpdate = now;
		writeStatusPayload();
	};
	const updateStepTurnBudget = (
		flatIndex: number,
		turnCount: number,
		now: number,
		terminalAssistantStop: boolean,
	): void => {
		const budget = config.turnBudget;
		const step = statusPayload.steps[flatIndex];
		if (!budget || !step || timedOut || turnBudgetExceeded || step.turnBudgetExceeded) return;
		if (turnCount < budget.maxTurns) {
			const state: TurnBudgetState = { ...budget, outcome: "within-budget", turnCount };
			step.turnBudget = state;
			statusPayload.turnBudget = state;
			return;
		}
		const state = turnBudgetState(budget, turnCount, false);
		step.turnBudget = state;
		statusPayload.turnBudget = state;
		if (!step.wrapUpRequested) {
			step.wrapUpRequested = true;
			statusPayload.wrapUpRequested = true;
			appendRecentStepOutput(step, [turnBudgetSoftNote(budget, turnCount)]);
		}
		if (!shouldAbortForTurnBudget(budget, turnCount, terminalAssistantStop)) return;
		const exceededState = turnBudgetState(budget, turnCount, true);
		const message = turnBudgetExceededMessage(budget, turnCount);
		step.turnBudget = exceededState;
		step.turnBudgetExceeded = true;
		step.wrapUpRequested = true;
		step.error = message;
		turnBudgetExceeded = true;
		statusPayload.turnBudget = exceededState;
		statusPayload.turnBudgetExceeded = true;
		statusPayload.wrapUpRequested = true;
		statusPayload.error = message;
		statusPayload.lastUpdate = now;
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.step.turn_budget_exceeded",
				ts: now,
				runId: id,
				stepIndex: flatIndex,
				agent: step.agent,
				turnCount,
				maxTurns: budget.maxTurns,
				graceTurns: budget.graceTurns,
				message,
			}),
		);
		activeChildTurnBudgetAborts.get(flatIndex)?.(message, exceededState);
	};
	const updateStepFromChildEvent = (flatIndex: number, event: ChildEvent): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step) return;
		const now = Date.now();
		statusPayload.currentStep = flatIndex;
		if (event.type === "tool_execution_start" && event.toolName) {
			const supervisorPause = resolveSupervisorPauseMetadata({
				toolName: event.toolName,
				toolArgs: event.args,
				requestedAt: now,
			});
			if (supervisorPause?.kind === "awaiting_supervisor") {
				requestSupervisorPause(flatIndex, supervisorPause);
			}
			const mutates = isMutatingTool(event.toolName, event.args);
			const currentPath = resolveCurrentPath(event.toolName, event.args);
			step.toolCount = (step.toolCount ?? 0) + 1;
			const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
			if (configuredToolBudget) {
				step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount);
				statusPayload.toolBudget = step.toolBudget;
			}
			step.currentTool = event.toolName;
			step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
			step.currentToolStartedAt = now;
			step.currentPath = currentPath;
			pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
			statusPayload.toolCount = (statusPayload.toolCount ?? 0) + 1;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_execution_end") {
			if (step.currentTool) {
				step.recentTools ??= [];
				appendRecentProgressItem(step.recentTools, {
					tool: step.currentTool,
					args: step.currentToolArgs || "",
					endMs: now,
				});
			}
			step.currentTool = undefined;
			step.currentToolArgs = undefined;
			step.currentToolStartedAt = undefined;
			step.currentPath = undefined;
			syncTopLevelCurrentTool();
		} else if (event.type === "tool_result_end" && event.message) {
			const toolSnapshot = pendingToolResults[flatIndex];
			pendingToolResults[flatIndex] = undefined;
			const resultText = extractTextFromContent(event.message.content);
			if (toolSnapshot && resultText.includes("Tool budget hard limit reached")) {
				const configuredToolBudget = flatSteps[flatIndex]?.toolBudget;
				if (configuredToolBudget) {
					step.toolBudget = toolBudgetState(configuredToolBudget, step.toolCount ?? 0, toolSnapshot.tool);
					step.toolBudgetBlocked = true;
					statusPayload.toolBudget = step.toolBudget;
					statusPayload.toolBudgetBlocked = true;
				}
			}
			appendRecentStepOutput(step, resultText.split("\n").slice(-10));
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				const state = mutatingFailureStates[flatIndex]!;
				recordMutatingFailure(
					state,
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
				if (
					controlConfig.enabled &&
					shouldEscalateMutatingFailures(state, controlConfig.failedToolAttemptsBeforeAttention) &&
					step.activityState !== "needs_attention"
				) {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(
						buildControlEvent({
							type: "needs_attention",
							from: previous,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index: flatIndex,
							ts: now,
							message: `${step.agent} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							turns: step.turnCount,
							tokens: step.tokens?.total,
							toolCount: step.toolCount,
							currentTool: toolSnapshot.tool,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							currentPath: toolSnapshot.path,
							recentFailureSummary: summarizeRecentMutatingFailures(state),
						}),
					);
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailureStates[flatIndex]!);
			}
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			appendRecentStepOutput(
				step,
				stripAcceptanceReport(extractTextFromContent(event.message.content)).split("\n").slice(-10),
			);
			step.turnCount = (step.turnCount ?? 0) + 1;
			const configuredModel = activeConfiguredModels[flatIndex];
			const configuredContextWindow = contextWindowForModel(configuredModel, flatSteps[flatIndex]?.contextWindows);
			let runtimeModelContext = runtimeModelContexts[flatIndex];
			if (!configuredModel && runtimeModelContext === undefined) {
				runtimeModelContext = resolveRuntimeModelContext(
					event.message.provider,
					event.message.model,
					flatSteps[flatIndex]?.contextWindows,
				);
				if (runtimeModelContext) {
					runtimeModelContexts[flatIndex] = runtimeModelContext;
					step.model = runtimeModelReference(runtimeModelContext.identity);
					step.thinking = runtimeModelContext.identity.thinking;
					step.modelIdentity = runtimeModelContext.identity;
				}
			}
			step.contextUsage = updateContextUsageDiagnostics(step.contextUsage, event.message, {
				restored: false,
				contextWindow: configuredContextWindow ?? runtimeModelContext?.contextWindow,
			});
			// Keep the persisted live status projection in sync before publishing any
			// pressure control event. Consumers can therefore resolve the event's
			// severity against the same context usage and crossed-threshold history.
			statusPayload.steps[flatIndex].contextUsage = step.contextUsage;
			statusPayload.steps[flatIndex].contextPressureCrossedThresholds = step.contextPressureCrossedThresholds;
			while (true) {
				const pressure = detectContextPressureCrossing(
					step.contextUsage,
					step.contextPressureCrossedThresholds ?? [],
					now,
				);
				if (!pressure) break;
				step.contextPressureCrossedThresholds = [
					...(step.contextPressureCrossedThresholds ?? []),
					pressure.crossedThreshold,
				];
				flatSteps[flatIndex].contextPressureCrossedThresholds = step.contextPressureCrossedThresholds;
				flatSteps[flatIndex].contextPressure = pressure;
				statusPayload.steps[flatIndex].contextPressureCrossedThresholds = step.contextPressureCrossedThresholds;
				statusPayload.steps[flatIndex].contextPressure = pressure;
				statusPayload.lastUpdate = now;
				// This write intentionally precedes appendControlEvent: the status file
				// is the durable projection paired with the notification. Use the same
				// terminal/pause-aware path as the surrounding live status writes so a
				// buffered message cannot clobber an authoritative state or reservation.
				writeStatusPayload();
				if (controlConfig.enabled) {
					const previousActivityState = step.activityState;
					step.activityState = "needs_attention";
					statusPayload.activityState = "needs_attention";
					appendControlEvent(
						buildControlEvent({
							type: "needs_attention",
							from: previousActivityState,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index: flatIndex,
							ts: now,
							message: formatContextPressureGuidance(pressure),
							contextPressureSeverity: pressure.severity,
							contextPressureThreshold: pressure.crossedThreshold,
							reason: "context_pressure",
							turns: step.turnCount,
							tokens: step.tokens?.total,
							toolCount: step.toolCount,
						}),
					);
				}
			}
			const usage = event.message.usage;
			if (usage) {
				const input = usage.input ?? usage.inputTokens ?? 0;
				const output = usage.output ?? usage.outputTokens ?? 0;
				const previousInput = step.tokens?.input ?? 0;
				const previousOutput = step.tokens?.output ?? 0;
				step.tokens = {
					input: previousInput + input,
					output: previousOutput + output,
					total: previousInput + previousOutput + input + output,
				};
				const totalInput = statusPayload.totalTokens?.input ?? 0;
				const totalOutput = statusPayload.totalTokens?.output ?? 0;
				statusPayload.totalTokens = {
					input: totalInput + input,
					output: totalOutput + output,
					total: totalInput + totalOutput + input + output,
				};
			}
			statusPayload.turnCount = Math.max(statusPayload.turnCount ?? 0, step.turnCount);
			updateStepTurnBudget(flatIndex, step.turnCount, now, isTerminalAssistantStop(event.message));
		}
		syncTopLevelCurrentTool();
		step.lastActivityAt = now;
		statusPayload.lastActivityAt = now;
		statusPayload.lastUpdate = now;
		maybeEmitActiveLongRunning(flatIndex, now);
		writeStatusPayload();
	};
	const updateRunnerActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;
		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: step.startedAt ?? overallStartTime,
				lastActivityAt,
				toolCallInFlight: Boolean(step.currentTool),
				now,
			});
			if (idleState === "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				if (previous !== "needs_attention") {
					appendControlEvent(
						buildControlEvent({
							from: previous,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index,
							ts: now,
							lastActivityAt,
						}),
					);
					changed = true;
				}
			} else if (maybeEmitActiveLongRunning(index, now)) {
				changed = true;
			}
		}
		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention")
			? "needs_attention"
			: statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		if (nextRunState !== currentActivityState) {
			currentActivityState = nextRunState;
			statusPayload.activityState = nextRunState;
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeStatusPayload();
		return changed;
	};
	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (statusPayload.state !== "running") return;
			const now = Date.now();
			updateRunnerActivityState(now);
		}, 1000);
		activityTimer.unref?.();
	}

	const interruptRunner = () => {
		consumeInterruptRequest(asyncDir);
		if (interrupted || statusPayload.state !== "running") return;
		interrupted = true;
		const now = Date.now();
		statusPayload.state = "paused";
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (let flatIndex = 0; flatIndex < statusPayload.steps.length; flatIndex++) {
			const step = statusPayload.steps[flatIndex]!;
			if (step.status === "running") {
				step.status = "paused";
				step.activityState = undefined;
				step.endedAt = now;
				step.durationMs = step.startedAt ? now - step.startedAt : undefined;
				step.lastActivityAt = now;
				// Persist the skipped acceptance ledger in the same status write that
				// publishes the paused state so a resume never observes a paused run
				// without its continuation acceptance contract.
				if (!step.acceptance) step.acceptance = pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
				// Capture each parallel child's own discovered session file before the
				// paused status write — writeStatusPayload() only refreshes currentStep.
				refreshTrackedSessionFile(flatIndex);
			}
		}
		writeStatusPayload();
		// The first paused checkpoint is now on disk. Subsequent writeStatusPayload
		// calls (for settling interrupted children and final finalization) must go
		// through mergeAndWriteSourceRunnerStatus so that a reservation committed
		// by the resuming actor between this write and those writes is preserved.
		pausedCheckpointCommitted = true;
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.run.paused",
				ts: now,
				runId: id,
			}),
		);
		interruptNestedAsyncDescendants();
		interruptAbortController.abort();
		interruptActiveChildren();
	};
	const timeoutRunner = () => {
		if (timedOut || interrupted || statusPayload.state !== "running") return;
		timedOut = true;
		const now = Date.now();
		const message = timeoutMessage ?? "Subagent timed out.";
		statusPayload.state = "failed";
		statusPayload.timedOut = true;
		statusPayload.error = message;
		currentActivityState = undefined;
		statusPayload.activityState = undefined;
		statusPayload.lastUpdate = now;
		for (const step of statusPayload.steps) {
			if (step.status !== "running" && step.status !== "pending") continue;
			step.status = "failed";
			step.error = message;
			step.exitCode = 1;
			step.timedOut = true;
			step.terminationReason = "timed_out";
			step.activityState = undefined;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : 0;
			step.lastActivityAt = now;
		}
		writeStatusPayload();
		appendJsonl(
			eventsPath,
			JSON.stringify({
				type: "subagent.run.timed_out",
				ts: now,
				runId: id,
				timeoutMs: config.timeoutMs,
				deadlineAt: config.deadlineAt,
				message,
			}),
		);
		timeoutAbortController.abort();
		timeoutNestedAsyncDescendants();
		timeoutActiveChildren();
	};
	process.on(ASYNC_INTERRUPT_SIGNAL, interruptRunner);
	// Portable control inbox: the parent drops control request files here when
	// it cannot deliver OS signals (e.g. ENOSYS on Windows) or when steering a
	// live child. Interrupts still route into the same graceful interruptRunner().
	const disposeControlInbox = watchAsyncControlInbox(asyncDir, {
		onInterrupt: interruptRunner,
		onTimeout: timeoutRunner,
		onSteer: (request) => {
			const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
			if (targetStep?.status === "pending") pendingStepSteers.push(request);
			else if (request.targetIndex !== undefined || statusPayload.steps.some((step) => step.status === "running"))
				deliverChildMessageRequest(request);
			else pendingStepSteers.push(request);
		},
		onResume: (request) => {
			const targetStep = request.targetIndex !== undefined ? statusPayload.steps[request.targetIndex] : undefined;
			if (targetStep?.status === "pending") pendingStepSteers.push(request);
			else if (request.targetIndex !== undefined || statusPayload.steps.some((step) => step.status === "running"))
				deliverChildMessageRequest(request);
			else pendingStepSteers.push(request);
		},
	});
	if (config.deadlineAt !== undefined) {
		timeoutTimer = scheduleDeadline(config.deadlineAt, timeoutRunner);
	}
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.started",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: overallStartTime,
			runId: id,
			mode: statusPayload.mode,
			cwd,
			pid: process.pid,
		}),
	);

	let flatIndex = 0;
	let stepCursor = 0;

	while (true) {
		// Once a concurrent terminal state (non-paused) has been adopted, disk owns
		// the final record and no further step may start. For the paused case,
		// `interrupted` is set to true by adoptConcurrentTerminalStatus so the
		// existing check already stops the loop.
		if (interrupted || timedOut || turnBudgetExceeded || concurrentTerminalStatusAdopted) break;
		if (stepCursor >= steps.length) break;
		const stepIndex = stepCursor++;
		const step = steps[stepIndex]!;

		if (isParallelGroup(step)) {
			const group = step;
			const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
			const failFast = group.failFast ?? false;
			const groupStartFlatIndex = flatIndex;
			let aborted = false;

			const groupStartTime = Date.now();
			markParallelGroupRunning({
				statusPayload,
				group,
				groupStartFlatIndex,
				groupStartTime,
				statusPath,
				eventsPath,
				asyncDir,
				runId: id,
				stepIndex,
			});
			const parallelResults = await mapConcurrent<(typeof group.parallel)[number], ParallelStepExecutionResult>(
				group.parallel,
				concurrency,
				async (task, taskIdx) => {
					const fi = groupStartFlatIndex + taskIdx;
					if (timedOut) return timedOutStepResult(task);
					// A concurrent non-paused terminal adoption sets concurrentTerminalStatusAdopted
					// but leaves interrupted=false, so we must consult the flag directly.
					if (interrupted || concurrentTerminalStatusAdopted) return pausedStepResult(task);
					if (aborted && failFast) {
						const skippedAt = Date.now();
						statusPayload.steps[fi].status = "failed";
						statusPayload.steps[fi].error = "Skipped due to fail-fast";
						statusPayload.steps[fi].terminationReason = "process_exit";
						statusPayload.steps[fi].startedAt = skippedAt;
						statusPayload.steps[fi].endedAt = skippedAt;
						statusPayload.steps[fi].durationMs = 0;
						statusPayload.steps[fi].exitCode = -1;
						statusPayload.steps[fi].activityState = undefined;
						statusPayload.lastUpdate = skippedAt;
						writeStatusPayload();
						appendJsonl(
							eventsPath,
							JSON.stringify({
								type: "subagent.step.failed",
								ts: skippedAt,
								runId: id,
								stepIndex: fi,
								agent: task.agent,
								exitCode: -1,
								durationMs: 0,
							}),
						);
						return {
							agent: task.agent,
							output: "(skipped — fail-fast)",
							exitCode: -1 as number | null,
							skipped: true,
							terminationReason: "process_exit",
							model: task.model,
							modelIdentity: task.modelIdentity,
							modelResolution: task.modelResolution,
						};
					}

					const taskSessionDir = config.sessionDir ? path.join(config.sessionDir, `parallel-${taskIdx}`) : undefined;
					const taskStartTime = Date.now();
					const taskDeadlineAt = task.timeoutMs !== undefined ? taskStartTime + task.timeoutMs : config.deadlineAt;
					beginTrackedSessionStep(
						fi,
						task.sessionFile ? path.dirname(task.sessionFile) : taskSessionDir,
						task.sessionFile,
					);
					statusPayload.currentStep = fi;
					statusPayload.steps[fi].status = "running";
					statusPayload.steps[fi].error = undefined;
					statusPayload.steps[fi].activityState = undefined;
					resetStepLiveDetail(statusPayload.steps[fi]);
					statusPayload.steps[fi].startedAt = taskStartTime;
					statusPayload.steps[fi].timeoutMs = task.timeoutMs ?? config.timeoutMs;
					statusPayload.steps[fi].deadlineAt = taskDeadlineAt;
					statusPayload.steps[fi].endedAt = undefined;
					statusPayload.steps[fi].durationMs = undefined;
					statusPayload.steps[fi].lastActivityAt = taskStartTime;
					statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
					statusPayload.lastActivityAt = taskStartTime;
					statusPayload.lastUpdate = taskStartTime;
					appendRecentStepOutput(statusPayload.steps[fi], task.attemptNotes ?? []);
					writeStatusPayload();

					appendJsonl(
						eventsPath,
						JSON.stringify({
							type: "subagent.step.started",
							ts: taskStartTime,
							runId: id,
							stepIndex: fi,
							agent: task.agent,
						}),
					);

					flushPendingStepSteers(fi);

					const singleResult = await runSingleStep(task, {
						previousOutput,
						placeholder,
						cwd,
						sessionEnabled,
						outputs,
						sessionDir: taskSessionDir,
						artifactsDir,
						artifactConfig,
						id,
						flatIndex: fi,
						flatStepCount: Math.max(statusPayload.steps.length, 1),
						outputFile: path.join(asyncDir, `output-${fi}.log`),
						steerInboxDir: stepSteerInboxDir(asyncDir, fi),
						piPackageRoot: config.piPackageRoot,
						piArgv1: config.piArgv1,
						childIntercomTarget: config.childIntercomTargets?.[fi],
						orchestratorIntercomTarget: config.controlIntercomTarget,
						nestedRoute: config.nestedRoute,
						registerInterrupt: (interrupt) => registerStepInterrupt(fi, interrupt),
						registerTimeout: (interrupt) => registerStepTimeout(fi, interrupt),
						registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(fi, abort),
						interruptSignal: interruptAbortController.signal,
						interruptMessage: "Interrupted. Waiting for explicit next action.",
						timeoutSignal: timeoutAbortController.signal,
						timeoutMessage,
						timeoutMs: task.timeoutMs ?? config.timeoutMs,
						deadlineAt: taskDeadlineAt,
						startedAt: taskStartTime,
						turnBudget: config.turnBudget,
						onAttemptStart: (attempt) => updateStepModel(fi, attempt),
						onChildEvent: (event) => updateStepFromChildEvent(fi, event),
						skipAcceptance: () => timedOut,
					});
					if (task.sessionFile) {
						latestSessionFile = task.sessionFile;
					}

					const taskEndTime = Date.now();
					const taskDuration = taskEndTime - taskStartTime;
					const childInterrupted = singleResult.interrupted === true;
					if (childInterrupted) interrupted = true;
					const priorStepStatus = statusPayload.steps[fi].status;
					const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
					statusPayload.steps[fi].status = timedOut
						? "failed"
						: pausedStep
							? "paused"
							: singleResult.exitCode === 0
								? "complete"
								: "failed";
					statusPayload.steps[fi].endedAt = taskEndTime;
					statusPayload.steps[fi].durationMs = taskDuration;
					statusPayload.steps[fi].activeRuntimeMs = singleResult.activeRuntimeMs;
					statusPayload.steps[fi].exitCode = timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
					statusPayload.steps[fi].exitSignal = singleResult.exitSignal;
					statusPayload.steps[fi].timedOut = timedOut || singleResult.timedOut ? true : undefined;
					statusPayload.steps[fi].processCleanup = singleResult.processCleanup;
					statusPayload.steps[fi].turnBudget = singleResult.turnBudget;
					statusPayload.steps[fi].turnBudgetExceeded = singleResult.turnBudgetExceeded;
					statusPayload.steps[fi].wrapUpRequested = singleResult.wrapUpRequested;
					statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
					statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
					statusPayload.steps[fi].contextUsage = singleResult.contextUsage;
					statusPayload.steps[fi].contextPressure = singleResult.contextPressure;
					statusPayload.steps[fi].contextPressureCrossedThresholds = singleResult.contextPressureCrossedThresholds;
					statusPayload.steps[fi].terminationReason = singleResult.terminationReason;
					if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
					if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
					if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
					if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
					if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
					statusPayload.steps[fi].model = singleResult.model;
					statusPayload.steps[fi].thinking = singleResult.modelIdentity
						? singleResult.modelIdentity.thinking
						: resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
					statusPayload.steps[fi].modelIdentity = singleResult.modelIdentity;
					statusPayload.steps[fi].modelResolution = singleResult.modelResolution;
					statusPayload.steps[fi].modelFallbackNotice = singleResult.modelFallbackNotice;
					statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
					statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
					statusPayload.steps[fi].totalCost = singleResult.totalCost;
					statusPayload.steps[fi].error = timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error;
					statusPayload.steps[fi].transcriptPath =
						singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
					statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
					statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
					statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
					statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
					statusPayload.steps[fi].acceptance = singleResult.acceptance;
					if (pausedStep) applyPausedStepMetadata(fi, taskEndTime);
					statusPayload.lastUpdate = taskEndTime;
					writeStatusPayload();

					appendJsonl(
						eventsPath,
						JSON.stringify({
							type: timedOut
								? "subagent.step.failed"
								: childInterrupted
									? "subagent.step.paused"
									: singleResult.exitCode === 0
										? "subagent.step.completed"
										: "subagent.step.failed",
							ts: taskEndTime,
							runId: id,
							stepIndex: fi,
							agent: task.agent,
							exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
							durationMs: taskDuration,
						}),
					);
					if (singleResult.completionGuardTriggered) {
						const event = buildControlEvent({
							from: statusPayload.steps[fi].activityState,
							to: "needs_attention",
							runId: id,
							agent: task.agent,
							index: fi,
							ts: taskEndTime,
							message: `${task.agent} completed without making edits for an implementation task`,
							reason: "completion_guard",
						});
						appendControlEvent(event);
					}

					if (singleResult.exitCode !== 0 && failFast) aborted = true;
					return timedOut
						? {
								...singleResult,
								output: timeoutMessage ?? "Subagent timed out.",
								error: timeoutMessage ?? "Subagent timed out.",
								exitCode: 1,
								interrupted: false,
								timedOut: true,
								skipped: false,
							}
						: { ...singleResult, skipped: false };
				},
				globalSemaphore,
			);

			flatIndex += group.parallel.length;

			for (let t = 0; t < group.parallel.length; t++) {
				const fi = groupStartFlatIndex + t;
				const sessionTokens = config.sessionDir
					? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
					: null;
				const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
				if (!taskTokens) continue;
				statusPayload.steps[fi].tokens = taskTokens;
				previousCumulativeTokens = {
					input: previousCumulativeTokens.input + taskTokens.input,
					output: previousCumulativeTokens.output + taskTokens.output,
					total: previousCumulativeTokens.total + taskTokens.total,
				};
			}
			statusPayload.totalTokens = { ...previousCumulativeTokens };
			statusPayload.lastUpdate = Date.now();
			writeStatusPayload();

			for (let t = 0; t < parallelResults.length; t++) {
				const pr = parallelResults[t]!;
				const fi = groupStartFlatIndex + t;
				results.push({
					agent: pr.agent,
					output: pr.interrupted ? pausedOutputForIndex(fi, pr.agent) : pr.output,
					error: pr.error,
					success: pr.interrupted !== true && pr.exitCode === 0,
					exitCode: pr.interrupted === true ? 0 : pr.exitCode,
					exitSignal: pr.exitSignal,
					skipped: pr.skipped,
					interrupted: pr.interrupted,
					timedOut: pr.timedOut,
					turnBudget: pr.turnBudget,
					turnBudgetExceeded: pr.turnBudgetExceeded,
					wrapUpRequested: pr.wrapUpRequested,
					toolBudget: pr.toolBudget,
					toolBudgetBlocked: pr.toolBudgetBlocked,
					contextUsage: pr.contextUsage,
					contextPressure: pr.contextPressure,
					contextPressureCrossedThresholds: pr.contextPressureCrossedThresholds,
					terminationReason: pr.terminationReason,
					sessionFile: resolveTrackedSessionFile(fi, pr.sessionFile),
					intercomTarget: pr.intercomTarget,
					model: pr.model,
					modelIdentity: pr.modelIdentity,
					modelResolution: pr.modelResolution,
					attemptedModels: pr.attemptedModels,
					modelAttempts: pr.modelAttempts,
					modelFallbackNotice: pr.modelFallbackNotice,
					totalCost: pr.totalCost,
					artifactPaths: pr.artifactPaths,
					processCleanup: pr.processCleanup,
					transcriptPath: pr.transcriptPath,
					transcriptError: pr.transcriptError,
					structuredOutput: pr.structuredOutput,
					structuredOutputPath: pr.structuredOutputPath,
					structuredOutputSchemaPath: pr.structuredOutputSchemaPath,
					acceptance: pr.acceptance,
					pause: pr.interrupted ? pauseMetadataForIndex(fi, statusPayload.steps[fi]?.endedAt) : undefined,
					activeRuntimeMs: pr.activeRuntimeMs,
				});
			}
			for (let t = 0; t < group.parallel.length; t++) {
				const outputName = group.parallel[t]?.outputName;
				if (outputName)
					outputs[outputName] = outputEntryFromAsyncResult(
						{
							agent: parallelResults[t]!.agent,
							output: parallelResults[t]!.output,
							structuredOutput: parallelResults[t]!.structuredOutput,
						},
						stepIndex,
					);
			}
			statusPayload.outputs = outputs;

			previousOutput = aggregateParallelOutputs(
				parallelResults.map((r) => ({
					agent: r.agent,
					output: r.output,
					exitCode: r.exitCode,
					error: r.error,
					model: r.model,
					attemptedModels: r.attemptedModels,
				})),
			);

			const parallelGroupInterrupted = interrupted || parallelResults.some((result) => result.interrupted === true);
			if (!parallelGroupInterrupted) {
				appendJsonl(
					eventsPath,
					JSON.stringify({
						type: "subagent.parallel.completed",
						ts: Date.now(),
						runId: id,
						stepIndex,
						success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1),
					}),
				);
			}

			if (parallelGroupInterrupted || parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1)) {
				break;
			}
		} else {
			const seqStep = step as SubagentStep;
			const stepStartTime = Date.now();
			const stepDeadlineAt = seqStep.timeoutMs !== undefined ? stepStartTime + seqStep.timeoutMs : config.deadlineAt;
			beginTrackedSessionStep(
				flatIndex,
				seqStep.sessionFile ? path.dirname(seqStep.sessionFile) : config.sessionDir,
				seqStep.sessionFile,
			);
			statusPayload.currentStep = flatIndex;
			statusPayload.steps[flatIndex].status = "running";
			statusPayload.steps[flatIndex].activityState = undefined;
			statusPayload.activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[flatIndex]);
			statusPayload.steps[flatIndex].skills = seqStep.skills;
			statusPayload.steps[flatIndex].startedAt = stepStartTime;
			statusPayload.steps[flatIndex].timeoutMs = seqStep.timeoutMs ?? config.timeoutMs;
			statusPayload.steps[flatIndex].deadlineAt = stepDeadlineAt;
			statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
			statusPayload.lastActivityAt = stepStartTime;
			statusPayload.lastUpdate = stepStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
			appendRecentStepOutput(statusPayload.steps[flatIndex], seqStep.attemptNotes ?? []);
			writeStatusPayload();

			appendJsonl(
				eventsPath,
				JSON.stringify({
					type: "subagent.step.started",
					ts: stepStartTime,
					runId: id,
					stepIndex: flatIndex,
					agent: seqStep.agent,
				}),
			);

			flushPendingStepSteers(flatIndex);
			const singleResult = await runSingleStep(seqStep, {
				previousOutput,
				placeholder,
				cwd,
				sessionEnabled,
				outputs,
				sessionDir: config.sessionDir,
				artifactsDir,
				artifactConfig,
				id,
				flatIndex,
				flatStepCount: Math.max(statusPayload.steps.length, 1),
				outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
				steerInboxDir: stepSteerInboxDir(asyncDir, flatIndex),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[flatIndex],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				nestedRoute: config.nestedRoute,
				registerInterrupt: (interrupt) => registerStepInterrupt(flatIndex, interrupt),
				registerTimeout: (interrupt) => registerStepTimeout(flatIndex, interrupt),
				registerTurnBudgetAbort: (abort) => registerStepTurnBudgetAbort(flatIndex, abort),
				interruptSignal: interruptAbortController.signal,
				interruptMessage: "Interrupted. Waiting for explicit next action.",
				timeoutSignal: timeoutAbortController.signal,
				timeoutMessage,
				timeoutMs: seqStep.timeoutMs ?? config.timeoutMs,
				deadlineAt: stepDeadlineAt,
				startedAt: stepStartTime,
				turnBudget: config.turnBudget,
				onAttemptStart: (attempt) => updateStepModel(flatIndex, attempt),
				onChildEvent: (event) => updateStepFromChildEvent(flatIndex, event),
				skipAcceptance: () => timedOut,
			});
			const resolvedSeqSessionFile = resolveTrackedSessionFile(
				flatIndex,
				singleResult.sessionFile ?? seqStep.sessionFile,
			);
			if (resolvedSeqSessionFile) {
				statusPayload.steps[flatIndex].sessionFile = resolvedSeqSessionFile;
				latestSessionFile = resolvedSeqSessionFile;
			}

			previousOutput = singleResult.output;
			results.push({
				agent: singleResult.agent,
				output: timedOut
					? (timeoutMessage ?? "Subagent timed out.")
					: singleResult.interrupted
						? pausedOutputForIndex(flatIndex, singleResult.agent)
						: singleResult.output,
				error: timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error,
				success: !timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
				exitCode: timedOut ? 1 : singleResult.interrupted === true ? 0 : singleResult.exitCode,
				exitSignal: singleResult.exitSignal,
				sessionFile: resolvedSeqSessionFile,
				intercomTarget: singleResult.intercomTarget,
				model: singleResult.model,
				modelIdentity: singleResult.modelIdentity,
				modelResolution: singleResult.modelResolution,
				attemptedModels: singleResult.attemptedModels,
				modelAttempts: singleResult.modelAttempts,
				modelFallbackNotice: singleResult.modelFallbackNotice,
				totalCost: singleResult.totalCost,
				artifactPaths: singleResult.artifactPaths,
				processCleanup: singleResult.processCleanup,
				transcriptPath: singleResult.transcriptPath,
				transcriptError: singleResult.transcriptError,
				structuredOutput: singleResult.structuredOutput,
				structuredOutputPath: singleResult.structuredOutputPath,
				structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
				acceptance: singleResult.acceptance,
				pause: singleResult.interrupted ? pauseMetadataForIndex(flatIndex) : undefined,
				interrupted: singleResult.interrupted,
				timedOut: timedOut || singleResult.timedOut ? true : undefined,
				turnBudget: singleResult.turnBudget,
				turnBudgetExceeded: singleResult.turnBudgetExceeded,
				wrapUpRequested: singleResult.wrapUpRequested,
				toolBudget: singleResult.toolBudget,
				toolBudgetBlocked: singleResult.toolBudgetBlocked,
				contextUsage: singleResult.contextUsage,
				contextPressure: singleResult.contextPressure,
				contextPressureCrossedThresholds: singleResult.contextPressureCrossedThresholds,
				terminationReason: singleResult.terminationReason,
				activeRuntimeMs: singleResult.activeRuntimeMs,
			});
			if (seqStep.outputName) {
				outputs[seqStep.outputName] = outputEntryFromAsyncResult(
					{
						agent: singleResult.agent,
						output: singleResult.output,
						structuredOutput: singleResult.structuredOutput,
					},
					stepIndex,
				);
			}
			statusPayload.outputs = outputs;

			const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
			let stepTokens: TokenUsage | null = cumulativeTokens
				? {
						input: cumulativeTokens.input - previousCumulativeTokens.input,
						output: cumulativeTokens.output - previousCumulativeTokens.output,
						total: cumulativeTokens.total - previousCumulativeTokens.total,
					}
				: null;
			if (cumulativeTokens) {
				previousCumulativeTokens = cumulativeTokens;
			} else {
				stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
				if (stepTokens) {
					previousCumulativeTokens = {
						input: previousCumulativeTokens.input + stepTokens.input,
						output: previousCumulativeTokens.output + stepTokens.output,
						total: previousCumulativeTokens.total + stepTokens.total,
					};
				}
			}

			const stepEndTime = Date.now();
			const childInterrupted = singleResult.interrupted === true;
			if (childInterrupted) interrupted = true;
			const priorStepStatus = statusPayload.steps[flatIndex].status;
			const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
			statusPayload.steps[flatIndex].status = timedOut
				? "failed"
				: pausedStep
					? "paused"
					: singleResult.exitCode === 0
						? "complete"
						: "failed";
			statusPayload.steps[flatIndex].endedAt = stepEndTime;
			statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
			statusPayload.steps[flatIndex].activeRuntimeMs = singleResult.activeRuntimeMs;
			statusPayload.steps[flatIndex].exitCode = timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode;
			statusPayload.steps[flatIndex].exitSignal = singleResult.exitSignal;
			statusPayload.steps[flatIndex].timedOut = timedOut || singleResult.timedOut ? true : undefined;
			statusPayload.steps[flatIndex].processCleanup = singleResult.processCleanup;
			statusPayload.steps[flatIndex].turnBudget = singleResult.turnBudget;
			statusPayload.steps[flatIndex].turnBudgetExceeded = singleResult.turnBudgetExceeded;
			statusPayload.steps[flatIndex].wrapUpRequested = singleResult.wrapUpRequested;
			statusPayload.steps[flatIndex].toolBudget = singleResult.toolBudget;
			statusPayload.steps[flatIndex].toolBudgetBlocked = singleResult.toolBudgetBlocked;
			statusPayload.steps[flatIndex].contextUsage = singleResult.contextUsage;
			statusPayload.steps[flatIndex].contextPressure = singleResult.contextPressure;
			statusPayload.steps[flatIndex].contextPressureCrossedThresholds = singleResult.contextPressureCrossedThresholds;
			statusPayload.steps[flatIndex].terminationReason = singleResult.terminationReason;
			if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
			if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
			if (singleResult.turnBudget) statusPayload.turnBudget = singleResult.turnBudget;
			if (singleResult.turnBudgetExceeded) statusPayload.turnBudgetExceeded = true;
			if (singleResult.wrapUpRequested) statusPayload.wrapUpRequested = true;
			statusPayload.steps[flatIndex].model = singleResult.model;
			statusPayload.steps[flatIndex].thinking = singleResult.modelIdentity
				? singleResult.modelIdentity.thinking
				: resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
			statusPayload.steps[flatIndex].modelIdentity = singleResult.modelIdentity;
			statusPayload.steps[flatIndex].modelResolution = singleResult.modelResolution;
			statusPayload.steps[flatIndex].modelFallbackNotice = singleResult.modelFallbackNotice;
			statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[flatIndex].totalCost = singleResult.totalCost;
			statusPayload.steps[flatIndex].error = timedOut ? (timeoutMessage ?? "Subagent timed out.") : singleResult.error;
			statusPayload.steps[flatIndex].transcriptPath =
				singleResult.transcriptPath ?? statusPayload.steps[flatIndex].transcriptPath;
			statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
			statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
			statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
			statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
			statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
			if (pausedStep) applyPausedStepMetadata(flatIndex, stepEndTime);
			if (stepTokens) {
				statusPayload.steps[flatIndex].tokens = stepTokens;
				statusPayload.totalTokens = { ...previousCumulativeTokens };
			}
			statusPayload.lastUpdate = stepEndTime;
			writeStatusPayload();

			appendJsonl(
				eventsPath,
				JSON.stringify({
					type: timedOut
						? "subagent.step.failed"
						: childInterrupted
							? "subagent.step.paused"
							: singleResult.exitCode === 0
								? "subagent.step.completed"
								: "subagent.step.failed",
					ts: stepEndTime,
					runId: id,
					stepIndex: flatIndex,
					agent: seqStep.agent,
					exitCode: timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
					durationMs: stepEndTime - stepStartTime,
					tokens: stepTokens,
				}),
			);
			if (singleResult.completionGuardTriggered) {
				const event = buildControlEvent({
					from: statusPayload.steps[flatIndex].activityState,
					to: "needs_attention",
					runId: id,
					agent: seqStep.agent,
					index: flatIndex,
					ts: stepEndTime,
					message: `${seqStep.agent} completed without making edits for an implementation task`,
					reason: "completion_guard",
				});
				appendControlEvent(event);
			}

			flatIndex++;
			if (singleResult.exitCode !== 0) {
				break;
			}
		}
	}

	let summary = results
		.map((r) => {
			const body = r.success ? r.output : formatErrorWithOutput(r.error, r.output);
			return `${r.agent}:\n${body}`;
		})
		.join("\n\n");
	let truncated = false;

	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, config, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const totalCost = results.reduce<CostSummary>(
		(sum, result) => ({
			inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
			outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
			costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
		}),
		{ inputTokens: 0, outputTokens: 0, costUsd: 0 },
	);
	const finalTotalCost =
		totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0 ? totalCost : undefined;
	const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
	const agentName =
		finalFlatAgents.length === 1
			? finalFlatAgents[0]!
			: resultMode === "parallel"
				? `parallel:${finalFlatAgents.join("+")}`
				: `chain:${finalFlatAgents.join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (shareEnabled) {
		sessionFile = config.sessionDir ? (findLatestSessionFile(config.sessionDir) ?? undefined) : undefined;
		if (!sessionFile && latestSessionFile) {
			sessionFile = latestSessionFile;
		}
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	if (activityTimer) clearInterval(activityTimer);
	if (timeoutTimer) timeoutTimer.cancel();
	disposeControlInbox();
	const effectiveSessionFile = sessionFile ?? latestSessionFile;
	const runEndedAt = Date.now();
	let pausedAwaitingSupervisor: AsyncStatus["pause"] | undefined;
	let safePausedResultAfterReap: AsyncStatus["pause"] | undefined;
	let skipFinalStatusWrite = false;
	if (supervisorPauseRequest) {
		const nestedDescendantsStoppedBeforeFinalization = await waitForNestedAsyncDescendantsToStop();
		const ownedProcessesStoppedBeforeFinalization = ownedPauseProcessesConfirmedStopped();
		if (
			isPersistedAwaitingSupervisorPause(statusPayload) &&
			nestedDescendantsStoppedBeforeFinalization &&
			ownedProcessesStoppedBeforeFinalization
		) {
			pausedAwaitingSupervisor = {
				...statusPayload.pause!,
				pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
				ownerPid: undefined,
			};
		} else if (statusPayload.state === "pausing") {
			if (nestedDescendantsStoppedBeforeFinalization && ownedProcessesStoppedBeforeFinalization) {
				const pausedSessionFile =
					effectiveSessionFile ?? statusPayload.steps[supervisorPauseRequest.requesterIndex]?.sessionFile;
				try {
					const transition = transitionLifecycleStatus({
						asyncDir,
						expectedGeneration: lifecycleGeneration(statusPayload),
						mutate: (status) => ({
							...status,
							state: "paused",
							pid: undefined,
							pause: {
								...supervisorPauseRequest!.pause,
								pausedAt: runEndedAt,
								ownerPid: undefined,
							},
							activityState: undefined,
							currentTool: undefined,
							currentToolStartedAt: undefined,
							currentPath: undefined,
							endedAt: runEndedAt,
							lastUpdate: runEndedAt,
							sessionFile: pausedSessionFile ?? status.sessionFile,
							totalCost: finalTotalCost,
							shareUrl,
							gistUrl,
							shareError,
							steps: status.steps?.map((step, index) =>
								step.status === "pausing" || step.status === "paused"
									? {
											...step,
											...(refreshTrackedSessionFile(index) ? { sessionFile: refreshTrackedSessionFile(index) } : {}),
											status: "paused",
											exitCode: 0,
											terminationReason: "paused",
											exitSignal: undefined,
											activityState: undefined,
											endedAt: step.endedAt ?? runEndedAt,
											durationMs: step.startedAt ? (step.endedAt ?? runEndedAt) - step.startedAt : step.durationMs,
											pause: pauseMetadataForIndex(index, runEndedAt),
											acceptance: step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[index]),
										}
									: step,
							),
						}),
					});
					Object.assign(statusPayload, transition.status);
				} catch {
					adoptConcurrentTerminalStatus();
				}
				const nestedDescendantsStoppedAfterFinalization = await waitForNestedAsyncDescendantsToStop();
				const ownedProcessesStoppedAfterFinalization = ownedPauseProcessesConfirmedStopped();
				if (
					!concurrentTerminalStatusAdopted &&
					nestedDescendantsStoppedAfterFinalization &&
					ownedProcessesStoppedAfterFinalization &&
					durablePausingCheckpointPersisted &&
					!supervisorPauseTransitionFailed
				) {
					safePausedResultAfterReap = {
						...(statusPayload.pause ?? supervisorPauseRequest.pause),
						pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
						ownerPid: undefined,
					};
					if (isPersistedAwaitingSupervisorPause(statusPayload)) pausedAwaitingSupervisor = safePausedResultAfterReap;
				} else if (!concurrentTerminalStatusAdopted) {
					supervisorPauseTransitionFailed = true;
					skipFinalStatusWrite = true;
				}
			} else if (!adoptConcurrentTerminalStatus()) {
				supervisorPauseTransitionFailed = true;
				skipFinalStatusWrite = true;
			}
		} else if (!adoptConcurrentTerminalStatus()) {
			supervisorPauseTransitionFailed = true;
		}
		if (!pausedAwaitingSupervisor && supervisorPauseTransitionFailed && !concurrentTerminalStatusAdopted) {
			// Fail closed without retaining or publishing an unverified owner pid.
			// Cleanup metadata remains available to state that processes may live.
			skipFinalStatusWrite = false;
			statusPayload.state = "failed";
			statusPayload.pid = undefined;
			statusPayload.pause = undefined;
			statusPayload.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
			statusPayload.steps = statusPayload.steps.map((step) =>
				step.status === "pausing" || step.status === "paused"
					? {
							...step,
							status: "failed",
							pause: undefined,
							terminationReason: step.terminationReason ?? "process_exit",
							error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
						}
					: step,
			);
			summary = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
			for (const result of results) {
				if (
					result.interrupted ||
					result.pause?.kind === "awaiting_supervisor" ||
					result.pause?.kind === "cohort_pause"
				) {
					result.output = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
					result.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
					result.success = false;
					result.exitCode = 1;
					result.terminationReason = result.terminationReason ?? "process_exit";
					result.interrupted = undefined;
					result.pause = undefined;
				}
			}
			if (results.length === 0) {
				results.push({
					agent: statusPayload.steps[supervisorPauseRequest.requesterIndex]?.agent ?? agentName,
					output: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
					error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
					success: false,
					exitCode: 1,
					terminationReason: "process_exit",
				});
			}
		}
	}
	if (!pausedAwaitingSupervisor && !skipFinalStatusWrite && !concurrentTerminalStatusAdopted) {
		statusPayload.state = supervisorPauseTransitionFailed
			? "failed"
			: timedOut || turnBudgetExceeded
				? "failed"
				: interrupted
					? "paused"
					: results.every((r) => r.success)
						? "complete"
						: "failed";
		statusPayload.activityState = undefined;
		if (timedOut) {
			statusPayload.timedOut = true;
			statusPayload.error = timeoutMessage ?? "Subagent timed out.";
		}
		if (turnBudgetExceeded && !statusPayload.error) {
			const budget = statusPayload.turnBudget;
			statusPayload.error = budget
				? turnBudgetExceededMessage(budget, budget.turnCount)
				: "Subagent exceeded turn budget.";
		}
		if (supervisorPauseTransitionFailed && statusPayload.state === "failed") {
			statusPayload.error = statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
		}
		statusPayload.endedAt = runEndedAt;
		statusPayload.lastUpdate = runEndedAt;
		statusPayload.sessionFile = effectiveSessionFile;
		statusPayload.totalCost = finalTotalCost;
		statusPayload.shareUrl = shareUrl;
		statusPayload.gistUrl = gistUrl;
		statusPayload.shareError = shareError;
		if (statusPayload.state === "failed" && !statusPayload.error) {
			const failedStep = statusPayload.steps.find((s) => s.status === "failed");
			if (failedStep?.agent) {
				statusPayload.error = failedStep.error ?? `Step failed: ${failedStep.agent}`;
			}
		}
		writeStatusPayload();
	}
	if (pausedAwaitingSupervisor) emitNestedSelfEvent("subagent.nested.completed");
	appendJsonl(
		eventsPath,
		JSON.stringify({
			type: "subagent.run.completed",
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			ts: runEndedAt,
			runId: id,
			status: statusPayload.state,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
		}),
	);
	writeRunLog(logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({
			agent: step.agent,
			status: step.status,
			durationMs: step.durationMs,
			processCleanup: step.processCleanup,
		})),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	const resultPausedAwaitingSupervisor =
		pausedAwaitingSupervisor ??
		(safePausedResultAfterReap && !supervisorPauseTransitionFailed && !concurrentTerminalStatusAdopted
			? safePausedResultAfterReap
			: undefined);
	const resultState = concurrentTerminalStatusAdopted
		? statusPayload.state
		: timedOut || turnBudgetExceeded
			? "failed"
			: resultPausedAwaitingSupervisor
				? "paused"
				: supervisorPauseTransitionFailed
					? "failed"
					: statusPayload.state === "failed" ||
							statusPayload.state === "paused" ||
							statusPayload.state === "cancelled" ||
							statusPayload.state === "continued"
						? statusPayload.state
						: interrupted
							? "paused"
							: results.every((r) => r.success)
								? "complete"
								: "failed";
	const resultSuccess = resultState === "complete";
	const resultSummary =
		!concurrentTerminalStatusAdopted && timedOut
			? (timeoutMessage ?? "Subagent timed out.")
			: !concurrentTerminalStatusAdopted && turnBudgetExceeded
				? (statusPayload.error ?? "Subagent exceeded turn budget.")
				: resultPausedAwaitingSupervisor
					? pausedOutputForIndex(
							supervisorPauseRequest?.requesterIndex ?? 0,
							statusPayload.steps[supervisorPauseRequest?.requesterIndex ?? 0]?.agent ?? agentName,
						)
					: resultState === "failed"
						? (statusPayload.error ??
							(supervisorPauseTransitionFailed ? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE : summary))
						: resultState === "paused"
							? "Paused after interrupt. Waiting for explicit next action."
							: summary;

	try {
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			agent: agentName,
			mode: resultMode,
			success: resultSuccess,
			state: resultState,
			summary: resultSummary,
			...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
			...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
			...(statusPayload.turnBudget ? { turnBudget: statusPayload.turnBudget } : {}),
			...(statusPayload.turnBudgetExceeded ? { turnBudgetExceeded: true } : {}),
			...(statusPayload.wrapUpRequested ? { wrapUpRequested: true } : {}),
			...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
			...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
			...(!concurrentTerminalStatusAdopted && timedOut
				? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." }
				: !concurrentTerminalStatusAdopted && turnBudgetExceeded
					? { error: statusPayload.error ?? "Subagent exceeded turn budget." }
					: resultState === "failed"
						? { error: statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE }
						: {}),
			...(resultPausedAwaitingSupervisor ? { pause: resultPausedAwaitingSupervisor } : {}),
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				exitCode: r.exitCode,
				exitSignal: r.exitSignal,
				skipped: r.skipped || undefined,
				interrupted: r.interrupted || undefined,
				timedOut: r.timedOut || undefined,
				turnBudget: r.turnBudget,
				turnBudgetExceeded: r.turnBudgetExceeded || undefined,
				wrapUpRequested: r.wrapUpRequested || undefined,
				toolBudget: r.toolBudget,
				toolBudgetBlocked: r.toolBudgetBlocked || undefined,
				contextUsage: r.contextUsage,
				contextPressure: r.contextPressure,
				contextPressureCrossedThresholds: r.contextPressureCrossedThresholds,
				terminationReason: r.terminationReason,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				modelIdentity: r.modelIdentity,
				modelResolution: r.modelResolution,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				modelFallbackNotice: r.modelFallbackNotice,
				totalCost: r.totalCost,
				artifactPaths: r.artifactPaths,
				processCleanup: r.processCleanup,
				truncated: r.truncated,
				transcriptPath: r.transcriptPath,
				transcriptError: r.transcriptError,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
				acceptance: r.acceptance,
				pause: r.pause,
				activeRuntimeMs: r.activeRuntimeMs,
			})),
			outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: resultState === "failed" ? 1 : 0,
			timestamp: runEndedAt,
			durationMs: runEndedAt - overallStartTime,
			totalTokens: statusPayload.totalTokens,
			totalCost: finalTotalCost,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(taskIndex !== undefined && { taskIndex }),
			...(totalTasks !== undefined && { totalTasks }),
		} satisfies AsyncResultArtifact);
	} catch (err) {
		console.error(`Failed to write result file ${resultPath}:`, err);
	}
}

const configArg = process.argv[2];
if (configArg) {
	try {
		const configJson = fs.readFileSync(configArg, "utf-8");
		const config = JSON.parse(configJson) as SubagentRunConfig;
		try {
			fs.unlinkSync(configArg);
		} catch {
			// Temp config cleanup is best effort.
		}
		runSubagent(config).catch((runErr) => {
			console.error("Subagent runner error:", runErr);
			process.exit(1);
		});
	} catch (err) {
		console.error("Subagent runner error:", err);
		process.exit(1);
	}
} else {
	let input = "";
	process.stdin.setEncoding("utf-8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
	});
	process.stdin.on("end", () => {
		try {
			const config = JSON.parse(input) as SubagentRunConfig;
			runSubagent(config).catch((runErr) => {
				console.error("Subagent runner error:", runErr);
				process.exit(1);
			});
		} catch (err) {
			console.error("Subagent runner error:", err);
			process.exit(1);
		}
	});
}
