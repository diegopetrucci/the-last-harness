import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryDiagnostic, AgentScope } from "../../agents/agents.ts";

import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  retainProjectAgentRunReference,
  releaseProjectAgentRunReference,
  type ProjectAgentRunCapture,
  type ProjectAgentSnapshotCapability,
  type ProjectAgentSnapshotExpected,
  type ProjectAgentRunReferenceLookup,
} from "../../agents/project-agent-snapshot.ts";
import { getArtifactsDir, resolveArtifactConfig } from "../../shared/artifacts.ts";

import { resolveExecutionAgentScope } from "../../agents/agent-scope.ts";
import { handleManagementAction } from "../../agents/agent-management.ts";
import { buildDoctorReport } from "../../extension/doctor.ts";
import { clearPendingForegroundControlNotices } from "../../extension/control-notices.ts";
import type { runSync } from "./execution.ts";
import {
  buildParallelModeError,
  runParallelPath,
  runSinglePath,
  toExecutionErrorResult,
} from "./execution-paths.ts";
import {
  authorizeProjectInterruptTarget,
  authorizeProjectSteerTarget,
  buildManagementActionParams,
  buildRunStatusParams,
  buildResumeModelResolution,
  cancelPersistedPausedForegroundRun,
  clearForegroundMessageInbox,
  foregroundStatusResult,
  getAsyncInterruptTarget,
  getForegroundControl,
  getRequestedModeLabel,
  interruptAsyncRun,
  readModelRegistrySnapshot,
  registerForegroundMessageInbox,
  requestForegroundInterrupt,
  requestInterruptAllRunningSubagentRuns,
  projectInterruptAuthorizationResult,
  projectInterruptResolutionMismatch,
  resolveRememberedForegroundRun,
  resolveSingleRunOutputBaseDir,
  resolvedAsyncInterruptTarget,
  selectInterruptTarget,
  steerAsyncRun,
  unknownAgentMessage,
  trimRememberedForegroundRuns,
  providerFallbackModelsForTarget,
  resumeAsyncRun,
  unsupportedSavedChainInput,
  unsupportedSavedChainInputResult,
} from "./foreground-control.ts";
import {
  hasInMemoryProjectAgentCapture,
  isRecordValue,
  lookupPrivateProjectActionReference,
  normalizeProjectAgentAccess,
  privateProjectCaptureForTarget,
  projectAgentEntryIdentityError,
  projectRunAuthorizationError,
  resolveProjectAgentExecution,
} from "./project-agent-control.ts";
export {
  buildResumeModelResolution,
  clearForegroundMessageInbox,
  normalizeProjectAgentAccess,
  projectAgentEntryIdentityError,
  registerForegroundMessageInbox,
  trimRememberedForegroundRuns,
  requestInterruptAllRunningSubagentRuns,
};
import { pausedForegroundStatusPath } from "./foreground-pause-state.ts";
import { resolveSubagentModelOverride } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import {
  executeAsyncParallel,
  executeAsyncSingle,
  isAsyncAvailable,
} from "../background/async-execution.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { normalizeSingleOutputOverride } from "../shared/single-output.ts";
import { readStatus } from "../../shared/utils.ts";
import { retiredNestedLaunchError } from "../shared/pi-args.ts";
import { resolveSubagentRunId, type ResolvedSubagentRunId } from "../background/run-id-resolver.ts";

import { inspectSubagentStatus } from "../background/run-status.ts";
import {
  type AsyncStatus,
  type Details,
  type ExtensionConfig,
  type SubagentToolResult,
  type ResolvedArtifactConfig,
  type ResolvedControlConfig,
  type SubagentRunMode,
  type SubagentState,
  SUBAGENT_ACTIONS,
  checkSubagentDepth,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
  resolveChildMaxSubagentDepth,
  resolveCurrentMaxSubagentDepth,
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
}

export interface SubagentParamsLike {
  action?: string;
  id?: string;
  dir?: string;
  index?: number;
  agent?: string;
  task?: string;
  message?: string;
  /** Chain-shaped input is intentionally unsupported; kept only for fail-closed validation. */
  chain?: unknown;
  tasks?: TaskParam[];
  async?: boolean;
  clarify?: boolean;
  cwd?: string;
  artifacts?: boolean;
  model?: string;
  modelFallbackNotice?: string;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
  agentScope?: unknown;
  chainDir?: string;
  schedule?: string;
  scheduleName?: string;
  chainName?: string;
  config?: unknown;
}

