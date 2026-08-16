import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHerdrActivityReporter, createCmuxActivityReporter } = await jiti.import(
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
    getPendingDelays() {
      return [...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b);
    },
  };
}

function createFakeSocket(path) {
  const socket = new EventEmitter();
  socket.path = path;
  socket.writes = [];
  socket.destroyCalls = 0;
  socket.write = (chunk) => {
    socket.writes.push(chunk);
    return true;
  };
  socket.destroy = () => {
    socket.destroyCalls += 1;
  };
  return socket;
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

test("Herdr reporter no-ops without required env and when official reporter is installed", async () => {
  const calls = [];
  const noopReporter = createHerdrActivityReporter({
    env: {},
    sendRequest: async (request) => {
      calls.push(request);
    },
  });
  noopReporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => "/tmp/s.json", getSessionId: () => "s" },
  });
  noopReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.deepEqual(calls, []);

  const agentDir = mkdtempSync(join(tmpdir(), "tlh-herdr-agent-dir-"));
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// installed by herdr\n");
  const singleWriterCalls = [];
  const singleWriterReporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      PI_CODING_AGENT_DIR: agentDir,
    },
    sendRequest: async (request) => {
      singleWriterCalls.push(request);
    },
  });

  singleWriterReporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => "/tmp/s.json", getSessionId: () => "s" },
  });
  singleWriterReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.deepEqual(singleWriterCalls, []);
});

test("Herdr reporter retries timed out activity socket delivery once", async () => {
  const timers = createFakeTimers();
  const sockets = [];
  const reporter = createHerdrActivityReporter({
    env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
    createSocket: (path) => {
      const socket = createFakeSocket(path);
      sockets.push(socket);
      return socket;
    },
    timers,
    now: timers.now,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.equal(sockets.length, 1);
  assert.deepEqual(timers.getPendingDelays(), [500]);

  sockets[0].emit("connect");
  assert.equal(sockets[0].writes.length, 1);

  timers.advance(499);
  await flushAsyncWork();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].destroyCalls, 0);

  timers.advance(1);
  await flushAsyncWork();
  assert.equal(sockets[0].destroyCalls, 1);
  assert.equal(sockets.length, 2);
  assert.deepEqual(timers.getPendingDelays(), [1500]);

  sockets[1].emit("connect");
  assert.equal(sockets[1].writes.length, 1);
  assert.equal(JSON.parse(sockets[1].writes[0]).method, "pane.report_agent");
  sockets[1].emit("data", Buffer.from("ok"));
  await flushAsyncWork();
  assert.equal(sockets[1].destroyCalls, 1);
  // Heartbeat timer (default 20s) is expected to be pending after first state report; only socket-retry timers (≤2000ms) should be gone.
  assert.deepEqual(
    timers.getPendingDelays().filter((d) => d <= 2000),
    [],
  );
  assert.deepEqual(JSON.parse(sockets[0].writes[0]), JSON.parse(sockets[1].writes[0]));
});

test("Herdr reporter starts heartbeat recovery after exhausted socket retries", async () => {
  const timers = createFakeTimers();
  const sockets = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    createSocket: (path) => {
      const socket = createFakeSocket(path);
      sockets.push(socket);
      return socket;
    },
    timers,
    now: timers.now,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.equal(sockets.length, 1);

  // Exhaust both default socket attempts. The desired state must still start
  // a heartbeat so a later socket availability can recover without a new edge.
  timers.advance(500);
  await flushAsyncWork();
  assert.equal(sockets.length, 2);
  timers.advance(1500);
  await flushAsyncWork();
  assert.deepEqual(timers.getPendingDelays(), [1000]);

  timers.advance(1000);
  await flushAsyncWork();
  assert.equal(sockets.length, 3);
  sockets[2].emit("connect");
  sockets[2].emit("data", Buffer.from("ok"));
  await flushAsyncWork();
  assert.equal(JSON.parse(sockets[2].writes[0]).params.state, "working");
  reporter.dispose();
});

test("Herdr reporter disables heartbeat for numeric zero representations", async () => {
  for (const configuredInterval of ["0", "0.0", " 0 ", "-0"]) {
    const timers = createFakeTimers();
    const calls = [];
    const reporter = createHerdrActivityReporter({
      env: {
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_PANE_ID: "pane-1",
        HERDR_TLH_HEARTBEAT_MS: configuredInterval,
      },
      sendRequest: async (request) => {
        calls.push(request);
      },
      now: timers.now,
      timers,
    });

    reporter.handleSessionStart({
      mode: "tui",
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
    });
    reporter.handleSnapshot({
      inProgress: true,
      primaryReasons: ["primary:agent-loop"],
      activeAsyncJobIds: [],
    });
    await flushAsyncWork();
    assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);
    assert.deepEqual(
      timers.getPendingDelays(),
      [],
      `zero interval ${JSON.stringify(configuredInterval)} must disable heartbeat`,
    );

    timers.advance(60000);
    await flushAsyncWork();
    assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);
    reporter.dispose();
  }
});

