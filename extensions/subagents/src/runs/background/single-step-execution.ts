/**
 * Background single-step setup, attempts, and result finalization.
 *
 * The detached runner owns run-scoped status/control state. This module owns
 * one step's lifecycle and receives diagnostic event persistence as a callback.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  createChildTranscriptWriter,
  type ChildTranscriptWriter,
} from "../../shared/child-transcript.ts";
import {
  contextWindowForModel,
  emptyUsage,
  runPiStreaming,
  type ChildEvent,
  type RunPiStreamingResult,
} from "./pi-streaming.ts";
import { getArtifactPaths, writeArtifactWithFloor } from "../../shared/artifacts.ts";
import {
  captureSingleOutputSnapshot,
  finalizeSingleOutput,
  formatSavedOutputReference,
  resolveSingleOutput,
  type SingleOutputSnapshot,
} from "../shared/single-output.ts";
import {
  type ArtifactPaths,
  type ChildProcessCleanupResult,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ContextUsageDiagnostics,
  type CostSummary,
  type ModelAttempt,
  type NestedRouteInfo,
  type ResolvedArtifactConfig,
  type SubagentModelIdentity,
  type SubagentModelResolution,
  type SubagentAttemptFacts,
  type GitWorkspaceSnapshot,
  type ProviderTokenUsage,
  type SubagentTerminationReason,
  type SubagentTerminalResult,
  type SubagentTerminalState,
} from "../../shared/types.ts";
import { type RunnerSubagentStep as SubagentStep } from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
  appendRuntimeFallbackResolution,
  canonicalSubagentModelIdentity,
  formatModelAttemptNote,
  isRetryableModelFailure,
  sanitizeModelFallbackNotice,
} from "../shared/model-fallback.ts";
import {
  boundChildError,
  boundChildStderrError,
  formatProtocolOutputLimit,
  type ProtocolOutputLimit,
} from "../shared/child-protocol.ts";
import { scheduleDeadline } from "../shared/deadline-timer.ts";
import { detectSubagentError, formatErrorWithOutput } from "../../shared/utils.ts";
import {
  captureGitWorkspaceSnapshot,
  captureSubagentAttemptFacts,
  providerTokensFromUsage,
} from "../../shared/post-run-facts.ts";
import {
  appendBoundedSubagentAttemptFact,
  boundSubagentAttemptFacts,
} from "../../shared/terminal-result.ts";
import {
  parseSessionFacts,
  snapshotSessionFiles,
  type SessionFacts,
  type SessionFileBaseline,
} from "../../shared/session-tokens.ts";
import { injectTicketBody } from "../shared/ticket-context.ts";
import { skipOwnedProcessGroupCleanup } from "../shared/process-group-cleanup.ts";
import {
  classifyContextExhaustedTermination,
  CONTEXT_EXHAUSTED_TERMINATION_MESSAGE,
  hasUsableSessionArtifact,
  mergeContextUsageDiagnostics,
  parseContextUsageDiagnostics,
  resolveSubagentTerminationReason,
} from "../../shared/context-diagnostics.ts";

type AppendDiagnosticJsonl = (filePath: string, line: string, droppedEventType?: string) => void;

function costSummaryFromAttempts(attempts: ModelAttempt[] | undefined): CostSummary | undefined {
  if (!attempts || attempts.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const attempt of attempts) {
    inputTokens += attempt.usage?.input ?? 0;
    outputTokens += attempt.usage?.output ?? 0;
    costUsd += attempt.usage?.cost ?? 0;
  }
  return inputTokens > 0 || outputTokens > 0 || costUsd > 0
    ? { inputTokens, outputTokens, costUsd }
    : undefined;
}

/** Context for running a single step */
interface SingleStepContext {
  cwd: string;
  sessionEnabled: boolean;
  sessionDir?: string;
  artifactsDir?: string;
  artifactConfig: ResolvedArtifactConfig;
  id: string;
  flatIndex: number;
  flatStepCount: number;
  outputFile: string;
  steerInboxDir?: string;
  transcriptPath?: string;
  piPackageRoot?: string;
  piArgv1?: string;
  registerInterrupt?: (interrupt: (() => void) | undefined) => void;
  registerTimeout?: (interrupt: (() => void) | undefined) => void;
  interruptSignal?: AbortSignal;
  interruptMessage?: string;
  timeoutSignal?: AbortSignal;
  timeoutMessage?: string;
  timeoutMs?: number;
  deadlineAt?: number;
  startedAt?: number;
  nestedRoute?: NestedRouteInfo;
  onAttemptStart?: (attempt: ModelAttemptStart) => void;
  onChildEvent?: (event: ChildEvent) => void;
  /** Called after each child attempt has fully settled, including failures. */
  onAttemptEnd?: (facts: SubagentAttemptFacts) => void;
  /** Async lifecycle directory used for persisted overlap attribution. */
  asyncDir?: string;
  onChildProtocolOutputLimit?: (limit: ProtocolOutputLimit) => void;
}

/** Crash-window snapshot persisted to status when a model attempt starts. */
export interface ModelAttemptStart {
  startedAt: number;
  /** Effective deadline for this specific child spawn, when bounded. */
  deadlineAt?: number;
  model?: string;
  thinking?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
}

