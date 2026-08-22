// Session-scoped per-provider auth-health store.
//
// Design notes:
// - Status is a CLOSED enum: healthy | reauth-required | transient-unavailable | unknown.
// - ONLY 'reauth-required' may trigger a footer warning; everything else is silent.
// - Redaction is BY DISCARD: the raw provider error string is never retained.
//   The error is classified into the closed enum and then thrown away.
// - Probes are NEVER speculative. Call probeProvider only when TLH is about to
//   depend on the provider, or when the provider is already flagged failed and
//   we are re-checking after a possible re-auth.
// - In-flight coalescing: concurrent callers share one probe per provider.
// - Capability-tested adapter: getProviderAuth / getProviderAuthStatus are
//   duck-typed; missing methods degrade to no-warning (fail open).

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Closed status enum for provider credential health. */
type ProviderAuthHealthStatus = "healthy" | "reauth-required" | "transient-unavailable" | "unknown";

type ProviderHealthEntry = {
  status: ProviderAuthHealthStatus;
  checkedAt: number;
};

export type ProviderAuthHealthStore = {
  /** Read the last recorded health entry for a provider, or undefined if not yet probed. */
  getEntry(provider: string): ProviderHealthEntry | undefined;

  /**
   * Probe a provider's credential liveness via getProviderAuth.
   * Concurrent callers for the same provider share one in-flight Promise.
   * On an unsupported runtime (missing method), returns 'unknown' and never
   * triggers a false warning.
   */
  probeProvider(modelRegistry: unknown, provider: string): Promise<ProviderAuthHealthStatus>;

  /**
   * Mark a provider as healthy and clear any in-flight probe.
   * Call this after a successful provider interaction or confirmed re-auth.
   * Also clears any run-level auth observation recorded via recordRunLevelAuthObservation.
   */
  clearProvider(provider: string): void;

  /**
   * Record a high-confidence runtime auth failure observed in a completed run's attempt history.
   *
   * Sets the provider's current status to 'reauth-required' (surfaced in the footer) and
   * marks it as a run-level observation for historical tracking.
   *
   * The footer warning CAN clear: a subsequent successful probe (e.g. from the turn_end
   * clearing pass) records 'healthy' and dismisses the warning, just as it would for any
   * other probe-observed failure. The historical observation record stays until clearProvider
   * or dispose; it does not gate what the footer shows.
   *
   * Known v1 tradeoff: a revoked-but-unexpired token passes the local probe while live
   * requests fail, causing a brief flap. See runLevelObservedProviders comment for details.
   */
  recordRunLevelAuthObservation(provider: string): void;

  /**
   * Synchronous configured-status check via getProviderAuthStatus.
   * Returns undefined when the method is absent (capability not available).
   * Never performs network I/O.
   */
  isConfigured(modelRegistry: unknown, provider: string): boolean | undefined;

  /**
   * Return the sorted list of provider names currently classified 'reauth-required'.
   * Used by the footer renderer to build the compact warning line.
   */
  getReauthProviders(): readonly string[];

  /**
   * Return the sorted list of provider names whose last recorded status is NOT
   * 'healthy'. Includes 'reauth-required', 'transient-unavailable', and 'unknown'.
   * Used by the turn_end clearing pass to retry any provider that has not yet
   * produced a confirmed-good result, regardless of which failure category it
   * landed in.
   */
  getNonHealthyProviders(): readonly string[];

  /**
   * Register a listener to be called whenever any provider's health status changes.
   * Returns an unsubscribe function; listeners are cleared by dispose().
   */
  subscribe(listener: () => void): () => void;

  /**
   * Reset all session state: health entries, in-flight probes, render listeners.
   * Call this on session boundaries.
   */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Capability-tested adapter
// ---------------------------------------------------------------------------

// Minimal types we need from the registry — open objects at the boundary.
// We only duck-type what we call, per the TypeScript boundaries skill.

type RegistryWithGetProviderAuth = {
  getProviderAuth(provider: string): ReturnType<ModelRegistry["getProviderAuth"]>;
};

type RegistryWithGetProviderAuthStatus = {
  getProviderAuthStatus(provider: string): { configured?: unknown } | null | undefined;
};

let runtimeCapabilityWarned = false;

function hasGetProviderAuth(registry: unknown): registry is RegistryWithGetProviderAuth {
  return (
    typeof registry === "object" &&
    registry !== null &&
    "getProviderAuth" in registry &&
    typeof (registry as Record<string, unknown>)["getProviderAuth"] === "function"
  );
}

function hasGetProviderAuthStatus(
  registry: unknown,
): registry is RegistryWithGetProviderAuthStatus {
  return (
    typeof registry === "object" &&
    registry !== null &&
    "getProviderAuthStatus" in registry &&
    typeof (registry as Record<string, unknown>)["getProviderAuthStatus"] === "function"
  );
}

/**
 * Synchronous configured-status adapter.
 * Returns undefined on unsupported runtime (fail open).
 */
export function adapterIsConfigured(registry: unknown, provider: string): boolean | undefined {
  if (!hasGetProviderAuthStatus(registry)) {
    return undefined;
  }
  try {
    const result = registry.getProviderAuthStatus(provider);
    if (result === null || result === undefined) {
      return undefined;
    }
    // Do not inspect AuthResult internals beyond the 'configured' boolean.
    const configured = (result as Record<string, unknown>)["configured"];
    return typeof configured === "boolean" ? configured : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Async credential liveness adapter.
 * Returns { ok: false } on unsupported runtime.
 * Emits a once-per-process console.debug when the method is absent.
 */
export async function adapterGetProviderAuth(
  registry: unknown,
  provider: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (!hasGetProviderAuth(registry)) {
    if (!runtimeCapabilityWarned) {
      runtimeCapabilityWarned = true;
      console.debug(
        "[tlh] provider-auth-health: getProviderAuth is unavailable in this Pi runtime; " +
          "provider health checks will be silently skipped.",
      );
    }
    return { ok: false, error: new UnsupportedRuntimeError() };
  }
  try {
    await registry.getProviderAuth(provider);
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

class UnsupportedRuntimeError extends Error {
  readonly isUnsupportedRuntime = true;
  constructor() {
    super("getProviderAuth unavailable");
  }
}

// ---------------------------------------------------------------------------
// Error classification (classify immediately, discard raw string)
// ---------------------------------------------------------------------------

function isUnsupportedRuntimeError(error: unknown): boolean {
  return (
    error instanceof UnsupportedRuntimeError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Record<string, unknown>)["isUnsupportedRuntime"] === true)
  );
}

/**
 * Return true when the error is a ModelsError (pi-ai/dist/models.d.ts) with the given code.
 * Duck-typed: we never import the Pi runtime directly from this module.
 * pi-ai/dist/models.d.ts:128 documents ModelsErrorCode = "model_source" | "model_validation" |
 * "provider" | "stream" | "auth" | "oauth" and states "Rejects with ModelsError: code 'oauth'
 * when a token refresh fails."
 */
function isModelsErrorWithCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const obj = error as Record<string, unknown>;
  return obj["name"] === "ModelsError" && obj["code"] === code;
}

/**
 * Walk the error cause chain (depth-capped to 4 levels, cycle-safe).
 * Returns a single lowercase string containing all messages and Node.js error codes
 * found at every level. Used only for transient/reauth classification — never stored.
 */
function extractErrorMessage(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth++) {
    if (current === null || current === undefined) break;
    if (typeof current !== "object" && typeof current !== "string") break;
    if (typeof current === "object") {
      if (seen.has(current)) break; // cycle guard
      seen.add(current);
    }

    if (typeof current === "string") {
      if (current.length > 0) parts.push(current.toLowerCase());
      break;
    }

    const obj = current as Record<string, unknown>;

    const msg = obj["message"];
    if (typeof msg === "string" && msg.length > 0) {
      parts.push(msg.toLowerCase());
    }

    // Node.js error code (e.g. ECONNREFUSED) is meaningful at any depth.
    const code = obj["code"];
    if (typeof code === "string" && code.length > 0) {
      parts.push(code.toLowerCase());
    }

    current = obj["cause"];
  }

  return parts.join(" ");
}

/**
 * Walk the error cause chain (depth-capped to 4 levels, cycle-safe).
 * Returns all numeric HTTP status codes found on any error in the chain.
 * Allows transient/reauth checks to act on a cause's HTTP status
 * even when the top-level error wraps it (e.g. ModelsError wrapping a fetch error).
 */
function extractCauseChainStatuses(error: unknown): ReadonlySet<number> {
  const seen = new Set<unknown>();
  const statuses = new Set<number>();
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) break;
    if (seen.has(current)) break; // cycle guard
    seen.add(current);

    const obj = current as Record<string, unknown>;
    const s = obj["status"];
    if (typeof s === "number" && Number.isFinite(s)) statuses.add(s);
    const sc = obj["statusCode"];
    if (typeof sc === "number" && Number.isFinite(sc)) statuses.add(sc);

    current = obj["cause"];
  }

  return statuses;
}

