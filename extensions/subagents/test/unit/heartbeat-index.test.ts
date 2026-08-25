/**
 * Extension-level heartbeat tests (finding F-2, F-3 — round-3 item 4a).
 *
 * These tests go through the real index.ts hook registration and emit actual
 * extension events, proving that index.ts registers and orders the handlers
 * correctly.  They use the execFileSync pattern from index-child-registration.test.ts
 * so that each test runs in an isolated Node process with full import resolution.
 *
 * Covered scenarios:
 *  1. agent_settled re-arm: after before_agent_start disarms the gap, firing
 *     agent_settled with a live async job re-opens the gap (timer re-armed).
 *  2. session_start restored-jobs re-arm: session_start triggers tryRearm for
 *     any live jobs that were restored by restoreActiveJobs.
 *  3. session_before_switch disclosure: firing session_before_switch calls
 *     disarm() and emits the heartbeat-gap-summary session entry BEFORE teardown
 *     for beat-bearing gaps.
 *  4. session_before_fork disclosure: same as above for session_before_fork.
 *
 * Note on harness constraints: The async-job tracker (async-job-tracker.ts)
 * requires real filesystem state (asyncDir + status.json) for jobs to
 * transition to "running" status.  These tests emit SUBAGENT_ASYNC_STARTED_EVENT
 * with "queued" status semantics (the job is added to asyncJobs immediately on
 * the started event, before any file poll), which countLiveAsyncRuns counts.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, after } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Temp dirs created during this test suite — cleaned up after. */
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

/**
 * Create a temp agent dir containing a heartbeat-enabled subagent config.
 * Returns the dir path; the caller is responsible for cleanup (registered
 * in `tempDirs` for suite-level cleanup).
 */
function makeHeartbeatAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-hb-index-test-"));
  tempDirs.push(dir);
  const configDir = path.join(dir, "extensions", "subagent");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ heartbeat: { enabled: true, intervalMs: 255000 } }),
    "utf-8",
  );
  return dir;
}

function testEnv(agentDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  env["PI_CODING_AGENT_DIR"] = agentDir;
  return env;
}

function runScript(script: string, agentDir: string): void {
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./test/support/register-loader.mjs",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: projectRoot, env: testEnv(agentDir), stdio: "pipe" },
  );
}

// ---------------------------------------------------------------------------
// Test 1: agent_settled re-arms the heartbeat after a parent turn
// ---------------------------------------------------------------------------

describe("heartbeat index.ts — agent_settled re-arm (finding F-2)", () => {
  it("fires agent_settled handler after a parent turn and re-arms when a live async job exists", () => {
    const agentDir = makeHeartbeatAgentDir();
    const script = String.raw`
      import assert from "node:assert/strict";
      import registerSubagentExtension from "./src/extension/index.ts";
      import { SUBAGENT_ASYNC_STARTED_EVENT } from "./src/shared/types.ts";

      // Track setTimeout calls so we can observe gap (re-)arming.
      const timerCallbacks = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn, ms) => {
        timerCallbacks.push({ fn, ms });
        return { unref() {} };
      };
      global.clearTimeout = () => {};

      const extensionHandlers = new Map();
      const eventBusListeners = new Map();
      const entries = [];
      const fakePi = new Proxy({
        events: {
          on(channel, handler) {
            const set = eventBusListeners.get(channel) ?? new Set();
            set.add(handler);
            eventBusListeners.set(channel, set);
            return () => {};
          },
          emit(channel, payload) {
            for (const h of eventBusListeners.get(channel) ?? []) h(payload);
          },
        },
        on(type, handler) {
          const arr = extensionHandlers.get(type) ?? [];
          arr.push(handler);
          extensionHandlers.set(type, arr);
        },
        appendEntry(type, data) { entries.push({ type, data }); },
        registerEntryRenderer() {},
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer() {},
        sendMessage() {},
        getSessionName() { return undefined; },
      }, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => undefined;
        },
      });

      registerSubagentExtension(fakePi);

      // Verify that agent_settled handler was registered.
      assert.ok(extensionHandlers.has("agent_settled"), "index.ts must register agent_settled handler");

      const makeCtx = (sessionId) => ({
        cwd: process.cwd(),
        hasUI: false,
        isIdle: () => true,
        sessionManager: {
          getSessionId() { return sessionId; },
          getSessionFile() { return null; },
        },
        modelRegistry: { getAvailable() { return []; } },
        model: {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      });

      const emitPiEvent = async (type, event, ctx) => {
        for (const h of extensionHandlers.get(type) ?? []) await h(event, ctx);
      };

      const SESSION_ID = "hb-agent-settled-test";
      const ctx = makeCtx(SESSION_ID);

      // 1. session_start: sets up heartbeat ctx + idle state.
      await emitPiEvent("session_start", { type: "session_start", reason: "startup" }, ctx);

      // 2. Emit ASYNC_STARTED to open a gap and add a job to asyncJobs.
      //    hbStartedHandler fires first (asyncJobs empty → notifyAsyncStarted(0)) → gap opens.
      //    handleStarted fires second → adds job to asyncJobs.
      fakePi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
        id: "job-hb-1",
        sessionId: SESSION_ID,
        mode: "single",
        agent: "worker",
        asyncDir: "/tmp/hb-async-job-1",
      });

      // Gap is open: at least one timer should be scheduled.
      const timersAfterGapOpen = timerCallbacks.length;
      assert.ok(timersAfterGapOpen > 0, "gap open must schedule a heartbeat timer");

      // 3. before_agent_start: disarms the gap (onIdle(false) + disarm()).
      await emitPiEvent("before_agent_start", { type: "before_agent_start" }, ctx);

      // Gap is now closed; no entry emitted (0 beats).
      const timersAfterDisarm = timerCallbacks.length;

      // 4. agent_settled: re-arms because asyncJobs has one live job.
      await emitPiEvent("agent_settled", { type: "agent_settled" }, ctx);

      // A new timer must have been scheduled (gap re-opened).
      assert.ok(
        timerCallbacks.length > timersAfterDisarm,
        "agent_settled must re-arm the heartbeat timer when a live async job exists; " +
        "timers before agent_settled: " + String(timersAfterDisarm) +
        ", timers after: " + String(timerCallbacks.length),
      );
    `;
    runScript(script, agentDir);
  });
});

