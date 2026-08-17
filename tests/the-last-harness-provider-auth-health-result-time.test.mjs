/**
 * Result-time auth-health observation tests.
 *
 * Validates:
 *   - tool_result handler reads modelAttempts (not top-level error) to detect fallback
 *   - High-confidence auth signature in a failed attempt flags the attempt's provider
 *   - A successful fallback (final result OK, failing attempt had auth error) is still detected
 *   - Non-auth fallbacks (rate limit, model unavailable, transient) flag nothing
 *   - No fallback (single attempt) flags nothing
 *   - Malformed / missing details payloads do not crash or flag anything
 *   - Async parity: subagent:async-complete event is observed; immediate tool_result with
 *     empty results (async launch) is correctly ignored
 *   - Run-level observation is preserved even when a subsequent successful probe fires
 *   - Provider is attributed from the FAILING attempt's model, not the run's final model
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createProviderAuthHealthStore } from "../extensions/the-last-harness/provider-auth-health.ts";
import {
  isHighConfidenceAuthSignatureInAttemptError,
  processSubagentRunDetails,
} from "../extensions/the-last-harness/primary-agent-runtime.ts";
import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerTlhPrimaryAgentRuntime,
  createPiHarness,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Session branch entries that select the architect primary agent. */
const ARCHITECT_BRANCH = [
  {
    type: "custom",
    customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
    data: { selected: "architect" },
  },
];

function createToolResultCtx({ getProviderAuth } = {}) {
  return {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => ARCHITECT_BRANCH },
    ui: { notify() {} },
    modelRegistry: {
      getAvailable: () => [],
      ...(getProviderAuth ? { getProviderAuth } : {}),
    },
    model: { provider: "anthropic", id: "claude-opus-4" },
  };
}

/**
 * Build a tool_result event for the subagent tool.
 * `details` is the raw details payload (will be passed as unknown).
 */
function subagentToolResultEvent(details) {
  return { toolName: "subagent", details };
}

/**
 * Build a Details payload with the given modelAttempts on the single result.
 */
function detailsWithAttempts(modelAttempts) {
  return {
    results: [
      {
        agent: "contrarian",
        status: "completed",
        modelAttempts,
      },
    ],
  };
}

/**
 * Build a single ModelAttempt fixture.
 */
function attempt(model, success, error) {
  const a = { model, success };
  if (error !== undefined) a.error = error;
  return a;
}

// ---------------------------------------------------------------------------
// isHighConfidenceAuthSignatureInAttemptError unit tests
// ---------------------------------------------------------------------------

test("isHighConfidenceAuthSignatureInAttemptError: invalid_grant → true", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError("OAuth refresh failed: invalid_grant"),
    true,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: token refresh unauthorized → true", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError(
      "Kimi Code token refresh unauthorized (status 401)",
    ),
    true,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: status 401 embedded → true", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError("Provider rejected request: status 401"),
    true,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: status 403 embedded → true", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError("Provider rejected request: status 403"),
    true,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: rate limit (429) → false", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError("Rate limit exceeded (429): too many requests"),
    false,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: model unavailable → false", () => {
  assert.equal(
    isHighConfidenceAuthSignatureInAttemptError("Model claude-opus-4 is not available"),
    false,
  );
});

test("isHighConfidenceAuthSignatureInAttemptError: transient network error → false", () => {
  assert.equal(isHighConfidenceAuthSignatureInAttemptError("fetch failed: ECONNREFUSED"), false);
});

test("isHighConfidenceAuthSignatureInAttemptError: server error 500 → false", () => {
  assert.equal(isHighConfidenceAuthSignatureInAttemptError("Internal server error (500)"), false);
});

test("isHighConfidenceAuthSignatureInAttemptError: empty string → false", () => {
  assert.equal(isHighConfidenceAuthSignatureInAttemptError(""), false);
});

test("isHighConfidenceAuthSignatureInAttemptError: case-insensitive match → true", () => {
  assert.equal(isHighConfidenceAuthSignatureInAttemptError("INVALID_GRANT error"), true);
});

// ---------------------------------------------------------------------------
// processSubagentRunDetails unit tests
// ---------------------------------------------------------------------------

