import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createTlhEffectiveActivityTracker,
  registerTlhEffectiveActivityTracker,
  TLH_EFFECTIVE_ACTIVITY_EVENT,
} = await jiti.import("../extensions/the-last-harness/activity-tracker.ts");

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
    pendingCount() {
      return timers.size;
    },
  };
}

test("tracker keeps primary activity busy through retry grace and compaction retry", () => {
  const timers = createFakeTimers();
  const tracker = createTlhEffectiveActivityTracker({
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    retryGraceMs: 25,
  });

  tracker.handleBeforeAgentStart();
  assert.equal(tracker.isInProgress(), true);
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:pending-start"]);

  tracker.handleAgentStart();
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:agent-loop"]);

  tracker.handleAgentEnd({
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }],
  });
  assert.equal(tracker.isInProgress(), true);
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

  tracker.handleSessionBeforeCompact({ reason: "overflow", willRetry: true });
  assert.deepEqual(tracker.getSnapshot().primaryReasons.sort(), ["primary:compaction:overflow"]);

  tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

  tracker.handleTurnStart();
  assert.deepEqual(tracker.getSnapshot().primaryReasons, []);

  tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
  assert.equal(tracker.isInProgress(), true);
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

  timers.advance(24);
  assert.equal(tracker.isInProgress(), true);
  timers.advance(1);
  assert.equal(tracker.isInProgress(), false);
});

test("tracker treats duplicate retry-grace scheduling for the same key as idempotent", () => {
  const timers = createFakeTimers();
  const tracker = createTlhEffectiveActivityTracker({
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    retryGraceMs: 25,
  });

  tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
  tracker.handleAgentEnd({
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "duplicate" }],
  });
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

  timers.advance(25);
  assert.equal(tracker.isInProgress(), false);

  tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
  tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);

  timers.advance(25);
  assert.equal(tracker.isInProgress(), false);
});

test("tracker clears retry grace after concurrent distinct grace keys expire", () => {
  const timers = createFakeTimers();
  const tracker = createTlhEffectiveActivityTracker({
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    retryGraceMs: 25,
  });

  tracker.handleSessionCompact({ reason: "overflow", willRetry: true });
  tracker.handleAgentEnd({
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "retry me" }],
  });
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);
  assert.equal(tracker.isInProgress(), true);

  timers.advance(24);
  assert.deepEqual(tracker.getSnapshot().primaryReasons, ["primary:retry-grace"]);
  assert.equal(tracker.isInProgress(), true);

  timers.advance(1);
  assert.deepEqual(tracker.getSnapshot().primaryReasons, []);
  assert.equal(tracker.isInProgress(), false);
});

