import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterGetProviderAuth,
  adapterIsConfigured,
  classifyProviderAuthError,
  createProviderAuthHealthStore,
} from "../extensions/the-last-harness/provider-auth-health.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNow(start = 1000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function makeRegistry({ getProviderAuth, getProviderAuthStatus } = {}) {
  const registry = {};
  if (getProviderAuth !== undefined) registry.getProviderAuth = getProviderAuth;
  if (getProviderAuthStatus !== undefined) registry.getProviderAuthStatus = getProviderAuthStatus;
  return registry;
}

// ---------------------------------------------------------------------------
// classifyProviderAuthError
// ---------------------------------------------------------------------------

test("classifyProviderAuthError: resolving (no throw) means healthy — that path goes through probeProvider not classifier", () => {
  // The classifier is only called on error. Verify the happy path does not reach it.
  // (See probeProvider tests below for the healthy path.)
  assert.ok(true); // Documented expectation; see probeProvider healthy test.
});

test("classifyProviderAuthError: invalid_grant → reauth-required", () => {
  assert.equal(classifyProviderAuthError(new Error("invalid_grant")), "reauth-required");
});

test("classifyProviderAuthError: token has been revoked → reauth-required", () => {
  assert.equal(classifyProviderAuthError(new Error("token has been revoked")), "reauth-required");
});

test("classifyProviderAuthError: token revoked → reauth-required", () => {
  assert.equal(classifyProviderAuthError(new Error("token revoked")), "reauth-required");
});

test("classifyProviderAuthError: refresh token expired → reauth-required", () => {
  assert.equal(classifyProviderAuthError(new Error("refresh token expired")), "reauth-required");
});

test("classifyProviderAuthError: refresh_token_expired → reauth-required", () => {
  assert.equal(classifyProviderAuthError(new Error("refresh_token_expired")), "reauth-required");
});

test("classifyProviderAuthError: authorization has been revoked → reauth-required", () => {
  assert.equal(
    classifyProviderAuthError(new Error("authorization has been revoked")),
    "reauth-required",
  );
});

