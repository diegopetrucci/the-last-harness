/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import {
  ensureArtifactsDir,
  getArtifactPaths,
  writeArtifact,
  writeArtifactWithFloor,
  writeMetadata,
} from "../../shared/artifacts.ts";
import {
  createChildTranscriptWriter,
  type ChildTranscriptWriter,
} from "../../shared/child-transcript.ts";
import {
  type AgentProgress,
  type ArtifactPaths,
  type ContextPressureProjection,
  type ContextPressureThreshold,
  type ControlEvent,
  type ModelAttempt,
  type RunSyncOptions,
  type SingleResult,
  type SubagentModelIdentity,
  type AcceptanceLedger,
  type ResolvedAcceptanceConfig,
  type Usage,
  DEFAULT_MAX_OUTPUT,
  truncateOutput,
  getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
  DEFAULT_CONTROL_CONFIG,
  buildControlEvent,
  claimControlNotification,
  deriveActivityState,
  shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
  getFinalOutput,
  findLatestSessionFile,
  detectSubagentError,
  extractToolArgsPreview,
  extractTextFromContent,
  formatErrorWithOutput,
  synthesizeChildExitDiagnostic,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import {
  CHILD_PROTOCOL_HARD_KILL_GRACE_MS,
  appendBoundedChildMessage,
  boundChildError,
  boundChildStderrError,
  claimChildTerminalReason,
  childUsageNumber,
  createBoundedByteTail,
  createBoundedLineReader,
  formatBoundedStderr,
  formatProtocolOutputLimit,
  parseChildProtocolInput,
  type ChildTerminalReasonLatch,
  type ProtocolOutputLimit,
} from "../shared/child-protocol.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { buildSubagentSpawnEnv, getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { appendRecentProgressItem } from "../../shared/recent-progress.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { scheduleDeadline, type DeadlineTimer } from "../shared/deadline-timer.ts";
import {
  applyThinkingSuffix,
  buildPiArgs,
  cleanupTempDir,
  getThinkingLevelDropNote,
} from "../shared/pi-args.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import {
  captureSingleOutputSnapshot,
  formatSavedOutputReference,
  injectOutputPathSystemPrompt,
  resolveSingleOutput,
  validateFileOnlyOutputMode,
  type SingleOutputSnapshot,
} from "../shared/single-output.ts";
import {
  buildFallbackModelList,
  buildModelCandidatePlan,
  appendRuntimeFallbackResolution,
  canonicalSubagentModelIdentity,
  combineModelFallbackNotices,
  formatModelAttemptNote,
  isRetryableModelFailure,
  sanitizeModelFallbackNotice,
} from "../shared/model-fallback.ts";
import { isCanonicalPackagedMinorAgent } from "../../../../shared/project-agent-guidance.ts";
import {
  createMutatingFailureState,
  didMutatingToolFail,
  isMutatingTool,
  nextLongRunningTrigger,
  recordMutatingFailure,
  resetMutatingFailureState,
  resolveCurrentPath,
  shouldEscalateMutatingFailures,
  summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import {
  acceptanceFailureMessage,
  appendAcceptanceReportDigest,
  buildSkippedAcceptanceLedger,
  composeAcceptanceFailureError,
  evaluateAcceptance,
  formatAcceptancePrompt,
  parseAndStripAcceptanceReport,
  resolveEffectiveAcceptance,
} from "../shared/acceptance.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { boundSupervisorSummary } from "../shared/lifecycle-state.ts";
import {
  FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE,
  formatForegroundSupervisorPauseMessage,
} from "../../shared/foreground-pause.ts";
import { resolveSupervisorChannelDir } from "../../supervisor/native-supervisor-channel.ts";
import {
  cleanupOwnedProcessGroup,
  skipOwnedProcessGroupCleanup,
  supportsOwnedProcessGroupCleanup,
} from "../shared/process-group-cleanup.ts";
import {
  assistantStopReason,
  classifyContextExhaustedTermination,
  CONTEXT_EXHAUSTED_TERMINATION_MESSAGE,
  hasUsableSessionArtifact,
  mergeContextUsageDiagnostics,
  resolveEffectiveContextWindow,
  resolveSubagentTerminationReason,
  updateContextUsageDiagnostics,
  detectContextPressureCrossing,
  formatContextPressureGuidance,
  parseContextPressureCrossedThresholds,
  parseContextPressureProjection,
} from "../../shared/context-diagnostics.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();
const FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE =
  "Foreground pause process cleanup could not be confirmed. Status does not claim the child stopped.";

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.turns += source.turns;
}

function finalAssistantStopReason(messages: Message[] | undefined): string | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index--) {
    const stopReason = assistantStopReason(messages![index]);
    if (stopReason !== undefined) return stopReason;
  }
  return undefined;
}

function finalizeTerminationReason(result: SingleResult): void {
  if (result.protocolOutputLimit) {
    result.terminationReason = "output_limit";
    return;
  }
  result.terminationReason = resolveSubagentTerminationReason({
    cancelled: Boolean(result.cancel),
    paused: Boolean(result.pause),
    timedOut: result.timedOut,
    toolBudgetBlocked: result.toolBudgetBlocked,
    interrupted: result.interrupted,
    assistantStopReason: finalAssistantStopReason(result.messages),
    effectiveExitCode: result.exitCode,
    processCompleted: true,
  });
}

function formatTimeoutMessage(timeoutMs: number): string {
  return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveEffectiveSingleTimeout(
  callerTimeoutMs: number | undefined,
  agentTimeoutCeilingMs: number | undefined,
): number | undefined {
  if (callerTimeoutMs === undefined) return agentTimeoutCeilingMs;
  if (agentTimeoutCeilingMs === undefined) return callerTimeoutMs;
  return Math.min(callerTimeoutMs, agentTimeoutCeilingMs);
}

function resolveEffectiveTimeoutDeadline(
  deadlineAt: number | undefined,
  timeoutMs: number | undefined,
): number | undefined {
  if (timeoutMs === undefined) return deadlineAt;
  const timeoutDeadlineAt = Date.now() + timeoutMs;
  if (deadlineAt === undefined) return timeoutDeadlineAt;
  return Math.min(deadlineAt, timeoutDeadlineAt);
}

const TIMEOUT_RECENT_OUTPUT_LINES = 5;
const TIMEOUT_RECENT_TOOLS = 3;
const TIMEOUT_LINE_MAX_CHARS = 160;

function truncateDiagnosticLine(value: string, maxChars = TIMEOUT_LINE_MAX_CHARS): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatTimeoutDiagnostics(
  result: SingleResult,
  options: RunSyncOptions,
  artifactPaths?: ArtifactPaths,
): string {
  const timeoutMessage = result.error ?? formatTimeoutMessage(options.timeoutMs ?? 0);
  const progress = result.progress;
  const details: string[] = [];
  const recentTools = progress?.recentTools.slice(-TIMEOUT_RECENT_TOOLS) ?? [];
  const recentOutput =
    progress?.recentOutput
      .filter((line) => typeof line === "string" && line.trim().length > 0)
      .slice(-TIMEOUT_RECENT_OUTPUT_LINES)
      .map((line) => truncateDiagnosticLine(line)) ?? [];

  if (options.runId) details.push(`Run id: ${options.runId}`);
  details.push(`Agent: ${result.agent}`);
  if (options.index !== undefined) details.push(`Child index: ${options.index}`);
  if (typeof progress?.durationMs === "number" && Number.isFinite(progress.durationMs)) {
    details.push(`Elapsed: ${progress.durationMs}ms`);
  }
  if (result.sessionFile) details.push(`Session file: ${result.sessionFile}`);
  if (options.artifactConfig?.includeOutput !== false && artifactPaths?.outputPath) {
    details.push(`Artifact output: ${artifactPaths.outputPath}`);
  }
  if (options.artifactConfig?.includeJsonl !== false && artifactPaths?.jsonlPath) {
    details.push(`Artifact jsonl: ${artifactPaths.jsonlPath}`);
  }
  if (progress?.activityState) details.push(`Activity: ${progress.activityState}`);
  if (progress?.currentTool) details.push(`Current tool: ${progress.currentTool}`);
  if (progress?.currentPath) details.push(`Current path: ${progress.currentPath}`);

  const sections = [
    timeoutMessage,
    "",
    "Recovery diagnostics:",
    ...details.map((detail) => `- ${detail}`),
  ];
  if (recentTools.length > 0) {
    sections.push("", "Recent tools:");
    for (const tool of recentTools) {
      const suffix = tool.args ? ` ${truncateDiagnosticLine(tool.args)}` : "";
      sections.push(`- ${tool.tool}${suffix}`);
    }
  }
  if (recentOutput.length > 0) {
    sections.push("", "Recent child output:");
    for (const line of recentOutput) sections.push(`- ${line}`);
  }
  sections.push(
    "",
    "Recovery guidance:",
    "- Inspect the session/jsonl artifacts above for the full transcript.",
    "- Re-dispatch or resume the subagent after addressing the blocking tool, path, or workspace state.",
  );
  return sections.join("\n");
}

function resolveAttemptTimeout(
  options: RunSyncOptions,
): { timeoutMs: number; deadlineAt: number; remainingMs: number; message: string } | undefined {
  if (options.timeoutMs === undefined) return undefined;
  const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
  return {
    timeoutMs: options.timeoutMs,
    deadlineAt,
    remainingMs: Math.max(0, deadlineAt - Date.now()),
    message: formatTimeoutMessage(options.timeoutMs),
  };
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
  if (lines.length === 0) return;
  progress.recentOutput.push(...lines.filter((line) => line.trim()));
  if (progress.recentOutput.length > 50) {
    progress.recentOutput.splice(0, progress.recentOutput.length - 50);
  }
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
  for (const message of messages ?? []) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") {
        part.text = parseAndStripAcceptanceReport(part.text).stripped;
      }
    }
  }
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
  return {
    ...progress,
    skills: progress.skills ? [...progress.skills] : undefined,
    recentTools: progress.recentTools.map((tool) => ({ ...tool })),
    recentOutput: [...progress.recentOutput],
  };
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
  return {
    ...result,
    messages:
      result.outputMode === "file-only" && result.savedOutputPath
        ? undefined
        : result.messages
          ? [...result.messages]
          : undefined,
    usage: { ...result.usage },
    contextPressure: result.contextPressure ? { ...result.contextPressure } : undefined,
    contextPressureCrossedThresholds: result.contextPressureCrossedThresholds
      ? [...result.contextPressureCrossedThresholds]
      : undefined,
    skills: result.skills ? [...result.skills] : undefined,
    attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
    modelAttempts: result.modelAttempts
      ? result.modelAttempts.map((attempt) => ({
          ...attempt,
          usage: attempt.usage ? { ...attempt.usage } : undefined,
        }))
      : undefined,
    controlEvents: result.controlEvents
      ? result.controlEvents.map((event) => ({ ...event }))
      : undefined,
    progress,
    progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
    artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
    truncation: result.truncation ? { ...result.truncation } : undefined,
    outputReference: result.outputReference ? { ...result.outputReference } : undefined,
  };
}

