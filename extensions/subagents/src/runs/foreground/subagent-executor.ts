import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope } from "../../agents/agents.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import {
	FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
	formatForegroundPauseMessage,
	formatForegroundSupervisorPauseMessage,
	UNCHANGED_SUPERVISOR_RESUME_MESSAGE,
} from "../../shared/foreground-pause.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import { runSync } from "./execution.ts";
import {
	canonicalSubagentModelIdentity,
	modelReferenceFromIdentity,
	resolveSubagentModelOverride,
	sanitizeSubagentModelIdentity,
	sanitizeSubagentModelResolution,
} from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { aggregateParallelOutputs } from "../shared/parallel-utils.ts";
import { clearForegroundInterrupt, registerForegroundInterrupt } from "../shared/foreground-interrupts.ts";
import {
	buildChainInstructions,
	writeInitialProgressFile,
	isParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	type ChainStep,
	type ResolvedStepBehavior,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { remainingExecutionTimeMs } from "../../agents/execution-ceiling.ts";
import {
	executeAsyncChain,
	executeAsyncSingle,
	formatAsyncStartedMessage,
	isAsyncAvailable,
} from "../background/async-execution.ts";
import { validateAcceptanceInput, validateDispatchAcceptanceInput } from "../shared/acceptance.ts";
import { createForkContextResolver } from "../../shared/fork-context.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
	applyIntercomBridgeToAgent,
	INTERCOM_BRIDGE_MARKER,
	resolveIntercomBridge,
	resolveIntercomSessionTarget,
	resolveSubagentIntercomTarget,
	type IntercomBridgeState,
} from "../../intercom/intercom-bridge.ts";
import {
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import { DEFAULT_TURN_BUDGET_GRACE_TURNS } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { resolveTkTicketMetadata, resolveTkTicketTaskContext } from "../shared/tk-ticket.ts";
import {
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import {
	compactForegroundDetails,
	getSingleResultOutput,
	mapConcurrent,
	readStatus,
	resolveChildCwd,
	sumResultsCost,
	sumResultsUsage,
} from "../../shared/utils.ts";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, Semaphore } from "../shared/parallel-utils.ts";
import {
	attachNestedChildrenToResultChildren,
	formatForegroundNativeSubagentResult,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";
import {
	buildRevivedAsyncTask,
	resolveAsyncResumeTarget,
	resolveAsyncRunLocation,
} from "../background/async-resume.ts";
import {
	lifecycleContinuationForIndex,
	lifecycleGeneration,
	markLifecycleContinuationSpawned,
	recoverStaleLifecycleContinuationClaim,
	recoverStaleLifecycleContinuationStatus,
	transitionLifecycleStatus,
	withLifecycleContinuation,
	withLifecycleStatusLock,
	writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import {
	childMessageAckPath,
	deliverInterruptRequest,
	requestAsyncResume,
	requestAsyncSteer,
	waitForChildMessageAcceptance,
} from "../background/control-channel.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import {
	attachRootChildrenToSteps,
	createNestedRoute,
	NESTED_CONTROL_DELIVERY_TIMEOUT_MS,
	NESTED_CONTROL_RESULT_TIMEOUT_MS,
	readNestedControlResults,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedAsyncDir,
	resolveNestedParentAddressFromEnv,
	updateForegroundNestedProjection,
	writeNestedControlRequest,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";
import {
	assessDurableResumeContext,
	formatDurableResumeContextBlock,
	parseContextPressureCrossedThresholds,
	parseContextUsageDiagnostics,
	resolveEffectiveContextWindow,
} from "../../shared/context-diagnostics.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { inspectSubagentStatus } from "../background/run-status.ts";
import {
	type AgentProgress,
	type AcceptanceInput,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type AsyncStatus,
	type Details,
	type ExtensionConfig,
	type SubagentToolResult,
	type IntercomEventBus,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type NestedRunSummary,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type TkTicketMetadata,
	type ResolvedToolBudget,
	type SingleResult,
	type ToolBudgetConfig,
	type TurnBudgetConfig,
	type SubagentResultStatus,
	type SubagentModelIdentity,
	type SubagentModelResolution,
	type ContextUsageDiagnostics,
	type SubagentRunMode,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SUBAGENT_ACTIONS,
	TEMP_ROOT_DIR,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	wrapForkTask,
} from "../../shared/types.ts";

const NESTED_ASYNC_RUNS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
const FOREGROUND_LIVE_MESSAGE_INBOXES_DIR = path.join(TEMP_ROOT_DIR, "foreground-live-message-inboxes");

interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	fallbackModels?: string[];
	modelFallbackNotice?: string;
	acceptance?: AcceptanceInput;
	toolBudget?: ToolBudgetConfig;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	dir?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
	agent?: string;
	task?: string;
	message?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	context?: "fresh" | "fork";
	async?: boolean;
	timeoutMs?: number;
	turnBudget?: TurnBudgetConfig;
	toolBudget?: ToolBudgetConfig;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	fallbackModels?: string[];
	modelFallbackNotice?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	agentScope?: unknown;
	chainDir?: string;
	acceptance?: AcceptanceInput;
	schedule?: string;
	scheduleName?: string;
	chainName?: string;
	config?: unknown;
}

interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[]; modelScope?: ModelScopeConfig };
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: SubagentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	nestedRoute?: NestedRouteInfo;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	contextPolicy: AgentDefaultContextPolicy;
	modelScope?: ModelScopeConfig;
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function indexedLifecycleContinuation(
	status: AsyncStatus | null | undefined,
	index = 0,
): NonNullable<AsyncStatus["lifecycle"]>["continuation"] | undefined {
	return lifecycleContinuationForIndex(status, index);
}

function isClaimedPausedLifecycle(status: AsyncStatus | null | undefined, index = 0): boolean {
	const continuation = indexedLifecycleContinuation(status, index);
	return (
		status?.state === "paused" && typeof continuation?.claimToken === "string" && continuation.claimToken.length > 0
	);
}

function pausedForegroundStatusPath(runId: string): string {
	return path.join(ASYNC_DIR, runId);
}

function pausedForegroundStepStatus(result: SingleResult): NonNullable<AsyncStatus["steps"]>[number]["status"] {
	if (result.cancel?.cancelledAt) return "cancelled";
	if (result.pause) return "paused";
	if (result.interrupted && !result.sessionFile && !result.pause) return "pending";
	if (result.interrupted) return "paused";
	if (result.exitCode === 0) return "completed";
	return "failed";
}

function isTerminalForegroundResultSnapshot(result: SingleResult, progress: AgentProgress | undefined): boolean {
	if (result.cancel?.cancelledAt || result.pause || result.detached || result.interrupted) return true;
	if (progress?.status === "completed" || progress?.status === "failed") return true;
	return result.exitCode !== 0;
}

function persistPausedForegroundCohortRun(input: {
	runId: string;
	cwd: string;
	sessionId: string | null;
	mode: "parallel" | "chain";
	stage: "pausing" | "paused";
	ownerPid?: number;
	results?: SingleResult[];
	steps?: NonNullable<AsyncStatus["steps"]>;
	pause?: AsyncStatus["pause"];
	startedAt?: number;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncStatus["parallelGroups"];
	workflowGraph?: AsyncStatus["workflowGraph"];
	outputs?: AsyncStatus["outputs"];
}): void {
	const asyncDir = pausedForegroundStatusPath(input.runId);
	const now = Date.now();
	const derivedPause =
		input.pause ?? input.results?.find((result) => result.pause?.kind === "awaiting_supervisor")?.pause;
	const pause = derivedPause
		? ({
				kind: derivedPause.kind,
				...(derivedPause.summary ? { summary: derivedPause.summary } : {}),
				...(derivedPause.requestedAt !== undefined ? { requestedAt: derivedPause.requestedAt } : {}),
				...(input.stage === "pausing" && input.ownerPid !== undefined ? { ownerPid: input.ownerPid } : {}),
				...(input.stage === "paused" ? { pausedAt: derivedPause.pausedAt ?? now, ownerPid: undefined } : {}),
				...(derivedPause.request ? { request: derivedPause.request } : {}),
			} satisfies AsyncStatus["pause"])
		: undefined;
	const steps = (
		input.steps ??
		input.results?.map((result) => ({
			agent: result.agent,
			status: input.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result),
			sessionFile: result.sessionFile,
			transcriptPath: result.transcriptPath,
			transcriptError: result.transcriptError,
			startedAt: result.progress?.durationMs !== undefined ? Math.max(0, now - result.progress.durationMs) : undefined,
			endedAt: input.stage === "paused" ? now : undefined,
			durationMs: result.progress?.durationMs,
			activeRuntimeMs: result.activeRuntimeMs ?? result.progress?.durationMs,
			model: result.model,
			thinking: result.modelIdentity?.thinking ?? result.thinking,
			...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
			...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
			...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
			...(pausedForegroundTerminationReason(result)
				? { terminationReason: pausedForegroundTerminationReason(result) }
				: {}),
			exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
			...(result.acceptance ? { acceptance: result.acceptance } : {}),
			...(result.pause
				? {
						pause: {
							kind: result.pause.kind,
							...(result.pause.summary ? { summary: result.pause.summary } : {}),
							...(result.pause.requestedAt !== undefined ? { requestedAt: result.pause.requestedAt } : {}),
							...(input.stage === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
							...(result.pause.request ? { request: result.pause.request } : {}),
						},
					}
				: {}),
			...(result.cancel ? { cancel: result.cancel } : {}),
		})) ??
		[]
	).map((step) =>
		(step.status === "pausing" || step.status === "paused") && step.pause
			? { ...step, terminationReason: "paused" as const }
			: step,
	);
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = readStatus(asyncDir);
		if (!current) {
			writeNormalizedLifecycleStatus(asyncDir, {
				runId: input.runId,
				...(input.sessionId ? { sessionId: input.sessionId } : {}),
				mode: input.mode,
				state: input.stage,
				startedAt: input.startedAt ?? now,
				lastUpdate: now,
				...(input.stage === "paused" ? { endedAt: now } : {}),
				cwd: input.cwd,
				...(pause ? { pause } : {}),
				...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
				...(input.chainStepCount !== undefined ? { chainStepCount: input.chainStepCount } : {}),
				...(input.parallelGroups ? { parallelGroups: input.parallelGroups } : {}),
				...(input.workflowGraph ? { workflowGraph: input.workflowGraph } : {}),
				...(input.outputs ? { outputs: input.outputs } : {}),
				pid: input.stage === "pausing" ? input.ownerPid : undefined,
				steps,
			});
			return;
		}
		try {
			transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: lifecycleGeneration(current),
				mutate: (status) => {
					const nextStage = status.state === "paused" && input.stage === "pausing" ? "paused" : input.stage;
					return {
						...status,
						...(input.sessionId ? { sessionId: input.sessionId } : {}),
						state: nextStage,
						pid: nextStage === "pausing" ? input.ownerPid : undefined,
						lastUpdate: now,
						...(nextStage === "paused" ? { endedAt: now } : {}),
						cwd: input.cwd,
						...(pause ? { pause } : {}),
						...(input.currentStep !== undefined ? { currentStep: input.currentStep } : {}),
						...(input.chainStepCount !== undefined ? { chainStepCount: input.chainStepCount } : {}),
						...(input.parallelGroups ? { parallelGroups: input.parallelGroups } : {}),
						...(input.workflowGraph ? { workflowGraph: input.workflowGraph } : {}),
						...(input.outputs ? { outputs: input.outputs } : {}),
						steps,
					};
				},
			});
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("expected generation") && !message.includes("persisted status was not found")) throw error;
		}
	}
	throw new Error(`Foreground cohort lifecycle update failed for run '${input.runId}'.`);
}

function pausedForegroundTerminationReason(
	result: SingleResult,
	pauseProjected = false,
): NonNullable<SingleResult["terminationReason"]> | undefined {
	return pauseProjected || result.pause ? "paused" : result.terminationReason;
}

function buildPausedStepFromResult(
	result: SingleResult,
	now: number,
	options: {
		stage: "pausing" | "paused";
		ownerPid?: number;
		status?: NonNullable<AsyncStatus["steps"]>[number]["status"];
	} = { stage: "paused" },
): NonNullable<AsyncStatus["steps"]>[number] {
	const status =
		options.status ?? (options.stage === "pausing" && result.pause ? "pausing" : pausedForegroundStepStatus(result));
	return {
		agent: result.agent,
		status,
		sessionFile: result.sessionFile,
		transcriptPath: result.transcriptPath,
		transcriptError: result.transcriptError,
		startedAt: result.progress?.durationMs !== undefined ? Math.max(0, now - result.progress.durationMs) : undefined,
		endedAt:
			options.stage === "paused" ||
			status === "paused" ||
			status === "completed" ||
			status === "failed" ||
			status === "cancelled"
				? now
				: undefined,
		durationMs: result.progress?.durationMs,
		activeRuntimeMs: result.activeRuntimeMs ?? result.progress?.durationMs,
		model: result.model,
		thinking: result.modelIdentity?.thinking ?? result.thinking,
		...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
		...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
		exitCode: result.pause || result.interrupted ? 0 : result.exitCode,
		...(result.acceptance ? { acceptance: result.acceptance } : {}),
		...(result.pause
			? {
					pause: {
						kind: result.pause.kind,
						...(result.pause.summary ? { summary: result.pause.summary } : {}),
						...(result.pause.requestedAt !== undefined ? { requestedAt: result.pause.requestedAt } : {}),
						...(status === "pausing" && options.ownerPid !== undefined && result.pause.kind === "awaiting_supervisor"
							? { ownerPid: options.ownerPid }
							: {}),
						...(status === "paused" ? { pausedAt: result.pause.pausedAt ?? now } : {}),
						...(result.pause.request ? { request: result.pause.request } : {}),
					},
				}
			: {}),
		...(result.cancel ? { cancel: result.cancel } : {}),
		...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
		...(pausedForegroundTerminationReason(result, status === "paused" || status === "pausing")
			? { terminationReason: pausedForegroundTerminationReason(result, status === "paused" || status === "pausing") }
			: {}),
	};
}

function buildCohortPauseStep(input: {
	agent: string;
	sessionFile?: string;
	status: "pending" | "pausing" | "paused";
	now: number;
	model?: string;
	thinking?: string;
	modelIdentity?: SubagentModelIdentity;
	modelResolution?: SubagentModelResolution;
	contextUsage?: ContextUsageDiagnostics;
}): NonNullable<AsyncStatus["steps"]>[number] {
	const modelIdentity = input.modelIdentity ?? canonicalSubagentModelIdentity(input.model, input.thinking);
	return {
		agent: input.agent,
		status: input.status,
		sessionFile: input.sessionFile,
		...(input.model ? { model: input.model } : {}),
		...(input.thinking ? { thinking: input.thinking } : {}),
		...(modelIdentity ? { modelIdentity } : {}),
		...(input.modelResolution ? { modelResolution: input.modelResolution } : {}),
		...(input.contextUsage ? { contextUsage: input.contextUsage } : {}),
		...(input.status === "pausing" || input.status === "paused"
			? {
					pause: {
						kind: "cohort_pause" as const,
						summary: "Paused because another child in this cohort is awaiting supervisor.",
						requestedAt: input.now,
						...(input.status === "paused" ? { pausedAt: input.now } : {}),
					},
					terminationReason: "paused" as const,
				}
			: {}),
	};
}

