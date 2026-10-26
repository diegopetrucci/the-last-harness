import { THINKING_LEVELS } from "./constants.js";
import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import type {
  ReasoningModel,
  ThinkingLevel,
  TlhModelDefault,
  TlhModelDefaultsSource,
  TlhSubagentOverride,
} from "./types.js";

import { isRecord } from "./common.js";
import {
  isEmbeddedSubagentTarget,
  PROVIDER_AWARE_FALLBACK_MODELS,
} from "../the-last-harness-subagent-safety.mjs";

export type ProviderModelReference = {
  provider: string;
  id: string;
};

export type AgentModelDefaults = {
  name: string;
  model?: string;
  /** Primary-only preferred model preserving the former generic default precedence. */
  preferredModel?: ProviderModelReference;
  /** Normalized provider entries produced by the frontmatter loader. */
  tlhModelDefaults: readonly TlhModelDefault[];
  /** Required provenance prevents direct constructors from silently changing semantics. */
  tlhModelDefaultsSource: TlhModelDefaultsSource;
  /** Generic compatibility fields are retained for legacy frontmatter only. */
  thinking?: ThinkingLevel;
  preferCurrentOpenaiModel?: boolean;
  preferOppositeProvider?: boolean;
};

type ProviderAwareAgentDefaults<T extends ProviderModelReference = ProviderModelReference> = {
  model?: T;
  thinking?: ThinkingLevel;
};

type ProviderAwareSubagentFallback<T extends ProviderModelReference = ProviderModelReference> = {
  model: T;
  thinking?: ThinkingLevel;
};

type ProviderAwareSubagentResolution<T extends ProviderModelReference = ProviderModelReference> = {
  model?: T;
  unavailableModel?: string;
  fallbackModels?: ProviderAwareSubagentFallback<T>[];
  modelFallbackNotice?: string;
  thinking?: ThinkingLevel;
  independence: "not-applicable" | "preferred" | "degraded" | "unknown";
  warning?: string;
  fallbackWarning?: string;
};

type ApplyProviderAwareSubagentModelOptions = {
  agentOverrides?: ReadonlyMap<string, TlhSubagentOverride>;
  onWarning?: (warning: { agent: string; message: string; source?: "stored" }) => void;
};

type ReasoningProviderModelReference = ProviderModelReference & Partial<ReasoningModel>;

const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
const XAI_PROVIDERS = new Set(["xai"]);
const OPENROUTER_PROVIDERS = new Set(["openrouter"]);
const OPPOSITE_PROVIDER_FALLBACK_NOTICE =
  "TLH fell back to a same-provider review model; review independence is reduced.";
const OPENROUTER_OPPOSITE_FALLBACK_NOTICE =
  "TLH fell back to the session model; review independence is reduced.";

