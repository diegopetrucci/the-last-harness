import { parseThinkingLevel, splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import type { SubagentModelIdentity, SubagentModelResolution, Usage } from "../../shared/types.ts";
import {
  checkModelScope,
  type ModelScopeConfig,
  type ModelScopeViolation,
  type ModelSource,
} from "./model-scope.ts";

interface ModelAttemptSummary {
  model: string;
  success: boolean;
  exitCode?: number | null;
  error?: string;
  usage?: Usage;
}

function sameModelIdentity(
  left: SubagentModelIdentity | undefined,
  right: SubagentModelIdentity,
): boolean {
  return Boolean(
    left &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.thinking === right.thinking,
  );
}

/**
 * Append one completed runtime-fallback transition to the durable resolution.
 * `sourceAttempt` is the candidate that just failed; callers invoke this at
 * attempt start and again at terminalization, so crash-window and final
 * artifacts share the same ordered history.
 */
export function appendRuntimeFallbackResolution(input: {
  previous?: SubagentModelResolution;
  sourceAttempt?: ModelAttemptSummary;
  currentIdentity?: SubagentModelIdentity;
  originalIdentity?: SubagentModelIdentity;
}): SubagentModelResolution | undefined {
  const current = input.currentIdentity;
  const source = input.sourceAttempt;
  if (!current || !source) return input.previous;
  if (sameModelIdentity(input.previous?.resumed, current)) return input.previous;
  const original =
    input.previous?.original ??
    input.originalIdentity ??
    canonicalSubagentModelIdentity(source.model);
  const currentReference = `${current.provider}/${current.model}${current.thinking ? `:${current.thinking}` : ""}`;
  const transition = `Runtime fallback selected '${currentReference}' after '${source.model}' failed: ${source.error ?? `exit ${source.exitCode ?? 1}`}.`;
  return {
    kind: "fallback",
    ...(original ? { original } : {}),
    resumed: current,
    reason: [input.previous?.reason, transition].filter(Boolean).join(" "),
  };
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
const INHERIT_MODEL = "inherit";

/**
 * Convert a canonical provider/model argument and effective thinking level into
 * the durable identity used by resume artifacts. Model strings without a
 * provider cannot safely be persisted as an identity because they may resolve
 * to a different provider after a session reload.
 */
export function canonicalSubagentModelIdentity(
  model: string | undefined,
  thinking?: string,
): SubagentModelIdentity | undefined {
  if (!model) return undefined;
  const parsed = splitKnownThinkingSuffix(model);
  const separator = parsed.baseModel.indexOf("/");
  if (separator <= 0 || separator === parsed.baseModel.length - 1) return undefined;
  const effectiveThinking = parsed.thinkingSuffix
    ? parsed.thinkingSuffix.slice(1)
    : parseThinkingLevel(thinking);
  return {
    provider: parsed.baseModel.slice(0, separator),
    model: parsed.baseModel.slice(separator + 1),
    ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
  };
}

/**
 * Sanitize persisted model identity at artifact boundaries. Provider and model
 * remain authoritative when valid; unsupported thinking values are omitted.
 */
export function sanitizeSubagentModelIdentity(value: unknown): SubagentModelIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    typeof input.provider !== "string" ||
    input.provider.trim() === "" ||
    typeof input.model !== "string" ||
    input.model.trim() === ""
  )
    return undefined;
  const thinking = parseThinkingLevel(input.thinking);
  return {
    provider: input.provider.trim(),
    model: input.model.trim(),
    ...(thinking ? { thinking } : {}),
  };
}

/** Sanitize a persisted model resolution, including both nested identities. */
export function sanitizeSubagentModelResolution(
  value: unknown,
): SubagentModelResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    (input.kind !== "restored" && input.kind !== "override" && input.kind !== "fallback") ||
    typeof input.reason !== "string" ||
    input.reason.trim() === ""
  )
    return undefined;
  const original = sanitizeSubagentModelIdentity(input.original);
  const resumed = sanitizeSubagentModelIdentity(input.resumed);
  if ((input.original !== undefined && !original) || (input.resumed !== undefined && !resumed))
    return undefined;
  return {
    kind: input.kind,
    ...(original ? { original } : {}),
    ...(resumed ? { resumed } : {}),
    reason: input.reason,
  };
}

export function modelReferenceFromIdentity(identity: SubagentModelIdentity): string {
  return `${identity.provider}/${identity.model}`;
}

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
  provider: string;
  id: string;
}

