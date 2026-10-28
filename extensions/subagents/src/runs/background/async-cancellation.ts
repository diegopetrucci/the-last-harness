import type { AsyncStatus, Details, SubagentToolResult } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { continuationResumeBlock } from "./async-resume.ts";
import {
  asyncRunOwnerRejectionMessage,
  authorizeAsyncRunOwner,
  type AsyncRunOwnerAuthorization,
} from "./async-owner-authorization.ts";
import { SUPERVISOR_LIFECYCLE_ERROR_MESSAGE } from "../../shared/pause-messages.ts";
import { ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE } from "./cancellation-projection.ts";
import {
  isCompletedLifecycleStepState,
  lifecycleContinuationForIndex,
  lifecycleGeneration,
  recoverStaleLifecycleContinuationClaim,
  transitionLifecycleStatus,
  withLifecycleContinuation,
} from "../shared/lifecycle-state.ts";
function isClaimedPausedLifecycle(status: AsyncStatus | null | undefined, index = 0): boolean {
  const continuation = lifecycleContinuationForIndex(status, index);
  return Boolean(
    status?.state === "paused" &&
    typeof continuation?.claimToken === "string" &&
    continuation.claimToken.length > 0,
  );
}

function hasResumableSiblingStep(
  steps: NonNullable<AsyncStatus["steps"]> | undefined,
  targetIndex: number,
): boolean {
  return (
    steps?.some(
      (step, stepIndex) =>
        stepIndex !== targetIndex &&
        !isCompletedLifecycleStepState(step.status) &&
        step.status !== "cancelled",
    ) ?? false
  );
}

type OwnerRejectionAuthorization = Exclude<AsyncRunOwnerAuthorization, { outcome: "owned" }>;

class OwnerRejection extends Error {
  readonly authorization: OwnerRejectionAuthorization;
  constructor(authorization: OwnerRejectionAuthorization) {
    super("async run owner rejected");
    this.authorization = authorization;
  }
}

function ownerRejectionResult(
  authorization: Exclude<AsyncRunOwnerAuthorization, { outcome: "owned" }>,
  runId: string,
): SubagentToolResult<Details> {
  return {
    content: [
      { type: "text", text: asyncRunOwnerRejectionMessage(authorization, runId, "cancelled") },
    ],
    isError: true,
    details: { mode: "management", results: [] },
  };
}

/**
 * Cancel one paused child without reviving the detached async runner. The
 * caller must own the run; ownership is authorized before any state read,
 * claim recovery or write, and rechecked inside the lifecycle mutation.
 */
export function cancelPersistedPausedAsyncRun(
  asyncDir: string,
  runId: string,
  index: number | undefined,
  callerKey: string | undefined,
): SubagentToolResult<Details> {
  const preAuthorization = authorizeAsyncRunOwner({ callerKey, asyncDir, runId });
  if (preAuthorization.outcome !== "owned") return ownerRejectionResult(preAuthorization, runId);
  try {
    let current = readStatus(asyncDir);
    if (!current) {
      return {
        content: [{ type: "text", text: `Paused async run '${runId}' was not found.` }],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (current.lifecycle?.resumeBlockedReason === "supervisor_lifecycle_failure") {
      return {
        content: [{ type: "text", text: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE }],
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
            text: `Async run '${runId}' has ${stepCount} children. Provide index to cancel one paused child.`,
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
            text: `Async run '${runId}' has ${stepCount} children. Index ${targetIndex ?? -1} is out of range.`,
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
            text: `Async run '${runId}' child ${targetIndex} is already cancelled.`,
          },
        ],
        details: { mode: "management", results: [] },
      };
    }
    const continuation = lifecycleContinuationForIndex(current, targetIndex);
    const continuationBlock = continuationResumeBlock(continuation);
    const alreadyClaimed = continuationBlock === "claimed" || continuation?.phase === "reserved";
    if (continuationBlock !== undefined && !alreadyClaimed) {
      return {
        content: [
          {
            type: "text",
            text: `Async run '${runId}' already continued into '${lifecycleContinuationForIndex(current, targetIndex)?.continuationRunId ?? current.lifecycle?.continuation?.continuationRunId ?? "unknown"}' and can no longer be cancelled from the paused supervisor lifecycle.`,
          },
        ],
        isError: true,
        details: { mode: "management", results: [] },
      };
    }
    if (alreadyClaimed || isClaimedPausedLifecycle(current, targetIndex)) {
      return {
        content: [
          {
            type: "text",
            text: `Async run '${runId}' child ${targetIndex} is already claimed for continuation and cannot be cancelled through the paused supervisor lifecycle.`,
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
            text: `Async run '${runId}' child ${targetIndex} is not a paused child.`,
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
    transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(current),
      mutate: (status) => {
        // Recheck under the lifecycle lock using the status being mutated (no re-read/re-lock).
        const recheck = authorizeAsyncRunOwner({ callerKey, asyncDir, runId, status });
        if (recheck.outcome !== "owned") throw new OwnerRejection(recheck);
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
        return {
          ...status,
          state: remainingActionable || remainingResumable ? "paused" : "cancelled",
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
          lifecycle: withLifecycleContinuation(status, targetIndex, undefined),
          steps: nextSteps,
        };
      },
    });
    return {
      content: [
        {
          type: "text",
          text: `Cancelled paused async run ${runId} child ${targetIndex}. Existing enabled artifacts and the canonical child session were preserved; compact mode may omit the diagnostic child transcript. Resume is no longer available for that child.`,
        },
      ],
      details: { mode: "management", results: [] },
    };
  } catch (error) {
    if (error instanceof OwnerRejection) return ownerRejectionResult(error.authorization, runId);
    return {
      content: [
        {
          type: "text",
          text: `Paused async run '${runId}' could not be updated safely. ${SUPERVISOR_LIFECYCLE_ERROR_MESSAGE}`,
        },
      ],
      isError: true,
      details: { mode: "management", results: [] },
    };
  }
}
