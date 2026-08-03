import { isRecord } from "./common.js";
const OPENAI_PROVIDERS = new Set(["openai-codex", "openai"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);
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
function isOpenaiProvider(provider) {
    return Boolean(provider && OPENAI_PROVIDERS.has(provider));
}
function isAnthropicProvider(provider) {
    return Boolean(provider && ANTHROPIC_PROVIDERS.has(provider));
}
export function findAvailableProviderModel(availableModels, model) {
    const parsed = parseProviderModelReference(model);
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
export function selectProviderAwareAgentModel(agent, availableModels, currentProvider) {
    return selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider)
        ?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
}
function resolveThinkingForProvider(agent, provider) {
    if (!agent)
        return undefined;
    if (isOpenaiProvider(provider) && agent.tlhOpenaiThinking) {
        return agent.tlhOpenaiThinking;
    }
    if (isAnthropicProvider(provider) && agent.tlhAnthropicThinking) {
        return agent.tlhAnthropicThinking;
    }
    return agent.thinking;
}
export function selectProviderAwareAgentDefaults(agent, availableModels, currentProvider) {
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
    const standardModel = agent?.preferCurrentOpenaiModel
        ? currentProviderOpenaiCandidate(agent, availableModels, currentProvider)
            ?? selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider)
        : selectStandardProviderAwareAgentModel(agent, availableModels, currentProvider);
    const model = oppositeProviderModel ?? standardModel;
    const thinking = resolveThinkingForProvider(agent, model?.provider ?? currentProvider);
    return { model, thinking };
}
export function selectProviderAwareAgentModelId(agent, availableModels, currentProvider) {
    const model = selectProviderAwareAgentModel(agent, availableModels, currentProvider);
    return model ? formatProviderModelReference(model) : undefined;
}
function hasExplicitModel(target) {
    return Object.hasOwn(target, "model") && target.model !== undefined;
}
function agentNameForTarget(target) {
    return typeof target.agent === "string" ? target.agent : undefined;
}
function applyModelToRunnableTarget(target, agents, availableModels, currentProvider, currentModel) {
    if (!isRecord(target) || hasExplicitModel(target)) {
        return 0;
    }
    const agentName = agentNameForTarget(target);
    const agent = agentName ? agents.get(agentName) : undefined;
    const defaults = selectProviderAwareAgentDefaults(agent, availableModels, currentProvider);
    const selectedModel = defaults.model ? formatProviderModelReference(defaults.model) : undefined;
    if (!selectedModel || selectedModel === agent?.model) {
        return 0;
    }
    const thinking = defaults.thinking;
    target.model = thinking ? `${selectedModel}:${thinking}` : selectedModel;
    const oppositeProviderModel = selectOppositeProviderPreferredAgentModel(agent, availableModels, currentProvider);
    if (oppositeProviderModel) {
        const fallbackModel = selectOppositeProviderFallbackModel(agent, availableModels, currentProvider, currentModel);
        const fallbackModelBase = fallbackModel ? formatProviderModelReference(fallbackModel) : undefined;
        if (fallbackModelBase && fallbackModelBase !== selectedModel) {
            const fallbackThinking = resolveThinkingForProvider(agent, fallbackModel.provider);
            const fallbackModelId = fallbackThinking ? `${fallbackModelBase}:${fallbackThinking}` : fallbackModelBase;
            if (!Object.hasOwn(target, "fallbackModels") || target.fallbackModels === undefined) {
                target.fallbackModels = [fallbackModelId];
            }
            if (!Object.hasOwn(target, "modelFallbackNotice") || target.modelFallbackNotice === undefined) {
                target.modelFallbackNotice = OPPOSITE_PROVIDER_FALLBACK_NOTICE;
            }
        }
    }
    return 1;
}
export function applyProviderAwareSubagentModels(input, agents, availableModels, currentProvider, currentModel) {
    if (!isRecord(input)) {
        return 0;
    }
    let mutations = applyModelToRunnableTarget(input, agents, availableModels, currentProvider, currentModel);
    if (Array.isArray(input.tasks)) {
        for (const task of input.tasks) {
            mutations += applyModelToRunnableTarget(task, agents, availableModels, currentProvider, currentModel);
        }
    }
    return mutations;
}