function persistPausedForegroundSingleRun(input: {
	runId: string;
	cwd: string;
	sessionId: string | null;
	stage: "pausing" | "paused";
	ownerPid?: number;
	result: SingleResult;
}): void {
	const asyncDir = pausedForegroundStatusPath(input.runId);
	const now =
		input.stage === "paused"
			? (input.result.pause?.pausedAt ?? Date.now())
			: (input.result.pause?.requestedAt ?? Date.now());
	const pause = input.result.pause
		? ({
				kind: input.result.pause.kind,
				...(input.result.pause.summary ? { summary: input.result.pause.summary } : {}),
				...(input.result.pause.requestedAt !== undefined ? { requestedAt: input.result.pause.requestedAt } : {}),
				...(input.stage === "paused" ? { pausedAt: now } : {}),
				...(input.stage === "pausing" && input.ownerPid !== undefined ? { ownerPid: input.ownerPid } : {}),
				...(input.result.pause.request ? { request: input.result.pause.request } : {}),
			} satisfies AsyncStatus["pause"])
		: undefined;
	const current = readStatus(asyncDir);
	if (!current) {
		if (input.stage !== "pausing")
			throw new Error(`Cannot finalize paused foreground run '${input.runId}' before its pausing checkpoint exists.`);
		writeNormalizedLifecycleStatus(asyncDir, {
			runId: input.runId,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			mode: "single",
			state: input.stage,
			startedAt:
				input.result.progress?.durationMs !== undefined ? Math.max(0, now - input.result.progress.durationMs) : now,
			lastUpdate: now,
			cwd: input.cwd,
			...(pause ? { pause } : {}),
			steps: [
				{
					agent: input.result.agent,
					status: input.stage,
					sessionFile: input.result.sessionFile,
					transcriptPath: input.result.transcriptPath,
					transcriptError: input.result.transcriptError,
					durationMs: input.result.progress?.durationMs,
					model: input.result.model,
					thinking: input.result.modelIdentity?.thinking ?? input.result.thinking,
					...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
					...(input.result.modelResolution ? { modelResolution: input.result.modelResolution } : {}),
					exitCode: 0,
					...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
					...(pausedForegroundTerminationReason(input.result)
						? { terminationReason: pausedForegroundTerminationReason(input.result) }
						: {}),
					...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
				},
			],
			sessionFile: input.result.sessionFile,
			...(input.stage === "pausing" && input.ownerPid !== undefined ? { pid: input.ownerPid } : {}),
		});
		return;
	}
	transitionLifecycleStatus({
		asyncDir,
		expectedGeneration: lifecycleGeneration(current),
		mutate: (status) => ({
			...status,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			state: input.stage,
			pid: input.stage === "pausing" ? input.ownerPid : undefined,
			lastUpdate: now,
			...(input.stage === "paused" ? { endedAt: now } : {}),
			cwd: input.cwd,
			...(pause ? { pause } : {}),
			sessionFile: input.result.sessionFile ?? status.sessionFile,
			steps: status.steps?.map((step, index) =>
				index === 0
					? {
							...step,
							agent: input.result.agent,
							status: input.stage,
							sessionFile: input.result.sessionFile ?? step.sessionFile,
							transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
							transcriptError: input.result.transcriptError ?? step.transcriptError,
							...(input.stage === "paused" ? { endedAt: now } : {}),
							durationMs: input.result.progress?.durationMs ?? step.durationMs,
							model: input.result.model ?? step.model,
							thinking: input.result.modelIdentity?.thinking ?? input.result.thinking ?? step.thinking,
							...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
							...(input.result.modelResolution ? { modelResolution: input.result.modelResolution } : {}),
							exitCode: 0,
							...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
							...(pausedForegroundTerminationReason(input.result)
								? { terminationReason: pausedForegroundTerminationReason(input.result) }
								: {}),
							...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
						}
					: step,
			),
		}),
	});
}

function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function formatForegroundActivity(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt)
		facts.push(
			`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`,
		);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running")
			return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running")
		return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
	const roots: string[] = [];
	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	if (parentSessionFile) roots.push(deps.getSubagentSessionRoot(parentSessionFile));
	return [...new Set(roots)];
}

function foregroundStatusResult(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): SubagentToolResult<Details> {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent
			? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
			: undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

function trimRememberedForegroundRuns(state: SubagentState): void {
	if (!state.foregroundRuns) return;
	while (state.foregroundRuns.size > 50) {
		const oldest = [...state.foregroundRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldest) break;
		state.foregroundRuns.delete(oldest.runId);
	}
}

function rememberForegroundRun(
	state: SubagentState,
	input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; results: SingleResult[] },
): void {
	state.foregroundRuns ??= new Map();
	const previous = state.foregroundRuns.get(input.runId);
	const updatedAt = Date.now();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		updatedAt,
		children: input.results.map((result, index) => {
			const activeRuntimeMs = result.activeRuntimeMs ?? result.progress?.durationMs;
			const child = {
				agent: result.agent,
				index,
				status: resolveSubagentResultStatus({
					exitCode: result.exitCode,
					interrupted: result.interrupted,
					detached: result.detached,
				}),
				updatedAt,
				...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
				...(result.model ? { model: result.model } : {}),
				...(result.thinking ? { thinking: result.thinking } : {}),
				...(result.modelIdentity ? { modelIdentity: result.modelIdentity } : {}),
				...(result.modelResolution ? { modelResolution: result.modelResolution } : {}),
				...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
				...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
				...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
				...(result.detachedReason ? { detachedReason: result.detachedReason } : {}),
				...(result.acceptance ? { acceptance: result.acceptance } : {}),
				...(result.pause ? { pause: result.pause } : {}),
				...(result.cancel ? { cancel: result.cancel } : {}),
				...(result.contextUsage ? { contextUsage: result.contextUsage } : {}),
				...(pausedForegroundTerminationReason(result)
					? { terminationReason: pausedForegroundTerminationReason(result) }
					: {}),
				...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
			};
			const recovered = previous?.children[index];
			return child.status === "detached" && recovered && recovered.status !== "detached" ? recovered : child;
		}),
	});
	trimRememberedForegroundRuns(state);
}

function updateRememberedForegroundChild(
	state: SubagentState,
	input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; index: number; result: SingleResult },
): void {
	state.foregroundRuns ??= new Map();
	const updatedAt = Date.now();
	let run = state.foregroundRuns.get(input.runId);
	if (!run) {
		run = { runId: input.runId, mode: input.mode, cwd: input.cwd, updatedAt, children: [] };
		state.foregroundRuns.set(input.runId, run);
	}
	run.updatedAt = updatedAt;
	const child = run.children[input.index] ?? {
		agent: input.result.agent,
		index: input.index,
		status: "detached" as const,
	};
	const activeRuntimeMs = input.result.activeRuntimeMs ?? input.result.progress?.durationMs;
	run.children[input.index] = {
		...child,
		agent: input.result.agent,
		index: input.index,
		status: resolveSubagentResultStatus({
			exitCode: input.result.exitCode,
			interrupted: input.result.interrupted,
			detached: false,
		}),
		updatedAt,
		...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
		...(input.result.model ? { model: input.result.model } : {}),
		...(input.result.thinking ? { thinking: input.result.thinking } : {}),
		...(input.result.modelIdentity ? { modelIdentity: input.result.modelIdentity } : {}),
		...(input.result.modelResolution ? { modelResolution: input.result.modelResolution } : {}),
		...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
		...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
		...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
		...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
		...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
		...(input.result.detachedReason ? { detachedReason: input.result.detachedReason } : {}),
		...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
		...(input.result.pause ? { pause: input.result.pause } : {}),
		...(input.result.cancel ? { cancel: input.result.cancel } : {}),
		...(input.result.contextUsage ? { contextUsage: input.result.contextUsage } : {}),
		...(pausedForegroundTerminationReason(input.result)
			? { terminationReason: pausedForegroundTerminationReason(input.result) }
			: {}),
		...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
	};
	trimRememberedForegroundRuns(state);
}