test("processSubagentRunDetails: high-confidence auth error in failed attempt flags provider", () => {
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt("anthropic/claude-opus-4", false, "OAuth refresh failed for anthropic: invalid_grant"),
    attempt("openai-codex/gpt-5.6-luna", true, undefined),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(store.getEntry("anthropic")?.status, "reauth-required");
  assert.equal(store.getEntry("openai-codex"), undefined, "successful attempt must not be flagged");
});

test("processSubagentRunDetails: provider attributed from failing attempt model, not final model", () => {
  // Successful fallback: first attempt failed for anthropic, final succeeded on openai-codex.
  // The run's final model is openai-codex, but the auth error belongs to anthropic.
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt("anthropic/claude-opus-4", false, "token refresh unauthorized (status 401)"),
    attempt("openai-codex/gpt-5.6-luna", true, undefined),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(
    store.getEntry("anthropic")?.status,
    "reauth-required",
    "anthropic must be flagged even though the run ended successfully on openai-codex",
  );
  assert.equal(
    store.getEntry("openai-codex"),
    undefined,
    "openai-codex must not be flagged (it was the successful fallback)",
  );
});

test("processSubagentRunDetails: non-auth fallback (rate limit) flags nothing", () => {
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt("anthropic/claude-opus-4", false, "Rate limit exceeded (429): too many requests"),
    attempt("openai-codex/gpt-5.6-luna", true, undefined),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(
    store.getEntry("anthropic"),
    undefined,
    "rate-limit error must not trigger auth observation",
  );
  assert.equal(store.getEntry("openai-codex"), undefined);
});

test("processSubagentRunDetails: non-auth fallback (model unavailable) flags nothing", () => {
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt(
      "anthropic/claude-opus-4",
      false,
      "Model claude-opus-4 is not available in this region",
    ),
    attempt("openai-codex/gpt-5.6-luna", true, undefined),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(store.getEntry("anthropic"), undefined);
});

test("processSubagentRunDetails: non-auth fallback (transient network) flags nothing", () => {
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt("anthropic/claude-opus-4", false, "fetch failed: ECONNREFUSED"),
    attempt("openai-codex/gpt-5.6-luna", true, undefined),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(store.getEntry("anthropic"), undefined);
});

test("processSubagentRunDetails: single attempt with auth error IS observed (no fallback candidate is not an excuse)", () => {
  // A lone attempt that failed with an auth error is precisely the case where
  // no fallback candidate existed and the run simply died. The user needs the
  // warning most in this scenario — the absence of a fallback is not a reason to
  // skip. The inner success === false + classification check already filters
  // non-auth errors; the only guard needed is modelAttempts being an array.
  const store = createProviderAuthHealthStore();
  const details = detailsWithAttempts([
    attempt("anthropic/claude-opus-4", false, "OAuth refresh failed: invalid_grant"),
  ]);
  processSubagentRunDetails(details, store);
  assert.equal(
    store.getEntry("anthropic")?.status,
    "reauth-required",
    "single-attempt auth failure must be observed; absence of a fallback is not a reason to skip",
  );
});

// ---------------------------------------------------------------------------
// Malformed / boundary payload tests (TypeScript boundaries skill)
// ---------------------------------------------------------------------------

test("processSubagentRunDetails: null details → no crash, no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails(null, store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: undefined details → no crash, no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails(undefined, store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: string details → no crash, no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails("not an object", store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: details with no results field → no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails({ mode: "foreground" }, store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: results not an array → no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails({ results: "oops" }, store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: result with modelAttempts not an array → no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails({ results: [{ modelAttempts: "bad" }] }, store);
  assert.equal(store.getReauthProviders().length, 0);
});

test("processSubagentRunDetails: attempt with missing model field → skipped, no crash", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails(
    {
      results: [
        {
          modelAttempts: [
            { success: false, error: "invalid_grant" }, // no model
            { model: "anthropic/claude-opus-4", success: true },
          ],
        },
      ],
    },
    store,
  );
  assert.equal(store.getReauthProviders().length, 0, "attempt without model must be skipped");
});

