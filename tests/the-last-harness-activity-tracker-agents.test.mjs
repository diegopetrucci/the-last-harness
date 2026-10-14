/**
 * Agent names for async jobs recovered after a restart (rehydrate / restored event)
 * and OSC 7501 output derived from them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTlhEffectiveActivityTracker } = await jiti.import(
  "../extensions/the-last-harness/activity-tracker.ts",
);
const { createProgramStatusActivityReporter } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);

const b64 = (t) => Buffer.from(t).toString("base64");
const osc = (f) => `\x1b]7501;${f}\x1b\\`;
const ctx = {
  cwd: "/repo",
  sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s1" },
};

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tlh-tracker-agents-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeStatus(dir, name, status) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "status.json"),
    typeof status === "string" ? status : JSON.stringify(status),
  );
}

const newTracker = (asyncDir) =>
  createTlhEffectiveActivityTracker({ asyncDir, checkPidLiveness: () => "alive" });

test("rehydrate preserves parallel duplicate agent names; root msg and child title use them", async () => {
  await withTemp(async (dir) => {
    writeStatus(dir, "r1", {
      runId: "r1",
      state: "running",
      pid: 123,
      sessionId: "s1",
      steps: [{ agent: "worker", task: "SECRET" }, { agent: " worker " }, { agent: "" }, {}, 5],
    });
    writeStatus(dir, "r2", { runId: "r2", state: "running", pid: 124, sessionId: "s1" });
    const tracker = newTracker(dir);
    tracker.rehydrateFromArtifacts(ctx);
    const snapshot = tracker.getSnapshot();
    assert.deepEqual(snapshot.activeAsyncJobIds, ["r1", "r2"]);
    assert.deepEqual(snapshot.activeAsyncJobAgents, { r1: ["worker", "worker"] });
    assert.ok(!JSON.stringify(snapshot).includes("SECRET"));

    const writes = [];
    const reporter = createProgramStatusActivityReporter({
      env: {},
      output: { isTTY: true, write: (d) => writes.push(d) },
      idleDebounceMs: 0,
    });
    reporter.handleSessionStart({ mode: "tui", sessionManager: ctx.sessionManager });
    reporter.handleSnapshot({ ...snapshot, activeAsyncJobIds: ["r1"] });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(writes, [
      osc(`state=working:app=tlh:msg=${b64("2 subagents running")}`),
      osc(`state=working:id=subagent/r1:title=${b64("worker+worker")}`),
    ]);
    reporter.dispose();
    tracker.dispose();
  });
});

test("restored-event jobs read agent names from asyncDir status.json", () => {
  withTemp((dir) => {
    writeStatus(dir, "r1", {
      runId: "r1",
      state: "running",
      pid: 123,
      sessionId: "s1",
      steps: [{ agent: "scout" }, { agent: "reviewer" }],
    });
    const tracker = newTracker(dir);
    tracker.rehydrateFromArtifacts({ ...ctx, sessionManager: ctx.sessionManager });
    tracker.handleAsyncRestored({
      sessionId: "s1",
      jobs: [{ runId: "r9", asyncDir: join(dir, "r1"), sessionId: "s1", pid: 5 }],
    });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobAgents, { r9: ["scout", "reviewer"] });
    tracker.dispose();
  });
});

test("missing or invalid status.json yields no names and does not throw", () => {
  withTemp((dir) => {
    writeStatus(dir, "bad", "{not json");
    writeStatus(dir, "arr", "[]");
    const tracker = newTracker(dir);
    tracker.rehydrateFromArtifacts(ctx);
    assert.doesNotThrow(() =>
      tracker.handleAsyncRestored({
        sessionId: "s1",
        jobs: [
          { runId: "a", asyncDir: join(dir, "bad"), sessionId: "s1", pid: 5 },
          { runId: "b", asyncDir: join(dir, "arr"), sessionId: "s1", pid: 6 },
          { runId: "c", asyncDir: join(dir, "missing"), sessionId: "s1", pid: 7 },
        ],
      }),
    );
    const snapshot = tracker.getSnapshot();
    assert.deepEqual(snapshot.activeAsyncJobIds, ["a", "c"]);
    assert.equal(snapshot.activeAsyncJobAgents, undefined);
    tracker.dispose();
  });
});

test("known names are not erased by a later nameless record", () => {
  withTemp((dir) => {
    const tracker = newTracker(dir);
    tracker.rehydrateFromArtifacts(ctx);
    tracker.handleAsyncStarted({ id: "r1", asyncDir: dir, pid: 10, agents: ["worker", "scout"] });
    tracker.handleAsyncStarted({ id: "r1", asyncDir: dir, pid: 10 });
    assert.deepEqual(tracker.getSnapshot().activeAsyncJobAgents, { r1: ["worker", "scout"] });
    tracker.dispose();
  });
});
