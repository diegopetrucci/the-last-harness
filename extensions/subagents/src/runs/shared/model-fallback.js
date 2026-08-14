import { parseThinkingLevel, splitKnownThinkingSuffix, } from "../../shared/model-info.js";
import { checkModelScope } from "./model-scope.js";
function sameModelIdentity(left, right) {
    return Boolean(left && left.provider === right.provider && left.model === right.model && left.thinking === right.thinking);
}
export function appendRuntimeFallbackResolution(input) {
    const current = input.currentIdentity;
    const source = input.sourceAttempt;
    if (!current || !source)
        return input.previous;
    if (sameModelIdentity(input.previous?.resumed, current))
        return input.previous;
    const original = input.previous?.original ?? input.originalIdentity ?? canonicalSubagentModelIdentity(source.model);
    const currentReference = `${current.provider}/${current.model}${current.thinking ? `:${current.thinking}` : ""}`;
    const transition = `Runtime fallback selected '${currentReference}' after '${source.model}' failed: ${source.error ?? `exit ${source.exitCode ?? 1}`}.`;
    return {
        kind: "fallback",
        ...(original ? { original } : {}),
        resumed: current,
        reason: [input.previous?.reason, transition].filter(Boolean).join(" "),
    };
}
export function splitThinkingSuffix(model) {
    const colonIdx = model.lastIndexOf(":");
    if (colonIdx === -1)
        return { baseModel: model, thinkingSuffix: "" };
    return {
        baseModel: model.substring(0, colonIdx),
        thinkingSuffix: model.substring(colonIdx),
    };
}
export const INHERIT_MODEL = "inherit";
export function canonicalSubagentModelIdentity(model, thinking) {
    if (!model)
        return undefined;
    const parsed = splitKnownThinkingSuffix(model);
    const separator = parsed.baseModel.indexOf("/");
    if (separator <= 0 || separator === parsed.baseModel.length - 1)
        return undefined;
    const effectiveThinking = parsed.thinkingSuffix ? parsed.thinkingSuffix.slice(1) : parseThinkingLevel(thinking);
    return {
        provider: parsed.baseModel.slice(0, separator),
        model: parsed.baseModel.slice(separator + 1),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
    };
}
export function sanitizeSubagentModelIdentity(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const input = value;
    if (typeof input.provider !== "string" ||
        input.provider.trim() === "" ||
        typeof input.model !== "string" ||
        input.model.trim() === "")
        return undefined;
    const thinking = parseThinkingLevel(input.thinking);
    return {
        provider: input.provider,
        model: input.model,
        ...(thinking ? { thinking } : {}),
    };
}
export function sanitizeSubagentModelResolution(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const input = value;
    if ((input.kind !== "restored" && input.kind !== "override" && input.kind !== "fallback") ||
        typeof input.reason !== "string" ||
        input.reason.trim() === "")
        return undefined;
    const original = sanitizeSubagentModelIdentity(input.original);
    const resumed = sanitizeSubagentModelIdentity(input.resumed);
    if ((input.original !== undefined && !original) || (input.resumed !== undefined && !resumed))
        return undefined;
    return {
        kind: input.kind,
        ...(original ? { original } : {}),
        ...(resumed ? { resumed } : {}),
        reason: input.reason,
    };
}
export function modelReferenceFromIdentity(identity) {
    return `${identity.provider}/${identity.model}`;
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
export function normalizeModelSegment(segment) {
    return segment.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function isPlausibleDateStamp(year, month, day) {
    const yyyy = Number(year);
    const mm = Number(month);
    const dd = Number(day);
    return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}
function stripTrailingDateStamp(segment) {
    const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
    if (dashed && isPlausibleDateStamp(dashed[2], dashed[3], dashed[4]))
        return dashed[1];
    const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
    if (compact && isPlausibleDateStamp(compact[2], compact[3], compact[4]))
        return compact[1];
    return segment;
}
function resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) {
    if (baseModel.includes("/")) {
        const exact = availableModels.find((entry) => entry.fullId === baseModel);
        if (exact)
            return exact.fullId;
    }
    else {
        const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
        if (preferredProvider) {
            const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
            if (preferredMatch)
                return preferredMatch.fullId;
        }
        if (exactMatches.length === 1)
            return exactMatches[0].fullId;
    }
    return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}
export function fuzzyResolveModel(baseModel, availableModels, preferredProvider) {
    let queryProvider;
    let queryIdRaw = baseModel;
    const slashIdx = baseModel.indexOf("/");
    if (slashIdx !== -1) {
        queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
        queryIdRaw = baseModel.slice(slashIdx + 1);
    }
    else {
        const providerSeparators = [":", "."];
        for (const separator of providerSeparators) {
            const separatorIdx = baseModel.indexOf(separator);
            if (separatorIdx <= 0)
                continue;
            const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
            if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart))
                continue;
            queryProvider = providerPart;
            queryIdRaw = baseModel.slice(separatorIdx + 1);
            break;
        }
    }
    const queryId = normalizeModelSegment(queryIdRaw);
    const queryIdNoDate = stripTrailingDateStamp(queryId);
    const candidates = availableModels.filter((entry) => {
        const entryId = normalizeModelSegment(entry.id);
        if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate)
            return false;
        if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider)
            return false;
        return true;
    });
    if (candidates.length === 0)
        return undefined;
    if (preferredProvider) {
        const preferredProviderNorm = normalizeModelSegment(preferredProvider);
        const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
        if (preferred)
            return preferred.fullId;
    }
    if (candidates.length === 1)
        return candidates[0].fullId;
    return undefined;
}
export function resolveModelCandidate(model, availableModels, preferredProvider) {
    if (!model)
        return undefined;
    if (!availableModels || availableModels.length === 0)
        return model;
    const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
    if (resolvedWhole)
        return resolvedWhole;
    const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
    if (!thinkingSuffix)
        return model;
    const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
    if (resolvedBase)
        return `${resolvedBase}${thinkingSuffix}`;
    return model;
}
function defaultScopeWarn(violation) {
    console.warn(`[pi-subagents] ${violation.message}`);
}
export function resolveSubagentModelOverride(requestedModel, parentModel, availableModels, preferredProvider, options) {
    const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
    const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
    let resolved;
    if (explicit === undefined) {
        resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
    }
    else {
        resolved = resolveModelCandidate(explicit, availableModels, preferredProvider);
    }
    if (resolved && options?.scope?.enforce) {
        const source = explicit === undefined ? "inherited" : (options.source ?? "inherited");
        const violation = checkModelScope(resolved, options.scope, source);
        if (violation) {
            if (violation.severity === "error")
                throw new Error(violation.message);
            (options.onWarn ?? defaultScopeWarn)(violation);
        }
    }
    return resolved;
}
export function buildFallbackModelList(perExecutionFallbackModels, agentFallbackModels) {
    const seen = new Set();
    const fallbackModels = [];
    for (const raw of [...(perExecutionFallbackModels ?? []), ...(agentFallbackModels ?? [])]) {
        const model = typeof raw === "string" ? raw.trim() : "";
        if (!model || seen.has(model))
            continue;
        seen.add(model);
        fallbackModels.push(model);
    }
    return fallbackModels.length > 0 ? fallbackModels : undefined;
}
export function buildModelCandidates(primaryModel, fallbackModels, availableModels, preferredProvider, options) {
    const seen = new Set();
    const candidates = [];
    const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
    for (let index = 0; index < rawCandidates.length; index++) {
        const raw = rawCandidates[index];
        if (!raw)
            continue;
        const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
        if (!normalized || seen.has(normalized))
            continue;
        if (index > 0 && options?.scope?.enforce) {
            const violation = checkModelScope(normalized, options.scope, "inherited");
            if (violation)
                (options.onWarn ?? defaultScopeWarn)(violation);
        }
        seen.add(normalized);
        candidates.push(normalized);
    }
    return candidates;
}
function replaceModelNoticeControlCharacters(value) {
    return [...value]
        .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f ? " " : character;
    })
        .join("");
}
export function sanitizeModelFallbackNotice(notice) {
    if (typeof notice !== "string")
        return undefined;
    const sanitized = replaceModelNoticeControlCharacters(notice).replace(/\s+/g, " ").trim();
    return sanitized ? sanitized.slice(0, 240) : undefined;
}
const RETRYABLE_MODEL_FAILURE_PATTERNS = [
    /rate\s*limit/i,
    /too many requests/i,
    /\b429\b/,
    /quota/i,
    /billing/i,
    /credit/i,
    /auth(?:entication)?/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /api key/i,
    /token expired/i,
    /invalid key/i,
    /provider.*unavailable/i,
    /model.*unavailable/i,
    /model.*disabled/i,
    /model.*not found/i,
    /unknown model/i,
    /overloaded/i,
    /service unavailable/i,
    /temporar(?:ily)? unavailable/i,
    /connection refused/i,
    /fetch failed/i,
    /network error/i,
    /socket hang up/i,
    /upstream/i,
    /timed? out/i,
    /timeout/i,
    /\b502\b/,
    /\b503\b/,
    /\b504\b/,
    /cold.?start/i,
    /empty response/i,
    /no output/i,
    /model.*(?:load|fail|error)/i,
];
export function isRetryableModelFailure(error) {
    if (!error)
        return false;
    return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}
export function formatModelAttemptNote(attempt, nextModel) {
    const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
    return nextModel
        ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
        : `[fallback] ${attempt.model} failed: ${failure}.`;
}
