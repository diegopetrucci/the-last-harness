/**
 * Dispatch-time credential preflight tests.
 *
 * Tests the integration between the primary-agent-runtime tool_call hook and
 * the session-scoped ProviderAuthHealthStore. Validates that:
 *  - the preflight is invoked for the expected provider
 *  - healthy providers are never re-probed
 *  - the throttle holds within the backoff window
 *  - the throttle allows a probe after the backoff expires
 *  - dispatch proceeds (returns undefined) even after a confirmed failure
 *  - the turn_end clearing pass re-probes reauth-required providers
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createProviderAuthHealthStore } from "../extensions/the-last-harness/provider-auth-health.ts";
import { extractDispatchProviders } from "../extensions/the-last-harness/primary-agent-runtime.ts";
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

/**
 * Build a minimal ExtensionContext for tool_call tests.
 * `getProviderAuth` controls what the preflight call does.
 */
function createToolCallCtx({
  getProviderAuth,
  model = { provider: "anthropic", id: "claude-opus-4" },
} = {}) {
  return {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
    ui: {
      notify() {},
    },
    modelRegistry: {
      getAvailable: () => [model],
      ...(getProviderAuth ? { getProviderAuth } : {}),
    },
    model,
  };
}

/**
 * Build a subagent tool-call event with a mutated model already set (as
 * applyProviderAwareSubagentModels would produce).
 */
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
 * Build a parallel-tasks subagent event with multiple model entries.
 */
