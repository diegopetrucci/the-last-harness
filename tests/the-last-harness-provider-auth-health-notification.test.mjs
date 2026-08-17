/**
 * One-time actionable notification tests.
 *
 * Validates that exactly one ctx.ui.notify call (level="warning", mentioning /login)
 * is emitted when a provider first transitions into reauth-required, and that
 * subsequent probes while still flagged, transient errors, and unknown errors
 * do not emit further notifications. Also verifies re-arming after a healthy probe
 * and safe behaviour when ctx.ui is absent.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createProviderAuthHealthStore } from "../extensions/the-last-harness/provider-auth-health.ts";
import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerTlhPrimaryAgentRuntime,
  createPiHarness,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Session branch entries that select the architect primary agent. */
const ARCHITECT_BRANCH = [
  {
    type: "custom",
    customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
    data: { selected: "architect" },
  },
];

/**
 * Create a test ctx that records notify calls and supports provider auth injection.
 * Returns { ctx, notifyCalls }.
 * notifyCalls is an array of { message, level } for each ctx.ui.notify call.
 */
function createNotifyCtx({
  getProviderAuth,
  model = { provider: "anthropic", id: "claude-opus-4" },
} = {}) {
  const notifyCalls = [];
  const ctx = {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => ARCHITECT_BRANCH },
    ui: {
      notify(message, level) {
        notifyCalls.push({ message, level });
      },
    },
    modelRegistry: {
      getAvailable: () => [model],
      ...(getProviderAuth !== undefined ? { getProviderAuth } : {}),
    },
    model,
  };
  return { ctx, notifyCalls };
}

/**
 * Count notify calls that are the reauth actionable warning (level=warning, message includes /login).
 */
function countReauthWarnings(notifyCalls) {
  return notifyCalls.filter((c) => c.level === "warning" && c.message.includes("/login")).length;
}

/** Build a subagent tool-call event for a given model string. */
function subagentEvent(model) {
  return {
    toolName: "subagent",
    input: {
      agent: "contrarian",
      task: "Stress-test the plan",
      model,
    },
  };
}

/**
 * Build a tool_result event with a Details payload that records a fallback with
 * an auth error on the given provider.
 */
function subagentToolResultWithAuthFallback(provider, model) {
  return {
    toolName: "subagent",
    details: {
      results: [
        {
          agent: "contrarian",
          status: "completed",
          modelAttempts: [
            {
              model: `${provider}/${model}`,
              success: false,
              error: "OAuth refresh failed: invalid_grant",
            },
            {
              model: "openai-codex/gpt-5.6-luna",
              success: true,
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch-path notification (scheduleProviderPreflight → reauth-required)
// ---------------------------------------------------------------------------

test("emits exactly one notification when provider first transitions into reauth-required", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall, "tool_call handler must be registered");

    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // First dispatch: probe fails → reauth-required → one notification.
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "exactly one reauth warning must be emitted on first transition",
    );

    // Advance past backoff window; probe again — still failing.
    clock.advance(61_000);
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "repeated probe while still reauth-required must NOT emit another notification",
    );
  });

  cleanupTempDir(fixture);
});

test("does not notify for repeated probes while provider remains reauth-required", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCount += 1;
    throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);
    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // First dispatch: probe fires → reauth-required → notify (count = 1).
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCount, 1, "first dispatch must probe");
    assert.equal(countReauthWarnings(notifyCalls), 1, "first probe must emit one notification");

    // Advance past the first backoff (60 s); second probe fires → still reauth-required → no re-notify.
    clock.advance(61_000);
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCount, 2, "second dispatch must probe after backoff expires");
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "second probe while still reauth-required must NOT emit another notification",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Re-arm after healthy → failed again
// ---------------------------------------------------------------------------

