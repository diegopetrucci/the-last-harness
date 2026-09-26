import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
  type AcceptanceLedger,
  type ArtifactPaths,
  type AsyncResultArtifact,
  type AsyncStatus,
  type ChildProcessCleanupResult,
  type CompactionReason,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ContextUsageDiagnostics,
  type CostSummary,
  type ModelAttempt,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentRunMode,
  type SubagentTerminationReason,
  type ToolBudgetState,
} from "../../shared/types.ts";
import type { ProjectAgentRunCapture } from "../../agents/project-agent-snapshot.ts";
import type { ProtocolOutputLimit } from "../shared/child-protocol.ts";
import {
  resolveSubagentTelemetryOutcome,
  telemetryFromRunnerResults,
  type SubagentRunTelemetry,
} from "../../shared/telemetry.ts";
import type { SubagentRunConfig, SubagentRunPlan } from "../shared/parallel-utils.ts";
import type {
  BackgroundRunStatusOwner,
  RunnerStatusPayload,
  RunnerStatusStep,
} from "./run-status-owner.ts";
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
  writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";

/** The detached runner's per-child result, kept separate from terminal writing. */
export interface RunnerStepResult {
  /** Flat plan index retained for partial parallel telemetry artifacts. */
  index?: number;
  agent: string;
  projectAgent?: ProjectAgentRunCapture;
  /** Validated per-child developer ticket assignment, when applicable. */
  tkTicketId?: string;
  output: string;
  error?: string;
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  success: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals;
  skipped?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  sessionFile?: string;
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
  acceptance?: AcceptanceLedger;
  pause?: AsyncStatus["pause"];
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  activityState?: RunnerStatusStep["activityState"];
  idleEpisodeId?: RunnerStatusStep["idleEpisodeId"];
  durableAttentionReasons?: RunnerStatusStep["durableAttentionReasons"];
  compaction?: { reason: CompactionReason };
}

type RunnerLogInput = {
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
};

interface TerminalPersistenceInput {
  config: SubagentRunConfig;
  plan: SubagentRunPlan;
  statusOwner: BackgroundRunStatusOwner;
  statusPayload: RunnerStatusPayload;
  results: RunnerStepResult[];
  controlConfig: NonNullable<SubagentRunConfig["controlConfig"]>;
  overallStartTime: number;
  runEndedAt: number;
  effectiveSessionFile?: string;
  finalTotalCost?: CostSummary;
  summary: string;
  truncated: boolean;
  agentName: string;
  timeoutMessage?: string;
  shareUrl?: string;
  gistUrl?: string;
  shareError?: string;
  resultPath: string;
  cwd: string;
  artifactsDir?: string;
  asyncDir: string;
  taskIndex?: number;
  totalTasks?: number;
  pausedAwaitingSupervisor?: AsyncStatus["pause"];
  safePausedResultAfterReap?: AsyncStatus["pause"];
  skipFinalStatusWrite: boolean;
  pausedOutputForIndex: (index: number, agent: string) => string;
  appendEvent: (line: string) => void;
  writeRunLog: (input: RunnerLogInput) => void;
}

interface ContinuationGateRejectionInput {
  config: SubagentRunConfig;
  plan: SubagentRunPlan;
  statusPayload: RunnerStatusPayload;
  asyncDir: string;
  resultPath: string;
  controlConfig: NonNullable<SubagentRunConfig["controlConfig"]>;
  overallStartTime: number;
  sourceRunId: string;
  sourceIndex: number;
}

function buildRunnerTelemetry(
  input: TerminalPersistenceInput,
  state: string,
  endedAt: number,
  success: boolean,
): SubagentRunTelemetry | undefined {
  return telemetryFromRunnerResults({
    runId: input.config.id,
    mode: input.plan.kind,
    results: input.results,
    provenance: input.config.telemetry?.provenance,
    controls: input.controlConfig,
    startedAt: input.overallStartTime,
    endedAt,
    activeRuntimeMs: input.statusPayload.activeRuntimeMs,
    statusSteps: input.statusPayload.steps,
    lineage: input.config.telemetry?.lineage,
    outcome: resolveSubagentTelemetryOutcome({
      state,
      timedOut: input.statusOwner.timedOut,
      interrupted: input.statusOwner.interrupted,
      success,
      terminationReason: input.statusOwner.terminalReason.reason,
    }),
  });
}