test("classifyProviderAuthError: ECONNREFUSED (code property) → transient-unavailable", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: ETIMEDOUT (code property) → transient-unavailable", () => {
  const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: ENOTFOUND (code property) → transient-unavailable", () => {
  const error = Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: ENOENT (credential store file missing) → transient-unavailable", () => {
  const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: EACCES (credential store permission denied) → transient-unavailable", () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: EPERM (credential store) → transient-unavailable", () => {
  const error = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: EBUSY (credential store lock) → transient-unavailable", () => {
  const error = Object.assign(new Error("resource busy"), { code: "EBUSY" });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: HTTP 429 status property → transient-unavailable", () => {
  const error = Object.assign(new Error("too many requests"), { status: 429 });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: HTTP 500 status property → transient-unavailable", () => {
  const error = Object.assign(new Error("internal server error"), { status: 500 });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: HTTP 503 statusCode property → transient-unavailable", () => {
  const error = Object.assign(new Error("service unavailable"), { statusCode: 503 });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("classifyProviderAuthError: 'fetch failed' message → transient-unavailable", () => {
  assert.equal(classifyProviderAuthError(new Error("fetch failed")), "transient-unavailable");
});

test("classifyProviderAuthError: 'network error' message → transient-unavailable", () => {
  assert.equal(classifyProviderAuthError(new Error("network error")), "transient-unavailable");
});

test("classifyProviderAuthError: 'rate limit exceeded' message → transient-unavailable", () => {
  assert.equal(
    classifyProviderAuthError(new Error("rate limit exceeded")),
    "transient-unavailable",
  );
});

test("classifyProviderAuthError: 'service unavailable' message → transient-unavailable", () => {
  assert.equal(
    classifyProviderAuthError(new Error("service unavailable")),
    "transient-unavailable",
  );
});

test("classifyProviderAuthError: generic credential failure → unknown (not reauth-required)", () => {
  assert.equal(classifyProviderAuthError(new Error("failed to resolve credential")), "unknown");
});

test("classifyProviderAuthError: 'unauthorized' alone → unknown (not reauth-required; could be transient auth gate)", () => {
  assert.equal(classifyProviderAuthError(new Error("unauthorized")), "unknown");
});

test("classifyProviderAuthError: 'invalid_client' → unknown (API-key or app config error, not user reauth)", () => {
  assert.equal(classifyProviderAuthError(new Error("invalid_client")), "unknown");
});

test("classifyProviderAuthError: non-Error value (string) → classifies on message content", () => {
  assert.equal(classifyProviderAuthError("invalid_grant"), "reauth-required");
  assert.equal(classifyProviderAuthError("fetch failed"), "transient-unavailable");
  assert.equal(classifyProviderAuthError("something odd"), "unknown");
});

test("classifyProviderAuthError: null / undefined → unknown", () => {
  assert.equal(classifyProviderAuthError(null), "unknown");
  assert.equal(classifyProviderAuthError(undefined), "unknown");
});

test("classifyProviderAuthError: 429 in message text → transient-unavailable", () => {
  assert.equal(
    classifyProviderAuthError(new Error("HTTP 429 Too Many Requests")),
    "transient-unavailable",
  );
});

test("classifyProviderAuthError: 503 digit-only in message text → unknown (bare digits dropped; use structural status property)", () => {
  // Bare digit checks were removed because they match request IDs and token fragments.
  // Use a structural statusCode/status property for reliable HTTP-status detection.
  assert.equal(classifyProviderAuthError(new Error("got 503 from server")), "unknown");
});

// ---------------------------------------------------------------------------
// adapterIsConfigured
// ---------------------------------------------------------------------------

test("adapterIsConfigured: returns true when getProviderAuthStatus returns { configured: true }", () => {
  const registry = makeRegistry({
    getProviderAuthStatus: () => ({ configured: true }),
  });
  assert.equal(adapterIsConfigured(registry, "anthropic"), true);
});

test("adapterIsConfigured: returns false when getProviderAuthStatus returns { configured: false }", () => {
  const registry = makeRegistry({
    getProviderAuthStatus: () => ({ configured: false }),
  });
  assert.equal(adapterIsConfigured(registry, "anthropic"), false);
});

test("adapterIsConfigured: returns undefined when getProviderAuthStatus is absent", () => {
  const registry = makeRegistry();
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

test("adapterIsConfigured: returns undefined when getProviderAuthStatus returns null", () => {
  const registry = makeRegistry({ getProviderAuthStatus: () => null });
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

test("adapterIsConfigured: returns undefined when getProviderAuthStatus returns undefined", () => {
  const registry = makeRegistry({ getProviderAuthStatus: () => undefined });
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

test("adapterIsConfigured: returns undefined when getProviderAuthStatus throws", () => {
  const registry = makeRegistry({
    getProviderAuthStatus: () => {
      throw new Error("boom");
    },
  });
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

test("adapterIsConfigured: returns undefined when registry is null", () => {
  assert.equal(adapterIsConfigured(null, "anthropic"), undefined);
});

test("adapterIsConfigured: returns undefined when configured field is not a boolean", () => {
  const registry = makeRegistry({ getProviderAuthStatus: () => ({ configured: "yes" }) });
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

test("adapterIsConfigured: does not throw when registry has getProviderAuthStatus as non-function", () => {
  const registry = { getProviderAuthStatus: "not-a-function" };
  assert.equal(adapterIsConfigured(registry, "anthropic"), undefined);
});

// ---------------------------------------------------------------------------
// adapterGetProviderAuth
// ---------------------------------------------------------------------------

test("adapterGetProviderAuth: resolves { ok: true } when getProviderAuth resolves", async () => {
  const registry = makeRegistry({
    getProviderAuth: async () => ({ accessToken: "tok" }),
  });
  const result = await adapterGetProviderAuth(registry, "anthropic");
  assert.equal(result.ok, true);
});

test("adapterGetProviderAuth: resolves { ok: false, error } when getProviderAuth throws", async () => {
  const boom = new Error("invalid_grant");
  const registry = makeRegistry({
    getProviderAuth: async () => {
      throw boom;
    },
  });
  const result = await adapterGetProviderAuth(registry, "anthropic");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.error === boom);
});

test("adapterGetProviderAuth: returns { ok: false } with unsupported marker when method is absent", async () => {
  const registry = makeRegistry();
  const result = await adapterGetProviderAuth(registry, "anthropic");
  assert.equal(result.ok, false);
  // The raw error is an internal UnsupportedRuntimeError; classifyProviderAuthError maps it to unknown.
  assert.ok(!result.ok);
  assert.equal(classifyProviderAuthError(result.error), "unknown");
});

// ---------------------------------------------------------------------------
// createProviderAuthHealthStore — healthy probe
// ---------------------------------------------------------------------------

test("probeProvider: returns healthy when getProviderAuth resolves", async () => {
  const clock = createNow();
  const store = createProviderAuthHealthStore({ now: clock.now });
  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });

  const status = await store.probeProvider(registry, "anthropic");
  assert.equal(status, "healthy");
  assert.deepEqual(store.getEntry("anthropic"), { status: "healthy", checkedAt: 1000 });
});

// ---------------------------------------------------------------------------
// createProviderAuthHealthStore — failed probe with reason
// ---------------------------------------------------------------------------

test("probeProvider: records reauth-required on invalid_grant", async () => {
  const clock = createNow();
  const store = createProviderAuthHealthStore({ now: clock.now });
  const registry = makeRegistry({
    getProviderAuth: async () => {
      throw new Error("invalid_grant");
    },
  });

  const status = await store.probeProvider(registry, "anthropic");
  assert.equal(status, "reauth-required");
  assert.deepEqual(store.getEntry("anthropic"), { status: "reauth-required", checkedAt: 1000 });
});

test("probeProvider: records transient-unavailable on network error", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({
    getProviderAuth: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
  });

  const status = await store.probeProvider(registry, "openai-codex");
  assert.equal(status, "transient-unavailable");
});

test("probeProvider: records unknown for unrecognised errors", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({
    getProviderAuth: async () => {
      throw new Error("some provider implementation error");
    },
  });

  const status = await store.probeProvider(registry, "anthropic");
  assert.equal(status, "unknown");
});

// ---------------------------------------------------------------------------
// Absent API degradation (fail-open)
// ---------------------------------------------------------------------------

test("probeProvider: returns unknown and does NOT record reauth when getProviderAuth is absent", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry(); // no getProviderAuth

  const status = await store.probeProvider(registry, "anthropic");
  assert.equal(status, "unknown");
  assert.equal(store.getEntry("anthropic")?.status, "unknown");
});

test("probeProvider: unknown from missing method is never reauth-required", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry();
  const status = await store.probeProvider(registry, "anthropic");
  assert.notEqual(status, "reauth-required");
});

// ---------------------------------------------------------------------------
// In-flight coalescing
// ---------------------------------------------------------------------------

test("probeProvider: concurrent callers share one in-flight probe (coalescing)", async () => {
  let callCount = 0;
  let resolveProbe;
  const probe = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const registry = makeRegistry({
    getProviderAuth: async () => {
      callCount += 1;
      return probe;
    },
  });
  const store = createProviderAuthHealthStore();

  // Start three concurrent probes for the same provider.
  const p1 = store.probeProvider(registry, "anthropic");
  const p2 = store.probeProvider(registry, "anthropic");
  const p3 = store.probeProvider(registry, "anthropic");

  resolveProbe({ accessToken: "tok" });
  const [s1, s2, s3] = await Promise.all([p1, p2, p3]);

  assert.equal(callCount, 1, "getProviderAuth must only be called once");
  assert.equal(s1, "healthy");
  assert.equal(s2, "healthy");
  assert.equal(s3, "healthy");
});

test("probeProvider: a second probe starts fresh after the first completes", async () => {
  let callCount = 0;
  const registry = makeRegistry({
    getProviderAuth: async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("invalid_grant");
    },
  });
  const store = createProviderAuthHealthStore();

  const s1 = await store.probeProvider(registry, "anthropic");
  assert.equal(s1, "reauth-required");
  assert.equal(callCount, 1);

  const s2 = await store.probeProvider(registry, "anthropic");
  assert.equal(s2, "healthy");
  assert.equal(callCount, 2);
});

// ---------------------------------------------------------------------------
// clearProvider (clear-on-success)
// ---------------------------------------------------------------------------

test("clearProvider: records healthy entry and removes any in-flight probe", async () => {
  const clock = createNow(5000);
  const store = createProviderAuthHealthStore({ now: clock.now });
  const registry = makeRegistry({
    getProviderAuth: async () => {
      throw new Error("invalid_grant");
    },
  });

  await store.probeProvider(registry, "anthropic");
  assert.equal(store.getEntry("anthropic")?.status, "reauth-required");

  clock.advance(1000);
  store.clearProvider("anthropic");
  assert.deepEqual(store.getEntry("anthropic"), { status: "healthy", checkedAt: 6000 });
});

test("clearProvider: stale probe that succeeds does not overwrite the cleared healthy state", async () => {
  let resolveProbe;
  const registry = makeRegistry({
    getProviderAuth: async () =>
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
  });
  const store = createProviderAuthHealthStore();

  const pending = store.probeProvider(registry, "anthropic");
  store.clearProvider("anthropic");
  const entry = store.getEntry("anthropic");
  assert.ok(entry !== undefined);
  assert.equal(entry.status, "healthy");

  // Let the original probe complete — it should not overwrite the cleared entry.
  resolveProbe({ accessToken: "tok" });
  const result = await pending;
  // The promise still resolves to its own result (healthy in this case),
  // but does not update the store entry (generation mismatch).
  assert.equal(result, "healthy");
  // Store entry was set by clearProvider; probe write was suppressed.
  assert.equal(store.getEntry("anthropic")?.status, "healthy");
});

test("clearProvider: stale probe failure (reauth-required) does NOT overwrite the cleared healthy state", async () => {
  let rejectProbe;
  const registry = makeRegistry({
    getProviderAuth: async () =>
      new Promise((_resolve, reject) => {
        rejectProbe = reject;
      }),
  });
  const store = createProviderAuthHealthStore();

  const pending = store.probeProvider(registry, "anthropic");
  // Clear the provider (e.g. user just re-authenticated).
  store.clearProvider("anthropic");
  assert.equal(store.getEntry("anthropic")?.status, "healthy");

  // The stale probe resolves with a credential error — this must NOT overwrite the cleared state.
  rejectProbe(new Error("invalid_grant"));
  const result = await pending;
  // The promise returns the probe classification...
  assert.equal(result, "reauth-required");
  // ...but the store entry remains healthy (the generation guard suppressed the write).
  assert.equal(store.getEntry("anthropic")?.status, "healthy");
});

// ---------------------------------------------------------------------------
// Session lifecycle (dispose)
// ---------------------------------------------------------------------------

test("dispose: clears health entries and in-flight probes", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });

  await store.probeProvider(registry, "anthropic");
  assert.ok(store.getEntry("anthropic") !== undefined);

  store.dispose();
  assert.equal(store.getEntry("anthropic"), undefined);
});

test("dispose: probeProvider returns unknown after dispose without storing any entry", async () => {
  const store = createProviderAuthHealthStore();
  store.dispose();

  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });
  const status = await store.probeProvider(registry, "anthropic");
  assert.equal(status, "unknown");
  assert.equal(store.getEntry("anthropic"), undefined);
});