test("processSubagentRunDetails: attempt with non-string error → skipped, no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails(
    {
      results: [
        {
          modelAttempts: [
            {
              model: "anthropic/claude-opus-4",
              success: false,
              error: { nested: "invalid_grant" },
            },
            { model: "openai-codex/gpt-5.6-luna", success: true },
          ],
        },
      ],
    },
    store,
  );
  assert.equal(store.getReauthProviders().length, 0, "non-string error must be skipped");
});

test("processSubagentRunDetails: attempt with model missing slash → skipped, no flag", () => {
  const store = createProviderAuthHealthStore();
  processSubagentRunDetails(
    {
      results: [
        {
          modelAttempts: [
            { model: "baremodel", success: false, error: "invalid_grant" },
            { model: "anthropic/claude-opus-4", success: true },
          ],
        },
      ],
    },
    store,
  );
  assert.equal(
    store.getReauthProviders().length,
    0,
    "model without provider slash must be skipped",
  );
});

test("processSubagentRunDetails: multiple results, only auth failure result flags provider", () => {
  const store = createProviderAuthHealthStore();
  const details = {
    results: [
      // First result: no fallback
      { agent: "a", modelAttempts: [attempt("anthropic/claude-opus-4", true, undefined)] },
      // Second result: fallback with auth error
      {
        agent: "b",
        modelAttempts: [
          attempt("openai-codex/gpt-5.6-luna", false, "token refresh unauthorized (status 401)"),
          attempt("anthropic/claude-opus-4", true, undefined),
        ],
      },
    ],
  };
  processSubagentRunDetails(details, store);
  assert.equal(store.getEntry("openai-codex")?.status, "reauth-required");
  assert.equal(store.getEntry("anthropic"), undefined);
});

// ---------------------------------------------------------------------------
// Run-level observation + probe clearability
// ---------------------------------------------------------------------------

test("run-level observation sets reauth-required, then successful probe clears it to healthy", async () => {
  // Regression guard: a run-level observation must NOT permanently lock the footer warning.
  // Once the user re-authenticates (or the probe otherwise passes), the footer must clear.
  // If this test fails, the warning has become unclearable for the session.
  const store = createProviderAuthHealthStore();
  const registry = {
    getProviderAuth: async () => {
      /* always succeeds */
    },
  };

  // Record a run-level observation (e.g. from a fallback with invalid_grant).
  store.recordRunLevelAuthObservation("anthropic");
  assert.equal(
    store.getEntry("anthropic")?.status,
    "reauth-required",
    "run-level observation must record reauth-required",
  );
  assert.deepEqual(store.getReauthProviders(), ["anthropic"]);

  // A successful probe (e.g. from turn_end clearing pass after user re-auths) must clear.
  await store.probeProvider(registry, "anthropic");

  assert.equal(
    store.getEntry("anthropic")?.status,
    "healthy",
    "footer warning must clear to healthy after a successful probe — even for run-level observations",
  );
  assert.deepEqual(
    store.getReauthProviders(),
    [],
    "provider must no longer appear in the reauth list after probe success",
  );
});

test("clearProvider records healthy and removes run-level record", async () => {
  const store = createProviderAuthHealthStore();
  store.recordRunLevelAuthObservation("anthropic");
  assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

  store.clearProvider("anthropic");
  assert.equal(store.getEntry("anthropic")?.status, "healthy", "clearProvider must set healthy");
  assert.deepEqual(store.getReauthProviders(), []);
});

// ---------------------------------------------------------------------------
// tool_result handler integration test
// ---------------------------------------------------------------------------

test("tool_result handler for subagent: auth failure in fallback attempt flags provider in store", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
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

    const ctx = createToolResultCtx();
    const details = detailsWithAttempts([
      attempt("anthropic/claude-opus-4", false, "OAuth refresh failed: invalid_grant"),
      attempt("openai-codex/gpt-5.6-luna", true, undefined),
    ]);
    await toolResult(subagentToolResultEvent(details), ctx);

    assert.equal(
      store.getEntry("anthropic")?.status,
      "reauth-required",
      "anthropic must be flagged after tool_result with auth failure in fallback attempt",
    );
    assert.equal(
      store.getEntry("openai-codex"),
      undefined,
      "openai-codex must not be flagged (it was the successful fallback)",
    );
  });

  cleanupTempDir(fixture);
});

