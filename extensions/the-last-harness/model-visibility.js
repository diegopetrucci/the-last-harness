import { InteractiveMode, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isRecord, readText, uniqueSorted } from "./common.js";
import { safeTlhProfileFilePath } from "./profile-state.js";
const TLH_MODEL_VISIBILITY_PATCHED = Symbol.for("tlh.modelVisibilityPatched");
const TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL = Symbol.for("tlh.modelVisibilityGetAvailableOriginal");
const TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED = Symbol.for("tlh.modelVisibilityExactLookupPatched");
const TLH_MODEL_VISIBILITY_FIND_EXACT_MODEL_MATCH_ORIGINAL = Symbol.for("tlh.modelVisibilityFindExactModelMatchOriginal");
export const TLH_HIDDEN_MODEL_DEFAULTS = Object.freeze([
    "anthropic/claude-3-5-haiku-20241022",
    "anthropic/claude-3-5-haiku-latest",
    "anthropic/claude-3-5-sonnet-20240620",
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-7-sonnet-20250219",
    "anthropic/claude-3-haiku-20240307",
    "anthropic/claude-3-opus-20240229",
    "anthropic/claude-3-sonnet-20240229",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-haiku-4-5-20251001",
    "anthropic/claude-opus-4-0",
    "anthropic/claude-opus-4-1",
    "anthropic/claude-opus-4-1-20250805",
    "anthropic/claude-opus-4-20250514",
    "anthropic/claude-opus-4-5",
    "anthropic/claude-opus-4-5-20251101",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-0",
    "anthropic/claude-sonnet-4-20250514",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-5-20250929",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-sonnet-5",
    "openai-codex/gpt-5.3-codex-spark",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.4-mini",
]);
function normalizePatternList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return uniqueSorted(value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean));
}
export function normalizeTlhModelVisibilityConfig(config) {
    if (!isRecord(config)) {
        return { disabled: false, hidden: [], visible: [] };
    }
    return {
        disabled: config.disabled === true,
        hidden: normalizePatternList(config.hidden),
        visible: uniqueSorted([
            ...normalizePatternList(config.visible),
            ...normalizePatternList(config.unhide),
        ]),
    };
}
function readTlhSettings() {
    const settingsPath = safeTlhProfileFilePath("settings.json");
    const content = settingsPath ? readText(settingsPath) : undefined;
    if (!content) {
        return settingsPath ? {} : undefined;
    }
    try {
        const parsed = JSON.parse(content);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
export function getTlhModelVisibilityConfig() {
    const settings = readTlhSettings();
    if (!settings) {
        return { disabled: true, hidden: [], visible: [] };
    }
    return normalizeTlhModelVisibilityConfig(settings.tlh?.modelVisibility);
}
function escapeRegExp(text) {
    return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
function matchesGlobPattern(value, pattern) {
    const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".")}$`, "i");
    return regex.test(value);
}
function modelCandidates(model, pattern) {
    const full = `${model.provider}/${model.id}`;
    return pattern.includes("/") ? [full] : [model.id, full];
}
export function matchesTlhModelVisibilityPattern(model, pattern) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) {
        return false;
    }
    const candidates = modelCandidates(model, normalizedPattern).map((value) => value.toLowerCase());
    if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
        return candidates.some((candidate) => matchesGlobPattern(candidate, normalizedPattern));
    }
    return candidates.some((candidate) => candidate === normalizedPattern);
}
function matchesAnyPattern(model, patterns) {
    return patterns.some((pattern) => matchesTlhModelVisibilityPattern(model, pattern));
}
function findExactModelReferenceMatch(modelReference, availableModels) {
    const trimmedReference = modelReference.trim();
    if (!trimmedReference) {
        return undefined;
    }
    const normalizedReference = trimmedReference.toLowerCase();
    const canonicalMatches = availableModels.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference);
    if (canonicalMatches.length === 1) {
        return canonicalMatches[0];
    }
    if (canonicalMatches.length > 1) {
        return undefined;
    }
    const slashIndex = trimmedReference.indexOf("/");
    if (slashIndex !== -1) {
        const provider = trimmedReference.substring(0, slashIndex).trim();
        const modelId = trimmedReference.substring(slashIndex + 1).trim();
        if (provider && modelId) {
            const providerMatches = availableModels.filter((model) => model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === modelId.toLowerCase());
            if (providerMatches.length === 1) {
                return providerMatches[0];
            }
            if (providerMatches.length > 1) {
                return undefined;
            }
        }
    }
    const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
    return idMatches.length === 1 ? idMatches[0] : undefined;
}
function isCanonicalModelReference(modelReference) {
    const trimmedReference = modelReference.trim();
    const slashIndex = trimmedReference.indexOf("/");
    return slashIndex > 0 && slashIndex < trimmedReference.length - 1;
}
export function isTlhModelHidden(model, config = getTlhModelVisibilityConfig()) {
    if (config.disabled) {
        return false;
    }
    if (matchesAnyPattern(model, config.visible)) {
        return false;
    }
    return matchesAnyPattern(model, TLH_HIDDEN_MODEL_DEFAULTS) || matchesAnyPattern(model, config.hidden);
}
export function filterTlhVisibleModels(models, config = getTlhModelVisibilityConfig()) {
    if (config.disabled) {
        return [...models];
    }
    return models.filter((model) => !isTlhModelHidden(model, config));
}
export function installTlhModelVisibilityFilter() {
    const modelRegistryPrototype = ModelRegistry.prototype;
    if (!modelRegistryPrototype[TLH_MODEL_VISIBILITY_PATCHED]) {
        const originalGetAvailable = modelRegistryPrototype.getAvailable;
        modelRegistryPrototype[TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL] = originalGetAvailable;
        modelRegistryPrototype.getAvailable = function tlhModelVisibilityGetAvailable() {
            return filterTlhVisibleModels(originalGetAvailable.call(this));
        };
        modelRegistryPrototype[TLH_MODEL_VISIBILITY_PATCHED] = true;
    }
    const interactiveModePrototype = InteractiveMode.prototype;
    if (interactiveModePrototype[TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED] ||
        typeof interactiveModePrototype.findExactModelMatch !== "function") {
        return;
    }
    const originalFindExactModelMatch = interactiveModePrototype.findExactModelMatch;
    interactiveModePrototype[TLH_MODEL_VISIBILITY_FIND_EXACT_MODEL_MATCH_ORIGINAL] = originalFindExactModelMatch;
    interactiveModePrototype.findExactModelMatch = async function tlhFindExactModelMatch(searchTerm) {
        const exactMatch = await originalFindExactModelMatch.call(this, searchTerm);
        if (exactMatch || !isCanonicalModelReference(searchTerm)) {
            return exactMatch;
        }
        if ((this.session?.scopedModels?.length ?? 0) > 0 || !this.session?.modelRegistry) {
            return exactMatch;
        }
        try {
            return findExactModelReferenceMatch(searchTerm, getUnfilteredAvailableModels(this.session.modelRegistry));
        }
        catch {
            return exactMatch;
        }
    };
    interactiveModePrototype[TLH_MODEL_VISIBILITY_EXACT_LOOKUP_PATCHED] = true;
}
export function getUnfilteredAvailableModels(modelRegistry) {
    const modelRegistryPrototype = Object.getPrototypeOf(modelRegistry);
    const originalGetAvailable = modelRegistryPrototype?.[TLH_MODEL_VISIBILITY_GET_AVAILABLE_ORIGINAL];
    return originalGetAvailable ? originalGetAvailable.call(modelRegistry) : modelRegistry.getAvailable();
}
