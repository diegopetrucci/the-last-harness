import { createHash } from "node:crypto";

export const TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA = "oauth-2025-04-20";
export const TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS = 3_000;

const SUPPORTED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const OPENAI_ACCOUNT_ID_KEYS = ["accountId", "account_id", "chatgptAccountId", "chatgpt_account_id"];
const NON_SECRET_CREDENTIAL_IDENTITY_KEYS = [
	...OPENAI_ACCOUNT_ID_KEYS,
	"organizationId",
	"organization_id",
	"workspaceId",
	"workspace_id",
	"tenantId",
	"tenant_id",
];
const WINDOW_CONTAINERS = ["usage", "rate_limit", "rateLimit", "limits", "windows", "message_limits", "messageLimits"];
const OPENAI_PRIMARY_WINDOW_KEYS = ["primary_window", "primaryWindow"];
const OPENAI_SECONDARY_WINDOW_KEYS = ["secondary_window", "secondaryWindow"];
const ANTHROPIC_SESSION_WINDOW_KEYS = ["five_hour", "fiveHour", "5h", "five_hours", "fiveHours"];
const ANTHROPIC_WEEKLY_WINDOW_KEYS = ["seven_day", "sevenDay", "seven_days", "sevenDays", "7d", "weekly", "week", "one_week", "oneWeek"];
const USAGE_PERCENT_KEYS = ["used_percent", "usedPercent", "utilization"];
const WINDOW_DURATION_SECONDS_KEYS = ["limit_window_seconds", "limitWindowSeconds"];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_WEEKLY_CANDIDATE_MS = WEEK_MS / 2;
const MAX_WEEKLY_CANDIDATE_MS = WEEK_MS * 2;

