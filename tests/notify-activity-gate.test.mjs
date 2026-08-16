/**
 * Tests for notify extension activity-gate behaviour (tickets ts-vy9k, ts-hehb).
 *
 * Covers:
 * - Suppressed while background work is in flight
 * - Notified when nothing is in flight
 * - No duplicate ping when agent_settled fires twice in rapid succession
 * - Normal behaviour (no suppression) when no activity signal is available
 * - Config field suppressWhileActive: work-in-flight cleared before debounce fires → notify
 * - Regression (ts-hehb): final errored settle with retry grace but no background jobs must notify
 * - Regression (ts-hehb): primary-only activity never suppresses notifications
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { createJiti } from "jiti";

// ---------------------------------------------------------------------------
// Hermetic agent-dir isolation
//
// loadConfig reads <getAgentDir()>/extensions/notify.json unconditionally;
// getAgentDir() resolves from PI_CODING_AGENT_DIR. Without isolation the suite
// reads the contributor's real global notify config, so a contributor who has
// set {"enabled": false} (which our CHANGELOG migration instructs) causes every
// assertion expecting a notification to fail.
//
// We point PI_CODING_AGENT_DIR at a fresh temp dir for the entire test run and
// restore the previous value afterward — including on test failure — so we
// never leave the process env in a mutated state.
// ---------------------------------------------------------------------------
const _previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const _testAgentDir = mkdtempSync(join(tmpdir(), "tlh-notify-test-agent-"));
mkdirSync(join(_testAgentDir, "extensions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = _testAgentDir;

after(() => {
  // Restore: delete the key entirely if it was previously unset, rather than
  // setting it to "", which would make getAgentDir() resolve differently.
  if (_previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = _previousAgentDir;
  }
  rmSync(_testAgentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url);
const { createNotifyExtension } = await jiti.import("../extensions/notify/index.ts");
const { TLH_EFFECTIVE_ACTIVITY_EVENT } = await jiti.import(
  "../extensions/shared/tlh-effective-activity.ts",
);

// ---------------------------------------------------------------------------
// Fake timer helpers (same pattern as activity-tracker tests)
// ---------------------------------------------------------------------------

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /**
     * Advance fake clock by `ms` milliseconds.
     * Fires all timers whose deadline is <= new `now`, in order.
     * Returns a Promise so callers can await async timer callbacks.
     */
    async advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at > now) continue;
          timers.delete(id);
          const result = timer.fn();
          if (result && typeof result.then === "function") await result;
          ran = true;
        }
      }
    },
    pendingCount() {
      return timers.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Pi harness factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal pi harness that tracks:
 * - `on(event, handler)` registrations (pi lifecycle events)
 * - `events.on(channel, handler)` registrations (event bus subscriptions)
 *
 * Also exposes helper methods for firing events from tests.
 */
function createPiHarness() {
  const eventHandlers = new Map();
  const channelHandlers = new Map();

  return {
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    events: {
      on(channel, handler) {
        const handlers = channelHandlers.get(channel) ?? [];
        handlers.push(handler);
        channelHandlers.set(channel, handlers);
        return () => {
          channelHandlers.set(
            channel,
            (channelHandlers.get(channel) ?? []).filter((h) => h !== handler),
          );
        };
      },
      emit(_channel, _payload) {},
    },
    /** Fire a pi lifecycle event (e.g. "agent_settled") */
    fireEvent(name, event = {}, ctx = {}) {
      for (const handler of eventHandlers.get(name) ?? []) {
        handler(event, ctx);
      }
    },
    /** Emit on the events bus (simulates the activity tracker publishing) */
    emitChannel(channel, payload) {
      for (const handler of channelHandlers.get(channel) ?? []) {
        handler(payload);
      }
    },
  };
}

/**
 * Minimal extension context.
 * hasUI=true so onlyWhenInteractive check passes.
 * isProjectTrusted returns false so no project-level config is loaded.
 * cwd points to os.tmpdir() so no project notify.json exists.
 */
function makeCtx(overrides = {}) {
  return {
    cwd: process.env.TMPDIR ?? "/tmp",
    hasUI: true,
    isProjectTrusted: () => false,
    // Default: agent is idle (no new turn has started).
    isIdle: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("notify fires when no activity signal has been received (graceful degradation)", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // No TLH_EFFECTIVE_ACTIVITY_EVENT ever emitted → latestInProgress stays undefined.
  // Undefined must NOT be treated as "in flight" (graceful degradation).
  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  assert.equal(notifyCount, 1, "expected exactly one notification when no signal was received");
});

test("notify is suppressed while background work is in flight", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Signal: background work is in flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  assert.equal(notifyCount, 0, "expected no notification while work is in flight");
});

test("no notify when child completion wakes parent and agent is no longer idle when timer fires", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 300,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Initially in-flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // agent_settled fires; 300 ms debounce starts.
  // isIdle: () => false simulates that by the time the timer fires, the
  // parent is mid-turn processing the child's completion result.
  pi.fireEvent("agent_settled", {}, makeCtx({ isIdle: () => false }));

  // 100 ms later: child completes, tracker emits inProgress=false.
  // pi-subagents wakes the parent, starting a new agent turn.
  await timers.advance(100);
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });

  // At 300 ms: timer fires. The agent is NOT idle (isIdle() returns false).
  // Must not notify — the new turn's own agent_settled is responsible.
  await timers.advance(200); // total = 300 ms

  assert.equal(
    notifyCount,
    0,
    "expected no notification when agent is not idle (new turn running)",
  );
});

