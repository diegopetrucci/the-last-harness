/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ProjectAgentRunCapture } from "../../agents/project-agent-snapshot.ts";
import type { SubagentRunConfig } from "../shared/parallel-utils.ts";
import {
  applyThinkingSuffix,
  getThinkingLevelDropNote,
  validatePiToolPolicy,
} from "../shared/pi-args.ts";
import {
  injectOutputPathSystemPrompt,
  injectSingleOutputInstruction,
  normalizeSingleOutputOverride,
  resolveSingleOutputPath,
  validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import {
  buildExecutionInstructions,
  resolveStepBehavior,
  suppressProgressForReadOnlyTask,
  writeInitialProgressFile,
  type ResolvedStepBehavior,
  type StepOverrides,
} from "../../shared/settings.ts";
import { type RunnerSubagentStep, type SubagentRunPlan } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { remainingExecutionTimeMs } from "../../agents/execution-ceiling.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveChildCwd } from "../../shared/utils.ts";
import {
  buildFallbackModelList,
  buildModelCandidatePlan,
  canonicalSubagentModelIdentity,
  modelReferenceFromIdentity,
  resolveSubagentModelOverride,
  type AvailableModelInfo,
  type ModelRegistryEvidence,
  type ParentModel,
} from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
  mergeContinuationAcceptance,
  resolveEffectiveAcceptance,
  validateAcceptanceInput,
  validateDispatchAcceptanceInput,
} from "../shared/acceptance.ts";
import {
  type AcceptanceInput,
  type ArtifactConfig,
  type OutputMode,
  type ToolBudgetConfig,
  type ContextPressureProjection,
  type ContextUsageDiagnostics,
  type Details,
  type MaxOutputConfig,
  type NestedRouteInfo,
  type ResolvedControlConfig,
  type TkTicketMetadata,
  type ResolvedToolBudget,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentRunMode,
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
  TEMP_ROOT_DIR,
  getAsyncConfigPath,
  resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import {
  nestedResultsPath,
  resolveInheritedNestedRouteFromEnv,
  resolveNestedParentAddressFromEnv,
  writeNestedEvent,
} from "../shared/nested-events.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
} from "../../shared/context-diagnostics.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import {
  detectTkTicketId,
  normalizeTkTicketMetadata,
  resolveTkTicketMetadata,
  resolveTkTicketTaskContext,
} from "../shared/tk-ticket.ts";
import { isCanonicalPackagedMinorAgent } from "../../../../shared/project-agent-guidance.ts";

const piPackageRoot = resolvePiPackageRoot();

interface AsyncExecutionContext {
  pi: ExtensionAPI;
  cwd: string;
  currentSessionId: string;
  /** Parent session id used by permission-system ask forwarding. */
  parentSessionId?: string;
  currentModelProvider?: string;
  currentModel?: ParentModel;
  /** Optional model-scope enforcement resolved from subagent settings. */
  modelScope?: ModelScopeConfig;
}

interface AsyncSingleParams {
  agent: string;
  task?: string;
  agentConfig: AgentConfig;
  ctx: AsyncExecutionContext;
  cwd?: string;
  continuationSource?: {
    asyncDir: string;
    runId: string;
    index: number;
    claimToken: string;
    projectAgent?: ProjectAgentRunCapture;
  };
  inheritedTkTicket?: TkTicketMetadata;
  /** Exact approved project-agent config/provenance for this child. */
  projectAgent?: ProjectAgentRunCapture;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig: ArtifactConfig;
  shareEnabled: boolean;
  sessionRoot?: string;
  sessionFile?: string;
  skills?: string[];
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  outputBaseDir?: string;
  modelOverride?: string;
  /** Persisted child identity used when durable resume has no explicit override. */
  restoredModelIdentity?: SubagentModelIdentity;
  /** Durable explanation for an explicit override or restored selection. */
  modelResolution?: SubagentModelResolution;
  /** Persisted context diagnostics used to initialize a durable continuation. */
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
  providerFallbackModels?: string[];
  modelFallbackNotice?: string;
  availableModels?: AvailableModelInfo[];
  modelRegistry?: ModelRegistryEvidence;
  maxSubagentDepth: number;
  controlConfig?: ResolvedControlConfig;
  nestedRoute?: NestedRouteInfo;
  acceptance?: AcceptanceInput;
  continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
  activeRuntimeMs?: number;
  timeoutMs?: number;
  toolBudget?: ResolvedToolBudget;
}

interface AsyncExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
  isError?: boolean;
}

/** Normalized task input for direct asynchronous parallel dispatch. */
interface AsyncParallelTaskParams {
  agent: string;
  task?: string;
  cwd?: string;
  output?: string | false;
  outputMode?: OutputMode;
  model?: string;
  providerFallbackModels?: string[];
  modelFallbackNotice?: string;
  acceptance?: AcceptanceInput;
  toolBudget?: ToolBudgetConfig;
}

