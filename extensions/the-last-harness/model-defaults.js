import { getAvailableThinkingLevels, isThinkingLevel } from "./thinking.js";
import { isRecord } from "./common.js";
const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
const MODEL_SUFFIX_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const OPPOSITE_PROVIDER_FALLBACK_NOTICE = "TLH fell back to a same-provider review model; review independence is reduced.";
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
export function splitKnownThinkingSuffix(model) {
    if (!model) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    const colon = model.lastIndexOf(":");
    if (colon === -1) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    const suffix = model.slice(colon + 1);
    if (!MODEL_SUFFIX_THINKING_LEVELS.includes(suffix)) {
        return { baseModel: model, thinkingSuffix: "" };
    }
    return { baseModel: model.slice(0, colon), thinkingSuffix: `:${suffix}` };
}
function applyThinkingSuffix(model, thinking) {
    if (!model || !thinking) {
        return model;
    }
    if (!MODEL_SUFFIX_THINKING_LEVELS.includes(thinking)) {
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
function providerFamily(provider) {
    if (isOpenaiProvider(provider)) {
        return "openai";
    }
    if (isAnthropicProvider(provider)) {
        return "anthropic";
    }
    return undefined;
}
export function findAvailableProviderModel(availableModels, model) {
    const parsed = parseProviderModelReference(splitKnownThinkingSuffix(model).baseModel);
    if (!parsed) {
        return undefined;
    }
    return findAvailableProviderModelReference(availableModels, parsed);
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
function selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider) {
    if (!agent?.preferOppositeProvider) {
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
    if (currentModel?.provider === currentProvider) {
        const availableCurrentModel = findAvailableProviderModelReference(availableModels, currentModel);
        if (availableCurrentModel) {
            return availableCurrentModel;
        }
    }
    return currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
        ?? currentProviderAnthropicCandidate(agent, availableModels, currentProvider);
}
function selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider) {
    if (!agent) {
        return undefined;
    }
    const defaultModel = findAvailableProviderModel(availableModels, agent.model);
    if (defaultModel) {
        return defaultModel;
    }
    const currentProviderModel = currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
        ?? currentProviderAnthropicCandidate(agent, availableModels, currentProvider);
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
function selectThinkingForProvider(agent, provider) {
    return isOpenaiProvider(provider) && agent?.tlhOpenaiThinking
        ? agent.tlhOpenaiThinking
        : agent?.thinking;
}
function resolveStoredSubagentThinking(agent, model, override) {
    const rawThinking = override?.thinking;
    const thinking = rawThinking && isThinkingLevel(rawThinking)
        ? rawThinking
        : rawThinking === undefined
            ? selectThinkingForProvider(agent, model?.provider)
            : undefined;
    if (!thinking) {
        return rawThinking === undefined
            ? {}
            : {
                warning: `TLH ignored unsupported stored minor-agent effort "${rawThinking}" for ${agent?.name ?? "this subagent"}; using bundled defaults for this run.`,
            };
    }
    if (!override?.thinking || !model) {
        return { thinking };
    }
    if (!getAvailableThinkingLevels(model).includes(thinking) || !MODEL_SUFFIX_THINKING_LEVELS.includes(thinking)) {
        return {
            warning: `TLH stored minor-agent effort "${thinking}" is not supported by ${formatProviderModelReference(model)}; using bundled defaults for this run.`,
        };
    }
    return { thinking };
}
function resolveIndependence(agent, model, currentProvider) {
    if (!agent?.preferOppositeProvider) {
        return "not-applicable";
    }
    if (!model) {
        return "unknown";
    }
    const currentFamily = providerFamily(currentProvider);
    const modelFamily = providerFamily(model.provider);
    if (!currentFamily || !modelFamily) {
        return "unknown";
    }
    return currentFamily === modelFamily ? "degraded" : "preferred";
}
export function selectProviderAwareAgentModel(agent, availableModels, currentProvider) {
    return selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider)
        ?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
}
export function selectProviderAwareAgentDefaults(agent, availableModels, currentProvider) {
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
    const standardModel = agent?.preferCurrentOpenaiModel
        ? currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
            ?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
        : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
    const model = oppositeProviderModel ?? standardModel;
    const thinking = selectThinkingForProvider(agent, model?.provider ?? currentProvider);
    return { model, thinking };
}
export function selectProviderAwareAgentModelId(agent, availableModels, currentProvider) {
    const model = selectProviderAwareAgentModel(agent, availableModels, currentProvider);
    return model ? formatProviderModelReference(model) : undefined;
}
export function resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override) {
    const overrideModel = findAvailableProviderModel(availableModels, override?.model);
    if (overrideModel) {
        const thinkingResolution = resolveStoredSubagentThinking(agent, overrideModel, override);
        return {
            model: overrideModel,
            thinking: thinkingResolution.thinking,
            independence: resolveIndependence(agent, overrideModel, currentProvider),
            warning: thinkingResolution.warning,
        };
    }
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
    let selectedModel = oppositeProviderModel
        ?? (agent?.preferCurrentOpenaiModel
            ? currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
                ?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
            : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider));
    const fallbackModel = oppositeProviderModel
        ? selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel)
        : undefined;
    let currentSessionThinkingResolution;
    if (!selectedModel && override?.thinking !== undefined) {
        const currentSessionModel = findAvailableProviderModelReference(availableModels, currentModel);
        if (currentSessionModel) {
            currentSessionThinkingResolution = resolveStoredSubagentThinking(agent, currentSessionModel, override);
            if (currentSessionThinkingResolution.thinking) {
                selectedModel = currentSessionModel;
            }
        }
    }
    const primaryThinkingResolution = selectedModel
        ? resolveStoredSubagentThinking(agent, selectedModel, override)
        : currentSessionThinkingResolution ?? {};
    const fallbackModels = fallbackModel && (!selectedModel || formatProviderModelReference(fallbackModel) !== formatProviderModelReference(selectedModel))
        ? [fallbackModel]
        : [];
    const resolvedFallbackModels = fallbackModels.map((model) => ({
        model,
        thinking: resolveStoredSubagentThinking(agent, model, override).thinking,
    }));
    const fallbackWarning = override?.thinking !== undefined
        ? resolvedFallbackModels.find((entry) => entry.thinking === undefined)?.model
        : undefined;
    return {
        model: selectedModel,
        fallbackModels: resolvedFallbackModels,
        modelFallbackNotice: resolvedFallbackModels.length > 0 ? OPPOSITE_PROVIDER_FALLBACK_NOTICE : undefined,
        thinking: primaryThinkingResolution.thinking,
        independence: resolveIndependence(agent, selectedModel, currentProvider),
        warning: primaryThinkingResolution.warning,
        fallbackWarning: !primaryThinkingResolution.warning && fallbackWarning
            ? `TLH stored minor-agent effort "${override?.thinking}" is not supported by generated fallback ${formatProviderModelReference(fallbackWarning)}; that fallback will use bundled effort behavior for this run.`
            : undefined,
    };
}
function hasExplicitModel(target) {
    return Object.hasOwn(target, "model") && target.model !== undefined;
}
function agentNameForTarget(target) {
    return typeof target.agent === "string" ? target.agent : undefined;
}
function applyModelToRunnableTarget(target, agents, availableModels, currentProvider, currentModel, options) {
    if (!isRecord(target)) {
        return 0;
    }
    const agentName = agentNameForTarget(target);
    const agent = agentName ? agents.get(agentName) : undefined;
    const override = agentName ? options.agentOverrides?.get(agentName) : undefined;
    if (hasExplicitModel(target)) {
        if (typeof target.model !== "string" || splitKnownThinkingSuffix(target.model).thinkingSuffix || override?.thinking === undefined) {
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
    const resolution = resolveProviderAwareSubagentResolution(agent, availableModels, currentProvider, currentModel, override);
    if (resolution.warning && agentName) {
        options.onWarning?.({ agent: agentName, message: resolution.warning });
    }
    const usesGeneratedFallback = !Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined;
    if (usesGeneratedFallback && resolution.fallbackWarning && agentName) {
        options.onWarning?.({ agent: agentName, message: resolution.fallbackWarning });
    }
    const selectedModel = resolution.model ? applyThinkingSuffix(formatProviderModelReference(resolution.model), resolution.thinking) : undefined;
    if (!selectedModel || selectedModel === agent?.model) {
        return 0;
    }
    target.model = selectedModel;
    const fallbackModels = resolution.fallbackModels
        ?.map((fallbackModel) => applyThinkingSuffix(formatProviderModelReference(fallbackModel.model), fallbackModel.thinking))
        .filter((model) => Boolean(model));
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