// ---------------------------------------------------------------------------
// Test 2: session_start re-arms for live jobs via idle + async start
// ---------------------------------------------------------------------------

describe("heartbeat index.ts — session_start idle setup and re-arm (finding F-2)", () => {
  it("session_start handler is registered and sets up idle/ctx so async start arms the heartbeat", () => {
    // Note: the 'restored-jobs from disk' scenario (restoreActiveJobs finding persisted
    // status.json files) requires real filesystem state that is complex to create in a
    // unit test. That path is covered at the wiring level (heartbeat-wiring.test.ts:
    // 'tryRearm arms gap when session_start restores live async jobs'). This
    // extension-level test verifies that index.ts registers the session_start handler,
    // correctly captures heartbeatSessionCtx, sets idle state, and that a subsequent
    // async start correctly opens a gap — proving the handler ordering is correct.
    const agentDir = makeHeartbeatAgentDir();
    const script = String.raw`
      import assert from "node:assert/strict";
      import registerSubagentExtension from "./src/extension/index.ts";
      import { SUBAGENT_ASYNC_STARTED_EVENT } from "./src/shared/types.ts";

      const timerCallbacks = [];
      global.setTimeout = (fn, ms) => {
        timerCallbacks.push({ fn, ms });
        return { unref() {} };
      };
      global.clearTimeout = () => {};

      const extensionHandlers = new Map();
      const eventBusListeners = new Map();
      const fakePi = new Proxy({
        events: {
          on(channel, handler) {
            const set = eventBusListeners.get(channel) ?? new Set();
            set.add(handler);
            eventBusListeners.set(channel, set);
            return () => {};
          },
          emit(channel, payload) {
            for (const h of eventBusListeners.get(channel) ?? []) h(payload);
          },
        },
        on(type, handler) {
          const arr = extensionHandlers.get(type) ?? [];
          arr.push(handler);
          extensionHandlers.set(type, arr);
        },
        appendEntry() {},
        registerEntryRenderer() {},
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer() {},
        sendMessage() {},
        getSessionName() { return undefined; },
      }, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => undefined;
        },
      });

      registerSubagentExtension(fakePi);

      assert.ok(
        extensionHandlers.has("session_start"),
        "index.ts must register session_start handler",
      );

      const SESSION_ID = "hb-session-start-idle";
      const makeCtx = () => ({
        cwd: process.cwd(),
        hasUI: false,
        isIdle: () => true,
        sessionManager: {
          getSessionId() { return SESSION_ID; },
          getSessionFile() { return null; },
        },
        modelRegistry: { getAvailable() { return []; } },
        model: undefined,
      });

      const emitPiEvent = async (type, event, ctx) => {
        for (const h of extensionHandlers.get(type) ?? []) await h(event, ctx);
      };

      // 1. session_start: sets up heartbeatSessionCtx and idle state.
      //    Without live disk jobs, tryRearm(0, ...) won’t open a gap.
      await emitPiEvent("session_start", { type: "session_start", reason: "startup" }, makeCtx());
      const timersAfterStart = timerCallbacks.length;

      // 2. Emit ASYNC_STARTED to open a gap (liveRunsBefore=0 → notifyAsyncStarted(0)).
      //    This also exercises that state.currentSessionId was correctly captured by
      //    session_start (handleStarted filters by sessionId).
      fakePi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
        id: "job-session-start-1",
        sessionId: SESSION_ID,
        mode: "single",
        agent: "worker",
        asyncDir: "/tmp/hb-async-session-start-1",
      });

      // Gap is now open: a timer must be scheduled.
      assert.ok(
        timerCallbacks.length > timersAfterStart,
        "ASYNC_STARTED after session_start must open a gap and arm a timer; " +
        "timers after session_start: " + String(timersAfterStart) +
        ", timers after ASYNC_STARTED: " + String(timerCallbacks.length),
      );
    `;
    runScript(script, agentDir);
  });
});

