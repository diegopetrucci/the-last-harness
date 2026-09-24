/**
 * Internal awaited-run owner.
 *
 * Ordinary execution uses this awaited owner while explicit async:true calls
 * remain detached. This module is deliberately a narrow parent-side adapter:
 * it subscribes before spawn, arbitrates the
 * result artifact with the background watcher, validates run identity and
 * lifecycle generation, and turns the terminal artifact into the same native
 * tool result used by the synchronous paths.
 */

import * as fs from "node:fs";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT,
  type AsyncStatus,
  type ChildProcessCleanupResult,
  type Details,
  type NestedRunSummary,
  type SingleResult,
  type SubagentEventBus,
  type SubagentRunMode,
  type SubagentResultStatus,
  type SubagentTerminationReason,
  type Usage,
  type SubagentTerminalResult,
} from "../../shared/types.ts";
import type { RunnerSubagentStep, SubagentRunPlan } from "../shared/parallel-utils.ts";
import {
  attachNestedChildrenToResultChildren,
  resolveSubagentResultStatus,
} from "../../shared/result-formatting.ts";
import {
  buildAwaitedNativeResult,
  resultSummaryForNativeAwaited,
} from "../../shared/result-formatting.ts";
import { sanitizeSummary } from "../shared/nested-events.ts";
import { parseSubagentTerminationReason } from "../../shared/context-diagnostics.ts";
import { parseSubagentTerminalResult } from "../../shared/terminal-result.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  checkPidLiveness,
  isCompletedLifecycleState,
  isCompletedLifecycleStepState,
  lifecycleGeneration,
  transitionLifecycleStatus,
  type PidLiveness,
} from "../shared/lifecycle-state.ts";
import {
  cleanupOwnedProcessGroup,
  normalizeChildProcessCleanup,
  PROCESS_GROUP_CLEANUP_MAX_WAIT_MS,
  skipOwnedProcessGroupCleanup,
  supportsOwnedProcessGroupCleanup,
  type OwnedProcessGroupOwner,
} from "../shared/process-group-cleanup.ts";
import { deliverTimeoutRequest, requestAsyncInterrupt } from "./control-channel.ts";
import {
  claimResultArtifact,
  resultArtifactClaimCleanupDelayMs,
  RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS,
  type ResultArtifactClaim,
  type ResultArtifactFs,
} from "./result-artifact-consumer.ts";
import {
  isAwaitedRunOwner,
  registerAwaitedRun,
  unregisterAwaitedRun,
} from "./awaited-run-registry.ts";
import { formatSupervisorPauseMessage } from "../../shared/pause-messages.ts";
import { buildAwaitedProgressUpdate } from "./awaited-progress.ts";
import { persistedTicketId } from "../shared/ticket-context.ts";

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_ARTIFACT_GRACE_MS = 150;
const DEFAULT_CLEANUP_GRACE_MS = 1_000;
const OWNER_TIMEOUT_MESSAGE = "Subagent timed out before finalization.";
const OWNER_MALFORMED_COMPLETION_MESSAGE = "Awaited run completion artifact was malformed.";
const OWNER_CLEANUP_DIAGNOSTIC_MAX_CHARS = 4_000;

const TERMINAL_STATES = new Set<AsyncStatus["state"]>([
  "complete",
  "failed",
  "cancelled",
  "paused",
]);

type RecordValue = Record<string, unknown>;

type AwaitedArtifact = RecordValue & {
  id: string;
  state: AsyncStatus["state"];
  asyncDir: string;
  sessionId?: string | null;
  generation?: number;
};

export interface AwaitedRunOwnerOptions {
  id: string;
  asyncDir: string;
  resultPath: string;
  mode: SubagentRunMode;
  plan: SubagentRunPlan;
  events: SubagentEventBus;
  sessionId?: string | null;
  cwd?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  expectedGeneration?: number;
  signal?: AbortSignal;
  /** Injected in tests; production uses the awaited cleanup primitive. */
  cleanup?: (
    processGroupId: number,
    owner?: OwnedProcessGroupOwner,
  ) => Promise<ChildProcessCleanupResult>;
  platform?: NodeJS.Platform;
  now?: () => number;
  pollIntervalMs?: number;
  artifactGraceMs?: number;
  /** Grace period after runner death/deadline before synthesizing failure. */
  cleanupGraceMs?: number;
  /** Maximum wait for the owned process-group cleanup primitive. */
  cleanupMaxWaitMs?: number;
  /** Injected in tests; production uses the host filesystem for artifact claims. */
  fs?: ResultArtifactFs;
  /** Injected in tests; production checks the runner pid with process.kill(pid, 0). */
  pidLiveness?: (pid: number) => PidLiveness;
  /** Injected in tests; production uses the host interval functions. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Receives status-driven progress while the awaited runner is live. */
  onUpdate?: (result: AwaitedRunResult) => void;
}

interface AwaitedRunOwner {
  /** Settles to a normal tool result, including a cancelled result on abort. */
  readonly promise: Promise<AwaitedRunResult>;
  /** Call immediately after spawn returns, before publishing the start event. */
  markSpawned(processId: number, owner?: OwnedProcessGroupOwner): void;
  /** Alias useful to narrow internal test seams. */
  start(processId: number, owner?: OwnedProcessGroupOwner): void;
  /** Request parent-owned cancellation; idempotent. */
  cancel(): Promise<void>;
  /** Settle a launch failure using the normal awaited result envelope. */
  fail(message: string): Promise<AwaitedRunResult>;
  /** Request child cleanup and settle a disposed owner with a bounded failure envelope. */
  dispose(): void;
}

export interface AwaitedRunResult {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
  isError?: boolean;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Compute the bounded point at which cleanup and artifact grace have elapsed. */
export function computeAwaitedHardDeadlineAt(input: {
  deadlineAt?: number;
  abortStartedAt?: number;
  cleanupGraceMs: number;
  artifactGraceMs: number;
  /** Maximum wait for the cleanup primitive; defaults to its production bound. */
  cleanupMaxWaitMs?: number;
}): number | undefined {
  const base = finiteNumber(input.abortStartedAt) ?? finiteNumber(input.deadlineAt);
  if (base === undefined) return undefined;
  const cleanupMaxWaitMs = Math.max(
    0,
    finiteNumber(input.cleanupMaxWaitMs) ?? PROCESS_GROUP_CLEANUP_MAX_WAIT_MS,
  );
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    base +
      cleanupMaxWaitMs +
      Math.max(0, finiteNumber(input.cleanupGraceMs) ?? 0) +
      Math.max(0, finiteNumber(input.artifactGraceMs) ?? 0),
  );
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function terminalState(value: unknown): AsyncStatus["state"] | undefined {
  if (value === "complete") return "complete";
  if (value === "failed") return "failed";
  if (value === "cancelled") return "cancelled";
  if (value === "paused") return "paused";
  return undefined;
}

function terminationReasonForLifecycleState(state: unknown): SubagentTerminationReason {
  switch (state) {
    case "complete":
      return "completed";
    case "paused":
      return "paused";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "running":
    case "pending":
    case "pausing":
    case "queued":
      return "process_exit";
    default:
      return "unknown";
  }
}

function resultStatusForChild(
  child: RecordValue,
  parentState: AsyncStatus["state"],
): SubagentResultStatus {
  // Cancellation is a terminal failure projection for the interrupted leaf in
  // the native envelope. Preserve an already-completed parallel sibling, but do
  // not let a cancelled leaf's interrupted bit turn it into a paused child.
  const childState = terminalState(child.state);
  if (parentState === "cancelled") {
    return child.success === true || childState === "complete" || child.state === "completed"
      ? "completed"
      : "failed";
  }
  return resolveSubagentResultStatus({
    interrupted:
      child.interrupted === true ||
      (childState === "paused" && child.interrupted !== false) ||
      (parentState === "paused" && child.success === false && child.exitCode === 0),
    success: typeof child.success === "boolean" ? child.success : undefined,
    exitCode: typeof child.exitCode === "number" ? child.exitCode : undefined,
    state: childState,
  });
}

function rawChildren(artifact: RecordValue): RecordValue[] {
  const children = Array.isArray(artifact.results) ? artifact.results.filter(isRecord) : [];
  return children.length > 0
    ? children
    : [
        {
          agent: artifact.agent,
          output: artifact.summary,
          success: artifact.success,
          state: artifact.state,
        },
      ];
}

function taskForIndex(plan: SubagentRunPlan, index: number): string {
  const tasks = plan.kind === "single" ? [plan.task] : plan.tasks;
  return tasks[index]?.task ?? "";
}

function agentForIndex(plan: SubagentRunPlan, index: number): string {
  const tasks = plan.kind === "single" ? [plan.task] : plan.tasks;
  return tasks[index]?.agent ?? `step-${index + 1}`;
}

function planStepForIndex(plan: SubagentRunPlan, index: number): RunnerSubagentStep | undefined {
  const tasks = plan.kind === "single" ? [plan.task] : plan.tasks;
  return tasks[index];
}

function usageFromArtifact(artifact: RecordValue): Usage {
  const totalTokens = isRecord(artifact.totalTokens) ? artifact.totalTokens : undefined;
  const input = nonNegativeInteger(totalTokens?.input) ?? 0;
  const output = nonNegativeInteger(totalTokens?.output) ?? 0;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    cost: finiteNumber(isRecord(artifact.totalCost) ? artifact.totalCost.costUsd : undefined) ?? 0,
    turns: 0,
  };
}

