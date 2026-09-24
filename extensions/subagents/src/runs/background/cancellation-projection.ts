import type {
  ArtifactPaths,
  AsyncStatus,
  ChildProcessCleanupResult,
  CostSummary,
  ContextPressureProjection,
  ContextPressureThreshold,
  ContextUsageDiagnostics,
  ModelAttempt,
  SubagentModelIdentity,
  SubagentModelResolution,
  SubagentTerminationReason,
} from "../../shared/types.ts";
import type { ProtocolOutputLimit } from "../shared/child-protocol.ts";
import type { RunnerStatusStep } from "./run-status-owner.ts";

export const ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE =
  "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";

export interface StepResult {
  agent: string;
  projectAgent?: import("../../agents/project-agent-loader.ts").ProjectAgentIdentity;
  /** Normalized ticket ID, when assigned. */
  ticketId?: string;
  output: string;
  finalOutput?: string;
  error?: string;
  cancel?: AsyncStatus["cancel"];
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  success: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals;
  skipped?: boolean;
  interrupted?: boolean;
  timedOut?: boolean;
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
  skills?: string[];
  skillsWarning?: string;
  outputMode?: import("../../shared/types.ts").OutputMode;
  savedOutputPath?: string;
  outputReference?: import("../../shared/types.ts").SavedOutputReference;
  outputSaveError?: string;
  childLocation?: import("../../shared/child-location.ts").ChildLocationSnapshot;
  pause?: AsyncStatus["pause"];
  activityState?: RunnerStatusStep["activityState"];
  /** Per-child terminal state and evidence-only facts. */
  terminalResult?: import("../../shared/types.ts").SubagentTerminalResult;
}

export function isPausedStepStatus(status: RunnerStatusStep["status"]): boolean {
  return status === "paused";
}

/** Keep a terminal child outcome when cancellation races its final projection. */
export function preservedCancellationStepStatus(
  priorStatus: RunnerStatusStep["status"],
  childInterrupted: boolean,
  exitCode: number | null,
): "complete" | "failed" | undefined {
  if (priorStatus === "complete" || priorStatus === "failed") return priorStatus;
  return !childInterrupted && exitCode === 0 ? "complete" : undefined;
}

/** Project parent cancellation consistently onto a native child result. */
export function applyCancelledStepProjection(
  result: StepResult,
  cancel: AsyncStatus["cancel"] | undefined,
): void {
  if (!cancel || result.success) return;
  result.output = "Cancelled by parent abort.";
  result.error = "Cancelled by parent abort.";
  result.cancel = cancel;
  result.success = false;
  result.exitCode = 1;
  result.interrupted = undefined;
  result.pause = undefined;
  result.terminationReason = "cancelled";
}

/** Project cancellation after a child finishes so a paused child is not revived. */
export function applyCancelledStatusStepProjection(
  step: RunnerStatusStep,
  cancel: AsyncStatus["cancel"] | undefined,
): void {
  if (!cancel || step.status === "complete" || step.status === "failed") return;
  step.status = "cancelled";
  step.pause = undefined;
  step.cancel = cancel;
  step.error = cancel.summary || "Cancelled by parent abort.";
  step.exitCode = 1;
  step.terminationReason = "cancelled";
  step.interruptRequestedAt = undefined;
}

export function normalizeFailedSupervisorPauseResults(
  results: StepResult[],
  steps: RunnerStatusStep[],
  requesterIndex: number,
  fallbackAgent: string,
): void {
  for (const result of results) {
    if (
      result.interrupted ||
      result.pause?.kind === "awaiting_supervisor" ||
      result.pause?.kind === "cohort_pause"
    ) {
      result.output = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      result.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      result.success = false;
      result.exitCode = 1;
      result.terminationReason = result.terminationReason ?? "process_exit";
      result.interrupted = undefined;
      result.pause = undefined;
      result.activityState = undefined;
    }
  }
  if (results.length === 0) {
    results.push({
      agent: steps[requesterIndex]?.agent ?? fallbackAgent,
      ...(steps[requesterIndex]?.projectAgent
        ? { projectAgent: steps[requesterIndex].projectAgent }
        : {}),
      ticketId: steps[requesterIndex]?.ticketId,
      output: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
      error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
      success: false,
      exitCode: 1,
      terminationReason: "process_exit",
    });
  }
}
