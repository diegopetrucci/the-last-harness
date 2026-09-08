import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectAgentRunCapture } from "../../agents/project-agent-snapshot.ts";
import { getArtifactPaths } from "../../shared/artifacts.ts";
import {
  type ActivityState,
  type AsyncStatus,
  type NestedRouteInfo,
  type ResolvedArtifactConfig,
  type ResolvedToolBudget,
  type TkTicketMetadata,
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
} from "../../shared/types.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import {
  boundChildError,
  claimChildTerminalReason,
  formatProtocolOutputLimit,
  type ChildTerminalReasonLatch,
  type ProtocolOutputLimit,
} from "../shared/child-protocol.ts";
import { buildSkippedAcceptanceLedger } from "../shared/acceptance.ts";
import {
  ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS,
  TERMINAL_RUN_STATES,
  applyActiveRuntimeCheckpoint,
  boundedActiveRuntimeMs,
  lifecycleGeneration,
  mergeAndWriteSourceRunnerStatus,
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
  transitionLifecycleStatus,
  writeNormalizedLifecycleStatus,
  isLifecycleTransitionContentionError,
  type ActiveRuntimeCheckpointUpdate,
  type ActiveRuntimeTracker,
} from "../shared/lifecycle-state.ts";
import type {
  RunnerSubagentStep as SubagentStep,
  SubagentRunPlan,
} from "../shared/parallel-utils.ts";
import type { runSingleStep } from "./single-step-execution.ts";

type SingleStepResultValue = Awaited<ReturnType<typeof runSingleStep>>;
import { initialToolBudgetState } from "../shared/tool-budget.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
} from "../../shared/context-diagnostics.ts";
import { sanitizeModelFallbackNotice } from "../shared/model-fallback.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  createHealthTransitionState,
  resetHealthTransitionState,
  transitionHealth,
  type HealthTransitionAction,
  type HealthTransitionResult,
  type HealthTransitionState,
} from "../shared/health-transition.ts";

export type RunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
  exitCode?: number | null;
};

function applyHealthStatusProjection(step: RunnerStatusStep, state: HealthTransitionState): void {
  step.activityState = state.activityState;
  step.idleEpisodeId = state.idleEpisodeId;
  step.durableAttentionReasons = state.durableAttentionReasons.length
    ? [...state.durableAttentionReasons]
    : undefined;
  step.compaction = state.compaction ? { ...state.compaction } : undefined;
}

export type RunnerStatusPayload = Omit<
  AsyncStatus,
  "steps" | "pid" | "cwd" | "currentStep" | "lastUpdate"
> & {
  pid?: number;
  cwd: string;
  currentStep: number;
  steps: RunnerStatusStep[];
  lastUpdate: number;
  artifactsDir?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  error?: string;
};

type NestedSelf = {
  parentRunId: string;
  parentStepIndex?: number;
  depth: number;
  path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
};

export interface BackgroundStatusOwnerInput {
  id: string;
  asyncDir: string;
  cwd: string;
  plan: SubagentRunPlan;
  overallStartTime: number;
  shareEnabled: boolean;
  artifactConfig: ResolvedArtifactConfig;
  artifactsDir?: string;
  sessionDir?: string;
  sessionId?: string | null;
  deadlineAt?: number;
  toolBudget?: ResolvedToolBudget;
  tkTicket?: TkTicketMetadata;
  projectAgents?: ProjectAgentRunCapture[];
  nestedRoute?: NestedRouteInfo;
  nestedSelf?: NestedSelf;
  timeoutMessage?: string;
  appendEvent: (line: string) => void;
  appendDiagnosticEvent?: (line: string, droppedEventType?: string) => void;
}

/**
 * These callbacks are deliberately narrower than a runner context. Status owns
 * lifecycle persistence and calls control only after a durable transition is
 * written, so the dependency direction cannot cycle through the orchestrator.
 */
export interface BackgroundStatusControlHooks {
  clearActivityState: () => void;
  interruptNestedDescendants: () => void;
  timeoutNestedDescendants: () => void;
  interruptActiveChildren: () => void;
  timeoutActiveChildren: () => void;
  abortInterrupt: () => void;
  abortTimeout: () => void;
}

export interface SupervisorPauseRequest {
  requesterIndex: number;
  pause: NonNullable<AsyncStatus["pause"]>;
  requestedAt: number;
}

