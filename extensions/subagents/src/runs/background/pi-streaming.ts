/** Background child-process streaming and protocol handling. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import {
  type ChildProcessCleanupResult,
  type ContextUsageDiagnostics,
  type SubagentModelIdentity,
  type ToolBudgetState,
  type Usage,
  getSubagentDepthEnv,
} from "../../shared/types.ts";
import { buildSubagentSpawnEnv, getPiSpawnCommand } from "../shared/pi-spawn.ts";
import {
  CHILD_PROTOCOL_HARD_KILL_GRACE_MS,
  appendBoundedChildMessage,
  boundChildError,
  boundChildStderrError,
  claimChildTerminalReason,
  childUsageNumber,
  createBoundedBytePrefix,
  createBoundedByteTail,
  createBoundedLineReader,
  formatBoundedRawStdout,
  formatBoundedStderr,
  formatProtocolOutputLimit,
  formatStderrLineOverflow,
  formatStderrTailOverflow,
  MAX_CHILD_RAW_STDOUT_BYTES,
  MAX_CHILD_STDERR_LINE_BYTES,
  parseChildProtocolInput,
  type ChildProtocolEvent,
  type ChildTerminalReasonLatch,
  type ProtocolOutputLimit,
} from "../shared/child-protocol.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import {
  extractTextFromContent,
  extractToolArgsPreview,
  getFinalOutput,
  synthesizeChildExitDiagnostic,
} from "../../shared/utils.ts";
import { isMutatingTool } from "../shared/long-running-guard.ts";
import {
  cleanupOwnedProcessGroup,
  skipOwnedProcessGroupCleanup,
  supportsOwnedProcessGroupCleanup,
} from "../shared/process-group-cleanup.ts";
import { resolveRuntimeModelContext } from "../shared/model-fallback.ts";
import {
  assistantStopReason,
  classifyContextExhaustedTermination,
  CONTEXT_EXHAUSTED_TERMINATION_MESSAGE,
  resolveSubagentTerminationReason,
  updateContextUsageDiagnostics,
} from "../../shared/context-diagnostics.ts";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";

export interface ChildEventContext {
  eventsPath: string;
  runId: string;
  stepIndex: number;
  agent: string;
  /** Undefined preserves detailed behavior for legacy/in-flight envelopes. */
  includeChildEventProjections?: boolean;
}

type ChildEventCategory = "projection" | "runner-diagnostic";

export type ChildEvent = ChildProtocolEvent;

function shouldPersistChildEvent(event: Record<string, unknown>): boolean {
  return event.type !== "message_update";
}