function resolveRememberedForegroundRun(
	params: SubagentParamsLike,
	state: SubagentState,
):
	| {
			run: import("../../shared/types.ts").ForegroundResumeRun;
			index: number;
			child: import("../../shared/types.ts").ForegroundResumeChild;
	  }
	| undefined {
	const requested = params.id?.trim();
	if (!requested || !state.foregroundRuns?.size) return undefined;
	const direct = state.foregroundRuns.get(requested);
	const matches = direct
		? [direct]
		: [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
	if (matches.length === 0) return undefined;
	if (matches.length > 1)
		throw new Error(
			`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`,
		);
	const run = matches[0]!;
	if (run.children.length > 1 && params.index === undefined)
		throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
	const index = params.index ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
	if (index < 0 || index >= run.children.length)
		throw new Error(
			`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`,
		);
	return { run, index, child: run.children[index]! };
}

function resolveForegroundResumeTarget(
	params: SubagentParamsLike,
	state: SubagentState,
):
	| {
			runId: string;
			mode: "single" | "parallel" | "chain";
			state: "complete" | "failed" | "paused";
			agent: string;
			index: number;
			intercomTarget: string;
			cwd: string;
			sessionFile: string;
			asyncDir?: string;
			pauseKind?: "awaiting_supervisor" | "cohort_pause";
			continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
			modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
			modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
			contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
			contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
			activeRuntimeMs?: number;
	  }
	| undefined {
	const resolved = resolveRememberedForegroundRun(params, state);
	if (!resolved) return undefined;
	const { run, index, child } = resolved;
	if (child.status === "detached")
		throw new Error(
			`Foreground run '${run.runId}' child ${index} is a legacy detached entry and cannot be revived safely from remembered foreground state. Inspect status/artifacts, then resume or replace work explicitly if needed.`,
		);
	if (child.cancel?.cancelledAt)
		throw new Error(
			`Foreground run '${run.runId}' child ${index} was cancelled while paused and cannot be resumed. Inspect status or transcript artifacts if needed.`,
		);
	if (!child.sessionFile)
		throw new Error(
			`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`,
		);
	if (path.extname(child.sessionFile) !== ".jsonl")
		throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file.`);
	const sessionFile = path.resolve(child.sessionFile);
	if (!fs.existsSync(sessionFile))
		throw new Error(`Foreground run '${run.runId}' child ${index} session file is missing.`);
	const childState = child.status === "completed" ? "complete" : child.status;
	const childModelIdentity = child.modelIdentity ?? canonicalSubagentModelIdentity(child.model, child.thinking);
	const continuationAcceptance =
		childState === "paused" && child.acceptance?.status === "skipped"
			? child.acceptance.effectiveAcceptance
			: undefined;
	return {
		runId: run.runId,
		mode: run.mode,
		state: childState,
		agent: child.agent,
		index,
		intercomTarget: resolveSubagentIntercomTarget(run.runId, child.agent, index),
		cwd: run.cwd,
		sessionFile,
		...(fs.existsSync(pausedForegroundStatusPath(run.runId))
			? { asyncDir: pausedForegroundStatusPath(run.runId) }
			: {}),
		...(child.pause?.kind ? { pauseKind: child.pause.kind } : {}),
		...(continuationAcceptance ? { continuationAcceptance } : {}),
		...(childModelIdentity ? { modelIdentity: childModelIdentity } : {}),
		...(child.modelResolution ? { modelResolution: child.modelResolution } : {}),
		...(parseContextUsageDiagnostics(child.contextUsage)
			? { contextUsage: parseContextUsageDiagnostics(child.contextUsage) }
			: {}),
		...(parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds)
			? {
					contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
						child.contextPressureCrossedThresholds,
					),
				}
			: {}),
		...(child.activeRuntimeMs !== undefined ? { activeRuntimeMs: child.activeRuntimeMs } : {}),
	};
}

type AsyncResumeSourceTarget = ReturnType<typeof resolveAsyncResumeTarget> & { source: "async" };
type ForegroundResumeSourceTarget = NonNullable<ReturnType<typeof resolveForegroundResumeTarget>> & {
	kind: "revive";
	source: "foreground";
};
type NestedResumeSourceTarget = {
	kind: "revive";
	source: "nested";
	runId: string;
	state: "complete" | "failed" | "paused";
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile: string;
	pauseKind?: "awaiting_supervisor" | "cohort_pause";
	continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
	modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
	modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
	contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
	contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
	activeRuntimeMs?: number;
	asyncDir?: string;
};
type ResumeSourceTarget = AsyncResumeSourceTarget | ForegroundResumeSourceTarget | NestedResumeSourceTarget;

type AsyncInterruptRequestResult = ReturnType<typeof requestAsyncInterruptForTarget>;

function isAsyncInterruptFailure(
	result: AsyncInterruptRequestResult,
): result is Extract<AsyncInterruptRequestResult, { ok: false }> {
	return !result.ok;
}

function isAsyncInterruptNotRunning(
	result: AsyncInterruptRequestResult,
): result is Extract<AsyncInterruptRequestResult, { ok: false; kind: "not_running" }> {
	return "kind" in result && result.kind === "not_running";
}

function buildRunStatusParams(params: SubagentParamsLike) {
	return {
		action: "status" as const,
		id: params.id,
		dir: params.dir,
		index: params.index,
		view: params.view,
		lines: params.lines,
	};
}

function buildManagementActionParams(params: SubagentParamsLike) {
	return {
		action: params.action,
		agent: params.agent,
		chainName: params.chainName,
		agentScope: params.agentScope,
		config: params.config,
	};
}

const UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE =
	"Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";

function unsupportedSavedChainInputResult(params: SubagentParamsLike, detail: string): SubagentToolResult<Details> {
	const text = detail.startsWith("The Last Harness") ? detail : `${UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE} ${detail}`;
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { mode: params.action ? "management" : getRequestedModeLabel(params), results: [] },
	};
}

function unsupportedSavedChainInput(params: SubagentParamsLike): string | undefined {
	if (params.chain !== undefined) return "Omit 'chain'.";
	if (params.chainName !== undefined) return "Omit 'chainName'.";
	if (params.chainDir !== undefined) return "Omit 'chainDir'.";
	if (params.clarify !== undefined) return "The Last Harness does not support the chain clarify UI; omit 'clarify'.";
	return undefined;
}

function isAsyncRunNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Async run not found.");
}

function isResumeAmbiguity(error: unknown): boolean {
	return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}

function resumeTargetExact(target: { runId: string } | undefined, requested: string): boolean {
	return target?.runId === requested;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExactResumeError(error: unknown, source: "async" | "foreground", requested: string): boolean {
	if (!(error instanceof Error) || !requested) return false;
	return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}

function resolveResumeTarget(
	params: SubagentParamsLike,
	state: SubagentState,
	options: { asyncRequireSessionFile?: boolean; readOnly?: boolean } = {},
): ResumeSourceTarget {
	const requested = params.id?.trim() ?? "";
	let foregroundTarget: ForegroundResumeSourceTarget | undefined;
	let foregroundError: unknown;
	let asyncTarget: AsyncResumeSourceTarget | undefined;
	let asyncError: unknown;

	try {
		const target = resolveForegroundResumeTarget(params, state);
		if (target) foregroundTarget = { kind: "revive", source: "foreground", ...target };
	} catch (error) {
		foregroundError = error;
	}
	try {
		asyncTarget = {
			source: "async",
			...resolveAsyncResumeTarget(
				params,
				{},
				{
					requireSessionFile: options.asyncRequireSessionFile,
					readOnly: options.readOnly,
				},
			),
		};
	} catch (error) {
		asyncError = error;
	}

	if (foregroundTarget && asyncTarget) {
		const foregroundExact = resumeTargetExact(foregroundTarget, requested);
		const asyncExact = resumeTargetExact(asyncTarget, requested);
		if (foregroundExact && asyncExact && foregroundTarget.runId === asyncTarget.runId) return foregroundTarget;
		if (foregroundExact && !asyncExact) return foregroundTarget;
		if (asyncExact && !foregroundExact) return asyncTarget;
		throw new Error(
			`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`,
		);
	}
	if (foregroundTarget) {
		if (isExactResumeError(asyncError, "async", requested) && !resumeTargetExact(foregroundTarget, requested))
			throw asyncError;
		if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested)) throw asyncError;
		return foregroundTarget;
	}
	if (asyncTarget) {
		if (isExactResumeError(foregroundError, "foreground", requested)) throw foregroundError;
		if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested)) throw foregroundError;
		return asyncTarget;
	}
	if (foregroundError && !isAsyncRunNotFound(asyncError)) throw foregroundError;
	if (foregroundError) throw foregroundError;
	if (asyncError) throw asyncError;
	throw new Error("Run not found. Provide id.");
}

type PausedContinuationClaim = {
	asyncDir: string;
	claimToken: string;
	rollbackReserved: () => void;
	markSpawned: () => void;
};

type ContinuationClaimDecision = PausedContinuationClaim | { blockedMessage: string } | undefined;

function claimPausedAwaitingSupervisorTarget(
	target: ResumeSourceTarget,
	continuationRunId: string,
	effectiveContextWindow?: number,
): ContinuationClaimDecision {
	if (target.kind !== "revive" || !("asyncDir" in target) || !target.asyncDir) return undefined;
	const asyncDir = target.asyncDir;
	const decision = withLifecycleStatusLock<{ claimToken: string } | { blockedMessage: string } | undefined>(
		asyncDir,
		(persisted) => {
			if (!persisted) throw new Error(`Paused run '${target.runId}' was not found.`);
			let current = persisted;
			const recovered = recoverStaleLifecycleContinuationStatus(current, asyncDir, target.index);
			if (recovered.recovered) current = recovered.status;
			const currentStep = current.steps?.[target.index];
			if (current.state === "cancelled" || currentStep?.status === "cancelled")
				throw new Error(`Paused run '${target.runId}' child ${target.index} was cancelled and cannot be resumed.`);
			if (current.state === "continued" || currentStep?.status === "continued")
				throw new Error(
					`Paused run '${target.runId}' child ${target.index} already launched its continuation and cannot be resumed again.`,
				);
			const latestContextUsage = parseContextUsageDiagnostics(currentStep?.contextUsage) ?? target.contextUsage;
			const contextAssessment = assessDurableResumeContext(latestContextUsage, effectiveContextWindow);
			if (contextAssessment.blocked) return { blockedMessage: formatDurableResumeContextBlock(contextAssessment) };
			if (
				current.state !== "paused" ||
				!currentStep ||
				(currentStep.status !== "paused" && currentStep.status !== "pausing")
			) {
				if (isClaimedPausedLifecycle(current, target.index))
					throw new Error(
						`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`,
					);
				if (target.state === "paused")
					throw new Error(`Paused run '${target.runId}' child ${target.index} is not paused and cannot be resumed.`);
				return undefined;
			}
			if (isClaimedPausedLifecycle(current, target.index))
				throw new Error(
					`Paused run '${target.runId}' child ${target.index} was already claimed for continuation and cannot be resumed again.`,
				);
			const claimToken = `claim-${target.runId}-${target.index}-${Date.now()}`;
			const claimedAt = Date.now();
			const nextStatus: AsyncStatus = {
				...current,
				lastUpdate: claimedAt,
				pause: current.pause ? { ...current.pause, ownerPid: undefined } : current.pause,
				lifecycle: {
					...withLifecycleContinuation(current, target.index, {
						phase: "reserved",
						claimToken,
						claimedAt,
						ownerPid: process.pid,
						continuationRunId,
					}),
					generation: lifecycleGeneration(current) + 1,
				},
			};
			writeNormalizedLifecycleStatus(asyncDir, nextStatus);
			return { claimToken };
		},
	);
	if (!decision || "blockedMessage" in decision) return decision;
	return {
		asyncDir,
		claimToken: decision.claimToken,
		rollbackReserved: () => {
			const latest = readStatus(asyncDir);
			if (!latest || latest.state !== "paused") return;
			const latestContinuation = indexedLifecycleContinuation(latest, target.index);
			if (
				latestContinuation?.claimToken !== decision.claimToken ||
				latestContinuation.continuationRunId !== continuationRunId ||
				latestContinuation.phase !== "reserved"
			)
				return;
			transitionLifecycleStatus({
				asyncDir,
				expectedGeneration: lifecycleGeneration(latest),
				mutate: (status) => ({
					...status,
					lastUpdate: Date.now(),
					lifecycle: withLifecycleContinuation(status, target.index, undefined),
				}),
			});
		},
		markSpawned: () => {
			markLifecycleContinuationSpawned(asyncDir, target.index, decision.claimToken, continuationRunId);
		},
	};
}

function recoverFailedPausedForegroundTransition(input: { runId: string; error: unknown }): void {
	const asyncDir = pausedForegroundStatusPath(input.runId);
	const message = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
	try {
		const current = readStatus(asyncDir);
		if (!current || current.state !== "pausing") return;
		const failedAt = Date.now();
		transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: lifecycleGeneration(current),
			mutate: (status) => ({
				...status,
				state: "failed",
				pid: undefined,
				lastUpdate: failedAt,
				endedAt: failedAt,
				error: message,
				pause: status.pause ? { ...status.pause, ownerPid: undefined } : status.pause,
				steps: status.steps?.map((step, index) =>
					index === 0 && (step.status === "pausing" || step.status === "paused")
						? {
								...step,
								status: "failed",
								endedAt: failedAt,
								exitCode: 1,
								terminationReason: "process_exit",
								error: step.error ?? message,
							}
						: step,
				),
			}),
		});
	} catch {
		// Best effort only; the explicit foreground failure still propagates.
	}
}

function enrichPersistedPausedForegroundSingleRun(input: { runId: string; result: SingleResult }): void {
	const asyncDir = pausedForegroundStatusPath(input.runId);
	const current = readStatus(asyncDir);
	if (current?.pause?.kind === "awaiting_supervisor" && (current.state === "paused" || current.state === "pausing")) {
		transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: lifecycleGeneration(current),
			mutate: (status) => ({
				...status,
				lastUpdate: Date.now(),
				sessionFile: input.result.sessionFile ?? status.sessionFile,
				steps: status.steps?.map((step, index) =>
					index === 0
						? {
								...step,
								sessionFile: input.result.sessionFile ?? step.sessionFile,
								transcriptPath: input.result.transcriptPath ?? step.transcriptPath,
								transcriptError: input.result.transcriptError ?? step.transcriptError,
								terminationReason: step.terminationReason ?? "paused",
								...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
							}
						: step,
				),
			}),
		});
	}
}

function getAsyncInterruptTarget(
	state: SubagentState,
	runId: string | undefined,
	location?: { asyncDir: string | null; resolvedId?: string },
): { asyncId: string; asyncDir: string } | undefined {
	if (location?.asyncDir) {
		return {
			asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
			asyncDir: location.asyncDir,
		};
	}
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

function requestForegroundInterrupt(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
): boolean {
	if (!control?.interrupt) return false;
	const interrupted = control.interrupt();
	if (interrupted) {
		control.updatedAt = Date.now();
		control.currentActivityState = undefined;
	}
	return interrupted;
}

function updateRememberedForegroundCancellation(
	state: SubagentState,
	runId: string,
	cancelledAt: number,
	summary: string,
	index = 0,
): void {
	const run = state.foregroundRuns?.get(runId);
	const child = run?.children[index];
	if (!run || !child) return;
	run.updatedAt = cancelledAt;
	run.children[index] = {
		...child,
		cancel: { summary, cancelledAt },
		terminationReason: "cancelled",
	};
}

function cancelPersistedPausedForegroundRun(
	state: SubagentState,
	asyncDir: string,
	runId: string,
	index?: number,
): SubagentToolResult<Details> {
	try {
		let current = readStatus(asyncDir);
		if (!current) {
			return {
				content: [{ type: "text", text: `Paused foreground run '${runId}' was not found.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const stepCount = current.steps?.length ?? 0;
		const targetIndex = index ?? (stepCount <= 1 ? 0 : undefined);
		if (stepCount > 1 && targetIndex === undefined) {
			return {
				content: [
					{
						type: "text",
						text: `Foreground run '${runId}' has ${stepCount} children. Provide index to cancel one paused child.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (targetIndex === undefined || targetIndex < 0 || targetIndex >= stepCount) {
			return {
				content: [
					{
						type: "text",
						text: `Foreground run '${runId}' has ${stepCount} children. Index ${targetIndex ?? -1} is out of range.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, targetIndex);
		if (recovered.recovered && recovered.status) current = recovered.status;
		const targetStep = current.steps?.[targetIndex];
		const targetPause = targetStep?.pause ?? (stepCount <= 1 ? current.pause : undefined);
		if (targetStep?.status === "cancelled") {
			return {
				content: [{ type: "text", text: `Foreground run '${runId}' child ${targetIndex} is already cancelled.` }],
				details: { mode: "management", results: [] },
			};
		}
		if (targetStep?.status === "continued") {
			return {
				content: [
					{
						type: "text",
						text: `Foreground run '${runId}' child ${targetIndex} already continued and cannot be cancelled.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (current.state === "continued" && stepCount <= 1) {
			return {
				content: [
					{
						type: "text",
						text: `Foreground run '${runId}' already continued into '${lifecycleContinuationForIndex(current, targetIndex)?.continuationRunId ?? current.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and can no longer be cancelled from the paused supervisor lifecycle.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (isClaimedPausedLifecycle(current, targetIndex)) {
			return {
				content: [
					{
						type: "text",
						text: `Foreground run '${runId}' child ${targetIndex} is already claimed for continuation and cannot be cancelled through the paused supervisor lifecycle.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (
			current.state !== "paused" ||
			!targetStep ||
			(targetStep.status !== "paused" && targetStep.status !== "pausing") ||
			!targetPause
		) {
			return {
				content: [{ type: "text", text: `Foreground run '${runId}' child ${targetIndex} is not a paused child.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const cancelledAt = Date.now();
		const summary =
			targetPause.kind === "awaiting_supervisor"
				? "Cancelled while paused awaiting supervisor."
				: "Cancelled while paused with the cohort.";
		transitionLifecycleStatus({
			asyncDir,
			expectedGeneration: lifecycleGeneration(current),
			mutate: (status) => {
				const nextSteps = status.steps?.map((step, stepIndex) =>
					stepIndex === targetIndex
						? {
								...step,
								status: "cancelled" as const,
								endedAt: cancelledAt,
								exitCode: 0,
								cancel: { summary, cancelledAt },
								terminationReason: "cancelled" as const,
							}
						: step,
				);
				const remainingActionable =
					nextSteps?.some(
						(step) => step.status === "paused" || step.status === "pausing" || step.status === "pending",
					) ?? false;
				return {
					...status,
					state: remainingActionable ? "paused" : "cancelled",
					pid: undefined,
					...(remainingActionable ? {} : { cancel: { summary, cancelledAt } }),
					pause: remainingActionable
						? nextSteps?.find(
								(step) =>
									step.pause?.kind === "awaiting_supervisor" && (step.status === "paused" || step.status === "pausing"),
							)?.pause
						: undefined,
					lastUpdate: cancelledAt,
					endedAt: cancelledAt,
					lifecycle: withLifecycleContinuation(status, targetIndex, undefined),
					steps: nextSteps,
				};
			},
		});
		updateRememberedForegroundCancellation(state, runId, cancelledAt, summary, targetIndex);
		return {
			content: [
				{
					type: "text",
					text: `Cancelled paused foreground run ${runId} child ${targetIndex}. Existing artifacts and transcript were preserved; resume is no longer available for that child.`,
				},
			],
			details: { mode: "management", results: [] },
		};
	} catch {
		return {
			content: [
				{
					type: "text",
					text: `Paused foreground run '${runId}' could not be updated safely. ${FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE}`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function resolveAsyncResultsDir(asyncDir: string): string | undefined {
	const relative = path.relative(NESTED_ASYNC_RUNS_DIR, path.resolve(asyncDir));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const [rootRunId, runId] = relative.split(path.sep).filter(Boolean);
	if (!rootRunId || !runId) return undefined;
	return path.join(RESULTS_DIR, "nested", rootRunId);
}

function requestAsyncInterruptForTarget(
	state: SubagentState,
	target: { asyncId: string; asyncDir: string },
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
): { ok: true } | { ok: false; kind: "not_running" | "error"; error?: string } {
	const resultsDir = resolveAsyncResultsDir(target.asyncDir);
	const status = reconcileAsyncRun(target.asyncDir, resultsDir ? { kill, resultsDir } : { kill }).status;
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return { ok: false, kind: "not_running" };
	}
	try {
		deliverInterruptRequest({ asyncDir: target.asyncDir, pid: status.pid, kill, source: "interrupt-action" });
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, kind: "error", error: message };
	}
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function normalizeComparableCwd(cwd: string): string {
	const resolved = path.resolve(cwd);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function diskOnlyAsyncStatusBelongsElsewhere(state: SubagentState, status: AsyncStatus): boolean {
	if (state.currentSessionId && status.sessionId) return state.currentSessionId !== status.sessionId;
	if (state.baseCwd && status.cwd && normalizeComparableCwd(state.baseCwd) !== normalizeComparableCwd(status.cwd))
		return true;
	return false;
}

function discoverDiskOnlyRunningAsyncTargets(
	state: SubagentState,
	knownAsyncDirs: Set<string>,
): { targets: Array<{ asyncId: string; asyncDir: string }>; errors: string[] } {
	const targets: Array<{ asyncId: string; asyncDir: string }> = [];
	const errors: string[] = [];
	const candidates: Array<{ asyncDir: string; fallbackId: string }> = [];

	try {
		for (const entry of fs.readdirSync(ASYNC_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			candidates.push({ asyncDir: path.join(ASYNC_DIR, entry.name), fallbackId: entry.name });
		}
	} catch (error) {
		if (!isNotFoundError(error)) {
			return {
				targets,
				errors: [
					`Failed to list async runs in '${ASYNC_DIR}': ${error instanceof Error ? error.message : String(error)}`,
				],
			};
		}
	}

	try {
		for (const rootEntry of fs.readdirSync(NESTED_ASYNC_RUNS_DIR, { withFileTypes: true })) {
			if (!rootEntry.isDirectory()) continue;
			const rootDir = path.join(NESTED_ASYNC_RUNS_DIR, rootEntry.name);
			try {
				for (const runEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
					if (!runEntry.isDirectory()) continue;
					candidates.push({ asyncDir: path.join(rootDir, runEntry.name), fallbackId: runEntry.name });
				}
			} catch (error) {
				if (isNotFoundError(error)) continue;
				errors.push(
					`Failed to list nested async runs in '${rootDir}': ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch (error) {
		if (!isNotFoundError(error)) {
			errors.push(
				`Failed to list nested async runs in '${NESTED_ASYNC_RUNS_DIR}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	for (const candidate of candidates) {
		if (knownAsyncDirs.has(candidate.asyncDir)) continue;
		try {
			const rawStatus = readStatus(candidate.asyncDir);
			if (!rawStatus || rawStatus.state !== "running" || diskOnlyAsyncStatusBelongsElsewhere(state, rawStatus))
				continue;
			const resultsDir = resolveAsyncResultsDir(candidate.asyncDir);
			const status = reconcileAsyncRun(candidate.asyncDir, resultsDir ? { resultsDir } : {}).status;
			if (status?.state === "running") {
				targets.push({
					asyncId: typeof status.runId === "string" && status.runId ? status.runId : candidate.fallbackId,
					asyncDir: candidate.asyncDir,
				});
			}
		} catch (error) {
			errors.push(
				`Failed to inspect async run ${candidate.fallbackId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { targets, errors };
}

export interface InterruptAllRunningSubagentRunsResult {
	foregroundRunIds: string[];
	asyncRunIds: string[];
	skippedForegroundRunIds: string[];
	skippedAsyncRunIds: string[];
	errors: string[];
}

export function requestInterruptAllRunningSubagentRuns(state: SubagentState): InterruptAllRunningSubagentRunsResult {
	const result: InterruptAllRunningSubagentRunsResult = {
		foregroundRunIds: [],
		asyncRunIds: [],
		skippedForegroundRunIds: [],
		skippedAsyncRunIds: [],
		errors: [],
	};
	for (const control of state.foregroundControls.values()) {
		if (requestForegroundInterrupt(control)) result.foregroundRunIds.push(control.runId);
		else result.skippedForegroundRunIds.push(control.runId);
	}
	const knownAsyncDirs = new Set<string>();
	for (const job of state.asyncJobs.values()) {
		knownAsyncDirs.add(job.asyncDir);
		const interruptResult = requestAsyncInterruptForTarget(state, { asyncId: job.asyncId, asyncDir: job.asyncDir });
		if (!isAsyncInterruptFailure(interruptResult)) {
			result.asyncRunIds.push(job.asyncId);
		} else if (interruptResult.kind === "error") {
			result.errors.push(`Failed to interrupt async run ${job.asyncId}: ${interruptResult.error ?? "unknown error"}`);
		} else {
			result.skippedAsyncRunIds.push(job.asyncId);
		}
	}
	const diskOnly = discoverDiskOnlyRunningAsyncTargets(state, knownAsyncDirs);
	for (const target of diskOnly.targets) {
		const interruptResult = requestAsyncInterruptForTarget(state, target);
		if (!isAsyncInterruptFailure(interruptResult)) {
			result.asyncRunIds.push(target.asyncId);
		} else if (interruptResult.kind === "error") {
			result.errors.push(
				`Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
			);
		} else {
			result.skippedAsyncRunIds.push(target.asyncId);
		}
	}
	result.errors.push(...diskOnly.errors);
	return result;
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (
		input.event.type !== "active_long_running" &&
		input.controlConfig.notifyChannels.includes("intercom") &&
		input.intercomBridge.active &&
		input.intercomBridge.orchestratorTarget
	) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

function interruptAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
): SubagentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId, location);
	if (!target) return null;
	const interruptResult = requestAsyncInterruptForTarget(state, target, kill);
	if (!isAsyncInterruptFailure(interruptResult)) {
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	}
	return {
		content: [
			{
				type: "text",
				text: isAsyncInterruptNotRunning(interruptResult)
					? `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.`
					: `Failed to interrupt async run ${target.asyncId}: ${interruptResult.error ?? "unknown error"}`,
			},
		],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

function asyncControlOwnedByCurrentSession(state: SubagentState, status: AsyncStatus): boolean {
	return (
		typeof state.currentSessionId === "string" &&
		state.currentSessionId.length > 0 &&
		typeof status.sessionId === "string" &&
		status.sessionId === state.currentSessionId
	);
}

function steerAsyncRun(input: {
	state: SubagentState;
	runId: string;
	message: string;
	index?: number;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	location: { asyncDir: string | null; resolvedId?: string };
}): SubagentToolResult<Details> {
	if (!input.location.asyncDir) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const status = reconcileAsyncRun(input.location.asyncDir, { kill: input.kill }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		return {
			content: [{ type: "text", text: `Async run '${input.runId}' is not running or queued and cannot be steered.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!asyncControlOwnedByCurrentSession(input.state, status)) {
		return {
			content: [
				{
					type: "text",
					text: `Async run '${status.runId}' is owned by another session and cannot be steered from this session.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const steps = status.steps ?? [];
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length) {
			return {
				content: [
					{
						type: "text",
						text: `Async run '${status.runId}' has ${steps.length} children. Index ${input.index} is out of range.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		const targetStep = steps[input.index];
		if (targetStep && targetStep.status !== "running" && targetStep.status !== "pending") {
			return {
				content: [
					{
						type: "text",
						text: `Async run '${status.runId}' child ${input.index} is ${targetStep.status} and cannot be steered.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	} else {
		const running = steps.filter((step) => step.status === "running");
		if (running.length === 0 && steps.length > 1) {
			return {
				content: [
					{
						type: "text",
						text: `Async run '${status.runId}' has no running child yet. Provide index to steer a queued child.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	requestAsyncSteer(input.location.asyncDir, {
		message: input.message,
		targetIndex: input.index,
		source: "steer-action",
	});
	const tracked = input.state.asyncJobs.get(status.runId);
	if (tracked) tracked.updatedAt = Date.now();
	const childText = input.index !== undefined ? ` child ${input.index}` : " running child";
	return {
		content: [
			{
				type: "text",
				text: `Steering queued for async run ${status.runId}${childText}. Delivery requires a live Pi child session that supports mid-run steering.`,
			},
		],
		details: { mode: "management", results: [] },
	};
}

function nestedRunSessionFile(run: NestedRunSummary): string | undefined {
	return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}

function nestedRunAgent(run: NestedRunSummary): string | undefined {
	return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function validateNestedSessionFile(run: NestedRunSummary, trustedSessionRoots: string[]): string {
	const sessionFile = nestedRunSessionFile(run);
	if (!sessionFile) throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
	if (path.extname(sessionFile) !== ".jsonl")
		throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!path.isAbsolute(sessionFile))
		throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
	if (!fs.existsSync(resolved)) throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
	const realSessionFile = fs.realpathSync(resolved);
	const trustedRoots = trustedSessionRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
	if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
		throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
	}
	if (!realSessionFile.split(path.sep).includes(run.id)) {
		throw new Error(
			`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`,
		);
	}
	return realSessionFile;
}

type NestedResumeStatusStep = {
	status?: string;
	acceptance?: import("../../shared/types.ts").AcceptanceLedger;
	model?: string;
	thinking?: string;
	modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
	modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
	contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
	contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
	activeRuntimeMs?: number;
};

function readNestedResumeStatusStep(runId: string, asyncDir: string | undefined): NestedResumeStatusStep | undefined {
	if (!asyncDir) return undefined;
	let parsed: { steps?: unknown };
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as { steps?: unknown };
	} catch {
		throw new Error(`Nested run '${runId}' persisted status could not be read safely.`);
	}
	if (!Array.isArray(parsed.steps))
		throw new Error(`Nested run '${runId}' persisted status has invalid steps metadata.`);
	const step = parsed.steps[0];
	if (!step || typeof step !== "object" || Array.isArray(step))
		throw new Error(`Nested run '${runId}' persisted status does not have a valid step at index 0.`);
	const activeRuntimeMs = (step as { activeRuntimeMs?: unknown }).activeRuntimeMs;
	if (
		activeRuntimeMs !== undefined &&
		(typeof activeRuntimeMs !== "number" || !Number.isFinite(activeRuntimeMs) || activeRuntimeMs < 0)
	) {
		throw new Error(`Nested run '${runId}' persisted step activeRuntimeMs must be a non-negative finite number.`);
	}
	const raw = step as Record<string, unknown>;
	const modelIdentity =
		sanitizeSubagentModelIdentity(raw.modelIdentity) ??
		canonicalSubagentModelIdentity(
			typeof raw.model === "string" ? raw.model : undefined,
			typeof raw.thinking === "string" ? raw.thinking : undefined,
		);
	const modelResolution = sanitizeSubagentModelResolution(raw.modelResolution);
	const contextUsage = parseContextUsageDiagnostics(raw.contextUsage);
	const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(raw.contextPressureCrossedThresholds);
	return {
		...(typeof raw.status === "string" ? { status: raw.status } : {}),
		...(modelIdentity ? { modelIdentity } : {}),
		...(modelResolution ? { modelResolution } : {}),
		...(contextUsage ? { contextUsage } : {}),
		...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
		...(typeof activeRuntimeMs === "number" ? { activeRuntimeMs } : {}),
		...(raw.acceptance ? { acceptance: raw.acceptance as NestedResumeStatusStep["acceptance"] } : {}),
	};
}

function resolveNestedContinuationAcceptance(
	runId: string,
	step: NestedResumeStatusStep | undefined,
): import("../../shared/types.ts").ResolvedAcceptanceConfig | undefined {
	const failClosed = () =>
		new Error(
			`Nested run '${runId}' is paused but its skipped acceptance ledger could not be read. Retry the resume once pause metadata is persisted.`,
		);
	if (!step?.acceptance) throw failClosed();
	return step.acceptance.status === "skipped" ? step.acceptance.effectiveAcceptance : undefined;
}

function resolveNestedResumeTarget(
	match: ResolvedSubagentRunId & { kind: "nested" },
	trustedSessionRoots: string[],
): NestedResumeSourceTarget {
	const run = match.match.run;
	if (run.state === "running" || run.state === "queued")
		throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
	const agent = nestedRunAgent(run);
	if (!agent) throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
	const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
	const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
	const statusStep = readNestedResumeStatusStep(run.id, asyncDir);
	const statusModelIdentity = statusStep?.modelIdentity;
	const statusModelResolution = statusStep?.modelResolution;
	const contextUsage = statusStep?.contextUsage;
	const contextPressureCrossedThresholds = statusStep?.contextPressureCrossedThresholds;
	const continuationAcceptance =
		state === "paused" ? resolveNestedContinuationAcceptance(run.id, statusStep) : undefined;
	return {
		kind: "revive",
		source: "nested",
		runId: run.id,
		state,
		agent,
		index: 0,
		...(continuationAcceptance ? { continuationAcceptance } : {}),
		...(statusModelIdentity ? { modelIdentity: statusModelIdentity } : {}),
		...(statusModelResolution ? { modelResolution: statusModelResolution } : {}),
		...(contextUsage ? { contextUsage } : {}),
		...(contextPressureCrossedThresholds
			? { contextPressureCrossedThresholds: [...contextPressureCrossedThresholds] }
			: {}),
		...(statusStep?.activeRuntimeMs !== undefined ? { activeRuntimeMs: statusStep.activeRuntimeMs } : {}),
		...(asyncDir ? { asyncDir } : {}),
		...(run.state === "paused" ? { pauseKind: "cohort_pause" as const } : {}),
		intercomTarget: resolveSubagentIntercomTarget(run.id, agent, 0),
		cwd: asyncDir ? path.dirname(asyncDir) : undefined,
		sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
	};
}

async function waitForNestedControlResult(
	target: ResolvedSubagentRunId & { kind: "nested" },
	requestId: string,
	timeoutMs = NESTED_CONTROL_RESULT_TIMEOUT_MS,
) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = readNestedControlResults(target.match.route).find(
			(candidate) => candidate.requestId === requestId && candidate.targetRunId === target.match.run.id,
		);
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function sendNestedControlRequest(
	target: ResolvedSubagentRunId & { kind: "nested" },
	action: "interrupt" | "resume",
	message?: string,
	targetIndex?: number,
) {
	const requestId = randomUUID();
	const now = Date.now();
	const requestPath = writeNestedControlRequest(target.match.route, {
		ts: now,
		requestId,
		targetRunId: target.match.run.id,
		ownerParentRunId: target.match.run.parentRunId,
		...(target.match.run.parentStepIndex !== undefined
			? { ownerParentStepIndex: target.match.run.parentStepIndex }
			: {}),
		deliveryDeadlineAt: now + NESTED_CONTROL_DELIVERY_TIMEOUT_MS,
		action,
		...(targetIndex !== undefined ? { targetIndex } : {}),
		...(message ? { message } : {}),
	});
	const result = await waitForNestedControlResult(target, requestId);
	if (!result) {
		try {
			fs.rmSync(requestPath, { force: true });
		} catch {
			/* Best effort cancellation of an unclaimed owner-gone request. */
		}
	}
	return result;
}

function directNestedAsyncInterrupt(
	target: ResolvedSubagentRunId & { kind: "nested" },
): SubagentToolResult<Details> | undefined {
	const run = target.match.run;
	const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, {
		resultsDir: path.join(RESULTS_DIR, "nested", target.match.rootRunId),
	}).status;
	const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
	if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0) return undefined;
	try {
		deliverInterruptRequest({ asyncDir, pid, source: "nested-interrupt" });
		return {
			content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

export function registerForegroundMessageInbox(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
	_runId: string,
	index: number,
): string {
	control.messageInboxRoot ??= path.join(FOREGROUND_LIVE_MESSAGE_INBOXES_DIR, randomUUID());
	const dir = path.join(control.messageInboxRoot, String(index));
	fs.mkdirSync(dir, { recursive: true });
	if (!control.activeMessageInboxes) control.activeMessageInboxes = new Map();
	control.activeMessageInboxes.set(index, dir);
	return dir;
}

export function clearForegroundMessageInbox(
	control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never,
	index: number,
): void {
	const dir = control.activeMessageInboxes?.get(index);
	if (dir) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Best effort foreground inbox cleanup. */
		}
	}
	control.activeMessageInboxes?.delete(index);
	if (control.activeMessageInboxes?.size === 0) {
		control.activeMessageInboxes = undefined;
		if (control.messageInboxRoot) {
			try {
				fs.rmSync(control.messageInboxRoot, { recursive: true, force: true });
			} catch {
				/* Best effort foreground inbox-root cleanup. */
			}
		}
		control.messageInboxRoot = undefined;
	}
}

function directNestedAsyncSteer(input: {
	target: ResolvedSubagentRunId & { kind: "nested" };
	message: string;
	index?: number;
}): SubagentToolResult<Details> | undefined {
	const run = input.target.match.run;
	const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
	if (!asyncDir) return undefined;
	const status = reconcileAsyncRun(asyncDir, {
		resultsDir: path.join(RESULTS_DIR, "nested", input.target.match.rootRunId),
	}).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) return undefined;
	const steps = status.steps ?? [];
	if (input.index !== undefined) {
		if (input.index < 0 || input.index >= steps.length)
			return {
				content: [
					{
						type: "text",
						text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		const step = steps[input.index];
		if (step && step.status !== "running" && step.status !== "pending")
			return {
				content: [
					{
						type: "text",
						text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
	}
	requestAsyncSteer(asyncDir, { message: input.message, targetIndex: input.index, source: "nested-steer" });
	return {
		content: [
			{
				type: "text",
				text: `Steering queued for nested async run ${run.id}. Delivery requires a live Pi child session that supports mid-run steering.`,
			},
		],
		details: { mode: "management", results: [] },
	};
}

async function interruptNestedRun(
	target: ResolvedSubagentRunId & { kind: "nested" },
): Promise<SubagentToolResult<Details>> {
	const run = target.match.run;
	if (run.state === "complete")
		return {
			content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	if (run.state === "failed")
		return {
			content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	if (run.state === "paused")
		return {
			content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	const result = await sendNestedControlRequest(target, "interrupt");
	if (result)
		return {
			content: [{ type: "text", text: result.message }],
			isError: result.ok ? undefined : true,
			details: { mode: "management", results: [] },
		};
	const direct = directNestedAsyncInterrupt(target);
	if (direct) return direct;
	return {
		content: [
			{
				type: "text",
				text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.`,
			},
		],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

async function resumeLiveNestedRun(input: {
	target: ResolvedSubagentRunId & { kind: "nested" };
	message: string;
	index?: number;
}): Promise<SubagentToolResult<Details>> {
	const run = input.target.match.run;
	const result = await sendNestedControlRequest(input.target, "resume", input.message, input.index);
	if (result)
		return {
			content: [{ type: "text", text: result.message }],
			isError: result.ok ? undefined : true,
			details: { mode: "management", results: [] },
		};
	return {
		content: [
			{
				type: "text",
				text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.`,
			},
		],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

function steerNestedRun(input: {
	target: ResolvedSubagentRunId & { kind: "nested" };
	message: string;
	index?: number;
}): SubagentToolResult<Details> {
	const run = input.target.match.run;
	if (run.state !== "running" && run.state !== "queued")
		return {
			content: [{ type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	const direct = directNestedAsyncSteer(input);
	if (direct) return direct;
	return {
		content: [
			{
				type: "text",
				text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.`,
			},
		],
		isError: true,
		details: { mode: "management", results: [] },
	};
}

async function queueLiveAsyncResume(input: {
	target: AsyncResumeSourceTarget & { kind: "live" };
	followUp: string;
	state: SubagentState;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}): Promise<SubagentToolResult<Details>> {
	if (!input.target.asyncDir) {
		return {
			content: [{ type: "text", text: `Async run '${input.target.runId}' has no live run directory to resume.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const status = reconcileAsyncRun(input.target.asyncDir, { kill: input.kill, resultsDir: RESULTS_DIR }).status;
	if (!status || status.state !== "running") {
		return {
			content: [
				{
					type: "text",
					text: `Async run '${input.target.runId}' is not running and cannot accept a live resume follow-up.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!asyncControlOwnedByCurrentSession(input.state, status)) {
		return {
			content: [
				{
					type: "text",
					text: `Async run '${status.runId}' is owned by another session and cannot be resumed from this session.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const step = status.steps?.[input.target.index];
	if (!step) {
		return {
			content: [
				{
					type: "text",
					text: `Async run '${status.runId}' no longer has child ${input.target.index}. Wait for completion, then retry action='resume' if revival is still needed.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (step.status !== "running") {
		return {
			content: [
				{
					type: "text",
					text: `Async run '${status.runId}' child ${input.target.index} is ${step.status} and cannot accept a live resume follow-up.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const requestId = randomUUID();
	const requestPath = requestAsyncResume(input.target.asyncDir, {
		id: requestId,
		message: input.followUp,
		targetIndex: input.target.index,
		source: "async-resume",
	});
	const acceptance = await waitForChildMessageAcceptance({
		asyncDir: input.target.asyncDir,
		requestId,
		isRunnerAlive: () => {
			if (typeof status.pid !== "number" || status.pid <= 0) return false;
			try {
				(input.kill ?? process.kill)(status.pid, 0);
				return true;
			} catch {
				return false;
			}
		},
	});
	if (
		acceptance.outcome !== "acknowledged" ||
		acceptance.acceptance.status !== "accepted" ||
		!acceptance.acceptance.acceptedIndexes.includes(input.target.index)
	) {
		try {
			fs.rmSync(requestPath, { force: true });
		} catch {
			/* Best effort request cleanup after failed acceptance. */
		}
		const lateAckPath = childMessageAckPath(input.target.asyncDir, requestId);
		try {
			fs.rmSync(lateAckPath, { force: true });
		} catch {
			/* Best effort immediate ack cleanup. */
		}
		const lateAckCleanup = setTimeout(() => {
			try {
				fs.rmSync(lateAckPath, { force: true });
			} catch {
				/* Best effort cleanup for an acknowledgement racing the timeout. */
			}
		}, 2_500);
		lateAckCleanup.unref?.();
		const reason =
			acceptance.outcome === "runner_gone"
				? "the runner disappeared before accepting it"
				: acceptance.outcome === "timeout"
					? "the runner did not acknowledge it before the acceptance timeout"
					: (acceptance.acceptance.reason ??
						acceptance.acceptance.rejected?.[0]?.reason ??
						"the target child rejected it");
		return {
			content: [
				{
					type: "text",
					text: `Live resume follow-up for async run '${status.runId}' child ${input.target.index} was not accepted: ${reason}.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const tracked = input.state.asyncJobs.get(status.runId);
	if (tracked) tracked.updatedAt = Date.now();
	return {
		content: [
			{
				type: "text",
				text: `Resume follow-up accepted for live async run ${status.runId} child ${input.target.index} and queued in its native inbox.`,
			},
		],
		details: { mode: "management", results: [] },
	};
}

function explicitResumeModel(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed !== "inherit" ? trimmed : undefined;
}

export function buildResumeModelResolution(
	target: ResumeSourceTarget,
	requestedModel: string | undefined,
): SubagentModelResolution | undefined {
	const persisted = target.kind === "revive" ? target.modelResolution : undefined;
	const persistedEffective = target.kind === "revive" ? (target.modelIdentity ?? persisted?.resumed) : undefined;
	const persistedOriginal = target.kind === "revive" ? (persisted?.original ?? persistedEffective) : undefined;
	const explicit = explicitResumeModel(requestedModel);
	if (explicit) {
		const explicitIdentity = canonicalSubagentModelIdentity(explicit);
		const reference = persistedEffective ?? persistedOriginal;
		return {
			kind: "override",
			...(reference ? { original: reference } : {}),
			...(explicitIdentity ? { resumed: explicitIdentity } : {}),
			reason: [
				persisted?.reason,
				reference
					? `Caller explicitly overrode persisted selection ${reference.provider}/${reference.model}${reference.thinking ? `:${reference.thinking}` : ""} with '${explicit}'.`
					: `Caller explicitly selected '${explicit}' for the resumed child.`,
			]
				.filter(Boolean)
				.join(" "),
		};
	}
	if (!persistedEffective) return undefined;
	const restoration = `Restored persisted child selection ${persistedEffective.provider}/${persistedEffective.model}${persistedEffective.thinking ? `:${persistedEffective.thinking}` : ""} instead of the current parent model.`;
	return persisted?.kind === "fallback"
		? {
				...persisted,
				...(persistedOriginal ? { original: persistedOriginal } : {}),
				resumed: persistedEffective,
				reason: [persisted.reason, restoration].join(" "),
			}
		: {
				kind: "restored",
				original: persistedOriginal!,
				resumed: persistedEffective,
				reason: [persisted?.reason, restoration].filter(Boolean).join(" "),
			};
}

async function resumeAsyncRun(input: {
	params: SubagentParamsLike;
	requestCwd: string;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
}): Promise<SubagentToolResult<Details>> {
	const requestedFollowUp = (input.params.message ?? input.params.task ?? "").trim();
	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const requestedId = input.params.id;

	let target: ResumeSourceTarget;
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	try {
		let resolved: ResolvedSubagentRunId | undefined;
		try {
			resolved = requestedId ? resolveSubagentRunId(requestedId, { state: input.deps.state }) : undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			const asyncMatches = message.match(/async:/g)?.length ?? 0;
			if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1) throw error;
		}
		if (resolved?.kind === "nested") {
			if (resolved.match.run.state === "running" || resolved.match.run.state === "queued") {
				if (!requestedFollowUp) {
					return {
						content: [{ type: "text", text: "action='resume' requires message." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				return resumeLiveNestedRun({ target: resolved, message: requestedFollowUp, index: input.params.index });
			}
			const trustedSessionRoots = [
				...(parentSessionFile ? [input.deps.getSubagentSessionRoot(parentSessionFile)] : []),
			];
			target = resolveNestedResumeTarget(resolved, trustedSessionRoots);
		} else if (resolved?.kind === "async" || input.params.dir) {
			const preResolutionDir =
				resolved?.kind === "async"
					? resolved.location.asyncDir
					: input.params.dir
						? path.resolve(input.params.dir)
						: null;
			const preResolutionStatus = preResolutionDir ? readStatus(preResolutionDir) : undefined;
			const hadLiveResumeIntent = Boolean(requestedFollowUp && preResolutionStatus?.state === "running");
			const asyncTarget: AsyncResumeSourceTarget = {
				source: "async",
				...resolveAsyncResumeTarget(
					input.params,
					{ kill: input.deps.kill, resultsDir: RESULTS_DIR },
					{ requireSessionFile: true, readOnly: preResolutionStatus?.state !== "running" },
				),
			};
			if (hadLiveResumeIntent && asyncTarget.kind !== "live") {
				return {
					content: [
						{
							type: "text",
							text: `Async run '${asyncTarget.runId}' was running when resume began, but its runner or selected child went stale before the live follow-up could be accepted. No durable revival was started.`,
						},
					],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (asyncTarget.kind === "live") {
				if (!requestedFollowUp)
					return {
						content: [{ type: "text", text: "action='resume' requires message." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				return queueLiveAsyncResume({
					target: asyncTarget as AsyncResumeSourceTarget & { kind: "live" },
					followUp: requestedFollowUp,
					state: input.deps.state,
					kill: input.deps.kill,
				});
			}
			target = asyncTarget;
		} else {
			target = resolveResumeTarget(input.params, input.deps.state, {
				asyncRequireSessionFile: true,
				readOnly: true,
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	const followUp =
		requestedFollowUp ||
		(target.kind === "revive" && target.state === "paused" && target.pauseKind === "awaiting_supervisor"
			? UNCHANGED_SUPERVISOR_RESUME_MESSAGE
			: "");
	if (!followUp) {
		return {
			content: [{ type: "text", text: "action='resume' requires message." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth);
	if (blocked) {
		return {
			content: [
				{
					type: "text",
					text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
	const effectiveCwd = target.cwd ?? input.requestCwd;
	const scope: AgentScope = resolveExecutionAgentScope(input.params.agentScope);
	const discovered = input.deps.discoverAgents(effectiveCwd, scope);
	const discoveredAgents = discovered.agents;
	const modelScope = discovered.modelScope;
	const sessionName = resolveIntercomSessionTarget(
		input.deps.pi.getSessionName(),
		input.ctx.sessionManager.getSessionId(),
	);
	const intercomBridge = resolveIntercomBridge({
		config: input.deps.config.intercomBridge,
		context: input.params.context,
		orchestratorTarget: sessionName,
	});
	const agents = intercomBridge.active
		? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
		: discoveredAgents;
	const agentConfig = agents.find((agent) => agent.name === target.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent for resume: ${target.agent}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const callerTimeout = resolveForegroundTimeout(input.params);
	if (callerTimeout.error) {
		return {
			content: [{ type: "text", text: callerTimeout.error }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const activeRuntimeMs = Math.max(0, target.activeRuntimeMs ?? 0);
	const remainingAgentTimeMs = remainingExecutionTimeMs(agentConfig.maxExecutionTimeMs, activeRuntimeMs);
	if (remainingAgentTimeMs === 0) {
		return {
			content: [
				{
					type: "text",
					text: `Agent '${target.agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
				},
			],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
	let modelContextWindow: number | undefined;
	if (target.kind === "revive") {
		const selectedModel =
			explicitResumeModel(input.params.model) ??
			(target.modelIdentity ? modelReferenceFromIdentity(target.modelIdentity) : undefined) ??
			agentConfig.model ??
			(input.ctx.model ? `${input.ctx.model.provider}/${input.ctx.model.id}` : undefined);
		modelContextWindow = resolveEffectiveContextWindow(selectedModel, availableModels, input.ctx.model?.provider);
		const contextAssessment = assessDurableResumeContext(
			target.contextUsage,
			modelContextWindow ?? target.contextUsage?.contextWindow,
		);
		if (contextAssessment.blocked) {
			return {
				content: [{ type: "text", text: formatDurableResumeContextBlock(contextAssessment) }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}

	const continuationRunId = randomUUID().slice(0, 8);
	let claimedPause: PausedContinuationClaim | undefined;
	try {
		const claimDecision = claimPausedAwaitingSupervisorTarget(target, continuationRunId, modelContextWindow);
		if (claimDecision && "blockedMessage" in claimDecision) {
			return {
				content: [{ type: "text", text: claimDecision.blockedMessage }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		claimedPause = claimDecision;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	const runId = continuationRunId;
	const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false };
	const artifactsDir = getArtifactsDir(parentSessionFile);
	const resumeModelResolution = buildResumeModelResolution(target, input.params.model);
	const restoredModelIdentity =
		explicitResumeModel(input.params.model) || target.kind !== "revive" ? undefined : target.modelIdentity;
	let result: ReturnType<typeof executeAsyncSingle>;
	try {
		result = executeAsyncSingle(runId, {
			agent: target.agent,
			...(claimedPause
				? {
						continuationSource: {
							asyncDir: claimedPause.asyncDir,
							runId: target.runId,
							index: target.index,
							claimToken: claimedPause.claimToken,
						},
					}
				: {}),
			...(target.source === "async" && target.tkTicket ? { inheritedTkTicket: target.tkTicket } : {}),
			task: buildRevivedAsyncTask(target, followUp),
			modelOverride: input.params.model,
			...(restoredModelIdentity ? { restoredModelIdentity } : {}),
			...(resumeModelResolution ? { modelResolution: resumeModelResolution } : {}),
			...(target.kind === "revive" && "contextUsage" in target && target.contextUsage
				? { contextUsage: target.contextUsage }
				: {}),
			// A revived run continues the same persisted execution segment, so its
			// crossed pressure history must survive for warning deduplication. A
			// claimed pause creates a new continuation segment and intentionally
			// starts with independent history.
			...(target.kind === "revive" && !claimedPause && "contextPressureCrossedThresholds" in target
				? { contextPressureCrossedThresholds: target.contextPressureCrossedThresholds }
				: {}),
			agentConfig,
			ctx: {
				pi: input.deps.pi,
				cwd: input.requestCwd,
				currentSessionId: input.deps.state.currentSessionId,
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: input.ctx.model?.provider,
				currentModel: input.ctx.model,
				modelScope,
			},
			cwd: effectiveCwd,
			maxOutput: input.params.maxOutput,
			artifactsDir,
			artifactConfig,
			shareEnabled: input.params.share === true,
			sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
			sessionFile: target.sessionFile,
			acceptance: input.params.acceptance,
			continuationAcceptance: target.state === "paused" ? target.continuationAcceptance : undefined,
			activeRuntimeMs,
			timeoutMs: callerTimeout.timeoutMs,
			outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, runId),
			maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth),
			controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
			controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: intercomBridge.active
				? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index)
				: undefined,
			availableModels,
			fallbackModels: input.params.fallbackModels,
			modelFallbackNotice: input.params.modelFallbackNotice,
		});
	} catch (error) {
		claimedPause?.rollbackReserved();
		throw error;
	}
	if (result.isError) {
		claimedPause?.rollbackReserved();
		return result;
	}

	const revivedId = result.details.asyncId ?? runId;
	claimedPause?.markSpawned();
	if (target.source === "foreground") input.deps.state.foregroundRuns?.delete(target.runId);

	const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
	const sourceLabel = target.source;
	const privacySafeSupervisorResume =
		target.kind === "revive" && target.state === "paused" && target.pauseKind === "awaiting_supervisor";
	const lines = [
		`Revived ${sourceLabel} subagent from ${target.runId}.`,
		`Revived run: ${revivedId}`,
		`Agent: ${target.agent}`,
		privacySafeSupervisorResume ? undefined : `Session: ${target.sessionFile}`,
		!privacySafeSupervisorResume && result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
		!privacySafeSupervisorResume && revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
		`Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n")) }], details: result.details };
}

const MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS = 600;

function boundedNativeForegroundSaveError(error: string): string {
	const marker = "… [save error truncated; full diagnostic is unavailable]";
	if (error.length <= MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS) return error;
	return `${error.slice(0, MAX_NATIVE_FOREGROUND_SAVE_ERROR_CHARS - marker.length)}${marker}`;
}

function splitFinalizeSingleOutputSaveErrorBlock(
	displayOutput: string,
	saveError: string,
): { output: string; header?: string } {
	const saveErrorSuffix = `\n${saveError}`;
	if (!displayOutput.endsWith(saveErrorSuffix)) return { output: displayOutput };
	const prefix = "\n\nOutput file error: ";
	const withoutSaveError = displayOutput.slice(0, -saveErrorSuffix.length);
	const blockStart = withoutSaveError.lastIndexOf(prefix);
	if (blockStart === -1) return { output: displayOutput };
	const pathLine = withoutSaveError.slice(blockStart + prefix.length);
	if (pathLine.includes("\n")) return { output: displayOutput };
	return {
		output: displayOutput.slice(0, blockStart),
		header: `Output file error: ${pathLine}`,
	};
}

function resultSummaryForNativeForeground(result: SingleResult, displayOutput?: string): string {
	const hasSavedOutputReference = result.exitCode === 0 && Boolean(result.savedOutputPath && result.outputReference);
	const rawOutput =
		hasSavedOutputReference && result.outputMode === "file-only"
			? getSingleResultOutput(result)
			: (displayOutput ?? result.truncation?.text) || getSingleResultOutput(result);
	const singleSaveError = result.outputSaveError
		? splitFinalizeSingleOutputSaveErrorBlock(rawOutput, result.outputSaveError)
		: undefined;
	const output = singleSaveError?.output ?? rawOutput;
	const lines: string[] = [];
	if (result.outputSaveError) {
		lines.push(
			`${singleSaveError?.header ?? "Output file error:"}\n${boundedNativeForegroundSaveError(result.outputSaveError)}`,
		);
	}
	if (result.modelFallbackNotice) lines.push(`Notice: ${result.modelFallbackNotice}`);
	if (result.exitCode !== 0 && result.error) {
		const error = result.error.trim();
		const selected = output.trim();
		const summary =
			selected === error || selected.startsWith(`${error}\n`)
				? selected
				: selected
					? `${result.error}\n\nOutput:\n${output}`
					: result.error;
		lines.push(summary);
	} else {
		lines.push(output || result.error || "(no output)");
	}
	return lines.join("\n\n");
}

function resultNoticeForEarlierSuccessfulChainStep(result: SingleResult): string {
	const lines: string[] = [];
	if (result.outputSaveError) {
		lines.push(`Output file error:\n${boundedNativeForegroundSaveError(result.outputSaveError)}`);
	}
	if (result.modelFallbackNotice) lines.push(`Notice: ${result.modelFallbackNotice}`);
	// Derive wording from the same values that populate artifactPath/sessionPath in the
	// enclosing child block (result.artifactPaths?.outputPath and result.sessionFile), so
	// the note and the rendered paths cannot drift apart. Do NOT condition on outputMode
	// alone — the previous wording did that and produced a false "unavailable" claim when
	// an artifact or session path was about to be rendered directly below.
	const hasArtifact = Boolean(result.artifactPaths?.outputPath);
	const hasSession = Boolean(result.sessionFile);
	const stepOutputNote =
		hasArtifact && hasSession
			? "Earlier successful chain step output omitted here; see the artifact and session paths below for reference."
			: hasArtifact
				? "Earlier successful chain step output omitted here; see the artifact path below for reference."
				: hasSession
					? "Earlier successful chain step output omitted here; see the session path below for reference."
					: "Earlier successful chain step output omitted here; full step output is unavailable.";
	lines.push(stepOutputNote);
	if (result.outputMode === "file-only" && result.savedOutputPath && result.outputReference) {
		lines.push(getSingleResultOutput(result) || result.outputReference.message);
	}
	return lines.join("\n\n");
}

function formatFailedSingleRunOutput(result: SingleResult, displayOutput: string): string {
	const error = result.error || "Failed";
	const output = displayOutput.trim();
	const lines = [error];
	if (output && output !== error.trim()) {
		lines.push("", "Output:", output);
	}
	if (result.artifactPaths?.outputPath) {
		lines.push("", `Output artifact: ${result.artifactPaths.outputPath}`);
	}
	return lines.join("\n");
}

function createForegroundControlNotifier(
	data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">,
	deps: Pick<ExecutorDeps, "pi">,
): (event: ControlEvent) => void {
	return (event) =>
		emitControlNotification({
			pi: deps.pi,
			controlConfig: data.controlConfig,
			intercomBridge: data.intercomBridge,
			event,
		});
}

function buildForegroundNativeResult(input: {
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	nestedChildren?: NestedRunSummary[];
	displayOutputs?: string[];
	statusOverride?: SubagentResultStatus;
	errorSummary?: string;
}): { text: string; details: Details } | null {
	const visibleResults = input.details.results
		.map((result, index) => ({ result, index }))
		.filter((entry) => !entry.result.detached);
	if (visibleResults.length === 0) return null;
	const finalVisibleIndex = input.mode === "chain" ? visibleResults[visibleResults.length - 1]?.index : undefined;
	const children = visibleResults.map(({ result, index }, visibleIndex) => {
		const status = resolveSubagentResultStatus({
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			detached: result.detached,
		});
		const retainFullChainSummary =
			input.mode !== "chain" || index === finalVisibleIndex || status === "failed" || status === "paused";
		const nativeForegroundPriority =
			input.mode === "chain"
				? index === finalVisibleIndex
					? 4
					: status === "failed" || status === "paused"
						? 3
						: 1
				: undefined;
		return {
			agent: result.agent,
			status,
			summary: retainFullChainSummary
				? resultSummaryForNativeForeground(result, input.displayOutputs?.[index])
				: resultNoticeForEarlierSuccessfulChainStep(result),
			index,
			displayIndex: visibleIndex + 1,
			displayTotal: visibleResults.length,
			...(nativeForegroundPriority !== undefined ? { nativeForegroundPriority } : {}),
			artifactPath: result.artifactPaths?.outputPath,
			sessionPath: result.sessionFile,
		};
	});
	const grouped = formatForegroundNativeSubagentResult({
		runId: input.runId,
		mode: input.mode,
		children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.statusOverride ? { statusOverride: input.statusOverride } : {}),
		...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
	});
	return {
		text: grouped.text,
		details: input.details,
	};
}

function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasTasks: boolean,
	hasSingle: boolean,
): SubagentToolResult<Details> | null {
	if (Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const acceptanceErrors = validateExecutionAcceptance(params);
	if (acceptanceErrors.length > 0) {
		return {
			content: [{ type: "text", text: acceptanceErrors.join(" ") }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		};
	}

	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) {
			const task = params.tasks[i]!;
			if (!agents.find((agent) => agent.name === task.agent)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${task.agent} (task ${i + 1})` }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function validateExecutionAcceptance(params: SubagentParamsLike): string[] {
	const errors: string[] = [];
	errors.push(...validateAcceptanceInput(params.acceptance, "acceptance"));
	errors.push(...validateDispatchAcceptanceInput(params.acceptance, "acceptance"));
	for (const [index, task] of (params.tasks ?? []).entries()) {
		errors.push(...validateAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
		errors.push(...validateDispatchAcceptanceInput(task.acceptance, `tasks[${index}].acceptance`));
	}
	for (const [stepIndex, step] of (params.chain ?? []).entries()) {
		errors.push(
			...validateAcceptanceInput((step as { acceptance?: unknown }).acceptance, `chain[${stepIndex}].acceptance`),
		);
		errors.push(
			...validateDispatchAcceptanceInput(
				(step as { acceptance?: unknown }).acceptance,
				`chain[${stepIndex}].acceptance`,
			),
		);
		if (isParallelStep(step)) {
			for (const [taskIndex, task] of step.parallel.entries()) {
				errors.push(
					...validateAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`),
				);
				errors.push(
					...validateDispatchAcceptanceInput(task.acceptance, `chain[${stepIndex}].parallel[${taskIndex}].acceptance`),
				);
			}
		}
	}
	return errors;
}

function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

interface AgentDefaultContextPolicy {
	params: SubagentParamsLike;
	contextForAgent(agentName: string): "fresh" | "fork";
	usesFork: boolean;
}

function resolveAgentDefaultContextPolicy(
	params: SubagentParamsLike,
	agents: AgentConfig[],
): AgentDefaultContextPolicy {
	if (params.context !== undefined) {
		return resolveExplicitContextPolicy(params);
	}
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const contextForAgent = (agentName: string): "fresh" | "fork" =>
		byName.get(agentName)?.defaultContext === "fork" ? "fork" : "fresh";
	const usesFork = collectRequestedAgentNames(params).some((name) => contextForAgent(name) === "fork");
	return {
		params: usesFork ? { ...params, context: "fork" } : params,
		contextForAgent,
		usesFork,
	};
}

function resolveExplicitContextPolicy(params: SubagentParamsLike): AgentDefaultContextPolicy {
	const context = params.context === "fork" ? "fork" : "fresh";
	return {
		params,
		contextForAgent: () => context,
		usesFork: context === "fork",
	};
}

function collectRequestedAgentNames(params: SubagentParamsLike): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	return names;
}

function shouldForkAgent(contextPolicy: AgentDefaultContextPolicy, agentName: string): boolean {
	return contextPolicy.contextForAgent(agentName) === "fork";
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): SubagentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function resolveForegroundTimeout(params: SubagentParamsLike): { timeoutMs?: number; error?: string } {
	const rawTimeout = params.timeoutMs;
	if (rawTimeout === undefined) return {};
	if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0) {
		return { error: "timeoutMs must be a positive integer." };
	}
	return { timeoutMs: rawTimeout };
}

function resolveEffectiveSingleTimeout(
	callerTimeoutMs: number | undefined,
	agentTimeoutCeilingMs: number | undefined,
): number | undefined {
	if (callerTimeoutMs === undefined) return agentTimeoutCeilingMs;
	if (agentTimeoutCeilingMs === undefined) return callerTimeoutMs;
	return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}

function resolveTurnBudget(params: SubagentParamsLike): { turnBudget?: ResolvedTurnBudget; error?: string } {
	const raw = params.turnBudget;
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { error: "turnBudget must be an object with maxTurns and optional graceTurns." };
	if (typeof raw.maxTurns !== "number" || !Number.isInteger(raw.maxTurns) || raw.maxTurns < 1) {
		return { error: "turnBudget.maxTurns must be an integer >= 1." };
	}
	const graceTurns = raw.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS;
	if (typeof graceTurns !== "number" || !Number.isInteger(graceTurns) || graceTurns < 0) {
		return { error: "turnBudget.graceTurns must be an integer >= 0." };
	}
	return { turnBudget: { maxTurns: raw.maxTurns, graceTurns } };
}

function resolveToolBudget(raw: unknown, label = "toolBudget"): { toolBudget?: ResolvedToolBudget; error?: string } {
	const resolved = validateToolBudgetConfig(raw, label);
	return { toolBudget: resolved.budget, error: resolved.error };
}

function resolveEffectiveToolBudget(input: {
	stepBudget?: ToolBudgetConfig;
	runBudget?: ResolvedToolBudget;
	agentBudget?: ToolBudgetConfig;
}): { toolBudget?: ResolvedToolBudget; error?: string } {
	if (input.stepBudget !== undefined) return resolveToolBudget(input.stepBudget, "toolBudget");
	if (input.runBudget !== undefined) return { toolBudget: input.runBudget };
	return resolveToolBudget(input.agentBudget, "agent.toolBudget");
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const concreteTask = { ...task };
		delete concreteTask.count;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const concreteTask = { ...task };
			delete concreteTask.count;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

function normalizeRepeatedParallelCounts(params: SubagentParamsLike): {
	params?: SubagentParamsLike;
	error?: SubagentToolResult<Details>;
} {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

function withForkContext(
	result: SubagentToolResult<Details>,
	context: SubagentParamsLike["context"],
): SubagentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): SubagentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function preflightForkSessionsForStaticTasks(
	params: SubagentParamsLike,
	contextPolicy: AgentDefaultContextPolicy,
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined,
): void {
	if (!contextPolicy.usesFork) return;
	if (params.agent) {
		if (shouldForkAgent(contextPolicy, params.agent)) sessionFileForTask(params.agent, 0);
		return;
	}
	if (params.tasks) {
		params.tasks.forEach((task, index) => {
			if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, index);
		});
		return;
	}
	if (!params.chain?.length) return;
	let flatIndex = 0;
	for (const step of params.chain) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) {
				if (shouldForkAgent(contextPolicy, task.agent)) sessionFileForTask(task.agent, flatIndex);
				flatIndex++;
			}
			continue;
		}
		const sequential = step as SequentialStep;
		if (shouldForkAgent(contextPolicy, sequential.agent)) sessionFileForTask(sequential.agent, flatIndex);
		flatIndex++;
	}
}

function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): SubagentToolResult<Details> | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForTask,
		thinkingOverrideForTask,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
		nestedRoute,
		contextPolicy,
	} = data;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasTasks && Boolean(params.agent);
	if (!effectiveAsync) return null;

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [
				{
					type: "text",
					text: "Async mode requires the detached runner module, but it could not be found. Ensure the generated TLH runtime files are installed.",
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
		currentModelProvider: ctx.model?.provider,
		currentModel: ctx.model,
		modelScope: data.modelScope,
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active
		? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index)
		: undefined;

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveSubagentModelOverride(
				task.model ?? agentConfigs[index]?.model,
				ctx.model,
				availableModels,
				currentProvider,
				{ scope: data.modelScope, source: task.model ? "explicit" : "inherited" },
			),
		);
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: shouldForkAgent(contextPolicy, task.agent) ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(task.fallbackModels ? { fallbackModels: task.fallbackModels } : {}),
			...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
			...(task.output === true
				? agentConfigs[index]?.output
					? { output: agentConfigs[index]!.output }
					: {}
				: task.output !== undefined
					? { output: task.output }
					: {}),
			...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
			...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
			...(task.progress !== undefined ? { progress: task.progress } : {}),
			...(task.toolBudget !== undefined ? { toolBudget: task.toolBudget } : {}),
			...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}),
		}));
		return executeAsyncChain(id, {
			chain: [
				{
					parallel: parallelTasks,
					concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				},
			],
			resultMode: "parallel",
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFilesByFlatIndex: params.tasks.map((task, index) => sessionFileForTask(task.agent, index)),
			thinkingOverridesByFlatIndex: params.tasks.map((task, index) => thinkingOverrideForTask(task.agent, index)),
			maxSubagentDepth: currentMaxSubagentDepth,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
			nestedRoute,
			timeoutMs: data.timeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
		const effectiveOutputMode = params.outputMode ?? "inline";
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const effectiveTimeoutMs = resolveEffectiveSingleTimeout(data.timeoutMs, a.maxExecutionTimeMs);
		const modelOverride = resolveSubagentModelOverride(
			(params.model as string | undefined) ?? a.model,
			ctx.model,
			availableModels,
			currentProvider,
			{ scope: data.modelScope, source: (params.model as string | undefined) ? "explicit" : "inherited" },
		);
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: shouldForkAgent(contextPolicy, params.agent!) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForTask(params.agent!, 0),
			skills,
			output: effectiveOutput,
			outputMode: effectiveOutputMode,
			outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, id),
			modelOverride,
			fallbackModels: params.fallbackModels,
			modelFallbackNotice: params.modelFallbackNotice,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0),
			maxSubagentDepth,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
			nestedRoute,
			acceptance: params.acceptance,
			timeoutMs: effectiveTimeoutMs,
			turnBudget: data.turnBudget,
			toolBudget: data.toolBudget,
		});
	}

	return null;
}

function buildParallelModeError(message: string): SubagentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	state: SubagentState;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
	thinkingOverrideForTask: (agentName: string, idx?: number) => AgentConfig["thinking"] | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	outputBaseDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	progressDir: string;
	availableModels: ModelInfo[];
	modelScope?: ModelScopeConfig;
	modelOverrides: (string | undefined)[];
	behaviors: ResolvedStepBehavior[];
	firstProgressIndex: number;
	controlConfig: ResolvedControlConfig;
	onControlEvent: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	globalSemaphore: Semaphore;
	maxSubagentDepths: number[];
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: SubagentToolResult<Details>) => void;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudgets: (ResolvedToolBudget | undefined)[];
	tkTicket?: TkTicketMetadata;
	tkTicketIndex?: number;
}

function resolveSingleRunOutputBaseDir(artifactsDir: string, runId: string): string {
	return path.join(artifactsDir, "outputs", runId);
}

function resolveParallelTaskCwd(task: TaskParam, paramsCwd: string): string {
	return resolveChildCwd(paramsCwd, task.cwd);
}

function findDuplicateParallelOutputPath(input: {
	tasks: TaskParam[];
	behaviors: ResolvedStepBehavior[];
	paramsCwd: string;
	ctxCwd: string;
	outputBaseDir: string;
}): string | undefined {
	const seen = new Map<string, { index: number; agent: string }>();
	for (let index = 0; index < input.tasks.length; index++) {
		const behavior = input.behaviors[index];
		if (!behavior?.output) continue;
		const task = input.tasks[index]!;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
		const outputPath = resolveSingleOutputPath(behavior.output, input.ctxCwd, taskCwd, input.outputBaseDir);
		if (!outputPath) continue;
		const previous = seen.get(outputPath);
		if (previous) {
			return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
		}
		seen.set(outputPath, { index, agent: task.agent });
	}
	return undefined;
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	let interrupted = false;
	let supervisorPauseIndex: number | undefined;
	const interruptControllers = new Map<number, AbortController>();
	const startedIndexes = new Set<number>();
	const writeParallelPauseCheckpoint = (
		requesterIndex: number,
		requester: SingleResult,
		ownerPid: number | undefined,
		options: { rootStage: "pausing" | "paused"; requesterStatus?: "pausing" | "paused" },
	) => {
		const now = Date.now();
		const steps = input.tasks.map((task, index) => {
			const liveResult = input.liveResults[index];
			const liveProgress = input.liveProgress[index];
			const result = liveResult ?? (index === requesterIndex ? requester : undefined);
			if (index === requesterIndex && result) {
				return buildPausedStepFromResult(result, now, {
					stage: options.rootStage,
					ownerPid,
					...(options.requesterStatus ? { status: options.requesterStatus } : {}),
				});
			}
			if (
				result &&
				options.rootStage === "paused" &&
				isTerminalForegroundResultSnapshot(result, liveProgress ?? result.progress)
			) {
				return buildPausedStepFromResult(result, now, { stage: "paused" });
			}
			if (liveResult && isTerminalForegroundResultSnapshot(liveResult, liveProgress)) {
				return buildPausedStepFromResult(liveResult, now, { stage: "paused" });
			}
			if (startedIndexes.has(index) || interruptControllers.has(index) || liveProgress?.status === "running") {
				return buildCohortPauseStep({
					agent: task.agent,
					sessionFile: input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
					status: options.rootStage === "paused" ? "paused" : "pausing",
					now,
					model: result?.model ?? task.model,
					thinking: result?.thinking,
					modelIdentity: result?.modelIdentity,
					modelResolution: result?.modelResolution,
					contextUsage: result?.contextUsage,
				});
			}
			return buildCohortPauseStep({
				agent: task.agent,
				sessionFile: input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
				status: "pending",
				now,
				model: result?.model ?? task.model,
				thinking: result?.thinking,
				modelIdentity: result?.modelIdentity,
				modelResolution: result?.modelResolution,
				contextUsage: result?.contextUsage,
			});
		});
		persistPausedForegroundCohortRun({
			runId: input.runId,
			cwd: input.paramsCwd,
			sessionId: input.state.currentSessionId,
			mode: "parallel",
			stage: options.rootStage,
			ownerPid,
			startedAt: input.foregroundControl?.startedAt,
			pause: requester.pause,
			steps,
		});
	};
	const requestCohortPause = (requesterIndex: number, requester: SingleResult, ownerPid: number | undefined) => {
		if (supervisorPauseIndex !== undefined) return;
		writeParallelPauseCheckpoint(requesterIndex, requester, ownerPid, {
			rootStage: "pausing",
			requesterStatus: "pausing",
		});
		supervisorPauseIndex = requesterIndex;
		interrupted = true;
		for (const [index, controller] of interruptControllers.entries()) {
			if (index === requesterIndex || controller.signal.aborted) continue;
			controller.abort();
		}
	};
	// Pre-warm fork session files sequentially before concurrent dispatch to avoid
	// races where multiple workers simultaneously try to branch the same parent session.
	// sessionFileForIndex caches results, so these calls return instantly inside mapConcurrent.
	for (let i = 0; i < input.tasks.length; i++) {
		input.sessionFileForIndex(i);
	}
	return mapConcurrent(
		input.tasks,
		input.concurrencyLimit,
		async (task, index) => {
			if (interrupted) {
				return {
					agent: task.agent,
					task: input.taskTexts[index]!,
					exitCode: 0,
					interrupted: true,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "Interrupted before starting queued task.",
				} as SingleResult;
			}
			const behavior = input.behaviors[index];
			const effectiveSkills = behavior?.skills;
			const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
			const readInstructions = behavior
				? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
				: { prefix: "", suffix: "" };
			const progressInstructions = behavior
				? buildChainInstructions(
						{ ...behavior, output: false, reads: false },
						input.progressDir,
						index === input.firstProgressIndex,
					)
				: { prefix: "", suffix: "" };
			const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd, input.outputBaseDir);
			const taskText = injectSingleOutputInstruction(
				`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
				outputPath,
			);
			const interruptController = new AbortController();
			interruptControllers.set(index, interruptController);
			startedIndexes.add(index);
			const steerInboxDir = input.foregroundControl
				? registerForegroundMessageInbox(input.foregroundControl, input.runId, index)
				: undefined;
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = index;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				registerForegroundInterrupt(input.foregroundControl, index, () => {
					interrupted = true;
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				});
			}
			const agentConfig = input.agents.find((agent) => agent.name === task.agent);
			return runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
				onSupervisorPauseTransition: (transition) => {
					const { stage, result } = transition;
					if (result.pause?.kind !== "awaiting_supervisor") return;
					if (stage === "pausing") {
						requestCohortPause(index, result, transition.ownerPid);
						return;
					}
					input.liveResults[index] = result;
					writeParallelPauseCheckpoint(index, result, undefined, { rootStage: "pausing", requesterStatus: "paused" });
				},
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				pauseBlockingSupervisor: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index,
				sessionDir: input.sessionDirForIndex(index),
				sessionFile: input.sessionFileForTask(task.agent, index),
				share: input.shareEnabled,
				artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
				artifactConfig: input.artifactConfig,
				maxOutput: input.maxOutput,
				outputPath,
				outputMode: behavior?.outputMode,
				maxSubagentDepth: input.maxSubagentDepths[index],
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				onDetachedExit: (result) =>
					updateRememberedForegroundChild(input.state, {
						runId: input.runId,
						mode: "parallel",
						cwd: taskCwd,
						index,
						result,
					}),
				intercomSessionName: input.childIntercomTarget?.(task.agent, index),
				orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				steerInboxDir,
				nestedRoute: input.foregroundControl?.nestedRoute,
				modelOverride: input.modelOverrides[index],
				fallbackModels: behavior?.fallbackModels,
				modelFallbackNotice: behavior?.modelFallbackNotice,
				thinkingOverride: input.thinkingOverrideForTask(task.agent, index),
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				modelScope: input.modelScope,
				...(input.tkTicket && input.tkTicketIndex === index ? { tkTicket: input.tkTicket } : {}),
				skills: effectiveSkills === false ? [] : effectiveSkills,
				acceptance: task.acceptance,
				acceptanceContext: { mode: "parallel" },
				timeoutMs: input.timeoutMs,
				deadlineAt: input.deadlineAt,
				turnBudget: input.turnBudget,
				toolBudget: input.toolBudgets[index],
				onUpdate: input.onUpdate
					? (progressUpdate) => {
							const stepResults = progressUpdate.details?.results || [];
							const stepProgress = progressUpdate.details?.progress || [];
							if (input.foregroundControl && stepProgress.length > 0) {
								const current = stepProgress[0];
								input.foregroundControl.currentAgent = task.agent;
								input.foregroundControl.currentIndex = index;
								input.foregroundControl.currentActivityState = current?.activityState;
								input.foregroundControl.lastActivityAt = current?.lastActivityAt;
								input.foregroundControl.currentTool = current?.currentTool;
								input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
								input.foregroundControl.currentPath = current?.currentPath;
								input.foregroundControl.turnCount = current?.turnCount;
								input.foregroundControl.tokens = current?.tokens;
								input.foregroundControl.toolCount = current?.toolCount;
								input.foregroundControl.updatedAt = Date.now();
							}
							if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
							if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
							const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
							const mergedProgress = input.liveProgress.filter(
								(progress): progress is AgentProgress => progress !== undefined,
							);
							input.onUpdate?.({
								content: progressUpdate.content,
								details: {
									mode: "parallel",
									results: mergedResults,
									progress: mergedProgress,
									controlEvents: progressUpdate.details?.controlEvents,
									totalSteps: input.tasks.length,
								},
							});
						}
					: undefined,
			})
				.then((result) => {
					input.liveResults[index] = result;
					startedIndexes.delete(index);
					if (
						supervisorPauseIndex !== undefined &&
						index !== supervisorPauseIndex &&
						result.interrupted &&
						!result.pause &&
						result.sessionFile
					) {
						result.pause = {
							kind: "cohort_pause",
							requestedAt: Date.now(),
							pausedAt: Date.now(),
							summary: "Paused because another child is awaiting supervisor.",
						};
						result.error = undefined;
						result.finalOutput = "Paused because another child in this cohort is awaiting supervisor.";
					}
					return result;
				})
				.finally(() => {
					startedIndexes.delete(index);
					interruptControllers.delete(index);
					if (input.foregroundControl) {
						clearForegroundInterrupt(input.foregroundControl, index);
						clearForegroundMessageInbox(input.foregroundControl, index);
						input.foregroundControl.updatedAt = Date.now();
					}
				});
		},
		input.globalSemaphore,
	);
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const tkTicketContext = resolveTkTicketTaskContext({ runnerCwd: effectiveCwd, tasks });
	const tkTicket = tkTicketContext
		? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
		: undefined;
	const tkTicketIndex = tkTicketContext?.taskIndex;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);
	const toolBudgets: (ResolvedToolBudget | undefined)[] = [];
	for (let index = 0; index < tasks.length; index++) {
		const resolved = resolveEffectiveToolBudget({
			stepBudget: tasks[index]?.toolBudget,
			runBudget: data.toolBudget,
			agentBudget: agentConfigs[index]?.toolBudget,
		});
		if (resolved.error) return buildParallelModeError(resolved.error);
		toolBudgets.push(resolved.toolBudget);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const taskTexts = tasks.map((t) => t.task);
	const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
		...(task.output !== undefined
			? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
			: {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(task.model ? { model: task.model } : {}),
		...(task.fallbackModels ? { fallbackModels: task.fallbackModels } : {}),
		...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
	}));
	const modelOverrides: (string | undefined)[] = tasks.map((_, i) =>
		resolveSubagentModelOverride(
			behaviorOverrides[i]?.model ?? agentConfigs[i]?.model,
			ctx.model,
			availableModels,
			currentProvider,
			{ scope: data.modelScope, source: behaviorOverrides[i]?.model ? "explicit" : "inherited" },
		),
	);

	const behaviors = agentConfigs.map((config, index) =>
		suppressProgressForReadOnlyTask(resolveStepBehavior(config, behaviorOverrides[index]!), taskTexts[index]),
	);
	const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);

	const outputBaseDir = path.join(artifactsDir, "outputs", runId);
	const duplicateOutputError = findDuplicateParallelOutputPath({
		tasks,
		behaviors,
		paramsCwd: effectiveCwd,
		ctxCwd: ctx.cwd,
		outputBaseDir,
	});
	if (duplicateOutputError) return buildParallelModeError(duplicateOutputError);
	for (let index = 0; index < tasks.length; index++) {
		const taskCwd = resolveParallelTaskCwd(tasks[index]!, effectiveCwd);
		const outputPath = resolveSingleOutputPath(behaviors[index]?.output, ctx.cwd, taskCwd, outputBaseDir);
		const validationError = validateFileOnlyOutputMode(
			behaviors[index]?.outputMode,
			outputPath,
			`Parallel task ${index + 1} (${tasks[index]!.agent})`,
		);
		if (validationError) return buildParallelModeError(validationError);
	}

	const parallelProgressPrecreated = firstProgressIndex !== -1;
	const parallelProgressDir = path.join(artifactsDir, "progress", runId);
	if (parallelProgressPrecreated) writeInitialProgressFile(parallelProgressDir);

	for (let i = 0; i < taskTexts.length; i++) {
		if (shouldForkAgent(contextPolicy, tasks[i]!.agent)) taskTexts[i] = wrapForkTask(taskTexts[i]!);
	}

	const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
	const results = await runForegroundParallelTasks({
		tasks,
		taskTexts,
		agents,
		ctx,
		state: deps.state,
		intercomEvents: deps.pi.events,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		outputBaseDir,
		maxOutput: params.maxOutput,
		paramsCwd: effectiveCwd,
		progressDir: parallelProgressDir,
		availableModels,
		modelScope: data.modelScope,
		modelOverrides,
		behaviors,
		firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
		controlConfig,
		onControlEvent,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		foregroundControl,
		concurrencyLimit: parallelConcurrency,
		globalSemaphore: new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
		maxSubagentDepths,
		liveResults,
		liveProgress,
		onUpdate,
		timeoutMs: data.timeoutMs,
		deadlineAt,
		turnBudget: data.turnBudget,
		toolBudgets,
		...(tkTicket ? { tkTicket } : {}),
		...(tkTicketIndex !== undefined && tkTicketIndex >= 0 ? { tkTicketIndex } : {}),
	});
	for (const result of results) {
		if (result.progress) allProgress.push(result.progress);
		if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
	}

	if (foregroundControl) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, results, foregroundControl.nestedChildren);
	}
	const interrupted = results.find((result) => result.interrupted);
	const details = compactForegroundDetails({
		mode: "parallel",
		runId,
		results,
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		totalChildUsage: sumResultsUsage(results),
		totalCost: sumResultsCost(results),
	});
	rememberForegroundRun(deps.state, { runId, mode: "parallel", cwd: effectiveCwd, results: details.results });
	if (results.some((result) => result.pause)) {
		persistPausedForegroundCohortRun({
			runId,
			cwd: effectiveCwd,
			sessionId: deps.state.currentSessionId,
			mode: "parallel",
			stage: "paused",
			results: details.results,
			startedAt: foregroundControl?.startedAt,
		});
	}
	if (interrupted) {
		const interruptedIndex = results.findIndex((result) => result === interrupted);
		const pausedChildren = results.filter((result) => result.interrupted).length;
		const text =
			interrupted.pause?.kind === "awaiting_supervisor"
				? formatForegroundSupervisorPauseMessage({
						headline: `Foreground parallel run ${runId} paused awaiting supervisor (${interrupted.agent}).`,
						runId,
						agent: interrupted.agent,
						requestSummary: interrupted.pause.summary,
						index: interruptedIndex >= 0 ? interruptedIndex : 0,
					})
				: formatForegroundPauseMessage({
						headline: `Foreground parallel run ${runId} paused after interrupt (${interrupted.agent}).`,
						runId,
						resume: {
							kind: "indexed",
							index: interruptedIndex >= 0 ? interruptedIndex : 0,
							...(pausedChildren > 1 ? { example: true } : {}),
						},
						redispatch: "subagent({ tasks: [...] })",
					});
		return {
			content: [{ type: "text", text }],
			details,
		};
	}
	const detachedIndex = results.findIndex((result) => result.detached);
	const detached = detachedIndex >= 0 ? results[detachedIndex] : undefined;
	if (detached) {
		return {
			content: [
				{
					type: "text",
					text:
						detached.pause?.kind === "awaiting_supervisor"
							? formatForegroundSupervisorPauseMessage({
									headline: `Foreground parallel run ${runId} paused awaiting supervisor (${detached.agent}).`,
									runId,
									agent: detached.agent,
									requestSummary: detached.pause.summary,
									index: detachedIndex,
								})
							: `Legacy detached parallel child (${detached.agent}). Inspect status/artifacts, then resume or replace work explicitly if needed.`,
				},
			],
			details,
		};
	}

	if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
	const nativeResult = buildForegroundNativeResult({
		runId,
		mode: "parallel",
		details,
		...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
	});
	if (nativeResult) {
		return {
			content: [{ type: "text", text: nativeResult.text }],
			details: nativeResult.details,
		};
	}

	const ok = results.filter((result) => result.exitCode === 0).length;
	const aggregatedOutput = aggregateParallelOutputs(
		results.map((result) => ({
			agent: result.agent,
			output: result.truncation?.text || getSingleResultOutput(result),
			exitCode: result.exitCode,
			error: result.error,
			timedOut: result.timedOut,
			modelFallbackNotice: result.modelFallbackNotice,
		})),
		(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
	);

	const summary = `${ok}/${results.length} succeeded`;
	return {
		content: [{ type: "text", text: `${summary}\n\n${aggregatedOutput}` }],
		details,
	};
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<SubagentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForTask,
		thinkingOverrideForTask,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		controlConfig,
		contextPolicy,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active
		? resolveSubagentIntercomTarget(runId, params.agent!, 0)
		: undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const effectiveToolBudget = resolveEffectiveToolBudget({
		runBudget: data.toolBudget,
		agentBudget: agentConfig.toolBudget,
	});
	if (effectiveToolBudget.error) return toExecutionErrorResult(params, new Error(effectiveToolBudget.error));

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	let task = params.task ?? "";
	const tkTicket = resolveTkTicketMetadata(params.task, { cwd: effectiveCwd });
	const modelOverride: string | undefined = resolveSubagentModelOverride(
		(params.model as string | undefined) ?? agentConfig.model,
		ctx.model,
		availableModels,
		currentProvider,
		{ scope: data.modelScope, source: (params.model as string | undefined) ? "explicit" : "inherited" },
	);
	const skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const fallbackModels = params.fallbackModels;
	const modelFallbackNotice = params.modelFallbackNotice;
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	const effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);
	const effectiveTimeoutMs = resolveEffectiveSingleTimeout(data.timeoutMs, agentConfig.maxExecutionTimeMs);

	if (shouldForkAgent(contextPolicy, params.agent!)) {
		task = wrapForkTask(task);
	}
	const outputPath = resolveSingleOutputPath(
		effectiveOutput,
		ctx.cwd,
		effectiveCwd,
		resolveSingleRunOutputBaseDir(artifactsDir, runId),
	);
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return {
			content: [{ type: "text", text: validationError }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const steerInboxDir = foregroundControl ? registerForegroundMessageInbox(foregroundControl, runId, 0) : undefined;
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
		registerForegroundInterrupt(foregroundControl, 0, () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		});
	}

	const forwardSingleUpdate = onUpdate
		? (update: SubagentToolResult<Details>) => {
				if (foregroundControl) {
					const firstProgress = update.details?.progress?.[0];
					foregroundControl.currentAgent = params.agent;
					foregroundControl.currentIndex = firstProgress?.index ?? 0;
					foregroundControl.currentActivityState = firstProgress?.activityState;
					foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
					foregroundControl.currentTool = firstProgress?.currentTool;
					foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
					foregroundControl.currentPath = firstProgress?.currentPath;
					foregroundControl.turnCount = firstProgress?.turnCount;
					foregroundControl.tokens = firstProgress?.tokens;
					foregroundControl.toolCount = firstProgress?.toolCount;
					foregroundControl.updatedAt = Date.now();
				}
				onUpdate(update);
			}
		: undefined;

	const deadlineAt =
		data.deadlineAt ?? (effectiveTimeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined);
	let r: SingleResult;
	try {
		r = await runSync(ctx.cwd, agents, params.agent!, task, {
			parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
			cwd: effectiveCwd,
			signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			pauseBlockingSupervisor: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: deps.pi.events,
			runId,
			sessionDir: sessionDirForIndex(0),
			sessionFile: sessionFileForTask(params.agent!, 0),
			share: shareEnabled,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			maxOutput: params.maxOutput,
			outputPath,
			outputMode: effectiveOutputMode,
			maxSubagentDepth,
			onUpdate: forwardSingleUpdate,
			controlConfig,
			onControlEvent,
			intercomSessionName: childIntercomTarget,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			steerInboxDir,
			nestedRoute: foregroundControl?.nestedRoute,
			onSupervisorPauseTransition: (transition) => {
				const { stage, result } = transition;
				try {
					persistPausedForegroundSingleRun({
						runId,
						cwd: effectiveCwd,
						sessionId: deps.state.currentSessionId,
						stage,
						ownerPid: stage === "pausing" ? transition.ownerPid : undefined,
						result,
					});
				} catch (error) {
					if (stage === "paused") recoverFailedPausedForegroundTransition({ runId, error });
					throw error;
				}
				if (stage === "paused")
					updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, index: 0, result });
			},
			index: 0,
			modelOverride,
			fallbackModels,
			modelFallbackNotice,
			thinkingOverride: thinkingOverrideForTask(params.agent!, 0),
			availableModels,
			preferredModelProvider: currentProvider,
			modelScope: data.modelScope,
			...(tkTicket ? { tkTicket } : {}),
			skills: effectiveSkills,
			acceptance: params.acceptance,
			acceptanceContext: { mode: "single" },
			onDetachedExit: (result) =>
				updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: effectiveCwd, index: 0, result }),
			timeoutMs: effectiveTimeoutMs,
			deadlineAt,
			turnBudget: data.turnBudget,
			toolBudget: effectiveToolBudget.toolBudget,
		});
	} finally {
		if (foregroundControl) clearForegroundMessageInbox(foregroundControl, 0);
	}
	if (foregroundControl) {
		clearForegroundInterrupt(foregroundControl, 0);
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	if (foregroundControl) {
		updateForegroundNestedProjection(foregroundControl);
		attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
	}
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		...(data.turnBudget ? { turnBudget: data.turnBudget } : {}),
		...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
		totalChildUsage: sumResultsUsage([r]),
		totalCost: sumResultsCost([r]),
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, results: details.results });
	if (r.pause?.kind === "awaiting_supervisor") enrichPersistedPausedForegroundSingleRun({ runId, result: r });

	if (!r.detached && !r.interrupted) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const nativeResult = buildForegroundNativeResult({
			runId,
			mode: "single",
			details,
			displayOutputs: [finalizedOutput.displayOutput],
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (nativeResult) {
			return {
				content: [{ type: "text", text: nativeResult.text }],
				details: nativeResult.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [
				{
					type: "text",
					text:
						r.pause?.kind === "awaiting_supervisor"
							? formatForegroundSupervisorPauseMessage({
									headline: `Foreground run ${runId} paused awaiting supervisor (${params.agent}).`,
									runId,
									agent: params.agent!,
									requestSummary: r.pause.summary,
								})
							: `Legacy detached result: ${params.agent}. Inspect status/artifacts, then resume or replace work explicitly if needed.`,
				},
			],
			details,
		};
	}

	if (r.pause?.kind === "awaiting_supervisor") {
		return {
			content: [
				{
					type: "text",
					text: formatForegroundSupervisorPauseMessage({
						headline: `Foreground run ${runId} paused awaiting supervisor (${params.agent}).`,
						runId,
						agent: params.agent!,
						requestSummary: r.pause.summary,
					}),
				},
			],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [
				{
					type: "text",
					text: formatForegroundPauseMessage({
						headline: `Foreground run ${runId} paused after interrupt (${params.agent}).`,
						runId,
						resume: { kind: "single" },
						redispatch: `subagent({ agent: "${params.agent}", task: "..." })`,
					}),
				},
			],
			details,
		};
	}

	const noticePrefix = r.modelFallbackNotice ? `Notice: ${r.modelFallbackNotice}\n\n` : "";
	if (r.exitCode !== 0)
		return {
			content: [
				{ type: "text", text: `${noticePrefix}${formatFailedSingleRunOutput(r, finalizedOutput.displayOutput)}` },
			],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: `${noticePrefix}${finalizedOutput.displayOutput || "(no output)"}` }],
		details,
	};
}

function inferExecutionMode(params: SubagentParamsLike): SubagentRunMode {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function duplicateSubagentCallResult(params: SubagentParamsLike): SubagentToolResult<Details> {
	return {
		content: [
			{
				type: "text",
				text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
			},
		],
		isError: true,
		details: { mode: inferExecutionMode(params), results: [] },
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<SubagentToolResult<Details>>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestParams = params;
		const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
		const paramsWithResolvedCwd =
			requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
		const unsupportedSavedChainDetail = unsupportedSavedChainInput(paramsWithResolvedCwd);
		if (unsupportedSavedChainDetail)
			return unsupportedSavedChainInputResult(paramsWithResolvedCwd, unsupportedSavedChainDetail);
		const action = paramsWithResolvedCwd.action;
		if (action) {
			if (action === "doctor") {
				let currentSessionFile: string | null = null;
				let currentSessionId = deps.state.currentSessionId;
				let sessionError: string | undefined;
				try {
					currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
					currentSessionId = ctx.sessionManager.getSessionId();
				} catch (error) {
					sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				let orchestratorTarget: string | undefined;
				try {
					orchestratorTarget = resolveIntercomSessionTarget(
						deps.pi.getSessionName(),
						ctx.sessionManager.getSessionId(),
					);
				} catch (error) {
					if (!sessionError) sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				}
				return {
					content: [
						{
							type: "text",
							text: buildDoctorReport({
								cwd: requestCwd,
								config: deps.config,
								state: deps.state,
								context: paramsWithResolvedCwd.context,
								requestedSessionDir: paramsWithResolvedCwd.sessionDir,
								currentSessionFile,
								currentSessionId,
								orchestratorTarget,
								sessionError,
								expandTilde: deps.expandTilde,
							}),
						},
					],
					details: { mode: "management", results: [] },
				};
			}
			if (action === "status") {
				const targetRunId = paramsWithResolvedCwd.id;
				const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
				if (paramsWithResolvedCwd.view === "fleet") {
					return inspectSubagentStatus(buildRunStatusParams(paramsWithResolvedCwd), {
						state: deps.state,
						sessionRoots,
					});
				}
				if (targetRunId) {
					try {
						const resolved = resolveSubagentRunId(targetRunId, { state: deps.state });
						if (resolved?.kind === "foreground") {
							const foreground = getForegroundControl(deps.state, resolved.id);
							if (foreground) {
								if (paramsWithResolvedCwd.view === "transcript") {
									return {
										content: [
											{
												type: "text",
												text: "Live foreground transcript is already visible in the expanded running subagent result. Persisted session transcript becomes inspectable after the foreground run completes when sessions are enabled.",
											},
										],
										details: { mode: "management", results: [] },
									};
								}
								return foregroundStatusResult(foreground);
							}
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text", text: message }],
							isError: true,
							details: { mode: "management", results: [] },
						};
					}
				} else {
					const foreground = getForegroundControl(deps.state, undefined);
					if (foreground && paramsWithResolvedCwd.view !== "transcript") return foregroundStatusResult(foreground);
					if (foreground && paramsWithResolvedCwd.view === "transcript") {
						return {
							content: [
								{
									type: "text",
									text: "Live foreground transcript is already visible in the expanded running subagent result. Pass an async run id to inspect a background transcript.",
								},
							],
							details: { mode: "management", results: [] },
						};
					}
				}
				return inspectSubagentStatus(buildRunStatusParams(paramsWithResolvedCwd), { state: deps.state, sessionRoots });
			}
			if (action === "resume") {
				return resumeAsyncRun({ params: paramsWithResolvedCwd, requestCwd, ctx, deps });
			}
			if (action === "steer") {
				deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
				const message = (paramsWithResolvedCwd.message ?? paramsWithResolvedCwd.task ?? "").trim();
				if (!message)
					return {
						content: [{ type: "text", text: "action='steer' requires message." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				const targetRunId = paramsWithResolvedCwd.id;
				if (paramsWithResolvedCwd.dir) {
					try {
						const location = resolveAsyncRunLocation(paramsWithResolvedCwd, ASYNC_DIR, RESULTS_DIR);
						const runId =
							location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir);
						return steerAsyncRun({
							state: deps.state,
							runId,
							message,
							index: paramsWithResolvedCwd.index,
							kill: deps.kill,
							location,
						});
					} catch (error) {
						const text = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
					}
				}
				if (!targetRunId)
					return {
						content: [{ type: "text", text: "action='steer' requires id or dir." }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				let resolved: ResolvedSubagentRunId | undefined;
				try {
					resolved = resolveSubagentRunId(targetRunId, { state: deps.state });
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
				}
				if (resolved?.kind === "nested")
					return steerNestedRun({ target: resolved, message, index: paramsWithResolvedCwd.index });
				if (resolved?.kind === "foreground")
					return {
						content: [
							{
								type: "text",
								text: "action='steer' currently supports live async Pi child sessions only; use action='interrupt' or action='resume' for foreground runs.",
							},
						],
						isError: true,
						details: { mode: "management", results: [] },
					};
				if (resolved?.kind !== "async")
					return {
						content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				return steerAsyncRun({
					state: deps.state,
					runId: resolved.id,
					message,
					index: paramsWithResolvedCwd.index,
					kill: deps.kill,
					location: resolved.location,
				});
			}
			if (action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.id;
				const rememberedPaused = resolveRememberedForegroundRun(paramsWithResolvedCwd, deps.state);
				if (
					rememberedPaused?.child.status === "paused" &&
					rememberedPaused.child.pause &&
					!getForegroundControl(deps.state, rememberedPaused.run.runId)
				) {
					const pausedAsyncDir = pausedForegroundStatusPath(rememberedPaused.run.runId);
					if (fs.existsSync(pausedAsyncDir))
						return cancelPersistedPausedForegroundRun(
							deps.state,
							pausedAsyncDir,
							rememberedPaused.run.runId,
							rememberedPaused.index,
						);
				}
				let resolved: ResolvedSubagentRunId | undefined;
				if (targetRunId) {
					try {
						resolved = resolveSubagentRunId(targetRunId, { state: deps.state });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text", text: message }],
							isError: true,
							details: { mode: "management", results: [] },
						};
					}
				}
				if (resolved?.kind === "nested") return interruptNestedRun(resolved);
				const foreground = getForegroundControl(
					deps.state,
					resolved?.kind === "foreground" ? resolved.id : targetRunId,
				);
				if (foreground) {
					if (requestForegroundInterrupt(foreground)) {
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [
							{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` },
						],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				if (resolved?.kind === "foreground") {
					const pausedAsyncDir = pausedForegroundStatusPath(resolved.id);
					const persistedStatus = readStatus(pausedAsyncDir);
					if (
						persistedStatus?.state === "paused" ||
						persistedStatus?.state === "continued" ||
						persistedStatus?.state === "cancelled"
					) {
						return cancelPersistedPausedForegroundRun(
							deps.state,
							pausedAsyncDir,
							resolved.id,
							paramsWithResolvedCwd.index,
						);
					}
				}
				if (resolved?.kind === "async" && resolved.location.asyncDir) {
					const persistedStatus = readStatus(resolved.location.asyncDir);
					if (
						persistedStatus?.state === "paused" ||
						persistedStatus?.state === "continued" ||
						persistedStatus?.state === "cancelled"
					) {
						return cancelPersistedPausedForegroundRun(
							deps.state,
							resolved.location.asyncDir,
							resolved.id,
							paramsWithResolvedCwd.index,
						);
					}
				}
				const asyncInterruptResult = interruptAsyncRun(
					deps.state,
					resolved?.kind === "async" ? resolved.id : targetRunId,
					deps.kill,
					resolved?.kind === "async" ? resolved.location : undefined,
				);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(action, buildManagementActionParams(paramsWithResolvedCwd), {
				...ctx,
				cwd: requestCwd,
				config: deps.config,
			});
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		let effectiveParams = normalizedParams;
		const foregroundTimeout = resolveForegroundTimeout(effectiveParams);
		if (foregroundTimeout.error) return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
		const turnBudget = resolveTurnBudget(effectiveParams);
		if (turnBudget.error) return buildRequestedModeError(effectiveParams, turnBudget.error);
		const runToolBudget = resolveToolBudget(effectiveParams.toolBudget, "toolBudget");
		if (runToolBudget.error) return buildRequestedModeError(effectiveParams, runToolBudget.error);
		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
		const discovered = deps.discoverAgents(effectiveCwd, scope);
		const discoveredAgents = discovered.agents;
		const modelScope = discovered.modelScope;
		const contextPolicy = resolveAgentDefaultContextPolicy(effectiveParams, discoveredAgents);
		effectiveParams = contextPolicy.params;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context,
			orchestratorTarget: sessionName,
		});
		const agents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const runId = randomUUID().slice(0, 8);
		const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
		const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
		const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
		const shareEnabled = effectiveParams.share === true;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = !hasTasks && Boolean(effectiveParams.agent);

		const validationError = validateExecutionInput(effectiveParams, agents, hasTasks, hasSingle);
		if (validationError) return validationError;

		let forkSessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		let forkThinkingOverrideForIndex: (idx?: number) => AgentConfig["thinking"] | undefined = () => undefined;
		try {
			const forkContextResolver = createForkContextResolver(
				ctx.sessionManager,
				contextPolicy.usesFork ? "fork" : undefined,
			);
			forkSessionFileForIndex = forkContextResolver.sessionFileForIndex;
			forkThinkingOverrideForIndex = forkContextResolver.thinkingOverrideForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error);
		}
		const requestedAsync = effectiveParams.async ?? false;
		const effectiveAsync = requestedAsync;
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
		};
		const artifactsDir = getArtifactsDir(parentSessionFile);

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
			);
		}
		const sessionDirForIndex = (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`);
		const forkSessionFileForTask = (agentName: string, idx?: number) =>
			shouldForkAgent(contextPolicy, agentName) ? forkSessionFileForIndex(idx) : undefined;
		const forkThinkingOverrideForTask = (agentName: string, idx?: number) =>
			shouldForkAgent(contextPolicy, agentName) ? forkThinkingOverrideForIndex(idx) : undefined;
		const childSessionFileForTask = (agentName: string, idx?: number) =>
			forkSessionFileForTask(agentName, idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
		const childSessionFileForIndex = (idx?: number) => path.join(sessionDirForIndex(idx), "session.jsonl");
		try {
			preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, forkSessionFileForTask);
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error);
		}
		const onUpdateWithContext = onUpdate
			? (r: SubagentToolResult<Details>) => onUpdate(withForkContext(r, effectiveParams.context))
			: undefined;

		const foregroundMode: "single" | "parallel" = hasTasks ? "parallel" : "single";

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex: childSessionFileForIndex,
			sessionFileForTask: childSessionFileForTask,
			thinkingOverrideForTask: forkThinkingOverrideForTask,
			artifactConfig,
			artifactsDir,
			effectiveAsync,
			controlConfig,
			intercomBridge,
			nestedRoute,
			timeoutMs: foregroundTimeout.timeoutMs,
			turnBudget: turnBudget.turnBudget,
			toolBudget: runToolBudget.toolBudget,
			contextPolicy,
			modelScope,
		};

		const foregroundControl = effectiveAsync
			? undefined
			: {
					runId,
					mode: foregroundMode,
					startedAt: Date.now(),
					updatedAt: Date.now(),
					currentAgent: undefined,
					currentIndex: undefined,
					currentActivityState: undefined,
					nestedRoute,
					interrupt: undefined,
				};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
		}

		const writeNestedForegroundEvent = (
			type: "subagent.nested.started" | "subagent.nested.completed",
			result?: SubagentToolResult<Details>,
		): void => {
			if (!inheritedNestedRoute || !nestedParentAddress) return;
			const now = Date.now();
			const details = result?.details;
			const state =
				type === "subagent.nested.started"
					? "running"
					: result?.isError || details?.results.some((child) => child.exitCode !== 0)
						? "failed"
						: details?.results.some((child) => child.interrupted)
							? "paused"
							: "complete";
			const errorText = result?.isError ? result.content.find((item) => item.type === "text")?.text : undefined;
			const agentsForSummary =
				hasTasks && effectiveParams.tasks
					? effectiveParams.tasks.map((task) => task.agent)
					: effectiveParams.agent
						? [effectiveParams.agent]
						: [];
			const leafIntercomTarget =
				intercomBridge.active && agentsForSummary[0]
					? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
					: undefined;
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type,
					ts: now,
					parentRunId: nestedParentAddress.parentRunId,
					parentStepIndex: nestedParentAddress.parentStepIndex,
					child: {
						id: runId,
						parentRunId: nestedParentAddress.parentRunId,
						parentStepIndex: nestedParentAddress.parentStepIndex,
						depth: nestedParentAddress.depth,
						path: nestedParentAddress.path,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget,
						intercomTarget: leafIntercomTarget,
						ownerState: state === "running" ? "live" : "gone",
						mode: foregroundMode,
						state,
						agent: agentsForSummary[0],
						agents: agentsForSummary,
						startedAt: foregroundControl?.startedAt ?? now,
						...(state !== "running" ? { endedAt: now } : {}),
						lastUpdate: now,
						...(details?.totalCost ? { totalCost: details.totalCost } : {}),
						...(errorText ? { error: errorText } : {}),
						...(details?.results.length
							? {
									steps: details.results.map((child) => ({
										agent: child.agent,
										status: child.interrupted ? "paused" : child.exitCode === 0 ? "complete" : "failed",
										...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
										...(child.error ? { error: child.error } : {}),
										...(child.contextUsage ? { contextUsage: child.contextUsage } : {}),
										...(child.terminationReason ? { terminationReason: child.terminationReason } : {}),
									})),
								}
							: {}),
					},
				});
			} catch (error) {
				console.error("Failed to emit nested foreground status event:", error);
			}
		};

		let nestedForegroundStarted = false;
		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, effectiveParams.context);
			if (foregroundControl) {
				writeNestedForegroundEvent("subagent.nested.started");
				nestedForegroundStarted = true;
			}
			if (hasTasks && effectiveParams.tasks) {
				const result = await runParallelPath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, effectiveParams.context);
			}
			if (hasSingle) {
				const result = await runSinglePath(execData, deps);
				writeNestedForegroundEvent("subagent.nested.completed", result);
				return withForkContext(result, effectiveParams.context);
			}
		} catch (error) {
			const errorResult = toExecutionErrorResult(effectiveParams, error);
			if (nestedForegroundStarted) writeNestedForegroundEvent("subagent.nested.completed", errorResult);
			return errorResult;
		} finally {
			if (foregroundControl) {
				clearPendingForegroundControlNotices(deps.state, runId);
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext(
			{
				content: [{ type: "text", text: "Invalid params" }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			},
			effectiveParams.context,
		);
	};

	const executeWithSingleDispatchGuard = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: SubagentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<SubagentToolResult<Details>> => {
		const requestParams = params;
		if (requestParams.action) return execute(id, requestParams, signal, onUpdate, ctx);
		if (deps.state.subagentInProgress === true) return duplicateSubagentCallResult(requestParams);
		deps.state.subagentInProgress = true;
		try {
			return await execute(id, requestParams, signal, onUpdate, ctx);
		} finally {
			deps.state.subagentInProgress = false;
		}
	};

	return { execute: executeWithSingleDispatchGuard };
}