interface ProjectAgentRebindRequest {
  projectRoot: string;
  cwd: string;
  sessionId: string;
  agent: string;
}

export interface ProjectAgentRebindResult {
  capability: ProjectAgentSnapshotCapability;
  expected: ProjectAgentSnapshotExpected;
  capture: ProjectAgentRunCapture;
}

export interface ProjectAgentAccess {
  capability: ProjectAgentSnapshotCapability;
  expected: ProjectAgentSnapshotExpected;
  /** True only while the architect is active; retained controls require this. */
  architect: boolean;
  /** Architect and disabled mode may initiate a new project-agent execution. */
  canInitiate?: boolean;
  /** Process-private current-trust reauthorization; never serializable. */
  reauthorize?: () => Promise<boolean>;
  /**
   * Process-private fresh-operation rebind used only when a prior run belongs
   * to another process and its old capability cannot be resolved.
   */
  rebind?: (request: ProjectAgentRebindRequest) => Promise<ProjectAgentRebindResult | undefined>;
}

interface ProjectAgentAccessRequest {
  cwd: string;
  sessionId: string | null;
  targetNames: readonly string[];
}

export interface ExecutorDeps {
  pi: ExtensionAPI;
  state: SubagentState;
  config: ExtensionConfig;
  /** Resolved once by the trusted parent; optional for direct test/legacy callers. */
  artifactConfig?: ResolvedArtifactConfig;
  tempArtifactsDir: string;
  getSubagentSessionRoot: (parentSessionFile: string | null) => string;
  expandTilde: (p: string) => string;
  discoverAgents: (
    cwd: string,
    scope: AgentScope,
  ) => {
    agents: AgentConfig[];
    modelScope?: ModelScopeConfig;
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
  };
  getProjectAgentAccess?: (request: ProjectAgentAccessRequest) => ProjectAgentAccess | undefined;
  /** Provenance captured once by the parent extension load boundary. */
  telemetryProvenance?: import("../../shared/telemetry.ts").SubagentTelemetryProvenance;
  /** Narrow functional seam for exercising continuation authorization without spawning a child. */
  executeAsyncSingle?: typeof executeAsyncSingle;
  /** Narrow functional seam for foreground pause/resume tests. */
  runSync?: typeof runSync;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}