test("re-arms and emits a second notification after provider returns to healthy then fails again", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let shouldFail = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    if (shouldFail) {
      throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
        name: "ModelsError",
        code: "oauth",
        cause: new Error("invalid_grant"),
      });
    }
    // Success — simulates re-authentication.
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);
    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // First dispatch: failure → reauth-required → notify (count = 1).
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(countReauthWarnings(notifyCalls), 1, "first failure must notify");

    // User re-authenticates; advance past backoff; probe succeeds → healthy → re-armed.
    shouldFail = false;
    clock.advance(61_000);
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(store.getEntry("anthropic")?.status, "healthy");
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "healthy probe must not emit another notification",
    );

    // Simulate a subsequent credential expiry: record a run-level observation to
    // re-enter reauth-required (as would happen after a live run's fallback).
    store.recordRunLevelAuthObservation("anthropic");
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
    shouldFail = true;

    // Dispatch again: non-healthy + no throttle → probes → reauth-required → re-armed → notify again.
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      countReauthWarnings(notifyCalls),
      2,
      "second genuine failure after re-arm must emit a new notification",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// No notification for transient-unavailable or unknown
// ---------------------------------------------------------------------------

test("does not notify for transient-unavailable status", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);
    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(store.getEntry("anthropic")?.status, "transient-unavailable");
    assert.equal(
      countReauthWarnings(notifyCalls),
      0,
      "transient-unavailable must not emit a reauth notification",
    );
  });

  cleanupTempDir(fixture);
});

test("does not notify for unknown status", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw new Error("some unrecognised internal provider error");
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);
    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(store.getEntry("anthropic")?.status, "unknown");
    assert.equal(
      countReauthWarnings(notifyCalls),
      0,
      "unknown status must not emit a reauth notification",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// No throw when ctx.ui is absent
// ---------------------------------------------------------------------------

test("does not throw when ctx.ui is absent or non-functional", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);

    // ctx without a ui object — simulates a non-interactive or headless context.
    const ctxWithoutUi = {
      cwd: process.cwd(),
      sessionManager: { getBranch: () => ARCHITECT_BRANCH },
      ui: undefined,
      modelRegistry: {
        getAvailable: () => [],
        getProviderAuth,
      },
      model: { provider: "anthropic", id: "claude-opus-4" },
    };

    // Must not throw into the tool_call dispatch path.
    await assert.doesNotReject(async () => {
      await toolCall(subagentEvent("anthropic/claude-opus-4"), ctxWithoutUi);
      await new Promise((r) => setImmediate(r));
    }, "dispatch path must not throw when ctx.ui is absent");

    // ctx with a throwing ui.notify — simulates non-interactive mode.
    clock.advance(61_000);
    const ctxWithThrowingUi = {
      cwd: process.cwd(),
      sessionManager: { getBranch: () => ARCHITECT_BRANCH },
      ui: {
        notify() {
          throw new Error("ui.notify is not available in this mode");
        },
      },
      modelRegistry: {
        getAvailable: () => [],
        getProviderAuth,
      },
      model: { provider: "anthropic", id: "claude-opus-4" },
    };

    // Must not throw even when ui.notify throws.
    await assert.doesNotReject(async () => {
      await toolCall(subagentEvent("anthropic/claude-opus-4"), ctxWithThrowingUi);
      await new Promise((r) => setImmediate(r));
    }, "dispatch path must not throw when ctx.ui.notify throws");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// turn_end clearing pass also emits notification on first reauth-required
// ---------------------------------------------------------------------------

test("turn_end clearing pass emits notification when probe first returns reauth-required", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    const turnEnd = pi.events.find((e) => e.name === "turn_end")?.handler;
    assert.ok(toolCall);
    assert.ok(turnEnd);

    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // First dispatch: failure → notify (count = 1).
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(countReauthWarnings(notifyCalls), 1);

    // Advance past backoff; turn_end re-probes → still reauth-required → must NOT re-notify.
    clock.advance(61_000);
    turnEnd({}, ctx);
    await new Promise((r) => setImmediate(r));

    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "turn_end re-probe while still reauth-required must not emit another notification",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// tool_result path: notify on run-level auth observation (new transition)
// ---------------------------------------------------------------------------

test("tool_result path emits notification when run-level observation newly sets reauth-required", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });

  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    const toolResult = pi.events.find((e) => e.name === "tool_result")?.handler;
    assert.ok(toolResult, "tool_result handler must be registered");

    const { ctx, notifyCalls } = createNotifyCtx();

    await toolResult(subagentToolResultWithAuthFallback("anthropic", "claude-opus-4"), ctx);

    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "tool_result auth fallback must emit exactly one reauth notification",
    );
  });

  cleanupTempDir(fixture);
});