test("tracker keeps concurrent async jobs active across duplicate, out-of-order, and shutdown events", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-concurrent-async-"));
  try {
    const timers = createFakeTimers();
    // Set up real asyncDir entries so the liveness drain can verify the jobs.
    const asyncDir1 = makeAsyncDir(root, "job-1", { runId: "job-1", state: "running", pid: 99990 });
    const asyncDir2 = makeAsyncDir(root, "job-2", { runId: "job-2", state: "running", pid: 99991 });
    const tracker = createTlhEffectiveActivityTracker({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      checkPidLiveness: () => "alive",
    });

    tracker.handleAsyncStarted({ id: "job-1", asyncDir: asyncDir1 });
    tracker.handleAsyncStarted({ id: "job-1", asyncDir: asyncDir1 }); // duplicate — idempotent
    tracker.handleAsyncControl({
      event: { runId: "job-2", mode: "background" },
      asyncDir: asyncDir2,
    });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-1", "job-2"]);
    assert.equal(tracker.isInProgress(), true);

    tracker.handleAsyncComplete({ id: "job-1" });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-2"]);
    assert.equal(tracker.isInProgress(), true);

    tracker.handleAsyncComplete({ runId: "job-2" });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
    assert.equal(tracker.isInProgress(), false);

    // Late restart of already-completed job must be suppressed by tombstone.
    tracker.handleAsyncStarted({ id: "job-2", asyncDir: asyncDir2 });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);

    tracker.handleAsyncComplete({ id: "job-missing" });
    assert.equal(tracker.isInProgress(), false);

    tracker.dispose();
    assert.deepEqual(tracker.getSnapshot(), {
      inProgress: false,
      primaryReasons: [],
      activeAsyncJobIds: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracker ignores foreground control notices and only tracks safe async control contexts", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-control-context-"));
  try {
    const asyncDirBackground = makeAsyncDir(root, "job-background", {
      runId: "job-background",
      state: "running",
      pid: 99980,
    });
    const asyncDirAsync = makeAsyncDir(root, "job-async", {
      runId: "job-async",
      state: "running",
      pid: 99981,
    });
    const tracker = createTlhEffectiveActivityTracker({
      checkPidLiveness: () => "alive",
    });

    tracker.handleAsyncControl({ event: { runId: "foreground-source", source: "foreground" } });
    tracker.handleAsyncControl({ event: { runId: "foreground-mode", mode: "foreground" } });
    tracker.handleAsyncControl({ event: { runId: "missing-context" } });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);

    tracker.handleAsyncControl({
      event: { runId: "job-background", mode: "background" },
      asyncDir: asyncDirBackground,
    });
    tracker.handleAsyncControl({
      event: { runId: "job-async", mode: "async" },
      asyncDir: asyncDirAsync,
    });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-async", "job-background"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracker rehydrates only matching running async jobs and ignores malformed artifacts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "tlh-activity-tracker-"));
  const asyncDir = join(tempDir, "async-subagent-runs");
  mkdirSync(asyncDir, { recursive: true });
  const writeStatus = (dirName, status) => {
    const dir = join(asyncDir, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  };

  try {
    // run-1: the only job that should be rehydrated. Includes pid so the drain can
    // verify it is alive via the injected checkPidLiveness.
    writeStatus("run-1", {
      runId: "run-1",
      state: "running",
      pid: 12300,
      cwd: "/repo",
      sessionId: "session-1",
      mode: "single",
      startedAt: 1,
    });
    // run-2: wrong cwd, excluded by rehydrate filter.
    writeStatus("run-2", {
      runId: "run-2",
      state: "running",
      pid: 12301,
      cwd: "/elsewhere",
      sessionId: "session-1",
      mode: "single",
      startedAt: 1,
    });
    // run-3: wrong sessionId, excluded by rehydrate filter.
    writeStatus("run-3", {
      runId: "run-3",
      state: "running",
      pid: 12302,
      cwd: "/repo",
      sessionId: "session-2",
      mode: "single",
      startedAt: 1,
    });
    // run-4: terminal state, excluded by readRunningAsyncJob filter.
    writeStatus("run-4", {
      runId: "run-4",
      state: "complete",
      pid: 12303,
      cwd: "/repo",
      sessionId: "session-1",
      mode: "single",
      startedAt: 1,
    });
    mkdirSync(join(asyncDir, "bad-json"), { recursive: true });
    writeFileSync(join(asyncDir, "bad-json", "status.json"), "{not json\n");

    // Inject a checkPidLiveness that says all pids are alive so the drain does
    // not interfere with the rehydrate filtering being tested here.
    const tracker = createTlhEffectiveActivityTracker({
      asyncDir,
      checkPidLiveness: () => "alive",
    });
    tracker.rehydrateFromArtifacts({
      cwd: "/repo",
      sessionManager: { getSessionId: () => "session-1" },
    });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["run-1"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tracker notifies snapshot listeners only when effective state changes", () => {
  const timers = createFakeTimers();
  const tracker = createTlhEffectiveActivityTracker({
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    retryGraceMs: 25,
  });
  const snapshots = [];
  const unsubscribe = tracker.subscribe((snapshot) => snapshots.push(snapshot));

  tracker.handleBeforeAgentStart();
  tracker.handleBeforeAgentStart();
  tracker.handleAgentStart();
  tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
  timers.advance(25);
  unsubscribe();
  tracker.handleAsyncStarted({ id: "job-1" });

  assert.deepEqual(snapshots, [
    { inProgress: true, primaryReasons: ["primary:pending-start"], activeAsyncJobIds: [] },
    {
      inProgress: true,
      primaryReasons: ["primary:agent-loop", "primary:pending-start"],
      activeAsyncJobIds: [],
    },
    { inProgress: true, primaryReasons: ["primary:retry-grace"], activeAsyncJobIds: [] },
    { inProgress: false, primaryReasons: [], activeAsyncJobIds: [] },
  ]);
});

test("registered tracker listens to pi events and cleans up on session shutdown", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-pi-events-"));
  try {
    const eventHandlers = new Map();
    const channelHandlers = new Map();
    const pi = {
      on(event, handler) {
        eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
      },
      events: {
        on(channel, handler) {
          channelHandlers.set(channel, [...(channelHandlers.get(channel) ?? []), handler]);
          return () => {
            channelHandlers.set(
              channel,
              (channelHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
            );
          };
        },
      },
    };
    const tracker = registerTlhEffectiveActivityTracker(pi);
    const fireEvent = (name, event = {}, ctx = undefined) => {
      for (const handler of eventHandlers.get(name) ?? []) {
        handler(event, ctx);
      }
    };
    const emitChannel = (name, payload) => {
      for (const handler of channelHandlers.get(name) ?? []) {
        handler(payload);
      }
    };

    fireEvent("before_agent_start", {});
    assert.equal(tracker.isInProgress(), true);
    fireEvent("agent_start", {});
    fireEvent("tool_execution_start", { toolCallId: "tool-1" });
    assert.equal(tracker.isInProgress(), true);
    fireEvent("tool_execution_end", { toolCallId: "tool-1" });
    fireEvent("agent_end", { messages: [] });
    assert.equal(tracker.isInProgress(), false);

    // Use the current process's pid so localCheckPidLiveness returns "alive".
    const asyncDir1 = makeAsyncDir(root, "job-1", {
      runId: "job-1",
      state: "running",
      pid: process.pid,
    });
    emitChannel("subagent:async-started", { id: "job-1", asyncDir: asyncDir1 });
    assert.equal(tracker.isInProgress(), true);
    fireEvent("session_shutdown", {});
    assert.equal(tracker.isInProgress(), false);
    assert.deepEqual(channelHandlers.get("subagent:async-started"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tracker ignores late async mutations after dispose", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-dispose-async-"));
  try {
    const asyncDir1 = makeAsyncDir(root, "job-1", { runId: "job-1", state: "running", pid: 99960 });
    const tracker = createTlhEffectiveActivityTracker({
      checkPidLiveness: () => "alive",
    });
    tracker.handleAsyncStarted({ id: "job-1", asyncDir: asyncDir1 });
    assert.equal(tracker.isInProgress(), true);

    tracker.dispose();
    tracker.handleAsyncStarted({ id: "job-2" });
    tracker.handleAsyncComplete({ id: "job-1" });
    assert.deepEqual(tracker.getSnapshot(), {
      inProgress: false,
      primaryReasons: [],
      activeAsyncJobIds: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered tracker tolerates runtimes without the optional event bus", () => {
  const eventHandlers = new Map();
  const pi = {
    on(event, handler) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
  };
  const tracker = registerTlhEffectiveActivityTracker(pi);
  for (const handler of eventHandlers.get("before_agent_start") ?? []) {
    handler({});
  }
  assert.equal(tracker.isInProgress(), true);
  for (const handler of eventHandlers.get("session_shutdown") ?? []) {
    handler({});
  }
  assert.equal(tracker.isInProgress(), false);
});

// ---------------------------------------------------------------------------
// Liveness-drain tests (Part 1)
// ---------------------------------------------------------------------------

function makeAsyncDir(root, dirName, status) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify(status, null, 2));
  return dir;
}

test("drain: drops job whose status.json reports a terminal state", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-terminal-"));
  try {
    for (const terminalState of ["complete", "failed", "cancelled", "continued"]) {
      const asyncDir = makeAsyncDir(root, terminalState, {
        runId: `run-${terminalState}`,
        state: terminalState,
        pid: 99999,
      });
      const tracker = createTlhEffectiveActivityTracker({
        checkPidLiveness: () => "alive", // Pid would pass; state should still drop it.
      });
      tracker.handleAsyncStarted({ id: `run-${terminalState}`, asyncDir });
      // Trigger drain by calling getSnapshot.
      const snapshot = tracker.getSnapshot();
      assert.deepEqual(
        snapshot.activeAsyncJobIds,
        [],
        `Expected terminal state '${terminalState}' to cause drain`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: drops job whose pid is dead", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-deadpid-"));
  try {
    const asyncDir = makeAsyncDir(root, "run-dead", {
      runId: "run-dead",
      state: "running",
      pid: 99998,
    });
    const tracker = createTlhEffectiveActivityTracker({
      checkPidLiveness: () => "dead",
    });
    tracker.handleAsyncStarted({ id: "run-dead", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: drops job when asyncDir is missing or unreadable", () => {
  const tracker = createTlhEffectiveActivityTracker({
    checkPidLiveness: () => "alive",
  });
  // asyncDir points to a nonexistent path.
  tracker.handleAsyncStarted({
    id: "run-missing",
    asyncDir: "/nonexistent/path/that/does/not/exist",
  });
  assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
});

test("drain: retains freshly queued job within grace period", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-queued-fresh-"));
  try {
    // startedAt=1000, now=1000+10s → 10 s elapsed, well within 30 s grace.
    const asyncDir = makeAsyncDir(root, "run-queued", {
      runId: "run-queued",
      state: "queued",
      startedAt: 1000,
    });
    const tracker = createTlhEffectiveActivityTracker({
      now: () => 1000 + 10_000,
      checkPidLiveness: () => "dead", // Must not be called for queued; pid absent.
    });
    tracker.handleAsyncStarted({ id: "run-queued", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["run-queued"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: drops queued job past grace period", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-queued-stale-"));
  try {
    // startedAt=1000, now=1000+31s → 31 s elapsed, past the 30 s bound.
    const asyncDir = makeAsyncDir(root, "run-queued-stale", {
      runId: "run-queued-stale",
      state: "queued",
      startedAt: 1000,
    });
    const tracker = createTlhEffectiveActivityTracker({
      now: () => 1000 + 31_000,
    });
    tracker.handleAsyncStarted({ id: "run-queued-stale", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: drops queued job with no startedAt (unverifiable grace)", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-queued-nostartedAt-"));
  try {
    const asyncDir = makeAsyncDir(root, "run-queued-no-ts", {
      runId: "run-queued-no-ts",
      state: "queued",
      // No startedAt field — cannot determine elapsed time.
    });
    const tracker = createTlhEffectiveActivityTracker({
      now: () => Date.now(),
    });
    tracker.handleAsyncStarted({ id: "run-queued-no-ts", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: drops job with no asyncDir recorded", () => {
  const tracker = createTlhEffectiveActivityTracker({
    checkPidLiveness: () => "alive", // Would pass if called; asyncDir absence must drop.
  });
  // No asyncDir field — cannot read status.json → drop immediately.
  tracker.handleAsyncStarted({ id: "run-no-asyncdir" });
  assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
});

test("drain: retains verified-live long-running job regardless of how long it has been running", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-alive-"));
  try {
    // Simulate a job that started long ago (large startedAt). The drain must NOT apply
    // any elapsed-time heuristic — it keeps the job because the pid is alive.
    const asyncDir = makeAsyncDir(root, "run-alive", {
      runId: "run-alive",
      state: "running",
      pid: 12345,
      startedAt: Date.now() - 4 * 60 * 60 * 1000, // 4 hours ago
    });
    const tracker = createTlhEffectiveActivityTracker({
      checkPidLiveness: () => "alive",
    });
    tracker.handleAsyncStarted({ id: "run-alive", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["run-alive"]);
    assert.equal(tracker.isInProgress(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain: keeps job whose pid liveness is unknown (fail-open)", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-unknown-"));
  try {
    const asyncDir = makeAsyncDir(root, "run-unknown", {
      runId: "run-unknown",
      state: "running",
      pid: 12346,
    });
    const tracker = createTlhEffectiveActivityTracker({
      checkPidLiveness: () => "unknown",
    });
    tracker.handleAsyncStarted({ id: "run-unknown", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["run-unknown"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests (Part 1b) — async-start race and malformed-field hardening
// ---------------------------------------------------------------------------

/**
 * REGRESSION: async-start race — job registered before status.json exists.
 *
 * Reproduces the real producer ordering:
 *   1. Parent creates asyncDir
 *   2. Parent emits subagent:async-started (no status.json yet)
 *   3. Child eventually writes status.json
 *
 * Before the fix, the drain would hit the catch branch for the missing
 * status.json and drop the record immediately, making the feature inert.
 * After the fix, the recorded live pid anchors liveness during the startup
 * window, so the job is retained at both points.
 */
test("regression: job is retained when asyncDir exists but status.json not yet written (async-start race)", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-start-race-"));
  try {
    // Parent creates asyncDir — child has NOT written status.json yet.
    const asyncDir = join(root, "run-1");
    mkdirSync(asyncDir, { recursive: true });

    // Use the current process's pid so pid liveness returns "alive".
    const tracker = createTlhEffectiveActivityTracker({ asyncDir: root });
    tracker.handleAsyncStarted({ id: "run-1", asyncDir, pid: process.pid });

    // Point A: status.json does not exist yet — job must still be tracked.
    assert.deepEqual(
      tracker.getSnapshot().activeAsyncJobIds,
      ["run-1"],
      "job must be retained before status.json exists (pid anchor)",
    );
    assert.equal(tracker.isInProgress(), true);

    // Child writes status.json.
    writeFileSync(
      join(asyncDir, "status.json"),
      JSON.stringify({ runId: "run-1", state: "running", pid: process.pid, startedAt: Date.now() }),
    );

    // Point B: status.json now exists and is valid — job must still be tracked.
    assert.deepEqual(
      tracker.getSnapshot().activeAsyncJobIds,
      ["run-1"],
      "job must still be retained after status.json is written",
    );
    assert.equal(tracker.isInProgress(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regression: started job with dead pid and no status.json is dropped (startup window with dead pid)", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-start-race-dead-"));
  try {
    const asyncDir = join(root, "run-dead");
    mkdirSync(asyncDir, { recursive: true }); // no status.json

    const tracker = createTlhEffectiveActivityTracker({
      asyncDir: root,
      checkPidLiveness: () => "dead",
    });
    tracker.handleAsyncStarted({ id: "run-dead", asyncDir, pid: 99997 });

    // Pid is dead and status.json does not exist → drop.
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardening: pid 0 in handleAsyncStarted payload is rejected before liveness check", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-pid0-"));
  try {
    const asyncDir = join(root, "run-pid0");
    mkdirSync(asyncDir, { recursive: true }); // no status.json

    // process.kill(0, 0) targets the current process group and always succeeds;
    // a pid of 0 must be rejected so it can never be reported alive.
    const tracker = createTlhEffectiveActivityTracker({ asyncDir: root });
    tracker.handleAsyncStarted({ id: "run-pid0", asyncDir, pid: 0 });

    // No valid pid anchor → no status.json → drop.
    assert.deepEqual(
      tracker.getSnapshot().activeAsyncJobIds,
      [],
      "pid=0 must be rejected; job must be dropped when status.json absent",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardening: non-integer pid in handleAsyncStarted payload is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-pidfloat-"));
  try {
    const asyncDir = join(root, "run-pidfloat");
    mkdirSync(asyncDir, { recursive: true }); // no status.json

    const tracker = createTlhEffectiveActivityTracker({ asyncDir: root });
    tracker.handleAsyncStarted({ id: "run-pidfloat", asyncDir, pid: 1.5 });

    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regression: non-terminal status.json with invalid pid (0, negative, fractional) is dropped", () => {
  // process.kill(0, 0) targets the current process group on POSIX and always
  // succeeds, so pid=0 in status.json would be retained as alive forever without
  // this validation. Negative and fractional pids are likewise invalid.
  const invalidPids = [0, -1, 1.5];
  for (const badPid of invalidPids) {
    const root = mkdtempSync(join(tmpdir(), `tlh-statusjson-badpid-`));
    try {
      const asyncDir = makeAsyncDir(root, "run-badpid", {
        runId: "run-badpid",
        state: "running",
        pid: badPid,
      });
      const tracker = createTlhEffectiveActivityTracker({
        // checkPidLiveness must never be called for an invalid pid.
        checkPidLiveness: () => {
          throw new Error(`checkPidLiveness must not be called for pid=${badPid}`);
        },
      });
      tracker.handleAsyncStarted({ id: "run-badpid", asyncDir });
      assert.deepEqual(
        tracker.getSnapshot().activeAsyncJobIds,
        [],
        `status.json with pid=${badPid} must be dropped, not retained`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("hardening: queued job with future startedAt is dropped (unbounded grace prevention)", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-queued-future-"));
  try {
    const nowMs = 1_000_000;
    // startedAt is in the future relative to now() — must not produce an unbounded grace.
    const asyncDir = makeAsyncDir(root, "run-future", {
      runId: "run-future",
      state: "queued",
      startedAt: nowMs + 60_000, // 60 seconds in the future
    });
    const tracker = createTlhEffectiveActivityTracker({
      now: () => nowMs,
    });
    tracker.handleAsyncStarted({ id: "run-future", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardening: queued job with NaN startedAt is dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-queued-nan-"));
  try {
    const asyncDir = makeAsyncDir(root, "run-nan", {
      runId: "run-nan",
      state: "queued",
      startedAt: Number.NaN,
    });
    const tracker = createTlhEffectiveActivityTracker({ now: () => 1_000_000 });
    tracker.handleAsyncStarted({ id: "run-nan", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardening: queued job with Infinity startedAt is dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-queued-inf-"));
  try {
    const asyncDir = makeAsyncDir(root, "run-inf", {
      runId: "run-inf",
      state: "queued",
      startedAt: Number.POSITIVE_INFINITY,
    });
    const tracker = createTlhEffectiveActivityTracker({ now: () => 1_000_000 });
    tracker.handleAsyncStarted({ id: "run-inf", asyncDir });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Event-emission tests (Part 2)
// ---------------------------------------------------------------------------

test("registered tracker emits tlh:effective-activity on pi.events when snapshot changes", () => {
  const eventHandlers = new Map();
  const emitted = [];
  const pi = {
    on(event, handler) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
    events: {
      on(_channel, _handler) {
        return () => {};
      },
      emit(channel, payload) {
        emitted.push({ channel, payload });
      },
    },
  };
  registerTlhEffectiveActivityTracker(pi);
  const fire = (name, event = {}) => {
    for (const handler of eventHandlers.get(name) ?? []) handler(event);
  };

  fire("before_agent_start");
  fire("agent_start");
  fire("agent_end", { messages: [] });

  // There should be exactly 3 emissions corresponding to the 3 state changes.
  const activityEmits = emitted.filter((e) => e.channel === TLH_EFFECTIVE_ACTIVITY_EVENT);
  assert.equal(activityEmits.length, 3);

  // First emission: inProgress=true (before_agent_start).
  assert.equal(activityEmits[0].payload.inProgress, true);
  assert.deepEqual(activityEmits[0].payload.activeAsyncJobIds, []);

  // Last emission: inProgress=false (agent_end with no retry).
  assert.equal(activityEmits[2].payload.inProgress, false);
  assert.deepEqual(activityEmits[2].payload.activeAsyncJobIds, []);
});

test("registered tracker does not emit on pi.events when snapshot is unchanged", () => {
  const eventHandlers = new Map();
  const emitted = [];
  const pi = {
    on(event, handler) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
    events: {
      on(_channel, _handler) {
        return () => {};
      },
      emit(channel, payload) {
        emitted.push({ channel, payload });
      },
    },
  };
  registerTlhEffectiveActivityTracker(pi);
  const fire = (name, event = {}) => {
    for (const handler of eventHandlers.get(name) ?? []) handler(event);
  };

  // Fire the same event twice — only one emission should happen.
  fire("before_agent_start");
  fire("before_agent_start");

  const activityEmits = emitted.filter((e) => e.channel === TLH_EFFECTIVE_ACTIVITY_EVENT);
  assert.equal(activityEmits.length, 1, "Duplicate state must not produce extra emissions");
});

test("registered tracker does not emit tlh:effective-activity when pi.events is absent", () => {
  const eventHandlers = new Map();
  const pi = {
    on(event, handler) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
  };
  registerTlhEffectiveActivityTracker(pi);
  for (const handler of eventHandlers.get("before_agent_start") ?? []) handler({});
  // No assertion needed beyond "does not throw"; the test just verifies the
  // absence-of-events-bus path is safe.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// Periodic liveness drain tests (ts-hm76)
// ---------------------------------------------------------------------------

test("periodic drain: dead child is drained and snapshot changes even without external stimulus", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-periodic-drain-"));
  try {
    const timers = createFakeTimers();
    // Start alive, then simulate the pid dying.
    let pidAlive = true;
    const asyncDir1 = makeAsyncDir(root, "job-1", { runId: "job-1", state: "running", pid: 99970 });
    const snapshots = [];
    const tracker = createTlhEffectiveActivityTracker({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      livenessIntervalMs: 100,
      checkPidLiveness: () => (pidAlive ? "alive" : "dead"),
    });
    tracker.subscribe((snapshot) => snapshots.push(snapshot));

    // Add a live job — timer should start.
    tracker.handleAsyncStarted({ id: "job-1", asyncDir: asyncDir1 });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobIds, ["job-1"]);
    assert.equal(tracker.isInProgress(), true);

    // Pid dies — but no external events arrive.
    pidAlive = false;

    // Advance past the liveness interval; the periodic timer fires, runs the drain,
    // and emits a snapshot change — with no external stimulus.
    timers.advance(100);

    assert.deepEqual(
      tracker.getSnapshot().activeAsyncJobIds,
      [],
      "dead child must be drained by periodic timer",
    );
    assert.equal(tracker.isInProgress(), false);
    // Subscriber must have been notified of the change.
    assert.ok(
      snapshots.some((s) => s.activeAsyncJobIds.length === 0 && !s.inProgress),
      "subscriber must receive snapshot after periodic drain removes dead job",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("periodic drain timer is cleared on dispose", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-drain-timer-dispose-"));
  try {
    const timers = createFakeTimers();
    const asyncDir1 = makeAsyncDir(root, "job-1", { runId: "job-1", state: "running", pid: 99971 });
    const tracker = createTlhEffectiveActivityTracker({
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      livenessIntervalMs: 100,
      checkPidLiveness: () => "alive",
    });
    tracker.handleAsyncStarted({ id: "job-1", asyncDir: asyncDir1 });
    // At least the liveness timer should be pending.
    assert.ok(timers.pendingCount() >= 1, "liveness timer should be pending after job is added");

    tracker.dispose();
    assert.equal(timers.pendingCount(), 0, "all timers must be cleared after dispose");

    // Advancing must produce no further activity after dispose.
    const snapshots = [];
    tracker.subscribe((s) => snapshots.push(s));
    timers.advance(500);
    assert.equal(snapshots.length, 0, "no snapshots must be emitted after dispose");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
