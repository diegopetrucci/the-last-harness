const MODEL_CONTEXT_WINDOW_POLICY_KEY = Symbol.for("the-last-harness.model-context-window-policy");
const MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY = Symbol.for("the-last-harness.model-context-window-policy-state");
function positiveFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function isModelContextWindowOwner(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function isModelContextWindowPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const policy = value;
    return (positiveFiniteNumber(policy.nativeContextWindow) !== undefined &&
        positiveFiniteNumber(policy.developerChildContextWindow) !== undefined);
}
function isSharedContextWindowPolicyState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const state = value;
    return (typeof state.active === "boolean" &&
        typeof state.enabled === "boolean" &&
        typeof state.generation === "number" &&
        Number.isInteger(state.generation) &&
        state.generation >= 0 &&
        positiveFiniteNumber(state.primaryContextWindowCap) !== undefined &&
        positiveFiniteNumber(state.developerContextWindowCap) !== undefined &&
        state.nativeContextWindows instanceof Map);
}
function isNativeContextWindowRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    return (positiveFiniteNumber(record.contextWindow) !== undefined &&
        typeof record.generation === "number" &&
        Number.isInteger(record.generation) &&
        record.generation >= 0);
}
function getSharedContextWindowPolicyState() {
    const globalValue = globalThis;
    const globalState = globalValue;
    const state = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY];
    return isSharedContextWindowPolicyState(state) && state.active ? state : undefined;
}
function modelIdentityKey(model) {
    if (typeof model.provider !== "string" ||
        typeof model.id !== "string" ||
        model.provider.length === 0 ||
        model.id.length === 0)
        return undefined;
    return JSON.stringify([model.provider, model.id]);
}
function getGlobalContextWindowPolicy(model) {
    const state = getSharedContextWindowPolicyState();
    if (!state)
        return undefined;
    const current = positiveFiniteNumber(model.contextWindow);
    const rememberedRecord = state.nativeContextWindows.get(modelIdentityKey(model) ?? "");
    const remembered = isNativeContextWindowRecord(rememberedRecord) &&
        rememberedRecord.generation === state.generation
        ? rememberedRecord.contextWindow
        : undefined;
    let nativeContextWindow = current ?? remembered;
    if (remembered !== undefined && current !== undefined) {
        const primaryEffective = Math.min(remembered, state.primaryContextWindowCap);
        const developerEffective = state.enabled
            ? Math.min(remembered, state.developerContextWindowCap)
            : remembered;
        if (current === primaryEffective || current === developerEffective) {
            nativeContextWindow = remembered;
        }
    }
    if (nativeContextWindow === undefined)
        return undefined;
    return {
        nativeContextWindow,
        developerChildContextWindow: state.enabled
            ? Math.min(nativeContextWindow, state.developerContextWindowCap)
            : nativeContextWindow,
    };
}
export function getModelContextWindowPolicy(model) {
    if (!isModelContextWindowOwner(model))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY);
    const policy = descriptor?.value;
    if (!isModelContextWindowPolicy(policy))
        return undefined;
    return {
        nativeContextWindow: policy.nativeContextWindow,
        developerChildContextWindow: policy.developerChildContextWindow,
    };
}
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function parseThinkingLevel(value) {
    return typeof value === "string" ? THINKING_LEVELS.find((level) => level === value) : undefined;
}
export function toModelInfo(model) {
    const contextWindowPolicy = getModelContextWindowPolicy(model) ?? getGlobalContextWindowPolicy(model);
    return {
        provider: model.provider,
        id: model.id,
        fullId: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
        ...(contextWindowPolicy
            ? {
                nativeContextWindow: contextWindowPolicy.nativeContextWindow,
                developerChildContextWindow: contextWindowPolicy.developerChildContextWindow,
            }
            : {}),
    };
}
function positiveContextWindow(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
export function contextWindowForChildModel(model, options = {}) {
    return options.canonicalDeveloper === true
        ? (positiveContextWindow(model.developerChildContextWindow) ??
            positiveContextWindow(model.nativeContextWindow) ??
            positiveContextWindow(model.contextWindow))
        : (positiveContextWindow(model.nativeContextWindow) ??
            positiveContextWindow(model.contextWindow));
}
export function contextWindowsForChildModels(models, options = {}) {
    const entries = [];
    for (const model of models ?? []) {
        const contextWindow = contextWindowForChildModel(model, options);
        if (contextWindow !== undefined)
            entries.push([model.fullId, contextWindow]);
    }
    return Object.fromEntries(entries);
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