test("tool_result path does not re-notify for a provider already notified via dispatch probe", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    const toolResult = pi.events.find((e) => e.name === "tool_result")?.handler;
    assert.ok(toolCall);
    assert.ok(toolResult);

    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // Dispatch: probe → reauth-required → notify (count = 1).
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(countReauthWarnings(notifyCalls), 1);

    // Subsequent tool_result also records a run-level observation for anthropic,
    // but the provider is already in notifiedForReauth → must NOT re-notify.
    await toolResult(subagentToolResultWithAuthFallback("anthropic", "claude-opus-4"), ctx);

    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "tool_result must not re-notify a provider already notified via probe",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Notification message content
// ---------------------------------------------------------------------------

test("notification message names the provider and mentions /login", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall);
    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    const reauth = notifyCalls.find((c) => c.level === "warning" && c.message.includes("/login"));
    assert.ok(reauth, "a reauth warning notification must have been emitted");
    assert.ok(reauth.message.includes("anthropic"), "notification must name the affected provider");
    assert.ok(reauth.message.includes("/login"), "notification must reference the /login command");
    assert.ok(
      reauth.message.toLowerCase().includes("code-reviewer") ||
        reauth.message.toLowerCase().includes("oracle") ||
        reauth.message.toLowerCase().includes("contrarian"),
      "notification must mention the affected subagents (code-reviewer, oracle, or contrarian)",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Finding 2a — async-path notification: intent flushed on next turn_end
// ---------------------------------------------------------------------------

test("async-complete path: notification is emitted on next turn_end before clearing probe can run", async (t) => {
  // In the revoked-but-unexpired scenario:
  //  1. async-complete fires → provider enters reauth-required → no ctx → intent recorded.
  //  2. turn_end fires → flush intent (sync) BEFORE scheduling the clearing probe (async).
  //  3. Clearing probe eventually returns healthy → clears status.
  // The user must be notified even though the probe would mark the provider healthy.
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });

  // The clearing probe always returns healthy (simulates revoked-but-unexpired token).
  const getProviderAuth = async () => {
    // Succeeds: local OAuth refresh says the token is still valid.
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const turnEnd = pi.events.find((e) => e.name === "turn_end")?.handler;
    assert.ok(turnEnd, "turn_end handler must be registered");

    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // Emit async-complete with an auth fallback — provider enters reauth-required.
    // There is no ctx at this point; notification intent must be stored.
    const asyncCompletePayload = {
      runId: "async-run-001",
      results: [
        {
          agent: "contrarian",
          status: "completed",
          modelAttempts: [
            {
              model: "anthropic/claude-opus-4",
              success: false,
              error: "OAuth refresh failed: invalid_grant",
            },
            {
              model: "openai-codex/gpt-5.6-luna",
              success: true,
            },
          ],
        },
      ],
    };
    pi.events.emit("subagent:async-complete", asyncCompletePayload);

    // Store must reflect reauth-required from the async-complete observation.
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
    // No notification yet (no ctx was available during async-complete).
    assert.equal(countReauthWarnings(notifyCalls), 0, "no notification before turn_end");

    // turn_end fires: flush intent BEFORE the clearing probe can run.
    turnEnd({}, ctx);

    // At this point (still sync within the test) the notification must have been
    // emitted — the flush is synchronous, the clearing probe is fire-and-forget.
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "turn_end must emit the pending notification before the clearing probe runs",
    );

    // Let the clearing probe settle (it returns healthy, which would clear the status).
    await new Promise((r) => setImmediate(r));

    // The notification count must still be 1 — we were told despite the probe clearing.
    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "notification count must remain 1 even after the clearing probe marks provider healthy",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Finding 2(a) — dispatch probe returning healthy must not erase async-path intent
// ---------------------------------------------------------------------------

test("async-complete intent survives a healthy dispatch probe — notification fires at turn_end", async (t) => {
  // This is the exact race Finding 2(a) describes:
  //  1. Async run fails with a live 401 → store flags reauth-required, intent recorded.
  //  2. The architect dispatches more work in the same turn → dispatch probe scheduled.
  //  3. Probe returns healthy (revoked-but-unexpired: local check cannot see revocation).
  //  4. In the buggy code, line 773 deleted the pending intent → silence at turn_end.
  //  5. Fixed code preserves the intent → user notified at turn_end regardless.
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });

  // The dispatch probe always returns healthy (revoked-but-unexpired simulation).
  const getProviderAuth = async () => {
    // Succeeds: token not locally expired, revocation invisible to local probe.
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    const turnEnd = pi.events.find((e) => e.name === "turn_end")?.handler;
    assert.ok(toolCall, "tool_call handler must be registered");
    assert.ok(turnEnd, "turn_end handler must be registered");

    const { ctx, notifyCalls } = createNotifyCtx({ getProviderAuth });

    // Step 1: async-complete fires — auth fallback observed, intent recorded, no ctx to notify.
    pi.events.emit("subagent:async-complete", {
      runId: "async-run-race-001",
      results: [
        {
          agent: "contrarian",
          status: "completed",
          modelAttempts: [
            {
              model: "anthropic/claude-opus-4",
              success: false,
              error: "OAuth refresh failed: invalid_grant",
            },
            {
              model: "openai-codex/gpt-5.6-luna",
              success: true,
            },
          ],
        },
      ],
    });

    assert.equal(
      store.getEntry("anthropic")?.status,
      "reauth-required",
      "store must flag anthropic",
    );
    assert.equal(
      countReauthWarnings(notifyCalls),
      0,
      "no notification yet — no ctx in async-complete handler",
    );

    // Step 2: the architect dispatches more work → dispatch probe fires → returns healthy.
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));

    // Probe returned healthy: store cleared, throttle deleted, notifiedForReauth re-armed.
    // In buggy code, the pending intent was also deleted here.
    assert.equal(
      store.getEntry("anthropic")?.status,
      "healthy",
      "healthy probe must clear store status",
    );
    assert.equal(countReauthWarnings(notifyCalls), 0, "no notification from a healthy probe");

    // Step 3: turn_end fires — must flush the pending intent regardless of current store status.
    turnEnd({}, ctx);

    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "turn_end must emit the run-level notification even though the store is now healthy — " +
        "the async-path evidence must not be lost to a healthy probe",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Finding 2b — mark notified only after notify returns without throwing
// ---------------------------------------------------------------------------

test("provider can be notified on retry when ctx.ui.notify threw on a previous call", async (t) => {
  // If ctx.ui.notify throws, the provider must NOT be permanently suppressed.
  // A subsequent call with a working ctx must still emit the notification.
  const fixture = createIsolatedProfileFixture("tlh-notify-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
      name: "ModelsError",
      code: "oauth",
      cause: new Error("invalid_grant"),
    });
  };

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
      now: clock.now,
    });

    const toolCall = pi.events.find((e) => e.name === "tool_call")?.handler;
    assert.ok(toolCall, "tool_call handler must be registered");

    // First ctx: notify always throws — provider must NOT be marked notified.
    let throwCount = 0;
    const ctxWithThrowingUi = {
      cwd: process.cwd(),
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "architect" },
          },
        ],
      },
      ui: {
        notify() {
          throwCount += 1;
          throw new Error("ui.notify is not available in this mode");
        },
      },
      modelRegistry: {
        getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4" }],
        getProviderAuth,
      },
      model: { provider: "anthropic", id: "claude-opus-4" },
    };

    // First dispatch: probe fails → tries to notify → notify throws → NOT marked.
    await assert.doesNotReject(async () => {
      await toolCall(subagentEvent("anthropic/claude-opus-4"), ctxWithThrowingUi);
      await new Promise((r) => setImmediate(r));
    }, "throwing notify must not escape into the dispatch path");

    assert.equal(throwCount, 1, "notify must have been attempted once");
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

    // Second dispatch: advance past the 60 s backoff; this time use a working ctx.
    clock.advance(61_000);

    const { ctx: workingCtx, notifyCalls } = createNotifyCtx({ getProviderAuth });
    workingCtx.sessionManager = {
      getBranch: () => [
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "architect" },
        },
      ],
    };

    await toolCall(subagentEvent("anthropic/claude-opus-4"), workingCtx);
    await new Promise((r) => setImmediate(r));

    assert.equal(
      countReauthWarnings(notifyCalls),
      1,
      "provider must be notifiable on retry when prior notify threw — must not be permanently suppressed",
    );
  });

  cleanupTempDir(fixture);
});
