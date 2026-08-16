import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA,
  TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL,
  TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL,
  createTlhSubscriptionUsageService,
  fetchTlhSubscriptionUsage,
  normalizeAnthropicUsage,
  normalizeOpenAICodexUsage,
} from "../extensions/the-last-harness/subscription-usage.ts";

const NOW_MS = Date.parse("2026-05-19T19:00:00Z");
const RESET_AT = "2026-05-19T20:00:00.000Z";

function openAiUsage(used = 25) {
  return {
    primary_window: {
      used,
      limit: 100,
      reset_at: RESET_AT,
    },
    secondary_window: {
      requests_remaining: 800,
      requests_limit: 1000,
      seconds_until_reset: 3600,
    },
  };
}

function openAiNestedUsage(used = 25) {
  return {
    rate_limit: openAiUsage(used),
  };
}

function assertNoCredentialMaterial(value) {
  assert.doesNotMatch(JSON.stringify(value), /Authorization|Bearer|access|refresh|token/i);
}

function tokenFingerprint(accessToken) {
  return createHash("sha256").update(accessToken).digest("hex");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("normalizes OpenAI/Codex wham usage top-level primary and secondary windows", () => {
  const snapshot = normalizeOpenAICodexUsage(openAiUsage(75), { nowMs: NOW_MS });

  assert.equal(snapshot?.provider, "openai-codex");
  assert.equal(snapshot?.fetchedAt, NOW_MS);
  assert.deepEqual(snapshot?.windows.session, {
    key: "primary_window",
    label: "session",
    used: 75,
    limit: 100,
    remaining: 25,
    percent: 75,
    resetsAt: RESET_AT,
  });
  assert.deepEqual(snapshot?.windows.weekly, {
    key: "secondary_window",
    label: "weekly",
    used: 200,
    limit: 1000,
    remaining: 800,
    percent: 20,
    resetsAt: RESET_AT,
  });
});

test("normalizes OpenAI/Codex wham nested rate_limit primary and secondary windows", () => {
  const snapshot = normalizeOpenAICodexUsage(openAiNestedUsage(75), { nowMs: NOW_MS });

  assert.equal(snapshot?.provider, "openai-codex");
  assert.equal(snapshot?.fetchedAt, NOW_MS);
  assert.deepEqual(snapshot?.windows.session, {
    key: "primary_window",
    label: "session",
    used: 75,
    limit: 100,
    remaining: 25,
    percent: 75,
    resetsAt: RESET_AT,
  });
  assert.deepEqual(snapshot?.windows.weekly, {
    key: "secondary_window",
    label: "weekly",
    used: 200,
    limit: 1000,
    remaining: 800,
    percent: 20,
    resetsAt: RESET_AT,
  });
});

test("normalizes OpenAI/Codex wham percentage-only windows", () => {
  const weeklyResetAt = "2026-05-26T19:00:00.000Z";
  const snapshot = normalizeOpenAICodexUsage(
    {
      primary_window: {
        used_percent: 42.34,
        reset_at: RESET_AT,
        limit_window_seconds: 18_000,
      },
      secondary_window: {
        used_percent: 101.2,
        reset_at: weeklyResetAt,
        limit_window_seconds: 604_800,
      },
    },
    { nowMs: NOW_MS },
  );

  assert.deepEqual(snapshot?.windows.session, {
    key: "primary_window",
    label: "session",
    percent: 42.3,
    resetsAt: RESET_AT,
    durationMs: 18_000_000,
  });
  assert.deepEqual(snapshot?.windows.weekly, {
    key: "secondary_window",
    label: "weekly",
    percent: 100,
    resetsAt: weeklyResetAt,
    durationMs: 604_800_000,
  });
});

test("prefers explicit usage percentages over derived count percentages", () => {
  const openAiSnapshot = normalizeOpenAICodexUsage(
    {
      primary_window: {
        used: 90,
        limit: 100,
        usedPercent: 12.34,
      },
    },
    { nowMs: NOW_MS },
  );
  const anthropicSnapshot = normalizeAnthropicUsage(
    {
      five_hour: {
        used: 1,
        limit: 100,
        utilization: 56.78,
      },
    },
    { nowMs: NOW_MS },
  );

  assert.equal(openAiSnapshot?.windows.session.percent, 12.3);
  assert.equal(anthropicSnapshot?.windows.session.percent, 56.8);
});

test("normalizes Anthropic OAuth five-hour and seven-day windows", () => {
  const snapshot = normalizeAnthropicUsage(
    {
      five_hour: {
        used_tokens: 40,
        max_tokens: 100,
        reset_time: RESET_AT,
      },
      seven_day: {
        used: 300,
        limit: 1000,
      },
    },
    { nowMs: NOW_MS },
  );

  assert.equal(snapshot?.provider, "anthropic");
  assert.deepEqual(snapshot?.windows.session, {
    key: "five_hour",
    label: "session",
    used: 40,
    limit: 100,
    remaining: 60,
    percent: 40,
    resetsAt: RESET_AT,
  });
  assert.deepEqual(snapshot?.windows.weekly, {
    key: "seven_day",
    label: "weekly",
    used: 300,
    limit: 1000,
    remaining: 700,
    percent: 30,
  });
});

test("normalizes Anthropic OAuth utilization-only windows", () => {
  const weeklyResetAt = "2026-05-26T19:00:00.000Z";
  const snapshot = normalizeAnthropicUsage(
    {
      five_hour: {
        utilization: 27.25,
        resets_at: RESET_AT,
      },
      seven_day: {
        utilization: 88.86,
        resets_at: weeklyResetAt,
      },
    },
    { nowMs: NOW_MS },
  );

  assert.deepEqual(snapshot?.windows.session, {
    key: "five_hour",
    label: "session",
    percent: 27.3,
    resetsAt: RESET_AT,
  });
  assert.deepEqual(snapshot?.windows.weekly, {
    key: "seven_day",
    label: "weekly",
    percent: 88.9,
    resetsAt: weeklyResetAt,
  });
});

test("normalizers fail closed for unobserved window shapes", () => {
  assert.equal(
    normalizeOpenAICodexUsage({ primaryWindow: { used: 1, limit: 10 } }, { nowMs: NOW_MS }),
    undefined,
  );
  assert.equal(
    normalizeAnthropicUsage(
      {
        usage: {
          five_hour: { used: 1, limit: 10 },
          seven_day: { used: 2, limit: 10 },
        },
      },
      { nowMs: NOW_MS },
    ),
    undefined,
  );
  assert.equal(
    normalizeAnthropicUsage(
      { fiveHour: { used: 1, limit: 10 }, six_day: { used: 2, limit: 10, duration: "6d" } },
      { nowMs: NOW_MS },
    ),
    undefined,
  );
});

test("fetches Anthropic OAuth usage with the beta header and fails soft on auth/decode errors", async () => {
  const accessToken = randomUUID();
  let request;
  const snapshot = await fetchTlhSubscriptionUsage(
    { provider: "anthropic", accessToken },
    {
      nowMs: NOW_MS,
      timeoutMs: 0,
      fetch: async (url, init) => {
        request = { url, init };
        return {
          ok: true,
          json: async () => ({
            five_hour: { remaining: 4, limit: 10 },
            seven_day: { used: 20, limit: 100 },
          }),
        };
      },
    },
  );

  assert.equal(request?.url, TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL);
  assert.equal(request?.init.method, "GET");
  assert.match(request?.init.headers.Authorization, /^Bearer \S+$/);
  assert.equal(request?.init.headers["anthropic-beta"], TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA);
  assert.equal(snapshot?.windows.session.used, 6);
  assertNoCredentialMaterial(snapshot);

  const authFailure = await fetchTlhSubscriptionUsage(
    { provider: "anthropic", accessToken: randomUUID() },
    {
      timeoutMs: 0,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    },
  );
  assert.equal(authFailure, undefined);

  const decodeFailure = await fetchTlhSubscriptionUsage(
    { provider: "anthropic", accessToken: randomUUID() },
    {
      timeoutMs: 0,
      fetch: async () => ({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    },
  );
  assert.equal(decodeFailure, undefined);
});

test("usage fetches fail soft before network calls for unsupported targets", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("unexpected usage request");
  };

  assert.equal(
    await fetchTlhSubscriptionUsage(
      { provider: "openrouter", accessToken: randomUUID() },
      { fetch: fetchImpl, timeoutMs: 0 },
    ),
    undefined,
  );
  assert.equal(
    await fetchTlhSubscriptionUsage(
      { provider: "openai-codex", accessToken: " " },
      { fetch: fetchImpl, timeoutMs: 0 },
    ),
    undefined,
  );
  assert.equal(fetchCalls, 0);
});

test("service gates OAuth usage, caches/throttles fetches, and keeps stale snapshots on failures", async () => {
  const accessToken = randomUUID();
  let nowMs = NOW_MS;
  let callCount = 0;
  let failNetwork = false;
  const requests = [];
  let credential = { type: "oauth", access: "stale-access", accountId: "acct_test" };
  const service = createTlhSubscriptionUsageService({
    now: () => nowMs,
    cacheTtlMs: 1000,
    minFetchIntervalMs: 5000,
    timeoutMs: 0,
    fetch: async (url, init) => {
      callCount += 1;
      requests.push({ url, init });
      if (failNetwork) {
        throw new Error("network failure");
      }
      return {
        ok: true,
        json: async () => openAiUsage(callCount * 10),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getApiKeyForProvider: async (provider) => {
        if (provider !== "openai-codex") {
          return undefined;
        }
        credential = { ...credential, access: accessToken };
        return accessToken;
      },
      authStorage: {
        get: (provider) => (provider === "openai-codex" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx);
  assert.equal(callCount, 1);
  assert.equal(requests[0]?.url, TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL);
  assert.match(requests[0]?.init.headers.Authorization, /^Bearer \S+$/);
  assert.equal(requests[0]?.init.headers["ChatGPT-Account-Id"], "acct_test");
  assert.equal(first?.windows.session.used, 10);

  const cached = await service.refresh(ctx);
  assert.equal(cached, first);
  assert.equal(callCount, 1);

  nowMs += 2000;
  const throttled = await service.refresh(ctx);
  assert.equal(throttled, first);
  assert.equal(callCount, 1);

  const unsupported = await service.refresh({
    model: { provider: "openrouter" },
    modelRegistry: ctx.modelRegistry,
  });
  assert.equal(unsupported, undefined);
  assert.equal(callCount, 1);

  const nonOAuth = await service.refresh({
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => accessToken,
      authStorage: { get: () => ({ type: "api_key", key: accessToken }) },
    },
  });
  assert.equal(nonOAuth, undefined);
  assert.equal(callCount, 1);

  nowMs += 5000;
  failNetwork = true;
  const stale = await service.refresh(ctx, { force: true });
  assert.equal(stale, first);
  assert.equal(service.getSnapshot("openai-codex"), first);
  assert.equal(callCount, 2);
  assertNoCredentialMaterial(service.getSnapshot("openai-codex"));
});

test("service preserves same-credential cached usage when key resolution is temporarily unavailable", async () => {
  const accessToken = randomUUID();
  let keyMode = "ok";
  let fetchCalls = 0;
  let credential = { type: "oauth", access: accessToken, accountId: "acct_test" };
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => openAiUsage(40),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getApiKeyForProvider: async () => {
        if (keyMode === "throw") {
          throw new Error("oauth refresh unavailable");
        }
        return keyMode === "undefined" ? undefined : accessToken;
      },
      authStorage: {
        get: (provider) => (provider === "openai-codex" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx, { force: true });
  assert.equal(first?.windows.session.used, 40);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);
  assert.equal(service.isEligible(ctx), true);

  keyMode = "undefined";
  assert.equal(await service.refresh(ctx, { force: true }), first);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);
  assert.equal(service.isEligible(ctx), true);

  keyMode = "throw";
  assert.equal(await service.refresh(ctx, { force: true }), first);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("openai-codex"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);

  credential = { type: "oauth", access: accessToken, accountId: "acct_changed" };
  keyMode = "undefined";
  assert.equal(service.getSnapshotForContext(ctx), undefined);
  assert.equal(await service.refresh(ctx, { force: true }), undefined);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("openai-codex"), undefined);
});

test("service preserves Anthropic cached usage across same-token credential reloads", async () => {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const expires = NOW_MS + 60_000;
  let keyMode = "ok";
  let fetchCalls = 0;
  let credential = { type: "oauth", access: accessToken, refresh: refreshToken, expires };
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 3, limit: 10 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => (keyMode === "ok" ? accessToken : undefined),
      authStorage: {
        get: (provider) => (provider === "anthropic" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx, { force: true });
  assert.equal(first?.windows.session.used, 3);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);

  const cacheKeys = Array.from(service.snapshots.keys());
  assert.deepEqual(cacheKeys, [`anthropic\tfingerprint:${tokenFingerprint(accessToken)}`]);
  assert.doesNotMatch(cacheKeys[0], /object|expires|access|refresh|token/i);
  assert.doesNotMatch(cacheKeys[0], new RegExp(accessToken));

  credential = {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: NOW_MS + 120_000,
  };
  keyMode = "undefined";
  assert.equal(service.getSnapshotForContext(ctx), first);
  assert.equal(await service.refresh(ctx, { force: true }), first);
  assert.equal(fetchCalls, 1);
});

test("service hides Anthropic cached usage across access-token changes", async () => {
  const firstAccessToken = randomUUID();
  const firstRefreshToken = randomUUID();
  const secondAccessToken = randomUUID();
  const secondRefreshToken = randomUUID();
  const expires = NOW_MS + 60_000;
  let keyMode = "ok";
  let fetchCalls = 0;
  let credential = { type: "oauth", access: firstAccessToken, refresh: firstRefreshToken, expires };
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 6, limit: 10 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => (keyMode === "ok" ? credential.access : undefined),
      authStorage: {
        get: (provider) => (provider === "anthropic" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx, { force: true });
  assert.equal(first?.windows.session.used, 6);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);

  const cacheKeys = Array.from(service.snapshots.keys());
  assert.deepEqual(cacheKeys, [`anthropic\tfingerprint:${tokenFingerprint(firstAccessToken)}`]);
  assert.doesNotMatch(cacheKeys[0], /expires|access|refresh|token/i);
  assert.doesNotMatch(cacheKeys[0], new RegExp(firstAccessToken));

  credential = { type: "oauth", access: secondAccessToken, refresh: secondRefreshToken, expires };
  keyMode = "undefined";
  assert.equal(service.getSnapshotForContext(ctx), undefined);
  assert.equal(await service.refresh(ctx, { force: true }), undefined);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("anthropic"), undefined);
});

test("throttle survives credential object rotation when access token is unchanged", async () => {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  let fetchCalls = 0;
  let credential = {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: NOW_MS + 60_000,
  };
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 60_000,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 4, limit: 10 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => credential.access,
      authStorage: {
        get: (provider) => (provider === "anthropic" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx);
  assert.equal(first?.windows.session.used, 4);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("anthropic"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);
  const firstCacheKey = service.activeCacheKeys.get("anthropic");

  assert.equal(firstCacheKey, `anthropic\tfingerprint:${tokenFingerprint(accessToken)}`);

  // Simulate Pi's AuthStorage.set() replacing the credential object on an
  // OAuth refresh: new object identity (and a bumped expiry) but the same
  // bearer access token. The fingerprint-derived cache key remains stable,
  // so the normal cacheKey throttle keeps the redundant fetch from going through.
  credential = {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: NOW_MS + 120_000,
  };

  const rotated = await service.refresh(ctx);
  assert.equal(rotated, first);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("anthropic"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);
  const rotatedCacheKey = service.activeCacheKeys.get("anthropic");
  assert.equal(rotatedCacheKey, firstCacheKey);
  assert.deepEqual(Array.from(service.snapshots.keys()), [rotatedCacheKey]);

  // And again, just to make sure the throttle remains armed.
  const rerotated = await service.refresh(ctx);
  assert.equal(rerotated, first);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("anthropic"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);

  for (const key of service.snapshots.keys()) {
    assert.doesNotMatch(key, /access|refresh|token/i);
    assert.doesNotMatch(key, new RegExp(accessToken));
  }
});

test("concurrent same-token credential object rotations preserve the cached snapshot", async () => {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  let fetchCalls = 0;
  let credential = {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: NOW_MS + 60_000,
  };
  let gateCredentialLookups = false;
  let gatedLookupCount = 0;
  const lookupGate = createDeferred();
  const bothLookupsGated = createDeferred();
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 60_000,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 7, limit: 10 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => {
        if (gateCredentialLookups) {
          gatedLookupCount += 1;
          if (gatedLookupCount === 2) {
            bothLookupsGated.resolve();
          }
          await lookupGate.promise;
        }
        return credential.access;
      },
      authStorage: {
        get: (provider) => (provider === "anthropic" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx);
  assert.equal(first?.windows.session.used, 7);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshot("anthropic"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);
  const firstCacheKey = service.activeCacheKeys.get("anthropic");
  assert.equal(firstCacheKey, `anthropic\tfingerprint:${tokenFingerprint(accessToken)}`);

  credential = {
    type: "oauth",
    access: accessToken,
    refresh: refreshToken,
    expires: NOW_MS + 120_000,
  };
  gateCredentialLookups = true;

  const firstRotatedRefresh = service.refresh(ctx);
  const secondRotatedRefresh = service.refresh(ctx);

  await bothLookupsGated.promise;
  assert.equal(gatedLookupCount, 2);
  assert.equal(fetchCalls, 1, "rotated refreshes wait at credential lookup before any extra fetch");

  lookupGate.resolve();
  const [firstRotated, secondRotated] = await Promise.all([
    firstRotatedRefresh,
    secondRotatedRefresh,
  ]);

  assert.equal(firstRotated, first);
  assert.equal(secondRotated, first);
  assert.equal(fetchCalls, 1, "same-token concurrent rotations do not issue a redundant fetch");
  assert.equal(service.getSnapshot("anthropic"), first);
  assert.equal(service.getSnapshotForContext(ctx), first);
  const rotatedCacheKey = service.activeCacheKeys.get("anthropic");
  assert.equal(rotatedCacheKey, firstCacheKey);
  assert.deepEqual(Array.from(service.snapshots.keys()), [rotatedCacheKey]);
  for (const key of service.snapshots.keys()) {
    assert.doesNotMatch(key, /access|refresh|token/i);
    assert.doesNotMatch(key, new RegExp(accessToken));
  }
});

test("service hides cached usage across OAuth account identity changes", async () => {
  const firstToken = randomUUID();
  const secondToken = randomUUID();
  let credential = { type: "oauth", access: firstToken, accountId: "acct_first" };
  const requests = [];
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 60_000,
    minFetchIntervalMs: 60_000,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => openAiUsage(requests.length * 10),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getApiKeyForProvider: async () => credential.access,
      authStorage: {
        get: (provider) => (provider === "openai-codex" ? credential : undefined),
      },
    },
  };

  const first = await service.refresh(ctx, { force: true });
  assert.equal(first?.windows.session.used, 10);
  assert.equal(service.getSnapshotForContext(ctx), first);
  assert.deepEqual(Array.from(service.snapshots.keys()), ["openai-codex\taccount:acct_first"]);

  credential = { type: "oauth", access: secondToken, accountId: "acct_second" };
  assert.equal(service.getSnapshotForContext(ctx), undefined);

  const second = await service.refresh(ctx, { force: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.init.headers["ChatGPT-Account-Id"], "acct_second");
  assert.equal(second?.windows.session.used, 20);
  assert.equal(service.getSnapshotForContext(ctx), second);
  assert.deepEqual(Array.from(service.snapshots.keys()), ["openai-codex\taccount:acct_second"]);
});

test("service does not fetch when a runtime key differs from the stored OAuth access token", async () => {
  const oauthToken = randomUUID();
  const runtimeToken = `sk-${randomUUID()}`;
  let fetchCalls = 0;
  const noCacheService = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("unexpected usage request");
    },
  });
  const mismatchCredential = { type: "oauth", access: oauthToken, expires: NOW_MS + 60_000 };
  const mismatchCtx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => runtimeToken,
      authStorage: {
        get: (provider) => (provider === "anthropic" ? mismatchCredential : undefined),
      },
    },
  };

  assert.equal(noCacheService.isEligible(mismatchCtx), true);
  assert.equal(await noCacheService.refresh(mismatchCtx, { force: true }), undefined);
  assert.equal(noCacheService.isEligible(mismatchCtx), false);
  assert.equal(fetchCalls, 0);

  let returnedToken = oauthToken;
  const staleCredential = { type: "oauth", access: oauthToken };
  const staleAuthStorage = {
    runtimeOverrides: new Map(),
    get: (provider) => (provider === "anthropic" ? staleCredential : undefined),
  };
  const requests = [];
  const staleService = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 2, limit: 10 } }),
      };
    },
  });
  const staleCtx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getApiKeyForProvider: async () => returnedToken,
      authStorage: staleAuthStorage,
    },
  };

  const first = await staleService.refresh(staleCtx, { force: true });
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.init.headers.Authorization, /^Bearer \S+$/);
  assert.equal(staleService.getSnapshotForContext(staleCtx), first);

  returnedToken = runtimeToken;
  staleAuthStorage.runtimeOverrides.set("anthropic", runtimeToken);
  assert.equal(staleService.getSnapshotForContext(staleCtx), undefined);
  const stale = await staleService.refresh(staleCtx, { force: true });
  assert.equal(stale, undefined);
  assert.equal(requests.length, 1);
  assert.equal(staleService.getSnapshot("anthropic"), undefined);
  assert.equal(staleService.getSnapshotForContext(staleCtx), undefined);
});

