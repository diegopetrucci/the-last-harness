import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  COMPLETION_DELIVERY,
  type CompletionDeliveryMetadata,
  isSeenWithTtl,
  markSeen,
} from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentEventBus,
  type AsyncStatus,
  type SubagentResultChild,
  type SubagentState,
} from "../../shared/types.ts";
import { resolveSubagentResultStatus } from "../../shared/result-formatting.ts";
import {
  lifecycleContinuationForIndex,
  withLifecycleStatusLock,
} from "../shared/lifecycle-state.ts";
import { readStatus } from "../../shared/utils.ts";
import {
  PROJECT_AGENT_TERMINAL_RETENTION_MS,
  lookupProjectAgentRunReference,
  releaseProjectAgentRunReference,
} from "../../agents/project-agent-snapshot.ts";
import { TERMINAL_ASYNC_DIR_MAX_AGE_MS } from "../../extension/runtime-cleanup.ts";
import { normalizeSubagentRunTelemetry } from "../../shared/telemetry.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;

type ResultWatcherFs = Pick<
  typeof fs,
  | "existsSync"
  | "readFileSync"
  | "statSync"
  | "unlinkSync"
  | "readdirSync"
  | "mkdirSync"
  | "realpathSync"
  | "watch"
>;

/** Typed timer handle for ResultWatcherTimers. */
export type ResultWatcherTimerHandle = ReturnType<typeof setTimeout> | number;

/** Helper to call .unref() on a timer handle when available. */
function unrefTimer(handle: ResultWatcherTimerHandle | null | undefined): void {
  if (handle != null && typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
}

export type ResultWatcherTimers = {
  setTimeout(callback: () => void, ms?: number): ResultWatcherTimerHandle;
  clearTimeout(id: ResultWatcherTimerHandle): void;
  setInterval(callback: () => void, ms?: number): ResultWatcherTimerHandle;
  clearInterval(id: ResultWatcherTimerHandle): void;
};

type ResultWatcherDeps = {
  fs?: ResultWatcherFs;
  timers?: ResultWatcherTimers;
  /** Test seam; production uses the shared project terminal retention window. */
  projectAgentTerminalRetentionMs?: number;
};

type ResultFileChild = {
  agent?: string;
  output?: string;
  error?: string;
  success?: boolean;
  exitCode?: number;
  interrupted?: boolean;
  sessionFile?: string;
  artifactPaths?: { outputPath?: string };
};

type ResultFileData = {
  id?: string;
  runId?: string;
  agent?: string;
  success?: boolean;
  state?: string;
  mode?: string;
  summary?: string;
  results?: ResultFileChild[];
  sessionId?: string;
  cwd?: string;
  sessionFile?: string;
  asyncDir?: string;
  lifecycleArtifactVersion?: number;
  telemetry?: unknown;
  /** Durable identity stamped at write time (crypto.randomUUID). See AsyncResultArtifact. */
  eventId?: string;
};

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EMFILE" || code === "ENOSPC";
}

function resolveNativeWatchDir(fsApi: ResultWatcherFs, resultsDir: string): string {
  try {
    return fsApi.realpathSync.native(resultsDir);
  } catch {
    return resultsDir;
  }
}

function resolveResultFileChildStatus(
  result: ResultFileChild,
  parentState: string | undefined,
): ReturnType<typeof resolveSubagentResultStatus> {
  const hasChildStatusMetadata =
    typeof result.success === "boolean" || typeof result.exitCode === "number";
  const interrupted =
    result.interrupted === true ||
    (result.interrupted === undefined &&
      parentState === "paused" &&
      result.success === false &&
      result.exitCode === 0);
  return resolveSubagentResultStatus({
    interrupted,
    success: result.success,
    exitCode: result.exitCode,
    state: !hasChildStatusMetadata && parentState !== "paused" ? parentState : undefined,
  });
}

type PausedArtifactDecision = "notify" | "discard" | "retry" | "compat";

