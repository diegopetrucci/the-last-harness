import { THINKING_LEVELS } from "./constants.js";
import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import type { ReasoningModel, ThinkingLevel, TlhSubagentOverride } from "./types.js";

import { isRecord } from "./common.js";

export type ProviderModelReference = {
  provider: string;
  id: string;
};

export type AgentModelDefaults = {
  name: string;
  model?: string;
  tlhOpenaiModels?: string[];
  tlhAnthropicModels?: string[];
  thinking?: ThinkingLevel;
  tlhOpenaiThinking?: ThinkingLevel;
  tlhAnthropicThinking?: ThinkingLevel;
  tlhOpenrouterThinking?: ThinkingLevel;
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
  onWarning?: (warning: { agent: string; message: string }) => void;
};

type ReasoningProviderModelReference = ProviderModelReference & Partial<ReasoningModel>;

const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
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
 * Format a model reference with an optional thinking suffix.
 * Every level in THINKING_LEVELS (including `max`) is a valid model-string suffix:
 * the subagents runtime that consumes these strings parses the same list in
 * `extensions/subagents/src/shared/model-info.ts`. Model capability is gated
 * separately by `getAvailableThinkingLevels`.
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

function isOpenrouterProvider(provider: string | undefined): boolean {
  return Boolean(provider && OPENROUTER_PROVIDERS.has(provider));
}

type ProviderFamily = "openai" | "anthropic";

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
  if (isOpenrouterProvider(provider)) {
    const underlyingVendor = modelId?.split("/", 1)[0];
    if (underlyingVendor === "openai" || underlyingVendor === "anthropic") {
      return underlyingVendor;
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

function currentProviderOpenaiCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!isOpenaiProvider(currentProvider)) {
    return undefined;
  }
  const currentProviderCandidate = agent?.tlhOpenaiModels?.find(
    (candidate) => parseProviderModelReference(candidate)?.provider === currentProvider,
  );
  return availableOpenaiCandidate(availableModels, currentProviderCandidate);
}

function currentProviderAnthropicCandidate<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  if (!isAnthropicProvider(currentProvider)) {
    return undefined;
  }
  const currentProviderCandidate = agent?.tlhAnthropicModels?.find(
    (candidate) => parseProviderModelReference(candidate)?.provider === currentProvider,
  );
  return availableAnthropicCandidate(availableModels, currentProviderCandidate);
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
        ? ["openai", "anthropic"]
        : currentFamily === "openai"
          ? ["anthropic", "openai"]
          : ["openai", "anthropic"];
    for (const family of families) {
      const candidates = family === "openai" ? agent.tlhOpenaiModels : agent.tlhAnthropicModels;
      for (const candidate of candidates ?? []) {
        const model =
          family === "openai"
            ? availableOpenaiCandidate(availableModels, candidate)
            : availableAnthropicCandidate(availableModels, candidate);
        if (model) {
          return model;
        }
      }
    }
    return undefined;
  }

  if (isAnthropicProvider(currentProvider)) {
    for (const candidate of agent.tlhOpenaiModels ?? []) {
      const model = availableCodexCandidate(availableModels, candidate);
      if (model) {
        return model;
      }
    }
    return undefined;
  }

  if (isOpenaiProvider(currentProvider)) {
    for (const candidate of agent.tlhAnthropicModels ?? []) {
      const model = availableAnthropicCandidate(availableModels, candidate);
      if (model) {
        return model;
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
    currentProviderAnthropicCandidate(agent, availableModels, currentProvider)
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

  const defaultModel = findAvailableProviderModel(availableModels, agent.model);
  if (defaultModel) {
    return defaultModel;
  }

  const currentProviderModel =
    currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
    currentProviderAnthropicCandidate(agent, availableModels, currentProvider);
  if (currentProviderModel) {
    return currentProviderModel;
  }

  for (const candidate of agent.tlhOpenaiModels ?? []) {
    const model = availableOpenaiCandidate(availableModels, candidate);
    if (model) {
      return model;
    }
  }

  for (const candidate of agent.tlhAnthropicModels ?? []) {
    const model = availableAnthropicCandidate(availableModels, candidate);
    if (model) {
      return model;
    }
  }

  return undefined;
}

function selectProviderAwareAgentModel<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider?: string,
): T | undefined {
  return (
    selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider) ??
    selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
  );
}