test("service dedupes concurrent refresh() calls via the in-flight registry", async () => {
  // With the strict generation guard, two concurrent refresh() calls with no
  // prior active state are treated as an older (gen 1) and newer (gen 2) call.
  // Gen 1 is superseded by gen 2 and bails with undefined (no active snapshot
  // yet). Gen 2 is the authoritative caller; it issues exactly one network
  // request. The key invariant is fetchCalls === 1.
  const accessToken = randomUUID();
  const credential = { type: "oauth", access: accessToken, accountId: "acct_concurrent" };
  let fetchCalls = 0;
  const deferred = createDeferred();
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: () => {
      fetchCalls += 1;
      return deferred.promise;
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getApiKeyForProvider: async () => accessToken,
      authStorage: {
        get: (provider) => (provider === "openai-codex" ? credential : undefined),
      },
    },
  };

  // Issue two concurrent refresh() calls without awaiting between them.
  // Gen 1 (first) will be superseded by gen 2 (second) and bail before fetching.
  const firstPromise = service.refresh(ctx);
  const secondPromise = service.refresh(ctx);

  // Drain pending microtasks so both refreshes advance past their credential
  // resolution awaits. Gen 2 proceeds to the fetch; gen 1 has already bailed.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    fetchCalls,
    1,
    "fetch is invoked exactly once — gen 2 is the sole authoritative caller",
  );

  deferred.resolve({ ok: true, json: async () => openAiUsage(50) });

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(fetchCalls, 1, "no additional fetch occurs after the deferred resolves");
  // Gen 2 (second) is the authoritative result; it produced the snapshot.
  assert.ok(second, "second (newer) refresh produced a snapshot");
  assert.equal(second?.windows.session.used, 50);
  // Gen 1 (first) was superseded; no active snapshot existed yet so it returns undefined.
  assert.equal(
    first,
    undefined,
    "first (superseded) refresh returns undefined — no active snapshot at bail time",
  );
  // The service state reflects the newer refresh.
  assert.equal(service.getSnapshot("openai-codex"), second);
});

