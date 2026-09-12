import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { consumeInterruptRequest, stepSteerInboxDir } from "./control-channel.ts";
import { appendJsonl as appendRawJsonl, resolveArtifactConfig } from "../../shared/artifacts.ts";
import { PI_CODING_AGENT_PACKAGE, resolveInstalledPiPackageRoot } from "../shared/pi-spawn.ts";
import {
  type ArtifactPaths,
  type AsyncResultArtifact,
  type AsyncStatus,
  type ChildProcessCleanupResult,
  type CostSummary,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ContextUsageDiagnostics,
  type ModelAttempt,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentRunMode,
  type SubagentTerminationReason,
  type ToolBudgetState,
  DEFAULT_MAX_OUTPUT,
  SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
  truncateOutput,
} from "../../shared/types.ts";
import { DEFAULT_CONTROL_CONFIG, buildControlEvent } from "../shared/subagent-control.ts";
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
  type ProtocolOutputLimit,
} from "../shared/child-protocol.ts";
import { scheduleDeadline, type DeadlineTimer } from "../shared/deadline-timer.ts";
import { formatErrorWithOutput } from "../../shared/utils.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import type { TokenUsage } from "../../shared/types.ts";

import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { formatOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.ts";
import { initialToolBudgetState } from "../shared/tool-budget.ts";
import {
  boundedActiveRuntimeMs,
  createActiveRuntimeTracker,
  finalizeLifecycleContinuationLaunch,
  lifecycleGeneration,
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
  transitionLifecycleStatus,
  writeNormalizedLifecycleStatus,
} from "../shared/lifecycle-state.ts";
import { formatForegroundSupervisorPauseMessage } from "../../shared/foreground-pause.ts";
import { runSingleStep, saturatingStepDeadlineAt } from "./single-step-execution.ts";
import {
  appendUnexpectedLifecycleTransitionDiagnostic,
  createBackgroundRunStatusOwner,
  type RunnerStatusStep,
} from "./run-status-owner.ts";
import { createBackgroundRunControlOwner } from "./run-control-owner.ts";

const ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE =
  "Async supervisor lifecycle update failed. The run was stopped safely and marked failed.";

interface StepResult {
  agent: string;
  projectAgent?: import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture;
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
  acceptance?: import("../../shared/types.ts").AcceptanceLedger;
  pause?: AsyncStatus["pause"];
  activeRuntimeMs?: number;
  activeRuntimeCheckpointAt?: number;
  activityState?: RunnerStatusStep["activityState"];
  idleEpisodeId?: RunnerStatusStep["idleEpisodeId"];
  durableAttentionReasons?: RunnerStatusStep["durableAttentionReasons"];
  compaction?: RunnerStatusStep["compaction"];
}

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals =
  process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 50 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const TRUNCATED_EVENT_TYPE = "subagent.events.truncated";
const TRUNCATION_MARKER_RESERVE_BYTES = 512;

interface AsyncEventLogState {
  bytes: number;
  diagnosticsTruncated: boolean;
}

const asyncEventLogStates = new Map<string, AsyncEventLogState>();

function maxAsyncEventsBytes(): number {
  const raw = process.env[ASYNC_EVENTS_MAX_BYTES_ENV];
  if (!raw) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_ASYNC_EVENTS_BYTES;
  return Math.floor(parsed);
}

function eventLogState(filePath: string): AsyncEventLogState {
  let state = asyncEventLogStates.get(filePath);
  if (state) return state;
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Diagnostic event accounting is best-effort; writes below are also safe.
      void 0;
    }
  }
  state = { bytes, diagnosticsTruncated: false };
  asyncEventLogStates.set(filePath, state);
  return state;
}

function appendJsonl(filePath: string, line: string): void {
  try {
    appendRawJsonl(filePath, line);
    const state = asyncEventLogStates.get(filePath);
    if (state) state.bytes += Buffer.byteLength(`${line}\n`, "utf-8");
  } catch {
    // Async event logging is diagnostic and must not fail the run.
  }
}