function terminalStatus(input: TerminalPersistenceInput): AsyncStatus["state"] {
  if (input.statusOwner.terminalReason.reason === "output_limit") return "failed";
  if (input.statusOwner.supervisorPauseTransitionFailed) return "failed";
  if (input.statusOwner.timedOut) return "failed";
  if (input.statusOwner.interrupted) return "paused";
  return input.results.every((result) => result.success) ? "complete" : "failed";
}

function applyTerminalStatus(input: TerminalPersistenceInput): SubagentRunTelemetry | undefined {
  const { statusPayload } = input;
  statusPayload.state = terminalStatus(input);
  statusPayload.activityState = undefined;
  if (input.statusOwner.timedOut) {
    statusPayload.timedOut = true;
    statusPayload.error = input.timeoutMessage ?? "Subagent timed out.";
  }
  if (input.statusOwner.supervisorPauseTransitionFailed && statusPayload.state === "failed") {
    statusPayload.error =
      statusPayload.error ??
      "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";
  }
  statusPayload.endedAt = input.runEndedAt;
  statusPayload.lastUpdate = input.runEndedAt;
  statusPayload.sessionFile = input.effectiveSessionFile;
  statusPayload.totalCost = input.finalTotalCost;
  statusPayload.shareUrl = input.shareUrl;
  statusPayload.gistUrl = input.gistUrl;
  statusPayload.shareError = input.shareError;
  if (statusPayload.state === "failed" && !statusPayload.error) {
    const failedStep = statusPayload.steps.find((step) => step.status === "failed");
    if (failedStep?.agent)
      statusPayload.error = failedStep.error ?? `Step failed: ${failedStep.agent}`;
  }
  const telemetry = buildRunnerTelemetry(
    input,
    statusPayload.state,
    input.runEndedAt,
    input.results.length > 0 && input.results.every((result) => result.success),
  );
  if (telemetry) statusPayload.telemetry = telemetry;
  input.statusOwner.writeStatusPayload();
  // The locked status write may merge lifecycle telemetry persisted by a
  // concurrent resume actor. Return that post-write canonical envelope so the
  // result artifact and completion notification cannot rebuild from stale
  // launch-time lineage.
  return statusPayload.telemetry ?? telemetry;
}

function resultState(
  input: TerminalPersistenceInput,
  resultPausedAwaitingSupervisor: AsyncStatus["pause"] | undefined,
): AsyncStatus["state"] {
  if (input.statusOwner.concurrentTerminalStatusAdopted) return input.statusPayload.state;
  if (input.statusOwner.terminalReason.reason === "output_limit") return "failed";
  if (input.statusOwner.timedOut) return "failed";
  if (resultPausedAwaitingSupervisor) return "paused";
  if (input.statusOwner.supervisorPauseTransitionFailed) return "failed";
  if (
    input.statusPayload.state === "failed" ||
    input.statusPayload.state === "paused" ||
    input.statusPayload.state === "cancelled" ||
    input.statusPayload.state === "continued"
  )
    return input.statusPayload.state;
  if (input.statusOwner.interrupted) return "paused";
  return input.results.every((result) => result.success) ? "complete" : "failed";
}

function resultSummary(
  input: TerminalPersistenceInput,
  state: AsyncStatus["state"],
  paused: AsyncStatus["pause"] | undefined,
): string {
  if (
    state === "failed" &&
    (input.statusPayload.timedOut ||
      (!input.statusOwner.concurrentTerminalStatusAdopted && input.statusOwner.timedOut))
  )
    return input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.";
  if (paused) {
    const requesterIndex = input.statusOwner.supervisorPauseRequest?.requesterIndex ?? 0;
    const requesterAgent = input.statusPayload.steps[requesterIndex]?.agent ?? input.agentName;
    return input.pausedOutputForIndex(requesterIndex, requesterAgent);
  }
  if (state === "failed") {
    return (
      input.statusPayload.error ??
      (input.statusOwner.supervisorPauseTransitionFailed
        ? "Async supervisor lifecycle update failed. The run was stopped safely and marked failed."
        : input.summary)
    );
  }
  if (state === "paused") return "Paused after interrupt. Waiting for explicit next action.";
  return input.summary;
}

function resultPauseBeforeTerminalWrite(
  input: TerminalPersistenceInput,
): AsyncStatus["pause"] | undefined {
  if (input.pausedAwaitingSupervisor) return input.pausedAwaitingSupervisor;
  if (
    input.safePausedResultAfterReap &&
    !input.statusOwner.supervisorPauseTransitionFailed &&
    !input.statusOwner.concurrentTerminalStatusAdopted
  )
    return input.safePausedResultAfterReap;
  return undefined;
}