test("Herdr reporter falls back to the default heartbeat for unsafe intervals", async () => {
  for (const configuredInterval of [
    "999",
    "-1",
    "invalid",
    "1500garbage",
    "Infinity",
    "2147483648",
  ]) {
    const timers = createFakeTimers();
    const calls = [];
    const reporter = createHerdrActivityReporter({
      env: {
        HERDR_SOCKET_PATH: "/tmp/herdr.sock",
        HERDR_PANE_ID: "pane-1",
        HERDR_TLH_HEARTBEAT_MS: configuredInterval,
      },
      sendRequest: async (request) => {
        calls.push(request);
      },
      now: timers.now,
      timers,
    });

    reporter.handleSessionStart({
      mode: "tui",
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
    });
    reporter.handleSnapshot({
      inProgress: true,
      primaryReasons: ["primary:agent-loop"],
      activeAsyncJobIds: [],
    });
    await flushAsyncWork();
    assert.deepEqual(
      timers.getPendingDelays(),
      [20000],
      `interval ${configuredInterval} must use the default`,
    );

    timers.advance(19999);
    await flushAsyncWork();
    assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);
    timers.advance(1);
    await flushAsyncWork();
    assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 2);
    reporter.dispose();
  }
});

test("Herdr reporter accepts Node's maximum timer interval", async () => {
  const timers = createFakeTimers();
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "2147483647",
    },
    sendRequest: async () => {},
    now: timers.now,
    timers,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.deepEqual(timers.getPendingDelays(), [2147483647]);
  reporter.dispose();
});

test("Herdr reporter does not retry after first activity socket response", async () => {
  const timers = createFakeTimers();
  const sockets = [];
  const reporter = createHerdrActivityReporter({
    env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
    createSocket: (path) => {
      const socket = createFakeSocket(path);
      sockets.push(socket);
      return socket;
    },
    timers,
    now: timers.now,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.equal(sockets.length, 1);
  assert.deepEqual(timers.getPendingDelays(), [500]);

  sockets[0].emit("connect");
  assert.equal(sockets[0].writes.length, 1);
  sockets[0].emit("data", Buffer.from("ok"));
  await flushAsyncWork();
  assert.equal(sockets[0].destroyCalls, 1);
  // Heartbeat timer (default 20s) is expected to be pending after first state report; only socket-retry timers (≤2000ms) should be gone.
  assert.deepEqual(
    timers.getPendingDelays().filter((d) => d <= 2000),
    [],
  );

  timers.advance(5000);
  await flushAsyncWork();
  assert.equal(sockets.length, 1);
  assert.equal(JSON.parse(sockets[0].writes[0]).method, "pane.report_agent");
});

test("Herdr reporter sends monotonic working/idle state with session refs", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1", HERDR_ENV: "1" },
    sendRequest: async (request) => {
      calls.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 25,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getSessionId: () => "session-1" },
  });
  await flushAsyncWork();
  assert.equal(calls[0].method, "pane.report_agent_session");
  assert.equal(calls[0].params.agent_session_path, "/tmp/session.jsonl");

  const workingSnapshot = {
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  };
  reporter.handleSnapshot(workingSnapshot);
  reporter.handleSnapshot(workingSnapshot);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);
  assert.equal(calls.at(-1).params.state, "working");
  assert.equal(calls.at(-1).params.agent_session_path, "/tmp/session.jsonl");

  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(24);
  await flushAsyncWork();
  assert.equal(calls.filter((call) => call.method === "pane.report_agent").length, 1);

  timers.advance(1);
  await flushAsyncWork();
  const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
  assert.deepEqual(
    stateCalls.map((call) => call.params.state),
    ["working", "idle"],
  );
  assert.ok(stateCalls[1].params.seq > stateCalls[0].params.seq);

  reporter.handleSessionShutdown();
  await flushAsyncWork();
  // Shutdown must not emit pane.release_agent; herdr v0.8.0 owns release on process exit.
  assert.ok(
    calls.every((call) => call.method !== "pane.release_agent"),
    "handleSessionShutdown must not emit pane.release_agent",
  );
});

