import * as fs from "node:fs";
import * as path from "node:path";
import { RESULTS_DIR, type AsyncResultArtifact, type AsyncStatus } from "../../shared/types.ts";
import { readStatus, type AsyncStatusReadOptions } from "../../shared/utils.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import {
  checkPidLiveness,
  isCompletedLifecycleStepState,
  isTerminalLifecycleState,
  lifecycleGeneration,
  transitionLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import { terminalResultForStatusStep } from "../../shared/terminal-result.ts";
import { boundChildError } from "../shared/child-protocol.ts";
import { isAsyncStatusReadError } from "./async-status-boundary.ts";
import {
  finalizeSubagentRunTelemetry,
  mergeSubagentRunTelemetry,
  normalizeSubagentRunTelemetry,
  resolveSubagentTelemetryOutcome,
  resolveParallelSubagentTelemetryOutcome,
  type SubagentRunTelemetry,
} from "../../shared/telemetry.ts";
export type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

type ReconcileAsyncRunOptions = {
  resultsDir?: string;
  kill?: KillFn;
  now?: () => number;
  statusRead?: AsyncStatusReadOptions;
  staleAlivePidMs?: number;
};

export interface ReconcileAsyncRunResult {
  status: AsyncStatus | null;
  repaired: boolean;
  resultPath?: string;
  message?: string;
  protectedLifecycle?: boolean;
}

type StaleRunRepairEvent = {
  type: "subagent.run.repaired_stale";
  ts: number;
  runId: string;
  pid?: number;
  resultPath: string;
  message: string;
};

const STALE_MESSAGE_PREFIX = "Async runner process";

const STALE_MESSAGE_SUFFIX =
  "exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.";

const DEFAULT_STALE_ALIVE_PID_MS = 24 * 60 * 60 * 1000;
const STALE_REPAIR_GUARD_FAILED = Symbol("stale-repair-guard-failed");

type StaleRepairGuard = (current: AsyncStatus) => boolean;

function safeStatus(asyncDir: string, options: AsyncStatusReadOptions = {}): AsyncStatus | null {
  try {
    return readStatus(asyncDir, { ...options, cache: false });
  } catch (error) {
    if (isAsyncStatusReadError(error)) throw error;
    return null;
  }
}

function appendRepairEvent(filePath: string, payload: StaleRunRepairEvent): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch {
    /* Lifecycle status is authoritative; diagnostics are advisory. */
  }
}

const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const staleMessage = (pid: number): string =>
  boundChildError(`${STALE_MESSAGE_PREFIX} ${pid} ${STALE_MESSAGE_SUFFIX}`)!;

const staleAlivePidMessage = (pid: number, ageMs: number): string =>
  boundChildError(
    `Async runner process ${pid} still has a live PID, but status has not updated for ${ageMs}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`,
  )!;

function failedStatus(status: AsyncStatus, now: number, message: string): AsyncStatus {
  const steps = status.steps?.map((step) =>
    isCompletedLifecycleStepState(step.status) ||
    step.status === "failed" ||
    step.status === "cancelled"
      ? step
      : {
          ...step,
          status: "failed" as const,
          endedAt: step.endedAt ?? now,
          durationMs:
            step.durationMs ??
            (step.startedAt === undefined ? undefined : Math.max(0, now - step.startedAt)),
          exitCode: step.exitCode ?? 1,
          error: message,
          terminationReason: step.terminationReason ?? ("process_exit" as const),
          terminalResult: terminalResultForStatusStep(step, "failed"),
        },
  );
  // Transition telemetry to a failed outcome, preserving authoritative terminal outcomes.
  const existingTelemetry = normalizeSubagentRunTelemetry(status.telemetry);
  const repairedTelemetry = existingTelemetry
    ? finalizeSubagentRunTelemetry(
        existingTelemetry,
        existingTelemetry.outcome?.state !== undefined &&
          !["queued", "running"].includes(existingTelemetry.outcome.state)
          ? existingTelemetry.outcome
          : { state: "failed", terminationReason: "process_exit" },
        now,
      )
    : undefined;
  return {
    ...status,
    state: "failed",
    pid: undefined,
    pause: undefined,
    error: message,
    endedAt: status.endedAt ?? now,
    lastUpdate: now,
    ...(steps ? { steps } : {}),
    ...(repairedTelemetry ? { telemetry: repairedTelemetry } : {}),
  };
}

