/**
 * Heartbeat controller stream outcome and accounting tests.
 *
 * Stream, timer, and logger state comes from per-test factories in the shared
 * heartbeat fixture module; this suite owns no mutable global fixtures.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatController } from "../../src/runs/shared/heartbeat-controller.ts";
import { MIN_REARM_DELAY_MS } from "../../src/runs/shared/heartbeat-state.ts";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  BASE_CONFIG,
  makeDoneEvent,
  makeErrorEvent,
  makeLoggerSink,
  makeModel,
  makeStartEvent,
  makeStream,
  makeTextDeltaEvent,
  makeTextStartEvent,
  makeThinkingDeltaEvent,
  makeThinkingStartEvent,
  makeTimerFake,
  makeToolCallDeltaEvent,
  makeToolCallStartEvent,
} from "../support/heartbeat-controller-fixtures.ts";

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
// Tests: early-generation cutoff
// ---------------------------------------------------------------------------

describe("createHeartbeatController — early-generation cutoff", () => {
  it("aborts immediately at a zero-usage content start", async () => {
    const startCases: Array<{ label: string; event: AssistantMessageEvent }> = [
      {
        label: "text_start",
        event: makeTextStartEvent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
      },
      {
        label: "thinking_start",
        event: makeThinkingStartEvent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
      },
      {
        label: "toolcall_start",
        event: makeToolCallStartEvent({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
      },
    ];

    for (const { label, event } of startCases) {
      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const consumed: string[] = [];

      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        streamProvider() {
          return (async function* () {
            consumed.push("start");
            yield makeStartEvent();
            consumed.push(label);
            yield event;
            consumed.push("done");
            yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 0, totalTokens: 6000 });
          })();
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "sess-cutoff");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(consumed, ["start", label], `${label} must be the first cutoff boundary`);
      assert.equal(sink.records[0]?.["outcome"], "generation_cutoff");
      ctrl.destroy();
    }
  });

  it("keeps the normal classifier for cache usage on an empty content start", async () => {
    const startCases: Array<{ label: string; event: AssistantMessageEvent; outcome: string }> = [
      {
        label: "cache-read",
        event: makeTextStartEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0 }),
        outcome: "cache_read",
      },
      {
        label: "cache-write-mismatch",
        event: makeThinkingStartEvent({ input: 1000, cacheRead: 0, cacheWrite: 1024, output: 0 }),
        outcome: "cache_write_mismatch",
      },
    ];

    for (const { label, event, outcome } of startCases) {
      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const consumed: string[] = [];

      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        streamProvider() {
          return (async function* () {
            consumed.push("start");
            yield makeStartEvent();
            consumed.push(label);
            yield event;
            consumed.push("done");
            yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 0, totalTokens: 6000 });
          })();
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "sess-usage");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(consumed, ["start", label]);
      assert.equal(sink.records[0]?.["outcome"], outcome);
      ctrl.destroy();
    }
  });

  it("retains output cost when cache-read usage arrives at an empty block start", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const earlyUsage = {
      input: 1000,
      cacheRead: 5000,
      cacheWrite: 0,
      output: 1,
      totalTokens: 6001,
    };

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        return makeStream([makeStartEvent(), makeTextStartEvent(earlyUsage)]);
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-early-output", "sess-early-output");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(sink.records[0]?.["outcome"], "cache_read");
    assert.deepEqual(sink.records[0]?.["usage"], {
      input: 1000,
      cacheRead: 5000,
      cacheWrite: 0,
      output: 1,
    });
    assert.equal(sink.records[0]?.["estCostUsd"], 0.004515);
    ctrl.destroy();
  });

  it("classifies populated block starts from cache usage without inspecting mutable partial content", async () => {
    const startCases: Array<{ label: string; event: AssistantMessageEvent }> = [
      {
        label: "text_start",
        event: makeTextStartEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0 }),
      },
      {
        label: "thinking_start-redacted",
        event: makeThinkingStartEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0 }),
      },
      {
        label: "toolcall_start-populated",
        event: makeToolCallStartEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0 }),
      },
    ];

    for (const { label, event } of startCases) {
      // The stream protocol exposes a shared partial message. Pin content on
      // that object, including redacted thinking and populated tool arguments,
      // to ensure classification depends on cache evidence rather than its
      // mutable contents.
      switch (event.type) {
        case "text_start":
          event.partial.content[event.contentIndex] = {
            type: "text",
            text: "shared partial text",
          };
          break;
        case "thinking_start":
          event.partial.content[event.contentIndex] = {
            type: "thinking",
            thinking: "[Reasoning redacted]",
            redacted: true,
          };
          break;
        case "toolcall_start":
          event.partial.content[event.contentIndex] = {
            type: "toolCall",
            id: "call-1",
            name: "lookup",
            arguments: { query: "value" },
          };
          break;
      }

      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const accounting: import("../../src/runs/shared/heartbeat-controller.ts").BeatAccounting[] =
        [];
      const consumed: string[] = [];

      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        onBeatAccounting: (value) => accounting.push(value),
        streamProvider() {
          return (async function* () {
            consumed.push("start");
            yield makeStartEvent();
            consumed.push(label);
            yield event;
            consumed.push("done");
            yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 0, totalTokens: 6000 });
          })();
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "sess-populated-start");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(consumed, ["start", label], `${label} must stop at the block start`);
      assert.equal(sink.records[0]?.["outcome"], "cache_read");
      assert.equal(accounting.length, 1, `${label} usage must be published once`);
      assert.equal(accounting[0]!.outcome, "cache_read");
      assert.equal(accounting[0]!.usage.cacheRead, 5000);
      ctrl.destroy();
    }
  });

  it("preserves cache-write mismatch precedence at a cache-bearing block start and closes the gap", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const consumed: string[] = [];
    let streamCalls = 0;

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return (async function* () {
          consumed.push("start");
          yield makeStartEvent();
          consumed.push("text_start");
          // cacheWrite exceeds the mismatch threshold even though cacheRead is
          // positive, so the mismatch outcome must retain precedence.
          yield makeTextStartEvent({
            input: 1000,
            cacheRead: 5000,
            cacheWrite: 1024,
            output: 0,
            totalTokens: 7024,
          });
          consumed.push("done");
          yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 0, totalTokens: 6000 });
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-start-mismatch", "sess-start-mismatch");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(
      consumed,
      ["start", "text_start"],
      "mismatch must terminate at the block start",
    );
    assert.equal(sink.records.length, 1);
    assert.equal(sink.records[0]?.["outcome"], "cache_write_mismatch");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(streamCalls, 1, "cache-write mismatch must close the gap");
    ctrl.destroy();
  });

  it("rejects generated deltas even when cache-read and output usage arrive together", async () => {
    const deltaCases: Array<{ label: string; event: AssistantMessageEvent }> = [
      {
        label: "text_delta",
        event: makeTextDeltaEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 5 }),
      },
      {
        label: "thinking_delta",
        event: makeThinkingDeltaEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 5 }),
      },
      {
        label: "toolcall_delta",
        event: makeToolCallDeltaEvent({ input: 1000, cacheRead: 5000, cacheWrite: 0, output: 5 }),
      },
    ];

    for (const { label, event } of deltaCases) {
      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const consumed: string[] = [];

      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        streamProvider() {
          return (async function* () {
            consumed.push("start");
            yield makeStartEvent();
            consumed.push(label);
            yield event;
            consumed.push("done");
            yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 5, totalTokens: 6005 });
          })();
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "sess-delta");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(consumed, ["start", label]);
      assert.equal(sink.records[0]?.["outcome"], "generation_cutoff");
      ctrl.destroy();
    }
  });

  it("rejects a generated done event instead of classifying final cache usage as a hit", async () => {
    const doneCases: Array<{ label: string; event: AssistantMessageEvent }> = [
      {
        label: "done-output-usage",
        event: makeDoneEvent({
          input: 1000,
          cacheRead: 5000,
          cacheWrite: 0,
          output: 5,
          totalTokens: 6005,
        }),
      },
      {
        label: "done-generated-content",
        event: makeDoneEvent(
          { input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0, totalTokens: 6000 },
          [{ type: "text", text: "generated content" }],
        ),
      },
      {
        label: "done-redacted-thinking",
        event: makeDoneEvent(
          { input: 1000, cacheRead: 5000, cacheWrite: 0, output: 0, totalTokens: 6000 },
          [{ type: "thinking", thinking: "[Reasoning redacted]" }],
        ),
      },
    ];

    for (const { label, event } of doneCases) {
      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const consumed: string[] = [];

      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        streamProvider() {
          return (async function* () {
            consumed.push("start");
            yield makeStartEvent();
            consumed.push(label);
            yield event;
          })();
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${label}`, "sess-done");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));

      assert.deepEqual(consumed, ["start", label]);
      assert.equal(sink.records[0]?.["outcome"], "generation_cutoff");
      ctrl.destroy();
    }
  });

  it("bounds repeated generation cutoffs with the existing error breaker", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const scheduledDelays: number[] = [];
    let streamCalls = 0;
    let finalUsageConsumed = false;
    const config = { ...BASE_CONFIG, maxBeatsPerGap: 10 };

    const ctrl = createHeartbeatController(config, {
      now: timer.now,
      setTimeout(fn, ms) {
        scheduledDelays.push(ms);
        return timer.setTimeout(fn, ms);
      },
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      streamProvider() {
        streamCalls++;
        return (async function* () {
          yield makeStartEvent();
          yield makeTextStartEvent({
            input: 0,
            cacheRead: 0,
            cacheWrite: 0,
            output: 0,
            totalTokens: 0,
          });
          finalUsageConsumed = true;
          yield makeDoneEvent({ input: 1000, cacheRead: 5000, output: 0, totalTokens: 6000 });
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-late-breaker", "sess-late-breaker");

    for (let attempt = 0; attempt < 3; attempt++) {
      timer.advance(attempt === 0 ? config.intervalMs + 1 : MIN_REARM_DELAY_MS);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 30));
    }

    assert.equal(streamCalls, 3, "three generation cutoffs should reach the session breaker");
    assert.equal(finalUsageConsumed, false, "late final usage must never be consumed");
    assert.equal(
      sink.records.filter((record) => record["outcome"] === "generation_cutoff").length,
      3,
    );
    assert.ok(
      scheduledDelays.slice(1).every((delay) => delay >= MIN_REARM_DELAY_MS),
      "generation cutoffs must use positive backoff before the breaker trips",
    );

    timer.advance(config.intervalMs + MIN_REARM_DELAY_MS);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(streamCalls, 3, "the error breaker must stop further generation-cutoff attempts");
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

  it("keeps cache_write_mismatch when iterator cleanup throws", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const beatResults: import("../../src/runs/shared/heartbeat-controller.ts").BeatResult[] = [];

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatResult: (result) => beatResults.push(result),
      streamProvider() {
        const events: AssistantMessageEvent[] = [
          makeStartEvent(),
          makeTextStartEvent({
            input: 100,
            cacheRead: 0,
            cacheWrite: 1024,
            output: 0,
            totalTokens: 1124,
          }),
        ];
        let index = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const event = events[index++];
                if (event) return { done: false, value: event };
                return { done: true, value: undefined };
              },
              return() {
                return Promise.reject(new Error("iterator cleanup failed"));
              },
            };
          },
        };
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-mismatch-cleanup", "sess-mismatch-cleanup");

    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(sink.records.length, 1, "cleanup failure must not duplicate the beat record");
    assert.equal(sink.records[0]?.["outcome"], "cache_write_mismatch");
    assert.equal(beatResults.length, 1);
    assert.equal(beatResults[0]!.outcome, "cache_write_mismatch");
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
      "generation_cutoff",
      "generation before cache usage must produce 'generation_cutoff', not 'cache_read'",
    );
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

  it("reports a failure when gap close races cutoff iterator cleanup", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const beatResults: import("../../src/runs/shared/heartbeat-controller.ts").BeatResult[] = [];
    let markCleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatResult: (result) => beatResults.push(result),
      streamProvider() {
        return (async function* () {
          try {
            yield makeTextStartEvent({ input: 100, cacheRead: 0, output: 5 });
          } finally {
            markCleanupStarted();
            await cleanupRelease;
          }
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-cutoff-race", "sess-cutoff-race");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    await cleanupStarted;
    ctrl.endGap();
    releaseCleanup();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(beatResults.length, 1, "cutoff completion must still report its failure");
    assert.equal(beatResults[0]!.outcome, "generation_cutoff");
    assert.equal(beatResults[0]!.sessionDisabled, false);
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

  it("publishes usage accounting before delayed iterator cleanup and only once", async () => {
    const timer = makeTimerFake();
    const sink = makeLoggerSink();
    const accounting: Array<{
      gapId: string;
      outcome: string;
      usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
      estCostUsd?: number;
    }> = [];
    let beatResultCalls = 0;
    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });

    const ctrl = createHeartbeatController(BASE_CONFIG, {
      now: timer.now,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      logPath: "/fake.jsonl",
      ...sink,
      onBeatAccounting: (value) => accounting.push(value),
      onBeatResult: () => {
        beatResultCalls++;
      },
      streamProvider() {
        return (async function* () {
          try {
            yield makeStartEvent();
            yield makeTextStartEvent({ input: 1000, cacheRead: 5000, output: 10 });
            yield makeDoneEvent();
          } finally {
            // Breaking on the usage-bearing event invokes iterator.return().
            // Hold its cleanup open so the test can inspect accounting before
            // executeBeat reaches completeBeat.
            markCleanupStarted();
            await cleanupRelease;
          }
        })();
      },
    });

    ctrl.onProviderRequest({}, makeModel());
    ctrl.onIdle(true);
    ctrl.startGap("gap-accounting", "sess-accounting");
    timer.advance(BASE_CONFIG.intervalMs + 1);
    timer.firePending();

    await cleanupStarted;
    assert.equal(accounting.length, 1, "usage must be published before iterator cleanup settles");
    assert.equal(accounting[0]!.gapId, "gap-accounting");
    assert.equal(accounting[0]!.outcome, "cache_read");
    assert.equal(accounting[0]!.usage.cacheRead, 5000);
    assert.ok((accounting[0]!.estCostUsd ?? 0) > 0, "known usage must include estimated cost");

    releaseCleanup();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(accounting.length, 1, "normal completion must not account usage twice");
    assert.equal(beatResultCalls, 1, "normal completion still reports one result");
    ctrl.destroy();
  });

  it("publishes observed usage for provider errors and cache-write mismatches", async () => {
    const cases: Array<{
      label: string;
      event: AssistantMessageEvent;
      outcome: "error" | "cache_write_mismatch";
    }> = [
      {
        label: "provider-error",
        event: makeErrorEvent({ input: 100, cacheRead: 5000, output: 1 }),
        outcome: "error",
      },
      {
        label: "cache-write-mismatch",
        event: makeTextStartEvent({ input: 100, cacheRead: 0, cacheWrite: 1024, output: 0 }),
        outcome: "cache_write_mismatch",
      },
    ];

    for (const testCase of cases) {
      const timer = makeTimerFake();
      const sink = makeLoggerSink();
      const accounting: import("../../src/runs/shared/heartbeat-controller.ts").BeatAccounting[] =
        [];
      const ctrl = createHeartbeatController(BASE_CONFIG, {
        now: timer.now,
        setTimeout: timer.setTimeout,
        clearTimeout: timer.clearTimeout,
        logPath: "/fake.jsonl",
        ...sink,
        onBeatAccounting: (value) => accounting.push(value),
        streamProvider() {
          return makeStream([makeStartEvent(), testCase.event]);
        },
      });

      ctrl.onProviderRequest({}, makeModel());
      ctrl.onIdle(true);
      ctrl.startGap(`gap-${testCase.label}`, "sess-accounting");
      timer.advance(BASE_CONFIG.intervalMs + 1);
      timer.firePending();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(accounting.length, 1, `${testCase.label} usage should be accounted once`);
      assert.equal(accounting[0]!.outcome, testCase.outcome);
      assert.ok((accounting[0]!.estCostUsd ?? 0) > 0, `${testCase.label} cost should be known`);
      ctrl.destroy();
    }
  });
});