test("Herdr reporter shutdown never emits pane.release_agent", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1", HERDR_ENV: "1" },
    sendRequest: async (request) => {
      calls.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 25,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getSessionId: () => "session-2" },
  });
  await flushAsyncWork();

  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();

  reporter.handleSessionShutdown();
  await flushAsyncWork();

  const releaseCalls = calls.filter((call) => call.method === "pane.release_agent");
  assert.deepEqual(
    releaseCalls,
    [],
    "pane.release_agent must never be emitted by the herdr reporter",
  );

  // queuedReporter.handleSessionShutdown() must still be forwarded (cancels idle debounce).
  // Verify by confirming no spurious idle is sent after shutdown.
  const stateCallsBeforeShutdown = calls.filter((c) => c.method === "pane.report_agent").length;
  timers.advance(1000);
  await flushAsyncWork();
  const stateCallsAfterShutdown = calls.filter((c) => c.method === "pane.report_agent").length;
  assert.equal(
    stateCallsAfterShutdown,
    stateCallsBeforeShutdown,
    "no state sends should occur after shutdown",
  );
});

test("Herdr heartbeat followed by an idle transition preserves final state ordering", async () => {
  const timers = createFakeTimers();
  const deliveries = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: (request) => {
      const deferred = createDeferred();
      deliveries.push({ request, deferred });
      return deferred.promise;
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].request.params.state, "working");
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  // The heartbeat starts before the idle transition and remains in flight.
  timers.advance(1000);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].request.params.state, "working");

  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2, "idle must wait behind the in-flight heartbeat");

  deliveries[1].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[2].request.params.state, "idle");
  assert.ok(deliveries[2].request.params.seq > deliveries[1].request.params.seq);

  deliveries[2].deferred.resolve();
  reporter.dispose();
  await flushAsyncWork();
});

test("queued Herdr transition resolves the latest committed state behind a heartbeat", async () => {
  const timers = createFakeTimers();
  const deliveries = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: (request) => {
      const deferred = createDeferred();
      deliveries.push({ request, deferred });
      return deferred.promise;
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  timers.advance(1000);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].request.params.state, "working");

  // Commit idle behind the in-flight heartbeat, then supersede it with an
  // immediate working transition before the queued real-state task executes.
  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10);
  await flushAsyncWork();
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.equal(deliveries.length, 2, "the transition must remain queued behind the heartbeat");

  deliveries[1].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 3);
  assert.equal(
    deliveries[2].request.params.state,
    "working",
    "the queued transition must not replay stale idle",
  );

  reporter.dispose();
  deliveries[2].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 3);
});

test("Herdr heartbeat does not bypass idle debounce", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (request) => {
      calls.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 2000,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();

  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(1000);
  await flushAsyncWork();

  const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
  assert.deepEqual(
    stateCalls.map((call) => call.params.state),
    ["working", "working"],
    "heartbeat must retain working until idle debounce commits",
  );

  reporter.dispose();
});

test("queued Herdr heartbeat reads idle after a real send settles", async () => {
  const timers = createFakeTimers();
  const deliveries = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: (request) => {
      const deferred = createDeferred();
      deliveries.push({ request, deferred });
      return deferred.promise;
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  // Let an idle real-state send occupy the outbound channel when the heartbeat
  // timer fires. The heartbeat must select idle when it eventually executes.
  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].request.params.state, "idle");
  timers.advance(990);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2, "heartbeat should remain queued behind idle");

  deliveries[1].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 3);
  assert.equal(
    deliveries[2].request.params.state,
    "idle",
    "heartbeat must not replay stale working",
  );
  assert.ok(deliveries[2].request.params.seq > deliveries[1].request.params.seq);

  deliveries[2].deferred.resolve();
  reporter.dispose();
  await flushAsyncWork();
});