// ---------------------------------------------------------------------------
// Pi 0.81 modelRegistry API tests (no authStorage)
// ---------------------------------------------------------------------------

// Creates a minimal base64url-encoded JWT with the given payload object.
// No real signing — used only to exercise the JWT-decode path in tests.
function makeFakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

test("Pi 0.81: eligible Anthropic OAuth session produces snapshot after refresh()", async () => {
  const accessToken = randomUUID();
  const fingerprint = tokenFingerprint(accessToken);
  let fetchCalls = 0;
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 8, limit: 20 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      // Pi 0.81: no authStorage
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getProviderAuthStatus: (provider) =>
        provider === "anthropic" ? { configured: true, source: "stored" } : { configured: false },
      getApiKeyForProvider: async (provider) =>
        provider === "anthropic" ? accessToken : undefined,
    },
  };

  // Before first refresh, isEligible is true (sync registry confirms OAuth).
  // suppressCost should be honoured even before usage data arrives.
  assert.equal(service.isEligible(ctx), true);
  assert.equal(service.getSnapshotForContext(ctx), undefined, "no snapshot yet before refresh");

  const snapshot = await service.refresh(ctx, { force: true });

  assert.ok(snapshot, "refresh produced a snapshot");
  assert.equal(snapshot?.provider, "anthropic");
  assert.equal(snapshot?.windows.session.used, 8);
  assert.equal(fetchCalls, 1);

  // Cache key is fingerprint-based (no account ID for Anthropic).
  assert.deepEqual(Array.from(service.snapshots.keys()), [`anthropic\tfingerprint:${fingerprint}`]);
  assert.doesNotMatch(Array.from(service.snapshots.keys())[0], new RegExp(accessToken));

  // Sync display path picks up the snapshot recorded by refresh().
  assert.equal(service.getSnapshotForContext(ctx), snapshot);
  assert.equal(service.isEligible(ctx), true);
  assertNoCredentialMaterial(snapshot);
});