export function parseProviderModelReference(
  model: string | undefined,
): ProviderModelReference | undefined {
  const slash = model?.indexOf("/") ?? -1;
  if (!model || slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

export function formatProviderModelReference(model: ProviderModelReference): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Return the validated provider/model references declared by an agent, in
 * frontmatter order and without duplicates. Consumers must use this normalized
 * collection rather than the legacy provider-specific frontmatter fields.
 */
export function listAgentModelDefaultReferences(
  agent: { tlhModelDefaults?: readonly TlhModelDefault[] } | undefined,
): ProviderModelReference[] {
  const seen = new Set<string>();
  const references: ProviderModelReference[] = [];
  for (const entry of agent?.tlhModelDefaults ?? []) {
    for (const model of entry.models ?? []) {
      if (model.provider !== entry.provider) {
        continue;
      }
      const key = formatProviderModelReference(model);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      references.push(model);
    }
  }
  return references;
}

function agentModelsForProvider(
  agent: AgentModelDefaults | undefined,
  provider: string | undefined,
): ProviderModelReference[] {
  if (!provider) {
    return [];
  }
  return listAgentModelDefaultReferences(agent).filter((model) => model.provider === provider);
}

function agentModelsForFamily(
  agent: AgentModelDefaults | undefined,
  family: ProviderFamily,
): ProviderModelReference[] {
  return listAgentModelDefaultReferences(agent).filter((model) =>
    family === "openai"
      ? isOpenaiProvider(model.provider)
      : family === "anthropic"
        ? isAnthropicProvider(model.provider)
        : isXaiProvider(model.provider),
  );
}

/**
 * Format a model reference with an optional thinking suffix.
 * Every level in THINKING_LEVELS (including `max`) is a valid model-string suffix:
 * the subagents runtime that consumes these strings parses the same list in
 * `extensions/subagents/src/shared/model-info.ts`. Recognized effort is forwarded
 * without capability filtering; Pi validates the resulting model argument.
 */
export function formatResolvedProviderModelReference(
  model: ProviderModelReference,
  thinking: ThinkingLevel | undefined,
): string {
  if (!thinking || !THINKING_LEVELS.includes(thinking)) {
    return formatProviderModelReference(model);
  }
  return `${formatProviderModelReference(model)}:${thinking}`;
}

/**
 * Split a model string into a base model and a known thinking suffix.
 * If the last colon-delimited segment is a level in THINKING_LEVELS, it is treated
 * as a suffix; otherwise the entire string is the base model. This mirrors
 * `splitKnownThinkingSuffix` in the subagents runtime (shared/model-info.ts).
 */
export function splitKnownThinkingSuffix(model: string | undefined): {
  baseModel: string | undefined;
  thinkingSuffix: string;
} {
  if (!model) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  const colon = model.lastIndexOf(":");
  if (colon === -1) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  const suffix = model.slice(colon + 1);
  if (!THINKING_LEVELS.includes(suffix as ThinkingLevel)) {
    return { baseModel: model, thinkingSuffix: "" };
  }
  return { baseModel: model.slice(0, colon), thinkingSuffix: `:${suffix}` };
}

function applyThinkingSuffix(
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
): string | undefined {
  if (!model || !thinking) {
    return model;
  }
  if (!THINKING_LEVELS.includes(thinking)) {
    return model;
  }
  const { thinkingSuffix } = splitKnownThinkingSuffix(model);
  return thinkingSuffix ? model : `${model}:${thinking}`;
}

function isOpenaiProvider(provider: string | undefined): boolean {
  return Boolean(provider && OPENAI_PROVIDERS.has(provider));
}

function isAnthropicProvider(provider: string | undefined): boolean {
  return Boolean(provider && ANTHROPIC_PROVIDERS.has(provider));
}

function isXaiProvider(provider: string | undefined): boolean {
  return Boolean(provider && XAI_PROVIDERS.has(provider));
}

function isOpenrouterProvider(provider: string | undefined): boolean {
  return Boolean(provider && OPENROUTER_PROVIDERS.has(provider));
}

/**
 * Whether an agent follows the active session model for the OpenRouter provider.
 * This predicate is shared by default resolution and primary override persistence.
 */
export function followsOpenrouterSession(
  agent: AgentModelDefaults | undefined,
  provider: string | undefined,
): boolean {
  return isOpenrouterProvider(provider) && !agent?.preferOppositeProvider;
}

type ProviderFamily = "openai" | "anthropic" | "xai";

function providerFamily(
  provider: string | undefined,
  modelId?: string,
): ProviderFamily | undefined {
  if (isOpenaiProvider(provider)) {
    return "openai";
  }
  if (isAnthropicProvider(provider)) {
    return "anthropic";
  }
  if (isXaiProvider(provider)) {
    return "xai";
  }
  if (isOpenrouterProvider(provider)) {
    const underlyingVendor = modelId?.split("/", 1)[0];
    if (underlyingVendor === "openai" || underlyingVendor === "anthropic") {
      return underlyingVendor;
    }
    if (underlyingVendor === "x-ai") {
      return "xai";
    }
  }
  return undefined;
}

export function findAvailableProviderModel<T extends ProviderModelReference>(
  availableModels: readonly T[],
  model: unknown,
): T | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  // Try exact match first (supports colon-bearing model IDs like "openrouter/reasoner:high")
  const exactParsed = parseProviderModelReference(model);
  const exactMatch = findAvailableProviderModelReference(availableModels, exactParsed);
  if (exactMatch) {
    return exactMatch;
  }
  // Fall back to matching after stripping a known thinking suffix
  const baseParsed = parseProviderModelReference(splitKnownThinkingSuffix(model).baseModel);
  return findAvailableProviderModelReference(availableModels, baseParsed);
}

function findAvailableProviderModelReference<T extends ProviderModelReference>(
  availableModels: readonly T[],
  model: ProviderModelReference | undefined,
): T | undefined {
  if (!model) {
    return undefined;
  }
  return availableModels.find(
    (entry) => entry.provider === model.provider && entry.id === model.id,
  );
}

function availableOpenaiCandidate<T extends ProviderModelReference>(
  availableModels: readonly T[],
  candidate: string | undefined,
): T | undefined {
  const parsed = parseProviderModelReference(candidate);
  if (!parsed || !isOpenaiProvider(parsed.provider)) {
    return undefined;
  }
  return findAvailableProviderModel(availableModels, candidate);
}

function availableCodexCandidate<T extends ProviderModelReference>(
  availableModels: readonly T[],
  candidate: string | undefined,
): T | undefined {
  const parsed = parseProviderModelReference(candidate);
  if (!parsed || parsed.provider !== "openai-codex") {
    return undefined;
  }
  return findAvailableProviderModel(availableModels, candidate);
}

function availableAnthropicCandidate<T extends ProviderModelReference>(
  availableModels: readonly T[],
  candidate: string | undefined,
): T | undefined {
  const parsed = parseProviderModelReference(candidate);
  if (!parsed || !isAnthropicProvider(parsed.provider)) {
    return undefined;
  }
  return findAvailableProviderModel(availableModels, candidate);
}

function availableXaiCandidate<T extends ProviderModelReference>(
  availableModels: readonly T[],
  candidate: string | undefined,
): T | undefined {
  const parsed = parseProviderModelReference(candidate);
  if (!parsed || !isXaiProvider(parsed.provider)) {
    return undefined;
  }
  return findAvailableProviderModel(availableModels, candidate);
}

function currentProviderOpenaiCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!isOpenaiProvider(currentProvider)) {
    return undefined;
  }
  const currentProviderCandidate = agentModelsForProvider(agent, currentProvider).find(
    (candidate) => candidate.provider === currentProvider,
  );
  return availableOpenaiCandidate(
    availableModels,
    currentProviderCandidate ? formatProviderModelReference(currentProviderCandidate) : undefined,
  );
}

function currentProviderAnthropicCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!isAnthropicProvider(currentProvider)) {
    return undefined;
  }
  const currentProviderCandidate = agentModelsForProvider(agent, currentProvider).find(
    (candidate) => candidate.provider === currentProvider,
  );
  return availableAnthropicCandidate(
    availableModels,
    currentProviderCandidate ? formatProviderModelReference(currentProviderCandidate) : undefined,
  );
}

function currentProviderXaiCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!isXaiProvider(currentProvider)) {
    return undefined;
  }
  for (const candidate of agentModelsForProvider(agent, currentProvider)) {
    const model = availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
    if (model) {
      return model;
    }
  }
  return undefined;
}

function currentProviderCustomCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (
    agent?.tlhModelDefaultsSource !== "frontmatter" ||
    agent?.preferOppositeProvider ||
    !currentProvider ||
    isOpenaiProvider(currentProvider) ||
    isAnthropicProvider(currentProvider) ||
    isXaiProvider(currentProvider) ||
    isOpenrouterProvider(currentProvider)
  ) {
    return undefined;
  }
  for (const candidate of agentModelsForProvider(agent, currentProvider)) {
    const model = findAvailableProviderModel(
      availableModels,
      formatProviderModelReference(candidate),
    );
    if (model) {
      return model;
    }
  }
  return undefined;
}

function selectOppositeProviderPreferredAgentModel<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
  currentModel?: ProviderModelReference,
): T | undefined {
  if (!agent?.preferOppositeProvider) {
    return undefined;
  }

  if (isOpenrouterProvider(currentProvider)) {
    const currentFamily = providerFamily(currentProvider, currentModel?.id);
    const families: ProviderFamily[] =
      currentFamily === "anthropic"
        ? ["openai", "xai", "anthropic"]
        : currentFamily === "openai"
          ? ["anthropic", "xai", "openai"]
          : currentFamily === "xai"
            ? ["anthropic", "openai", "xai"]
            : ["openai", "anthropic", "xai"];
    for (const family of families) {
      const candidates = agentModelsForFamily(agent, family);
      for (const candidate of candidates) {
        const model =
          family === "openai"
            ? availableOpenaiCandidate(availableModels, formatProviderModelReference(candidate))
            : family === "anthropic"
              ? availableAnthropicCandidate(
                  availableModels,
                  formatProviderModelReference(candidate),
                )
              : availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
        if (model) {
          return model;
        }
      }
    }
    return undefined;
  }

  if (isAnthropicProvider(currentProvider)) {
    for (const family of ["openai", "xai"] as const) {
      for (const candidate of agentModelsForFamily(agent, family)) {
        const model =
          family === "openai"
            ? availableCodexCandidate(availableModels, formatProviderModelReference(candidate))
            : availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
        if (model) {
          return model;
        }
      }
    }
    return undefined;
  }

  if (isOpenaiProvider(currentProvider)) {
    for (const family of ["anthropic", "xai"] as const) {
      for (const candidate of agentModelsForFamily(agent, family)) {
        const model =
          family === "anthropic"
            ? availableAnthropicCandidate(availableModels, formatProviderModelReference(candidate))
            : availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
        if (model) {
          return model;
        }
      }
    }
    return undefined;
  }

  if (isXaiProvider(currentProvider)) {
    for (const family of ["anthropic", "openai"] as const) {
      for (const candidate of agentModelsForFamily(agent, family)) {
        const model =
          family === "anthropic"
            ? availableAnthropicCandidate(availableModels, formatProviderModelReference(candidate))
            : availableCodexCandidate(availableModels, formatProviderModelReference(candidate));
        if (model) {
          return model;
        }
      }
    }
  }

  return undefined;
}

function selectOppositeProviderFallbackModel<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider: string | undefined,
  currentModel: ProviderModelReference | undefined,
): T | undefined {
  if (!agent?.preferOppositeProvider) {
    return undefined;
  }

  if (isOpenrouterProvider(currentProvider) && currentModel?.provider === currentProvider) {
    // OpenRouter models are runtime session values; retain a valid current model even
    // when this dispatch's registry snapshot omitted it.
    return (
      findAvailableProviderModelReference(availableModels, currentModel) ?? (currentModel as T)
    );
  }

  if (currentModel?.provider === currentProvider) {
    const availableCurrentModel = findAvailableProviderModelReference(
      availableModels,
      currentModel,
    );
    if (availableCurrentModel) {
      return availableCurrentModel;
    }
  }

  return (
    currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
    currentProviderAnthropicCandidate(agent, availableModels, currentProvider) ??
    currentProviderXaiCandidate(agent, availableModels, currentProvider)
  );
}