type SingleStepResultValue = {
  agent: string;
  projectAgent?: import("../../agents/project-agent-loader.ts").ProjectAgentIdentity;
  output: string;
  finalOutput?: string;
  exitCode: number | null;
  exitSignal?: NodeJS.Signals;
  error?: string;
  cancel?: import("../../shared/types.ts").AsyncCancellationMetadata;
  stderr?: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  model?: string;
  modelIdentity?: SubagentModelIdentity;
  modelResolution?: SubagentModelResolution;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  totalCost?: CostSummary;
  artifactPaths?: ArtifactPaths;
  processCleanup?: ChildProcessCleanupResult;
  transcriptPath?: string;
  transcriptError?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  sessionFile?: string;
  skills?: string[];
  skillsWarning?: string;
  outputMode?: import("../../shared/types.ts").OutputMode;
  savedOutputPath?: string;
  outputReference?: import("../../shared/types.ts").SavedOutputReference;
  outputSaveError?: string;
  truncated?: boolean;
  childLocation?: import("../../shared/child-location.ts").ChildLocationSnapshot;
  /** Normalized ticket ID, when assigned. */
  ticketId?: string;
  modelFallbackNotice?: string;
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: ContextPressureProjection;
  contextPressureCrossedThresholds?: ContextPressureThreshold[];
  terminationReason?: SubagentTerminationReason;
  /** Per-child terminal state and evidence-only facts. */
  terminalResult?: SubagentTerminalResult;
};

type SingleStepResolvedOutput = ReturnType<typeof resolveSingleOutput>;
type SingleStepRuntimeResult = RunPiStreamingResult;

interface SingleStepExecutionState {
  candidates: Array<string | undefined>;
  attemptedModels: string[];
  modelAttempts: ModelAttempt[];
  attemptNotes: string[];
  modelResolution?: SubagentModelResolution;
  finalResult?: SingleStepRuntimeResult;
  finalOutputSnapshot?: SingleOutputSnapshot;
  contextExhaustedDetected: boolean;
  firstAttemptIdentity?: SubagentModelIdentity;
  aggregateContextUsage?: ContextUsageDiagnostics;
  finalAttemptContextUsage?: ContextUsageDiagnostics;
  /** Facts are retained in attempt order across fallback and resumed segments. */
  attemptFacts: SubagentAttemptFacts[];
  /** Tool-call IDs are globally deduplicated across appended/resumed session data. */
  seenToolCallIds: Set<string>;
}

interface SingleStepSetup {
  triggerTimeout: () => void;
  inheritedTimeoutSignal?: AbortSignal;
  relayInheritedTimeout: () => void;
  parentRegisterTimeout?: (interrupt: (() => void) | undefined) => void;
  childDeadlineAt?: number;
  ctx: SingleStepContext;
  /** Task text retained in artifacts and diagnostics without ticket contents. */
  task: string;
  /** Initial child prompt, including the ticket body when one was assigned. */
  promptTask: string;
  sessionEnabled: boolean;
  sessionDir?: string;
  artifactPaths?: ArtifactPaths;
  transcriptWriter?: ChildTranscriptWriter;
  eventsPath: string;
  restoredSession: boolean;
  state: SingleStepExecutionState;
}

export function saturatingStepDeadlineAt(stepStartedAt: number, stepTimeoutMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, stepStartedAt + stepTimeoutMs);
}

