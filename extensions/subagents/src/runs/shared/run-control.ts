import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAsyncRunLocation, type AsyncRunLocation } from "../background/async-resume.ts";
import { deliverInterruptRequest, requestAsyncSteer } from "../background/control-channel.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { resolveSubagentRunId } from "../background/run-id-resolver.ts";
import { readStatus } from "../../shared/utils.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.ts";
import {
  projectRunAuthorizationError,
  authorizePersistedProjectAgentRun,
} from "../shared/project-agent-control.ts";
import { NESTED_ASYNC_RUNS_DIR } from "./nested-control.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike, ExecutorDeps } from "./executor-types.ts";
import type {
  AsyncStatus,
  Details,
  SubagentState,
  SubagentToolResult,
} from "../../shared/types.ts";
import type { ResolvedSubagentRunId } from "../background/run-id-resolver.ts";

type KillFn = ExecutorDeps["kill"];
type AsyncInterruptTarget = { asyncId: string; asyncDir: string };
type AsyncInterruptResult =
  | { ok: true }
  | { ok: false; kind: "not_running" }
  | { ok: false; kind: "error"; error: string };
export { buildResumeModelResolution, resumeAsyncRun } from "../background/async-control-resume.ts";
export { cancelPersistedPausedAsyncRun } from "../background/async-cancellation.ts";
export function trustedSessionRootsForStatus(ctx: ExtensionContext, deps: ExecutorDeps): string[] {
  let currentSessionId;
  let parentSessionFile;
  try {
    currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
    parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
  } catch {
    return [];
  }
  if (!parentSessionFile) return [];
  if (deps.state?.currentSessionId !== currentSessionId) return [];
  return [deps.getSubagentSessionRoot(parentSessionFile)];
}
export {
  authorizeNestedProjectAgentControl,
  interruptNestedRun,
  steerNestedRun,
} from "./nested-control.ts";
export {
  readModelRegistrySnapshot,
  providerFallbackModelsForTarget,
  resolveSingleRunOutputBaseDir,
  unknownAgentMessage,
} from "./run-support.ts";
type AsyncInterruptFailure = Exclude<AsyncInterruptResult, { ok: true }>;

function isAsyncInterruptFailure(result: AsyncInterruptResult): result is AsyncInterruptFailure {
  return !result.ok;
}
function isAsyncInterruptNotRunning(
  result: AsyncInterruptFailure,
): result is Extract<AsyncInterruptFailure, { kind: "not_running" }> {
  return result.kind === "not_running";
}
export function buildRunStatusParams(params: SubagentParamsLike): {
  action: "status";
  id?: string;
  dir?: string;
  index?: number;
  view?: "transcript";
  lines?: number;
} {
  return {
    action: "status",
    id: params.id,
    dir: params.dir,
    index: params.index,
    view: params.view,
    lines: params.lines,
  };
}
export function buildManagementActionParams(params: SubagentParamsLike): SubagentParamsLike {
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
export function unsupportedSavedChainInputResult(
  params: SubagentParamsLike,
  detail: string,
): SubagentToolResult<Details> {
  const text = detail.startsWith("The Last Harness")
    ? detail
    : `${UNSUPPORTED_SAVED_CHAIN_INPUT_MESSAGE} ${detail}`;
  return {
    content: [{ type: "text", text }],
    isError: true,
    details: { mode: params.action ? "management" : getRequestedModeLabel(params), results: [] },
  };
}
export function unsupportedSavedChainInput(params: SubagentParamsLike): string | undefined {
  if (params.chain !== undefined) return "Omit 'chain'.";
  if (params.chainName !== undefined) return "Omit 'chainName'.";
  if (params.chainDir !== undefined) return "Omit 'chainDir'.";
  if (params.clarify !== undefined)
    return "The Last Harness does not support the chain clarify UI; omit 'clarify'.";
  return undefined;
}
export function getRequestedModeLabel(params: SubagentParamsLike): "single" | "parallel" {
  if ((params.tasks?.length ?? 0) > 0) return "parallel";
  if (params.agent) return "single";
  return "single";
}
function getAsyncInterruptTarget(
  state: SubagentState,
  runId?: string,
  location?: AsyncRunLocation,
): AsyncInterruptTarget | undefined {
  if (location) {
    if (location.asyncDir) {
      return {
        asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
        asyncDir: location.asyncDir,
      };
    }
    if (runId) {
      const direct = state.asyncJobs.get(runId);
      if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
    }
    return undefined;
  }
  if (runId) {
    const direct = state.asyncJobs.get(runId);
    if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
    return undefined;
  }
  let newest;
  for (const job of state.asyncJobs.values()) {
    if (job.status !== "running") continue;
    if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
      newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
    }
  }
  return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}