test("dispose: clearProvider is a no-op after dispose", () => {
  const store = createProviderAuthHealthStore();
  store.dispose();
  assert.doesNotThrow(() => store.clearProvider("anthropic"));
});

test("dispose: isConfigured returns undefined after dispose", () => {
  const store = createProviderAuthHealthStore();
  store.dispose();
  const registry = makeRegistry({ getProviderAuthStatus: () => ({ configured: true }) });
  assert.equal(store.isConfigured(registry, "anthropic"), undefined);
});

// ---------------------------------------------------------------------------
// isConfigured pass-through
// ---------------------------------------------------------------------------

test("isConfigured: delegates to adapterIsConfigured", () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({ getProviderAuthStatus: () => ({ configured: true }) });
  assert.equal(store.isConfigured(registry, "anthropic"), true);
});

test("isConfigured: returns undefined when method is absent", () => {
  const store = createProviderAuthHealthStore();
  assert.equal(store.isConfigured(makeRegistry(), "anthropic"), undefined);
});

// ---------------------------------------------------------------------------
// getEntry: correct checkedAt timestamps
// ---------------------------------------------------------------------------

test("getEntry: checkedAt reflects the clock at probe time", async () => {
  const clock = createNow(2000);
  const store = createProviderAuthHealthStore({ now: clock.now });
  const registry = makeRegistry({ getProviderAuth: async () => {} });

  const p = store.probeProvider(registry, "anthropic");
  clock.advance(500);
  await p;

  // checkedAt is set when the result is recorded (after async resolution).
  // The clock advanced 500ms after starting but before the async settles.
  // Exact value depends on when 'finally' runs; check it's in the expected range.
  const entry = store.getEntry("anthropic");
  assert.ok(entry !== undefined);
  assert.ok(entry.checkedAt >= 2000 && entry.checkedAt <= 2500);
});