function prepareSingleStepSetup(step: SubagentStep, ctx: SingleStepContext): SingleStepSetup {
  let activeTimeoutInterrupt: (() => void) | undefined;
  const inheritedTimeoutSignal = ctx.timeoutSignal;
  const relayInheritedTimeout = () => activeTimeoutInterrupt?.();
  if (inheritedTimeoutSignal?.aborted) relayInheritedTimeout();
  else inheritedTimeoutSignal?.addEventListener("abort", relayInheritedTimeout, { once: true });
  const parentRegisterTimeout = ctx.registerTimeout;
  const roleTimeoutMessage =
    step.timeoutOwner !== "run" && step.timeoutMs !== undefined
      ? `Subagent timed out after ${step.timeoutMs}ms.`
      : ctx.timeoutMessage;
  const stepContext: SingleStepContext = {
    ...ctx,
    timeoutSignal: inheritedTimeoutSignal,
    timeoutMessage: roleTimeoutMessage,
    registerTimeout: (interrupt) => {
      activeTimeoutInterrupt = interrupt;
      parentRegisterTimeout?.(interrupt);
      if (interrupt && inheritedTimeoutSignal?.aborted) interrupt();
    },
  };
  const task = step.task;
  const promptTask =
    step.ticketId !== undefined && step.ticketBody !== undefined
      ? injectTicketBody(task, step.ticketId, step.ticketBody)
      : task;
  const sessionEnabled = Boolean(step.sessionFile) || stepContext.sessionEnabled;
  const sessionDir = step.sessionFile ? undefined : stepContext.sessionDir;

  let artifactPaths: ArtifactPaths | undefined;
  let transcriptWriter: ChildTranscriptWriter | undefined;
  if (stepContext.artifactsDir && stepContext.artifactConfig?.enabled !== false) {
    const index = stepContext.flatStepCount > 1 ? stepContext.flatIndex : undefined;
    artifactPaths = getArtifactPaths(stepContext.artifactsDir, stepContext.id, step.agent, index);
    fs.mkdirSync(stepContext.artifactsDir, { recursive: true });
    if (stepContext.artifactConfig?.includeInput !== false) {
      fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
    }
    if (stepContext.artifactConfig?.includeTranscript !== false) {
      transcriptWriter = createChildTranscriptWriter({
        transcriptPath: artifactPaths.transcriptPath,
        source: "async",
        runId: stepContext.id,
        agent: step.agent,
        childIndex: stepContext.flatIndex,
        cwd: step.cwd ?? stepContext.cwd,
      });
    }
  }
  transcriptWriter?.writeInitialUserMessage(task);

  const candidates =
    step.modelCandidates && step.modelCandidates.length > 0
      ? step.modelCandidates
      : step.model
        ? [step.model]
        : [undefined];
  const attemptedModels: string[] = [];
  const modelAttempts: ModelAttempt[] = [];
  const attemptNotes: string[] = [...(step.attemptNotes ?? [])];
  let modelResolution = step.modelResolution;
  const eventsPath = path.join(path.dirname(stepContext.outputFile), "events.jsonl");
  // Async fresh runs commonly receive a preallocated session path. Snapshot
  // whether its artifact existed before the first child is spawned so fallback
  // attempts in this invocation cannot become restored attempts.
  const restoredSession = hasUsableSessionArtifact(step.sessionFile);
  const persistedContextUsage = parseContextUsageDiagnostics(step.contextUsage);
  let aggregateContextUsage: ContextUsageDiagnostics | undefined = persistedContextUsage
    ? {
        ...persistedContextUsage,
        ...(persistedContextUsage.restoredTokens === undefined &&
        persistedContextUsage.contextTokens !== undefined
          ? { restoredTokens: persistedContextUsage.contextTokens }
          : {}),
      }
    : undefined;
  return {
    triggerTimeout: () => activeTimeoutInterrupt?.(),
    inheritedTimeoutSignal,
    relayInheritedTimeout,
    parentRegisterTimeout,
    childDeadlineAt: undefined,
    ctx: stepContext,
    task,
    promptTask,
    sessionEnabled,
    sessionDir,
    artifactPaths,
    transcriptWriter,
    eventsPath,
    restoredSession,
    state: {
      candidates,
      attemptedModels,
      modelAttempts,
      attemptNotes,
      modelResolution,
      finalResult: undefined,
      finalOutputSnapshot: undefined,
      contextExhaustedDetected: false,
      firstAttemptIdentity: undefined,
      aggregateContextUsage,
      finalAttemptContextUsage: undefined,
      attemptFacts: step.terminalResult
        ? boundSubagentAttemptFacts(step.terminalResult.facts.attempts)
        : [],
      seenToolCallIds: new Set(),
    },
  };
}

interface SingleStepAttemptPreparation {
  candidate: string | undefined;
  attemptThinking?: string;
  outputSnapshot?: SingleOutputSnapshot;
  baseline: GitWorkspaceSnapshot;
  startedAt: number;
  attemptDeadlineAt?: number;
  childDeadlineAt?: number;
  monotonicStartedAt: number;
  sessionBaseline?: SessionFileBaseline;
  args?: string[];
  env?: Record<string, string | undefined>;
  tempDir?: string;
  buildError?: string;
}

function prepareSingleStepAttempt(input: {
  step: SubagentStep;
  ctx: SingleStepContext;
  state: SingleStepExecutionState;
  candidate: string | undefined;
  index: number;
  task: string;
  sessionEnabled: boolean;
  sessionDir?: string;
}): SingleStepAttemptPreparation {
  const { step, ctx, state, candidate, index, task, sessionEnabled, sessionDir } = input;
  const attemptCwd = path.resolve(step.cwd ?? ctx.cwd);
  // Capture the baseline before constructing or spawning the child. Git errors
  // are represented in the snapshot rather than allowed to fail the attempt.
  const baseline = captureGitWorkspaceSnapshot(attemptCwd);
  const attemptSessionPath = step.sessionFile ?? sessionDir;
  const sessionBaseline = attemptSessionPath ? snapshotSessionFiles(attemptSessionPath) : undefined;
  const startedAt = Date.now();
  const monotonicStartedAt = performance.now();
  const roleTimeoutMs = step.timeoutOwner !== "run" ? step.timeoutMs : undefined;
  const attemptDeadlineAt =
    roleTimeoutMs !== undefined ? saturatingStepDeadlineAt(startedAt, roleTimeoutMs) : undefined;
  const childDeadlineAt =
    ctx.deadlineAt === undefined
      ? attemptDeadlineAt
      : attemptDeadlineAt === undefined
        ? ctx.deadlineAt
        : Math.min(ctx.deadlineAt, attemptDeadlineAt);
  // The requested thinking level is forwarded to Pi, which owns model-argument validation.
  const attemptThinking = resolveEffectiveThinking(candidate, step.thinking);
  const attemptIdentity = canonicalSubagentModelIdentity(candidate, attemptThinking);
  if (index === 0) state.firstAttemptIdentity = attemptIdentity;
  // If the process dies mid-attempt, the last status write must still carry the
  // original identity, fallback reason, and completed attempt history so
  // durable resume does not mistake a runtime fallback for the original
  // selection. Persist the full transition in one status write.
  let attemptResolution = state.modelResolution;
  if (index > 0) {
    state.modelResolution = appendRuntimeFallbackResolution({
      previous: state.modelResolution,
      sourceAttempt: state.modelAttempts.at(-1),
      currentIdentity: attemptIdentity,
      originalIdentity: state.firstAttemptIdentity,
    });
    attemptResolution = state.modelResolution;
  }
  ctx.onAttemptStart?.({
    startedAt,
    model: candidate,
    thinking: attemptThinking,
    modelIdentity: attemptIdentity,
    modelResolution: attemptResolution,
    attemptedModels: candidate ? [...state.attemptedModels, candidate] : undefined,
    modelAttempts: state.modelAttempts.length > 0 ? [...state.modelAttempts] : undefined,
    ...(childDeadlineAt !== undefined ? { deadlineAt: childDeadlineAt } : {}),
  });
  const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
  let args: string[] | undefined;
  let env: Record<string, string | undefined> | undefined;
  let tempDir: string | undefined;
  let buildError: string | undefined;
  try {
    ({ args, env, tempDir } = buildPiArgs({
      parentSessionId: step.parentSessionId,
      baseArgs: ["--mode", "json", "-p"],
      task,
      sessionEnabled,
      sessionDir,
      sessionFile: step.sessionFile,
      model: candidate,
      inheritProjectContext: step.inheritProjectContext,
      inheritSkills: step.inheritSkills,
      requireReadTool: step.inheritSkills || Boolean(step.skills?.length),
      tools: step.tools,
      extensions: step.extensions,
      subagentOnlyExtensions: step.subagentOnlyExtensions,
      supervisorBridge: step.supervisorBridge,
      systemPrompt: step.systemPrompt ?? "",
      systemPromptMode: step.systemPromptMode,
      cwd: attemptCwd,
      promptFileStem: step.agent,
      runId: ctx.id,
      childAgentName: step.agent,
      projectAgentGuidance: step.projectAgentGuidance === true,
      childIndex: ctx.flatIndex,
      steerInboxDir: ctx.steerInboxDir,
    }));
  } catch (error) {
    buildError =
      boundChildError(error instanceof Error ? error.message : String(error)) ??
      "Unknown child setup error.";
  }
  return {
    candidate,
    attemptThinking,
    outputSnapshot,
    baseline,
    startedAt,
    attemptDeadlineAt,
    childDeadlineAt,
    monotonicStartedAt,
    sessionBaseline,
    args,
    env,
    tempDir,
    buildError,
  };
}

