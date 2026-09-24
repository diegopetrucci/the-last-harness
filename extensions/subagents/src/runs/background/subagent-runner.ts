import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { stepSteerInboxDir } from "./control-channel.ts";
import { resolveArtifactConfig } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import {
  type AsyncResultArtifact,
  type AsyncStatus,
  type ChildProcessCleanupResult,
  type CostSummary,
  type ModelAttempt,
  type SubagentRunMode,
  DEFAULT_MAX_OUTPUT,
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
  truncateOutput,
} from "../../shared/types.ts";
import { DEFAULT_CONTROL_CONFIG } from "../shared/subagent-control.ts";
import type { SubagentRunConfig } from "../shared/parallel-utils.ts";
import {
  type RunnerSubagentStep as SubagentStep,
  type SubagentRunPlan,
  mapConcurrent,
  MAX_PARALLEL_CONCURRENCY,
  DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
  Semaphore,
} from "../shared/parallel-utils.ts";
import {
  boundChildError,
  boundChildStderrError,
  MAX_CHILD_ERROR_BYTES,
} from "../shared/child-protocol.ts";
import { scheduleDeadline, type DeadlineTimer } from "../shared/deadline-timer.ts";
import { formatErrorWithOutput } from "../../shared/utils.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";

import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { formatOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.ts";
import { persistedTicketId, TICKET_LOOKUP_MAX_OUTPUT_BYTES } from "../shared/ticket-context.ts";
import {
  advanceLifecycleContinuation,
  isCompletedLifecycleState,
  isCompletedLifecycleStepState,
  lifecycleGeneration,
  transitionLifecycleStatus,
  writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import { formatSupervisorPauseMessage } from "../../shared/pause-messages.ts";
import { runSingleStep, saturatingStepDeadlineAt } from "./single-step-execution.ts";
import {
  appendUnexpectedLifecycleTransitionDiagnostic,
  createBackgroundRunStatusOwner,
  type RunnerStatusStep,
} from "./run-status-owner.ts";
import { createBackgroundRunControlOwner } from "./run-control-owner.ts";
import { terminalResultForStatusStep } from "../../shared/terminal-result.ts";
import { appendDiagnosticJsonl, appendJsonl, findLatestSessionFile } from "./runner-event-log.ts";

import {
  ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
  applyCancelledStatusStepProjection,
  applyCancelledStepProjection,
  isPausedStepStatus,
  normalizeFailedSupervisorPauseResults,
  preservedCancellationStepStatus,
  type StepResult,
} from "./cancellation-projection.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals =
  process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
  if (!attempts || attempts.length === 0) return null;
  let input = 0;
  let output = 0;
  for (const attempt of attempts) {
    input += attempt.usage?.input ?? 0;
    output += attempt.usage?.output ?? 0;
  }
  const total = input + output;
  return total > 0 ? { input, output, total } : null;
}

function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
  const nonEmpty = lines.filter((line) => line.trim());
  if (nonEmpty.length === 0) return;
  step.recentOutput ??= [];
  step.recentOutput.push(...nonEmpty);
  if (step.recentOutput.length > 50) {
    step.recentOutput.splice(0, step.recentOutput.length - 50);
  }
}

function resetStepLiveDetail(step: RunnerStatusStep): void {
  step.currentTool = undefined;
  step.currentToolArgs = undefined;
  step.currentToolStartedAt = undefined;
  step.currentPath = undefined;
  step.recentTools = [];
  step.recentOutput = [];
}

function resolvePiPackageRootFallback(): string {
  const root = resolveInstalledPiPackageRoot();
  if (root) return root;
  throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
}

async function exportSessionHtml(
  sessionFile: string,
  outputDir: string,
  piPackageRoot?: string,
): Promise<string> {
  const pkgRoot = piPackageRoot ?? resolvePiPackageRootFallback();
  const exportModulePath = path.join(pkgRoot, "dist", "core", "export-html", "index.js");
  const moduleUrl = pathToFileURL(exportModulePath).href;
  const mod = await import(moduleUrl);
  const exportFromFile = (
    mod as { exportFromFile?: (inputPath: string, options?: { outputPath?: string }) => string }
  ).exportFromFile;
  if (typeof exportFromFile !== "function") {
    throw new Error("exportFromFile not available");
  }
  const outputPath = path.join(outputDir, `${path.basename(sessionFile, ".jsonl")}.html`);
  return exportFromFile(sessionFile, { outputPath });
}

