export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function toModelInfo(model) {
    return {
        provider: model.provider,
        id: model.id,
        fullId: `${model.provider}/${model.id}`,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
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
export function getSupportedThinkingLevels(model) {
    if (!model)
        return THINKING_LEVELS.filter((level) => level !== "max");
    if (model.reasoning === false)
        return ["off"];
    if (!model.thinkingLevelMap)
        return THINKING_LEVELS.filter((level) => level !== "max");
    const levels = THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null)
            return false;
        if (level === "xhigh" || level === "max")
            return mapped !== undefined;
        return true;
    });
    return levels;
}