interface SingleStepAttemptAssessment {
  attempt: ModelAttempt;
}

function assessSingleStepAttempt(input: {
  step: SubagentStep;
  state: SingleStepExecutionState;
  run: RunPiStreamingResult;
  candidate: string | undefined;
  outputSnapshot?: SingleOutputSnapshot;
  tempDir?: string;
}): SingleStepAttemptAssessment {
  const { step, state, run, candidate, outputSnapshot, tempDir } = input;
  state.finalAttemptContextUsage = run.contextUsage;
  state.aggregateContextUsage = mergeContextUsageDiagnostics(
    state.aggregateContextUsage,
    run.contextUsage,
  );
  cleanupTempDir(tempDir);

  const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
  const runTerminationReason = resolveSubagentTerminationReason({
    assistantStopReason: run.assistantStopReason,
    effectiveExitCode: run.exitCode ?? undefined,
    processCompleted: true,
  });
  const contextExhaustedSignature = run.protocolOutputLimit
    ? undefined
    : classifyContextExhaustedTermination({
        messages: run.messages,
        // A retry is a new diagnostic scope; prior attempts remain aggregate
        // reporting data but cannot pressure-classify this attempt.
        contextUsage: run.contextUsage,
        exitCode: run.exitCode ?? undefined,
        error: run.error,
        terminationReason: runTerminationReason,
      });
  // Keep this scoped to the current attempt; a failed prior attempt must
  // never make a later fallback look context-exhausted.
  state.contextExhaustedDetected =
    run.contextExhausted === true || contextExhaustedSignature === "context_exhausted";
  const emptyOutputError =
    run.exitCode === 0 &&
    !run.error &&
    !hiddenError?.hasError &&
    !contextExhaustedSignature &&
    !run.finalOutput.trim()
      ? "Subagent produced no output (possible model cold-start or empty response)."
      : undefined;
  const effectiveExitCode = run.protocolOutputLimit
    ? 1
    : hiddenError?.hasError
      ? (hiddenError.exitCode ?? 1)
      : emptyOutputError
        ? 1
        : run.error && run.exitCode === 0
          ? 1
          : run.exitCode;
  const childFailureError = hiddenError?.hasError
    ? hiddenError.details
      ? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
      : `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
    : (emptyOutputError ??
      (run.error ||
        (run.exitCode !== 0
          ? boundChildStderrError(run.stderr.trim(), run.stderrTruncated === true)
          : undefined)));
  const error = boundChildError(
    run.protocolOutputLimit
      ? formatProtocolOutputLimit(run.protocolOutputLimit)
      : childFailureError,
  );
  const attempt: ModelAttempt = {
    model: candidate ?? run.model ?? step.model ?? "default",
    success: effectiveExitCode === 0 && !error,
    exitCode: effectiveExitCode,
    error,
    usage: run.usage,
  };
  state.modelAttempts.push(attempt);
  if (candidate) state.attemptedModels.push(candidate);
  state.finalOutputSnapshot = outputSnapshot;
  state.finalResult = {
    ...run,
    exitCode: effectiveExitCode,
    model: candidate ?? run.model,
    error,
  };
  return { attempt };
}

function shouldStopSingleStepAttempt(input: {
  run: RunPiStreamingResult;
  ctx: SingleStepContext;
  attempt: ModelAttempt;
  index: number;
  candidateCount: number;
}): boolean {
  if (input.run.protocolOutputLimit) return true;
  if (input.run.timedOut || input.ctx.timeoutSignal?.aborted) return true;
  if (input.attempt.success) return true;
  return !isRetryableModelFailure(input.attempt.error) || input.index === input.candidateCount - 1;
}

interface SingleStepOutputFinalization {
  processCleanup: ChildProcessCleanupResult;
  modelFallbackNotice?: string;
  finalModel?: string;
  finalModelIdentity?: SubagentModelIdentity;
  rawOutput: string;
  resolvedOutput: SingleStepResolvedOutput;
  output: string;
  outputForSummary: string;
  outputReference?: import("../../shared/types.ts").SavedOutputReference;
}

function finalizeSingleStepOutput(input: {
  step: SubagentStep;
  state: SingleStepExecutionState;
}): SingleStepOutputFinalization {
  const { step, state } = input;
  const finalResult = state.finalResult;
  const processCleanup =
    finalResult?.processCleanup ??
    skipOwnedProcessGroupCleanup("process_group_unavailable", finalResult?.processGroupId);
  const modelFallbackNotice =
    state.modelAttempts.length > 1
      ? sanitizeModelFallbackNotice(step.modelFallbackNotice)
      : undefined;
  const finalModel = finalResult?.model;
  // A dispatched candidate is authoritative. For an unconfigured run, only the
  // first validated child report is eligible to become the effective identity;
  // runtime observation is not a model-resolution override or fallback.
  const finalConfiguredIdentity = finalResult?.configuredModel
    ? canonicalSubagentModelIdentity(finalResult.configuredModel, step.thinking)
    : undefined;
  const finalModelIdentity = finalConfiguredIdentity ?? finalResult?.runtimeModelIdentity;
  let modelResolution = state.modelResolution;
  if (state.modelAttempts.length > 1 && finalConfiguredIdentity) {
    modelResolution = appendRuntimeFallbackResolution({
      previous: modelResolution,
      sourceAttempt: state.modelAttempts.at(-2),
      currentIdentity: finalConfiguredIdentity,
      originalIdentity: state.firstAttemptIdentity,
    });
  } else if (modelResolution && finalConfiguredIdentity) {
    modelResolution = { ...modelResolution, resumed: finalConfiguredIdentity };
  }
  state.modelResolution = modelResolution;
  if (modelResolution) {
    const resolutionNotice = `Notice: ${modelResolution.reason}`;
    if (!state.attemptNotes.some((note) => note.includes(modelResolution!.reason)))
      state.attemptNotes.push(resolutionNotice);
  }
  const rawOutput = finalResult?.finalOutput ?? "";
  const resolvedOutput =
    step.outputPath && finalResult?.exitCode === 0
      ? resolveSingleOutput(step.outputPath, rawOutput, state.finalOutputSnapshot)
      : { fullOutput: rawOutput };
  const output = resolvedOutput.fullOutput;
  const outputReference = resolvedOutput.savedPath
    ? formatSavedOutputReference(resolvedOutput.savedPath, output)
    : undefined;
  let outputForSummary = output;
  if (modelFallbackNotice) {
    outputForSummary = `Notice: ${modelFallbackNotice}\n\n${outputForSummary}`.trim();
  }
  if (state.attemptNotes.length > 0) {
    outputForSummary = `${state.attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
  }
  const finalizedOutput = finalizeSingleOutput({
    fullOutput: outputForSummary,
    outputPath: step.outputPath,
    outputMode: step.outputMode,
    exitCode: finalResult?.exitCode ?? 1,
    savedPath: resolvedOutput.savedPath,
    outputReference,
    saveError: resolvedOutput.saveError,
  });
  outputForSummary = finalizedOutput.displayOutput;
  return {
    processCleanup,
    modelFallbackNotice,
    finalModel,
    finalModelIdentity,
    rawOutput,
    resolvedOutput,
    output,
    outputForSummary,
    ...(outputReference ? { outputReference } : {}),
  };
}

