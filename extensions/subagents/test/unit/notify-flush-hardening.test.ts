import assert from "node:assert/strict";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import {
  COMPLETION_DELIVERY,
  type CompletionDeliveryMetadata,
} from "../../src/runs/background/completion-dedupe.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { completionResult, createFakeClock } from "../support/notify-fixtures.ts";

/**
 * Attach COMPLETION_DELIVERY Symbol metadata to an event payload (same helper
 * used in notify.test.ts delivery-hardening tests).
 */
function withDelivery(
  payload: Record<string, unknown>,
  ack: () => void,
  eventId = `test-eid-${Math.random().toString(36).slice(2)}`,
): Record<symbol, unknown> {
  const meta: CompletionDeliveryMetadata = {
    eventId,
    acknowledgeDelivery: ack,
    onAcknowledged: () => {},
  };
  return Object.assign({}, payload, { [COMPLETION_DELIVERY]: meta });
}

describe("registerSubagentNotify flush-hardening (P2)", () => {
  it("P2 flush-catch: non-completion flush failure does not abort the urgent notice", () => {
    // P2 fix: if the held-success flush throws, the failure/pause notice must
    // still be sent.  Previously the finally block re-ran before the notice.
    const testSessionId = `session-flush-catch-${Date.now()}`;
    const fcListeners = new Map<string, Set<(d: unknown) => void>>();
    const fcEvents = {
      on(event: string, h: (d: unknown) => void) {
        const s = fcListeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        fcListeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of fcListeners.get(event) ?? []) h(d);
      },
    };
    let sendCount = 0;
    let successAckCalled = false;
    const sentContents: string[] = [];
    const fcPi = {
      events: fcEvents,
      on(_e: string, _h: (...args: unknown[]) => void) {},
      sendMessage(m: { content?: string }) {
        sendCount++;
        // First send (held success flush) always throws.
        if (sendCount === 1) throw new Error("flush send failure");
        sentContents.push(m.content ?? "");
      },
      sendUserMessage(_c: unknown) {},
    };
    const clock = createFakeClock();
    registerSubagentNotify(
      fcPi as never,
      { currentSessionId: testSessionId },
      {
        batchConfig: { enabled: true, debounceMs: 100, maxWaitMs: 5000 },
        timers: clock.api,
        now: clock.now,
      },
    );
    // Queue a held success for the same owner.
    fcEvents.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(completionResult({ id: "fc-held", sessionId: testSessionId }), () => {
        successAckCalled = true;
      }),
    );
    assert.equal(successAckCalled, false, "ack not yet");
    // Emit a non-completion (failure/pause) — non-completion path flushes held successes first.
    fcEvents.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      withDelivery(
        completionResult({ id: "fc-fail", success: false, sessionId: testSessionId }),
        () => {},
      ),
    );
    // The flush send threw (sendCount 1); urgent notice must still be attempted (sendCount 2).
    assert.equal(sendCount, 2, "urgent notice sent despite flush failure");
    assert.equal(successAckCalled, false, "held-success ack not called (flush threw)");
    assert.equal(sentContents.length, 1, "exactly the urgent notice content was persisted");
    // The urgent notice is a non-completion (failed or paused) result.
    assert.match(
      sentContents[0]!,
      /Background task (failed|paused)/,
      "urgent notice has correct prose",
    );
  });

  it("P2 flush-catch: session_shutdown flush failure does not crash the shutdown handler", () => {
    // P2 fix: a batcher flush failure during session_shutdown must not escape
    // the shutdown handler.  Unacked items retain their files for recovery.
    const testSessionId = `session-shutdown-flush-fail-${Date.now()}`;
    const ssdListeners = new Map<string, Set<(d: unknown) => void>>();
    const ssdEvents = {
      on(event: string, h: (d: unknown) => void) {
        const s = ssdListeners.get(event) ?? new Set<(d: unknown) => void>();
        s.add(h);
        ssdListeners.set(event, s);
        return () => s.delete(h);
      },
      emit(event: string, d: unknown) {
        for (const h of ssdListeners.get(event) ?? []) h(d);
      },
    };
    const lifecycleHandlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
    let sendCount = 0;
    const ssdPi = {
      events: ssdEvents,
      on(event: string, h: (...args: unknown[]) => void) {
        lifecycleHandlers.set(event, h as (event: unknown, ctx?: unknown) => void);
      },
      sendMessage(_m: unknown) {
        sendCount++;
        throw new Error("every flush throws");
      },
      sendUserMessage(_c: unknown) {},
    };
    registerSubagentNotify(
      ssdPi as never,
      { currentSessionId: testSessionId },
      { batchConfig: { enabled: true, debounceMs: 9999, maxWaitMs: 99999 } },
    );
    ssdEvents.emit(
      SUBAGENT_ASYNC_COMPLETE_EVENT,
      completionResult({ id: "ssd-a", sessionId: testSessionId }),
    );
    // session_shutdown must complete without throwing even when flush fails.
    assert.doesNotThrow(() => {
      lifecycleHandlers.get("session_shutdown")?.({});
    }, "session_shutdown must not throw when flush fails");
    assert.equal(sendCount, 1, "flush was attempted");
  });
});
