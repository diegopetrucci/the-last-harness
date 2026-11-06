import * as fs from "node:fs";
import * as path from "node:path";
import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  normalizeProjectAgentRunCapture,
  releaseProjectAgentRunReference,
  type ProjectAgentRunCapture,
} from "../../agents/project-agent-snapshot.ts";
import { FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE } from "../../shared/foreground-pause.ts";
import { canonicalSubagentModelIdentity } from "../shared/model-fallback.ts";
import {
  lifecycleContinuationForIndex,
  lifecycleGeneration,
  recoverStaleLifecycleContinuationClaim,
  transitionLifecycleStatus,
  withLifecycleContinuation,
} from "../shared/lifecycle-state.ts";
import {
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
  parseContextUsageDiagnostics,
} from "../../shared/context-diagnostics.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  type AsyncStatus,
  type Details,
  type SubagentRunMode,
  type SubagentState,
  type SubagentToolResult,
} from "../../shared/types.ts";
import {
  transitionSubagentRunTelemetryLifecycle,
  type SubagentRunTelemetry,
} from "../../shared/telemetry.ts";
import type { SubagentParamsLike } from "./subagent-executor.ts";
import { isClaimedPausedLifecycle, pausedForegroundStatusPath } from "./foreground-pause-state.ts";
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
} from "../shared/lifecycle-state.ts";
import { projectRunAuthorizationError } from "./project-agent-control.ts";
import { normalizeTkTicketId } from "../shared/tk-ticket.ts";
import { isWellFormedResolvedAcceptance } from "../shared/acceptance.ts";

function foregroundRunHasResumableState(run: {
  runId: string;
  children: readonly {
    status: string;
    sessionFile?: string;
  }[];
}): boolean {
  const persistedPath = pausedForegroundStatusPath(run.runId);
  try {
    const status = readStatus(persistedPath);
    if (status) {
      if (status.state === "paused" || status.state === "pausing" || status.state === "running") {
        return true;
      }
      if (
        status.steps?.some(
          (step) =>
            step.status !== "continued" &&
            step.status !== "cancelled" &&
            (step.status === "paused" ||
              step.status === "pausing" ||
              step.status === "pending" ||
              step.status === "running" ||
              step.sessionFile !== undefined),
        )
      ) {
        return true;
      }
      return false;
    }
  } catch {
    // Unknown persisted state is retained rather than releasing authority.
    return true;
  }
  return (
    run.children.length === 0 ||
    run.children.some(
      (child) =>
        child.status === "paused" ||
        child.status === "pausing" ||
        child.status === "pending" ||
        child.status === "running" ||
        ((child.status === "completed" || child.status === "failed") &&
          child.sessionFile !== undefined),
    )
  );
}

function scheduleForegroundProjectReferenceRelease(runId: string): void {
  const releaseTimer = setTimeout(
    () => releaseProjectAgentRunReference(runId),
    PROJECT_AGENT_TERMINAL_RETENTION_MS,
  );
  releaseTimer.unref?.();
}

export function trimRememberedForegroundRuns(state: SubagentState): void {
  if (!state.foregroundRuns) return;
  while (state.foregroundRuns.size > 50) {
    const oldest = [...state.foregroundRuns.values()].sort(
      (left, right) => left.updatedAt - right.updatedAt,
    )[0];
    if (!oldest) break;
    state.foregroundRuns.delete(oldest.runId);
    if (!foregroundRunHasResumableState(oldest)) {
      scheduleForegroundProjectReferenceRelease(oldest.runId);
    }
  }
}