interface ExecutionContextData {
  params: SubagentParamsLike;
  effectiveCwd: string;
  ctx: ExtensionContext;
  signal: AbortSignal;
  onUpdate?: (r: SubagentToolResult<Details>) => void;
  agents: AgentConfig[];
  projectAgentCapability?: ProjectAgentSnapshotCapability;
  projectAgentCaptures?: readonly import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture[];
  runId: string;
  sessionRoot: string;
  sessionDirForIndex: (idx?: number) => string;
  sessionFileForIndex: (idx?: number) => string | undefined;
  sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
  artifactConfig: ResolvedArtifactConfig;
  artifactsDir: string;
  effectiveAsync: boolean;
  controlConfig: ResolvedControlConfig;
  telemetryProvenance?: import("../../shared/telemetry.ts").SubagentTelemetryProvenance;
  telemetryLineage?: import("../../shared/telemetry.ts").SubagentTelemetryLineage;
  startedAt?: number;
  modelScope?: ModelScopeConfig;
  /** Narrow functional seam for foreground pause/resume tests. */
  runSync?: typeof runSync;
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
  return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function hasExplicitProjectModel(target: unknown): boolean {
  if (!isRecordValue(target)) return false;
  const model = target.model;
  if (typeof model !== "string") return false;
  const normalized = model.trim();
  return normalized.length > 0 && normalized !== "inherit";
}

function applyProjectAgentOpenRouterModel(
  params: SubagentParamsLike,
  captures: readonly ProjectAgentRunCapture[] | undefined,
  currentModel: ExtensionContext["model"],
): SubagentParamsLike {
  if (!captures?.length || currentModel?.provider !== "openrouter") return params;
  const projectTargets = new Set(captures.map((capture) => capture.provenance.agent));
  const apply = (target: unknown): void => {
    if (
      !isRecordValue(target) ||
      typeof target.agent !== "string" ||
      !projectTargets.has(target.agent.trim()) ||
      hasExplicitProjectModel(target)
    ) {
      return;
    }
    target.model = `${currentModel.provider}/${currentModel.id}`;
  };
  const next = { ...params };
  apply(next);
  if (Array.isArray(next.tasks)) {
    next.tasks = next.tasks.map((task) => {
      const copy = { ...task };
      apply(copy);
      return copy;
    });
  }
  return next;
}

function retiredExecutionControlError(params: SubagentParamsLike): string | undefined {
  const input = params as Record<string, unknown>;
  const topLevelGuidance: Record<string, string> = {
    timeoutMs:
      "Caller-selected execution timeouts are retired; per-role execution budgets are applied automatically. Restart with a new direct run after removing `timeoutMs`.",
    concurrency:
      "Configure `parallel.concurrency` in `<agent-dir>/extensions/subagent/config.json`; per-call concurrency is no longer supported.",
    fallbackModels:
      "Configure fallbackModels in the agent definition; per-call fallback selection is no longer supported.",
    includeProgress:
      "Progress is tracked automatically and is not a caller-controlled execution option.",
    skills:
      "Configure skills in the agent definition; per-call skill selection is no longer supported.",
    skill:
      "Configure skills in the agent definition; per-call skill selection is no longer supported.",
    share: "Session publishing is retired; ordinary session persistence remains automatic.",
    acceptance:
      "Acceptance is inferred from the agent definition and persisted continuation contract.",
    toolBudget:
      "Configure toolBudget in the agent definition; per-call budgets are no longer supported.",
    control:
      "Configure control in the isolated extension config; per-call control is no longer supported.",
    sessionDir:
      "Session directories are managed internally; per-call sessionDir is no longer supported.",
    maxOutput: "Output bounds are managed internally; per-call maxOutput is no longer supported.",
    dir: "Run directories are resolved internally; public dir selectors are no longer supported.",
    view: "Status views are no longer caller-selectable; use the default status output.",
    lines: "Status line limits are no longer caller-selectable; use the default status output.",
  };
  for (const [key, guidance] of Object.entries(topLevelGuidance)) {
    if (Object.hasOwn(input, key)) return `${key} is no longer supported. ${guidance}`;
  }

  if (Array.isArray(input.tasks)) {
    for (const [index, rawTask] of input.tasks.entries()) {
      if (!isRecordValue(rawTask)) continue;
      const taskPrefix = `tasks[${index}]`;
      const taskGuidance: Record<string, string> = {
        skills:
          "Configure skills in the agent definition; per-task skill selection is no longer supported.",
        skill:
          "Configure skills in the agent definition; per-task skill selection is no longer supported.",
        share: "Session publishing is retired; ordinary session persistence remains automatic.",
        acceptance:
          "Acceptance is inferred from the agent definition and persisted continuation contract.",
        toolBudget:
          "Configure toolBudget in the agent definition; per-task budgets are no longer supported.",
        control:
          "Configure control in the isolated extension config; per-task control is no longer supported.",
        sessionDir:
          "Session directories are managed internally; per-task sessionDir is no longer supported.",
        maxOutput:
          "Output bounds are managed internally; per-task maxOutput is no longer supported.",
        dir: "Run directories are resolved internally; public dir selectors are no longer supported.",
        view: "Status views are no longer caller-selectable; use the default status output.",
        lines: "Status line limits are no longer caller-selectable; use the default status output.",
      };
      for (const [key, guidance] of Object.entries(taskGuidance)) {
        if (Object.hasOwn(rawTask, key))
          return `${taskPrefix}.${key} is no longer supported. ${guidance}`;
      }
      if (Object.hasOwn(rawTask, "timeoutMs")) {
        return `${taskPrefix}.timeoutMs is no longer supported. Caller-selected execution timeouts are retired; per-role execution budgets are applied automatically. Restart with a new direct run after removing timeoutMs.`;
      }
      if (Object.hasOwn(rawTask, "reads")) {
        return `tasks[${index}].reads is no longer supported. Configure defaultReads in the agent definition instead.`;
      }
      if (Object.hasOwn(rawTask, "progress")) {
        return `tasks[${index}].progress is no longer supported. Configure defaultProgress in the agent definition instead.`;
      }
      if (Object.hasOwn(rawTask, "fallbackModels")) {
        return `tasks[${index}].fallbackModels is no longer supported. Configure fallbackModels in the agent definition instead.`;
      }
    }
  }
  return undefined;
}

function validateExecutionInput(
  params: SubagentParamsLike,
  agents: AgentConfig[],
  agentDiagnostics: AgentDiscoveryDiagnostic[] | undefined,
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

  if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
    return {
      content: [{ type: "text", text: unknownAgentMessage(params.agent, agentDiagnostics) }],
      isError: true,
      details: { mode: "single" as const, results: [] },
    };
  }