function resultPauseFromCanonicalStatus(
  input: TerminalPersistenceInput,
  fallback: AsyncStatus["pause"] | undefined,
): AsyncStatus["pause"] | undefined {
  return input.statusPayload.state === "paused"
    ? (input.statusPayload.pause ?? fallback)
    : undefined;
}

function canonicalStatusValue<T>(
  input: TerminalPersistenceInput,
  value: T | undefined,
  fallback: T | undefined,
): T | undefined {
  return input.statusOwner.concurrentTerminalStatusAdopted ? value : (value ?? fallback);
}

function resultItems(results: RunnerStepResult[]): AsyncResultArtifact["results"] {
  return results.map((result) => ({
    agent: result.agent,
    ...(result.projectAgent ? { projectAgent: result.projectAgent } : {}),
    tkTicketId: result.tkTicketId,
    output: result.output,
    error: result.error,
    stderr: result.stderr,
    stderrTruncated: result.stderrTruncated,
    protocolOutputLimit: result.protocolOutputLimit,
    success: result.success,
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    skipped: result.skipped || undefined,
    interrupted: result.interrupted || undefined,
    timedOut: result.timedOut || undefined,
    toolBudget: result.toolBudget,
    toolBudgetBlocked: result.toolBudgetBlocked || undefined,
    contextUsage: result.contextUsage,
    contextPressure: result.contextPressure,
    contextPressureCrossedThresholds: result.contextPressureCrossedThresholds,
    terminationReason: result.terminationReason,
    sessionFile: result.sessionFile,
    model: result.model,
    modelIdentity: result.modelIdentity,
    modelResolution: result.modelResolution,
    attemptedModels: result.attemptedModels,
    modelAttempts: result.modelAttempts,
    modelFallbackNotice: result.modelFallbackNotice,
    totalCost: result.totalCost,
    artifactPaths: result.artifactPaths,
    processCleanup: result.processCleanup,
    truncated: result.truncated,
    transcriptPath: result.transcriptPath,
    transcriptError: result.transcriptError,
    acceptance: result.acceptance,
    pause: result.pause,
    activeRuntimeMs: result.activeRuntimeMs,
    activeRuntimeCheckpointAt: result.activeRuntimeCheckpointAt,
    activityState: result.activityState,
    idleEpisodeId: result.idleEpisodeId,
    durableAttentionReasons: result.durableAttentionReasons,
    compaction: result.compaction,
  }));
}

function writeResultArtifact(
  input: TerminalPersistenceInput,
  telemetry: SubagentRunTelemetry | undefined,
  state: AsyncStatus["state"],
  paused: AsyncStatus["pause"] | undefined,
  startedAt: number,
  endedAt: number,
): void {
  const timedOut =
    input.statusPayload.timedOut ||
    (!input.statusOwner.concurrentTerminalStatusAdopted && input.statusOwner.timedOut);
  const deadlineAt = canonicalStatusValue(
    input,
    input.statusPayload.deadlineAt,
    input.config.deadlineAt,
  );
  const totalCost = canonicalStatusValue(
    input,
    input.statusPayload.totalCost,
    input.finalTotalCost,
  );
  const sessionFile = canonicalStatusValue(
    input,
    input.statusPayload.sessionFile,
    input.effectiveSessionFile,
  );
  const shareUrl = canonicalStatusValue(input, input.statusPayload.shareUrl, input.shareUrl);
  const gistUrl = canonicalStatusValue(input, input.statusPayload.gistUrl, input.gistUrl);
  const shareError = canonicalStatusValue(input, input.statusPayload.shareError, input.shareError);
  const artifactsDir = canonicalStatusValue(
    input,
    input.statusPayload.artifactsDir,
    input.artifactsDir,
  );
  const cwd = canonicalStatusValue(input, input.statusPayload.cwd, input.cwd) ?? input.cwd;
  const sessionId = canonicalStatusValue(
    input,
    input.statusPayload.sessionId,
    input.config.sessionId ?? undefined,
  );
  const projectAgents = canonicalStatusValue(
    input,
    input.statusPayload.projectAgents,
    input.config.projectAgents,
  );
  const result: AsyncResultArtifact = {
    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
    id: input.config.id,
    agent: input.agentName,
    mode: input.statusPayload.mode,
    success: state === "complete",
    state,
    summary: resultSummary(input, state, paused),
    ...(telemetry ? { telemetry } : {}),
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    ...(input.statusPayload.toolBudget ? { toolBudget: input.statusPayload.toolBudget } : {}),
    ...(input.statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
    ...(timedOut && state === "failed"
      ? {
          timedOut: true,
          error: input.statusPayload.error ?? input.timeoutMessage ?? "Subagent timed out.",
        }
      : state === "failed"
        ? {
            error:
              input.statusPayload.error ??
              "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.",
          }
        : {}),
    ...(paused ? { pause: paused } : {}),
    ...(normalizeActiveRuntimeMs(input.statusPayload.activeRuntimeMs) !== undefined
      ? { activeRuntimeMs: normalizeActiveRuntimeMs(input.statusPayload.activeRuntimeMs) }
      : {}),
    ...(normalizeActiveRuntimeCheckpointAt(input.statusPayload.activeRuntimeCheckpointAt) !==
    undefined
      ? {
          activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
            input.statusPayload.activeRuntimeCheckpointAt,
          ),
        }
      : {}),
    results: resultItems(input.results),
    exitCode: state === "failed" ? 1 : 0,
    timestamp: endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    totalTokens: input.statusPayload.totalTokens,
    totalCost,
    truncated: input.truncated,
    artifactsDir,
    cwd,
    asyncDir: input.asyncDir,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(projectAgents ? { projectAgents } : {}),
    sessionFile,
    shareUrl,
    gistUrl,
    shareError,
    ...(input.taskIndex !== undefined ? { taskIndex: input.taskIndex } : {}),
    ...(input.totalTasks !== undefined ? { totalTasks: input.totalTasks } : {}),
  };
  try {
    writeAtomicJson(input.resultPath, result);
  } catch (error) {
    console.error(`Failed to write result file ${input.resultPath}:`, error);
  }
}