export function resolveRememberedForegroundRun(
  params: SubagentParamsLike,
  state: SubagentState,
):
  | {
      run: import("../../shared/types.ts").ForegroundResumeRun;
      index: number;
      child: import("../../shared/types.ts").ForegroundResumeChild;
    }
  | undefined {
  const requested = params.id?.trim();
  if (!requested || !state.foregroundRuns?.size) return undefined;
  const direct = state.foregroundRuns.get(requested);
  const matches = direct
    ? [direct]
    : [...state.foregroundRuns.values()].filter((run) => run.runId.startsWith(requested));
  if (matches.length === 0) return undefined;
  if (matches.length > 1)
    throw new Error(
      `Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`,
    );
  const run = matches[0]!;
  if (run.children.length > 1 && params.index === undefined)
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`,
    );
  const index = params.index ?? 0;
  if (!Number.isInteger(index))
    throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
  if (index < 0 || index >= run.children.length)
    throw new Error(
      `Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`,
    );
  return { run, index, child: run.children[index]! };
}

export function resolveForegroundResumeTarget(
  params: SubagentParamsLike,
  state: SubagentState,
):
  | {
      runId: string;
      mode: SubagentRunMode;
      state: "complete" | "failed" | "paused";
      agent: string;
      index: number;
      cwd: string;
      sessionFile: string;
      asyncDir?: string;
      pauseKind?: "awaiting_supervisor" | "cohort_pause";
      continuationAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
      modelIdentity?: import("../../shared/types.ts").SubagentModelIdentity;
      modelResolution?: import("../../shared/types.ts").SubagentModelResolution;
      contextUsage?: import("../../shared/types.ts").ContextUsageDiagnostics;
      contextPressure?: import("../../shared/types.ts").ContextPressureProjection;
      contextPressureCrossedThresholds?: import("../../shared/types.ts").ContextPressureThreshold[];
      activityState?: import("../../shared/types.ts").ActivityState;
      idleEpisodeId?: string;
      durableAttentionReasons?: import("../../shared/types.ts").DurableAttentionReason[];
      compaction?: { reason: import("../../shared/types.ts").CompactionReason };
      tkTicketId?: string;
      activeRuntimeMs?: number;
      activeRuntimeCheckpointAt?: number;
      telemetry?: SubagentRunTelemetry;
      projectAgents?: ProjectAgentRunCapture[];
    }
  | undefined {
  const resolved = resolveRememberedForegroundRun(params, state);
  if (!resolved) return undefined;
  const { run, index, child } = resolved;
  if (child.cancel?.cancelledAt)
    throw new Error(
      `Foreground run '${run.runId}' child ${index} was cancelled while paused and cannot be resumed. Inspect status and any retained output/session artifacts if needed; compact mode may omit the diagnostic child transcript.`,
    );
  if (!child.sessionFile)
    throw new Error(
      `Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`,
    );
  if (path.extname(child.sessionFile) !== ".jsonl")
    throw new Error(
      `Foreground run '${run.runId}' child ${index} session file must be a .jsonl file.`,
    );
  const sessionFile = path.resolve(child.sessionFile);
  if (!fs.existsSync(sessionFile))
    throw new Error(`Foreground run '${run.runId}' child ${index} session file is missing.`);
  const childState = child.status === "completed" ? "complete" : child.status;
  const projectAgentMarker = Object.hasOwn(child, "projectAgent")
    ? normalizeProjectAgentRunCapture(child.projectAgent)
    : undefined;
  if (Object.hasOwn(child, "projectAgent") && !projectAgentMarker) {
    throw projectRunAuthorizationError(
      `Foreground run '${run.runId}' child ${index} has an invalid project-agent marker.`,
    );
  }
  const projectAgentMarkers = run.children.flatMap((candidate) => {
    if (!Object.hasOwn(candidate, "projectAgent")) return [];
    const marker = normalizeProjectAgentRunCapture(candidate.projectAgent);
    if (!marker) {
      throw projectRunAuthorizationError(
        `Foreground run '${run.runId}' has an invalid project-agent marker on child ${candidate.index}.`,
      );
    }
    return [marker];
  });
  const childModelIdentity =
    child.modelIdentity ?? canonicalSubagentModelIdentity(child.model, child.thinking);
  let continuationAcceptance: import("../../shared/types.ts").ResolvedAcceptanceConfig | undefined;
  if (childState === "paused") {
    if (
      !child.acceptance ||
      !isWellFormedResolvedAcceptance(child.acceptance.effectiveAcceptance)
    ) {
      throw new Error(
        `Foreground run '${run.runId}' child ${index} has a missing or malformed persisted acceptance ledger; refusing to resume with an unverified acceptance contract.`,
      );
    }
    if (child.acceptance.status === "skipped") {
      if (child.acceptance.effectiveAcceptance.level === "none") {
        throw new Error(
          `Foreground run '${run.runId}' child ${index} has an incompatible persisted acceptance ledger: status 'skipped' cannot carry effective level 'none'.`,
        );
      }
      continuationAcceptance = child.acceptance.effectiveAcceptance;
    } else if (child.acceptance.status === "not-required") {
      if (child.acceptance.effectiveAcceptance.level !== "none") {
        throw new Error(
          `Foreground run '${run.runId}' child ${index} has an incompatible persisted acceptance ledger: status 'not-required' must carry effective level 'none'.`,
        );
      }
    } else {
      throw new Error(
        `Foreground run '${run.runId}' child ${index} has an incompatible persisted acceptance ledger status '${child.acceptance.status}'; expected 'skipped' or 'not-required'.`,
      );
    }
  }
  return {
    runId: run.runId,
    mode: run.mode,
    state: childState,
    agent: child.agent,
    ...(projectAgentMarker ? { projectAgent: projectAgentMarker } : {}),
    ...(child.agent === "developer" && normalizeTkTicketId(child.tkTicketId)
      ? { tkTicketId: normalizeTkTicketId(child.tkTicketId) }
      : {}),
    index,
    cwd: run.cwd,
    sessionFile,
    ...(fs.existsSync(pausedForegroundStatusPath(run.runId))
      ? { asyncDir: pausedForegroundStatusPath(run.runId) }
      : {}),
    ...(child.pause?.kind ? { pauseKind: child.pause.kind } : {}),
    ...(continuationAcceptance ? { continuationAcceptance } : {}),
    ...(childModelIdentity ? { modelIdentity: childModelIdentity } : {}),
    ...(projectAgentMarkers.length > 0 ? { projectAgents: projectAgentMarkers } : {}),
    ...(child.modelResolution ? { modelResolution: child.modelResolution } : {}),
    ...(parseContextUsageDiagnostics(child.contextUsage)
      ? { contextUsage: parseContextUsageDiagnostics(child.contextUsage) }
      : {}),
    ...(parseContextPressureProjection(child.contextPressure)
      ? { contextPressure: parseContextPressureProjection(child.contextPressure) }
      : {}),
    ...(parseContextPressureCrossedThresholds(child.contextPressureCrossedThresholds)
      ? {
          contextPressureCrossedThresholds: parseContextPressureCrossedThresholds(
            child.contextPressureCrossedThresholds,
          ),
        }
      : {}),
    ...(child.activityState ? { activityState: child.activityState } : {}),
    ...(child.idleEpisodeId ? { idleEpisodeId: child.idleEpisodeId } : {}),
    ...(child.durableAttentionReasons
      ? { durableAttentionReasons: [...child.durableAttentionReasons] }
      : {}),
    ...(child.compaction ? { compaction: { ...child.compaction } } : {}),
    ...(normalizeActiveRuntimeMs(child.activeRuntimeMs) !== undefined
      ? { activeRuntimeMs: normalizeActiveRuntimeMs(child.activeRuntimeMs) }
      : {}),
    ...(normalizeActiveRuntimeCheckpointAt(child.activeRuntimeCheckpointAt) !== undefined
      ? {
          activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
            child.activeRuntimeCheckpointAt,
          ),
        }
      : {}),
    ...(run.telemetry ? { telemetry: run.telemetry } : {}),
  };
}
function updateRememberedForegroundCancellation(
  state: SubagentState,
  runId: string,
  cancelledAt: number,
  summary: string,
  index = 0,
): void {
  const run = state.foregroundRuns?.get(runId);
  const child = run?.children[index];
  if (!run || !child) return;
  run.updatedAt = cancelledAt;
  run.children[index] = {
    ...child,
    cancel: { summary, cancelledAt },
    terminationReason: "cancelled",
  };
}

function hasResumableSiblingStep(
  steps: NonNullable<AsyncStatus["steps"]> | undefined,
  targetIndex: number,
): boolean {
  return (
    steps?.some(
      (step, stepIndex) =>
        stepIndex !== targetIndex && step.status !== "continued" && step.status !== "cancelled",
    ) ?? false
  );
}

export function cancelPersistedPausedForegroundRun(
  state: SubagentState,
  asyncDir: string,
  runId: string,
  index?: number,
): SubagentToolResult<Details> {
  try {
    let current = readStatus(asyncDir);
    if (!current) {
      return {
        content: [{ type: "text", text: `Paused foreground run '${runId}' was not found.` }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const stepCount = current.steps?.length ?? 0;
    const targetIndex = index ?? (stepCount <= 1 ? 0 : undefined);
    if (stepCount > 1 && targetIndex === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' has ${stepCount} children. Provide index to cancel one paused child.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (targetIndex === undefined || targetIndex < 0 || targetIndex >= stepCount) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' has ${stepCount} children. Index ${targetIndex ?? -1} is out of range.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const recovered = recoverStaleLifecycleContinuationClaim(asyncDir, targetIndex);
    if (recovered.recovered && recovered.status) current = recovered.status;
    const targetStep = current.steps?.[targetIndex];
    const targetPause = targetStep?.pause ?? (stepCount <= 1 ? current.pause : undefined);
    if (targetStep?.status === "cancelled") {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is already cancelled.`,
          },
        ],
        details: { mode: "management", results: [] },
      };
    }
    if (targetStep?.status === "continued") {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} already continued and cannot be cancelled.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (current.state === "continued" && stepCount <= 1) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' already continued into '${lifecycleContinuationForIndex(current, targetIndex)?.continuationRunId ?? current.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and can no longer be cancelled from the paused supervisor lifecycle.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (isClaimedPausedLifecycle(current, targetIndex)) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is already claimed for continuation and cannot be cancelled through the paused supervisor lifecycle.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (
      current.state !== "paused" ||
      !targetStep ||
      (targetStep.status !== "paused" && targetStep.status !== "pausing") ||
      !targetPause
    ) {
      return {
        content: [
          {
            type: "text",
            text: `Foreground run '${runId}' child ${targetIndex} is not a paused child.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    const cancelledAt = Date.now();
    const summary =
      targetPause.kind === "awaiting_supervisor"
        ? "Cancelled while paused awaiting supervisor."
        : "Cancelled while paused with the cohort.";
    const transitioned = transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) => {
        const nextSteps = status.steps?.map((step, stepIndex) =>
          stepIndex === targetIndex
            ? {
                ...step,
                status: "cancelled" as const,
                endedAt: cancelledAt,
                exitCode: 0,
                cancel: { summary, cancelledAt },
                terminationReason: "cancelled" as const,
              }
            : step,
        );
        const remainingActionable =
          nextSteps?.some(
            (step) =>
              step.status === "paused" || step.status === "pausing" || step.status === "pending",
          ) ?? false;
        const remainingResumable = hasResumableSiblingStep(nextSteps, targetIndex);
        const nextState = remainingActionable || remainingResumable ? "paused" : "cancelled";
        const telemetry = transitionSubagentRunTelemetryLifecycle({
          telemetry: status.telemetry,
          runState: nextState,
          stepIndex: targetIndex,
          stepState: "cancelled",
          endedAt: cancelledAt,
        });
        return {
          ...status,
          state: nextState,
          pid: undefined,
          ...(remainingActionable || remainingResumable
            ? {}
            : { cancel: { summary, cancelledAt } }),
          pause: remainingActionable
            ? nextSteps?.find(
                (step) =>
                  step.pause?.kind === "awaiting_supervisor" &&
                  (step.status === "paused" || step.status === "pausing"),
              )?.pause
            : undefined,
          lastUpdate: cancelledAt,
          endedAt: cancelledAt,
          ...(telemetry ? { telemetry } : {}),
          lifecycle: withLifecycleContinuation(status, targetIndex, undefined),
          steps: nextSteps,
        };
      },
    });
    if (transitioned.status.state === "cancelled") releaseProjectAgentRunReference(runId);
    updateRememberedForegroundCancellation(state, runId, cancelledAt, summary, targetIndex);
    return {
      content: [
        {
          type: "text",
          text: `Cancelled paused foreground run ${runId} child ${targetIndex}. Existing enabled artifacts and the canonical child session were preserved; compact mode may omit the diagnostic child transcript. Resume is no longer available for that child.`,
        },
      ],
      details: { mode: "management", results: [] },
    };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `Paused foreground run '${runId}' could not be updated safely. ${FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE}`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
}
