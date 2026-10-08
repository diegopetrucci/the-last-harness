/**
 * OSC 7501 Program Status reporter — quiescent state mapping and settle-based
 * outcome regression tests.
 *
 * Covers:
 * - lastRunOutcome quiescent mapping: aborted→idle, error→error,
 *   completed→done, undefined→idle.
 * - Settle-based outcome: no false "error" during Pi retry gap (runActive
 *   keeps the reporter in "working" across agent_end→agent_settled).
 *
 * Kept in a separate file to stay within the max-lines limit of the main
 * activity-reporters test file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createProgramStatusActivityReporter } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);
const { createTlhEffectiveActivityTracker } = await jiti.import(
  "../extensions/the-last-harness/activity-tracker.ts",
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

function createFakeOutput() {
  return {
    isTTY: true,
    writes: [],
    write(data) {
      this.writes.push(data);
    },
  };
}

const workingSeq = "\x1b]7501;state=working:app=tlh\x1b\\";
const doneSeq = "\x1b]7501;state=done:app=tlh\x1b\\";
const idleSeq = "\x1b]7501;state=idle:app=tlh\x1b\\";
const errorSeq = "\x1b]7501;state=error:app=tlh\x1b\\";

const sm = { getSessionFile: () => undefined, getSessionId: () => "s" };

function makeReporter(idleDebounceMs = 0) {
  const timers = createFakeTimers();
  const output = createFakeOutput();
  const reporter = createProgramStatusActivityReporter({
    env: {},
    output,
    timers,
    idleDebounceMs,
  });
  reporter.handleSessionStart({ mode: "tui", sessionManager: sm });
  return { reporter, output, timers };
}

test("program-status reporter quiescent state maps lastRunOutcome correctly", async () => {
  for (const [outcome, expected, label] of [
    ["aborted", idleSeq, "cancelled run → idle"],
    ["error", errorSeq, "failed run → error"],
    ["completed", doneSeq, "completed run → done"],
    [undefined, idleSeq, "no run yet → idle"],
  ]) {
    const { reporter, output, timers } = makeReporter();
    const snap = { inProgress: false, primaryReasons: [], activeAsyncJobIds: [] };
    if (outcome !== undefined) snap.lastRunOutcome = outcome;
    reporter.handleSnapshot(snap);
    timers.advance(0);
    await flushAsyncWork();
    assert.deepEqual(output.writes, [expected], label);
    reporter.dispose();
  }
});

test("program-status reporter: retry grace keeps working; done after retry success", async () => {
  // inProgress=true during retry grace suppresses error; done after successful retry.
  const { reporter, output, timers } = makeReporter();
  reporter.handleSnapshot({
    inProgress: true,
    lastRunOutcome: "error",
    primaryReasons: ["primary:retry-grace"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  assert.deepEqual(output.writes, [workingSeq], "retry grace must keep working, not emit error");
  reporter.handleSnapshot({
    inProgress: false,
    lastRunOutcome: "completed",
    primaryReasons: [],
    activeAsyncJobIds: [],
  });
  timers.advance(0);
  await flushAsyncWork();
  assert.deepEqual(output.writes, [workingSeq, doneSeq], "after retry success, done is emitted");
  reporter.dispose();
});

// ─── Settle-based outcome regression: tracker → reporter integration ─────────

const DEFAULT_RETRY_GRACE_MS = 1500;

function makeTrackerReporter(retryGraceMs = DEFAULT_RETRY_GRACE_MS) {
  const timers = createFakeTimers();
  const tracker = createTlhEffectiveActivityTracker({
    retryGraceMs,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const output = createFakeOutput();
  const reporter = createProgramStatusActivityReporter({
    env: {},
    output,
    timers,
    idleDebounceMs: 0,
  });
  const sessionCtx = { mode: "tui", sessionManager: sm };
  reporter.handleSessionStart(sessionCtx);
  tracker.subscribe((snapshot) => reporter.handleSnapshot(snapshot));
  return { tracker, reporter, output, timers };
}

const retryableEndMsg = [{ role: "assistant", stopReason: "error", errorMessage: "provider err" }];
const successEndMsg = [{ role: "assistant", stopReason: "stop" }];
const abortedEndMsg = [{ role: "assistant", stopReason: "aborted" }];

test("no false error emitted during Pi retry gap longer than retry grace", async () => {
  // Regression: Pi retry delay (2000ms default) > DEFAULT_RETRY_GRACE_MS (1500ms).
  // With the settle-based approach runActive keeps the reporter in "working"
  // across the whole gap, so "error" must never appear in the sequence.
  const { tracker, reporter, output, timers } = makeTrackerReporter(DEFAULT_RETRY_GRACE_MS);

  tracker.handleBeforeAgentStart();
  tracker.handleAgentStart();
  tracker.handleAgentEnd({ messages: retryableEndMsg });
  // Advance 3000ms: exceeds retry grace (1500ms) and typical Pi retry delay.
  timers.advance(3000);
  await flushAsyncWork();

  // Retry completes successfully.
  tracker.handleAgentStart();
  tracker.handleAgentEnd({ messages: successEndMsg });
  tracker.handleAgentSettled();
  timers.advance(0);
  await flushAsyncWork();

  assert.ok(!output.writes.includes(errorSeq), "must not emit error during retry gap");
  assert.ok(output.writes.at(-1) === doneSeq, "must end at done after settled success");
  reporter.dispose();
});

test("error emitted when run settles as error (no retry)", async () => {
  const { tracker, reporter, output, timers } = makeTrackerReporter();

  tracker.handleBeforeAgentStart();
  tracker.handleAgentStart();
  tracker.handleAgentEnd({ messages: retryableEndMsg });
  // agent_settled fires immediately with no retry following.
  tracker.handleAgentSettled();
  timers.advance(0);
  await flushAsyncWork();

  assert.ok(output.writes.includes(errorSeq), "must emit error when settled as error");
  reporter.dispose();
});

test("idle emitted when run settles as aborted", async () => {
  const { tracker, reporter, output, timers } = makeTrackerReporter();

  tracker.handleBeforeAgentStart();
  tracker.handleAgentStart();
  tracker.handleAgentEnd({ messages: abortedEndMsg });
  tracker.handleAgentSettled();
  timers.advance(0);
  await flushAsyncWork();

  assert.ok(output.writes.includes(idleSeq), "must emit idle when settled as aborted");
  assert.ok(!output.writes.includes(errorSeq), "must not emit error for aborted run");
  reporter.dispose();
});

// Pinned-behaviour test: cancel during retry delay reports error (Pi 1.0.4 limitation).
// On Pi 1.0.4, aborting during an automatic retry backoff emits agent_settled with
// no new agent_end, so pendingOutcome still holds the error from the failed attempt
// and is committed as "error" rather than "idle". Pi >=1.1.0 adds
// agent_settled.aborted (#748), which will fix this. Until then this test pins the
// known behaviour so a future Pi bump reveals the deviation.
test("cancel during retry delay reports error on Pi 1.0.4 (known limitation)", async () => {
  const { tracker, reporter, output, timers } = makeTrackerReporter();

  tracker.handleBeforeAgentStart();
  tracker.handleAgentStart();
  // First attempt fails with a retryable error.
  tracker.handleAgentEnd({ messages: retryableEndMsg });
  // User cancels during the retry backoff: agent_settled fires without a new
  // agent_end, so pendingOutcome remains "error".
  tracker.handleAgentSettled();
  timers.advance(0);
  await flushAsyncWork();

  // Known limitation: reports error, not idle.
  assert.ok(
    output.writes.includes(errorSeq),
    "cancel during retry delay commits pending error (Pi 1.0.4 limitation)",
  );
  assert.ok(
    !output.writes.includes(idleSeq),
    "idle must not be emitted for abort-during-retry on Pi 1.0.4",
  );
  reporter.dispose();
});
