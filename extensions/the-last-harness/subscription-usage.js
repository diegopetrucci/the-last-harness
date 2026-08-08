import { createHash } from "node:crypto";
export const TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL = "https://api.anthropic.com/api/oauth/usage";
export const TLH_SUBSCRIPTION_USAGE_ANTHROPIC_BETA = "oauth-2025-04-20";
export const TLH_SUBSCRIPTION_USAGE_CACHE_TTL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_MIN_FETCH_INTERVAL_MS = 60_000;
export const TLH_SUBSCRIPTION_USAGE_TIMEOUT_MS = 3_000;
const SUPPORTED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const ACCOUNT_ID_KEYS = ["accountId", "account_id", "chatgptAccountId", "chatgpt_account_id"];
const USAGE_PERCENT_KEYS = ["used_percent", "usedPercent", "utilization"];
const WINDOW_DURATION_SECONDS_KEYS = ["limit_window_seconds", "limitWindowSeconds"];
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
function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) {
            return undefined;
        }
        const segment = parts[1] ?? "";
        if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
            return undefined;
        }
        if (segment.length % 4 === 1) {
            return undefined;
        }
        const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
        const json = Buffer.from(padded, "base64").toString("utf8");
        return asObject(JSON.parse(json));
    }
    catch {
        return undefined;
    }
}
function accountIdFromJwt(token) {
    const payload = decodeJwtPayload(token);
    if (!payload) {
        return undefined;
    }
    const authClaim = asObject(payload["https://api.openai.com/auth"]);
    if (authClaim) {
        const id = pickString(authClaim, ACCOUNT_ID_KEYS);
        if (id) {
            return id;
        }
    }
    return pickString(payload, ACCOUNT_ID_KEYS);
}
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
function normalizeWindowDurationMs(source) {
    const seconds = pickNumber(source, WINDOW_DURATION_SECONDS_KEYS);
    return seconds !== undefined ? Math.round(seconds * 1000) : undefined;
}
function normalizeResetTime(source, nowMs) {
    return (normalizeIsoTime(source.reset_at) ??
        normalizeIsoTime(source.resetAt) ??
        normalizeIsoTime(source.resets_at) ??
        normalizeIsoTime(source.resetsAt) ??
        normalizeIsoTime(source.reset_time) ??
        normalizeIsoTime(source.resetTime) ??
        normalizeIsoTime(source.end_time) ??
        normalizeIsoTime(source.endTime) ??
        resetAtFromRelativeSeconds(source, nowMs));
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
    }
    else if (normalizedUsed !== undefined && normalizedLimit !== undefined && normalizedLimit > 0) {
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
    return typeof provider === "string" && SUPPORTED_PROVIDERS.has(provider);
}
export function normalizeOpenAICodexUsage(data, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const root = asObject(data);
    const rateLimit = asObject(root?.rate_limit);
    const session = normalizeUsageWindow(rateLimit?.primary_window ?? root?.primary_window, "primary_window", "session", nowMs);
    const weekly = normalizeUsageWindow(rateLimit?.secondary_window ?? root?.secondary_window, "secondary_window", "weekly", nowMs);
    return createSnapshot("openai-codex", session, weekly, nowMs);
}
export function normalizeAnthropicUsage(data, options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    const root = asObject(data);
    const session = normalizeUsageWindow(root?.five_hour, "five_hour", "session", nowMs);
    const weekly = normalizeUsageWindow(root?.seven_day, "seven_day", "weekly", nowMs);
    return createSnapshot("anthropic", session, weekly, nowMs);
}
function timeoutSignal(timeoutMs) {
    if (!Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        typeof AbortSignal === "undefined" ||
        typeof AbortSignal.timeout !== "function") {
        return undefined;
    }
    return AbortSignal.timeout(timeoutMs);
}
async function responseJson(response) {
    if (response?.ok !== true || typeof response.json !== "function") {
        return undefined;
    }
    return response.json();
}
function oauthCredentialFromRegistry(modelRegistry, provider) {
    const authStorage = modelRegistry?.authStorage;
    const credential = authStorage?.get?.(provider);
    const stored = asObject(credential);
    return stored?.type === "oauth" ? stored : undefined;
}
function readOauthCredentialFromRegistry(modelRegistry, provider) {
    try {
        return { status: "ok", credential: oauthCredentialFromRegistry(modelRegistry, provider) };
    }
    catch {
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
function accountIdFromCredential(credential) {
    const stored = asObject(credential);
    if (!stored) {
        return undefined;
    }
    return pickString(stored, ACCOUNT_ID_KEYS);
}
function subscriptionUsageCacheKey(provider, identity) {
    return `${provider}\t${identity}`;
}
function cacheKeyMatchesProvider(cacheKey, provider) {
    return cacheKey.startsWith(`${provider}\t`);
}
function hasRuntimeCredentialOverride(modelRegistry, provider) {
    try {
        const authStorage = modelRegistry?.authStorage;
        const runtimeOverrides = authStorage?.runtimeOverrides;
        return runtimeOverrides instanceof Map && runtimeOverrides.has(provider);
    }
    catch {
        return false;
    }
}
function isRuntimeCredentialOverride(modelRegistry, provider) {
    if (hasRuntimeCredentialOverride(modelRegistry, provider)) {
        return true;
    }
    try {
        return modelRegistry?.getProviderAuthStatus?.(provider)?.source === "runtime";
    }
    catch {
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
            const response = (await fetchImpl(TLH_SUBSCRIPTION_USAGE_OPENAI_CODEX_URL, {
                method: "GET",
                headers: openAiHeaders(accessToken, target.accountId),
                signal,
            }));
            return normalizeOpenAICodexUsage(await responseJson(response), { nowMs });
        }
        if (provider === "anthropic") {
            const response = (await fetchImpl(TLH_SUBSCRIPTION_USAGE_ANTHROPIC_URL, {
                method: "GET",
                headers: anthropicHeaders(accessToken),
                signal,
            }));
            return normalizeAnthropicUsage(await responseJson(response), { nowMs });
        }
    }
    catch {
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
    }
    catch {
        return { status: "transient-unavailable", provider };
    }
    if (!modelRegistry.authStorage) {
        return { status: "eligible", model, provider, modelRegistry };
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
function resolveTlhSubscriptionUsageDisplayTarget(ctx) {
    const resolved = resolveTlhSubscriptionUsageProvider(ctx);
    if (!resolved) {
        return undefined;
    }
    if (isRuntimeCredentialOverride(resolved.modelRegistry, resolved.provider)) {
        return undefined;
    }
    if (!resolved.credential) {
        return undefined;
    }
    return credentialCacheTarget(resolved.provider, resolved.credential);
}
async function resolveTlhSubscriptionUsageTarget(resolved) {
    const { provider, modelRegistry } = resolved;
    let accessToken;
    try {
        accessToken = await modelRegistry.getApiKeyForProvider?.(provider);
    }
    catch {
        return { status: "transient-unavailable" };
    }
    const normalizedAccessToken = typeof accessToken === "string" ? accessToken.trim() : "";
    if (!normalizedAccessToken) {
        return { status: "transient-unavailable" };
    }
    if (!modelRegistry.authStorage) {
        let accountId;
        if (provider === "openai-codex") {
            accountId = accountIdFromJwt(normalizedAccessToken);
        }
        const fp = accessTokenFingerprint(normalizedAccessToken);
        const identity = accountId ? `account:${accountId}` : fp ? `fingerprint:${fp}` : undefined;
        if (!identity) {
            return { status: "ineligible" };
        }
        return {
            status: "resolved",
            target: {
                provider,
                accessToken: normalizedAccessToken,
                accountId: provider === "openai-codex" ? accountId : undefined,
                cacheKey: subscriptionUsageCacheKey(provider, identity),
            },
        };
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
    fetch;
    now;
    cacheTtlMs;
    minFetchIntervalMs;
    timeoutMs;
    snapshots;
    lastAttempts;
    inFlight;
    activeCacheKeys;
    ineligibleCacheKeys;
    refreshGenerations;
    constructor(options = {}) {
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
        this.refreshGenerations = new Map();
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
            .filter((snapshot) => Boolean(snapshot))
            .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
    }
    resolveDisplayCacheKey(ctx) {
        const model = ctx?.model;
        const provider = model?.provider;
        const modelRegistry = ctx?.modelRegistry;
        if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
            return undefined;
        }
        if (!modelRegistry || typeof modelRegistry.isUsingOAuth !== "function") {
            return undefined;
        }
        try {
            if (!modelRegistry.isUsingOAuth(model)) {
                return undefined;
            }
        }
        catch {
            return undefined;
        }
        if (isRuntimeCredentialOverride(modelRegistry, provider)) {
            return undefined;
        }
        if (modelRegistry.authStorage) {
            const legacyTarget = resolveTlhSubscriptionUsageDisplayTarget(ctx);
            if (!legacyTarget) {
                return undefined;
            }
            return { provider, cacheKey: legacyTarget.cacheKey };
        }
        const cacheKey = this.activeCacheKeys.get(provider);
        if (!cacheKey) {
            return undefined;
        }
        return { provider, cacheKey };
    }
    getSnapshotForContext(ctx) {
        const target = this.resolveDisplayCacheKey(ctx);
        if (!target) {
            return undefined;
        }
        return this.snapshotForCacheKey(target.provider, target.cacheKey);
    }
    isEligible(target) {
        if (typeof target === "string") {
            return isSupportedTlhSubscriptionUsageProvider(target) && this.activeCacheKeys.has(target);
        }
        const modelRegistry = target?.modelRegistry;
        if (modelRegistry && !modelRegistry.authStorage) {
            const model = target?.model;
            const provider = model?.provider;
            if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
                return false;
            }
            if (typeof modelRegistry.isUsingOAuth !== "function") {
                return false;
            }
            try {
                if (!modelRegistry.isUsingOAuth(model)) {
                    return false;
                }
            }
            catch {
                return false;
            }
            return !isRuntimeCredentialOverride(modelRegistry, provider);
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
        this.inFlight.clear();
        this.activeCacheKeys.clear();
        this.ineligibleCacheKeys.clear();
        this.refreshGenerations.clear();
    }
    async refresh(ctx, options = {}) {
        const provider = ctx?.model?.provider;
        if (!isSupportedTlhSubscriptionUsageProvider(provider)) {
            return undefined;
        }
        const generation = (this.refreshGenerations.get(provider) ?? 0) + 1;
        this.refreshGenerations.set(provider, generation);
        const resolved = resolveTlhSubscriptionUsageProviderContext(ctx);
        if (resolved.status === "transient-unavailable") {
            return undefined;
        }
        if (resolved.status !== "eligible") {
            this.clearProvider(provider);
            return undefined;
        }
        if (isRuntimeCredentialOverride(resolved.modelRegistry, provider)) {
            this.clearProvider(provider);
            return undefined;
        }
        const legacyCredentialTarget = resolved.credential
            ? credentialCacheTarget(provider, resolved.credential)
            : undefined;
        if (resolved.credential && !legacyCredentialTarget) {
            this.clearProvider(provider);
            return undefined;
        }
        const nowMs = this.now();
        const targetResult = await resolveTlhSubscriptionUsageTarget(resolved);
        if (this.refreshGenerations.get(provider) !== generation) {
            const activeKey = this.activeCacheKeys.get(provider);
            return activeKey ? this.snapshotForCacheKey(provider, activeKey) : undefined;
        }
        if (targetResult.status === "transient-unavailable") {
            if (legacyCredentialTarget) {
                const resolvedActiveCacheKey = this.activeCacheKeys.get(provider);
                if (resolvedActiveCacheKey && resolvedActiveCacheKey !== legacyCredentialTarget.cacheKey) {
                    this.clearProvider(provider);
                }
                return this.snapshotForCacheKey(provider, legacyCredentialTarget.cacheKey);
            }
            const activeCacheKey = this.activeCacheKeys.get(provider);
            return activeCacheKey ? this.snapshotForCacheKey(provider, activeCacheKey) : undefined;
        }
        if (targetResult.status !== "resolved") {
            this.clearProvider(provider);
            if (targetResult.status === "mismatch" && legacyCredentialTarget) {
                this.ineligibleCacheKeys.set(provider, legacyCredentialTarget.cacheKey);
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
        }
        catch {
            return this.snapshotForCacheKey(provider, cacheKey);
        }
        finally {
            if (this.inFlight.get(cacheKey) === pending) {
                this.inFlight.delete(cacheKey);
            }
        }
    }
}
export function createTlhSubscriptionUsageService(options = {}) {
    return new TlhSubscriptionUsageService(options);
}
