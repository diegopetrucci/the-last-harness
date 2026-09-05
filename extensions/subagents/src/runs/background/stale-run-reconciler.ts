import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  RESULTS_DIR,
  type AsyncResultArtifact,
  type AsyncStatus,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ContextUsageDiagnostics,
  type NestedRunSummary,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentRunMode,
  type SubagentTerminationReason,
  normalizeSubagentRunMode,
} from "../../shared/types.ts";
import { createAsyncStatusJsonParseError } from "./async-status-corruption.ts";
import {
  nestedSummaryFromAsyncStatus,
  projectNestedEvents,
  resolveNestedAsyncDir,
  writeNestedEvent,
  type NestedRoute,
} from "../shared/nested-events.ts";
import {
  checkPidLiveness,
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
  normalizeAsyncLifecycleStatus,
  recoverStoppedLifecycleOwnership,
} from "../shared/lifecycle-state.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
  parseSubagentTerminationReason,
} from "../../shared/context-diagnostics.ts";
import {
  sanitizeSubagentModelIdentity,
  sanitizeSubagentModelResolution,
} from "../shared/model-fallback.ts";
import { parseThinkingLevel } from "../../shared/model-info.ts";
import { normalizeProjectAgentRunCapture } from "../../agents/project-agent-snapshot.ts";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
  runId: string;
  pid?: number;
  sessionId?: string;
  mode?: SubagentRunMode;
  agents?: string[];
  startedAt?: number;
  sessionFile?: string;
  projectAgents?: import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture[];
}

interface ReconcileAsyncRunOptions {
  resultsDir?: string;
  kill?: KillFn;
  now?: () => number;
  startedRun?: StartedRunMetadata;
  missingStatusGraceMs?: number;
  staleAlivePidMs?: number;
}

interface ReconcileAsyncRunResult {
  status: AsyncStatus | null;
  repaired: boolean;
  resultPath?: string;
  message?: string;
}