interface SingleStepOutcome {
  effectiveInterrupted: boolean;
  timedOut: boolean;
  effectiveFinalExitCode: number | null;
  terminationReason: SubagentTerminationReason;
  effectiveFinalError?: string;
}

function finalizeSingleStepOutcome(input: {
  ctx: SingleStepContext;
  state: SingleStepExecutionState;
}): SingleStepOutcome {
  const { ctx, state } = input;
  const finalResult = state.finalResult;
  const effectiveInterrupted =
    !finalResult?.protocolOutputLimit &&
    (finalResult?.interrupted === true ||
      (ctx.interruptSignal?.aborted === true && !ctx.timeoutSignal?.aborted));
  const timedOut = finalResult?.timedOut === true || ctx.timeoutSignal?.aborted === true;
  let effectiveFinalExitCode = finalResult?.protocolOutputLimit
    ? 1
    : timedOut
      ? 1
      : effectiveInterrupted
        ? 0
        : (finalResult?.exitCode ?? 1);
  let terminationReason = finalResult?.protocolOutputLimit
    ? "output_limit"
    : resolveSubagentTerminationReason({
        paused: effectiveInterrupted,
        timedOut,
        interrupted: effectiveInterrupted,
        assistantStopReason: finalResult?.assistantStopReason,
        effectiveExitCode: effectiveFinalExitCode,
        processCompleted: true,
      });
  let effectiveFinalError = finalResult?.protocolOutputLimit
    ? boundChildError(formatProtocolOutputLimit(finalResult.protocolOutputLimit))
    : timedOut
      ? boundChildError(ctx.timeoutMessage ?? "Subagent timed out.")
      : effectiveInterrupted
        ? undefined
        : boundChildError(finalResult?.error);
  const contextExhaustedReason = finalResult?.protocolOutputLimit
    ? undefined
    : state.contextExhaustedDetected &&
        !timedOut &&
        !effectiveInterrupted &&
        finalResult?.error === CONTEXT_EXHAUSTED_TERMINATION_MESSAGE &&
        terminationReason === "process_exit"
      ? "context_exhausted"
      : classifyContextExhaustedTermination({
          messages: finalResult?.messages,
          // Use only the final attempt for false-success classification;
          // aggregateContextUsage remains the persisted reporting diagnostic.
          contextUsage: state.finalAttemptContextUsage,
          exitCode: effectiveFinalExitCode,
          error: effectiveFinalError,
          terminationReason,
        });
  if (contextExhaustedReason) {
    effectiveFinalExitCode = 1;
    effectiveFinalError = CONTEXT_EXHAUSTED_TERMINATION_MESSAGE;
    terminationReason = contextExhaustedReason;
  }
  return {
    effectiveInterrupted,
    timedOut,
    effectiveFinalExitCode,
    terminationReason,
    effectiveFinalError,
  };
}