interface AsyncParallelParams {
  tasks: AsyncParallelTaskParams[];
  concurrency?: number;
  agents: AgentConfig[];
  ctx: AsyncExecutionContext;
  availableModels?: AvailableModelInfo[];
  modelRegistry?: ModelRegistryEvidence;
  cwd?: string;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig: ArtifactConfig;
  shareEnabled: boolean;
  sessionRoot?: string;
  sessionFilesByFlatIndex?: (string | undefined)[];
  progressDir?: string;
  maxSubagentDepth: number;
  controlConfig?: ResolvedControlConfig;
  nestedRoute?: NestedRouteInfo;
  timeoutMs?: number;
  toolBudget?: ResolvedToolBudget;
  /** Exact approved project-agent captures for detached runner tasks. */
  projectAgentCaptures?: readonly ProjectAgentRunCapture[];
}

/** The narrow config portion consumed when resolving detached-runner log paths. */
interface AsyncRunnerLogPathConfig {
  asyncDir?: string;
}

export function formatAsyncStartedMessage(headline: string): string {
  return headline;
}

/**
 * Resolve the detached runner beside this module. Source modules use the
 * TypeScript runner for development/test loaders; generated runtime modules
 * always resolve the committed JavaScript runner.
 */
function resolveAsyncRunnerModulePath(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const runnerExtension = path.extname(modulePath) === ".ts" ? ".ts" : ".js";
  return path.join(path.dirname(modulePath), `subagent-runner${runnerExtension}`);
}

export function isAsyncAvailable(): boolean {
  return fs.existsSync(resolveAsyncRunnerModulePath());
}

function isNodeExecutableName(execPath: string): boolean {
  const basename = path.basename(execPath).toLowerCase();
  return (
    basename === "node" ||
    basename === "node.exe" ||
    basename === "nodejs" ||
    basename === "nodejs.exe"
  );
}

function canUseCurrentNodeExecutable(execPath: string): boolean {
  try {
    fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAsyncRunnerNodeCommand(): string {
  if (isNodeExecutableName(process.execPath) && canUseCurrentNodeExecutable(process.execPath)) {
    return process.execPath;
  }
  return process.platform === "win32" ? "node.exe" : "node";
}

export function resolveAsyncRunnerLogPaths(
  cfg: AsyncRunnerLogPathConfig,
): { stdoutPath: string; stderrPath: string } | undefined {
  const asyncDir = typeof cfg.asyncDir === "string" ? cfg.asyncDir : undefined;
  if (!asyncDir) return undefined;
  return {
    stdoutPath: path.join(asyncDir, "runner.stdout.log"),
    stderrPath: path.join(asyncDir, "runner.stderr.log"),
  };
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // Best-effort cleanup; child process already owns its duplicated stdio fd.
  }
}

/**
 * Spawn the async runner process
 */
function spawnRunner(
  cfg: SubagentRunConfig,
  suffix: string,
  cwd: string,
): { pid?: number; error?: string } {
  const runner = resolveAsyncRunnerModulePath();
  if (!fs.existsSync(runner)) {
    return { error: `async runner module could not be found: ${runner}` };
  }

  try {
    const cwdStats = fs.statSync(cwd);
    if (!cwdStats.isDirectory()) {
      return { error: `cwd is not a directory: ${cwd}` };
    }
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }

  fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
  const cfgPath = getAsyncConfigPath(suffix);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const nodeCommand = resolveAsyncRunnerNodeCommand();
  const runnerArgs = runner.endsWith(".ts")
    ? ["--experimental-strip-types", runner, cfgPath]
    : [runner, cfgPath];

  const logPaths = resolveAsyncRunnerLogPaths(cfg);
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    if (logPaths) {
      fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
      stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
      stderrFd = fs.openSync(logPaths.stderrPath, "a");
    }
    const proc = spawn(nodeCommand, runnerArgs, {
      cwd,
      detached: true,
      stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
      windowsHide: true,
      env: {
        ...process.env,
        ...(piPackageRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piPackageRoot } : {}),
      },
    });
    closeFd(stdoutFd);
    closeFd(stderrFd);
    proc.on("error", (error) => {
      console.error(`[pi-subagents] async spawn failed: ${error.message}`);
    });
    if (typeof proc.pid !== "number") {
      return { error: `async runner did not produce a pid for cwd: ${cwd}` };
    }
    proc.unref();
    return { pid: proc.pid };
  } catch (error) {
    closeFd(stdoutFd);
    closeFd(stderrFd);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode, results: [] },
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

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

function appendThinkingDropNote(
  notes: string[],
  droppedModels: string[],
  model: string | undefined,
  thinking: string | false | undefined,
  options: Parameters<typeof getThinkingLevelDropNote>[3],
): void {
  const note = getThinkingLevelDropNote(model, thinking, false, options);
  if (!note) return;
  if (!notes.includes(note)) notes.push(note);
  // Per-candidate drop metadata stays on every step even when the duplicate
  // human-facing note is deduplicated across direct parallel tasks.
  if (model && !droppedModels.includes(model)) droppedModels.push(model);
}