function resolvePausedArtifactTargetIndex(data: ResultFileData): number | undefined {
  const children = Array.isArray(data.results) ? data.results : [];
  if (children.length <= 1) return 0;
  const pausedChild = children.find(
    (child) =>
      resolveResultFileChildStatus(child, data.state) === "paused" &&
      typeof child.sessionFile === "string" &&
      child.sessionFile.length > 0,
  );
  return pausedChild ? children.indexOf(pausedChild) : undefined;
}

function hasUsableProjectSessionFile(sessionFile: unknown, fsApi: ResultWatcherFs): boolean {
  if (typeof sessionFile !== "string" || sessionFile.trim().length === 0) return false;
  const resolved = path.resolve(sessionFile);
  return path.extname(resolved) === ".jsonl" && fsApi.existsSync(resolved);
}

function hasResumableProjectSibling(
  data: ResultFileData,
  fsApi: ResultWatcherFs,
  includeTerminalProjectSibling = true,
): boolean {
  if (typeof data.asyncDir !== "string" || data.asyncDir.length === 0) {
    // Without a status file we cannot prove that a multi-child artifact has no
    // resumable sibling. Keep the private generation rather than releasing it
    // on mutable/incomplete result metadata.
    return true;
  }
  let status: AsyncStatus | null;
  try {
    status = readStatus(data.asyncDir);
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
        hasUsableProjectSessionFile(step.sessionFile, fsApi)
      );
    }
    if (stepStatus === "continued" || stepStatus === "cancelled") return false;
    return true;
  });
}

function resolvePausedArtifactDecision(data: ResultFileData): PausedArtifactDecision {
  if (data.state !== "paused") return "compat";
  if (
    typeof data.asyncDir !== "string" ||
    data.asyncDir.length === 0 ||
    data.lifecycleArtifactVersion !== 1
  )
    return "compat";
  try {
    return withLifecycleStatusLock(
      data.asyncDir,
      (status) => {
        if (!status || status.state === "pausing") return "retry";
        if (status.state === "continued" || status.state === "cancelled") return "discard";
        if (status.state !== "paused") return "retry";
        const targetIndex = resolvePausedArtifactTargetIndex(data);
        if (targetIndex === undefined) return "retry";
        const targetStep = status.steps?.[targetIndex];
        if (targetStep?.status === "continued" || targetStep?.status === "cancelled")
          return "discard";
        if (targetStep?.status === "pausing") return "retry";
        const continuation = lifecycleContinuationForIndex(status, targetIndex);
        if (continuation?.phase === "continued") return "discard";
        if (
          continuation?.phase === "claimed" ||
          continuation?.phase === "reserved" ||
          continuation?.phase === "launched"
        )
          return "retry";
        if (!targetStep || targetStep.status === "paused") return "notify";
        return "retry";
      },
      { retryDelaysMs: [] },
    );
  } catch {
    return "retry";
  }
}