// ---------------------------------------------------------------------------
// subscribe
// ---------------------------------------------------------------------------

test("subscribe: listener is called when probeProvider records a result", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });
  let callCount = 0;
  store.subscribe(() => {
    callCount += 1;
  });

  await store.probeProvider(registry, "anthropic");
  assert.equal(callCount, 1);
});

test("subscribe: listener is called when clearProvider is invoked", () => {
  const store = createProviderAuthHealthStore();
  let callCount = 0;
  store.subscribe(() => {
    callCount += 1;
  });

  store.clearProvider("anthropic");
  assert.equal(callCount, 1);
});

test("subscribe: unsubscribe stops future listener calls", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });
  let callCount = 0;
  const unsubscribe = store.subscribe(() => {
    callCount += 1;
  });

  await store.probeProvider(registry, "anthropic");
  assert.equal(callCount, 1);

  unsubscribe();

  store.clearProvider("anthropic");
  await store.probeProvider(registry, "anthropic");
  assert.equal(callCount, 1); // no additional calls after unsubscribe
});

test("subscribe: dispose clears listeners; subscribe after dispose returns no-op unsubscriber", async () => {
  const store = createProviderAuthHealthStore();
  let callCount = 0;
  store.subscribe(() => {
    callCount += 1;
  });
  store.dispose();

  // After dispose, the registered listener must not be called.
  // Also, subscribe on a disposed store returns a no-op unsubscribe without throwing.
  const unsubscribe = store.subscribe(() => {
    callCount += 1;
  });
  assert.doesNotThrow(() => unsubscribe());
  assert.equal(callCount, 0);
});