function findSupervisorRequestMetadata(input: {
  runId: string;
  agent: string;
  index: number;
  reason?: "need_decision" | "interview_request";
  requestedAt: number;
}): { requestId?: string; summary?: string } {
  try {
    const requestsDir = path.join(
      resolveSupervisorChannelDir(input.runId, input.agent, input.index),
      "requests",
    );
    const files = readdirSync(requestsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(requestsDir, name));
    for (const file of files) {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
        id?: unknown;
        runId?: unknown;
        agent?: unknown;
        childIndex?: unknown;
        reason?: unknown;
        message?: unknown;
        createdAt?: unknown;
      };
      if (
        parsed.runId !== input.runId ||
        parsed.agent !== input.agent ||
        parsed.childIndex !== input.index
      )
        continue;
      if (input.reason && parsed.reason !== input.reason) continue;
      const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : undefined;
      if (createdAt !== undefined && createdAt + 5_000 < input.requestedAt) continue;
      return {
        ...(typeof parsed.id === "string" && parsed.id ? { requestId: parsed.id } : {}),
        ...(boundSupervisorSummary(parsed.message)
          ? { summary: boundSupervisorSummary(parsed.message) }
          : {}),
      };
    }
  } catch {
    // Best-effort metadata capture only.
  }
  return {};
}

function resolveSupervisorPauseMetadata(input: {
  runId: string;
  agent: string;
  index: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  requestedAt: number;
}): SingleResult["pause"] | undefined {
  if (
    input.toolName === "contact_supervisor" &&
    (input.toolArgs.reason === "need_decision" || input.toolArgs.reason === "interview_request")
  ) {
    const request = findSupervisorRequestMetadata({
      runId: input.runId,
      agent: input.agent,
      index: input.index,
      reason: input.toolArgs.reason,
      requestedAt: input.requestedAt,
    });
    const summary = request.summary ?? boundSupervisorSummary(input.toolArgs.message);
    return {
      kind: "awaiting_supervisor",
      requestedAt: input.requestedAt,
      ...(summary ? { summary } : {}),
      request: {
        tool: "contact_supervisor",
        reason: input.toolArgs.reason,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        ...(summary ? { summary } : {}),
      },
    };
  }
  return undefined;
}

function resolveResultSessionFile(
  result: SingleResult,
  options: RunSyncOptions,
  shareEnabled: boolean,
): void {
  if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
    result.sessionFile = options.sessionFile;
  } else if (shareEnabled && options.sessionDir) {
    const sessionFile = findLatestSessionFile(options.sessionDir);
    if (sessionFile) result.sessionFile = sessionFile;
  }
}

type ForegroundArtifactSetup = {
  artifactPathsResult?: ArtifactPaths;
  jsonlPath?: string;
  transcriptWriter?: ChildTranscriptWriter;
};

function setupForegroundArtifacts(
  runtimeCwd: string,
  agentName: string,
  taskWithAcceptance: string,
  options: RunSyncOptions,
): ForegroundArtifactSetup {
  let artifactPathsResult: ArtifactPaths | undefined;
  let jsonlPath: string | undefined;
  let transcriptWriter: ChildTranscriptWriter | undefined;
  if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
    artifactPathsResult = getArtifactPaths(
      options.artifactsDir,
      options.runId,
      agentName,
      options.index,
    );
    ensureArtifactsDir(options.artifactsDir);
    if (options.artifactConfig?.includeInput !== false) {
      writeArtifact(
        artifactPathsResult.inputPath,
        `# Task for ${agentName}\n\n${taskWithAcceptance}`,
      );
    }
    if (options.artifactConfig?.includeJsonl !== false) {
      jsonlPath = artifactPathsResult.jsonlPath;
    }
    if (options.artifactConfig?.includeTranscript !== false) {
      transcriptWriter = createChildTranscriptWriter({
        transcriptPath: artifactPathsResult.transcriptPath,
        source: "foreground",
        runId: options.runId,
        agent: agentName,
        childIndex: options.index,
        cwd: options.cwd ?? runtimeCwd,
      });
      transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
    }
  }
  return { artifactPathsResult, jsonlPath, transcriptWriter };
}

type SingleAttemptFinalizationInput = {
  result: SingleResult;
  progress: AgentProgress;
  startTime: number;
  agent: AgentConfig;
  task: string;
  options: RunSyncOptions;
  sessionEnabled: boolean;
  originalTask?: string;
  outputSnapshot?: SingleOutputSnapshot;
  supervisorPauseRequested: boolean;
  interruptedByControl: boolean;
  observedMutationAttempt: boolean;
  allControlEvents: ControlEvent[];
  emitControlEvent: (event: ControlEvent) => void;
};

function normalizeSingleAttemptResult(result: SingleResult, options: RunSyncOptions): void {
  if (result.error && result.exitCode === 0) {
    result.exitCode = 1;
  }
  if (result.exitCode !== 0 && !result.error) {
    result.error = synthesizeChildExitDiagnostic({
      exitCode: result.exitCode,
      signal: result.exitSignal,
    });
  }
  if (result.exitCode === 0 && !result.error) {
    const errInfo = detectSubagentError(result.messages ?? []);
    if (errInfo.hasError) {
      result.exitCode = errInfo.exitCode ?? 1;
      result.error = boundChildError(
        errInfo.details
          ? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
          : `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`,
      );
    }
  }
  const preNormalizationTerminationReason = result.protocolOutputLimit
    ? "output_limit"
    : result.timedOut
      ? "timed_out"
      : result.toolBudgetBlocked
        ? "tool_budget_blocked"
        : result.interrupted
          ? "interrupted"
          : "completed";
  const contextExhaustedSignature = classifyContextExhaustedTermination({
    messages: result.messages,
    contextUsage: result.contextUsage,
    exitCode: result.exitCode,
    error: result.error,
    // At this pre-normalization point a zero-exit, error-free child is the
    // completed candidate; later post-processing may otherwise rewrite the
    // reason to process_exit before the narrow empty-terminal check runs.
    terminationReason: preNormalizationTerminationReason,
  });
  if (result.exitCode === 0 && !result.error) {
    const finalText = getFinalOutput(result.messages ?? []);
    const missingStructuredOutput = options.structuredOutput
      ? !existsSync(options.structuredOutput.outputPath)
      : false;
    if (
      !contextExhaustedSignature &&
      !finalText?.trim() &&
      (!options.structuredOutput || missingStructuredOutput)
    ) {
      result.exitCode = 1;
      result.error = "Subagent produced no output (possible model cold-start or empty response).";
    }
  }
  if (options.structuredOutput && result.exitCode === 0 && !result.error) {
    const structured = readStructuredOutput({
      schema: options.structuredOutput.schema,
      schemaPath: options.structuredOutput.schemaPath,
      outputPath: options.structuredOutput.outputPath,
    });
    result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
    result.structuredOutputPath = options.structuredOutput.outputPath;
    if (structured.error) {
      result.exitCode = 1;
      result.error = structured.error;
    } else {
      result.structuredOutput = structured.value;
    }
  }
}

