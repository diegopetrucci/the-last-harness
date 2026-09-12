/**
 * Heartbeat controller scheduling and cancellation tests.
 *
 * Stream, timer, and logger state comes from per-test factories in the shared
 * heartbeat fixture module; this suite owns no mutable global fixtures.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatController } from "../../src/runs/shared/heartbeat-controller.ts";
import { MIN_REARM_DELAY_MS } from "../../src/runs/shared/heartbeat-state.ts";
import type { ResolvedHeartbeatConfig } from "../../src/runs/shared/heartbeat-config.ts";
import type { AssistantMessageEvent, StreamOptions } from "@earendil-works/pi-ai";
import {
  BASE_CONFIG,
  makeLoggerSink,
  makeModel,
  makeStartEvent,
  makeStream,
  makeTextStartEvent,
  makeTimerFake,
} from "../support/heartbeat-controller-fixtures.ts";
import type { FakeHandle } from "../support/heartbeat-controller-fixtures.ts";

// ---------------------------------------------------------------------------
// Tests: no-op when disabled
// ---------------------------------------------------------------------------

describe("createHeartbeatController — disabled by default", () => {
  it("is a no-op when enabled=false", () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(
      { ...BASE_CONFIG, enabled: false },
      {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
      },
    );

    ctrl.onProviderRequest({ foo: 1 }, makeModel());
    ctrl.startGap("g1", "sess-1");
    timer.advance(BASE_CONFIG.intervalMs);
    timer.firePending();

    assert.equal(sink.records.length, 0, "no records when disabled");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: arming predicate (gap + idle)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — arming predicate", () => {
  it("does not fire a beat when no gap is active", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCallCount = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCallCount++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onIdle(true);
    ctrl.onProviderRequest({}, makeModel());
    // No startGap — no beat should fire
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCallCount, 0);
    ctrl.destroy();
  });

  it("does not fire a beat when parent is not idle", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCallCount = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCallCount++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onIdle(false); // not idle
    ctrl.onProviderRequest({}, makeModel());
    ctrl.startGap("g1", "sess-1");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCallCount, 0);
    ctrl.destroy();
  });

  it("fires a beat when gap is active and parent is idle", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCallCount = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCallCount++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    // Wait for async beat to complete
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(streamCallCount, 1);
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: late-timer skip
// ---------------------------------------------------------------------------

describe("createHeartbeatController — late-timer skip", () => {
  it("records 'lost' and stops the gap when elapsed >= LATE_BEAT_THRESHOLD_MS at beat time", () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider: () => makeStream([]),
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    // Advance well past the late threshold without firing timer
    timer.advance(290_001);
    timer.firePending();

    assert.equal(sink.records.length, 1);
    assert.equal((sink.records[0] as { outcome: string }).outcome, "lost");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: per-gap caps
// ---------------------------------------------------------------------------

describe("createHeartbeatController — per-gap caps", () => {
  it("records 'capped' when beatCount reaches maxBeatsPerGap", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;

    const smallCapConfig = { ...BASE_CONFIG, maxBeatsPerGap: 1 };

    const ctrl = createHeartbeatController(smallCapConfig, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    // First beat
    timer.advance(smallCapConfig.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Second beat attempt — should be capped
    timer.advance(smallCapConfig.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // One successful beat, then one capped record
    const outcomes = sink.records.map((r) => (r as { outcome: string }).outcome);
    assert.ok(outcomes.includes("cache_read"), "first beat should succeed");
    assert.ok(outcomes.includes("capped"), "second attempt should be capped");
    assert.equal(streamCalls, 1, "stream must be called exactly once (capped beat skips stream)");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: single in-flight beat
// ---------------------------------------------------------------------------

describe("createHeartbeatController — single in-flight beat", () => {
  it("skips a second beat while one is already in flight", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;
    let resolveStream!: () => void;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return (async function* () {
          // Hold the stream open until resolveStream is called
          await new Promise<void>((r) => {
            resolveStream = r;
          });
          yield makeTextStartEvent();
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    // Fire first beat
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCalls, 1);

    // Try to fire a second beat while first is still in-flight
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCalls, 1, "second beat should be skipped while first is in-flight");

    resolveStream();
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: error -> silent skip + log
// ---------------------------------------------------------------------------

describe("createHeartbeatController — error handling", () => {
  it("records 'error' outcome when stream throws, does not throw into caller", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        return (async function* () {
          yield makeStartEvent();
          throw new Error("network failure");
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    const errRecords = sink.records.filter((r) => (r as { outcome: string }).outcome === "error");
    assert.ok(errRecords.length > 0, "error outcome must be logged");
    ctrl.destroy();
  });

  it("re-arms errors with the minimum delay before the three-error breaker trips", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const scheduledDelays: number[] = [];
    let errorCount = 0;

    const trackingSetTimeout = (fn: () => void, ms: number): FakeHandle => {
      scheduledDelays.push(ms);
      return timer.setTimeout(fn, ms);
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: trackingSetTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        errorCount++;
        return (async function* () {
          throw new Error("always fails");
          /* eslint-disable no-unreachable */
          yield makeStartEvent();
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    // The first error is due at the normal interval, then must re-arm with a
    // positive floor without moving lastRequestAt forward.
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCount, 1);
    assert.equal(scheduledDelays[0], BASE_CONFIG.intervalMs);
    assert.equal(
      scheduledDelays.at(-1),
      MIN_REARM_DELAY_MS,
      "the first error must re-arm with the minimum positive delay",
    );

    // A pending error re-arm must not fire again in the same tick or before its
    // full delay has elapsed.
    timer.firePending();
    assert.equal(errorCount, 1, "the first error must not trigger a same-tick retry");
    timer.advance(MIN_REARM_DELAY_MS - 1);
    timer.firePending();
    assert.equal(errorCount, 1, "the first error must wait for the minimum delay");

    // The second error gets the same guarded re-arm, while the third still
    // trips the existing session breaker.
    timer.advance(1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCount, 2);
    assert.equal(
      scheduledDelays.at(-1),
      MIN_REARM_DELAY_MS,
      "the second error must re-arm with the minimum positive delay",
    );
    timer.firePending();
    assert.equal(errorCount, 2, "the second error must not trigger a same-tick retry");

    timer.advance(MIN_REARM_DELAY_MS);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCount, 3);

    // After 3 errors the controller should be permanently disabled; no timer
    // remains that can invoke the stream again.
    timer.advance(BASE_CONFIG.intervalMs + MIN_REARM_DELAY_MS);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCount, 3, "no more stream calls after session disabled");
    assert.equal(
      sink.records.filter((r) => (r as { outcome: string }).outcome === "error").length,
      3,
      "each breaker attempt must remain an error outcome",
    );
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: endGap and destroy
// ---------------------------------------------------------------------------