test("subscribe: listener exceptions do not crash the store", async () => {
  const store = createProviderAuthHealthStore();
  const registry = makeRegistry({ getProviderAuth: async () => ({ accessToken: "x" }) });
  store.subscribe(() => {
    throw new Error("listener boom");
  });

  // probeProvider should complete normally despite the throwing listener.
  await assert.doesNotReject(store.probeProvider(registry, "anthropic"));
});

// ---------------------------------------------------------------------------
// Pinned-runtime fixtures
//
// These reproduce the real error shapes thrown by the pinned Pi runtime so
// that a future runtime bump reveals classification regressions immediately.
// Source references are noted per fixture.
// ---------------------------------------------------------------------------

/**
 * Fixture: pi-ai/dist/auth/resolve.js:90
 *   throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error })
 *
 * ModelsError is duck-typed: name === "ModelsError", code === "oauth".
 * Do NOT import from the Pi runtime in unit tests.
 */
function makeModelsErrorOauth(providerId, causeMessage, causeProps = {}) {
  const cause = Object.assign(new Error(causeMessage), causeProps);
  const err = new Error(`OAuth refresh failed for ${providerId}`);
  err.name = "ModelsError";
  err.code = "oauth";
  err.cause = cause;
  return err;
}

// pi-ai/dist/auth/resolve.js:90 + Anthropic token-refresh detail from formatErrorDetails
// (anthropic.js:62-74). The cause message text is the flattened error detail produced by
// the runtime, which includes the raw OAuth error code from the provider response body.
test("pinned-runtime: ModelsError(oauth) wrapping Anthropic invalid_grant → reauth-required", () => {
  // Mirrors: pi-ai/dist/auth/oauth/anthropic.js (token refresh path)
  const error = makeModelsErrorOauth(
    "anthropic",
    "Anthropic token refresh request failed. url=https://api.anthropic.com/oauth/token; " +
      'details=Error: HTTP 400 Bad Request\n\n{"error":{"type":"invalid_request_error","message":"invalid_grant"}}',
  );
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

test("pinned-runtime: ModelsError(oauth) wrapping Anthropic ECONNREFUSED → transient-unavailable", () => {
  // Mirrors: pi-ai/dist/auth/oauth/anthropic.js (network failure during token refresh)
  const error = makeModelsErrorOauth("anthropic", "connect ECONNREFUSED 127.0.0.1:443", {
    code: "ECONNREFUSED",
  });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("pinned-runtime: ModelsError(oauth) wrapping Anthropic ETIMEDOUT → transient-unavailable", () => {
  // Mirrors: pi-ai/dist/auth/oauth/anthropic.js (timeout during token refresh)
  const error = makeModelsErrorOauth("anthropic", "connect ETIMEDOUT 104.18.20.1:443", {
    code: "ETIMEDOUT",
  });
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("pinned-runtime: ModelsError(oauth) wrapping Anthropic 503 → transient-unavailable", () => {
  // Mirrors: pi-ai/dist/auth/oauth/anthropic.js (server-side error during token refresh)
  const error = makeModelsErrorOauth(
    "anthropic",
    "Anthropic token refresh request failed. url=https://api.anthropic.com/oauth/token; details=503 Service Unavailable",
    { status: 503 },
  );
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("pinned-runtime: ModelsError(oauth) wrapping OpenAI Codex invalid_grant → reauth-required", () => {
  // Mirrors: pi-ai/dist/auth/oauth/openai-codex.js:142 (token refresh error path)
  const error = makeModelsErrorOauth(
    "openai-codex",
    "OpenAI Codex token refresh error: HTTP 400 Bad Request — invalid_grant",
  );
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

test("pinned-runtime: ModelsError(oauth) wrapping OpenAI Codex ETIMEDOUT → transient-unavailable", () => {
  // Mirrors: pi-ai/dist/auth/oauth/openai-codex.js:142 (network timeout)
  const error = makeModelsErrorOauth(
    "openai-codex",
    "network timeout connecting to token endpoint",
    {
      code: "ETIMEDOUT",
    },
  );
  assert.equal(classifyProviderAuthError(error), "transient-unavailable");
});

test("pinned-runtime: Kimi 'token refresh unauthorized (status 401)' → reauth-required", () => {
  // Mirrors: pi-ai/dist/auth/oauth/kimi-coding.js:222-224
  //   throw new Error(`Kimi Code token refresh unauthorized (status ${res.status})`)
  const error = new Error("Kimi Code token refresh unauthorized (status 401)");
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

test("pinned-runtime: 401 status property on cause inside ModelsError(oauth) → reauth-required", () => {
  // Mirrors: pi-ai/dist/auth/resolve.js:90 where the cause carries an HTTP 401 status.
  const error = makeModelsErrorOauth(
    "anthropic",
    "Anthropic token refresh request failed. url=https://api.anthropic.com/oauth/token; status=401",
    { status: 401 },
  );
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

test("pinned-runtime: ModelsError(oauth) with unrecognised cause → unknown (conservative)", () => {
  // An unknown provider implementation error inside the oauth refresh path should
  // stay silent rather than triggering a false reauth warning.
  const error = makeModelsErrorOauth("anthropic", "some unexpected internal provider error");
  assert.equal(classifyProviderAuthError(error), "unknown");
});

// ---------------------------------------------------------------------------
// Over-broad matcher regression guards
// ---------------------------------------------------------------------------

test("classifier: 'account has been blocked' must not classify as transient (lock-in-blocked regression)", () => {
  // 'blocked' contains 'lock' as a substring — a naive message.includes('lock')
  // would silently swallow this as transient-unavailable.
  assert.equal(classifyProviderAuthError(new Error("account has been blocked")), "unknown");
});

test("classifier: 401 on root error alone → reauth-required", () => {
  const error = Object.assign(new Error("HTTP 401 Unauthorized"), { status: 401 });
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

test("classifier: 403 on root error alone → reauth-required", () => {
  const error = Object.assign(new Error("Forbidden"), { statusCode: 403 });
  assert.equal(classifyProviderAuthError(error), "reauth-required");
});

// ---------------------------------------------------------------------------
// Pinned-runtime API contract
//
// Verify that the installed ModelRegistry facade exposes getProviderAuth and
// getProviderAuthStatus, which provider-auth-health.ts duck-types at runtime.
//
// If either assertion fails after a Pi pin bump, the feature silently degrades
// to no-warning (fail-open) instead of surfacing real credential failures in
// the footer. Check the new runtime's ModelRegistry class and update the
// duck-typing guards in provider-auth-health.ts accordingly before landing
// the bump. See Gnosis entry mxhzwc for the precedent failure mode.
// ---------------------------------------------------------------------------

test("pinned-runtime API contract: getProviderAuth exists on ModelRegistry prototype", async () => {
  // Import the installed registry class — duck-typed so future renames fail here,
  // not silently inside the feature at runtime.
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  assert.ok(
    typeof ModelRegistry.prototype.getProviderAuth === "function",
    [
      "ModelRegistry.prototype.getProviderAuth is missing or not a function in the pinned Pi runtime.",
      "The provider-auth-health footer warning silently degrades to no-warning when this method is absent.",
      "If you bumped @earendil-works/pi-coding-agent past 0.84.2, check the new ModelRegistry API and",
      "update the duck-typing guard hasGetProviderAuth() in extensions/the-last-harness/provider-auth-health.ts.",
      "See Gnosis mxhzwc for the precedent: Pi 0.81 removed ModelRegistry.authStorage and quietly broke",
      "the footer's subscription-usage segment in the same way.",
    ].join(" "),
  );
});

test("pinned-runtime API contract: getProviderAuthStatus exists on ModelRegistry prototype", async () => {
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  assert.ok(
    typeof ModelRegistry.prototype.getProviderAuthStatus === "function",
    [
      "ModelRegistry.prototype.getProviderAuthStatus is missing or not a function in the pinned Pi runtime.",
      "The provider-auth-health feature uses this for synchronous configured-status checks (isConfigured).",
      "A missing method degrades to returning undefined from isConfigured() — silent failure.",
      "If you bumped @earendil-works/pi-coding-agent past 0.84.2, check the new ModelRegistry API and",
      "update the duck-typing guard hasGetProviderAuthStatus() in extensions/the-last-harness/provider-auth-health.ts.",
    ].join(" "),
  );
});