/** Persist the explicit result required when a detached continuation loses its claim gate. */
export function persistContinuationGateRejection(input: ContinuationGateRejectionInput): void {
  const { statusPayload } = input;
  const endedAt = Date.now();
  statusPayload.state = "failed";
  statusPayload.pid = undefined;
  statusPayload.endedAt = endedAt;
  statusPayload.lastUpdate = endedAt;
  statusPayload.error = `Continuation launch gate rejected for source run '${input.sourceRunId}' child ${input.sourceIndex}.`;
  statusPayload.steps = statusPayload.steps.map((step, index) =>
    index === 0
      ? {
          ...step,
          status: "failed",
          endedAt,
          exitCode: 1,
          terminationReason: step.terminationReason ?? "process_exit",
          error: statusPayload.error,
        }
      : step,
  );
  const firstStep = statusPayload.steps[0];
  const gateResults = statusPayload.steps.map((step, index) => ({
    index,
    agent: step.agent,
    ...(index === 0 ? { success: false, terminationReason: "process_exit" as const } : {}),
  }));
  const gateTelemetry = telemetryFromRunnerResults({
    runId: input.config.id,
    mode: input.plan.kind,
    results:
      gateResults.length > 0
        ? gateResults
        : [
            {
              index: 0,
              agent: firstStep?.agent ?? "subagent",
              success: false,
              terminationReason: "process_exit",
            },
          ],
    provenance: input.config.telemetry?.provenance,
    controls: input.controlConfig,
    startedAt: input.overallStartTime,
    endedAt,
    statusSteps: statusPayload.steps,
    lineage: input.config.telemetry?.lineage,
    outcome: { state: "failed", terminationReason: "process_exit" },
  });
  if (gateTelemetry) statusPayload.telemetry = gateTelemetry;
  writeNormalizedLifecycleStatus(input.asyncDir, statusPayload);
  const agent = firstStep?.agent ?? "subagent";
  try {
    writeAtomicJson(input.resultPath, {
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      id: input.config.id,
      agent,
      mode: statusPayload.mode,
      success: false,
      state: "failed" as const,
      summary: statusPayload.error,
      ...(gateTelemetry ? { telemetry: gateTelemetry } : {}),
      error: statusPayload.error,
      results: [
        {
          agent,
          ...(firstStep?.projectAgent ? { projectAgent: firstStep.projectAgent } : {}),
          tkTicketId: firstStep?.tkTicketId,
          output: statusPayload.error,
          error: statusPayload.error,
          success: false,
          exitCode: 1,
        },
      ],
      exitCode: 1,
      timestamp: endedAt,
      durationMs: 0,
      asyncDir: input.asyncDir,
      sessionId: input.config.sessionId,
      ...(input.config.projectAgents ? { projectAgents: input.config.projectAgents } : {}),
    } satisfies AsyncResultArtifact);
  } catch (error) {
    console.error(`Failed to write gate-rejection result file ${input.resultPath}:`, error);
  }
}

