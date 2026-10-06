/**
 * Tests for session-name / title propagation in Herdr pane metadata.
 * Covers: named, unnamed/clear_title, rename via handleSessionInfoChanged,
 * rename during in-flight send, heartbeat resend with current title,
 * /new-style session_start without name clearing, and non-TUI/disposed gates.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHerdrActivityReporter, registerTlhActivityReporters } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay, delay });
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      timers.delete(handle.id ?? handle);
    },
    advance(ms) {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at > now) continue;
          timers.delete(id);
          timer.fn();
          ran = true;
        }
      }
    },
  };
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseEnv() {
  return {
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_PANE_ID: "pane-1",
    HERDR_TLH_HEARTBEAT_MS: "0", // disable heartbeat unless test opts in
  };
}

function metadataCalls(calls) {
  return calls.filter((c) => c.method === "pane.report_metadata");
}

// ─── named session ───────────────────────────────────────────────────────────

test("named session sends title in metadata on session_start", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "My Project",
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 1);
  assert.equal(mCalls[0].params.title, "My Project");
  assert.equal("clear_title" in mCalls[0].params, false);
  assert.equal(mCalls[0].params.display_agent, "tlh");
  assert.equal(mCalls[0].params.agent, "pi");
  assert.equal(mCalls[0].params.applies_to_source, "herdr:tlh");
  reporter.dispose();
});

// ─── unnamed session ──────────────────────────────────────────────────────────

test("unnamed session sends clear_title in metadata on session_start", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => undefined,
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 1);
  assert.equal(mCalls[0].params.clear_title, true);
  assert.equal("title" in mCalls[0].params, false);
  reporter.dispose();
});

test("blank session name is treated as unnamed (sends clear_title)", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "   ",
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 1);
  assert.equal(mCalls[0].params.clear_title, true);
  assert.equal("title" in mCalls[0].params, false);
  reporter.dispose();
});

test("getSessionName throwing is treated as unnamed (sends clear_title)", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => {
        throw new Error("not available");
      },
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 1);
  assert.equal(mCalls[0].params.clear_title, true);
  reporter.dispose();
});

// ─── title and clear_title never both sent ─────────────────────────────────

test("metadata params never include both title and clear_title", async () => {
  for (const name of ["Named Session", undefined, "", "  "]) {
    const calls = [];
    const reporter = createHerdrActivityReporter({
      env: baseEnv(),
      sendRequest: async (req) => calls.push(req),
    });
    reporter.handleSessionStart({
      mode: "tui",
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
        getSessionName: () => name,
      },
    });
    await flushAsyncWork();
    for (const call of metadataCalls(calls)) {
      assert.ok(
        !("title" in call.params && "clear_title" in call.params),
        `title and clear_title must not both be set (name=${JSON.stringify(name)})`,
      );
    }
    reporter.dispose();
  }
});

// ─── rename via handleSessionInfoChanged ─────────────────────────────────────

test("handleSessionInfoChanged sends updated title immediately", async () => {
  const calls = [];
  let sessionName = undefined;
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, 1);
  assert.equal(metadataCalls(calls)[0].params.clear_title, true);

  // Rename the session
  sessionName = "Renamed Session";
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 2);
  assert.equal(mCalls[1].params.title, "Renamed Session");
  assert.equal("clear_title" in mCalls[1].params, false);
  reporter.dispose();
});

test("handleSessionInfoChanged with same name does not trigger resend", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Stable Name",
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, 1);

  // Same name — should not trigger a resend
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Stable Name",
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, 1, "no resend for identical name");
  reporter.dispose();
});

test("session_info_changed rename to unnamed sends clear_title", async () => {
  const calls = [];
  let sessionName = "Initial Name";
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls)[0].params.title, "Initial Name");

  sessionName = undefined;
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  assert.equal(mCalls.length, 2);
  assert.equal(mCalls[1].params.clear_title, true);
  assert.equal("title" in mCalls[1].params, false);
  reporter.dispose();
});

// ─── rename during in-flight send ─────────────────────────────────────────

test("rename during in-flight metadata send results in latest name after in-flight settles", async () => {
  const deliveries = [];

  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: (req) => {
      if (req.method !== "pane.report_metadata") return Promise.resolve();
      const deferred = createDeferred();
      deliveries.push({ req, deferred });
      return deferred.promise;
    },
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "First Name",
    },
  });
  await flushAsyncWork();

  // First in-flight send for "First Name" is pending
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].req.params.title, "First Name");

  // Rename while in flight — should mark dirty
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Second Name",
    },
  });
  await flushAsyncWork();

  // Only one in-flight send; the rename has not triggered a new send yet
  assert.equal(deliveries.length, 1, "no new send while first is in flight");

  // Settle the first send
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  // After the in-flight settles, the dirty flag should trigger a follow-up
  assert.equal(deliveries.length, 2, "resend after in-flight settles");
  assert.equal(deliveries[1].req.params.title, "Second Name");
  assert.equal("clear_title" in deliveries[1].req.params, false);

  deliveries[1].deferred.resolve();
  reporter.dispose();
});

test("multiple renames during in-flight only send the latest name once it settles", async () => {
  const deliveries = [];

  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: (req) => {
      if (req.method !== "pane.report_metadata") return Promise.resolve();
      const deferred = createDeferred();
      deliveries.push({ req, deferred });
      return deferred.promise;
    },
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Alpha",
    },
  });
  await flushAsyncWork();

  assert.equal(deliveries.length, 1);

  // Two renames while in flight — only last one should be sent
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Beta",
    },
  });
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Gamma",
    },
  });
  await flushAsyncWork();

  assert.equal(deliveries.length, 1, "still only one in-flight");

  // Settle the first
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  // Should resend once with "Gamma"
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].req.params.title, "Gamma");

  deliveries[1].deferred.resolve();
  reporter.dispose();
});

// ─── heartbeat resend includes current title ──────────────────────────────

test("heartbeat resend includes current title", async () => {
  const timers = createFakeTimers();
  const calls = [];

  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (req) => calls.push(req),
    now: timers.now,
    timers,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Heartbeat Session",
    },
  });
  await flushAsyncWork();

  const mCallsBefore = metadataCalls(calls);
  assert.equal(mCallsBefore.length, 1);
  assert.equal(mCallsBefore[0].params.title, "Heartbeat Session");

  // Trigger a working snapshot to start the heartbeat
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();

  // Advance to fire the heartbeat
  timers.advance(1000);
  await flushAsyncWork();

  const mCallsAfter = metadataCalls(calls);
  assert.equal(mCallsAfter.length, 2, "heartbeat should resend metadata");
  assert.equal(mCallsAfter[1].params.title, "Heartbeat Session");
  reporter.dispose();
});

test("heartbeat after rename sends updated title", async () => {
  const timers = createFakeTimers();
  const calls = [];
  let sessionName = "Old Name";

  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (req) => calls.push(req),
    now: timers.now,
    timers,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();

  // Rename
  sessionName = "New Name";
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  });
  await flushAsyncWork();

  // Advance to fire heartbeat
  timers.advance(1000);
  await flushAsyncWork();

  const mCalls = metadataCalls(calls);
  // initial + rename + heartbeat = 3
  assert.ok(mCalls.length >= 3, `expected >=3 metadata sends, got ${mCalls.length}`);
  assert.equal(mCalls.at(-1).params.title, "New Name");
  reporter.dispose();
});

// ─── /new-style session_start (session_info_changed type path) ─────────────

test("session_info_changed does not send if reporter is not root TUI session", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  // Never call handleSessionStart → not a root session
  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Should Not Send",
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, 0, "no metadata from non-root session");
  reporter.dispose();
});

test("session_info_changed does not send after handleSessionShutdown", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => undefined,
    },
  });
  await flushAsyncWork();
  reporter.handleSessionShutdown();
  const countAfterShutdown = metadataCalls(calls).length;

  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Post-Shutdown",
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, countAfterShutdown, "no metadata after shutdown");
  reporter.dispose();
});

// ─── non-TUI mode ────────────────────────────────────────────────────────────

test("non-TUI session sends no metadata", async () => {
  for (const mode of ["json", "rpc", "print"]) {
    const calls = [];
    const reporter = createHerdrActivityReporter({
      env: baseEnv(),
      sendRequest: async (req) => calls.push(req),
    });

    reporter.handleSessionStart({
      mode,
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
        getSessionName: () => "Session Name",
      },
    });
    await flushAsyncWork();
    assert.equal(metadataCalls(calls).length, 0, `no metadata for mode=${mode}`);

    reporter.handleSessionInfoChanged({
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
        getSessionName: () => "Session Name",
      },
    });
    await flushAsyncWork();
    assert.equal(metadataCalls(calls).length, 0, `no metadata after info_changed for mode=${mode}`);
    reporter.dispose();
  }
});

// ─── disposed reporter ────────────────────────────────────────────────────────

test("disposed reporter sends no metadata via handleSessionInfoChanged", async () => {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: async (req) => calls.push(req),
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Before Dispose",
    },
  });
  await flushAsyncWork();
  reporter.dispose();
  const countAfterDispose = metadataCalls(calls).length;

  reporter.handleSessionInfoChanged({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "After Dispose",
    },
  });
  await flushAsyncWork();
  assert.equal(metadataCalls(calls).length, countAfterDispose, "no metadata after dispose");
});

// ─── registerTlhActivityReporters wires session_info_changed ─────────────────

test("registerTlhActivityReporters wires session_info_changed to reporter", async () => {
  const calls = [];
  const pi = new EventEmitter();
  pi.on = (event, handler) => {
    EventEmitter.prototype.on.call(pi, event, handler);
    return () => pi.removeListener(event, handler);
  };

  let sessionName = "Initial";
  const fakeTracker = {
    subscribe: (_fn) => {
      return () => {};
    },
    getSnapshot: () => ({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] }),
  };

  registerTlhActivityReporters(pi, fakeTracker, {
    herdr: {
      env: baseEnv(),
      sendRequest: async (req) => calls.push(req),
    },
  });

  const ctx = {
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => sessionName,
    },
  };

  pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await flushAsyncWork();

  const mAfterStart = metadataCalls(calls);
  assert.equal(mAfterStart.length, 1);
  assert.equal(mAfterStart[0].params.title, "Initial");

  // Trigger a rename via session_info_changed
  sessionName = "Renamed";
  pi.emit("session_info_changed", { type: "session_info_changed", name: "Renamed" }, ctx);
  await flushAsyncWork();

  const mAfterRename = metadataCalls(calls);
  assert.equal(mAfterRename.length, 2);
  assert.equal(mAfterRename[1].params.title, "Renamed");

  pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  await flushAsyncWork();
});

// ─── handleSessionShutdown → handleSessionStart while metadata in flight ──────

test("handleSessionShutdown then handleSessionStart while metadata in flight sends new session title after in-flight settles", async () => {
  const deliveries = [];

  const reporter = createHerdrActivityReporter({
    env: baseEnv(),
    sendRequest: (req) => {
      if (req.method !== "pane.report_metadata") return Promise.resolve();
      const deferred = createDeferred();
      deliveries.push({ req, deferred });
      return deferred.promise;
    },
  });

  // Start a named session; its metadata send is held in flight.
  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => "Old",
    },
  });
  await flushAsyncWork();

  // Exactly one in-flight metadata send for "Old".
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].req.params.title, "Old");

  // Shutdown the session (clears pending/dirty, but in-flight stays active).
  reporter.handleSessionShutdown();

  // Immediately restart with an unnamed context while the send is still in flight.
  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => undefined,
    },
  });
  await flushAsyncWork();

  // No additional send yet — the original is still in flight.
  assert.equal(deliveries.length, 1, "no new send while original is in flight");

  // Release the held send.
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  // After the in-flight settles, dirty flag causes a follow-up with clear_title.
  assert.equal(deliveries.length, 2, "follow-up send after in-flight settles");
  assert.equal(deliveries[1].req.params.clear_title, true, "new session has clear_title");
  assert.equal("title" in deliveries[1].req.params, false, "no title for unnamed session");

  deliveries[1].deferred.resolve();
  reporter.dispose();
});
