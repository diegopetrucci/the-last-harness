import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryDiagnostic, AgentScope } from "../agents/agents.ts";

import type { ProjectAgentIdentity } from "../agents/project-agent-loader.ts";
import { getArtifactsDir, resolveArtifactConfig } from "../shared/artifacts.ts";

import { resolveExecutionAgentScope } from "../agents/agent-scope.ts";
import { handleManagementAction } from "../agents/agent-management.ts";
import { buildDoctorReport, resolveProjectAgentDoctorTrust } from "./doctor.ts";
import {
  authorizeNestedProjectAgentControl,
  authorizeProjectInterruptTarget,
  authorizeProjectSteerTarget,
  buildManagementActionParams,
  buildRunStatusParams,
  buildResumeModelResolution,
  cancelPersistedPausedAsyncRun,
  getRequestedModeLabel,
  interruptAsyncRun,
  readModelRegistrySnapshot,
  requestInterruptAllRunningSubagentRuns,
  interruptNestedRun,
  resolveSingleRunOutputBaseDir,
  selectInterruptTarget,
  steerAsyncRun,
  steerNestedRun,
  trustedSessionRootsForStatus,
  unknownAgentMessage,
  providerFallbackModelsForTarget,
  resumeAsyncRun,
  unsupportedSavedChainInput,
  unsupportedSavedChainInputResult,
} from "../runs/shared/run-control.ts";
import {
  hasMalformedProjectAgentControlMarker,
  isRecordValue,
  normalizeProjectAgentAccess,
  projectRunAuthorizationError,
  resolveProjectAgentExecution,
} from "../runs/shared/project-agent-control.ts";
export {
  buildResumeModelResolution,
  normalizeProjectAgentAccess,
  requestInterruptAllRunningSubagentRuns,
};
import { resolveSubagentModelOverride } from "../runs/shared/model-fallback.ts";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { normalizeSkillInput } from "../agents/skills.ts";
import { resolveExecutionPolicy } from "../agents/execution-ceiling.ts";
import {
  executeAsyncParallel,
  executeAsyncSingle,
  isAsyncAvailable,
} from "../runs/background/async-execution.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { resolveControlConfig } from "../runs/shared/subagent-control.ts";
import { resolveAsyncRunLocation } from "../runs/background/async-resume.ts";
import { normalizeSingleOutputOverride } from "../runs/shared/single-output.ts";
import { readStatus, resolveChildCwd } from "../shared/utils.ts";
import {
  normalizeTicketId,
  readTicketBody,
  ticketLookupKey,
} from "../runs/shared/ticket-context.ts";

import { resolveInheritedNestedRouteFromEnv } from "../runs/shared/nested-events.ts";
import {
  resolveSubagentRunId,
  type ResolvedSubagentRunId,
} from "../runs/background/run-id-resolver.ts";

import { inspectSubagentStatus } from "../runs/background/run-status.ts";
import { isAsyncStatusReadError } from "../runs/background/async-status-boundary.ts";
import {
  type AsyncStatus,
  type Details,
  type SubagentToolResult,
  type NestedRouteInfo,
  type ResolvedArtifactConfig,
  type ResolvedControlConfig,
  type SubagentRunMode,
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ACTIONS,
  checkSubagentDepth,
  resolveTopLevelParallelConcurrency,
  resolveTopLevelParallelMaxTasks,
  resolveChildMaxSubagentDepth,
  resolveCurrentMaxSubagentDepth,
} from "../shared/types.ts";
import type { ExecutorDeps, SubagentParamsLike, TaskParam } from "../runs/shared/executor-types.ts";
export type {
  ExecutorDeps,
  ProjectAgentAccess,
  SubagentParamsLike,
} from "../runs/shared/executor-types.ts";

function toExecutionErrorResult(
  params: SubagentParamsLike,
  error: unknown,
): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
    details: { mode: getRequestedModeLabel(params), results: [] },
  };
}

function buildParallelModeError(message: string): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: { mode: "parallel", results: [] },
  };
}