test("queued Herdr state is a no-op after shutdown", async () => {
  const timers = createFakeTimers();
  const deliveries = [];
  const reporter = createHerdrActivityReporter({
    env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
    sendRequest: (request) => {
      const deferred = createDeferred();
      deliveries.push({ request, deferred });
      return deferred.promise;
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10);
  await flushAsyncWork();
  reporter.handleSessionShutdown();
  deliveries[0].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 1, "queued snapshot state must not start after shutdown");
  reporter.dispose();
});

test("queued Herdr heartbeat is a no-op after shutdown and snapshots cannot restart it", async () => {
  const timers = createFakeTimers();
  const deliveries = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: (request) => {
      const deferred = createDeferred();
      deliveries.push({ request, deferred });
      return deferred.promise;
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  deliveries[0].deferred.resolve();
  await flushAsyncWork();

  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2);
  timers.advance(990);
  await flushAsyncWork();
  assert.equal(deliveries.length, 2, "heartbeat should be queued behind the idle delivery");

  reporter.handleSessionShutdown();
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  deliveries[1].deferred.resolve();
  await flushAsyncWork();
  assert.equal(deliveries.length, 2, "queued heartbeat and post-shutdown snapshot must not send");
  reporter.dispose();
});

test("Herdr reporter heartbeat re-sends last state with strictly increasing seq", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (request) => {
      calls.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });

  // No heartbeat fires before the first real state report.
  timers.advance(200);
  await flushAsyncWork();
  const preStateReportCalls = calls.filter((c) => c.method === "pane.report_agent");
  assert.equal(
    preStateReportCalls.length,
    0,
    "heartbeat must not fire before the first state report",
  );

  // Trigger the first real working report.
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  const afterFirstReport = calls.filter((c) => c.method === "pane.report_agent");
  assert.equal(afterFirstReport.length, 1);
  assert.equal(afterFirstReport[0].params.state, "working");
  const firstSeq = afterFirstReport[0].params.seq;

  // Advance past the heartbeat interval — one heartbeat should fire.
  timers.advance(1000);
  await flushAsyncWork();
  const afterFirstHeartbeat = calls.filter((c) => c.method === "pane.report_agent");
  assert.equal(afterFirstHeartbeat.length, 2, "one heartbeat should have fired");
  assert.equal(afterFirstHeartbeat[1].params.state, "working", "heartbeat re-sends last state");
  assert.ok(
    afterFirstHeartbeat[1].params.seq > firstSeq,
    "heartbeat seq must be strictly greater than first report seq",
  );

  // Advance another interval — another heartbeat fires.
  timers.advance(1000);
  await flushAsyncWork();
  const afterSecondHeartbeat = calls.filter((c) => c.method === "pane.report_agent");
  assert.equal(afterSecondHeartbeat.length, 3, "second heartbeat should fire");
  assert.ok(
    afterSecondHeartbeat[2].params.seq > afterSecondHeartbeat[1].params.seq,
    "second heartbeat seq must be strictly greater",
  );

  // Switch to idle — heartbeat should re-send idle.
  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(10); // debounce
  await flushAsyncWork();
  const idleReport = calls.filter((c) => c.method === "pane.report_agent").at(-1);
  assert.equal(idleReport.params.state, "idle");
  timers.advance(1000);
  await flushAsyncWork();
  const afterIdleHeartbeat = calls.filter((c) => c.method === "pane.report_agent").at(-1);
  assert.equal(afterIdleHeartbeat.params.state, "idle", "heartbeat re-sends idle state");

  reporter.dispose();
});

test("Herdr reporter heartbeat stops on handleSessionShutdown and dispose", async () => {
  const timers = createFakeTimers();
  const calls = [];

  // Test shutdown.
  const shutdownReporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (request) => {
      calls.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });
  shutdownReporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  shutdownReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  const countBeforeShutdown = calls.filter((c) => c.method === "pane.report_agent").length;
  shutdownReporter.handleSessionShutdown();
  timers.advance(5000);
  await flushAsyncWork();
  const countAfterShutdown = calls.filter((c) => c.method === "pane.report_agent").length;
  assert.equal(
    countAfterShutdown,
    countBeforeShutdown,
    "heartbeat must not fire after handleSessionShutdown",
  );

  // Test dispose.
  const calls2 = [];
  const disposeReporter = createHerdrActivityReporter({
    env: {
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      HERDR_TLH_HEARTBEAT_MS: "1000",
    },
    sendRequest: async (request) => {
      calls2.push(request);
    },
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });
  disposeReporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  });
  disposeReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  const countBeforeDispose = calls2.filter((c) => c.method === "pane.report_agent").length;
  disposeReporter.dispose();
  timers.advance(5000);
  await flushAsyncWork();
  const countAfterDispose = calls2.filter((c) => c.method === "pane.report_agent").length;
  assert.equal(countAfterDispose, countBeforeDispose, "heartbeat must not fire after dispose");
});