function resultStep(
  step: NonNullable<AsyncStatus["steps"]>[number],
  message: string,
): AsyncResultArtifact["results"][number] {
  const complete = isCompletedLifecycleStepState(step.status);
  return {
    agent: step.agent,
    // Carry per-child cwd for result-only revival after stale repair.
    ...(typeof step.cwd === "string" && step.cwd.length > 0 ? { cwd: step.cwd } : {}),
    output: "",
    success: complete,
    ...(complete ? {} : { error: message }),
    ...(step.promptVariant ? { promptVariant: step.promptVariant } : {}),
    ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
    ...(step.ticketId ? { ticketId: step.ticketId } : {}),
    ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    ...(step.exitSignal ? { exitSignal: step.exitSignal } : {}),
    ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.modelIdentity ? { modelIdentity: step.modelIdentity } : {}),
    ...(step.modelResolution ? { modelResolution: step.modelResolution } : {}),
    ...(step.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
    ...(step.modelAttempts ? { modelAttempts: step.modelAttempts } : {}),
    ...(step.terminationReason ? { terminationReason: step.terminationReason } : {}),
    ...(step.terminalResult ? { terminalResult: step.terminalResult } : {}),
  };
}

function resultArtifact(
  status: AsyncStatus,
  asyncDir: string,
  now: number,
  message: string,
): AsyncResultArtifact {
  const steps = status.steps ?? [];
  return {
    id: status.runId || path.basename(asyncDir),
    agent: steps[status.currentStep ?? 0]?.agent ?? steps[0]?.agent ?? "subagent",
    mode: status.mode,
    generation: lifecycleGeneration(status),
    success: false,
    state: "failed",
    summary: message,
    error: message,
    results: steps.map((step) => resultStep(step, message)),
    exitCode: 1,
    timestamp: now,
    durationMs: Math.max(0, now - status.startedAt),
    asyncDir,
    ...(status.sessionId ? { sessionId: status.sessionId } : {}),
    ...(status.projectAgents ? { projectAgents: status.projectAgents } : {}),
    // Copy the committed telemetry envelope into the result artifact so session analysis
    // can read it even when no earlier result artifact was written by the runner.
    ...(status.telemetry ? { telemetry: status.telemetry } : {}),
  } satisfies AsyncResultArtifact;
}

const protectedLifecycle = (status: AsyncStatus): boolean =>
  status.state === "pausing" || status.pause?.kind === "awaiting_supervisor";

function commitStaleFailure(
  asyncDir: string,
  observed: AsyncStatus,
  resultPath: string,
  now: number,
  message: string,
  guard?: StaleRepairGuard,
): ReconcileAsyncRunResult {
  let committed: AsyncStatus;
  try {
    committed = transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: lifecycleGeneration(observed),
      carryMalformedAccounting: true,
      mutate: (current) => {
        if (guard && !guard(current)) throw STALE_REPAIR_GUARD_FAILED;
        return failedStatus(current, now, message);
      },
    }).status;
  } catch {
    const latest = safeStatus(asyncDir);
    return {
      status: latest,
      repaired: false,
      resultPath,
      protectedLifecycle: latest ? protectedLifecycle(latest) : protectedLifecycle(observed),
    };
  }

  const artifact = resultArtifact(committed, asyncDir, now, message);

  if (!fs.existsSync(resultPath))
    try {
      writeAtomicJson(resultPath, artifact);
    } catch {
      /* Status remains authoritative if result storage is unavailable. */
    }

  appendRepairEvent(path.join(asyncDir, "events.jsonl"), {
    type: "subagent.run.repaired_stale",
    ts: now,
    runId: committed.runId,
    pid: observed.pid,
    resultPath,
    message,
  });
  return {
    status: committed,
    repaired: true,
    resultPath,
    message,
    protectedLifecycle: protectedLifecycle(observed),
  };
}

export { checkPidLiveness };

