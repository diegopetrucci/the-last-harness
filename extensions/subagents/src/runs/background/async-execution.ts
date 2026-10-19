/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ProjectAgentIdentity } from "../../agents/project-agent-loader.ts";
import type { SubagentRunConfig } from "../shared/parallel-utils.ts";
import {
  applyThinkingSuffix,
  validatePiToolPolicy,
  retiredNestedLaunchError,
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
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
} from "../shared/active-runtime.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, resolveChildCwd } from "../../shared/utils.ts";
import {
  buildFallbackModelList,
  buildModelCandidatePlan,
  canonicalSubagentModelIdentity,
  deduplicateModelCandidates,
  modelReferenceFromIdentity,
  resolveSubagentModelOverride,
  type ParentModel,
} from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import {
  contextWindowsForChildModels,
  resolveEffectiveThinking,
  type ModelInfo,
} from "../../shared/model-info.ts";
import {
  type OutputMode,
  type ResolvedArtifactConfig,
  type ContextPressureProjection,
  type ContextUsageDiagnostics,
  type Details,
  type MaxOutputConfig,
  type ResolvedControlConfig,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentRunMode,
  type SubagentTerminalResult,
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
  TEMP_ROOT_DIR,
  getAsyncConfigPath,
  resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import {
  buildSubagentRunTelemetry,
  type SubagentRunTelemetry,
  type SubagentTelemetryLineage,
  type SubagentTelemetryProvenance,
} from "../../shared/telemetry.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
} from "../../shared/context-diagnostics.ts";
import { normalizeTicketId, readTicketBody, ticketLookupKey } from "../shared/ticket-context.ts";
import { isCanonicalPackagedMinorAgent } from "../../../../shared/project-agent-guidance.ts";
import {
  captureChildLocationSnapshot,
  makeParentGitFactsAccessor,
  type ChildLocationSnapshot,
} from "../../shared/child-location.ts";
import { createAwaitedRunOwner, type AwaitedRunResult } from "./awaited-run-owner.ts";
import {
  createOwnedProcessGroupOwner,
  type OwnedProcessGroupOwner,
} from "../shared/process-group-cleanup.ts";

const piPackageRoot = resolvePiPackageRoot();

interface AsyncExecutionContext {
  pi: ExtensionAPI;
  cwd: string;
  currentSessionId: string;
  /** Parent session id used by permission-system ask forwarding. */
  parentSessionId?: string;
  currentModel?: ParentModel;
  /** Optional model-scope enforcement resolved from subagent settings. */
  modelScope?: ModelScopeConfig;
}

interface AsyncSingleParams {
  /** Internal-only opt-in; public schemas intentionally do not expose this. */
  awaited?: boolean;
  signal?: AbortSignal;
  onUpdate?: (result: AwaitedRunResult) => void;
  agent: string;
  task?: string;
  telemetryProvenance?: SubagentTelemetryProvenance;
  telemetryLineage?: SubagentTelemetryLineage;
  agentConfig: AgentConfig;
  ctx: AsyncExecutionContext;
  cwd?: string;
  continuationSource?: {
    asyncDir: string;
    runId: string;
    index: number;
    claimToken: string;
    projectAgent?: ProjectAgentIdentity;
  };
  /** Explicit ticket assignment; normalized by the model-facing boundary. */
  ticket?: string;
  /** Ticket body prepared by the parent dispatch, when available. */
  ticketBody?: string;
  /** Persisted ticket identity for a continuation; intentionally does not re-read the body. */
  ticketId?: string;
  /** Exact approved project-agent config/provenance for this child. */
  projectAgent?: ProjectAgentIdentity;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig: ResolvedArtifactConfig;
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
  availableModels?: ModelInfo[];
  maxSubagentDepth: number;
  controlConfig?: ResolvedControlConfig;
  /** Prior persisted facts retained when this invocation revives a child. */
  priorTerminalResult?: SubagentTerminalResult;
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
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
  /** Explicit ticket assignment; normalized by the model-facing boundary. */
  ticket?: string;
}