function resolvedAsyncInterruptTarget(
  target: AsyncInterruptTarget,
): ResolvedSubagentRunId & { kind: "async" } {
  return {
    kind: "async",
    id: target.asyncId,
    location: {
      asyncDir: target.asyncDir,
      resultPath: null,
      resolvedId: target.asyncId,
    },
  };
}
export function selectInterruptTarget(
  params: SubagentParamsLike,
  state: SubagentState,
): { target: ResolvedSubagentRunId | undefined; params: SubagentParamsLike } {
  const requestedId = params.id?.trim();
  if (params.dir) {
    const location = resolveAsyncRunLocation(params, ASYNC_DIR, RESULTS_DIR);
    const runId = location.resolvedId ?? path.basename(path.resolve(params.dir));
    if (!runId) return { target: undefined, params };
    return {
      target: { kind: "async", id: runId, location },
      params: { ...params, id: runId },
    };
  }
  if (requestedId) {
    const resolved = resolveSubagentRunId(requestedId, { state });
    if (resolved) return { target: resolved, params: { ...params, id: resolved.id } };
    const asyncTarget = getAsyncInterruptTarget(state, requestedId);
    if (asyncTarget) {
      const target = resolvedAsyncInterruptTarget(asyncTarget);
      return {
        target,
        params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
      };
    }
    return { target: undefined, params };
  }
  const asyncTarget = getAsyncInterruptTarget(state, undefined);
  if (!asyncTarget) return { target: undefined, params };
  const target = resolvedAsyncInterruptTarget(asyncTarget);
  return {
    target,
    params: { ...params, id: target.id, dir: asyncTarget.asyncDir },
  };
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
  target: AsyncInterruptTarget,
  kill?: KillFn,
): AsyncInterruptResult {
  const resultsDir = resolveAsyncResultsDir(target.asyncDir);
  const status = reconcileAsyncRun(
    target.asyncDir,
    resultsDir ? { kill, resultsDir } : { kill },
  ).status;
  if (!status || status.state !== "running" || typeof status.pid !== "number") {
    return { ok: false, kind: "not_running" };
  }
  try {
    deliverInterruptRequest({
      asyncDir: target.asyncDir,
      pid: status.pid,
      kill,
      source: "interrupt-action",
    });
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
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function normalizeComparableCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function diskOnlyAsyncStatusBelongsElsewhere(state: SubagentState, status: AsyncStatus): boolean {
  if (state.currentSessionId && status.sessionId)
    return state.currentSessionId !== status.sessionId;
  if (
    state.baseCwd &&
    status.cwd &&
    normalizeComparableCwd(state.baseCwd) !== normalizeComparableCwd(status.cwd)
  )
    return true;
  return false;
}
function discoverDiskOnlyRunningAsyncTargets(
  state: SubagentState,
  knownAsyncDirs: ReadonlySet<string>,
): { targets: AsyncInterruptTarget[]; errors: string[] } {
  const targets: AsyncInterruptTarget[] = [];
  const errors = [];
  const candidates = [];
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
          candidates.push({
            asyncDir: path.join(rootDir, runEntry.name),
            fallbackId: runEntry.name,
          });
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
      if (
        !rawStatus ||
        rawStatus.state !== "running" ||
        diskOnlyAsyncStatusBelongsElsewhere(state, rawStatus)
      )
        continue;
      const resultsDir = resolveAsyncResultsDir(candidate.asyncDir);
      const status = reconcileAsyncRun(candidate.asyncDir, resultsDir ? { resultsDir } : {}).status;
      if (status?.state === "running") {
        targets.push({
          asyncId:
            typeof status.runId === "string" && status.runId ? status.runId : candidate.fallbackId,
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
export function requestInterruptAllRunningSubagentRuns(state: SubagentState): {
  asyncRunIds: string[];
  skippedAsyncRunIds: string[];
  errors: string[];
} {
  const result: {
    asyncRunIds: string[];
    skippedAsyncRunIds: string[];
    errors: string[];
  } = {
    asyncRunIds: [],
    skippedAsyncRunIds: [],
    errors: [],
  };
  const knownAsyncDirs = new Set<string>();
  for (const job of state.asyncJobs.values()) {
    knownAsyncDirs.add(job.asyncDir);
    const interruptResult = requestAsyncInterruptForTarget(state, {
      asyncId: job.asyncId,
      asyncDir: job.asyncDir,
    });
    if (!isAsyncInterruptFailure(interruptResult)) {
      result.asyncRunIds.push(job.asyncId);
    } else if (interruptResult.kind === "error") {
      result.errors.push(
        `Failed to interrupt async run ${job.asyncId}: ${interruptResult.error ?? "unknown error"}`,
      );
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
export function interruptAsyncRun(
  state: SubagentState,
  runId: string | undefined,
  kill?: KillFn,
  location?: AsyncRunLocation,
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
export function steerAsyncRun(input: {
  state: SubagentState;
  runId: string;
  message: string;
  index?: number;
  kill?: KillFn;
  location: AsyncRunLocation;
}): SubagentToolResult<Details> {
  if (!input.location.asyncDir) {
    return {
      content: [
        { type: "text", text: `Async run '${input.runId}' has no live run directory to steer.` },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
  const status = reconcileAsyncRun(input.location.asyncDir, { kill: input.kill }).status;
  if (!status || (status.state !== "running" && status.state !== "queued")) {
    return {
      content: [
        {
          type: "text",
          text: `Async run '${input.runId}' is not running or queued and cannot be steered.`,
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
export async function authorizeProjectSteerTarget(input: {
  params: SubagentParamsLike;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<void> {
  let location;
  try {
    location = resolveAsyncRunLocation(input.params, ASYNC_DIR, RESULTS_DIR);
  } catch (error) {
    throw projectRunAuthorizationError(
      error instanceof Error ? error.message : "the persisted control target is invalid.",
    );
  }
  if (!location.asyncDir) return;
  const status = readStatus(location.asyncDir);
  if (!status || status.runId !== location.resolvedId) return;
  const steps = status.steps ?? [];
  const selected =
    input.params.index !== undefined
      ? steps.slice(input.params.index, input.params.index + 1)
      : steps.length === 1
        ? steps
        : steps.filter((step) => step.status === "running" || step.status === "pending");
  for (const step of selected) {
    if (!step.agent.startsWith("embedded.")) continue;
    await authorizePersistedProjectAgentRun({
      target: {
        runId: status.runId,
        agent: step.agent,
        cwd: step.cwd ?? status.cwd,
        projectAgent: step.projectAgent,
      },
      ctx: input.ctx,
      deps: input.deps,
    });
  }
}

export async function authorizeProjectInterruptTarget(input: {
  params: SubagentParamsLike;
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<void> {
  let location;
  try {
    location = resolveAsyncRunLocation(input.params, ASYNC_DIR, RESULTS_DIR);
  } catch (error) {
    throw projectRunAuthorizationError(
      error instanceof Error ? error.message : "the persisted interrupt target is invalid.",
    );
  }
  if (!location.asyncDir) return;
  const status = readStatus(location.asyncDir);
  if (!status || status.runId !== location.resolvedId) return;
  for (const step of status.steps ?? []) {
    if (!step.agent.startsWith("embedded.")) continue;
    await authorizePersistedProjectAgentRun({
      target: {
        runId: status.runId,
        agent: step.agent,
        cwd: step.cwd ?? status.cwd,
        projectAgent: step.projectAgent,
      },
      ctx: input.ctx,
      deps: input.deps,
      requireArchitect: false,
    });
  }
}
