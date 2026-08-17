let runtimeCapabilityWarned = false;
function hasGetProviderAuth(registry) {
    return (typeof registry === "object" &&
        registry !== null &&
        "getProviderAuth" in registry &&
        typeof registry["getProviderAuth"] === "function");
}
function hasGetProviderAuthStatus(registry) {
    return (typeof registry === "object" &&
        registry !== null &&
        "getProviderAuthStatus" in registry &&
        typeof registry["getProviderAuthStatus"] === "function");
}
export function adapterIsConfigured(registry, provider) {
    if (!hasGetProviderAuthStatus(registry)) {
        return undefined;
    }
    try {
        const result = registry.getProviderAuthStatus(provider);
        if (result === null || result === undefined) {
            return undefined;
        }
        const configured = result["configured"];
        return typeof configured === "boolean" ? configured : undefined;
    }
    catch {
        return undefined;
    }
}
export async function adapterGetProviderAuth(registry, provider) {
    if (!hasGetProviderAuth(registry)) {
        if (!runtimeCapabilityWarned) {
            runtimeCapabilityWarned = true;
            console.debug("[tlh] provider-auth-health: getProviderAuth is unavailable in this Pi runtime; " +
                "provider health checks will be silently skipped.");
        }
        return { ok: false, error: new UnsupportedRuntimeError() };
    }
    try {
        await registry.getProviderAuth(provider);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error };
    }
}
class UnsupportedRuntimeError extends Error {
    isUnsupportedRuntime = true;
    constructor() {
        super("getProviderAuth unavailable");
    }
}
function isUnsupportedRuntimeError(error) {
    return (error instanceof UnsupportedRuntimeError ||
        (typeof error === "object" &&
            error !== null &&
            error["isUnsupportedRuntime"] === true));
}
function isModelsErrorWithCode(error, code) {
    if (typeof error !== "object" || error === null)
        return false;
    const obj = error;
    return obj["name"] === "ModelsError" && obj["code"] === code;
}
function extractErrorMessage(error) {
    const seen = new Set();
    const parts = [];
    let current = error;
    for (let depth = 0; depth < 4; depth++) {
        if (current === null || current === undefined)
            break;
        if (typeof current !== "object" && typeof current !== "string")
            break;
        if (typeof current === "object") {
            if (seen.has(current))
                break;
            seen.add(current);
        }
        if (typeof current === "string") {
            if (current.length > 0)
                parts.push(current.toLowerCase());
            break;
        }
        const obj = current;
        const msg = obj["message"];
        if (typeof msg === "string" && msg.length > 0) {
            parts.push(msg.toLowerCase());
        }
        const code = obj["code"];
        if (typeof code === "string" && code.length > 0) {
            parts.push(code.toLowerCase());
        }
        current = obj["cause"];
    }
    return parts.join(" ");
}
function extractCauseChainStatuses(error) {
    const seen = new Set();
    const statuses = new Set();
    let current = error;
    for (let depth = 0; depth < 4; depth++) {
        if (typeof current !== "object" || current === null)
            break;
        if (seen.has(current))
            break;
        seen.add(current);
        const obj = current;
        const s = obj["status"];
        if (typeof s === "number" && Number.isFinite(s))
            statuses.add(s);
        const sc = obj["statusCode"];
        if (typeof sc === "number" && Number.isFinite(sc))
            statuses.add(sc);
        current = obj["cause"];
    }
    return statuses;
}
export function classifyProviderAuthError(error) {
    if (isUnsupportedRuntimeError(error)) {
        return "unknown";
    }
    if (isModelsErrorWithCode(error, "oauth")) {
        const fullMessage = extractErrorMessage(error);
        const statuses = extractCauseChainStatuses(error);
        if (isTransientError(fullMessage, error, statuses))
            return "transient-unavailable";
        if (isReauthError(fullMessage, statuses))
            return "reauth-required";
        return "unknown";
    }
    const message = extractErrorMessage(error);
    const statuses = extractCauseChainStatuses(error);
    if (isReauthError(message, statuses))
        return "reauth-required";
    if (isTransientError(message, error, statuses))
        return "transient-unavailable";
    return "unknown";
}
function isReauthError(message, statuses) {
    if (statuses.has(401) || statuses.has(403))
        return true;
    return (message.includes("invalid_grant") ||
        message.includes("token has been revoked") ||
        message.includes("token revoked") ||
        message.includes("refresh token expired") ||
        message.includes("refresh_token_expired") ||
        message.includes("authorization has been revoked") ||
        message.includes("account has been deleted") ||
        message.includes("token refresh unauthorized") ||
        (message.includes("user not found") && message.includes("oauth")));
}
function isTransientError(message, error, statuses) {
    if (typeof error === "object" && error !== null) {
        const code = error["code"];
        if (typeof code === "string") {
            const sysCode = code.toUpperCase();
            if (sysCode === "ECONNREFUSED" ||
                sysCode === "ECONNRESET" ||
                sysCode === "ETIMEDOUT" ||
                sysCode === "ENOTFOUND" ||
                sysCode === "ENOENT" ||
                sysCode === "EACCES" ||
                sysCode === "EPERM" ||
                sysCode === "EBUSY" ||
                sysCode === "ELOCKED") {
                return true;
            }
        }
    }
    for (const status of statuses) {
        if (status === 429 || (status >= 500 && status <= 599))
            return true;
    }
    return (message.includes("fetch failed") ||
        message.includes("network error") ||
        message.includes("network timeout") ||
        message.includes("connection refused") ||
        message.includes("connection reset") ||
        message.includes("etimedout") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("enotfound") ||
        message.includes("dns") ||
        message.includes("socket hang up") ||
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("service unavailable") ||
        message.includes("bad gateway") ||
        message.includes("gateway timeout") ||
        message.includes("internal server error") ||
        message.includes("request timed out") ||
        message.includes("timed out") ||
        message.includes("request aborted") ||
        message.includes("abortError".toLowerCase()) ||
        message.includes("credential store") ||
        message.includes("keychain") ||
        message.includes("keystore") ||
        message.includes("secret store") ||
        message.includes("store is locked") ||
        message.includes("file is locked") ||
        message.includes("database locked") ||
        message.includes("storage read") ||
        message.includes("storage write") ||
        message.includes("storage error"));
}
export function createProviderAuthHealthStore(options = {}) {
    const nowFn = options.now ?? Date.now;
    const healthEntries = new Map();
    const inFlight = new Map();
    const generations = new Map();
    const runLevelObservedProviders = new Set();
    const renderListeners = new Set();
    let disposed = false;
    const generation = (provider) => generations.get(provider) ?? 0;
    const bumpGeneration = (provider) => {
        generations.set(provider, generation(provider) + 1);
    };
    const recordEntry = (provider, status) => {
        healthEntries.set(provider, { status, checkedAt: nowFn() });
    };
    const notifyListeners = () => {
        for (const listener of renderListeners) {
            try {
                listener();
            }
            catch {
            }
        }
    };
    return {
        getEntry(provider) {
            return healthEntries.get(provider);
        },
        async probeProvider(modelRegistry, provider) {
            if (disposed)
                return "unknown";
            const existing = inFlight.get(provider);
            if (existing)
                return existing;
            const startGeneration = generation(provider);
            const probe = (async () => {
                try {
                    const result = await adapterGetProviderAuth(modelRegistry, provider);
                    if (result.ok) {
                        const status = "healthy";
                        if (!disposed && generation(provider) === startGeneration) {
                            recordEntry(provider, status);
                            notifyListeners();
                        }
                        return status;
                    }
                    const status = classifyProviderAuthError(result.error);
                    if (!disposed && generation(provider) === startGeneration) {
                        recordEntry(provider, status);
                        notifyListeners();
                    }
                    return status;
                }
                finally {
                    inFlight.delete(provider);
                }
            })();
            inFlight.set(provider, probe);
            return probe;
        },
        clearProvider(provider) {
            if (disposed)
                return;
            bumpGeneration(provider);
            inFlight.delete(provider);
            runLevelObservedProviders.delete(provider);
            recordEntry(provider, "healthy");
            notifyListeners();
        },
        recordRunLevelAuthObservation(provider) {
            if (disposed)
                return;
            runLevelObservedProviders.add(provider);
            recordEntry(provider, "reauth-required");
            notifyListeners();
        },
        isConfigured(modelRegistry, provider) {
            if (disposed)
                return undefined;
            return adapterIsConfigured(modelRegistry, provider);
        },
        getReauthProviders() {
            const result = [];
            for (const [provider, entry] of healthEntries) {
                if (entry.status === "reauth-required") {
                    result.push(provider);
                }
            }
            return result.sort();
        },
        getNonHealthyProviders() {
            const result = [];
            for (const [provider, entry] of healthEntries) {
                if (entry.status !== "healthy") {
                    result.push(provider);
                }
            }
            return result.sort();
        },
        subscribe(listener) {
            if (disposed)
                return () => { };
            renderListeners.add(listener);
            return () => {
                renderListeners.delete(listener);
            };
        },
        dispose() {
            disposed = true;
            healthEntries.clear();
            inFlight.clear();
            generations.clear();
            runLevelObservedProviders.clear();
            renderListeners.clear();
        },
    };
}