interface AsyncParallelParams {
  /** Internal-only opt-in; public schemas intentionally do not expose this. */
  awaited?: boolean;
  signal?: AbortSignal;
  onUpdate?: (result: AwaitedRunResult) => void;
  tasks: AsyncParallelTaskParams[];
  telemetryProvenance?: SubagentTelemetryProvenance;
  telemetryLineage?: SubagentTelemetryLineage;
  concurrency?: number;
  agents: AgentConfig[];
  ctx: AsyncExecutionContext;
  availableModels?: ModelInfo[];
  cwd?: string;
  maxOutput?: MaxOutputConfig;
  artifactsDir?: string;
  artifactConfig: ResolvedArtifactConfig;
  sessionRoot?: string;
  sessionFilesByFlatIndex?: (string | undefined)[];
  progressDir?: string;
  maxSubagentDepth: number;
  controlConfig?: ResolvedControlConfig;
  /** Exact approved project-agent captures for detached runner tasks. */
  projectAgentIdentities?: readonly ProjectAgentIdentity[];
  /** Ticket bodies prepared once by the parent dispatch, keyed by cwd and ID. */
  ticketBodies?: ReadonlyMap<string, string>;
}

/** The narrow config portion consumed when resolving detached-runner log paths. */
interface AsyncRunnerLogPathConfig {
  asyncDir?: string;
}

/** Keep persisted absolute deadlines safe without capping the configured duration. */
function saturatingAsyncDeadlineAt(startedAt: number, durationMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, startedAt + durationMs);
}

export function formatAsyncStartedMessage(headline: string): string {
  return headline;
}

/**
 * Resolve a named runner module alongside a given source module.
 * The runner extension (.ts or .js) matches the referencing module so that
 * source loaders pick up TypeScript and generated runtime picks up JavaScript.
 */
export function resolveRunnerModulePath(moduleUrl: string, runnerName: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const runnerExtension = path.extname(modulePath) === ".ts" ? ".ts" : ".js";
  return path.join(path.dirname(modulePath), `${runnerName}${runnerExtension}`);
}

/**
 * Resolve the Node executable suitable for spawning a detached runner.
 * Prefers the current process executable when it is a Node binary and accessible.
 */
