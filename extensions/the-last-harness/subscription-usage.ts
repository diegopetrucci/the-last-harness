import { createHash } from "node:crypto";

import type { TlhSubscriptionUsageProvider, TlhSubscriptionUsageSnapshot, TlhSubscriptionUsageWindow } from "./types.js";

export const TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA = "oauth-2025-04-20";
export const TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS = 3_000;

const SUPPORTED_PROVIDERS = new Set<TlhSubscriptionUsageProvider>(["openai-codex", "anthropic"]);
const ACCOUNT_ID_KEYS = ["accountId", "account_id", "chatgptAccountId", "chatgpt_account_id"] as const;
const USAGE_PERCENT_KEYS = ["used_percent", "usedPercent", "utilization"] as const;
const WINDOW_DURATION_SECONDS_KEYS = ["limit_window_seconds", "limitWindowSeconds"] as const;

type JsonRecord = Record<string, unknown>;
type TlhSubscriptionUsageFetch = typeof globalThis.fetch;
type ResponseLike = {
	ok?: boolean;
	json?: (() => Promise<unknown>) | (() => unknown);
};
type TlhSubscriptionUsageTarget = {
	provider?: unknown;
	accessToken?: unknown;
	accountId?: string;
};
type TlhSubscriptionUsageFetchOptions = {
	fetch?: TlhSubscriptionUsageFetch;
	nowMs?: number;
	timeoutMs?: number;
};
type TlhSubscriptionUsageContext = {
	model?: { provider?: unknown };
	modelRegistry?: TlhSubscriptionUsageModelRegistry;
};
type TlhSubscriptionUsageModelRegistry = {
	isUsingOAuth?(model: unknown): boolean;
	getApiKeyForProvider?(provider: string): Promise<unknown> | unknown;
	authStorage?: unknown;
};
type EligibleProviderContext = {
	status: "eligible";
	model: TlhSubscriptionUsageContext["model"];
	provider: TlhSubscriptionUsageProvider;
	modelRegistry: TlhSubscriptionUsageModelRegistry;
	credential: JsonRecord;
};
type ResolvedProviderContext =
	| EligibleProviderContext
	| { status: "unsupported"; provider: unknown }
	| { status: "ineligible"; provider: TlhSubscriptionUsageProvider }
	| { status: "transient-unavailable"; provider: TlhSubscriptionUsageProvider };
type CredentialResult =
	| { status: "ok"; credential: JsonRecord | undefined }
	| { status: "transient-unavailable" };
type CredentialCacheTarget = {
	provider: TlhSubscriptionUsageProvider;
	accountId?: string;
	cacheKey: string;
};
type ResolvedTargetResult =
	| { status: "resolved"; target: CredentialCacheTarget & { accessToken: string } }
	| { status: "transient-unavailable" }
	| { status: "ineligible" }
	| { status: "mismatch" };

export type TlhSubscriptionUsageServiceOptions = {
	fetch?: TlhSubscriptionUsageFetch;
	now?: () => number;
	cacheTtlMs?: number;
	minFetchIntervalMs?: number;
	timeoutMs?: number;
};

