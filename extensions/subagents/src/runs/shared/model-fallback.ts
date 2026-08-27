import {
  parseThinkingLevel,
  splitKnownThinkingSuffix,
  type ModelInfo as AvailableModelInfo,
} from "../../shared/model-info.ts";
import type { SubagentModelIdentity, SubagentModelResolution, Usage } from "../../shared/types.ts";
import {
  checkModelScope,
  type ModelScopeConfig,
  type ModelScopeViolation,
  type ModelSource,
} from "./model-scope.ts";

export type { AvailableModelInfo };

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

function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
  return splitKnownThinkingSuffix(model);
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

interface RuntimeModelContextResolution {
  identity: SubagentModelIdentity;
  contextWindow: number;
}

const SAFE_RUNTIME_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Model ids are registry-owned values. Keep the boundary conservative without
// treating `/` or `:` as separators: providers such as OpenRouter and Ollama
// legitimately report those characters in the model id itself.
const SAFE_RUNTIME_MODEL = /^(?!\/)(?!.*\/$)[^\s\0]+$/;

function runtimeIdentityFromFullId(
  fullId: string,
  thinkingSuffix: string,
): SubagentModelIdentity | undefined {
  // Match canonicalSubagentModelIdentity: only the first slash separates the
  // provider, so nested provider model ids remain intact.
  const separator = fullId.indexOf("/");
  if (separator <= 0 || separator === fullId.length - 1) return undefined;
  const provider = fullId.slice(0, separator);
  const model = fullId.slice(separator + 1);
  if (!SAFE_RUNTIME_PROVIDER.test(provider) || !SAFE_RUNTIME_MODEL.test(model)) return undefined;
  return {
    provider,
    model,
    ...(thinkingSuffix ? { thinking: thinkingSuffix.slice(1) } : {}),
  };
}

/**
 * Resolve a model identity reported by an untrusted child message only when it
 * names an exact registered context window. A separately reported provider
 * scopes the opaque model id; an empty provider accepts a qualified full id.
 */
export function resolveRuntimeModelContext(
  providerValue: unknown,
  modelValue: unknown,
  contextWindows: Record<string, number> | undefined,
): RuntimeModelContextResolution | undefined {
  if (
    !contextWindows ||
    (typeof contextWindows !== "object" && typeof contextWindows !== "function") ||
    typeof modelValue !== "string" ||
    (providerValue !== undefined && typeof providerValue !== "string")
  )
    return undefined;
  const provider = typeof providerValue === "string" ? providerValue.trim() : "";
  const model = modelValue.trim();
  if (model === "") return undefined;
  if (provider !== "" && !SAFE_RUNTIME_PROVIDER.test(provider)) return undefined;
  const parsed = splitKnownThinkingSuffix(model);
  if (!SAFE_RUNTIME_MODEL.test(parsed.baseModel)) return undefined;

  // With a separately reported provider, the model portion is opaque. This is
  // what preserves registry ids such as openrouter/anthropic/claude-* and
  // ollama/qwen3:8b instead of mis-parsing their model portions as providers.
  const fullId = provider ? `${provider}/${parsed.baseModel}` : parsed.baseModel;
  if (!Object.hasOwn(contextWindows, fullId)) return undefined;
  const identity = runtimeIdentityFromFullId(fullId, parsed.thinkingSuffix);
  if (!identity) return undefined;
  const contextWindow = contextWindows[fullId];
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return undefined;
  return { identity, contextWindow };
}

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
  provider: string;
  id: string;
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
  return segment.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
  const yyyy = Number(year);
  const mm = Number(month);
  const dd = Number(day);
  return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
  const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
  if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
  const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
  if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
  return segment;
}