function finalizeSingleStepArtifacts(input: {
  step: SubagentStep;
  ctx: SingleStepContext;
  state: SingleStepExecutionState;
  output: SingleStepOutputFinalization;
  outcome: SingleStepOutcome;
  artifactPaths?: ArtifactPaths;
  transcriptWriter?: ChildTranscriptWriter;
  childDeadlineAt?: number;
  task: string;
}): void {
  const {
    step,
    ctx,
    state,
    output,
    outcome,
    artifactPaths,
    transcriptWriter,
    childDeadlineAt,
    task,
  } = input;
  const { finalResult } = state;
  if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
    if (ctx.artifactConfig?.includeOutput !== false) {
      const artifactBaseOutput =
        outcome.effectiveFinalExitCode !== 0 && !outcome.effectiveInterrupted
          ? formatErrorWithOutput(outcome.effectiveFinalError, output.output)
          : output.output;
      writeArtifactWithFloor(
        artifactPaths.outputPath,
        artifactBaseOutput,
        output.rawOutput,
        !!output.resolvedOutput.savedPath,
      );
    }
    if (ctx.artifactConfig?.includeMetadata !== false) {
      fs.writeFileSync(
        artifactPaths.metadataPath,
        JSON.stringify(
          {
            runId: ctx.id,
            agent: step.agent,
            projectAgent: step.projectAgent,
            ...(ctx.artifactConfig.mode !== "compact" ? { task } : {}),
            exitCode: outcome.effectiveFinalExitCode,
            exitSignal: finalResult?.exitSignal,
            model: finalResult?.model,
            modelIdentity: output.finalModelIdentity,
            modelResolution: state.modelResolution,
            attemptedModels: state.attemptedModels.length > 0 ? state.attemptedModels : undefined,
            modelAttempts: state.modelAttempts,
            modelFallbackNotice: output.modelFallbackNotice,
            error: outcome.effectiveFinalError,
            stderr: finalResult?.stderr,
            stderrTruncated: finalResult?.stderrTruncated,
            protocolOutputLimit: finalResult?.protocolOutputLimit,
            terminationReason: outcome.terminationReason,
            contextUsage: state.aggregateContextUsage,
            contextPressure: step.contextPressure,
            contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
            processCleanup: output.processCleanup,
            terminalResult: terminalResultForState(state, terminalStateForOutcome(outcome)),
            ...(transcriptWriter ? { transcriptPath: artifactPaths.transcriptPath } : {}),
            transcriptError: transcriptWriter?.getError(),
            skills: step.skills,
            skillsWarning: step.skillsWarning,
            timeoutMs: ctx.timeoutMs ?? step.timeoutMs,
            deadlineAt: childDeadlineAt,
            timestamp: Date.now(),
          },
          null,
          2,
        ),
        "utf-8",
      );
    }
  }
}

function terminalStateForOutcome(outcome: SingleStepOutcome): SubagentTerminalState {
  if (outcome.effectiveInterrupted) return "paused";
  return outcome.effectiveFinalExitCode === 0 ? "completed" : "failed";
}

function terminalResultForState(
  state: SingleStepExecutionState,
  terminalState: SubagentTerminalState,
): SubagentTerminalResult | undefined {
  if (state.attemptFacts.length === 0) return undefined;
  return {
    state: terminalState,
    facts: { attempts: boundSubagentAttemptFacts(state.attemptFacts) },
  };
}

function cleanupSingleStepSetup(setup: SingleStepSetup): void {
  setup.inheritedTimeoutSignal?.removeEventListener("abort", setup.relayInheritedTimeout);
  setup.parentRegisterTimeout?.(undefined);
}

