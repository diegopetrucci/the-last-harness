import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TLH_EFFECTIVE_ACTIVITY_EVENT } from "../shared/tlh-effective-activity.js";
// Re-export so existing importers of activity-tracker.ts continue to work.
export { TLH_EFFECTIVE_ACTIVITY_EVENT };

const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const RETRY_GRACE_REASON = "primary:retry-grace";
const DEFAULT_RETRY_GRACE_MS = 1500;
const COMPLETED_ASYNC_TOMBSTONE_MS = 60_000;

// Terminal async-run states: the run has ended, so the job must not count as active.
const ASYNC_TERMINAL_STATES = new Set(["complete", "failed", "cancelled", "continued"]);

/**
 * How often the periodic read-only liveness drain fires while async jobs are tracked.
 * Modest enough to catch a dead child quickly; coarse enough to avoid busy-polling.
 * The timer is unref'd so it cannot hold the process open.
 */
const LIVENESS_DRAIN_INTERVAL_MS = 5_000;

// Maximum time a run may remain in the "queued" state before it is dropped.
// A healthy long-running run is in state "running" with a live pid — this bound
// never touches that path. It only catches a run that never manages to spawn.
const QUEUED_GRACE_MS = 30_000;

export type TlhEffectiveActivitySnapshot = {
  inProgress: boolean;
  primaryReasons: string[];
  activeAsyncJobIds: string[];
};

type TlhEffectiveActivityListener = (snapshot: TlhEffectiveActivitySnapshot) => void;

export type TlhEffectiveActivityTracker = {
  getSnapshot(): TlhEffectiveActivitySnapshot;
  isInProgress(): boolean;
  subscribe(listener: TlhEffectiveActivityListener): () => void;
  rehydrateFromArtifacts(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): void;
  dispose(): void;
  handleBeforeAgentStart(): void;
  handleAgentStart(): void;
  handleAgentEnd(event: { messages?: unknown[] }): void;
  handleTurnStart(): void;
  handleToolExecutionStart(event: { toolCallId?: string }): void;
  handleToolExecutionEnd(event: { toolCallId?: string }): void;
  handleSessionBeforeCompact(event: { reason?: string; willRetry?: boolean }): void;
  handleSessionCompact(event: { reason?: string; willRetry?: boolean }): void;
  handleAsyncStarted(data: unknown): void;
  handleAsyncComplete(data: unknown): void;
  handleAsyncControl(data: unknown): void;
};

type TimeoutHandle = ReturnType<typeof setTimeout>;

// Read-only pid liveness result, matching the upstream lifecycle-state.ts definition.
type PidLiveness = "alive" | "dead" | "unknown";

/**
 * Local read-only check for whether a pid is still alive.
 * Uses process.kill(pid, 0) — sending signal 0 is a no-op but throws ESRCH when the
 * process does not exist, or EPERM when it exists but we lack permission.
 * This is the same logic used by checkPidLiveness in the subagents runtime; it is
 * reimplemented here to avoid a cross-extension import and to keep activity-tracker
 * consistent with its existing pattern of reaching async state by path convention only.
 */
function localCheckPidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "unknown";
    return "unknown";
  }
}

type TlhEffectiveActivityTrackerOptions = {
  asyncDir?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  retryGraceMs?: number;
  completedAsyncTombstoneMs?: number;
  /** Injectable pid-liveness checker; defaults to localCheckPidLiveness. */
  checkPidLiveness?: (pid: number) => PidLiveness;
  /**
   * Override the periodic liveness-drain interval (ms). Defaults to LIVENESS_DRAIN_INTERVAL_MS.
   * Inject a short value in tests to avoid real sleeps.
   */
  livenessIntervalMs?: number;
};

type AsyncJobRecord = {
  asyncDir?: string;
  /** Pid recorded from the subagent:async-started payload; used as liveness anchor before status.json is written. */
  pid?: number;
  source: "started" | "control" | "rehydrated";
};

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolvePiSubagentsTempScopeId(): string {
  if (typeof process.getuid === "function") {
    return `uid-${process.getuid()}`;
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-directory-based scoping.
  }
  const homedir = process.env.USERPROFILE ?? process.env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;
  try {
    const fallbackHomedir = os.homedir();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // Fall through to the shared scope.
  }
  return "shared";
}