function usageFromChild(
  artifact: RecordValue,
  child: RecordValue,
  index: number,
  persistedSteps?: unknown[],
): Usage {
  const statusSteps = Array.isArray(artifact.steps) ? artifact.steps : persistedSteps;
  const statusStep = isRecord(statusSteps?.[index]) ? statusSteps[index] : undefined;
  const tokens = isRecord(child.tokens)
    ? child.tokens
    : isRecord(statusStep?.tokens)
      ? statusStep.tokens
      : undefined;
  const childCost = isRecord(child.totalCost)
    ? child.totalCost
    : isRecord(statusStep?.totalCost)
      ? statusStep.totalCost
      : undefined;
  return {
    input: nonNegativeInteger(tokens?.input) ?? 0,
    output: nonNegativeInteger(tokens?.output) ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: finiteNumber(childCost?.costUsd) ?? 0,
    turns: 0,
  };
}

function artifactPaths(value: unknown): SingleResult["artifactPaths"] {
  if (!isRecord(value)) return undefined;
  const fields = [
    "inputPath",
    "outputPath",
    "jsonlPath",
    "transcriptPath",
    "metadataPath",
  ] as const;
  if (!fields.every((field) => typeof value[field] === "string")) return undefined;
  return {
    inputPath: value.inputPath as string,
    outputPath: value.outputPath as string,
    jsonlPath: value.jsonlPath as string,
    transcriptPath: value.transcriptPath as string,
    metadataPath: value.metadataPath as string,
  };
}

function nestedChildren(value: unknown): NestedRunSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const children = value
    .map((child) => sanitizeSummary(child))
    .filter((child): child is NestedRunSummary => Boolean(child));
  return children.length > 0 ? children : undefined;
}

function boundedDiagnostic(value: string): string {
  if (value.length <= OWNER_CLEANUP_DIAGNOSTIC_MAX_CHARS) return value;
  return `${value.slice(0, OWNER_CLEANUP_DIAGNOSTIC_MAX_CHARS)}… [diagnostic truncated]`;
}