function buildSingleStepResult(input: {
  step: SubagentStep;
  ctx: SingleStepContext;
  state: SingleStepExecutionState;
  setup: SingleStepSetup;
  output: SingleStepOutputFinalization;
  outcome: SingleStepOutcome;
}): SingleStepResultValue {
  const { step, state, setup, output, outcome } = input;
  const finalResult = state.finalResult;
  return {
    agent: step.agent,
    ...(step.projectAgent ? { projectAgent: step.projectAgent } : {}),
    ...(step.ticketId ? { ticketId: step.ticketId } : {}),
    output: output.outputForSummary,
    finalOutput: output.output,
    skills: step.skills,
    skillsWarning: step.skillsWarning,
    outputMode: step.outputMode,
    savedOutputPath: output.resolvedOutput.savedPath,
    outputReference: output.outputReference,
    outputSaveError: output.resolvedOutput.saveError,
    childLocation: step.childLocation,
    exitCode: outcome.effectiveFinalExitCode,
    exitSignal: finalResult?.exitSignal,
    error: outcome.effectiveFinalError,
    stderr: finalResult?.stderr,
    stderrTruncated: finalResult?.stderrTruncated,
    protocolOutputLimit: finalResult?.protocolOutputLimit,
    sessionFile: step.sessionFile,
    model: output.finalModel,
    modelIdentity: output.finalModelIdentity,
    modelResolution: state.modelResolution,
    attemptedModels: state.attemptedModels.length > 0 ? state.attemptedModels : undefined,
    modelAttempts: state.modelAttempts,
    modelFallbackNotice: output.modelFallbackNotice,
    totalCost: costSummaryFromAttempts(state.modelAttempts),
    artifactPaths: setup.artifactPaths,
    processCleanup: output.processCleanup,
    contextUsage: state.aggregateContextUsage,
    contextPressure: step.contextPressure,
    contextPressureCrossedThresholds: step.contextPressureCrossedThresholds,
    terminationReason: outcome.terminationReason,
    transcriptPath: setup.transcriptWriter ? setup.artifactPaths?.transcriptPath : undefined,
    transcriptError: setup.transcriptWriter?.getError(),
    interrupted: outcome.timedOut ? false : outcome.effectiveInterrupted,
    timedOut: outcome.timedOut ? true : finalResult?.timedOut,
    terminalResult: terminalResultForState(state, terminalStateForOutcome(outcome)),
  };
}

function providerTokensFromRuntimeUsage(
  usage: Pick<SingleStepRuntimeResult["usage"], "input" | "output"> | undefined,
): ProviderTokenUsage {
  if (!usage || usage.input + usage.output <= 0) return { status: "unavailable" };
  return providerTokensFromUsage(usage);
}

/** Do not expose partial provider usage when a bounded attempt range was cut. */
export function providerTokensForAttempt(input: {
  sessionFacts?: Pick<SessionFacts, "truncated" | "hasUsage" | "tokens">;
  runtimeUsage?: Pick<SingleStepRuntimeResult["usage"], "input" | "output">;
}): ProviderTokenUsage {
  if (input.sessionFacts?.truncated) return { status: "unavailable" };
  return input.sessionFacts?.hasUsage
    ? providerTokensFromUsage(input.sessionFacts.tokens)
    : providerTokensFromRuntimeUsage(input.runtimeUsage);
}

function captureAttemptFactsForRun(input: {
  step: SubagentStep;
  ctx: SingleStepContext;
  state: SingleStepExecutionState;
  preparation: SingleStepAttemptPreparation;
  attemptIndex: number;
  run?: SingleStepRuntimeResult;
  effectiveExitCode: number | null;
  effectiveExitSignal?: string | null;
}): SubagentAttemptFacts {
  const { step, ctx, state, preparation, attemptIndex, run } = input;
  const sessionPath = step.sessionFile ?? ctx.sessionDir;
  const sessionFacts = sessionPath
    ? parseSessionFacts(sessionPath, {
        baseline: preparation.sessionBaseline,
        seenToolCallIds: state.seenToolCallIds,
      })
    : undefined;
  if (sessionFacts) {
    for (const id of sessionFacts.toolCallIds) state.seenToolCallIds.add(id);
  }
  const requestedToolCalls = sessionFacts?.requestedToolCalls ?? {
    edit: 0,
    write: 0,
    bash: 0,
  };
  const providerTokens = providerTokensForAttempt({
    sessionFacts,
    runtimeUsage: run?.usage,
  });
  const endedAt = Date.now();
  const durationMs = Math.max(0, performance.now() - preparation.monotonicStartedAt);
  const facts = captureSubagentAttemptFacts({
    attempt: attemptIndex,
    cwd: path.resolve(step.cwd ?? ctx.cwd),
    baseline: preparation.baseline,
    startedAt: preparation.startedAt,
    endedAt,
    durationMs,
    exitCode: input.effectiveExitCode,
    exitSignal: input.effectiveExitSignal,
    providerTokens,
    requestedToolCalls,
    asyncDir: ctx.asyncDir,
    stepIndex: ctx.flatIndex,
  });
  state.attemptFacts = appendBoundedSubagentAttemptFact(state.attemptFacts, facts);
  return facts;
}

