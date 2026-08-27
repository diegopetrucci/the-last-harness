import { THINKING_LEVELS } from "./constants.js";
import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import { isRecord } from "./common.js";
const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
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
    if (isOpenrouterProvider(provider)) {
        const underlyingVendor = modelId?.split("/", 1)[0];
        if (underlyingVendor === "openai" || underlyingVendor === "anthropic") {
            return underlyingVendor;
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
function currentProviderOpenaiCandidate(agent, availableModels, currentProvider) {
    if (!isOpenaiProvider(currentProvider)) {
        return undefined;
    }
    const currentProviderCandidate = agent?.tlhOpenaiModels?.find((candidate) => parseProviderModelReference(candidate)?.provider === currentProvider);
    return availableOpenaiCandidate(availableModels, currentProviderCandidate);
}
function currentProviderAnthropicCandidate(agent, availableModels, currentProvider) {
    if (!isAnthropicProvider(currentProvider)) {
        return undefined;
    }
    const currentProviderCandidate = agent?.tlhAnthropicModels?.find((candidate) => parseProviderModelReference(candidate)?.provider === currentProvider);
    return availableAnthropicCandidate(availableModels, currentProviderCandidate);
}
function selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider, currentModel) {
    if (!agent?.preferOppositeProvider) {
        return undefined;
    }
    if (isOpenrouterProvider(currentProvider)) {
        const currentFamily = providerFamily(currentProvider, currentModel?.id);
        const families = currentFamily === "anthropic"
            ? ["openai", "anthropic"]
            : currentFamily === "openai"
                ? ["anthropic", "openai"]
                : ["openai", "anthropic"];
        for (const family of families) {
            const candidates = family === "openai" ? agent.tlhOpenaiModels : agent.tlhAnthropicModels;
            for (const candidate of candidates ?? []) {
                const model = family === "openai"
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
        currentProviderAnthropicCandidate(agent, availableModels, currentProvider));
}
function selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider) {
    if (!agent) {
        return undefined;
    }
    const defaultModel = findAvailableProviderModel(availableModels, agent.model);
    if (defaultModel) {
        return defaultModel;
    }
    const currentProviderModel = currentProviderOpenaiCandidate(agent, availableModels, currentProvider) ??
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
function resolveOpenrouterFollowDefaults(agent, availableModels, currentProvider, currentModel) {
    if (!followsOpenrouterSession(agent, currentProvider)) {
        return undefined;
    }
    const followedModel = findAvailableProviderModelReference(availableModels, currentModel) ??
        (currentModel ? currentModel : undefined);
    if (!followedModel) {
        return undefined;
    }
    return { model: followedModel, thinking: agent?.tlhOpenrouterThinking };
}
export function resolveProviderThinking(agent, provider) {
    if (!agent)
        return undefined;
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
function formatStoredThinkingWarning(agent, model, rawThinking, neutralizingThinking, generatedFallback) {
    const storedThinking = rawThinking === false ? "off" : String(rawThinking);
    const modelLabel = `${generatedFallback ? "generated fallback " : ""}${formatProviderModelReference(model)}`;
    const standardStoredThinking = rawThinking === false || (typeof rawThinking === "string" && isThinkingLevel(rawThinking));
    const subject = standardStoredThinking
        ? `TLH stored minor-agent effort "${storedThinking}" is not supported by ${modelLabel}`
        : `TLH ignored unsupported stored minor-agent effort "${storedThinking}" for ${generatedFallback ? modelLabel : (agent?.name ?? "this subagent")}`;
    if (neutralizingThinking === undefined) {
        const residual = rawThinking === false
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
function formatUnresolvedStoredThinkingWarning(agent, rawThinking) {
    return `TLH ignored unsupported stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"}; no supported model suffix could be emitted, so the subagents runtime will drop the value for a known model and fail open for an unknown model if this role is dispatched.`;
}
function formatUnresolvedStoredThinkingCapabilityWarning(agent, rawThinking) {
    return `TLH stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"} could not be capability-checked because no bundled or current-session model is available; the subagents runtime will apply its capability gate if the model resolves and fail open otherwise.`;
}
function resolveStoredSubagentThinking(agent, model, override, generatedFallback = false) {
    const rawThinking = override?.thinking;
    const bundledThinking = resolveThinkingForProvider(agent, model?.provider);
    const requestedThinking = rawThinking === false
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
    if (!Object.hasOwn(model, "reasoning")) {
        return requestedThinking !== undefined ? { thinking: requestedThinking } : {};
    }
    const supportedLevels = getAvailableThinkingLevels(model);
    if (requestedThinking !== undefined && supportedLevels.includes(requestedThinking)) {
        return { thinking: requestedThinking };
    }
    const neutralizingThinking = bundledThinking && supportedLevels.includes(bundledThinking)
        ? bundledThinking
        : supportedLevels.includes("off")
            ? "off"
            : undefined;
    return {
        thinking: neutralizingThinking,
        warning: formatStoredThinkingWarning(agent, model, rawThinking, neutralizingThinking, generatedFallback),
    };
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
    return `TLH saved minor-agent model override "${model}" for ${roleLabel} is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults.${action}`;
}
export function resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override) {
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
    if (typeof override?.model === "string") {
        const parsedOverrideModel = parseProviderModelReference(splitKnownThinkingSuffix(override.model).baseModel);
        const thinkingResolution = resolveStoredSubagentThinking(agent, undefined, override);
        return {
            unavailableModel: override.model,
            independence: resolveIndependence(agent, parsedOverrideModel, currentProvider, currentModel),
            warning: thinkingResolution.warning,
        };
    }
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
    const openrouterFollow = resolveOpenrouterFollowDefaults(agent, availableModels, currentProvider, currentModel);
    if (openrouterFollow?.model) {
        const thinkingResolution = override === undefined
            ? { thinking: openrouterFollow.thinking }
            : resolveStoredSubagentThinking(agent, openrouterFollow.model, override);
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
            currentSessionThinkingResolution = resolveStoredSubagentThinking(agent, currentSessionModel, override);
            if (currentSessionThinkingResolution.thinking) {
                selectedModel = currentSessionModel;
            }
        }
        else if (typeof override.thinking === "string" && override.thinking !== "off") {
            currentSessionThinkingResolution = {
                warning: formatUnresolvedStoredThinkingCapabilityWarning(agent, override.thinking),
            };
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
        return model;
    }
    return formatResolvedProviderModelReference(model, thinking);
}
function applyModelToRunnableTarget(target, agents, availableModels, currentProvider, currentModel, options) {
    if (!isRecord(target)) {
        return 0;
    }
    const agentName = agentNameForTarget(target);
    const agent = agentName ? agents.get(agentName) : undefined;
    const override = agentName ? options.agentOverrides?.get(agentName) : undefined;
    if (hasExplicitModel(target)) {
        if (typeof target.model !== "string" ||
            splitKnownThinkingSuffix(target.model).thinkingSuffix ||
            override?.thinking === undefined) {
            return 0;
        }
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
    if (override === undefined) {
        const defaults = selectProviderAwareAgentDefaults(agent, availableModels, currentProvider, currentModel);
        const selectedModel = defaults.model ? formatProviderModelReference(defaults.model) : undefined;
        if (!selectedModel || selectedModel === agent?.model) {
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
                    target.fallbackModels = [fallbackModelId];
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
    if (override.model === false && override.thinking === undefined) {
        return 0;
    }
    const resolution = resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override);
    if (resolution.unavailableModel && agentName) {
        options.onWarning?.({
            agent: agentName,
            message: formatUnavailableStoredModelWarning(agentName, resolution.unavailableModel),
        });
    }
    if (resolution.warning && agentName) {
        options.onWarning?.({ agent: agentName, message: resolution.warning });
    }
    const usesGeneratedFallback = !Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined;
    if (usesGeneratedFallback && resolution.fallbackWarning && agentName) {
        options.onWarning?.({ agent: agentName, message: resolution.fallbackWarning });
    }
    const selectedModel = formatEffectiveModelAndThinking(resolution.unavailableModel ?? resolution.model, resolution.unavailableModel ? undefined : resolution.thinking);
    if (!selectedModel || (!resolution.unavailableModel && selectedModel === agent?.model)) {
        return 0;
    }
    target.model = selectedModel;
    const fallbackModels = resolution.fallbackModels
        ?.map((fb) => formatResolvedProviderModelReference(fb.model, fb.thinking))
        .filter((m) => Boolean(m));
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