function selectStandardProviderAwareAgentModel<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!agent) {
    return undefined;
  }

  // Primary agents expose preferredModel so the new provider list retains the
  // former generic `model:` precedence. New-format subagents intentionally omit
  // this field and begin with current-provider/provider-list selection below.
  const defaultModel =
    findAvailableProviderModelReference(availableModels, agent.preferredModel) ??
    (agent.tlhModelDefaultsSource === "legacy"
      ? findAvailableProviderModel(availableModels, agent.model)
      : undefined);
  if (defaultModel) {
    return defaultModel;
  }

  const currentProviderModel =
    currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
    currentProviderAnthropicCandidate(agent, availableModels, currentProvider) ??
    currentProviderXaiCandidate(agent, availableModels, currentProvider) ??
    currentProviderCustomCandidate(agent, availableModels, currentProvider);
  if (currentProviderModel) {
    return currentProviderModel;
  }

  for (const candidate of agentModelsForFamily(agent, "openai")) {
    const model = availableOpenaiCandidate(
      availableModels,
      formatProviderModelReference(candidate),
    );
    if (model) {
      return model;
    }
  }

  for (const candidate of agentModelsForFamily(agent, "anthropic")) {
    const model = availableAnthropicCandidate(
      availableModels,
      formatProviderModelReference(candidate),
    );
    if (model) {
      return model;
    }
  }

  for (const candidate of agentModelsForFamily(agent, "xai")) {
    const model = availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
    if (model) {
      return model;
    }
  }

  return undefined;
}

/**
 * When the active provider is "openrouter" (literal string only), agents without
 * preferOppositeProvider follow the current session model instead of falling
 * through to bundled direct-provider candidates.
 *
 * Thinking comes exclusively from the normalized OpenRouter entry; the generic
 * `thinking` key does NOT leak through on this path. Returns undefined when the rule does
 * not apply (provider is not openrouter or agent prefers opposite provider).
 *
 * The current model is a session identity, not necessarily a registry entry. Keep
 * that identity separate from optional reasoning metadata: this follow path preserves
 * the session identity and applies only the normalized OpenRouter effort; it does not
 * normalize saved effort against missing registry metadata.
 */
function resolveOpenrouterFollowDefaults<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider: string | undefined,
  currentModel: ProviderModelReference | undefined,
): ProviderAwareAgentDefaults<T> | undefined {
  if (!followsOpenrouterSession(agent, currentProvider)) {
    return undefined;
  }
  // Prefer registry metadata when present, but follow a valid session identity even
  // when the registry snapshot omitted it. This cast adapts identity-only data to
  // the generic return type; it is never used for capability checks as-is.
  const followedModel =
    findAvailableProviderModelReference(availableModels, currentModel) ??
    (currentModel ? (currentModel as T) : undefined);
  if (!followedModel) {
    return undefined;
  }
  // OpenRouter effort is scoped to its normalized provider entry. Generic
  // thinking never leaks onto this follow path.
  return { model: followedModel, thinking: resolveProviderThinking(agent, "openrouter") };
}

/**
 * Resolve the bundled thinking level for the given agent and provider.
 * A matching normalized provider entry is authoritative, even when it omits
 * effort. Generic thinking is retained only for legacy-normalized agents when
 * no matching provider entry exists (and never for OpenRouter).
 */
export function resolveProviderThinking(
  agent: AgentModelDefaults | undefined,
  provider: string | undefined,
): ThinkingLevel | undefined {
  if (!agent) return undefined;
  const providerEntry = agent.tlhModelDefaults?.find((entry) => entry.provider === provider);
  if (providerEntry) {
    return providerEntry.effort;
  }
  if (isOpenaiProvider(provider)) {
    // The legacy `tlhOpenaiThinking` value covered both OpenAI API and Codex
    // providers. Preserve that family behavior when the new block declares only
    // one of those provider names.
    const openaiEntry = agent.tlhModelDefaults?.find((entry) => isOpenaiProvider(entry.provider));
    if (openaiEntry) {
      return openaiEntry.effort;
    }
  }
  if (isOpenrouterProvider(provider)) {
    return undefined;
  }
  // New-format entries do not synthesize a generic effort for unknown providers.
  // Only legacy-normalized files retain their old generic thinking fallback.
  return agent.tlhModelDefaultsSource === "legacy" ? agent.thinking : undefined;
}

// Keep the internal name for model-default resolution paths; primary runtime
// callers use the explicitly provider-scoped exported helper above.
function resolveThinkingForProvider(
  agent: AgentModelDefaults | undefined,
  provider: string | undefined,
): ThinkingLevel | undefined {
  return resolveProviderThinking(agent, provider);
}

export function selectProviderAwareAgentDefaults<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
  currentModel?: ProviderModelReference,
): ProviderAwareAgentDefaults<T> {
  // OpenRouter follow rule: non-opposite-role agents follow the session model.
  const openrouterFollow = resolveOpenrouterFollowDefaults(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  if (openrouterFollow) {
    return openrouterFollow;
  }
  const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  const standardModel = agent?.preferCurrentOpenaiModel
    ? (currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
      selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider))
    : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
  const model = oppositeProviderModel ?? standardModel;
  const thinking = resolveProviderThinking(agent, model?.provider ?? currentProvider);
  return { model, thinking };
}