export interface RunPiStreamingResult {
  /** Bounded stderr tail, optionally prefixed with a truncation diagnostic. */
  stderr: string;
  stderrTruncated?: boolean;
  protocolOutputLimit?: ProtocolOutputLimit;
  exitCode: number | null;
  exitSignal?: NodeJS.Signals;
  messages: Message[];
  usage: Usage;
  model?: string;
  runtimeModelIdentity?: SubagentModelIdentity;
  configuredModel?: string;
  error?: string;
  finalOutput: string;
  interrupted?: boolean;
  timedOut?: boolean;
  toolBudget?: ToolBudgetState;
  toolBudgetBlocked?: boolean;
  observedMutationAttempt?: boolean;
  processGroupId?: number;
  processCleanup?: ChildProcessCleanupResult;
  contextUsage?: ContextUsageDiagnostics;
  assistantStopReason?: string;
  contextExhausted?: boolean;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function isTerminalAssistantStop(message: Message): boolean {
  const stopReason = (message as { stopReason?: string }).stopReason;
  const hasToolCall =
    Array.isArray(message.content) &&
    message.content.some((part) => (part as { type?: string }).type === "toolCall");
  return stopReason === "stop" && !hasToolCall;
}

export function contextWindowForModel(
  model: string | undefined,
  contextWindows: Record<string, number> | undefined,
): number | undefined {
  if (!model || !contextWindows) return undefined;
  const baseModel = splitKnownThinkingSuffix(model).baseModel;
  const value = contextWindows[baseModel];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function runtimeModelReference(identity: SubagentModelIdentity): string {
  return `${identity.provider}/${identity.model}${identity.thinking ? `:${identity.thinking}` : ""}`;
}

export function runPiStreaming(
  args: string[],
  cwd: string,
  outputFile: string,
  appendDiagnosticJsonl: (filePath: string, line: string, droppedEventType?: string) => void,
  env?: Record<string, string | undefined>,
  piPackageRoot?: string,
  piArgv1?: string,
  maxSubagentDepth?: number,
  childEventContext?: ChildEventContext,
  registerInterrupt?: (interrupt: (() => void) | undefined) => void,
  onChildEvent?: (event: ChildEvent) => void,
  transcriptWriter?: ChildTranscriptWriter,
  registerTimeout?: (interrupt: (() => void) | undefined) => void,
  timeoutMessage?: string,
  onChildProtocolOutputLimit?: (limit: ProtocolOutputLimit) => void,
  context?: {
    restored: boolean;
    configuredModel?: string;
    contextWindow?: number;
    contextWindows?: Record<string, number>;
  },
): Promise<RunPiStreamingResult> {
  return new Promise((resolve) => {
    const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
    const spawnEnv = buildSubagentSpawnEnv(process.env, env, getSubagentDepthEnv(maxSubagentDepth));
    const spawnSpec = getPiSpawnCommand(args, {
      ...(piPackageRoot ? { piPackageRoot } : {}),
      ...(piArgv1 ? { argv1: piArgv1 } : {}),
    });
    const ownsProcessGroup = supportsOwnedProcessGroupCleanup();
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
      windowsHide: true,
      ...(ownsProcessGroup ? { detached: true } : {}),
    });
    const processGroupId =
      ownsProcessGroup && typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
    const stderrTail = createBoundedByteTail();
    const messages: Message[] = [];
    const messageLedger = { bytes: 0, sizes: [] as number[] };
    const usage = emptyUsage();
    let model: string | undefined;
    let error: string | undefined;
    let assistantError: string | undefined;
    let protocolOutputLimit: ProtocolOutputLimit | undefined;
    let stderrLineOverflow = false;
    const terminalReason: ChildTerminalReasonLatch = {};
    let interrupted = false;
    let timedOut = false;
    let observedMutationAttempt = false;
    let contextUsage: ContextUsageDiagnostics | undefined;
    let runtimeModelIdentity: SubagentModelIdentity | undefined;
    let finalAssistantStopReason: string | undefined;
    let wroteHumanReadableOutput = false;
    const rawStdout = createBoundedBytePrefix(MAX_CHILD_RAW_STDOUT_BYTES);

    const writeOutputLine = (line: string) => {
      if (!line.trim()) return;
      wroteHumanReadableOutput = true;
      outputStream.write(`${line}\n`);
    };

    const writeOutputText = (text: string) => {
      for (const line of text.split("\n")) {
        writeOutputLine(line);
      }
    };

    const appendChildEvent = (
      event: Record<string, unknown>,
      category: ChildEventCategory = "projection",
    ) => {
      if (!childEventContext) return;
      if (category === "projection" && childEventContext.includeChildEventProjections === false)
        return;
      if (!shouldPersistChildEvent(event)) return;
      appendDiagnosticJsonl(
        childEventContext.eventsPath,
        JSON.stringify({
          ...event,
          subagentSource: "child",
          subagentRunId: childEventContext.runId,
          subagentStepIndex: childEventContext.stepIndex,
          subagentAgent: childEventContext.agent,
          observedAt: Date.now(),
        }),
        typeof event.type === "string" ? event.type : undefined,
      );
    };

    const appendChildLine = (
      type: "subagent.child.stdout" | "subagent.child.stderr",
      line: string,
    ) => {
      appendChildEvent({ type, line });
      // When the debug transcript is enabled, stderr is streamed as raw chunks
      // so split UTF-8 and line endings remain byte-faithful. Only stdout
      // fallback lines need a direct transcript record here.
      if (type === "subagent.child.stdout") transcriptWriter?.writeStdoutLine(line);
    };

    const processStdoutLine = (line: string) => {
      if (!line.trim()) return;
      const writeRawStdoutLine = () => {
        rawStdout.push(`${line}\n`);
        writeOutputLine(line);
        appendChildLine("subagent.child.stdout", line);
      };
      const parsed = parseChildProtocolInput(line);
      if (parsed.kind === "raw") {
        writeRawStdoutLine();
        return;
      }
      if (parsed.kind === "unknown") {
        // Treat unknown object envelopes as diagnostic/raw transcript
        // projections when enabled, but never pass unchecked fields into
        // orchestration logic.
        appendChildEvent(parsed.value);
        transcriptWriter?.writeStdoutLine(line);
        return;
      }
      const event = parsed.event;

      appendChildEvent(event);
      transcriptWriter?.writeChildEvent(event);
      onChildEvent?.(event);

      if (event.type === "tool_execution_start" && event.toolName) {
        observedMutationAttempt =
          observedMutationAttempt || isMutatingTool(event.toolName, event.args);
        const toolArgs = extractToolArgsPreview(event.args ?? {});
        writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
        return;
      }

      if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
        appendBoundedChildMessage(
          messages,
          event.message,
          Buffer.byteLength(line, "utf8"),
          messageLedger,
        );
        const text = extractTextFromContent(event.message.content);
        if (text) writeOutputText(text);

        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        if (context && !context.configuredModel && runtimeModelIdentity === undefined) {
          const reportedModel = resolveRuntimeModelContext(
            event.message.provider,
            event.message.model,
            context.contextWindows,
          );
          if (reportedModel) {
            runtimeModelIdentity = reportedModel.identity;
            context.contextWindow = reportedModel.contextWindow;
            model = runtimeModelReference(reportedModel.identity);
          }
        }
        if (event.message.model && runtimeModelIdentity === undefined) model = event.message.model;
        if (event.message.errorMessage)
          assistantError = boundChildError(event.message.errorMessage);
        finalAssistantStopReason = assistantStopReason(event.message);
        contextUsage = updateContextUsageDiagnostics(contextUsage, event.message, {
          restored: context?.restored === true,
          contextWindow: context?.contextWindow,
        });
        const eventUsage = event.message.usage;
        if (eventUsage) {
          usage.turns++;
          usage.input += childUsageNumber(eventUsage, "input", "inputTokens");
          usage.output += childUsageNumber(eventUsage, "output", "outputTokens");
          usage.cacheRead += childUsageNumber(eventUsage, "cacheRead");
          usage.cacheWrite += childUsageNumber(eventUsage, "cacheWrite");
          usage.cost += childUsageNumber(eventUsage.cost, "total");
        }
        if (isTerminalAssistantStop(event.message)) {
          if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim())
            assistantError = undefined;
          cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
          startFinalDrain();
        }
      }
    };