test("notify fires when child completes without waking parent and agent stays idle", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 300,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Initially in-flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // agent_settled fires; 300 ms debounce starts.
  pi.fireEvent("agent_settled", {}, makeCtx()); // isIdle: () => true (default)

  // 100 ms later: child completes, tracker emits inProgress=false.
  // The child result needed no further parent work, so the agent stays idle.
  await timers.advance(100);
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });

  // At 300 ms: timer fires. Agent IS idle (isIdle() returns true) and
  // inProgress is false → should notify exactly once.
  await timers.advance(200); // total = 300 ms

  assert.equal(
    notifyCount,
    1,
    "expected exactly one notification when agent stays idle after child completes",
  );
});

test("no duplicate ping when agent_settled fires twice in rapid succession", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 100,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // No background work in flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });

  // Two rapid settles (simulating settle → child completes → new settle).
  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(30); // First timer is pending but not yet fired.
  pi.fireEvent("agent_settled", {}, makeCtx()); // Cancels first timer, sets new one.

  // Advance past the second debounce.
  await timers.advance(100);

  assert.equal(notifyCount, 1, "expected exactly one ping despite two rapid settles");
});

test("notify remains suppressed when inProgress stays true through the debounce", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // Multiple settles while still in-flight.
  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);
  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  assert.equal(notifyCount, 0, "expected no notifications while work remains in flight");
});

test("notify works normally when pi.events is absent (no event bus)", async () => {
  const timers = createFakeTimers();
  let notifyCount = 0;

  // Build a pi harness without events support.
  const eventHandlers = new Map();
  const pi = {
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    // No `events` property.
  };

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // No events bus: latestInProgress stays undefined → should notify.
  for (const handler of eventHandlers.get("agent_settled") ?? []) {
    handler({}, makeCtx());
  }
  await timers.advance(50);

  assert.equal(notifyCount, 1, "expected notification even without an events bus");
});

