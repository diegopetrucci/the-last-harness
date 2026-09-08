/**
 * Heartbeat controller registry integration and session reset tests.
 *
 * Stream, timer, and logger state comes from per-test factories in the shared
 * heartbeat fixture module; this suite owns no mutable global fixtures.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeartbeatController } from "../../src/runs/shared/heartbeat-controller.ts";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  BASE_CONFIG,
  makeLoggerSink,
  makeModel,
  makeStartEvent,
  makeStream,
  makeTextStartEvent,
  makeTimerFake,
} from "../support/heartbeat-controller-fixtures.ts";

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