describe("createHeartbeatController — endGap and destroy", () => {
  it("endGap stops the timer and clears the gap", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    ctrl.endGap();

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCalls, 0, "no beat after endGap");
    ctrl.destroy();
  });

  it("destroy is idempotent", () => {
    const ctrl = createHeartbeatController(BASE_CONFIG, {
      logPath: null,
    });
    ctrl.startGap("g1", "s");
    assert.doesNotThrow(() => {
      ctrl.destroy();
      ctrl.destroy();
    });
  });

  it("endGap aborts an in-flight beat (finding 3)", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamAborted = false;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(
        _model,
        _context,
        options: import("@earendil-works/pi-ai").StreamOptions,
      ): AsyncIterable<import("@earendil-works/pi-ai").AssistantMessageEvent> {
        return (async function* () {
          // Hold the stream open until aborted
          await new Promise<void>((r) => {
            if (options.signal) {
              options.signal.addEventListener("abort", () => {
                streamAborted = true;
                r();
              });
            } else {
              // No signal — resolve immediately so the test doesn't hang
              r();
            }
          });
          yield makeTextStartEvent();
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    // Start the beat
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));

    // endGap should abort the in-flight beat
    ctrl.endGap();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamAborted, true, "endGap must abort the in-flight beat signal");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: first-beat timing from capturedAt (finding 6)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — first-beat timing (finding 6)", () => {
  it("uses captured provider-request timestamp as lastRequestAt on gap open", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    // Capture a provider request at t=0
    timer.advance(0);
    ctrl.onProviderRequest({}, makeModel());
    const captureTime = timer.now(); // 0

    // Advance time significantly before opening the gap
    timer.advance(50_000);
    ctrl.onIdle(true);
    ctrl.startGap("g-timing", "sess-t");

    // The gap opened at t=50_000, but capturedAt=0. The first beat timer should
    // fire after intervalMs from capturedAt (not from gap-open).
    // Advance to just past intervalMs from capturedAt.
    timer.advance(BASE_CONFIG.intervalMs - captureTime + 1); // effectively intervalMs+1 from t=0
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // With capturedAt-based timing, the beat should have fired by now.
    assert.ok(
      streamCalls >= 1,
      `beat should fire when intervalMs has elapsed from capturedAt; streamCalls=${streamCalls}`,
    );
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: armTimer uses elapsed-based delay (finding A — second pass)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — armTimer elapsed-based delay (finding A)", () => {
  it("gap opening >35s after capture fires beat before the 290s threshold", async () => {
    // Regression for: armTimer previously scheduled a fresh intervalMs from gap-open
    // time, so opening the gap 40s after capture would schedule the beat at
    // capturedAt + 40000 + 255000 = capturedAt + 295000, past the 290s threshold.
    // With the fix, the delay = max(0, intervalMs - elapsed) so the beat fires at
    // capturedAt + 255000 regardless of when the gap opens.
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;

    const prodConfig: ResolvedHeartbeatConfig = {
      enabled: true,
      intervalMs: 255_000,
      maxDurationMs: 3_600_000,
      maxBeatsPerGap: 11,
    };

    const ctrl = createHeartbeatController(prodConfig, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    // Capture at t=0
    ctrl.onProviderRequest({}, makeModel());

    // Gap opens 40s (>35s) after capture
    timer.advance(40_000);
    ctrl.onIdle(true);
    ctrl.startGap("g-threshold", "sess-threshold");

    // With corrected armTimer:
    //   elapsed = 40000, delay = max(0, 255000 - 40000) = 215000
    //   beat fires at t = 40000 + 215000 = 255000 (before 290000 threshold)
    // With old buggy armTimer:
    //   delay = 255000, beat fires at t = 40000 + 255000 = 295000 (PAST threshold)
    timer.advance(215_001); // now at t=255001 — beat should have fired with fix
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      streamCalls >= 1,
      `beat must fire before 290s threshold when gap opens >35s after capture (streamCalls=${streamCalls})`,
    );
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: lifecycle-aborted beat (finding B — second pass)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — lifecycle cancellation (finding B)", () => {
  it("lifecycle-aborted beat logs 'cancelled' and does not increment the error breaker", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const beatResults: import("../../src/runs/shared/heartbeat-controller.ts").BeatResult[] = [];
    const beatAccounting: import("../../src/runs/shared/heartbeat-controller.ts").BeatAccounting[] =
      [];
    let capturedSignal: AbortSignal | undefined;
    // Signal when the stream generator has started so the test knows the beat
    // is in-flight before it calls endGap.
    let streamStarted = false;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatAccounting: (value) => beatAccounting.push(value),
      onBeatResult: (r) => beatResults.push(r),
      streamProvider(
        _model,
        _context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        capturedSignal = options.signal;
        return (async function* () {
          streamStarted = true;
          // Hold the stream open until the abort signal fires.
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // Delegation over empty array satisfies the generator requirement
          // while producing no events (the abort already caused the loop to exit).
          yield* [] as AssistantMessageEvent[];
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-cancel", "sess-cancel");

    // Start the beat
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    // Let the event loop tick so the stream generator starts
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(streamStarted, "stream must have started before endGap is called");

    // Simulate lifecycle disarm (e.g. before_agent_start, session_before_switch)
    ctrl.endGap();

    // Wait for the async beat to settle
    await new Promise((r) => setTimeout(r, 50));

    // The beat signal must have been aborted
    assert.ok(capturedSignal?.aborted, "beat AbortSignal must be aborted on endGap");

    // The JSONL log must show 'cancelled', not 'error'
    const cancelledRecords = sink.records.filter(
      (r) => (r as { outcome: string }).outcome === "cancelled",
    );
    assert.ok(
      cancelledRecords.length >= 1,
      "lifecycle abort must log 'cancelled' outcome, not 'error'",
    );
    const errorRecords = sink.records.filter((r) => (r as { outcome: string }).outcome === "error");
    assert.equal(
      errorRecords.length,
      0,
      "lifecycle abort must not produce any 'error' outcome records",
    );

    // onBeatResult must NOT be called for lifecycle-cancelled beats
    // (executedBeats is already counted optimistically via onBeatIssued)
    assert.equal(
      beatResults.length,
      0,
      "onBeatResult must not be called for lifecycle-cancelled beats",
    );
    assert.equal(
      beatAccounting.length,
      0,
      "onBeatAccounting must not be called when cancellation happens before usage",
    );

    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: onBeatIssued optimistic accounting (finding B)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — onBeatIssued optimistic accounting (finding B)", () => {
  it("calls onBeatIssued before the stream starts (before any await)", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const issuedGaps: string[] = [];
    let streamCallCount = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatIssued: (gapId) => issuedGaps.push(gapId),
      streamProvider() {
        streamCallCount++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-issued", "sess-issued");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(issuedGaps.length, 1, "onBeatIssued must be called once per beat");
    assert.equal(issuedGaps[0], "gap-issued", "onBeatIssued must receive the correct gapId");
    assert.equal(streamCallCount, 1, "stream must have been called");
    ctrl.destroy();
  });

  it("does not call onBeatResult for a lifecycle-cancelled beat", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const beatResultOutcomes: string[] = [];

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatResult: (r) => beatResultOutcomes.push(r.outcome),
      streamProvider(
        _model,
        _context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        return (async function* () {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield* [] as AssistantMessageEvent[];
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-noResult", "sess-noResult");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));

    ctrl.endGap();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      beatResultOutcomes.length,
      0,
      "onBeatResult must not be called for lifecycle-cancelled beats",
    );
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: stale-generation in-flight guard (finding B — round-3 fix)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — stale-generation in-flight guard", () => {
  it("close-gap → reopen-gap → new-beat-in-flight → stale-settle does not clobber newer beat", async () => {
    // Regression: when a lifecycle-cancelled beat (beat A) from gap 1 settled
    // after gap 2 opened and gap 2's beat (beat B) had already started, the
    // stale settle unconditionally cleared state.inFlight.  This allowed the
    // timer to fire a third beat while beat B was still running.
    //
    // Observable effect: if the stale settle clobbers inFlight, decideBeat
    // returns fire=true the next time the timer fires and a third stream call
    // is made while beat B is still in flight.

    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCallCount = 0;
    const streamResolvers: Array<() => void> = [];

    // A stream that blocks until manually resolved (controlled per-call).
    function makeBlockingStream(signal: AbortSignal): AsyncIterable<AssistantMessageEvent> {
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done || signal.aborted) return { done: true, value: undefined };
              // Wait until the stream is explicitly resolved or aborted.
              await new Promise<void>((resolve) => {
                streamResolvers.push(resolve);
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              done = true;
              return { done: true, value: undefined };
            },
            return() {
              done = true;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
    }

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(_model, _context, options: StreamOptions) {
        streamCallCount++;
        return makeBlockingStream(options.signal!);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);

    // Step 1: open gap 1, fire beat A.
    ctrl.startGap("gap-1", "sess-stale");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    // Yield to let the async beat start.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCallCount, 1, "beat A must have started");

    // Step 2: close gap 1 (lifecycle cancel beat A) and open gap 2.
    ctrl.endGap();
    // Re-capture a payload — endGap() eagerly clears the capture so the
    // controller has data to replay for gap 2's first beat.
    ctrl.onProviderRequest({}, makeModel());
    ctrl.startGap("gap-2", "sess-stale");

    // Step 3: fire beat B for gap 2.
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCallCount, 2, "beat B must have started");

    // Step 4: let beat A settle (it was cancelled, so it resolves quickly).
    // Resolve the first stream resolver if it's still pending.
    if (streamResolvers[0]) streamResolvers[0]();
    await new Promise((r) => setTimeout(r, 50));

    // Step 5: fire the timer again — if stale-settle clobbered inFlight,
    // decideBeat would return fire=true and stream 3 would be requested.
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      streamCallCount,
      2,
      "stale settle of beat A must not permit a third stream call while beat B is in flight",
    );

    // Cleanup: resolve beat B's stream and destroy.
    if (streamResolvers[1]) streamResolvers[1]();
    await new Promise((r) => setTimeout(r, 10));
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: MIN_REARM_DELAY_MS — no busy-loop on skip paths (finding 1 — PR review)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — MIN_REARM_DELAY_MS floor on skip re-arm", () => {
  it("not_idle skip past intervalMs re-arms with >=1s delay, not 0", () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const scheduledDelays: number[] = [];

    // Wrap the fake setTimeout to capture delays.
    const trackingSetTimeout = (fn: () => void, ms: number): FakeHandle => {
      scheduledDelays.push(ms);
      return timer.setTimeout(fn, ms);
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: trackingSetTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: null,
      ...sink,
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(false); // not idle — every timer fire will be a not_idle skip
    ctrl.startGap("g-spin", "sess-spin");

    // startGap arms the timer (delay = intervalMs - 0 = 10000 from capturedAt=0).
    // Advance well past intervalMs so elapsed >= intervalMs at fire time.
    timer.advance(BASE_CONFIG.intervalMs + 5_000);
    timer.firePending();

    // The skip re-arm delay must be >= MIN_REARM_DELAY_MS (1000 ms), not 0.
    // The first delay is from startGap (initial arm), the second is from the skip re-arm.
    const rearmDelays = scheduledDelays.slice(1); // skip the initial arm
    assert.ok(rearmDelays.length >= 1, "skip must re-arm the timer");
    for (const d of rearmDelays) {
      assert.ok(d >= 1_000, `re-arm delay must be >=1000 ms, got ${d}`);
    }
    ctrl.destroy();
  });

  it("no-capture skip past intervalMs re-arms with >=1s delay, not 0", () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const scheduledDelays: number[] = [];

    const trackingSetTimeout = (fn: () => void, ms: number): FakeHandle => {
      scheduledDelays.push(ms);
      return timer.setTimeout(fn, ms);
    };

    // No capture ever provided; beat will fire as "no capture" skip.
    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: trackingSetTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: null,
      ...sink,
    });

    // Open gap without any provider request capture.
    ctrl.onIdle(true);
    ctrl.startGap("g-nocapture", "sess-nocapture");

    // Advance past intervalMs so elapsed >= intervalMs at fire time.
    timer.advance(BASE_CONFIG.intervalMs + 5_000);
    timer.firePending();

    const rearmDelays = scheduledDelays.slice(1);
    assert.ok(rearmDelays.length >= 1, "no-capture skip must re-arm the timer");
    for (const d of rearmDelays) {
      assert.ok(d >= 1_000, `re-arm delay must be >=1000 ms, got ${d}`);
    }
    ctrl.destroy();
  });

  it("first beat scheduling (initial arm) is unaffected by MIN_REARM_DELAY_MS", () => {
    // The initial armTimer() (on startGap or onProviderRequest) must still use
    // max(0, intervalMs - elapsed), so a genuinely-due first beat fires promptly.
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const scheduledDelays: number[] = [];

    const trackingSetTimeout = (fn: () => void, ms: number): FakeHandle => {
      scheduledDelays.push(ms);
      return timer.setTimeout(fn, ms);
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: trackingSetTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: null,
      ...sink,
      streamProvider() {
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    // Capture at t=0, advance 5s (well within intervalMs), open gap.
    ctrl.onProviderRequest({}, makeModel());
    timer.advance(5_000);
    ctrl.onIdle(true);
    ctrl.startGap("g-first", "sess-first");

    // Initial arm delay must be intervalMs - 5000 = 5000 (not floored to 1000).
    assert.ok(scheduledDelays.length >= 1, "initial arm must schedule a timer");
    const initialDelay = scheduledDelays[scheduledDelays.length - 1]!;
    assert.ok(
      initialDelay > 1_000,
      `initial arm delay must be >1000 ms when elapsed is small, got ${initialDelay}`,
    );
    ctrl.destroy();
  });
});