test("tool_result handler: non-subagent tool names are ignored", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    const toolResult = pi.events.find((e) => e.name === "tool_result")?.handler;
    assert.ok(toolResult);

    const ctx = createToolResultCtx();
    // Bash tool result with auth-looking details should not touch the store
    await toolResult(
      {
        toolName: "bash",
        details: detailsWithAttempts([
          attempt("anthropic/claude-opus-4", false, "invalid_grant"),
          attempt("openai-codex/gpt-5.6-luna", true, undefined),
        ]),
      },
      ctx,
    );
    assert.equal(store.getReauthProviders().length, 0);
  });

  cleanupTempDir(fixture);
});

test("tool_result handler: non-auth fallback does not flag provider", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    const toolResult = pi.events.find((e) => e.name === "tool_result")?.handler;
    assert.ok(toolResult);

    const ctx = createToolResultCtx();
    const details = detailsWithAttempts([
      attempt("anthropic/claude-opus-4", false, "Rate limit exceeded (429): too many requests"),
      attempt("openai-codex/gpt-5.6-luna", true, undefined),
    ]);
    await toolResult(subagentToolResultEvent(details), ctx);

    assert.equal(
      store.getReauthProviders().length,
      0,
      "rate-limit fallback must not produce an auth warning",
    );
  });

  cleanupTempDir(fixture);
});

// ---------------------------------------------------------------------------
// Async parity: subagent:async-complete event
// ---------------------------------------------------------------------------

test("async parity: subagent:async-complete with auth fallback flags provider", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    // Emit the async-complete event with a fallback that had an auth error.
    const asyncCompletePayload = {
      runId: "async-run-001",
      results: [
        {
          agent: "contrarian",
          status: "completed",
          modelAttempts: [
            attempt("anthropic/claude-opus-4", false, "token refresh unauthorized (status 401)"),
            attempt("openai-codex/gpt-5.6-luna", true, undefined),
          ],
        },
      ],
    };

    pi.events.emit("subagent:async-complete", asyncCompletePayload);

    assert.equal(
      store.getEntry("anthropic")?.status,
      "reauth-required",
      "async-complete must flag the provider from the failing attempt",
    );
    assert.equal(store.getEntry("openai-codex"), undefined);
  });

  cleanupTempDir(fixture);
});

test("async parity: immediate tool_result for async launch (empty results) flags nothing", async (t) => {
  // An async launch's immediate tool_result deliberately has results: [].
  // This must not flag any provider (there is no attempt history here).
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    const toolResult = pi.events.find((e) => e.name === "tool_result")?.handler;
    assert.ok(toolResult);

    const ctx = createToolResultCtx();
    // Async launch returns empty results (no attempt history yet).
    await toolResult(subagentToolResultEvent({ mode: "async", results: [] }), ctx);

    assert.equal(
      store.getReauthProviders().length,
      0,
      "empty-results async launch must flag nothing",
    );
  });

  cleanupTempDir(fixture);
});

test("async parity: subagent:async-complete non-auth fallback flags nothing", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    pi.events.emit("subagent:async-complete", {
      runId: "async-run-002",
      results: [
        {
          agent: "contrarian",
          status: "completed",
          modelAttempts: [
            attempt("anthropic/claude-opus-4", false, "Model not available in this region"),
            attempt("openai-codex/gpt-5.6-luna", true, undefined),
          ],
        },
      ],
    });

    assert.equal(store.getReauthProviders().length, 0, "async non-auth fallback must flag nothing");
  });

  cleanupTempDir(fixture);
});

test("async parity: malformed subagent:async-complete payload does not crash", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-result-time-test-", { cwd: true, test: t });
  const store = createProviderAuthHealthStore();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      subagentMetadata: [],
      getProviderAuthHealthStore: () => store,
    });

    // Should not throw for any of these malformed payloads.
    pi.events.emit("subagent:async-complete", null);
    pi.events.emit("subagent:async-complete", "string");
    pi.events.emit("subagent:async-complete", { results: "not-an-array" });
    pi.events.emit("subagent:async-complete", { results: [null, undefined, 42] });
    pi.events.emit("subagent:async-complete", 42);

    assert.equal(store.getReauthProviders().length, 0);
  });

  cleanupTempDir(fixture);
});
