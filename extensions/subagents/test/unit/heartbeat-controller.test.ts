/**
 * Unit tests for the heartbeat controller.
 *
 * Uses injected fakes for: clock, timers, stream provider, and logger deps.
 * No real network calls, no file I/O, no Pi session interaction.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatController } from "../../src/runs/shared/heartbeat-controller.ts";
import type { ResolvedHeartbeatConfig } from "../../src/runs/shared/heartbeat-config.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: ResolvedHeartbeatConfig = {
  enabled: true,
  intervalMs: 10_000,
  maxDurationMs: 60_000,
  maxBeatsPerGap: 3,
};

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    api: "anthropic-messages" as Api,
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    ...overrides,
  } as Model<Api>;
}

type SimpleUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function makeUsage(overrides: Partial<SimpleUsage> = {}): SimpleUsage {
  return {
    input: 1000,
    output: 10,
    cacheRead: 5000,
    cacheWrite: 0,
    totalTokens: 6010,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

/** Build a fake AssistantMessageEvent stream from a list of events. */
async function* makeStream(events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  for (const e of events) yield e;
}

/**
 * Build a start event (usage all zeros — the synthetic event Anthropic emits
 * after HTTP headers but before cache usage is observable).
 */
function makeStartEvent(): AssistantMessageEvent {
  return {
    type: "start",
    partial: {
      role: "assistant",
      content: [],
      api: "anthropic-messages" as Api,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: makeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
      stopReason: "pending",
      timestamp: 0,
    },
  };
}

/** Build a text_start event with usage populated (first usage-bearing event). */
function makeTextStartEvent(usageOverrides: Partial<SimpleUsage> = {}): AssistantMessageEvent {
  return {
    type: "text_start",
    contentIndex: 0,
    partial: {
      role: "assistant",
      content: [],
      api: "anthropic-messages" as Api,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: makeUsage(usageOverrides),
      stopReason: "pending",
      timestamp: 0,
    },
  };
}

/** Build an error event (provider error response — carries a final AssistantMessage). */
function makeErrorEvent(usageOverrides: Partial<SimpleUsage> = {}): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error" as const,
    // The pi-ai error event carries the final AssistantMessage in the .error field.
    error: {
      role: "assistant",
      content: [],
      api: "anthropic-messages" as Api,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: makeUsage(usageOverrides),
      stopReason: "error" as const,
      timestamp: 0,
    },
  } as AssistantMessageEvent;
}

/** Build a done event. */
function makeDoneEvent(usageOverrides: Partial<SimpleUsage> = {}): AssistantMessageEvent {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages" as Api,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usage: makeUsage(usageOverrides),
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

type FakeHandle = ReturnType<typeof setTimeout>;

/** Fake timer that lets tests fire callbacks manually. */
function makeTimerFake(): {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => FakeHandle;
  clearTimeout: (h: FakeHandle) => void;
  advance: (ms: number) => void;
  firePending: () => void;
} {
  let clock = 0;
  // Use object identity for handle lookup so we avoid chained type assertions.
  const pending = new Map<FakeHandle, { fn: () => void; at: number }>();

  return {
    now: () => clock,
    setTimeout(fn, ms) {
      // Single-step assertion, same pattern as deadline-timer.test.ts
      const handle = { unref() {} } as FakeHandle;
      pending.set(handle, { fn, at: clock + ms });
      return handle;
    },
    clearTimeout(h: FakeHandle) {
      pending.delete(h);
    },
    advance(ms: number) {
      clock += ms;
    },
    firePending() {
      const toFire = [...pending.entries()]
        .filter(([, { at }]) => at <= clock)
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [handle, { fn }] of toFire) {
        pending.delete(handle);
        fn();
      }
    },
  };
}

/** Collect JSONL records written during a test. */
function makeLoggerSink(): {
  records: Record<string, unknown>[];
  mkdirSync: () => void;
  appendFileSync: (_file: string, data: string) => void;
} {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    mkdirSync() {},
    appendFileSync(_file: string, data: string) {
      records.push(JSON.parse(data) as Record<string, unknown>);
    },
  };
}

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
// Tests: capture / clear / oversize skip
// ---------------------------------------------------------------------------