function cleanupSummary(cleanup: ChildProcessCleanupResult | undefined): string | undefined {
  if (!cleanup) return undefined;
  const parts = [
    cleanup.terminated ? "terminated" : "not confirmed terminated",
    cleanup.supported ? undefined : "unsupported platform",
    cleanup.skippedReason ? `skipped: ${cleanup.skippedReason}` : undefined,
    cleanup.signals?.length ? `signals=${cleanup.signals.join(",")}` : undefined,
    cleanup.warnings?.length ? boundedDiagnostic(cleanup.warnings.join(" ")) : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? `Process cleanup: ${parts.join("; ")}` : undefined;
}

function cloneCleanup(cleanup: ChildProcessCleanupResult): ChildProcessCleanupResult {
  return {
    ...cleanup,
    ...(cleanup.signals ? { signals: [...cleanup.signals] } : {}),
    ...(cleanup.warnings
      ? { warnings: cleanup.warnings.map((warning) => boundedDiagnostic(warning)) }
      : {}),
  };
}

function isTerminalStatus(status: AsyncStatus | null): status is AsyncStatus {
  return Boolean(status && TERMINAL_STATES.has(status.state));
}

function isPendingSupervisorPause(status: AsyncStatus | null): boolean {
  if (!status || status.pause?.kind !== "awaiting_supervisor") return false;
  if (status.state === "pausing" || status.state === "paused") return true;
  return status.steps?.some((step) => step.pause?.kind === "awaiting_supervisor") ?? false;
}

function isContinuationInFlight(status: AsyncStatus | null): boolean {
  const continuation = status?.lifecycle?.continuation;
  return (
    continuation?.phase === "launched" ||
    continuation?.phase === "continued" ||
    continuation?.continuedAt !== undefined
  );
}

function statusRecord(status: AsyncStatus | null): RecordValue | undefined {
  if (!status) return undefined;
  return { ...status };
}

function pausedSyntheticOutput(
  input: AwaitedRunOwnerOptions,
  status: AsyncStatus,
  step: NonNullable<AsyncStatus["steps"]>[number],
  index: number,
): string {
  if (status.pause?.kind !== "awaiting_supervisor")
    return "Paused after interrupt. Waiting for explicit next action.";
  const requesterIndex =
    status.steps?.findIndex((candidate) => candidate.pause?.kind === "awaiting_supervisor") ?? -1;
  if (requesterIndex !== index)
    return "Paused because another child in this cohort is awaiting supervisor.";
  const parallel = input.plan.kind === "parallel" && input.plan.tasks.length > 1;
  return formatSupervisorPauseMessage({
    headline: `Async run ${input.id} paused awaiting supervisor (${step.agent}).`,
    runId: input.id,
    agent: step.agent,
    requestSummary: status.pause.summary,
    ...(parallel ? { index } : {}),
  });
}

function statusSyntheticArtifact(
  input: AwaitedRunOwnerOptions,
  status: AsyncStatus | null,
  state: AsyncStatus["state"],
  cleanup?: ChildProcessCleanupResult,
  failureMessage?: string,
): AwaitedArtifact {
  const statusValue = statusRecord(status);
  // A persisted child timeout belongs to that role, not to the awaited run.
  // Keep it on the synthetic child result without promoting it to the
  // top-level artifact timeout marker, which is reserved for maxRunTimeMs.

  const steps = status?.steps?.length
    ? status.steps.map((step, index) => {
        const completed = isCompletedLifecycleStepState(step.status);
        return {
          agent: step.agent,
          output:
            state === "paused"
              ? pausedSyntheticOutput(input, status, step, index)
              : step.recentOutput?.join("\n") ||
                step.error ||
                (state === "cancelled"
                  ? "Cancelled by parent abort."
                  : (failureMessage ?? status?.error ?? "(no output)")),
          error: step.error ?? (state === "failed" ? failureMessage : undefined),
          success: completed,
          exitCode: completed ? 0 : 1,
          interrupted: state === "paused",
          timedOut: step.timedOut,
          terminationReason:
            state === "cancelled"
              ? completed
                ? "completed"
                : "cancelled"
              : step.timedOut
                ? "timed_out"
                : (parseSubagentTerminationReason(step.terminationReason) ??
                  terminationReasonForLifecycleState(step.status)),
          sessionFile: step.sessionFile,
          skills: step.skills,
          skillsWarning: step.skillsWarning,
          artifactPaths: undefined,
          tokens: step.tokens,
          totalCost: step.totalCost,
          ...(state === "paused" ? { pause: status?.pause } : {}),
          ...(state === "cancelled"
            ? {
                cancel: status?.cancel ?? {
                  summary: "Cancelled by parent abort.",
                  cancelledAt: Date.now(),
                },
                ...(cleanup ? { processCleanup: cloneCleanup(cleanup) } : {}),
              }
            : {}),
        };
      })
    : [
        {
          agent: agentForIndex(input.plan, 0),
          output:
            state === "cancelled"
              ? "Cancelled by parent abort."
              : (failureMessage ??
                status?.error ??
                (state === "paused" ? "Paused after interrupt." : "(no output)")),
          error:
            state === "failed" || state === "cancelled"
              ? (status?.error ?? failureMessage)
              : undefined,
          success: isCompletedLifecycleState(state),
          exitCode: isCompletedLifecycleState(state) ? 0 : 1,
          interrupted: state === "paused",
          terminationReason: terminationReasonForLifecycleState(state),
          ...(status?.steps?.[0]?.tokens ? { tokens: status.steps[0].tokens } : {}),
          ...(status?.steps?.[0]?.totalCost ? { totalCost: status.steps[0].totalCost } : {}),
          ...(status?.steps?.[0]?.skills ? { skills: status.steps[0].skills } : {}),
          ...(status?.steps?.[0]?.skillsWarning
            ? { skillsWarning: status.steps[0].skillsWarning }
            : {}),
          ...(state === "paused" ? { pause: status?.pause } : {}),
          ...(state === "cancelled"
            ? {
                cancel: status?.cancel ?? {
                  summary: "Cancelled by parent abort.",
                  cancelledAt: Date.now(),
                },
                ...(cleanup ? { processCleanup: cloneCleanup(cleanup) } : {}),
              }
            : {}),
        },
      ];
  const planStepCount = input.plan.kind === "parallel" ? input.plan.tasks.length : 1;
  const missingSteps = Array.from(
    { length: Math.max(0, planStepCount - steps.length) },
    (_, offset) => {
      const index = steps.length + offset;
      const timedOut = failureMessage === OWNER_TIMEOUT_MESSAGE || status?.timedOut === true;
      const terminationReason =
        state === "cancelled"
          ? "cancelled"
          : timedOut
            ? "timed_out"
            : terminationReasonForLifecycleState(state);
      return {
        agent: agentForIndex(input.plan, index),
        output:
          state === "cancelled"
            ? "Cancelled by parent abort."
            : (failureMessage ??
              status?.error ??
              (state === "paused" ? "Paused after interrupt." : "(no output)")),
        error:
          state === "failed" || state === "cancelled"
            ? (failureMessage ?? status?.error)
            : undefined,
        success: isCompletedLifecycleState(state),
        exitCode: isCompletedLifecycleState(state) ? 0 : 1,
        interrupted: state === "paused",
        ...(timedOut ? { timedOut: true } : {}),
        ...(status?.steps?.[index]?.skills ? { skills: status.steps[index].skills } : {}),
        ...(status?.steps?.[index]?.skillsWarning
          ? { skillsWarning: status.steps[index].skillsWarning }
          : {}),
        terminationReason,
        ...(state === "paused" ? { pause: status?.pause } : {}),
        ...(state === "cancelled"
          ? {
              cancel: status?.cancel ?? {
                summary: "Cancelled by parent abort.",
                cancelledAt: Date.now(),
              },
            }
          : {}),
        ...(cleanup ? { processCleanup: cloneCleanup(cleanup) } : {}),
      };
    },
  );
  const projectedSteps = [...steps, ...missingSteps];
  const summary =
    state === "cancelled"
      ? (status?.cancel?.summary ?? "Cancelled by parent abort.")
      : (failureMessage ??
        status?.error ??
        (state === "paused" ? "Paused after interrupt. Waiting for explicit next action." : ""));
  return {
    ...statusValue,
    id: input.id,
    state,
    mode: input.mode,
    agent: projectedSteps[0]?.agent ?? agentForIndex(input.plan, 0),
    success: isCompletedLifecycleState(state),
    summary,
    ...(state === "failed" || state === "cancelled" ? { error: status?.error ?? summary } : {}),
    results: projectedSteps,
    asyncDir: input.asyncDir,
    sessionId: input.sessionId,
    ...(cleanup ? { processCleanup: cloneCleanup(cleanup) } : {}),
    generation: status ? lifecycleGeneration(status) : (input.expectedGeneration ?? 0),
    timestamp: status?.endedAt ?? Date.now(),
    durationMs: status?.startedAt
      ? Math.max(0, (status.endedAt ?? Date.now()) - status.startedAt)
      : 0,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  };
}

function childProcessCleanup(value: unknown): ChildProcessCleanupResult | undefined {
  return normalizeChildProcessCleanup(value);
}

function resultFromRawChild(
  input: AwaitedRunOwnerOptions,
  artifact: AwaitedArtifact,
  child: RecordValue,
  index: number,
  ownerCleanup: ChildProcessCleanupResult | undefined,
  persistedSteps?: unknown[],
): SingleResult {
  const childState = resultStatusForChild(child, artifact.state);
  const rawChildState = terminalState(child.state);
  const childCompleted =
    child.success === true || rawChildState === "complete" || child.state === "completed";
  const childCancelled = artifact.state === "cancelled" && !childCompleted;
  const task = taskForIndex(input.plan, index);
  const plannedStep = planStepForIndex(input.plan, index);
  const agent = nonEmptyString(child.agent) ?? agentForIndex(input.plan, index);
  const statusStep = isRecord(persistedSteps?.[index]) ? persistedSteps[index] : undefined;
  const pause = (child.pause ?? artifact.pause ?? statusStep?.pause) as SingleResult["pause"];
  const output =
    pause?.kind === "awaiting_supervisor"
      ? formatSupervisorPauseMessage({
          headline: `Async run ${input.id} paused awaiting supervisor (${agent}).`,
          runId: input.id,
          agent,
          requestSummary: pause.summary,
          ...(input.plan.kind === "parallel" && input.plan.tasks.length > 1 ? { index } : {}),
        })
      : typeof child.output === "string"
        ? child.output
        : typeof child.summary === "string"
          ? child.summary
          : typeof artifact.summary === "string"
            ? artifact.summary
            : "(no output)";
  const error = typeof child.error === "string" ? child.error : undefined;
  const cancelled = artifact.state === "cancelled";
  const paused = artifact.state === "paused" || (!cancelled && childState === "paused");
  const childCleanup = childProcessCleanup(child.processCleanup);
  const artifactCleanup = childProcessCleanup(artifact.processCleanup);
  const processCleanup = ownerCleanup ?? childCleanup ?? artifactCleanup;
  const terminationReason = childCancelled
    ? "cancelled"
    : (parseSubagentTerminationReason(child.terminationReason) ??
      terminationReasonForLifecycleState(child.state ?? artifact.state));
  const persistedChildTicketId = persistedTicketId(child.ticketId);
  const childResult: SingleResult = {
    agent,
    task,
    projectAgent: (child.projectAgent ?? plannedStep?.projectAgent) as SingleResult["projectAgent"],
    exitCode: childCancelled
      ? 1
      : typeof child.exitCode === "number"
        ? child.exitCode
        : childState === "completed"
          ? 0
          : 1,
    exitSignal: child.exitSignal as SingleResult["exitSignal"],
    ...(paused ? { interrupted: true } : {}),
    ...(childCancelled
      ? { cancel: (child.cancel ?? artifact.cancel) as SingleResult["cancel"] }
      : {}),
    ...(child.timedOut === true ? { timedOut: true } : {}),
    contextUsage: child.contextUsage as SingleResult["contextUsage"],
    contextPressure: child.contextPressure as SingleResult["contextPressure"],
    contextPressureCrossedThresholds:
      child.contextPressureCrossedThresholds as SingleResult["contextPressureCrossedThresholds"],
    ...(terminationReason ? { terminationReason } : {}),
    usage: usageFromChild(artifact, child, index, persistedSteps),
    model: child.model as string | undefined,
    modelIdentity: child.modelIdentity as SingleResult["modelIdentity"],
    modelResolution: child.modelResolution as SingleResult["modelResolution"],
    attemptedModels: child.attemptedModels as string[] | undefined,
    modelAttempts: child.modelAttempts as SingleResult["modelAttempts"],
    modelFallbackNotice: child.modelFallbackNotice as string | undefined,
    error:
      childCancelled && !error
        ? (nonEmptyString((artifact.cancel as RecordValue | undefined)?.summary) ??
          "Cancelled by parent abort.")
        : error,
    stderr: child.stderr as string | undefined,
    stderrTruncated: child.stderrTruncated as boolean | undefined,
    protocolOutputLimit: child.protocolOutputLimit as SingleResult["protocolOutputLimit"],
    sessionFile: (child.sessionFile ?? plannedStep?.sessionFile) as string | undefined,
    skills: Array.isArray(child.skills) ? (child.skills as string[]) : plannedStep?.skills,
    skillsWarning:
      (typeof child.skillsWarning === "string" ? child.skillsWarning : undefined) ??
      plannedStep?.skillsWarning,
    outputMode: (child.outputMode ?? plannedStep?.outputMode) as SingleResult["outputMode"],
    savedOutputPath: child.savedOutputPath as string | undefined,
    outputReference: child.outputReference as SingleResult["outputReference"],
    outputSaveError: child.outputSaveError as string | undefined,
    childLocation: (child.childLocation ??
      plannedStep?.childLocation) as SingleResult["childLocation"],
    artifactPaths: artifactPaths(child.artifactPaths),
    processCleanup,
    ...(child.truncated === true ? { truncation: { text: output, truncated: true } } : {}),
    transcriptPath: child.transcriptPath as string | undefined,
    transcriptError: child.transcriptError as string | undefined,
    terminalResult: parseSubagentTerminalResult(child.terminalResult) as
      | SubagentTerminalResult
      | undefined,
    pause: paused ? ((child.pause ?? artifact.pause) as SingleResult["pause"]) : undefined,
    ...(persistedChildTicketId ? { ticketId: persistedChildTicketId } : {}),
    finalOutput:
      pause?.kind === "awaiting_supervisor"
        ? output
        : child.outputMode === "file-only" && typeof child.savedOutputPath === "string"
          ? output
          : typeof child.finalOutput === "string"
            ? child.finalOutput
            : output,
    ...(Array.isArray(child.children) ? { children: nestedChildren(child.children) } : {}),
  };
  return childResult;
}

function resultChildrenForFormatting(
  input: AwaitedRunOwnerOptions,
  artifact: AwaitedArtifact,
  results: SingleResult[],
): ReturnType<typeof attachNestedChildrenToResultChildren> {
  const rootNested = nestedChildren(artifact.nestedChildren);
  const children = results.map((result, index) => ({
    agent: result.agent,
    status: resolveSubagentResultStatus({
      exitCode: result.exitCode,
      interrupted: result.interrupted,
      success: result.exitCode === 0,
    }),
    summary: resultSummaryForNativeAwaited(result),
    index,
    artifactPath: result.artifactPaths?.outputPath,
    sessionPath: result.sessionFile,
    terminalResult: result.terminalResult,
    children: result.children,
  }));
  return attachNestedChildrenToResultChildren(input.id, children, rootNested);
}

function buildAwaitedResult(
  input: AwaitedRunOwnerOptions,
  artifact: AwaitedArtifact,
  ownerCleanup?: ChildProcessCleanupResult,
): AwaitedRunResult {
  const rawResultChildren = rawChildren(artifact);
  const expectedChildCount = input.plan.kind === "parallel" ? input.plan.tasks.length : 1;
  while (rawResultChildren.length < expectedChildCount) {
    const timedOut = artifact.timedOut === true;
    rawResultChildren.push({
      agent: agentForIndex(input.plan, rawResultChildren.length),
      state: artifact.state,
      success: isCompletedLifecycleState(artifact.state),
      output:
        artifact.state === "cancelled"
          ? "Cancelled by parent abort."
          : timedOut
            ? OWNER_TIMEOUT_MESSAGE
            : typeof artifact.summary === "string"
              ? artifact.summary
              : "(no output)",
      error:
        artifact.state === "failed" || artifact.state === "cancelled" ? artifact.error : undefined,
      exitCode: isCompletedLifecycleState(artifact.state) ? 0 : 1,
      timedOut,
      terminationReason:
        artifact.state === "cancelled"
          ? "cancelled"
          : timedOut
            ? "timed_out"
            : terminationReasonForLifecycleState(artifact.state),
      ...(artifact.cancel ? { cancel: artifact.cancel } : {}),
    });
  }
  const artifactCleanup = childProcessCleanup(artifact.processCleanup);
  const effectiveCleanup = ownerCleanup ?? artifactCleanup;
  let persistedSteps: unknown[] | undefined;
  try {
    persistedSteps = readStatus(input.asyncDir)?.steps;
  } catch {
    persistedSteps = undefined;
  }
  const results = rawResultChildren.map((child, index) =>
    resultFromRawChild(input, artifact, child, index, effectiveCleanup, persistedSteps),
  );
  if (artifact.truncated === true && typeof artifact.summary === "string" && results.length === 1) {
    results[0] = {
      ...results[0],
      truncation: { text: artifact.summary, truncated: true },
    };
  }
  const rootNested = nestedChildren(artifact.nestedChildren);
  const resultWithNested = resultChildrenForFormatting(input, artifact, results);
  const details: Details = {
    mode: input.mode,
    runId: input.id,
    results: results.map((result, index) => ({
      ...result,
      ...(resultWithNested[index]?.children ? { children: resultWithNested[index].children } : {}),
    })),
    asyncId: input.id,
    asyncDir: input.asyncDir,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    ...(artifact.timedOut === true ? { timedOut: true } : {}),
    ...(artifact.totalCost && isRecord(artifact.totalCost)
      ? { totalCost: artifact.totalCost as Details["totalCost"] }
      : {}),
    ...(artifact.totalTokens ? { totalChildUsage: usageFromArtifact(artifact) } : {}),
    totalSteps: results.length,
  };
  // The native result envelope has no `cancelled` status; retain its existing
  // failed rendering while the detailed result keeps terminationReason/cancel
  // metadata and the persisted lifecycle remains explicitly `cancelled`.
  const statusOverride: SubagentResultStatus = isCompletedLifecycleState(artifact.state)
    ? "completed"
    : artifact.state === "paused"
      ? "paused"
      : "failed";
  const errorSummary =
    artifact.state === "failed" || artifact.state === "cancelled"
      ? typeof artifact.error === "string"
        ? artifact.error
        : artifact.state === "cancelled"
          ? "Cancelled by parent abort."
          : typeof artifact.summary === "string"
            ? artifact.summary
            : undefined
      : undefined;
  const native = buildAwaitedNativeResult({
    runId: input.id,
    mode: input.mode,
    details,
    ...(rootNested?.length ? { nestedChildren: rootNested } : {}),
    statusOverride,
    ...(errorSummary ? { errorSummary } : {}),
  });
  const cleanupText = cleanupSummary(effectiveCleanup);
  const baseText =
    native?.text ?? (typeof artifact.summary === "string" ? artifact.summary : "(no output)");
  const text = cleanupText ? `${baseText}\n\n${cleanupText}` : baseText;
  return {
    content: [{ type: "text", text }],
    details,
    ...(artifact.state === "failed" || artifact.state === "cancelled" ? { isError: true } : {}),
  };
}

function minimalFailedResult(input: AwaitedRunOwnerOptions, message: string): AwaitedRunResult {
  const text = boundedDiagnostic(message.trim() || "Awaited async run failed before completion.");
  const details: Details = {
    mode: input.mode,
    runId: input.id,
    results: [],
    asyncId: input.id,
    asyncDir: input.asyncDir,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  };
  return {
    content: [{ type: "text", text }],
    details,
    isError: true,
  };
}

function safeStatusSyntheticArtifact(
  input: AwaitedRunOwnerOptions,
  status: AsyncStatus | null,
  state: AsyncStatus["state"],
  cleanup?: ChildProcessCleanupResult,
  failureMessage?: string,
): AwaitedArtifact {
  try {
    return statusSyntheticArtifact(input, status, state, cleanup, failureMessage);
  } catch {
    const summary =
      failureMessage ??
      (state === "cancelled"
        ? "Cancelled by parent abort."
        : state === "paused"
          ? "Paused after interrupt."
          : isCompletedLifecycleState(state)
            ? "(no output)"
            : "Awaited async run failed before completion.");
    return {
      id: input.id,
      state,
      mode: input.mode,
      agent: "unknown",
      success: isCompletedLifecycleState(state),
      summary,
      ...(state === "failed" || state === "cancelled" ? { error: summary } : {}),
      results: [],
      asyncDir: input.asyncDir,
      sessionId: input.sessionId,
      generation: input.expectedGeneration ?? 0,
      timestamp: Date.now(),
      durationMs: 0,
      ...(cleanup ? { processCleanup: cloneCleanup(cleanup) } : {}),
    };
  }
}

function timedOutArtifact(candidate: AwaitedArtifact): AwaitedArtifact {
  const results = Array.isArray(candidate.results)
    ? candidate.results.filter(isRecord).map((child) => {
        const childState = terminalState(child.state);
        const completed =
          child.success === true || childState === "complete" || child.state === "completed";
        return completed
          ? child
          : {
              ...child,
              success: false,
              timedOut: true,
              exitCode: typeof child.exitCode === "number" ? child.exitCode : 1,
              terminationReason: "timed_out",
              error: typeof child.error === "string" ? child.error : OWNER_TIMEOUT_MESSAGE,
            };
      })
    : undefined;
  return {
    ...candidate,
    state: "failed",
    success: false,
    timedOut: true,
    summary: OWNER_TIMEOUT_MESSAGE,
    error: OWNER_TIMEOUT_MESSAGE,
    ...(results && results.length > 0 ? { results } : {}),
  };
}

function readArtifact(
  resultPath: string,
  fsApi: Pick<ResultArtifactFs, "readFileSync"> = fs,
): RecordValue | undefined {
  try {
    const parsed: unknown = JSON.parse(fsApi.readFileSync(resultPath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createAwaitedRunOwner(input: AwaitedRunOwnerOptions): AwaitedRunOwner {
  const expectedGeneration = input.expectedGeneration ?? 0;
  const now = input.now ?? Date.now;
  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const artifactGraceMs = Math.max(0, input.artifactGraceMs ?? DEFAULT_ARTIFACT_GRACE_MS);
  const cleanupGraceMs = Math.max(0, input.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS);
  const cleanupMaxWaitMs = Math.max(0, input.cleanupMaxWaitMs ?? PROCESS_GROUP_CLEANUP_MAX_WAIT_MS);
  const artifactFs = input.fs ?? fs;
  const pidLiveness = input.pidLiveness ?? ((pid: number): PidLiveness => checkPidLiveness(pid));
  const setPollInterval = input.setInterval ?? setInterval;
  const clearPollInterval = input.clearInterval ?? clearInterval;
  const usesInjectedCleanup = input.cleanup !== undefined;
  const cleanup =
    input.cleanup ??
    ((processGroupId: number, owner?: OwnedProcessGroupOwner) =>
      cleanupOwnedProcessGroup(processGroupId, { owner }));
  let processId: number | undefined;
  let processOwner: OwnedProcessGroupOwner | undefined;
  let settled = false;
  let abortStarted = false;
  let timeoutStarted = false;
  let abortStartedAt: number | undefined;
  let terminalObservedAt: number | undefined;
  let observedGeneration: number | undefined = input.expectedGeneration;
  let pendingAbortArtifact: AwaitedArtifact | undefined;
  let ownerCleanup: ChildProcessCleanupResult | undefined;
  let cleanupPromise: Promise<ChildProcessCleanupResult> | undefined;
  let runnerGoneAt: number | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let hardDeadlineAt: number | undefined;
  let lateArtifactSinkTimer: ReturnType<typeof setTimeout> | undefined;
  let artifactClaimCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let artifactClaimCleanupMode: "release" | "commit" | undefined;
  let artifactClaimCleanupAttempts = 0;
  let artifactClaimCleanupDiagnosticReported = false;
  let lastProgressSignature: string | undefined;
  let removeAbortListener: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resolvePromise!: (result: AwaitedRunResult) => void;
  const awaitedPromise = new Promise<AwaitedRunResult>((resolve) => {
    resolvePromise = resolve;
  });

  const handleCompletion = (data: unknown): boolean => {
    if (settled) return true;
    if (!isRecord(data)) return false;
    try {
      const candidate = correlatedArtifact(data);
      if (!candidate || !TERMINAL_STATES.has(candidate.state)) {
        if (isMalformedOwnerCompletion(data)) {
          settleFailure(OWNER_MALFORMED_COMPLETION_MESSAGE);
          return true;
        }
        return false;
      }
      if (abortStarted) {
        pendingAbortArtifact = candidate;
        return true;
      }
      settle(candidate, ownerCleanup);
      return true;
    } catch (error) {
      settleFailure(
        `Awaited run completion could not be projected: ${boundedDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      return true;
    }
  };
  // Register before spawn; the watcher may win the artifact claim.
  let registrationToken = registerAwaitedRun(
    input.id,
    handleCompletion,
    expectedGeneration,
    dispose,
    guard,
    retire,
  );
  const unsubscribe = input.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
    if (!ownsRegistration()) return;
    handleCompletion(data);
  });

  function currentStatus(): AsyncStatus | null {
    try {
      // Lifecycle decisions must observe the bounded status boundary rather
      // than parsing status.json independently. Bypass the cache because an
      // awaited owner races the detached runner and CAS control writers.
      return readStatus(input.asyncDir, { cache: false });
    } catch {
      return null;
    }
  }

  function persistedGeneration(): number | undefined {
    const status = currentStatus();
    return status ? lifecycleGeneration(status) : undefined;
  }

  function runnerLiveness(status: AsyncStatus | null): PidLiveness {
    const pid = processId ?? status?.pid;
    if (pid === undefined) return "dead";
    try {
      return pidLiveness(pid);
    } catch {
      return "unknown";
    }
  }

  function finalizedStatus(status: AsyncStatus | null): boolean {
    if (!isTerminalStatus(status)) return false;
    if (finiteNumber(status.endedAt) === undefined) return false;
    const persisted = persistedGeneration();
    const statusGeneration = lifecycleGeneration(status);
    if (persisted === undefined || persisted < expectedGeneration || persisted !== statusGeneration)
      return false;
    // The runner writes the terminal status before the result artifact. Do not
    // synthesize from that intermediate write while the runner still owns its
    // process group; an artifact or a dead runner is the finalization proof.
    return runnerLiveness(status) === "dead";
  }

  function explicitGeneration(candidate: RecordValue): number | undefined {
    const direct = nonNegativeInteger(candidate.generation);
    if (direct !== undefined) return direct;
    if (isRecord(candidate.lifecycle)) {
      const lifecycle = nonNegativeInteger(candidate.lifecycle.generation);
      if (lifecycle !== undefined) return lifecycle;
    }
    return undefined;
  }

  function matchesOwnerIdentity(candidate: RecordValue): boolean {
    const candidateId = candidate.id ?? candidate.runId;
    return (
      candidateId === input.id &&
      (candidate.runId === undefined || candidate.runId === input.id) &&
      (candidate.id === undefined || candidate.id === input.id) &&
      (candidate.asyncDir === undefined || candidate.asyncDir === input.asyncDir) &&
      (input.sessionId === undefined ||
        input.sessionId === null ||
        candidate.sessionId === undefined ||
        candidate.sessionId === input.sessionId)
    );
  }

  function matchesOwnerGeneration(candidate: RecordValue): boolean {
    const generation = explicitGeneration(candidate);
    if (generation === undefined || generation < expectedGeneration) return false;
    if (observedGeneration !== undefined && generation < observedGeneration) return false;
    const status = currentStatus();
    const currentGeneration = status ? lifecycleGeneration(status) : undefined;
    if (currentGeneration === undefined) return generation === expectedGeneration;
    return (
      generation === currentGeneration &&
      (generation === expectedGeneration || Boolean(status && TERMINAL_STATES.has(status.state)))
    );
  }

  function isMalformedOwnerCompletion(candidate: RecordValue): boolean {
    return matchesOwnerIdentity(candidate) && matchesOwnerGeneration(candidate);
  }

  function correlatedArtifact(candidate: RecordValue): AwaitedArtifact | undefined {
    const candidateId = candidate.id ?? candidate.runId;
    if (candidateId !== input.id) return undefined;
    if (candidate.runId !== undefined && candidate.runId !== input.id) return undefined;
    if (candidate.id !== undefined && candidate.id !== input.id) return undefined;
    if (candidate.asyncDir !== undefined && candidate.asyncDir !== input.asyncDir) return undefined;
    if (
      input.sessionId !== undefined &&
      input.sessionId !== null &&
      candidate.sessionId !== undefined &&
      candidate.sessionId !== input.sessionId
    )
      return undefined;
    const generation = explicitGeneration(candidate);
    if (generation === undefined) return undefined;
    const status = currentStatus();
    const currentGeneration = status ? lifecycleGeneration(status) : undefined;
    // The event/artifact and the persisted lifecycle must describe the same
    // generation. A resumed source run may leave a stale artifact behind; it
    // must never wake the owner that subscribed for the earlier generation.
    if (observedGeneration !== undefined && generation < observedGeneration) return undefined;
    if (currentGeneration !== undefined && generation !== currentGeneration) return undefined;
    if (generation < expectedGeneration) return undefined;
    if (generation !== expectedGeneration && (!status || !TERMINAL_STATES.has(status.state))) {
      return undefined;
    }
    if (currentGeneration !== undefined && currentGeneration > (observedGeneration ?? -1)) {
      observedGeneration = currentGeneration;
    }
    const state = terminalState(candidate.state);
    if (!state) return undefined;
    return {
      ...candidate,
      id: input.id,
      state,
      asyncDir: input.asyncDir,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      generation,
    };
  }

  function guard(candidate: unknown): boolean {
    if (!isRecord(candidate) || !matchesOwnerIdentity(candidate)) return false;
    return correlatedArtifact(candidate) !== undefined || isMalformedOwnerCompletion(candidate);
  }

  function ownsRegistration(): boolean {
    return isAwaitedRunOwner(input.id, registrationToken);
  }

  /** Keep a bounded silent sink for a late artifact after synthetic settlement. */
  function isCorrelatedLateArtifact(candidate: unknown): boolean {
    if (!isRecord(candidate) || !matchesOwnerIdentity(candidate)) return false;
    return explicitGeneration(candidate) !== undefined && matchesOwnerGeneration(candidate);
  }

  function emitProgress(status: AsyncStatus): void {
    if (
      !input.onUpdate ||
      (status.state !== "running" && status.state !== "pausing" && status.state !== "paused")
    )
      return;
    let signature: string;
    try {
      signature = JSON.stringify(status);
    } catch {
      signature = `${status.state}:${status.lastUpdate ?? ""}`;
    }
    if (signature === lastProgressSignature) return;
    lastProgressSignature = signature;
    try {
      input.onUpdate(buildAwaitedProgressUpdate(input, status, now));
    } catch {
      // Progress is advisory; a host update/render failure must not prevent the
      // awaited owner from consuming the terminal artifact.
    }
  }

  function stopLateArtifactSink(): void {
    if (lateArtifactSinkTimer) clearTimeout(lateArtifactSinkTimer);
    lateArtifactSinkTimer = undefined;
  }

  function stopArtifactClaimCleanup(): void {
    if (artifactClaimCleanupTimer) clearTimeout(artifactClaimCleanupTimer);
    artifactClaimCleanupTimer = undefined;
  }

  function retireLateSink(): void {
    stopLateArtifactSink();
    stopArtifactClaimCleanup();
  }

  function retire(): void {
    if (settled) return;
    settled = true;
    stopPolling();
    stopDeadlineTimer();
    retireLateSink();
    try {
      unsubscribe();
    } catch {}
    try {
      removeAbortListener?.();
    } catch {}
    removeAbortListener = undefined;
    if (processId !== undefined) void cleanupSpawnedProcess();
    resolvePromise(minimalFailedResult(input, "Awaited run owner was superseded."));
  }

  function unregisterAwaitedOwner(): void {
    stopLateArtifactSink();
    try {
      unregisterAwaitedRun(input.id, expectedGeneration, registrationToken);
    } catch {
      // Registry cleanup is best effort after the promise has settled.
    }
  }

  function retainLateArtifactSink(): void {
    stopLateArtifactSink();
    const lateArtifactSinkToken = registerAwaitedRun(
      input.id,
      (candidate) => isCorrelatedLateArtifact(candidate),
      expectedGeneration,
      undefined,
      isCorrelatedLateArtifact,
      retireLateSink,
    );
    registrationToken = lateArtifactSinkToken;
    const retentionMs = Math.max(pollIntervalMs, cleanupGraceMs + artifactGraceMs);
    lateArtifactSinkTimer = setTimeout(
      () => {
        lateArtifactSinkTimer = undefined;
        try {
          unregisterAwaitedRun(input.id, expectedGeneration, lateArtifactSinkToken);
        } catch {
          // Registry cleanup is best effort after the bounded retention window.
        }
      },
      Math.min(retentionMs, 2_147_483_647),
    );
    lateArtifactSinkTimer.unref?.();
  }

  function abandonIfRunnerGone(status: AsyncStatus | null): boolean {
    if (settled || abortStarted) return false;
    if (runnerLiveness(status) !== "dead") {
      runnerGoneAt = undefined;
      return false;
    }
    const observedAt = (runnerGoneAt ??= now());
    if (now() - observedAt < cleanupGraceMs) return false;
    const supervisorPausePending = isPendingSupervisorPause(status);
    const state: AsyncStatus["state"] = supervisorPausePending
      ? "paused"
      : status?.state === "cancelled"
        ? "cancelled"
        : "failed";
    const timedOut =
      !supervisorPausePending &&
      (status?.timedOut === true || (input.deadlineAt !== undefined && now() >= input.deadlineAt));
    const message = timedOut ? OWNER_TIMEOUT_MESSAGE : "Async runner exited before finalization.";
    const synthetic = safeStatusSyntheticArtifact(
      input,
      status,
      state,
      ownerCleanup,
      state === "failed" ? message : undefined,
    );
    settle(timedOut ? timedOutArtifact(synthetic) : synthetic, ownerCleanup, { synthetic: true });
    return true;
  }

  function unlinkArtifact(): boolean {
    try {
      artifactFs.unlinkSync(input.resultPath);
      return true;
    } catch (error) {
      // The watcher may have removed it after a released claim; settlement is
      // already in memory and does not depend on deletion succeeding. A live
      // claim consumer handles any remaining artifact/sidecar cleanup.
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return true;
      return false;
    }
  }

  function reportArtifactClaimCleanupExhausted(
    claim: ResultArtifactClaim,
    mode: "release" | "commit",
    error?: unknown,
  ): void {
    if (artifactClaimCleanupDiagnosticReported) return;
    artifactClaimCleanupDiagnosticReported = true;
    const operation = mode === "commit" ? "complete" : "release";
    console.error(
      `Could not ${operation} awaited result artifact cleanup for '${claim.path}' after ${RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS} attempts; retained the claim sidecar for manual recovery.`,
      ...(error === undefined ? [] : [error]),
    );
  }

  function scheduleArtifactClaimCleanup(
    claim: ResultArtifactClaim,
    mode: "release" | "commit" = "commit",
    attempts = 0,
  ): void {
    if (!ownsRegistration()) return;
    if (artifactClaimCleanupTimer || artifactClaimCleanupDiagnosticReported) {
      if (artifactClaimCleanupTimer && mode === "commit") artifactClaimCleanupMode = "commit";
      return;
    }
    artifactClaimCleanupMode = mode;
    artifactClaimCleanupAttempts = attempts;
    artifactClaimCleanupTimer = setTimeout(() => {
      artifactClaimCleanupTimer = undefined;
      if (!ownsRegistration()) return;
      const cleanupMode = artifactClaimCleanupMode ?? mode;
      artifactClaimCleanupMode = undefined;
      const cleanupAttempts = artifactClaimCleanupAttempts + 1;
      try {
        if (cleanupMode === "commit" && artifactFs.existsSync(input.resultPath))
          artifactFs.unlinkSync(input.resultPath);
        const cleaned = cleanupMode === "commit" ? claim.commit() : claim.release();
        if (cleaned) return;
        if (cleanupAttempts >= RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS) {
          reportArtifactClaimCleanupExhausted(claim, cleanupMode);
          return;
        }
        scheduleArtifactClaimCleanup(claim, "commit", cleanupAttempts);
      } catch (error) {
        if (cleanupAttempts >= RESULT_ARTIFACT_CLAIM_CLEANUP_MAX_ATTEMPTS) {
          reportArtifactClaimCleanupExhausted(claim, cleanupMode, error);
          return;
        }
        scheduleArtifactClaimCleanup(claim, cleanupMode, cleanupAttempts);
      }
    }, resultArtifactClaimCleanupDelayMs(attempts));
    artifactClaimCleanupTimer.unref?.();
  }

  function stopPolling(): void {
    if (pollTimer) clearPollInterval(pollTimer);
    pollTimer = undefined;
  }

  function stopDeadlineTimer(): void {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
    if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
    hardDeadlineTimer = undefined;
    hardDeadlineAt = undefined;
  }

  function settleFailure(message: string): void {
    if (settled) return;
    const synthetic = safeStatusSyntheticArtifact(
      input,
      currentStatus(),
      "failed",
      ownerCleanup,
      boundedDiagnostic(message),
    );
    settle(synthetic, ownerCleanup, { synthetic: true });
  }

  function settle(
    candidate: AwaitedArtifact,
    cleanupResult?: ChildProcessCleanupResult,
    options: { synthetic?: boolean } = {},
  ): void {
    if (settled) return;
    settled = true;
    stopPolling();
    stopDeadlineTimer();
    try {
      unsubscribe();
    } catch {}
    try {
      removeAbortListener?.();
    } catch {}
    removeAbortListener = undefined;
    if (candidate.state === "cancelled" && cleanupResult) {
      candidate = {
        ...candidate,
        cancel: candidate.cancel ?? {
          summary: "Cancelled by parent abort.",
          cancelledAt: now(),
        },
      };
    }
    let result: AwaitedRunResult;
    try {
      result = buildAwaitedResult(input, candidate, cleanupResult);
    } catch (error) {
      result = minimalFailedResult(
        input,
        `Awaited run result could not be projected: ${boundedDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
    }
    // Owner completion is private; re-emitting the public event would wake the parent twice.
    try {
      input.events.emit(SUBAGENT_ASYNC_OWNER_COMPLETE_EVENT, {
        id: input.id,
        runId: input.id,
        ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
        state: candidate.state,
      });
    } catch {
      // A host lifecycle listener must not prevent the awaited result settling.
    }
    unlinkArtifact();
    if (options.synthetic === true && cleanupResult?.terminated !== true) {
      retainLateArtifactSink();
    } else {
      // Retain the marker for consumers that observe the run after settlement.
      queueMicrotask(unregisterAwaitedOwner);
    }
    resolvePromise(result);
  }

  function consumeArtifact(): boolean {
    if (!ownsRegistration()) return false;
    let claim: ResultArtifactClaim | undefined;
    try {
      claim = claimResultArtifact(input.resultPath, artifactFs);
    } catch (error) {
      console.error(
        `Failed to claim awaited result artifact '${input.resultPath}'; will retry while polling:`,
        error,
      );
      return false;
    }
    if (!claim) return false;
    let delivered = false;
    try {
      const raw = readArtifact(claim.path, artifactFs);
      const candidate = raw ? correlatedArtifact(raw) : undefined;
      if (!candidate || !TERMINAL_STATES.has(candidate.state)) {
        if (raw && isMalformedOwnerCompletion(raw)) {
          settleFailure(OWNER_MALFORMED_COMPLETION_MESSAGE);
          delivered = true;
          return true;
        }
        return false;
      }
      if (abortStarted) {
        pendingAbortArtifact = candidate;
        return true;
      }
      settle(candidate, ownerCleanup);
      delivered = true;
      return true;
    } finally {
      if (delivered) {
        try {
          if (!claim.commit()) scheduleArtifactClaimCleanup(claim, "commit");
        } catch {
          scheduleArtifactClaimCleanup(claim, "commit");
        }
      } else {
        try {
          claim.release();
        } catch {
          scheduleArtifactClaimCleanup(claim, "release");
        }
      }
    }
  }

  function poll(): void {
    if (settled || !ownsRegistration()) return;
    const status = currentStatus();
    if (status) {
      const generation = lifecycleGeneration(status);
      if (observedGeneration === undefined || generation > observedGeneration)
        observedGeneration = generation;
      emitProgress(status);
    }
    if (consumeArtifact()) return;
    if (abandonIfRunnerGone(status)) return;
    const candidate = statusRecord(status) ? correlatedArtifact(statusRecord(status)!) : undefined;
    if (!candidate || !isTerminalStatus(status)) {
      terminalObservedAt = undefined;
      return;
    }
    if (abortStarted) {
      pendingAbortArtifact = candidate;
      return;
    }
    // Incomplete terminal writes remain eligible for later polling.
    if (!finalizedStatus(status)) {
      terminalObservedAt = undefined;
      return;
    }
    terminalObservedAt ??= now();
    if (now() - terminalObservedAt >= artifactGraceMs) {
      // A finalized terminal status can synthesize a bounded result if the artifact is lost.
      settle(safeStatusSyntheticArtifact(input, status, status.state, ownerCleanup), ownerCleanup, {
        synthetic: true,
      });
    }
  }

  function startPolling(): void {
    if (pollTimer || settled || !ownsRegistration()) return;
    // Keep one referenced poll handle while the awaited promise is pending.
    pollTimer = setPollInterval(poll, pollIntervalMs);
    pollTimer.ref?.();
    poll();
  }

  function armDeadlineTimer(): void {
    if (!ownsRegistration() || deadlineTimer || settled || abortStarted) return;
    if (input.deadlineAt === undefined) return;
    const deadlineAt = finiteNumber(input.deadlineAt);
    if (deadlineAt === undefined) return;
    const current = finiteNumber(now()) ?? Date.now();
    const remaining = deadlineAt - current;
    if (remaining <= 0) {
      void timeout();
      return;
    }
    const delay = Math.min(remaining, 2_147_483_647);
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      if (settled) return;
      const observedNow = finiteNumber(now()) ?? Date.now();
      if (observedNow < deadlineAt) {
        armDeadlineTimer();
        return;
      }
      void timeout();
    }, delay);
    deadlineTimer.unref?.();
  }

  function hardDeadlineCleanupFallback(): ChildProcessCleanupResult {
    const supported = supportsOwnedProcessGroupCleanup(input.platform);
    if (
      processId === undefined ||
      !supported ||
      (!usesInjectedCleanup && processOwner === undefined)
    ) {
      return skipOwnedProcessGroupCleanup(
        supported ? "process_group_unavailable" : "unsupported_platform",
        processId,
        supported,
      );
    }
    return {
      supported: true,
      attempted: true,
      terminated: false,
      liveProcessesDetected: true,
      warnings: [
        "Awaited owner reached its hard deadline before process-group cleanup was confirmed.",
      ],
    };
  }

  function forceHardSettlement(): void {
    if (settled || !ownsRegistration()) return;
    // Bound an abort/timeout path if cleanup remains wedged.
    if (!abortStarted) void timeout();
    if (settled) return;
    const timedOut = timeoutStarted;
    const cleanupResult = ownerCleanup ?? hardDeadlineCleanupFallback();
    ownerCleanup ??= cleanupResult;
    void cleanupSpawnedProcess();
    if (timedOut) {
      persistTimedOutStatus(cleanupResult);
      const synthetic = safeStatusSyntheticArtifact(
        input,
        currentStatus(),
        "failed",
        cleanupResult,
        OWNER_TIMEOUT_MESSAGE,
      );
      settle(timedOutArtifact(synthetic), cleanupResult, { synthetic: true });
    } else {
      persistCancelledStatus(cleanupResult);
      const synthetic = safeStatusSyntheticArtifact(
        input,
        currentStatus(),
        "cancelled",
        cleanupResult,
      );
      settle(synthetic, cleanupResult, { synthetic: true });
    }
  }

  function armHardDeadlineTimer(): void {
    if (settled || !ownsRegistration()) return;
    const deadlineAt = finiteNumber(input.deadlineAt);
    const abortAt = finiteNumber(abortStartedAt);
    const hardAt = computeAwaitedHardDeadlineAt({
      deadlineAt,
      abortStartedAt: abortAt,
      cleanupGraceMs,
      artifactGraceMs,
      cleanupMaxWaitMs,
    });
    if (hardAt === undefined) return;
    if (hardDeadlineTimer && hardDeadlineAt === hardAt) return;
    if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
    hardDeadlineTimer = undefined;
    hardDeadlineAt = hardAt;
    const current = finiteNumber(now()) ?? Date.now();
    const remaining = hardAt - current;
    if (remaining <= 0) {
      hardDeadlineAt = undefined;
      queueMicrotask(forceHardSettlement);
      return;
    }
    hardDeadlineTimer = setTimeout(
      () => {
        hardDeadlineTimer = undefined;
        hardDeadlineAt = undefined;
        if (settled) return;
        const observedNow = finiteNumber(now()) ?? Date.now();
        if (observedNow < hardAt) {
          armHardDeadlineTimer();
          return;
        }
        forceHardSettlement();
      },
      Math.min(remaining, 2_147_483_647),
    );
    hardDeadlineTimer.unref?.();
  }

  async function waitForPostAbortArtifact(cleanupResult: ChildProcessCleanupResult): Promise<void> {
    const waitUntil =
      now() + (cleanupResult.terminated ? artifactGraceMs : cleanupGraceMs + artifactGraceMs);
    while (!settled && ownsRegistration() && now() < waitUntil) {
      if (pendingAbortArtifact) return;
      if (consumeArtifact() || pendingAbortArtifact || settled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  async function cancelInternal(timedOut: boolean): Promise<void> {
    if (settled || abortStarted || !ownsRegistration()) return;
    // Check for a completion already visible before changing its classification
    // to cancellation/timeout. This closes the completion-vs-abort race, but
    // only a finalized lifecycle status can stand in for a missing artifact.
    if (consumeArtifact() || settled) return;
    const status = currentStatus();
    const terminal = statusRecord(status) ? correlatedArtifact(statusRecord(status)!) : undefined;
    if (terminal && finalizedStatus(status)) {
      settle(terminal, undefined, { synthetic: true });
      return;
    }
    if (isPendingSupervisorPause(status)) {
      // Preserve a durable supervisor pause rather than rewriting it as cancellation.
      try {
        requestAsyncInterrupt(input.asyncDir, {
          source: "awaited-run-owner",
          reason: "parent_abort",
        });
      } catch {
        // The runner may already be draining; polling remains authoritative.
      }
      return;
    }
    abortStarted = true;
    if (timedOut) timeoutStarted = true;
    abortStartedAt = finiteNumber(now()) ?? Date.now();
    try {
      if (timedOut) {
        deliverTimeoutRequest({ asyncDir: input.asyncDir, source: "awaited-run-owner" });
      } else {
        requestAsyncInterrupt(input.asyncDir, {
          source: "awaited-run-owner",
          reason: "parent_abort",
        });
      }
    } catch {
      // Cleanup below remains authoritative if the inbox cannot be written.
    }
    const cleanupAttempt = cleanupSpawnedProcess();
    armHardDeadlineTimer();
    ownerCleanup = await cleanupAttempt;
    if (settled || !ownsRegistration()) return;
    if (timedOut) persistTimedOutStatus(ownerCleanup);
    else persistCancelledStatus(ownerCleanup);
    // Hold the awaited call open through the runner's post-cleanup artifact handoff.
    await waitForPostAbortArtifact(ownerCleanup);
    if (settled || !ownsRegistration()) return;
    const latestStatus = currentStatus();
    const latestStatusArtifact = latestStatus
      ? correlatedArtifact(statusRecord(latestStatus)!)
      : undefined;
    const artifact =
      pendingAbortArtifact ??
      (() => {
        const raw = readArtifact(input.resultPath, artifactFs);
        return raw ? correlatedArtifact(raw) : undefined;
      })();

    if (timedOut) {
      const terminalArtifact =
        artifact ??
        (latestStatusArtifact && !isContinuationInFlight(latestStatus)
          ? safeStatusSyntheticArtifact(
              input,
              latestStatus,
              "failed",
              ownerCleanup,
              OWNER_TIMEOUT_MESSAGE,
            )
          : undefined);
      settle(
        timedOutArtifact(
          terminalArtifact ??
            safeStatusSyntheticArtifact(
              input,
              latestStatus,
              "failed",
              ownerCleanup,
              OWNER_TIMEOUT_MESSAGE,
            ),
        ),
        ownerCleanup,
        { synthetic: artifact === undefined },
      );
      return;
    }

    const terminalArtifact =
      latestStatus?.state === "cancelled"
        ? artifact && artifact.state !== "cancelled"
          ? {
              ...artifact,
              state: "cancelled" as const,
              success: false,
              summary: latestStatus.cancel?.summary ?? "Cancelled by parent abort.",
              error: latestStatus.error ?? latestStatus.cancel?.summary,
              cancel: latestStatus.cancel,
              generation: lifecycleGeneration(latestStatus),
            }
          : (artifact ??
            safeStatusSyntheticArtifact(input, latestStatus, "cancelled", ownerCleanup))
        : (artifact ??
          (latestStatusArtifact &&
          !isContinuationInFlight(latestStatus) &&
          finalizedStatus(latestStatus)
            ? safeStatusSyntheticArtifact(
                input,
                latestStatus,
                latestStatusArtifact.state,
                ownerCleanup,
              )
            : undefined));
    const artifactWasUsed = artifact !== undefined && terminalArtifact !== undefined;
    settle(
      terminalArtifact ??
        safeStatusSyntheticArtifact(input, latestStatus, "cancelled", ownerCleanup),
      ownerCleanup,
      { synthetic: !artifactWasUsed },
    );
  }

  async function cancel(): Promise<void> {
    return cancelInternal(false);
  }

  async function timeout(): Promise<void> {
    return cancelInternal(true);
  }

  function persistCancelledStatus(cleanupResult: ChildProcessCleanupResult): void {
    if (!ownsRegistration()) return;
    const status = currentStatus();
    if (
      !status ||
      isCompletedLifecycleState(status.state) ||
      status.state === "failed" ||
      status.state === "cancelled"
    )
      return;
    try {
      transitionLifecycleStatus({
        asyncDir: input.asyncDir,
        expectedGeneration: lifecycleGeneration(status),
        mutate: (current) => {
          const cancelledAt = now();
          const summary = "Cancelled by parent abort.";
          return {
            ...current,
            state: "cancelled",
            pid: undefined,
            pause: undefined,
            activityState: undefined,
            currentTool: undefined,
            currentToolStartedAt: undefined,
            currentPath: undefined,
            cancel: { summary, cancelledAt },
            error: summary,
            endedAt: current.endedAt ?? cancelledAt,
            lastUpdate: cancelledAt,
            processCleanup: cloneCleanup(cleanupResult),
            steps: current.steps?.map((step) =>
              step.status === "complete" || step.status === "failed"
                ? step
                : {
                    ...step,
                    status: "cancelled",
                    pause: undefined,
                    activityState: undefined,
                    currentTool: undefined,
                    currentToolStartedAt: undefined,
                    currentPath: undefined,
                    cancel: { summary, cancelledAt },
                    error: summary,
                    exitCode: 1,
                    terminationReason: "cancelled",
                    endedAt: step.endedAt ?? cancelledAt,
                    durationMs: step.startedAt
                      ? (step.endedAt ?? cancelledAt) - step.startedAt
                      : step.durationMs,
                    processCleanup: cloneCleanup(cleanupResult),
                  },
            ),
          };
        },
      });
    } catch {}
  }

  function persistTimedOutStatus(cleanupResult: ChildProcessCleanupResult): void {
    if (!ownsRegistration()) return;
    const status = currentStatus();
    if (
      !status ||
      isCompletedLifecycleState(status.state) ||
      status.state === "failed" ||
      status.state === "cancelled"
    )
      return;
    try {
      transitionLifecycleStatus({
        asyncDir: input.asyncDir,
        expectedGeneration: lifecycleGeneration(status),
        mutate: (current) => {
          const endedAt = now();
          return {
            ...current,
            state: "failed",
            pid: undefined,
            pause: undefined,
            cancel: undefined,
            activityState: undefined,
            currentTool: undefined,
            currentToolStartedAt: undefined,
            currentPath: undefined,
            timedOut: true,
            error: OWNER_TIMEOUT_MESSAGE,
            endedAt: current.endedAt ?? endedAt,
            lastUpdate: endedAt,
            processCleanup: cloneCleanup(cleanupResult),
            steps: current.steps?.map((step) =>
              isCompletedLifecycleStepState(step.status) ||
              step.status === "failed" ||
              step.status === "cancelled"
                ? step
                : {
                    ...step,
                    status: "failed",
                    pause: undefined,
                    cancel: undefined,
                    activityState: undefined,
                    currentTool: undefined,
                    currentToolStartedAt: undefined,
                    currentPath: undefined,
                    timedOut: true,
                    error: OWNER_TIMEOUT_MESSAGE,
                    exitCode: 1,
                    terminationReason: "timed_out",
                    endedAt: step.endedAt ?? endedAt,
                    durationMs: step.startedAt
                      ? (step.endedAt ?? endedAt) - step.startedAt
                      : step.durationMs,
                    processCleanup: cloneCleanup(cleanupResult),
                  },
            ),
          };
        },
      });
    } catch {}
  }

  function performCleanup(groupId: number): Promise<ChildProcessCleanupResult> {
    return Promise.resolve()
      .then(() => cleanup(groupId, processOwner))
      .catch((error): ChildProcessCleanupResult => ({
        supported: true,
        attempted: true,
        terminated: false,
        processGroupId: groupId,
        warnings: [boundedDiagnostic(error instanceof Error ? error.message : String(error))],
      }));
  }

  function cleanupSpawnedProcess(): Promise<ChildProcessCleanupResult> {
    if (cleanupPromise) return cleanupPromise;
    const supported = supportsOwnedProcessGroupCleanup(input.platform);
    if (
      processId === undefined ||
      !supported ||
      (!usesInjectedCleanup && processOwner === undefined)
    ) {
      cleanupPromise = Promise.resolve(
        skipOwnedProcessGroupCleanup(
          supported ? "process_group_unavailable" : "unsupported_platform",
          processId,
          supported,
        ),
      );
      return cleanupPromise;
    }
    cleanupPromise = performCleanup(processId);
    return cleanupPromise;
  }

  function markSpawned(processIdValue: number, owner?: OwnedProcessGroupOwner): void {
    if (settled || abortStarted || !ownsRegistration()) return;
    processId = processIdValue;
    processOwner = owner?.processGroupId === processIdValue ? owner : undefined;
    if (input.signal?.aborted) {
      void cancel();
      return;
    }
    startPolling();
  }

  function fail(message: string): Promise<AwaitedRunResult> {
    if (!ownsRegistration()) return awaitedPromise;
    if (!settled) {
      const failure = message.trim() || "Async runner failed to start.";
      settle(
        safeStatusSyntheticArtifact(input, currentStatus(), "failed", undefined, failure),
        undefined,
        {
          synthetic: true,
        },
      );
    }
    return awaitedPromise;
  }

  function dispose(): void {
    if (settled) return;
    if (!ownsRegistration()) return;
    if (consumeArtifact() || settled) return;
    const status = currentStatus();
    const terminal = statusRecord(status) ? correlatedArtifact(statusRecord(status)!) : undefined;
    if (terminal && finalizedStatus(status)) {
      settle(terminal, ownerCleanup, { synthetic: true });
      return;
    }

    // Request cleanup, then settle with bounded evidence without waiting for a wedge.
    try {
      requestAsyncInterrupt(input.asyncDir, {
        source: "awaited-run-owner",
        reason: "owner_disposed",
      });
    } catch {}
    if (processId !== undefined && ownerCleanup === undefined) {
      ownerCleanup = hardDeadlineCleanupFallback();
    }
    const cleanupAttempt = cleanupSpawnedProcess();
    void cleanupAttempt.then((result) => {
      ownerCleanup = result;
    });
    settleFailure("Awaited run owner disposed before completion.");
  }

  if (input.signal) {
    if (input.signal.aborted) void cancel();
    else {
      const abortHandler = (): void => void cancel();
      input.signal.addEventListener("abort", abortHandler, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", abortHandler);
    }
  }
  armDeadlineTimer();
  armHardDeadlineTimer();

  return {
    promise: awaitedPromise,
    markSpawned,
    start: markSpawned,
    cancel,
    fail,
    dispose,
  };
}
