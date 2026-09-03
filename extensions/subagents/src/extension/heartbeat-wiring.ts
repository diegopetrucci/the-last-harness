/**
 * Heartbeat wire-up for the subagent extension.
 *
 * Bridges createHeartbeatController (runs/shared/heartbeat-controller.ts) into
 * the extension lifecycle:
 *   - Arms (startGap) when the first genuinely live async run appears, or when
 *     the parent becomes idle again with live runs still active.
 *   - Disarms (endGap) when the last live async run completes, OR on any
 *     lifecycle event that invalidates the cached prompt state.
 *   - Emits a per-gap JSONL summary record and one durable session entry
 *     (pi.appendEntry/registerEntryRenderer — NOT in LLM context) per gap
 *     where at least one beat was executed.
 *
 * "Genuinely live" means NOT in a terminal retention status.  The
 * async-job-tracker retains completed jobs for ~10 s, so we must filter on
 * the status rather than checking asyncJobs.size.
 *
 * Stats accumulation uses a structured beat-result callback from the controller
 * rather than intercepting appendFileSync — this avoids coupling stats to JSONL
 * serialization and makes the accounting testable without file I/O mocking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveHeartbeatConfig } from "../runs/shared/heartbeat-config.ts";
import {
  createHeartbeatController,
  type BeatAccounting,
  type BeatResult,
  type HeartbeatControllerDeps,
} from "../runs/shared/heartbeat-controller.ts";
import type { AsyncJobState, ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

// ---------------------------------------------------------------------------
// Live-run predicate
// ---------------------------------------------------------------------------

/**
 * Statuses where the async-job-tracker retains completed jobs (~10 s).
 * A job is "genuinely live" only when its status is NOT in this set.
 */
const ASYNC_TERMINAL_STATUSES = new Set(["complete", "failed", "paused", "cancelled", "continued"]);