function dedupeRunnerTaskAttemptNotes(tasks: RunnerSubagentStep[]): RunnerSubagentStep[] {
  const emitted = new Set<string>();
  return tasks.map((task) => {
    if (!task.attemptNotes || task.attemptNotes.length === 0) return task;
    const attemptNotes = task.attemptNotes.filter((note) => {
      if (emitted.has(note)) return false;
      emitted.add(note);
      return true;
    });
    return attemptNotes.length > 0
      ? { ...task, attemptNotes }
      : { ...task, attemptNotes: undefined };
  });
}

function validateAsyncExecutionAcceptance(
  params: Pick<AsyncSingleParams, "acceptance"> | Pick<AsyncParallelParams, "tasks">,
): string[] {
  const errors: string[] = [];
  if ("tasks" in params) {
    for (const [taskIndex, task] of params.tasks.entries()) {
      errors.push(...validateAcceptanceInput(task.acceptance, `tasks[${taskIndex}].acceptance`));
      errors.push(
        ...validateDispatchAcceptanceInput(task.acceptance, `tasks[${taskIndex}].acceptance`),
      );
    }
    return errors;
  }
  errors.push(...validateAcceptanceInput(params.acceptance, "acceptance"));
  errors.push(...validateDispatchAcceptanceInput(params.acceptance, "acceptance"));
  return errors;
}

interface AsyncRunnerPlanBuildResult {
  plan: Extract<SubagentRunPlan, { kind: "parallel" }>;
  runnerCwd: string;
}

type AsyncParallelPlanParams = Omit<AsyncParallelParams, "artifactConfig" | "shareEnabled"> &
  Partial<Pick<AsyncParallelParams, "artifactConfig" | "shareEnabled">>;

/**
 * Build the direct parallel plan consumed by the detached runner.
 */