describe("createHeartbeatController — payload capture", () => {
  it("passes the captured payload via onPayload to the stream", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let capturedPayload: unknown;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(
        _model: Model<Api>,
        _context: Context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        capturedPayload = options.onPayload?.({}, _model);
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    const payload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    };
    ctrl.onProviderRequest(payload, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(capturedPayload, payload);
    ctrl.destroy();
  });

  it("skips capture when serialized payload exceeds ~2 MB", async () => {
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

    // Build a payload that exceeds the 2 MB limit
    const bigPayload = { data: "x".repeat(2 * 1024 * 1024 + 1) };
    ctrl.onProviderRequest(bigPayload, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Beat should not have fired (no capture available)
    assert.equal(streamCallCount, 0);
    ctrl.destroy();
  });

  it("sets maxRetries=0 on the stream options", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let observedMaxRetries: number | undefined;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(
        _model: Model<Api>,
        _context: Context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        observedMaxRetries = options.maxRetries;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({ x: 1 }, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(observedMaxRetries, 0);
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: abort after first usage-bearing event
// ---------------------------------------------------------------------------

describe("createHeartbeatController — abort semantics", () => {
  it("does not abort on the synthetic start event", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const eventsConsumed: string[] = [];

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        return (async function* () {
          eventsConsumed.push("start");
          yield makeStartEvent();
          eventsConsumed.push("text_start");
          yield makeTextStartEvent();
          eventsConsumed.push("done");
          yield makeDoneEvent();
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Should have consumed start and text_start, then aborted (done may or may not be consumed)
    assert.ok(eventsConsumed.includes("start"), "start must be consumed");
    assert.ok(eventsConsumed.includes("text_start"), "text_start must be consumed");
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

  it("disables the session after MAX_CONSECUTIVE_ERRORS errors", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let errorCount = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
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

    for (let i = 0; i < 3; i++) {
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 50));
    }

    // After 3 errors the controller should be permanently disabled
    // Further timer fires should not invoke the stream
    const beforeCount = errorCount;
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(errorCount, beforeCount, "no more stream calls after session disabled");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: cache_write_mismatch circuit breaker
// ---------------------------------------------------------------------------

describe("createHeartbeatController — cache_write_mismatch circuit breaker", () => {
  it("stops the gap when cacheWrite exceeds the mismatch threshold", async () => {
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
        // Return a large cacheWrite (> CACHE_WRITE_MISMATCH_THRESHOLD)
        return makeStream([
          makeStartEvent(),
          makeTextStartEvent({ cacheRead: 0, cacheWrite: 1024, input: 100, totalTokens: 1124 }),
        ]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Should log cache_write_mismatch
    const mismatchRecords = sink.records.filter(
      (r) => (r as { outcome: string }).outcome === "cache_write_mismatch",
    );
    assert.ok(mismatchRecords.length > 0, "cache_write_mismatch outcome must be logged");

    // Second timer fire should not invoke stream (gap stopped)
    const before = streamCalls;
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(streamCalls, before, "stream should not be called after gap stopped");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: JSONL record shape
// ---------------------------------------------------------------------------

describe("createHeartbeatController — JSONL record shape", () => {
  it("writes a record with all required fields on a successful beat", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        return makeStream([
          makeStartEvent(),
          makeTextStartEvent({
            input: 2000,
            cacheRead: 8000,
            cacheWrite: 0,
            output: 5,
            totalTokens: 10005,
          }),
        ]);
      },
    });

    const model = makeModel();
    ctrl.onProviderRequest({}, model);
    ctrl.onIdle(true);
    ctrl.startGap("gap-xyz", "sess-abc");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(sink.records.length >= 1, "at least one record must be written");
    const rec = sink.records[0] as {
      ts: number;
      sessionId: string;
      gapId: string;
      beatIndex: number;
      model: string;
      provider: string;
      outcome: string;
      usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
      estCostUsd: number;
      latencyMs: number;
    };

    assert.equal(typeof rec.ts, "number");
    assert.equal(rec.sessionId, "sess-abc");
    assert.equal(rec.gapId, "gap-xyz");
    assert.equal(rec.beatIndex, 0);
    assert.equal(rec.model, model.id);
    assert.equal(rec.provider, model.provider);
    assert.equal(rec.outcome, "cache_read");
    assert.ok(rec.usage, "usage must be present");
    assert.equal(rec.usage.cacheRead, 8000);
    assert.equal(typeof rec.estCostUsd, "number");
    assert.equal(typeof rec.latencyMs, "number");
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
// Tests: error event classification (finding 2)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — error event classification (finding 2)", () => {
  it("classifies provider error events as 'error' outcome regardless of usage", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        // Error event with non-zero usage that would previously be misclassified
        // as cache_read
        return makeStream([
          makeStartEvent(),
          makeErrorEvent({ input: 100, cacheRead: 5000, cacheWrite: 0, output: 5 }),
        ]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(sink.records.length >= 1, "at least one record");
    const rec = sink.records[0] as { outcome: string };
    assert.equal(
      rec.outcome,
      "error",
      "error event must produce 'error' outcome, not 'cache_read'",
    );
    ctrl.destroy();
  });

  it("does not classify zero-cacheRead usage as cache_read (finding 2)", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        // Non-zero usage but zero cacheRead — NOT a successful cache refresh
        return makeStream([
          makeStartEvent(),
          makeTextStartEvent({ input: 100, cacheRead: 0, cacheWrite: 0, output: 5 }),
        ]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-1");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(sink.records.length >= 1, "at least one record");
    const rec = sink.records[0] as { outcome: string };
    assert.equal(
      rec.outcome,
      "error",
      "zero cacheRead must produce 'error' outcome, not 'cache_read'",
    );
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: production registry path — getModelRegistry (finding 1)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — production registry path (finding 1)", () => {
  it("fails with error outcome when getModelRegistry returns undefined", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();

    // No streamProvider and no getModelRegistry — simulates production path
    // with no registry supplied.
    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      getModelRegistry: () => undefined,
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-registry");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Should have logged an error outcome (not thrown)
    const errorRecords = sink.records.filter((r) => (r as { outcome: string }).outcome === "error");
    assert.ok(
      errorRecords.length > 0,
      "missing registry must produce error outcome, not throw into host",
    );
    ctrl.destroy();
  });

  it("calls getModelRegistry lazily at beat time (not at construction)", () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let registryCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      getModelRegistry: () => {
        registryCalls++;
        return undefined;
      },
    });

    // Registry getter must NOT be called at construction time
    assert.equal(registryCalls, 0, "registry getter must not be called at construction");

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-lazy");

    // Registry getter must NOT be called at startGap
    assert.equal(registryCalls, 0, "registry getter must not be called at startGap");
    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: onBeatResult callback (finding 7)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — onBeatResult callback (finding 7)", () => {
  it("calls onBeatResult once per executed beat with correct outcome", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const beatResults: import("../../src/runs/shared/heartbeat-controller.ts").BeatResult[] = [];

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatResult: (r) => beatResults.push(r),
      streamProvider() {
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-cb", "sess-cb");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(beatResults.length, 1, "onBeatResult called once per executed beat");
    assert.equal(beatResults[0]!.outcome, "cache_read");
    assert.equal(beatResults[0]!.gapId, "gap-cb");
    assert.ok(beatResults[0]!.usage, "usage should be present");
    assert.equal(typeof beatResults[0]!.sessionDisabled, "boolean");
    ctrl.destroy();
  });

  it("onBeatResult and logger.append are both called exactly once per beat (no double-log)", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let beatResultCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatResult: () => {
        beatResultCalls++;
      },
      streamProvider() {
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-once", "sess-once");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one JSONL record (from logger) and one callback call
    assert.equal(sink.records.length, 1, "exactly one JSONL record per beat");
    assert.equal(beatResultCalls, 1, "onBeatResult called exactly once per beat");
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
// Tests: sessionId in stream options (finding 1)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — sessionId in stream options (finding 1)", () => {
  it("passes sessionId to the fake streamProvider options", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let observedSessionId: string | undefined;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(
        _model: Model<Api>,
        _context: Context,
        options: StreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        observedSessionId = (options as { sessionId?: string }).sessionId;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g1", "sess-id-test");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(
      observedSessionId,
      "sess-id-test",
      "sessionId from startGap must be included in stream options",
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

    ctrl.destroy();
  });
});

// ---------------------------------------------------------------------------
// Tests: production registry path — real fake registry (finding F-1)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — production registry path with real registry shape (finding F-1)", () => {
  it("exercises getModelRegistry().getProvider() and getApiKeyAndHeaders() in production path", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let providerCalls = 0;
    let authCalls = 0;
    let streamCalls = 0;

    const fakeStream = async function* (): AsyncIterable<AssistantMessageEvent> {
      yield makeStartEvent();
      yield makeTextStartEvent();
    };

    const fakeProvider = {
      stream: (
        _model: unknown,
        _context: unknown,
        _options: unknown,
      ): AsyncIterable<AssistantMessageEvent> => {
        streamCalls++;
        return fakeStream();
      },
    };

    // Typed as unknown first so the single 'as ModelRegistry' cast below
    // avoids the chained-assertion anti-slop rule.
    const fakeRegistryObj: unknown = {
      getProvider: (provider: string) => {
        if (provider === "anthropic") {
          providerCalls++;
          return fakeProvider;
        }
        return undefined;
      },
      getApiKeyAndHeaders: async (_model: unknown) => {
        authCalls++;
        return { ok: true as const, apiKey: "test-key-abc" };
      },
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      // Production path: getModelRegistry but NO streamProvider bypass.
      getModelRegistry: () => fakeRegistryObj as ModelRegistry,
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-prod", "sess-prod");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(providerCalls > 0, "getProvider must be called in production registry path");
    assert.ok(authCalls > 0, "getApiKeyAndHeaders must be called in production registry path");
    assert.ok(streamCalls > 0, "provider.stream must be called in production registry path");
    assert.ok(sink.records.length > 0, "must have logged a beat record");

    ctrl.destroy();
  });

  it("forwards auth.baseUrl on the model and auth.env in stream options in production path", async () => {
    // Provider adapters (e.g. anthropic-messages.js) read baseUrl from
    // model.baseUrl, not from StreamOptions.  auth.env is a recognised
    // StreamOption and stays in options.
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let observedModel: Record<string, unknown> | undefined;
    let observedStreamOptions: Record<string, unknown> | undefined;

    const fakeStream = async function* (): AsyncIterable<AssistantMessageEvent> {
      yield makeStartEvent();
      yield makeTextStartEvent();
    };

    const fakeProvider = {
      stream: (
        model: unknown,
        _context: unknown,
        options: unknown,
      ): AsyncIterable<AssistantMessageEvent> => {
        observedModel = model as Record<string, unknown>;
        observedStreamOptions = options as Record<string, unknown>;
        return fakeStream();
      },
    };

    const fakeRegistryObj2: unknown = {
      getProvider: (provider: string) => (provider === "anthropic" ? fakeProvider : undefined),
      getApiKeyAndHeaders: async (_model: unknown) => ({
        ok: true as const,
        apiKey: "test-key",
        baseUrl: "https://custom.api.example.com",
        env: { ANTHROPIC_CUSTOM: "1" },
      }),
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      getModelRegistry: () => fakeRegistryObj2 as ModelRegistry,
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-auth", "sess-auth");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(observedModel !== undefined, "stream must have been called");
    // auth.baseUrl must be applied to the MODEL (not stream options) so
    // provider adapters that read model.baseUrl pick it up correctly.
    assert.equal(
      observedModel!["baseUrl"],
      "https://custom.api.example.com",
      "auth.baseUrl must be applied to the model passed to provider.stream",
    );
    // auth.baseUrl must NOT appear in stream options (it would be silently
    // ignored by adapters, giving a false sense of security).
    assert.ok(
      !("baseUrl" in (observedStreamOptions ?? {})),
      "auth.baseUrl must NOT appear in stream options",
    );
    assert.deepEqual(
      observedStreamOptions!["env"],
      { ANTHROPIC_CUSTOM: "1" },
      "auth.env must be forwarded to stream options",
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

// ---------------------------------------------------------------------------
// Tests: resetSession — session state cleared across session switch (finding 2 — PR review)
// ---------------------------------------------------------------------------

describe("createHeartbeatController — resetSession", () => {
  it("resetSession clears captured data and idle state before a new gap", async () => {
    const timer = makeTimerFake();
    let streamCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: null,
      streamProvider() {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    });

    ctrl.onProviderRequest({ session: "old" }, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-old", "session-old");

    ctrl.resetSession();

    // Re-arm while idle, but without a new provider request.  The old capture
    // must not be replayed into the new session.
    ctrl.onIdle(true);
    ctrl.startGap("gap-new-no-capture", "session-new");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCalls, 0, "resetSession must clear the prior payload capture");

    ctrl.resetSession();

    // A new capture still must wait for the new session's idle notification;
    // resetSession must not carry the prior idle state across sessions.
    ctrl.onProviderRequest({ session: "new" }, makeModel());
    ctrl.startGap("gap-new-not-idle", "session-new");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamCalls, 0, "resetSession must clear the prior idle state");

    ctrl.destroy();
  });

  it("rejects unusable captures without replaying the previous payload", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const invalidPayloads: Array<{ label: string; payload: unknown }> = [
      { label: "circular payload", payload: circular },
      { label: "undefined payload", payload: undefined },
      { label: "oversized payload", payload: { data: "x".repeat(2 * 1024 * 1024 + 1) } },
      { label: "unusable serialized payload", payload: { toJSON: () => undefined } },
    ];

    for (const { label, payload } of invalidPayloads) {
      const timer = makeTimerFake();
      let streamCalls = 0;
      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: null,
        streamProvider() {
          streamCalls++;
          return makeStream([makeStartEvent(), makeTextStartEvent()]);
        },
      });

      ctrl.onProviderRequest({ valid: true }, makeModel());
      assert.doesNotThrow(
        () => ctrl.onProviderRequest(payload, makeModel()),
        `${label} must be rejected without throwing`,
      );
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "session-invalid");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(streamCalls, 0, `${label} must clear the previous capture`);
      ctrl.destroy();
    }
  });

  it("does not construct a provider stream after auth is cancelled", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let resolveAuth!: (result: { ok: true; apiKey: string }) => void;
    let authRequested = false;
    let streamCalls = 0;
    const authPending = new Promise<{ ok: true; apiKey: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const fakeProvider = {
      stream: () => {
        streamCalls++;
        return makeStream([makeStartEvent(), makeTextStartEvent()]);
      },
    };
    const fakeRegistryObj: unknown = {
      getProvider: () => fakeProvider,
      getApiKeyAndHeaders: async () => {
        authRequested = true;
        return authPending;
      },
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      getModelRegistry: () => fakeRegistryObj as ModelRegistry,
    });

    ctrl.onProviderRequest({ messages: [] }, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-auth-cancel", "session-old");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    assert.equal(authRequested, true, "the beat must reach the pending auth lookup");

    // Session reset aborts the old beat and opens the way for a new session;
    // resolving the old auth lookup must not construct its provider stream.
    ctrl.resetSession();
    ctrl.onIdle(true);
    ctrl.startGap("gap-after-reset", "session-new");
    resolveAuth({ ok: true, apiKey: "test-key" });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(streamCalls, 0, "cancelled auth must not invoke provider.stream");
    const cancelledRecord = sink.records.find((record) => record["outcome"] === "cancelled");
    assert.equal(cancelledRecord?.["sessionId"], "session-old");
    ctrl.destroy();
  });

  it("uses issuing session identity for stream options and cancellation logs", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let observedStreamSessionId: unknown;
    let streamStarted = false;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider(_model, _context, options: StreamOptions) {
        observedStreamSessionId = (options as { sessionId?: string }).sessionId;
        return (async function* () {
          streamStarted = true;
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

    ctrl.onProviderRequest({ messages: [] }, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-identity-old", "session-old");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(streamStarted, true, "the old beat must be in flight");
    assert.equal(observedStreamSessionId, "session-old");

    ctrl.endGap();
    ctrl.startGap("gap-identity-new", "session-new");
    await new Promise((r) => setTimeout(r, 20));

    const cancelledRecord = sink.records.find((record) => record["outcome"] === "cancelled");
    assert.equal(cancelledRecord?.["sessionId"], "session-old");
    assert.equal(cancelledRecord?.["gapId"], "gap-identity-old");
    ctrl.destroy();
  });

  it("resetSession re-enables a breaker-tripped session so startGap works again", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    let streamCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: null,
      ...sink,
      streamProvider() {
        streamCalls++;
        return (async function* () {
          throw new Error("always fails");
          /* eslint-disable no-unreachable */
          yield makeStartEvent();
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-breaker", "sess-1");

    // Trip the error breaker (3 consecutive errors).
    for (let i = 0; i < 3; i++) {
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 50));
    }
    const beforeReset = streamCalls;

    // Verify breaker is tripped: no more stream calls.
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCalls, beforeReset, "session must be disabled after 3 errors");

    // Reset session — should clear the breaker.
    ctrl.resetSession();

    // Now startGap a new session and verify the stream fires again.
    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("g-new", "sess-2");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(
      streamCalls > beforeReset,
      "resetSession must re-enable heartbeat after breaker trip",
    );
    ctrl.destroy();
  });
});
