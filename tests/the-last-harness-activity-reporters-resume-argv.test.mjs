/**
 * Tests for the Herdr resume_argv restore command reported on pane.report_agent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { createFakeTimers } from "./support/fake-timers.mjs";

const jiti = createJiti(import.meta.url);
const { createHerdrActivityReporter } = await jiti.import(
  "../extensions/the-last-harness/activity-reporters.ts",
);

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function herdrEnv(extra = {}) {
  return { HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1", ...extra };
}

async function firstStateReport(env, sessionPath, sessionId = "session-1") {
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env,
    sendRequest: async (request) => calls.push(request),
    idleDebounceMs: 10,
  });
  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => sessionId },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
  reporter.dispose();
  return stateCalls;
}

test("Herdr reporter resumes through the runtime wrapper name", async () => {
  const sessionPath = "/Users/dev/.tlh-dev/agent/sessions/2026-11-03.jsonl";
  for (const wrapperName of ["tlh-dev", "tlh.v2_x", "TLH2"]) {
    const stateCalls = await firstStateReport(
      herdrEnv({ TLH_RUNTIME_WRAPPER_NAME: wrapperName }),
      sessionPath,
    );
    assert.equal(stateCalls.length, 1);
    assert.deepEqual(
      stateCalls[0].params.resume_argv,
      [wrapperName, "--session", sessionPath],
      `wrapper name ${JSON.stringify(wrapperName)} must be used verbatim`,
    );
  }
});

test("Herdr reporter heartbeats repeat the resume argv", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const sessionPath = "/tmp/session.jsonl";
  const reporter = createHerdrActivityReporter({
    env: herdrEnv({ HERDR_TLH_HEARTBEAT_MS: "1000", TLH_RUNTIME_WRAPPER_NAME: "tlh" }),
    sendRequest: async (request) => calls.push(request),
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });
  reporter.handleSessionStart({
    mode: "tui",
    sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "session-1" },
  });
  reporter.handleSnapshot({
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  });
  await flushAsyncWork();
  timers.advance(1000);
  await flushAsyncWork();
  const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
  assert.equal(stateCalls.length, 2);
  for (const call of stateCalls) {
    assert.deepEqual(call.params.resume_argv, ["tlh", "--session", sessionPath]);
  }
  reporter.dispose();
});

test("Herdr reporter falls back to the tlh wrapper name for unusable names", async () => {
  const sessionPath = "/tmp/session.jsonl";
  for (const wrapperName of [
    "/usr/local/bin/tlh",
    "./tlh",
    "-tlh",
    "tlh wrapper",
    "tlh;rm -rf /",
    "tlh\n",
    "",
  ]) {
    const stateCalls = await firstStateReport(
      herdrEnv({ TLH_RUNTIME_WRAPPER_NAME: wrapperName }),
      sessionPath,
    );
    assert.equal(stateCalls.length, 1);
    assert.deepEqual(
      stateCalls[0].params.resume_argv,
      ["tlh", "--session", sessionPath],
      `wrapper name ${JSON.stringify(wrapperName)} must fall back to tlh`,
    );
  }
  const missingEnvCalls = await firstStateReport(herdrEnv(), sessionPath);
  assert.deepEqual(missingEnvCalls[0].params.resume_argv, ["tlh", "--session", sessionPath]);
});

test("Herdr reporter falls back when the wrapper name alone breaks Herdr's argv bound", async () => {
  // A plain command name can still be unusable: 8193 bytes exceeds Herdr's
  // 8192-byte argv ceiling, and Herdr rejects the whole report in that case.
  const oversizedName = "t".repeat(8193);
  const stateCalls = await firstStateReport(
    herdrEnv({ TLH_RUNTIME_WRAPPER_NAME: oversizedName }),
    "/tmp/session.jsonl",
  );
  assert.equal(stateCalls.length, 1);
  assert.deepEqual(stateCalls[0].params.resume_argv, ["tlh", "--session", "/tmp/session.jsonl"]);
});

test("Herdr reporter sends the bare wrapper for unusable session paths", async () => {
  for (const sessionPath of [
    "/tmp/o'brien.jsonl",
    "/tmp/line\nbreak.jsonl",
    "/tmp/tab\tname.jsonl",
    "/tmp/del\u007f.jsonl",
    "/tmp/c1\u009f.jsonl",
    "relative/session.jsonl",
    "",
  ]) {
    const stateCalls = await firstStateReport(
      herdrEnv({ TLH_RUNTIME_WRAPPER_NAME: "tlh-custom" }),
      sessionPath,
    );
    assert.equal(stateCalls.length, 1);
    assert.deepEqual(
      stateCalls[0].params.resume_argv,
      ["tlh-custom"],
      `session path ${JSON.stringify(sessionPath)} must fall back to the bare wrapper`,
    );
  }
});

test("Herdr reporter bounds resume argv by Herdr's UTF-8 byte limit", async () => {
  // `tlh` + `--session` occupy 12 bytes, so a path of 8180 bytes is exactly at
  // Herdr's 8192-byte ceiling and a path of 8181 bytes exceeds it.
  const atLimit = `/${"a".repeat(8179)}`;
  const overLimit = `/${"a".repeat(8180)}`;
  const multiByteOverLimit = `/${`é${"a".repeat(8178)}`}`;
  assert.equal(multiByteOverLimit.length, atLimit.length);
  const atLimitCalls = await firstStateReport(herdrEnv(), atLimit);
  assert.deepEqual(atLimitCalls[0].params.resume_argv, ["tlh", "--session", atLimit]);
  const overLimitCalls = await firstStateReport(herdrEnv(), overLimit);
  assert.deepEqual(overLimitCalls[0].params.resume_argv, ["tlh"]);
  const multiByteCalls = await firstStateReport(herdrEnv(), multiByteOverLimit);
  assert.deepEqual(
    multiByteCalls[0].params.resume_argv,
    ["tlh"],
    "byte length, not character count, decides the limit",
  );
});

test("Herdr session change reports the new resume argv with heartbeats disabled", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: herdrEnv({ HERDR_TLH_HEARTBEAT_MS: "0", TLH_RUNTIME_WRAPPER_NAME: "tlh" }),
    sendRequest: async (request) => calls.push(request),
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });
  const stateCalls = () => calls.filter((call) => call.method === "pane.report_agent");
  const workingSnapshot = {
    inProgress: true,
    primaryReasons: ["primary:agent-loop"],
    activeAsyncJobIds: [],
  };
  let sessionPath = "/tmp/first.jsonl";
  const sessionManager = () => ({
    getSessionFile: () => sessionPath,
    getSessionId: () => "session-1",
  });

  reporter.handleSessionStart({ mode: "tui", sessionManager: sessionManager() });
  await flushAsyncWork();
  assert.equal(stateCalls().length, 0, "a start with no known state sends no state report");

  reporter.handleSnapshot(workingSnapshot);
  await flushAsyncWork();
  assert.equal(stateCalls().length, 1);
  assert.deepEqual(stateCalls()[0].params.resume_argv, ["tlh", "--session", sessionPath]);

  sessionPath = "/tmp/second.jsonl";
  reporter.handleSessionStart({ mode: "tui", sessionManager: sessionManager() });
  await flushAsyncWork();
  assert.equal(stateCalls().length, 2, "the session change must report without a state edge");
  const changeCall = stateCalls()[1];
  assert.equal(changeCall.params.state, "working");
  assert.deepEqual(changeCall.params.resume_argv, ["tlh", "--session", sessionPath]);
  assert.ok(changeCall.params.seq > stateCalls()[0].params.seq);

  // The unchanged snapshot that follows a session start stays deduplicated.
  reporter.handleSnapshot(workingSnapshot);
  await flushAsyncWork();
  assert.equal(stateCalls().length, 2);
  assert.equal(calls.filter((call) => call.method === "pane.report_agent_session").length, 0);
  reporter.dispose();
  await flushAsyncWork();
});

test("Herdr reporter carries resume argv on blocked reports and across a blocked session change", async () => {
  const timers = createFakeTimers();
  const calls = [];
  const reporter = createHerdrActivityReporter({
    env: herdrEnv({ HERDR_TLH_HEARTBEAT_MS: "0" }),
    sendRequest: async (request) => calls.push(request),
    now: timers.now,
    timers,
    idleDebounceMs: 10,
  });
  let sessionPath = "/tmp/first.jsonl";
  const ctx = () => ({
    mode: "tui",
    sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "session-1" },
  });
  reporter.handleSessionStart(ctx());
  reporter.handleSnapshot({
    inProgress: false,
    waitingForUser: true,
    primaryReasons: [],
    activeAsyncJobIds: [],
  });
  timers.advance(10);
  await flushAsyncWork();
  sessionPath = "/tmp/second.jsonl";
  reporter.handleSessionStart(ctx());
  await flushAsyncWork();
  const stateCalls = calls.filter((call) => call.method === "pane.report_agent");
  assert.deepEqual(
    stateCalls.map((call) => call.params.state),
    ["blocked", "blocked"],
  );
  assert.deepEqual(stateCalls[0].params.resume_argv, ["tlh", "--session", "/tmp/first.jsonl"]);
  assert.deepEqual(stateCalls[1].params.resume_argv, ["tlh", "--session", "/tmp/second.jsonl"]);
  assert.ok(stateCalls[1].params.seq > stateCalls[0].params.seq);
  reporter.dispose();
});