/**
 * When the active provider is "openrouter" (literal string only), agents without
 * preferOppositeProvider follow the current session model instead of falling
 * through to bundled codex/anthropic candidates.
 *
 * Thinking comes exclusively from tlhOpenrouterThinking; the generic `thinking`
 * key does NOT leak through on this path. Returns undefined when the rule does
 * not apply (provider is not openrouter or agent prefers opposite provider).
 *
 * The current model is a session identity, not necessarily a registry entry. Keep
 * that identity separate from optional reasoning metadata: capability checks must
 * fail open when the registry omitted the active model.
 */
function resolveOpenrouterFollowDefaults<T extends ProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly T[],
  currentProvider: string | undefined,
  currentModel: ProviderModelReference | undefined,
): ProviderAwareAgentDefaults<T> | undefined {
  if (!isOpenrouterProvider(currentProvider) || agent?.preferOppositeProvider) {
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
  // Explicitly use tlhOpenrouterThinking only — do not fall through to agent.thinking.
  return { model: followedModel, thinking: agent?.tlhOpenrouterThinking };
}

/**
 * Resolve the bundled thinking level for the given agent and provider.
 * Checks provider-specific overrides (`tlhOpenaiThinking`, `tlhAnthropicThinking`)
 * before falling back to the generic `thinking` field.
 */
export function resolveProviderThinking(
  agent: AgentModelDefaults | undefined,
  provider: string | undefined,
): ThinkingLevel | undefined {
  if (!agent) return undefined;
  if (isOpenaiProvider(provider) && agent.tlhOpenaiThinking) {
    return agent.tlhOpenaiThinking;
  }
  if (isAnthropicProvider(provider) && agent.tlhAnthropicThinking) {
    return agent.tlhAnthropicThinking;
  }
  if (isOpenrouterProvider(provider)) {
    return agent.tlhOpenrouterThinking;
  }
  return agent.thinking;
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

export function selectProviderAwareAgentModelId(
  agent: AgentModelDefaults | undefined,
  availableModels: readonly ProviderModelReference[],
  currentProvider?: string,
): string | undefined {
  const model = selectProviderAwareAgentModel(agent, availableModels, currentProvider);
  return model ? formatProviderModelReference(model) : undefined;
}

/**
 * Resolve the effective thinking level when a stored subagent override may be present.
 *
 * - If `override.thinking` is a valid ThinkingLevel, validate it against the model's
 *   supported levels and return it (or a neutralizing supported suffix on failure).
 * - If `override.thinking` is `false`, map it to `"off"`.
 * - If `override.thinking` is absent (model-only override), compute the bundled level
 *   via `resolveThinkingForProvider` and validate against the model.
 *   - Supported by the model → `{ thinking }`.
 *   - Unsupported → fall back to `"off"` when the model supports it, else `{}`.
 *
 * A stored effort is consumed independently by the subagents runtime. When it is
 * unsupported, an explicit bundled or `off` suffix keeps that runtime from applying
 * the raw stored value a second time and pins the intended TLH effort. If neither
 * suffix is supported, the bare model is retained and the runtime drops a known-
 * unsupported value (while failing open when the model cannot be resolved).
 *
 * This function must only be called when an `override` is present (`override !== undefined`).
 * For the pure no-override path use `resolveThinkingForProvider` directly.
 */
function formatStoredThinkingWarning<T extends ReasoningProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  model: T,
  rawThinking: string | false,
  neutralizingThinking: ThinkingLevel | undefined,
  generatedFallback: boolean,
): string {
  const storedThinking = rawThinking === false ? "off" : String(rawThinking);
  const modelLabel = `${generatedFallback ? "generated fallback " : ""}${formatProviderModelReference(model)}`;
  const standardStoredThinking =
    rawThinking === false || (typeof rawThinking === "string" && isThinkingLevel(rawThinking));
  const subject = standardStoredThinking
    ? `TLH stored minor-agent effort "${storedThinking}" is not supported by ${modelLabel}`
    : `TLH ignored unsupported stored minor-agent effort "${storedThinking}" for ${generatedFallback ? modelLabel : (agent?.name ?? "this subagent")}`;
  if (neutralizingThinking === undefined) {
    const residual =
      rawThinking === false
        ? "no supported neutralizer is available, so the runtime's default effort behavior will be used for this run"
        : "no supported suffix can neutralize it, so the subagents runtime will drop the stored value for this run";
    return `${subject}; ${residual}.`;
  }
  if (neutralizingThinking === "off") {
    const action = generatedFallback
      ? "that fallback will use explicit off for this run"
      : "using explicit off for this run";
    return `${subject}; ${action}.`;
  }
  const action = generatedFallback
    ? "that fallback will use bundled defaults for this run"
    : "using bundled defaults for this run";
  return `${subject}; ${action}.`;
}

function formatUnresolvedStoredThinkingWarning(
  agent: AgentModelDefaults | undefined,
  rawThinking: string,
): string {
  return `TLH ignored unsupported stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"}; no supported model suffix could be emitted, so the subagents runtime will drop the value for a known model and fail open for an unknown model if this role is dispatched.`;
}

function formatUnresolvedStoredThinkingCapabilityWarning(
  agent: AgentModelDefaults | undefined,
  rawThinking: string,
): string {
  return `TLH stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"} could not be capability-checked because no bundled or current-session model is available; the subagents runtime will apply its capability gate if the model resolves and fail open otherwise.`;
}

function resolveStoredSubagentThinking<T extends ReasoningProviderModelReference>(
  agent: AgentModelDefaults | undefined,
  model: T | undefined,
  override: TlhSubagentOverride | undefined,
  generatedFallback = false,
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
    if (!bundledThinking) {
      return {};
    }
    if (!model) {
      return { thinking: bundledThinking };
    }
    // Identity without reasoning metadata means capability is unknown (the
    // registry omitted this active model), not explicitly non-reasoning.
    if (!Object.hasOwn(model, "reasoning")) {
      return { thinking: bundledThinking };
    }
    const supportedLevels = getAvailableThinkingLevels(model);
    if (supportedLevels.includes(bundledThinking)) {
      return { thinking: bundledThinking };
    }
    return supportedLevels.includes("off") ? { thinking: "off" } : {};
  }

  if (!model) {
    if (requestedThinking !== undefined) {
      return { thinking: requestedThinking };
    }
    return {
      warning: formatUnresolvedStoredThinkingWarning(agent, String(rawThinking)),
    };
  }

  // Fail open for a valid stored effort when the active model's capability is
  // unknown; absent `reasoning` must not be interpreted as `off`.
  if (!Object.hasOwn(model, "reasoning")) {
    return requestedThinking !== undefined ? { thinking: requestedThinking } : {};
  }

  const supportedLevels = getAvailableThinkingLevels(model);
  if (requestedThinking !== undefined && supportedLevels.includes(requestedThinking)) {
    return { thinking: requestedThinking };
  }

  // Prefer a recognized suffix when the model supports one: this pins the intended
  // bundled effort instead of merely letting the runtime drop to model default.
  // The runtime capability gate remains the fallback when neither suffix is supported.
  const neutralizingThinking =
    bundledThinking && supportedLevels.includes(bundledThinking)
      ? bundledThinking
      : supportedLevels.includes("off")
        ? "off"
        : undefined;
  return {
    thinking: neutralizingThinking,
    warning: formatStoredThinkingWarning(
      agent,
      model,
      rawThinking,
      neutralizingThinking,
      generatedFallback,
    ),
  };
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
  return `TLH saved minor-agent model override "${model}" for ${roleLabel} is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults.${action}`;
}