/**
 * Classify a thrown provider auth error into the closed enum.
 * The raw error message is extracted only for classification and is never stored
 * in the returned status — the string is discarded after this function returns.
 */
export function classifyProviderAuthError(error: unknown): ProviderAuthHealthStatus {
  // Unsupported runtime: fail open, no warning.
  if (isUnsupportedRuntimeError(error)) {
    return "unknown";
  }

  // pi-ai/dist/auth/resolve.js:90 throws:
  //   throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error })
  // pi-ai/dist/models.d.ts:128: "Rejects with ModelsError: code 'oauth' when a token refresh fails."
  // This is the primary structured signal for Anthropic / OpenAI Codex token-refresh failures.
  //
  // IMPORTANT: code === "oauth" only means "the refresh path failed", NOT "the credential is dead."
  // A network error during refresh also produces this code. Apply transient checks FIRST.
  if (isModelsErrorWithCode(error, "oauth")) {
    const fullMessage = extractErrorMessage(error);
    const statuses = extractCauseChainStatuses(error);
    if (isTransientError(fullMessage, error, statuses)) return "transient-unavailable";
    if (isReauthError(fullMessage, statuses)) return "reauth-required";
    return "unknown";
  }

  // For all other errors: message + status-based classification.
  const message = extractErrorMessage(error);
  const statuses = extractCauseChainStatuses(error);

  if (isReauthError(message, statuses)) return "reauth-required";
  if (isTransientError(message, error, statuses)) return "transient-unavailable";
  return "unknown";
}