/** Persist status, diagnostics, and the final async result after child execution stops. */
export function persistRunnerTerminalRun(input: TerminalPersistenceInput): void {
  let finalTelemetry: SubagentRunTelemetry | undefined;
  if (
    !input.pausedAwaitingSupervisor &&
    !input.skipFinalStatusWrite &&
    !input.statusOwner.concurrentTerminalStatusAdopted
  ) {
    finalTelemetry = applyTerminalStatus(input);
  }

  const preWritePaused = resultPauseBeforeTerminalWrite(input);
  let state = resultState(input, preWritePaused);
  const preWriteEndedAt = input.statusPayload.endedAt ?? input.runEndedAt;
  // A concurrent lifecycle owner may have added continuation lineage while this
  // runner was draining. Use its envelope when it is already authoritative;
  // otherwise build the terminal envelope that the upcoming status write will
  // persist.
  finalTelemetry ??=
    (input.statusOwner.concurrentTerminalStatusAdopted
      ? input.statusPayload.telemetry
      : undefined) ?? buildRunnerTelemetry(input, state, preWriteEndedAt, state === "complete");
  if (
    input.pausedAwaitingSupervisor &&
    finalTelemetry &&
    !input.statusOwner.concurrentTerminalStatusAdopted
  ) {
    input.statusPayload.telemetry = finalTelemetry;
    input.statusOwner.writeStatusPayload({ lifecycleLocked: true });
  }

  // The locked write above may adopt a concurrent terminal resume. Recompute
  // every terminal carrier from the status payload after that write so a
  // paused result cannot be paired with a continued status or telemetry.
  const resultPaused = resultPauseFromCanonicalStatus(input, preWritePaused);
  state = resultState(input, resultPaused);
  const startedAt = input.statusPayload.startedAt ?? input.overallStartTime;
  const endedAt = input.statusPayload.endedAt ?? input.runEndedAt;
  finalTelemetry =
    input.statusPayload.telemetry ??
    buildRunnerTelemetry(input, state, endedAt, state === "complete");
  const totalCost = canonicalStatusValue(
    input,
    input.statusPayload.totalCost,
    input.finalTotalCost,
  );
  const artifactsDir = canonicalStatusValue(
    input,
    input.statusPayload.artifactsDir,
    input.artifactsDir,
  );
  const cwd = canonicalStatusValue(input, input.statusPayload.cwd, input.cwd) ?? input.cwd;
  const sessionFile = canonicalStatusValue(
    input,
    input.statusPayload.sessionFile,
    input.effectiveSessionFile,
  );
  const shareUrl = canonicalStatusValue(input, input.statusPayload.shareUrl, input.shareUrl);
  const shareError = canonicalStatusValue(input, input.statusPayload.shareError, input.shareError);

  // Nested completion is independent of telemetry. In particular, the paused
  // supervisor path may have no telemetry envelope, and concurrent terminal
  // adoption may skip the ordinary terminal status write. The status owner
  // de-duplicates this lifecycle edge when an earlier terminal write already
  // published it.
  input.statusOwner.emitNestedSelfEvent("subagent.nested.completed");

  input.appendEvent(
    JSON.stringify({
      type: "subagent.run.completed",
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      ts: endedAt,
      runId: input.config.id,
      status: state,
      durationMs: Math.max(0, endedAt - startedAt),
      totalTokens: input.statusPayload.totalTokens,
      totalCost,
    }),
  );
  input.writeRunLog({
    id: input.config.id,
    mode: input.statusPayload.mode,
    cwd,
    startedAt,
    endedAt,
    steps: input.statusPayload.steps.map((step) => ({
      agent: step.agent,
      status: step.status,
      durationMs: step.durationMs,
      processCleanup: step.processCleanup,
    })),
    // The markdown run log retains the ordered human-facing aggregation built
    // while steps executed. Terminal status still supplies its canonical state,
    // timing, and step rows above; it does not carry this output summary.
    summary: input.summary,
    truncated: input.truncated,
    artifactsDir,
    sessionFile,
    shareUrl,
    shareError,
  });
  writeResultArtifact(input, finalTelemetry, state, resultPaused, startedAt, endedAt);
}