test("cmux reporter uses per-surface status keys and status-only commands", async () => {
  const timers = createFakeTimers();
  const commands = [];
  const reporter = createCmuxActivityReporter({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "pane 1:/left", CMUX_BIN: "cmux" },
    runner: async (command, args) => {
      commands.push({ command, args: [...args] });
    },
    timers,
    idleDebounceMs: 25,
  });

  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session-1" },
  });
  reporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-1"] });
  reporter.handleSnapshot({ inProgress: true, primaryReasons: [], activeAsyncJobIds: ["job-1"] });
  await flushAsyncWork();
  assert.deepEqual(commands, [
    { command: "cmux", args: ["set-status", "tlh-pane-1-left", "working"] },
  ]);

  reporter.handleSnapshot({ inProgress: false, primaryReasons: [], activeAsyncJobIds: [] });
  timers.advance(25);
  await flushAsyncWork();
  assert.deepEqual(commands.at(-1), { command: "cmux", args: ["clear-status", "tlh-pane-1-left"] });
  assert.equal(
    commands.some(
      ({ args }) =>
        args.includes("hooks") || args.includes("prompt-submit") || args.includes("stop"),
    ),
    false,
  );

  reporter.handleSessionShutdown();
  await flushAsyncWork();
  assert.deepEqual(commands.at(-1), { command: "cmux", args: ["clear-status", "tlh-pane-1-left"] });
});

test("cmux reporter falls back to session id then global key", async () => {
  const sessionCommands = [];
  const sessionReporter = createCmuxActivityReporter({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_BIN: "cmux" },
    runner: async (command, args) => {
      sessionCommands.push({ command, args: [...args] });
    },
  });
  sessionReporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session:/two pane" },
  });
  sessionReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: [],
    activeAsyncJobIds: ["job-1"],
  });
  await flushAsyncWork();
  assert.deepEqual(sessionCommands, [
    { command: "cmux", args: ["set-status", "tlh-session-two-pane", "working"] },
  ]);

  const fallbackCommands = [];
  const fallbackReporter = createCmuxActivityReporter({
    env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "///", CMUX_BIN: "cmux" },
    runner: async (command, args) => {
      fallbackCommands.push({ command, args: [...args] });
    },
  });
  fallbackReporter.handleSessionStart({
    mode: "tui",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => {
        throw new Error("missing session");
      },
    },
  });
  fallbackReporter.handleSnapshot({
    inProgress: true,
    primaryReasons: [],
    activeAsyncJobIds: ["job-2"],
  });
  await flushAsyncWork();
  assert.deepEqual(fallbackCommands, [{ command: "cmux", args: ["set-status", "tlh", "working"] }]);
});

test("cmux reporter no-ops without workspace env", async () => {
  const commands = [];
  const reporter = createCmuxActivityReporter({
    env: {},
    runner: async (command, args) => {
      commands.push({ command, args: [...args] });
    },
  });
  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.deepEqual(commands, []);
});

test("reporters no-op for non-TUI modes even when hasUI would be true (json, rpc, print)", async () => {
  const sessionManager = { getSessionFile: () => "/tmp/s.jsonl", getSessionId: () => "s" };

  for (const mode of ["json", "rpc", "print"]) {
    const herdrCalls = [];
    const herdrReporter = createHerdrActivityReporter({
      env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" },
      sendRequest: async (request) => {
        herdrCalls.push(request);
      },
    });
    herdrReporter.handleSessionStart({ mode, sessionManager });
    herdrReporter.handleSnapshot({
      inProgress: true,
      primaryReasons: ["primary:agent-loop"],
      activeAsyncJobIds: [],
    });
    await flushAsyncWork();
    assert.deepEqual(herdrCalls, [], `herdr reporter should not send for mode=${mode}`);
    herdrReporter.handleSessionShutdown();
    await flushAsyncWork();
    assert.deepEqual(herdrCalls, [], `herdr reporter should not release_agent for mode=${mode}`);

    const cmuxCommands = [];
    const cmuxReporter = createCmuxActivityReporter({
      env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_BIN: "cmux" },
      runner: async (command, args) => {
        cmuxCommands.push({ command, args: [...args] });
      },
    });
    cmuxReporter.handleSessionStart({ mode, sessionManager });
    cmuxReporter.handleSnapshot({
      inProgress: true,
      primaryReasons: ["primary:agent-loop"],
      activeAsyncJobIds: [],
    });
    await flushAsyncWork();
    assert.deepEqual(cmuxCommands, [], `cmux reporter should not send for mode=${mode}`);
    cmuxReporter.handleSessionShutdown();
    await flushAsyncWork();
    assert.deepEqual(cmuxCommands, [], `cmux reporter should not clear-status for mode=${mode}`);
  }
});