/**
 * Returns true ONLY for unambiguous OAuth credential-rejection errors.
 * Network, storage, timeout, 5xx, and 429 errors MUST NOT map to reauth-required.
 * We must be conservative: if in doubt, return false.
 *
 * 401/403 from a token exchange is as unambiguous as reauth evidence gets.
 * pi-ai/dist/auth/oauth/kimi-coding.js:222-224 surfaces a 401 as:
 *   throw new Error("Kimi Code token refresh unauthorized (status 401)")
 */
function isReauthError(message: string, statuses: ReadonlySet<number>): boolean {
  // HTTP 401/403 anywhere in the cause chain during a token refresh = credential rejected.
  if (statuses.has(401) || statuses.has(403)) return true;

  return (
    message.includes("invalid_grant") ||
    message.includes("token has been revoked") ||
    message.includes("token revoked") ||
    message.includes("refresh token expired") ||
    message.includes("refresh_token_expired") ||
    message.includes("authorization has been revoked") ||
    message.includes("account has been deleted") ||
    // pi-ai/dist/auth/oauth/kimi-coding.js:222-224
    message.includes("token refresh unauthorized") ||
    (message.includes("user not found") && message.includes("oauth"))
  );
}

/**
 * Returns true for transient infrastructure failures that should never trigger
 * a re-auth warning (network, storage, rate-limit, server-side errors).
 */