function asObject(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function pickNumber(source: JsonRecord | undefined, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = positiveNumber(source?.[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function pickFiniteNumber(source: JsonRecord | undefined, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = finiteNumber(source?.[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function pickString(source: JsonRecord | undefined, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = source?.[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

// Stable, one-way fingerprint of a bearer access token. Used in cache keys
// only when no account id is available; raw bearer material is never stored in
// usage service state or returned in snapshots.
function accessTokenFingerprint(accessToken: unknown): string | undefined {
	if (typeof accessToken !== "string" || !accessToken) {
		return undefined;
	}
	return createHash("sha256").update(accessToken).digest("hex");
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function normalizeCount(value: number | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	return Math.round(value * 1000) / 1000;
}

function normalizeIsoTime(value: unknown): string | undefined {
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

function resetAtFromRelativeSeconds(source: JsonRecord, nowMs: number): string | undefined {
	const seconds = pickNumber(source, [
		"seconds_until_reset",
		"reset_seconds",
		"resetAfterSeconds",
		"reset_after_seconds",
		"resetsInSeconds",
		"resets_in_seconds",
	]);
	return seconds !== undefined ? new Date(nowMs + seconds * 1000).toISOString() : undefined;
}

function normalizeWindowDurationMs(source: JsonRecord): number | undefined {
	const seconds = pickNumber(source, WINDOW_DURATION_SECONDS_KEYS);
	return seconds !== undefined ? Math.round(seconds * 1000) : undefined;
}

function normalizeResetTime(source: JsonRecord, nowMs: number): string | undefined {
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

function normalizeUsageWindow(
	source: unknown,
	key: string,
	label: string,
	nowMs: number,
): TlhSubscriptionUsageWindow | undefined {
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

	const normalized: TlhSubscriptionUsageWindow = { key, label };
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

function createSnapshot(
	provider: TlhSubscriptionUsageProvider,
	session: TlhSubscriptionUsageWindow | undefined,
	weekly: TlhSubscriptionUsageWindow | undefined,
	fetchedAt: number,
): TlhSubscriptionUsageSnapshot | undefined {
	if (!session) {
		return undefined;
	}
	const windows: TlhSubscriptionUsageSnapshot["windows"] = { session };
	if (weekly) {
		windows.weekly = weekly;
	}
	return { provider, fetchedAt, windows };
}

export function isSupportedTlhSubscriptionUsageProvider(provider: unknown): provider is TlhSubscriptionUsageProvider {
	return typeof provider === "string" && SUPPORTED_PROVIDERS.has(provider as TlhSubscriptionUsageProvider);
}

export function normalizeOpenAICodexUsage(
	data: unknown,
	options: { nowMs?: number } = {},
): TlhSubscriptionUsageSnapshot | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const root = asObject(data);
	const rateLimit = asObject(root?.rate_limit);
	const session = normalizeUsageWindow(rateLimit?.primary_window ?? root?.primary_window, "primary_window", "session", nowMs);
	const weekly = normalizeUsageWindow(rateLimit?.secondary_window ?? root?.secondary_window, "secondary_window", "weekly", nowMs);
	return createSnapshot("openai-codex", session, weekly, nowMs);
}

export function normalizeAnthropicUsage(
	data: unknown,
	options: { nowMs?: number } = {},
): TlhSubscriptionUsageSnapshot | undefined {
	const nowMs = options.nowMs ?? Date.now();
	const root = asObject(data);
	const session = normalizeUsageWindow(root?.five_hour, "five_hour", "session", nowMs);
	const weekly = normalizeUsageWindow(root?.seven_day, "seven_day", "weekly", nowMs);
	return createSnapshot("anthropic", session, weekly, nowMs);
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
		return undefined;
	}
	return AbortSignal.timeout(timeoutMs);
}

async function responseJson(response: ResponseLike | null | undefined): Promise<unknown | undefined> {
	if (response?.ok !== true || typeof response.json !== "function") {
		return undefined;
	}
	return response.json();
}

function oauthCredentialFromRegistry(
	modelRegistry: TlhSubscriptionUsageModelRegistry | undefined,
	provider: TlhSubscriptionUsageProvider,
): JsonRecord | undefined {
	const authStorage = modelRegistry?.authStorage as { get?: (provider: string) => unknown } | undefined;
	const credential = authStorage?.get?.(provider);
	const stored = asObject(credential);
	return stored?.type === "oauth" ? stored : undefined;
}

function readOauthCredentialFromRegistry(
	modelRegistry: TlhSubscriptionUsageModelRegistry | undefined,
	provider: TlhSubscriptionUsageProvider,
): CredentialResult {
	try {
		return { status: "ok", credential: oauthCredentialFromRegistry(modelRegistry, provider) };
	} catch {
		return { status: "transient-unavailable" };
	}
}

function oauthAccessTokenFromCredential(credential: unknown): string | undefined {
	const stored = asObject(credential);
	if (stored?.type !== "oauth") {
		return undefined;
	}
	const access = typeof stored.access === "string" ? stored.access.trim() : "";
	return access || undefined;
}

function accountIdFromCredential(credential: unknown): string | undefined {
	const stored = asObject(credential);
	if (!stored) {
		return undefined;
	}
	return pickString(stored, ACCOUNT_ID_KEYS);
}

function subscriptionUsageCacheKey(provider: TlhSubscriptionUsageProvider, identity: string): string {
	return `${provider}\t${identity}`;
}

function cacheKeyMatchesProvider(cacheKey: string, provider: TlhSubscriptionUsageProvider): boolean {
	return cacheKey.startsWith(`${provider}\t`);
}

function hasRuntimeCredentialOverride(
	modelRegistry: TlhSubscriptionUsageModelRegistry | undefined,
	provider: TlhSubscriptionUsageProvider,
): boolean {
	try {
		const authStorage = modelRegistry?.authStorage as { runtimeOverrides?: unknown } | undefined;
		const runtimeOverrides = authStorage?.runtimeOverrides;
		return runtimeOverrides instanceof Map && runtimeOverrides.has(provider);
	} catch {
		return false;
	}
}

function openAiHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
	};
	if (accountId) {
		headers["ChatGPT-Account-Id"] = accountId;
	}
	return headers;
}

function anthropicHeaders(accessToken: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${accessToken}`,
		"anthropic-beta": TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA,
	};
}

export async function fetchTlhSubscriptionUsage(
	target: TlhSubscriptionUsageTarget,
	options: TlhSubscriptionUsageFetchOptions = {},
): Promise<TlhSubscriptionUsageSnapshot | undefined> {
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
			const response = (await fetchImpl(TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL, {
				method: "GET",
				headers: openAiHeaders(accessToken, target.accountId),
				signal,
			})) as ResponseLike;
			return normalizeOpenAICodexUsage(await responseJson(response), { nowMs });
		}
		if (provider === "anthropic") {
			const response = (await fetchImpl(TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL, {
				method: "GET",
				headers: anthropicHeaders(accessToken),
				signal,
			})) as ResponseLike;
			return normalizeAnthropicUsage(await responseJson(response), { nowMs });
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveTlhSubscriptionUsageProviderContext(ctx: TlhSubscriptionUsageContext | undefined): ResolvedProviderContext {
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

function resolveTlhSubscriptionUsageProvider(ctx: TlhSubscriptionUsageContext | undefined): EligibleProviderContext | undefined {
	const resolved = resolveTlhSubscriptionUsageProviderContext(ctx);
	return resolved.status === "eligible" ? resolved : undefined;
}

function credentialCacheTarget(
	provider: TlhSubscriptionUsageProvider,
	credential: unknown,
): CredentialCacheTarget | undefined {
	const accountId = accountIdFromCredential(credential);
	if (accountId) {
		return {
			provider,
			accountId: provider === "openai-codex" ? accountId : undefined,
			cacheKey: subscriptionUsageCacheKey(provider, `account:${accountId}`),
		};
	}

	const fingerprint = accessTokenFingerprint(oauthAccessTokenFromCredential(credential));
	if (!fingerprint) {
		return undefined;
	}
	return {
		provider,
		accountId: undefined,
		cacheKey: subscriptionUsageCacheKey(provider, `fingerprint:${fingerprint}`),
	};
}

function resolveTlhSubscriptionUsageDisplayTarget(
	ctx: TlhSubscriptionUsageContext | undefined,
): CredentialCacheTarget | undefined {
	const resolved = resolveTlhSubscriptionUsageProvider(ctx);
	if (!resolved || hasRuntimeCredentialOverride(resolved.modelRegistry, resolved.provider)) {
		return undefined;
	}

	return credentialCacheTarget(resolved.provider, resolved.credential);
}

async function resolveTlhSubscriptionUsageTarget(resolved: EligibleProviderContext): Promise<ResolvedTargetResult> {
	const { provider, modelRegistry } = resolved;
	let accessToken: unknown;
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
	fetch: TlhSubscriptionUsageFetch | undefined;
	now: () => number;
	cacheTtlMs: number;
	minFetchIntervalMs: number;
	timeoutMs: number;
	snapshots: Map<string, TlhSubscriptionUsageSnapshot>;
	lastAttempts: Map<string, number>;
	inFlight: Map<string, Promise<TlhSubscriptionUsageSnapshot | undefined>>;
	activeCacheKeys: Map<TlhSubscriptionUsageProvider, string>;
	ineligibleCacheKeys: Map<TlhSubscriptionUsageProvider, string>;

	constructor(options: TlhSubscriptionUsageServiceOptions = {}) {
		this.fetch = options.fetch;
		this.now = typeof options.now === "function" ? options.now : () => Date.now();
		this.cacheTtlMs = options.cacheTtlMs ?? TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS;
		this.minFetchIntervalMs = options.minFetchIntervalMs ?? TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS;
		this.timeoutMs = options.timeoutMs ?? TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS;
		this.snapshots = new Map();
		this.lastAttempts = new Map();
		this.inFlight = new Map();
		this.activeCacheKeys = new Map();
		this.ineligibleCacheKeys = new Map();
	}

	snapshotForCacheKey(provider: TlhSubscriptionUsageProvider, cacheKey: string): TlhSubscriptionUsageSnapshot | undefined {
		return this.activeCacheKeys.get(provider) === cacheKey ? this.snapshots.get(cacheKey) : undefined;
	}

	getSnapshot(provider?: string): TlhSubscriptionUsageSnapshot | undefined {
		if (provider !== undefined && !isSupportedTlhSubscriptionUsageProvider(provider)) {
			return undefined;
		}
		if (provider) {
			const cacheKey = this.activeCacheKeys.get(provider);
			return cacheKey ? this.snapshots.get(cacheKey) : undefined;
		}
		return Array.from(this.activeCacheKeys.entries())
			.map(([snapshotProvider, cacheKey]) => this.snapshotForCacheKey(snapshotProvider, cacheKey))
			.filter((snapshot): snapshot is TlhSubscriptionUsageSnapshot => Boolean(snapshot))
			.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
	}

	getSnapshotForContext(ctx: TlhSubscriptionUsageContext | undefined): TlhSubscriptionUsageSnapshot | undefined {
		const target = resolveTlhSubscriptionUsageDisplayTarget(ctx);
		if (!target) {
			return undefined;
		}
		return this.snapshotForCacheKey(target.provider, target.cacheKey);
	}

	isEligible(target: string | TlhSubscriptionUsageContext | undefined): boolean {
		if (typeof target === "string") {
			return isSupportedTlhSubscriptionUsageProvider(target) && this.activeCacheKeys.has(target);
		}
		const displayTarget = resolveTlhSubscriptionUsageDisplayTarget(target);
		return Boolean(displayTarget && this.ineligibleCacheKeys.get(displayTarget.provider) !== displayTarget.cacheKey);
	}

	clearProvider(provider: string): void {
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

	activateTarget(provider: TlhSubscriptionUsageProvider, cacheKey: string): void {
		if (this.activeCacheKeys.get(provider) !== cacheKey) {
			this.clearProvider(provider);
			this.activeCacheKeys.set(provider, cacheKey);
		}
	}

	clear(): void {
		this.snapshots.clear();
		this.lastAttempts.clear();
		this.inFlight.clear();
		this.activeCacheKeys.clear();
		this.ineligibleCacheKeys.clear();
	}

	async refresh(
		ctx: TlhSubscriptionUsageContext | undefined,
		options: { force?: boolean } = {},
	): Promise<TlhSubscriptionUsageSnapshot | undefined> {
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
		const nowMs = this.now();
		const targetResult = await resolveTlhSubscriptionUsageTarget(resolved);
		const resolvedActiveCacheKey = this.activeCacheKeys.get(provider);
		const credentialCacheKeyChanged = resolvedActiveCacheKey && resolvedActiveCacheKey !== credentialTarget.cacheKey;
		if (targetResult.status === "transient-unavailable") {
			if (credentialCacheKeyChanged) {
				this.clearProvider(provider);
			}
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
		const cacheKey = target.cacheKey;
		const activeCacheKey = this.activeCacheKeys.get(provider);
		if (activeCacheKey && activeCacheKey !== cacheKey) {
			this.clearProvider(provider);
		}
		this.activeCacheKeys.set(provider, cacheKey);
		const cached = this.snapshots.get(cacheKey);
		const lastAttempt = this.lastAttempts.get(cacheKey);
		if (!options.force && cached && nowMs - cached.fetchedAt < this.cacheTtlMs) {
			return cached;
		}
		if (!options.force && lastAttempt !== undefined && nowMs - lastAttempt < this.minFetchIntervalMs) {
			return cached;
		}

		const existing = this.inFlight.get(cacheKey);
		if (existing) {
			return existing;
		}

		this.lastAttempts.set(cacheKey, nowMs);
		const pending: Promise<TlhSubscriptionUsageSnapshot | undefined> = (async () => {
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

export function createTlhSubscriptionUsageService(
	options: TlhSubscriptionUsageServiceOptions = {},
): TlhSubscriptionUsageService {
	return new TlhSubscriptionUsageService(options);
}