test('Pi 0.81: runtime-override (AuthStatus.source === "runtime") suppresses usage segment', async () => {
  const accessToken = randomUUID();
  let fetchCalls = 0;
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("unexpected usage fetch");
    },
  });

  let authSource = "stored";
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getProviderAuthStatus: () => ({ configured: true, source: authSource }),
      getApiKeyForProvider: async () => accessToken,
      // No authStorage — Pi 0.81 shape
    },
  };

  // With stored source, refresh should succeed.
  const noOverrideService = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => ({
      ok: true,
      json: async () => ({ five_hour: { used: 3, limit: 10 } }),
    }),
  });
  const storedCtx = {
    ...ctx,
    modelRegistry: {
      ...ctx.modelRegistry,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    },
  };
  const storedSnapshot = await noOverrideService.refresh(storedCtx, { force: true });
  assert.ok(storedSnapshot);
  assert.equal(noOverrideService.isEligible(storedCtx), true);

  // Switch to runtime source — usage should be suppressed.
  authSource = "runtime";
  assert.equal(service.isEligible(ctx), false, "runtime override makes isEligible false");
  const result = await service.refresh(ctx, { force: true });
  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0, "no fetch should occur with runtime override");
  assert.equal(service.getSnapshotForContext(ctx), undefined);
});

