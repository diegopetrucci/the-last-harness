import { isRecord } from "./common.js";
import { parseProviderModelReference } from "./model-defaults.js";
import type { ProviderAuthHealthStore } from "./provider-auth-health.js";

// Keep in sync with extensions/subagents/src/shared/types.ts:SUBAGENT_ASYNC_COMPLETE_EVENT.
// Do NOT import from that package — it carries its own upstream provenance.
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/**
 * Return true when an error string from a failed ModelAttempt carries a
 * high-confidence runtime auth rejection signature.
 *
 * Matches only these three high-confidence auth-rejection patterns:
 *   - invalid_grant (OAuth token revoked / expired grant)
 *   - token-refresh unauthorized / token refresh unauthorized
 *     (pi-ai/dist/auth/oauth/kimi-coding.js:222-224 pattern)
 *   - provider 401 / 403 embedded in the error message
 *
 * Conservative by design: rate-limit (429), server errors (5xx), network, and
 * credential-store errors must NOT match here — those are transient, not
 * historical auth facts.
 */
export function isHighConfidenceAuthSignatureInAttemptError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("invalid_grant") ||
    lower.includes("token-refresh unauthorized") ||
    lower.includes("token refresh unauthorized") ||
    lower.includes("status 401") ||
    lower.includes("status 403") ||
    lower.includes("(status 401)") ||
    lower.includes("(status 403)") ||
    lower.includes("http 401") ||
    lower.includes("http 403")
  );
}

/**
 * Walk the Details payload from a subagent tool result (or async-complete artifact)
 * and record run-level auth observations for any failed ModelAttempt that carries
 * a high-confidence auth rejection signature.
 *
 * Parses from `unknown` per the TypeScript boundaries skill — this crosses the
 * extensions/subagents open-object boundary (types.ts:650-690). Every field access
 * is guarded; malformed payloads are silently skipped.
 *
 * Associates each failed attempt with the provider parsed from THAT attempt's model
 * id (not the run's final model), so a successful fallback where the run ends on a
 * different provider is correctly attributed.
 */
export function processSubagentRunDetails(
  details: unknown,
  authStore: ProviderAuthHealthStore,
): void {
  if (!isRecord(details)) return;
  const { results } = details;
  if (!Array.isArray(results)) return;

  for (const result of results) {
    if (!isRecord(result)) continue;
    const { modelAttempts } = result;
    if (!Array.isArray(modelAttempts)) {
      continue;
    }

    for (const attempt of modelAttempts) {
      if (!isRecord(attempt)) continue;
      const { model, success, error } = attempt;
      // Validate required fields per the TypeScript boundaries skill.
      if (typeof model !== "string" || typeof success !== "boolean") continue;
      // Only failed attempts carry auth errors worth recording.
      if (success === true) continue;
      if (typeof error !== "string" || error.length === 0) continue;

      // Attribute the failure to the provider from THIS attempt's model id,
      // not the run's final model. On a successful fallback the final result
      // carries no auth error, so attributing from the run level would miss it.
      const parsed = parseProviderModelReference(model);
      if (!parsed?.provider) continue;

      if (isHighConfidenceAuthSignatureInAttemptError(error)) {
        authStore.recordRunLevelAuthObservation(parsed.provider);
      }
    }
  }
}

/**
 * Backoff intervals for per-provider credential preflight throttle.
 * After the Nth consecutive failure, wait at least this long before re-probing.
 *
 * Chosen intervals: 60 s (1st failure), 120 s (2nd), 300 s (3rd+).
 * Reset to zero on a successful probe.
 */
export function dispatchPreflightBackoffMs(failures: number): number {
  if (failures <= 1) return 60_000;
  if (failures === 2) return 120_000;
  return 300_000;
}

/**
 * Extract the unique provider strings from a subagent tool-call input after
 * applyProviderAwareSubagentModels has mutated it.
 *
 * Reads `input.model` (single dispatch) and `input.tasks[].model` (parallel
 * dispatch). Non-string and unparseable model values are silently skipped so
 * a malformed input never prevents the tool call from proceeding.
 */
export function extractDispatchProviders(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const obj = input as Record<string, unknown>;
  const seen = new Set<string>();

  function addModel(model: unknown): void {
    if (typeof model !== "string") return;
    const parsed = parseProviderModelReference(model);
    if (parsed?.provider) seen.add(parsed.provider);
  }

  addModel(obj["model"]);

  if (Array.isArray(obj["tasks"])) {
    for (const task of obj["tasks"]) {
      if (typeof task === "object" && task !== null) {
        addModel((task as Record<string, unknown>)["model"]);
      }
    }
  }

  return [...seen];
}