// ---------------------------------------------------------------------------
// Test 3: session_before_switch emits disclosure entry before teardown
// ---------------------------------------------------------------------------

describe("heartbeat index.ts — session_before_switch/fork disclosure (finding F-3)", () => {
  it("session_before_switch emits heartbeat-gap-summary entry for a beat-bearing gap before destroy", () => {
    const agentDir = makeHeartbeatAgentDir();
    const script = String.raw`
      import assert from "node:assert/strict";
      import registerSubagentExtension from "./src/extension/index.ts";
      import { SUBAGENT_ASYNC_STARTED_EVENT } from "./src/shared/types.ts";

      // Fake setTimeout to fire callbacks IMMEDIATELY so onBeatIssued is called
      // synchronously (before any await) within the same event loop turn.
      // This makes executedBeats > 0 before session_before_switch fires.
      const timerCallbacks = [];
      global.setTimeout = (fn, ms) => {
        // Fire synchronously so the beat's onBeatIssued (synchronous part of
        // the async executeBeat function) runs before we emit session_before_switch.
        timerCallbacks.push({ fn, ms });
        // Do NOT fire synchronously here \u2014 fire after gap is confirmed open.
        return { unref() {} };
      };
      global.clearTimeout = () => {};

      const extensionHandlers = new Map();
      const eventBusListeners = new Map();
      const entries = [];
      const fakePi = new Proxy({
        events: {
          on(channel, handler) {
            const set = eventBusListeners.get(channel) ?? new Set();
            set.add(handler);
            eventBusListeners.set(channel, set);
            return () => {};
          },
          emit(channel, payload) {
            for (const h of eventBusListeners.get(channel) ?? []) h(payload);
          },
        },
        on(type, handler) {
          const arr = extensionHandlers.get(type) ?? [];
          arr.push(handler);
          extensionHandlers.set(type, arr);
        },
        appendEntry(type, data) { entries.push({ type, data }); },
        registerEntryRenderer() {},
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer() {},
        sendMessage() {},
        getSessionName() { return undefined; },
      }, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => undefined;
        },
      });

      registerSubagentExtension(fakePi);

      assert.ok(
        extensionHandlers.has("session_before_switch"),
        "index.ts must register session_before_switch handler when heartbeat is enabled",
      );
      assert.ok(
        extensionHandlers.has("session_before_fork"),
        "index.ts must register session_before_fork handler when heartbeat is enabled",
      );

      const SESSION_ID = "hb-switch-test";
      const makeCtx = () => ({
        cwd: process.cwd(),
        hasUI: false,
        isIdle: () => true,
        sessionManager: {
          getSessionId() { return SESSION_ID; },
          getSessionFile() { return null; },
        },
        modelRegistry: { getAvailable() { return []; } },
        model: {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      });

      const emitPiEvent = async (type, event, ctx) => {
        for (const h of extensionHandlers.get(type) ?? []) await h(event, ctx);
      };

      // 1. session_start: sets up heartbeat ctx + idle state.
      await emitPiEvent("session_start", { type: "session_start", reason: "startup" }, makeCtx());

      // 2. Capture a payload so the controller has a capture ready.
      await emitPiEvent(
        "before_provider_request",
        { type: "before_provider_request", payload: { messages: [] } },
        makeCtx(),
      );

      // 3. Open a gap via ASYNC_STARTED.
      fakePi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
        id: "job-switch-1",
        sessionId: SESSION_ID,
        mode: "single",
        agent: "worker",
        asyncDir: "/tmp/hb-async-switch-1",
      });

      // A timer should be scheduled now.
      assert.ok(timerCallbacks.length > 0, "gap open must schedule a heartbeat timer");

      // 4. Fire the timer synchronously \u2014 the timer callback runs onTimerFire() which:
      //    a) Calls decideBeat (idle=true, gap active, not in-flight, elapsed < 290s) \u2192 fire.
      //    b) Calls beginBeat (state.inFlight = true).
      //    c) Calls executeBeat (async, fire-and-forget):
      //       \u2022 synchronously: calls deps.onBeatIssued \u2192 executedBeats++ (= 1)
      //       \u2022 then awaits stream (registry path, will fail \u2014 doesn\u2019t matter for this test)
      timerCallbacks[0].fn();
      // Yield to the microtask queue so onBeatIssued runs (it\u2019s the sync part of the async fn).
      await Promise.resolve();

      // 5. Emit session_before_switch \u2014 this calls hbWiring.disarm() which calls
      //    closeGapWithSummary(true).  Since executedBeats = 1, pi.appendEntry IS called.
      await emitPiEvent("session_before_switch", { type: "session_before_switch" }, makeCtx());

      const hbEntries = entries.filter((e) => e.type === "heartbeat-gap-summary");
      assert.ok(
        hbEntries.length >= 1,
        "session_before_switch must emit heartbeat-gap-summary entry before teardown; " +
        "total entries: " + String(entries.length) + ", entries: " + JSON.stringify(entries),
      );
    `;
    runScript(script, agentDir);
  });

  it("session_before_fork emits heartbeat-gap-summary entry for a beat-bearing gap before destroy", () => {
    const agentDir = makeHeartbeatAgentDir();
    // Same scenario as session_before_switch, using session_before_fork instead.
    const script = String.raw`
      import assert from "node:assert/strict";
      import registerSubagentExtension from "./src/extension/index.ts";
      import { SUBAGENT_ASYNC_STARTED_EVENT } from "./src/shared/types.ts";

      const timerCallbacks = [];
      global.setTimeout = (fn, ms) => {
        timerCallbacks.push({ fn, ms });
        return { unref() {} };
      };
      global.clearTimeout = () => {};

      const extensionHandlers = new Map();
      const eventBusListeners = new Map();
      const entries = [];
      const fakePi = new Proxy({
        events: {
          on(channel, handler) {
            const set = eventBusListeners.get(channel) ?? new Set();
            set.add(handler);
            eventBusListeners.set(channel, set);
            return () => {};
          },
          emit(channel, payload) {
            for (const h of eventBusListeners.get(channel) ?? []) h(payload);
          },
        },
        on(type, handler) {
          const arr = extensionHandlers.get(type) ?? [];
          arr.push(handler);
          extensionHandlers.set(type, arr);
        },
        appendEntry(type, data) { entries.push({ type, data }); },
        registerEntryRenderer() {},
        registerTool() {},
        registerCommand() {},
        registerShortcut() {},
        registerMessageRenderer() {},
        sendMessage() {},
        getSessionName() { return undefined; },
      }, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => undefined;
        },
      });

      registerSubagentExtension(fakePi);

      const SESSION_ID = "hb-fork-test";
      const makeCtx = () => ({
        cwd: process.cwd(),
        hasUI: false,
        isIdle: () => true,
        sessionManager: {
          getSessionId() { return SESSION_ID; },
          getSessionFile() { return null; },
        },
        modelRegistry: { getAvailable() { return []; } },
        model: {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      });

      const emitPiEvent = async (type, event, ctx) => {
        for (const h of extensionHandlers.get(type) ?? []) await h(event, ctx);
      };

      await emitPiEvent("session_start", { type: "session_start", reason: "startup" }, makeCtx());
      await emitPiEvent(
        "before_provider_request",
        { type: "before_provider_request", payload: { messages: [] } },
        makeCtx(),
      );

      fakePi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
        id: "job-fork-1",
        sessionId: SESSION_ID,
        mode: "single",
        agent: "worker",
        asyncDir: "/tmp/hb-async-fork-1",
      });

      assert.ok(timerCallbacks.length > 0, "gap open must schedule a heartbeat timer");
      timerCallbacks[0].fn();
      await Promise.resolve();

      await emitPiEvent("session_before_fork", { type: "session_before_fork" }, makeCtx());

      const hbEntries = entries.filter((e) => e.type === "heartbeat-gap-summary");
      assert.ok(
        hbEntries.length >= 1,
        "session_before_fork must emit heartbeat-gap-summary entry before teardown; " +
        "entries: " + JSON.stringify(entries),
      );
    `;
    runScript(script, agentDir);
  });
});