interface ResolveSubagentModelOverrideOptions {
  /** When set with `enforce: true`, out-of-scope models are rejected. */
  scope?: ModelScopeConfig;
  /** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
  source?: ModelSource;
  /** Called for warn-severity violations instead of `console.warn`. */
  onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
  console.warn(`[pi-subagents] ${violation.message}`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * Model strings are intentionally forwarded exactly after surrounding
 * whitespace is removed. Registry availability is not a resolution policy:
 * Pi receives the explicit value and decides whether it accepts the argument.
 * When no model is requested, the child inherits the parent's in-memory model
 * so another session cannot contaminate the child through global settings.
 */
export function resolveSubagentModelOverride(
  requestedModel: string | boolean | undefined,
  parentModel: ParentModel | undefined,
  options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
  const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
  const resolved =
    explicit ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
  if (resolved && options?.scope?.enforce) {
    const source: ModelSource =
      explicit === undefined ? "inherited" : (options.source ?? "inherited");
    const violation = checkModelScope(resolved, options.scope, source);
    if (violation) {
      if (violation.severity === "error") throw new Error(violation.message);
      (options.onWarn ?? defaultScopeWarn)(violation);
    }
  }
  return resolved;
}

interface BuildModelCandidatesOptions {
  /** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
  scope?: ModelScopeConfig;
  onWarn?: (violation: ModelScopeViolation) => void;
}

export interface ModelCandidatePlan {
  candidates: string[];
}

/**
 * Remove duplicate model argv values after effective thinking suffixes have
 * been applied. Two differently configured candidates can collapse to the
 * same argument and must not spawn the same child twice.
 */
export function deduplicateModelCandidates(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

/**
 * Merge provider-aware role defaults with frontmatter fallbackModels while
 * preserving declaration order and removing only exact duplicate strings.
 */
export function buildFallbackModelList(
  providerFallbackModels: string[] | undefined,
  agentFallbackModels: string[] | undefined,
): string[] | undefined {
  const seen = new Set<string>();
  const fallbackModels: string[] = [];
  for (const raw of [...(providerFallbackModels ?? []), ...(agentFallbackModels ?? [])]) {
    const model = typeof raw === "string" ? raw.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    fallbackModels.push(model);
  }
  return fallbackModels.length > 0 ? fallbackModels : undefined;
}

/**
 * Build the deterministic dispatch order. The primary model is always first,
 * followed by provider-aware and role-declared fallback entries. No catalog,
 * fuzzy matching, or availability view participates in this plan.
 */
export function buildModelCandidatePlan(
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
  options?: BuildModelCandidatesOptions,
): ModelCandidatePlan {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const raw = rawCandidates[index];
    if (typeof raw !== "string") continue;
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    if (index > 0 && options?.scope?.enforce) {
      const violation = checkModelScope(model, options.scope, "inherited");
      if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
    }
    seen.add(model);
    candidates.push(model);
  }
  return { candidates };
}

function replaceModelNoticeControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? " " : character;
    })
    .join("");
}

export function sanitizeModelFallbackNotice(notice: string | undefined): string | undefined {
  if (typeof notice !== "string") return undefined;
  const sanitized = replaceModelNoticeControlCharacters(notice).replace(/\s+/g, " ").trim();
  return sanitized ? sanitized.slice(0, 240) : undefined;
}

/**
 * Only failures that can plausibly be repaired by changing providers/models
 * retry. Explicit Pi model rejections, authentication/configuration errors,
 * tool failures, and ordinary task errors are non-transient.
 */
const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /\bquota\b/i,
  /connection\s+(?:refused|reset|closed|timed?\s*out)/i,
  /fetch failed/i,
  /network\s+error/i,
  /socket hang up/i,
  /\b(?:econnreset|econnrefused|enetunreach|ehostunreach|eai_again|etimedout)\b/i,
  /(?:request|provider|upstream|gateway)\s+.*\b(?:timed?\s*out|timeout)\b/i,
  /stream ended without finish_reason/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /internal server error/i,
  /\boverloaded(?:_error)?\b/i,
];

/**
 * Child tool errors can contain network/provider words, but rerunning the
 * whole task under another model cannot repair a failed tool invocation.
 */
const TOOL_FAILURE_PREFIX =
  /^[\w.:@/-]+ failed (?:(?:(?:\(exit \d+\):))|(?:with exit code \d+))(?:\s|$)/i;

export function isRetryableModelFailure(error: string | undefined): boolean {
  if (!error) return false;
  if (TOOL_FAILURE_PREFIX.test(error.trim())) return false;
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
  const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
  return nextModel
    ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
    : `[fallback] ${attempt.model} failed: ${failure}.`;
}