function finalizeSingleAttemptOutput(input: SingleAttemptFinalizationInput): SingleResult {
  const {
    result,
    progress,
    agent,
    task,
    options,
    originalTask,
    outputSnapshot,
    observedMutationAttempt,
    allControlEvents,
    emitControlEvent,
  } = input;
  const acceptanceOutput = getFinalOutput(result.messages ?? []);
  const acceptanceParsed = parseAndStripAcceptanceReport(acceptanceOutput);
  const { report: finalAcceptanceReport } = acceptanceParsed;
  let fullOutput = result.protocolOutputLimit
    ? boundChildError(formatProtocolOutputLimit(result.protocolOutputLimit))
    : acceptanceParsed.stripped;
  if (result.timedOut) {
    const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
    fullOutput = fullOutput.trim()
      ? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
      : timeoutMessage;
  }
  const completionGuard =
    result.exitCode === 0 && !result.error && agent.completionGuard !== false
      ? evaluateCompletionMutationGuard({
          agent: agent.name,
          task: originalTask ?? task,
          messages: result.messages ?? [],
          tools: agent.tools,
        })
      : undefined;
  if (completionGuard?.triggered && !observedMutationAttempt) {
    result.exitCode = 1;
    result.error =
      "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
    progress.status = "failed";
    progress.error = result.error;
    emitControlEvent(
      buildControlEvent({
        from: progress.activityState,
        to: "needs_attention",
        runId: options.runId ?? agent.name,
        agent: agent.name,
        index: options.index,
        ts: Date.now(),
        message: `${agent.name} completed without making edits for an implementation task`,
        reason: "completion_guard",
      }),
    );
  }
  if (options.outputPath && result.exitCode === 0) {
    const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, outputSnapshot);
    fullOutput = parseAndStripAcceptanceReport(resolvedOutput.fullOutput).stripped;
    result.savedOutputPath = resolvedOutput.savedPath;
    result.outputSaveError = resolvedOutput.saveError;
    if (resolvedOutput.savedPath) {
      result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
    }
  }
  // The artifact file is the supervisor-facing surface (it is what gets read back
  // as *_output.md). Append the validation-evidence digest there only, so the
  // acceptance evidence survives the strip without touching result.finalOutput,
  // which is a semantic value feeding user-requested output files and
  // chain/parallel output references.
  //
  // Exception: when the run saved a user-requested output file, the artifact is a
  // verbatim archive of that deliverable, so it stays byte-exact.
  const artifactBaseOutput = result.timedOut
    ? fullOutput
    : result.exitCode !== 0 && !result.interrupted
      ? formatErrorWithOutput(result.error, fullOutput)
      : fullOutput;
  artifactOutputByResult.set(
    result,
    finalAcceptanceReport && !result.savedOutputPath
      ? appendAcceptanceReportDigest(artifactBaseOutput, finalAcceptanceReport)
      : artifactBaseOutput,
  );
  acceptanceOutputByResult.set(result, acceptanceOutput);
  result.outputMode = options.outputMode ?? "inline";
  const preservedFinalOutput = result.finalOutput;
  result.finalOutput =
    options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
      ? result.outputReference.message
      : fullOutput;
  if (
    result.exitCode !== 0 &&
    !result.finalOutput.trim() &&
    typeof preservedFinalOutput === "string" &&
    preservedFinalOutput.trim()
  ) {
    result.finalOutput = preservedFinalOutput;
  }
  if (result.error) {
    result.error = boundChildError(result.error);
    progress.error = result.error;
  }
  result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
  finalizeTerminationReason(result);
  if (options.onUpdate) {
    const finalText = result.finalOutput || result.error || "(no output)";
    const progressSnapshot = snapshotProgress(progress);
    const resultSnapshot = snapshotResult(result, progressSnapshot);
    options.onUpdate({
      content: [{ type: "text", text: finalText }],
      details: {
        mode: "single",
        results: [resultSnapshot],
        progress: [progressSnapshot],
        controlEvents: allControlEvents.length ? allControlEvents : undefined,
      },
    });
  }
  return result;
}

function finalizeSingleAttempt(input: SingleAttemptFinalizationInput): SingleResult {
  const {
    result,
    progress,
    startTime,
    agent,
    options,
    sessionEnabled,
    supervisorPauseRequested,
    interruptedByControl,
  } = input;
  if (!result.protocolOutputLimit && supervisorPauseRequested) {
    resolveResultSessionFile(result, options, sessionEnabled);
    result.exitCode = 0;
    result.interrupted = true;
    result.error = undefined;
    if (result.pause) result.pause = { ...result.pause, ownerPid: undefined };
    result.finalOutput =
      result.finalOutput ||
      formatForegroundSupervisorPauseMessage({
        headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
        runId: options.runId,
        agent: agent.name,
        requestSummary: result.pause?.summary,
      });
    result.controlEvents = input.allControlEvents.length ? input.allControlEvents : undefined;
    progress.activityState = undefined;
    progress.durationMs = Date.now() - startTime;
    result.progressSummary = {
      toolCount: progress.toolCount,
      tokens: progress.tokens,
      durationMs: progress.durationMs,
    };
    return result;
  }
  if (!result.protocolOutputLimit && interruptedByControl) {
    resolveResultSessionFile(result, options, sessionEnabled);
    result.exitCode = 0;
    result.interrupted = true;
    result.error = undefined;
    result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
    result.controlEvents = input.allControlEvents.length ? input.allControlEvents : undefined;
    progress.activityState = undefined;
    progress.durationMs = Date.now() - startTime;
    result.progressSummary = {
      toolCount: progress.toolCount,
      tokens: progress.tokens,
      durationMs: progress.durationMs,
    };
    return result;
  }
  normalizeSingleAttemptResult(result, options);

  progress.status = result.exitCode === 0 ? "completed" : "failed";
  progress.durationMs = Date.now() - startTime;
  if (result.error) {
    progress.error = result.error;
    if (progress.currentTool) {
      progress.failedTool = progress.currentTool;
    }
  }

  result.progressSummary = {
    toolCount: progress.toolCount,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
  };

  return finalizeSingleAttemptOutput(input);
}

type ForegroundRunFinalizationInput = {
  result: SingleResult;
  options: RunSyncOptions;
  shareEnabled: boolean;
  artifactPathsResult?: ArtifactPaths;
  transcriptWriter?: ChildTranscriptWriter;
};

function prepareForegroundRunFinalization(input: ForegroundRunFinalizationInput): void {
  const { result, options, shareEnabled, artifactPathsResult, transcriptWriter } = input;
  resolveResultSessionFile(result, options, shareEnabled);
  if (result.timedOut) {
    const timeoutDiagnostics = formatTimeoutDiagnostics(
      result,
      options,
      artifactPathsResult ?? result.artifactPaths,
    );
    result.finalOutput = timeoutDiagnostics;
    // Append the acceptance digest to the artifact copy only; result.finalOutput must
    // remain exactly timeoutDiagnostics so it does not corrupt output-file or chain
    // output references. The savedOutputPath exception (no digest) is preserved.
    // Parse with the trailing-fence rule so the digest describes the same fence
    // the gate will evaluate.
    const storedAcceptanceOutput = acceptanceOutputByResult.get(result);
    const timeoutReport = storedAcceptanceOutput
      ? parseAndStripAcceptanceReport(storedAcceptanceOutput).report
      : undefined;
    artifactOutputByResult.set(
      result,
      timeoutReport && !result.savedOutputPath
        ? appendAcceptanceReportDigest(timeoutDiagnostics, timeoutReport)
        : timeoutDiagnostics,
    );
  }
  if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
  if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();
  finalizeTerminationReason(result);
}

type SingleAcceptanceEvaluationInput = {
  result: SingleResult;
  effectiveAcceptance: ResolvedAcceptanceConfig;
  options: RunSyncOptions;
  runtimeCwd: string;
};

type SingleAcceptanceEvaluation = {
  interruptedAcceptance: AcceptanceLedger;
  acceptance: AcceptanceLedger | Promise<AcceptanceLedger>;
};

function evaluateSingleAcceptance(
  input: SingleAcceptanceEvaluationInput,
): SingleAcceptanceEvaluation {
  const { result, effectiveAcceptance, options, runtimeCwd } = input;
  const interruptedAcceptance = buildSkippedAcceptanceLedger({
    acceptance: effectiveAcceptance,
    ledgerStatus: "skipped",
    runtimeCheckStatus: "not-applicable",
    id: "paused",
    message:
      "Acceptance was not evaluated because the run was paused/interrupted and will be evaluated on resumed completion.",
  });
  const interruptedBeforeAcceptance =
    !result.protocolOutputLimit &&
    (result.interrupted || options.interruptSignal?.aborted === true);
  if (result.timedOut) {
    return {
      interruptedAcceptance,
      acceptance: buildSkippedAcceptanceLedger({
        acceptance: effectiveAcceptance,
        ledgerStatus: "rejected",
        runtimeCheckStatus: "failed",
        id: "timeout",
        message: "Acceptance was not evaluated because the subagent timed out.",
      }),
    };
  }
  if (interruptedBeforeAcceptance) {
    return { interruptedAcceptance, acceptance: interruptedAcceptance };
  }
  return {
    interruptedAcceptance,
    acceptance: evaluateAcceptance({
      acceptance: effectiveAcceptance,
      output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
      cwd: options.cwd ?? runtimeCwd,
      signal: options.interruptSignal,
      abortMessage: "Interrupted. Waiting for explicit next action.",
    }),
  };
}

type ForegroundArtifactFinalizationInput = {
  result: SingleResult;
  options: RunSyncOptions;
  artifactPathsResult?: ArtifactPaths;
  transcriptWriter?: ChildTranscriptWriter;
  agentName: string;
  task: string;
  finalAttemptContextUsage?: SingleResult["contextUsage"];
};