function resolveDefaultAsyncDir(): string {
  return path.join(
    os.tmpdir(),
    `pi-subagents-${resolvePiSubagentsTempScopeId()}`,
    "async-subagent-runs",
  );
}

function normalizeComparablePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Returns `value` only when it is a positive integer safe to pass to `process.kill`.
 * Rejects 0 (targets the current process group on POSIX → always reports alive),
 * negative values, non-integers, NaN, and Infinity.
 */
function toValidPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isAsyncControlContext(
  data: Record<string, unknown>,
  event: Record<string, unknown>,
): boolean {
  const asyncDir =
    readNonEmptyStringField(data, "asyncDir") ?? readNonEmptyStringField(event, "asyncDir");
  if (asyncDir) {
    return true;
  }
  const mode = (
    readNonEmptyStringField(data, "mode") ?? readNonEmptyStringField(event, "mode")
  )?.toLowerCase();
  if (mode === "async" || mode === "background") {
    return true;
  }
  const source = (
    readNonEmptyStringField(data, "source") ?? readNonEmptyStringField(event, "source")
  )?.toLowerCase();
  return source === "async" || source === "background";
}

function looksLikeRetryableAgentEnd(messages: readonly unknown[] | undefined): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    return message.stopReason === "error" || typeof message.errorMessage === "string";
  }
  return false;
}

function readRunningAsyncJob(
  asyncDir: string,
): { runId: string; sessionId?: string; cwd?: string } | undefined {
  const statusPath = path.join(asyncDir, "status.json");
  const raw = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as unknown;
  if (
    !isRecord(raw) ||
    raw.state !== "running" ||
    typeof raw.runId !== "string" ||
    raw.runId.length === 0
  ) {
    return undefined;
  }
  return {
    runId: raw.runId,
    ...(typeof raw.sessionId === "string" && raw.sessionId.length > 0
      ? { sessionId: raw.sessionId }
      : {}),
    ...(typeof raw.cwd === "string" && raw.cwd.length > 0 ? { cwd: raw.cwd } : {}),
  };
}