function parallelSubagentEvent(models) {
  return {
    toolName: "subagent",
    input: {
      tasks: models.map((m, i) => ({
        agent: "contrarian",
        task: `Task ${i}`,
        model: m,
      })),
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

// ---------------------------------------------------------------------------
// extractDispatchProviders
// ---------------------------------------------------------------------------

test("extractDispatchProviders: extracts provider from single model string", () => {
  const providers = extractDispatchProviders({
    model: "anthropic/claude-opus-4",
    agent: "contrarian",
    task: "t",
  });
  assert.deepEqual([...providers], ["anthropic"]);
});

test("extractDispatchProviders: extracts providers from parallel tasks", () => {
  const providers = extractDispatchProviders({
    tasks: [
      { model: "anthropic/claude-opus-4", agent: "contrarian", task: "t1" },
      { model: "openai-codex/gpt-5.6-luna", agent: "developer", task: "t2" },
    ],
  });
  assert.deepEqual([...providers].sort(), ["anthropic", "openai-codex"]);
});

test("extractDispatchProviders: deduplicates same provider across tasks", () => {
  const providers = extractDispatchProviders({
    tasks: [
      { model: "anthropic/claude-opus-4", agent: "contrarian", task: "t1" },
      { model: "anthropic/claude-sonnet-4-6", agent: "librarian", task: "t2" },
    ],
  });
  assert.deepEqual([...providers], ["anthropic"]);
});

test("extractDispatchProviders: returns empty array for input with no model fields", () => {
  const providers = extractDispatchProviders({ agent: "contrarian", task: "t" });
  assert.deepEqual([...providers], []);
});

test("extractDispatchProviders: returns empty array for non-object input", () => {
  assert.deepEqual([...extractDispatchProviders(null)], []);
  assert.deepEqual([...extractDispatchProviders("string")], []);
  assert.deepEqual([...extractDispatchProviders(42)], []);
});

test("extractDispatchProviders: skips model strings without a provider slash", () => {
  const providers = extractDispatchProviders({ model: "bare-model-name" });
  assert.deepEqual([...providers], []);
});

// ---------------------------------------------------------------------------
// Dispatch-time preflight: probe IS invoked for provider in the input
// ---------------------------------------------------------------------------

test("auth failure at dispatch records reauth-required in store", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
      name: "ModelsError",
      code: "oauth",
      cause: Object.assign(new Error("invalid_grant"), {}),
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

    const ctx = createToolCallCtx({
      getProviderAuth,
      model: { provider: "anthropic", id: "claude-opus-4" },
    });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };

    const event = subagentEvent("anthropic/claude-opus-4");

    // tool_call must return undefined (not block) even when a preflight is scheduled.
    const result = await toolCall(event, ctx);
    assert.equal(result, undefined, "dispatch must not be blocked by a preflight failure");

    // Wait for the fire-and-forget preflight to settle.
    await new Promise((r) => setImmediate(r));

    // The probe must have been called exactly once.
    assert.equal(probeCallCount, 1, "preflight probe must be called once at dispatch");

    // The store must reflect the failure.
    const entry = store.getEntry("anthropic");
    assert.ok(entry !== undefined, "store entry must be recorded");
    assert.equal(entry.status, "reauth-required", "failure must be classified reauth-required");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Healthy providers are never re-probed
// ---------------------------------------------------------------------------

test("healthy provider is not probed again on subsequent dispatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: probe runs, records healthy.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "first dispatch should probe");
    assert.equal(store.getEntry("anthropic")?.status, "healthy");

    // Second dispatch: provider is healthy — must NOT re-probe.
    clock.advance(1000);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "healthy provider must not be re-probed");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Throttle holds within the backoff window
// ---------------------------------------------------------------------------

test("throttle prevents re-probing a failed provider before backoff expires (60 s)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: probe runs, records failure, sets throttle.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "first dispatch should probe");

    // Advance 30 s — still within the 60 s backoff window.
    clock.advance(30_000);

    // Second dispatch within throttle window: must NOT probe again.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "probe must be suppressed within backoff window");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Throttle allows a probe after backoff expires
// ---------------------------------------------------------------------------

test("throttle allows re-probe after 60 s backoff window expires", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: probe, failure recorded.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);

    // Advance 61 s — past the 60 s backoff window.
    clock.advance(61_000);

    // Dispatch again: throttle has expired, probe should run.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "probe must be allowed after backoff window expires");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Successful re-probe clears the failure flag
// ---------------------------------------------------------------------------

test("successful re-probe after failure clears reauth-required status", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;
  let shouldFail = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    if (shouldFail) {
      throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
        name: "ModelsError",
        code: "oauth",
        cause: new Error("invalid_grant"),
      });
    }
    // Success (simulates user re-authenticated).
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: failure.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

    // User re-authenticates; next probe will succeed.
    shouldFail = false;

    // Advance past 60 s backoff so throttle allows a re-probe.
    clock.advance(61_000);

    // Second dispatch: successful probe should clear the flag.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2);
    assert.equal(
      store.getEntry("anthropic")?.status,
      "healthy",
      "status must be cleared to healthy after successful re-probe",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// turn_end clearing pass
// ---------------------------------------------------------------------------

test("turn_end re-probes reauth-required providers when outside backoff window", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    // Always fail so provider stays reauth-required.
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
    const turnEnd = pi.events.find((e) => e.name === "turn_end")?.handler;
    assert.ok(toolCall, "tool_call handler must be registered");
    assert.ok(turnEnd, "turn_end handler must be registered");

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };

    // Dispatch: probe, failure recorded.
    const event = subagentEvent("anthropic/claude-opus-4");
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

    // Advance past backoff window.
    clock.advance(61_000);

    // turn_end: clearing pass should re-probe the reauth-required provider.
    turnEnd({}, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "turn_end must trigger re-probe of reauth-required provider");
  });

  cleanupTempDir(fixture);
});

test("turn_end does NOT probe healthy providers", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    // Always succeed.
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };

    // Dispatch: probe runs, records healthy.
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);
    assert.equal(store.getEntry("anthropic")?.status, "healthy");

    // turn_end: no reauth-required providers — must not probe.
    clock.advance(120_000);
    turnEnd({}, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "turn_end must not probe a healthy provider");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Dispatch proceeds unchanged after confirmed failure (warn, do not reroute)
// ---------------------------------------------------------------------------

test("dispatch returns undefined and leaves model unchanged after preflight failure", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
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
    assert.ok(toolCall);

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    const result = await toolCall(event, ctx);

    // Dispatch must not be blocked.
    assert.equal(result, undefined, "handler must return undefined (allow dispatch)");
    // Model in the event input must not be changed.
    assert.equal(
      event.input.model,
      "anthropic/claude-opus-4",
      "model must be unchanged after preflight failure",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Parallel dispatch deduplication
// ---------------------------------------------------------------------------

test("parallel dispatch with same provider in multiple tasks only probes once", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };

    // Parallel dispatch with two tasks for the same provider.
    const event = parallelSubagentEvent(["anthropic/claude-opus-4", "anthropic/claude-sonnet-4-6"]);

    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));

    // extractDispatchProviders deduplicates; the store also coalesces in-flight.
    // Either mechanism is acceptable — what matters is the probe count.
    assert.equal(probeCallCount, 1, "same provider in multiple tasks must be probed only once");
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// transient-unavailable and unknown are retried, not permanently silenced
// ---------------------------------------------------------------------------