/** Read the result artifact for stale repair, if available. */
function readResultForRepair(resultPath: string):
  | {
      id?: string;
      generation?: number;
      state: string;
      success?: boolean;
      results?: Array<Record<string, unknown>>;
      telemetry?: SubagentRunTelemetry;
    }
  | undefined {
  try {
    if (!fs.existsSync(resultPath)) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.state !== "string") return undefined;
    return {
      id: typeof rec.id === "string" ? rec.id : undefined,
      generation:
        typeof rec.generation === "number" && Number.isSafeInteger(rec.generation)
          ? rec.generation
          : undefined,
      state: rec.state,
      success: typeof rec.success === "boolean" ? rec.success : undefined,
      results: Array.isArray(rec.results)
        ? (rec.results as Array<Record<string, unknown>>)
        : undefined,
      telemetry: normalizeSubagentRunTelemetry(rec.telemetry),
    };
  } catch {
    return undefined;
  }
}

/**
 * Build a repaired status from an existing result artifact when the runner
 * exited without updating status to a terminal state. Adopts the result's
 * telemetry when it carries an authoritative terminal outcome; synthesizes
 * an outcome from the result state/steps otherwise.
 *
 * The write is performed under the lifecycle lock with a generation check so
 * that a concurrent terminal transition, continuation claim, or PID publication
 * landing between the observation and this repair is never silently overwritten.
 */
function repairStatusFromResult(
  asyncDir: string,
  observed: AsyncStatus,
  resultPath: string,
  now: number,
): ReconcileAsyncRunResult | undefined {
  const repair = readResultForRepair(resultPath);
  if (!repair) return undefined;

  // Validate result identity — reject an artifact that does not belong to this run.
  const expectedRunId = observed.runId || path.basename(asyncDir);
  if (repair.id !== undefined && repair.id !== expectedRunId) return undefined;

  const isComplete = repair.state === "complete" || repair.state === "completed";
  const isFailed = repair.state === "failed";
  if (!isComplete && !isFailed) return undefined;

  // Validate result generation — if the artifact carries one it must match the observed snapshot.
  const observedGeneration = lifecycleGeneration(observed);
  if (typeof repair.generation === "number" && repair.generation !== observedGeneration)
    return undefined;

  const mergedTelemetry = mergeSubagentRunTelemetry(repair.telemetry, observed.telemetry);

  // Adopt the result telemetry outcome when it is a valid terminal state; otherwise synthesize.
  const isTerminalTelemetryState = (state?: string): boolean =>
    state === "completed" || state === "failed" || state === "cancelled" || state === "paused";
  const resultOutcome = mergedTelemetry?.outcome;
  const runOutcome =
    resultOutcome && isTerminalTelemetryState(resultOutcome.state)
      ? resultOutcome
      : resolveSubagentTelemetryOutcome({
          state: repair.state,
          success: isComplete,
          terminationReason: isFailed ? "process_exit" : undefined,
        });

  // Update per-child telemetry steps based on the result file's child outcomes.
  // Computed outside the lock because the result artifact is immutable and
  // the generation check guarantees current === observed when we enter mutate.
  let repairedTelemetry: SubagentRunTelemetry | undefined = mergedTelemetry;
  if (repairedTelemetry) {
    const updatedSteps = repairedTelemetry.steps.map((step) => {
      // Skip already-terminal step outcomes; they are authoritative.
      if (step.outcome && isTerminalTelemetryState(step.outcome.state)) return step;
      const child = repair.results?.[step.index] as Record<string, unknown> | undefined;
      if (!child) return { ...step, ...(runOutcome ? { outcome: runOutcome } : {}) };
      const childOutcome = resolveSubagentTelemetryOutcome({
        success: child.success === true,
        terminationReason:
          typeof child.terminationReason === "string"
            ? (child.terminationReason as import("../../shared/types.ts").SubagentTerminationReason)
            : isFailed
              ? "process_exit"
              : undefined,
      });
      return { ...step, ...(childOutcome ? { outcome: childOutcome } : {}) };
    });
    const aggregateOutcome =
      updatedSteps.length > 1
        ? (resolveParallelSubagentTelemetryOutcome(
            updatedSteps.map((s) => (s.outcome ? { ...s.outcome } : {})),
          ) ?? runOutcome)
        : runOutcome;
    repairedTelemetry = {
      ...repairedTelemetry,
      steps: updatedSteps,
      ...(aggregateOutcome ? { outcome: aggregateOutcome } : {}),
    };
  }

  // Build step repairs outside the lock for the same reason.
  const repairedSteps = observed.steps?.map((step) => {
    if (isCompletedLifecycleStepState(step.status) || step.status === "failed") return step;
    const child = repair.results?.[observed.steps!.indexOf(step)] as
      | Record<string, unknown>
      | undefined;
    const childSuccess = child?.success === true;
    return {
      ...step,
      status: childSuccess ? ("complete" as const) : ("failed" as const),
      endedAt: step.endedAt ?? now,
      exitCode: childSuccess ? (step.exitCode ?? 0) : (step.exitCode ?? 1),
      ...(typeof child?.error === "string" ? { error: child.error } : {}),
      terminationReason:
        step.terminationReason ?? (childSuccess ? undefined : ("process_exit" as const)),
      terminalResult: terminalResultForStatusStep(step, childSuccess ? "complete" : "failed"),
    };
  });

  // Snapshot the PID before the lock so we can detect a concurrent claim inside mutate.
  const observedPid = observed.pid;

  // Perform the write under the lifecycle lock with a generation revalidation so that
  // a concurrent terminal transition, continuation claim, or PID publication is never
  // silently overwritten.
  let committed: AsyncStatus;
  try {
    committed = transitionLifecycleStatus({
      asyncDir,
      expectedGeneration: observedGeneration,
      carryMalformedAccounting: true,
      mutate: (current) => {
        // Abort if a concurrent writer already moved to a terminal state.
        if (isTerminalLifecycleState(current.state)) throw STALE_REPAIR_GUARD_FAILED;
        // Abort if the PID changed — a continuation was claimed or a new runner started.
        if (current.pid !== observedPid) throw STALE_REPAIR_GUARD_FAILED;
        // Build the repaired status from current (generation-validated equal to observed).
        return {
          ...current,
          state: isComplete ? "complete" : "failed",
          pid: undefined,
          error: isFailed ? (current.error ?? "Async run failed.") : undefined,
          endedAt: current.endedAt ?? now,
          lastUpdate: now,
          ...(repairedSteps ? { steps: repairedSteps } : {}),
          ...(repairedTelemetry ? { telemetry: repairedTelemetry } : {}),
        } as AsyncStatus;
      },
    }).status;
  } catch {
    const latest = safeStatus(asyncDir);
    return { status: latest ?? observed, repaired: false, resultPath };
  }

  appendRepairEvent(path.join(asyncDir, "events.jsonl"), {
    type: "subagent.run.repaired_stale",
    ts: now,
    runId: committed.runId,
    resultPath,
    message: `Stale run repaired from existing result artifact (state=${committed.state}).`,
  });

  return { status: committed, repaired: true, resultPath };
}