export function createTlhEffectiveActivityTracker(
  options: TlhEffectiveActivityTrackerOptions = {},
): TlhEffectiveActivityTracker {
  const asyncDir = options.asyncDir ?? resolveDefaultAsyncDir();
  const now = options.now ?? Date.now;
  const setTimeoutImpl = options.setTimeout ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  const retryGraceMs = options.retryGraceMs ?? DEFAULT_RETRY_GRACE_MS;
  const completedAsyncTombstoneMs =
    options.completedAsyncTombstoneMs ?? COMPLETED_ASYNC_TOMBSTONE_MS;
  const checkPidLivenessImpl = options.checkPidLiveness ?? localCheckPidLiveness;
  const livenessIntervalMs = options.livenessIntervalMs ?? LIVENESS_DRAIN_INTERVAL_MS;
  const primaryReasons = new Map<string, number>();
  const activeAsyncJobs = new Map<string, AsyncJobRecord>();
  const recentlyCompletedAsyncJobs = new Map<string, number>();
  const retryGraceTimers = new Map<string, TimeoutHandle>();
  const listeners = new Set<TlhEffectiveActivityListener>();
  let disposed = false;
  let lastSnapshotKey = "0::::";
  /** Handle for the periodic read-only liveness drain timer. undefined when no jobs are tracked. */
  let livenessTimer: TimeoutHandle | undefined;

  const stopLivenessTimer = (): void => {
    if (livenessTimer !== undefined) {
      clearTimeoutImpl(livenessTimer);
      livenessTimer = undefined;
    }
  };

  /**
   * Schedule one periodic liveness-drain tick if none is already pending and there
   * are tracked jobs. The callback re-runs the drain, emits if the snapshot changed,
   * and reschedules itself only when jobs remain — so the timer stops automatically
   * when the last job is gone.
   *
   * The timer is unref'd so it can never hold the Node process open.
   */
  const scheduleLivenessCheck = (): void => {
    if (disposed || livenessTimer !== undefined || activeAsyncJobs.size === 0) return;
    const handle = setTimeoutImpl((): void => {
      livenessTimer = undefined;
      if (!disposed) {
        // notifyIfChanged calls drainDeadAsyncJobs internally; the drain may
        // remove dead jobs and emit a snapshot change to all subscribers.
        notifyIfChanged();
        // Reschedule only when jobs remain; stop otherwise.
        scheduleLivenessCheck();
      }
    }, livenessIntervalMs);
    // unref so the timer never keeps the process alive when it is the only
    // remaining thing on the event loop.
    if (handle !== null && typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    livenessTimer = handle;
  };

  const cleanupCompletedAsyncJobTombstones = (): void => {
    const cutoff = now() - completedAsyncTombstoneMs;
    for (const [runId, completedAt] of recentlyCompletedAsyncJobs) {
      if (completedAt < cutoff) {
        recentlyCompletedAsyncJobs.delete(runId);
      }
    }
  };

  const addPrimaryReason = (reason: string): void => {
    if (disposed) return;
    primaryReasons.set(reason, (primaryReasons.get(reason) ?? 0) + 1);
  };

  const removePrimaryReason = (reason: string): void => {
    const current = primaryReasons.get(reason);
    if (!current) return;
    if (current <= 1) {
      primaryReasons.delete(reason);
      return;
    }
    primaryReasons.set(reason, current - 1);
  };

  const syncRetryGraceReason = (): void => {
    if (retryGraceTimers.size > 0) {
      primaryReasons.set(RETRY_GRACE_REASON, 1);
      return;
    }
    primaryReasons.delete(RETRY_GRACE_REASON);
  };

  const clearRetryGrace = (): void => {
    for (const timer of retryGraceTimers.values()) {
      clearTimeoutImpl(timer);
    }
    retryGraceTimers.clear();
    syncRetryGraceReason();
  };

  const scheduleRetryGrace = (reasonKey: string): void => {
    if (disposed) return;
    const existing = retryGraceTimers.get(reasonKey);
    if (existing) {
      clearTimeoutImpl(existing);
    }
    retryGraceTimers.set(
      reasonKey,
      setTimeoutImpl(() => {
        retryGraceTimers.delete(reasonKey);
        syncRetryGraceReason();
        notifyIfChanged();
      }, retryGraceMs),
    );
    syncRetryGraceReason();
  };

  const mergeAsyncJobRecord = (
    existing: AsyncJobRecord | undefined,
    incoming: AsyncJobRecord,
  ): AsyncJobRecord => {
    const incomingAsyncDir =
      typeof incoming.asyncDir === "string" && incoming.asyncDir.length > 0
        ? incoming.asyncDir
        : undefined;
    const existingAsyncDir =
      typeof existing?.asyncDir === "string" && existing.asyncDir.length > 0
        ? existing.asyncDir
        : undefined;
    const asyncDir = incomingAsyncDir ?? existingAsyncDir;
    const pid = toValidPid(incoming.pid) ?? toValidPid(existing?.pid);
    return {
      source: incoming.source,
      ...(asyncDir ? { asyncDir } : {}),
      ...(pid !== undefined ? { pid } : {}),
    };
  };

  const setAsyncJobActive = (runId: string, record: AsyncJobRecord): void => {
    if (disposed) return;
    cleanupCompletedAsyncJobTombstones();
    if (!runId || recentlyCompletedAsyncJobs.has(runId)) {
      return;
    }
    activeAsyncJobs.set(runId, mergeAsyncJobRecord(activeAsyncJobs.get(runId), record));
    // Start the periodic liveness drain if it isn't already running.
    scheduleLivenessCheck();
  };

  /**
   * Read-only liveness drain: remove any tracked async job that cannot be positively
   * verified as still running.
   *
   * Rules (in order):
   *   - No asyncDir recorded for the job → unverifiable → drop.
   *   - asyncDir/status.json missing or unreadable → run is gone → drop.
   *   - State is terminal (complete/failed/cancelled/continued) → drop.
   *   - State is "queued" (no pid yet) → grace period; keep.
   *   - State is non-terminal with a pid → check liveness:
   *       alive or unknown → keep (fail-open: do not suppress on uncertainty).
   *       dead           → drop.
   *   - State is non-terminal without a pid → unverifiable → drop.
   *
   * This is strictly read-only: it never calls reconcileAsyncRun and never
   * writes status files. It never applies elapsed-time heuristics.
   */
  const drainDeadAsyncJobs = (): void => {
    if (activeAsyncJobs.size === 0) return;
    const toDelete: string[] = [];
    for (const [runId, record] of activeAsyncJobs) {
      if (!record.asyncDir) {
        // No asyncDir: there is no filesystem evidence for this job and no
        // recovery path — a single event that omits asyncDir would silence
        // notifications for the rest of the session. Drop it so the failure
        // mode is a spurious notification rather than permanent silence.
        toDelete.push(runId);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(record.asyncDir, "status.json"), "utf-8"));
      } catch {
        // Missing or unreadable status.json — the child may still be starting up
        // and has not yet written status.json. If a recorded live pid is available,
        // use it as positive evidence that the run is alive and keep the job.
        // Only drop when there is no usable pid to anchor liveness on.
        if (record.pid !== undefined) {
          const liveness = checkPidLivenessImpl(record.pid);
          if (liveness !== "dead") {
            // alive or unknown → keep (fail-open: do not suppress on uncertainty).
            continue;
          }
        }
        toDelete.push(runId);
        continue;
      }
      if (!isRecord(raw)) {
        toDelete.push(runId);
        continue;
      }
      const state = readNonEmptyStringField(raw, "state");
      if (!state || ASYNC_TERMINAL_STATES.has(state)) {
        // Terminal or unrecognised state → the run has ended.
        toDelete.push(runId);
        continue;
      }
      if (state === "queued") {
        // Queued: no pid yet. Grant a short grace period bounded by startedAt
        // so the check stays stateless. This does not penalise long-running
        // work — healthy long runs are in state "running" with a live pid.
        const startedAt = raw["startedAt"];
        if (
          typeof startedAt === "number" &&
          Number.isFinite(startedAt) &&
          startedAt <= now() && // reject future timestamps — grace cannot be unbounded
          now() - startedAt <= QUEUED_GRACE_MS
        ) {
          continue; // Still within grace; keep.
        }
        // Grace expired or startedAt absent/invalid → unverifiable → drop.
        toDelete.push(runId);
        continue;
      }
      // Non-terminal state (running/pausing/paused): require a verifiably alive pid.
      const pid = toValidPid(raw["pid"]);
      if (pid === undefined) {
        // No pid, or invalid (0, negative, fractional) → unverifiable → drop.
        // process.kill(0, 0) targets the current process group on POSIX and would
        // always report alive; we must never let such a pid reach liveness checks.
        toDelete.push(runId);
        continue;
      }
      const liveness = checkPidLivenessImpl(pid);
      if (liveness === "dead") {
        toDelete.push(runId);
      }
      // alive: keep.
      // unknown (EPERM): a process exists at that pid but we lack permission to
      // signal it — we cannot confirm it is our run. Keeping here matches the
      // upstream reconciler, which only acts on a definitively dead pid. Residual
      // risk: a recycled pid now owned by another user could hold suppression
      // open until the job record is otherwise cleaned up.
    }
    for (const runId of toDelete) {
      activeAsyncJobs.delete(runId);
    }
  };

  const markAsyncJobComplete = (runId: string): void => {
    if (disposed || !runId) return;
    activeAsyncJobs.delete(runId);
    recentlyCompletedAsyncJobs.set(runId, now());
    cleanupCompletedAsyncJobTombstones();
    // Stop the liveness timer eagerly when no jobs remain.
    if (activeAsyncJobs.size === 0) {
      stopLivenessTimer();
    }
  };

  const currentSessionId = (
    sessionManager: { getSessionId?: (() => string | undefined) | undefined } | undefined,
  ): string | undefined => {
    const sessionId = sessionManager?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };

  const buildSnapshot = (): TlhEffectiveActivitySnapshot => ({
    inProgress: primaryReasons.size > 0 || activeAsyncJobs.size > 0,
    primaryReasons: [...primaryReasons.keys()].sort(),
    activeAsyncJobIds: [...activeAsyncJobs.keys()].sort(),
  });

  const snapshotKey = (snapshot: TlhEffectiveActivitySnapshot): string =>
    [
      snapshot.inProgress ? "1" : "0",
      snapshot.primaryReasons.join(","),
      snapshot.activeAsyncJobIds.join(","),
    ].join("::");

  const notifyIfChanged = (): void => {
    drainDeadAsyncJobs();
    const snapshot = buildSnapshot();
    const nextKey = snapshotKey(snapshot);
    if (nextKey === lastSnapshotKey) {
      return;
    }
    lastSnapshotKey = nextKey;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Subscribers must not crash tracker updates.
      }
    }
  };

  return {
    getSnapshot() {
      cleanupCompletedAsyncJobTombstones();
      drainDeadAsyncJobs();
      return buildSnapshot();
    },
    isInProgress() {
      return this.getSnapshot().inProgress;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rehydrateFromArtifacts(ctx) {
      if (disposed) return;
      const entries = (() => {
        try {
          return fs.readdirSync(asyncDir, { withFileTypes: true });
        } catch (error) {
          if (isRecord(error) && error.code === "ENOENT") {
            return undefined;
          }
          // Fail closed: this ticket only rehydrates from the stable top-level async status.json layout.
          // If pi-subagents changes its registry shape or the runtime dir is unavailable, leave async jobs empty.
          return undefined;
        }
      })();
      if (!entries) return;

      const normalizedCwd = normalizeComparablePath(ctx.cwd);
      const sessionId = currentSessionId(ctx.sessionManager);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidateAsyncDir = path.join(asyncDir, entry.name);
        try {
          const status = readRunningAsyncJob(candidateAsyncDir);
          if (!status) continue;
          if (sessionId && status.sessionId && sessionId !== status.sessionId) continue;
          if (status.cwd && normalizeComparablePath(status.cwd) !== normalizedCwd) continue;
          setAsyncJobActive(status.runId, { asyncDir: candidateAsyncDir, source: "rehydrated" });
        } catch {
          // Fail closed on malformed or partially-written async artifacts.
        }
      }
      notifyIfChanged();
    },
    dispose() {
      disposed = true;
      stopLivenessTimer();
      clearRetryGrace();
      primaryReasons.clear();
      activeAsyncJobs.clear();
      recentlyCompletedAsyncJobs.clear();
      notifyIfChanged();
      listeners.clear();
    },
    handleBeforeAgentStart() {
      clearRetryGrace();
      addPrimaryReason("primary:pending-start");
      notifyIfChanged();
    },
    handleAgentStart() {
      clearRetryGrace();
      removePrimaryReason("primary:pending-start");
      addPrimaryReason("primary:agent-loop");
      notifyIfChanged();
    },
    handleAgentEnd(event) {
      removePrimaryReason("primary:agent-loop");
      removePrimaryReason("primary:pending-start");
      if (looksLikeRetryableAgentEnd(event.messages)) {
        scheduleRetryGrace("agent-end");
      }
      notifyIfChanged();
    },
    handleTurnStart() {
      clearRetryGrace();
      notifyIfChanged();
    },
    handleToolExecutionStart(event) {
      if (!event.toolCallId) return;
      addPrimaryReason(`primary:tool:${event.toolCallId}`);
      notifyIfChanged();
    },
    handleToolExecutionEnd(event) {
      if (!event.toolCallId) return;
      removePrimaryReason(`primary:tool:${event.toolCallId}`);
      notifyIfChanged();
    },
    handleSessionBeforeCompact(event) {
      clearRetryGrace();
      addPrimaryReason(`primary:compaction:${event.reason ?? "unknown"}`);
      notifyIfChanged();
    },
    handleSessionCompact(event) {
      removePrimaryReason(`primary:compaction:${event.reason ?? "unknown"}`);
      if (event.willRetry) {
        scheduleRetryGrace(`compaction:${event.reason ?? "unknown"}`);
      }
      notifyIfChanged();
    },
    handleAsyncStarted(data) {
      if (!isRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
        return;
      }
      // Validate pid: must be a positive integer. Reject 0 (targets the current process
      // group on POSIX and would report "alive" forever) and any non-integer value.
      const record: AsyncJobRecord = { source: "started" };
      const asyncDir = readNonEmptyStringField(data, "asyncDir");
      if (asyncDir) record.asyncDir = asyncDir;
      const pid = toValidPid(data.pid);
      if (pid !== undefined) record.pid = pid;
      setAsyncJobActive(data.id, record);
      notifyIfChanged();
    },
    handleAsyncComplete(data) {
      if (!isRecord(data)) return;
      const runId =
        typeof data.id === "string" && data.id.length > 0
          ? data.id
          : typeof data.runId === "string" && data.runId.length > 0
            ? data.runId
            : undefined;
      if (!runId) return;
      markAsyncJobComplete(runId);
      notifyIfChanged();
    },
    handleAsyncControl(data) {
      if (
        !isRecord(data) ||
        !isRecord(data.event) ||
        typeof data.event.runId !== "string" ||
        data.event.runId.length === 0
      ) {
        return;
      }
      if (!isAsyncControlContext(data, data.event)) {
        return;
      }
      const record: AsyncJobRecord = { source: "control" };
      const asyncDir =
        readNonEmptyStringField(data, "asyncDir") ??
        readNonEmptyStringField(data.event, "asyncDir");
      if (asyncDir) record.asyncDir = asyncDir;
      setAsyncJobActive(data.event.runId, record);
      notifyIfChanged();
    },
  };
}