interface ExecutionContextData {
  params: SubagentParamsLike;
  effectiveCwd: string;
  ctx: ExtensionContext;
  signal: AbortSignal;
  onUpdate?: (r: SubagentToolResult<Details>) => void;
  agents: AgentConfig[];
  /** Whether ordinary execution is owned by the awaited async runner. */
  awaited: boolean;
  projectAgentIdentities?: readonly ProjectAgentIdentity[];
  runId: string;
  shareEnabled: boolean;
  sessionRoot: string;
  sessionDirForIndex: (idx?: number) => string;
  sessionFileForIndex: (idx?: number) => string | undefined;
  sessionFileForTask: (agentName: string, idx?: number) => string | undefined;
  artifactConfig: ResolvedArtifactConfig;
  artifactsDir: string;
  controlConfig: ResolvedControlConfig;
  nestedRoute?: NestedRouteInfo;
  timeoutMs?: number;
  deadlineAt?: number;
  modelScope?: ModelScopeConfig;
  /** Ticket bodies loaded once per normalized cwd and ticket ID for this dispatch. */
  ticketBodies?: ReadonlyMap<string, string>;
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
  identities: readonly ProjectAgentIdentity[] | undefined,
  currentModel: ExtensionContext["model"],
): SubagentParamsLike {
  if (!identities?.length || currentModel?.provider !== "openrouter") return params;
  const projectTargets = new Set(identities.map((identity) => `embedded.${identity.slug}`));
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

function statusTranscriptOptionError(params: SubagentParamsLike): string | undefined {
  if (params.view === undefined && params.lines === undefined) return undefined;
  if (params.action === "status") return undefined;
  return 'Status transcript options `view` and `lines` are only supported with action=\'status\'; use { action: "status", id: "...", view: "transcript" } (optional lines 1-500).';
}

function retiredExecutionControlError(params: SubagentParamsLike): string | undefined {
  const input = params as Record<string, unknown>;
  const topLevelGuidance: Record<string, string> = {
    timeoutMs:
      "Configure `execution.maxRunTimeMs` in `<agent-dir>/extensions/subagent/config.json`; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing `timeoutMs`.",
    concurrency:
      "Configure `parallel.concurrency` in `<agent-dir>/extensions/subagent/config.json`; per-call concurrency is no longer supported.",
    fallbackModels:
      "Configure fallbackModels in the agent definition; per-call fallback selection is no longer supported.",
    includeProgress:
      "Progress is tracked automatically and is not a caller-controlled execution option.",
  };
  for (const [key, guidance] of Object.entries(topLevelGuidance)) {
    if (Object.hasOwn(input, key)) return `${key} is no longer supported. ${guidance}`;
  }

  if (Array.isArray(input.tasks)) {
    for (const [index, rawTask] of input.tasks.entries()) {
      if (!isRecordValue(rawTask)) continue;
      if (Object.hasOwn(rawTask, "timeoutMs")) {
        return `tasks[${index}].timeoutMs is no longer supported. Configure execution.maxRunTimeMs in <agent-dir>/extensions/subagent/config.json; caller-selected execution timeouts are no longer supported. Restart with a new direct run after removing timeoutMs.`;
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

function normalizeExecutionTickets(params: SubagentParamsLike): {
  params?: SubagentParamsLike;
  error?: string;
} {
  if (params.ticket !== undefined && params.tasks !== undefined) {
    return { error: "Top-level ticket cannot be combined with tasks; use tasks[i].ticket." };
  }

  const topLevel = normalizeTicketId(params.ticket, "ticket");
  if (topLevel.error) return { error: topLevel.error };

  let taskError: string | undefined;
  const normalizedTasks = params.tasks?.map((task, index) => {
    const ticket = normalizeTicketId(task.ticket, `tasks[${index}].ticket`);
    if (ticket.error) taskError ??= ticket.error;
    const normalizedTask = { ...task };
    if (ticket.ticketId) normalizedTask.ticket = ticket.ticketId;
    else delete normalizedTask.ticket;
    return normalizedTask;
  });
  if (taskError) return { error: taskError };
  const normalizedParams = { ...params };
  if (topLevel.ticketId) normalizedParams.ticket = topLevel.ticketId;
  else delete normalizedParams.ticket;
  if (normalizedTasks) normalizedParams.tasks = normalizedTasks;
  return { params: normalizedParams };
}

function prepareTicketBodies(
  params: SubagentParamsLike,
  effectiveCwd: string,
): { ticketBodies?: ReadonlyMap<string, string>; error?: string } {
  const lookups = new Map<string, ReturnType<typeof readTicketBody>>();
  const ticketBodies = new Map<string, string>();

  const prepare = (ticketId: string, cwd: string, field: string): string | undefined => {
    const key = ticketLookupKey(cwd, ticketId);
    const cached = lookups.get(key);
    if (cached) {
      if (cached.error) return cached.error;
      if (cached.body !== undefined) ticketBodies.set(key, cached.body);
      return undefined;
    }

    const result = readTicketBody(ticketId, cwd, field);
    lookups.set(key, result);
    if (result.error) return result.error;
    if (result.body === undefined) {
      return `Unable to load ticket '${ticketId}' in '${cwd}': tk show returned no ticket body.`;
    }
    ticketBodies.set(key, result.body);
    return undefined;
  };

  if (params.ticket !== undefined) {
    const error = prepare(params.ticket, effectiveCwd, "ticket");
    if (error) return { error };
  }
  for (const [index, task] of (params.tasks ?? []).entries()) {
    if (task.ticket === undefined) continue;
    const taskCwd = resolveChildCwd(effectiveCwd, task.cwd);
    const error = prepare(task.ticket, taskCwd, `tasks[${index}].ticket`);
    if (error) return { error };
  }

  return ticketBodies.size > 0 ? { ticketBodies } : {};
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

async function runAsyncPath(
  data: ExecutionContextData,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details> | null> {
  const {
    params,
    effectiveCwd,
    agents,
    ctx,
    shareEnabled,
    sessionRoot,
    sessionFileForTask,
    artifactConfig,
    artifactsDir,
    awaited,
    controlConfig,
    nestedRoute,
    ticketBodies,
  } = data;
  const hasTasks = (params.tasks?.length ?? 0) > 0;
  const hasSingle = !hasTasks && Boolean(params.agent);

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
    currentModel: ctx.model,
    modelScope: data.modelScope,
  };
  const modelRegistrySnapshot = readModelRegistrySnapshot(ctx);
  const { availableModels } = modelRegistrySnapshot;
  const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
  if (hasTasks && params.tasks) {
    const agentConfigs = params.tasks.map((task) =>
      agents.find((agent) => agent.name === task.agent),
    );
    const modelOverrides = params.tasks.map((task, index) =>
      resolveSubagentModelOverride(task.model ?? agentConfigs[index]?.model, ctx.model, {
        scope: data.modelScope,
        source: task.model ? "explicit" : "inherited",
      }),
    );
    const parallelTasks = params.tasks.map((task, index) => ({
      agent: task.agent,
      task: task.task,
      ...(task.ticket ? { ticket: task.ticket } : {}),
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
    return executeAsyncParallel(id, {
      awaited,
      signal: data.signal,
      onUpdate: data.onUpdate,
      tasks: parallelTasks,
      concurrency: resolveTopLevelParallelConcurrency(deps.config.parallel?.concurrency),
      agents,
      ctx: asyncCtx,
      availableModels,
      cwd: effectiveCwd,
      maxOutput: params.maxOutput,
      artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
      artifactConfig,
      shareEnabled,
      sessionRoot,
      sessionFilesByFlatIndex: params.tasks.map((task, index) =>
        sessionFileForTask(task.agent, index),
      ),
      maxSubagentDepth: currentMaxSubagentDepth,
      controlConfig,
      nestedRoute,
      timeoutMs: data.timeoutMs,
      projectAgentIdentities: data.projectAgentIdentities,
      ticketBodies,
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
    const maxSubagentDepth = resolveChildMaxSubagentDepth(
      currentMaxSubagentDepth,
      a.maxSubagentDepth,
    );
    const modelOverride = resolveSubagentModelOverride(
      (params.model as string | undefined) ?? a.model,
      ctx.model,
      {
        scope: data.modelScope,
        source: (params.model as string | undefined) ? "explicit" : "inherited",
      },
    );
    const executeSingle = deps.executeAsyncSingle ?? executeAsyncSingle;
    return executeSingle(id, {
      awaited,
      signal: data.signal,
      onUpdate: data.onUpdate,
      agent: params.agent!,
      task: params.task ?? "",
      ...(params.ticket ? { ticket: params.ticket } : {}),
      ...(params.ticket && ticketBodies
        ? { ticketBody: ticketBodies.get(ticketLookupKey(effectiveCwd, params.ticket)) }
        : {}),
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
      providerFallbackModels: providerFallbackModelsForTarget(params),
      modelFallbackNotice: params.modelFallbackNotice,
      maxSubagentDepth,
      controlConfig,
      nestedRoute,
      timeoutMs: data.timeoutMs,
      projectAgent: data.projectAgentIdentities?.find(
        (identity) => `embedded.${identity.slug}` === params.agent,
      ),
    });
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

async function executeDoctorAction(
  params: SubagentParamsLike,
  requestCwd: string,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details>> {
  let currentSessionFile: string | null = null;
  let currentSessionId = deps.state.currentSessionId;
  let sessionError: string | undefined;
  try {
    currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    currentSessionId = ctx.sessionManager.getSessionId();
  } catch (error) {
    sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  let projectAgentTrustOptions: Parameters<typeof resolveProjectAgentDoctorTrust>[1] = {};
  try {
    const access = normalizeProjectAgentAccess(
      deps.getProjectAgentAccess?.({
        cwd: requestCwd,
        sessionId: currentSessionId ?? null,
        targetNames: [],
      }),
    );
    if (access) {
      projectAgentTrustOptions = {
        ...(access.agentDir ? { agentDir: access.agentDir } : {}),
        ...(access.trustStore ? { trustStore: access.trustStore } : {}),
        ...(access.createProjectTrustStore
          ? { createProjectTrustStore: access.createProjectTrustStore }
          : {}),
      };
    }
  } catch {
    // The doctor must remain usable when the host authorization bridge is unavailable.
  }
  const projectAgentTrust = await resolveProjectAgentDoctorTrust(
    requestCwd,
    projectAgentTrustOptions,
  );
  return {
    content: [
      {
        type: "text",
        text: buildDoctorReport({
          cwd: requestCwd,
          config: deps.config,
          state: deps.state,
          requestedSessionDir: params.sessionDir,
          currentSessionFile,
          currentSessionId,
          sessionError,
          expandTilde: deps.expandTilde,
          projectAgentTrust,
          ...(deps.getHeartbeatSummary ? { heartbeat: deps.getHeartbeatSummary() } : {}),
        }),
      },
    ],
    details: { mode: "management", results: [] },
  };
}

function executeStatusAction(
  params: SubagentParamsLike,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): SubagentToolResult<Details> {
  try {
    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  } catch {
    return {
      content: [{ type: "text", text: "Status requires a current session identity." }],
      isError: true,
      details: { mode: "single", results: [] },
    };
  }
  const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
  return inspectSubagentStatus(buildRunStatusParams(params) as never, {
    state: deps.state,
    sessionRoots,
  });
}

function projectManagementError(text: string): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function awaitedLifecycleFailure(): SubagentToolResult<Details> {
  return {
    content: [
      {
        type: "text",
        text: "Awaited supervisor lifecycle update failed. The run was stopped safely and marked failed.",
      },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}
function projectManagementErrorFrom(error: unknown): SubagentToolResult<Details> {
  if (isAsyncStatusReadError(error)) return awaitedLifecycleFailure();
  return projectManagementError(error instanceof Error ? error.message : String(error));
}

async function executeSteerAction(
  params: SubagentParamsLike,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details>> {
  deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  const message = (params.message ?? params.task ?? "").trim();
  if (!message) {
    return projectManagementError("action='steer' requires message.");
  }
  if (params.dir) {
    try {
      const location = resolveAsyncRunLocation(params, ASYNC_DIR, RESULTS_DIR);
      const runId =
        location.resolvedId ?? params.id ?? path.basename(location.asyncDir ?? params.dir);
      await authorizeProjectSteerTarget({
        params: { ...params, id: runId, dir: location.asyncDir ?? params.dir },
        ctx,
        deps,
      });
      return steerAsyncRun({
        state: deps.state,
        runId,
        message,
        index: params.index,
        kill: deps.kill,
        location,
      }) as SubagentToolResult<Details>;
    } catch (error) {
      return projectManagementErrorFrom(error);
    }
  }
  if (!params.id) {
    return projectManagementError("action='steer' requires id or dir.");
  }
  let resolved: ResolvedSubagentRunId | undefined;
  try {
    resolved = resolveSubagentRunId(params.id, { state: deps.state });
  } catch (error) {
    return projectManagementError(error instanceof Error ? error.message : String(error));
  }
  if (resolved?.kind === "nested") {
    try {
      await authorizeNestedProjectAgentControl({
        target: resolved,
        ctx,
        deps,
        action: "steer",
        index: params.index,
      });
    } catch (error) {
      return projectManagementErrorFrom(error);
    }
    try {
      return steerNestedRun({ target: resolved, message, index: params.index });
    } catch (error) {
      return projectManagementErrorFrom(error);
    }
  }
  if (resolved?.kind !== "async") {
    return projectManagementError(`No async run found for '${params.id}'.`);
  }
  try {
    await authorizeProjectSteerTarget({ params, ctx, deps });
  } catch (error) {
    return projectManagementErrorFrom(error);
  }
  try {
    return steerAsyncRun({
      state: deps.state,
      runId: resolved.id,
      message,
      index: params.index,
      kill: deps.kill,
      location: resolved.location,
    }) as SubagentToolResult<Details>;
  } catch (error) {
    return projectManagementErrorFrom(error);
  }
}

function isPersistedCancellationState(status: AsyncStatus | null | undefined): boolean {
  const continuation = status?.lifecycle?.continuation;
  return (
    status?.state === "paused" ||
    status?.state === "cancelled" ||
    continuation?.phase === "launched" ||
    continuation?.phase === "continued" ||
    continuation?.continuedAt !== undefined
  );
}

async function executeInterruptAction(
  params: SubagentParamsLike,
  ctx: ExtensionContext,
  deps: ExecutorDeps,
): Promise<SubagentToolResult<Details>> {
  deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
  let resolved: ResolvedSubagentRunId | undefined;
  let selectedParams = params;
  try {
    const selected = selectInterruptTarget(params, deps.state);
    resolved = selected.target as ResolvedSubagentRunId;
    selectedParams = selected.params;
  } catch (error) {
    return projectManagementError(error instanceof Error ? error.message : String(error));
  }
  if (resolved?.kind === "nested") {
    if (hasMalformedProjectAgentControlMarker(resolved.match.run)) {
      return projectManagementError(
        projectRunAuthorizationError(
          "the nested target carries a malformed project-agent marker; refusing nested interrupt fallback.",
        ).message,
      );
    }
    try {
      await authorizeNestedProjectAgentControl({
        target: resolved,
        ctx,
        deps,
        action: "interrupt",
        index: params.index,
      });
    } catch (error) {
      return projectManagementErrorFrom(error);
    }
    try {
      return interruptNestedRun(resolved);
    } catch (error) {
      return projectManagementErrorFrom(error);
    }
  }
  const asyncInterruptTarget = resolved?.kind === "async" ? resolved : undefined;
  if (!asyncInterruptTarget) {
    return projectManagementError("No interrupt-capable run found in this session.");
  }
  try {
    await authorizeProjectInterruptTarget({
      params: selectedParams,
      ctx,
      deps,
    });
  } catch (error) {
    return projectManagementErrorFrom(error);
  }
  if (params.id?.trim() && asyncInterruptTarget.location.asyncDir) {
    let persistedStatus: AsyncStatus | null;
    try {
      persistedStatus = readStatus(asyncInterruptTarget.location.asyncDir);
    } catch (error) {
      if (isAsyncStatusReadError(error)) return awaitedLifecycleFailure();
      throw error;
    }
    if (isPersistedCancellationState(persistedStatus)) {
      return cancelPersistedPausedAsyncRun(
        asyncInterruptTarget.location.asyncDir,
        asyncInterruptTarget.id,
        params.index,
      );
    }
  }
  try {
    const result = interruptAsyncRun(
      deps.state,
      asyncInterruptTarget.id,
      deps.kill,
      asyncInterruptTarget.location,
    );
    return (result ??
      projectManagementError(
        "No interrupt-capable run found in this session.",
      )) as SubagentToolResult<Details>;
  } catch (error) {
    return projectManagementErrorFrom(error);
  }
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
  const executionPolicy = deps.executionPolicy ?? resolveExecutionPolicy(deps.config.execution);

  const execute = async (
    _id: string,
    params: SubagentParamsLike,
    signal: AbortSignal,
    onUpdate: ((r: SubagentToolResult<Details>) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<SubagentToolResult<Details>> => {
    deps.state.baseCwd = ctx.cwd;
    const requestParams = params;
    const requestCwd = resolveRequestedCwd(ctx.cwd, requestParams.cwd);
    const paramsWithResolvedCwd =
      requestParams.cwd === undefined ? requestParams : { ...requestParams, cwd: requestCwd };
    const retiredControlDetail = retiredExecutionControlError(paramsWithResolvedCwd);
    if (retiredControlDetail)
      return buildRequestedModeError(paramsWithResolvedCwd, retiredControlDetail);
    const unsupportedSavedChainDetail = unsupportedSavedChainInput(paramsWithResolvedCwd);
    if (unsupportedSavedChainDetail)
      return unsupportedSavedChainInputResult(
        paramsWithResolvedCwd,
        unsupportedSavedChainDetail,
      ) as SubagentToolResult<Details>;
    const statusTranscriptDetail = statusTranscriptOptionError(paramsWithResolvedCwd);
    if (statusTranscriptDetail)
      return buildRequestedModeError(paramsWithResolvedCwd, statusTranscriptDetail);
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
          executionPolicy,
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

    const ticketNormalized = normalizeExecutionTickets(paramsWithResolvedCwd);
    if (ticketNormalized.error) {
      return buildRequestedModeError(paramsWithResolvedCwd, ticketNormalized.error);
    }
    const normalized = normalizeRepeatedParallelCounts(ticketNormalized.params!);
    if (normalized.error) return normalized.error;
    let effectiveParams = normalized.params!;
    const runTimeoutMs =
      executionPolicy.maxRunTimeMs === false ? undefined : executionPolicy.maxRunTimeMs;
    const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
    const requestedExecutionCwd = effectiveParams.cwd ?? ctx.cwd;
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    const projectResolution = await resolveProjectAgentExecution(
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
      projectResolution.projectAgentIdentities,
      ctx.model,
    );
    const effectiveCwd = projectResolution.effectiveCwd;
    const discovered = projectResolution.discovered;
    const discoveredAgents = discovered.agents;
    const modelScope = discovered.modelScope;
    const agents = discoveredAgents;
    const runId = randomUUID().slice(0, 8);
    const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
    const nestedRoute = inheritedNestedRoute;
    const shareEnabled = effectiveParams.share === true;
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

    const ticketPreparation = prepareTicketBodies(effectiveParams, effectiveCwd);
    if (ticketPreparation.error) {
      return buildRequestedModeError(effectiveParams, ticketPreparation.error);
    }
    const ticketBodies = ticketPreparation.ticketBodies;
    const awaited = effectiveParams.async !== true;
    const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

    const artifactConfig: ResolvedArtifactConfig = {
      ...configuredArtifactConfig,
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
    const childSessionFileForTask = (_agentName: string, idx?: number) =>
      path.join(sessionDirForIndex(idx), "session.jsonl");
    const childSessionFileForIndex = (idx?: number) =>
      path.join(sessionDirForIndex(idx), "session.jsonl");

    const onUpdateWithContext = onUpdate;

    const execData: ExecutionContextData = {
      params: effectiveParams,
      effectiveCwd,
      ctx,
      signal,
      onUpdate: onUpdateWithContext,
      agents,
      awaited,
      ...(projectResolution.projectAgentIdentities
        ? { projectAgentIdentities: projectResolution.projectAgentIdentities }
        : {}),
      runId,
      shareEnabled,
      sessionRoot,
      sessionDirForIndex,
      sessionFileForIndex: childSessionFileForIndex,
      sessionFileForTask: childSessionFileForTask,
      artifactConfig,
      artifactsDir,
      controlConfig,
      nestedRoute,
      timeoutMs: runTimeoutMs,
      modelScope,
      ticketBodies,
    };

    try {
      const asyncResult = await runAsyncPath(execData, deps);
      if (asyncResult) return asyncResult;
      return toExecutionErrorResult(
        effectiveParams,
        new Error("The awaited subagent runner is unavailable."),
      );
    } catch (error) {
      return toExecutionErrorResult(effectiveParams, error);
    }
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