export function buildAsyncRunnerPlan(
  id: string,
  params: AsyncParallelPlanParams,
): AsyncRunnerPlanBuildResult | { error: string } {
  const { tasks, agents, ctx, cwd, sessionFilesByFlatIndex, maxSubagentDepth } = params;
  const outputBaseDir = params.artifactsDir
    ? path.join(params.artifactsDir, "outputs", id)
    : undefined;
  const availableModels = params.availableModels;
  const thinkingSuffixOptions = {
    availableModels,
    preferredModelProvider: ctx.currentModelProvider,
  };
  const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
  const progressDir = params.progressDir ?? runnerCwd;

  for (const task of tasks) {
    if (!agents.find((candidate) => candidate.name === task.agent)) {
      return { error: `Unknown agent: ${task.agent}` };
    }
  }

  let progressInstructionCreated = false;
  const buildStepOverrides = (task: AsyncParallelTaskParams): StepOverrides => ({
    ...(task.output !== undefined ? { output: task.output } : {}),
    ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
  });

  const buildTask = (
    taskSpec: AsyncParallelTaskParams,
    sessionFile?: string,
    progressPrecreated = false,
    resolvedBehavior?: ResolvedStepBehavior,
  ): RunnerSubagentStep => {
    const agent = agents.find((candidate) => candidate.name === taskSpec.agent)!;
    const toolBudgetInput = taskSpec.toolBudget ?? params.toolBudget ?? agent.toolBudget;
    const resolvedToolBudget = validateToolBudgetConfig(
      toolBudgetInput,
      taskSpec.toolBudget ? "toolBudget" : agent.toolBudget ? "agent.toolBudget" : "toolBudget",
    );
    if (resolvedToolBudget.error) throw new AsyncStartValidationError(resolvedToolBudget.error);
    const stepCwd = resolveChildCwd(runnerCwd, taskSpec.cwd);
    const behavior = suppressProgressForReadOnlyTask(
      resolvedBehavior ?? resolveStepBehavior(agent, buildStepOverrides(taskSpec)),
      taskSpec.task,
    );
    const skillNames = behavior.skills === false ? [] : behavior.skills;
    const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
      skillNames,
      stepCwd,
      ctx.cwd,
    );
    if (missingSkills.includes("pi-subagents"))
      throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);
    const toolPolicyError = validatePiToolPolicy({
      tools: agent.tools,
      requireReadTool: agent.inheritSkills || resolvedSkills.length > 0,
    });
    if (toolPolicyError) throw new AsyncStartValidationError(toolPolicyError);

    let systemPrompt = agent.systemPrompt?.trim() ?? "";
    if (resolvedSkills.length > 0) {
      const injection = buildSkillInjection(resolvedSkills);
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
    }

    const readInstructions = buildExecutionInstructions(
      { ...behavior, output: false, progress: false },
      stepCwd,
      false,
    );
    const isFirstProgressAgent =
      behavior.progress && !progressPrecreated && !progressInstructionCreated;
    if (behavior.progress) progressInstructionCreated = true;
    const progressInstructions = buildExecutionInstructions(
      { ...behavior, output: false, reads: false },
      progressDir,
      isFirstProgressAgent,
    );
    const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, stepCwd, outputBaseDir);
    systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath);
    const validationError = validateFileOnlyOutputMode(
      behavior.outputMode,
      outputPath,
      `Async parallel task (${taskSpec.agent})`,
    );
    if (validationError) throw new AsyncStartValidationError(validationError);
    const task = injectSingleOutputInstruction(
      `${readInstructions.prefix}${taskSpec.task ?? ""}${progressInstructions.suffix}`,
      outputPath,
    );

    const requestedModel = behavior.model ?? agent.model;
    const primaryModel = resolveSubagentModelOverride(
      requestedModel,
      ctx.currentModel,
      availableModels,
      ctx.currentModelProvider,
      { scope: ctx.modelScope, source: behavior.model ? "explicit" : "inherited" },
    );
    const fallbackModels = buildFallbackModelList(
      taskSpec.providerFallbackModels,
      agent.fallbackModels,
    );
    const effectiveThinking = agent.thinking;
    const attemptNotes: string[] = [];
    const thinkingDroppedModels: string[] = [];
    appendThinkingDropNote(
      attemptNotes,
      thinkingDroppedModels,
      primaryModel,
      effectiveThinking,
      thinkingSuffixOptions,
    );
    const model = applyThinkingSuffix(
      primaryModel,
      effectiveThinking,
      false,
      thinkingSuffixOptions,
    );
    const primaryThinkingDropped = Boolean(
      getThinkingLevelDropNote(primaryModel, effectiveThinking, false, thinkingSuffixOptions),
    );
    const modelIdentity = canonicalSubagentModelIdentity(
      model,
      primaryThinkingDropped ? undefined : resolveEffectiveThinking(model, effectiveThinking),
    );
    const modelThinking =
      modelIdentity?.thinking ??
      (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
    const candidatePlan = buildModelCandidatePlan(
      primaryModel,
      fallbackModels,
      availableModels,
      ctx.currentModelProvider,
      { scope: ctx.modelScope, registry: params.modelRegistry },
    );
    const modelCandidates = candidatePlan.candidates
      .map((candidate) => {
        appendThinkingDropNote(
          attemptNotes,
          thinkingDroppedModels,
          candidate,
          effectiveThinking,
          thinkingSuffixOptions,
        );
        return applyThinkingSuffix(candidate, effectiveThinking, false, thinkingSuffixOptions);
      })
      .filter((candidate): candidate is string => candidate !== undefined);
    const projectAgent = params.projectAgentCaptures?.find(
      (capture) => capture.provenance.agent === taskSpec.agent,
    );
    return {
      parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
      ...(projectAgent ? { projectAgent } : {}),
      agent: taskSpec.agent,
      projectAgentGuidance: isCanonicalPackagedMinorAgent(agent),
      task,
      cwd: stepCwd,
      model,
      thinking: modelThinking,
      ...(modelIdentity ? { modelIdentity } : {}),
      modelCandidates,
      contextWindows: Object.fromEntries(
        (availableModels ?? [])
          .filter(
            (candidate) =>
              typeof candidate.contextWindow === "number" && candidate.contextWindow > 0,
          )
          .map((candidate) => [candidate.fullId, candidate.contextWindow!]),
      ),
      ...(attemptNotes.length > 0 ? { attemptNotes } : {}),
      ...(thinkingDroppedModels.length > 0 ? { thinkingDroppedModels } : {}),
      ...(candidatePlan.filteringNotice
        ? { modelFallbackFilterNotice: candidatePlan.filteringNotice }
        : {}),
      modelFallbackNotice: behavior.modelFallbackNotice,
      tools: agent.tools,
      extensions: agent.extensions,
      subagentOnlyExtensions: agent.subagentOnlyExtensions,
      completionGuard: agent.completionGuard,
      supervisorBridge: agent.supervisorBridge,
      systemPrompt,
      systemPromptMode: agent.systemPromptMode,
      inheritProjectContext: agent.inheritProjectContext,
      inheritSkills: agent.inheritSkills,
      skills: resolvedSkills.map((resolved) => resolved.name),
      outputPath,
      outputMode: behavior.outputMode,
      sessionFile,
      maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agent.maxSubagentDepth),
      effectiveAcceptance: resolveEffectiveAcceptance({
        explicit: taskSpec.acceptance,
        agentName: taskSpec.agent,
        acceptanceRole: agent.acceptanceRole,
        task,
        mode: "parallel",
        async: true,
      }),
      acceptanceInput: taskSpec.acceptance,
      acceptanceRole: agent.acceptanceRole,
      ...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
      ...(agent.maxExecutionTimeMs !== undefined &&
      (params.timeoutMs === undefined || agent.maxExecutionTimeMs < params.timeoutMs)
        ? { timeoutMs: agent.maxExecutionTimeMs }
        : {}),
    };
  };

  const progressBehaviors = tasks.map((task) => {
    const agent = agents.find((candidate) => candidate.name === task.agent)!;
    return suppressProgressForReadOnlyTask(
      resolveStepBehavior(agent, buildStepOverrides(task)),
      task.task,
    );
  });
  const progressPrecreated = progressBehaviors.some((behavior) => behavior.progress);
  if (progressPrecreated) {
    writeInitialProgressFile(progressDir);
    progressInstructionCreated = true;
  }

  let flatStepIndex = 0;
  let builtTasks: RunnerSubagentStep[];
  try {
    builtTasks = tasks.map((task, index) => {
      const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex++];
      return buildTask(task, sessionFile, progressPrecreated, progressBehaviors[index]);
    });
  } catch (error) {
    if (
      error instanceof UnavailableSubagentSkillError ||
      error instanceof AsyncStartValidationError
    ) {
      return { error: error.message };
    }
    throw error;
  }
  const directTasks = dedupeRunnerTaskAttemptNotes(builtTasks);
  const plan: SubagentRunPlan = {
    kind: "parallel",
    tasks: directTasks,
    ...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
  };
  return { plan, runnerCwd };
}