test("Pi 0.81: openai-codex JWT account-id decode sets ChatGPT-Account-Id header and account-based cache key", async () => {
  const accountId = "acct_jwt_decoded";
  // Create a JWT with the nested OpenAI auth claim.
  const jwtToken = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    sub: "user_test",
  });
  const requests = [];
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => openAiUsage(30),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async (provider) =>
        provider === "openai-codex" ? jwtToken : undefined,
      // No authStorage — Pi 0.81 shape
    },
  };

  const snapshot = await service.refresh(ctx, { force: true });

  assert.ok(snapshot);
  assert.equal(snapshot?.windows.session.used, 30);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.init.headers["ChatGPT-Account-Id"],
    accountId,
    "decoded account ID included in request header",
  );
  // Cache key uses account identity, not fingerprint.
  assert.deepEqual(Array.from(service.snapshots.keys()), [`openai-codex\taccount:${accountId}`]);
  assert.doesNotMatch(
    requests[0]?.init.headers.Authorization,
    new RegExp(accountId),
    "account ID not present in auth header",
  );
  assertNoCredentialMaterial(snapshot);
});

test("Pi 0.81: openai-codex without decodable account-id falls back to fingerprint cache key", async () => {
  // Plain UUID is not a JWT — decode will fail and fingerprint is used.
  const accessToken = randomUUID();
  const fingerprint = tokenFingerprint(accessToken);
  const requests = [];
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => openAiUsage(15),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async () => accessToken,
      // No authStorage — Pi 0.81 shape
    },
  };

  const snapshot = await service.refresh(ctx, { force: true });

  assert.ok(snapshot);
  assert.equal(snapshot?.windows.session.used, 15);
  // No ChatGPT-Account-Id when account ID could not be decoded.
  assert.equal(requests[0]?.init.headers["ChatGPT-Account-Id"], undefined);
  assert.deepEqual(Array.from(service.snapshots.keys()), [
    `openai-codex\tfingerprint:${fingerprint}`,
  ]);
  assertNoCredentialMaterial(snapshot);
});