export function createResultWatcher(
  pi: { events: SubagentEventBus },
  state: SubagentState,
  resultsDir: string,
  completionTtlMs: number,
  deps: ResultWatcherDeps = {},
): {
  startResultWatcher: () => void;
  primeExistingResults: () => void;
  stopResultWatcher: () => void;
  clearPendingAcks: () => void;
  /** Remove undelivered result files older than TERMINAL_ASYNC_DIR_MAX_AGE_MS
   * (7 days), releasing any held project references first.
   * Pass nowMs in tests to control the clock; production passes nothing. */
  sweepStaleResultFiles: (nowMs?: number) => void;
} {
  const fsApi = deps.fs ?? fs;
  const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
  const projectAgentTerminalRetentionMs =
    deps.projectAgentTerminalRetentionMs ?? PROJECT_AGENT_TERMINAL_RETENTION_MS;
  // Set to false by stopResultWatcher() so that orphan-timer retry-rescheduling
  // callbacks (which call resultFileCoalescer.schedule) do not fire on a stopped
  // watcher instance.  Project-reference cleanup timers are independent and
  // intentionally kept alive; only delivery-retry scheduling is suppressed.
  let watcherActive = true;

  // Tracks completions whose events have been emitted but whose
  // acknowledgeDelivery has not yet fired.  Prevents duplicate emissions
  // of the same file while a delivery is in-flight.  Cleared by ack on
  // success and by the orphan timer on timeout (to permit re-discovery).
  // clearPendingAcks() is called on session start/switch so that a result
  // file for the re-entering session is always re-emittable.
  const pendingAcks = new Set<string>();

  const projectReferenceReleaseTimers = new Map<
    string,
    ReturnType<ResultWatcherTimers["setTimeout"]>
  >();
  const cancelProjectReferenceRelease = (runId: string): void => {
    const timer = projectReferenceReleaseTimers.get(runId);
    if (!timer) return;
    timers.clearTimeout(timer);
    projectReferenceReleaseTimers.delete(runId);
  };
  const scheduleProjectReferenceRelease = (data: ResultFileData, runId: string): void => {
    const lookup = lookupProjectAgentRunReference(runId);
    if (lookup.status !== "found" || lookup.runId !== runId) return;
    cancelProjectReferenceRelease(runId);
    const timer = timers.setTimeout(() => {
      projectReferenceReleaseTimers.delete(runId);
      // A missing directory is an uninspectable cohort, not proof that all
      // siblings are terminal. Never release a project reference unguarded.
      if (!data.asyncDir) return;
      // Terminal project siblings are retained only through this timer. Active,
      // paused, and unknown siblings remain protected and are checked again.
      if (hasResumableProjectSibling(data, fsApi, false)) {
        scheduleProjectReferenceRelease(data, runId);
        return;
      }
      releaseProjectAgentRunReference(runId);
    }, projectAgentTerminalRetentionMs);
    unrefTimer(timer);
    projectReferenceReleaseTimers.set(runId, timer);
  };
  const retainOrReleaseProjectReference = (data: ResultFileData, runId: string): void => {
    const lookup = lookupProjectAgentRunReference(runId);
    if (lookup.status !== "found" || lookup.runId !== runId) return;
    if (hasResumableProjectSibling(data, fsApi)) {
      scheduleProjectReferenceRelease(data, runId);
      return;
    }
    releaseProjectAgentRunReference(runId);
  };

  const handleResult = (file: string) => {
    const resultPath = path.join(resultsDir, file);
    if (!fsApi.existsSync(resultPath)) return;
    try {
      // Read raw bytes once; derive eventId from data.eventId (stamped by
      // the writer) or, for legacy files, from a sha256 content digest so every
      // file always has a durable identity.
      const rawBytes = fsApi.readFileSync(resultPath, "utf-8");
      const data = JSON.parse(rawBytes) as ResultFileData;
      // Durable eventId: prefer the field stamped at write time; fall back
      // to sha256(file-bytes) for files written before this field was introduced.
      const eventId: string =
        typeof data.eventId === "string" && data.eventId.length > 0
          ? data.eventId
          : createHash("sha256").update(rawBytes).digest("hex");
      // Session-exact delivery (upstream v0.34.0 cutover). This also preserves the
      // issue #45 defense in depth: foreign/fixture files without a sessionId are
      // skipped without unlinking, so we never emit a ghost 'Background task
      // completed' notification for them.
      if (typeof data.sessionId !== "string" || data.sessionId !== state.currentSessionId) return;

      const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
      const now = Date.now();
      const pausedDecision = resolvePausedArtifactDecision(data);
      if (pausedDecision === "retry") return;
      if (pausedDecision === "discard") {
        retainOrReleaseProjectReference(data, runId);
        fsApi.unlinkSync(resultPath);
        return;
      }

      const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
      const resultChildren = hasResultChildren
        ? data.results!
        : [
            {
              agent: data.agent,
              output: data.summary,
              success: data.success,
            },
          ];
      const normalizedChildren = resultChildren.map(
        (result = {}, arrayIndex): SubagentResultChild => {
          const baseOutput = result.output ?? data.summary;
          const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
          const output = hasRealOutput ? baseOutput : "(no output)";
          const summary =
            result.success === false && result.error
              ? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
              : output;
          const sessionPath =
            result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
          return {
            agent: result.agent ?? data.agent ?? `step-${arrayIndex + 1}`,
            status: resolveResultFileChildStatus(result, data.state),
            summary,
            index: arrayIndex,
            artifactPath: result.artifactPaths?.outputPath,
            ...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath)
              ? { sessionPath }
              : {}),
          };
        },
      );

      // Dedup keyed by eventId — both the watcher completionSeen map and
      // the pendingAcks in-flight set use the durable eventId as key.
      if (isSeenWithTtl(state.completionSeen, eventId, now, completionTtlMs)) {
        // Already delivered (ack marked completionSeen).  The file survived
        // (transient unlink failure or crash-rewrite).  Clean it up without
        // re-emitting — but only if the on-disk eventId still matches what we
        // just observed (safe-unlink guard).
        try {
          const currentRaw = fsApi.readFileSync(resultPath, "utf-8");
          const currentData = JSON.parse(currentRaw) as ResultFileData;
          const currentId =
            typeof currentData.eventId === "string" && currentData.eventId.length > 0
              ? currentData.eventId
              : createHash("sha256").update(currentRaw).digest("hex");
          if (currentId === eventId) fsApi.unlinkSync(resultPath);
        } catch {
          // ENOENT or transient failure; ignore.
        }
        return;
      }
      if (pendingAcks.has(eventId)) {
        // A delivery is already in-flight for this eventId.  Do not re-emit;
        // let the existing ack or orphan timer own cleanup and re-allowance.
        return;
      }

      // ackReceived: true once acknowledgeDelivery is called (delivery confirmed).
      // ackFired:    true once the result file is successfully unlinked.
      // These are separate because a transient unlink failure sets ackReceived
      // but not ackFired; the orphan timer then retries the unlink.
      let ackReceived = false;
      let ackFired = false;

      // Safe unlink — re-read the file and verify its current eventId matches
      // the one we emitted before deleting.  This prevents destroying a file that
      // was atomically replaced with a new write (different eventId) while
      // delivery was in-flight.
      const tryUnlinkResultFile = () => {
        try {
          // Re-read to verify the on-disk eventId still matches.
          const currentRaw = fsApi.readFileSync(resultPath, "utf-8");
          const currentData = JSON.parse(currentRaw) as ResultFileData;
          const currentId =
            typeof currentData.eventId === "string" && currentData.eventId.length > 0
              ? currentData.eventId
              : createHash("sha256").update(currentRaw).digest("hex");
          if (currentId !== eventId) {
            // A newer write replaced the file.  Leave it so the next scan
            // can deliver the new content under its own eventId.
            ackFired = true; // treat as "done" — we intentionally skip deletion
            timers.clearTimeout(orphanTimer);
            return;
          }
          fsApi.unlinkSync(resultPath);
          ackFired = true;
          timers.clearTimeout(orphanTimer);
        } catch (unlinkErr) {
          if (isNotFoundError(unlinkErr)) {
            // File was already gone; treat as success.
            ackFired = true;
            timers.clearTimeout(orphanTimer);
          } else {
            // Transient failure (e.g. EBUSY, EPERM).
            // Leave ackFired=false so the orphan timer can retry later.
            console.error(`Failed to remove subagent result file '${resultPath}':`, unlinkErr);
          }
        }
      };

      // Watcher-side project-reference management helper — called from
      // acknowledgeDelivery (after confirmed delivery) and from the orphan
      // timer fallback (when ack never arrives) to prevent reference leaks.
      // Idempotent: both helpers guard against missing or already-released refs.
      const runProjectReferenceMgmt = () => {
        if (data.state === "cancelled" || data.state === "continued") {
          retainOrReleaseProjectReference(data, runId);
        } else if (data.state === "complete" || data.state === "failed") {
          scheduleProjectReferenceRelease(data, runId);
        }
      };

      // Orphan timer: fired when the file has not been unlinked within completionTtlMs.
      //
      // Case 1 — ackReceived is true (delivery confirmed) but ackFired is false
      //   (unlink failed transiently): retry the unlink.
      // Case 2 — ackReceived is false (delivery failed: send threw, session
      //   switched away, or process restarted):
      //   • Clear the in-flight slot (keyed by eventId) so the next scan can
      //     re-discover and re-deliver the result.
      //   • Do NOT delete the file.
      //   • Run watcher-side project-reference management as a fallback.
      const orphanTimer = timers.setTimeout(() => {
        if (ackFired) return;
        if (ackReceived) {
          tryUnlinkResultFile();
          return;
        }
        // Delivery was never confirmed (send threw, session switched, or process
        // restarted before ack).  Clear the in-flight slot so the coalescer can
        // re-process the file, then schedule it immediately for another attempt.
        // Under native fs.watch no rename event fires for an existing file, so
        // the coalescer is the only way to rediscover it without a full rescan.
        // Each failed retry creates a new orphan timer; retries therefore recur
        // approximately every completionTtlMs (~10 min in production).
        // Do NOT reschedule if the watcher was stopped; a replacement watcher
        // must not receive events from this instance's orphan timers.
        pendingAcks.delete(eventId);
        runProjectReferenceMgmt();
        if (watcherActive) state.resultFileCoalescer.schedule(file, 0);
      }, completionTtlMs);
      unrefTimer(orphanTimer);

      // onAcknowledged callbacks — registered by consumers (e.g. async-job-tracker)
      // to defer side effects (project-reference management) to after confirmed delivery.
      const onAcknowledgedCallbacks: Array<() => void> = [];

      // acknowledgeDelivery is called by notify.ts after each sendMessage.
      // Only then do we mark completionSeen, release the in-flight slot, run
      // project-reference management, fire onAcknowledged callbacks, and unlink.
      const acknowledgeDelivery = () => {
        if (ackReceived) return; // Idempotent.
        ackReceived = true;
        // Key completionSeen on eventId.
        markSeen(state.completionSeen, eventId, now);
        pendingAcks.delete(eventId);
        // Fire onAcknowledged callbacks (e.g. tracker project-ref management).
        for (const cb of onAcknowledgedCallbacks) {
          try {
            cb();
          } catch (cbErr) {
            console.error("onAcknowledged callback error:", cbErr);
          }
        }
        // Watcher-side project-reference management.
        runProjectReferenceMgmt();
        tryUnlinkResultFile();
      };

      // onAcknowledged registration function passed to consumers via the Symbol metadata.
      // If acknowledgement already happened (e.g. notify ran synchronously before the
      // tracker could register), invoke the callback immediately (once) so late
      // registrations do not silently miss their side-effect window.
      const onAcknowledged: CompletionDeliveryMetadata["onAcknowledged"] = (cb) => {
        if (ackReceived) {
          try {
            cb();
          } catch (cbErr) {
            console.error("onAcknowledged callback error:", cbErr);
          }
          return;
        }
        onAcknowledgedCallbacks.push(cb);
      };

      // Register as in-flight before emitting (keyed by eventId).
      pendingAcks.add(eventId);
      const telemetry = normalizeSubagentRunTelemetry(data.telemetry);
      // Attach delivery metadata under the Symbol key so it never serialises
      // into message details, telemetry, or session entries.
      const deliveryMetadata: CompletionDeliveryMetadata = {
        eventId,
        acknowledgeDelivery,
        onAcknowledged,
      };
      pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        ...data,
        runId,
        [COMPLETION_DELIVERY]: deliveryMetadata,
        ...(telemetry ? { telemetry } : { telemetry: undefined }),
        ...(Array.isArray(data.results)
          ? {
              results: hasResultChildren
                ? normalizedChildren.map((child, index) => ({
                    ...data.results![index],
                    agent: child.agent,
                    status: child.status,
                    summary: child.summary,
                    index: child.index,
                    artifactPath: child.artifactPath,
                    sessionPath: child.sessionPath,
                  }))
                : [],
            }
          : {}),
      });
      // Project-reference management now runs in acknowledgeDelivery (after
      // confirmed delivery) and in the orphan timer fallback (when ack never
      // arrives).  See runProjectReferenceMgmt defined above.
    } catch (error) {
      if (isNotFoundError(error)) return;
      console.error(`Failed to process subagent result file '${resultPath}':`, error);
    }
  };

  state.resultFileCoalescer = createFileCoalescer((file) => {
    void handleResult(file);
  }, 50);

  const primeExistingResults = () => {
    try {
      fsApi
        .readdirSync(resultsDir)
        .filter((f) => f.endsWith(".json"))
        .forEach((file) => state.resultFileCoalescer.schedule(file, 0));
    } catch (error) {
      if (isNotFoundError(error)) return;
      console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
    }
  };

  const startPollingFallback = (reason: unknown) => {
    state.watcher?.close();
    state.watcher = null;
    if (state.watcherRestartTimer) return;

    console.error(
      `Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
    );
    primeExistingResults();
    state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
    unrefTimer(state.watcherRestartTimer);
  };

  const scheduleRestart = () => {
    if (state.watcherRestartTimer) return;
    state.watcherRestartTimer = timers.setTimeout(() => {
      state.watcherRestartTimer = null;
      try {
        fsApi.mkdirSync(resultsDir, { recursive: true });
        startResultWatcher();
      } catch (error) {
        if (shouldFallBackToPolling(error)) {
          startPollingFallback(error);
          return;
        }
        console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
        scheduleRestart();
      }
    }, WATCHER_RESTART_DELAY_MS);
    unrefTimer(state.watcherRestartTimer);
  };

  const startResultWatcher = () => {
    if (state.watcher) return;
    if (state.watcherRestartTimer) {
      timers.clearTimeout(state.watcherRestartTimer);
      timers.clearInterval(state.watcherRestartTimer);
      state.watcherRestartTimer = null;
    }
    try {
      const watchDir = resolveNativeWatchDir(fsApi, resultsDir);
      state.watcher = fsApi.watch(watchDir, (ev, file) => {
        if (ev !== "rename" || !file) return;
        const fileName = file.toString();
        if (!fileName.endsWith(".json")) return;
        state.resultFileCoalescer.schedule(fileName);
      });
      state.watcher.on("error", (error) => {
        if (shouldFallBackToPolling(error)) {
          startPollingFallback(error);
          return;
        }
        console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
        state.watcher?.close();
        state.watcher = null;
        scheduleRestart();
      });
      state.watcher.unref?.();
    } catch (error) {
      if (shouldFallBackToPolling(error)) {
        startPollingFallback(error);
        return;
      }
      console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
      state.watcher = null;
      scheduleRestart();
    }
  };

  const stopResultWatcher = () => {
    // Invalidate orphan-timer retry callbacks before closing so they cannot
    // reschedule files on a replacement watcher.  Project-reference release
    // timers are independent and kept alive intentionally.
    watcherActive = false;
    state.watcher?.close();
    state.watcher = null;
    if (state.watcherRestartTimer) {
      timers.clearTimeout(state.watcherRestartTimer);
      timers.clearInterval(state.watcherRestartTimer);
    }
    state.watcherRestartTimer = null;
    state.resultFileCoalescer.clear();
    // Keep project-reference timers alive across extension reloads. The
    // process-private registry intentionally survives reload, and clearing a
    // fallback result timer here would retain that reference indefinitely.
  };

  /**
   * Sweep stale undelivered result files older than TERMINAL_ASYNC_DIR_MAX_AGE_MS
   * (7 days, the same retention window used for terminal async-run directories).
   *
   * A file is considered undelivered when its eventId is absent from
   * `state.completionSeen`.  Before deleting, the function confirms the full
   * report remains recoverable: the subagent's session transcript
   * (`data.sessionFile` / `data.results[].sessionFile`) and the async-dir
   * status.json (`data.asyncDir/status.json`) are retained for the same 7-day
   * window by the detached runtime-cleanup process, so the output is always
   * accessible through the session history or the async artifact path
   * (`data.results[].artifactPaths.outputPath`).
   *
   * Project references are released before deletion so they cannot leak when
   * ack never arrives within the retention period.
   *
   * Call this once per session start (in addition to primeExistingResults)
   * because the cleanup must run in the main process where the project-reference
   * registry lives; the detached runtime-cleanup runner cannot do it.
   */
  const sweepStaleResultFiles = (nowMs?: number) => {
    const now = nowMs ?? Date.now();
    let files: string[];
    try {
      files = fsApi.readdirSync(resultsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return; // resultsDir may not exist yet; nothing to sweep
    }
    for (const file of files) {
      const resultPath = path.join(resultsDir, file);
      try {
        let mtimeMs: number;
        try {
          mtimeMs = fsApi.statSync(resultPath).mtimeMs;
        } catch {
          continue; // file may have been removed concurrently
        }
        if (now - mtimeMs < TERMINAL_ASYNC_DIR_MAX_AGE_MS) continue;

        // Parse the result file to obtain metadata.
        let rawBytes: string;
        let data: ResultFileData;
        try {
          rawBytes = fsApi.readFileSync(resultPath, "utf-8");
          data = JSON.parse(rawBytes) as ResultFileData;
        } catch {
          // Unreadable / malformed file \ skip; do not delete blindly.
          continue;
        }

        // Derive eventId from data.eventId or sha256 digest.
        const fileEventId: string =
          typeof data.eventId === "string" && data.eventId.length > 0
            ? data.eventId
            : createHash("sha256").update(rawBytes).digest("hex");

        // Never sweep an undelivered result owned by the current session.
        // primeExistingResults() will deliver it; deleting it here would destroy
        // the report before any delivery attempt.  A session that has been active
        // for more than seven days can legitimately own result files this old.
        if (
          typeof data.sessionId === "string" &&
          data.sessionId === state.currentSessionId &&
          !isSeenWithTtl(state.completionSeen, fileEventId, now, completionTtlMs)
        ) {
          continue;
        }

        // Skip files with a pending in-flight ack \ the delivery is already
        // in progress and will handle cleanup when it completes.
        if (pendingAcks.has(fileEventId)) continue;

        const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");

        // Check delivery status keyed by eventId.
        if (isSeenWithTtl(state.completionSeen, fileEventId, now, completionTtlMs)) {
          // Already delivered (ack was recorded).  Delete if it survived.
          // Re-read to verify the on-disk eventId still matches before unlinking
          // (a concurrent write may have replaced the file with a new eventId).
          try {
            const currentRaw = fsApi.readFileSync(resultPath, "utf-8");
            const currentData = JSON.parse(currentRaw) as ResultFileData;
            const currentId =
              typeof currentData.eventId === "string" && currentData.eventId.length > 0
                ? currentData.eventId
                : createHash("sha256").update(currentRaw).digest("hex");
            if (currentId === fileEventId) fsApi.unlinkSync(resultPath);
            // If currentId !== fileEventId: a newer write replaced the file.
            // Leave it so the next scan can deliver it under its new eventId.
          } catch {
            // ENOENT or transient failure; ignore.
          }
          continue;
        }

        // Conservative sweep \ only delete if every logical child has a
        // verifiably readable backup source so the output is not lost.
        // status.json is NOT a full-report backup (recentOutput keeps only
        // ~50 lines); only per-child artifact files and session transcripts count.
        //
        // Per-child check (every child must pass):
        //   1. artifactPaths.outputPath is readable (actual read succeeds), OR
        //   2. results[i].sessionFile is readable, OR
        //   3. status.steps[i].sessionFile (from asyncDir/status.json) is readable.
        // The top-level sessionFile counts only for a single-child result
        // (results.length <= 1).
        // "Readable" means an actual readFileSync call succeeds, not existsSync.
        const hasVerifiableReport = (() => {
          const children = Array.isArray(data.results) ? data.results : [];
          const isSingleChild = children.length <= 1;

          // Load status.json once to extract per-step sessionFile fallbacks.
          let statusSteps: Array<{ sessionFile?: string }> | undefined;
          if (data.asyncDir) {
            try {
              const statusRaw = fsApi.readFileSync(
                path.join(data.asyncDir, "status.json"),
                "utf-8",
              );
              const status = JSON.parse(statusRaw) as { steps?: unknown };
              if (Array.isArray(status.steps)) {
                statusSteps = status.steps as Array<{ sessionFile?: string }>;
              }
            } catch {
              // status.json not readable or missing \ no step fallbacks available.
            }
          }

          const canRead = (filePath: string | undefined): boolean => {
            if (!filePath) return false;
            try {
              fsApi.readFileSync(filePath, "utf-8");
              return true;
            } catch {
              return false;
            }
          };

          // No children: require the top-level sessionFile to be readable.
          if (children.length === 0) {
            return canRead(data.sessionFile);
          }

          // Every child must have at least one readable source.
          for (let i = 0; i < children.length; i++) {
            const child = children[i]!;
            const childVerified =
              canRead(child.artifactPaths?.outputPath) ||
              canRead(child.sessionFile) ||
              canRead(statusSteps?.[i]?.sessionFile) ||
              // Top-level sessionFile counts for a single-child result.
              (isSingleChild && canRead(data.sessionFile));
            if (!childVerified) return false;
          }

          return true;
        })();

        if (!hasVerifiableReport) {
          // No readable backup \ keep the file and log once.
          console.error(
            `sweepStaleResultFiles: skipping '${resultPath}' (aged past retention but no verifiable full-report source found; will retry on next sweep).`,
          );
          continue;
        }

        // Undelivered file beyond retention with a readable backup.
        // Release any held project reference, then delete.
        if (data.state === "cancelled" || data.state === "continued") {
          retainOrReleaseProjectReference(data, runId);
        } else if (data.state === "complete" || data.state === "failed") {
          scheduleProjectReferenceRelease(data, runId);
        }
        // Re-read and compare eventId immediately before unlinking, just as
        // the already-delivered branch does.  A concurrent write may have
        // replaced the file with a new result (new eventId) during the backup
        // checks above; deleting it would silently discard an undelivered report.
        try {
          const currentRaw = fsApi.readFileSync(resultPath, "utf-8");
          const currentData = JSON.parse(currentRaw) as ResultFileData;
          const currentId =
            typeof currentData.eventId === "string" && currentData.eventId.length > 0
              ? currentData.eventId
              : createHash("sha256").update(currentRaw).digest("hex");
          if (currentId !== fileEventId) continue; // replaced — leave for next scan
          fsApi.unlinkSync(resultPath);
        } catch {
          // ENOENT or transient failure; ignore — next sweep will retry
        }
      } catch (error) {
        console.error(`sweepStaleResultFiles: error processing '${resultPath}':`, error);
      }
    }
  };

  return {
    startResultWatcher,
    primeExistingResults,
    stopResultWatcher,
    /** Clear in-flight pending-ack slots. Call before primeExistingResults on
     * session start/switch so that result files belonging to the re-entering
     * session are always eligible for re-emission. */
    clearPendingAcks: () => pendingAcks.clear(),
    sweepStaleResultFiles,
  };
}