/**
 * Resolve the effective thinking level when a stored subagent override may be present.
 *
 * - If `override.thinking` is a recognized ThinkingLevel, return it unchanged so
 *   the model argument can carry the suffix to Pi, regardless of registry metadata.
 * - If `override.thinking` is `false`, map it to `"off"` and forward it likewise.
 * - If `override.thinking` is absent (model-only override), compute the bundled level
 *   via `resolveThinkingForProvider` without capability filtering.
 * - If the configured value is not a recognized level, omit only that invalid value
 *   and return a warning that identifies the invalid effort.
 *
 * Capability metadata may produce an informational warning for a known unsupported
 *   level, but it never changes the recognized suffix. Pi validates the resulting
 *   model argument; a Pi rejection is a non-transient model failure.
 *
 * This function must only be called when an `override` is present (`override !== undefined`).
 * For the pure no-override path use `resolveThinkingForProvider` directly.
 */
function formatInvalidStoredThinkingWarning(
  agent: AgentModelDefaults | undefined,
  rawThinking: string | false,
): string {
  const roleLabel = agent?.name ?? "this subagent";
  const value = String(rawThinking);
  const validLevels = "off, minimal, low, medium, high, xhigh, max";
  return `TLH ignored invalid stored minor-agent effort "${value}" for ${roleLabel}; expected one of ${validLevels}, so no effort suffix was applied.`;
}

function formatKnownUnsupportedThinkingWarning<T extends ReasoningProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  model: T,
  rawThinking: string | false,
  generatedFallback: boolean,
): string {
  const effort = rawThinking === false ? "off" : String(rawThinking);
  const modelLabel = `${generatedFallback ? "generated fallback " : ""}${formatProviderModelReference(model)}`;
  return `TLH stored minor-agent effort "${effort}" is not advertised by ${modelLabel}; the :${effort} suffix is forwarded and Pi will validate it.`;
}

function formatUnavailableStoredThinkingWarning(
  agent: AgentModelDefaults | undefined,
  rawThinking: string | false,
  unresolvedModelReference: string,
): string {
  const roleLabel = agent?.name ?? "this subagent";
  const effort = rawThinking === false ? "off" : String(rawThinking);
  return `TLH stored minor-agent effort "${effort}" had unavailable capability metadata for saved model "${unresolvedModelReference}"; the :${effort} suffix is forwarded and Pi will validate it for ${roleLabel}.`;
}

function resolveStoredSubagentThinking<T extends ReasoningProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  model: T | undefined,
  override: TlhSubagentOverride | undefined,
  generatedFallback = false,
  unresolvedModelReference?: string,
): { thinking?: ThinkingLevel; warning?: string } {
  const rawThinking = override?.thinking;
  const bundledThinking = resolveThinkingForProvider(agent, model?.provider);
  const requestedThinking =
    rawThinking === false
      ? "off"
      : typeof rawThinking === "string" && isThinkingLevel(rawThinking)
        ? rawThinking
        : undefined;

  if (rawThinking === undefined) {
    return bundledThinking ? { thinking: bundledThinking } : {};
  }

  if (requestedThinking === undefined) {
    return { warning: formatInvalidStoredThinkingWarning(agent, rawThinking) };
  }

  if (!model) {
    return unresolvedModelReference
      ? {
          thinking: requestedThinking,
          warning: formatUnavailableStoredThinkingWarning(
            agent,
            rawThinking,
            unresolvedModelReference,
          ),
        }
      : { thinking: requestedThinking };
  }

  // Capability metadata can explain a warning, but it never gates a recognized
  // suffix. Pi remains the authority for accepting or rejecting the argument.
  if (
    Object.hasOwn(model, "reasoning") &&
    !getAvailableThinkingLevels(model).includes(requestedThinking)
  ) {
    return {
      thinking: requestedThinking,
      warning: formatKnownUnsupportedThinkingWarning(agent, model, rawThinking, generatedFallback),
    };
  }
  return { thinking: requestedThinking };
}

function resolveIndependence(
  agent: AgentModelDefaults | undefined,
  model: ProviderModelReference | undefined,
  currentProvider?: string,
  currentModel?: ProviderModelReference,
): ProviderAwareSubagentResolution["independence"] {
  if (!agent?.preferOppositeProvider) {
    return "not-applicable";
  }
  if (!model) {
    return "unknown";
  }
  const currentFamily = providerFamily(currentProvider, currentModel?.id);
  const modelFamily = providerFamily(model.provider, model.id);
  if (!currentFamily || !modelFamily) {
    return "unknown";
  }
  return currentFamily === modelFamily ? "degraded" : "preferred";
}