function appendDiagnosticJsonl(filePath: string, line: string, droppedEventType?: string): void {
  if (!line.trim()) return;
  const state = eventLogState(filePath);
  if (state.diagnosticsTruncated) return;
  const maxBytes = maxAsyncEventsBytes();
  const chunkBytes = Buffer.byteLength(`${line}\n`, "utf-8");
  const diagnosticBudget = Math.max(0, maxBytes - TRUNCATION_MARKER_RESERVE_BYTES);
  if (state.bytes + chunkBytes <= diagnosticBudget) {
    appendJsonl(filePath, line);
    return;
  }

  const marker = JSON.stringify({
    type: TRUNCATED_EVENT_TYPE,
    ts: Date.now(),
    maxBytes,
    droppedEventType,
  });
  if (state.bytes + Buffer.byteLength(`${marker}\n`, "utf-8") <= maxBytes) {
    appendJsonl(filePath, marker);
  }
  state.diagnosticsTruncated = true;
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
    // Session lookup is optional metadata.
    return null;
  }
}

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

function isPausedStepStatus(status: RunnerStatusStep["status"]): boolean {
  return status === "paused";
}

type SingleStepResult = Awaited<ReturnType<typeof runSingleStep>>;
type ParallelStepExecutionResult = SingleStepResult & { skipped?: boolean };

