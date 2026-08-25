/**
 * Prompt-cache heartbeat controller.
 *
 * While async subagent runs are live and the parent Pi session is idle,
 * this controller periodically replays the last captured provider payload
 * through the provider stream to refresh the prompt-cache TTL at
 * cache-read prices.
 *
 * Public API (consumed by the wire-up ticket, tlhmf-db3g):
 *   createHeartbeatController(config, deps) → HeartbeatController
 *
 * The controller is pure-session: it never persists anything to the Pi session
 * and never triggers agent turns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ResolvedHeartbeatConfig } from "./heartbeat-config.ts";
import {
  beginBeat,
  CACHE_WRITE_MISMATCH_THRESHOLD,
  closeGap,
  completeBeat,
  createHeartbeatState,
  decideBeat,
  openGap,
  recordProviderRequest,
  type HeartbeatMachineState,
  type HeartbeatOutcome,
  type HeartbeatUsage,
} from "./heartbeat-state.ts";
import {
  createHeartbeatLogger,
  type HeartbeatLogRecord,
  type HeartbeatLogger,
} from "./heartbeat-logger.ts";
import { getAgentDir } from "../../shared/utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum serialized payload size accepted for capture (~2 MB). */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** Timeout for a ghost stream request. */
const BEAT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of a captured provider request. */
interface HeartbeatCapture {
  payload: unknown;
  model: Model<Api>;
  /** Wall-clock timestamp when the provider request was captured. */
  capturedAt: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Structured result emitted by the controller after each beat completes.
 * Consumed by the wiring to accumulate per-gap stats without file-I/O interception.
 */
export interface BeatResult {
  gapId: string;
  outcome: HeartbeatOutcome;
  usage?: HeartbeatUsage;
  estCostUsd?: number;
  model: Model<Api>;
  /**
   * True when the session circuit-breaker is now disabled (either as a result
   * of this beat or due to a prior error that finally tripped the threshold).
   */
  sessionDisabled: boolean;
}

/**
 * Dependencies injected into the controller.
 *
 * All fields are optional; production code uses defaults while unit tests
 * inject lightweight fakes for deterministic behaviour.
 */
export interface HeartbeatControllerDeps {
  /**
   * Lazy getter for the live model registry used for provider lookup and auth.
   * Required in production; resolved at beat time (not at controller creation)
   * so the registry is always the live session registry regardless of when the
   * controller was constructed.
   *
   * If both `getModelRegistry` and `streamProvider` are absent, every beat will
   * fail with an error outcome and the circuit breaker will eventually fire.
   */
  getModelRegistry?: () => ModelRegistry | undefined;
  /** Wall-clock source. Defaults to Date.now. */
  now?: () => number;
  /** Timer factory. Defaults to the global setTimeout. */
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  /** Timer canceller. Defaults to the global clearTimeout. */
  clearTimeout?: (handle: TimerHandle) => void;
  /**
   * Stream factory injected by unit tests to bypass the real provider.
   * Receives model, context and stream options; returns an async iterable of events.
   */
  streamProvider?: (
    model: Model<Api>,
    context: Context,
    options: StreamOptions,
  ) => AsyncIterable<AssistantMessageEvent>;
  /**
   * Callback invoked synchronously at the start of each ghost stream request,
   * before the stream begins.  The wiring uses this for optimistic beat
   * accounting: the request was issued (and may have cost money) regardless of
   * whether it completes normally or is cancelled by a lifecycle event.
   *
   * Called with the gap ID and model so the wiring can identify which gap to
   * credit.  Lifecycle-cancelled beats will NOT be followed by an onBeatResult
   * call — onBeatIssued is the only signal for those beats.
   */
  onBeatIssued?: (gapId: string, model: Model<Api>) => void;
  /**
   * Callback invoked after each executed beat (not for timer-only skips).
   * Used by the wiring to accumulate per-gap stats without intercepting file I/O.
   * JSONL logging still happens inside the controller; this callback provides
   * structured access to the same data.
   *
   * NOTE: executedBeats accounting is done in onBeatIssued (optimistic).
   * onBeatResult must NOT increment executedBeats again; it should only update
   * outcome-specific fields (cost, cacheRead, mismatch).
   */
  onBeatResult?: (result: BeatResult) => void;
  /**
   * Callback invoked when a beat is lifecycle-cancelled (gap closed while the
   * stream was in flight).  The wiring uses this to increment the
   * `cancelledBeats` counter in the gap accumulator, making the cancellation-
   * only verdict explicitly 'wasted' (beats issued but no cache-read evidence)
   * rather than an implicit fallthrough.
   */
  onBeatCancelled?: (gapId: string) => void;
  /**
   * Callback invoked when the controller decides the gap is terminal-lost
   * (elapsed >= LATE_BEAT_THRESHOLD_MS).  The wiring uses this to override the
   * gap verdict to 'lost' even when prior beats were successful.
   */
  onGapLost?: (gapId: string) => void;
  /**
   * Absolute path for the heartbeat JSONL log.
   * Defaults to <agent-dir>/subagents/heartbeat.jsonl.
   */
  logPath?: string | null;
  /** Override fs.mkdirSync for tests. */
  mkdirSync?: (dir: string, options: { recursive: true }) => void;
  /** Override fs.appendFileSync for tests. */
  appendFileSync?: (file: string, data: string) => void;
}

/** Public interface consumed by the wire-up ticket. */
export interface HeartbeatController {
  /**
   * Capture the provider payload for the next ghost request.
   * Call from the before_provider_request event handler.
   */
  onProviderRequest(payload: unknown, model: Model<Api>): void;
  /**
   * Notify the controller when the parent session transitions to/from idle.
   * When idle=true and a gap is active the beat timer becomes relevant.
   */
  onIdle(idle: boolean): void;
  /**
   * Open a new gap (called when the first async run becomes live).
   * @param gapId     Opaque identifier for this gap (e.g. derived from run IDs).
   * @param sessionId Parent session ID written into every JSONL record.
   */
  startGap(gapId: string, sessionId: string): void;
  /**
   * Close the active gap.
   * Aborts any in-flight beat and eagerly clears the captured payload so
   * stale data is not replayed into a future gap.
   */
  endGap(): void;
  /** Cancel the pending timer and abort any in-flight beat. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultLogPath(): string {
  return path.join(getAgentDir(), "subagents", "heartbeat.jsonl");
}

/** Extract usage from any AssistantMessageEvent variant. */
function extractEventUsage(event: AssistantMessageEvent): HeartbeatUsage {
  let raw: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
  };
  if (event.type === "done") {
    raw = event.message.usage;
  } else if (event.type === "error") {
    raw = event.error.usage;
  } else {
    raw = event.partial.usage;
  }
  return {
    input: raw.input,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    output: raw.output,
  };
}

/** True when usage contains at least one non-zero token count. */
function isUsageBearing(usage: HeartbeatUsage): boolean {
  return usage.input > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.output > 0;
}

/** Estimate USD cost given usage and per-million-token rates. */
function estimateCost(
  usage: HeartbeatUsage,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  return (
    (usage.input * cost.input +
      usage.cacheRead * cost.cacheRead +
      usage.cacheWrite * cost.cacheWrite +
      usage.output * cost.output) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a heartbeat controller.
 *
 * When `config.enabled` is false (the default), the controller is a no-op:
 * all methods return immediately and no timers are scheduled.
 */
export function createHeartbeatController(
  config: ResolvedHeartbeatConfig,
  deps: HeartbeatControllerDeps = {},
): HeartbeatController {
  if (!config.enabled) {
    return {
      onProviderRequest() {},
      onIdle() {},
      startGap() {},
      endGap() {},
      destroy() {},
    };
  }

  const now = deps.now ?? Date.now;
  const schedule: (fn: () => void, ms: number) => TimerHandle =
    deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel: (handle: TimerHandle) => void = deps.clearTimeout ?? clearTimeout;

  const resolvedLogPath = Object.hasOwn(deps, "logPath")
    ? (deps.logPath ?? undefined)
    : defaultLogPath();

  const logger: HeartbeatLogger = createHeartbeatLogger(resolvedLogPath, {
    mkdirSync: deps.mkdirSync ?? ((dir, options) => fs.mkdirSync(dir, options)),
    appendFileSync: deps.appendFileSync ?? ((file, data) => fs.appendFileSync(file, data)),
  });

  const state: HeartbeatMachineState = createHeartbeatState();

  let timerHandle: TimerHandle | undefined;
  let sessionId: string = "";
  let isIdle: boolean = false;
  let destroyed: boolean = false;
  let capture: HeartbeatCapture | null = null;
  /** AbortController for the current in-flight beat. */
  let beatAbortController: AbortController | null = null;
  /**
   * Monotonically-incrementing generation counter tied to gap lifecycle.
   * Captured at the start of executeBeat so post-beat code can detect whether
   * the gap has changed (e.g. because a lifecycle event closed the old gap and
   * a new one opened) and avoid mutating the wrong gap's state.
   */
  let gapGeneration: number = 0;

  // -------------------------------------------------------------------------
  // Timer management
  // -------------------------------------------------------------------------

  function armTimer(): void {
    if (timerHandle !== undefined) {
      cancel(timerHandle);
      timerHandle = undefined;
    }
    if (destroyed || !state.gap) return;
    // Base the delay on time elapsed since the last provider request (or
    // successful beat), so the first beat fires ~intervalMs after capture
    // rather than ~intervalMs after the gap opened.  Without this, a gap that
    // opens more than (intervalMs - LATE_BEAT_THRESHOLD_MS) ms after the last
    // provider request would schedule the beat past the TTL expiry.
    const elapsed = Math.max(0, now() - state.gap.lastRequestAt);
    const delay = Math.max(0, config.intervalMs - elapsed);
    timerHandle = schedule(onTimerFire, delay);
  }

  function cancelTimer(): void {
    if (timerHandle !== undefined) {
      cancel(timerHandle);
      timerHandle = undefined;
    }
  }

  function abortInFlight(): void {
    if (beatAbortController) {
      // Use a named reason so executeBeat can distinguish a lifecycle cancellation
      // (gap closing) from a provider-induced abort (e.g. after usage-bearing event).
      // This prevents the error-breaker from firing on lifecycle cancellations.
      beatAbortController.abort("lifecycle");
      beatAbortController = null;
    }
  }

  // -------------------------------------------------------------------------
  // Beat execution
  // -------------------------------------------------------------------------

  /**
   * Run one ghost stream request and record its outcome.
   * Never throws; errors are caught and logged as "error" outcomes.
   */
  async function executeBeat(
    currentCapture: HeartbeatCapture,
    capturedGapId: string,
    capturedGeneration: number,
  ): Promise<void> {
    const beatStartMs = now();
    const gapId = capturedGapId;
    // Use beatCount BEFORE completeBeat increments it so the index is 0-based.
    const beatIndex = state.gap?.beatCount ?? 0;
    const model = currentCapture.model;

    let outcome: HeartbeatOutcome = "error";
    // When a provider error event is seen, outcome is already "error" and we
    // must not reclassify based on usage.  All other paths (no error event)
    // should classify from usage after the loop.
    let classifyFromUsage = true;
    let usage: HeartbeatUsage | undefined;
    let estCostUsd: number | undefined;
    let lifecycleCancelled = false;

    const abortCtrl = new AbortController();
    beatAbortController = abortCtrl;

    // Optimistic accounting: notify wiring that this beat was issued before
    // the stream starts.  If the gap is closed synchronously (lifecycle event)
    // while the stream is in flight, the wiring will have already counted this
    // beat in the gap summary.  Cancelled beats do not follow up with
    // onBeatResult, so this is the only signal for those beats.
    deps.onBeatIssued?.(gapId, model);

    try {
      let stream: AsyncIterable<AssistantMessageEvent>;

      if (deps.streamProvider) {
        stream = deps.streamProvider(
          model,
          { messages: [] },
          {
            onPayload: () => currentCapture.payload,
            signal: abortCtrl.signal,
            maxRetries: 0,
            timeoutMs: BEAT_TIMEOUT_MS,
            ...(sessionId ? { sessionId } : {}),
          },
        );
      } else {
        const registry = deps.getModelRegistry?.();
        if (!registry) throw new Error("heartbeat: no modelRegistry or streamProvider available");

        const provider = registry.getProvider(model.provider);
        if (!provider) throw new Error(`heartbeat: provider not found: ${model.provider}`);

        const auth = await registry.getApiKeyAndHeaders(model);
        if (!auth.ok) throw new Error(`heartbeat: auth failed: ${auth.error}`);

        const options: StreamOptions = {
          onPayload: () => currentCapture.payload,
          signal: abortCtrl.signal,
          maxRetries: 0,
          timeoutMs: BEAT_TIMEOUT_MS,
          ...(sessionId ? { sessionId } : {}),
          ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
          ...(auth.headers !== undefined ? { headers: auth.headers } : {}),
          // Forward auth.env so providers that scope credentials by environment
          // variable work correctly in the ghost stream.
          ...(auth.env !== undefined ? { env: auth.env } : {}),
        };
        // Provider adapters read baseUrl from model.baseUrl, not from StreamOptions.
        // Override it on a shallow model copy when auth provides a per-credential
        // endpoint — matching how the upstream runtime handles credential-scoped
        // endpoint overrides.
        const streamModel: Model<Api> =
          auth.baseUrl !== undefined ? { ...model, baseUrl: auth.baseUrl } : model;
        // Cast to StreamOptions & Record<string, unknown> to satisfy ApiStreamOptions<Api>
        stream = provider.stream(
          streamModel,
          { messages: [] },
          options as StreamOptions & Record<string, unknown>,
        );
      }

      for await (const event of stream) {
        if (abortCtrl.signal.aborted) break;

        // Skip the synthetic start event; usage fields are not yet populated.
        if (event.type === "start") continue;

        // Provider error events are always classified as "error", regardless of
        // whether they carry usage — the request did not successfully refresh
        // the cache TTL.
        if (event.type === "error") {
          const eventUsage = extractEventUsage(event);
          if (isUsageBearing(eventUsage)) {
            usage = eventUsage;
          }
          // outcome is already "error" (default); mark that it must not be
          // reclassified by the post-loop usage-based classifier.
          classifyFromUsage = false;
          abortCtrl.abort();
          break;
        }

        const eventUsage = extractEventUsage(event);

        if (isUsageBearing(eventUsage)) {
          usage = eventUsage;
          abortCtrl.abort();
          break;
        }

        // For done terminal events, capture whatever usage is available.
        if (event.type === "done") {
          usage = eventUsage;
          break;
        }
      }

      // Classify the outcome from usage evidence when not already determined
      // by a provider error event.  cache_read requires actual cacheRead
      // evidence; zero-cacheRead usage is not a successful TTL refresh and
      // leaves outcome as the default "error".
      if (classifyFromUsage && usage) {
        if (usage.cacheWrite > CACHE_WRITE_MISMATCH_THRESHOLD) {
          outcome = "cache_write_mismatch";
        } else if (usage.cacheRead > 0) {
          outcome = "cache_read";
        }
        // else: usage present but no cacheRead evidence — outcome remains "error"
      }
      // If no usage was observed: outcome remains the default "error".

      try {
        if (usage) {
          estCostUsd = estimateCost(usage, model.cost);
        }
      } catch {
        // Cost estimate is best-effort.
      }
    } catch {
      outcome = "error";
    } finally {
      // Only clear our own reference — a newer beat may have already replaced it.
      if (beatAbortController === abortCtrl) {
        beatAbortController = null;
      }
      abortCtrl.abort();
      // Detect lifecycle cancellation AFTER calling abort() (idempotent if already
      // aborted) so reason is always set before we check it.
      lifecycleCancelled = abortCtrl.signal.reason === "lifecycle";
    }

    // Lifecycle cancellation: the gap was closed by a lifecycle event while the
    // beat was in flight.  Classify as "cancelled" (not "error") so the error
    // breaker is not incremented.  The beat was already counted optimistically
    // via onBeatIssued; skip onBeatResult and skip re-arming.
    if (lifecycleCancelled) {
      const record: HeartbeatLogRecord = {
        ts: beatStartMs,
        sessionId,
        gapId,
        beatIndex,
        model: model.id,
        provider: model.provider,
        outcome: "cancelled",
        latencyMs: now() - beatStartMs,
      };
      logger.append(record);
      deps.onBeatCancelled?.(gapId);
      // Only clear inFlight if this beat still matches the active gap generation.
      // A newer gap may have already set state.inFlight = true for its own beat;
      // clearing it here would permit a ghost overlap on the newer gap.
      if (capturedGeneration === gapGeneration) {
        state.inFlight = false;
      }
      return;
    }

    const latencyMs = now() - beatStartMs;

    const record: HeartbeatLogRecord = {
      ts: beatStartMs,
      sessionId,
      gapId,
      beatIndex,
      model: model.id,
      provider: model.provider,
      outcome,
      ...(usage ? { usage } : {}),
      ...(estCostUsd !== undefined ? { estCostUsd } : {}),
      latencyMs,
    };
    logger.append(record);

    if (destroyed) return;

    // Guard against mutating a newer gap: only advance state and re-arm if the
    // gap we started with is still the active one.  A lifecycle event could have
    // closed this gap and opened a new one while the stream was in flight.
    if (state.gap?.gapId !== capturedGapId || gapGeneration !== capturedGeneration) {
      // Stale beat: a newer gap is active.  Do NOT clear state.inFlight — the
      // newer gap owns that flag and may have its own beat in flight.
      return;
    }

    const result = completeBeat(state, outcome, now());

    // Notify the wiring of the beat result via structured callback.
    // NOTE: wiring's executedBeats was already incremented in onBeatIssued;
    // onBeatResult must only update outcome-specific fields (cost, cacheRead).
    deps.onBeatResult?.({
      gapId,
      outcome,
      usage,
      estCostUsd,
      model,
      sessionDisabled: state.disabled,
    });

    if (result.stopGap) {
      closeGap(state);
      cancelTimer();
      return;
    }

    // Re-arm for the next interval.
    armTimer();
  }

  // -------------------------------------------------------------------------
  // Timer callback
  // -------------------------------------------------------------------------

  function onTimerFire(): void {
    timerHandle = undefined;
    if (destroyed) return;

    const decision = decideBeat(config, state, isIdle, now());

    if (decision.fire) {
      if (!capture) {
        // No captured payload yet — skip silently, re-arm.
        armTimer();
        return;
      }
      beginBeat(state);
      const currentCapture = capture;
      const capturedGapId = state.gap?.gapId ?? "unknown";
      const capturedGeneration = gapGeneration;
      // Beat is async; fire and forget.
      executeBeat(currentCapture, capturedGapId, capturedGeneration).catch(() => {
        // executeBeat never throws, but guard defensively.
      });
      // The timer is re-armed inside executeBeat once the beat completes.
      return;
    }

    // Decision says skip.
    if (decision.stopGap) {
      // Log the skip for outcomes that warrant a record.
      const loggableOutcomes: Set<string> = new Set(["lost", "capped"]);
      if (loggableOutcomes.has(decision.outcome)) {
        const gapId = state.gap?.gapId ?? "unknown";
        const record: HeartbeatLogRecord = {
          ts: now(),
          sessionId,
          gapId,
          beatIndex: state.gap?.beatCount ?? 0,
          model: capture?.model.id ?? "",
          provider: capture?.model.provider ?? "",
          outcome: decision.outcome as HeartbeatOutcome,
        };
        logger.append(record);
        // Notify wiring of terminal-lost so it can override the gap verdict
        // even if prior beats were successful (cache refreshed then expired).
        if (decision.outcome === "lost") {
          deps.onGapLost?.(gapId);
        }
      }
      closeGap(state);
      cancelTimer();
      return;
    }

    // Non-terminal skip (not_idle, in_flight, etc.) — re-arm.
    armTimer();
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  return {
    onProviderRequest(payload: unknown, model: Model<Api>): void {
      if (destroyed || state.disabled) return;

      // Validate serialized size before storing.
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        return;
      }
      if (Buffer.byteLength(serialized, "utf-8") > MAX_PAYLOAD_BYTES) {
        // Payload too large — clear any stale capture to avoid a mismatched replay.
        capture = null;
        return;
      }

      // Deep-copy via JSON round-trip so mutations to the original do not affect the capture.
      try {
        capture = {
          payload: JSON.parse(serialized) as unknown,
          model,
          capturedAt: now(),
        };
      } catch {
        capture = null;
        return;
      }

      // Reset the timer: the new request is the new reference point.
      if (state.gap) {
        recordProviderRequest(state, now());
        armTimer();
      }
    },

    onIdle(idle: boolean): void {
      isIdle = idle;
      // No explicit timer action needed here; decideBeat will gate on isIdle.
    },

    startGap(gapId: string, sid: string): void {
      if (destroyed || state.disabled) return;
      sessionId = sid;
      gapGeneration++;
      // Reset inFlight for the new gap.  Any in-flight beat from the previous
      // gap was aborted (via endGap() → abortInFlight()) and will settle in
      // the cancellation or stale-generation path without disturbing this flag.
      state.inFlight = false;
      openGap(state, gapId, now());
      // Base first-beat timing on the captured provider-request timestamp rather
      // than the gap-open time.  The gap may open some time after the last real
      // provider request, which could schedule the beat past the cache TTL.
      if (capture && state.gap) {
        state.gap.lastRequestAt = capture.capturedAt;
      }
      armTimer();
    },

    endGap(): void {
      // Abort any in-flight beat before closing the gap so the ghost stream
      // does not continue using a stale payload from a completed gap.
      abortInFlight();
      // Eagerly clear the captured payload/model so stale context is not
      // replayed into a future gap.
      capture = null;
      closeGap(state);
      cancelTimer();
    },

    destroy(): void {
      destroyed = true;
      cancelTimer();
      abortInFlight();
    },
  };
}