test("Pi 0.81: JWT top-level account_id claim is also accepted", async () => {
  const accountId = "acct_toplevel";
  // JWT with top-level chatgpt_account_id (no nested auth claim).
  const jwtToken = makeFakeJwt({ chatgpt_account_id: accountId, sub: "user_test" });
  const requests = [];
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => openAiUsage(20),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async () => jwtToken,
    },
  };

  const snapshot = await service.refresh(ctx, { force: true });

  assert.ok(snapshot);
  assert.equal(requests[0]?.init.headers["ChatGPT-Account-Id"], accountId);
  assert.deepEqual(Array.from(service.snapshots.keys()), [`openai-codex\taccount:${accountId}`]);
});

test("Pi 0.81: transient-unavailable getApiKeyForProvider preserves existing cached snapshot", async () => {
  const accessToken = randomUUID();
  let keyMode = "ok";
  let fetchCalls = 0;
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => ({ five_hour: { used: 5, limit: 10 } }),
      };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async () => {
        if (keyMode === "throw") throw new Error("transient");
        return keyMode === "ok" ? accessToken : undefined;
      },
    },
  };

  const first = await service.refresh(ctx, { force: true });
  assert.ok(first);
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);

  keyMode = "undefined";
  const staleUndefined = await service.refresh(ctx, { force: true });
  assert.equal(staleUndefined, first, "undefined key returns stale snapshot");
  assert.equal(fetchCalls, 1);

  keyMode = "throw";
  const staleThrow = await service.refresh(ctx, { force: true });
  assert.equal(staleThrow, first, "thrown key error returns stale snapshot");
  assert.equal(fetchCalls, 1);
  assert.equal(service.getSnapshotForContext(ctx), first);
});

test("Pi 0.81: legacy authStorage fallback: authStorage.get credential still drives the cache key", async () => {
  // Regression: Pi <= 0.80 modelRegistry with authStorage should follow the
  // existing credential-based path unchanged.
  const accessToken = randomUUID();
  const credential = { type: "oauth", access: accessToken, accountId: "acct_legacy" };
  const requests = [];
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => openAiUsage(12),
      };
    },
  });
  const ctx = {
    model: { provider: "openai-codex" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "openai-codex",
      getApiKeyForProvider: async () => accessToken,
      // Legacy authStorage present — Pi <= 0.80 shape
      authStorage: {
        get: (provider) => (provider === "openai-codex" ? credential : undefined),
      },
    },
  };

  const snapshot = await service.refresh(ctx, { force: true });

  assert.ok(snapshot);
  assert.equal(snapshot?.windows.session.used, 12);
  // Cache key is account-based (from authStorage credential).
  assert.deepEqual(Array.from(service.snapshots.keys()), ["openai-codex\taccount:acct_legacy"]);
  assert.equal(requests[0]?.init.headers["ChatGPT-Account-Id"], "acct_legacy");
  assert.equal(service.isEligible(ctx), true);
  assertNoCredentialMaterial(snapshot);
});

// ---------------------------------------------------------------------------
// Pi 0.80 hybrid regression: runtimeOverrides map must win over stored source
// ---------------------------------------------------------------------------

test("Pi 0.80 hybrid: runtimeOverrides map override is detected even when getProviderAuthStatus returns source stored", async () => {
  // Regression for FINDING 1: on Pi 0.80.x getAuthStatus() returns
  // source "stored" when a stored OAuth credential exists, even when a
  // runtime --api-key override is also active. The legacy runtimeOverrides
  // Map check must be consulted first to correctly detect the override.
  const oauthToken = randomUUID();
  const runtimeToken = `sk-${randomUUID()}`;
  let fetchCalls = 0;
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("unexpected usage fetch — runtime override should suppress this");
    },
  });

  const storedCredential = { type: "oauth", access: oauthToken, accountId: "acct_pi80" };
  const authStorage = {
    // runtimeOverrides Map has the provider key set (runtime --api-key active)
    runtimeOverrides: new Map([["anthropic", runtimeToken]]),
    get: (provider) => (provider === "anthropic" ? storedCredential : undefined),
  };
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      // Pi 0.80 shape: getProviderAuthStatus returns source "stored" (not
      // "runtime") despite the runtime override being active — this is the
      // bug scenario that motivated FINDING 1.
      getProviderAuthStatus: (provider) =>
        provider === "anthropic" ? { configured: true, source: "stored" } : { configured: false },
      getApiKeyForProvider: async () => runtimeToken,
      authStorage,
    },
  };

  // isEligible must be false: runtimeOverrides map reveals the override.
  assert.equal(
    service.isEligible(ctx),
    false,
    "Pi 0.80 runtimeOverrides override must be detected despite stored authStatus",
  );

  // refresh() must clear and return undefined without fetching.
  const result = await service.refresh(ctx, { force: true });
  assert.equal(
    result,
    undefined,
    "usage segment must be suppressed when runtimeOverrides map is set",
  );
  assert.equal(fetchCalls, 0, "no fetch should occur with a runtime override");
  assert.equal(service.getSnapshot("anthropic"), undefined);
  assert.equal(service.getSnapshotForContext(ctx), undefined);
});

// ---------------------------------------------------------------------------
// decodeJwtPayload hardening: malformed JWT inputs must not surface
// a ChatGPT-Account-Id header and must never throw
// ---------------------------------------------------------------------------