export function resolveRunnerNodeCommand(): string {
  if (isNodeExecutableName(process.execPath) && canUseCurrentNodeExecutable(process.execPath)) {
    return process.execPath;
  }
  return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * Resolve the detached async subagent runner beside this module. Source modules
 * use the TypeScript runner for development/test loaders; generated runtime
 * modules always resolve the committed JavaScript runner.
 */
function resolveAsyncRunnerModulePath(moduleUrl: string = import.meta.url): string {
  return resolveRunnerModulePath(moduleUrl, "subagent-runner");
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
): { pid?: number; error?: string; ownership?: OwnedProcessGroupOwner } {
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
  const nodeCommand = resolveRunnerNodeCommand();
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
    const ownership = createOwnedProcessGroupOwner(proc);
    if (ownership) {
      const observedPid = proc.pid;
      const observeExit = () => ownership.observeExit(observedPid);
      proc.once("exit", observeExit);
      proc.once("close", observeExit);
    }
    proc.unref();
    return { pid: proc.pid, ...(ownership ? { ownership } : {}) };
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

type AsyncSingleRuntimePolicy =
  | {
      activeRuntimeMs: number;
      activeRuntimeCheckpointAt?: number;
      /** Remaining active-time budget for this launch, shown in status details. */
      effectiveTimeoutMs?: number;
      /** Full per-instance role budget carried in the plan; consumption is subtracted by the runner. */
      roleBudgetMs?: number;
      timeoutOwner?: "role";
      effectiveDeadlineAt?: number;
    }
  | { error: string };

function resolveAsyncSingleRuntimePolicy(
  agent: string,
  params: Pick<AsyncSingleParams, "activeRuntimeMs" | "activeRuntimeCheckpointAt" | "agentConfig">,
): AsyncSingleRuntimePolicy {
  const normalizedActiveRuntimeMs = normalizeActiveRuntimeMs(params.activeRuntimeMs);
  if (params.activeRuntimeMs !== undefined && normalizedActiveRuntimeMs === undefined) {
    return { error: "Invalid active runtime evidence; continuation cannot start." };
  }
  const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    params.activeRuntimeCheckpointAt,
  );
  if (params.activeRuntimeCheckpointAt !== undefined && activeRuntimeCheckpointAt === undefined) {
    return { error: "Invalid active runtime checkpoint; continuation cannot start." };
  }
  const activeRuntimeMs = normalizedActiveRuntimeMs ?? 0;
  const remainingAgentTimeMs = remainingExecutionTimeMs(
    params.agentConfig.maxExecutionTimeMs,
    activeRuntimeMs,
  );
  if (remainingAgentTimeMs === 0) {
    return {
      error: `Agent '${agent}' has exhausted its maxExecutionTimeMs budget after ${activeRuntimeMs}ms of active runtime.`,
    };
  }
  const effectiveDeadlineAt =
    remainingAgentTimeMs !== undefined
      ? saturatingAsyncDeadlineAt(Date.now(), remainingAgentTimeMs)
      : undefined;
  return {
    activeRuntimeMs,
    ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
    ...(remainingAgentTimeMs !== undefined
      ? {
          effectiveTimeoutMs: remainingAgentTimeMs,
          roleBudgetMs: params.agentConfig.maxExecutionTimeMs,
          timeoutOwner: "role" as const,
        }
      : {}),
    ...(effectiveDeadlineAt !== undefined ? { effectiveDeadlineAt } : {}),
  };
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

interface AsyncRunnerPlanBuildResult {
  plan: Extract<SubagentRunPlan, { kind: "parallel" }>;
  runnerCwd: string;
}

type AsyncParallelPlanParams = Omit<AsyncParallelParams, "artifactConfig"> & {
  /** New plans always carry the trusted parent's fully resolved artifact policy. */
  artifactConfig: ResolvedArtifactConfig;
};

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
  const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
  const preparedTicketBodies = params.ticketBodies;
  const localTicketLookups = new Map<string, ReturnType<typeof readTicketBody>>();
  const resolveTicket = (ticketId: string, stepCwd: string): ReturnType<typeof readTicketBody> => {
    const normalized = normalizeTicketId(ticketId, "ticket");
    if (!normalized.ticketId) {
      return { ticketId, error: normalized.error ?? "ticket is invalid." };
    }
    const normalizedTicketId = normalized.ticketId;
    const key = ticketLookupKey(stepCwd, normalizedTicketId);
    if (preparedTicketBodies) {
      const body = preparedTicketBodies.get(key);
      return body === undefined
        ? {
            ticketId: normalizedTicketId,
            error: `Unable to load ticket '${normalizedTicketId}' in '${stepCwd}': ticket body was not prepared.`,
          }
        : { ticketId: normalizedTicketId, body };
    }
    const cached = localTicketLookups.get(key);
    if (cached) return cached;
    const result = readTicketBody(normalizedTicketId, stepCwd, "ticket");
    localTicketLookups.set(key, result);
    return result;
  };
  const progressDir = params.progressDir ?? runnerCwd;

  for (const task of tasks) {
    if (!agents.find((candidate) => candidate.name === task.agent)) {
      return { error: `Unknown agent: ${task.agent}` };
    }
  }

  // Create a lazy memoizing accessor for parent git facts. The accessor is
  // only invoked when a child cwd actually differs from the parent, so in the
  // common case (all tasks share the parent cwd) zero git work is done. When
  // multiple tasks do differ, the parent lookup runs exactly once.
  const asyncParentFacts = makeParentGitFactsAccessor(ctx.cwd);

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
    precomputedChildLocation?: ChildLocationSnapshot,
  ): RunnerSubagentStep => {
    const agent = agents.find((candidate) => candidate.name === taskSpec.agent)!;
    const stepCwd = resolveChildCwd(runnerCwd, taskSpec.cwd);
    const ticket =
      taskSpec.ticket === undefined ? undefined : resolveTicket(taskSpec.ticket, stepCwd);
    if (ticket?.error) throw new AsyncStartValidationError(ticket.error);
    // Prefer the pre-computed snapshot (parent git invoked once per dispatch);
    // fall back to a fresh capture when called outside the tasks.map loop.
    const childLocation =
      precomputedChildLocation !== undefined
        ? precomputedChildLocation
        : captureChildLocationSnapshot(ctx.cwd, stepCwd, undefined, asyncParentFacts);
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
    const primaryModel = resolveSubagentModelOverride(requestedModel, ctx.currentModel, {
      scope: ctx.modelScope,
      source: behavior.model ? "explicit" : "inherited",
    });
    const fallbackModels = buildFallbackModelList(
      taskSpec.providerFallbackModels,
      agent.fallbackModels,
    );
    const effectiveThinking = agent.thinking;
    const model = applyThinkingSuffix(primaryModel, effectiveThinking);
    const modelIdentity = canonicalSubagentModelIdentity(
      model,
      resolveEffectiveThinking(model, effectiveThinking),
    );
    const modelThinking =
      modelIdentity?.thinking ??
      (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
    const candidatePlan = buildModelCandidatePlan(primaryModel, fallbackModels, {
      scope: ctx.modelScope,
    });
    const modelCandidates = deduplicateModelCandidates(
      candidatePlan.candidates
        .map((candidate) => applyThinkingSuffix(candidate, effectiveThinking))
        .filter((candidate): candidate is string => candidate !== undefined),
    );
    const projectAgent =
      params.projectAgentIdentities?.find(
        (identity) => `embedded.${identity.slug}` === taskSpec.agent && identity.cwd === stepCwd,
      ) ??
      params.projectAgentIdentities?.find(
        (identity) => `embedded.${identity.slug}` === taskSpec.agent,
      );
    return {
      parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
      ...(projectAgent ? { projectAgent } : {}),
      ...(ticket?.ticketId ? { ticketId: ticket.ticketId } : {}),
      ...(ticket?.body !== undefined ? { ticketBody: ticket.body } : {}),
      agent: taskSpec.agent,
      projectAgentGuidance: isCanonicalPackagedMinorAgent(agent),
      task,
      cwd: stepCwd,
      model,
      thinking: modelThinking,
      ...(modelIdentity ? { modelIdentity } : {}),
      modelCandidates,
      contextWindows: contextWindowsForChildModels(availableModels, {
        canonicalDeveloper: agent.name === "developer" && isCanonicalPackagedMinorAgent(agent),
      }),
      modelFallbackNotice: behavior.modelFallbackNotice,
      tools: agent.tools,
      extensions: agent.extensions,
      subagentOnlyExtensions: agent.subagentOnlyExtensions,
      supervisorBridge: agent.supervisorBridge,
      systemPrompt,
      systemPromptMode: agent.systemPromptMode,
      inheritProjectContext: agent.inheritProjectContext,
      inheritSkills: agent.inheritSkills,
      skills: resolvedSkills.map((resolved) => resolved.name),
      ...(missingSkills.length > 0
        ? { skillsWarning: `Skills not found: ${missingSkills.join(", ")}` }
        : {}),
      outputPath,
      outputMode: behavior.outputMode,
      sessionFile,
      maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agent.maxSubagentDepth),
      // The role ceiling is trusted policy, not caller input. Persist it on
      // every new task so the runner can enforce it independently per child.
      ...(agent.maxExecutionTimeMs !== undefined
        ? { timeoutMs: agent.maxExecutionTimeMs, timeoutOwner: "role" as const }
        : {}),
      ...(childLocation ? { childLocation } : {}),
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

  // Precompute all child location snapshots in one pass. The shared accessor
  // ensures the parent git lookup runs at most once across all tasks.
  const asyncTaskSnapshots = tasks.map((taskSpec) => {
    const stepCwd = resolveChildCwd(runnerCwd, taskSpec.cwd);
    return captureChildLocationSnapshot(ctx.cwd, stepCwd, undefined, asyncParentFacts);
  });

  let flatStepIndex = 0;
  let builtTasks: RunnerSubagentStep[];
  try {
    builtTasks = tasks.map((task, index) => {
      const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex++];
      return buildTask(
        task,
        sessionFile,
        progressPrecreated,
        progressBehaviors[index],
        asyncTaskSnapshots[index],
      );
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
  const plan: SubagentRunPlan = {
    kind: "parallel",
    tasks: builtTasks,
    ...(params.concurrency !== undefined ? { concurrency: params.concurrency } : {}),
  };
  return { plan, runnerCwd };
}

function initialAsyncTelemetry(input: {
  id: string;
  execution?: import("../../shared/telemetry.ts").SubagentTelemetryExecution;
  mode: SubagentRunMode;
  plan: SubagentRunPlan;
  provenance?: SubagentTelemetryProvenance;
  controls?: ResolvedControlConfig;
  startedAt: number;
  lineage?: SubagentTelemetryLineage;
}): SubagentRunTelemetry | undefined {
  if (!input.provenance || !input.controls) return undefined;
  const planSteps = input.plan.kind === "single" ? [input.plan.task] : input.plan.tasks;
  return buildSubagentRunTelemetry({
    runId: input.id,
    execution: input.execution ?? "async",
    mode: input.mode,
    provenance: input.provenance,
    controls: input.controls,
    startedAt: input.startedAt,
    outcome: { state: "running" },
    lineage: input.lineage,
    steps: planSteps.map((step, index) => ({
      index,
      agent: step.agent,
      model: step.modelIdentity,
      outcome: { state: "queued" },
    })),
  });
}

/**
 * Execute a direct parallel batch asynchronously.
 */
export function executeAsyncParallel<T extends AsyncParallelParams>(
  id: string,
  params: T,
): AsyncExecutionResult | Promise<AwaitedRunResult> {
  const {
    tasks,
    agents,
    ctx,
    cwd,
    maxOutput,
    artifactsDir,
    artifactConfig,
    sessionRoot,
    sessionFilesByFlatIndex,
    maxSubagentDepth,
    controlConfig,
  } = params;
  const retiredNestedError = retiredNestedLaunchError(params);
  if (retiredNestedError) return formatAsyncStartError("parallel", retiredNestedError);
  const runStartedAt = Date.now();
  const asyncDir = path.join(ASYNC_DIR, id);
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
      cwd,
      artifactsDir,
      artifactConfig,
      sessionFilesByFlatIndex,
      progressDir:
        params.progressDir ??
        (artifactsDir ? path.join(artifactsDir, "progress", id) : path.join(asyncDir, "progress")),
      maxSubagentDepth,
      projectAgentIdentities: params.projectAgentIdentities,
      ticketBodies: params.ticketBodies,
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
  const telemetry = initialAsyncTelemetry({
    id,
    execution: params.awaited ? "foreground" : "async",
    mode: "parallel",
    plan,
    provenance: params.telemetryProvenance,
    controls: params.controlConfig,
    startedAt: runStartedAt,
    lineage: params.telemetryLineage,
  });
  const projectAgents = [
    ...new Map(
      params.projectAgentIdentities?.map((identity) => [
        `${identity.slug}\0${identity.root}\0${identity.cwd}`,
        identity,
      ]) ?? [],
    ).values(),
  ];
  const flatAgents = plan.kind === "parallel" ? plan.tasks.map((task) => task.agent) : [];
  const firstTask = plan.kind === "parallel" ? plan.tasks[0] : undefined;
  const resultPath = path.join(RESULTS_DIR, `${id}.json`);
  const awaitedOwner =
    params.awaited === true
      ? createAwaitedRunOwner({
          id,
          asyncDir,
          resultPath,
          mode: "parallel",
          plan,
          events: ctx.pi.events,
          sessionId: ctx.currentSessionId,
          cwd: runnerCwd,
          expectedGeneration: 0,
          signal: params.signal,
          onUpdate: params.onUpdate,
        })
      : undefined;

  if (awaitedOwner && params.signal?.aborted) {
    void awaitedOwner.cancel();
    return awaitedOwner.promise;
  }

  let spawnResult: { pid?: number; error?: string; ownership?: OwnedProcessGroupOwner };
  try {
    spawnResult = spawnRunner(
      {
        id,
        ...(params.awaited === true ? { awaited: true } : {}),
        ...(telemetry ? { telemetry } : {}),
        plan,
        resultPath: path.join(RESULTS_DIR, `${id}.json`),
        cwd: runnerCwd,
        maxOutput,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
        asyncDir,
        sessionId: ctx.currentSessionId,
        piPackageRoot,
        piArgv1: process.argv[1],
        controlConfig,
        ...(projectAgents.length > 0 ? { projectAgents } : {}),
      },
      id,
      runnerCwd,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return awaitedOwner
      ? awaitedOwner.fail(`Failed to start async parallel '${id}': ${message}`)
      : formatAsyncStartError("parallel", `Failed to start async parallel '${id}': ${message}`);
  }

  if (spawnResult.error) {
    const message = `Failed to start async parallel '${id}': ${spawnResult.error}`;
    return awaitedOwner ? awaitedOwner.fail(message) : formatAsyncStartError("parallel", message);
  }

  if (spawnResult.pid) {
    awaitedOwner?.markSpawned(spawnResult.pid, spawnResult.ownership);
    ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      id,
      pid: spawnResult.pid,
      sessionId: ctx.currentSessionId,
      mode: "parallel",
      agent: firstTask?.agent,
      ...(telemetry ? { telemetry } : {}),
      agents: flatAgents,
      task: firstTask?.task?.slice(0, 50),
      cwd: runnerCwd,
      asyncDir,
      ...(projectAgents.length > 0 ? { projectAgents } : {}),
    });
  }

  if (awaitedOwner) return awaitedOwner.promise;

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
      ...(telemetry ? { telemetry } : {}),
      asyncId: id,
      asyncDir,
    },
  };
}

/** @internal Exposed for unit tests; not a stable public API. */
export interface AsyncSingleRunnerPlanInputs {
  task: string;
  taskWithOutputInstruction: string;
  runnerCwd: string;
  systemPrompt: string;
  resolvedSkillNames: string[];
  skillsWarning?: string;
  outputPath?: string;
  outputMode: "inline" | "file-only";
  /** Dispatch-time child-location snapshot; absent when cwd matches parent. */
  childLocation?: import("../../shared/child-location.ts").ChildLocationSnapshot;
}

/** @internal Exposed for unit tests; not a stable public API. */
export interface AsyncSingleRunnerPlanBuildResult {
  buildPlan: () => Extract<SubagentRunPlan, { kind: "single" }>;
  effectiveTimeoutMs?: number;
  effectiveDeadlineAt?: number;
}

/**
 * Resolve the synchronous single-run plan before handing ownership to the
 * detached runner. This keeps model and runtime policy resolution in one
 * synchronous launch seam while leaving filesystem and lifecycle effects
 * with the caller.
 */
/** @internal Exposed for unit tests; not a stable public API. */
export function buildAsyncSingleRunnerPlan(
  params: AsyncSingleParams,
  inputs: AsyncSingleRunnerPlanInputs,
): AsyncSingleRunnerPlanBuildResult | { error: string } {
  const {
    agent,
    agentConfig,
    ctx,
    modelOverride,
    restoredModelIdentity,
    modelResolution: persistedModelResolution,
    availableModels,
    providerFallbackModels,
    modelFallbackNotice,
    contextUsage,
    contextPressure,
    contextPressureCrossedThresholds,
    priorTerminalResult,
    activeRuntimeMs,
    activeRuntimeCheckpointAt,
    projectAgent,
    sessionFile,
    maxSubagentDepth,
  } = params;
  const {
    taskWithOutputInstruction,
    runnerCwd,
    systemPrompt,
    resolvedSkillNames,
    skillsWarning,
    outputPath,
    outputMode,
    childLocation,
  } = inputs;
  const durableResume =
    persistedModelResolution !== undefined || restoredModelIdentity !== undefined;
  const explicitResumeModel =
    durableResume && typeof modelOverride === "string" && modelOverride.trim() !== ""
      ? modelOverride.trim() !== "inherit"
      : false;
  const restoringModel = Boolean(durableResume && !explicitResumeModel && restoredModelIdentity);
  const requestedPrimaryModel = restoringModel
    ? modelReferenceFromIdentity(restoredModelIdentity!)
    : (modelOverride ?? agentConfig.model);
  const scopeWarnings: string[] = [];
  const primaryModel = resolveSubagentModelOverride(
    requestedPrimaryModel,
    ctx.currentModel,
    durableResume
      ? {
          scope: ctx.modelScope,
          source: explicitResumeModel ? "explicit" : "inherited",
          onWarn: (violation) => scopeWarnings.push(violation.message),
        }
      : undefined,
  );
  const fallbackModels = buildFallbackModelList(providerFallbackModels, agentConfig.fallbackModels);
  const effectiveThinking = restoringModel ? restoredModelIdentity?.thinking : agentConfig.thinking;
  const model = applyThinkingSuffix(primaryModel, effectiveThinking);
  const modelIdentity = canonicalSubagentModelIdentity(
    model,
    resolveEffectiveThinking(model, effectiveThinking),
  );
  const candidatePlan = buildModelCandidatePlan(primaryModel, fallbackModels, {
    scope: ctx.modelScope,
    ...(durableResume ? { onWarn: (violation) => scopeWarnings.push(violation.message) } : {}),
  });
  const modelCandidates = deduplicateModelCandidates(
    candidatePlan.candidates
      .map((candidate) => applyThinkingSuffix(candidate, effectiveThinking))
      .filter((candidate): candidate is string => candidate !== undefined),
  );
  const modelThinking =
    modelIdentity?.thinking ??
    (modelIdentity ? undefined : resolveEffectiveThinking(model, effectiveThinking));
  const modelResolution = persistedModelResolution
    ? {
        ...persistedModelResolution,
        ...(modelIdentity ? { resumed: modelIdentity } : {}),
        reason: [persistedModelResolution.reason, ...scopeWarnings].join(" "),
      }
    : undefined;
  const normalizedTicketId = normalizeTicketId(params.ticketId, "ticketId");
  if (normalizedTicketId.error) return { error: normalizedTicketId.error };
  const normalizedInputTicket = normalizeTicketId(params.ticket, "ticket");
  if (normalizedInputTicket.error) return { error: normalizedInputTicket.error };
  let ticket: ReturnType<typeof readTicketBody> | undefined;
  if (params.ticket !== undefined) {
    const inputTicketId = normalizedInputTicket.ticketId;
    if (!inputTicketId) return { error: "ticket is invalid." };
    ticket =
      params.ticketBody !== undefined
        ? { ticketId: inputTicketId, body: params.ticketBody }
        : readTicketBody(params.ticket, runnerCwd, "ticket");
  }
  if (ticket?.error) return { error: ticket.error };
  const ticketId = ticket?.ticketId ?? normalizedTicketId.ticketId;

  const runtimePolicy = resolveAsyncSingleRuntimePolicy(agent, {
    activeRuntimeMs,
    activeRuntimeCheckpointAt,
    agentConfig,
  });
  if ("error" in runtimePolicy) return { error: runtimePolicy.error };
  const {
    activeRuntimeMs: resolvedActiveRuntimeMs,
    activeRuntimeCheckpointAt: resolvedActiveRuntimeCheckpointAt,
    effectiveTimeoutMs,
    roleBudgetMs,
    timeoutOwner,
    effectiveDeadlineAt,
  } = runtimePolicy;
  return {
    buildPlan: () => ({
      kind: "single",
      task: {
        parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
        ...(projectAgent ? { projectAgent } : {}),
        agent,
        projectAgentGuidance: isCanonicalPackagedMinorAgent(agentConfig),
        ...(ticketId ? { ticketId } : {}),
        ...(ticket?.body !== undefined ? { ticketBody: ticket.body } : {}),
        task: taskWithOutputInstruction,
        cwd: runnerCwd,
        model,
        thinking: modelThinking,
        ...(modelIdentity ? { modelIdentity } : {}),
        ...(modelResolution ? { modelResolution } : {}),
        modelCandidates,
        contextWindows: contextWindowsForChildModels(availableModels, {
          canonicalDeveloper:
            agentConfig.name === "developer" && isCanonicalPackagedMinorAgent(agentConfig),
        }),
        modelFallbackNotice,
        tools: agentConfig.tools,
        extensions: agentConfig.extensions,
        subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
        supervisorBridge: agentConfig.supervisorBridge,
        systemPrompt,
        systemPromptMode: agentConfig.systemPromptMode,
        inheritProjectContext: agentConfig.inheritProjectContext,
        inheritSkills: agentConfig.inheritSkills,
        skills: resolvedSkillNames,
        ...(skillsWarning ? { skillsWarning } : {}),
        outputPath,
        outputMode,
        sessionFile,
        ...(parseContextUsageDiagnostics(contextUsage)
          ? { contextUsage: parseContextUsageDiagnostics(contextUsage) }
          : {}),
        ...(parseContextPressureProjection(contextPressure)
          ? { contextPressure: parseContextPressureProjection(contextPressure) }
          : {}),
        // Lifecycle-aware callers omit both pressure fields for a newly
        // created continuation. Same-segment revivals restore the latest
        // display projection separately from machine deduplication history.
        ...(parseContextPressureCrossedThresholds(contextPressureCrossedThresholds)
          ? {
              contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
                contextPressureCrossedThresholds,
              ),
            }
          : {}),
        maxSubagentDepth: resolveChildMaxSubagentDepth(
          maxSubagentDepth,
          agentConfig.maxSubagentDepth,
        ),
        ...(roleBudgetMs !== undefined ? { timeoutMs: roleBudgetMs } : {}),
        ...(timeoutOwner ? { timeoutOwner } : {}),
        ...(resolvedActiveRuntimeMs > 0 ? { activeRuntimeMs: resolvedActiveRuntimeMs } : {}),
        ...(resolvedActiveRuntimeCheckpointAt !== undefined
          ? { activeRuntimeCheckpointAt: resolvedActiveRuntimeCheckpointAt }
          : {}),
        ...(childLocation ? { childLocation } : {}),
        ...(priorTerminalResult ? { terminalResult: priorTerminalResult } : {}),
      },
    }),
    effectiveTimeoutMs,
    effectiveDeadlineAt,
  };
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle<T extends AsyncSingleParams>(
  id: string,
  params: T,
): AsyncExecutionResult | Promise<AwaitedRunResult> {
  const {
    agent,
    agentConfig,
    ctx,
    cwd,
    maxOutput,
    artifactsDir,
    artifactConfig,
    sessionRoot,
    controlConfig,
  } = params;
  const retiredNestedError = retiredNestedLaunchError(params);
  if (retiredNestedError) return formatAsyncStartError("single", retiredNestedError);
  const runStartedAt = Date.now();
  const task = params.task ?? "";
  const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
  const childLocation = captureChildLocationSnapshot(ctx.cwd, runnerCwd);
  const skillNames = params.skills ?? agentConfig.skills ?? [];
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

  const asyncDir = path.join(ASYNC_DIR, id);
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
  const launchPlan = buildAsyncSingleRunnerPlan(params, {
    task,
    taskWithOutputInstruction,
    runnerCwd,
    systemPrompt,
    resolvedSkillNames: resolvedSkills.map((skill) => skill.name),
    ...(missingSkills.length > 0
      ? { skillsWarning: `Skills not found: ${missingSkills.join(", ")}` }
      : {}),
    outputPath,
    outputMode,
    ...(childLocation ? { childLocation } : {}),
  });
  if ("error" in launchPlan) {
    try {
      fs.rmSync(asyncDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for validation failures before the runner is spawned.
    }
    return formatAsyncStartError("single", launchPlan.error);
  }
  const { buildPlan, effectiveTimeoutMs, effectiveDeadlineAt } = launchPlan;
  const plan = buildPlan();
  const telemetry = initialAsyncTelemetry({
    id,
    execution: params.awaited ? "foreground" : "async",
    mode: "single",
    plan,
    provenance: params.telemetryProvenance,
    controls: params.controlConfig,
    startedAt: runStartedAt,
    lineage: params.telemetryLineage,
  });
  const resultPath = path.join(RESULTS_DIR, `${id}.json`);
  const awaitedOwner =
    params.awaited === true
      ? createAwaitedRunOwner({
          id,
          asyncDir,
          resultPath,
          mode: "single",
          plan,
          events: ctx.pi.events,
          sessionId: ctx.currentSessionId,
          cwd: runnerCwd,
          expectedGeneration: 0,
          signal: params.signal,
          onUpdate: params.onUpdate,
        })
      : undefined;

  if (awaitedOwner && params.signal?.aborted) {
    void awaitedOwner.cancel();
    return awaitedOwner.promise;
  }

  let spawnResult: { pid?: number; error?: string; ownership?: OwnedProcessGroupOwner };
  try {
    spawnResult = spawnRunner(
      {
        id,
        ...(params.awaited === true ? { awaited: true } : {}),
        ...(telemetry ? { telemetry } : {}),
        plan,
        resultPath: path.join(RESULTS_DIR, `${id}.json`),
        cwd: runnerCwd,
        maxOutput,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
        asyncDir,
        sessionId: ctx.currentSessionId,
        piPackageRoot,
        piArgv1: process.argv[1],
        controlConfig,
        // Async singles retain a role-derived root deadline so the runner's
        // segment timer and the role step timeout describe the same budget.
        ...(effectiveDeadlineAt !== undefined ? { deadlineAt: effectiveDeadlineAt } : {}),
        ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
        ...(params.continuationSource ? { continuationSource: params.continuationSource } : {}),
      },
      id,
      runnerCwd,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return awaitedOwner
      ? awaitedOwner.fail(`Failed to start async run '${id}': ${message}`)
      : formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
  }

  if (spawnResult.error) {
    const message = `Failed to start async run '${id}': ${spawnResult.error}`;
    return awaitedOwner ? awaitedOwner.fail(message) : formatAsyncStartError("single", message);
  }

  if (spawnResult.pid) {
    awaitedOwner?.markSpawned(spawnResult.pid, spawnResult.ownership);
    ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      id,
      pid: spawnResult.pid,
      sessionId: ctx.currentSessionId,
      mode: "single",
      agent,
      ...(telemetry ? { telemetry } : {}),
      task: task?.slice(0, 50),
      cwd: runnerCwd,
      asyncDir,
      ...(params.projectAgent ? { projectAgents: [params.projectAgent] } : {}),
      ...(effectiveTimeoutMs !== undefined
        ? { timeoutMs: effectiveTimeoutMs, deadlineAt: effectiveDeadlineAt }
        : {}),
    });
  }

  if (awaitedOwner) return awaitedOwner.promise;

  return {
    content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
    details: {
      mode: "single",
      runId: id,
      results: [],
      ...(telemetry ? { telemetry } : {}),
      asyncId: id,
      asyncDir,
      ...(effectiveTimeoutMs !== undefined
        ? { timeoutMs: effectiveTimeoutMs, deadlineAt: effectiveDeadlineAt }
        : {}),
    },
  };
}