function isTransientError(message: string, error: unknown, statuses: ReadonlySet<number>): boolean {
  // Node.js system error codes (network / credential store file I/O) on the root error.
  if (typeof error === "object" && error !== null) {
    const code = (error as Record<string, unknown>)["code"];
    if (typeof code === "string") {
      const sysCode = code.toUpperCase();
      if (
        sysCode === "ECONNREFUSED" ||
        sysCode === "ECONNRESET" ||
        sysCode === "ETIMEDOUT" ||
        sysCode === "ENOTFOUND" ||
        sysCode === "ENOENT" ||
        sysCode === "EACCES" ||
        sysCode === "EPERM" ||
        sysCode === "EBUSY" ||
        sysCode === "ELOCKED"
      ) {
        return true;
      }
    }
  }

  // HTTP 429 / 5xx anywhere in the cause chain — must not become a sticky reauth warning.
  for (const status of statuses) {
    if (status === 429 || (status >= 500 && status <= 599)) return true;
  }

  // String-match heuristics. These must NOT overlap with reauth patterns.
  // NOTE: "lock" was deliberately avoided — it is a substring of "blocked",
  // so "account has been blocked" would silently classify as transient.
  return (
    message.includes("fetch failed") ||
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
    // Specific lock patterns — avoid bare "lock" which matches "blocked"
    message.includes("store is locked") ||
    message.includes("file is locked") ||
    message.includes("database locked") ||
    message.includes("storage read") ||
    message.includes("storage write") ||
    message.includes("storage error")
    // Bare HTTP status digits (e.g. "500", "503") intentionally omitted:
    // they match request IDs and token fragments. Use the structural status
    // check above (extractCauseChainStatuses) instead.
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type ProviderAuthHealthStoreOptions = {
  /** Injectable clock for testing. Defaults to Date.now. */
  now?: () => number;
};

export function createProviderAuthHealthStore(
  options: ProviderAuthHealthStoreOptions = {},
): ProviderAuthHealthStore {
  const nowFn = options.now ?? Date.now;

  // Session-scoped health entries (no disk persistence).
  const healthEntries = new Map<string, ProviderHealthEntry>();

  // In-flight coalescing: concurrent callers for the same provider share one probe.
  const inFlight = new Map<string, Promise<ProviderAuthHealthStatus>>();

  // Per-provider generation counter. Bumped by clearProvider so that probes started
  // before a clear do not overwrite the cleared state when they finally resolve.
  const generations = new Map<string, number>();

  // Providers with a run-level auth observation (historical fact from a completed run).
  // This is a read-only record of degradation; it does NOT gate what the footer shows.
  // A successful probe records 'healthy' and clears the footer warning even for these
  // providers, because current health is what the footer reports and a replaced credential
  // must be able to dismiss the warning.
  //
  // Known tradeoff (v1): a revoked-but-unexpired token passes the local probe while live
  // provider requests fail (pi-ai/dist/auth/resolve.js:56-66 skips the network call for
  // tokens that have not expired). That causes a brief warning flap — clear on turn_end,
  // reappear after the next failed run. Accept this for v1: self-correcting, and a
  // warning that briefly clears is strictly better than one that never clears.
  //
  // Follow-up idea (out of scope): capture a credential fingerprint (SHA-256 of the access
  // token, as in subscription-usage.ts:accessTokenFingerprint) when the observation is
  // recorded, and clear the observation only when the fingerprint changes on a successful
  // probe — a real re-auth changes the credential, a revocation does not.
  const runLevelObservedProviders = new Set<string>();

  // Render listeners to notify on changes (wired up by dependent tickets).
  const renderListeners = new Set<() => void>();

  let disposed = false;

  const generation = (provider: string): number => generations.get(provider) ?? 0;

  const bumpGeneration = (provider: string): void => {
    generations.set(provider, generation(provider) + 1);
  };

  const recordEntry = (provider: string, status: ProviderAuthHealthStatus): void => {
    healthEntries.set(provider, { status, checkedAt: nowFn() });
  };

  const notifyListeners = (): void => {
    for (const listener of renderListeners) {
      try {
        listener();
      } catch {
        // Listeners must not crash the store.
      }
    }
  };

  return {
    getEntry(provider) {
      return healthEntries.get(provider);
    },

    async probeProvider(modelRegistry, provider) {
      if (disposed) return "unknown";

      // Return in-flight promise if a probe is already running for this provider.
      const existing = inFlight.get(provider);
      if (existing) return existing;

      // Capture the generation at probe start. If clearProvider is called before
      // this probe resolves, the generation will be bumped and the stale result
      // will be discarded rather than overwriting the cleared state.
      const startGeneration = generation(provider);

      // Use let so the identity check in the finally block (probe === inFlight.get(provider))
      // can reference probe after it is assigned. TypeScript cannot infer that finally
      // only runs after the assignment, so the definite-assignment assertion (!) is needed.
      // eslint-disable-next-line prefer-const
      let probe!: Promise<ProviderAuthHealthStatus>;
      probe = (async (): Promise<ProviderAuthHealthStatus> => {
        try {
          const result = await adapterGetProviderAuth(modelRegistry, provider);
          if (result.ok) {
            const status: ProviderAuthHealthStatus = "healthy";
            if (!disposed && generation(provider) === startGeneration) {
              // Record healthy unconditionally — even for providers with a run-level
              // observation. Current health is what the footer shows; suppressing a
              // healthy probe result here would make the warning unclearable for the
              // entire session (no production caller ever calls clearProvider).
              // The run-level observation remains in runLevelObservedProviders as a
              // historical record; the footer is driven by healthEntries only.
              recordEntry(provider, status);
              notifyListeners();
            }
            return status;
          }
          // Classify and immediately discard the raw error.
          const status = classifyProviderAuthError(result.error);
          if (!disposed && generation(provider) === startGeneration) {
            recordEntry(provider, status);
            notifyListeners();
          }
          return status;
        } finally {
          // Only remove this probe's entry. If clearProvider was called mid-flight
          // and a new probe was installed for the same provider, do not evict the
          // newer probe — coalescing would be lost and a duplicate getProviderAuth
          // call could run (which rotates credentials and holds the auth-file lock).
          if (inFlight.get(provider) === probe) {
            inFlight.delete(provider);
          }
        }
      })();

      inFlight.set(provider, probe);
      return probe;
    },

    clearProvider(provider) {
      if (disposed) return;
      // Bump generation so any in-flight probe started before this clear will
      // not overwrite the fresh healthy state when it eventually resolves.
      bumpGeneration(provider);
      inFlight.delete(provider);
      runLevelObservedProviders.delete(provider);
      recordEntry(provider, "healthy");
      notifyListeners();
    },

    recordRunLevelAuthObservation(provider) {
      if (disposed) return;
      // Historical fact: a completed run's attempt received a definitive auth rejection.
      // Records reauth-required in healthEntries (drives footer) and marks the provider
      // in runLevelObservedProviders (historical record only — does not gate probe results).
      // A subsequent successful probe will clear the footer warning by recording healthy;
      // the run-level record in runLevelObservedProviders stays until clearProvider or dispose.
      runLevelObservedProviders.add(provider);
      recordEntry(provider, "reauth-required");
      notifyListeners();
    },

    isConfigured(modelRegistry, provider) {
      if (disposed) return undefined;
      return adapterIsConfigured(modelRegistry, provider);
    },

    getReauthProviders() {
      const result: string[] = [];
      for (const [provider, entry] of healthEntries) {
        if (entry.status === "reauth-required") {
          result.push(provider);
        }
      }
      return result.sort();
    },

    getNonHealthyProviders() {
      const result: string[] = [];
      for (const [provider, entry] of healthEntries) {
        if (entry.status !== "healthy") {
          result.push(provider);
        }
      }
      return result.sort();
    },

    subscribe(listener) {
      if (disposed) return () => {};
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