test("transient on first dispatch then reauth on second dispatch (after backoff) produces warning", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;
  let firstProbe = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    if (firstProbe) {
      // First call: network blip → transient-unavailable.
      firstProbe = false;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }
    // Second call (after user re-attempt and clock advance): dead refresh token.
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: transient error — provider enters transient-unavailable.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "first dispatch must probe");
    assert.equal(store.getEntry("anthropic")?.status, "transient-unavailable");

    // Advance past the 60 s backoff window.
    clock.advance(61_000);

    // Second dispatch: transient-unavailable must NOT be silenced — probe runs,
    // this time the dead refresh token produces reauth-required.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "transient provider must be re-probed after backoff");
    assert.equal(
      store.getEntry("anthropic")?.status,
      "reauth-required",
      "second probe must surface the dead credential as reauth-required",
    );
  });

  cleanupTempDir(fixture);
});

test("transient within backoff window is NOT re-probed at dispatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: transient error.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);
    assert.equal(store.getEntry("anthropic")?.status, "transient-unavailable");

    // Advance only 30 s — still within the 60 s window.
    clock.advance(30_000);

    // Second dispatch: throttled — must not re-probe.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "transient must be throttled within backoff window");
  });

  cleanupTempDir(fixture);
});

test("unknown status is retried after backoff, not permanently silenced", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;
  let firstProbe = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    if (firstProbe) {
      firstProbe = false;
      throw new Error("some unexpected internal error"); // → unknown
    }
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // First dispatch: unknown result.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);
    assert.equal(store.getEntry("anthropic")?.status, "unknown");

    // Advance past backoff.
    clock.advance(61_000);

    // Second dispatch: unknown must be retried, producing reauth-required this time.
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "unknown status must be retried after backoff");
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
  });

  cleanupTempDir(fixture);
});

test("turn_end clears transient-unavailable provider after backoff, not just reauth-required", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;
  let firstProbe = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    if (firstProbe) {
      firstProbe = false;
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }
    // Transient resolved on retry.
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };

    // Dispatch: transient error recorded.
    await toolCall(subagentEvent("anthropic/claude-opus-4"), ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1);
    assert.equal(store.getEntry("anthropic")?.status, "transient-unavailable");

    // Advance past backoff.
    clock.advance(61_000);

    // turn_end: must re-probe the transient provider (not only reauth-required ones).
    turnEnd({}, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "turn_end must re-probe transient-unavailable after backoff");
    assert.equal(
      store.getEntry("anthropic")?.status,
      "healthy",
      "provider clears to healthy after successful re-probe",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Finding 3 — dispatch-safety guarantees (genuine regression tests)
// ---------------------------------------------------------------------------

/** Session branch entries that select the rush primary agent. */
const RUSH_BRANCH = [
  {
    type: "custom",
    customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
    data: { selected: "rush" },
  },
];

/** Build a developer subagent tool-call event. */
function developerEvent(model) {
  return {
    toolName: "subagent",
    input: {
      agent: "developer",
      task: "Implement the feature",
      model,
    },
  };
}

test("tool_call returns before an unresolved getProviderAuth probe settles", async (t) => {
  // This test can only pass if the handler truly fires-and-forgets the probe.
  // If the handler awaits the probe, it would hang here forever (the promise
  // passed to getProviderAuth never resolves).
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeStarted = false;

  const store = createProviderAuthHealthStore({ now: clock.now });

  // A probe that starts but never settles.
  const getProviderAuth = () => {
    probeStarted = true;
    return new Promise(() => {
      // Intentionally never resolved or rejected.
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

    const ctx = createToolCallCtx({
      getProviderAuth,
      model: { provider: "anthropic", id: "claude-opus-4" },
    });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // If the handler awaited the probe, this line would never resolve and the
    // test would hang, failing by timeout.
    const result = await toolCall(event, ctx);

    assert.equal(result, undefined, "handler must return undefined without awaiting the probe");

    // The probe must have been started (confirms the preflight ran, not just skipped).
    assert.ok(probeStarted, "probe must have been invoked before tool_call returned");

    // The store must have no entry yet: the probe is still in flight, so the
    // store cannot have been updated. This confirms tool_call returned before
    // the probe settled.
    assert.equal(
      store.getEntry("anthropic"),
      undefined,
      "store must have no entry while probe is still in flight — confirms early return",
    );
  });

  cleanupTempDir(fixture);
});

test("blocked tool call performs zero credential calls", async (t) => {
  // The preflight is scheduled AFTER all block/authorization checks.
  // A blocked dispatch must never reach the preflight code.
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
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

    // Rush selection + developer subagent → blocked before any preflight code is reached.
    const ctx = createToolCallCtx({
      getProviderAuth,
      model: { provider: "anthropic", id: "claude-opus-4" },
    });
    ctx.sessionManager = { getBranch: () => RUSH_BRANCH };

    const event = developerEvent("anthropic/claude-opus-4");
    const result = await toolCall(event, ctx);

    await new Promise((r) => setImmediate(r));

    assert.ok(result?.block === true, "dispatch must be blocked for rush + developer");
    assert.equal(
      probeCallCount,
      0,
      "blocked tool call must perform zero credential calls — preflight must not run",
    );
  });

  cleanupTempDir(fixture);
});

