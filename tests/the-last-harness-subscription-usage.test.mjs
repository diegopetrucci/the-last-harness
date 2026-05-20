import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
	TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA,
	TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL,
	TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL,
	createTlhSubscriptionUsageService,
	fetchTlhSubscriptionUsage,
	normalizeAnthropicUsage,
	normalizeOpenAICodexUsage,
} from "../extensions/the-last-harness/subscription-usage.mjs";

const NOW_MS = Date.parse("2026-05-19T19:00:00Z");
const RESET_AT = "2026-05-19T20:00:00.000Z";

function openAiUsage(used = 25) {
	return {
		rate_limit: {
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
		},
	};
}

function assertNoCredentialMaterial(value) {
	assert.doesNotMatch(JSON.stringify(value), /Authorization|Bearer|access|refresh|token/i);
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

test("normalizes OpenAI/Codex wham usage primary and secondary windows", () => {
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

test("normalizes Anthropic OAuth five-hour and closest weekly windows", () => {
	const snapshot = normalizeAnthropicUsage(
		{
			usage: {
				five_hour: {
					used_tokens: 40,
					max_tokens: 100,
					reset_time: RESET_AT,
				},
				six_day: {
					used: 300,
					limit: 1000,
					duration: "6d",
				},
				monthly: {
					used: 1,
					limit: 2,
					duration: "30d",
				},
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
		key: "six_day",
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
		await fetchTlhSubscriptionUsage({ provider: "openrouter", accessToken: randomUUID() }, { fetch: fetchImpl, timeoutMs: 0 }),
		undefined,
	);
	assert.equal(await fetchTlhSubscriptionUsage({ provider: "openai-codex", accessToken: " " }, { fetch: fetchImpl, timeoutMs: 0 }), undefined);
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

test("service preserves Anthropic cached usage across same stable-metadata credential reloads", async () => {
	const accessToken = randomUUID();
	const refreshToken = randomUUID();
	const expires = NOW_MS + 60_000;
	const organizationId = "org_test";
	let keyMode = "ok";
	let fetchCalls = 0;
	let credential = { type: "oauth", access: accessToken, refresh: refreshToken, expires, organizationId };
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
	assert.equal(cacheKeys.length, 1);
	assert.match(cacheKeys[0], /^anthropic\tcredential:/);
	assert.match(cacheKeys[0], /organizationId/);
	assert.doesNotMatch(cacheKeys[0], /object|expires|access|refresh|token/i);

	credential = { type: "oauth", access: accessToken, refresh: refreshToken, expires, organizationId };
	keyMode = "undefined";
	assert.equal(service.getSnapshotForContext(ctx), first);
	assert.equal(await service.refresh(ctx, { force: true }), first);
	assert.equal(fetchCalls, 1);
});

test("service does not reuse Anthropic cached usage across expiry-only credential reloads", async () => {
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
	assert.equal(cacheKeys.length, 1);
	assert.match(cacheKeys[0], /^anthropic\tcredential-object:/);
	assert.doesNotMatch(cacheKeys[0], /expires|access|refresh|token/i);

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
	let credential = { type: "oauth", access: accessToken, refresh: refreshToken, expires: NOW_MS + 60_000 };
	const service = createTlhSubscriptionUsageService({
		now: () => NOW_MS,
		cacheTtlMs: 60_000,
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

	// Simulate Pi's AuthStorage.set() replacing the credential object on an
	// OAuth refresh: new object identity (and a bumped expiry) but the same
	// bearer access token. The cacheKey-based throttle resets because the
	// WeakMap-derived synthetic id changes; only the access-token-hash
	// throttle should keep the redundant fetch from going through.
	credential = { type: "oauth", access: accessToken, refresh: refreshToken, expires: NOW_MS + 120_000 };

	await service.refresh(ctx);
	assert.equal(fetchCalls, 1);

	// And again, just to make sure the throttle remains armed for the
	// rotated cacheKey rather than only firing on the first attempt.
	await service.refresh(ctx);
	assert.equal(fetchCalls, 1);

	// Cache keys must remain keyed on the existing cacheKey scheme even
	// though the secondary throttle now covers the rotation case.
	for (const key of service.snapshots.keys()) {
		assert.doesNotMatch(key, /access|refresh|token/i);
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

	// Issue two concurrent refresh() calls without awaiting between them so
	// both reach the in-flight check before the network request resolves.
	const firstPromise = service.refresh(ctx);
	const secondPromise = service.refresh(ctx);

	// Drain pending microtasks so each refresh() advances past its internal
	// awaits (credential resolution) and either populates or observes the
	// in-flight entry. The deferred fetch promise keeps both calls parked
	// until we explicitly resolve it below, so this is deterministic.
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(fetchCalls, 1, "fetch is invoked exactly once for concurrent refreshes");

	deferred.resolve({ ok: true, json: async () => openAiUsage(50) });

	const [first, second] = await Promise.all([firstPromise, secondPromise]);

	assert.equal(fetchCalls, 1, "no additional fetch occurs after the deferred resolves");
	assert.ok(first, "first refresh produced a snapshot");
	assert.equal(first, second, "both refresh() calls resolve to the same snapshot instance");
	assert.equal(first?.windows.session.used, 50);
});