export function formatUnavailableStoredModelWarning(
  agentName: string | undefined,
  model: string,
): string {
  const roleLabel = agentName ?? "this minor-agent role";
  const action = ` Update it with /subagent-settings set ${roleLabel} model <provider/id> or clear it with /subagent-settings reset ${roleLabel} model.`;
  // Fallbacks can come from the dispatch, preserved role settings, or bundled
  // agent configuration. TLH cannot observe every source here, so do not claim
  // that this dispatch will fail closed.
  return `TLH saved minor-agent model override "${model}" is not in the available registry for ${roleLabel}; forwarding the model argument to Pi for validation instead of swapping in bundled defaults.${action}`;
}

/**
 * Resolve the full provider-aware model and thinking for a subagent, incorporating
 * any stored per-agent override from settings.
 *
 * Precedence (highest to lowest):
 *  1. Stored model pin (available)  → use it; resolve thinking from stored or bundled
 *  2. Stored model pin (unavailable) → forward the exact pin and any recognized saved effort, and warn when capability metadata is unavailable
 *  3. Stored model: false            → inherit the current session model; apply stored thinking
 *  4. No stored model                → bundled provider-aware defaults
 *
 * When `override` is `undefined`, bundled defaults use `resolveThinkingForProvider`
 * directly. Recognized stored effort is forwarded here without capability filtering;
 * Pi validates the resulting model argument.
 */
export function resolveProviderAwareSubagentResolution<T extends ReasoningProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
  currentModel?: ProviderModelReference,
  override?: TlhSubagentOverride,
): ProviderAwareSubagentResolution<T> {
  // 1. Stored model pin — available in the registry
  const overrideModel = findAvailableProviderModel(availableModels, override?.model);
  if (overrideModel) {
    const thinkingResolution = resolveStoredSubagentThinking(agent, overrideModel, override, false);
    return {
      model: overrideModel,
      thinking: thinkingResolution.thinking,
      independence: resolveIndependence(agent, overrideModel, currentProvider, currentModel),
      warning: thinkingResolution.warning,
    };
  }

  // 2. Stored model pin — not available (string present but not in registry)
  if (typeof override?.model === "string") {
    const parsedOverrideModel = parseProviderModelReference(
      splitKnownThinkingSuffix(override.model).baseModel,
    );
    const thinkingResolution = resolveStoredSubagentThinking(
      agent,
      undefined,
      override,
      false,
      override.model,
    );
    return {
      unavailableModel: override.model,
      // A saved pin is still an exact argv identity. Recognized effort is
      // forwarded even when this registry cannot describe the pinned model;
      // Pi remains the authority for accepting or rejecting the suffix.
      thinking: thinkingResolution.thinking,
      independence: resolveIndependence(agent, parsedOverrideModel, currentProvider, currentModel),
      warning: thinkingResolution.warning,
    };
  }

  // 3. Stored model: false → inherit current session model
  if (override?.model === false) {
    const inheritedModel = findAvailableProviderModelReference(availableModels, currentModel);
    const thinkingResolution = resolveStoredSubagentThinking(
      agent,
      inheritedModel,
      override,
      false,
    );
    return {
      model: inheritedModel,
      thinking: thinkingResolution.thinking,
      independence: resolveIndependence(agent, inheritedModel, currentProvider, currentModel),
      warning: thinkingResolution.warning,
    };
  }

  // 4. No stored model override — use bundled provider-aware defaults.

  // OpenRouter follow rule (non-opposite-role agents only): follow the session model.
  // Thinking-only overrides are normalized by the defaults layer; the pure
  // no-override path uses the normalized OpenRouter entry exclusively — the generic
  // thinking key does not leak.
  const openrouterFollow = resolveOpenrouterFollowDefaults(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  if (openrouterFollow?.model) {
    const thinkingResolution =
      override === undefined
        ? { thinking: openrouterFollow.thinking }
        : resolveStoredSubagentThinking(agent, openrouterFollow.model, override, false);
    return {
      model: openrouterFollow.model,
      fallbackModels: [],
      thinking: thinkingResolution.thinking,
      independence: resolveIndependence(
        agent,
        openrouterFollow.model,
        currentProvider,
        currentModel,
      ),
      warning: thinkingResolution.warning,
    };
  }

  const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  let selectedModel: T | undefined =
    oppositeProviderModel ??
    (agent?.preferCurrentOpenaiModel
      ? (currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
        selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider))
      : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider));

  // When there is a thinking-only override and no bundled model matched, try the
  // current session model so the stored effort has something to attach to.
  let currentSessionThinkingResolution:
    | ReturnType<typeof resolveStoredSubagentThinking>
    | undefined;
  if (!selectedModel && override?.thinking !== undefined) {
    const currentSessionModel = findAvailableProviderModelReference(availableModels, currentModel);
    if (currentSessionModel) {
      currentSessionThinkingResolution = resolveStoredSubagentThinking(
        agent,
        currentSessionModel,
        override,
        false,
      );
      if (currentSessionThinkingResolution.thinking) {
        selectedModel = currentSessionModel;
      }
    } else {
      // Preserve a recognized effort value even when no registry-backed session
      // model is available; only invalid syntax produces a warning here.
      currentSessionThinkingResolution = resolveStoredSubagentThinking(
        agent,
        undefined,
        override,
        false,
      );
    }
  }

  const fallbackModel = oppositeProviderModel
    ? selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel)
    : undefined;
  const fallbackModels =
    fallbackModel &&
    (!selectedModel ||
      formatProviderModelReference(fallbackModel) !== formatProviderModelReference(selectedModel))
      ? [fallbackModel]
      : [];

  // For the pure bundled path (no override at all), use resolveThinkingForProvider
  // directly. Stored effort is forwarded unchanged; model capability metadata may
  // explain a warning but never filters the suffix before Pi.
  const resolveThinkingResult = (
    m: T | undefined,
    generatedFallback = false,
  ): ReturnType<typeof resolveStoredSubagentThinking> =>
    override === undefined
      ? { thinking: resolveThinkingForProvider(agent, m?.provider ?? currentProvider) }
      : resolveStoredSubagentThinking(agent, m, override, generatedFallback);

  const primaryThinkingResolution = selectedModel
    ? resolveThinkingResult(selectedModel)
    : (currentSessionThinkingResolution ?? {});

  const resolvedFallbackThinking = fallbackModels.map((m) => ({
    model: m,
    resolution: resolveThinkingResult(m, true),
  }));
  const resolvedFallbackModels = resolvedFallbackThinking.map(({ model: m, resolution }) => ({
    model: m,
    thinking: resolution.thinking,
  }));

  const fallbackWarning =
    override?.thinking !== undefined
      ? resolvedFallbackThinking.find((entry) => entry.resolution.warning)?.resolution.warning
      : undefined;

  return {
    model: selectedModel,
    fallbackModels: resolvedFallbackModels,
    modelFallbackNotice:
      resolvedFallbackModels.length > 0
        ? isOpenrouterProvider(currentProvider)
          ? OPENROUTER_OPPOSITE_FALLBACK_NOTICE
          : OPPOSITE_PROVIDER_FALLBACK_NOTICE
        : undefined,
    thinking: primaryThinkingResolution.thinking,
    independence: resolveIndependence(agent, selectedModel, currentProvider, currentModel),
    warning: primaryThinkingResolution.warning,
    fallbackWarning: !primaryThinkingResolution.warning ? fallbackWarning : undefined,
  };
}