    const processStderrChunk = (chunk: Buffer) => {
      const wasTruncated = stderrTail.wasTruncated();
      stderrTail.push(chunk);
      if (!wasTruncated && stderrTail.wasTruncated()) {
        appendChildEvent(
          {
            type: "subagent.child.stderr.truncated",
            message: formatStderrTailOverflow(stderrTail),
          },
          "runner-diagnostic",
        );
      }
      if (chunk.length > 0) wroteHumanReadableOutput = true;
      outputStream.write(chunk);
      transcriptWriter?.writeStderrChunk(chunk);
      if (childEventContext) stderrLineReader.push(chunk);
    };

    // Guard both cases that can leave the parent waiting on `close` forever:
    // a lingering stdio holder after `exit`, or a child that never exits.
    const FINAL_STOP_GRACE_MS = 1000;
    const HARD_KILL_MS = 3000;
    const CLOSE_FALLBACK_MS = 1000;
    const INTERRUPT_HARD_KILL_MS = 4000;
    const TIMEOUT_HARD_KILL_MS = 3000;
    let childExited = false;
    let forcedTerminationSignal = false;
    let cleanTerminalAssistantStopReceived = false;
    let finalDrainTimer: NodeJS.Timeout | undefined;
    let finalHardKillTimer: NodeJS.Timeout | undefined;
    let closeFallbackTimer: NodeJS.Timeout | undefined;
    let interruptTerminationTimer: NodeJS.Timeout | undefined;
    let interruptHardKillTimer: NodeJS.Timeout | undefined;
    let timeoutHardKillTimer: NodeJS.Timeout | undefined;
    let protocolLimitHardKillTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let softInterruptsEnabled = true;
    let interruptRegistered = false;
    let exitCodeFromExit: number | null = null;
    let exitSignalFromExit: NodeJS.Signals | null = null;
    let processCleanup: ChildProcessCleanupResult | undefined;
    let cleanupPromise: Promise<ChildProcessCleanupResult> | undefined;
    const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
    const clearCloseFallbackTimer = () => {
      if (!closeFallbackTimer) return;
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = undefined;
    };
    const clearProtocolLimitHardKillTimer = () => {
      if (!protocolLimitHardKillTimer) return;
      clearTimeout(protocolLimitHardKillTimer);
      protocolLimitHardKillTimer = undefined;
    };
    const clearRegisteredInterrupt = () => {
      if (!interruptRegistered) return;
      interruptRegistered = false;
      registerInterrupt?.(undefined);
      registerTimeout?.(undefined);
    };
    const disableSoftInterrupts = () => {
      softInterruptsEnabled = false;
      clearRegisteredInterrupt();
    };
    const resolveProcessCleanup = (): Promise<ChildProcessCleanupResult> => {
      disableSoftInterrupts();
      if (processCleanup) return Promise.resolve(processCleanup);
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        processCleanup = processGroupId
          ? await cleanupOwnedProcessGroup(processGroupId)
          : skipOwnedProcessGroupCleanup(
              supportsOwnedProcessGroupCleanup()
                ? "process_group_unavailable"
                : "unsupported_platform",
              processGroupId,
            );
        return processCleanup;
      })();
      return cleanupPromise;
    };
    const finalize = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      disableSoftInterrupts();
      clearDrainTimers();
      clearCloseFallbackTimer();
      clearProtocolLimitHardKillTimer();
      clearStdioGuard();
      stdoutReader.end();
      stderrLineReader.end();
      transcriptWriter?.finishStderr();
      const stderrText = formatBoundedStderr(stderrTail);
      const finalOutput = getFinalOutput(messages) || formatBoundedRawStdout(rawStdout).trim();
      const resolvedExitCode = protocolOutputLimit
        ? (exitCode ?? 1)
        : interrupted
          ? 0
          : forcedTerminationSignal || signal
            ? (exitCode ?? 1)
            : exitCode;
      const forcedDrainAfterFinalSuccess =
        !protocolOutputLimit &&
        forcedTerminationSignal &&
        cleanTerminalAssistantStopReceived &&
        !(error ?? assistantError);
      const finalError = boundChildError(
        error ??
          assistantError ??
          (resolvedExitCode !== 0
            ? boundChildStderrError(
                stderrText.trim(),
                stderrTail.wasTruncated() || stderrLineOverflow,
              )
            : undefined) ??
          synthesizeChildExitDiagnostic({ exitCode: resolvedExitCode, signal }),
      );
      const resultExitCode = protocolOutputLimit
        ? 1
        : timedOut
          ? 1
          : forcedDrainAfterFinalSuccess
            ? 0
            : resolvedExitCode;
      const resultTerminationReason = resolveSubagentTerminationReason({
        assistantStopReason: finalAssistantStopReason,
        effectiveExitCode: resultExitCode ?? undefined,
        processCompleted: true,
      });
      const contextExhausted = protocolOutputLimit
        ? undefined
        : classifyContextExhaustedTermination({
            messages,
            contextUsage,
            exitCode: resultExitCode ?? undefined,
            error: finalError,
            terminationReason: resultTerminationReason,
          });
      if (
        !interrupted &&
        !forcedDrainAfterFinalSuccess &&
        resolvedExitCode !== 0 &&
        finalError &&
        finalError !== stderrText.trim()
      ) {
        outputStream.write(`${wroteHumanReadableOutput ? "\n" : ""}${finalError}\n`);
      }
      outputStream.end();
      resolve({
        stderr: stderrText,
        stderrTruncated: stderrTail.wasTruncated() || stderrLineOverflow,
        protocolOutputLimit,
        exitCode: contextExhausted ? 1 : resultExitCode,

        exitSignal: signal ?? undefined,
        messages,
        usage,
        model,
        error: contextExhausted
          ? CONTEXT_EXHAUSTED_TERMINATION_MESSAGE
          : protocolOutputLimit
            ? finalError
            : timedOut
              ? (timeoutMessage ?? "Subagent timed out.")
              : interrupted || forcedDrainAfterFinalSuccess
                ? undefined
                : finalError,
        finalOutput: protocolOutputLimit
          ? (finalError ?? formatProtocolOutputLimit(protocolOutputLimit))
          : timedOut && !finalOutput.trim()
            ? (timeoutMessage ?? "Subagent timed out.")
            : finalOutput,
        interrupted,
        timedOut,
        observedMutationAttempt,
        processGroupId,
        processCleanup,
        contextUsage,
        runtimeModelIdentity,
        configuredModel: context?.configuredModel,
        assistantStopReason: finalAssistantStopReason,
        contextExhausted: contextExhausted === "context_exhausted" || undefined,
      });
    };
    const stdoutReader = createBoundedLineReader({
      stream: "stdout",
      onLine: processStdoutLine,
      onLimit: (limit) => {
        if (protocolOutputLimit) return;
        if (!claimChildTerminalReason(terminalReason, "output_limit")) return;
        protocolOutputLimit = limit;
        interrupted = false;
        error = boundChildError(formatProtocolOutputLimit(limit));
        onChildProtocolOutputLimit?.(limit);
        if (settled || childExited) return;
        trySignalChild(child, "SIGTERM");
        protocolLimitHardKillTimer = setTimeout(() => {
          protocolLimitHardKillTimer = undefined;
          if (!settled && !childExited) trySignalChild(child, "SIGKILL");
        }, CHILD_PROTOCOL_HARD_KILL_GRACE_MS);
        protocolLimitHardKillTimer.unref?.();
      },
    });
    const stderrLineReader = createBoundedLineReader({
      stream: "stderr",
      maxPendingLineBytes: MAX_CHILD_STDERR_LINE_BYTES,
      onLine: (line) => {
        if (!line.trim()) return;
        // Raw stderr is streamed to output; the optional debug transcript also
        // receives it. This is a bounded diagnostic projection for the async
        // event log only.
        appendChildEvent({ type: "subagent.child.stderr", line });
      },
      onLimit: (limit) => {
        stderrLineOverflow = true;
        appendChildEvent(
          {
            type: "subagent.child.stderr.overflow",
            message: formatStderrLineOverflow(limit),
          },
          "runner-diagnostic",
        );
      },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutReader.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      processStderrChunk(chunk);
    });
    interruptRegistered = true;
    registerInterrupt?.(() => {
      if (settled || timedOut || !softInterruptsEnabled || protocolOutputLimit) return;
      if (!claimChildTerminalReason(terminalReason, "interrupted")) return;
      interrupted = true;
      if (!error) error = "Interrupted. Waiting for explicit next action.";
      trySignalChild(child, "SIGINT");
      interruptTerminationTimer = setTimeout(() => {
        if (!settled && !timedOut && softInterruptsEnabled) trySignalChild(child, "SIGTERM");
      }, 1000);
      interruptTerminationTimer.unref?.();
      interruptHardKillTimer = setTimeout(() => {
        if (!settled && !timedOut && softInterruptsEnabled) trySignalChild(child, "SIGKILL");
      }, INTERRUPT_HARD_KILL_MS);
      interruptHardKillTimer.unref?.();
    });
    registerTimeout?.(() => {
      if (settled || timedOut || protocolOutputLimit) return;
      if (!claimChildTerminalReason(terminalReason, "timed_out")) return;
      timedOut = true;
      interrupted = false;
      error = boundChildError(timeoutMessage ?? "Subagent timed out.");
      trySignalChild(child, "SIGTERM");
      timeoutHardKillTimer = setTimeout(() => {
        if (!settled) trySignalChild(child, "SIGKILL");
      }, TIMEOUT_HARD_KILL_MS);
      timeoutHardKillTimer.unref?.();
    });
    const clearDrainTimers = () => {
      if (finalDrainTimer) {
        clearTimeout(finalDrainTimer);
        finalDrainTimer = undefined;
      }
      if (finalHardKillTimer) {
        clearTimeout(finalHardKillTimer);
        finalHardKillTimer = undefined;
      }
      if (interruptTerminationTimer) {
        clearTimeout(interruptTerminationTimer);
        interruptTerminationTimer = undefined;
      }
      if (interruptHardKillTimer) {
        clearTimeout(interruptHardKillTimer);
        interruptHardKillTimer = undefined;
      }
      if (timeoutHardKillTimer) {
        clearTimeout(timeoutHardKillTimer);
        timeoutHardKillTimer = undefined;
      }
      clearProtocolLimitHardKillTimer();
    };
    function startFinalDrain(): void {
      if (childExited || finalDrainTimer || settled) return;
      finalDrainTimer = setTimeout(() => {
        if (settled) return;
        const termSent = trySignalChild(child, "SIGTERM");
        if (!termSent) return;
        forcedTerminationSignal = true;
        if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
          error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
        }
        finalHardKillTimer = setTimeout(() => {
          if (settled) return;
          forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
        }, HARD_KILL_MS);
        finalHardKillTimer.unref?.();
      }, FINAL_STOP_GRACE_MS);
      finalDrainTimer.unref?.();
    }
    child.on("exit", (exitCode, signal) => {
      childExited = true;
      exitCodeFromExit = exitCode;
      exitSignalFromExit = signal;
      clearDrainTimers();
      disableSoftInterrupts();
      void resolveProcessCleanup().finally(() => {
        if (settled) return;
        closeFallbackTimer = setTimeout(() => {
          if (settled) return;
          try {
            child.stdout?.destroy();
          } catch {
            void 0;
          }
          try {
            child.stderr?.destroy();
          } catch {
            void 0;
          }
          finalize(exitCodeFromExit, exitSignalFromExit);
        }, CLOSE_FALLBACK_MS);
        closeFallbackTimer.unref?.();
      });
    });
    child.on("close", (exitCode, signal) => {
      disableSoftInterrupts();
      void resolveProcessCleanup().finally(() => {
        finalize(exitCode, signal);
      });
    });

    child.on("error", (spawnError) => {
      processCleanup = skipOwnedProcessGroupCleanup(
        supportsOwnedProcessGroupCleanup() ? "process_group_unavailable" : "unsupported_platform",
        processGroupId,
      );
      settled = true;
      disableSoftInterrupts();
      registerInterrupt?.(undefined);
      registerTimeout?.(undefined);
      clearDrainTimers();
      clearCloseFallbackTimer();
      clearStdioGuard();
      outputStream.end();
      const finalOutput = getFinalOutput(messages) || formatBoundedRawStdout(rawStdout).trim();
      const spawnErrorMessage = boundChildError(
        spawnError instanceof Error ? spawnError.message : String(spawnError),
      );
      resolve({
        stderr: formatBoundedStderr(stderrTail),
        stderrTruncated: stderrTail.wasTruncated() || stderrLineOverflow,
        protocolOutputLimit,
        exitCode: 1,
        messages,
        usage,
        model,
        error: timedOut
          ? (timeoutMessage ?? "Subagent timed out.")
          : (error ?? assistantError ?? spawnErrorMessage),
        finalOutput:
          timedOut && !finalOutput.trim() ? (timeoutMessage ?? "Subagent timed out.") : finalOutput,
        timedOut,
        observedMutationAttempt,
        processGroupId,
        processCleanup,
        contextUsage,
        runtimeModelIdentity,
        configuredModel: context?.configuredModel,
        assistantStopReason: finalAssistantStopReason,
      });
    });
  });
}
