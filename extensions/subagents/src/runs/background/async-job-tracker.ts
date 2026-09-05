import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderWidget, widgetRenderKey } from "../../tui/render.ts";
import { formatControlNoticeMessage, parseControlEvent } from "../shared/subagent-control.ts";
import {
  type AsyncJobState,
  type AsyncStatus,
  type AsyncStartedEvent,
  type ControlEvent,
  type SubagentState,
  normalizeSubagentRunMode,
  POLL_INTERVAL_MS,
  RESULTS_DIR,
  SUBAGENT_CONTROL_EVENT,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import {
  normalizeActiveRuntimeCheckpointAt,
  normalizeActiveRuntimeMs,
} from "../shared/lifecycle-state.ts";
import {
  hasLiveNestedDescendants,
  updateAsyncJobNestedProjection,
} from "../shared/nested-events.ts";
import { scanAsyncRunsForRestore, type AsyncRunSummary } from "./async-status.ts";
import {
  quarantineCorruptAsyncRun,
  type AsyncStatusQuarantineOptions,
} from "./async-status-quarantine.ts";
import { normalizeTkTicketMetadata } from "../shared/tk-ticket.ts";
import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  lookupProjectAgentRunReference,
  releaseProjectAgentRunReference,
  type ProjectAgentRunCapture,
} from "../../agents/project-agent-snapshot.ts";

interface AsyncJobTrackerOptions {
  completionRetentionMs?: number;
  /** Test seam; production defaults to the shared project terminal retention window. */
  projectAgentTerminalRetentionMs?: number;
  pollIntervalMs?: number;
  resultsDir?: string;
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
  now?: () => number;
  quarantine?: AsyncStatusQuarantineOptions;
  /** Test seam for failures while probing restored control-event logs. */
  fs?: Pick<typeof fs, "statSync" | "openSync" | "readSync" | "closeSync">;
}

const CONTROL_EVENT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CONTROL_EVENT_LINE_BYTES = 1024 * 1024;
const CONTROL_EVENT_SCAN_WINDOW_BYTES = 2 * 1024 * 1024;
const COMPLETION_RETENTION_STATES = new Set<string>([
  "complete",
  "failed",
  "paused",
  "cancelled",
  "continued",
]);

function hasUsableProjectSessionFile(sessionFile: unknown): boolean {
  if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) return false;
  const resolved = path.resolve(sessionFile);
  return path.extname(resolved) === ".jsonl" && fs.existsSync(resolved);
}

function hasResumableProjectSibling(
  asyncDir: string | undefined,
  includeTerminalProjectSibling = true,
): boolean {
  if (!asyncDir) return true;
  let status: AsyncStatus | null;
  try {
    status = readStatus(asyncDir);
  } catch {
    return true;
  }
  if (!status || !status.steps || status.steps.length === 0) return true;
  return status.steps.some((step) => {
    const stepStatus = step.status as string;
    if (
      stepStatus === "paused" ||
      stepStatus === "pausing" ||
      stepStatus === "pending" ||
      stepStatus === "running" ||
      stepStatus === "queued"
    ) {
      return true;
    }
    if (stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed") {
      return (
        includeTerminalProjectSibling &&
        step.projectAgent !== undefined &&
        hasUsableProjectSessionFile(step.sessionFile)
      );
    }
    if (stepStatus === "continued" || stepStatus === "cancelled") return false;
    // Unknown status is retained conservatively rather than allowing an
    // unrecognized persisted state to release a project generation.
    return true;
  });
}

