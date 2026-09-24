import { parseThinkingLevel, splitKnownThinkingSuffix } from "../../shared/model-info.js";
import { checkModelScope, } from "./model-scope.js";
function sameModelIdentity(left, right) {
    return Boolean(left &&
        left.provider === right.provider &&
        left.model === right.model &&
        left.thinking === right.thinking);
}
export function appendRuntimeFallbackResolution(input) {
    const current = input.currentIdentity;
    const source = input.sourceAttempt;
    if (!current || !source)
        return input.previous;
    if (sameModelIdentity(input.previous?.resumed, current))
        return input.previous;
    const original = input.previous?.original ??
        input.originalIdentity ??
        canonicalSubagentModelIdentity(source.model);
    const currentReference = `${current.provider}/${current.model}${current.thinking ? `:${current.thinking}` : ""}`;
    const transition = `Runtime fallback selected '${currentReference}' after '${source.model}' failed: ${source.error ?? `exit ${source.exitCode ?? 1}`}.`;
    return {
        kind: "fallback",
        ...(original ? { original } : {}),
        resumed: current,
        reason: [input.previous?.reason, transition].filter(Boolean).join(" "),
    };
}
const INHERIT_MODEL = "inherit";
export function canonicalSubagentModelIdentity(model, thinking) {
    if (!model)
        return undefined;
    const parsed = splitKnownThinkingSuffix(model);
    const separator = parsed.baseModel.indexOf("/");
    if (separator <= 0 || separator === parsed.baseModel.length - 1)
        return undefined;
    const effectiveThinking = parsed.thinkingSuffix
        ? parsed.thinkingSuffix.slice(1)
        : parseThinkingLevel(thinking);
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
        provider: input.provider.trim(),
        model: input.model.trim(),
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
function defaultScopeWarn(violation) {
    console.warn(`[pi-subagents] ${violation.message}`);
}
export function resolveSubagentModelOverride(requestedModel, parentModel, options) {
    const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
    const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
    const resolved = explicit ?? (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
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
export function deduplicateModelCandidates(candidates) {
    const seen = new Set();
    return candidates.filter((candidate) => {
        if (seen.has(candidate))
            return false;
        seen.add(candidate);
        return true;
    });
}
export function buildFallbackModelList(providerFallbackModels, agentFallbackModels) {
    const seen = new Set();
    const fallbackModels = [];
    for (const raw of [...(providerFallbackModels ?? []), ...(agentFallbackModels ?? [])]) {
        const model = typeof raw === "string" ? raw.trim() : "";
        if (!model || seen.has(model))
            continue;
        seen.add(model);
        fallbackModels.push(model);
    }
    return fallbackModels.length > 0 ? fallbackModels : undefined;
}
export function buildModelCandidatePlan(primaryModel, fallbackModels, options) {
    const seen = new Set();
    const candidates = [];
    const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
    for (let index = 0; index < rawCandidates.length; index += 1) {
        const raw = rawCandidates[index];
        if (typeof raw !== "string")
            continue;
        const model = raw.trim();
        if (!model || seen.has(model))
            continue;
        if (index > 0 && options?.scope?.enforce) {
            const violation = checkModelScope(model, options.scope, "inherited");
            if (violation)
                (options.onWarn ?? defaultScopeWarn)(violation);
        }
        seen.add(model);
        candidates.push(model);
    }
    return { candidates };
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
    /usage\s*limit/i,
    /too many requests/i,
    /\b429\b/,
    /\bquota\b/i,
    /connection\s+(?:refused|reset|closed|timed?\s*out)/i,
    /fetch failed/i,
    /network\s+error/i,
    /socket hang up/i,
    /\b(?:econnreset|econnrefused|enetunreach|ehostunreach|eai_again|etimedout)\b/i,
    /(?:request|provider|upstream|gateway)\s+.*\b(?:timed?\s*out|timeout)\b/i,
    /stream ended without finish_reason/i,
    /service unavailable/i,
    /bad gateway/i,
    /gateway timeout/i,
    /internal server error/i,
    /\boverloaded(?:_error)?\b/i,
];
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:(?:\(exit \d+\):))|(?:with exit code \d+))(?:\s|$)/i;
export function isRetryableModelFailure(error) {
    if (!error)
        return false;
    if (TOOL_FAILURE_PREFIX.test(error.trim()))
        return false;
    return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}
export function formatModelAttemptNote(attempt, nextModel) {
    const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
    return nextModel
        ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
        : `[fallback] ${attempt.model} failed: ${failure}.`;
}