function hasExplicitModel(target: Record<string, unknown>): boolean {
  return Object.hasOwn(target, "model") && target.model !== undefined;
}

function agentNameForTarget(target: Record<string, unknown>): string | undefined {
  return typeof target.agent === "string" ? target.agent : undefined;
}

function formatEffectiveModelAndThinking(
  model: ProviderModelReference | string | undefined,
  thinking: ThinkingLevel | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }
  if (typeof model === "string") {
    return applyThinkingSuffix(model, thinking);
  }
  return formatResolvedProviderModelReference(model, thinking);
}

function applyExplicitModelThinking(
  target: Record<string, unknown>,
  agent: AgentModelDefaults | undefined,
  agentName: string | undefined,
  availableModels: readonly ReasoningProviderModelReference[],
  override: TlhSubagentOverride | undefined,
  options: ApplyProviderAwareSubagentModelOptions,
): number {
  if (
    typeof target.model !== "string" ||
    splitKnownThinkingSuffix(target.model).thinkingSuffix ||
    override?.thinking === undefined
  ) {
    return 0;
  }

  const explicitModel = findAvailableProviderModel(availableModels, target.model);
  // An explicit model is caller-owned. If the registry cannot resolve it, do not
  // classify the target as a persisted unavailable pin; Pi validates the argument.
  const thinkingResolution = resolveStoredSubagentThinking(agent, explicitModel, override, false);
  if (thinkingResolution.warning && agentName) {
    options.onWarning?.({
      agent: agentName,
      message: thinkingResolution.warning,
      source: "stored",
    });
  }
  const modelWithThinking = applyThinkingSuffix(target.model, thinkingResolution.thinking);
  if (!modelWithThinking || modelWithThinking === target.model) {
    return 0;
  }
  target.model = modelWithThinking;
  return 1;
}