function finalizeForegroundArtifacts(input: ForegroundArtifactFinalizationInput): void {
  const {
    result,
    options,
    artifactPathsResult,
    transcriptWriter,
    agentName,
    task,
    finalAttemptContextUsage,
  } = input;
  finalizeTerminationReason(result);
  // Classify from raw model messages before acceptance-report stripping can turn
  // a report-only terminal assistant message into empty text.
  const contextExhaustedReason = result.protocolOutputLimit
    ? undefined
    : classifyContextExhaustedTermination({
        messages: result.messages,
        // Classification belongs to the final model attempt. Keep the aggregate
        // diagnostics on the result for reporting and durable artifacts.
        contextUsage: finalAttemptContextUsage,
        exitCode: result.exitCode,
        error: result.error,
        terminationReason: result.terminationReason,
      });
  if (contextExhaustedReason) {
    result.exitCode = 1;
    result.error = CONTEXT_EXHAUSTED_TERMINATION_MESSAGE;
    result.terminationReason = contextExhaustedReason;
    if (result.progress) {
      result.progress.status = "failed";
      result.progress.error = result.error;
    }
    artifactOutputByResult.set(
      result,
      formatErrorWithOutput(result.error, result.finalOutput ?? ""),
    );
  }
  if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
    result.artifactPaths = artifactPathsResult;
    if (options.artifactConfig?.includeOutput !== false) {
      writeArtifactWithFloor(
        artifactPathsResult.outputPath,
        artifactOutputByResult.get(result) ?? result.finalOutput ?? "",
        acceptanceOutputByResult.get(result) ?? "",
        !!result.savedOutputPath,
      );
    }
    if (options.maxOutput) {
      const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
      const truncationResult = truncateOutput(
        result.finalOutput ?? "",
        config,
        artifactPathsResult.outputPath,
      );
      if (truncationResult.truncated) result.truncation = truncationResult;
    }
  } else if (options.maxOutput) {
    const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
    const truncationResult = truncateOutput(result.finalOutput ?? "", config);
    if (truncationResult.truncated) result.truncation = truncationResult;
  }
  stripAcceptanceReportsFromMessages(result.messages);
  if (
    artifactPathsResult &&
    options.artifactConfig?.enabled !== false &&
    options.artifactConfig?.includeMetadata !== false
  ) {
    // Acceptance can change exitCode, error, interruption, and therefore the
    // canonical termination reason. Write metadata only after that finalization
    // so recovery observes the same terminal result returned to the caller.
    writeMetadata(artifactPathsResult.metadataPath, {
      runId: options.runId,
      agent: agentName,
      projectAgent: result.projectAgent,
      task,
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      timedOut: result.timedOut,
      terminationReason: result.terminationReason,
      contextUsage: result.contextUsage,
      contextPressure: result.contextPressure,
      contextPressureCrossedThresholds: result.contextPressureCrossedThresholds,
      ...(result.timedOut && result.sessionFile && existsSync(result.sessionFile)
        ? { sessionFile: result.sessionFile }
        : {}),
      usage: result.usage,
      model: result.model,
      thinking: result.thinking,
      modelIdentity: result.modelIdentity,
      modelResolution: result.modelResolution,
      attemptedModels: result.attemptedModels,
      modelAttempts: result.modelAttempts,
      modelFallbackNotice: result.modelFallbackNotice,
      durationMs: result.progressSummary?.durationMs,
      activeRuntimeMs: result.activeRuntimeMs,
      timeoutMs: options.timeoutMs,
      deadlineAt: options.deadlineAt,
      toolCount: result.progressSummary?.toolCount,
      error: result.error,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated,
      protocolOutputLimit: result.protocolOutputLimit,
      ...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
      transcriptError: result.transcriptError,
      skills: result.skills,
      skillsWarning: result.skillsWarning,
      timestamp: Date.now(),
    });
  }
}