function resolveBaseModelCandidate(
  baseModel: string,
  availableModels: readonly AvailableModelInfo[],
  preferredProvider?: string,
): string | undefined {
  if (baseModel.includes("/")) {
    const exact = availableModels.find((entry) => entry.fullId === baseModel);
    if (exact) return exact.fullId;
  } else {
    const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
    if (preferredProvider) {
      const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
      if (preferredMatch) return preferredMatch.fullId;
    }
    if (exactMatches.length === 1) return exactMatches[0]!.fullId;
  }

  return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
  baseModel: string,
  availableModels: readonly AvailableModelInfo[],
  preferredProvider?: string,
): string | undefined {
  let queryProvider: string | undefined;
  let queryIdRaw = baseModel;
  const slashIdx = baseModel.indexOf("/");
  if (slashIdx !== -1) {
    queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
    queryIdRaw = baseModel.slice(slashIdx + 1);
  } else {
    const providerSeparators = [":", "."];
    for (const separator of providerSeparators) {
      const separatorIdx = baseModel.indexOf(separator);
      if (separatorIdx <= 0) continue;
      const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
      if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart))
        continue;
      queryProvider = providerPart;
      queryIdRaw = baseModel.slice(separatorIdx + 1);
      break;
    }
  }
  const queryId = normalizeModelSegment(queryIdRaw);
  const queryIdNoDate = stripTrailingDateStamp(queryId);

  const candidates = availableModels.filter((entry) => {
    const entryId = normalizeModelSegment(entry.id);
    if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
    if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider)
      return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  if (preferredProvider) {
    const preferredProviderNorm = normalizeModelSegment(preferredProvider);
    const preferred = candidates.find(
      (entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm,
    );
    if (preferred) return preferred.fullId;
  }
  if (candidates.length === 1) return candidates[0]!.fullId;
  return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
  model: string | undefined,
  availableModels: readonly AvailableModelInfo[] | undefined,
  preferredProvider?: string,
): string | undefined {
  if (!model) return undefined;
  if (!availableModels || availableModels.length === 0) return model;

  const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
  if (resolvedWhole) return resolvedWhole;

  const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
  if (!thinkingSuffix) return model;
  const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
  if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
  return model;
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
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one.
 */
export function resolveSubagentModelOverride(
  requestedModel: string | boolean | undefined,
  parentModel: ParentModel | undefined,
  availableModels: readonly AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
  const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
  const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
  let resolved: string | undefined;
  if (explicit === undefined) {
    resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
  } else {
    resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
  }
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

export interface ModelRegistryEvidence {
  /** Complete model catalog returned by the current ModelRegistry.getAll() view. */
  allModels?: readonly AvailableModelInfo[];
  /** Any registry/availability error makes the snapshot too stale to filter with. */
  error?: string;
}

interface BuildModelCandidatesOptions {
  /** Fallback models are inherited agent config and warn, rather than error, when out of scope. */
  scope?: ModelScopeConfig;
  onWarn?: (violation: ModelScopeViolation) => void;
  /** Optional catalog/availability evidence used only for conservative fallback filtering. */
  registry?: ModelRegistryEvidence;
}

export interface ModelCandidatePlan {
  candidates: string[];
  /** Raw fallback entries removed because the registry positively reported them unavailable. */
  filteredFallbackModels: string[];
  /** Bounded, actionable notice for a non-empty filteredFallbackModels list. */
  filteringNotice?: string;
}

export function buildFallbackModelList(
  perExecutionFallbackModels: string[] | undefined,
  agentFallbackModels: string[] | undefined,
): string[] | undefined {
  const seen = new Set<string>();
  const fallbackModels: string[] = [];
  for (const raw of [...(perExecutionFallbackModels ?? []), ...(agentFallbackModels ?? [])]) {
    const model = typeof raw === "string" ? raw.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    fallbackModels.push(model);
  }
  return fallbackModels.length > 0 ? fallbackModels : undefined;
}

/**
 * Find a catalog entry for a requested fallback without treating absence as
 * evidence. The availability list is intentionally not used for this lookup:
 * ModelRegistry.getAvailable() is auth-filtered, while getAll() is the complete
 * known catalog. Qualified ids resolve only to an exact/fuzzy match within the
 * requested provider; bare ids require the normal unique/preferred-provider
 * resolution rules.
 */
function findCatalogModel(
  model: string,
  allModels: readonly AvailableModelInfo[],
  preferredProvider?: string,
): AvailableModelInfo | undefined {
  // Check the unsplit id first: providers such as Ollama may legitimately use
  // a model id ending in ":high", even though that is also a TLH thinking suffix.
  const exactWhole = allModels.find((entry) => entry.fullId === model);
  if (exactWhole) return exactWhole;
  const baseModel = splitKnownThinkingSuffix(model).baseModel;
  const exact = allModels.find((entry) => entry.fullId === baseModel);
  if (exact) return exact;
  const resolved = resolveModelCandidate(baseModel, allModels, preferredProvider);
  if (!resolved) return undefined;
  return allModels.find((entry) => entry.fullId === resolved);
}

function isAuthoritativelyUnavailableFallback(
  normalizedCandidate: string,
  availableModels: readonly AvailableModelInfo[] | undefined,
  preferredProvider: string | undefined,
  registry: ModelRegistryEvidence | undefined,
): boolean {
  // No catalog, no availability snapshot, an empty availability view, or an
  // availability refresh error is uncertainty. In all of those cases the
  // configured fallback remains a candidate rather than being silently erased.
  if (
    !registry?.allModels ||
    registry.allModels.length === 0 ||
    registry.error?.trim() ||
    !availableModels ||
    availableModels.length === 0
  )
    return false;

  // The candidate that will actually be dispatched is authoritative when the
  // availability view contains it. This must happen before catalog resolution:
  // aliases (including dated ids) and preferred-provider bare ids may resolve
  // to a canonical fullId that differs from the persisted fallback spelling.
  if (availableModels.some((entry) => entry.fullId === normalizedCandidate)) return false;

  // Only a catalog match plus absence from the non-empty availability view is
  // positive evidence of unavailability. Unknown candidates remain intact.
  const catalogModel = findCatalogModel(normalizedCandidate, registry.allModels, preferredProvider);
  if (!catalogModel) return false;
  return !availableModels.some((entry) => entry.fullId === catalogModel.fullId);
}

function formatFilteredFallbackNotice(filteredFallbackModels: string[]): string {
  const names: string[] = [];
  let remaining = filteredFallbackModels.length;
  for (const model of filteredFallbackModels) {
    const safeName = sanitizeModelFallbackNotice(model)?.slice(0, 48) ?? "(unnamed)";
    const separator = names.length > 0 ? ", " : "";
    if (names.join(", ").length + separator.length + safeName.length > 96) break;
    names.push(safeName);
    remaining--;
  }
  if (remaining > 0) names.push(`+${remaining} more`);
  const modelLabel = filteredFallbackModels.length === 1 ? "model" : "models";
  return (
    sanitizeModelFallbackNotice(
      `Skipped ${filteredFallbackModels.length} unavailable fallback ${modelLabel}${
        names.length > 0 ? ` (${names.join(", ")})` : ""
      }. Check provider credentials or update fallbackModels; the primary model was retained.`,
    ) ??
    "Unavailable fallback models were skipped; check provider credentials or update fallbackModels."
  );
}

export function buildModelCandidatePlan(
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
  availableModels: readonly AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: BuildModelCandidatesOptions,
): ModelCandidatePlan {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const filteredFallbackModels: string[] = [];
  const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
  for (let index = 0; index < rawCandidates.length; index++) {
    const raw = rawCandidates[index];
    if (!raw) continue;
    const model = raw.trim();
    if (!model) continue;
    const normalized = resolveModelCandidate(model, availableModels, preferredProvider);
    if (!normalized || seen.has(normalized)) continue;
    if (
      index > 0 &&
      isAuthoritativelyUnavailableFallback(
        normalized,
        availableModels,
        preferredProvider,
        options?.registry,
      )
    ) {
      seen.add(normalized);
      filteredFallbackModels.push(model);
      continue;
    }
    if (index > 0 && options?.scope?.enforce) {
      const violation = checkModelScope(normalized, options.scope, "inherited");
      if (violation) (options.onWarn ?? defaultScopeWarn)(violation);
    }
    seen.add(normalized);
    candidates.push(normalized);
  }
  return {
    candidates,
    filteredFallbackModels,
    ...(filteredFallbackModels.length > 0
      ? { filteringNotice: formatFilteredFallbackNotice(filteredFallbackModels) }
      : {}),
  };
}

export function buildModelCandidates(
  primaryModel: string | undefined,
  fallbackModels: string[] | undefined,
  availableModels: readonly AvailableModelInfo[] | undefined,
  preferredProvider?: string,
  options?: BuildModelCandidatesOptions,
): string[] {
  return buildModelCandidatePlan(
    primaryModel,
    fallbackModels,
    availableModels,
    preferredProvider,
    options,
  ).candidates;
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

const MAX_MODEL_FALLBACK_NOTICE_LENGTH = 240;
const MIN_MEANINGFUL_MODEL_FALLBACK_PREFIX_LENGTH = 24;

/**
 * Combine notices while preserving the same one-line/240-character boundary.
 * The final notice is the highest-priority one so a registry-filtering action
 * remains visible even when an inherited notice is unusually long. Truncated
 * lower-priority notices end at a word boundary; a too-short fragment is
 * dropped rather than displayed as an unreadable partial message.
 */
export function combineModelFallbackNotices(
  ...notices: Array<string | undefined>
): string | undefined {
  const unique = [...new Set(notices.map(sanitizeModelFallbackNotice).filter(Boolean))];
  if (unique.length === 0) return undefined;
  const joined = unique.join(" ");
  if (joined.length <= MAX_MODEL_FALLBACK_NOTICE_LENGTH) return joined;
  const priority = unique.at(-1)!;
  if (priority.length >= MAX_MODEL_FALLBACK_NOTICE_LENGTH)
    return priority.slice(0, MAX_MODEL_FALLBACK_NOTICE_LENGTH);

  const prefixBudget = MAX_MODEL_FALLBACK_NOTICE_LENGTH - priority.length - 1;
  if (prefixBudget < MIN_MEANINGFUL_MODEL_FALLBACK_PREFIX_LENGTH) return priority;
  const prefixSource = unique.slice(0, -1).join(" ");
  const truncatedPrefix = prefixSource.slice(0, prefixBudget).trimEnd();
  const wordBoundary = truncatedPrefix.lastIndexOf(" ");
  if (wordBoundary < MIN_MEANINGFUL_MODEL_FALLBACK_PREFIX_LENGTH) return priority;
  const prefix = truncatedPrefix.slice(0, wordBoundary).trimEnd();
  return prefix.length >= MIN_MEANINGFUL_MODEL_FALLBACK_PREFIX_LENGTH
    ? `${prefix} ${priority}`
    : priority;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /usage\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication)?/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /api key/i,
  /token expired/i,
  /invalid key/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /connection refused/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /stream ended without finish_reason/i,
  /upstream/i,
  /timed? out/i,
  /timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /cold.?start/i,
  /empty response/i,
  /no output/i,
  /model.*(?:load|fail|error)/i,
];

/**
 * Child tool errors can contain network/provider words, but rerunning the
 * whole task under another model cannot repair a failed tool invocation.
 */
const TOOL_FAILURE_PREFIX =
  /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

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