test("Pi 0.81: malformed JWT tokens do not set ChatGPT-Account-Id header and do not throw", async () => {
  // Regression for FINDING 3: decodeJwtPayload must reject tokens that do not
  // have exactly 3 dot-separated segments or whose payload contains characters
  // outside the base64url alphabet.
  const requests = [];
  function makeService() {
    return createTlhSubscriptionUsageService({
      now: () => NOW_MS,
      cacheTtlMs: 0,
      minFetchIntervalMs: 0,
      timeoutMs: 0,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return { ok: true, json: async () => openAiUsage(5) };
      },
    });
  }
  function makeCtx(accessToken) {
    return {
      model: { provider: "openai-codex" },
      modelRegistry: {
        isUsingOAuth: (model) => model?.provider === "openai-codex",
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        getApiKeyForProvider: async () => accessToken,
        // No authStorage — Pi 0.81 shape
      },
    };
  }

  // Wrong segment count: only 2 segments (missing signature)
  const twoSegmentToken = "aGVhZGVy.cGF5bG9hZA";
  const s1 = makeService();
  const snap1 = await s1.refresh(makeCtx(twoSegmentToken), { force: true });
  assert.ok(snap1, "two-segment token still produces a snapshot via fingerprint fallback");
  assert.equal(
    requests.find((r) => r.init.headers["ChatGPT-Account-Id"] !== undefined),
    undefined,
    "two-segment token: no ChatGPT-Account-Id header",
  );

  requests.length = 0;

  // Wrong segment count: 4 segments
  const fourSegmentToken = "a.b.c.d";
  const s2 = makeService();
  const snap2 = await s2.refresh(makeCtx(fourSegmentToken), { force: true });
  assert.ok(snap2, "four-segment token still produces a snapshot via fingerprint fallback");
  assert.equal(
    requests.find((r) => r.init.headers["ChatGPT-Account-Id"] !== undefined),
    undefined,
    "four-segment token: no ChatGPT-Account-Id header",
  );

  requests.length = 0;

  // Invalid base64url chars in payload segment (contains '+' which is base64
  // but not base64url, and spaces)
  const invalidBase64UrlToken = "aGVhZGVy.cGF5b G9h ZA==.fakesig";
  const s3 = makeService();
  const snap3 = await s3.refresh(makeCtx(invalidBase64UrlToken), { force: true });
  assert.ok(
    snap3,
    "invalid base64url payload token still produces a snapshot via fingerprint fallback",
  );
  assert.equal(
    requests.find((r) => r.init.headers["ChatGPT-Account-Id"] !== undefined),
    undefined,
    "invalid base64url chars: no ChatGPT-Account-Id header",
  );

  requests.length = 0;

  // Impossible padding length: segment.length % 4 === 1
  // A base64url segment of length 1 mod 4 is structurally invalid.
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const badLenPayload = "A"; // length 1, 1 % 4 === 1 → impossible
  const impossibleLenToken = `${header}.${badLenPayload}.fakesig`;
  const s4 = makeService();
  const snap4 = await s4.refresh(makeCtx(impossibleLenToken), { force: true });
  assert.ok(
    snap4,
    "impossible-length payload token still produces a snapshot via fingerprint fallback",
  );
  assert.equal(
    requests.find((r) => r.init.headers["ChatGPT-Account-Id"] !== undefined),
    undefined,
    "impossible payload length: no ChatGPT-Account-Id header",
  );
});

// ---------------------------------------------------------------------------
// Generation guard: out-of-order async credential resolution
// ---------------------------------------------------------------------------

test("generation guard: single refresh activates and caches correctly (sanity)", async () => {
  const accessToken = randomUUID();
  let fetchCalls = 0;
  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 60_000,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ five_hour: { used: 33, limit: 100 } }) };
    },
  });
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async () => accessToken,
    },
  };

  const snapshot = await service.refresh(ctx, { force: true });
  assert.ok(snapshot, "single refresh produces a snapshot");
  assert.equal(snapshot?.windows.session.used, 33);
  assert.equal(fetchCalls, 1);
  assert.equal(
    service.activeCacheKeys.get("anthropic"),
    `anthropic\tfingerprint:${tokenFingerprint(accessToken)}`,
  );
  assert.equal(service.getSnapshotForContext(ctx), snapshot);

  // Cached second refresh does not re-fetch
  const cached = await service.refresh(ctx);
  assert.equal(cached, snapshot);
  assert.equal(fetchCalls, 1, "no redundant fetch for cached refresh");
});

