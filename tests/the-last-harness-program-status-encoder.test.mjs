/**
 * OSC 7501 report encoder tests and internal tracker snapshot metadata
 * (prompt title, compaction flag, error line, async agent names).
 * Kept separate from the larger reporter/tracker suites (max-lines limit).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatProgramStatusReport, isValidProgramStatusId } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);
const { createTlhEffectiveActivityTracker, registerTlhEffectiveActivityTracker } =
  await jiti.import("../extensions/the-last-harness/activity-tracker.ts");
const { TLH_EFFECTIVE_ACTIVITY_EVENT } = await jiti.import(
  "../extensions/shared/tlh-effective-activity.ts",
);

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const decode = (report, key) => {
  const body = report.slice("\x1b]7501;".length, -2);
  const pair = body.split(":").find((part) => part.startsWith(`${key}=`));
  return pair === undefined ? undefined : Buffer.from(pair.slice(key.length + 1), "base64");
};

test("encoder: root report with app, blocked kind, clear", () => {
  assert.equal(
    formatProgramStatusReport({ state: "working", app: "tlh" }),
    "\x1b]7501;state=working:app=tlh\x1b\\",
  );
  assert.equal(
    formatProgramStatusReport({ state: "blocked", app: "tlh", kind: "permission" }),
    "\x1b]7501;state=blocked:app=tlh:kind=permission\x1b\\",
  );
  // kind is only meaningful for blocked.
  assert.equal(
    formatProgramStatusReport({ state: "done", kind: "question" }),
    "\x1b]7501;state=done\x1b\\",
  );
  assert.equal(
    formatProgramStatusReport({ state: "working", id: "subagent/r1", app: "tlh" }),
    "\x1b]7501;state=working:id=subagent/r1\x1b\\",
  );
  assert.equal(formatProgramStatusReport({ state: "clear" }), "\x1b]7501;state=clear\x1b\\");
  assert.equal(
    formatProgramStatusReport({ state: "clear", id: "root/a.b" }),
    "\x1b]7501;state=clear:id=root/a.b\x1b\\",
  );
});

test("encoder: title and msg are base64 UTF-8, control chars become spaces, empty omitted", () => {
  const report = formatProgramStatusReport({
    state: "working",
    id: "c1",
    title: "  héllo\u0000\u001bwörld\u009f! ",
    msg: "line1\nline2\t✓",
  });
  assert.ok(report.includes(`:title=${b64("héllo wörld !")}`));
  assert.ok(report.includes(`:msg=${b64("line1 line2 ✓")}`));
  const empty = formatProgramStatusReport({ state: "idle", title: " \n\u0085 ", msg: "" });
  assert.equal(empty, "\x1b]7501;state=idle\x1b\\");
});

test("encoder: truncates on UTF-8 boundaries at 2048 (msg) and 192 (title) bytes", () => {
  const msg = formatProgramStatusReport({ state: "working", msg: "é".repeat(2000) });
  assert.equal(decode(msg, "msg").toString("utf8"), "é".repeat(1024));
  assert.equal(decode(msg, "msg").length, 2048);
  const odd = formatProgramStatusReport({ state: "working", msg: "a" + "€".repeat(1000) });
  assert.equal(decode(odd, "msg").length, 2047); // 1 + 682*3, never splits a char
  const title = formatProgramStatusReport({ state: "working", title: "😀".repeat(100) });
  assert.equal(decode(title, "title").toString("utf8"), "😀".repeat(48));
  assert.equal(decode(title, "title").length, 192);
});

test("encoder: invalid ids are rejected and never fall back to the root record", () => {
  const bad = [
    "",
    "a//b",
    "/a",
    "a/",
    "a b",
    "a:b",
    "é",
    "x".repeat(33),
    "a/b/c/d/e/f/g/h/i",
    Array.from({ length: 8 }, () => "x".repeat(16)).join("/"), // 135 bytes
  ];
  for (const id of bad) {
    assert.equal(isValidProgramStatusId(id), false, JSON.stringify(id));
    assert.equal(formatProgramStatusReport({ state: "working", app: "tlh", id }), undefined);
    assert.equal(formatProgramStatusReport({ state: "clear", id }), undefined);
  }
  for (const id of ["a", "A_b.c+d-e", "a/b/c/d/e/f/g/h", "x".repeat(32)]) {
    assert.equal(isValidProgramStatusId(id), true, id);
  }
  assert.equal(
    isValidProgramStatusId(
      ["x".repeat(32), "x".repeat(32), "x".repeat(32), "x".repeat(29)].join("/"),
    ),
    true,
  );
  assert.equal(
    isValidProgramStatusId(
      ["x".repeat(32), "x".repeat(32), "x".repeat(32), "x".repeat(32)].join("/"),
    ),
    false,
  );
});

test("tracker: nested prompt title precedence and cleanup", () => {
  const tracker = createTlhEffectiveActivityTracker();
  try {
    assert.equal(tracker.getSnapshot().waitingForUserTitle, undefined);
    tracker.handleUIPromptStart({ kind: "select", title: "  Outer  " });
    assert.equal(tracker.getSnapshot().waitingForUserTitle, "Outer");
    tracker.handleUIPromptStart({ kind: "confirm", title: "Inner" });
    assert.equal(tracker.getSnapshot().waitingForUserTitle, "Inner");
    tracker.handleUIPromptEnd();
    assert.equal(tracker.getSnapshot().waitingForUserTitle, "Outer");
    tracker.handleUIPromptStart({ kind: "input" });
    assert.equal(tracker.getSnapshot().waitingForUserTitle, undefined);
    tracker.handleUIPromptEnd();
    tracker.handleUIPromptEnd();
    assert.equal("waitingForUserTitle" in tracker.getSnapshot(), false);
  } finally {
    tracker.dispose();
  }
});

test("tracker: compacting flag follows any primary:compaction reason", () => {
  const tracker = createTlhEffectiveActivityTracker();
  try {
    assert.equal("compacting" in tracker.getSnapshot(), false);
    tracker.handleSessionBeforeCompact({ reason: "manual" });
    tracker.handleSessionBeforeCompact({ reason: "threshold" });
    assert.equal(tracker.getSnapshot().compacting, true);
    tracker.handleSessionCompact({ reason: "manual" });
    assert.equal(tracker.getSnapshot().compacting, true);
    tracker.handleSessionCompactFailed({ reason: "threshold" });
    assert.equal("compacting" in tracker.getSnapshot(), false);
    tracker.handleToolExecutionStart({ toolCallId: "t" });
    assert.equal("compacting" in tracker.getSnapshot(), false);
  } finally {
    tracker.dispose();
  }
});

test("tracker: lastRunErrorLine is first non-empty trimmed line, only for error outcomes", () => {
  const tracker = createTlhEffectiveActivityTracker({ retryGraceMs: 0 });
  try {
    tracker.handleAgentStart();
    tracker.handleAgentEnd({
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "\n  \n  Boom happened  \nstack" },
      ],
    });
    // Not committed until settled.
    assert.equal(tracker.getSnapshot().lastRunErrorLine, undefined);
    tracker.handleAgentSettled({ aborted: false });
    let snapshot = tracker.getSnapshot();
    assert.equal(snapshot.lastRunOutcome, "error");
    assert.equal(snapshot.lastRunErrorLine, "Boom happened");

    tracker.handleAgentStart();
    tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] });
    tracker.handleAgentSettled({ aborted: false });
    snapshot = tracker.getSnapshot();
    assert.equal(snapshot.lastRunOutcome, "completed");
    assert.equal("lastRunErrorLine" in snapshot, false);

    tracker.handleAgentStart();
    tracker.handleAgentEnd({ messages: [{ role: "assistant", errorMessage: "x" }] });
    tracker.handleAgentSettled({ aborted: true });
    assert.equal("lastRunErrorLine" in tracker.getSnapshot(), false);

    tracker.handleAgentStart();
    tracker.handleAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }] });
    tracker.handleAgentSettled({ aborted: false });
    assert.equal("lastRunErrorLine" in tracker.getSnapshot(), false);
  } finally {
    tracker.dispose();
  }
});

test("tracker: async job agent names come from agent/agents and never store task text", () => {
  const root = mkdtempSync(join(tmpdir(), "tlh-psenc-"));
  try {
    const dirFor = (id) => {
      const dir = join(root, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "status.json"),
        JSON.stringify({ state: "running", pid: process.pid }),
      );
      return dir;
    };
    const tracker = createTlhEffectiveActivityTracker({ checkPidLiveness: () => "alive" });
    try {
      tracker.handleAsyncStarted({
        id: "r1",
        asyncDir: dirFor("r1"),
        agent: "worker",
        task: "SECRET",
      });
      tracker.handleAsyncStarted({
        id: "r2",
        asyncDir: dirFor("r2"),
        agents: ["scout", "worker", "scout"],
      });
      tracker.handleAsyncStarted({
        id: "r4",
        asyncDir: dirFor("r4"),
        agent: "ignored",
        agents: ["worker", " worker ", 3],
      });
      tracker.handleAsyncStarted({
        id: "r5",
        asyncDir: dirFor("r5"),
        agent: "solo",
        agents: [],
      });
      tracker.handleAsyncStarted({ id: "r3", asyncDir: dirFor("r3") });
      const snapshot = tracker.getSnapshot();
      assert.deepEqual(snapshot.activeAsyncJobAgents, {
        r1: ["worker"],
        r2: ["scout", "worker", "scout"],
        r4: ["worker", "worker"],
        r5: ["solo"],
      });
      assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
      tracker.handleAsyncComplete({ id: "r1" });
      assert.deepEqual(tracker.getSnapshot().activeAsyncJobAgents, {
        r2: ["scout", "worker", "scout"],
        r4: ["worker", "worker"],
        r5: ["solo"],
      });
    } finally {
      tracker.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared bus payload is unchanged by the new internal snapshot fields", () => {
  const handlers = new Map();
  const emitted = [];
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      on() {
        return () => {};
      },
      emit(channel, payload) {
        emitted.push([channel, payload]);
      },
    },
  };
  const tracker = registerTlhEffectiveActivityTracker(pi, { env: {} });
  try {
    handlers.get("ui_prompt_start")({ kind: "select", title: "Pick" });
    handlers.get("session_before_compact")({ reason: "manual" });
  } finally {
    tracker.dispose();
  }
  assert.ok(emitted.length > 0);
  for (const [channel, payload] of emitted) {
    assert.equal(channel, TLH_EFFECTIVE_ACTIVITY_EVENT);
    assert.deepEqual(Object.keys(payload).sort(), [
      "activeAsyncJobIds",
      "inProgress",
      "waitingForUser",
    ]);
  }
});