export function reconcileAsyncRun(
  asyncDir: string,
  options: ReconcileAsyncRunOptions = {},
): ReconcileAsyncRunResult {
  const observed = safeStatus(asyncDir, options.statusRead);
  if (!observed) return { status: null, repaired: false };
  const runId = observed.runId || path.basename(asyncDir);
  const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
  if (isTerminalLifecycleState(observed.state) || !validPid(observed.pid)) {
    // Attempt result-based repair when the run is non-terminal but has no live PID.
    if (!isTerminalLifecycleState(observed.state) && !validPid(observed.pid)) {
      const resultRepair = repairStatusFromResult(
        asyncDir,
        observed,
        resultPath,
        options.now?.() ?? Date.now(),
      );
      if (resultRepair) return resultRepair;
    }
    return { status: observed, repaired: false, resultPath };
  }

  const liveness = checkPidLiveness(observed.pid, options.kill);
  if (liveness !== "dead" && observed.state !== "running")
    return { status: observed, repaired: false, resultPath };

  const now = options.now?.() ?? Date.now();
  if (liveness !== "dead") {
    const staleAfterMs = options.staleAlivePidMs ?? DEFAULT_STALE_ALIVE_PID_MS;
    const lastUpdate = observed.lastUpdate ?? observed.startedAt;
    const ageMs = now - lastUpdate;
    if (ageMs <= staleAfterMs) return { status: observed, repaired: false, resultPath };
    return commitStaleFailure(
      asyncDir,
      observed,
      resultPath,
      now,
      staleAlivePidMessage(observed.pid, ageMs),
      (current) =>
        current.state === "running" &&
        current.pid === observed.pid &&
        lifecycleGeneration(current) === lifecycleGeneration(observed) &&
        now - (current.lastUpdate ?? current.startedAt) > staleAfterMs,
    );
  }

  return commitStaleFailure(asyncDir, observed, resultPath, now, staleMessage(observed.pid));
}