/** Count genuinely live async jobs (not in a terminal retention status). */
export function countLiveAsyncRuns(asyncJobs: Map<string, AsyncJobState>): number {
  let count = 0;
  for (const job of asyncJobs.values()) {
    if (!ASYNC_TERMINAL_STATUSES.has(job.status)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-gap summary types (public — used by doctor + tests)
// ---------------------------------------------------------------------------

export type HeartbeatGapVerdict = "saved" | "wasted" | "lost" | "unneeded";

/** Data shape written into the JSONL log and the session entry. */
export interface HeartbeatGapSummaryData {
  ts: number;
  sessionId: string;
  gapId: string;
  /** Number of ghost-stream requests actually sent (excludes internal skips). */
  beats: number;
  /** Total estimated USD cost of all executed beats. */
  beatCostUsd: number;
  /**
   * Estimated USD that would have been paid had the cache been missed.
   * Computed from the most recent successful cache_read beat as:
   *   (cacheRead tokens × (input_rate − cacheRead_rate)) / 1e6.
   * Represents the value of ONE avoided cache miss (not accumulated per beat,
   * since only one future cache miss can be avoided per gap).
   */
  avoidedCostUsd: number;
  verdict: HeartbeatGapVerdict;
}

/** Session-level heartbeat totals surfaced in the doctor output. */
export interface HeartbeatSessionSummary {
  enabled: boolean;
  totalBeats: number;
  totalCacheReadTokens: number;
  totalBeatCostUsd: number;
  gapsSaved: number;
  gapsWasted: number;
  gapsLost: number;
  /**
   * Zero-beat gaps closed before their first beat without a terminal-lost
   * signal; this can reflect a short run, parent turn, lifecycle event, model
   * change, or compaction, and the closure cause is not recorded.
   */
  gapsUnneeded: number;
  /** True when the session circuit-breaker has fired (≥3 consecutive failures). */
  breakerDisabled: boolean;
}

// ---------------------------------------------------------------------------
// Internal per-gap accumulator
// ---------------------------------------------------------------------------

interface GapAccumulator {
  gapId: string;
  sessionId: string;
  /**
   * Beats counted at issue time via onBeatIssued (optimistic accounting).
   * Includes beats that may later be lifecycle-cancelled; those beats are
   * never followed by an onBeatResult call.
   */
  executedBeats: number;
  cacheReadBeats: number;
  totalBeatCostUsd: number;
  totalCacheReadTokens: number;
  /**
   * Avoided cost from the most recent cache_read beat.
   * Replaced (not accumulated) on each successful beat since only one future
   * cache miss can be avoided per gap.
   */
  avoidedCostUsd: number;
  /**
   * Set to true when the controller reports a terminal-lost event for this gap.
   * Overrides the verdict to 'lost' even if prior beats were cache_read, since
   * the cache is considered/likely expired.
   */
  terminatedLost: boolean;
}

function createAccumulator(gapId: string, sessionId: string): GapAccumulator {
  return {
    gapId,
    sessionId,
    executedBeats: 0,
    cacheReadBeats: 0,
    totalBeatCostUsd: 0,
    totalCacheReadTokens: 0,
    avoidedCostUsd: 0,
    terminatedLost: false,
  };
}

function verdictFrom(acc: GapAccumulator): HeartbeatGapVerdict {
  // Terminal-lost overrides even a prior successful beat: the cache is
  // considered/likely expired, so any earlier refresh is now irrelevant.
  if (acc.terminatedLost) return "lost";
  if (acc.cacheReadBeats > 0) return "saved";
  // Deliberate semantic: any gap with issued beats (including a
  // cancellation-only gap) is 'wasted' when no cache-read evidence was
  // observed. The issue-time executedBeats count preserves this verdict even
  // when lifecycle cancellation prevents onBeatResult.
  if (acc.executedBeats > 0) return "wasted";
  // Zero-beat gap without a terminal-lost signal: it closed before the first
  // beat. This can reflect a short run, parent turn, lifecycle event, model
  // change, or compaction; the closure cause is not recorded. Nothing was sent
  // and the cache may still be warm — counting this as 'lost' would inflate
  // gapsLost unfairly.
  return "unneeded";
}

// ---------------------------------------------------------------------------
// Deps (injectable for tests)
// ---------------------------------------------------------------------------

export interface HeartbeatWiringDeps {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  appendFileSync?: (file: string, data: string) => void;
  mkdirSync?: (dir: string, options: { recursive: true }) => void;
  /** Override the JSONL log path (pass null to disable file I/O). */
  logPath?: string | null;
  /** Fake stream provider for unit tests (bypasses real provider calls). */
  streamProvider?: HeartbeatControllerDeps["streamProvider"];
  /**
   * Lazy getter for the live model registry.
   * Production: injected from the captured session context.
   * Tests: omit to exercise the no-registry error path, or inject a fake.
   */
  getModelRegistry?: () => ModelRegistry | undefined;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HeartbeatWiring {
  /**
   * Called from the before_provider_request handler.
   * Forwards payload + model to the controller for capture.
   */
  onProviderRequest(payload: unknown, model: Model<Api>): void;
  /** Forward parent-idle-state changes to the controller. */
  onIdle(idle: boolean): void;
  /**
   * Called when SUBAGENT_ASYNC_STARTED_EVENT fires (before the tracker adds the job).
   * @param liveRunsBefore Live-run count at the moment this handler fires (new job not yet in asyncJobs).
   * @param sessionId      Current parent session ID (used as the gap session ID).
   */
  notifyAsyncStarted(liveRunsBefore: number, sessionId: string | null): void;
  /**
   * Called when SUBAGENT_ASYNC_COMPLETE_EVENT fires (synchronously, before the
   * wake nudge in notify.ts).
   * @param completingId The id of the completing job.
   * @param asyncJobs    The current jobs map; completing job still has its old status.
   * @returns true if the gap was closed as a result of this call.
   */
  notifyAsyncComplete(
    completingId: string | undefined,
    asyncJobs: Map<string, AsyncJobState>,
  ): boolean;
  /**
   * Disarm: close the active gap (if any) and emit a per-gap summary.
   * Called on before_agent_start, model_select, thinking_level_select,
   * session_compact, session_tree, extension reload, and session_before_switch/fork.
   */
  disarm(): void;
  /**
   * Destroy: cancel timers, abort in-flight beats, close any active gap without
   * emitting a session entry (called on session_shutdown where the session is
   * going away).
   */
  destroy(): void;
  /** Returns per-session totals for the doctor report. */
  getSessionSummary(): HeartbeatSessionSummary;
  /**
   * Re-arm the heartbeat if all conditions are met: parent is idle, live async
   * runs exist, and no gap is currently active.
   *
   * Call from agent_settled (after a parent turn) and from session_start (after
   * restoring active jobs) to ensure the heartbeat resumes for any still-live
   * async runs when the parent becomes idle again.
   */
  tryRearm(liveRunCount: number, sessionId: string | null): void;
  /**
   * Reset session-scoped state for a new session (session_start).
   *
   * Clears the failure breaker, consecutive-failure count, session totals, idle
   * state, and any open gap state.  The controller also clears its captured
   * request and session identity.  Does NOT reset the resolved config.  Safe
   * to call when a gap is somehow still open — discards it without emitting a
   * duplicate entry.
   */
  resetSession(): void;
}

// ---------------------------------------------------------------------------
// JSONL gap summary record helper
// ---------------------------------------------------------------------------

interface HeartbeatGapSummaryRecord extends HeartbeatGapSummaryData {
  type: "gap_summary";
}

function appendGapSummaryRecord(
  acc: GapAccumulator,
  logPath: string | undefined,
  appendFile: (file: string, data: string) => void,
  mkdir: (dir: string, opts: { recursive: true }) => void,
  now: () => number,
): HeartbeatGapSummaryRecord {
  const verdict = verdictFrom(acc);
  const record: HeartbeatGapSummaryRecord = {
    type: "gap_summary",
    ts: now(),
    sessionId: acc.sessionId,
    gapId: acc.gapId,
    beats: acc.executedBeats,
    beatCostUsd: acc.totalBeatCostUsd,
    avoidedCostUsd: acc.avoidedCostUsd,
    verdict,
  };
  if (logPath) {
    try {
      mkdir(path.dirname(logPath), { recursive: true });
      appendFile(logPath, JSON.stringify(record) + "\n");
    } catch {
      // Best-effort: never throw into the host process.
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function resolvedDefaultLogPath(): string {
  return path.join(getAgentDir(), "subagents", "heartbeat.jsonl");
}

export function createHeartbeatWiring(
  pi: Pick<ExtensionAPI, "appendEntry" | "registerEntryRenderer">,
  config: ExtensionConfig,
  deps: HeartbeatWiringDeps = {},
): HeartbeatWiring {
  const resolved = resolveHeartbeatConfig(config.heartbeat);

  if (!resolved.enabled) {
    // No-op: zero timers, zero file writes, no Pi event hooks beyond this
    // cheap config check, no entry renderers registered.
    return {
      onProviderRequest() {},
      onIdle() {},
      notifyAsyncStarted() {},
      notifyAsyncComplete() {
        return false;
      },
      disarm() {},
      destroy() {},
      tryRearm() {},
      resetSession() {},
      getSessionSummary(): HeartbeatSessionSummary {
        return {
          enabled: false,
          totalBeats: 0,
          totalCacheReadTokens: 0,
          totalBeatCostUsd: 0,
          gapsSaved: 0,
          gapsWasted: 0,
          gapsLost: 0,
          gapsUnneeded: 0,
          breakerDisabled: false,
        };
      },
    };
  }

  const nowFn = deps.now ?? Date.now;
  const resolvedLogPath: string | undefined = Object.hasOwn(deps, "logPath")
    ? (deps.logPath ?? undefined)
    : resolvedDefaultLogPath();

  const appendFileSyncBase =
    deps.appendFileSync ?? ((file: string, data: string) => fs.appendFileSync(file, data));
  const mkdirSyncBase =
    deps.mkdirSync ?? ((dir: string, options: { recursive: true }) => fs.mkdirSync(dir, options));

  // Session-level totals.
  let sessionTotalBeats = 0;
  let sessionTotalCacheReadTokens = 0;
  let sessionTotalBeatCostUsd = 0;
  let sessionGapsSaved = 0;
  let sessionGapsWasted = 0;
  let sessionGapsLost = 0;
  let sessionGapsUnneeded = 0;
  let sessionBreakerDisabled = false;

  // Per-gap state.
  let currentGap: GapAccumulator | null = null;
  let isIdleState: boolean = false;

  // ---------------------------------------------------------------------------
  // Register entry renderer so pi.appendEntry entries are TUI-visible.
  // (Not in LLM context — appendEntry creates a "custom" entry, not a message.)
  // ---------------------------------------------------------------------------

  pi.registerEntryRenderer<HeartbeatGapSummaryData>(
    "heartbeat-gap-summary",
    (entry, _options, theme) => {
      const d = entry.data;
      if (!d) return undefined;
      const verdictIcon = d.verdict === "saved" ? theme.fg("success", "♥") : theme.fg("dim", "♥");
      const beatsLabel = d.beats === 1 ? "1 beat" : `${d.beats} beats`;
      const parts: string[] = [beatsLabel];
      if (d.beatCostUsd > 0) parts.push(`$${d.beatCostUsd.toFixed(5)} cost`);
      if (d.avoidedCostUsd > 0) parts.push(`~$${d.avoidedCostUsd.toFixed(5)} saved`);
      const summary = parts.join(" · ");
      return new Text(`${verdictIcon} Heartbeat [${d.verdict}]: ${summary}`, 0, 0);
    },
  );

  // ---------------------------------------------------------------------------
  // Beat-accounting callback: accumulate per-gap stats synchronously when usage
  // is first observed, before provider iterator cleanup can yield to a lifecycle
  // disarm.  The controller invokes this at most once per executed beat.
  // ---------------------------------------------------------------------------

  // Optimistic accounting: called by the controller at beat-issue time (before
  // the stream starts).  Increments executedBeats immediately so the gap
  // summary reflects the beat even if the gap is closed synchronously
  // (lifecycle disarm) while the stream is in flight.
  function onBeatIssued(gapId: string): void {
    if (!currentGap || gapId !== currentGap.gapId) return;
    currentGap.executedBeats++;
  }

  // Called by the controller when the gap has expired (timer fired past
  // LATE_BEAT_THRESHOLD_MS).  Overrides the verdict to 'lost' so a gap
  // that had prior successful beats is not misleadingly marked 'saved'.
  function onGapLost(gapId: string): void {
    if (!currentGap || gapId !== currentGap.gapId) return;
    currentGap.terminatedLost = true;
  }

  function onBeatAccounting(accounting: BeatAccounting): void {
    if (!currentGap || accounting.gapId !== currentGap.gapId) return;

    const acc = currentGap;

    // NOTE: executedBeats is already incremented in onBeatIssued (optimistic).
    // Usage/cost is accounted here exactly once, at first observation.  The
    // completion callback below must not account for it again.
    if (accounting.outcome === "cache_read") {
      acc.cacheReadBeats++;
      acc.totalCacheReadTokens += accounting.usage.cacheRead;
      const model = accounting.model;
      if (model.cost) {
        const savedPerToken = model.cost.input - model.cost.cacheRead;
        if (savedPerToken > 0) {
          // Replace (not accumulate) avoided cost: only one future cache miss
          // can be avoided per gap, so we record the most recent successful
          // beat's value.
          acc.avoidedCostUsd = (accounting.usage.cacheRead * savedPerToken) / 1_000_000;
        }
      }
      if (typeof accounting.estCostUsd === "number") {
        acc.totalBeatCostUsd += accounting.estCostUsd;
      }
    } else if (accounting.outcome === "error") {
      if (typeof accounting.estCostUsd === "number") {
        acc.totalBeatCostUsd += accounting.estCostUsd;
      }
    } else if (accounting.outcome === "cache_write_mismatch") {
      if (typeof accounting.estCostUsd === "number") {
        acc.totalBeatCostUsd += accounting.estCostUsd;
      }
    }
  }

  function onBeatResult(result: BeatResult): void {
    // Propagate the controller's session breaker signal even if the active gap
    // has been disarmed before the completion callback runs. This flag gates
    // future starts/rearms while keeping the diagnostic summary available.
    if (result.sessionDisabled) {
      sessionBreakerDisabled = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Controller (created with the beat-result callback for stats accumulation).
  // ---------------------------------------------------------------------------

  const controllerDeps: HeartbeatControllerDeps = {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
    ...(deps.appendFileSync ? { appendFileSync: deps.appendFileSync } : {}),
    ...(deps.mkdirSync ? { mkdirSync: deps.mkdirSync } : {}),
    ...(resolvedLogPath !== undefined ? { logPath: resolvedLogPath } : { logPath: null }),
    ...(deps.streamProvider ? { streamProvider: deps.streamProvider } : {}),
    ...(deps.getModelRegistry ? { getModelRegistry: deps.getModelRegistry } : {}),
    onBeatIssued,
    onBeatAccounting,
    onBeatResult,
    onGapLost,
  };

  const controller = createHeartbeatController(resolved, controllerDeps);

  // ---------------------------------------------------------------------------
  // Gap close helpers
  // ---------------------------------------------------------------------------

  function closeGapWithSummary(emitSessionEntry: boolean): void {
    if (!currentGap) return;
    const acc = currentGap;
    currentGap = null;

    controller.endGap();

    // Write JSONL summary record.
    const record = appendGapSummaryRecord(
      acc,
      resolvedLogPath,
      appendFileSyncBase,
      mkdirSyncBase,
      nowFn,
    );

    // Update session totals.
    sessionTotalBeats += acc.executedBeats;
    sessionTotalCacheReadTokens += acc.totalCacheReadTokens;
    sessionTotalBeatCostUsd += acc.totalBeatCostUsd;
    const verdict = record.verdict;
    if (verdict === "saved") sessionGapsSaved++;
    else if (verdict === "wasted") sessionGapsWasted++;
    else if (verdict === "lost") sessionGapsLost++;
    else sessionGapsUnneeded++;

    // Emit a durable session entry (TUI-visible, not in LLM context).
    // Skip when no beats were fired (nothing useful to show) or session entry
    // emission is suppressed (e.g., shutdown).
    if (emitSessionEntry && acc.executedBeats > 0) {
      try {
        pi.appendEntry("heartbeat-gap-summary", {
          ts: record.ts,
          sessionId: acc.sessionId,
          gapId: acc.gapId,
          beats: record.beats,
          beatCostUsd: record.beatCostUsd,
          avoidedCostUsd: record.avoidedCostUsd,
          verdict,
        } satisfies HeartbeatGapSummaryData);
      } catch {
        // Best-effort: pi may be shutting down.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: open a new gap when conditions are met.
  // ---------------------------------------------------------------------------

  function openGapIfNeeded(sessionId: string | null): void {
    if (sessionBreakerDisabled || currentGap) return;
    const sid = sessionId ?? "";
    const gapId = `${sid}-${nowFn()}`;
    currentGap = createAccumulator(gapId, sid);
    controller.startGap(gapId, sid);
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    onProviderRequest(payload: unknown, model: Model<Api>): void {
      controller.onProviderRequest(payload, model);
    },

    onIdle(idle: boolean): void {
      isIdleState = idle;
      controller.onIdle(idle);
    },

    notifyAsyncStarted(liveRunsBefore: number, sessionId: string | null): void {
      // Arm when this is the first live run (liveRunsBefore === 0).
      if (liveRunsBefore === 0) {
        openGapIfNeeded(sessionId);
      }
    },

    notifyAsyncComplete(
      completingId: string | undefined,
      asyncJobs: Map<string, AsyncJobState>,
    ): boolean {
      if (!currentGap) return false;
      // Count live runs excluding the completing job (which still has old status in asyncJobs).
      let liveAfter = 0;
      for (const job of asyncJobs.values()) {
        if (completingId !== undefined && job.asyncId === completingId) continue;
        if (!ASYNC_TERMINAL_STATUSES.has(job.status)) liveAfter++;
      }
      if (liveAfter === 0) {
        closeGapWithSummary(true);
        return true;
      }
      return false;
    },

    disarm(): void {
      closeGapWithSummary(true);
    },

    destroy(): void {
      // Close gap without emitting session entry (session going away).
      if (currentGap) {
        const acc = currentGap;
        currentGap = null;
        // Abort in-flight via controller.destroy() below — endGap is not called
        // here because we're going to destroy immediately after.
        appendGapSummaryRecord(acc, resolvedLogPath, appendFileSyncBase, mkdirSyncBase, nowFn);
        // Update session totals even on destroy (for doctor if called before destroy).
        sessionTotalBeats += acc.executedBeats;
        sessionTotalCacheReadTokens += acc.totalCacheReadTokens;
        sessionTotalBeatCostUsd += acc.totalBeatCostUsd;
        const verdict = verdictFrom(acc);
        if (verdict === "saved") sessionGapsSaved++;
        else if (verdict === "wasted") sessionGapsWasted++;
        else if (verdict === "lost") sessionGapsLost++;
        else sessionGapsUnneeded++;
      }
      controller.destroy();
    },

    tryRearm(liveRunCount: number, sessionId: string | null): void {
      // Re-arm only when the parent is idle, live runs exist, and no gap is
      // currently active (e.g. after a parent turn disarmed the gap).
      if (!isIdleState || liveRunCount <= 0 || currentGap) return;
      openGapIfNeeded(sessionId);
    },

    resetSession(): void {
      // Discard any open gap without emitting a duplicate summary.
      // (session_before_switch/fork already called disarm() which emits a
      // summary; this guard handles the rare case where a gap is still open.)
      currentGap = null;
      // Do not let tryRearm open a new gap until the new session reports its
      // actual idle state.
      isIdleState = false;
      // Reset session totals for the new session.
      sessionTotalBeats = 0;
      sessionTotalCacheReadTokens = 0;
      sessionTotalBeatCostUsd = 0;
      sessionGapsSaved = 0;
      sessionGapsWasted = 0;
      sessionGapsLost = 0;
      sessionGapsUnneeded = 0;
      sessionBreakerDisabled = false;
      // Reset controller state (disabled flag, consecutive failures, in-flight,
      // open gap state) without emitting a log entry.
      controller.resetSession();
    },

    getSessionSummary(): HeartbeatSessionSummary {
      // Project the active accumulator onto the read-time totals without
      // finalizing it.  Gap verdict counters remain finalized-only so doctor
      // does not report a verdict for a gap that is still in progress.
      const activeGap = currentGap;
      return {
        enabled: true,
        totalBeats: sessionTotalBeats + (activeGap?.executedBeats ?? 0),
        totalCacheReadTokens: sessionTotalCacheReadTokens + (activeGap?.totalCacheReadTokens ?? 0),
        totalBeatCostUsd: sessionTotalBeatCostUsd + (activeGap?.totalBeatCostUsd ?? 0),
        gapsSaved: sessionGapsSaved,
        gapsWasted: sessionGapsWasted,
        gapsLost: sessionGapsLost,
        gapsUnneeded: sessionGapsUnneeded,
        breakerDisabled: sessionBreakerDisabled,
      };
    },
  };
}
