/**
 * Foreground execution paths and their result construction.
 *
 * The executor owns validation, management dispatch, and path selection; this
 * module owns the single-task and parallel foreground execution paths.
 */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { ProjectAgentRunCapture } from "../../agents/project-agent-snapshot.ts";
import {
  clearForegroundMessageInbox,
  emitControlNotification,
  enrichPersistedPausedForegroundSingleRun,
  getRequestedModeLabel,
  providerFallbackModelsForTarget,
  readModelRegistrySnapshot,
  recoverFailedPausedForegroundTransition,
  registerForegroundMessageInbox,
  rememberForegroundRun,
  resetForegroundControlHealth,
  resolveSingleRunOutputBaseDir,
  updateForegroundControlProgress,
  updateRememberedForegroundChild,
  clearForegroundControlEphemeralHealth,
} from "./foreground-control.ts";
import {
  buildCohortPauseStep,
  buildPausedStepFromResult,
  isTerminalForegroundResultSnapshot,
  persistPausedForegroundCohortRun,
  persistPausedForegroundSingleRun,
} from "./foreground-pause-state.ts";
import {
  resolveSubagentModelOverride,
  type ModelRegistryEvidence,
} from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import {
  clearForegroundInterrupt,
  registerForegroundInterrupt,
} from "../shared/foreground-interrupts.ts";
import {
  buildExecutionInstructions,
  resolveStepBehavior,
  suppressProgressForReadOnlyTask,
  writeInitialProgressFile,
  type ResolvedStepBehavior,
  type StepOverrides,
} from "../../shared/settings.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
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
  resolveChildCwd,
  sumResultsCost,
  sumResultsUsage,
} from "../../shared/utils.ts";
import {
  captureChildLocationSnapshot,
  makeParentGitFactsAccessor,
} from "../../shared/child-location.ts";
import {
  aggregateParallelOutputs,
  DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
  Semaphore,
} from "../shared/parallel-utils.ts";
import {
  attachNestedChildrenToResultChildren,
  formatForegroundNativeSubagentResult,
  resolveSubagentResultStatus,
} from "../../shared/result-formatting.ts";
import {
  attachRootChildrenToSteps,
  updateForegroundNestedProjection,
} from "../shared/nested-events.ts";
import {
  safeTerminalDocument,
  safeTerminalDocumentLeaf,
  safeTerminalText,
} from "../../shared/display-text.ts";
import {
  formatForegroundPauseMessage,
  formatForegroundSupervisorPauseMessage,
} from "../../shared/foreground-pause.ts";
import { runSync } from "./execution.ts";
import {
  resolveChildMaxSubagentDepth,
  resolveCurrentMaxSubagentDepth,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
  type AcceptanceInput,
  type AgentProgress,
  type ArtifactPaths,
  type ControlEvent,
  type Details,
  type ExtensionConfig,
  type MaxOutputConfig,
  type NestedRunSummary,
  type ResolvedArtifactConfig,
  type ResolvedControlConfig,
  type ResolvedToolBudget,
  type SingleResult,
  type SubagentResultStatus,
  type SubagentRunMode,
  type SubagentState,
  type SubagentToolResult,
  type TkTicketMetadata,
  type ToolBudgetConfig,
} from "../../shared/types.ts";

interface TaskParam {
  agent: string;
  task: string;
  cwd?: string;
  count?: number;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  model?: string;
  modelFallbackNotice?: string;
  acceptance?: AcceptanceInput;
  toolBudget?: ToolBudgetConfig;
}

interface ForegroundPathParams {
  agent?: string;
  task?: string;
  tasks?: TaskParam[];
  toolBudget?: ToolBudgetConfig;
  maxOutput?: MaxOutputConfig;
  model?: string;
  modelFallbackNotice?: string;
  skill?: string | string[] | boolean;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  acceptance?: AcceptanceInput;
}

interface ForegroundPathDeps {
  pi: ExtensionAPI;
  state: SubagentState;
  config: ExtensionConfig;
}