test("pending debounce timer is cancelled and replaced by a new settle", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 100,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });

  pi.fireEvent("agent_settled", {}, makeCtx());
  assert.equal(timers.pendingCount(), 1, "first debounce timer should be pending");

  // Second settle before first fires.
  await timers.advance(50);
  pi.fireEvent("agent_settled", {}, makeCtx());
  assert.equal(timers.pendingCount(), 1, "only one debounce timer should be pending at a time");

  // First timer was cancelled; advance past second.
  await timers.advance(100);
  assert.equal(notifyCount, 1, "only one notification for two settles");
  assert.equal(timers.pendingCount(), 0, "no timers remain after notification");
});

test("session_shutdown clears pending debounce timer", async () => {
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 100,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });
  pi.fireEvent("agent_settled", {}, makeCtx());
  assert.equal(timers.pendingCount(), 1, "timer should be pending before shutdown");

  // Shutdown fires before the debounce timer fires.
  pi.fireEvent("session_shutdown");
  assert.equal(timers.pendingCount(), 0, "timer should be cleared after session_shutdown");

  // Advancing past the original debounce window must produce no notification.
  await timers.advance(200);
  assert.equal(notifyCount, 0, "no notification should fire after session_shutdown");
});

test("session_shutdown unsubscribes from activity event bus", () => {
  const timers = createFakeTimers();
  let unsubscribeCalled = false;

  // Build a pi harness that tracks whether the unsubscribe was called.
  const eventHandlers = new Map();
  const channelHandlers = new Map();
  const pi = {
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
    },
    events: {
      on(channel, handler) {
        const handlers = channelHandlers.get(channel) ?? [];
        handlers.push(handler);
        channelHandlers.set(channel, handlers);
        return () => {
          unsubscribeCalled = true;
        };
      },
      emit() {},
    },
  };

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 100,
    onNotify: () => {},
  });
  ext(pi);

  assert.equal(unsubscribeCalled, false, "unsubscribe should not be called before shutdown");

  for (const handler of eventHandlers.get("session_shutdown") ?? []) {
    handler();
  }

  assert.equal(unsubscribeCalled, true, "unsubscribe should be called on session_shutdown");
});

// ---------------------------------------------------------------------------
// Regression tests (ts-hehb): gate on background work only, not aggregate activity
// ---------------------------------------------------------------------------

test("[ts-hehb] final errored settle with retry grace active and no background jobs must notify", async () => {
  // Scenario: the tracker holds primary:retry-grace (1500 ms) because the last
  // agent turn ended with an error. inProgress is therefore true, but there are
  // NO background subagent jobs (activeAsyncJobIds is empty).
  // The settle-debounce fires at 300 ms, before retry grace expires.
  // Bug (before fix): notify checked `inProgress === true` → returned early → NO notification.
  // Expected (after fix): notify checks activeAsyncJobIds.length → 0 → DOES notify.
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Tracker emits inProgress=true (retry grace), but no background jobs.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: [] });

  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  assert.equal(notifyCount, 1, "expected notification: retry grace alone must not suppress");
});

test("[ts-hehb] primary-only activity never suppresses notifications", async () => {
  // Scenario: the tracker has a primary-agent-loop reason (or any primaryReasons entry)
  // but activeAsyncJobIds is empty. inProgress is true, but no background work.
  // notify must NOT suppress in this case.
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Multiple primary-only payloads with different inProgress values but always
  // empty activeAsyncJobIds. None should suppress.
  for (const inProgress of [true, false, true]) {
    pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress, activeAsyncJobIds: [] });
  }

  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  assert.equal(notifyCount, 1, "expected notification: primary-only activity must never suppress");
});

// ---------------------------------------------------------------------------
// Pending-settle tests (ts-hm76) and double-ping regression (ts-gfzs)
// ---------------------------------------------------------------------------

