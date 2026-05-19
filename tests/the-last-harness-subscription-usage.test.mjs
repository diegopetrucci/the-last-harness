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
	assert.ok(request?.init.headers.Authorization === `Bearer ${accessToken}`, "uses the supplied bearer token");
	assert.equal(request?.init.headers["anthropic-beta"], TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA);
	assert.equal(snapshot?.windows.session.used, 6);
	assert.equal(JSON.stringify(snapshot).includes(accessToken), false);

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
	assert.ok(requests[0]?.init.headers.Authorization === `Bearer ${accessToken}`, "uses the supplied bearer token");
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
	assert.equal(JSON.stringify(service.getSnapshot("openai-codex")).includes(accessToken), false);
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
	const mismatchCtx = {
		model: { provider: "anthropic" },
		modelRegistry: {
			isUsingOAuth: (model) => model?.provider === "anthropic",
			getApiKeyForProvider: async () => runtimeToken,
			authStorage: {
				get: (provider) => (provider === "anthropic" ? { type: "oauth", access: oauthToken } : undefined),
			},
		},
	};

	assert.equal(await noCacheService.refresh(mismatchCtx, { force: true }), undefined);
	assert.equal(fetchCalls, 0);

	let returnedToken = oauthToken;
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
			authStorage: {
				get: (provider) => (provider === "anthropic" ? { type: "oauth", access: oauthToken } : undefined),
			},
		},
	};

	const first = await staleService.refresh(staleCtx, { force: true });
	assert.equal(requests.length, 1);
	assert.ok(requests[0]?.init.headers.Authorization === `Bearer ${oauthToken}`, "uses the stored OAuth bearer token");

	returnedToken = runtimeToken;
	const stale = await staleService.refresh(staleCtx, { force: true });
	assert.equal(stale, first);
	assert.equal(requests.length, 1);
	assert.equal(JSON.stringify(stale).includes(runtimeToken), false);
});