/** Run a single pi agent step, returning output and metadata */
export async function runSingleStep(
  step: SubagentStep,
  ctx: SingleStepContext,
  appendDiagnosticJsonl: AppendDiagnosticJsonl,
): Promise<SingleStepResultValue> {
  const setup = prepareSingleStepSetup(step, ctx);
  const stepCtx = setup.ctx;
  const state = setup.state;

  for (let index = 0; index < state.candidates.length; index++) {
    if (stepCtx.timeoutSignal?.aborted) break;
    const candidate = state.candidates[index];
    const attempt = prepareSingleStepAttempt({
      step,
      ctx: stepCtx,
      state,
      candidate,
      index,
      task: setup.promptTask,
      sessionEnabled: setup.sessionEnabled,
      sessionDir: setup.sessionDir,
    });
    if (attempt.buildError) {
      const attemptResult: ModelAttempt = {
        model: candidate ?? step.model ?? "default",
        success: false,
        exitCode: 1,
        error: attempt.buildError,
        usage: emptyUsage(),
      };
      state.modelAttempts.push(attemptResult);
      if (candidate) state.attemptedModels.push(candidate);
      state.finalOutputSnapshot = attempt.outputSnapshot;
      state.finalResult = {
        stderr: "",
        exitCode: 1,
        messages: [],
        usage: emptyUsage(),
        model: candidate,
        configuredModel: candidate,
        error: attempt.buildError,
        finalOutput: attempt.buildError,
      };
      const facts = captureAttemptFactsForRun({
        step,
        ctx: stepCtx,
        state,
        preparation: attempt,
        attemptIndex: state.attemptFacts.length + 1,
        effectiveExitCode: 1,
      });
      stepCtx.onAttemptEnd?.(facts);
      break;
    }
    const attemptDeadlineAt = attempt.attemptDeadlineAt;
    const childDeadlineAt = attempt.childDeadlineAt;
    const attemptOwnsDeadline =
      step.timeoutOwner !== "run" &&
      attemptDeadlineAt !== undefined &&
      (stepCtx.deadlineAt === undefined || attemptDeadlineAt <= stepCtx.deadlineAt);
    setup.childDeadlineAt = childDeadlineAt;
    const attemptTimeoutTimer =
      childDeadlineAt !== undefined
        ? scheduleDeadline(childDeadlineAt, () => {
            setup.triggerTimeout();
          })
        : undefined;
    let stopAttempt = false;
    let attemptFacts: SubagentAttemptFacts | undefined;
    let completedRun: SingleStepRuntimeResult | undefined;
    try {
      // Keep this await in runSingleStep: settling a child attempt must not gain
      // a promise continuation from an extracted async helper.
      const run = await runPiStreaming(
        attempt.args!,
        path.resolve(step.cwd ?? stepCtx.cwd),
        stepCtx.outputFile,
        appendDiagnosticJsonl,
        attempt.env,
        stepCtx.piPackageRoot,
        stepCtx.piArgv1,
        step.maxSubagentDepth,
        {
          eventsPath: setup.eventsPath,
          runId: stepCtx.id,
          stepIndex: stepCtx.flatIndex,
          agent: step.agent,
          includeChildEventProjections: stepCtx.artifactConfig.includeChildEventProjections,
        },
        stepCtx.registerInterrupt,
        stepCtx.onChildEvent,
        setup.transcriptWriter,
        stepCtx.registerTimeout,
        attemptOwnsDeadline
          ? `Subagent timed out after ${step.timeoutMs}ms.`
          : stepCtx.timeoutMessage,
        stepCtx.onChildProtocolOutputLimit,
        {
          restored: setup.restoredSession,
          configuredModel: candidate,
          contextWindow: contextWindowForModel(candidate, step.contextWindows),
          contextWindows: step.contextWindows,
        },
      );
      completedRun = run;
      const assessment = assessSingleStepAttempt({
        step,
        state,
        run,
        candidate,
        outputSnapshot: attempt.outputSnapshot,
        tempDir: attempt.tempDir,
      });
      stopAttempt = shouldStopSingleStepAttempt({
        run,
        ctx: stepCtx,
        attempt: assessment.attempt,
        index,
        candidateCount: state.candidates.length,
      });
      if (!stopAttempt) {
        state.attemptNotes.push(
          formatModelAttemptNote(assessment.attempt, state.candidates[index + 1]),
        );
      }
      attemptFacts = captureAttemptFactsForRun({
        step,
        ctx: stepCtx,
        state,
        preparation: attempt,
        attemptIndex: state.attemptFacts.length + 1,
        run,
        effectiveExitCode: assessment.attempt.exitCode ?? null,
        effectiveExitSignal: run.exitSignal,
      });
    } finally {
      attemptTimeoutTimer?.cancel();
      // End operation-scoped health state before a fallback can start or the
      // step settles. The runner owns the transition and persistence callback.
      if (!attemptFacts) {
        attemptFacts = captureAttemptFactsForRun({
          step,
          ctx: stepCtx,
          state,
          preparation: attempt,
          attemptIndex: state.attemptFacts.length + 1,
          run: completedRun,
          effectiveExitCode: completedRun?.exitCode ?? null,
          effectiveExitSignal: completedRun?.exitSignal,
        });
      }
      stepCtx.onAttemptEnd?.(attemptFacts);
    }
    if (stopAttempt) break;
  }

  const output = finalizeSingleStepOutput({ step, state });
  const outcome = finalizeSingleStepOutcome({
    ctx: stepCtx,
    state,
  });
  finalizeSingleStepArtifacts({
    step,
    ctx: stepCtx,
    state,
    output,
    outcome,
    artifactPaths: setup.artifactPaths,
    transcriptWriter: setup.transcriptWriter,
    childDeadlineAt: setup.childDeadlineAt,
    task: setup.task,
  });
  cleanupSingleStepSetup(setup);
  return buildSingleStepResult({
    step,
    ctx: stepCtx,
    state,
    setup,
    output,
    outcome,
  });
}