const credentialObjectIds = new WeakMap();
let nextCredentialObjectId = 1;

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function finiteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function positiveNumber(value) {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function pickNumber(source, keys) {
	for (const key of keys) {
		const value = positiveNumber(source?.[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function pickFiniteNumber(source, keys) {
	for (const key of keys) {
		const value = finiteNumber(source?.[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function pickString(source, keys) {
	for (const key of keys) {
		const value = source?.[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function credentialIdentityMetadataValue(value) {
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

function nonSecretCredentialIdentityMetadata(credential) {
	const stored = asObject(credential);
	if (!stored) {
		return undefined;
	}
	const entries = [];
	for (const key of NON_SECRET_CREDENTIAL_IDENTITY_KEYS) {
		const value = credentialIdentityMetadataValue(stored[key]);
		if (value !== undefined) {
			entries.push([key, value]);
		}
	}
	return entries.length > 0 ? JSON.stringify(entries) : undefined;
}

function credentialObjectIdentity(credential) {
	const stored = asObject(credential);
	if (!stored) {
		return undefined;
	}
	let identity = credentialObjectIds.get(stored);
	if (identity === undefined) {
		identity = nextCredentialObjectId;
		nextCredentialObjectId += 1;
		credentialObjectIds.set(stored, identity);
	}
	return String(identity);
}

// Stable, one-way fingerprint of a bearer access token. We use this as a
// secondary throttle key so a fresh credential object (Pi's AuthStorage.set()
// replaces the object on every OAuth refresh) cannot bypass the per-cacheKey
// rate limit when the underlying bearer is unchanged. The hash is never
// logged or returned to callers.
function accessTokenFingerprint(accessToken) {
	if (typeof accessToken !== "string" || !accessToken) {
		return undefined;
	}
	return createHash("sha256").update(accessToken).digest("hex");
}

function clampPercent(value) {
	return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function normalizeCount(value) {
	if (value === undefined) {
		return undefined;
	}
	return Math.round(value * 1000) / 1000;
}

function normalizeIsoTime(value) {
	if (typeof value === "string" && value.trim()) {
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
	}
	const numeric = finiteNumber(value);
	if (numeric === undefined) {
		return undefined;
	}
	const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function resetAtFromRelativeSeconds(source, nowMs) {
	const seconds = pickNumber(source, ["seconds_until_reset", "reset_seconds", "resetAfterSeconds", "reset_after_seconds", "resetsInSeconds", "resets_in_seconds"]);
	return seconds !== undefined ? new Date(nowMs + seconds * 1000).toISOString() : undefined;
}

function normalizeWindowDurationMs(source) {
	const seconds = pickNumber(source, WINDOW_DURATION_SECONDS_KEYS);
	return seconds !== undefined ? Math.round(seconds * 1000) : undefined;
}

function normalizeResetTime(source, nowMs) {
	return (
		normalizeIsoTime(source.reset_at) ??
		normalizeIsoTime(source.resetAt) ??
		normalizeIsoTime(source.resets_at) ??
		normalizeIsoTime(source.resetsAt) ??
		normalizeIsoTime(source.reset_time) ??
		normalizeIsoTime(source.resetTime) ??
		normalizeIsoTime(source.end_time) ??
		normalizeIsoTime(source.endTime) ??
		resetAtFromRelativeSeconds(source, nowMs)
	);
}

function normalizeUsageWindow(source, key, label, nowMs) {
	const window = asObject(source);
	if (!window) {
		return undefined;
	}

	let limit = pickNumber(window, [
		"limit",
		"max",
		"maximum",
		"quota",
		"cap",
		"total",
		"allowed",
		"requests_limit",
		"request_limit",
		"messages_limit",
		"message_limit",
		"max_messages",
		"maxMessages",
		"max_tokens",
		"maxTokens",
	]);
	let used = pickNumber(window, [
		"used",
		"usage",
		"current",
		"consumed",
		"count",
		"requests_used",
		"request_count",
		"messages_used",
		"message_count",
		"used_messages",
		"usedMessages",
		"used_tokens",
		"usedTokens",
	]);
	let remaining = pickNumber(window, [
		"remaining",
		"available",
		"left",
		"requests_remaining",
		"remaining_requests",
		"messages_remaining",
		"remaining_messages",
		"remainingMessages",
		"remaining_tokens",
		"remainingTokens",
	]);
	const percent = pickFiniteNumber(window, USAGE_PERCENT_KEYS);
	const resetsAt = normalizeResetTime(window, nowMs);
	const durationMs = normalizeWindowDurationMs(window);

	if (used === undefined && limit !== undefined && remaining !== undefined) {
		used = Math.max(0, limit - remaining);
	}
	if (remaining === undefined && limit !== undefined && used !== undefined) {
		remaining = Math.max(0, limit - used);
	}
	if (limit === undefined && used !== undefined && remaining !== undefined) {
		limit = used + remaining;
	}

	const normalized = { key, label };
	const normalizedUsed = normalizeCount(used);
	const normalizedLimit = normalizeCount(limit);
	const normalizedRemaining = normalizeCount(remaining);
	if (normalizedUsed !== undefined) {
		normalized.used = normalizedUsed;
	}
	if (normalizedLimit !== undefined) {
		normalized.limit = normalizedLimit;
	}
	if (normalizedRemaining !== undefined) {
		normalized.remaining = normalizedRemaining;
	}
	if (percent !== undefined) {
		normalized.percent = clampPercent(percent);
	} else if (normalizedUsed !== undefined && normalizedLimit !== undefined && normalizedLimit > 0) {
		normalized.percent = clampPercent((normalizedUsed / normalizedLimit) * 100);
	}
	if (resetsAt) {
		normalized.resetsAt = resetsAt;
	}
	if (durationMs !== undefined) {
		normalized.durationMs = durationMs;
	}

	return Object.keys(normalized).length > 2 ? normalized : undefined;
}

function collectWindowContainers(data) {
	const root = asObject(data);
	if (!root) {
		return [];
	}
	const containers = [root];
	for (const key of WINDOW_CONTAINERS) {
		const container = asObject(root[key]);
		if (container) {
			containers.push(container);
		}
	}
	return containers;
}

function findWindow(data, keys) {
	for (const container of collectWindowContainers(data)) {
		for (const key of keys) {
			const value = asObject(container[key]);
			if (value) {
				return { key, value };
			}
		}
	}
	return undefined;
}

function parseDurationMs(value) {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) {
		return numeric * 1000;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
	if (!normalized) {
		return undefined;
	}
	if (["weekly", "week", "one-week", "seven-day", "seven-days", "7-day", "7-days", "7d", "p7d"].includes(normalized)) {
		return WEEK_MS;
	}
	if (["five-hour", "five-hours", "5-hour", "5-hours", "5h"].includes(normalized)) {
		return 5 * 60 * 60 * 1000;
	}
	const wordMatch = /^(one|two|three|four|five|six|seven|eight|nine|ten)-(hour|hours|day|days|week|weeks)$/.exec(normalized);
	if (wordMatch) {
		const wordAmounts = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
		const amount = wordAmounts[wordMatch[1]];
		const unit = wordMatch[2];
		if (unit === "hour" || unit === "hours") return amount * 60 * 60 * 1000;
		if (unit === "day" || unit === "days") return amount * 24 * 60 * 60 * 1000;
		return amount * WEEK_MS;
	}
	const match = /^(\d+(?:\.\d+)?)(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(
		normalized,
	);
	if (!match) {
		return undefined;
	}
	const amount = Number(match[1]);
	const unit = match[2];
	if (!Number.isFinite(amount)) {
		return undefined;
	}
	if (unit === "ms") return amount;
	if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return amount * 1000;
	if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return amount * 60 * 1000;
	if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return amount * 60 * 60 * 1000;
	if (["d", "day", "days"].includes(unit)) return amount * 24 * 60 * 60 * 1000;
	if (["w", "week", "weeks"].includes(unit)) return amount * WEEK_MS;
	return undefined;
}

function numericDurationMs(value, unitMs) {
	const numeric = finiteNumber(value);
	if (numeric !== undefined) {
		return numeric * unitMs;
	}
	return parseDurationMs(value);
}

function durationMsForWindow(key, value) {
	const window = asObject(value);
	return (
		parseDurationMs(key) ??
		parseDurationMs(window?.duration) ??
		numericDurationMs(window?.duration_ms, 1) ??
		numericDurationMs(window?.durationMs, 1) ??
		numericDurationMs(window?.duration_seconds, 1000) ??
		numericDurationMs(window?.durationSeconds, 1000) ??
		parseDurationMs(window?.window) ??
		parseDurationMs(window?.window_name) ??
		parseDurationMs(window?.windowName) ??
		parseDurationMs(window?.period) ??
		parseDurationMs(window?.interval)
	);
}

function findClosestWeeklyWindow(data, sessionKey) {
	let best;
	for (const container of collectWindowContainers(data)) {
		for (const [key, value] of Object.entries(container)) {
			if (key === sessionKey || !asObject(value)) {
				continue;
			}
			const durationMs = durationMsForWindow(key, value);
			if (durationMs === undefined || durationMs < MIN_WEEKLY_CANDIDATE_MS || durationMs > MAX_WEEKLY_CANDIDATE_MS) {
				continue;
			}
			const distance = Math.abs(durationMs - WEEK_MS);
			if (!best || distance < best.distance) {
				best = { key, value, distance };
			}
		}
	}
	return best;
}

function createSnapshot(provider, session, weekly, fetchedAt) {
	if (!session) {
		return undefined;
	}
	const windows = { session };
	if (weekly) {
		windows.weekly = weekly;
	}
	return { provider, fetchedAt, windows };
}

export function isSupportedTlhSubscriptionUsageProvider(provider) {
	return SUPPORTED_PROVIDERS.has(provider);
}

export function normalizeOpenAICodexUsage(data, options = {}) {
	const nowMs = options.nowMs ?? Date.now();
	const primary = findWindow(data, OPENAI_PRIMARY_WINDOW_KEYS);
	const secondary = findWindow(data, OPENAI_SECONDARY_WINDOW_KEYS);
	const session = normalizeUsageWindow(primary?.value, primary?.key ?? "primary_window", "session", nowMs);
	const weekly = normalizeUsageWindow(secondary?.value, secondary?.key ?? "secondary_window", "weekly", nowMs);
	return createSnapshot("openai-codex", session, weekly, nowMs);
}

export function normalizeAnthropicUsage(data, options = {}) {
	const nowMs = options.nowMs ?? Date.now();
	const fiveHour = findWindow(data, ANTHROPIC_SESSION_WINDOW_KEYS);
	const sevenDay = findWindow(data, ANTHROPIC_WEEKLY_WINDOW_KEYS) ?? findClosestWeeklyWindow(data, fiveHour?.key);
	const session = normalizeUsageWindow(fiveHour?.value, fiveHour?.key ?? "five_hour", "session", nowMs);
	const weekly = normalizeUsageWindow(sevenDay?.value, sevenDay?.key ?? "seven_day", "weekly", nowMs);
	return createSnapshot("anthropic", session, weekly, nowMs);
}

function timeoutSignal(timeoutMs) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
		return undefined;
	}
	return AbortSignal.timeout(timeoutMs);
}

async function responseJson(response) {
	if (!response?.ok || typeof response.json !== "function") {
		return undefined;
	}
	return response.json();
}

function oauthCredentialFromRegistry(modelRegistry, provider) {
	const credential = modelRegistry?.authStorage?.get?.(provider);
	return asObject(credential)?.type === "oauth" ? credential : undefined;
}

function readOauthCredentialFromRegistry(modelRegistry, provider) {
	try {
		return { status: "ok", credential: oauthCredentialFromRegistry(modelRegistry, provider) };
	} catch {
		return { status: "transient-unavailable" };
	}
}

function oauthAccessTokenFromCredential(credential) {
	const stored = asObject(credential);
	if (stored?.type !== "oauth") {
		return undefined;
	}
	const access = typeof stored.access === "string" ? stored.access.trim() : "";
	return access || undefined;
}

function openAiAccountIdFromCredential(credential) {
	const stored = asObject(credential);
	if (!stored) {
		return undefined;
	}
	return pickString(stored, OPENAI_ACCOUNT_ID_KEYS);
}

function oauthCredentialIdentity(provider, credential) {
	const accountId = provider === "openai-codex" ? openAiAccountIdFromCredential(credential) : undefined;
	if (accountId) {
		return `account:${accountId}`;
	}
	const metadata = nonSecretCredentialIdentityMetadata(credential);
	if (metadata) {
		return `credential:${metadata}`;
	}
	const objectIdentity = credentialObjectIdentity(credential);
	return objectIdentity ? `credential-object:${objectIdentity}` : undefined;
}

function subscriptionUsageCacheKey(provider, credentialIdentity) {
	return `${provider}\t${credentialIdentity}`;
}

function cacheKeyMatchesProvider(cacheKey, provider) {
	return typeof cacheKey === "string" && cacheKey.startsWith(`${provider}\t`);
}

function hasRuntimeCredentialOverride(modelRegistry, provider) {
	try {
		const runtimeOverrides = modelRegistry?.authStorage?.runtimeOverrides;
		return runtimeOverrides instanceof Map && runtimeOverrides.has(provider);
	} catch {
		return false;
	}
}

function openAiHeaders(accessToken, accountId) {
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
	};
	if (accountId) {
		headers["ChatGPT-Account-Id"] = accountId;
	}
	return headers;
}

function anthropicHeaders(accessToken) {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA,
	};
}

export async function fetchTlhSubscriptionUsage(target, options = {}) {
	const provider = target?.provider;
	const accessToken = typeof target?.accessToken === "string" ? target.accessToken.trim() : "";
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (!isSupportedTlhSubscriptionUsageProvider(provider) || !accessToken || typeof fetchImpl !== "function") {
		return undefined;
	}

	const nowMs = options.nowMs ?? Date.now();
	const signal = timeoutSignal(options.timeoutMs ?? TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS);
	try {
		if (provider === "openai-codex") {
			const response = await fetchImpl(TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL, {
				method: "GET",
				headers: openAiHeaders(accessToken, target.accountId),
				signal,
			});
			return normalizeOpenAICodexUsage(await responseJson(response), { nowMs });
		}
		if (provider === "anthropic") {
			const response = await fetchImpl(TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL, {
				method: "GET",
				headers: anthropicHeaders(accessToken),
				signal,
			});
			return normalizeAnthropicUsage(await responseJson(response), { nowMs });
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveTlhSubscriptionUsageProviderContext(ctx) {
	const model = ctx?.model;
	const provider = model?.provider;
	const modelRegistry = ctx?.modelRegistry;
	if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
		return { status: "unsupported", provider };
	}
	if (!modelRegistry || typeof modelRegistry.isUsingOAuth !== "function") {
		return { status: "ineligible", provider };
	}

	try {
		if (!modelRegistry.isUsingOAuth(model)) {
			return { status: "ineligible", provider };
		}
	} catch {
		return { status: "transient-unavailable", provider };
	}

	const credentialResult = readOauthCredentialFromRegistry(modelRegistry, provider);
	if (credentialResult.status !== "ok") {
		return { status: "transient-unavailable", provider };
	}
	if (!credentialResult.credential) {
		return { status: "ineligible", provider };
	}
	return { status: "eligible", model, provider, modelRegistry, credential: credentialResult.credential };
}

function resolveTlhSubscriptionUsageProvider(ctx) {
	const resolved = resolveTlhSubscriptionUsageProviderContext(ctx);
	return resolved.status === "eligible" ? resolved : undefined;
}

function credentialCacheTarget(provider, credential) {
	const credentialIdentity = oauthCredentialIdentity(provider, credential);
	if (!credentialIdentity) {
		return undefined;
	}
	return {
		provider,
		accountId: provider === "openai-codex" ? openAiAccountIdFromCredential(credential) : undefined,
		cacheKey: subscriptionUsageCacheKey(provider, credentialIdentity),
	};
}

function resolveTlhSubscriptionUsageDisplayTarget(ctx) {
	const resolved = resolveTlhSubscriptionUsageProvider(ctx);
	if (!resolved || hasRuntimeCredentialOverride(resolved.modelRegistry, resolved.provider)) {
		return undefined;
	}

	return credentialCacheTarget(resolved.provider, resolved.credential);
}

async function resolveTlhSubscriptionUsageTarget(resolved) {
	const { provider, modelRegistry } = resolved;
	let accessToken;
	try {
		accessToken = await modelRegistry.getApiKeyForProvider?.(provider);
	} catch {
		return { status: "transient-unavailable" };
	}

	const normalizedAccessToken = typeof accessToken === "string" ? accessToken.trim() : "";
	if (!normalizedAccessToken) {
		return { status: "transient-unavailable" };
	}

	const credentialResult = readOauthCredentialFromRegistry(modelRegistry, provider);
	if (credentialResult.status !== "ok") {
		return { status: "transient-unavailable" };
	}
	if (!credentialResult.credential) {
		return { status: "ineligible" };
	}

	const credentialAccessToken = oauthAccessTokenFromCredential(credentialResult.credential);
	if (!credentialAccessToken) {
		return { status: "transient-unavailable" };
	}
	if (normalizedAccessToken !== credentialAccessToken) {
		return { status: "mismatch" };
	}

	const target = credentialCacheTarget(provider, credentialResult.credential);
	if (!target) {
		return { status: "ineligible" };
	}
	return {
		status: "resolved",
		target: {
			provider,
			accessToken: credentialAccessToken,
			accountId: target.accountId,
			cacheKey: target.cacheKey,
		},
	};
}

export class TlhSubscriptionUsageService {
	constructor(options = {}) {
		this.fetch = options.fetch;
		this.now = typeof options.now === "function" ? options.now : () => Date.now();
		this.cacheTtlMs = options.cacheTtlMs ?? TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS;
		this.minFetchIntervalMs = options.minFetchIntervalMs ?? TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS;
		this.timeoutMs = options.timeoutMs ?? TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS;
		this.snapshots = new Map();
		this.lastAttempts = new Map();
		// Secondary throttle keyed on a SHA-256 hash of the bearer access
		// token. Pi's AuthStorage.set() swaps the credential object on every
		// OAuth refresh, which produces a fresh WeakMap-based cacheKey for
		// Anthropic credentials and would otherwise reset lastAttempts on
		// every rotation. Entries here are intentionally not cleared by
		// clearProvider() so the throttle survives the credential swap.
		this.lastAccessTokenAttempts = new Map();
		this.inFlight = new Map();
		this.activeCacheKeys = new Map();
		this.ineligibleCacheKeys = new Map();
	}

	snapshotForCacheKey(provider, cacheKey) {
		return this.activeCacheKeys.get(provider) === cacheKey ? this.snapshots.get(cacheKey) : undefined;
	}

	getSnapshot(provider) {
		if (provider !== undefined && !isSupportedTlhSubscriptionUsageProvider(provider)) {
			return undefined;
		}
		if (provider) {
			const cacheKey = this.activeCacheKeys.get(provider);
			return cacheKey ? this.snapshots.get(cacheKey) : undefined;
		}
		return Array.from(this.activeCacheKeys.entries())
			.map(([snapshotProvider, cacheKey]) => this.snapshotForCacheKey(snapshotProvider, cacheKey))
			.filter(Boolean)
			.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
	}

	getSnapshotForContext(ctx) {
		const target = resolveTlhSubscriptionUsageDisplayTarget(ctx);
		if (!target) {
			return undefined;
		}
		return this.snapshotForCacheKey(target.provider, target.cacheKey);
	}

	isEligible(target) {
		if (typeof target === "string") {
			return isSupportedTlhSubscriptionUsageProvider(target) && this.activeCacheKeys.has(target);
		}
		const displayTarget = resolveTlhSubscriptionUsageDisplayTarget(target);
		return Boolean(displayTarget && this.ineligibleCacheKeys.get(displayTarget.provider) !== displayTarget.cacheKey);
	}

	clearProvider(provider) {
		if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
			return;
		}
		this.activeCacheKeys.delete(provider);
		for (const key of this.snapshots.keys()) {
			if (cacheKeyMatchesProvider(key, provider)) {
				this.snapshots.delete(key);
			}
		}
		for (const key of this.lastAttempts.keys()) {
			if (cacheKeyMatchesProvider(key, provider)) {
				this.lastAttempts.delete(key);
			}
		}
		for (const key of this.inFlight.keys()) {
			if (cacheKeyMatchesProvider(key, provider)) {
				this.inFlight.delete(key);
			}
		}
		this.ineligibleCacheKeys.delete(provider);
	}

	activateTarget(provider, cacheKey) {
		if (this.activeCacheKeys.get(provider) !== cacheKey) {
			this.clearProvider(provider);
			this.activeCacheKeys.set(provider, cacheKey);
		}
	}

	clear() {
		this.snapshots.clear();
		this.lastAttempts.clear();
		this.lastAccessTokenAttempts.clear();
		this.inFlight.clear();
		this.activeCacheKeys.clear();
		this.ineligibleCacheKeys.clear();
	}

	async refresh(ctx, options = {}) {
		const provider = ctx?.model?.provider;
		if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
			return undefined;
		}

		const resolved = resolveTlhSubscriptionUsageProviderContext(ctx);
		if (resolved.status === "transient-unavailable") {
			return undefined;
		}
		if (resolved.status !== "eligible") {
			this.clearProvider(provider);
			return undefined;
		}
		if (hasRuntimeCredentialOverride(resolved.modelRegistry, provider)) {
			this.clearProvider(provider);
			return undefined;
		}

		const credentialTarget = credentialCacheTarget(provider, resolved.credential);
		if (!credentialTarget) {
			this.clearProvider(provider);
			return undefined;
		}
		const activeCacheKey = this.activeCacheKeys.get(provider);
		if (activeCacheKey && activeCacheKey !== credentialTarget.cacheKey) {
			this.clearProvider(provider);
		}

		const nowMs = this.now();
		const targetResult = await resolveTlhSubscriptionUsageTarget(resolved);
		if (targetResult.status === "transient-unavailable") {
			return this.snapshotForCacheKey(provider, credentialTarget.cacheKey);
		}
		if (targetResult.status !== "resolved") {
			this.clearProvider(provider);
			if (targetResult.status === "mismatch") {
				this.ineligibleCacheKeys.set(provider, credentialTarget.cacheKey);
			}
			return undefined;
		}

		const target = targetResult.target;
		if (target.cacheKey !== credentialTarget.cacheKey) {
			this.clearProvider(provider);
		}

		const cacheKey = target.cacheKey;
		this.activateTarget(provider, cacheKey);
		const cached = this.snapshots.get(cacheKey);
		const lastAttempt = this.lastAttempts.get(cacheKey);
		// Both throttle windows must be stale before we issue another network
		// call. The cacheKey throttle covers steady-state identity, while the
		// access-token-hash throttle survives credential object rotation when
		// the underlying bearer is unchanged (Pi mints a new credential
		// object on every OAuth refresh).
		const tokenFingerprint = accessTokenFingerprint(target.accessToken);
		const lastTokenAttempt = tokenFingerprint !== undefined ? this.lastAccessTokenAttempts.get(tokenFingerprint) : undefined;
		if (!options.force && cached && nowMs - cached.fetchedAt < this.cacheTtlMs) {
			return cached;
		}
		if (!options.force && lastAttempt !== undefined && nowMs - lastAttempt < this.minFetchIntervalMs) {
			return cached;
		}
		if (!options.force && lastTokenAttempt !== undefined && nowMs - lastTokenAttempt < this.minFetchIntervalMs) {
			return cached;
		}

		const existing = this.inFlight.get(cacheKey);
		if (existing) {
			return existing;
		}

		this.lastAttempts.set(cacheKey, nowMs);
		if (tokenFingerprint !== undefined) {
			this.lastAccessTokenAttempts.set(tokenFingerprint, nowMs);
		}
		const pending = (async () => {
			const snapshot = await fetchTlhSubscriptionUsage(target, {
				fetch: this.fetch,
				nowMs,
				timeoutMs: this.timeoutMs,
			});
			if (snapshot?.provider === provider && this.activeCacheKeys.get(provider) === cacheKey) {
				this.snapshots.set(cacheKey, snapshot);
				return snapshot;
			}
			return this.snapshotForCacheKey(provider, cacheKey);
		})();
		this.inFlight.set(cacheKey, pending);
		try {
			return await pending;
		} catch {
			return this.snapshotForCacheKey(provider, cacheKey);
		} finally {
			if (this.inFlight.get(cacheKey) === pending) {
				this.inFlight.delete(cacheKey);
			}
		}
	}
}

export function createTlhSubscriptionUsageService(options = {}) {
	return new TlhSubscriptionUsageService(options);
}