test("backoff escalates 60s → 120s → 300s and resets to no-throttle after successful probe", async (t) => {
  // Validates the full escalation ladder and that a successful probe clears
  // the throttle entirely so the next failure restarts from 60 s, not 300 s.
  const fixture = createIsolatedProfileFixture("tlh-preflight-test-", { cwd: true, test: t });
  const clock = createClock(1_000_000);
  let probeCallCount = 0;
  let shouldFail = true;

  const store = createProviderAuthHealthStore({ now: clock.now });
  const getProviderAuth = async () => {
    probeCallCount += 1;
    if (shouldFail) {
      throw Object.assign(new Error("OAuth refresh failed for anthropic"), {
        name: "ModelsError",
        code: "oauth",
        cause: new Error("invalid_grant"),
      });
    }
    // Success — simulates user re-authenticated.
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

    const ctx = createToolCallCtx({ getProviderAuth });
    ctx.sessionManager = { getBranch: () => ARCHITECT_BRANCH };
    const event = subagentEvent("anthropic/claude-opus-4");

    // ---- Failure 1: starts the 60 s backoff ----
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "first dispatch must probe");
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

    // Still within 60 s: throttled.
    clock.advance(59_999);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 1, "probe must be suppressed within 60 s backoff");

    // ---- Failure 2: escalates to 120 s backoff ----
    clock.advance(2); // now 60_001 ms past failure 1
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "probe must be allowed after 60 s backoff expires");

    // Still within 120 s: throttled.
    clock.advance(119_999);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 2, "probe must be suppressed within 120 s backoff");

    // ---- Failure 3: escalates to 300 s backoff ----
    clock.advance(2); // now 120_001 ms past failure 2
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 3, "probe must be allowed after 120 s backoff expires");

    // Still within 300 s: throttled.
    clock.advance(299_999);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 3, "probe must be suppressed within 300 s backoff");

    // ---- Success: resets throttle entirely ----
    shouldFail = false;
    clock.advance(2); // now 300_001 ms past failure 3
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 4, "probe must be allowed after 300 s backoff expires");
    assert.equal(store.getEntry("anthropic")?.status, "healthy", "probe must clear status");

    // Simulate re-entry into failure so we can verify the backoff truly reset.
    // After success, throttle is deleted; a new failure starts from 60 s again.
    store.recordRunLevelAuthObservation("anthropic"); // re-enter reauth-required
    shouldFail = true;

    // Advance only 1 ms (way inside any backoff window) — but throttle was
    // deleted by the success probe, so the provider is probed immediately.
    clock.advance(1);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(
      probeCallCount,
      5,
      "after throttle reset, next dispatch must probe immediately (no residual backoff)",
    );
    assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

    // And the new failure must reinstate the 60 s (not 300 s) backoff.
    clock.advance(59_999);
    await toolCall(event, ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(probeCallCount, 5, "after reset, first re-failure must set 60 s backoff again");
  });

  cleanupTempDir(fixture);
});