  if (hasTasks && params.tasks) {
    for (let i = 0; i < params.tasks.length; i++) {
      const task = params.tasks[i]!;
      if (!agents.find((agent) => agent.name === task.agent)) {
        return {
          content: [
            {
              type: "text",
              text: `${unknownAgentMessage(task.agent, agentDiagnostics)} (task ${i + 1})`,
            },
          ],
          isError: true,
          details: { mode: "parallel" as const, results: [] },
        };
      }
    }
  }

  return null;
}

function buildRequestedModeError(
  params: SubagentParamsLike,
  message: string,
): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode: getRequestedModeLabel(params), results: [] },
  };
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
  const expanded: TaskParam[] = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const task = tasks[taskIndex]!;
    const rawCount = (task as TaskParam & { count?: unknown }).count;
    if (
      rawCount !== undefined &&
      (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)
    ) {
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
  return { params };
}

function runAsyncPath(
  data: ExecutionContextData,
  deps: ExecutorDeps,
): SubagentToolResult<Details> | null {
  const {
    params,
    effectiveCwd,
    agents,
    ctx,
    sessionRoot,
    sessionFileForTask,
    artifactConfig,
    artifactsDir,
    effectiveAsync,
    controlConfig,
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
  const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
  const { availableModels } = modelRegistrySnapshot;
  const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
  const currentProvider = ctx.model?.provider;
  let projectRunRetained = false;
  if (data.projectAgentCaptures?.length) {
    try {
      retainProjectAgentRunReference(data.projectAgentCapability!, id, data.projectAgentCaptures);
      projectRunRetained = true;
    } catch (error) {
      return toExecutionErrorResult(
        params,
        new Error(
          `TLH project-agent run retention failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  const releaseAsyncProjectRunOnError = <T extends SubagentToolResult<Details>>(result: T): T => {
    if (projectRunRetained && result.isError) {
      releaseProjectAgentRunReference(id);
      projectRunRetained = false;
    }
    return result;
  };

  if (hasTasks && params.tasks) {
    const agentConfigs = params.tasks.map((task) =>
      agents.find((agent) => agent.name === task.agent),
    );
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
      task: task.task,
      cwd: task.cwd,
      ...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
      ...(providerFallbackModelsForTarget(task)
        ? { providerFallbackModels: providerFallbackModelsForTarget(task) }
        : {}),
      ...(task.modelFallbackNotice ? { modelFallbackNotice: task.modelFallbackNotice } : {}),
      ...(task.output === true
        ? agentConfigs[index]?.output
          ? { output: agentConfigs[index]!.output }
          : {}
        : task.output !== undefined
          ? { output: task.output }
          : {}),
      ...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
    }));
    return releaseAsyncProjectRunOnError(
      executeAsyncParallel(id, {
        tasks: parallelTasks,
        concurrency: resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency),
        agents,
        ctx: asyncCtx,
        availableModels,
        modelRegistry: modelRegistrySnapshot.evidence,
        cwd: effectiveCwd,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        sessionRoot,
        sessionFilesByFlatIndex: params.tasks.map((task, index) =>
          sessionFileForTask(task.agent, index),
        ),
        maxSubagentDepth: currentMaxSubagentDepth,
        controlConfig,
        telemetryProvenance: data.telemetryProvenance,
        telemetryLineage: data.telemetryLineage,
        projectAgentCaptures: data.projectAgentCaptures,
      }),
    );
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
    const skills = a.skills;
    const maxSubagentDepth = resolveChildMaxSubagentDepth(
      currentMaxSubagentDepth,
      a.maxSubagentDepth,
    );
    const modelOverride = resolveSubagentModelOverride(
      (params.model as string | undefined) ?? a.model,
      ctx.model,
      availableModels,
      currentProvider,
      {
        scope: data.modelScope,
        source: (params.model as string | undefined) ? "explicit" : "inherited",
      },
    );
    return releaseAsyncProjectRunOnError(
      (deps.executeAsyncSingle ?? executeAsyncSingle)(id, {
        agent: params.agent!,
        task: params.task ?? "",
        agentConfig: a,
        ctx: asyncCtx,
        availableModels,
        modelRegistry: modelRegistrySnapshot.evidence,
        cwd: effectiveCwd,
        artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
        artifactConfig,
        sessionRoot,
        sessionFile: sessionFileForTask(params.agent!, 0),
        skills,
        output: effectiveOutput,
        outputMode: effectiveOutputMode,
        outputBaseDir: resolveSingleRunOutputBaseDir(artifactsDir, id),
        modelOverride,
        providerFallbackModels: providerFallbackModelsForTarget(params),
        modelFallbackNotice: params.modelFallbackNotice,
        maxSubagentDepth,
        controlConfig,
        telemetryProvenance: data.telemetryProvenance,
        telemetryLineage: data.telemetryLineage,
        projectAgent: data.projectAgentCaptures?.find(
          (capture) => capture.provenance.agent === params.agent,
        ),
      }),
    );
  }

  if (projectRunRetained) {
    releaseProjectAgentRunReference(id);
    projectRunRetained = false;
  }
  return null;
}

function inferExecutionMode(params: SubagentParamsLike): SubagentRunMode {
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

function executeDoctorAction(
  params: SubagentParamsLike,
  requestCwd: string,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): SubagentToolResult<Details> {
  let currentSessionFile: string | null = null;
  let currentSessionId = deps.state.currentSessionId;
  let sessionError: string | undefined;
  try {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    currentSessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return {
    content: [
      {
        type: "text",
        text: buildDoctorReport({
          cwd: requestCwd,
          config: deps.config,
          state: deps.state,
          currentSessionFile,
          currentSessionId,
          sessionError,
        }),
      },
    ],
    details: { mode: "management", results: [] },
  };
}

function executeStatusAction(
  params: SubagentParamsLike,
  _ctx: ExtensionContext,
  deps: ExecutorDeps,
): SubagentToolResult<Details> {
  if (params.id) {
    try {
      const resolved = resolveSubagentRunId(params.id, { state: deps.state });
      if (resolved?.kind === "foreground") {
        const foreground = getForegroundControl(deps.state, resolved.id);
        if (foreground) return foregroundStatusResult(foreground);
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
    if (foreground) return foregroundStatusResult(foreground);
  }
  return inspectSubagentStatus(buildRunStatusParams(params), { state: deps.state });
}

async function executeSteerAction(
  params: SubagentParamsLike,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details>> {
  deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  const privateProjectLookup = lookupPrivateProjectActionReference(params);
  if (privateProjectLookup.status === "ambiguous")
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            `the requested run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`,
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  const message = (params.message ?? params.task ?? "").trim();
  if (!message)
    return {
      content: [{ type: "text", text: "action='steer' requires message." }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  const targetRunId = params.id;
  const retainedRunId =
    privateProjectLookup.status === "found" ? privateProjectLookup.runId : undefined;
  if (!targetRunId)
    return {
      content: [{ type: "text", text: "action='steer' requires id." }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  let resolved: ResolvedSubagentRunId | undefined;
  try {
    resolved = resolveSubagentRunId(retainedRunId ?? targetRunId, { state: deps.state });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  if (privateProjectLookup.status === "found" && resolved?.kind !== "async")
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            "the retained project-agent run is not an async control target.",
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
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
  try {
    await authorizeProjectSteerTarget({
      params: { ...params, ...(retainedRunId ? { id: retainedRunId } : {}) },
      lookup: privateProjectLookup,
      ctx,
      deps,
    });
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  return steerAsyncRun({
    state: deps.state,
    runId: resolved.id,
    message,
    index: params.index,
    kill: deps.kill,
    location: resolved.location,
    projectLookup: privateProjectLookup,
  });
}

function isPersistedCancellationState(status: AsyncStatus | null | undefined): boolean {
  return (
    status?.state === "paused" || status?.state === "continued" || status?.state === "cancelled"
  );
}

async function executeInterruptAction(
  params: SubagentParamsLike,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details>> {
  deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  const requestedProjectLookup = lookupPrivateProjectActionReference(params);
  if (requestedProjectLookup.status === "ambiguous") {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            `the requested run id is ambiguous in the retained project-agent registry (${requestedProjectLookup.runIds.join(", ")}). Provide a full run id.`,
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const targetRunId = params.id;
  const rememberedPaused = resolveRememberedForegroundRun(params, deps.state);
  if (
    rememberedPaused?.child.status === "paused" &&
    rememberedPaused.child.pause &&
    !getForegroundControl(deps.state, rememberedPaused.run.runId)
  ) {
    const pausedAsyncDir = pausedForegroundStatusPath(rememberedPaused.run.runId);
    if (fs.existsSync(pausedAsyncDir)) {
      const projectResolutionError = projectInterruptResolutionMismatch(
        requestedProjectLookup,
        rememberedPaused.run.runId,
      );
      if (projectResolutionError)
        return projectInterruptAuthorizationResult(projectResolutionError);
      try {
        await authorizeProjectInterruptTarget({
          params: { ...params, id: rememberedPaused.run.runId },
          lookup: requestedProjectLookup,
          ctx,
          deps,
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          details: { mode: "management", results: [] },
        };
      }
      return cancelPersistedPausedForegroundRun(
        deps.state,
        pausedAsyncDir,
        rememberedPaused.run.runId,
        rememberedPaused.index,
      );
    }
  }
  let resolved: ResolvedSubagentRunId | undefined;
  let selectedParams = params;
  try {
    const selected = selectInterruptTarget(params, deps.state);
    resolved = selected.target;
    selectedParams = selected.params;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const privateProjectLookup = targetRunId
    ? requestedProjectLookup
    : lookupPrivateProjectActionReference(selectedParams);
  if (privateProjectLookup.status === "ambiguous") {
    return {
      content: [
        {
          type: "text",
          text: projectRunAuthorizationError(
            `the selected run id is ambiguous in the retained project-agent registry (${privateProjectLookup.runIds.join(", ")}). Provide a full run id.`,
          ).message,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const projectResolutionError = projectInterruptResolutionMismatch(
    privateProjectLookup,
    resolved?.id,
  );
  if (projectResolutionError) return projectInterruptAuthorizationResult(projectResolutionError);
  let asyncInterruptTarget = resolved?.kind === "async" ? resolved : undefined;
  let asyncInterruptParams = selectedParams;
  let asyncInterruptLookup: ProjectAgentRunReferenceLookup = privateProjectLookup;
  if (resolved?.kind === "foreground") {
    const foregroundRun = deps.state.foregroundRuns?.get(resolved.id);
    const foregroundProjectChildren = (foregroundRun?.children ?? []).filter(
      (child) => child.projectAgent !== undefined,
    );
    if (foregroundProjectChildren.length > 0 && privateProjectLookup.status === "missing") {
      return {
        content: [
          {
            type: "text",
            text: projectRunAuthorizationError(
              "the foreground target carries a project-agent marker, but its process-private reference is unavailable; refusing interrupt fallback.",
            ).message,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (foregroundProjectChildren.length > 0 && privateProjectLookup.status === "found") {
      try {
        for (const foregroundChild of foregroundProjectChildren) {
          privateProjectCaptureForTarget(privateProjectLookup, {
            runId: resolved.id,
            agent: foregroundChild.agent,
            projectAgent: foregroundChild.projectAgent,
          });
        }
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          details: { mode: "management", results: [] },
        };
      }
    }
    const foreground = getForegroundControl(deps.state, resolved.id);
    if (foreground) {
      if (requestForegroundInterrupt(foreground)) {
        return {
          content: [
            { type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` },
          ],
          details: { mode: "management", results: [] },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Foreground run ${foreground.runId} has no active child step to interrupt.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const asyncTarget = getAsyncInterruptTarget(deps.state, resolved.id);
    if (asyncTarget) {
      asyncInterruptTarget = resolvedAsyncInterruptTarget(asyncTarget);
      asyncInterruptParams = {
        ...selectedParams,
        id: asyncInterruptTarget.id,
        dir: asyncTarget.asyncDir,
      };
      asyncInterruptLookup = lookupPrivateProjectActionReference(asyncInterruptParams);
      if (asyncInterruptLookup.status === "ambiguous") {
        return {
          content: [
            {
              type: "text",
              text: projectRunAuthorizationError(
                `the selected async run id is ambiguous in the retained project-agent registry (${asyncInterruptLookup.runIds.join(", ")}). Provide a full run id.`,
              ).message,
            },
          ],
          isError: true,
          details: { mode: "management", results: [] },
        };
      }
      const asyncProjectResolutionError = projectInterruptResolutionMismatch(
        asyncInterruptLookup,
        asyncInterruptTarget.id,
      );
      if (asyncProjectResolutionError)
        return projectInterruptAuthorizationResult(asyncProjectResolutionError);
    } else {
      const pausedAsyncDir = pausedForegroundStatusPath(resolved.id);
      const persistedStatus = readStatus(pausedAsyncDir);
      if (isPersistedCancellationState(persistedStatus)) {
        return cancelPersistedPausedForegroundRun(
          deps.state,
          pausedAsyncDir,
          resolved.id,
          params.index,
        );
      }
    }
  }
  if (asyncInterruptTarget) {
    const selectedAsyncJob = deps.state.asyncJobs.get(asyncInterruptTarget.id);
    if (
      asyncInterruptLookup.status === "missing" &&
      hasInMemoryProjectAgentCapture(selectedAsyncJob)
    ) {
      return projectInterruptAuthorizationResult(
        projectRunAuthorizationError(
          "the selected async run carries a project-agent marker, but its process-private reference is unavailable; refusing interrupt fallback.",
        ),
      );
    }
    try {
      await authorizeProjectInterruptTarget({
        params: asyncInterruptParams,
        lookup: asyncInterruptLookup,
        ctx,
        deps,
      });
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
  }
  if (
    asyncInterruptTarget &&
    resolved?.kind === "async" &&
    targetRunId?.trim() &&
    asyncInterruptTarget.location.asyncDir
  ) {
    const persistedStatus = readStatus(asyncInterruptTarget.location.asyncDir);
    if (isPersistedCancellationState(persistedStatus)) {
      return cancelPersistedPausedForegroundRun(
        deps.state,
        asyncInterruptTarget.location.asyncDir,
        asyncInterruptTarget.id,
        params.index,
      );
    }
  }
  const asyncInterruptResult = asyncInterruptTarget
    ? interruptAsyncRun(
        deps.state,
        asyncInterruptTarget.id,
        deps.kill,
        asyncInterruptTarget.location,
      )
    : null;
  if (asyncInterruptResult) return asyncInterruptResult;
  return {
    content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
    isError: true,
    details: { mode: "management", results: [] },
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
  const configuredArtifactConfig =
    deps.artifactConfig ?? resolveArtifactConfig(deps.config.artifacts);

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
    const retiredControlDetail = retiredExecutionControlError(paramsWithResolvedCwd);
    if (retiredControlDetail)
      return buildRequestedModeError(paramsWithResolvedCwd, retiredControlDetail);
    const unsupportedSavedChainDetail = unsupportedSavedChainInput(paramsWithResolvedCwd);
    if (unsupportedSavedChainDetail)
      return unsupportedSavedChainInputResult(paramsWithResolvedCwd, unsupportedSavedChainDetail);
    const retiredNestedError = retiredNestedLaunchError(paramsWithResolvedCwd);
    if (retiredNestedError)
      return buildRequestedModeError(paramsWithResolvedCwd, retiredNestedError);
    const action = paramsWithResolvedCwd.action;
    if (action) {
      if (action === "doctor")
        return executeDoctorAction(paramsWithResolvedCwd, requestCwd, ctx, deps);
      if (action === "status") return executeStatusAction(paramsWithResolvedCwd, ctx, deps);
      if (action === "resume") {
        return resumeAsyncRun({
          params: paramsWithResolvedCwd,
          requestCwd,
          ctx,
          deps,
          artifactConfig: {
            ...configuredArtifactConfig,
            enabled: paramsWithResolvedCwd.artifacts !== false,
          },
        });
      }
      if (action === "steer") return executeSteerAction(paramsWithResolvedCwd, ctx, deps);
      if (action === "interrupt") return executeInterruptAction(paramsWithResolvedCwd, ctx, deps);
      if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown action: ${action}. Valid: ${SUBAGENT_ACTIONS.join(", ")}`,
            },
          ],
          isError: true,
          details: { mode: "management" as const, results: [] },
        };
      }
      return handleManagementAction(action, buildManagementActionParams(paramsWithResolvedCwd), {
        ...ctx,
        cwd: requestCwd,
      });
    }

    const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
    if (blocked) {
      return {
        content: [
          {
            type: "text",
            text:
              `Subagent dispatch blocked at the configured recursion depth (depth=${depth}, max=${maxDepth}). ` +
              "You are running at the maximum supported child depth. " +
              "Complete your current task directly without delegating further.",
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
    const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
    const requestedExecutionCwd = effectiveParams.cwd ?? ctx.cwd;
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    const projectResolution = resolveProjectAgentExecution(
      effectiveParams,
      requestedExecutionCwd,
      scope,
      deps.state.currentSessionId,
      deps,
    );
    if ("error" in projectResolution) {
      return toExecutionErrorResult(effectiveParams, new Error(projectResolution.error));
    }
    effectiveParams = applyProjectAgentOpenRouterModel(
      projectResolution.params,
      projectResolution.projectAgentCaptures,
      ctx.model,
    );
    const effectiveCwd = projectResolution.effectiveCwd;
    const discovered = projectResolution.discovered;
    const discoveredAgents = discovered.agents;
    const modelScope = discovered.modelScope;
    const agents = discoveredAgents;
    const runId = randomUUID().slice(0, 8);
    const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
    const hasSingle = !hasTasks && Boolean(effectiveParams.agent);

    const validationError = validateExecutionInput(
      effectiveParams,
      agents,
      discovered.agentDiagnostics,
      hasTasks,
      hasSingle,
    );
    if (validationError) return validationError;

    const requestedAsync = effectiveParams.async ?? false;
    const effectiveAsync = requestedAsync;
    const controlConfig = resolveControlConfig(deps.config.control);

    const artifactConfig: ResolvedArtifactConfig = {
      ...configuredArtifactConfig,
      enabled: effectiveParams.artifacts !== false,
    };
    const artifactsDir = getArtifactsDir(parentSessionFile);

    const baseSessionRoot = deps.getSubagentSessionRoot(parentSessionFile);
    const sessionRoot = path.join(baseSessionRoot, runId);
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
    const childSessionFileForTask = (_agentName: string, idx?: number) =>
      path.join(sessionDirForIndex(idx), "session.jsonl");
    const childSessionFileForIndex = (idx?: number) =>
      path.join(sessionDirForIndex(idx), "session.jsonl");

    let projectRunRetained = false;
    if (!effectiveAsync && projectResolution.projectAgentCaptures?.length) {
      try {
        retainProjectAgentRunReference(
          projectResolution.projectAgentCapability!,
          runId,
          projectResolution.projectAgentCaptures,
        );
        projectRunRetained = true;
      } catch (error) {
        return toExecutionErrorResult(
          effectiveParams,
          new Error(
            `TLH project-agent run retention failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    const releaseTerminalProjectRun = (
      result: SubagentToolResult<Details>,
    ): SubagentToolResult<Details> => {
      if (
        projectRunRetained &&
        !result.details?.results.some((child) => child.pause || child.interrupted)
      ) {
        const releaseTimer = setTimeout(
          () => releaseProjectAgentRunReference(runId),
          PROJECT_AGENT_TERMINAL_RETENTION_MS,
        );
        releaseTimer.unref?.();
        projectRunRetained = false;
      }
      return result;
    };
    const onUpdateWithContext = onUpdate;

    const foregroundMode: "single" | "parallel" = hasTasks ? "parallel" : "single";
    const runStartedAt = Date.now();

    const execData: ExecutionContextData = {
      params: effectiveParams,
      effectiveCwd,
      ctx,
      signal,
      onUpdate: onUpdateWithContext,
      agents,
      ...(projectResolution.projectAgentCapability
        ? { projectAgentCapability: projectResolution.projectAgentCapability }
        : {}),
      ...(projectResolution.projectAgentCaptures
        ? { projectAgentCaptures: projectResolution.projectAgentCaptures }
        : {}),
      runId,
      sessionRoot,
      sessionDirForIndex,
      sessionFileForIndex: childSessionFileForIndex,
      sessionFileForTask: childSessionFileForTask,
      artifactConfig,
      artifactsDir,
      effectiveAsync,
      controlConfig,
      telemetryProvenance: deps.telemetryProvenance,
      startedAt: runStartedAt,
      modelScope,
      runSync: deps.runSync,
    };

    const foregroundControl = effectiveAsync
      ? undefined
      : {
          runId,
          mode: foregroundMode,
          startedAt: runStartedAt,
          updatedAt: runStartedAt,
          currentAgent: undefined,
          currentIndex: undefined,
          currentActivityState: undefined,
          interrupt: undefined,
        };
    if (foregroundControl) {
      deps.state.foregroundControls.set(runId, foregroundControl);
      deps.state.lastForegroundControlId = runId;
    }

    try {
      const asyncResult = runAsyncPath(execData, deps);
      if (asyncResult) return asyncResult;
      if (hasTasks && effectiveParams.tasks) {
        const result = await runParallelPath(execData, deps);
        return releaseTerminalProjectRun(result);
      }
      if (hasSingle) {
        const result = await runSinglePath(execData, deps);
        return releaseTerminalProjectRun(result);
      }
    } catch (error) {
      if (projectRunRetained) {
        releaseProjectAgentRunReference(runId);
        projectRunRetained = false;
      }
      const errorResult = toExecutionErrorResult(effectiveParams, error);
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

    if (projectRunRetained) {
      releaseProjectAgentRunReference(runId);
      projectRunRetained = false;
    }
    return {
      content: [{ type: "text", text: "Invalid params" }],
      isError: true,
      details: { mode: "single" as const, results: [] },
    };
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