export function registerTlhEffectiveActivityTracker(
  pi: Pick<ExtensionAPI, "on"> & {
    events?: Pick<ExtensionAPI["events"], "on" | "emit"> | undefined;
  },
): TlhEffectiveActivityTracker {
  const tracker = createTlhEffectiveActivityTracker();
  const unsubscribes = pi.events
    ? [
        pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => tracker.handleAsyncStarted(data)),
        pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => tracker.handleAsyncComplete(data)),
        pi.events.on(SUBAGENT_CONTROL_EVENT, (data) => tracker.handleAsyncControl(data)),
      ]
    : [];

  // Publish snapshot changes on pi.events so other extensions (e.g. notify-gating)
  // can react without coupling directly to this tracker instance.
  if (pi.events) {
    tracker.subscribe((snapshot) => {
      try {
        pi.events?.emit(TLH_EFFECTIVE_ACTIVITY_EVENT, {
          inProgress: snapshot.inProgress,
          activeAsyncJobIds: snapshot.activeAsyncJobIds,
        });
      } catch {
        // Best-effort: never let an emit failure crash the tracker.
      }
    });
  }

  pi.on("session_start", (_event, ctx) => {
    tracker.rehydrateFromArtifacts(ctx);
  });
  pi.on("before_agent_start", () => {
    tracker.handleBeforeAgentStart();
  });
  pi.on("agent_start", () => {
    tracker.handleAgentStart();
  });
  pi.on("agent_end", (event) => {
    tracker.handleAgentEnd(event);
  });
  pi.on("turn_start", () => {
    tracker.handleTurnStart();
  });
  pi.on("tool_execution_start", (event) => {
    tracker.handleToolExecutionStart(event);
  });
  pi.on("tool_execution_end", (event) => {
    tracker.handleToolExecutionEnd(event);
  });
  pi.on("session_before_compact", (event) => {
    tracker.handleSessionBeforeCompact(event);
  });
  pi.on("session_compact", (event) => {
    tracker.handleSessionCompact(event);
  });
  pi.on("session_shutdown", () => {
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Best-effort event-bus cleanup during shutdown.
      }
    }
    tracker.dispose();
  });
  return tracker;
}