export interface BackgroundRunStatusOwner {
  readonly flatSteps: SubagentStep[];
  readonly initialStatusSteps: RunnerStatusStep[];
  readonly sessionEnabled: boolean;
  readonly statusPayload: RunnerStatusPayload;
  readonly activeRuntimeTrackers: Map<number, ActiveRuntimeTracker>;
  readonly flatStepAcceptances: Array<SubagentStep["effectiveAcceptance"]>;
  readonly terminalReason: ChildTerminalReasonLatch;
  latestSessionFile: string | undefined;
  interrupted: boolean;
  timedOut: boolean;
  supervisorPauseRequest: SupervisorPauseRequest | undefined;
  supervisorPauseTransitionFailed: boolean;
  durablePausingCheckpointPersisted: boolean;
  concurrentTerminalStatusAdopted: boolean;
  pausedCheckpointCommitted: boolean;
  setControlHooks(hooks: BackgroundStatusControlHooks): void;
  claimTerminalReason(reason: Parameters<typeof claimChildTerminalReason>[1]): boolean;
  beginTrackedSessionStep(
    flatIndex: number,
    sessionDir: string | undefined,
    sessionFile?: string,
  ): void;
  refreshTrackedSessionFile(flatIndex: number): string | undefined;
  resolveTrackedSessionFile(flatIndex: number, fallback?: string): string | undefined;
  writeStatusPayload(options?: { projectNested?: boolean; lifecycleLocked?: boolean }): void;
  checkpointActiveRuntime(now?: number, freeze?: boolean): boolean;
  healthStateForStep(flatIndex: number): HealthTransitionState;
  transitionStepHealth(flatIndex: number, action: HealthTransitionAction): HealthTransitionResult;
  resetStepHealth(flatIndex: number): HealthTransitionResult;
  clearStepHealth(flatIndex: number): HealthTransitionResult;
  clearRunningStepHealth(): void;
  endStepCompaction(flatIndex: number, options?: { publish?: boolean }): void;
  endAllStepCompactions(options?: { publish?: boolean }): void;
  syncTopLevelHealthProjection(): boolean;
  onChildProtocolOutputLimit(limit: ProtocolOutputLimit): void;
  pausedAcceptanceLedger(
    acceptance: SubagentStep["effectiveAcceptance"],
  ): import("../../shared/types.ts").AcceptanceLedger | undefined;
  pausedStepResult(
    task: Pick<
      SubagentStep,
      | "agent"
      | "effectiveAcceptance"
      | "model"
      | "modelIdentity"
      | "modelResolution"
      | "projectAgent"
    >,
  ): SingleStepResultValue;
  timedOutStepResult(
    task: Pick<
      SubagentStep,
      "agent" | "model" | "modelIdentity" | "modelResolution" | "projectAgent"
    >,
  ): SingleStepResultValue;
  pauseMetadataForIndex(index: number, pausedAt?: number): AsyncStatus["pause"] | undefined;
  adoptConcurrentTerminalStatus(): RunnerStatusPayload | undefined;
  requestSupervisorPause(requesterIndex: number, pause: NonNullable<AsyncStatus["pause"]>): void;
  interrupt(): void;
  timeout(): void;
  ownedPauseProcessesConfirmedStopped(): boolean;
  isPersistedAwaitingSupervisorPause(status: RunnerStatusPayload | undefined): boolean;
  applyPausedStepMetadata(flatIndex: number, endedAt: number): void;
  startRuntimeCheckpointTimer(): void;
  disposeRuntimeCheckpointTimer(): void;
  emitNestedSelfEvent(type: "subagent.nested.updated" | "subagent.nested.completed"): void;
}

const LIFECYCLE_TRANSITION_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
type LifecycleTransitionPhase = "running->pausing" | "pausing->paused";

function lifecycleTransitionErrorDetail(error: unknown, depth = 0): string {
  try {
    if (!(error instanceof Error))
      return boundChildError(String(error), LIFECYCLE_TRANSITION_DIAGNOSTIC_MAX_BYTES) ?? "unknown";
    const errnoError = error as NodeJS.ErrnoException;
    const code = typeof errnoError.code === "string" ? `code=${errnoError.code}` : undefined;
    const cause =
      error.cause !== undefined && depth < 2
        ? `cause=${lifecycleTransitionErrorDetail(error.cause, depth + 1)}`
        : undefined;
    return (
      boundChildError(
        [error.name ? `name=${error.name}` : undefined, code, `message=${error.message}`, cause]
          .filter((part): part is string => part !== undefined)
          .join("; "),
        LIFECYCLE_TRANSITION_DIAGNOSTIC_MAX_BYTES,
      ) ?? "unknown"
    );
  } catch {
    return "unavailable";
  }
}

export function appendLifecycleTransitionDiagnostic(
  appendDiagnosticEvent: (line: string, droppedEventType?: string) => void,
  runId: string,
  phase: LifecycleTransitionPhase,
  error: unknown,
): void {
  try {
    appendDiagnosticEvent(
      JSON.stringify({
        type: "subagent.run.lifecycle_transition_failed",
        ts: Date.now(),
        runId,
        phase,
        cause: lifecycleTransitionErrorDetail(error),
      }),
      "subagent.run.lifecycle_transition_failed",
    );
  } catch {
    // Lifecycle diagnostics are best effort and must not interrupt teardown.
  }
}

export function appendUnexpectedLifecycleTransitionDiagnostic(
  appendDiagnosticEvent: (line: string, droppedEventType?: string) => void,
  runId: string,
  phase: LifecycleTransitionPhase,
  error: unknown,
): void {
  if (isLifecycleTransitionContentionError(error)) return;
  appendLifecycleTransitionDiagnostic(appendDiagnosticEvent, runId, phase, error);
}

function projectInitialModelFallbackFilterNotice(notice: string | undefined): {
  modelFallbackNotice?: string;
} {
  const sanitized = sanitizeModelFallbackNotice(notice);
  return sanitized ? { modelFallbackNotice: sanitized } : {};
}

function resolveAsyncStepTranscriptPath(input: {
  artifactsDir?: string;
  artifactConfig: ResolvedArtifactConfig;
  runId: string;
  agent: string;
  flatIndex: number;
  flatStepCount: number;
}): string | undefined {
  if (
    !input.artifactsDir ||
    input.artifactConfig.enabled === false ||
    input.artifactConfig.includeTranscript === false
  )
    return undefined;
  return getArtifactPaths(
    input.artifactsDir,
    input.runId,
    input.agent,
    input.flatStepCount > 1 ? input.flatIndex : undefined,
  ).transcriptPath;
}