async function runSingleAttempt(
  runtimeCwd: string,
  agent: AgentConfig,
  task: string,
  model: string | undefined,
  options: RunSyncOptions,
  shared: {
    sessionEnabled: boolean;
    systemPrompt: string;
    resolvedSkillNames?: string[];
    skillsWarning?: string;
    jsonlPath?: string;
    artifactPaths?: ArtifactPaths;
    transcriptWriter?: ChildTranscriptWriter;
    attemptNotes: string[];
    restoredSession: boolean;
    outputSnapshot?: SingleOutputSnapshot;
    originalTask?: string;
    contextPressureCrossedThresholds: Set<ContextPressureThreshold>;
    contextPressure?: ContextPressureProjection;
  },
): Promise<SingleResult> {
  const effectiveThinking = agent.thinking;
  const thinkingSuffixOptions = {
    availableModels: options.availableModels,
    preferredModelProvider: options.preferredModelProvider,
  };
  const thinkingDropNote = getThinkingLevelDropNote(
    model,
    effectiveThinking,
    false,
    thinkingSuffixOptions,
  );
  if (thinkingDropNote && !shared.attemptNotes.includes(thinkingDropNote))
    shared.attemptNotes.push(thinkingDropNote);
  const modelArg = applyThinkingSuffix(model, effectiveThinking, false, thinkingSuffixOptions);
  const modelIdentity = canonicalSubagentModelIdentity(
    modelArg,
    thinkingDropNote || typeof effectiveThinking !== "string" ? undefined : effectiveThinking,
  );
  let args: string[];
  let sharedEnv: Record<string, string | undefined>;
  let tempDir: string | undefined;
  try {
    ({
      args,
      env: sharedEnv,
      tempDir,
    } = buildPiArgs({
      baseArgs: ["--mode", "json", "-p"],
      task,
      sessionEnabled: shared.sessionEnabled,
      sessionDir: options.sessionDir,
      sessionFile: options.sessionFile,
      model: modelArg,
      thinking: effectiveThinking,
      availableModels: options.availableModels,
      preferredModelProvider: options.preferredModelProvider,
      systemPromptMode: agent.systemPromptMode,
      inheritProjectContext: agent.inheritProjectContext,
      inheritSkills: agent.inheritSkills,
      requireReadTool: agent.inheritSkills || Boolean(shared.resolvedSkillNames?.length),
      tools: agent.tools,
      extensions: agent.extensions,
      subagentOnlyExtensions: agent.subagentOnlyExtensions,
      supervisorBridge: agent.supervisorBridge,
      systemPrompt: shared.systemPrompt,
      cwd: options.cwd ?? runtimeCwd,
      promptFileStem: agent.name,
      runId: options.runId,
      childAgentName: agent.name,
      projectAgentGuidance: isCanonicalPackagedMinorAgent(agent),
      childIndex: options.index ?? 0,
      parentSessionId: options.parentSessionId,
      structuredOutput: options.structuredOutput,
      steerInboxDir: options.steerInboxDir,
      toolBudget: options.toolBudget,
    }));
  } catch (error) {
    const message =
      boundChildError(error instanceof Error ? error.message : String(error)) ??
      "Unknown child setup error.";
    const now = Date.now();
    const progress: AgentProgress = {
      index: options.index ?? 0,
      agent: agent.name,
      status: "failed",
      task,
      skills: shared.resolvedSkillNames,
      recentTools: [],
      recentOutput: [...shared.attemptNotes, message],
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
      lastActivityAt: now,
      error: message,
    };
    return {
      agent: agent.name,
      task: shared.originalTask ?? task,
      exitCode: 1,
      ...(options.tkTicket ? { tkTicket: options.tkTicket } : {}),
      messages: [],
      usage: emptyUsage(),
      model: modelArg,
      ...(modelIdentity ? { thinking: modelIdentity.thinking, modelIdentity } : {}),
      artifactPaths: shared.artifactPaths,
      transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
      skills: shared.resolvedSkillNames,
      skillsWarning: shared.skillsWarning,
      ...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
      error: message,
      finalOutput: message,
      outputMode: options.outputMode ?? "inline",
      progress,
      progressSummary: { toolCount: 0, tokens: 0, durationMs: 0 },
    };
  }

  const result: SingleResult = {
    agent: agent.name,
    task: shared.originalTask ?? task,
    exitCode: 0,
    ...(options.tkTicket ? { tkTicket: options.tkTicket } : {}),
    messages: [],
    usage: emptyUsage(),
    model: modelArg,
    ...(modelIdentity ? { thinking: modelIdentity.thinking, modelIdentity } : {}),
    artifactPaths: shared.artifactPaths,
    transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
    skills: shared.resolvedSkillNames,
    skillsWarning: shared.skillsWarning,
    ...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
  };
  const startTime = Date.now();
  if (options.structuredOutput) {
    try {
      if (existsSync(options.structuredOutput.outputPath))
        unlinkSync(options.structuredOutput.outputPath);
    } catch {
      // Missing/stale structured-output files are handled after the child exits.
    }
  }
  const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
  let interruptedByControl = false;
  const allControlEvents: ControlEvent[] = [];
  let pendingControlEvents: ControlEvent[] = [];
  const emittedControlEventKeys = new Set<string>();
  const emitControlEvent = (event: ControlEvent) => {
    if (!shouldNotifyControlEvent(controlConfig, event)) return;
    if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
    allControlEvents.push(event);
    pendingControlEvents.push(event);
    options.onControlEvent?.(event);
  };

  const progress: AgentProgress = {
    index: options.index ?? 0,
    agent: agent.name,
    status: "running",
    task,
    skills: shared.resolvedSkillNames,
    recentTools: [],
    recentOutput: [...shared.attemptNotes],
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
    lastActivityAt: startTime,
  };
  result.progress = progress;
  const attemptTimeout = resolveAttemptTimeout(options);
  if (attemptTimeout?.remainingMs === 0) {
    result.exitCode = 1;
    result.timedOut = true;
    result.error = attemptTimeout.message;
    result.finalOutput = attemptTimeout.message;
    progress.status = "failed";
    progress.error = attemptTimeout.message;
    result.progressSummary = {
      toolCount: progress.toolCount,
      tokens: progress.tokens,
      durationMs: progress.durationMs,
    };
    return result;
  }
  const spawnEnv = buildSubagentSpawnEnv(
    process.env,
    sharedEnv,
    getSubagentDepthEnv(options.maxSubagentDepth),
  );
  let observedMutationAttempt = false;
  const messageLedger = { bytes: 0, sizes: [] as number[] };
  let supervisorPauseRequested = false;

  const exitCode = await new Promise<number>((resolve) => {
    const spawnSpec = getPiSpawnCommand(args);
    const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
    const proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd ?? runtimeCwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(ownsProcessGroup ? { detached: true } : {}),
    });
    // This id is owned only because it comes from the child spawned above in
    // this execution. Never reconstruct it from persisted lifecycle state.
    const processGroupId =
      ownsProcessGroup && typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : undefined;
    const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
    let processClosed = false;
    let settled = false;
    let pendingSupervisorPause: SingleResult["pause"] | undefined;
    let assistantError: string | undefined;
    let supervisorPauseCleanupPromise:
      | Promise<NonNullable<SingleResult["processCleanup"]>>
      | undefined;
    let removeAbortListener: (() => void) | undefined;
    let removeInterruptListener: (() => void) | undefined;
    let activityTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: DeadlineTimer | undefined;
    let timeoutTerminationTimer: NodeJS.Timeout | undefined;
    let timeoutHardKillTimer: NodeJS.Timeout | undefined;
    let protocolLimitHardKillTimer: NodeJS.Timeout | undefined;
    let protocolOutputLimit: ProtocolOutputLimit | undefined;
    const terminalReason: ChildTerminalReasonLatch = {};
    const clearTimeoutTimers = () => {
      if (timeoutTimer) {
        timeoutTimer.cancel();
        timeoutTimer = undefined;
      }
      if (timeoutTerminationTimer) {
        clearTimeout(timeoutTerminationTimer);
        timeoutTerminationTimer = undefined;
      }
      if (timeoutHardKillTimer) {
        clearTimeout(timeoutHardKillTimer);
        timeoutHardKillTimer = undefined;
      }
    };
    const clearProtocolLimitHardKillTimer = () => {
      if (!protocolLimitHardKillTimer) return;
      clearTimeout(protocolLimitHardKillTimer);
      protocolLimitHardKillTimer = undefined;
    };

    const beginSupervisorPauseCleanup = (): Promise<
      NonNullable<SingleResult["processCleanup"]>
    > => {
      if (supervisorPauseCleanupPromise) return supervisorPauseCleanupPromise;
      if (processGroupId) {
        supervisorPauseCleanupPromise = cleanupOwnedProcessGroup(processGroupId);
      } else {
        // Portable direct-child signaling is best effort only. Without a
        // verified owned process group, pause publication must fail closed.
        trySignalChild(proc, "SIGINT");
        setTimeout(() => {
          if (!processClosed && !settled) trySignalChild(proc, "SIGTERM");
        }, 1000).unref?.();
        setTimeout(() => {
          if (!processClosed && !settled) trySignalChild(proc, "SIGKILL");
        }, 3000).unref?.();
        supervisorPauseCleanupPromise = Promise.resolve(
          skipOwnedProcessGroupCleanup(
            ownsProcessGroup ? "process_group_unavailable" : "unsupported_platform",
            undefined,
            ownsProcessGroup,
          ),
        );
      }
      return supervisorPauseCleanupPromise;
    };

    const pauseForSupervisor = (pause: NonNullable<SingleResult["pause"]>) => {
      if (supervisorPauseRequested || processClosed || settled) return;
      if (!claimChildTerminalReason(terminalReason, "paused")) return;
      const ownerPid = processGroupId;
      result.pause = {
        ...pause,
        ownerPid,
      };
      result.interrupted = true;
      result.error = undefined;
      result.finalOutput = formatForegroundSupervisorPauseMessage({
        headline: `Foreground run ${options.runId} paused awaiting supervisor (${agent.name}).`,
        runId: options.runId,
        agent: agent.name,
        requestSummary: pause.summary,
      });
      progress.activityState = undefined;
      progress.durationMs = Date.now() - startTime;
      try {
        options.onSupervisorPauseTransition?.({
          stage: "pausing",
          result: snapshotResult(result, snapshotProgress(progress)),
          ownerPid,
        });
      } catch {
        result.pause = undefined;
        result.interrupted = false;
        result.exitCode = 1;
        result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
        result.finalOutput = result.error;
        progress.status = "failed";
        progress.error = result.error;
        fireUpdate();
        void beginSupervisorPauseCleanup();
        return;
      }
      supervisorPauseRequested = true;
      fireUpdate();
      void beginSupervisorPauseCleanup();
    };

    // If the child emits a terminal assistant stop but never exits,
    // give it a short grace period to flush naturally, then clean it up.
    const FINAL_STOP_GRACE_MS = 1000;
    const HARD_KILL_MS = 3000;
    let childExited = false;
    let forcedTerminationSignal = false;
    let cleanTerminalAssistantStopReceived = false;
    let finalDrainTimer: NodeJS.Timeout | undefined;
    let finalHardKillTimer: NodeJS.Timeout | undefined;
    const clearFinalDrainTimers = () => {
      if (finalDrainTimer) {
        clearTimeout(finalDrainTimer);
        finalDrainTimer = undefined;
      }
      if (finalHardKillTimer) {
        clearTimeout(finalHardKillTimer);
        finalHardKillTimer = undefined;
      }
    };
    const startFinalDrain = () => {
      if (childExited || finalDrainTimer || settled || processClosed) return;
      finalDrainTimer = setTimeout(() => {
        if (settled || processClosed) return;
        const termSent = trySignalChild(proc, "SIGTERM");
        if (!termSent) return;
        forcedTerminationSignal = true;
        if (!cleanTerminalAssistantStopReceived && !assistantError) {
          result.error =
            result.error ??
            `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
        }
        finalHardKillTimer = setTimeout(() => {
          if (settled || processClosed) return;
          forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
        }, HARD_KILL_MS);
        finalHardKillTimer.unref?.();
      }, FINAL_STOP_GRACE_MS);
      finalDrainTimer.unref?.();
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearFinalDrainTimers();
      clearProtocolLimitHardKillTimer();
      clearStdioGuard();
      clearTimeoutTimers();
      if (activityTimer) {
        clearInterval(activityTimer);
        activityTimer = undefined;
      }
      removeAbortListener?.();
      removeInterruptListener?.();
      resolve(code);
    };

    const drainPendingControlEvents = (): ControlEvent[] | undefined => {
      if (pendingControlEvents.length === 0) return undefined;
      const events = pendingControlEvents;
      pendingControlEvents = [];
      return events;
    };

    let activeLongRunningNotified = false;
    let pendingToolResult:
      | { tool: string; path?: string; mutates: boolean; startedAt?: number }
      | undefined;
    const mutatingFailures = createMutatingFailureState();
    const mutatingFailureWindowMs = 5 * 60_000;
    const currentToolDurationMs = (now: number) =>
      progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
    const emitNeedsAttention = (
      now: number,
      input: {
        message?: string;
        contextPressureSeverity?: import("../../shared/types.ts").ContextPressureSeverity;
        contextPressureThreshold?: import("../../shared/types.ts").ContextPressureThreshold;
        reason?: ControlEvent["reason"];
        recentFailureSummary?: string;
        currentTool?: string;
        currentPath?: string;
        currentToolDurationMs?: number;
      } = {},
    ): boolean => {
      if (!controlConfig.enabled) return false;
      const previous = progress.activityState;
      progress.activityState = "needs_attention";
      const event = buildControlEvent({
        type: "needs_attention",
        from: previous,
        to: "needs_attention",
        runId: options.runId,
        agent: agent.name,
        index: options.index,
        ts: now,
        lastActivityAt: progress.lastActivityAt,
        message: input.message,
        contextPressureSeverity: input.contextPressureSeverity,
        contextPressureThreshold: input.contextPressureThreshold,
        reason: input.reason ?? "idle",
        turns: result.usage.turns,
        tokens: progress.tokens,
        toolCount: progress.toolCount,
        currentTool: input.currentTool ?? progress.currentTool,
        currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
        currentPath: input.currentPath ?? progress.currentPath,
        recentFailureSummary: input.recentFailureSummary,
      });
      emitControlEvent(event);
      return previous !== "needs_attention";
    };
    const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
      if (
        !controlConfig.enabled ||
        activeLongRunningNotified ||
        progress.activityState === "needs_attention"
      )
        return false;
      activeLongRunningNotified = true;
      const previous = progress.activityState;
      progress.activityState = "active_long_running";
      emitControlEvent(
        buildControlEvent({
          type: "active_long_running",
          from: previous,
          to: "active_long_running",
          runId: options.runId,
          agent: agent.name,
          index: options.index,
          ts: now,
          message: `${agent.name} is still active but long-running`,
          reason,
          turns: result.usage.turns,
          tokens: progress.tokens,
          toolCount: progress.toolCount,
          currentTool: progress.currentTool,
          currentToolDurationMs: currentToolDurationMs(now),
          currentPath: progress.currentPath,
          elapsedMs: now - startTime,
        }),
      );
      return true;
    };
    const updateActivityState = (now: number): boolean => {
      if (!controlConfig.enabled) return false;
      const idleState = deriveActivityState({
        config: controlConfig,
        startedAt: startTime,
        lastActivityAt: progress.lastActivityAt,
        toolCallInFlight: Boolean(progress.currentTool),
        now,
      });
      if (idleState === "needs_attention") {
        return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
      }
      const activeReason = nextLongRunningTrigger(controlConfig, {
        startedAt: startTime,
        now,
        turns: result.usage.turns,
        tokens: progress.tokens,
      });
      return activeReason ? emitActiveLongRunning(now, activeReason) : false;
    };

    const emitUpdateSnapshot = (text: string) => {
      if (!options.onUpdate || processClosed) return;
      const progressSnapshot = snapshotProgress(progress);
      const resultSnapshot = snapshotResult(result, progressSnapshot);
      const controlEvents = drainPendingControlEvents();
      options.onUpdate({
        content: [{ type: "text", text }],
        details: {
          mode: "single",
          results: [resultSnapshot],
          progress: [progressSnapshot],
          controlEvents,
        },
      });
    };

    const fireUpdate = () => {
      if (!options.onUpdate || processClosed) return;
      progress.durationMs = Date.now() - startTime;
      const output =
        result.timedOut && result.finalOutput
          ? result.finalOutput
          : getFinalOutput(result.messages ?? []);
      emitUpdateSnapshot(output || "(running...)");
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      jsonlWriter.writeLine(line);
      const parsed = parseChildProtocolInput(line);
      if (parsed.kind === "raw") {
        shared.transcriptWriter?.writeStdoutLine(line);
        // Non-JSON and non-object lines remain raw child output.
        return;
      }
      if (parsed.kind === "unknown") {
        // Preserve unknown object envelopes in the transcript without allowing
        // their fields to affect foreground state.
        shared.transcriptWriter?.writeStdoutLine(line);
        return;
      }
      const evt = parsed.event;
      shared.transcriptWriter?.writeChildEvent(evt);

      const now = Date.now();
      progress.durationMs = now - startTime;
      progress.lastActivityAt = now;
      updateActivityState(now);

      if (evt.type === "tool_execution_start") {
        const toolArgs = evt.args ?? {};
        let supervisorPause: SingleResult["pause"] | undefined;
        if (
          options.pauseBlockingSupervisor &&
          evt.toolName === "contact_supervisor" &&
          (toolArgs.reason === "need_decision" || toolArgs.reason === "interview_request")
        ) {
          supervisorPause = resolveSupervisorPauseMetadata({
            runId: options.runId,
            agent: agent.name,
            index: options.index ?? 0,
            toolName: evt.toolName,
            toolArgs,
            requestedAt: now,
          });
          pendingSupervisorPause = supervisorPause;
        }
        progress.toolCount++;
        if (options.toolBudget) {
          result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount);
        }
        progress.currentTool = evt.toolName;
        progress.currentToolArgs = extractToolArgsPreview(toolArgs);
        progress.currentToolStartedAt = now;
        progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
        const mutates = isMutatingTool(evt.toolName, toolArgs);
        observedMutationAttempt = observedMutationAttempt || mutates;
        pendingToolResult = {
          tool: evt.toolName ?? "tool",
          path: progress.currentPath,
          mutates,
          startedAt: now,
        };
        fireUpdate();
        if (supervisorPause?.kind === "awaiting_supervisor" && !processClosed) {
          pauseForSupervisor(supervisorPause);
        }
      }

      if (evt.type === "tool_execution_end") {
        pendingSupervisorPause = undefined;
        if (progress.currentTool) {
          appendRecentProgressItem(progress.recentTools, {
            tool: progress.currentTool,
            args: progress.currentToolArgs || "",
            endMs: now,
          });
        }
        progress.currentTool = undefined;
        progress.currentToolArgs = undefined;
        progress.currentToolStartedAt = undefined;
        progress.currentPath = undefined;
        fireUpdate();
      }

      if (evt.type === "message_end" && evt.message) {
        result.messages ??= [];
        appendBoundedChildMessage(
          result.messages,
          evt.message,
          Buffer.byteLength(line, "utf8"),
          messageLedger,
        );
        if (evt.message.role === "assistant") {
          result.usage.turns++;
          progress.turnCount = result.usage.turns;
          const stopReason = (evt.message as { stopReason?: string }).stopReason;
          const hasToolCall =
            Array.isArray(evt.message.content) &&
            evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
          const terminalAssistantStop = stopReason === "stop" && !hasToolCall;
          result.contextUsage = updateContextUsageDiagnostics(result.contextUsage, evt.message, {
            restored: shared.restoredSession,
            contextWindow: resolveEffectiveContextWindow(
              result.model ?? model,
              options.availableModels,
              options.preferredModelProvider,
            ),
          });
          while (true) {
            const pressure = detectContextPressureCrossing(
              result.contextUsage,
              [...shared.contextPressureCrossedThresholds],
              now,
            );
            if (!pressure) break;
            shared.contextPressureCrossedThresholds.add(pressure.crossedThreshold);
            shared.contextPressure = pressure;
            result.contextPressure = pressure;
            result.contextPressureCrossedThresholds = [...shared.contextPressureCrossedThresholds];
            emitNeedsAttention(now, {
              message: formatContextPressureGuidance(pressure),
              contextPressureSeverity: pressure.severity,
              contextPressureThreshold: pressure.crossedThreshold,
              reason: "context_pressure",
            });
          }
          const u = evt.message.usage;
          if (u) {
            result.usage.input += childUsageNumber(u, "input", "inputTokens");
            result.usage.output += childUsageNumber(u, "output", "outputTokens");
            result.usage.cacheRead += childUsageNumber(u, "cacheRead");
            result.usage.cacheWrite += childUsageNumber(u, "cacheWrite");
            result.usage.cost += childUsageNumber(u.cost, "total");
            progress.tokens = result.usage.input + result.usage.output;
          }
          if (!result.model && evt.message.model) result.model = evt.message.model;
          if (evt.message.errorMessage) assistantError = boundChildError(evt.message.errorMessage);
          const assistantText = extractTextFromContent(evt.message.content);
          appendRecentOutput(progress, assistantText.split("\n").slice(-10));
          // Final assistant message: start the exit drain window.
          if (terminalAssistantStop) {
            if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
            cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
            startFinalDrain();
          }
        }
        updateActivityState(now);
        fireUpdate();
      }

      if (evt.type === "tool_result_end" && evt.message) {
        result.messages ??= [];
        appendBoundedChildMessage(
          result.messages,
          evt.message,
          Buffer.byteLength(line, "utf8"),
          messageLedger,
        );
        const resultText = extractTextFromContent(evt.message.content);
        if (
          options.toolBudget &&
          pendingToolResult &&
          resultText.includes("Tool budget hard limit reached")
        ) {
          result.toolBudgetBlocked = true;
          result.toolBudget = toolBudgetState(
            options.toolBudget,
            progress.toolCount,
            pendingToolResult.tool,
          );
        }
        appendRecentOutput(progress, resultText.split("\n").slice(-10));
        const toolSnapshot = pendingToolResult;
        pendingToolResult = undefined;
        if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
          recordMutatingFailure(
            mutatingFailures,
            {
              tool: toolSnapshot.tool,
              path: toolSnapshot.path,
              error:
                resultText
                  .split("\n")
                  .find((line) => line.trim())
                  ?.trim()
                  .slice(0, 180) ?? "mutating tool failed",
              ts: now,
            },
            mutatingFailureWindowMs,
          );
          if (
            shouldEscalateMutatingFailures(
              mutatingFailures,
              controlConfig.failedToolAttemptsBeforeAttention,
            )
          ) {
            emitNeedsAttention(now, {
              message: `${agent.name} needs attention after repeated mutating tool failures`,
              reason: "tool_failures",
              currentTool: toolSnapshot.tool,
              currentPath: toolSnapshot.path,
              currentToolDurationMs: toolSnapshot.startedAt
                ? Math.max(0, now - toolSnapshot.startedAt)
                : undefined,
              recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
            });
          }
        } else if (toolSnapshot?.mutates) {
          resetMutatingFailureState(mutatingFailures);
        }
        fireUpdate();
      }
    };

    if (controlConfig.enabled) {
      activityTimer = setInterval(() => {
        if (processClosed || settled) return;
        const now = Date.now();
        if (updateActivityState(now)) {
          progress.durationMs = now - startTime;
          fireUpdate();
        }
      }, 1000);
      activityTimer.unref?.();
    }

    if (attemptTimeout) {
      timeoutTimer = scheduleDeadline(attemptTimeout.deadlineAt, () => {
        if (processClosed || settled || interruptedByControl || protocolOutputLimit) return;
        if (!claimChildTerminalReason(terminalReason, "timed_out")) return;
        result.timedOut = true;
        result.error = boundChildError(attemptTimeout.message);
        result.finalOutput = result.error;
        progress.status = "failed";
        progress.error = attemptTimeout.message;
        progress.durationMs = Date.now() - startTime;
        fireUpdate();
        trySignalChild(proc, "SIGINT");
        timeoutTerminationTimer = setTimeout(() => {
          if (processClosed || settled) return;
          trySignalChild(proc, "SIGTERM");
        }, 1000);
        timeoutTerminationTimer.unref?.();
        timeoutHardKillTimer = setTimeout(() => {
          if (processClosed || settled) return;
          trySignalChild(proc, "SIGKILL");
        }, 4000);
        timeoutHardKillTimer.unref?.();
      });
    }

    const stderrTail = createBoundedByteTail();
    const stdoutReader = createBoundedLineReader({
      stream: "stdout",
      onLine: processLine,
      onLimit: (limit) => {
        if (protocolOutputLimit) return;
        if (!claimChildTerminalReason(terminalReason, "output_limit")) return;
        protocolOutputLimit = limit;
        const message = boundChildError(formatProtocolOutputLimit(limit));
        result.protocolOutputLimit = limit;
        result.error = message;
        result.finalOutput = result.error;
        result.terminationReason = "output_limit";
        result.interrupted = false;
        progress.status = "failed";
        progress.error = message;
        progress.durationMs = Date.now() - startTime;
        emitUpdateSnapshot(message);
        if (settled || childExited) return;
        trySignalChild(proc, "SIGTERM");
        protocolLimitHardKillTimer = setTimeout(() => {
          protocolLimitHardKillTimer = undefined;
          if (!settled && !childExited) trySignalChild(proc, "SIGKILL");
        }, CHILD_PROTOCOL_HARD_KILL_GRACE_MS);
        protocolLimitHardKillTimer.unref?.();
      },
    });

    const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
    proc.stdout.on("data", (d) => {
      stdoutReader.push(d);
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderrTail.push(d);
      shared.transcriptWriter?.writeStderrChunk(d);
    });
    proc.on("exit", () => {
      childExited = true;
      clearFinalDrainTimers();
      clearProtocolLimitHardKillTimer();
    });
    proc.on("close", (code, signal) => {
      // Synchronous prelude — runs before any await so guards cannot observe stale state.
      clearFinalDrainTimers();
      clearProtocolLimitHardKillTimer();
      clearStdioGuard();
      result.exitSignal = signal ?? undefined;
      // Flush bounded readers before processClosed so the final complete line is
      // parsed and the raw stderr decoder receives its trailing code point.
      stdoutReader.end();
      shared.transcriptWriter?.finishStderr();
      const stderrText = formatBoundedStderr(stderrTail);
      result.stderr = stderrText;
      result.stderrTruncated = stderrTail.wasTruncated();
      // processLine must be called before processClosed = true: the onUpdate guards at line 874/890
      // check processClosed and would suppress the trailing line's progress update if set earlier.
      // processClosed must be set before the first await so timeout and kill guards cannot
      // observe a stale false during the artifact flush window.
      processClosed = true;
      void (async () => {
        // jsonlWriter.close() marks itself closed and drops its stream synchronously before
        // its first await (jsonl-writer.ts), so processLine() must be called before close()
        // to ensure any trailing partial line reaches the JSONL artifact.
        await jsonlWriter.close().catch(() => {
          // JSONL artifact flush is best effort.
        });
        cleanupTempDir(tempDir);
        if (!result.error && assistantError) result.error = boundChildError(assistantError);
        const forcedDrainAfterFinalSuccess =
          forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
        if (code !== 0 && stderrText.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
          result.error = boundChildStderrError(stderrText.trim(), stderrTail.wasTruncated());
        }
        const finalCode = protocolOutputLimit
          ? 1
          : forcedDrainAfterFinalSuccess
            ? 0
            : forcedTerminationSignal || signal
              ? (code ?? 1)
              : (code ?? 0);
        if (protocolOutputLimit) {
          // The latch only permits this branch when protocol overflow won before
          // timeout, interrupt, or supervisor-pause cleanup.
          supervisorPauseRequested = false;
          interruptedByControl = false;
          result.pause = undefined;
          result.interrupted = false;
          result.exitCode = 1;
          result.error = boundChildError(formatProtocolOutputLimit(protocolOutputLimit));
          result.finalOutput = result.error;
          progress.status = "failed";
          progress.error = result.error;
          finish(1);
          return;
        }
        if (supervisorPauseRequested) {
          void (async () => {
            const cleanup = await beginSupervisorPauseCleanup();
            result.processCleanup = cleanup;
            if (!cleanup.terminated) {
              supervisorPauseRequested = false;
              result.pause = undefined;
              result.interrupted = false;
              result.exitCode = 1;
              result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
              result.finalOutput = result.error;
              result.exitSignal = undefined;
              progress.status = "failed";
              progress.error = result.error;
              finish(1);
              return;
            }
            result.exitCode = 0;
            result.interrupted = true;
            result.error = undefined;
            result.exitSignal = undefined;
            if (result.pause)
              result.pause = { ...result.pause, pausedAt: Date.now(), ownerPid: undefined };
            progress.durationMs = Date.now() - startTime;
            result.progressSummary = {
              toolCount: progress.toolCount,
              tokens: progress.tokens,
              durationMs: progress.durationMs,
            };
            resolveResultSessionFile(result, options, shared.sessionEnabled);
            try {
              options.onSupervisorPauseTransition?.({
                stage: "paused",
                result: snapshotResult(result, snapshotProgress(progress)),
              });
            } catch {
              supervisorPauseRequested = false;
              result.pause = undefined;
              result.interrupted = false;
              result.exitCode = 1;
              result.error = FOREGROUND_SUPERVISOR_LIFECYCLE_ERROR_MESSAGE;
              result.finalOutput = result.error;
              progress.status = "failed";
              progress.error = result.error;
              finish(1);
              return;
            }
            finish(0);
          })();
          return;
        }
        if (interruptedByControl) {
          void (async () => {
            const cleanup = await beginSupervisorPauseCleanup();
            result.processCleanup = cleanup;
            if (!cleanup.terminated) {
              interruptedByControl = false;
              result.interrupted = false;
              result.exitCode = 1;
              result.error = FOREGROUND_PROCESS_CLEANUP_ERROR_MESSAGE;
              result.finalOutput = result.error;
              progress.status = "failed";
              progress.error = result.error;
              finish(1);
              return;
            }
            processClosed = true;
            finish(finalCode);
          })();
          return;
        }
        finish(finalCode);
      })();
    });
    proc.on("error", (error) => {
      // Synchronous prelude — keep guards safe before the artifact flush await.
      clearFinalDrainTimers();
      clearProtocolLimitHardKillTimer();
      clearStdioGuard();
      stdoutReader.end();
      shared.transcriptWriter?.finishStderr();
      const stderrText = formatBoundedStderr(stderrTail);
      result.stderr = stderrText;
      result.stderrTruncated = stderrTail.wasTruncated();
      if (!result.error) {
        result.error = boundChildError(error instanceof Error ? error.message : String(error));
      }
      // processClosed must be set before the first await so timeout, abort, and interrupt
      // paths cannot observe a stale false and reinterpret a real process error.
      processClosed = true;
      void (async () => {
        await jsonlWriter.close().catch(() => {
          // JSONL artifact flush is best effort.
        });
        cleanupTempDir(tempDir);
        finish(1);
      })();
    });

    if (options.signal) {
      const kill = () => {
        if (processClosed) return;
        if (
          options.pauseBlockingSupervisor &&
          pendingSupervisorPause?.kind === "awaiting_supervisor"
        ) {
          pauseForSupervisor(pendingSupervisorPause);
          return;
        }
        proc.kill("SIGTERM");
        setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
      };
      if (options.signal.aborted) kill();
      else {
        options.signal.addEventListener("abort", kill, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
      }
    }

    if (options.interruptSignal) {
      const interrupt = () => {
        if (processClosed || settled || protocolOutputLimit) return;
        if (result.timedOut) return;
        if (!claimChildTerminalReason(terminalReason, "interrupted")) return;
        interruptedByControl = true;
        clearTimeoutTimers();
        progress.status = "running";
        progress.durationMs = Date.now() - startTime;
        result.interrupted = true;
        result.finalOutput = "Interrupted. Waiting for explicit next action.";
        progress.activityState = undefined;
        fireUpdate();
        void beginSupervisorPauseCleanup();
      };
      if (options.interruptSignal.aborted) interrupt();
      else {
        options.interruptSignal.addEventListener("abort", interrupt, { once: true });
        removeInterruptListener = () =>
          options.interruptSignal?.removeEventListener("abort", interrupt);
      }
    }
  });
  result.exitCode = exitCode;
  return finalizeSingleAttempt({
    result,
    progress,
    startTime,
    agent,
    task,
    options,
    sessionEnabled: shared.sessionEnabled,
    originalTask: shared.originalTask,
    outputSnapshot: shared.outputSnapshot,
    supervisorPauseRequested,
    interruptedByControl,
    observedMutationAttempt,
    allControlEvents,
    emitControlEvent,
  });
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
  runtimeCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: RunSyncOptions,
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      usage: emptyUsage(),
      error: `Unknown agent: ${agentName}`,
    };
  }
  const effectiveTimeoutMs = resolveEffectiveSingleTimeout(
    options.timeoutMs,
    agent.maxExecutionTimeMs,
  );
  options = {
    ...options,
    timeoutMs: effectiveTimeoutMs,
    deadlineAt: resolveEffectiveTimeoutDeadline(options.deadlineAt, effectiveTimeoutMs),
    ...(agent.supervisorBridge === false ? { pauseBlockingSupervisor: false } : {}),
  };
  const outputModeValidationError = validateFileOnlyOutputMode(
    options.outputMode,
    options.outputPath,
    `Single run (${agentName})`,
  );
  if (outputModeValidationError) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      usage: emptyUsage(),
      outputMode: options.outputMode,
      error: outputModeValidationError,
    };
  }

  const shareEnabled = options.share === true;
  const effectiveAcceptance = resolveEffectiveAcceptance({
    explicit: options.acceptance,
    agentName,
    acceptanceRole: agent.acceptanceRole,
    task,
    mode: options.acceptanceContext?.mode ?? "single",
    async: options.acceptanceContext?.async,
  });
  const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
  const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
  const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
  // A configured session path is often preallocated for a fresh run. Capture
  // whether an artifact existed before the first child is spawned so fallback
  // attempts in this invocation cannot become restored attempts.
  const restoredSession = hasUsableSessionArtifact(options.sessionFile);
  const skillNames = options.skills ?? agent.skills ?? [];
  const skillCwd = options.cwd ?? runtimeCwd;
  const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
    skillNames,
    skillCwd,
    runtimeCwd,
  );
  if (
    skillNames.some((skill) => skill.trim() === "pi-subagents") &&
    missingSkills.includes("pi-subagents")
  ) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      usage: emptyUsage(),
      error: "Skills not found: pi-subagents",
    };
  }
  let systemPrompt = agent.systemPrompt?.trim() || "";
  if (resolvedSkills.length > 0) {
    const skillInjection = buildSkillInjection(resolvedSkills);
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
  }
  systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath);

  const fallbackModels = buildFallbackModelList(options.fallbackModels, agent.fallbackModels);
  const candidatePlan = buildModelCandidatePlan(
    options.modelOverride ?? agent.model,
    fallbackModels,
    options.availableModels,
    options.preferredModelProvider,
    { scope: options.modelScope, registry: options.modelRegistry },
  );
  const candidates = candidatePlan.candidates;
  const filteringNotice = candidatePlan.filteringNotice;
  const configuredFallbackNotice = sanitizeModelFallbackNotice(options.modelFallbackNotice);
  const attemptedModels: string[] = [];
  const modelAttempts: ModelAttempt[] = [];
  const aggregateUsage = emptyUsage();
  const attemptNotes: string[] = [];
  const contextPressureCrossedThresholds = new Set<ContextPressureThreshold>(
    parseContextPressureCrossedThresholds(options.contextPressureCrossedThresholds) ?? [],
  );
  let contextPressure = parseContextPressureProjection(options.contextPressure);
  let totalToolCount = 0;
  let totalDurationMs = 0;

  const { artifactPathsResult, jsonlPath, transcriptWriter } = setupForegroundArtifacts(
    runtimeCwd,
    agentName,
    taskWithAcceptance,
    options,
  );

  let lastResult: SingleResult | undefined;
  let aggregateContextUsage: SingleResult["contextUsage"];
  let finalAttemptContextUsage: SingleResult["contextUsage"];
  let firstAttemptModelIdentity: SubagentModelIdentity | undefined;
  let modelResolution = options.modelResolution;
  const modelsToTry = candidates.length > 0 ? candidates : [undefined];
  for (let i = 0; i < modelsToTry.length; i++) {
    const candidate = modelsToTry[i];
    const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
    const result = await runSingleAttempt(
      runtimeCwd,
      agent,
      taskWithAcceptance,
      candidate,
      options,
      {
        sessionEnabled,
        systemPrompt,
        resolvedSkillNames:
          resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
        skillsWarning:
          missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
        jsonlPath,
        artifactPaths: artifactPathsResult,
        transcriptWriter,
        attemptNotes,
        restoredSession,
        outputSnapshot,
        originalTask: task,
        contextPressureCrossedThresholds,
        contextPressure,
      },
    );
    lastResult = result;
    contextPressure = result.contextPressure ?? contextPressure;
    finalAttemptContextUsage = result.contextUsage;
    aggregateContextUsage = mergeContextUsageDiagnostics(
      aggregateContextUsage,
      result.contextUsage,
    );
    if (i === 0) firstAttemptModelIdentity = result.modelIdentity;
    if (i > 0) {
      modelResolution = appendRuntimeFallbackResolution({
        previous: modelResolution,
        sourceAttempt: modelAttempts.at(-1),
        currentIdentity: result.modelIdentity,
        originalIdentity: firstAttemptModelIdentity,
      });
    }
    if (result.model) attemptedModels.push(result.model);
    else if (candidate) attemptedModels.push(candidate);
    sumUsage(aggregateUsage, result.usage);
    totalToolCount += result.progressSummary?.toolCount ?? 0;
    totalDurationMs += result.progressSummary?.durationMs ?? 0;
    const attemptSucceeded = result.exitCode === 0 && !result.error;
    const attempt: ModelAttempt = {
      model: result.model ?? candidate ?? agent.model ?? "default",
      success: attemptSucceeded,
      exitCode: result.exitCode,
      error: result.error,
      usage: { ...result.usage },
    };
    modelAttempts.push(attempt);
    if (result.protocolOutputLimit || result.timedOut) {
      break;
    }
    if (attemptSucceeded) {
      break;
    }
    if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
      break;
    }
    attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
  }

  const result =
    lastResult ??
    ({
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      usage: emptyUsage(),
      error: "Subagent did not produce a result.",
    } satisfies SingleResult);

  // Keep the exact approved project capture attached to every foreground
  // checkpoint/result. The capture contains data only; capability authority
  // remains in the process-private generation registry.
  if (options.projectAgent) result.projectAgent = options.projectAgent;

  if (modelAttempts.length > 1 && result.modelIdentity) {
    modelResolution = appendRuntimeFallbackResolution({
      previous: modelResolution,
      sourceAttempt: modelAttempts.at(-2),
      currentIdentity: result.modelIdentity,
      originalIdentity: firstAttemptModelIdentity,
    });
  } else if (modelResolution && result.modelIdentity) {
    modelResolution = { ...modelResolution, resumed: result.modelIdentity };
  }
  result.modelResolution = modelResolution;
  result.usage = aggregateUsage;
  result.contextUsage = aggregateContextUsage;
  result.contextPressure = contextPressure;
  result.contextPressureCrossedThresholds = contextPressureCrossedThresholds.size
    ? [...contextPressureCrossedThresholds]
    : undefined;
  result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
  result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
  const modelFallbackNotice = combineModelFallbackNotices(
    modelAttempts.length > 1 ? configuredFallbackNotice : undefined,
    filteringNotice,
  );
  if (modelFallbackNotice) result.modelFallbackNotice = modelFallbackNotice;
  result.progressSummary = {
    toolCount: totalToolCount,
    tokens: aggregateUsage.input + aggregateUsage.output,
    durationMs: totalDurationMs,
  };
  result.activeRuntimeMs = totalDurationMs;
  if (attemptNotes.length > 0 && result.progress) {
    const existingNotes = new Set(result.progress.recentOutput);
    result.progress.recentOutput = [
      ...attemptNotes.filter((note) => !existingNotes.has(note)),
      ...result.progress.recentOutput,
    ];
    if (result.progress.recentOutput.length > 50) {
      result.progress.recentOutput.splice(50);
    }
  }

  prepareForegroundRunFinalization({
    result,
    options,
    shareEnabled,
    artifactPathsResult,
    transcriptWriter,
  });

  const acceptanceEvaluation = evaluateSingleAcceptance({
    result,
    effectiveAcceptance,
    options,
    runtimeCwd,
  });
  const { interruptedAcceptance, acceptance } = acceptanceEvaluation;
  result.acceptance = acceptance instanceof Promise ? await acceptance : acceptance;
  if (
    !result.protocolOutputLimit &&
    !result.timedOut &&
    !result.interrupted &&
    options.interruptSignal?.aborted
  ) {
    result.interrupted = true;
    result.exitCode = 0;
    result.error = undefined;
    result.finalOutput = "Interrupted. Waiting for explicit next action.";
    result.acceptance = interruptedAcceptance;
    if (result.progress) {
      result.progress.activityState = undefined;
      result.progress.error = undefined;
    }
  }
  const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
  if (
    acceptanceFailure &&
    result.acceptance.explicit &&
    result.exitCode === 0 &&
    !result.interrupted &&
    !result.timedOut &&
    !result.protocolOutputLimit
  ) {
    result.exitCode = 1;
    result.error = composeAcceptanceFailureError(result.error, acceptanceFailure);
    if (result.progress) {
      result.progress.status = "failed";
      result.progress.error = result.error;
    }
  }

  finalizeForegroundArtifacts({
    result,
    options,
    artifactPathsResult,
    transcriptWriter,
    agentName,
    task,
    finalAttemptContextUsage,
  });
  return result;
}
