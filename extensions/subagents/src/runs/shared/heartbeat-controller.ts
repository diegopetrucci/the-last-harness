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
  AssistantMessage,
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
  MIN_REARM_DELAY_MS,
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
 * The wiring uses it for completion-only state; usage accounting is published
 * earlier through BeatAccounting.
 */
export interface BeatResult {
  gapId: string;
  outcome: HeartbeatOutcome;
  usage?: HeartbeatUsage;
  estCostUsd?: number;
  model: Model<Api>;
  /**
   * True when the session circuit-breaker is now disabled (either as a result
   * of this beat or due to a prior failure that finally tripped the threshold).
   */
  sessionDisabled: boolean;
}

/**
 * Usage and cost observed before a provider iterator has finished cleaning up.
 * Only outcomes that can be classified from the observed usage are allowed;
 * generation cutoffs with usage are represented as `error` here, while the
 * final beat result/JSONL record retains the `generation_cutoff` outcome.
 */
export interface BeatAccounting {
  gapId: string;
  outcome: "cache_read" | "cache_write_mismatch" | "error";
  usage: HeartbeatUsage;
  estCostUsd?: number;
  model: Model<Api>;
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
   * credit.  A beat cancelled before usage is observed will not be followed by
   * an onBeatAccounting or onBeatResult call — onBeatIssued is its only signal.
   */
  onBeatIssued?: (gapId: string, model: Model<Api>) => void;
  /**
   * Callback invoked synchronously when the first usage-bearing event is
   * observed, before aborting the stream can yield to iterator cleanup.
   * Used by the wiring to account for usage and cost before a lifecycle event
   * can close the gap.  It is invoked at most once per beat.
   */
  onBeatAccounting?: (accounting: BeatAccounting) => void;
  /**
   * Callback invoked after each executed beat (not for timer-only skips).
   * Used by the wiring to propagate completion-only state without intercepting
   * file I/O.  JSONL logging still happens inside the controller.
   *
   * NOTE: executedBeats accounting is done in onBeatIssued (optimistic), and
   * usage/cost accounting is done in onBeatAccounting.  onBeatResult must not
   * account for either again; it only propagates outcome completion state.
   */
  onBeatResult?: (result: BeatResult) => void;
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
  /**
   * Reset session-scoped state for a new session.
   *
   * Clears the failure breaker (disabled flag), consecutive-failure count, captured
   * request, idle/session identity, and any open gap state.  Does NOT reset the
   * resolved config.  Safe to call when a gap is somehow still open — closes
   * it without emitting a duplicate log entry.
   */
  resetSession(): void;
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

/** True when a content block contains generated text, reasoning, or arguments. */
function hasGeneratedContentBlock(block: AssistantMessage["content"][number] | undefined): boolean {
  if (!block) return false;
  if (block.type === "text") return block.text.length > 0;
  if (block.type === "thinking") {
    // The provider's [Reasoning redacted] marker represents a completed block,
    // not an empty thinking start, so keep it on the non-success path.
    return block.thinking.length > 0;
  }
  return Object.keys(block.arguments).length > 0;
}

/** True when a completed assistant message contains generated content. */
function hasGeneratedContent(content: AssistantMessage["content"]): boolean {
  return content.some((block) => block.type === "toolCall" || hasGeneratedContentBlock(block));
}

/**
 * True when an event crosses the generation boundary for a heartbeat.
 *
 * A block start can still be the safe usage observation used by Anthropic: its
 * partial message may carry cacheRead before any block content is present, and
 * output usage may already be non-zero even when the block is empty.  A block
 * start without that cache evidence is nevertheless the first boundary, so it
 * must not wait for a later delta.  Deltas/ends are generation-bearing by
 * event shape; done is generation-bearing when output or content exists.
 */
function isGenerationBearingEvent(event: AssistantMessageEvent, usage: HeartbeatUsage): boolean {
  switch (event.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return (
        usage.cacheRead <= 0 || hasGeneratedContentBlock(event.partial.content[event.contentIndex])
      );
    case "text_delta":
    case "text_end":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_delta":
    case "toolcall_end":
      return true;
    case "done":
      return usage.output > 0 || hasGeneratedContent(event.message.content);
    case "start":
    case "error":
      return false;
  }
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

/** Classify an observed usage snapshot without advancing controller state. */
function classifyObservedUsage(
  usage: HeartbeatUsage,
  classifyFromUsage: boolean,
): BeatAccounting["outcome"] {
  if (!classifyFromUsage) return "error";
  if (usage.cacheWrite > CACHE_WRITE_MISMATCH_THRESHOLD) return "cache_write_mismatch";
  if (usage.cacheRead > 0) return "cache_read";
  return "error";
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
      resetSession() {},
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

  /**
   * Re-arm the timer after a deferred attempt (not_idle, in_flight, no-capture,
   * or error).
   *
   * Applies MIN_REARM_DELAY_MS as a floor so the controller never spins on
   * setTimeout(0) when elapsed >= intervalMs and the attempt did not advance
   * lastRequestAt.  The initial-scheduling path (armTimer) is unchanged.
   */
  function rearmAfterSkip(): void {
    if (timerHandle !== undefined) {
      cancel(timerHandle);
      timerHandle = undefined;
    }
    if (destroyed || !state.gap) return;
    const elapsed = Math.max(0, now() - state.gap.lastRequestAt);
    const delay = Math.max(MIN_REARM_DELAY_MS, Math.max(0, config.intervalMs - elapsed));
    timerHandle = schedule(onTimerFire, delay);
  }

  function abortInFlight(): void {
    if (beatAbortController) {
      // Use a named reason so executeBeat can distinguish a lifecycle cancellation
      // (gap closing) from a provider-induced abort (e.g. after usage-bearing event).
      // This prevents the failure breaker from firing on lifecycle cancellations.
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
    capturedSessionId: string,
    capturedGeneration: number,
    capturedBeatIndex: number,
  ): Promise<void> {
    const beatStartMs = now();
    // Snapshot all beat identity before any asynchronous provider/auth work so
    // later lifecycle changes cannot retag this beat with a newer session.
    const gapId = capturedGapId;
    const sessionId = capturedSessionId;
    const beatIndex = capturedBeatIndex;
    const model = currentCapture.model;

    let outcome: HeartbeatOutcome = "error";
    // Provider errors remain genuine "error" outcomes. Generation-bearing
    // events become "generation_cutoff" outcomes unless cache-write evidence
    // preserves the existing mismatch classification.
    let forcedOutcome: "generation_cutoff" | "cache_write_mismatch" | undefined;
    let classifyFromUsage = true;
    let usage: HeartbeatUsage | undefined;
    let estCostUsd: number | undefined;
    let lifecycleCancelled = false;
    /** Prevent normal completion from accounting usage a second time. */
    let accountingPublished = false;

    const publishBeatAccounting = (): void => {
      if (
        accountingPublished ||
        !usage ||
        !isUsageBearing(usage) ||
        destroyed ||
        gapGeneration !== capturedGeneration ||
        state.gap?.gapId !== capturedGapId
      ) {
        return;
      }
      accountingPublished = true;
      try {
        estCostUsd = estimateCost(usage, model.cost);
      } catch {
        // Cost estimate is best-effort.
      }
      deps.onBeatAccounting?.({
        gapId,
        outcome: classifyObservedUsage(usage, classifyFromUsage),
        usage,
        ...(estCostUsd !== undefined ? { estCostUsd } : {}),
        model,
      });
    };

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
        // Auth lookup is asynchronous.  A session reset, gap close, or newer
        // gap may have invalidated this beat while it was pending; never build
        // a provider stream for that stale request.
        if (
          abortCtrl.signal.aborted ||
          destroyed ||
          gapGeneration !== capturedGeneration ||
          state.gap?.gapId !== capturedGapId
        ) {
          if (!abortCtrl.signal.aborted) abortCtrl.abort("lifecycle");
          // Throw so the common finally/cancellation path records the beat as
          // cancelled without ever constructing a provider stream.
          throw new Error("heartbeat: beat invalidated during auth lookup");
        }
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
          // Publish before aborting: closing the iterator may yield to a
          // lifecycle disarm that flushes the current gap accumulator.
          publishBeatAccounting();
          abortCtrl.abort();
          break;
        }

        const eventUsage = extractEventUsage(event);

        // A block start without cache-read evidence is already the generation
        // boundary. Deltas/ends and generated done messages are likewise too
        // late to qualify as a cheap cache-read beat. Preserve the existing
        // mismatch classifier for cache-write evidence on any event.
        if (isGenerationBearingEvent(event, eventUsage)) {
          if (isUsageBearing(eventUsage)) {
            usage = eventUsage;
          }
          if (eventUsage.cacheWrite > CACHE_WRITE_MISMATCH_THRESHOLD) {
            forcedOutcome = "cache_write_mismatch";
          } else {
            // A generation-boundary abort is a distinct bounded non-success,
            // even when the same event happens to include cache-read or output
            // usage. Do not wait for a later usage event.
            forcedOutcome = "generation_cutoff";
            classifyFromUsage = false;
          }
          // Publish before aborting: closing the iterator may yield to a
          // lifecycle disarm that flushes the current gap accumulator.
          publishBeatAccounting();
          abortCtrl.abort();
          break;
        }

        if (isUsageBearing(eventUsage)) {
          usage = eventUsage;
          // Publish before aborting: closing the iterator may yield to a
          // lifecycle disarm that flushes the current gap accumulator.
          publishBeatAccounting();
          abortCtrl.abort();
          break;
        }

        // For an actually empty done event, capture whatever usage is available.
        if (event.type === "done") {
          usage = eventUsage;
          break;
        }
      }

      // Classify the outcome from usage evidence unless a provider error or
      // generation boundary already forced a result. cache_read requires actual
      // cacheRead evidence; zero-cacheRead usage is not a successful TTL refresh
      // and leaves outcome as the default "error".
      if (forcedOutcome) {
        outcome = forcedOutcome;
      } else if (classifyFromUsage && usage) {
        outcome = classifyObservedUsage(usage, classifyFromUsage);
      }
      // If no usage was observed: outcome remains the default "error".

      try {
        if (usage) {
          estCostUsd = estimateCost(usage, model.cost);
        }
      } catch {
        // Cost estimate is best-effort.
      }
      // Usage-bearing events publish before stream abort/iterator cleanup. Keep
      // this completion-side call as an idempotent fallback for any future
      // usage-bearing event path.
      publishBeatAccounting();
    } catch {
      // Preserve a classification made before iterator cleanup. In particular,
      // a generation cutoff must remain distinct from a provider/stream error.
      outcome = forcedOutcome ?? "error";
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
      // If this gap was closed while iterator cleanup was pending, preserve a
      // genuine failure for the session breaker. Lifecycle cancellations return
      // above, and a generation change means resetSession/new-gap state owns the
      // machine now. No beat-count or timer mutation is possible without a gap.
      if (
        state.gap === null &&
        gapGeneration === capturedGeneration &&
        (outcome === "cache_read" || outcome === "error" || outcome === "generation_cutoff")
      ) {
        completeBeat(state, outcome, now());
        deps.onBeatResult?.({
          gapId,
          outcome,
          usage,
          estCostUsd,
          model,
          sessionDisabled: state.disabled,
        });
      }
      // This beat is stale. If a newer gap is active, do not clear
      // state.inFlight: the newer gap owns that flag and may have its own beat
      // in flight.
      return;
    }

    const result = completeBeat(state, outcome, now());

    // Notify the wiring that the beat completed so it can propagate breaker
    // state. Usage/cost was already accounted synchronously when first observed.
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

    // Errors do not refresh the provider cache, so keep lastRequestAt as-is
    // while still avoiding a zero-delay retry burst.
    if (outcome === "error" || outcome === "generation_cutoff") {
      rearmAfterSkip();
    } else {
      // Re-arm for the next interval after a successful or otherwise terminal beat.
      armTimer();
    }
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
        // No captured payload yet — skip silently, re-arm with minimum delay
        // so elapsed >= intervalMs does not cause a busy-loop on setTimeout(0).
        rearmAfterSkip();
        return;
      }
      beginBeat(state);
      const currentCapture = capture;
      const capturedGapId = state.gap?.gapId ?? "unknown";
      const capturedSessionId = sessionId;
      const capturedGeneration = gapGeneration;
      const capturedBeatIndex = state.gap?.beatCount ?? 0;
      // Beat is async; fire and forget.
      executeBeat(
        currentCapture,
        capturedGapId,
        capturedSessionId,
        capturedGeneration,
        capturedBeatIndex,
      ).catch(() => {
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

    // Non-terminal skip (not_idle, in_flight, etc.) — re-arm with minimum
    // delay so elapsed >= intervalMs does not cause a busy-loop on setTimeout(0).
    rearmAfterSkip();
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  return {
    onProviderRequest(payload: unknown, model: Model<Api>): void {
      if (destroyed || state.disabled) return;

      // Validate serialized size before storing.
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        // A circular or otherwise non-serializable payload must invalidate any
        // previous capture instead of leaving it available for replay.
        capture = null;
        return;
      }
      if (typeof serialized !== "string") {
        // JSON.stringify returns undefined for root-level undefined, functions,
        // symbols, and some unusable toJSON results.
        capture = null;
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

    resetSession(): void {
      // Invalidate any beat that may still resume after this reset before
      // clearing the session-owned identity it must use for attribution.
      gapGeneration++;
      cancelTimer();
      abortInFlight();
      capture = null;
      sessionId = "";
      isIdle = false;
      // Reset all session-scoped state without emitting a log entry.
      // (The wiring is responsible for discarding the gap accumulator
      // and resetting session totals before calling this.)
      state.disabled = false;
      state.consecutiveErrors = 0;
      state.inFlight = false;
      state.gap = null;
    },
  };
}