export function createBackgroundRunStatusOwner(
  input: BackgroundStatusOwnerInput,
): BackgroundRunStatusOwner {
  const {
    id,
    asyncDir,
    cwd,
    plan,
    overallStartTime,
    shareEnabled,
    artifactConfig,
    artifactsDir,
    sessionDir,
    sessionId,
    deadlineAt,
    toolBudget,
    tkTicket,
    projectAgents,
    nestedRoute,
    nestedSelf,
    timeoutMessage,
    appendEvent,
    appendDiagnosticEvent,
  } = input;
  const flatSteps = plan.kind === "single" ? [plan.task] : plan.tasks;
  for (const step of flatSteps) {
    step.contextPressure = parseContextPressureProjection(step.contextPressure);
    step.contextPressureCrossedThresholds = parseContextPressureCrossedThresholds(
      step.contextPressureCrossedThresholds,
    );
  }
  const initialStatusSteps: RunnerStatusStep[] = flatSteps.map((task, taskFlatIndex) => {
    const transcriptPath = resolveAsyncStepTranscriptPath({
      artifactsDir,
      artifactConfig,
      runId: id,
      agent: task.agent,
      flatIndex: taskFlatIndex,
      flatStepCount: flatSteps.length,
    });
    return {
      agent: task.agent,
      ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
      status: "pending",
      ...(task.toolBudget ? { toolBudget: initialToolBudgetState(task.toolBudget) } : {}),
      ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
      ...(normalizeActiveRuntimeMs(task.activeRuntimeMs) !== undefined
        ? { activeRuntimeMs: normalizeActiveRuntimeMs(task.activeRuntimeMs) }
        : {}),
      ...(normalizeActiveRuntimeCheckpointAt(task.activeRuntimeCheckpointAt) !== undefined
        ? {
            activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
              task.activeRuntimeCheckpointAt,
            ),
          }
        : {}),
      ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
      skills: task.skills,
      model: task.model,
      thinking: task.thinking,
      ...(task.modelIdentity ? { modelIdentity: task.modelIdentity } : {}),
      ...(task.modelResolution ? { modelResolution: task.modelResolution } : {}),
      ...projectInitialModelFallbackFilterNotice(task.modelFallbackFilterNotice),
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
    };
  });
  const sessionEnabled =
    Boolean(sessionDir) || shareEnabled || flatSteps.some((step) => Boolean(step.sessionFile));
  const initialActiveRuntimeValues = initialStatusSteps
    .map((step) => normalizeActiveRuntimeMs(step.activeRuntimeMs))
    .filter((value): value is number => value !== undefined);
  const initialActiveRuntimeMs = initialActiveRuntimeValues.reduce(
    (total, value) => total + value,
    0,
  );
  const initialActiveRuntimeCheckpointValues = initialStatusSteps
    .map((step) => normalizeActiveRuntimeCheckpointAt(step.activeRuntimeCheckpointAt))
    .filter((value): value is number => value !== undefined);
  const initialActiveRuntimeCheckpointAt =
    initialActiveRuntimeCheckpointValues.length > 0
      ? Math.max(...initialActiveRuntimeCheckpointValues)
      : undefined;
  const statusPayload: RunnerStatusPayload = {
    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
    runId: id,
    ...(sessionId ? { sessionId } : {}),
    mode: plan.kind,
    state: "running",
    lastActivityAt: overallStartTime,
    startedAt: overallStartTime,
    lastUpdate: overallStartTime,
    ...(initialActiveRuntimeValues.length > 0 ? { activeRuntimeMs: initialActiveRuntimeMs } : {}),
    ...(initialActiveRuntimeCheckpointAt !== undefined
      ? { activeRuntimeCheckpointAt: initialActiveRuntimeCheckpointAt }
      : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(toolBudget ? { toolBudget: initialToolBudgetState(toolBudget) } : {}),
    pid: process.pid,
    cwd,
    currentStep: 0,
    steps: initialStatusSteps,
    ...(tkTicket ? { tkTicket } : {}),
    ...(projectAgents ? { projectAgents } : {}),
    artifactsDir,
    sessionDir,
    outputFile: path.join(asyncDir, "output-0.log"),
  };
  fs.mkdirSync(asyncDir, { recursive: true });
  writeNormalizedLifecycleStatus(asyncDir, statusPayload);

  const activeRuntimeTrackers = new Map<number, ActiveRuntimeTracker>();
  // Health transitions are independent from active-runtime accounting: the
  // former describes user-visible liveness and durable attention, while the
  // latter measures execution time for continuation budgets.
  const healthStates: Array<HealthTransitionState | undefined> = initialStatusSteps.map(
    () => undefined,
  );
  // Lifecycle cleanup closes an ephemeral health segment. Child callbacks may
  // still arrive while a process drains, so retain that closure in memory.
  const closedHealthSteps = new Set<number>();
  let currentActivityState: ActivityState | undefined;
  const flatStepAcceptances = flatSteps.map((step) => step.effectiveAcceptance);
  const terminalReason: ChildTerminalReasonLatch = {};
  const controlHooks: BackgroundStatusControlHooks = {
    clearActivityState: () => undefined,
    interruptNestedDescendants: () => undefined,
    timeoutNestedDescendants: () => undefined,
    interruptActiveChildren: () => undefined,
    timeoutActiveChildren: () => undefined,
    abortInterrupt: () => undefined,
    abortTimeout: () => undefined,
  };
  let latestSessionFile: string | undefined;
  const trackedStepSessions: Array<TrackedStepSessionState | undefined> = initialStatusSteps.map(
    (step) =>
      step.sessionFile
        ? {
            sessionDir: path.dirname(step.sessionFile),
            baselineSessionFiles: new Set(listTrackedSessionFiles(path.dirname(step.sessionFile))),
            discoveredSessionFile: path.resolve(step.sessionFile),
          }
        : undefined,
  );
  let supervisorPauseRequest: SupervisorPauseRequest | undefined;
  let supervisorPauseTransitionFailed = false;
  let durablePausingCheckpointPersisted = false;
  let concurrentTerminalStatusAdopted = false;
  let pausedCheckpointCommitted = false;
  let interrupted = false;
  let timedOut = false;
  let runtimeCheckpointTimer: NodeJS.Timeout | undefined;

  function listTrackedSessionFiles(dir: string | undefined): string[] {
    if (!dir) return [];
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.resolve(dir, name));
    } catch {
      return [];
    }
  }

  function emitNestedSelfEvent(
    type: "subagent.nested.updated" | "subagent.nested.completed",
  ): void {
    if (!nestedRoute || !nestedSelf) return;
    try {
      writeNestedEvent(nestedRoute, {
        type,
        ts: Date.now(),
        parentRunId: nestedSelf.parentRunId,
        parentStepIndex: nestedSelf.parentStepIndex,
        child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
          id,
          parentRunId: nestedSelf.parentRunId,
          parentStepIndex: nestedSelf.parentStepIndex,
          depth: nestedSelf.depth,
          path: nestedSelf.path,
          mode: statusPayload.mode,
          ts: Date.now(),
        }),
      });
    } catch (error) {
      console.error("Failed to emit nested async status event:", error);
    }
  }

  function beginTrackedSessionStep(
    flatIndex: number,
    stepSessionDir: string | undefined,
    sessionFile?: string,
  ): void {
    trackedStepSessions[flatIndex] = {
      sessionDir: stepSessionDir,
      baselineSessionFiles: new Set(listTrackedSessionFiles(stepSessionDir)),
      ...(sessionFile ? { discoveredSessionFile: path.resolve(sessionFile) } : {}),
    };
  }

  function refreshTrackedSessionFile(flatIndex: number): string | undefined {
    const step = statusPayload.steps[flatIndex];
    const tracked = trackedStepSessions[flatIndex];
    if (!step || !tracked?.sessionDir) return step?.sessionFile;
    const latestDiscovered = findLatestSessionFile(tracked.sessionDir) ?? undefined;
    if (latestDiscovered) {
      const resolvedLatest = path.resolve(latestDiscovered);
      if (!tracked.baselineSessionFiles.has(resolvedLatest))
        tracked.discoveredSessionFile = resolvedLatest;
    }
    if (tracked.discoveredSessionFile && !step.sessionFile)
      step.sessionFile = tracked.discoveredSessionFile;
    if (tracked.discoveredSessionFile) latestSessionFile = tracked.discoveredSessionFile;
    if (!statusPayload.sessionFile) {
      statusPayload.sessionFile =
        statusPayload.steps.length === 1
          ? (step.sessionFile ?? latestSessionFile)
          : latestSessionFile;
    }
    return step.sessionFile ?? tracked.discoveredSessionFile;
  }

  function resolveTrackedSessionFile(flatIndex: number, fallback?: string): string | undefined {
    if (fallback) {
      const tracked = trackedStepSessions[flatIndex];
      if (tracked) tracked.discoveredSessionFile = path.resolve(fallback);
      return fallback;
    }
    const current = statusPayload.steps[flatIndex]?.sessionFile;
    if (current) return current;
    return refreshTrackedSessionFile(flatIndex);
  }

  function writeStatusPayload(
    options: { projectNested?: boolean; lifecycleLocked?: boolean } = {},
  ): void {
    // Once ANY concurrent lifecycle state has been adopted from disk, every
    // subsequent write must go through the lifecycle lock and merge against the
    // persisted record. The merge guarantees that a persisted terminal run
    // state and its terminal step statuses always beat this process's in-memory
    // state, while late per-step settlement fields can still be folded in.
    //
    // `pausedCheckpointCommitted` covers the analogous paused case: after a
    // durable paused checkpoint, a resume actor may hold the lifecycle lock and
    // commit a continuation reservation. A lockless write here could clobber it.
    if (statusPayload.currentStep !== undefined)
      refreshTrackedSessionFile(statusPayload.currentStep);
    if (
      options.lifecycleLocked === true ||
      concurrentTerminalStatusAdopted ||
      (interrupted && pausedCheckpointCommitted)
    ) {
      const merged = mergeAndWriteSourceRunnerStatus(asyncDir, statusPayload);
      if (TERMINAL_RUN_STATES.has(merged.state) && merged.state !== statusPayload.state) {
        adoptConcurrentTerminalStatus();
      } else {
        statusPayload.lifecycle = merged.lifecycle;
        for (let index = 0; index < (merged.steps?.length ?? 0); index++) {
          const mergedStep = merged.steps?.[index];
          const localStep = statusPayload.steps[index];
          if (!mergedStep || !localStep) continue;
          const mergedRuntime = normalizeActiveRuntimeMs(mergedStep.activeRuntimeMs);
          const localRuntime = normalizeActiveRuntimeMs(localStep.activeRuntimeMs);
          if (
            mergedRuntime !== undefined &&
            (localRuntime === undefined || mergedRuntime > localRuntime)
          )
            localStep.activeRuntimeMs = mergedRuntime;
          const mergedCheckpoint = normalizeActiveRuntimeCheckpointAt(
            mergedStep.activeRuntimeCheckpointAt,
          );
          const localCheckpoint = normalizeActiveRuntimeCheckpointAt(
            localStep.activeRuntimeCheckpointAt,
          );
          if (
            mergedCheckpoint !== undefined &&
            (localCheckpoint === undefined || mergedCheckpoint > localCheckpoint)
          )
            localStep.activeRuntimeCheckpointAt = mergedCheckpoint;
        }
      }
    } else {
      writeNormalizedLifecycleStatus(asyncDir, statusPayload);
    }
    if (options.projectNested !== false) {
      emitNestedSelfEvent(
        statusPayload.state === "running" || statusPayload.state === "queued"
          ? "subagent.nested.updated"
          : "subagent.nested.completed",
      );
    }
  }

  function checkpointActiveRuntime(now = Date.now(), freeze = false): boolean {
    const candidates = [...activeRuntimeTrackers].flatMap(([index, tracker]) => {
      const step = statusPayload.steps[index];
      if (!step || step.status !== "running") return [];
      return [
        {
          tracker,
          previousActiveRuntimeMs: step.activeRuntimeMs,
          previousActiveRuntimeCheckpointAt: step.activeRuntimeCheckpointAt,
          apply: ({
            activeRuntimeMs,
            activeRuntimeCheckpointAt,
          }: ActiveRuntimeCheckpointUpdate) => {
            step.activeRuntimeMs = activeRuntimeMs;
            step.activeRuntimeCheckpointAt = activeRuntimeCheckpointAt;
          },
        },
      ];
    });
    // Runtime checkpoints are authoritative internal evidence. Persist them
    // through the same terminal/pause-aware path, but do not publish nested
    // projections or heartbeat/control notifications for each checkpoint.
    return applyActiveRuntimeCheckpoint(candidates, {
      now,
      freeze,
      persist: () => {
        const aggregateRuntime = statusPayload.steps.reduce(
          (total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0),
          0,
        );
        const previousAggregateRuntime = normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs);
        statusPayload.activeRuntimeMs = Math.max(previousAggregateRuntime ?? 0, aggregateRuntime);
        statusPayload.activeRuntimeCheckpointAt = Math.max(
          normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) ?? 0,
          normalizeActiveRuntimeCheckpointAt(now) ?? 0,
        );
        statusPayload.lastUpdate = now;
        writeStatusPayload({ projectNested: false, lifecycleLocked: true });
      },
    });
  }

  function syncTopLevelHealthProjection(): boolean {
    const nextRunState = statusPayload.steps.some(
      (step) => step.activityState === "needs_attention",
    )
      ? "needs_attention"
      : statusPayload.steps.some((step) => step.activityState === "active_long_running")
        ? "active_long_running"
        : undefined;
    const changed = nextRunState !== currentActivityState;
    currentActivityState = nextRunState;
    statusPayload.activityState = nextRunState;
    return changed;
  }

  function healthStateForStep(flatIndex: number): HealthTransitionState {
    const current = healthStates[flatIndex];
    if (current) return current;
    const persistedReasons = statusPayload.steps[flatIndex]?.durableAttentionReasons;
    const created = createHealthTransitionState(randomUUID());
    healthStates[flatIndex] = persistedReasons?.length
      ? { ...created, durableAttentionReasons: [...persistedReasons] }
      : created;
    return healthStates[flatIndex]!;
  }

  function ignoredHealthTransition(state: HealthTransitionState): HealthTransitionResult {
    return {
      state,
      changed: false,
      projectionChanged: false,
      projection: state.activityState,
      idleEpisodeStarted: false,
      idleEpisodeEnded: false,
      activeLongRunningNotice: false,
      idleAttentionEligible: false,
    };
  }

  function transitionStepHealth(
    flatIndex: number,
    action: HealthTransitionAction,
  ): HealthTransitionResult {
    const current = healthStateForStep(flatIndex);
    const closed = closedHealthSteps.has(flatIndex);
    // Lifecycle cleanup closes ephemeral projections, but a validated durable
    // producer may still arrive while child output drains. Keep that evidence
    // without re-projecting activity or compaction onto the closed record.
    if (closed && action.type !== "durable_attention") return ignoredHealthTransition(current);
    const transition = transitionHealth(current, action);
    const publishedState = closed
      ? {
          ...transition.state,
          activityState: undefined,
          idleEpisodeId: undefined,
          compaction: undefined,
        }
      : transition.state;
    const publishedTransition = closed
      ? {
          ...transition,
          state: publishedState,
          projection: undefined,
          projectionChanged: false,
        }
      : transition;
    healthStates[flatIndex] = publishedState;
    const step = statusPayload.steps[flatIndex];
    if (step) applyHealthStatusProjection(step, publishedState);
    syncTopLevelHealthProjection();
    return publishedTransition;
  }

  function resetStepHealth(flatIndex: number): HealthTransitionResult {
    closedHealthSteps.delete(flatIndex);
    const transition = resetHealthTransitionState(healthStateForStep(flatIndex), randomUUID());
    healthStates[flatIndex] = transition.state;
    const step = statusPayload.steps[flatIndex];
    if (step) applyHealthStatusProjection(step, transition.state);
    syncTopLevelHealthProjection();
    return transition;
  }

  function clearStepHealth(flatIndex: number): HealthTransitionResult {
    const current = healthStateForStep(flatIndex);
    if (closedHealthSteps.has(flatIndex)) return ignoredHealthTransition(current);
    const transition = transitionHealth(current, { type: "clear_ephemeral" });
    healthStates[flatIndex] = transition.state;
    closedHealthSteps.add(flatIndex);
    const step = statusPayload.steps[flatIndex];
    if (step) applyHealthStatusProjection(step, transition.state);
    syncTopLevelHealthProjection();
    return transition;
  }

  function clearRunningStepHealth(): void {
    for (let index = 0; index < statusPayload.steps.length; index++) {
      if (statusPayload.steps[index]?.status === "running") clearStepHealth(index);
    }
  }

  function endStepCompaction(flatIndex: number, options?: { publish?: boolean }): void {
    const transition = transitionStepHealth(flatIndex, { type: "compaction_end" });
    if (!transition.changed) return;
    const now = Date.now();
    statusPayload.lastUpdate = now;
    if (options?.publish !== false) writeStatusPayload();
  }

  function endAllStepCompactions(options?: { publish?: boolean }): void {
    for (let index = 0; index < statusPayload.steps.length; index++) {
      if (healthStates[index]?.compaction) endStepCompaction(index, options);
    }
  }

  function adoptConcurrentTerminalStatus(): RunnerStatusPayload | undefined {
    const persisted = readStatus(asyncDir) as RunnerStatusPayload | null;
    if (!persisted || persisted.state === "running" || persisted.state === "pausing")
      return undefined;
    // A concurrent lifecycle owner has ended this live segment. Freeze local
    // trackers before adopting its status so child teardown cannot inflate the
    // runtime returned by this process. Merge that evidence into the adopted
    // record while keeping the persisted lifecycle state authoritative.
    const adoptedAt = Date.now();
    const localRuntimeByIndex = new Map<number, number>();
    for (const [index, tracker] of activeRuntimeTrackers) {
      localRuntimeByIndex.set(index, tracker.freeze(adoptedAt));
    }
    const adoptedSteps = persisted.steps?.map((step, index) => {
      const localStep = statusPayload.steps[index];
      const localRuntime =
        localRuntimeByIndex.get(index) ?? normalizeActiveRuntimeMs(localStep?.activeRuntimeMs);
      const persistedRuntime = normalizeActiveRuntimeMs(step.activeRuntimeMs);
      const localCheckpoint = normalizeActiveRuntimeCheckpointAt(
        localStep?.activeRuntimeCheckpointAt,
      );
      const persistedCheckpoint = normalizeActiveRuntimeCheckpointAt(
        step.activeRuntimeCheckpointAt,
      );
      return {
        ...step,
        ...(localRuntime !== undefined || persistedRuntime !== undefined
          ? { activeRuntimeMs: Math.max(localRuntime ?? 0, persistedRuntime ?? 0) }
          : {}),
        ...(localCheckpoint !== undefined || persistedCheckpoint !== undefined
          ? { activeRuntimeCheckpointAt: Math.max(localCheckpoint ?? 0, persistedCheckpoint ?? 0) }
          : {}),
      };
    });
    const localAggregateRuntime = statusPayload.steps.reduce(
      (total, step, index) =>
        total +
        (localRuntimeByIndex.get(index) ?? normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0),
      0,
    );
    const persistedAggregateRuntime = persisted.steps?.reduce(
      (total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0),
      0,
    );
    const adoptedStatus: RunnerStatusPayload = {
      ...persisted,
      ...(adoptedSteps ? { steps: adoptedSteps } : {}),
      ...(localAggregateRuntime > 0 ||
      persistedAggregateRuntime !== undefined ||
      persisted.activeRuntimeMs !== undefined
        ? {
            activeRuntimeMs: Math.max(
              normalizeActiveRuntimeMs(persisted.activeRuntimeMs) ?? 0,
              persistedAggregateRuntime ?? 0,
              localAggregateRuntime,
            ),
          }
        : {}),
      ...(localRuntimeByIndex.size > 0 || persisted.activeRuntimeCheckpointAt !== undefined
        ? {
            activeRuntimeCheckpointAt: Math.max(
              normalizeActiveRuntimeCheckpointAt(persisted.activeRuntimeCheckpointAt) ?? 0,
              ...[...localRuntimeByIndex.keys()].map(
                (index) =>
                  normalizeActiveRuntimeCheckpointAt(
                    statusPayload.steps[index]?.activeRuntimeCheckpointAt,
                  ) ?? adoptedAt,
              ),
            ),
          }
        : {}),
    };
    Object.assign(statusPayload, adoptedStatus);
    // A child can continue draining after another lifecycle owner publishes a
    // terminal record. Close local ephemeral health segments so late events do
    // not re-project liveness over the adopted lifecycle state. Durable reasons
    // come from the adopted status and remain available for result reporting.
    for (let index = 0; index < statusPayload.steps.length; index++) {
      const adoptedStep = statusPayload.steps[index];
      if (
        !adoptedStep ||
        adoptedStep.status === "running" ||
        adoptedStep.status === "pending" ||
        adoptedStep.status === "pausing"
      )
        continue;
      const currentHealth = healthStateForStep(index);
      healthStates[index] = {
        ...currentHealth,
        activityState: undefined,
        idleEpisodeId: undefined,
        compaction: undefined,
        durableAttentionReasons: [...(adoptedStep.durableAttentionReasons ?? [])],
      };
      closedHealthSteps.add(index);
    }
    syncTopLevelHealthProjection();
    // A paused adoption must keep subsequent writes locked so a continuation
    // reservation cannot be erased. Non-paused adoption leaves `interrupted`
    // false, so the orchestrator also checks `concurrentTerminalStatusAdopted`
    // directly when deciding whether to start another step.
    interrupted = persisted.state === "paused";
    if (persisted.state === "paused") pausedCheckpointCommitted = true;
    concurrentTerminalStatusAdopted = true;
    controlHooks.interruptNestedDescendants();
    controlHooks.interruptActiveChildren();
    return persisted;
  }

  function onChildProtocolOutputLimit(limit: ProtocolOutputLimit): void {
    if (
      concurrentTerminalStatusAdopted ||
      statusPayload.state !== "running" ||
      timedOut ||
      interrupted
    )
      return;
    if (!claimChildTerminalReason(terminalReason, "output_limit")) return;
    const now = Date.now();
    // Output limits are terminal for this segment. End any in-flight compaction
    // before publishing the failure so cleanup cannot leak operation state.
    endAllStepCompactions({ publish: false });
    clearRunningStepHealth();
    // Freeze before publishing the failure so child teardown time cannot enter
    // a continuation budget.
    checkpointActiveRuntime(now, true);
    const message = boundChildError(formatProtocolOutputLimit(limit));
    statusPayload.state = "failed";
    statusPayload.activityState = undefined;
    statusPayload.error = message;
    statusPayload.lastUpdate = now;
    appendEvent(
      JSON.stringify({
        type: "subagent.child.protocol_output_limit",
        ts: now,
        runId: id,
        stream: limit.stream,
        limitBytes: limit.limitBytes,
        observedBytes: limit.observedBytes,
      }),
    );
    writeStatusPayload();
  }

  function pausedAcceptanceLedger(
    acceptance: SubagentStep["effectiveAcceptance"],
  ): import("../../shared/types.ts").AcceptanceLedger | undefined {
    return acceptance
      ? buildSkippedAcceptanceLedger({
          acceptance,
          ledgerStatus: "skipped",
          runtimeCheckStatus: "not-applicable",
          id: "paused",
          message:
            "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
        })
      : undefined;
  }

  function pauseMetadataForIndex(
    index: number,
    pausedAt?: number,
  ): AsyncStatus["pause"] | undefined {
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
  }

  function requestSupervisorPause(
    requesterIndex: number,
    pause: NonNullable<AsyncStatus["pause"]>,
  ): void {
    if (supervisorPauseRequest || interrupted || timedOut || statusPayload.state !== "running")
      return;
    if (!claimChildTerminalReason(terminalReason, "paused")) return;
    supervisorPauseRequest = {
      requesterIndex,
      pause: { ...pause, ownerPid: process.pid },
      requestedAt: pause.requestedAt ?? Date.now(),
    };
    const now = Date.now();
    // End operation projections and close ephemeral health before freezing and
    // publishing the pausing lifecycle state. The transition below copies this
    // checkpoint; it must not add another wall-time interval to the later
    // continuation budget.
    endAllStepCompactions({ publish: false });
    clearRunningStepHealth();
    checkpointActiveRuntime(now, true);
    if (concurrentTerminalStatusAdopted) {
      interrupted = true;
      controlHooks.abortInterrupt();
      return;
    }
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
            const activeRuntimeMs = boundedActiveRuntimeMs(step.activeRuntimeMs);
            return {
              ...step,
              status: "pausing",
              activeRuntimeMs,
              activeRuntimeCheckpointAt: now,
              activityState: undefined,
              idleEpisodeId: undefined,
              compaction: undefined,
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
    } catch (error) {
      appendUnexpectedLifecycleTransitionDiagnostic(
        appendDiagnosticEvent ?? appendEvent,
        id,
        "running->pausing",
        error,
      );
      supervisorPauseTransitionFailed = !adoptConcurrentTerminalStatus();
    }
    interrupted = true;
    controlHooks.clearActivityState();
    appendEvent(
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
    controlHooks.interruptNestedDescendants();
    controlHooks.abortInterrupt();
    controlHooks.interruptActiveChildren();
  }

  function interrupt(): void {
    if (interrupted || statusPayload.state !== "running") return;
    if (!claimChildTerminalReason(terminalReason, "interrupted")) return;
    interrupted = true;
    const now = Date.now();
    // End operation projections before changing lifecycle state. Paused wall
    // time is excluded because no tracker remains live after this checkpoint.
    endAllStepCompactions({ publish: false });
    checkpointActiveRuntime(now, true);
    clearRunningStepHealth();
    statusPayload.state = "paused";
    controlHooks.clearActivityState();
    statusPayload.activityState = undefined;
    statusPayload.lastUpdate = now;
    for (let flatIndex = 0; flatIndex < statusPayload.steps.length; flatIndex++) {
      const step = statusPayload.steps[flatIndex]!;
      if (step.status !== "running") continue;
      step.status = "paused";
      step.activityState = undefined;
      step.idleEpisodeId = undefined;
      step.compaction = undefined;
      step.endedAt = now;
      step.durationMs = step.startedAt ? now - step.startedAt : undefined;
      step.lastActivityAt = now;
      if (!step.acceptance)
        step.acceptance = pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
      refreshTrackedSessionFile(flatIndex);
    }
    writeStatusPayload();
    // The first paused checkpoint is now on disk. Subsequent writes must use the
    // lifecycle lock/merge path so a continuation reservation committed between
    // this write and settlement is preserved.
    pausedCheckpointCommitted = true;
    appendEvent(JSON.stringify({ type: "subagent.run.paused", ts: now, runId: id }));
    controlHooks.interruptNestedDescendants();
    controlHooks.abortInterrupt();
    controlHooks.interruptActiveChildren();
  }

  function timeout(): void {
    if (timedOut || interrupted || statusPayload.state !== "running") return;
    if (!claimChildTerminalReason(terminalReason, "timed_out")) return;
    timedOut = true;
    const now = Date.now();
    // End operation projections before publishing the terminal timeout state.
    endAllStepCompactions({ publish: false });
    checkpointActiveRuntime(now, true);
    for (let index = 0; index < statusPayload.steps.length; index++) {
      const step = statusPayload.steps[index];
      if (step?.status === "running" || step?.status === "pending") clearStepHealth(index);
    }
    const message = timeoutMessage ?? "Subagent timed out.";
    statusPayload.state = "failed";
    statusPayload.timedOut = true;
    statusPayload.error = message;
    controlHooks.clearActivityState();
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
      step.idleEpisodeId = undefined;
      step.compaction = undefined;
      step.endedAt = now;
      step.durationMs = step.startedAt ? now - step.startedAt : 0;
      step.lastActivityAt = now;
    }
    writeStatusPayload();
    appendEvent(
      JSON.stringify({
        type: "subagent.run.timed_out",
        ts: now,
        runId: id,
        deadlineAt,
        message,
      }),
    );
    controlHooks.abortTimeout();
    controlHooks.timeoutNestedDescendants();
    controlHooks.timeoutActiveChildren();
  }

  function pausedStepResult(
    task: Pick<
      SubagentStep,
      | "agent"
      | "effectiveAcceptance"
      | "model"
      | "modelIdentity"
      | "modelResolution"
      | "projectAgent"
    >,
  ): SingleStepResultValue {
    return {
      agent: task.agent,
      ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
      output: "Paused after interrupt. Waiting for explicit next action.",
      exitCode: 0,
      interrupted: true,
      terminationReason: "paused",
      model: task.model,
      modelIdentity: task.modelIdentity,
      modelResolution: task.modelResolution,
      acceptance: pausedAcceptanceLedger(task.effectiveAcceptance),
    };
  }

  function timedOutStepResult(
    task: Pick<
      SubagentStep,
      "agent" | "model" | "modelIdentity" | "modelResolution" | "projectAgent"
    >,
  ): SingleStepResultValue {
    return {
      agent: task.agent,
      ...(task.projectAgent ? { projectAgent: task.projectAgent } : {}),
      output: timeoutMessage ?? "Subagent timed out.",
      error: timeoutMessage ?? "Subagent timed out.",
      exitCode: 1,
      timedOut: true,
      terminationReason: "timed_out",
      model: task.model,
      modelIdentity: task.modelIdentity,
      modelResolution: task.modelResolution,
    };
  }

  function ownedPauseProcessesConfirmedStopped(): boolean {
    return statusPayload.steps.every((step) => {
      if (step.status !== "pausing" && step.status !== "paused") return true;
      // Pending cohort members never spawned a process and need no cleanup.
      if (!step.startedAt) return true;
      return step.processCleanup?.terminated === true;
    });
  }

  function isPersistedAwaitingSupervisorPause(status: RunnerStatusPayload | undefined): boolean {
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
  }

  function applyPausedStepMetadata(flatIndex: number, endedAt: number): void {
    const step = statusPayload.steps[flatIndex];
    if (!step) return;
    const sessionFile = refreshTrackedSessionFile(flatIndex);
    if (sessionFile) step.sessionFile = sessionFile;
    step.pause = pauseMetadataForIndex(flatIndex, endedAt);
    step.acceptance = step.acceptance ?? pausedAcceptanceLedger(flatStepAcceptances[flatIndex]);
    step.interruptRequestedAt = supervisorPauseRequest?.requestedAt ?? step.interruptRequestedAt;
  }

  function startRuntimeCheckpointTimer(): void {
    runtimeCheckpointTimer = setInterval(() => {
      if (statusPayload.state !== "running") return;
      checkpointActiveRuntime(Date.now());
    }, ACTIVE_RUNTIME_CHECKPOINT_INTERVAL_MS);
    runtimeCheckpointTimer.unref?.();
  }

  function disposeRuntimeCheckpointTimer(): void {
    if (runtimeCheckpointTimer) clearInterval(runtimeCheckpointTimer);
    runtimeCheckpointTimer = undefined;
  }

  const owner: BackgroundRunStatusOwner = {
    flatSteps,
    initialStatusSteps,
    sessionEnabled,
    statusPayload,
    activeRuntimeTrackers,
    flatStepAcceptances,
    terminalReason,
    get latestSessionFile() {
      return latestSessionFile;
    },
    set latestSessionFile(value: string | undefined) {
      latestSessionFile = value;
    },
    get interrupted() {
      return interrupted;
    },
    set interrupted(value: boolean) {
      interrupted = value;
    },
    get timedOut() {
      return timedOut;
    },
    set timedOut(value: boolean) {
      timedOut = value;
    },
    get supervisorPauseRequest() {
      return supervisorPauseRequest;
    },
    set supervisorPauseRequest(value: SupervisorPauseRequest | undefined) {
      supervisorPauseRequest = value;
    },
    get supervisorPauseTransitionFailed() {
      return supervisorPauseTransitionFailed;
    },
    set supervisorPauseTransitionFailed(value: boolean) {
      supervisorPauseTransitionFailed = value;
    },
    get durablePausingCheckpointPersisted() {
      return durablePausingCheckpointPersisted;
    },
    set durablePausingCheckpointPersisted(value: boolean) {
      durablePausingCheckpointPersisted = value;
    },
    get concurrentTerminalStatusAdopted() {
      return concurrentTerminalStatusAdopted;
    },
    set concurrentTerminalStatusAdopted(value: boolean) {
      concurrentTerminalStatusAdopted = value;
    },
    get pausedCheckpointCommitted() {
      return pausedCheckpointCommitted;
    },
    set pausedCheckpointCommitted(value: boolean) {
      pausedCheckpointCommitted = value;
    },
    setControlHooks(hooks) {
      Object.assign(controlHooks, hooks);
    },
    claimTerminalReason(reason) {
      return claimChildTerminalReason(terminalReason, reason);
    },
    beginTrackedSessionStep,
    refreshTrackedSessionFile,
    resolveTrackedSessionFile,
    writeStatusPayload,
    checkpointActiveRuntime,
    healthStateForStep,
    transitionStepHealth,
    resetStepHealth,
    clearStepHealth,
    clearRunningStepHealth,
    endStepCompaction,
    endAllStepCompactions,
    syncTopLevelHealthProjection,
    onChildProtocolOutputLimit,
    pausedAcceptanceLedger,
    pausedStepResult,
    timedOutStepResult,
    pauseMetadataForIndex,
    adoptConcurrentTerminalStatus,
    requestSupervisorPause,
    interrupt,
    timeout,
    ownedPauseProcessesConfirmedStopped,
    isPersistedAwaitingSupervisorPause,
    applyPausedStepMetadata,
    startRuntimeCheckpointTimer,
    disposeRuntimeCheckpointTimer,
    emitNestedSelfEvent,
  };
  return owner;
}

interface TrackedStepSessionState {
  sessionDir?: string;
  baselineSessionFiles: Set<string>;
  discoveredSessionFile?: string;
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
    return null;
  }
}