test("generation guard: older concurrent refresh for different account does not clobber newer account state", async () => {
  const tokenA = randomUUID(); // older invocation's token — resolves LAST
  const tokenB = randomUUID(); // newer invocation's token — resolves FIRST

  const deferredA = createDeferred(); // gate for the first (older) call to getApiKeyForProvider
  const deferredB = createDeferred(); // gate for the second (newer) call to getApiKeyForProvider

  let callIndex = 0;
  let fetchCount = 0;

  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async (_url, init) => {
      fetchCount++;
      const auth = init?.headers?.Authorization ?? "";
      // Return different used counts so we can distinguish which account's fetch ran
      const used = auth.includes(tokenB) ? 22 : 11;
      return { ok: true, json: async () => ({ five_hour: { used, limit: 100 } }) };
    },
  });

  // Pi 0.81 shape (no authStorage)
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: (model) => model?.provider === "anthropic",
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async () => {
        const myCall = callIndex++;
        if (myCall === 0) {
          // first (older) refresh — waits on deferredA, resolves LAST
          await deferredA.promise;
          return tokenA;
        }
        // second (newer) refresh — waits on deferredB, resolves FIRST
        await deferredB.promise;
        return tokenB;
      },
    },
  };

  // Start older refresh (generation 1) then newer refresh (generation 2)
  const olderRefreshPromise = service.refresh(ctx, { force: true });
  const newerRefreshPromise = service.refresh(ctx, { force: true });

  // Drain microtasks so both refreshes advance to their getApiKeyForProvider await points
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callIndex, 2, "both refreshes have called getApiKeyForProvider");
  assert.equal(fetchCount, 0, "no fetches yet — both are waiting for token resolution");

  // Resolve the NEWER refresh first (tokenB) — it gets generation 2 and should win
  deferredB.resolve();
  // Drain to let the newer refresh advance past resolveTlhSubscriptionUsageTarget and set activeCacheKeys
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // Resolve the OLDER refresh (tokenA) — it has generation 1, current gen is 2 → superseded
  deferredA.resolve();

  const [olderResult, newerResult] = await Promise.all([olderRefreshPromise, newerRefreshPromise]);

  // Newer refresh produced the correct snapshot for tokenB
  assert.equal(
    newerResult?.windows.session.used,
    22,
    "newer refresh (tokenB) produced the correct snapshot",
  );

  // Final activeCacheKeys reflects tokenB (newer account), not tokenA (older)
  const activeCacheKey = service.activeCacheKeys.get("anthropic");
  const expectedCacheKey = `anthropic\tfingerprint:${tokenFingerprint(tokenB)}`;
  assert.equal(
    activeCacheKey,
    expectedCacheKey,
    "activeCacheKeys reflects the newer account (B), not the older (A)",
  );

  // getSnapshotForContext also reflects the newer account
  const contextSnapshot = service.getSnapshotForContext(ctx);
  assert.equal(
    contextSnapshot?.windows.session.used,
    22,
    "getSnapshotForContext returns the newer account's snapshot",
  );

  // Only one network fetch was issued — the older refresh was bailed before it could fetch
  assert.equal(
    fetchCount,
    1,
    "only the newer refresh issued a network fetch; the older was superseded before fetching",
  );

  // TokenA's cache entry was never written
  const aKey = `anthropic\tfingerprint:${tokenFingerprint(tokenA)}`;
  assert.equal(
    service.snapshots.has(aKey),
    false,
    "older account (tokenA) snapshot was never stored",
  );

  // The older refresh result must not be tokenA's data (it was either the active snapshot or undefined)
  if (olderResult !== undefined) {
    assert.notEqual(
      olderResult.windows.session.used,
      11,
      "older refresh did not return tokenA's stale data",
    );
  }
});

test("generation guard: older eligible refresh superseded by newer ineligible refresh does not reactivate cleared credential", async () => {
  // Regression for Codex P2 (second finding on PR #372):
  // An older eligible refresh is suspended inside getApiKeyForProvider.
  // A newer refresh() observes the provider is now ineligible (isUsingOAuth
  // returns false), calls clearProvider(), and returns.
  // When the older lookup eventually resolves, the generation mismatch guard
  // must bail immediately — zero state mutations and no fetch — because the
  // same-account fall-through carve-out has been removed.
  const accessToken = randomUUID();
  const deferredKey = createDeferred(); // gates the older refresh's getApiKeyForProvider

  let isOAuth = true; // newer refresh will set this to false
  let fetchCount = 0;
  let olderKeyCallResolved = false;

  const service = createTlhSubscriptionUsageService({
    now: () => NOW_MS,
    cacheTtlMs: 0,
    minFetchIntervalMs: 0,
    timeoutMs: 0,
    fetch: async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ five_hour: { used: 99, limit: 100 } }) };
    },
  });

  let keyCallIndex = 0;
  const ctx = {
    model: { provider: "anthropic" },
    modelRegistry: {
      get isUsingOAuth() {
        // Capture current isOAuth value at call time
        return (model) => isOAuth && model?.provider === "anthropic";
      },
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyForProvider: async (provider) => {
        if (provider !== "anthropic") return undefined;
        const myIndex = keyCallIndex++;
        if (myIndex === 0) {
          // Older refresh — suspend until we allow it to continue
          await deferredKey.promise;
          olderKeyCallResolved = true;
          return accessToken;
        }
        // Should not be called again in this test
        return accessToken;
      },
    },
  };

  // Start the older refresh (generation 1) — it suspends inside getApiKeyForProvider
  const olderRefreshPromise = service.refresh(ctx, { force: true });

  // Drain microtasks so the older refresh advances to its getApiKeyForProvider await point
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keyCallIndex, 1, "older refresh has called getApiKeyForProvider and is suspended");
  assert.equal(fetchCount, 0, "no fetch yet");

  // Now flip isOAuth to false — the provider is no longer eligible
  isOAuth = false;

  // Run the newer refresh (generation 2): provider now ineligible → clearProvider() + return undefined
  const newerResult = await service.refresh(ctx, { force: true });
  assert.equal(newerResult, undefined, "newer refresh returns undefined for ineligible provider");
  assert.equal(
    service.activeCacheKeys.has("anthropic"),
    false,
    "clearProvider removed activeCacheKeys entry",
  );
  assert.equal(fetchCount, 0, "newer ineligible refresh performed no fetch");

  // Let the older refresh's getApiKeyForProvider resolve with the eligible token
  deferredKey.resolve();
  const olderResult = await olderRefreshPromise;

  assert.equal(olderKeyCallResolved, true, "older key lookup did resolve");

  // Generation guard must have bailed: no state mutations, no fetch
  assert.equal(
    service.activeCacheKeys.has("anthropic"),
    false,
    "activeCacheKeys still has no entry after superseded older refresh",
  );
  assert.equal(
    service.getSnapshot("anthropic"),
    undefined,
    "getSnapshot returns undefined — credential was not reactivated",
  );
  assert.equal(fetchCount, 0, "superseded older refresh performed NO fetch");

  // The older refresh returns undefined (no active key after clearProvider)
  assert.equal(olderResult, undefined, "older superseded refresh returns undefined");
});