function createShareLink(
  htmlPath: string,
): { shareUrl: string; gistUrl: string } | { error: string } {
  try {
    const auth = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
    if (auth.status !== 0) {
      return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
    }
  } catch {
    return { error: "GitHub CLI (gh) is not installed." };
  }

  try {
    const result = spawnSync("gh", ["gist", "create", htmlPath], { encoding: "utf-8" });
    if (result.status !== 0) {
      const err = boundChildError((result.stderr || "").trim()) || "Failed to create gist.";
      return { error: err };
    }
    const gistUrl = (result.stdout || "").trim();
    const gistId = gistUrl.split("/").pop();
    if (!gistId) return { error: "Failed to parse gist ID." };
    const shareUrl = `https://shittycodingagent.ai/session/?${gistId}`;
    return { shareUrl, gistUrl };
  } catch (err) {
    return { error: boundChildError(String(err)) ?? "Failed to create gist." };
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

function writeRunLog(
  logPath: string,
  input: {
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
  },
): void {
  const lines: string[] = [];
  lines.push(`# Subagent run ${input.id}`);
  lines.push("");
  lines.push(`- **Mode:** ${input.mode}`);
  lines.push(`- **CWD:** ${input.cwd}`);
  lines.push(`- **Started:** ${new Date(input.startedAt).toISOString()}`);
  lines.push(`- **Ended:** ${new Date(input.endedAt).toISOString()}`);
  lines.push(`- **Duration:** ${formatDuration(input.endedAt - input.startedAt)}`);
  if (input.sessionFile) lines.push(`- **Session:** ${input.sessionFile}`);
  if (input.shareUrl) lines.push(`- **Share:** ${input.shareUrl}`);
  if (input.shareError) lines.push(`- **Share error:** ${input.shareError}`);
  if (input.artifactsDir) lines.push(`- **Artifacts:** ${input.artifactsDir}`);
  lines.push("");
  lines.push("## Steps");
  lines.push("| Step | Agent | Status | Duration |");
  lines.push("| --- | --- | --- | --- |");
  input.steps.forEach((step, i) => {
    const duration = step.durationMs !== undefined ? formatDuration(step.durationMs) : "-";
    lines.push(`| ${i + 1} | ${step.agent} | ${step.status} | ${duration} |`);
  });
  const cleanupSteps = input.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.processCleanup);
  if (cleanupSteps.length > 0) {
    lines.push("");
    lines.push("## Process cleanup");
    for (const { step, index } of cleanupSteps) {
      const cleanup = step.processCleanup;
      if (!cleanup) continue;
      lines.push(`${index + 1}. ${step.agent}: ${formatOwnedProcessGroupCleanup(cleanup)}`);
      for (const warning of cleanup.warnings ?? []) lines.push(`   - Warning: ${warning}`);
    }
  }
  lines.push("");
  lines.push("## Summary");
  if (input.truncated) {
    lines.push("_Output truncated_");
    lines.push("");
  }
  lines.push(input.summary.trim() || "(no output)");
  lines.push("");
  fs.writeFileSync(logPath, lines.join("\n"), "utf-8");
}

type SingleStepResult = Awaited<ReturnType<typeof runSingleStep>>;
type ParallelStepExecutionResult = SingleStepResult & { skipped?: boolean };

const ASYNC_RUNNER_MISSING_PLAN_ERROR = "Async runner config must include a valid direct plan.";
const ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR =
  "Async runner config contains unsupported structuredOutput or structuredOutputSchema task properties. Structured output contracts are retired; restart with a new direct single or parallel run without those properties.";
const ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR =
  "Async runner config contains retired timeoutMs execution control. Configure execution.maxRunTimeMs in <agent-dir>/extensions/subagent/config.json; caller-selected execution timeouts are no longer supported. Restart with a new direct single or parallel run after removing timeoutMs.";
const ASYNC_RUNNER_INVALID_CONFIG_ERROR = "Async runner config is malformed.";

type RunnerConfigEnvelope = Omit<SubagentRunConfig, "plan" | "artifactConfig" | "deadlineAt"> & {
  plan?: unknown;
  artifactConfig?: unknown;
  deadlineAt?: unknown;
  /** Legacy boundary-only field; rejected before an executable plan launches. */
  timeoutMs?: unknown;
};

type ValidRunnerConfigEnvelope = Omit<RunnerConfigEnvelope, "deadlineAt"> & {
  deadlineAt?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasRetiredStructuredOutputProperty(value: unknown): boolean {
  return (
    isRecord(value) &&
    (Object.hasOwn(value, "structuredOutput") || Object.hasOwn(value, "structuredOutputSchema"))
  );
}

function hasRetiredTimeoutProperty(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "timeoutMs");
}

function hasRetiredRunTimeoutProperty(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasRetiredTimeoutProperty(value) || hasRetiredTimeoutProperty(value.plan);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRunnerSubagentStepValue(value: unknown): value is SubagentStep {
  if (!isRecord(value) || hasRetiredStructuredOutputProperty(value)) return false;
  const ticketId = persistedTicketId(value.ticketId);
  if (Object.hasOwn(value, "ticketId") && ticketId !== value.ticketId) return false;
  if (Object.hasOwn(value, "ticketBody")) {
    if (
      typeof value.ticketBody !== "string" ||
      value.ticketId === undefined ||
      value.ticketBody.trim().length === 0 ||
      Buffer.byteLength(value.ticketBody, "utf8") > TICKET_LOOKUP_MAX_OUTPUT_BYTES
    )
      return false;
  }
  const hasTimeoutMs = Object.hasOwn(value, "timeoutMs");
  if (hasTimeoutMs && !isPositiveSafeInteger(value.timeoutMs)) return false;
  if (Object.hasOwn(value, "timeoutOwner")) {
    if (value.timeoutOwner !== "role" && value.timeoutOwner !== "run") return false;
    if (!hasTimeoutMs || !isPositiveSafeInteger(value.timeoutMs)) return false;
  }
  return typeof value.agent === "string" && typeof value.task === "string";
}

function isDirectRunPlanValue(value: unknown): value is SubagentRunPlan {
  if (!isRecord(value)) return false;
  if (value.kind === "single") return isRunnerSubagentStepValue(value.task);
  return (
    value.kind === "parallel" &&
    Array.isArray(value.tasks) &&
    value.tasks.length > 0 &&
    value.tasks.every(isRunnerSubagentStepValue)
  );
}

function directRunPlanValidationError(value: unknown): string {
  if (isRecord(value)) {
    if (hasRetiredTimeoutProperty(value)) return ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR;
    if (value.kind === "single" && hasRetiredStructuredOutputProperty(value.task)) {
      return ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR;
    }
    if (
      value.kind === "parallel" &&
      Array.isArray(value.tasks) &&
      value.tasks.some(hasRetiredStructuredOutputProperty)
    ) {
      return ASYNC_RUNNER_RETIRED_STRUCTURED_OUTPUT_ERROR;
    }
  }
  return ASYNC_RUNNER_MISSING_PLAN_ERROR;
}

function rejectedPlanMode(value: unknown): SubagentRunMode {
  if (isRecord(value) && (value.kind === "single" || value.kind === "parallel")) {
    return value.kind;
  }
  return "single";
}

function isRunnerConfigEnvelope(value: unknown): value is RunnerConfigEnvelope {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.resultPath === "string" &&
    typeof value.cwd === "string" &&
    typeof value.asyncDir === "string"
  );
}

function hasValidRunnerDeadlineAt(value: RunnerConfigEnvelope): value is ValidRunnerConfigEnvelope {
  return !Object.hasOwn(value, "deadlineAt") || isPositiveSafeInteger(value.deadlineAt);
}

function parseRunnerConfig(value: unknown): RunnerConfigEnvelope {
  if (!isRunnerConfigEnvelope(value)) throw new Error(ASYNC_RUNNER_INVALID_CONFIG_ERROR);
  return value;
}

function resolveRunnerTimeoutMessage(plan: SubagentRunPlan): string {
  if (
    plan.kind === "single" &&
    plan.task.timeoutOwner === "role" &&
    plan.task.timeoutMs !== undefined
  ) {
    return `Subagent timed out after ${plan.task.timeoutMs}ms.`;
  }
  return "Subagent exceeded the configured maximum execution time.";
}

function resolveStepDeadlineAt(
  stepStartedAt: number,
  stepTimeoutMs: number | undefined,
  runDeadlineAt: number | undefined,
): number | undefined {
  const stepDeadlineAt =
    stepTimeoutMs !== undefined
      ? saturatingStepDeadlineAt(stepStartedAt, stepTimeoutMs)
      : undefined;
  if (stepDeadlineAt === undefined) return runDeadlineAt;
  if (runDeadlineAt === undefined) return stepDeadlineAt;
  return Math.min(stepDeadlineAt, runDeadlineAt);
}

function persistMissingRunPlanFailure(
  config: RunnerConfigEnvelope,
  error = ASYNC_RUNNER_MISSING_PLAN_ERROR,
): void {
  const timestamp = Date.now();
  const mode = rejectedPlanMode(config.plan);
  const deadlineAt = isPositiveSafeInteger(config.deadlineAt) ? config.deadlineAt : undefined;
  const status: AsyncStatus = {
    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
    runId: config.id,
    ...(typeof config.sessionId === "string" ? { sessionId: config.sessionId } : {}),
    mode,
    state: "failed",
    error,
    startedAt: timestamp,
    endedAt: timestamp,
    lastUpdate: timestamp,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    cwd: config.cwd,
    currentStep: 0,
    steps: [],
    ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
    sessionDir: config.sessionDir,
    outputFile: path.join(config.asyncDir, "output-0.log"),
  };

  fs.mkdirSync(config.asyncDir, { recursive: true });
  writeNormalizedLifecycleStatus(config.asyncDir, status);
  writeAtomicJson(config.resultPath, {
    lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
    id: config.id,
    agent: "subagent",
    mode,
    generation: lifecycleGeneration(status),
    success: false,
    state: "failed" as const,
    summary: error,
    error,
    results: [],
    exitCode: 1,
    timestamp,
    durationMs: 0,
    asyncDir: config.asyncDir,
    ...(config.artifactsDir ? { artifactsDir: config.artifactsDir } : {}),
    cwd: config.cwd,
    sessionId: config.sessionId,
    ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
    ...(config.taskIndex !== undefined ? { taskIndex: config.taskIndex } : {}),
    ...(config.totalTasks !== undefined ? { totalTasks: config.totalTasks } : {}),
  } satisfies AsyncResultArtifact);
}

async function runSubagent(config: RunnerConfigEnvelope): Promise<void> {
  if (hasRetiredRunTimeoutProperty(config)) {
    persistMissingRunPlanFailure(config, ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR);
    throw new Error(ASYNC_RUNNER_RETIRED_TIMEOUT_ERROR);
  }
  if (!hasValidRunnerDeadlineAt(config)) {
    persistMissingRunPlanFailure(config, ASYNC_RUNNER_INVALID_CONFIG_ERROR);
    throw new Error(ASYNC_RUNNER_INVALID_CONFIG_ERROR);
  }
  const plan = isDirectRunPlanValue(config.plan) ? config.plan : undefined;
  if (!plan) {
    const error = directRunPlanValidationError(config.plan);
    persistMissingRunPlanFailure(config, error);
    throw new Error(error);
  }
  const artifactConfig = resolveArtifactConfig(config.artifactConfig, { legacy: true });
  const {
    timeoutMs: _legacyTimeoutMs,
    plan: _unvalidatedPlan,
    artifactConfig: _rawArtifactConfig,
    deadlineAt: _unvalidatedDeadlineAt,
    ...currentConfig
  } = config;
  return runSubagentWithInput(
    {
      ...currentConfig,
      ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
      plan,
      artifactConfig,
    },
    plan,
  );
}

async function runSubagentWithInput(
  config: SubagentRunConfig,
  plan: SubagentRunPlan,
): Promise<void> {
  const { id, resultPath, cwd, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } =
    config;
  const globalSemaphore = new Semaphore(DEFAULT_GLOBAL_CONCURRENCY_LIMIT);
  const results: StepResult[] = [];
  const overallStartTime = Date.now();
  const shareEnabled = config.share === true;
  const asyncDir = config.asyncDir;
  // Install this route before publishing the running PID. The control inbox is
  // authoritative, so the early trampoline deliberately does not act on the
  // signal until the graceful handler below is initialized; it only prevents
  // the platform default from terminating the runner in that startup window.
  let interruptRunner: ((request?: { reason?: string }) => void) | undefined;
  const interruptSignalTrampoline = (): void => {
    interruptRunner?.();
  };
  process.on(ASYNC_INTERRUPT_SIGNAL, interruptSignalTrampoline);
  const eventsPath = path.join(asyncDir, "events.jsonl");
  const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
  const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
  const timeoutMessage =
    config.deadlineAt !== undefined ? resolveRunnerTimeoutMessage(plan) : undefined;
  const timeoutAbortController = new AbortController();
  const interruptAbortController = new AbortController();
  let previousCumulativeTokens: TokenUsage = { input: 0, output: 0, total: 0 };
  const appendEvent = (line: string): void => appendJsonl(eventsPath, line);
  const appendDiagnosticEvent = (line: string, droppedEventType?: string): void =>
    appendDiagnosticJsonl(eventsPath, line, droppedEventType);
  const statusOwner = createBackgroundRunStatusOwner({
    id,
    ...(config.awaited ? { awaited: true } : {}),
    asyncDir,
    cwd,
    plan,
    overallStartTime,
    shareEnabled,
    artifactConfig,
    artifactsDir,
    sessionDir: config.sessionDir,
    sessionId: config.sessionId,
    deadlineAt: config.deadlineAt,
    projectAgents: config.projectAgents,
    nestedRoute: config.nestedRoute,
    nestedSelf: config.nestedSelf,
    timeoutMessage,
    appendEvent,
    appendDiagnosticEvent,
  });
  const { sessionEnabled, statusPayload } = statusOwner;
  const controlOwner = createBackgroundRunControlOwner({
    status: statusOwner,
    id,
    asyncDir,
    overallStartTime,
    controlConfig,
    nestedRoute: config.nestedRoute,
    appendEvent,
  });
  const pausedOutputForIndex = (index: number, agent: string): string =>
    statusOwner.supervisorPauseRequest &&
    index === statusOwner.supervisorPauseRequest.requesterIndex
      ? formatSupervisorPauseMessage({
          headline: `Async run ${id} paused awaiting supervisor (${agent}).`,
          runId: id,
          agent,
          requestSummary: statusOwner.supervisorPauseRequest.pause.summary,
        })
      : "Paused because another child in this cohort is awaiting supervisor.";
  const waitForNestedAsyncDescendantsToStop = async (
    timeoutMs = 2_000,
    pollMs = 50,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (controlOwner.hasLiveNestedAsyncDescendants()) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      // Give a child event one poll to publish a descendant that raced the
      // parent's pausing checkpoint. A single empty read is not evidence that
      // no nested owner exists.
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (!controlOwner.hasLiveNestedAsyncDescendants()) return true;
    }
    return !controlOwner.hasLiveNestedAsyncDescendants();
  };
  let timeoutTimer: DeadlineTimer | undefined;
  statusOwner.setControlHooks({
    clearActivityState: controlOwner.clearActivityState,
    interruptNestedDescendants: controlOwner.interruptNestedAsyncDescendants,
    timeoutNestedDescendants: controlOwner.timeoutNestedAsyncDescendants,
    interruptActiveChildren: controlOwner.interruptActiveChildren,
    timeoutActiveChildren: controlOwner.timeoutActiveChildren,
    abortInterrupt: () => interruptAbortController.abort(),
    abortTimeout: () => timeoutAbortController.abort(),
  });
  const rejectContinuationLaunch = (): boolean => {
    const continuationSource = config.continuationSource;
    if (!continuationSource) return false;
    const gate = advanceLifecycleContinuation(
      continuationSource.asyncDir,
      continuationSource.index,
      continuationSource.claimToken,
      id,
      true,
    );
    if (gate.changed || gate.done) return false;

    const endedAt = Date.now();
    const error = `Continuation launch gate rejected for source run '${continuationSource.runId}' child ${continuationSource.index}.`;
    statusPayload.state = "failed";
    statusPayload.pid = undefined;
    statusPayload.endedAt = endedAt;
    statusPayload.lastUpdate = endedAt;
    statusPayload.error = error;
    statusPayload.steps = statusPayload.steps?.map((step, index) =>
      index === 0
        ? {
            ...step,
            status: "failed",
            endedAt,
            exitCode: 1,
            terminationReason: step.terminationReason ?? "process_exit",
            error,
          }
        : step,
    );
    writeNormalizedLifecycleStatus(asyncDir, statusPayload);
    const gateRejectAgent = statusPayload.steps?.[0]?.agent ?? "subagent";
    try {
      // This early inline artifact is required because the normal terminal writer
      // below is unreachable after the gate-rejection return; without it, waiters
      // could time out without a completion receipt.
      // sessionId is the live-session delivery gate and must match currentSessionId;
      // id is the completion deduplication key.
      // state/success drive child-status resolution and delivery; summary/error carry
      // the user-visible failure; results carries normalized child output; asyncDir
      // supports paused-artifact resolution and the forward-compatible contract.
      writeAtomicJson(resultPath, {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        ...(config.awaited ? { awaited: true } : {}),
        generation: lifecycleGeneration(statusPayload),
        id,
        agent: gateRejectAgent,
        mode: statusPayload.mode,
        success: false,
        state: "failed" as const,
        summary: error,
        error,
        results: [
          {
            agent: gateRejectAgent,
            ...(statusPayload.steps?.[0]?.projectAgent
              ? { projectAgent: statusPayload.steps[0].projectAgent }
              : {}),
            ticketId: statusPayload.steps?.[0]?.ticketId,
            output: error,
            error,
            success: false,
            exitCode: 1,
          },
        ],
        exitCode: 1,
        timestamp: endedAt,
        durationMs: 0,
        asyncDir,
        sessionId: config.sessionId,
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
      } satisfies AsyncResultArtifact);
    } catch (err) {
      console.error(`Failed to write gate-rejection result file ${resultPath}:`, err);
    }
    return true;
  };
  if (rejectContinuationLaunch()) return;
  interruptRunner = (request?: { reason?: string }): void => {
    if (request?.reason === "parent_abort") statusOwner.cancel();
    else statusOwner.interrupt();
  };
  const timeoutRunner = (): void => {
    statusOwner.timeout();
  };
  controlOwner.startActivityTimer();
  // Portable control inbox: the parent drops control request files here when
  // it cannot deliver OS signals (e.g. ENOSYS on Windows) or when steering a
  // live child. Interrupts still route into the same graceful interruptRunner().
  const disposeControlInbox = controlOwner.watchControlInbox({
    onInterrupt: (request) => interruptRunner?.(request),
    onTimeout: timeoutRunner,
  });
  if (config.deadlineAt !== undefined) {
    timeoutTimer = scheduleDeadline(config.deadlineAt, timeoutRunner);
  }
  appendJsonl(
    eventsPath,
    JSON.stringify({
      type: "subagent.run.started",
      lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
      ts: overallStartTime,
      runId: id,
      mode: statusPayload.mode,
      cwd,
      pid: process.pid,
    }),
  );

  let flatIndex = 0;

  const settleParallelResults = (
    group: Extract<SubagentRunPlan, { kind: "parallel" }>,
    parallelResults: ParallelStepExecutionResult[],
    groupStartFlatIndex: number,
  ): void => {
    for (let t = 0; t < group.tasks.length; t++) {
      const fi = groupStartFlatIndex + t;
      const sessionTokens = config.sessionDir
        ? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`))
        : null;
      const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
      if (!taskTokens) continue;
      statusPayload.steps[fi].tokens = taskTokens;
      previousCumulativeTokens = {
        input: previousCumulativeTokens.input + taskTokens.input,
        output: previousCumulativeTokens.output + taskTokens.output,
        total: previousCumulativeTokens.total + taskTokens.total,
      };
    }
    statusPayload.totalTokens = { ...previousCumulativeTokens };
    statusPayload.lastUpdate = Date.now();
    statusOwner.writeStatusPayload();
    for (let t = 0; t < parallelResults.length; t++) {
      const pr = parallelResults[t]!;
      const fi = groupStartFlatIndex + t;
      const persistedStepStatus = statusPayload.steps[fi]?.status;
      const preservedTerminalStep = Boolean(
        preservedCancellationStepStatus(persistedStepStatus, true, null),
      );
      const cancelProjection =
        statusOwner.cancelled && !preservedTerminalStep ? statusPayload.cancel : undefined;
      const projectedResult: StepResult = {
        agent: pr.agent,
        ...(pr.projectAgent ? { projectAgent: pr.projectAgent } : {}),
        ticketId: pr.ticketId,
        output: cancelProjection
          ? "Cancelled by parent abort."
          : pr.interrupted
            ? pausedOutputForIndex(fi, pr.agent)
            : pr.output,
        finalOutput: pr.finalOutput,
        error: cancelProjection ? "Cancelled by parent abort." : pr.error,
        cancel: cancelProjection ?? pr.cancel,
        stderr: pr.stderr,
        stderrTruncated: pr.stderrTruncated,
        protocolOutputLimit: pr.protocolOutputLimit,
        success: !cancelProjection && pr.interrupted !== true && pr.exitCode === 0,
        exitCode: cancelProjection ? 1 : pr.interrupted === true ? 0 : pr.exitCode,
        exitSignal: pr.exitSignal,
        skipped: pr.skipped,
        interrupted: pr.interrupted,
        timedOut: pr.timedOut,
        contextUsage: pr.contextUsage,
        contextPressure: pr.contextPressure,
        contextPressureCrossedThresholds: pr.contextPressureCrossedThresholds,
        terminationReason: cancelProjection ? "cancelled" : pr.terminationReason,
        sessionFile: statusOwner.refreshTrackedSessionFile(fi, pr.sessionFile),
        model: pr.model,
        modelIdentity: pr.modelIdentity,
        modelResolution: pr.modelResolution,
        attemptedModels: pr.attemptedModels,
        modelAttempts: pr.modelAttempts,
        modelFallbackNotice: pr.modelFallbackNotice,
        totalCost: pr.totalCost,
        artifactPaths: pr.artifactPaths,
        processCleanup: pr.processCleanup,
        truncated: pr.truncated,
        transcriptPath: pr.transcriptPath,
        transcriptError: pr.transcriptError,
        skills: pr.skills,
        skillsWarning: pr.skillsWarning,
        outputMode: pr.outputMode,
        savedOutputPath: pr.savedOutputPath,
        outputReference: pr.outputReference,
        outputSaveError: pr.outputSaveError,
        pause:
          !cancelProjection && pr.interrupted
            ? statusOwner.pauseMetadataForIndex(fi, statusPayload.steps[fi]?.endedAt)
            : undefined,
        activityState: statusPayload.steps[fi]?.activityState,
        terminalResult: terminalResultForStatusStep(
          pr,
          cancelProjection
            ? "cancelled"
            : statusOwner.timedOut
              ? "failed"
              : (statusPayload.steps[fi]?.status ?? "failed"),
        ),
      };
      applyCancelledStepProjection(projectedResult, cancelProjection);
      results.push(projectedResult);
    }
  };
  const settleSingleStep = (
    seqStep: SubagentStep,
    stepStartTime: number,
    singleResult: SingleStepResult,
  ): void => {
    const resolvedSeqSessionFile = statusOwner.refreshTrackedSessionFile(
      flatIndex,
      singleResult.sessionFile ?? seqStep.sessionFile,
    );
    if (resolvedSeqSessionFile) {
      statusPayload.steps[flatIndex].sessionFile = resolvedSeqSessionFile;
      statusOwner.latestSessionFile = resolvedSeqSessionFile;
    }
    // Invoke immediately below; this snapshots mutable lifecycle state captured by the runner.
    const projectSingleStepResult = (): StepResult => {
      const projectedResult: StepResult = {
        agent: singleResult.agent,
        ...(singleResult.projectAgent ? { projectAgent: singleResult.projectAgent } : {}),
        ticketId: singleResult.ticketId,
        output: statusOwner.cancelled
          ? "Cancelled by parent abort."
          : statusOwner.timedOut
            ? (timeoutMessage ?? "Subagent timed out.")
            : singleResult.interrupted
              ? pausedOutputForIndex(flatIndex, singleResult.agent)
              : singleResult.output,
        finalOutput: singleResult.finalOutput,
        error: statusOwner.cancelled
          ? "Cancelled by parent abort."
          : statusOwner.timedOut
            ? boundChildError(timeoutMessage ?? "Subagent timed out.")
            : singleResult.error,
        cancel: statusOwner.cancelled ? statusPayload.cancel : singleResult.cancel,
        stderr: singleResult.stderr,
        stderrTruncated: singleResult.stderrTruncated,
        protocolOutputLimit: singleResult.protocolOutputLimit,
        success:
          !statusOwner.cancelled &&
          !statusOwner.timedOut &&
          singleResult.interrupted !== true &&
          singleResult.exitCode === 0,
        exitCode: statusOwner.cancelled
          ? 1
          : statusOwner.timedOut
            ? 1
            : singleResult.interrupted === true
              ? 0
              : singleResult.exitCode,
        exitSignal: singleResult.exitSignal,
        sessionFile: resolvedSeqSessionFile,
        model: singleResult.model,
        modelIdentity: singleResult.modelIdentity,
        modelResolution: singleResult.modelResolution,
        attemptedModels: singleResult.attemptedModels,
        modelAttempts: singleResult.modelAttempts,
        modelFallbackNotice: singleResult.modelFallbackNotice,
        totalCost: singleResult.totalCost,
        artifactPaths: singleResult.artifactPaths,
        processCleanup: singleResult.processCleanup,
        truncated: singleResult.truncated,
        transcriptPath: singleResult.transcriptPath,
        transcriptError: singleResult.transcriptError,
        skills: singleResult.skills,
        skillsWarning: singleResult.skillsWarning,
        outputMode: singleResult.outputMode,
        savedOutputPath: singleResult.savedOutputPath,
        outputReference: singleResult.outputReference,
        outputSaveError: singleResult.outputSaveError,
        pause:
          !statusOwner.cancelled && singleResult.interrupted
            ? statusOwner.pauseMetadataForIndex(flatIndex)
            : undefined,
        interrupted: singleResult.interrupted,
        timedOut: statusOwner.timedOut || singleResult.timedOut ? true : undefined,
        contextUsage: singleResult.contextUsage,
        contextPressure: singleResult.contextPressure,
        contextPressureCrossedThresholds: singleResult.contextPressureCrossedThresholds,
        terminationReason: statusOwner.cancelled ? "cancelled" : singleResult.terminationReason,
        activityState: statusPayload.steps[flatIndex]?.activityState,
        terminalResult: singleResult.terminalResult,
      };
      applyCancelledStepProjection(
        projectedResult,
        statusOwner.cancelled ? statusPayload.cancel : undefined,
      );
      return projectedResult;
    };
    results.push(projectSingleStepResult());
    const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
    let stepTokens: TokenUsage | null = cumulativeTokens
      ? {
          input: cumulativeTokens.input - previousCumulativeTokens.input,
          output: cumulativeTokens.output - previousCumulativeTokens.output,
          total: cumulativeTokens.total - previousCumulativeTokens.total,
        }
      : null;
    if (cumulativeTokens) {
      previousCumulativeTokens = cumulativeTokens;
    } else {
      stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
      if (stepTokens) {
        previousCumulativeTokens = {
          input: previousCumulativeTokens.input + stepTokens.input,
          output: previousCumulativeTokens.output + stepTokens.output,
          total: previousCumulativeTokens.total + stepTokens.total,
        };
      }
    }
    const stepEndTime = Date.now();
    const stepDurationStart = statusPayload.steps[flatIndex].startedAt ?? stepStartTime;
    const childInterrupted = singleResult.interrupted === true;
    if (childInterrupted && !statusOwner.cancelled) statusOwner.interrupted = true;
    const priorStepStatus = statusPayload.steps[flatIndex].status;
    const pausedStep =
      !statusOwner.cancelled && (childInterrupted || isPausedStepStatus(priorStepStatus));
    statusPayload.steps[flatIndex].status = statusOwner.cancelled
      ? "cancelled"
      : statusOwner.timedOut
        ? "failed"
        : pausedStep
          ? "paused"
          : singleResult.exitCode === 0
            ? "complete"
            : "failed";
    statusPayload.steps[flatIndex].endedAt = stepEndTime;
    statusPayload.steps[flatIndex].durationMs = stepEndTime - stepDurationStart;
    statusPayload.steps[flatIndex].terminalResult = terminalResultForStatusStep(
      singleResult,
      statusPayload.steps[flatIndex].status,
    );
    const settledTerminalResult = terminalResultForStatusStep(
      singleResult,
      statusPayload.steps[flatIndex].status,
    );
    const settledStepResult = results.at(-1);
    if (settledStepResult) settledStepResult.terminalResult = settledTerminalResult;
    statusPayload.steps[flatIndex].exitCode = statusOwner.cancelled
      ? 1
      : statusOwner.timedOut
        ? 1
        : childInterrupted
          ? 0
          : singleResult.exitCode;
    statusPayload.steps[flatIndex].exitSignal = singleResult.exitSignal;
    statusPayload.steps[flatIndex].timedOut =
      statusOwner.timedOut || singleResult.timedOut ? true : undefined;
    statusPayload.steps[flatIndex].processCleanup = singleResult.processCleanup;
    statusPayload.steps[flatIndex].contextUsage =
      singleResult.contextUsage ?? statusPayload.steps[flatIndex].contextUsage;
    statusPayload.steps[flatIndex].contextPressure =
      singleResult.contextPressure ?? statusPayload.steps[flatIndex].contextPressure;
    statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
      singleResult.contextPressureCrossedThresholds ??
      statusPayload.steps[flatIndex].contextPressureCrossedThresholds;
    statusPayload.steps[flatIndex].terminationReason = statusOwner.cancelled
      ? "cancelled"
      : singleResult.terminationReason;
    statusPayload.steps[flatIndex].model = singleResult.model;
    statusPayload.steps[flatIndex].thinking = singleResult.modelIdentity
      ? singleResult.modelIdentity.thinking
      : resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
    statusPayload.steps[flatIndex].modelIdentity = singleResult.modelIdentity;
    statusPayload.steps[flatIndex].modelResolution = singleResult.modelResolution;
    statusPayload.steps[flatIndex].modelFallbackNotice = singleResult.modelFallbackNotice;
    statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
    statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
    statusPayload.steps[flatIndex].totalCost = singleResult.totalCost;
    statusPayload.steps[flatIndex].error = statusOwner.timedOut
      ? boundChildError(timeoutMessage ?? "Subagent timed out.")
      : singleResult.error;
    statusPayload.steps[flatIndex].stderr = singleResult.stderr
      ? boundChildStderrError(
          singleResult.stderr,
          singleResult.stderrTruncated === true,
          MAX_CHILD_ERROR_BYTES,
        )
      : undefined;
    statusPayload.steps[flatIndex].stderrTruncated = singleResult.stderrTruncated;
    statusPayload.steps[flatIndex].protocolOutputLimit = singleResult.protocolOutputLimit;
    statusPayload.steps[flatIndex].transcriptPath =
      singleResult.transcriptPath ?? statusPayload.steps[flatIndex].transcriptPath;
    statusPayload.steps[flatIndex].transcriptError = singleResult.transcriptError;
    statusPayload.steps[flatIndex].skills = singleResult.skills;
    statusPayload.steps[flatIndex].skillsWarning = singleResult.skillsWarning;
    if (pausedStep) statusOwner.applyPausedStepMetadata(flatIndex, stepEndTime);
    if (statusOwner.cancelled)
      applyCancelledStatusStepProjection(statusPayload.steps[flatIndex], statusPayload.cancel);
    if (stepTokens) {
      statusPayload.steps[flatIndex].tokens = stepTokens;
      statusPayload.totalTokens = { ...previousCumulativeTokens };
    }
    statusPayload.lastUpdate = stepEndTime;
    statusOwner.writeStatusPayload();

    appendJsonl(
      eventsPath,
      JSON.stringify({
        type: statusOwner.cancelled
          ? "subagent.step.cancelled"
          : statusOwner.timedOut
            ? "subagent.step.failed"
            : childInterrupted
              ? "subagent.step.paused"
              : singleResult.exitCode === 0
                ? "subagent.step.completed"
                : "subagent.step.failed",
        ts: stepEndTime,
        runId: id,
        stepIndex: flatIndex,
        agent: seqStep.agent,
        exitCode: statusOwner.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
        durationMs: stepEndTime - stepDurationStart,
        tokens: stepTokens,
      }),
    );
  };

  if (
    !statusOwner.interrupted &&
    !statusOwner.cancelled &&
    !statusOwner.timedOut &&
    !statusOwner.concurrentTerminalStatusAdopted
  ) {
    const step = plan;

    if (step.kind === "parallel") {
      const group = step;
      const tasks = group.tasks;
      const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
      const groupStartFlatIndex = flatIndex;

      const parallelResults = await mapConcurrent<
        (typeof group.tasks)[number],
        ParallelStepExecutionResult
      >(
        tasks,
        concurrency,
        async (task, taskIdx) => {
          const fi = groupStartFlatIndex + taskIdx;
          if (statusOwner.cancelled || statusOwner.timedOut) {
            return statusOwner.cancelled
              ? statusOwner.pausedStepResult(task)
              : statusOwner.timedOutStepResult(task);
          }
          // A concurrent non-paused terminal adoption sets statusOwner.concurrentTerminalStatusAdopted
          // but leaves statusOwner.interrupted=false, so we must consult the flag directly.
          if (statusOwner.interrupted || statusOwner.concurrentTerminalStatusAdopted)
            return statusOwner.pausedStepResult(task);
          const taskSessionDir = config.sessionDir
            ? path.join(config.sessionDir, `parallel-${taskIdx}`)
            : undefined;
          const taskStartTime = Date.now();
          const taskDeadlineAt = resolveStepDeadlineAt(
            taskStartTime,
            task.timeoutMs,
            config.deadlineAt,
          );
          statusOwner.beginTrackedSessionStep(
            fi,
            task.sessionFile ? path.dirname(task.sessionFile) : taskSessionDir,
            task.sessionFile,
          );
          statusPayload.currentStep = fi;
          statusPayload.steps[fi].status = "running";
          statusPayload.steps[fi].error = undefined;
          statusPayload.steps[fi].activityState = undefined;
          resetStepLiveDetail(statusPayload.steps[fi]);
          statusPayload.steps[fi].startedAt = taskStartTime;
          statusPayload.steps[fi].timeoutMs = task.timeoutMs;
          statusPayload.steps[fi].deadlineAt = taskDeadlineAt;
          statusPayload.steps[fi].endedAt = undefined;
          statusPayload.steps[fi].durationMs = undefined;
          statusPayload.steps[fi].lastActivityAt = taskStartTime;
          statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
          statusPayload.lastActivityAt = taskStartTime;
          statusPayload.lastUpdate = taskStartTime;
          appendRecentStepOutput(statusPayload.steps[fi], task.attemptNotes ?? []);
          statusOwner.writeStatusPayload();

          appendJsonl(
            eventsPath,
            JSON.stringify({
              type: "subagent.step.started",
              ts: taskStartTime,
              runId: id,
              stepIndex: fi,
              agent: task.agent,
            }),
          );
          controlOwner.flushPendingStepSteers(fi);

          const singleResult = await runSingleStep(
            task,
            {
              cwd,
              sessionEnabled,
              sessionDir: taskSessionDir,
              artifactsDir,
              artifactConfig,
              id,
              flatIndex: fi,
              flatStepCount: Math.max(statusPayload.steps.length, 1),
              outputFile: path.join(asyncDir, `output-${fi}.log`),
              steerInboxDir: stepSteerInboxDir(asyncDir, fi),
              piPackageRoot: config.piPackageRoot,
              piArgv1: config.piArgv1,
              nestedRoute: config.nestedRoute,
              registerInterrupt: (interrupt) => controlOwner.registerStepInterrupt(fi, interrupt),
              registerTimeout: (interrupt) => controlOwner.registerStepTimeout(fi, interrupt),
              interruptSignal: interruptAbortController.signal,
              interruptMessage: "Interrupted. Waiting for explicit next action.",
              timeoutSignal: timeoutAbortController.signal,
              timeoutMessage,
              timeoutMs: task.timeoutMs,
              deadlineAt: config.deadlineAt,
              startedAt: taskStartTime,
              onAttemptStart: (attempt) => {
                statusPayload.steps[fi].startedAt = attempt.startedAt;
                statusPayload.steps[fi].durationMs = 0;
                statusPayload.steps[fi].deadlineAt = attempt.deadlineAt;
                statusPayload.lastUpdate = attempt.startedAt;
                controlOwner.updateStepModel(fi, attempt);
                statusOwner.writeStatusPayload();
              },
              onChildEvent: (event) => controlOwner.updateStepFromChildEvent(fi, event),
              onAttemptEnd: (facts) => {
                statusOwner.recordAttemptFacts(fi, facts);
              },
              asyncDir,

              onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
            },
            appendDiagnosticJsonl,
          );
          if (task.sessionFile) {
            statusOwner.latestSessionFile = task.sessionFile;
          }
          const taskEndTime = Date.now();
          const taskDurationStart = statusPayload.steps[fi].startedAt ?? taskStartTime;
          const taskDuration = taskEndTime - taskDurationStart;
          const childInterrupted = singleResult.interrupted === true;
          if (childInterrupted && !statusOwner.cancelled) statusOwner.interrupted = true;
          const priorStepStatus = statusPayload.steps[fi].status as RunnerStatusStep["status"];
          const preservedTerminalStatus = preservedCancellationStepStatus(
            priorStepStatus,
            childInterrupted,
            singleResult.exitCode,
          );
          const cancelProjection = statusOwner.cancelled && !preservedTerminalStatus;
          const pausedStep =
            !statusOwner.cancelled && (childInterrupted || isPausedStepStatus(priorStepStatus));
          statusPayload.steps[fi].status = cancelProjection
            ? "cancelled"
            : statusOwner.timedOut
              ? "failed"
              : (preservedTerminalStatus ??
                (pausedStep ? "paused" : singleResult.exitCode === 0 ? "complete" : "failed"));
          statusPayload.steps[fi].endedAt = taskEndTime;
          statusPayload.steps[fi].durationMs = taskDuration;
          statusPayload.steps[fi].terminalResult = terminalResultForStatusStep(
            singleResult,
            statusPayload.steps[fi].status,
          );
          statusPayload.steps[fi].exitCode = cancelProjection
            ? 1
            : statusOwner.timedOut
              ? 1
              : preservedTerminalStatus === "complete"
                ? 0
                : childInterrupted
                  ? 0
                  : singleResult.exitCode;
          statusPayload.steps[fi].exitSignal = singleResult.exitSignal;
          statusPayload.steps[fi].timedOut =
            statusOwner.timedOut || singleResult.timedOut ? true : undefined;
          statusPayload.steps[fi].processCleanup = singleResult.processCleanup;
          statusPayload.steps[fi].contextUsage =
            singleResult.contextUsage ?? statusPayload.steps[fi].contextUsage;
          statusPayload.steps[fi].contextPressure =
            singleResult.contextPressure ?? statusPayload.steps[fi].contextPressure;
          statusPayload.steps[fi].contextPressureCrossedThresholds =
            singleResult.contextPressureCrossedThresholds ??
            statusPayload.steps[fi].contextPressureCrossedThresholds;
          statusPayload.steps[fi].terminationReason = cancelProjection
            ? "cancelled"
            : preservedTerminalStatus === "complete"
              ? "completed"
              : singleResult.terminationReason;
          statusPayload.steps[fi].model = singleResult.model;
          statusPayload.steps[fi].thinking = singleResult.modelIdentity
            ? singleResult.modelIdentity.thinking
            : resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
          statusPayload.steps[fi].modelIdentity = singleResult.modelIdentity;
          statusPayload.steps[fi].modelResolution = singleResult.modelResolution;
          statusPayload.steps[fi].modelFallbackNotice = singleResult.modelFallbackNotice;
          statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
          statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
          statusPayload.steps[fi].totalCost = singleResult.totalCost;
          statusPayload.steps[fi].error = cancelProjection
            ? "Cancelled by parent abort."
            : statusOwner.timedOut
              ? boundChildError(timeoutMessage ?? "Subagent timed out.")
              : singleResult.error;
          statusPayload.steps[fi].stderr = singleResult.stderr
            ? boundChildStderrError(
                singleResult.stderr,
                singleResult.stderrTruncated === true,
                MAX_CHILD_ERROR_BYTES,
              )
            : undefined;
          statusPayload.steps[fi].stderrTruncated = singleResult.stderrTruncated;
          statusPayload.steps[fi].protocolOutputLimit = singleResult.protocolOutputLimit;
          statusPayload.steps[fi].transcriptPath =
            singleResult.transcriptPath ?? statusPayload.steps[fi].transcriptPath;
          statusPayload.steps[fi].transcriptError = singleResult.transcriptError;
          statusPayload.steps[fi].skills = singleResult.skills;
          statusPayload.steps[fi].skillsWarning = singleResult.skillsWarning;
          if (pausedStep) statusOwner.applyPausedStepMetadata(fi, taskEndTime);
          if (cancelProjection)
            applyCancelledStatusStepProjection(statusPayload.steps[fi], statusPayload.cancel);
          statusPayload.lastUpdate = taskEndTime;
          statusOwner.writeStatusPayload();

          appendJsonl(
            eventsPath,
            JSON.stringify({
              type: cancelProjection
                ? "subagent.step.cancelled"
                : statusOwner.timedOut
                  ? "subagent.step.failed"
                  : childInterrupted
                    ? "subagent.step.paused"
                    : singleResult.exitCode === 0
                      ? "subagent.step.completed"
                      : "subagent.step.failed",
              ts: taskEndTime,
              runId: id,
              stepIndex: fi,
              agent: task.agent,
              exitCode: cancelProjection
                ? 1
                : statusOwner.timedOut
                  ? 1
                  : preservedTerminalStatus === "complete"
                    ? 0
                    : childInterrupted
                      ? 0
                      : singleResult.exitCode,
              durationMs: taskDuration,
            }),
          );
          statusOwner.writeStatusPayload();
          return cancelProjection
            ? {
                ...singleResult,
                output: "Cancelled by parent abort.",
                error: "Cancelled by parent abort.",
                exitCode: 1,
                interrupted: undefined,
                pause: undefined,
                cancel: statusPayload.cancel,
                terminationReason: "cancelled",
                skipped: false,
              }
            : statusOwner.timedOut
              ? {
                  ...singleResult,
                  output: timeoutMessage ?? "Subagent timed out.",
                  error: timeoutMessage ?? "Subagent timed out.",
                  exitCode: 1,
                  interrupted: false,
                  timedOut: true,
                  skipped: false,
                }
              : { ...singleResult, skipped: false };
        },
        globalSemaphore,
      );

      flatIndex += tasks.length;
      settleParallelResults(group, parallelResults, groupStartFlatIndex);
    } else {
      const seqStep = step.task;
      const stepStartTime = Date.now();
      const stepDeadlineAt = resolveStepDeadlineAt(
        stepStartTime,
        seqStep.timeoutMs,
        config.deadlineAt,
      );
      statusOwner.beginTrackedSessionStep(
        flatIndex,
        seqStep.sessionFile ? path.dirname(seqStep.sessionFile) : config.sessionDir,
        seqStep.sessionFile,
      );
      statusPayload.currentStep = flatIndex;
      statusPayload.steps[flatIndex].status = "running";
      statusPayload.steps[flatIndex].activityState = undefined;
      statusPayload.activityState = undefined;
      resetStepLiveDetail(statusPayload.steps[flatIndex]);
      statusPayload.steps[flatIndex].skills = seqStep.skills;
      statusPayload.steps[flatIndex].startedAt = stepStartTime;
      statusPayload.steps[flatIndex].timeoutMs = seqStep.timeoutMs;
      statusPayload.steps[flatIndex].deadlineAt = stepDeadlineAt;
      statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
      statusPayload.lastActivityAt = stepStartTime;
      statusPayload.lastUpdate = stepStartTime;
      statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
      appendRecentStepOutput(statusPayload.steps[flatIndex], seqStep.attemptNotes ?? []);
      statusOwner.writeStatusPayload();

      appendJsonl(
        eventsPath,
        JSON.stringify({
          type: "subagent.step.started",
          ts: stepStartTime,
          runId: id,
          stepIndex: flatIndex,
          agent: seqStep.agent,
        }),
      );

      controlOwner.flushPendingStepSteers(flatIndex);
      const singleResult = await runSingleStep(
        seqStep,
        {
          cwd,
          sessionEnabled,
          sessionDir: config.sessionDir,
          artifactsDir,
          artifactConfig,
          id,
          flatIndex,
          flatStepCount: Math.max(statusPayload.steps.length, 1),
          outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
          steerInboxDir: stepSteerInboxDir(asyncDir, flatIndex),
          piPackageRoot: config.piPackageRoot,
          piArgv1: config.piArgv1,
          nestedRoute: config.nestedRoute,
          registerInterrupt: (interrupt) =>
            controlOwner.registerStepInterrupt(flatIndex, interrupt),
          registerTimeout: (interrupt) => controlOwner.registerStepTimeout(flatIndex, interrupt),
          interruptSignal: interruptAbortController.signal,
          interruptMessage: "Interrupted. Waiting for explicit next action.",
          timeoutSignal: timeoutAbortController.signal,
          timeoutMessage,
          timeoutMs: seqStep.timeoutMs,
          deadlineAt: config.deadlineAt,
          startedAt: stepStartTime,
          onAttemptStart: (attempt) => {
            statusPayload.steps[flatIndex].startedAt = attempt.startedAt;
            statusPayload.steps[flatIndex].durationMs = 0;
            statusPayload.steps[flatIndex].deadlineAt = attempt.deadlineAt;
            statusPayload.lastUpdate = attempt.startedAt;
            controlOwner.updateStepModel(flatIndex, attempt);
            statusOwner.writeStatusPayload();
          },
          onChildEvent: (event) => controlOwner.updateStepFromChildEvent(flatIndex, event),
          onAttemptEnd: (facts) => {
            statusOwner.recordAttemptFacts(flatIndex, facts);
          },
          asyncDir,
          onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
        },
        appendDiagnosticJsonl,
      );
      settleSingleStep(seqStep, stepStartTime, singleResult);

      flatIndex++;
    }
  }

  let summary = results
    .map((r) => {
      const body = r.success ? r.output : formatErrorWithOutput(r.error, r.output);
      return `${r.agent}:\n${body}`;
    })
    .join("\n\n");
  let truncated = false;

  if (maxOutput) {
    const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
    const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
    const truncResult = truncateOutput(summary, config, lastArtifactPath);
    if (truncResult.truncated) {
      summary = truncResult.text;
      truncated = true;
    }
  }

  const totalCost = results.reduce<CostSummary>(
    (sum, result) => ({
      inputTokens: sum.inputTokens + (result.totalCost?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (result.totalCost?.outputTokens ?? 0),
      costUsd: sum.costUsd + (result.totalCost?.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  const finalTotalCost =
    totalCost.inputTokens > 0 || totalCost.outputTokens > 0 || totalCost.costUsd > 0
      ? totalCost
      : undefined;
  const finalFlatAgents = statusPayload.steps.map((step) => step.agent);
  const agentName =
    finalFlatAgents.length === 1 ? finalFlatAgents[0]! : `parallel:${finalFlatAgents.join("+")}`;
  let sessionFile: string | undefined;
  let shareUrl: string | undefined;
  let gistUrl: string | undefined;
  let shareError: string | undefined;

  if (shareEnabled) {
    sessionFile = config.sessionDir
      ? (findLatestSessionFile(config.sessionDir) ?? undefined)
      : undefined;
    if (!sessionFile && statusOwner.latestSessionFile) {
      sessionFile = statusOwner.latestSessionFile;
    }
    if (sessionFile) {
      try {
        const exportDir = config.sessionDir ?? path.dirname(sessionFile);
        const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
        const share = createShareLink(htmlPath);
        if ("error" in share) shareError = share.error;
        else {
          shareUrl = share.shareUrl;
          gistUrl = share.gistUrl;
        }
      } catch (err) {
        shareError = boundChildError(String(err));
      }
    } else {
      shareError = "Session file not found.";
    }
  }

  controlOwner.disposeActivityTimer();
  if (timeoutTimer) timeoutTimer.cancel();
  disposeControlInbox();
  const effectiveSessionFile = sessionFile ?? statusOwner.latestSessionFile;
  const runEndedAt = Date.now();
  let pausedAwaitingSupervisor: AsyncStatus["pause"] | undefined;
  let safePausedResultAfterReap: AsyncStatus["pause"] | undefined;
  let skipFinalStatusWrite = false;
  if (statusOwner.supervisorPauseRequest && !statusOwner.cancelled) {
    const nestedDescendantsStoppedBeforeFinalization = await waitForNestedAsyncDescendantsToStop();
    const ownedProcessesStoppedBeforeFinalization =
      statusOwner.ownedPauseProcessesConfirmedStopped();
    if (
      statusOwner.isPersistedAwaitingSupervisorPause(statusPayload) &&
      nestedDescendantsStoppedBeforeFinalization &&
      ownedProcessesStoppedBeforeFinalization
    ) {
      pausedAwaitingSupervisor = {
        ...statusPayload.pause!,
        pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
        ownerPid: undefined,
      };
    } else if (statusPayload.state === "pausing") {
      if (nestedDescendantsStoppedBeforeFinalization && ownedProcessesStoppedBeforeFinalization) {
        const pausedSessionFile =
          effectiveSessionFile ??
          statusPayload.steps[statusOwner.supervisorPauseRequest.requesterIndex]?.sessionFile;
        try {
          const transition = transitionLifecycleStatus({
            asyncDir,
            expectedGeneration: lifecycleGeneration(statusPayload),
            mutate: (status) => ({
              ...status,
              state: "paused",
              pid: undefined,
              pause: {
                ...statusOwner.supervisorPauseRequest!.pause,
                pausedAt: runEndedAt,
                ownerPid: undefined,
              },
              activityState: undefined,
              currentTool: undefined,
              currentToolStartedAt: undefined,
              currentPath: undefined,
              endedAt: runEndedAt,
              lastUpdate: runEndedAt,
              sessionFile: pausedSessionFile ?? status.sessionFile,
              totalCost: finalTotalCost,
              shareUrl,
              gistUrl,
              shareError,
              steps: status.steps?.map((step, index) =>
                step.status === "pausing" || step.status === "paused"
                  ? {
                      ...step,
                      ...(statusOwner.refreshTrackedSessionFile(index)
                        ? { sessionFile: statusOwner.refreshTrackedSessionFile(index) }
                        : {}),
                      status: "paused",
                      exitCode: 0,
                      terminationReason: "paused",
                      exitSignal: undefined,
                      activityState: undefined,
                      endedAt: step.endedAt ?? runEndedAt,
                      durationMs: step.startedAt
                        ? (step.endedAt ?? runEndedAt) - step.startedAt
                        : step.durationMs,
                      pause: statusOwner.pauseMetadataForIndex(index, runEndedAt),
                    }
                  : step,
              ),
            }),
          });
          Object.assign(statusPayload, transition.status);
        } catch (error) {
          appendUnexpectedLifecycleTransitionDiagnostic(
            appendDiagnosticEvent,
            id,
            "pausing->paused",
            error,
          );
          statusOwner.adoptConcurrentTerminalStatus();
        }
        const nestedDescendantsStoppedAfterFinalization =
          await waitForNestedAsyncDescendantsToStop();
        const ownedProcessesStoppedAfterFinalization =
          statusOwner.ownedPauseProcessesConfirmedStopped();
        if (
          !statusOwner.concurrentTerminalStatusAdopted &&
          nestedDescendantsStoppedAfterFinalization &&
          ownedProcessesStoppedAfterFinalization &&
          statusOwner.durablePausingCheckpointPersisted &&
          !statusOwner.supervisorPauseTransitionFailed
        ) {
          safePausedResultAfterReap = {
            ...(statusPayload.pause ?? statusOwner.supervisorPauseRequest.pause),
            pausedAt: statusPayload.pause?.pausedAt ?? runEndedAt,
            ownerPid: undefined,
          };
          if (statusOwner.isPersistedAwaitingSupervisorPause(statusPayload))
            pausedAwaitingSupervisor = safePausedResultAfterReap;
        } else if (!statusOwner.concurrentTerminalStatusAdopted) {
          statusOwner.supervisorPauseTransitionFailed = true;
          skipFinalStatusWrite = true;
        }
      } else if (!statusOwner.adoptConcurrentTerminalStatus()) {
        statusOwner.supervisorPauseTransitionFailed = true;
        skipFinalStatusWrite = true;
      }
    } else if (!statusOwner.adoptConcurrentTerminalStatus()) {
      statusOwner.supervisorPauseTransitionFailed = true;
    }
    if (
      !pausedAwaitingSupervisor &&
      statusOwner.supervisorPauseTransitionFailed &&
      !statusOwner.concurrentTerminalStatusAdopted
    ) {
      // Fail closed without retaining or publishing an unverified owner pid.
      // Cleanup metadata remains available to state that processes may live.
      // The marker blocks revival without conflating this bounded lifecycle
      // failure with an ordinary resumable child failure.
      skipFinalStatusWrite = false;
      statusPayload.state = "failed";
      statusPayload.pid = undefined;
      statusPayload.pause = undefined;
      statusPayload.activityState = undefined;
      statusPayload.currentTool = undefined;
      statusPayload.currentToolStartedAt = undefined;
      statusPayload.currentPath = undefined;
      statusPayload.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      statusPayload.endedAt = runEndedAt;
      statusPayload.lastUpdate = runEndedAt;
      statusPayload.lifecycle = {
        ...statusPayload.lifecycle,
        resumeBlockedReason: "supervisor_lifecycle_failure",
      };
      statusPayload.steps = statusPayload.steps.map((step) =>
        isCompletedLifecycleStepState(step.status) ||
        step.status === "failed" ||
        step.status === "cancelled"
          ? step
          : {
              ...step,
              status: "failed" as const,
              pause: undefined,
              activityState: undefined,
              currentTool: undefined,
              currentToolArgs: undefined,
              currentToolStartedAt: undefined,
              currentPath: undefined,
              interruptRequestedAt: undefined,
              exitCode: 1,
              terminationReason: "process_exit" as const,
              error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
              endedAt: step.endedAt ?? runEndedAt,
              durationMs:
                step.durationMs ??
                (step.startedAt === undefined
                  ? undefined
                  : Math.max(0, runEndedAt - step.startedAt)),
              terminalResult: terminalResultForStatusStep(step, "failed"),
            },
      );
      summary = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      normalizeFailedSupervisorPauseResults(
        results,
        statusPayload.steps,
        statusOwner.supervisorPauseRequest.requesterIndex,
        agentName,
      );
    }
  }
  const persistTerminalRun = (): void => {
    if (
      !pausedAwaitingSupervisor &&
      !skipFinalStatusWrite &&
      !statusOwner.concurrentTerminalStatusAdopted
    ) {
      statusPayload.state = statusOwner.cancelled
        ? "cancelled"
        : statusOwner.terminalReason.reason === "output_limit"
          ? "failed"
          : statusOwner.supervisorPauseTransitionFailed
            ? "failed"
            : statusOwner.timedOut
              ? "failed"
              : statusOwner.interrupted
                ? "paused"
                : results.every((r) => r.success)
                  ? "complete"
                  : "failed";
      statusPayload.activityState = undefined;
      if (statusOwner.cancelled) {
        statusPayload.cancel = statusPayload.cancel ?? {
          summary: "Cancelled by parent abort.",
          cancelledAt: runEndedAt,
        };
        statusPayload.error = statusPayload.cancel.summary;
      }
      if (statusOwner.timedOut) {
        statusPayload.timedOut = true;
        statusPayload.error = timeoutMessage ?? "Subagent timed out.";
      }
      if (statusOwner.supervisorPauseTransitionFailed && statusPayload.state === "failed") {
        statusPayload.error = statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      }
      statusPayload.endedAt = runEndedAt;
      statusPayload.lastUpdate = runEndedAt;
      statusPayload.sessionFile = effectiveSessionFile;
      statusPayload.totalCost = finalTotalCost;
      statusPayload.shareUrl = shareUrl;
      statusPayload.gistUrl = gistUrl;
      statusPayload.shareError = shareError;
      if (statusPayload.state === "failed" && !statusPayload.error) {
        const failedStep = statusPayload.steps.find((s) => s.status === "failed");
        if (failedStep?.agent) {
          statusPayload.error = failedStep.error ?? `Step failed: ${failedStep.agent}`;
        }
      }
      statusOwner.writeStatusPayload();
    }
    if (pausedAwaitingSupervisor) statusOwner.emitNestedSelfEvent("subagent.nested.completed");
    appendJsonl(
      eventsPath,
      JSON.stringify({
        type: "subagent.run.completed",
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        ts: runEndedAt,
        runId: id,
        status: statusPayload.state,
        durationMs: runEndedAt - overallStartTime,
        totalTokens: statusPayload.totalTokens,
        totalCost: finalTotalCost,
      }),
    );
    writeRunLog(logPath, {
      id,
      mode: statusPayload.mode,
      cwd,
      startedAt: overallStartTime,
      endedAt: runEndedAt,
      steps: statusPayload.steps.map((step) => ({
        agent: step.agent,
        status: step.status,
        durationMs: step.durationMs,
        processCleanup: step.processCleanup,
      })),
      summary,
      truncated,
      artifactsDir,
      sessionFile: effectiveSessionFile,
      shareUrl,
      shareError,
    });

    const resultPausedAwaitingSupervisor =
      pausedAwaitingSupervisor ??
      (safePausedResultAfterReap &&
      !statusOwner.supervisorPauseTransitionFailed &&
      !statusOwner.concurrentTerminalStatusAdopted
        ? safePausedResultAfterReap
        : undefined);
    // Invoke immediately below; this snapshots mutable terminal state at the current site.
    const resolveResultState = (): AsyncResultArtifact["state"] =>
      statusOwner.concurrentTerminalStatusAdopted
        ? statusPayload.state
        : statusOwner.terminalReason.reason === "output_limit"
          ? "failed"
          : statusOwner.timedOut
            ? "failed"
            : resultPausedAwaitingSupervisor
              ? "paused"
              : statusOwner.supervisorPauseTransitionFailed
                ? "failed"
                : statusPayload.state === "failed" ||
                    statusPayload.state === "paused" ||
                    statusPayload.state === "cancelled"
                  ? statusPayload.state
                  : isCompletedLifecycleState(statusPayload.state)
                    ? "complete"
                    : statusOwner.interrupted
                      ? "paused"
                      : results.every((r) => r.success)
                        ? "complete"
                        : "failed";
    const resultState = resolveResultState();
    const resultSuccess = resultState === "complete";
    const resultSummary =
      !statusOwner.concurrentTerminalStatusAdopted && statusOwner.timedOut
        ? (timeoutMessage ?? "Subagent timed out.")
        : resultPausedAwaitingSupervisor
          ? pausedOutputForIndex(
              statusOwner.supervisorPauseRequest?.requesterIndex ?? 0,
              statusPayload.steps[statusOwner.supervisorPauseRequest?.requesterIndex ?? 0]?.agent ??
                agentName,
            )
          : resultState === "failed"
            ? statusOwner.supervisorPauseTransitionFailed
              ? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE
              : config.awaited
                ? summary
                : (statusPayload.error ?? summary)
            : resultState === "paused"
              ? "Paused after interrupt. Waiting for explicit next action."
              : summary;

    try {
      writeAtomicJson(resultPath, {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        ...(config.awaited ? { awaited: true } : {}),
        generation: lifecycleGeneration(statusPayload),
        id,
        agent: agentName,
        mode: plan.kind,
        success: resultSuccess,
        state: resultState,
        summary: resultSummary,
        ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
        ...(!statusOwner.concurrentTerminalStatusAdopted && statusOwner.timedOut
          ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." }
          : resultState === "failed"
            ? { error: statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE }
            : {}),
        ...(resultPausedAwaitingSupervisor ? { pause: resultPausedAwaitingSupervisor } : {}),
        results: results.map((r) => ({
          agent: r.agent,
          ...(r.projectAgent ? { projectAgent: r.projectAgent } : {}),
          ticketId: r.ticketId,
          output: r.output,
          finalOutput: r.finalOutput,
          error: r.error,
          cancel: r.cancel,
          stderr: r.stderr,
          stderrTruncated: r.stderrTruncated,
          protocolOutputLimit: r.protocolOutputLimit,
          success: r.success,
          exitCode: r.exitCode,
          exitSignal: r.exitSignal,
          skipped: r.skipped || undefined,
          interrupted: r.interrupted || undefined,
          timedOut: r.timedOut || undefined,
          contextUsage: r.contextUsage,
          contextPressure: r.contextPressure,
          contextPressureCrossedThresholds: r.contextPressureCrossedThresholds,
          terminationReason: r.terminationReason,
          sessionFile: r.sessionFile,
          model: r.model,
          modelIdentity: r.modelIdentity,
          modelResolution: r.modelResolution,
          attemptedModels: r.attemptedModels,
          modelAttempts: r.modelAttempts,
          modelFallbackNotice: r.modelFallbackNotice,
          totalCost: r.totalCost,
          artifactPaths: r.artifactPaths,
          processCleanup: r.processCleanup,
          truncated: r.truncated,
          transcriptPath: r.transcriptPath,
          transcriptError: r.transcriptError,
          skills: r.skills,
          skillsWarning: r.skillsWarning,
          outputMode: r.outputMode,
          savedOutputPath: r.savedOutputPath,
          outputReference: r.outputReference,
          outputSaveError: r.outputSaveError,
          childLocation: r.childLocation,
          pause: r.pause,
          activityState: r.activityState,
          terminalResult: r.terminalResult,
        })),
        exitCode: resultState === "failed" || resultState === "cancelled" ? 1 : 0,
        timestamp: runEndedAt,
        durationMs: runEndedAt - overallStartTime,
        totalTokens: statusPayload.totalTokens,
        totalCost: finalTotalCost,
        truncated,
        artifactsDir,
        cwd,
        asyncDir,
        sessionId: config.sessionId,
        ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        sessionFile: effectiveSessionFile,
        shareUrl,
        gistUrl,
        shareError,
        ...(taskIndex !== undefined && { taskIndex }),
        ...(totalTasks !== undefined && { totalTasks }),
      } satisfies AsyncResultArtifact);
    } catch (err) {
      console.error(`Failed to write result file ${resultPath}:`, err);
    }
  };
  persistTerminalRun();
}

const configArg = process.argv[2];
if (configArg) {
  try {
    const configJson = fs.readFileSync(configArg, "utf-8");
    const configValue: unknown = JSON.parse(configJson);
    try {
      fs.unlinkSync(configArg);
    } catch {
      // Temp config cleanup is best effort.
    }
    const config = parseRunnerConfig(configValue);
    runSubagent(config).catch((runErr) => {
      console.error("Subagent runner error:", runErr);
      process.exit(1);
    });
  } catch (err) {
    console.error("Subagent runner error:", err);
    process.exit(1);
  }
} else {
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const configValue: unknown = JSON.parse(input);
      const config = parseRunnerConfig(configValue);
      runSubagent(config).catch((runErr) => {
        console.error("Subagent runner error:", runErr);
        process.exit(1);
      });
    } catch (err) {
      console.error("Subagent runner error:", err);
      process.exit(1);
    }
  });
}