interface StaleRunRepairEvent {
  type: "subagent.run.repaired_stale";
  ts: number;
  runId: string;
  pid?: number;
  resultPath: string;
  message: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
  const stderrPath = path.join(asyncDir, "runner.stderr.log");
  const maxBytes = 64 * 1024;
  let content: string;
  try {
    const stat = fs.statSync(stderrPath);
    if (stat.size <= 0) return undefined;
    const fd = fs.openSync(stderrPath, "r");
    try {
      const bytesToRead = Math.min(stat.size, maxBytes);
      const start = Math.max(0, stat.size - bytesToRead);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, start);
      content = buffer.toString("utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (!content) return undefined;
  const lines = content.split(/\r?\n/).slice(-30).join("\n");
  return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function appendJsonlBestEffort(filePath: string, payload: StaleRunRepairEvent): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
  } catch {
    // Repair status/result writes are the important path. A broken or full
    // diagnostic event log must not make stale-run reconciliation fail.
  }
}

function readStatusFile(asyncDir: string): AsyncStatus | null {
  const statusPath = path.join(asyncDir, "status.json");
  let content: string;
  try {
    content = fs.readFileSync(statusPath, "utf-8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  try {
    return normalizeAsyncLifecycleStatus(JSON.parse(content) as AsyncStatus);
  } catch (error) {
    throw createAsyncStatusJsonParseError({
      asyncDir,
      statusPath,
      content,
      cause: error,
    });
  }
}

interface ResultChildOutcome {
  agent?: string;
  success?: boolean;
  error?: string;
  sessionFile?: string;
  model?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  attemptedModels?: string[];
  modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  projectAgent?: import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture;
}

interface ResultRepairData {
  state: "complete" | "failed" | "paused" | "cancelled" | "continued" | "pausing";
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  results?: ResultChildOutcome[];
  projectAgents?: import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture[];
}

type AsyncStatusStep = NonNullable<AsyncStatus["steps"]>[number];

function sanitizeStatusStep(step: AsyncStatusStep): AsyncStatusStep {
  const {
    modelIdentity: _modelIdentity,
    modelResolution: _modelResolution,
    thinking: _thinking,
    activeRuntimeMs: _activeRuntimeMs,
    activeRuntimeCheckpointAt: _activeRuntimeCheckpointAt,
    ...rest
  } = step;
  const activeRuntimeMs = normalizeActiveRuntimeMs(step.activeRuntimeMs);
  const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
    step.activeRuntimeCheckpointAt,
  );
  const modelIdentity = sanitizeSubagentModelIdentity(step.modelIdentity);
  const modelResolution = sanitizeSubagentModelResolution(step.modelResolution);
  const thinking = parseThinkingLevel(step.thinking);
  return {
    ...rest,
    ...(modelIdentity ? { modelIdentity } : {}),
    ...(modelResolution ? { modelResolution } : {}),
    ...(thinking ? { thinking } : {}),
    ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
    ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
  };
}

function readResultRepairData(resultPath: string): ResultRepairData | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Async result file '${resultPath}' must contain a JSON object.`);
    }
    const data = parsed as Record<string, unknown>;
    const state =
      data.success === true
        ? "complete"
        : data.state === "cancelled" || data.state === "continued" || data.state === "pausing"
          ? data.state
          : data.state === "paused" || data.exitCode === 0
            ? "paused"
            : "failed";
    const projectMarkerPresent =
      Object.hasOwn(data, "projectAgent") ||
      Object.hasOwn(data, "projectAgents") ||
      (Array.isArray(data.results) &&
        data.results.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            Object.hasOwn(entry, "projectAgent"),
        ));
    const projectAgents = Array.isArray(data.projectAgents)
      ? data.projectAgents
          .map((capture) => normalizeProjectAgentRunCapture(capture))
          .filter(
            (
              capture,
            ): capture is import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture =>
              Boolean(capture),
          )
      : undefined;
    const activeRuntimeMs = normalizeActiveRuntimeMs(data.activeRuntimeMs);
    const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
      data.activeRuntimeCheckpointAt,
    );
    const results = Array.isArray(data.results)
      ? data.results.map((entry): ResultChildOutcome => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
          const child = entry as Record<string, unknown>;
          const contextUsage = parseContextUsageDiagnostics(child.contextUsage);
          const projectAgent = normalizeProjectAgentRunCapture(child.projectAgent);
          const contextPressure = parseContextPressureProjection(child.contextPressure);
          const contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
            child.contextPressureCrossedThresholds,
          );
          const terminationReason = parseSubagentTerminationReason(child.terminationReason);
          const modelIdentity = sanitizeSubagentModelIdentity(child.modelIdentity);
          const modelResolution = sanitizeSubagentModelResolution(child.modelResolution);
          const attemptedModels = Array.isArray(child.attemptedModels)
            ? child.attemptedModels.filter((value): value is string => typeof value === "string")
            : undefined;
          const activeRuntimeMs = normalizeActiveRuntimeMs(child.activeRuntimeMs);
          const activeRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
            child.activeRuntimeCheckpointAt,
          );
          return {
            ...(typeof child.agent === "string" ? { agent: child.agent } : {}),
            ...(projectAgent ? { projectAgent } : {}),
            ...(typeof child.success === "boolean" ? { success: child.success } : {}),
            ...(typeof child.error === "string" ? { error: child.error } : {}),
            ...(typeof child.sessionFile === "string" ? { sessionFile: child.sessionFile } : {}),
            ...(typeof child.model === "string" ? { model: child.model } : {}),
            ...(modelIdentity ? { modelIdentity } : {}),
            ...(modelResolution ? { modelResolution } : {}),
            ...(attemptedModels?.length ? { attemptedModels } : {}),
            ...(contextUsage ? { contextUsage } : {}),
            ...(contextPressure ? { contextPressure } : {}),
            ...(contextPressureCrossedThresholds ? { contextPressureCrossedThresholds } : {}),
            ...(terminationReason ? { terminationReason } : {}),
            ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
            ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
          };
        })
      : undefined;
    return {
      state,
      ...(activeRuntimeMs !== undefined ? { activeRuntimeMs } : {}),
      ...(activeRuntimeCheckpointAt !== undefined ? { activeRuntimeCheckpointAt } : {}),
      ...(results ? { results } : {}),
      ...(projectAgents ? { projectAgents } : projectMarkerPresent ? { projectAgents: [] } : {}),
    };
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
}

function childState(
  overallState: ResultRepairData["state"],
  child: ResultChildOutcome | undefined,
): "complete" | "failed" | "paused" | "continued" | "pausing" {
  if (child?.success === true) return "complete";
  if (child?.success === false) return "failed";
  return overallState === "cancelled" ? "paused" : overallState;
}

function terminalStatusFromResult(
  status: AsyncStatus,
  resultPath: string,
  now: number,
): AsyncStatus | undefined {
  const repair = readResultRepairData(resultPath);
  if (!repair) return undefined;
  const steps = (status.steps ?? []).map((step, index) => {
    const sanitizedStep = sanitizeStatusStep(step);
    const child = repair.results?.[index];
    const persistedActiveRuntimeMs = normalizeActiveRuntimeMs(step.activeRuntimeMs);
    const persistedActiveRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
      step.activeRuntimeCheckpointAt,
    );
    const childActiveRuntimeMs = normalizeActiveRuntimeMs(child?.activeRuntimeMs);
    const childActiveRuntimeCheckpointAt = normalizeActiveRuntimeCheckpointAt(
      child?.activeRuntimeCheckpointAt,
    );
    if (step.status !== "running" && step.status !== "pending") {
      return {
        ...sanitizedStep,
        ...(persistedActiveRuntimeMs !== undefined || childActiveRuntimeMs !== undefined
          ? {
              activeRuntimeMs: Math.max(persistedActiveRuntimeMs ?? 0, childActiveRuntimeMs ?? 0),
            }
          : {}),
        ...(persistedActiveRuntimeCheckpointAt !== undefined ||
        childActiveRuntimeCheckpointAt !== undefined
          ? {
              activeRuntimeCheckpointAt: Math.max(
                persistedActiveRuntimeCheckpointAt ?? 0,
                childActiveRuntimeCheckpointAt ?? 0,
              ),
            }
          : {}),
      };
    }
    const state = childState(repair.state, child);
    return {
      ...sanitizedStep,
      status:
        state === "complete"
          ? ("complete" as const)
          : state === "continued"
            ? ("continued" as const)
            : state === "pausing"
              ? ("pausing" as const)
              : state,
      endedAt: step.endedAt ?? now,
      durationMs:
        step.startedAt !== undefined && step.durationMs === undefined
          ? Math.max(0, now - step.startedAt)
          : step.durationMs,
      // A terminal child result or the latest checkpoint is authoritative.
      // Never charge the interval while this detached process was offline:
      // that gap may include an arbitrarily long paused/sleeping period.
      activeRuntimeMs:
        [persistedActiveRuntimeMs, childActiveRuntimeMs].filter(
          (value): value is number => value !== undefined,
        ).length > 0
          ? Math.max(persistedActiveRuntimeMs ?? 0, childActiveRuntimeMs ?? 0)
          : undefined,
      activeRuntimeCheckpointAt:
        childActiveRuntimeMs !== undefined
          ? Math.max(persistedActiveRuntimeCheckpointAt ?? 0, childActiveRuntimeCheckpointAt ?? now)
          : (persistedActiveRuntimeCheckpointAt ??
            normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt)),
      exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
      error: state === "failed" ? (step.error ?? child?.error) : step.error,
      sessionFile: step.sessionFile ?? child?.sessionFile,
      model: step.model ?? child?.model,
      modelIdentity: sanitizedStep.modelIdentity ?? child?.modelIdentity,
      modelResolution: sanitizedStep.modelResolution ?? child?.modelResolution,
      attemptedModels: step.attemptedModels ?? child?.attemptedModels,
      modelAttempts: step.modelAttempts ?? child?.modelAttempts,
      contextUsage: step.contextUsage ?? child?.contextUsage,
      contextPressure: step.contextPressure ?? child?.contextPressure,
      contextPressureCrossedThresholds:
        step.contextPressureCrossedThresholds ?? child?.contextPressureCrossedThresholds,
      terminationReason:
        step.terminationReason ??
        child?.terminationReason ??
        (state === "failed" ? "process_exit" : undefined),
      ...((step.projectAgent ?? child?.projectAgent)
        ? { projectAgent: step.projectAgent ?? child?.projectAgent }
        : {}),
    };
  });
  const stepActiveRuntimeMs = steps
    .map((step) => normalizeActiveRuntimeMs(step.activeRuntimeMs))
    .filter((value): value is number => value !== undefined);
  const reconciledActiveRuntimeMs = [
    normalizeActiveRuntimeMs(status.activeRuntimeMs),
    repair.activeRuntimeMs,
    ...(stepActiveRuntimeMs.length > 0
      ? [stepActiveRuntimeMs.reduce((sum, value) => sum + value, 0)]
      : []),
  ].filter((value): value is number => value !== undefined);
  const stepActiveRuntimeCheckpointAt = steps
    .map((step) => normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt))
    .filter((value): value is number => value !== undefined);
  const reconciledActiveRuntimeCheckpointAt = [
    normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt),
    repair.activeRuntimeCheckpointAt,
    ...(stepActiveRuntimeCheckpointAt.length > 0
      ? [Math.max(...stepActiveRuntimeCheckpointAt)]
      : []),
  ].filter((value): value is number => value !== undefined);
  return {
    ...status,
    state: repair.state,
    activityState: undefined,
    lastUpdate: now,
    endedAt: status.endedAt ?? now,
    steps,
    ...(repair.projectAgents ? { projectAgents: repair.projectAgents } : {}),
    ...(reconciledActiveRuntimeMs.length > 0
      ? { activeRuntimeMs: Math.max(...reconciledActiveRuntimeMs) }
      : {}),
    ...(reconciledActiveRuntimeCheckpointAt.length > 0
      ? { activeRuntimeCheckpointAt: Math.max(...reconciledActiveRuntimeCheckpointAt) }
      : {}),
  };
}

function buildStartedStatus(
  asyncDir: string,
  startedRun: StartedRunMetadata,
  now: number,
): AsyncStatus {
  const startedAt = startedRun.startedAt ?? now;
  const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
  return {
    runId: startedRun.runId || path.basename(asyncDir),
    ...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
    mode: normalizeSubagentRunMode(startedRun.mode),
    state: "running",
    pid: startedRun.pid,
    startedAt,
    lastUpdate: now,
    currentStep: 0,
    ...(startedRun.projectAgents ? { projectAgents: startedRun.projectAgents } : {}),
    steps: agents.map((agent) => ({
      agent,
      status: "running" as const,
      startedAt,
    })),
    ...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
  };
}

function buildFailedRepair(
  status: AsyncStatus,
  asyncDir: string,
  now: number,
  reason?: string,
): { status: AsyncStatus; result: AsyncResultArtifact; message: string } {
  const runId = status.runId || path.basename(asyncDir);
  const pid = typeof status.pid === "number" ? status.pid : "unknown";
  const baseMessage =
    reason ??
    `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
  const diagnostics = readRunnerStartupDiagnostics(asyncDir);
  const message = diagnostics
    ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}`
    : baseMessage;
  const steps = (
    status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }]
  ).map(sanitizeStatusStep);
  const repairedSteps = steps
    .map((step) =>
      step.status === "running" || step.status === "pending" || step.status === "pausing"
        ? {
            ...step,
            status: "failed" as const,
            activityState: undefined,
            endedAt: step.endedAt ?? now,
            durationMs:
              step.startedAt !== undefined && step.durationMs === undefined
                ? Math.max(0, now - step.startedAt)
                : step.durationMs,
            // Legacy records without a checkpoint intentionally retain only
            // their persisted evidence; the offline wall-clock gap is unknown.
            ...(normalizeActiveRuntimeMs(step.activeRuntimeMs) !== undefined
              ? { activeRuntimeMs: normalizeActiveRuntimeMs(step.activeRuntimeMs) }
              : {}),
            ...(normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt) !== undefined
              ? {
                  activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
                    step.activeRuntimeCheckpointAt,
                  ),
                }
              : {}),
            exitCode: step.exitCode ?? 1,
            error: step.error ?? message,
            terminationReason: step.terminationReason ?? "process_exit",
          }
        : step,
    )
    .map((step) =>
      step.status === "failed" && !step.terminationReason
        ? { ...step, terminationReason: "process_exit" as const }
        : step,
    );
  const repairedRuntimeValues = repairedSteps
    .map((step) => normalizeActiveRuntimeMs(step.activeRuntimeMs))
    .filter((value): value is number => value !== undefined);
  const repairedCheckpointValues = repairedSteps
    .map((step) => normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt))
    .filter((value): value is number => value !== undefined);
  const repairedActiveRuntimeMs = [
    normalizeActiveRuntimeMs(status.activeRuntimeMs),
    ...(repairedRuntimeValues.length > 0
      ? [repairedRuntimeValues.reduce((sum, value) => sum + value, 0)]
      : []),
  ].filter((value): value is number => value !== undefined);
  const repairedActiveRuntimeCheckpointAt = [
    normalizeActiveRuntimeCheckpointAt(status.activeRuntimeCheckpointAt),
    ...(repairedCheckpointValues.length > 0 ? [Math.max(...repairedCheckpointValues)] : []),
  ].filter((value): value is number => value !== undefined);
  const repairedStatus: AsyncStatus = {
    ...status,
    state: "failed",
    activityState: undefined,
    lastUpdate: now,
    endedAt: now,
    steps: repairedSteps,
    ...(repairedActiveRuntimeMs.length > 0
      ? { activeRuntimeMs: Math.max(...repairedActiveRuntimeMs) }
      : {}),
    ...(repairedActiveRuntimeCheckpointAt.length > 0
      ? { activeRuntimeCheckpointAt: Math.max(...repairedActiveRuntimeCheckpointAt) }
      : {}),
  };
  const resultAgent =
    repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
  return {
    status: repairedStatus,
    message,
    result: {
      id: runId,
      agent: resultAgent,
      mode: status.mode,
      success: false,
      state: "failed",
      summary: message,
      results: repairedSteps.map((step) => ({
        agent: step.agent,
        ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
        output: step.status === "complete" || step.status === "completed" ? "" : message,
        error:
          step.status === "complete" || step.status === "completed"
            ? undefined
            : (step.error ?? message),
        success: step.status === "complete" || step.status === "completed",
        model: step.model,
        modelIdentity: step.modelIdentity,
        modelResolution: step.modelResolution,
        attemptedModels: step.attemptedModels,
        modelAttempts: step.modelAttempts,
        contextUsage: step.contextUsage,
        contextPressure: step.contextPressure,
        contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
        ...(step.terminationReason
          ? { terminationReason: step.terminationReason }
          : step.status !== "complete" && step.status !== "completed"
            ? { terminationReason: "process_exit" as const }
            : {}),
        sessionFile: step.sessionFile,
        activeRuntimeMs: step.activeRuntimeMs,
        activeRuntimeCheckpointAt: step.activeRuntimeCheckpointAt,
      })),
      exitCode: 1,
      timestamp: now,
      durationMs: Math.max(0, now - status.startedAt),
      ...(repairedStatus.activeRuntimeMs !== undefined
        ? { activeRuntimeMs: repairedStatus.activeRuntimeMs }
        : {}),
      ...(repairedStatus.activeRuntimeCheckpointAt !== undefined
        ? { activeRuntimeCheckpointAt: repairedStatus.activeRuntimeCheckpointAt }
        : {}),
      asyncDir,
      sessionId: status.sessionId,
      ...(status.projectAgents ? { projectAgents: status.projectAgents } : {}),
      sessionFile: status.sessionFile,
    } satisfies AsyncResultArtifact,
  };
}

function writeFailedRepair(
  asyncDir: string,
  status: AsyncStatus,
  resultPath: string,
  now: number,
  reason?: string,
): ReconcileAsyncRunResult {
  const repair = buildFailedRepair(status, asyncDir, now, reason);
  writeAtomicJson(resultPath, repair.result);
  writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
  appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
    type: "subagent.run.repaired_stale",
    ts: now,
    runId: repair.status.runId,
    pid: status.pid,
    resultPath,
    message: repair.message,
  });
  return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

function terminal(state: AsyncStatus["state"]): boolean {
  return (
    state === "complete" ||
    state === "failed" ||
    state === "paused" ||
    state === "cancelled" ||
    state === "continued"
  );
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
  for (const child of children ?? []) {
    yield child;
    yield* nestedRuns(child.children);
    yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
  }
}

export function reconcileNestedAsyncDescendants(
  route: NestedRoute,
  options: ReconcileAsyncRunOptions = {},
): void {
  const registry = projectNestedEvents(route);
  for (const run of nestedRuns(registry.children)) {
    if (run.state !== "running" && run.state !== "queued") continue;
    const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
    if (!asyncDir) continue;
    const result = reconcileAsyncRun(asyncDir, {
      ...options,
      resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
    });
    const status = result.status;
    if (!status) continue;
    if (!result.repaired && !terminal(status.state)) continue;
    const ts = options.now?.() ?? Date.now();
    writeNestedEvent(route, {
      type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
      ts,
      parentRunId: run.parentRunId,
      parentStepIndex: run.parentStepIndex,
      child: nestedSummaryFromAsyncStatus(status, asyncDir, {
        id: run.id,
        parentRunId: run.parentRunId,
        parentStepIndex: run.parentStepIndex,
        depth: run.depth,
        path: run.path,
        mode: run.mode,
        ts,
      }),
    });
  }
}

export { checkPidLiveness };

export function reconcileAsyncRun(
  asyncDir: string,
  options: ReconcileAsyncRunOptions = {},
): ReconcileAsyncRunResult {
  const now = options.now?.() ?? Date.now();
  const status = readStatusFile(asyncDir);
  const startedStatus =
    !status && options.startedRun
      ? buildStartedStatus(asyncDir, options.startedRun, now)
      : undefined;
  const effectiveStatus = status ?? startedStatus;
  if (!effectiveStatus) return { status: null, repaired: false };

  const runId = effectiveStatus.runId || path.basename(asyncDir);
  const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
  if (
    effectiveStatus.state === "paused" ||
    effectiveStatus.state === "cancelled" ||
    effectiveStatus.state === "continued" ||
    effectiveStatus.state === "pausing"
  ) {
    const recovered = recoverStoppedLifecycleOwnership(effectiveStatus, {
      kill: options.kill,
      now: options.now,
    });
    if (recovered.repaired) {
      writeAtomicJson(path.join(asyncDir, "status.json"), recovered.status);
      return {
        status: recovered.status,
        repaired: true,
        resultPath,
        message:
          effectiveStatus.state === "pausing"
            ? `Stale pausing lifecycle finalized to paused after child pid ${effectiveStatus.pid} exited.`
            : recovered.pidLiveness === "alive"
              ? `Stopped lifecycle state discarded persisted pid ${effectiveStatus.pid} because ownership could not be verified after pause/cancel recovery.`
              : recovered.pidLiveness === "unknown"
                ? `Stopped lifecycle state discarded persisted pid ${effectiveStatus.pid} because ownership could not be verified.`
                : `Stopped lifecycle state cleared dead persisted pid ${effectiveStatus.pid}.`,
      };
    }
    if (effectiveStatus.state === "pausing" && recovered.pidLiveness === "dead") {
      const terminalFromResult = terminalStatusFromResult(effectiveStatus, resultPath, now);
      if (terminalFromResult) {
        writeAtomicJson(path.join(asyncDir, "status.json"), terminalFromResult);
        return {
          status: terminalFromResult,
          repaired: true,
          resultPath,
          message: "Existing async result file was used to finalize a stale pausing status.",
        };
      }
      return writeFailedRepair(
        asyncDir,
        effectiveStatus,
        resultPath,
        now,
        `Persisted pausing run '${runId}' could not be finalized to paused because safe resume metadata was incomplete.`,
      );
    }
  }

  if (fs.existsSync(resultPath)) {
    const terminalStatus =
      effectiveStatus.state === "running" || effectiveStatus.state === "queued"
        ? terminalStatusFromResult(effectiveStatus, resultPath, now)
        : undefined;
    if (terminalStatus) {
      writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
      return {
        status: terminalStatus,
        repaired: true,
        resultPath,
        message: "Existing async result file was used to repair stale running status.",
      };
    }
    return { status: effectiveStatus, repaired: false, resultPath };
  }

  if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
    return { status: status ?? null, repaired: false, resultPath };
  }

  if (!status) {
    const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
    if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
      return { status: null, repaired: false, resultPath };
    }
  }

  const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
  if (liveness !== "dead") {
    const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
    const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
    if (now - lastUpdate <= staleAfterMs)
      return { status: status ?? null, repaired: false, resultPath };
    const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
    return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
  }

  return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