/**
 * Resolve the full provider-aware model and thinking for a subagent, incorporating
 * any stored per-agent override from settings.
 *
 * Precedence (highest to lowest):
 *  1. Stored model pin (available)  → use it; resolve thinking from stored or bundled
 *  2. Stored model pin (unavailable) → forward pin unchanged, independence from parsed provider
 *  3. Stored model: false            → inherit the current session model; apply stored thinking
 *  4. No stored model                → bundled provider-aware defaults
 *
 * When `override` is `undefined`, bundled defaults use `resolveThinkingForProvider`
 * directly without model-capability gating (preserving the runtime's authority to
 * apply the level even on models that do not advertise it).
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
    const thinkingResolution = resolveStoredSubagentThinking(agent, overrideModel, override);
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
    const thinkingResolution = resolveStoredSubagentThinking(agent, undefined, override);
    return {
      unavailableModel: override.model,
      independence: resolveIndependence(agent, parsedOverrideModel, currentProvider, currentModel),
      warning: thinkingResolution.warning,
    };
  }

  // 3. Stored model: false → inherit current session model
  if (override?.model === false) {
    const inheritedModel = findAvailableProviderModelReference(availableModels, currentModel);
    const thinkingResolution = resolveStoredSubagentThinking(agent, inheritedModel, override);
    return {
      model: inheritedModel,
      thinking: thinkingResolution.thinking,
      independence: resolveIndependence(agent, inheritedModel, currentProvider, currentModel),
      warning: thinkingResolution.warning,
    };
  }

  // 4. No stored model override — use bundled provider-aware defaults.

  // OpenRouter follow rule (non-opposite-role agents only): follow the session model.
  // Thinking-only overrides are capability-gated; the pure no-override path uses
  // tlhOpenrouterThinking exclusively — the generic thinking key does not leak.
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
        : resolveStoredSubagentThinking(agent, openrouterFollow.model, override);
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
      );
      if (currentSessionThinkingResolution.thinking) {
        selectedModel = currentSessionModel;
      }
    } else if (typeof override.thinking === "string" && override.thinking !== "off") {
      currentSessionThinkingResolution = {
        warning: formatUnresolvedStoredThinkingCapabilityWarning(agent, override.thinking),
      };
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
  // directly without model-capability gating, preserving main's existing behavior:
  // a bundled level is passed through regardless of the model's advertised
  // reasoning levels. Stored overrides are capability-gated instead, so an
  // unsupported saved effort warns rather than being silently forwarded.
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
    return model;
  }
  return formatResolvedProviderModelReference(model, thinking);
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
  const agent = agentName ? agents.get(agentName) : undefined;
  const override = agentName ? options.agentOverrides?.get(agentName) : undefined;

  // Explicit dispatch: target already has a model set by the caller.
  if (hasExplicitModel(target)) {
    // If the model already carries a known thinking suffix, or there is no
    // stored thinking preference, leave it untouched.
    if (
      typeof target.model !== "string" ||
      splitKnownThinkingSuffix(target.model).thinkingSuffix ||
      override?.thinking === undefined
    ) {
      return 0;
    }
    // Explicit model without suffix + stored thinking preference → append suffix.
    const explicitModel = findAvailableProviderModel(availableModels, target.model);
    const thinkingResolution = resolveStoredSubagentThinking(agent, explicitModel, override);
    if (thinkingResolution.warning && agentName) {
      options.onWarning?.({ agent: agentName, message: thinkingResolution.warning });
    }
    const modelWithThinking = applyThinkingSuffix(target.model, thinkingResolution.thinking);
    if (!modelWithThinking || modelWithThinking === target.model) {
      return 0;
    }
    target.model = modelWithThinking;
    return 1;
  }

  // No stored override — fast path preserving main's bundled-defaults behavior:
  // resolveThinkingForProvider's result is appended directly without
  // model-capability gating.
  if (override === undefined) {
    const defaults = selectProviderAwareAgentDefaults(
      agent,
      availableModels,
      currentProvider,
      currentModel,
    );
    const selectedModel = defaults.model ? formatProviderModelReference(defaults.model) : undefined;
    if (!selectedModel || selectedModel === agent?.model) {
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
          target.fallbackModels = [fallbackModelId];
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
    });
  }
  if (resolution.warning && agentName) {
    options.onWarning?.({ agent: agentName, message: resolution.warning });
  }
  const usesGeneratedFallback =
    !Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined;
  if (usesGeneratedFallback && resolution.fallbackWarning && agentName) {
    options.onWarning?.({ agent: agentName, message: resolution.fallbackWarning });
  }

  const selectedModel = formatEffectiveModelAndThinking(
    resolution.unavailableModel ?? resolution.model,
    resolution.unavailableModel ? undefined : resolution.thinking,
  );
  if (!selectedModel || (!resolution.unavailableModel && selectedModel === agent?.model)) {
    return 0;
  }

  target.model = selectedModel;

  const fallbackModels = resolution.fallbackModels
    ?.map((fb) => formatResolvedProviderModelReference(fb.model, fb.thinking))
    .filter((m): m is string => Boolean(m));

  if (fallbackModels?.length) {
    if (usesGeneratedFallback) {
      target.fallbackModels = fallbackModels;
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