export function createAsyncJobTracker(
  pi: Pick<ExtensionAPI, "events">,
  state: SubagentState,
  asyncDirRoot: string,
  options: AsyncJobTrackerOptions = {},
): {
  ensurePoller: () => void;
  handleStarted: (data: unknown) => void;
  handleComplete: (data: unknown) => void;
  resetJobs: (ctx?: ExtensionContext) => void;
  restoreActiveJobs: (ctx?: ExtensionContext) => void;
} {
  const completionRetentionMs = options.completionRetentionMs ?? 10000;
  const projectAgentTerminalRetentionMs =
    options.projectAgentTerminalRetentionMs ?? PROJECT_AGENT_TERMINAL_RETENTION_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const resultsDir = options.resultsDir ?? RESULTS_DIR;
  const restoreWarningDedupe = new Set<string>();
  const restoreControlEventProbeFailures = new Set<string>();
  const projectReferenceCleanupTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; captures: readonly ProjectAgentRunCapture[] }
  >();
  const eventFs = options.fs ?? fs;
  const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
    renderWidget(ctx, jobs, state.liveDetailController);
  };
  const restoredControlEventCursor = (
    asyncDir: string,
  ): { cursor?: number; identity?: string; skippingOversizedLine: boolean } => {
    const eventsPath = path.join(asyncDir, "events.jsonl");
    try {
      const stat = eventFs.statSync(eventsPath);
      let skippingOversizedLine = false;
      if (stat.size > MAX_CONTROL_EVENT_LINE_BYTES) {
        const fd = eventFs.openSync(eventsPath, "r");
        try {
          const probeStart = Math.max(0, stat.size - MAX_CONTROL_EVENT_LINE_BYTES - 1);
          let readCursor = probeStart;
          let lastNewline = -1;
          while (readCursor < stat.size) {
            const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, stat.size - readCursor);
            const buffer = Buffer.alloc(toRead);
            const bytesRead = eventFs.readSync(fd, buffer, 0, toRead, readCursor);
            if (bytesRead <= 0) break;
            for (let index = 0; index < bytesRead; index++) {
              if (buffer[index] === 0x0a) lastNewline = readCursor + index;
            }
            readCursor += bytesRead;
          }
          skippingOversizedLine = stat.size - lastNewline - 1 > MAX_CONTROL_EVENT_LINE_BYTES;
        } finally {
          eventFs.closeSync(fd);
        }
      }
      return { cursor: stat.size, identity: `${stat.dev}:${stat.ino}`, skippingOversizedLine };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { cursor: 0, identity: undefined, skippingOversizedLine: false };
      // Startup restoration must not fail all jobs because one historical
      // control-event log cannot be probed. Starting from zero is the
      // conservative fallback: a later poll can still deliver every readable
      // event rather than silently skipping one.
      restoreControlEventProbeFailures.add(asyncDir);
      return { cursor: 0, identity: undefined, skippingOversizedLine: false };
    }
  };
  const summaryToJob = (run: AsyncRunSummary): AsyncJobState => {
    const visibleSteps = run.steps.map((step, index) => ({ ...step, index }));
    return {
      asyncId: run.id,
      asyncDir: run.asyncDir,
      status: run.state,
      sessionId: run.sessionId,
      activityState: run.activityState,
      lastActivityAt: run.lastActivityAt,
      currentTool: run.currentTool,
      currentToolStartedAt: run.currentToolStartedAt,
      currentPath: run.currentPath,
      turnCount: run.turnCount,
      toolCount: run.toolCount,
      mode: run.mode,
      agents: visibleSteps.map((step) => step.agent),
      currentStep: run.currentStep,
      steps: visibleSteps,
      stepsTotal: visibleSteps.length,
      runningSteps: visibleSteps.filter((step) => step.status === "running").length,
      completedSteps: visibleSteps.filter(
        (step) =>
          step.status === "complete" || step.status === "completed" || step.status === "continued",
      ).length,
      startedAt: run.startedAt,
      updatedAt: run.lastUpdate ?? run.startedAt,
      activeRuntimeMs: run.activeRuntimeMs,
      activeRuntimeCheckpointAt: run.activeRuntimeCheckpointAt,
      timeoutMs: run.timeoutMs,
      deadlineAt: run.deadlineAt,
      timedOut: run.timedOut,
      sessionDir: run.sessionDir,
      outputFile: run.outputFile,
      totalTokens: run.totalTokens,
      sessionFile: run.sessionFile,
      ...(() => {
        const restoredCursor = restoredControlEventCursor(run.asyncDir);
        return {
          controlEventCursor: restoredCursor.cursor,
          controlEventFileIdentity: restoredCursor.identity,
          controlEventSkippingOversizedLine: restoredCursor.skippingOversizedLine,
        };
      })(),
      nestedChildren: run.nestedChildren,
      tkTicket: run.tkTicket,
      projectAgents: run.projectAgents,
    };
  };
  const cancelCleanup = (asyncId: string) => {
    const existingTimer = state.cleanupTimers.get(asyncId);
    if (!existingTimer) return;
    clearTimeout(existingTimer);
    state.cleanupTimers.delete(asyncId);
  };
  const cancelProjectReferenceCleanup = (asyncId: string) => {
    const existingTimer = projectReferenceCleanupTimers.get(asyncId);
    if (!existingTimer) return;
    clearTimeout(existingTimer.timer);
    projectReferenceCleanupTimers.delete(asyncId);
  };
  const scheduleProjectReferenceCleanup = (
    asyncId: string,
    asyncDir: string | undefined,
    options: { siblingSafe: boolean; delayMs?: number },
  ) => {
    const lookup = lookupProjectAgentRunReference(asyncId);
    if (lookup.status !== "found" || lookup.runId !== asyncId) return;
    cancelProjectReferenceCleanup(asyncId);
    const expectedCaptures = lookup.captures;
    const timer = setTimeout(() => {
      const pending = projectReferenceCleanupTimers.get(asyncId);
      if (!pending || pending.timer !== timer) return;
      projectReferenceCleanupTimers.delete(asyncId);
      const current = lookupProjectAgentRunReference(asyncId);
      // Do not let a stale timer release a newer reference that reused this
      // run id after the original reference was released.
      if (
        current.status !== "found" ||
        current.runId !== asyncId ||
        current.captures !== expectedCaptures
      )
        return;
      if (options.siblingSafe) {
        // A missing directory is an uninspectable cohort, not proof that all
        // siblings are terminal. Never release a sibling-safe reference from
        // an undefined path.
        if (!asyncDir) return;
        // Terminal project siblings are protected by this timer only. Active,
        // paused, and unknown siblings remain conservatively retained and are
        // checked again after the next retention window.
        if (hasResumableProjectSibling(asyncDir, false)) {
          scheduleProjectReferenceCleanup(asyncId, asyncDir, options);
          return;
        }
      }
      releaseProjectAgentRunReference(asyncId);
    }, options.delayMs ?? projectAgentTerminalRetentionMs);
    timer.unref?.();
    projectReferenceCleanupTimers.set(asyncId, { timer, captures: expectedCaptures });
  };
  const retainOrReleaseProjectReference = (asyncId: string, asyncDir: string | undefined): void => {
    const lookup = lookupProjectAgentRunReference(asyncId);
    if (lookup.status !== "found" || lookup.runId !== asyncId) return;
    if (hasResumableProjectSibling(asyncDir)) {
      scheduleProjectReferenceCleanup(asyncId, asyncDir, { siblingSafe: true });
      return;
    }
    cancelProjectReferenceCleanup(asyncId);
    releaseProjectAgentRunReference(asyncId);
  };
  const scheduleCleanup = (asyncId: string) => {
    cancelCleanup(asyncId);
    const timer = setTimeout(() => {
      state.cleanupTimers.delete(asyncId);
      const job = state.asyncJobs.get(asyncId);
      if (job && job.status !== "paused") {
        if (
          (job.status === "cancelled" || job.status === "continued") &&
          !projectReferenceCleanupTimers.has(asyncId)
        ) {
          retainOrReleaseProjectReference(asyncId, job.asyncDir);
        } else if (!projectReferenceCleanupTimers.has(asyncId)) {
          // This is only a fallback for terminal jobs whose project retention
          // was deferred while nested descendants were still live.
          scheduleProjectReferenceCleanup(asyncId, job.asyncDir, { siblingSafe: false });
        }
      }
      state.asyncJobs.delete(asyncId);
      if (state.lastUiContext) {
        rerenderWidget(state.lastUiContext);
      }
    }, completionRetentionMs);
    state.cleanupTimers.set(asyncId, timer);
  };
  const formatRestoreIssueCounts = (counts: {
    jsonParse: number;
    persistedValidation: number;
  }): string => {
    const parts: string[] = [];
    if (counts.jsonParse > 0) parts.push(`${counts.jsonParse} malformed JSON`);
    if (counts.persistedValidation > 0)
      parts.push(`${counts.persistedValidation} invalid persisted status`);
    return parts.join(", ");
  };
  const formatRestoredActiveJobsCount = (count: number): string =>
    `restored ${count} valid active ${count === 1 ? "job" : "jobs"}`;
  const warnRestoreIssues = (message: string): void => {
    console.warn(message);
  };
  const emitNewControlEvents = (job: AsyncJobState) => {
    const eventsPath = path.join(job.asyncDir, "events.jsonl");
    let fd: number;
    try {
      fd = fs.openSync(eventsPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
      return;
    }
    try {
      const stat = fs.fstatSync(fd);
      const fileIdentity = `${stat.dev}:${stat.ino}`;
      const savedCursor = job.controlEventCursor;
      const fileReplaced =
        job.controlEventFileIdentity !== undefined && job.controlEventFileIdentity !== fileIdentity;
      const cursorInvalid = fileReplaced || stat.size < (savedCursor ?? 0);
      let cursor = cursorInvalid ? 0 : (savedCursor ?? 0);
      const startedFromTail =
        !cursorInvalid && savedCursor === undefined && stat.size > CONTROL_EVENT_SCAN_WINDOW_BYTES;
      if (startedFromTail) cursor = stat.size - CONTROL_EVENT_SCAN_WINDOW_BYTES;
      job.controlEventFileIdentity = fileIdentity;
      if (cursorInvalid) job.controlEventSkippingOversizedLine = false;
      if (stat.size <= cursor) return;
      const scanEnd = Math.min(stat.size, cursor + CONTROL_EVENT_SCAN_WINDOW_BYTES);
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          console.error(`Ignoring malformed async control event in '${eventsPath}':`, error);
          return;
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          (parsed as { type?: unknown }).type !== "subagent.control"
        )
          return;
        const record = parsed as {
          event?: ControlEvent;
          channels?: string[];
          noticeText?: string;
        };
        const event = parseControlEvent(record.event);
        if (!event || !Array.isArray(record.channels)) return;
        const payload = {
          event,
          source: "async" as const,
          asyncDir: job.asyncDir,
          noticeText: record.noticeText ?? formatControlNoticeMessage(event),
        };
        if (record.channels.includes("event")) {
          pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
        }
      };
      let readCursor = cursor;
      let lastCompleteCursor = cursor;
      let lineParts: Buffer[] = [];
      let lineBytes = 0;
      let skippingOversizedLine = cursorInvalid
        ? false
        : (job.controlEventSkippingOversizedLine ?? startedFromTail);
      const appendLineSegment = (segment: Buffer) => {
        if (segment.length === 0 || skippingOversizedLine) return;
        if (lineBytes + segment.length > MAX_CONTROL_EVENT_LINE_BYTES) {
          lineParts = [];
          lineBytes = 0;
          skippingOversizedLine = true;
          return;
        }
        lineParts.push(segment);
        lineBytes += segment.length;
      };
      while (readCursor < scanEnd) {
        const toRead = Math.min(CONTROL_EVENT_READ_CHUNK_BYTES, scanEnd - readCursor);
        const buffer = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buffer, 0, toRead, readCursor);
        if (bytesRead <= 0) break;
        const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
        let lineStart = 0;
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== 0x0a) continue;
          appendLineSegment(chunk.subarray(lineStart, index));
          if (!skippingOversizedLine && lineBytes > 0) {
            handleLine(Buffer.concat(lineParts, lineBytes).toString("utf-8"));
          }
          lineParts = [];
          lineBytes = 0;
          skippingOversizedLine = false;
          lastCompleteCursor = readCursor + index + 1;
          lineStart = index + 1;
        }
        appendLineSegment(chunk.subarray(lineStart));
        readCursor += bytesRead;
        if (skippingOversizedLine) {
          job.controlEventCursor = readCursor;
          job.controlEventSkippingOversizedLine = true;
        }
      }
      if (skippingOversizedLine) {
        job.controlEventCursor = readCursor;
        job.controlEventSkippingOversizedLine = true;
      } else if (lastCompleteCursor > cursor) {
        job.controlEventCursor = lastCompleteCursor;
        job.controlEventSkippingOversizedLine = false;
      } else if (scanEnd < stat.size || startedFromTail) {
        job.controlEventCursor = scanEnd;
      }
    } catch (error) {
      console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
    } finally {
      fs.closeSync(fd);
    }
  };

  const ensurePoller = () => {
    if (state.poller) return;
    state.poller = setInterval(() => {
      if (state.asyncJobs.size === 0) {
        if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
        if (state.poller) {
          clearInterval(state.poller);
          state.poller = null;
        }
        return;
      }

      let widgetChanged = false;
      for (const job of state.asyncJobs.values()) {
        const widgetStateBefore = widgetRenderKey(job);
        let nestedRefreshFailed = false;
        const refreshNestedProjection = () => {
          try {
            updateAsyncJobNestedProjection(job);
          } catch (error) {
            nestedRefreshFailed = true;
            console.error(
              `Failed to refresh nested async descendants for '${job.asyncDir}':`,
              error,
            );
          }
        };
        const reconcileNestedDescendants = () => {
          try {
            if (job.nestedRoute)
              reconcileNestedAsyncDescendants(job.nestedRoute, {
                resultsDir,
                kill: options.kill,
                now: options.now,
              });
          } catch (error) {
            nestedRefreshFailed = true;
            console.error(
              `Failed to refresh nested async descendants for '${job.asyncDir}':`,
              error,
            );
          }
          refreshNestedProjection();
        };
        try {
          emitNewControlEvents(job);
          reconcileNestedDescendants();
          const reconciliation = reconcileAsyncRun(job.asyncDir, {
            resultsDir,
            kill: options.kill,
            now: options.now,
            startedRun: {
              runId: job.asyncId,
              pid: job.pid,
              sessionId: job.sessionId,
              mode: job.mode,
              agents: job.agents,
              startedAt: job.startedAt,
              sessionFile: job.sessionFile,
              projectAgents: job.projectAgents,
            },
          });
          const status = reconciliation.status ?? readStatus(job.asyncDir);
          if (status) {
            const previousStatus = job.status;
            job.status = status.state;
            if (!COMPLETION_RETENTION_STATES.has(job.status)) cancelCleanup(job.asyncId);
            job.sessionId = status.sessionId ?? job.sessionId;
            job.activityState = status.activityState;
            job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
            job.currentTool = status.currentTool;
            job.currentToolStartedAt = status.currentToolStartedAt;
            job.currentPath = status.currentPath;
            job.turnCount = status.turnCount ?? job.turnCount;
            job.toolCount = status.toolCount ?? job.toolCount;
            job.mode = normalizeSubagentRunMode(status.mode);
            job.currentStep = status.currentStep ?? job.currentStep;
            job.startedAt = status.startedAt ?? job.startedAt;
            const persistedRuntime = normalizeActiveRuntimeMs(status.activeRuntimeMs);
            const observedRuntime = normalizeActiveRuntimeMs(job.activeRuntimeMs);
            if (persistedRuntime !== undefined || observedRuntime !== undefined) {
              job.activeRuntimeMs = Math.max(persistedRuntime ?? 0, observedRuntime ?? 0);
            }
            const persistedCheckpoint = normalizeActiveRuntimeCheckpointAt(
              status.activeRuntimeCheckpointAt,
            );
            const observedCheckpoint = normalizeActiveRuntimeCheckpointAt(
              job.activeRuntimeCheckpointAt,
            );
            if (persistedCheckpoint !== undefined || observedCheckpoint !== undefined) {
              job.activeRuntimeCheckpointAt = Math.max(
                persistedCheckpoint ?? 0,
                observedCheckpoint ?? 0,
              );
            }
            if (status.lastUpdate !== undefined) job.updatedAt = status.lastUpdate;
            if (
              job.status !== "complete" &&
              job.status !== "failed" &&
              job.status !== "continued" &&
              job.status !== "cancelled"
            ) {
              cancelProjectReferenceCleanup(job.asyncId);
            }
            if (status.steps?.length) {
              const visibleSteps = status.steps.map((step, index) => ({ ...step, index }));
              job.agents = visibleSteps.map((step) => step.agent);
              job.steps = visibleSteps;
              refreshNestedProjection();
              job.stepsTotal = visibleSteps.length;
              job.runningSteps = visibleSteps.filter((step) => step.status === "running").length;
              job.completedSteps = visibleSteps.filter(
                (step) =>
                  step.status === "complete" ||
                  step.status === "completed" ||
                  step.status === "continued",
              ).length;
              if (status.state === "complete") job.completedSteps = visibleSteps.length;
            }
            job.sessionDir = status.sessionDir ?? job.sessionDir;
            job.outputFile = status.outputFile ?? job.outputFile;
            job.totalTokens = status.totalTokens ?? job.totalTokens;
            job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
            job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
            job.timedOut = status.timedOut ?? job.timedOut;
            job.sessionFile = status.sessionFile ?? job.sessionFile;
            if (status.tkTicket !== undefined)
              job.tkTicket = normalizeTkTicketMetadata(status.tkTicket);
            if (status.projectAgents !== undefined) job.projectAgents = status.projectAgents;
            const liveNestedDescendants = hasLiveNestedDescendants(job.nestedChildren);
            if (
              (job.status === "complete" || job.status === "failed") &&
              !nestedRefreshFailed &&
              !liveNestedDescendants &&
              !projectReferenceCleanupTimers.has(job.asyncId)
            ) {
              scheduleProjectReferenceCleanup(job.asyncId, job.asyncDir, { siblingSafe: false });
            }
            if (liveNestedDescendants) cancelCleanup(job.asyncId);
            if (
              COMPLETION_RETENTION_STATES.has(job.status) &&
              !nestedRefreshFailed &&
              !liveNestedDescendants &&
              (previousStatus !== job.status || !state.cleanupTimers.has(job.asyncId))
            ) {
              scheduleCleanup(job.asyncId);
            }
            if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
            continue;
          }
          const liveNestedDescendants = hasLiveNestedDescendants(job.nestedChildren);
          if (
            (job.status === "complete" || job.status === "failed") &&
            !liveNestedDescendants &&
            !projectReferenceCleanupTimers.has(job.asyncId)
          ) {
            scheduleProjectReferenceCleanup(job.asyncId, job.asyncDir, { siblingSafe: false });
          }
          if (liveNestedDescendants) {
            cancelCleanup(job.asyncId);
          } else if (
            COMPLETION_RETENTION_STATES.has(job.status) &&
            !state.cleanupTimers.has(job.asyncId)
          ) {
            scheduleCleanup(job.asyncId);
          }
          if (job.status === "queued") {
            job.status = "running";
            job.updatedAt = Date.now();
          }
        } catch (error) {
          if (job.status !== "failed") {
            console.error(`Failed to read async status for '${job.asyncDir}':`, error);
            job.status = "failed";
            job.updatedAt = Date.now();
          }
          if (hasLiveNestedDescendants(job.nestedChildren)) {
            cancelCleanup(job.asyncId);
          } else if (!state.cleanupTimers.has(job.asyncId)) {
            scheduleCleanup(job.asyncId);
          }
        }
        if (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
      }

      if (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
    }, pollIntervalMs);
    state.poller.unref?.();
  };

  const handleStarted = (data: unknown) => {
    const info = data as AsyncStartedEvent;
    if (!info.id) return;
    if (typeof state.currentSessionId === "string" && info.sessionId !== state.currentSessionId)
      return;
    const now = Date.now();
    cancelProjectReferenceCleanup(info.id);
    const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
    const agents = info.agents?.length ? info.agents : info.agent ? [info.agent] : undefined;
    const normalizedTkTicket = normalizeTkTicketMetadata(info.tkTicket);
    state.asyncJobs.set(info.id, {
      asyncId: info.id,
      asyncDir,
      status: "queued",
      pid: typeof info.pid === "number" ? info.pid : undefined,
      ...(typeof info.sessionId === "string" ? { sessionId: info.sessionId } : {}),
      mode: normalizeSubagentRunMode(info.mode),
      agents,
      nestedRoute: info.nestedRoute,
      stepsTotal: agents?.length,
      startedAt: now,
      updatedAt: now,
      timeoutMs: info.timeoutMs,
      deadlineAt: info.deadlineAt,
      controlEventCursor: 0,
      tkTicket: normalizedTkTicket,
      projectAgents: info.projectAgents,
    });
    ensurePoller();
    if (state.lastUiContext) {
      rerenderWidget(state.lastUiContext);
    }
  };

  const handleComplete = (data: unknown) => {
    const result = data as {
      id?: string;
      success?: boolean;
      asyncDir?: string;
      sessionId?: string;
      state?: AsyncJobState["status"];
    };
    if (typeof state.currentSessionId === "string" && result.sessionId !== state.currentSessionId)
      return;
    const asyncId = result.id;
    if (!asyncId) return;
    const job = state.asyncJobs.get(asyncId);
    let nestedRefreshFailed = false;
    if (job) {
      job.status =
        result.state === "continued" || result.state === "cancelled"
          ? result.state
          : result.success
            ? "complete"
            : "failed";
      job.updatedAt = Date.now();
      if (result.asyncDir) job.asyncDir = result.asyncDir;
      try {
        updateAsyncJobNestedProjection(job);
      } catch (error) {
        nestedRefreshFailed = true;
        console.error(`Failed to refresh nested async descendants for '${job.asyncDir}':`, error);
      }
    }
    if (result.state === "cancelled" || result.state === "continued") {
      retainOrReleaseProjectReference(asyncId, job?.asyncDir ?? result.asyncDir);
    } else if (
      (job?.status === "complete" || job?.status === "failed") &&
      !nestedRefreshFailed &&
      !hasLiveNestedDescendants(job?.nestedChildren) &&
      !projectReferenceCleanupTimers.has(asyncId)
    ) {
      scheduleProjectReferenceCleanup(asyncId, job?.asyncDir ?? result.asyncDir, {
        siblingSafe: false,
      });
    }
    if (state.lastUiContext) {
      rerenderWidget(state.lastUiContext);
    }
    if (hasLiveNestedDescendants(job?.nestedChildren)) {
      cancelCleanup(asyncId);
    } else if (!nestedRefreshFailed) {
      scheduleCleanup(asyncId);
    }
  };

  const resetJobs = (ctx?: ExtensionContext) => {
    for (const timer of state.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    state.cleanupTimers.clear();
    // Keep same-session project retention timers alive across /reload. They
    // are private registry ownership, not UI state; clearing them here would
    // strand terminal references after their result/status files are removed.
    // A timer from another session is stale and must not survive into an id
    // reuse in the new session.
    for (const [asyncId, pending] of projectReferenceCleanupTimers) {
      const sameSession =
        typeof state.currentSessionId === "string" &&
        pending.captures.length > 0 &&
        pending.captures.every(
          (capture) => capture.provenance.sessionId === state.currentSessionId,
        );
      if (!sameSession) {
        clearTimeout(pending.timer);
        projectReferenceCleanupTimers.delete(asyncId);
      }
    }
    state.asyncJobs.clear();
    state.foregroundControls?.clear();
    state.lastForegroundControlId = null;
    state.resultFileCoalescer.clear();
    if (ctx?.hasUI) {
      state.lastUiContext = ctx;
      rerenderWidget(ctx, []);
    }
  };

  const restoreActiveJobs = (ctx?: ExtensionContext) => {
    if (ctx?.hasUI) state.lastUiContext = ctx;
    if (!state.currentSessionId) return;
    restoreControlEventProbeFailures.clear();
    let runs: AsyncRunSummary[];
    let issues: ReturnType<typeof scanAsyncRunsForRestore>["issues"];
    try {
      ({ runs, issues } = scanAsyncRunsForRestore(asyncDirRoot, {
        states: ["queued", "running"],
        sessionId: state.currentSessionId,
        resultsDir,
        kill: options.kill,
        now: options.now,
      }));
    } catch (error) {
      console.error(`Failed to restore active async jobs from '${asyncDirRoot}':`, error);
      return;
    }
    const quarantined = { jsonParse: 0, persistedValidation: 0 };
    const deferred = { jsonParse: 0, persistedValidation: 0 };
    const failed = { jsonParse: 0, persistedValidation: 0 };
    for (const issue of issues) {
      const result = quarantineCorruptAsyncRun(asyncDirRoot, issue, options.quarantine);
      if (result.outcome === "quarantined") {
        if (result.kind === "json_parse") quarantined.jsonParse += 1;
        else quarantined.persistedValidation += 1;
        continue;
      }
      if (
        (result.outcome === "deferred" || result.outcome === "failed") &&
        !restoreWarningDedupe.has(result.dedupeKey)
      ) {
        restoreWarningDedupe.add(result.dedupeKey);
        const bucket = result.outcome === "deferred" ? deferred : failed;
        if (result.kind === "json_parse") bucket.jsonParse += 1;
        else bucket.persistedValidation += 1;
      }
    }
    const warnings: string[] = [formatRestoredActiveJobsCount(runs.length)];
    const quarantinedSummary = formatRestoreIssueCounts(quarantined);
    if (quarantinedSummary) warnings.push(`quarantined ${quarantinedSummary}`);
    const deferredSummary = formatRestoreIssueCounts(deferred);
    if (deferredSummary) warnings.push(`deferred ${deferredSummary}`);
    const failedSummary = formatRestoreIssueCounts(failed);
    if (failedSummary) warnings.push(`left ${failedSummary} in place`);
    if (warnings.length > 1)
      warnRestoreIssues(`Async restore skipped corrupt startup runs: ${warnings.join("; ")}.`);
    for (const run of runs) {
      state.asyncJobs.set(run.id, summaryToJob(run));
    }
    if (
      restoreControlEventProbeFailures.size > 0 &&
      !restoreWarningDedupe.has("control-event-probe-failure")
    ) {
      restoreWarningDedupe.add("control-event-probe-failure");
      const count = restoreControlEventProbeFailures.size;
      warnRestoreIssues(
        `Async restore could not inspect persisted control events for ${count} active ${count === 1 ? "job" : "jobs"}; continued restoring active jobs.`,
      );
    }
    if (runs.length === 0) return;
    ensurePoller();
    if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
  };

  return { ensurePoller, handleStarted, handleComplete, resetJobs, restoreActiveJobs };
}