interface ExecutionPathData {
  params: ForegroundPathParams;
  effectiveCwd: string;
  ctx: ExtensionContext;
  signal: AbortSignal;
  onUpdate?: (r: SubagentToolResult<Details>) => void;
  agents: AgentConfig[];
  projectAgentCaptures?: readonly ProjectAgentRunCapture[];
  runId: string;
  shareEnabled: boolean;
  sessionDirForIndex: (idx?: number) => string;
  sessionFileForIndex: (idx?: number) => string | undefined;
  sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
  artifactConfig: ResolvedArtifactConfig;
  artifactsDir: string;
  controlConfig: ResolvedControlConfig;
  timeoutMs?: number;
  deadlineAt?: number;
  toolBudget?: ResolvedToolBudget;
  modelScope?: ModelScopeConfig;
  /** Narrow functional seam for foreground pause/resume tests. */
  runSync?: typeof runSync;
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
  const hasSavedOutputReference =
    result.exitCode === 0 && Boolean(result.savedOutputPath && result.outputReference);
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

function formatFailedSingleRunOutput(result: SingleResult, displayOutput: string): string {
  const error = safeTerminalText(result.error || "Failed");
  const output = safeTerminalDocumentLeaf(displayOutput).trim();
  const outputForComparison = safeTerminalText(output).trim();
  const lines = [error];
  if (output && outputForComparison !== error.trim()) {
    lines.push("", "Output:", output);
  }
  if (result.artifactPaths?.outputPath) {
    lines.push("", `Output artifact: ${safeTerminalText(result.artifactPaths.outputPath)}`);
  }
  return safeTerminalDocument(lines.join("\n"));
}

function createForegroundControlNotifier(
  data: Pick<ExecutionPathData, "controlConfig">,
  deps: Pick<ForegroundPathDeps, "pi">,
): (event: ControlEvent) => void {
  return (event) =>
    emitControlNotification({
      pi: deps.pi,
      controlConfig: data.controlConfig,
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
  const visibleResults = input.details.results.map((result, index) => ({ result, index }));
  if (visibleResults.length === 0) return null;
  const children = visibleResults.map(({ result, index }, visibleIndex) => ({
    agent: result.agent,
    status: resolveSubagentResultStatus({
      exitCode: result.exitCode,
      interrupted: result.interrupted,
    }),
    summary: resultSummaryForNativeForeground(result, input.displayOutputs?.[index]),
    index,
    displayIndex: visibleIndex + 1,
    displayTotal: visibleResults.length,
    artifactPath: result.artifactPaths?.outputPath,
    sessionPath: result.sessionFile,
  }));
  const grouped = formatForegroundNativeSubagentResult({
    runId: input.runId,
    mode: input.mode,
    children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
    ...(input.statusOverride ? { statusOverride: input.statusOverride } : {}),
    ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
  });
  return {
    text: grouped.text,
    details: input.details,
  };
}

function resolveEffectiveSingleTimeout(
  callerTimeoutMs: number | undefined,
  agentTimeoutCeilingMs: number | undefined,
): number | undefined {
  if (callerTimeoutMs === undefined) return agentTimeoutCeilingMs;
  if (agentTimeoutCeilingMs === undefined) return callerTimeoutMs;
  return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}

export function resolveToolBudget(
  raw: unknown,
  label = "toolBudget",
): { toolBudget?: ResolvedToolBudget; error?: string } {
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

export function toExecutionErrorResult(
  params: ForegroundPathParams,
  error: unknown,
): SubagentToolResult<Details> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode: getRequestedModeLabel(params), results: [] },
  };
}

export function buildParallelModeError(message: string): SubagentToolResult<Details> {
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
  signal: AbortSignal;
  runId: string;
  sessionDirForIndex: (idx?: number) => string;
  sessionFileForIndex: (idx?: number) => string | undefined;
  sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
  shareEnabled: boolean;
  artifactConfig: ResolvedArtifactConfig;
  artifactsDir: string;
  outputBaseDir: string;
  maxOutput?: MaxOutputConfig;
  paramsCwd: string;
  progressDir: string;
  availableModels: ModelInfo[];
  modelRegistry: ModelRegistryEvidence;
  modelScope?: ModelScopeConfig;
  modelOverrides: (string | undefined)[];
  providerFallbackModels: (string[] | undefined)[];
  behaviors: ResolvedStepBehavior[];
  firstProgressIndex: number;
  controlConfig: ResolvedControlConfig;
  onControlEvent: (event: ControlEvent) => void;
  foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
  concurrencyLimit: number;
  globalSemaphore: Semaphore;
  maxSubagentDepths: number[];
  liveResults: (SingleResult | undefined)[];
  liveProgress: (AgentProgress | undefined)[];
  onUpdate?: (r: SubagentToolResult<Details>) => void;
  timeoutMs?: number;
  deadlineAt?: number;
  toolBudgets: (ResolvedToolBudget | undefined)[];
  tkTicket?: TkTicketMetadata;
  tkTicketIndex?: number;
  projectAgentCaptures?: readonly import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture[];
  /** Narrow functional seam for foreground pause/resume tests. */
  runSync?: typeof runSync;
}

function resolveParallelTaskCwd(task: TaskParam, paramsCwd: string): string {
  return resolveChildCwd(paramsCwd, task.cwd);
}

function cohortPauseHealth(
  result: SingleResult | undefined,
  liveProgress: AgentProgress | undefined,
): Pick<
  AgentProgress,
  "activityState" | "idleEpisodeId" | "durableAttentionReasons" | "compaction"
> {
  return {
    activityState: result?.progress?.activityState ?? liveProgress?.activityState,
    idleEpisodeId: result?.progress?.idleEpisodeId ?? liveProgress?.idleEpisodeId,
    durableAttentionReasons:
      result?.progress?.durableAttentionReasons ?? liveProgress?.durableAttentionReasons,
    compaction: result?.progress?.compaction ?? liveProgress?.compaction,
  };
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
    const outputPath = resolveSingleOutputPath(
      behavior.output,
      input.ctxCwd,
      taskCwd,
      input.outputBaseDir,
    );
    if (!outputPath) continue;
    const previous = seen.get(outputPath);
    if (previous) {
      return `Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${outputPath}. Use distinct output paths.`;
    }
    seen.set(outputPath, { index, agent: task.agent });
  }
  return undefined;
}