function applyBundledModelDefaults(
  target: Record<string, unknown>,
  agent: AgentModelDefaults | undefined,
  availableModels: readonly ReasoningProviderModelReference[],
  currentProvider: string | undefined,
  currentModel: ProviderModelReference | undefined,
): number {
  const defaults = selectProviderAwareAgentDefaults(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  const selectedModel = defaults.model ? formatProviderModelReference(defaults.model) : undefined;
  const isLegacyGenericModel = agent?.tlhModelDefaultsSource === "legacy";
  if (!selectedModel || (isLegacyGenericModel && selectedModel === agent?.model)) {
    return 0;
  }
  const thinking = defaults.thinking;
  target.model = thinking ? `${selectedModel}:${thinking}` : selectedModel;

  const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(
    agent,
    availableModels,
    currentProvider,
    currentModel,
  );
  if (oppositeProviderModel) {
    const fallbackModel = selectOppositeProviderFallbackModel(
      agent,
      availableModels,
      currentProvider,
      currentModel,
    );
    const fallbackModelBase = fallbackModel
      ? formatProviderModelReference(fallbackModel)
      : undefined;
    if (fallbackModelBase && fallbackModelBase !== selectedModel) {
      const fallbackThinking = resolveThinkingForProvider(agent, fallbackModel!.provider);
      const fallbackModelId = fallbackThinking
        ? `${fallbackModelBase}:${fallbackThinking}`
        : fallbackModelBase;
      if (!Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined) {
        (target as Record<PropertyKey, unknown>)[PROVIDER_AWARE_FALLBACK_MODELS] = [
          fallbackModelId,
        ];
      }
      if (
        !Object.hasOwn(target, "modelFallbackNotice") ||
        target.modelFallbackNotice === undefined
      ) {
        target.modelFallbackNotice = isOpenrouterProvider(currentProvider)
          ? OPENROUTER_OPPOSITE_FALLBACK_NOTICE
          : OPPOSITE_PROVIDER_FALLBACK_NOTICE;
      }
    }
  }
  return 1;
}

function applyModelToRunnableTarget(
  target: unknown,
  agents: ReadonlyMap<string, AgentModelDefaults>,
  availableModels: readonly ReasoningProviderModelReference[],
  currentProvider: string | undefined,
  currentModel: ProviderModelReference | undefined,
  options: ApplyProviderAwareSubagentModelOptions,
): number {
  if (!isRecord(target)) {
    return 0;
  }

  const agentName = agentNameForTarget(target);
  // Never let stored or bundled model policy mutate an embedded target, even
  // if a future caller bypasses the outer non-project dispatch filter.
  if (isEmbeddedSubagentTarget(agentName)) {
    return 0;
  }
  const agent = agentName ? agents.get(agentName) : undefined;
  const explicitModel = hasExplicitModel(target);
  const persistedOverride = agentName ? options.agentOverrides?.get(agentName) : undefined;

  // Only persisted per-role overrides are applied here.
  const override = persistedOverride;

  // Explicit dispatch: target already has a model set by the caller.
  if (explicitModel) {
    return applyExplicitModelThinking(target, agent, agentName, availableModels, override, options);
  }

  // No effective override — fast path preserving main's bundled-defaults behavior:
  // resolveThinkingForProvider's result is appended directly without stored-effort
  // normalization because no stored effort is being applied.
  if (override === undefined) {
    return applyBundledModelDefaults(target, agent, availableModels, currentProvider, currentModel);
  }

  // model:false with no thinking stored means "inherit session model, no changes".
  if (override.model === false && override.thinking === undefined) {
    return 0;
  }

  const resolution = resolveProviderAwareSubagentResolution(
    agent,
    availableModels,
    currentProvider,
    currentModel,
    override,
  );

  if (resolution.unavailableModel && agentName) {
    options.onWarning?.({
      agent: agentName,
      message: formatUnavailableStoredModelWarning(agentName, resolution.unavailableModel),
      source: "stored",
    });
  }
  if (resolution.warning && agentName) {
    options.onWarning?.({
      agent: agentName,
      message: resolution.warning,
      source: "stored",
    });
  }
  const usesGeneratedFallback =
    !Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined;
  if (usesGeneratedFallback && resolution.fallbackWarning && agentName) {
    options.onWarning?.({
      agent: agentName,
      message: resolution.fallbackWarning,
      source: "stored",
    });
  }

  const selectedModel = formatEffectiveModelAndThinking(
    resolution.unavailableModel ?? resolution.model,
    resolution.thinking,
  );
  if (
    !selectedModel ||
    (!resolution.unavailableModel &&
      agent?.tlhModelDefaultsSource === "legacy" &&
      selectedModel === agent?.model)
  ) {
    return 0;
  }

  target.model = selectedModel;

  const fallbackModels = resolution.fallbackModels
    ?.map((fb) => formatResolvedProviderModelReference(fb.model, fb.thinking))
    .filter((m): m is string => Boolean(m));

  if (fallbackModels?.length) {
    if (usesGeneratedFallback) {
      (target as Record<PropertyKey, unknown>)[PROVIDER_AWARE_FALLBACK_MODELS] = fallbackModels;
    }
    if (!Object.hasOwn(target, "modelFallbackNotice") || target.modelFallbackNotice === undefined) {
      target.modelFallbackNotice = resolution.modelFallbackNotice;
    }
  }

  return 1;
}

export function applyProviderAwareSubagentModels(
  input: unknown,
  agents: ReadonlyMap<string, AgentModelDefaults>,
  availableModels: readonly ReasoningProviderModelReference[],
  currentProvider?: string,
  currentModel?: ProviderModelReference,
  options: ApplyProviderAwareSubagentModelOptions = {},
): number {
  if (!isRecord(input)) {
    return 0;
  }

  let mutations = applyModelToRunnableTarget(
    input,
    agents,
    availableModels,
    currentProvider,
    currentModel,
    options,
  );

  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      mutations += applyModelToRunnableTarget(
        task,
        agents,
        availableModels,
        currentProvider,
        currentModel,
        options,
      );
    }
  }

  return mutations;
}
