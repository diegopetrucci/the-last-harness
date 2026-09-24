import { THINKING_LEVELS } from "./constants.js";
import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import { isRecord } from "./common.js";
import { isEmbeddedSubagentTarget, PROVIDER_AWARE_FALLBACK_MODELS, } from "../the-last-harness-subagent-safety.mjs";
const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
const XAI_PROVIDERS = new Set(["xai"]);
const OPENROUTER_PROVIDERS = new Set(["openrouter"]);
const OPPOSITE_PROVIDER_FALLBACK_NOTICE = "TLH fell back to a same-provider review model; review independence is reduced.";
const OPENROUTER_OPPOSITE_FALLBACK_NOTICE = "TLH fell back to the session model; review independence is reduced.";
export function parseProviderModelReference(model) {
    const slash = model?.indexOf("/") ?? -1;
    if (!model || slash <= 0 || slash === model.length - 1) {
        return undefined;
    }
    return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}
export function formatProviderModelReference(model) {
    return `${model.provider}/${model.id}`;
}
export function listAgentModelDefaultReferences(agent) {
    const seen = new Set();
    const references = [];
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
function agentModelsForProvider(agent, provider) {
    if (!provider) {
        return [];
    }
    return listAgentModelDefaultReferences(agent).filter((model) => model.provider === provider);
}
function agentModelsForFamily(agent, family) {
    return listAgentModelDefaultReferences(agent).filter((model) => family === "openai"
        ? isOpenaiProvider(model.provider)
        : family === "anthropic"
            ? isAnthropicProvider(model.provider)
            : isXaiProvider(model.provider));
}
export function formatResolvedProviderModelReference(model, thinking) {
    if (!thinking || !THINKING_LEVELS.includes(thinking)) {
        return formatProviderModelReference(model);
    }
    return `${formatProviderModelReference(model)}:${thinking}`;
}
export function splitKnownThinkingSuffix(model) {
    if (!model) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    const colon = model.lastIndexOf(":");
    if (colon === -1) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    const suffix = model.slice(colon + 1);
    if (!THINKING_LEVELS.includes(suffix)) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    return { baseModel: model.slice(0, colon), thinkingSuffix: `:${suffix}` };
}
function applyThinkingSuffix(model, thinking) {
    if (!model || !thinking) {
        return model;
    }
    if (!THINKING_LEVELS.includes(thinking)) {
        return model;
    }
    const { thinkingSuffix } = splitKnownThinkingSuffix(model);
    return thinkingSuffix ? model : `${model}:${thinking}`;
}
function isOpenaiProvider(provider) {
    return Boolean(provider && OPENAI_PROVIDERS.has(provider));
}
function isAnthropicProvider(provider) {
    return Boolean(provider && ANTHROPIC_PROVIDERS.has(provider));
}
function isXaiProvider(provider) {
    return Boolean(provider && XAI_PROVIDERS.has(provider));
}
function isOpenrouterProvider(provider) {
    return Boolean(provider && OPENROUTER_PROVIDERS.has(provider));
}
export function followsOpenrouterSession(agent, provider) {
    return isOpenrouterProvider(provider) && !agent?.preferOppositeProvider;
}
function providerFamily(provider, modelId) {
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
export function findAvailableProviderModel(availableModels, model) {
    if (typeof model !== "string") {
        return undefined;
    }
    const exactParsed = parseProviderModelReference(model);
    const exactMatch = findAvailableProviderModelReference(availableModels, exactParsed);
    if (exactMatch) {
        return exactMatch;
    }
    const baseParsed = parseProviderModelReference(splitKnownThinkingSuffix(model).baseModel);
    return findAvailableProviderModelReference(availableModels, baseParsed);
}
function findAvailableProviderModelReference(availableModels, model) {
    if (!model) {
        return undefined;
    }
    return availableModels.find((entry) => entry.provider === model.provider && entry.id === model.id);
}
function availableOpenaiCandidate(availableModels, candidate) {
    const parsed = parseProviderModelReference(candidate);
    if (!parsed || !isOpenaiProvider(parsed.provider)) {
        return undefined;
    }
    return findAvailableProviderModel(availableModels, candidate);
}
function availableCodexCandidate(availableModels, candidate) {
    const parsed = parseProviderModelReference(candidate);
    if (!parsed || parsed.provider !== "openai-codex") {
        return undefined;
    }
    return findAvailableProviderModel(availableModels, candidate);
}
function availableAnthropicCandidate(availableModels, candidate) {
    const parsed = parseProviderModelReference(candidate);
    if (!parsed || !isAnthropicProvider(parsed.provider)) {
        return undefined;
    }
    return findAvailableProviderModel(availableModels, candidate);
}
function availableXaiCandidate(availableModels, candidate) {
    const parsed = parseProviderModelReference(candidate);
    if (!parsed || !isXaiProvider(parsed.provider)) {
        return undefined;
    }
    return findAvailableProviderModel(availableModels, candidate);
}
function currentProviderOpenaiCandidate(agent, availableModels, currentProvider) {
    if (!isOpenaiProvider(currentProvider)) {
        return undefined;
    }
    const currentProviderCandidate = agentModelsForProvider(agent, currentProvider).find((candidate) => candidate.provider === currentProvider);
    return availableOpenaiCandidate(availableModels, currentProviderCandidate ? formatProviderModelReference(currentProviderCandidate) : undefined);
}
function currentProviderAnthropicCandidate(agent, availableModels, currentProvider) {
    if (!isAnthropicProvider(currentProvider)) {
        return undefined;
    }
    const currentProviderCandidate = agentModelsForProvider(agent, currentProvider).find((candidate) => candidate.provider === currentProvider);
    return availableAnthropicCandidate(availableModels, currentProviderCandidate ? formatProviderModelReference(currentProviderCandidate) : undefined);
}
function currentProviderXaiCandidate(agent, availableModels, currentProvider) {
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
function currentProviderCustomCandidate(agent, availableModels, currentProvider) {
    if (agent?.tlhModelDefaultsSource !== "frontmatter" ||
        agent?.preferOppositeProvider ||
        !currentProvider ||
        isOpenaiProvider(currentProvider) ||
        isAnthropicProvider(currentProvider) ||
        isXaiProvider(currentProvider) ||
        isOpenrouterProvider(currentProvider)) {
        return undefined;
    }
    for (const candidate of agentModelsForProvider(agent, currentProvider)) {
        const model = findAvailableProviderModel(availableModels, formatProviderModelReference(candidate));
        if (model) {
            return model;
        }
    }
    return undefined;
}
function selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider, currentModel) {
    if (!agent?.preferOppositeProvider) {
        return undefined;
    }
    if (isOpenrouterProvider(currentProvider)) {
        const currentFamily = providerFamily(currentProvider, currentModel?.id);
        const families = currentFamily === "anthropic"
            ? ["openai", "xai", "anthropic"]
            : currentFamily === "openai"
                ? ["anthropic", "xai", "openai"]
                : currentFamily === "xai"
                    ? ["anthropic", "openai", "xai"]
                    : ["openai", "anthropic", "xai"];
        for (const family of families) {
            const candidates = agentModelsForFamily(agent, family);
            for (const candidate of candidates) {
                const model = family === "openai"
                    ? availableOpenaiCandidate(availableModels, formatProviderModelReference(candidate))
                    : family === "anthropic"
                        ? availableAnthropicCandidate(availableModels, formatProviderModelReference(candidate))
                        : availableXaiCandidate(availableModels, formatProviderModelReference(candidate));
                if (model) {
                    return model;
                }
            }
        }
        return undefined;
    }
    if (isAnthropicProvider(currentProvider)) {
        for (const family of ["openai", "xai"]) {
            for (const candidate of agentModelsForFamily(agent, family)) {
                const model = family === "openai"
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
        for (const family of ["anthropic", "xai"]) {
            for (const candidate of agentModelsForFamily(agent, family)) {
                const model = family === "anthropic"
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
        for (const family of ["anthropic", "openai"]) {
            for (const candidate of agentModelsForFamily(agent, family)) {
                const model = family === "anthropic"
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
function selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel) {
    if (!agent?.preferOppositeProvider) {
        return undefined;
    }
    if (isOpenrouterProvider(currentProvider) && currentModel?.provider === currentProvider) {
        return (findAvailableProviderModelReference(availableModels, currentModel) ?? currentModel);
    }
    if (currentModel?.provider === currentProvider) {
        const availableCurrentModel = findAvailableProviderModelReference(availableModels, currentModel);
        if (availableCurrentModel) {
            return availableCurrentModel;
        }
    }
    return (currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
        currentProviderAnthropicCandidate(agent, availableModels, currentProvider) ??
        currentProviderXaiCandidate(agent, availableModels, currentProvider));
}
function selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider) {
    if (!agent) {
        return undefined;
    }
    const defaultModel = findAvailableProviderModelReference(availableModels, agent.preferredModel) ??
        (agent.tlhModelDefaultsSource === "legacy"
            ? findAvailableProviderModel(availableModels, agent.model)
            : undefined);
    if (defaultModel) {
        return defaultModel;
    }
    const currentProviderModel = currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
        currentProviderAnthropicCandidate(agent, availableModels, currentProvider) ??
        currentProviderXaiCandidate(agent, availableModels, currentProvider) ??
        currentProviderCustomCandidate(agent, availableModels, currentProvider);
    if (currentProviderModel) {
        return currentProviderModel;
    }
    for (const candidate of agentModelsForFamily(agent, "openai")) {
        const model = availableOpenaiCandidate(availableModels, formatProviderModelReference(candidate));
        if (model) {
            return model;
        }
    }
    for (const candidate of agentModelsForFamily(agent, "anthropic")) {
        const model = availableAnthropicCandidate(availableModels, formatProviderModelReference(candidate));
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
function resolveOpenrouterFollowDefaults(agent, availableModels, currentProvider, currentModel) {
    if (!followsOpenrouterSession(agent, currentProvider)) {
        return undefined;
    }
    const followedModel = findAvailableProviderModelReference(availableModels, currentModel) ??
        (currentModel ? currentModel : undefined);
    if (!followedModel) {
        return undefined;
    }
    return { model: followedModel, thinking: resolveProviderThinking(agent, "openrouter") };
}
export function resolveProviderThinking(agent, provider) {
    if (!agent)
        return undefined;
    const providerEntry = agent.tlhModelDefaults?.find((entry) => entry.provider === provider);
    if (providerEntry) {
        return providerEntry.effort;
    }
    if (isOpenaiProvider(provider)) {
        const openaiEntry = agent.tlhModelDefaults?.find((entry) => isOpenaiProvider(entry.provider));
        if (openaiEntry) {
            return openaiEntry.effort;
        }
    }
    if (isOpenrouterProvider(provider)) {
        return undefined;
    }
    return agent.tlhModelDefaultsSource === "legacy" ? agent.thinking : undefined;
}
function resolveThinkingForProvider(agent, provider) {
    return resolveProviderThinking(agent, provider);
}
export function selectProviderAwareAgentDefaults(agent, availableModels, currentProvider, currentModel) {
    const openrouterFollow = resolveOpenrouterFollowDefaults(agent, availableModels, currentProvider, currentModel);
    if (openrouterFollow) {
        return openrouterFollow;
    }
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider, currentModel);
    const standardModel = agent?.preferCurrentOpenaiModel
        ? (currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
            selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider))
        : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
    const model = oppositeProviderModel ?? standardModel;
    const thinking = resolveProviderThinking(agent, model?.provider ?? currentProvider);
    return { model, thinking };
}
function formatInvalidStoredThinkingWarning(agent, rawThinking) {
    const roleLabel = agent?.name ?? "this subagent";
    const value = String(rawThinking);
    const validLevels = "off, minimal, low, medium, high, xhigh, max";
    return `TLH ignored invalid stored minor-agent effort "${value}" for ${roleLabel}; expected one of ${validLevels}, so no effort suffix was applied.`;
}
function formatKnownUnsupportedThinkingWarning(agent, model, rawThinking, generatedFallback) {
    const effort = rawThinking === false ? "off" : String(rawThinking);
    const modelLabel = `${generatedFallback ? "generated fallback " : ""}${formatProviderModelReference(model)}`;
    return `TLH stored minor-agent effort "${effort}" is not advertised by ${modelLabel}; the :${effort} suffix is forwarded and Pi will validate it.`;
}
function formatUnavailableStoredThinkingWarning(agent, rawThinking, unresolvedModelReference) {
    const roleLabel = agent?.name ?? "this subagent";
    const effort = rawThinking === false ? "off" : String(rawThinking);
    return `TLH stored minor-agent effort "${effort}" had unavailable capability metadata for saved model "${unresolvedModelReference}"; the :${effort} suffix is forwarded and Pi will validate it for ${roleLabel}.`;
}
function resolveStoredSubagentThinking(agent, model, override, generatedFallback = false, unresolvedModelReference) {
    const rawThinking = override?.thinking;
    const bundledThinking = resolveThinkingForProvider(agent, model?.provider);
    const requestedThinking = rawThinking === false
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
                warning: formatUnavailableStoredThinkingWarning(agent, rawThinking, unresolvedModelReference),
            }
            : { thinking: requestedThinking };
    }
    if (Object.hasOwn(model, "reasoning") &&
        !getAvailableThinkingLevels(model).includes(requestedThinking)) {
        return {
            thinking: requestedThinking,
            warning: formatKnownUnsupportedThinkingWarning(agent, model, rawThinking, generatedFallback),
        };
    }
    return { thinking: requestedThinking };
}
function resolveIndependence(agent, model, currentProvider, currentModel) {
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
export function formatUnavailableStoredModelWarning(agentName, model) {
    const roleLabel = agentName ?? "this minor-agent role";
    const action = ` Update it with /subagent-settings set ${roleLabel} model <provider/id> or clear it with /subagent-settings reset ${roleLabel} model.`;
    return `TLH saved minor-agent model override "${model}" is not in the available registry for ${roleLabel}; forwarding the model argument to Pi for validation instead of swapping in bundled defaults.${action}`;
}
export function resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override) {
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
    if (typeof override?.model === "string") {
        const parsedOverrideModel = parseProviderModelReference(splitKnownThinkingSuffix(override.model).baseModel);
        const thinkingResolution = resolveStoredSubagentThinking(agent, undefined, override, false, override.model);
        return {
            unavailableModel: override.model,
            thinking: thinkingResolution.thinking,
            independence: resolveIndependence(agent, parsedOverrideModel, currentProvider, currentModel),
            warning: thinkingResolution.warning,
        };
    }
    if (override?.model === false) {
        const inheritedModel = findAvailableProviderModelReference(availableModels, currentModel);
        const thinkingResolution = resolveStoredSubagentThinking(agent, inheritedModel, override, false);
        return {
            model: inheritedModel,
            thinking: thinkingResolution.thinking,
            independence: resolveIndependence(agent, inheritedModel, currentProvider, currentModel),
            warning: thinkingResolution.warning,
        };
    }
    const openrouterFollow = resolveOpenrouterFollowDefaults(agent, availableModels, currentProvider, currentModel);
    if (openrouterFollow?.model) {
        const thinkingResolution = override === undefined
            ? { thinking: openrouterFollow.thinking }
            : resolveStoredSubagentThinking(agent, openrouterFollow.model, override, false);
        return {
            model: openrouterFollow.model,
            fallbackModels: [],
            thinking: thinkingResolution.thinking,
            independence: resolveIndependence(agent, openrouterFollow.model, currentProvider, currentModel),
            warning: thinkingResolution.warning,
        };
    }
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider, currentModel);
    let selectedModel = oppositeProviderModel ??
        (agent?.preferCurrentOpenaiModel
            ? (currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
                selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider))
            : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider));
    let currentSessionThinkingResolution;
    if (!selectedModel && override?.thinking !== undefined) {
        const currentSessionModel = findAvailableProviderModelReference(availableModels, currentModel);
        if (currentSessionModel) {
            currentSessionThinkingResolution = resolveStoredSubagentThinking(agent, currentSessionModel, override, false);
            if (currentSessionThinkingResolution.thinking) {
                selectedModel = currentSessionModel;
            }
        }
        else {
            currentSessionThinkingResolution = resolveStoredSubagentThinking(agent, undefined, override, false);
        }
    }
    const fallbackModel = oppositeProviderModel
        ? selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel)
        : undefined;
    const fallbackModels = fallbackModel &&
        (!selectedModel ||
            formatProviderModelReference(fallbackModel) !== formatProviderModelReference(selectedModel))
        ? [fallbackModel]
        : [];
    const resolveThinkingResult = (m, generatedFallback = false) => override === undefined
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
    const fallbackWarning = override?.thinking !== undefined
        ? resolvedFallbackThinking.find((entry) => entry.resolution.warning)?.resolution.warning
        : undefined;
    return {
        model: selectedModel,
        fallbackModels: resolvedFallbackModels,
        modelFallbackNotice: resolvedFallbackModels.length > 0
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
function hasExplicitModel(target) {
    return Object.hasOwn(target, "model") && target.model !== undefined;
}
function agentNameForTarget(target) {
    return typeof target.agent === "string" ? target.agent : undefined;
}
function formatEffectiveModelAndThinking(model, thinking) {
    if (!model) {
        return undefined;
    }
    if (typeof model === "string") {
        return applyThinkingSuffix(model, thinking);
    }
    return formatResolvedProviderModelReference(model, thinking);
}
function applyExplicitModelThinking(target, agent, agentName, availableModels, override, options) {
    if (typeof target.model !== "string" ||
        splitKnownThinkingSuffix(target.model).thinkingSuffix ||
        override?.thinking === undefined) {
        return 0;
    }
    const explicitModel = findAvailableProviderModel(availableModels, target.model);
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
function applyBundledModelDefaults(target, agent, availableModels, currentProvider, currentModel) {
    const defaults = selectProviderAwareAgentDefaults(agent, availableModels, currentProvider, currentModel);
    const selectedModel = defaults.model ? formatProviderModelReference(defaults.model) : undefined;
    const isLegacyGenericModel = agent?.tlhModelDefaultsSource === "legacy";
    if (!selectedModel || (isLegacyGenericModel && selectedModel === agent?.model)) {
        return 0;
    }
    const thinking = defaults.thinking;
    target.model = thinking ? `${selectedModel}:${thinking}` : selectedModel;
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider, currentModel);
    if (oppositeProviderModel) {
        const fallbackModel = selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel);
        const fallbackModelBase = fallbackModel
            ? formatProviderModelReference(fallbackModel)
            : undefined;
        if (fallbackModelBase && fallbackModelBase !== selectedModel) {
            const fallbackThinking = resolveThinkingForProvider(agent, fallbackModel.provider);
            const fallbackModelId = fallbackThinking
                ? `${fallbackModelBase}:${fallbackThinking}`
                : fallbackModelBase;
            if (!Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined) {
                target[PROVIDER_AWARE_FALLBACK_MODELS] = [
                    fallbackModelId,
                ];
            }
            if (!Object.hasOwn(target, "modelFallbackNotice") ||
                target.modelFallbackNotice === undefined) {
                target.modelFallbackNotice = isOpenrouterProvider(currentProvider)
                    ? OPENROUTER_OPPOSITE_FALLBACK_NOTICE
                    : OPPOSITE_PROVIDER_FALLBACK_NOTICE;
            }
        }
    }
    return 1;
}
function applyModelToRunnableTarget(target, agents, availableModels, currentProvider, currentModel, options) {
    if (!isRecord(target)) {
        return 0;
    }
    const agentName = agentNameForTarget(target);
    if (isEmbeddedSubagentTarget(agentName)) {
        return 0;
    }
    const agent = agentName ? agents.get(agentName) : undefined;
    const explicitModel = hasExplicitModel(target);
    const persistedOverride = agentName ? options.agentOverrides?.get(agentName) : undefined;
    const override = persistedOverride;
    if (explicitModel) {
        return applyExplicitModelThinking(target, agent, agentName, availableModels, override, options);
    }
    if (override === undefined) {
        return applyBundledModelDefaults(target, agent, availableModels, currentProvider, currentModel);
    }
    if (override.model === false && override.thinking === undefined) {
        return 0;
    }
    const resolution = resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override);
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
    const usesGeneratedFallback = !Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined;
    if (usesGeneratedFallback && resolution.fallbackWarning && agentName) {
        options.onWarning?.({
            agent: agentName,
            message: resolution.fallbackWarning,
            source: "stored",
        });
    }
    const selectedModel = formatEffectiveModelAndThinking(resolution.unavailableModel ?? resolution.model, resolution.thinking);
    if (!selectedModel ||
        (!resolution.unavailableModel &&
            agent?.tlhModelDefaultsSource === "legacy" &&
            selectedModel === agent?.model)) {
        return 0;
    }
    target.model = selectedModel;
    const fallbackModels = resolution.fallbackModels
        ?.map((fb) => formatResolvedProviderModelReference(fb.model, fb.thinking))
        .filter((m) => Boolean(m));
    if (fallbackModels?.length) {
        if (usesGeneratedFallback) {
            target[PROVIDER_AWARE_FALLBACK_MODELS] = fallbackModels;
        }
        if (!Object.hasOwn(target, "modelFallbackNotice") || target.modelFallbackNotice === undefined) {
            target.modelFallbackNotice = resolution.modelFallbackNotice;
        }
    }
    return 1;
}
export function applyProviderAwareSubagentModels(input, agents, availableModels, currentProvider, currentModel, options = {}) {
    if (!isRecord(input)) {
        return 0;
    }
    let mutations = applyModelToRunnableTarget(input, agents, availableModels, currentProvider, currentModel, options);
    if (Array.isArray(input.tasks)) {
        for (const task of input.tasks) {
            mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel, options);
        }
    }
    return mutations;
}
