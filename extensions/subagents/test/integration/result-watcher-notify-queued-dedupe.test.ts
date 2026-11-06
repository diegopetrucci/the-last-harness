// Queued completion dedupe: result files re-primed while the batcher still holds them.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import {
  createResultWatcher,
  type ResultWatcherTimers,
} from "../../src/runs/background/result-watcher.ts";
import { createFakeClock } from "../support/notify-fixtures.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(sessionId: string): SubagentState {
  return {
    baseCwd: "/repo",
    currentSessionId: sessionId,
    asyncJobs: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
  };
}

describe("queued completion dedupe with batching enabled", () => {
  function setup(sessionId: string, sendMessage?: (content: string) => void) {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-queued-"));
    const clock = createFakeClock();
    const watcherTimers: ResultWatcherTimers = {
      setTimeout: (cb: () => void, ms?: number) => clock.api.setTimeout(cb, ms ?? 0),
      clearTimeout: (id) => clock.api.clearTimeout(id as number),
      setInterval(_cb: () => void, _ms?: number) {
        const h = setInterval(() => {}, 999_999_999);
        clearInterval(h);
        return h;
      },
      clearInterval(_id) {},
    };
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const sent: string[] = [];
    const pi = {
      events: {
        on(event: string, handler: (payload: unknown) => void) {
          const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
          handlers.add(handler);
          listeners.set(event, handlers);
          return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
          for (const handler of listeners.get(event) ?? []) handler(data);
        },
      },
      on(_event: string, _handler: (...args: unknown[]) => void) {},
      sendMessage(message: { content?: string }) {
        sendMessage?.(message.content ?? "");
        sent.push(message.content ?? "");
      },
      sendUserMessage(_content: string, _options?: { deliverAs?: string }) {},
    };
    const state = createState(sessionId);
    registerSubagentNotify(pi as never, state, {
      batchConfig: { enabled: true, debounceMs: 100, maxWaitMs: 5000 },
      timers: clock.api,
      now: clock.now,
    });
    const watcher = createResultWatcher(pi, state, resultsDir, 200, { timers: watcherTimers });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const resultPath = path.join(resultsDir, `queued-${unique}.json`);
    fs.writeFileSync(
      resultPath,
      JSON.stringify({
        id: `queued-run-${unique}`,
        agent: "worker",
        success: true,
        state: "complete",
        summary: `queued summary ${unique}`,
        results: [{ agent: "worker", output: `queued output ${unique}`, success: true }],
        sessionId,
        eventId: `queued-eid-${unique}`,
      }),
      "utf-8",
    );
    const prime = async () => {
      watcher.primeExistingResults();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { resultsDir, resultPath, clock, watcher, state, sent, prime, unique };
  }

  it("emits one report when session re-entry re-primes a result still held by the batcher", async () => {
    const t = setup("session-queued-dedupe");
    try {
      await t.prime();
      assert.equal(fs.existsSync(t.resultPath), true, "file survives while batcher holds it");

      t.watcher.clearPendingAcks();
      await t.prime();

      t.clock.advance(100);
      assert.equal(t.sent.length, 1, "exactly one model-visible message");
      assert.doesNotMatch(t.sent[0]!, /\(2\)/, "heading must not report two completions");
      assert.equal(
        t.sent[0]!.split(`queued output ${t.unique}`).length - 1,
        1,
        "report body appears once",
      );
      assert.equal(fs.existsSync(t.resultPath), false, "acknowledged once and cleaned up");

      t.clock.advance(1000);
      assert.equal(t.sent.length, 1, "no late duplicate");
    } finally {
      t.watcher.stopResultWatcher();
      fs.rmSync(t.resultsDir, { recursive: true, force: true });
    }
  });

  it("redelivers the same result after a failed batched send", async () => {
    let shouldThrow = true;
    const t = setup("session-queued-send-fail", () => {
      if (shouldThrow) throw new Error("simulated send failure");
    });
    try {
      await t.prime();
      t.clock.advance(100); // batcher logs and swallows the emit failure
      assert.equal(t.sent.length, 0, "failed send delivered nothing");
      assert.equal(fs.existsSync(t.resultPath), true, "file survives the failed send");

      shouldThrow = false;
      t.watcher.clearPendingAcks();
      await t.prime();
      t.clock.advance(100);

      assert.equal(t.sent.length, 1, "redelivered exactly once");
      assert.match(t.sent[0]!, /Background task completed/);
      assert.equal(fs.existsSync(t.resultPath), false, "acknowledged after redelivery");
    } finally {
      t.watcher.stopResultWatcher();
      fs.rmSync(t.resultsDir, { recursive: true, force: true });
    }
  });

  it("redelivers the same result after its owner batch was dropped on session switch", async () => {
    const t = setup("session-queued-owner-a");
    try {
      await t.prime();
      t.state.currentSessionId = "session-queued-owner-b";
      t.clock.advance(100);
      assert.equal(t.sent.length, 0, "batch dropped for the non-owner session");
      assert.equal(fs.existsSync(t.resultPath), true, "file survives the drop");

      t.state.currentSessionId = "session-queued-owner-a";
      t.watcher.clearPendingAcks();
      await t.prime();
      t.clock.advance(100);

      assert.equal(t.sent.length, 1, "redelivered exactly once");
      assert.equal(fs.existsSync(t.resultPath), false, "acknowledged after redelivery");
    } finally {
      t.watcher.stopResultWatcher();
      fs.rmSync(t.resultsDir, { recursive: true, force: true });
    }
  });
});