function normalizeFailedSupervisorPauseResults(
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
    }
  }
  if (results.length === 0) {
    results.push({
      agent: steps[requesterIndex]?.agent ?? fallbackAgent,
      ...(steps[requesterIndex]?.projectAgent
        ? { projectAgent: steps[requesterIndex].projectAgent }
        : {}),
      output: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
      error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
      success: false,
      exitCode: 1,
      terminationReason: "process_exit",
    });
  }
}

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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRunnerSubagentStepValue(value: unknown): value is SubagentStep {
  if (!isRecord(value) || hasRetiredStructuredOutputProperty(value)) return false;
  const hasTimeoutMs = Object.hasOwn(value, "timeoutMs");
  if (hasTimeoutMs && !isPositiveSafeInteger(value.timeoutMs)) return false;
  if (
    Object.hasOwn(value, "activeRuntimeMs") &&
    normalizeActiveRuntimeMs(value.activeRuntimeMs) === undefined
  )
    return false;
  if (
    Object.hasOwn(value, "activeRuntimeCheckpointAt") &&
    !isNonNegativeSafeInteger(value.activeRuntimeCheckpointAt)
  )
    return false;
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
    ...(config.toolBudget ? { toolBudget: initialToolBudgetState(config.toolBudget) } : {}),
    cwd: config.cwd,
    currentStep: 0,
    steps: [],
    ...(config.tkTicket ? { tkTicket: config.tkTicket } : {}),
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
  let interruptRunner: (() => void) | undefined;
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
    toolBudget: config.toolBudget,
    tkTicket: config.tkTicket,
    projectAgents: config.projectAgents,
    nestedRoute: config.nestedRoute,
    nestedSelf: config.nestedSelf,
    timeoutMessage,
    appendEvent,
    appendDiagnosticEvent,
  });
  const { sessionEnabled, statusPayload, activeRuntimeTrackers, flatStepAcceptances } = statusOwner;
  const controlOwner = createBackgroundRunControlOwner({
    status: statusOwner,
    id,
    asyncDir,
    overallStartTime,
    controlConfig,
    nestedRoute: config.nestedRoute,
    appendEvent,
    appendDiagnosticEvent,
  });
  const pausedOutputForIndex = (index: number, agent: string): string =>
    statusOwner.supervisorPauseRequest &&
    index === statusOwner.supervisorPauseRequest.requesterIndex
      ? formatForegroundSupervisorPauseMessage({
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
    while (true) {
      if (!controlOwner.hasLiveNestedAsyncDescendants()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
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
  if (config.continuationSource) {
    const gate = finalizeLifecycleContinuationLaunch(
      config.continuationSource.asyncDir,
      config.continuationSource.index,
      config.continuationSource.claimToken,
      id,
    );
    if (!gate.finalized) {
      statusPayload.state = "failed";
      statusPayload.pid = undefined;
      statusPayload.endedAt = Date.now();
      statusPayload.lastUpdate = statusPayload.endedAt;
      statusPayload.error = `Continuation launch gate rejected for source run '${config.continuationSource.runId}' child ${config.continuationSource.index}.`;
      statusPayload.steps = statusPayload.steps?.map((step, index) =>
        index === 0
          ? {
              ...step,
              status: "failed",
              endedAt: statusPayload.endedAt,
              exitCode: 1,
              terminationReason: step.terminationReason ?? "process_exit",
              error: statusPayload.error,
            }
          : step,
      );
      writeNormalizedLifecycleStatus(asyncDir, statusPayload);
      // Option (b): explicit inline failure artifact. The terminal result writer at
      // the bottom of runSubagent is unreachable from this early return, so any waiter
      // blocking on RESULTS_DIR/${id}.json would hang until its own timeout without
      // this write. Consumer contract verified against result-watcher.ts handleResult:
      //   - sessionId    CRITICAL: delivery gate; result-watcher drops the file if absent
      //                  or mismatched against state.currentSessionId.
      //   - id           Primary dedup key; buildCompletionKey uses `id:${id}` when present.
      //   - state/success Drive child-status resolution and resolvePausedArtifactDecision
      //                  (returns "compat" for state !== "paused", so delivery proceeds).
      //   - summary/error User-visible failure message surfaced in the UI.
      //   - results       Child array consumed by the normalizedChildren path.
      //   - asyncDir      Read by resolvePausedArtifactDecision only when state === "paused";
      //                  included for forward compatibility.
      // Safe to omit: durationMs, totalTokens, totalCost, truncated, cwd,
      // sessionFile, shareUrl,
      const gateRejectAgent = statusPayload.steps?.[0]?.agent ?? "subagent";
      try {
        // summary, timestamp, and results[].output are required on AsyncResultArtifact.
        // They are satisfied here because TypeScript control-flow analysis narrows
        // statusPayload.error (assigned above) and statusPayload.endedAt (assigned
        // above) to non-undefined at this write site. Do not extract this block
        // into a helper that accepts statusPayload — doing so would lose that
        // narrowing and require explicit non-null assertions or guards.
        writeAtomicJson(resultPath, {
          lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
          id,
          agent: gateRejectAgent,
          mode: statusPayload.mode,
          success: false,
          state: "failed" as const,
          summary: statusPayload.error,
          error: statusPayload.error,
          results: [
            {
              agent: gateRejectAgent,
              ...(statusPayload.steps?.[0]?.projectAgent
                ? { projectAgent: statusPayload.steps[0].projectAgent }
                : {}),
              output: statusPayload.error,
              error: statusPayload.error,
              success: false,
              exitCode: 1,
            },
          ],
          exitCode: 1,
          timestamp: statusPayload.endedAt,
          durationMs: 0,
          asyncDir,
          sessionId: config.sessionId,
          ...(config.projectAgents ? { projectAgents: config.projectAgents } : {}),
        } satisfies AsyncResultArtifact);
      } catch (err) {
        console.error(`Failed to write gate-rejection result file ${resultPath}:`, err);
      }
      return;
    }
  }
  interruptRunner = () => {
    consumeInterruptRequest(asyncDir);
    statusOwner.interrupt();
  };
  const timeoutRunner = (): void => {
    statusOwner.timeout();
  };
  controlOwner.startActivityTimer();
  statusOwner.startRuntimeCheckpointTimer();
  // Portable control inbox: the parent drops control request files here when
  // it cannot deliver OS signals (e.g. ENOSYS on Windows) or when steering a
  // live child. Interrupts still route into the same graceful interruptRunner().
  const disposeControlInbox = controlOwner.watchControlInbox({
    onInterrupt: () => interruptRunner?.(),
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
      results.push({
        agent: pr.agent,
        ...(pr.projectAgent ? { projectAgent: pr.projectAgent } : {}),
        output: pr.interrupted ? pausedOutputForIndex(fi, pr.agent) : pr.output,
        error: pr.error,
        stderr: pr.stderr,
        stderrTruncated: pr.stderrTruncated,
        protocolOutputLimit: pr.protocolOutputLimit,
        success: pr.interrupted !== true && pr.exitCode === 0,
        exitCode: pr.interrupted === true ? 0 : pr.exitCode,
        exitSignal: pr.exitSignal,
        skipped: pr.skipped,
        interrupted: pr.interrupted,
        timedOut: pr.timedOut,
        toolBudget: pr.toolBudget,
        toolBudgetBlocked: pr.toolBudgetBlocked,
        contextUsage: pr.contextUsage,
        contextPressure: pr.contextPressure,
        contextPressureCrossedThresholds: pr.contextPressureCrossedThresholds,
        terminationReason: pr.terminationReason,
        sessionFile: statusOwner.resolveTrackedSessionFile(fi, pr.sessionFile),
        model: pr.model,
        modelIdentity: pr.modelIdentity,
        modelResolution: pr.modelResolution,
        attemptedModels: pr.attemptedModels,
        modelAttempts: pr.modelAttempts,
        modelFallbackNotice: pr.modelFallbackNotice,
        totalCost: pr.totalCost,
        artifactPaths: pr.artifactPaths,
        processCleanup: pr.processCleanup,
        transcriptPath: pr.transcriptPath,
        transcriptError: pr.transcriptError,
        acceptance: pr.acceptance,
        pause: pr.interrupted
          ? statusOwner.pauseMetadataForIndex(fi, statusPayload.steps[fi]?.endedAt)
          : undefined,
        activeRuntimeMs: pr.activeRuntimeMs,
        activeRuntimeCheckpointAt: pr.activeRuntimeCheckpointAt,
        activityState: statusPayload.steps[fi]?.activityState,
        idleEpisodeId: statusPayload.steps[fi]?.idleEpisodeId,
        durableAttentionReasons: statusPayload.steps[fi]?.durableAttentionReasons,
        compaction: statusPayload.steps[fi]?.compaction,
      });
    }
  };

  const settleSingleStep = (
    seqStep: SubagentStep,
    stepStartTime: number,
    singleResult: SingleStepResult,
  ): void => {
    const resolvedSeqSessionFile = statusOwner.resolveTrackedSessionFile(
      flatIndex,
      singleResult.sessionFile ?? seqStep.sessionFile,
    );
    if (resolvedSeqSessionFile) {
      statusPayload.steps[flatIndex].sessionFile = resolvedSeqSessionFile;
      statusOwner.latestSessionFile = resolvedSeqSessionFile;
    }

    results.push({
      agent: singleResult.agent,
      ...(singleResult.projectAgent ? { projectAgent: singleResult.projectAgent } : {}),
      output: statusOwner.timedOut
        ? (timeoutMessage ?? "Subagent timed out.")
        : singleResult.interrupted
          ? pausedOutputForIndex(flatIndex, singleResult.agent)
          : singleResult.output,
      error: statusOwner.timedOut
        ? boundChildError(timeoutMessage ?? "Subagent timed out.")
        : singleResult.error,
      stderr: singleResult.stderr,
      stderrTruncated: singleResult.stderrTruncated,
      protocolOutputLimit: singleResult.protocolOutputLimit,
      success:
        !statusOwner.timedOut && singleResult.interrupted !== true && singleResult.exitCode === 0,
      exitCode: statusOwner.timedOut
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
      transcriptPath: singleResult.transcriptPath,
      transcriptError: singleResult.transcriptError,
      acceptance: singleResult.acceptance,
      pause: singleResult.interrupted ? statusOwner.pauseMetadataForIndex(flatIndex) : undefined,
      interrupted: singleResult.interrupted,
      timedOut: statusOwner.timedOut || singleResult.timedOut ? true : undefined,
      toolBudget: singleResult.toolBudget,
      toolBudgetBlocked: singleResult.toolBudgetBlocked,
      contextUsage: singleResult.contextUsage,
      contextPressure: singleResult.contextPressure,
      contextPressureCrossedThresholds: singleResult.contextPressureCrossedThresholds,
      terminationReason: singleResult.terminationReason,
      activeRuntimeMs: singleResult.activeRuntimeMs,
      activityState: statusPayload.steps[flatIndex]?.activityState,
      idleEpisodeId: statusPayload.steps[flatIndex]?.idleEpisodeId,
      durableAttentionReasons: statusPayload.steps[flatIndex]?.durableAttentionReasons,
      compaction: statusPayload.steps[flatIndex]?.compaction,
    });
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
    const trackedRuntime = activeRuntimeTrackers.get(flatIndex)?.finalize(stepEndTime);
    activeRuntimeTrackers.delete(flatIndex);
    const settledActiveRuntimeMs = Math.max(
      normalizeActiveRuntimeMs(singleResult.activeRuntimeMs) ?? 0,
      trackedRuntime ?? 0,
    );
    singleResult.activeRuntimeMs = settledActiveRuntimeMs;
    const settledResult = results.at(-1);
    if (settledResult) {
      settledResult.activeRuntimeMs = settledActiveRuntimeMs;
      settledResult.activeRuntimeCheckpointAt = stepEndTime;
    }
    const childInterrupted = singleResult.interrupted === true;
    if (childInterrupted) statusOwner.interrupted = true;
    const priorStepStatus = statusPayload.steps[flatIndex].status;
    const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
    statusPayload.steps[flatIndex].status = statusOwner.timedOut
      ? "failed"
      : pausedStep
        ? "paused"
        : singleResult.exitCode === 0
          ? "complete"
          : "failed";
    statusPayload.steps[flatIndex].endedAt = stepEndTime;
    statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
    statusPayload.steps[flatIndex].activeRuntimeMs = normalizeActiveRuntimeMs(
      singleResult.activeRuntimeMs,
    );
    statusPayload.steps[flatIndex].activeRuntimeCheckpointAt = stepEndTime;
    statusPayload.steps[flatIndex].exitCode = statusOwner.timedOut
      ? 1
      : childInterrupted
        ? 0
        : singleResult.exitCode;
    statusPayload.steps[flatIndex].exitSignal = singleResult.exitSignal;
    statusPayload.steps[flatIndex].timedOut =
      statusOwner.timedOut || singleResult.timedOut ? true : undefined;
    statusPayload.steps[flatIndex].processCleanup = singleResult.processCleanup;
    statusPayload.steps[flatIndex].toolBudget = singleResult.toolBudget;
    statusPayload.steps[flatIndex].toolBudgetBlocked = singleResult.toolBudgetBlocked;
    statusPayload.steps[flatIndex].contextUsage = singleResult.contextUsage;
    statusPayload.steps[flatIndex].contextPressure = singleResult.contextPressure;
    statusPayload.steps[flatIndex].contextPressureCrossedThresholds =
      singleResult.contextPressureCrossedThresholds;
    statusPayload.steps[flatIndex].terminationReason = singleResult.terminationReason;
    if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
    if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
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
    statusPayload.steps[flatIndex].acceptance = singleResult.acceptance;
    if (pausedStep) statusOwner.applyPausedStepMetadata(flatIndex, stepEndTime);
    if (stepTokens) {
      statusPayload.steps[flatIndex].tokens = stepTokens;
      statusPayload.totalTokens = { ...previousCumulativeTokens };
    }
    const sequentialAggregateRuntime = statusPayload.steps.reduce(
      (total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0),
      0,
    );
    statusPayload.activeRuntimeMs = Math.max(
      normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs) ?? 0,
      sequentialAggregateRuntime,
    );
    statusPayload.activeRuntimeCheckpointAt = Math.max(
      normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) ?? 0,
      normalizeActiveRuntimeCheckpointAt(stepEndTime) ?? 0,
    );
    const completionGuardActive =
      singleResult.completionGuardTriggered === true &&
      !singleResult.interrupted &&
      !singleResult.timedOut &&
      !statusOwner.timedOut &&
      !pausedStep;
    const completionGuardPreviousActivityState = statusPayload.steps[flatIndex].activityState;
    if (completionGuardActive) {
      statusOwner.transitionStepHealth(flatIndex, {
        type: "durable_attention",
        reason: "completion_guard",
      });
    }
    if (settledResult) {
      const healthStep = statusPayload.steps[flatIndex];
      settledResult.activityState = healthStep?.activityState;
      settledResult.idleEpisodeId = healthStep?.idleEpisodeId;
      settledResult.durableAttentionReasons = healthStep?.durableAttentionReasons;
      settledResult.compaction = healthStep?.compaction;
    }
    statusPayload.lastUpdate = stepEndTime;
    statusOwner.writeStatusPayload();

    appendJsonl(
      eventsPath,
      JSON.stringify({
        type: statusOwner.timedOut
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
        durationMs: stepEndTime - stepStartTime,
        tokens: stepTokens,
      }),
    );
    if (completionGuardActive) {
      const event = buildControlEvent({
        from: completionGuardPreviousActivityState,
        to: "needs_attention",
        runId: id,
        agent: seqStep.agent,
        index: flatIndex,
        ts: stepEndTime,
        message: `${seqStep.agent} completed without making edits for an implementation task`,
        reason: "completion_guard",
      });
      controlOwner.appendControlEvent(event);
    }
  };

  if (
    !statusOwner.interrupted &&
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
          if (statusOwner.timedOut) return statusOwner.timedOutStepResult(task);
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
          statusPayload.steps[fi].idleEpisodeId = undefined;
          statusPayload.steps[fi].compaction = undefined;
          resetStepLiveDetail(statusPayload.steps[fi]);
          statusPayload.steps[fi].startedAt = taskStartTime;
          statusPayload.steps[fi].activeRuntimeMs = boundedActiveRuntimeMs(
            statusPayload.steps[fi].activeRuntimeMs,
          );
          activeRuntimeTrackers.set(
            fi,
            createActiveRuntimeTracker({
              priorActiveRuntimeMs: statusPayload.steps[fi].activeRuntimeMs,
              segmentStartedAt: taskStartTime,
            }),
          );
          statusPayload.steps[fi].timeoutMs = task.timeoutMs;
          statusPayload.steps[fi].deadlineAt = taskDeadlineAt;
          statusPayload.steps[fi].endedAt = undefined;
          statusPayload.steps[fi].durationMs = undefined;
          statusPayload.steps[fi].lastActivityAt = taskStartTime;
          statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
          statusPayload.lastActivityAt = taskStartTime;
          statusPayload.lastUpdate = taskStartTime;
          appendRecentStepOutput(statusPayload.steps[fi], task.attemptNotes ?? []);
          statusOwner.syncTopLevelHealthProjection();
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
              deadlineAt: taskDeadlineAt,
              startedAt: taskStartTime,
              onAttemptStart: (attempt) => controlOwner.updateStepModel(fi, attempt),
              onChildEvent: (event) => controlOwner.updateStepFromChildEvent(fi, event),
              onAttemptEnd: () => statusOwner.endStepCompaction(fi),
              onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
              skipAcceptance: () => statusOwner.timedOut,
              runtimeTracker: activeRuntimeTrackers.get(fi),
            },
            appendDiagnosticJsonl,
          );
          if (task.sessionFile) {
            statusOwner.latestSessionFile = task.sessionFile;
          }

          const taskEndTime = Date.now();
          const taskDuration = taskEndTime - taskStartTime;
          const trackedRuntime = activeRuntimeTrackers.get(fi)?.finalize(taskEndTime);
          activeRuntimeTrackers.delete(fi);
          const settledActiveRuntimeMs = Math.max(
            normalizeActiveRuntimeMs(singleResult.activeRuntimeMs) ?? 0,
            trackedRuntime ?? 0,
          );
          singleResult.activeRuntimeMs = settledActiveRuntimeMs;
          const childInterrupted = singleResult.interrupted === true;
          if (childInterrupted) statusOwner.interrupted = true;
          const priorStepStatus = statusPayload.steps[fi].status;
          const pausedStep = childInterrupted || isPausedStepStatus(priorStepStatus);
          statusPayload.steps[fi].status = statusOwner.timedOut
            ? "failed"
            : pausedStep
              ? "paused"
              : singleResult.exitCode === 0
                ? "complete"
                : "failed";
          statusPayload.steps[fi].endedAt = taskEndTime;
          statusPayload.steps[fi].durationMs = taskDuration;
          statusPayload.steps[fi].activeRuntimeMs = normalizeActiveRuntimeMs(
            singleResult.activeRuntimeMs,
          );
          statusPayload.steps[fi].activeRuntimeCheckpointAt = taskEndTime;
          singleResult.activeRuntimeCheckpointAt = taskEndTime;
          statusPayload.steps[fi].exitCode = statusOwner.timedOut
            ? 1
            : childInterrupted
              ? 0
              : singleResult.exitCode;
          statusPayload.steps[fi].exitSignal = singleResult.exitSignal;
          statusPayload.steps[fi].timedOut =
            statusOwner.timedOut || singleResult.timedOut ? true : undefined;
          statusPayload.steps[fi].processCleanup = singleResult.processCleanup;
          statusPayload.steps[fi].toolBudget = singleResult.toolBudget;
          statusPayload.steps[fi].toolBudgetBlocked = singleResult.toolBudgetBlocked;
          statusPayload.steps[fi].contextUsage = singleResult.contextUsage;
          statusPayload.steps[fi].contextPressure = singleResult.contextPressure;
          statusPayload.steps[fi].contextPressureCrossedThresholds =
            singleResult.contextPressureCrossedThresholds;
          statusPayload.steps[fi].terminationReason = singleResult.terminationReason;
          if (singleResult.toolBudget) statusPayload.toolBudget = singleResult.toolBudget;
          if (singleResult.toolBudgetBlocked) statusPayload.toolBudgetBlocked = true;
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
          statusPayload.steps[fi].error = statusOwner.timedOut
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
          statusPayload.steps[fi].acceptance = singleResult.acceptance;
          if (pausedStep) statusOwner.applyPausedStepMetadata(fi, taskEndTime);
          const parallelAggregateRuntime = statusPayload.steps.reduce(
            (total, step) => total + (normalizeActiveRuntimeMs(step.activeRuntimeMs) ?? 0),
            0,
          );
          statusPayload.activeRuntimeMs = Math.max(
            normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs) ?? 0,
            parallelAggregateRuntime,
          );
          statusPayload.activeRuntimeCheckpointAt = Math.max(
            normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) ?? 0,
            normalizeActiveRuntimeCheckpointAt(taskEndTime) ?? 0,
          );
          statusPayload.lastUpdate = taskEndTime;
          statusOwner.writeStatusPayload();

          appendJsonl(
            eventsPath,
            JSON.stringify({
              type: statusOwner.timedOut
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
              exitCode: statusOwner.timedOut ? 1 : childInterrupted ? 0 : singleResult.exitCode,
              durationMs: taskDuration,
            }),
          );
          const completionGuardActive =
            singleResult.completionGuardTriggered === true &&
            !singleResult.interrupted &&
            !singleResult.timedOut &&
            !statusOwner.timedOut &&
            !pausedStep;
          const completionGuardPreviousActivityState = statusPayload.steps[fi].activityState;
          if (completionGuardActive) {
            statusOwner.transitionStepHealth(fi, {
              type: "durable_attention",
              reason: "completion_guard",
            });
            const event = buildControlEvent({
              from: completionGuardPreviousActivityState,
              to: "needs_attention",
              runId: id,
              agent: task.agent,
              index: fi,
              ts: taskEndTime,
              message: `${task.agent} completed without making edits for an implementation task`,
              reason: "completion_guard",
            });
            controlOwner.appendControlEvent(event);
          }

          statusOwner.writeStatusPayload();
          return statusOwner.timedOut
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
      statusPayload.steps[flatIndex].idleEpisodeId = undefined;
      statusPayload.steps[flatIndex].compaction = undefined;
      statusPayload.activityState = undefined;
      resetStepLiveDetail(statusPayload.steps[flatIndex]);
      statusPayload.steps[flatIndex].skills = seqStep.skills;
      statusPayload.steps[flatIndex].startedAt = stepStartTime;
      statusPayload.steps[flatIndex].activeRuntimeMs = boundedActiveRuntimeMs(
        statusPayload.steps[flatIndex].activeRuntimeMs,
      );
      activeRuntimeTrackers.set(
        flatIndex,
        createActiveRuntimeTracker({
          priorActiveRuntimeMs: statusPayload.steps[flatIndex].activeRuntimeMs,
          segmentStartedAt: stepStartTime,
        }),
      );
      statusPayload.steps[flatIndex].timeoutMs = seqStep.timeoutMs;
      statusPayload.steps[flatIndex].deadlineAt = stepDeadlineAt;
      statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
      statusPayload.lastActivityAt = stepStartTime;
      statusPayload.lastUpdate = stepStartTime;
      statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
      appendRecentStepOutput(statusPayload.steps[flatIndex], seqStep.attemptNotes ?? []);
      statusOwner.syncTopLevelHealthProjection();
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
          deadlineAt: stepDeadlineAt,
          startedAt: stepStartTime,
          onAttemptStart: (attempt) => controlOwner.updateStepModel(flatIndex, attempt),
          onChildEvent: (event) => controlOwner.updateStepFromChildEvent(flatIndex, event),
          onAttemptEnd: () => statusOwner.endStepCompaction(flatIndex),
          onChildProtocolOutputLimit: statusOwner.onChildProtocolOutputLimit,
          skipAcceptance: () => statusOwner.timedOut,
          runtimeTracker: activeRuntimeTrackers.get(flatIndex),
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
  statusOwner.disposeRuntimeCheckpointTimer();
  if (timeoutTimer) timeoutTimer.cancel();
  disposeControlInbox();
  const effectiveSessionFile = sessionFile ?? statusOwner.latestSessionFile;
  const runEndedAt = Date.now();
  let pausedAwaitingSupervisor: AsyncStatus["pause"] | undefined;
  let safePausedResultAfterReap: AsyncStatus["pause"] | undefined;
  let skipFinalStatusWrite = false;
  if (statusOwner.supervisorPauseRequest) {
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
                      acceptance:
                        step.acceptance ??
                        statusOwner.pausedAcceptanceLedger(flatStepAcceptances[index]),
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
      skipFinalStatusWrite = false;
      statusPayload.state = "failed";
      statusPayload.pid = undefined;
      statusPayload.pause = undefined;
      statusPayload.error = ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
      statusPayload.steps = statusPayload.steps.map((step) =>
        step.status === "pausing" || step.status === "paused"
          ? {
              ...step,
              status: "failed",
              pause: undefined,
              terminationReason: step.terminationReason ?? "process_exit",
              error: ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
            }
          : step,
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
      statusPayload.state =
        statusOwner.terminalReason.reason === "output_limit"
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
    const resultState = statusOwner.concurrentTerminalStatusAdopted
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
                  statusPayload.state === "cancelled" ||
                  statusPayload.state === "continued"
                ? statusPayload.state
                : statusOwner.interrupted
                  ? "paused"
                  : results.every((r) => r.success)
                    ? "complete"
                    : "failed";
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
            ? (statusPayload.error ??
              (statusOwner.supervisorPauseTransitionFailed
                ? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE
                : summary))
            : resultState === "paused"
              ? "Paused after interrupt. Waiting for explicit next action."
              : summary;

    try {
      writeAtomicJson(resultPath, {
        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
        id,
        agent: agentName,
        mode: plan.kind,
        success: resultSuccess,
        state: resultState,
        summary: resultSummary,
        ...(config.deadlineAt !== undefined ? { deadlineAt: config.deadlineAt } : {}),
        ...(statusPayload.toolBudget ? { toolBudget: statusPayload.toolBudget } : {}),
        ...(statusPayload.toolBudgetBlocked ? { toolBudgetBlocked: true } : {}),
        ...(!statusOwner.concurrentTerminalStatusAdopted && statusOwner.timedOut
          ? { timedOut: true, error: timeoutMessage ?? "Subagent timed out." }
          : resultState === "failed"
            ? { error: statusPayload.error ?? ASYNC_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE }
            : {}),
        ...(resultPausedAwaitingSupervisor ? { pause: resultPausedAwaitingSupervisor } : {}),
        ...(normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs) !== undefined
          ? { activeRuntimeMs: normalizeActiveRuntimeMs(statusPayload.activeRuntimeMs) }
          : {}),
        ...(normalizeActiveRuntimeCheckpointAt(statusPayload.activeRuntimeCheckpointAt) !==
        undefined
          ? {
              activeRuntimeCheckpointAt: normalizeActiveRuntimeCheckpointAt(
                statusPayload.activeRuntimeCheckpointAt,
              ),
            }
          : {}),
        results: results.map((r) => ({
          agent: r.agent,
          ...(r.projectAgent ? { projectAgent: r.projectAgent } : {}),
          output: r.output,
          error: r.error,
          stderr: r.stderr,
          stderrTruncated: r.stderrTruncated,
          protocolOutputLimit: r.protocolOutputLimit,
          success: r.success,
          exitCode: r.exitCode,
          exitSignal: r.exitSignal,
          skipped: r.skipped || undefined,
          interrupted: r.interrupted || undefined,
          timedOut: r.timedOut || undefined,
          toolBudget: r.toolBudget,
          toolBudgetBlocked: r.toolBudgetBlocked || undefined,
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
          acceptance: r.acceptance,
          pause: r.pause,
          activeRuntimeMs: r.activeRuntimeMs,
          activeRuntimeCheckpointAt: r.activeRuntimeCheckpointAt,
          activityState: r.activityState,
          idleEpisodeId: r.idleEpisodeId,
          durableAttentionReasons: r.durableAttentionReasons,
          compaction: r.compaction,
        })),
        exitCode: resultState === "failed" ? 1 : 0,
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