test("[ts-gfzs] falling edge then parent wake then new settle yields exactly one notification", async () => {
  // Regression: before the fix the activity falling edge sent the pending-settle
  // notification synchronously. On a normal async child completion the tracker
  // emits the falling edge before the completion wakes the parent, so isIdle()
  // is still true at that point. The synchronous send fires once, and then the
  // woken turn's own agent_settled fires again — two notifications for one logical
  // moment, the exact double-ping this feature exists to eliminate.
  //
  // With the fix the falling edge re-arms the existing debounce. before_agent_start
  // fires before the debounce expires, cancels it, and the woken turn's own
  // agent_settled becomes the single notification.
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Background work is in flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // agent_settled fires; debounce starts.
  pi.fireEvent("agent_settled", {}, makeCtx()); // isIdle: () => true

  // Debounce fires — work still in flight → pendingSettle recorded.
  await timers.advance(50);
  assert.equal(notifyCount, 0, "no notification yet — work in flight when debounce fired");

  // Falling edge arrives: tracker detected the dead child.
  // Fix: this re-arms the debounce, does NOT notify synchronously.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });
  assert.equal(
    notifyCount,
    0,
    "no notification immediately after falling edge — debounce re-armed",
  );

  // Parent is woken by the child result before the debounce fires.
  pi.fireEvent("before_agent_start", {});

  // New run's own settle fires and its debounce runs to completion.
  pi.fireEvent("agent_settled", {}, makeCtx());
  await timers.advance(50);

  // Exactly one notification — from the woken turn's own agent_settled.
  assert.equal(notifyCount, 1, "exactly one notification from the woken turn's own agent_settled");
});

test("notify fires once when pending settle emits after work clears while agent stays idle", async () => {
  // Scenario: debounce fires while background work is still in flight → pendingSettle
  // is recorded.  Later the activity tracker (via periodic liveness drain) emits
  // inProgress=false.  Notify must fire exactly once.
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Background work is in flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // agent_settled fires; debounce starts.
  pi.fireEvent("agent_settled", {}, makeCtx()); // isIdle: () => true

  // Debounce fires (50 ms) — work is still in flight → pendingSettle is recorded.
  await timers.advance(50);
  assert.equal(notifyCount, 0, "no notification yet — work in flight when debounce fired");

  // Periodic liveness drain detects dead child and emits falling edge.
  // With the fix the falling edge re-arms the debounce instead of notifying
  // synchronously, so we must advance past the debounce to see the notification.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });
  assert.equal(notifyCount, 0, "not yet — debounce re-armed, must advance timer");

  await timers.advance(50);

  // Must have notified exactly once from the pending-settle path.
  assert.equal(notifyCount, 1, "exactly one notification when work clears and agent stays idle");
});

test("notify stays silent when new agent run starts before pending settle fires", async () => {
  // Scenario: debounce fires while background work is in flight → pendingSettle
  // recorded.  Then before_agent_start fires (child's result woke the parent),
  // clearing the pending settle.  When work eventually clears, no notification
  // must be emitted — the new run's own agent_settled is responsible.
  const timers = createFakeTimers();
  const pi = createPiHarness();
  let notifyCount = 0;

  const ext = createNotifyExtension({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    settleDebounceMs: 50,
    onNotify: () => {
      notifyCount += 1;
    },
  });
  ext(pi);

  // Background work is in flight.
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: true, activeAsyncJobIds: ["run-1"] });

  // agent_settled fires; debounce starts.
  pi.fireEvent("agent_settled", {}, makeCtx()); // isIdle: () => true

  // Debounce fires — work still in flight → pendingSettle recorded.
  await timers.advance(50);
  assert.equal(notifyCount, 0, "no notification yet — work in flight when debounce fired");

  // Child result wakes the parent: a new agent run starts, clearing the pending settle.
  pi.fireEvent("before_agent_start", {});

  // Work now clears (e.g. the periodic drain fires).
  pi.emitChannel(TLH_EFFECTIVE_ACTIVITY_EVENT, { inProgress: false, activeAsyncJobIds: [] });

  // No notification — the pending settle was cleared by before_agent_start.
  assert.equal(notifyCount, 0, "no notification when new agent run started before work cleared");
});