/**
 * Execute a direct parallel batch asynchronously.
 */
export function executeAsyncParallel(
  id: string,
  params: AsyncParallelParams,
): AsyncExecutionResult {
  const {
    tasks,
    agents,
    ctx,
    cwd,
    maxOutput,
    artifactsDir,
    artifactConfig,
    shareEnabled,
    sessionRoot,
    sessionFilesByFlatIndex,
    maxSubagentDepth,
    controlConfig,
    nestedRoute,
  } = params;
  const acceptanceErrors = validateAsyncExecutionAcceptance({ tasks });
  if (acceptanceErrors.length > 0)
    return formatAsyncStartError("parallel", acceptanceErrors.join(" "));
  const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
  const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
  const asyncDir = inheritedNestedRoute
    ? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
    : path.join(ASYNC_DIR, id);
  try {
    fs.mkdirSync(asyncDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` },
      ],
      isError: true,
      details: { mode: "parallel", results: [] },
    };
  }

  let built: AsyncRunnerPlanBuildResult | { error: string };
  try {
    built = buildAsyncRunnerPlan(id, {
      tasks,
      concurrency: params.concurrency,
      agents,
      ctx,
      availableModels: params.availableModels,
      modelRegistry: params.modelRegistry,
      cwd,
      artifactsDir,
      artifactConfig,
      shareEnabled,
      sessionFilesByFlatIndex,
      progressDir:
        params.progressDir ??
        (artifactsDir ? path.join(artifactsDir, "progress", id) : path.join(asyncDir, "progress")),
      maxSubagentDepth,
      timeoutMs: params.timeoutMs,
      toolBudget: params.toolBudget,
      projectAgentCaptures: params.projectAgentCaptures,
    });
  } catch (error) {
    try {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for validation failures before the runner is spawned.
    }
    return formatAsyncStartError(
      "parallel",
      error instanceof Error ? error.message : String(error),
    );
  }
  if ("error" in built) {
    try {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for validation failures before the runner is spawned.
    }
    return formatAsyncStartError("parallel", built.error);
  }
  const { plan, runnerCwd } = built;
  const tkTicketContext = resolveTkTicketTaskContext({
    runnerCwd,
    tasks: tasks.map((task) => ({ agent: task.agent, task: task.task ?? "", cwd: task.cwd })),
  });
  const tkTicket = tkTicketContext
    ? resolveTkTicketMetadata(tkTicketContext.task, { cwd: tkTicketContext.cwd })
    : undefined;
  const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
  const projectAgents = [
    ...new Map(
      params.projectAgentCaptures?.map((capture) => [capture.provenance.agent, capture]) ?? [],
    ).values(),
  ];
  const flatAgents = plan.kind === "parallel" ? plan.tasks.map((task) => task.agent) : [];
  const firstTask = plan.kind === "parallel" ? plan.tasks[0] : undefined;

  let spawnResult: { pid?: number; error?: string };
  try {
    spawnResult = spawnRunner(
      {
        id,
        plan,
        resultPath: inheritedNestedRoute
          ? nestedResultsPath(inheritedNestedRoute.rootRunId, id)
          : path.join(RESULTS_DIR, `${id}.json`),
        cwd: runnerCwd,
        maxOutput,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        share: shareEnabled,
        sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
        asyncDir,
        sessionId: ctx.currentSessionId,
        piPackageRoot,
        piArgv1: process.argv[1],
        controlConfig,
        toolBudget: params.toolBudget,
        timeoutMs: params.timeoutMs,
        deadlineAt,
        tkTicket,
        nestedRoute: nestedRoute ?? inheritedNestedRoute,
        ...(projectAgents.length > 0 ? { projectAgents } : {}),
        nestedSelf:
          inheritedNestedRoute && nestedAddress
            ? {
                parentRunId: nestedAddress.parentRunId,
                parentStepIndex: nestedAddress.parentStepIndex,
                depth: nestedAddress.depth,
                path: nestedAddress.path,
              }
            : undefined,
      },
      id,
      runnerCwd,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatAsyncStartError("parallel", `Failed to start async parallel '${id}': ${message}`);
  }

  if (spawnResult.error) {
    return formatAsyncStartError(
      "parallel",
      `Failed to start async parallel '${id}': ${spawnResult.error}`,
    );
  }

  if (spawnResult.pid) {
    if (inheritedNestedRoute && nestedAddress) {
      const now = Date.now();
      try {
        writeNestedEvent(inheritedNestedRoute, {
          type: "subagent.nested.started",
          ts: now,
          parentRunId: nestedAddress.parentRunId,
          parentStepIndex: nestedAddress.parentStepIndex,
          child: {
            id,
            parentRunId: nestedAddress.parentRunId,
            parentStepIndex: nestedAddress.parentStepIndex,
            depth: nestedAddress.depth,
            path: nestedAddress.path,
            cwd: runnerCwd,
            asyncDir,
            pid: spawnResult.pid,
            ownerState: "live",
            mode: "parallel",
            state: "running",
            agent: firstTask?.agent,
            agents: flatAgents,
            ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
            startedAt: now,
            lastUpdate: now,
          },
        });
      } catch (error) {
        console.error("Failed to emit nested async start event:", error);
      }
    }
    ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      id,
      pid: spawnResult.pid,
      sessionId: ctx.currentSessionId,
      mode: "parallel",
      agent: firstTask?.agent,
      agents: flatAgents,
      task: firstTask?.task?.slice(0, 50),
      cwd: runnerCwd,
      asyncDir,
      ...(tkTicket ? { tkTicket } : {}),
      ...(projectAgents.length > 0 ? { projectAgents } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
      nestedRoute,
    });
  }

  return {
    content: [
      {
        type: "text",
        text: formatAsyncStartedMessage(`Async parallel: [${flatAgents.join("+")}] [${id}]`),
      },
    ],
    details: {
      mode: "parallel",
      runId: id,
      results: [],
      asyncId: id,
      asyncDir,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
      ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}),
    },
  };
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(id: string, params: AsyncSingleParams): AsyncExecutionResult {
  const {
    agent,
    agentConfig,
    ctx,
    cwd,
    maxOutput,
    artifactsDir,
    artifactConfig,
    shareEnabled,
    sessionRoot,
    sessionFile,
    maxSubagentDepth,
    controlConfig,
    nestedRoute,
  } = params;
  const task = params.task ?? "";
  const acceptanceErrors = validateAsyncExecutionAcceptance({ acceptance: params.acceptance });
  if (acceptanceErrors.length > 0)
    return formatAsyncStartError("single", acceptanceErrors.join(" "));
  const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
  const skillNames = params.skills ?? agentConfig.skills ?? [];
  const availableModels = params.availableModels;
  const thinkingSuffixOptions = {
    availableModels,
    preferredModelProvider: ctx.currentModelProvider,
  };
  const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
    skillNames,
    runnerCwd,
    ctx.cwd,
  );
  if (missingSkills.includes("pi-subagents"))
    return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
  const toolPolicyError = validatePiToolPolicy({
    tools: agentConfig.tools,
    requireReadTool: agentConfig.inheritSkills || resolvedSkills.length > 0,
  });
  if (toolPolicyError) return formatAsyncStartError("single", toolPolicyError);
  let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
  if (resolvedSkills.length > 0) {
    const injection = buildSkillInjection(resolvedSkills);
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
  }

  const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
  const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
  const asyncDir = inheritedNestedRoute
    ? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
    : path.join(ASYNC_DIR, id);
  try {
    fs.mkdirSync(asyncDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        { type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` },
      ],
      isError: true,
      details: { mode: "single" as const, results: [] },
    };
  }

  const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
  const outputPath = resolveSingleOutputPath(
    effectiveOutput,
    ctx.cwd,
    runnerCwd,
    params.outputBaseDir ?? (artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined),
  );
  systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath);
  const outputMode = params.outputMode ?? "inline";
  const validationError = validateFileOnlyOutputMode(
    outputMode,
    outputPath,
    `Async single run (${agent})`,
  );
  if (validationError) return formatAsyncStartError("single", validationError);
  const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
  const durableResume =
    params.modelResolution !== undefined || params.restoredModelIdentity !== undefined;
  const explicitResumeModel =
    durableResume && typeof params.modelOverride === "string" && params.modelOverride.trim() !== ""
      ? params.modelOverride.trim() !== "inherit"
      : false;
  const restoringModel = Boolean(
    durableResume && !explicitResumeModel && params.restoredModelIdentity,
  );
  const requestedPrimaryModel = restoringModel
    ? modelReferenceFromIdentity(params.restoredModelIdentity!)
    : (params.modelOverride ?? agentConfig.model);
  const scopeWarnings: string[] = [];
  const primaryModel = resolveSubagentModelOverride(
    requestedPrimaryModel,
    ctx.currentModel,
    availableModels,
    ctx.currentModelProvider,
    durableResume
      ? {
          scope: ctx.modelScope,
          source: explicitResumeModel ? "explicit" : "inherited",
          onWarn: (violation) => scopeWarnings.push(violation.message),
        }
      : undefined,
  );
  const fallbackModels = buildFallbackModelList(
    params.providerFallbackModels,
    agentConfig.fallbackModels,
  );
  const effectiveThinking = restoringModel
    ? params.restoredModelIdentity?.thinking
    : agentConfig.thinking;
  const attemptNotes: string[] = [];
  const thinkingDroppedModels: string[] = [];
  const primaryThinkingDropped = Boolean(
    getThinkingLevelDropNote(primaryModel, effectiveThinking, false, thinkingSuffixOptions),
  );
  appendThinkingDropNote(
    attemptNotes,
    thinkingDroppedModels,
    primaryModel,
    effectiveThinking,
    thinkingSuffixOptions,
  );
  const model = applyThinkingSuffix(primaryModel, effectiveThinking, false, thinkingSuffixOptions);
  if (
    restoringModel &&
    availableModels &&
    availableModels.length > 0 &&
    params.restoredModelIdentity &&
    !availableModels.some((candidate) => candidate.fullId === primaryModel)
  ) {
    attemptNotes.push(
      `Notice: Persisted model '${modelReferenceFromIdentity(params.restoredModelIdentity)}' was not present in the current model registry; retaining it so configured runtime fallback policy can apply.`,
    );
  }
  const modelIdentity = canonicalSubagentModelIdentity(
    model,
    primaryThinkingDropped ? undefined : resolveEffectiveThinking(model, effectiveThinking),
  );
  const candidatePlan = buildModelCandidatePlan(
    primaryModel,
    fallbackModels,
    availableModels,
    ctx.currentModelProvider,
    {
      scope: ctx.modelScope,
      registry: params.modelRegistry,
      ...(durableResume ? { onWarn: (violation) => scopeWarnings.push(violation.message) } : {}),
    },
  );
  const modelCandidates = candidatePlan.candidates
    .map((candidate) => {
      appendThinkingDropNote(
        attemptNotes,
        thinkingDroppedModels,
        candidate,
        effectiveThinking,
        thinkingSuffixOptions,
      );
      return applyThinkingSuffix(candidate, effectiveThinking, false, thinkingSuffixOptions);
    })
    .filter((candidate): candidate is string => candidate !== undefined);
  const modelThinking =
    modelIdentity?.thinking ??
    (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
  const modelResolution = params.modelResolution
    ? {
        ...params.modelResolution,
        ...(modelIdentity ? { resumed: modelIdentity } : {}),
        reason: [params.modelResolution.reason, ...scopeWarnings, ...attemptNotes].join(" "),
      }
    : undefined;
  const toolBudgetInput = params.toolBudget ?? agentConfig.toolBudget;
  const resolvedToolBudget = validateToolBudgetConfig(
    toolBudgetInput,
    params.toolBudget ? "toolBudget" : "agent.toolBudget",
  );
  if (resolvedToolBudget.error) return formatAsyncStartError("single", resolvedToolBudget.error);
  const activeRuntimeMs = Math.max(0, params.activeRuntimeMs ?? 0);
  const remainingAgentTimeMs = remainingExecutionTimeMs(
    agentConfig.maxExecutionTimeMs,
    activeRuntimeMs,
  );
  if (remainingAgentTimeMs === 0) {
    return formatAsyncStartError(
      "single",
      `Agent '${agent}' has exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms of active runtime.`,
    );
  }
  const effectiveTimeoutMs = resolveEffectiveSingleTimeout(params.timeoutMs, remainingAgentTimeMs);
  const deadlineAt = effectiveTimeoutMs !== undefined ? Date.now() + effectiveTimeoutMs : undefined;
  const tkTicket = detectTkTicketId(task)
    ? resolveTkTicketMetadata(task, { cwd: runnerCwd })
    : normalizeTkTicketMetadata(params.inheritedTkTicket);
  let spawnResult: { pid?: number; error?: string };
  try {
    spawnResult = spawnRunner(
      {
        id,
        plan: {
          kind: "single",
          task: {
            parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
            ...(params.projectAgent ? { projectAgent: params.projectAgent } : {}),
            agent,
            projectAgentGuidance: isCanonicalPackagedMinorAgent(agentConfig),
            task: taskWithOutputInstruction,
            cwd: runnerCwd,
            model,
            thinking: modelThinking,
            ...(modelIdentity ? { modelIdentity } : {}),
            ...(modelResolution ? { modelResolution } : {}),
            modelCandidates,
            contextWindows: Object.fromEntries(
              (availableModels ?? [])
                .filter(
                  (candidate) =>
                    typeof candidate.contextWindow === "number" && candidate.contextWindow > 0,
                )
                .map((candidate) => [candidate.fullId, candidate.contextWindow!]),
            ),
            ...(attemptNotes.length > 0 ? { attemptNotes } : {}),
            ...(thinkingDroppedModels.length > 0 ? { thinkingDroppedModels } : {}),
            ...(candidatePlan.filteringNotice
              ? { modelFallbackFilterNotice: candidatePlan.filteringNotice }
              : {}),
            modelFallbackNotice: params.modelFallbackNotice,
            tools: agentConfig.tools,
            extensions: agentConfig.extensions,
            subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
            completionGuard: agentConfig.completionGuard,
            supervisorBridge: agentConfig.supervisorBridge,
            systemPrompt,
            systemPromptMode: agentConfig.systemPromptMode,
            inheritProjectContext: agentConfig.inheritProjectContext,
            inheritSkills: agentConfig.inheritSkills,
            skills: resolvedSkills.map((r) => r.name),
            outputPath,
            outputMode,
            sessionFile,
            ...(parseContextUsageDiagnostics(params.contextUsage)
              ? { contextUsage: parseContextUsageDiagnostics(params.contextUsage) }
              : {}),
            ...(parseContextPressureProjection(params.contextPressure)
              ? { contextPressure: parseContextPressureProjection(params.contextPressure) }
              : {}),
            // Lifecycle-aware callers omit both pressure fields for a newly
            // created continuation. Same-segment revivals restore the latest
            // display projection separately from machine deduplication history.
            ...(parseContextPressureCrossedThresholds(params.contextPressureCrossedThresholds)
              ? {
                  contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
                    params.contextPressureCrossedThresholds,
                  ),
                }
              : {}),
            maxSubagentDepth: resolveChildMaxSubagentDepth(
              maxSubagentDepth,
              agentConfig.maxSubagentDepth,
            ),
            effectiveAcceptance: params.continuationAcceptance
              ? (mergeContinuationAcceptance(params.continuationAcceptance, params.acceptance) ??
                params.continuationAcceptance)
              : resolveEffectiveAcceptance({
                  explicit: params.acceptance,
                  agentName: agent,
                  acceptanceRole: agentConfig.acceptanceRole,
                  task,
                  mode: "single",
                  async: true,
                }),
            ...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
            ...(activeRuntimeMs > 0 ? { activeRuntimeMs } : {}),
          },
        },
        resultPath: inheritedNestedRoute
          ? nestedResultsPath(inheritedNestedRoute.rootRunId, id)
          : path.join(RESULTS_DIR, `${id}.json`),
        cwd: runnerCwd,
        maxOutput,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        share: shareEnabled,
        sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
        asyncDir,
        sessionId: ctx.currentSessionId,
        piPackageRoot,
        piArgv1: process.argv[1],
        controlConfig,
        timeoutMs: effectiveTimeoutMs,
        deadlineAt,
        toolBudget: params.toolBudget,
        tkTicket,
        ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
        ...(params.continuationSource ? { continuationSource: params.continuationSource } : {}),
        nestedRoute: nestedRoute ?? inheritedNestedRoute,
        nestedSelf:
          inheritedNestedRoute && nestedAddress
            ? {
                parentRunId: nestedAddress.parentRunId,
                parentStepIndex: nestedAddress.parentStepIndex,
                depth: nestedAddress.depth,
                path: nestedAddress.path,
              }
            : undefined,
      },
      id,
      runnerCwd,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
  }

  if (spawnResult.error) {
    return formatAsyncStartError(
      "single",
      `Failed to start async run '${id}': ${spawnResult.error}`,
    );
  }

  if (spawnResult.pid) {
    if (inheritedNestedRoute && nestedAddress) {
      const now = Date.now();
      try {
        writeNestedEvent(inheritedNestedRoute, {
          type: "subagent.nested.started",
          ts: now,
          parentRunId: nestedAddress.parentRunId,
          parentStepIndex: nestedAddress.parentStepIndex,
          child: {
            id,
            parentRunId: nestedAddress.parentRunId,
            parentStepIndex: nestedAddress.parentStepIndex,
            depth: nestedAddress.depth,
            path: nestedAddress.path,
            cwd: runnerCwd,
            asyncDir,
            pid: spawnResult.pid,
            ownerState: "live",
            mode: "single",
            state: "running",
            agent,
            agents: [agent],
            ...(effectiveTimeoutMs !== undefined
              ? { timeoutMs: effectiveTimeoutMs, deadlineAt }
              : {}),
            startedAt: now,
            lastUpdate: now,
          },
        });
      } catch (error) {
        console.error("Failed to emit nested async start event:", error);
      }
    }
    ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      id,
      pid: spawnResult.pid,
      sessionId: ctx.currentSessionId,
      mode: "single",
      agent,
      task: task?.slice(0, 50),
      cwd: runnerCwd,
      asyncDir,
      ...(tkTicket ? { tkTicket } : {}),
      ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
      ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs, deadlineAt } : {}),
      nestedRoute,
    });
  }

  return {
    content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
    details: {
      mode: "single",
      runId: id,
      results: [],
      asyncId: id,
      asyncDir,
      ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs, deadlineAt } : {}),
      ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}),
    },
  };
}
