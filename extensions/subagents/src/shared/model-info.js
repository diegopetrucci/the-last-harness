export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function parseThinkingLevel(value) {
    return typeof value === "string" ? THINKING_LEVELS.find((level) => level === value) : undefined;
}
export function toModelInfo(model) {
    return {
        provider: model.provider,
        id: model.id,
        fullId: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
    };
}
export function resolveEffectiveThinking(model, configThinking) {
    if (!model)
        return undefined;
    const { thinkingSuffix } = splitKnownThinkingSuffix(model);
    if (thinkingSuffix)
        return thinkingSuffix.slice(1);
    return THINKING_LEVELS.find((level) => level === configThinking);
}
export function splitKnownThinkingSuffix(model) {
    const colonIdx = model.lastIndexOf(":");
    if (colonIdx === -1)
        return { baseModel: model, thinkingSuffix: "" };
    const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
    if (!suffix)
        return { baseModel: model, thinkingSuffix: "" };
    return {
        baseModel: model.substring(0, colonIdx),
        thinkingSuffix: `:${suffix}`,
    };
}
export function findModelInfo(model, availableModels, preferredProvider) {
    if (!model || !availableModels || availableModels.length === 0)
        return undefined;
    const { baseModel } = splitKnownThinkingSuffix(model);
    const exact = availableModels.find((entry) => entry.fullId === baseModel);
    if (exact)
        return exact;
    const matches = availableModels.filter((entry) => entry.id === baseModel);
    if (preferredProvider) {
        const preferred = matches.find((entry) => entry.provider === preferredProvider);
        if (preferred)
            return preferred;
    }
    return matches.length === 1 ? matches[0] : undefined;
}
const SAFE_RUNTIME_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_RUNTIME_MODEL = /^(?!\/)(?!.*\/$)[^\s\0]+$/;
function runtimeIdentityFromFullId(fullId, thinkingSuffix) {
    const separator = fullId.indexOf("/");
    if (separator <= 0 || separator === fullId.length - 1)
        return undefined;
    const provider = fullId.slice(0, separator);
    const model = fullId.slice(separator + 1);
    if (!SAFE_RUNTIME_PROVIDER.test(provider) || !SAFE_RUNTIME_MODEL.test(model))
        return undefined;
    return {
        provider,
        model,
        ...(thinkingSuffix ? { thinking: thinkingSuffix.slice(1) } : {}),
    };
}
export function resolveRuntimeModelContext(providerValue, modelValue, contextWindows) {
    if (!contextWindows ||
        (typeof contextWindows !== "object" && typeof contextWindows !== "function") ||
        typeof modelValue !== "string" ||
        (providerValue !== undefined && typeof providerValue !== "string"))
        return undefined;
    const provider = typeof providerValue === "string" ? providerValue.trim() : "";
    const model = modelValue.trim();
    if (model === "")
        return undefined;
    if (provider !== "" && !SAFE_RUNTIME_PROVIDER.test(provider))
        return undefined;
    const parsed = splitKnownThinkingSuffix(model);
    if (!SAFE_RUNTIME_MODEL.test(parsed.baseModel))
        return undefined;
    const fullId = provider ? `${provider}/${parsed.baseModel}` : parsed.baseModel;
    if (!Object.hasOwn(contextWindows, fullId))
        return undefined;
    const identity = runtimeIdentityFromFullId(fullId, parsed.thinkingSuffix);
    if (!identity)
        return undefined;
    const contextWindow = contextWindows[fullId];
    if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
        return undefined;
    return { identity, contextWindow };
}