async function runForegroundParallelTasks(
  input: ForegroundParallelRunInput,
): Promise<SingleResult[]> {
  let interrupted = false;
  let supervisorPauseIndex: number | undefined;
  const interruptControllers = new Map<number, AbortController>();
  const startedIndexes = new Set<number>();
  // Precompute per-task dispatch-time child-location snapshots sequentially so
  // writeParallelPauseCheckpoint can carry them for pending/cohort-pause steps
  // even when a task has not yet produced a live result.
  // Use a lazy memoizing accessor so the parent git lookup is deferred until
  // a child cwd is confirmed to differ; when all tasks share the parent cwd
  // (the common case) the accessor is never called and zero git work is done.
  const parentFactsAccessor = makeParentGitFactsAccessor(input.ctx.cwd);
  const taskLocationSnapshots = input.tasks.map((task) => {
    const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
    return captureChildLocationSnapshot(input.ctx.cwd, taskCwd, undefined, parentFactsAccessor);
  });
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
      // Prefer childLocation from the live result (set by execution.ts at dispatch).
      // Fall back to the precomputed dispatch snapshot for pending tasks that
      // have not yet produced a live result.
      const cohortChildLocation = result?.childLocation ?? taskLocationSnapshots[index];
      if (
        startedIndexes.has(index) ||
        interruptControllers.has(index) ||
        liveProgress?.status === "running"
      ) {
        return buildCohortPauseStep({
          agent: task.agent,
          sessionFile:
            input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
          status: options.rootStage === "paused" ? "paused" : "pausing",
          now,
          model: result?.model ?? task.model,
          thinking: result?.thinking,
          modelIdentity: result?.modelIdentity,
          modelResolution: result?.modelResolution,
          ...cohortPauseHealth(result, liveProgress),
          contextUsage: result?.contextUsage,
          contextPressure: result?.contextPressure,
          contextPressureCrossedThresholds: result?.contextPressureCrossedThresholds,
          projectAgent:
            result?.projectAgent ??
            input.projectAgentCaptures?.find((capture) => capture.provenance.agent === task.agent),
          childLocation: cohortChildLocation,
        });
      }
      return buildCohortPauseStep({
        agent: task.agent,
        sessionFile:
          input.sessionFileForTask(task.agent, index) ?? input.sessionFileForIndex(index),
        status: "pending",
        now,
        model: result?.model ?? task.model,
        thinking: result?.thinking,
        modelIdentity: result?.modelIdentity,
        modelResolution: result?.modelResolution,
        ...cohortPauseHealth(result, liveProgress),
        contextUsage: result?.contextUsage,
        contextPressure: result?.contextPressure,
        contextPressureCrossedThresholds: result?.contextPressureCrossedThresholds,
        projectAgent:
          result?.projectAgent ??
          input.projectAgentCaptures?.find((capture) => capture.provenance.agent === task.agent),
        childLocation: cohortChildLocation,
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
  const requestCohortPause = (
    requesterIndex: number,
    requester: SingleResult,
    ownerPid: number | undefined,
  ) => {
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
  // Pre-create child session paths sequentially before concurrent dispatch.
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
          // Attach the precomputed dispatch-time snapshot so the finalization
          // path (persistPausedForegroundCohortRun with results:) includes
          // the child location in the final persisted paused status. Without
          // this the checkpoint written by writeParallelPauseCheckpoint
          // (which uses taskLocationSnapshots directly) is overwritten by
          // the finalization call that rebuilds steps from results.
          ...(taskLocationSnapshots[index] !== undefined
            ? { childLocation: taskLocationSnapshots[index] }
            : {}),
        } as SingleResult;
      }
      const behavior = input.behaviors[index];
      const effectiveSkills = behavior?.skills;
      const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd);
      // Reuse the precomputed snapshot from cohort setup; do NOT re-capture here.
      // Re-capturing would spawn two additional git processes per task, defeating
      // the capture-once model and allowing the live snapshot to drift from the
      // pause snapshot if the repository changes mid-dispatch.
      const taskChildLocationSnapshot = taskLocationSnapshots[index];
      const readInstructions = behavior
        ? buildExecutionInstructions(
            { ...behavior, output: false, progress: false },
            taskCwd,
            false,
          )
        : { prefix: "", suffix: "" };
      const progressInstructions = behavior
        ? buildExecutionInstructions(
            { ...behavior, output: false, reads: false },
            input.progressDir,
            index === input.firstProgressIndex,
          )
        : { prefix: "", suffix: "" };
      const outputPath = resolveSingleOutputPath(
        behavior?.output,
        input.ctx.cwd,
        taskCwd,
        input.outputBaseDir,
      );
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
        resetForegroundControlHealth(input.foregroundControl);
        input.foregroundControl.updatedAt = Date.now();
        registerForegroundInterrupt(input.foregroundControl, index, () => {
          interrupted = true;
          if (interruptController.signal.aborted) return false;
          interruptController.abort();
          clearForegroundControlEphemeralHealth(input.foregroundControl!);
          input.foregroundControl!.updatedAt = Date.now();
          return true;
        });
      }
      const agentConfig = input.agents.find((agent) => agent.name === task.agent);
      const supervisorBridgeActive = agentConfig?.supervisorBridge !== false;
      return (input.runSync ?? runSync)(input.ctx.cwd, input.agents, task.agent, taskText, {
        onSupervisorPauseTransition: (transition) => {
          const { stage, result } = transition;
          if (result.pause?.kind !== "awaiting_supervisor") return;
          if (stage === "pausing") {
            requestCohortPause(index, result, transition.ownerPid);
            return;
          }
          input.liveResults[index] = result;
          writeParallelPauseCheckpoint(index, result, undefined, {
            rootStage: "pausing",
            requesterStatus: "paused",
          });
        },
        parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
        projectAgent: input.projectAgentCaptures?.find(
          (capture) => capture.provenance.agent === task.agent,
        ),
        cwd: taskCwd,
        signal: input.signal,
        interruptSignal: interruptController.signal,
        pauseBlockingSupervisor: supervisorBridgeActive,
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
        steerInboxDir,
        nestedRoute: input.foregroundControl?.nestedRoute,
        modelOverride: input.modelOverrides[index],
        providerFallbackModels: input.providerFallbackModels[index],
        modelFallbackNotice: behavior?.modelFallbackNotice,
        availableModels: input.availableModels,
        modelRegistry: input.modelRegistry,
        preferredModelProvider: input.ctx.model?.provider,
        modelScope: input.modelScope,
        ...(input.tkTicket && input.tkTicketIndex === index ? { tkTicket: input.tkTicket } : {}),
        ...(taskChildLocationSnapshot ? { childLocation: taskChildLocationSnapshot } : {}),
        skills: effectiveSkills === false ? [] : effectiveSkills,
        acceptance: task.acceptance,
        acceptanceContext: { mode: "parallel" },
        timeoutMs: input.timeoutMs,
        deadlineAt: input.deadlineAt,
        toolBudget: input.toolBudgets[index],
        onUpdate: input.onUpdate
          ? (progressUpdate) => {
              const stepResults = progressUpdate.details?.results || [];
              const stepProgress = progressUpdate.details?.progress || [];
              if (input.foregroundControl && stepProgress.length > 0) {
                const current = stepProgress[0];
                input.foregroundControl.currentAgent = task.agent;
                input.foregroundControl.currentIndex = index;
                updateForegroundControlProgress(input.foregroundControl, current);
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
              const mergedResults = input.liveResults.filter(
                (result): result is SingleResult => result !== undefined,
              );
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
            result.finalOutput =
              "Paused because another child in this cohort is awaiting supervisor.";
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

export async function runParallelPath(
  data: ExecutionPathData,
  deps: ForegroundPathDeps,
): Promise<SubagentToolResult<Details>> {
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
    shareEnabled,
    artifactConfig,
    artifactsDir,
    onUpdate,
    controlConfig,
  } = data;
  const onControlEvent = createForegroundControlNotifier(data, deps);
  const allArtifactPaths: ArtifactPaths[] = [];
  const tasks = params.tasks!;
  const tkTicketContext = resolveTkTicketTaskContext({ runnerCwd: effectiveCwd, tasks });
  const tkTicket = tkTicketContext
    ? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
    : undefined;
  const tkTicketIndex = tkTicketContext?.taskIndex;
  const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
  const parallelConcurrency = resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency);
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
  const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
  const { availableModels } = modelRegistrySnapshot;
  const taskTexts = tasks.map((t) => t.task);
  const behaviorOverrides: StepOverrides[] = tasks.map((task, index) => ({
    ...(task.output !== undefined
      ? { output: task.output === true ? (agentConfigs[index]?.output ?? false) : task.output }
      : {}),
    ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
    ...(task.model ? { model: task.model } : {}),
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
    suppressProgressForReadOnlyTask(
      resolveStepBehavior(config, behaviorOverrides[index]!),
      taskTexts[index],
    ),
  );
  const firstProgressIndex = behaviors.findIndex((behavior) => behavior.progress);
  const liveResults: (SingleResult | undefined)[] = Array.from(
    { length: tasks.length },
    () => undefined,
  );
  const liveProgress: (AgentProgress | undefined)[] = Array.from(
    { length: tasks.length },
    () => undefined,
  );
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
    const outputPath = resolveSingleOutputPath(
      behaviors[index]?.output,
      ctx.cwd,
      taskCwd,
      outputBaseDir,
    );
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

  const deadlineAt =
    data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
  const results = await runForegroundParallelTasks({
    tasks,
    taskTexts,
    agents,
    ctx,
    state: deps.state,
    signal,
    runId,
    sessionDirForIndex,
    sessionFileForIndex,
    sessionFileForTask,
    shareEnabled,
    artifactConfig,
    artifactsDir,
    outputBaseDir,
    maxOutput: params.maxOutput,
    paramsCwd: effectiveCwd,
    progressDir: parallelProgressDir,
    availableModels,
    modelRegistry: modelRegistrySnapshot.evidence,
    modelScope: data.modelScope,
    modelOverrides,
    providerFallbackModels: tasks.map((task) => providerFallbackModelsForTarget(task)),
    behaviors,
    firstProgressIndex: parallelProgressPrecreated ? -1 : firstProgressIndex,
    controlConfig,
    onControlEvent,
    foregroundControl,
    concurrencyLimit: parallelConcurrency,
    globalSemaphore: new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT),
    maxSubagentDepths,
    liveResults,
    liveProgress,
    onUpdate,
    timeoutMs: data.timeoutMs,
    deadlineAt,
    toolBudgets,
    ...(tkTicket ? { tkTicket } : {}),
    ...(tkTicketIndex !== undefined && tkTicketIndex >= 0 ? { tkTicketIndex } : {}),
    projectAgentCaptures: data.projectAgentCaptures,
    runSync: data.runSync,
  });
  for (const result of results) {
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
    artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
    totalChildUsage: sumResultsUsage(results),
    totalCost: sumResultsCost(results),
  });
  rememberForegroundRun(deps.state, {
    runId,
    mode: "parallel",
    cwd: effectiveCwd,
    results: details.results,
  });
  if (results.some((result) => result.pause)) {
    persistPausedForegroundCohortRun({
      runId,
      cwd: effectiveCwd,
      sessionId: deps.state.currentSessionId,
      mode: "parallel",
      stage: "paused",
      results,
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
  if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
  const nativeResult = buildForegroundNativeResult({
    runId,
    mode: "parallel",
    details,
    ...(foregroundControl?.nestedChildren?.length
      ? { nestedChildren: foregroundControl.nestedChildren }
      : {}),
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

export async function runSinglePath(
  data: ExecutionPathData,
  deps: ForegroundPathDeps,
): Promise<SubagentToolResult<Details>> {
  const {
    params,
    effectiveCwd,
    agents,
    ctx,
    signal,
    runId,
    sessionDirForIndex,
    sessionFileForTask,
    shareEnabled,
    artifactConfig,
    artifactsDir,
    onUpdate,
    controlConfig,
  } = data;
  const onControlEvent = createForegroundControlNotifier(data, deps);
  const allArtifactPaths: ArtifactPaths[] = [];
  const agentConfig = agents.find((a) => a.name === params.agent);
  if (!agentConfig) {
    return {
      content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
  const supervisorBridgeActive = agentConfig.supervisorBridge !== false;
  const effectiveToolBudget = resolveEffectiveToolBudget({
    runBudget: data.toolBudget,
    agentBudget: agentConfig.toolBudget,
  });
  if (effectiveToolBudget.error)
    return toExecutionErrorResult(params, new Error(effectiveToolBudget.error));

  const currentProvider = ctx.model?.provider;
  const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
  const { availableModels } = modelRegistrySnapshot;
  let task = params.task ?? "";
  const tkTicket = resolveTkTicketMetadata(params.task, { cwd: effectiveCwd });
  const modelOverride: string | undefined = resolveSubagentModelOverride(
    (params.model as string | undefined) ?? agentConfig.model,
    ctx.model,
    availableModels,
    currentProvider,
    {
      scope: data.modelScope,
      source: (params.model as string | undefined) ? "explicit" : "inherited",
    },
  );
  const skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
  const providerFallbackModels = providerFallbackModelsForTarget(params);
  const modelFallbackNotice = params.modelFallbackNotice;
  const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
  const effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
  const effectiveOutputMode = params.outputMode ?? "inline";
  const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
  const maxSubagentDepth = resolveChildMaxSubagentDepth(
    currentMaxSubagentDepth,
    agentConfig.maxSubagentDepth,
  );
  const effectiveTimeoutMs = resolveEffectiveSingleTimeout(
    data.timeoutMs,
    agentConfig.maxExecutionTimeMs,
  );

  const outputPath = resolveSingleOutputPath(
    effectiveOutput,
    ctx.cwd,
    effectiveCwd,
    resolveSingleRunOutputBaseDir(artifactsDir, runId),
  );
  const validationError = validateFileOnlyOutputMode(
    effectiveOutputMode,
    outputPath,
    `Single run (${params.agent})`,
  );
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
  const steerInboxDir = foregroundControl
    ? registerForegroundMessageInbox(foregroundControl, runId, 0)
    : undefined;
  if (foregroundControl) {
    foregroundControl.currentAgent = params.agent;
    foregroundControl.currentIndex = 0;
    resetForegroundControlHealth(foregroundControl);
    foregroundControl.updatedAt = Date.now();
    registerForegroundInterrupt(foregroundControl, 0, () => {
      if (interruptController.signal.aborted) return false;
      interruptController.abort();
      clearForegroundControlEphemeralHealth(foregroundControl);
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
          updateForegroundControlProgress(foregroundControl, firstProgress);
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
    data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
  const childLocationSnapshot = captureChildLocationSnapshot(ctx.cwd, effectiveCwd);
  let r: SingleResult;
  try {
    r = await (data.runSync ?? runSync)(ctx.cwd, agents, params.agent!, task, {
      parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
      projectAgent: data.projectAgentCaptures?.find(
        (capture) => capture.provenance.agent === params.agent,
      ),
      cwd: effectiveCwd,
      signal,
      interruptSignal: interruptController.signal,
      pauseBlockingSupervisor: supervisorBridgeActive,
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
          updateRememberedForegroundChild(deps.state, {
            runId,
            mode: "single",
            cwd: effectiveCwd,
            index: 0,
            result,
          });
      },
      index: 0,
      modelOverride,
      providerFallbackModels,
      modelFallbackNotice,
      availableModels,
      modelRegistry: modelRegistrySnapshot.evidence,
      preferredModelProvider: currentProvider,
      modelScope: data.modelScope,
      ...(tkTicket ? { tkTicket } : {}),
      ...(childLocationSnapshot ? { childLocation: childLocationSnapshot } : {}),
      skills: effectiveSkills,
      acceptance: params.acceptance,
      acceptanceContext: { mode: "single" },
      timeoutMs: effectiveTimeoutMs,
      deadlineAt,
      toolBudget: effectiveToolBudget.toolBudget,
    });
  } finally {
    if (foregroundControl) clearForegroundMessageInbox(foregroundControl, 0);
  }
  if (foregroundControl) {
    clearForegroundInterrupt(foregroundControl, 0);
    updateForegroundControlProgress(foregroundControl, r.progress);
    foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
    foregroundControl.currentTool = r.progress?.currentTool;
    foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
    foregroundControl.currentPath = r.progress?.currentPath;
    foregroundControl.turnCount = r.progress?.turnCount;
    foregroundControl.tokens = r.progress?.tokens;
    foregroundControl.toolCount = r.progress?.toolCount;
    foregroundControl.updatedAt = Date.now();
  }
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
    // A saved deliverable remains useful when an otherwise-successful run is
    // rejected by either inferred or explicit post-run acceptance.
    acceptanceRejected: r.acceptance?.status === "rejected" && Boolean(r.savedOutputPath),
  });
  if (foregroundControl) {
    updateForegroundNestedProjection(foregroundControl);
    attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
  }
  const details = compactForegroundDetails({
    mode: "single",
    runId,
    results: [r],
    ...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
    artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
    truncation: r.truncation,
    totalChildUsage: sumResultsUsage([r]),
    totalCost: sumResultsCost([r]),
  });
  rememberForegroundRun(deps.state, {
    runId,
    mode: "single",
    cwd: effectiveCwd,
    results: details.results,
  });
  if (r.pause?.kind === "awaiting_supervisor")
    enrichPersistedPausedForegroundSingleRun({ runId, result: r });

  if (!r.interrupted) {
    if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
    const nativeResult = buildForegroundNativeResult({
      runId,
      mode: "single",
      details,
      displayOutputs: [finalizedOutput.displayOutput],
      ...(foregroundControl?.nestedChildren?.length
        ? { nestedChildren: foregroundControl.nestedChildren }
        : {}),
    });
    if (nativeResult) {
      return {
        content: [{ type: "text", text: nativeResult.text }],
        details: nativeResult.details,
        ...(r.exitCode !== 0 ? { isError: true } : {}),
      };
    }
  }

  if (r.pause?.kind === "awaiting_supervisor") {
    return {
      content: [
        {
          type: "text",
          text: safeTerminalDocument(
            formatForegroundSupervisorPauseMessage({
              headline: `Foreground run ${runId} paused awaiting supervisor (${params.agent}).`,
              runId,
              agent: params.agent!,
              requestSummary: r.pause.summary,
            }),
          ),
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
          text: safeTerminalDocument(
            formatForegroundPauseMessage({
              headline: `Foreground run ${runId} paused after interrupt (${params.agent}).`,
              runId,
              resume: { kind: "single" },
              redispatch: `subagent({ agent: "${params.agent}", task: "..." })`,
            }),
          ),
        },
      ],
      details,
    };
  }

  const noticePrefix = r.modelFallbackNotice
    ? `Notice: ${safeTerminalText(r.modelFallbackNotice)}\n\n`
    : "";
  if (r.exitCode !== 0)
    return {
      content: [
        {
          type: "text",
          text: `${noticePrefix}${formatFailedSingleRunOutput(r, finalizedOutput.displayOutput)}`,
        },
      ],
      details,
      isError: true,
    };
  return {
    content: [
      { type: "text", text: `${noticePrefix}${finalizedOutput.displayOutput || "(no output)"}` },
    ],
    details,
  };
}
