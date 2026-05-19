export const TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA = "oauth-2025-04-20";
export const TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS = 3_000;

const SUPPORTED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const OPENAI_ACCOUNT_ID_KEYS = ["accountId", "account_id", "chatgptAccountId", "chatgpt_account_id"];
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

function resolveTlhSubscriptionUsageProvider(ctx) {
	const model = ctx?.model;
	const provider = model?.provider;
	const modelRegistry = ctx?.modelRegistry;
	if (!isSupportedTlhSubscriptionUsageProvider(provider) || !modelRegistry) {
		return undefined;
	}

	try {
		if (typeof modelRegistry.isUsingOAuth !== "function" || !modelRegistry.isUsingOAuth(model)) {
			return undefined;
		}
		if (modelRegistry.authStorage?.get?.(provider)?.type !== "oauth") {
			return undefined;
		}
		return { model, provider, modelRegistry };
	} catch {
		return undefined;
	}
}

async function resolveTlhSubscriptionUsageTarget(ctx) {
	const resolved = resolveTlhSubscriptionUsageProvider(ctx);
	if (!resolved) {
		return undefined;
	}

	const { provider, modelRegistry } = resolved;
	try {
		const accessToken = await modelRegistry.getApiKeyForProvider?.(provider);
		const credential = modelRegistry.authStorage?.get?.(provider);
		const credentialAccessToken = oauthAccessTokenFromCredential(credential);
		if (typeof accessToken !== "string" || accessToken.trim() !== credentialAccessToken) {
			return undefined;
		}
		return {
			provider,
			accessToken: credentialAccessToken,
			accountId: provider === "openai-codex" ? openAiAccountIdFromCredential(credential) : undefined,
		};
	} catch {
		return undefined;
	}
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
		this.inFlight = new Map();
	}

	getSnapshot(provider) {
		if (provider !== undefined && !isSupportedTlhSubscriptionUsageProvider(provider)) {
			return undefined;
		}
		if (provider) {
			return this.snapshots.get(provider);
		}
		return Array.from(this.snapshots.values()).sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
	}

	clear() {
		this.snapshots.clear();
		this.lastAttempts.clear();
		this.inFlight.clear();
	}

	async refresh(ctx, options = {}) {
		const resolved = resolveTlhSubscriptionUsageProvider(ctx);
		if (!resolved) {
			return undefined;
		}

		const provider = resolved.provider;
		const nowMs = this.now();
		const cached = this.snapshots.get(provider);
		const lastAttempt = this.lastAttempts.get(provider);
		if (!options.force && cached && nowMs - cached.fetchedAt < this.cacheTtlMs) {
			return cached;
		}
		if (!options.force && lastAttempt !== undefined && nowMs - lastAttempt < this.minFetchIntervalMs) {
			return cached;
		}

		const existing = this.inFlight.get(provider);
		if (existing) {
			return existing;
		}

		this.lastAttempts.set(provider, nowMs);
		const pending = (async () => {
			const target = await resolveTlhSubscriptionUsageTarget(ctx);
			if (!target) {
				return cached;
			}
			const snapshot = await fetchTlhSubscriptionUsage(target, {
				fetch: this.fetch,
				nowMs,
				timeoutMs: this.timeoutMs,
			});
			if (snapshot) {
				this.snapshots.set(provider, snapshot);
				return snapshot;
			}
			return this.snapshots.get(provider);
		})();
		this.inFlight.set(provider, pending);
		try {
			return await pending;
		} catch {
			return this.snapshots.get(provider);
		} finally {
			this.inFlight.delete(provider);
		}
	}
}

export function createTlhSubscriptionUsageService(options = {}) {
	return new TlhSubscriptionUsageService(options);
}
