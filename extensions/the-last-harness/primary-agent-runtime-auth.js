import { isRecord } from "./common.js";
import { parseProviderModelReference } from "./model-defaults.js";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export function isHighConfidenceAuthSignatureInAttemptError(error) {
    const lower = error.toLowerCase();
    return (lower.includes("invalid_grant") ||
        lower.includes("token-refresh unauthorized") ||
        lower.includes("token refresh unauthorized") ||
        lower.includes("status 401") ||
        lower.includes("status 403") ||
        lower.includes("(status 401)") ||
        lower.includes("(status 403)") ||
        lower.includes("http 401") ||
        lower.includes("http 403"));
}
export function processSubagentRunDetails(details, authStore) {
    if (!isRecord(details))
        return;
    const { results } = details;
    if (!Array.isArray(results))
        return;
    for (const result of results) {
        if (!isRecord(result))
            continue;
        const { modelAttempts } = result;
        if (!Array.isArray(modelAttempts)) {
            continue;
        }
        for (const attempt of modelAttempts) {
            if (!isRecord(attempt))
                continue;
            const { model, success, error } = attempt;
            if (typeof model !== "string" || typeof success !== "boolean")
                continue;
            if (success === true)
                continue;
            if (typeof error !== "string" || error.length === 0)
                continue;
            const parsed = parseProviderModelReference(model);
            if (!parsed?.provider)
                continue;
            if (isHighConfidenceAuthSignatureInAttemptError(error)) {
                authStore.recordRunLevelAuthObservation(parsed.provider);
            }
        }
    }
}
export function dispatchPreflightBackoffMs(failures) {
    if (failures <= 1)
        return 60_000;
    if (failures === 2)
        return 120_000;
    return 300_000;
}
export function extractDispatchProviders(input) {
    if (typeof input !== "object" || input === null)
        return [];
    const obj = input;
    const seen = new Set();
    function addModel(model) {
        if (typeof model !== "string")
            return;
        const parsed = parseProviderModelReference(model);
        if (parsed?.provider)
            seen.add(parsed.provider);
    }
    addModel(obj["model"]);
    if (Array.isArray(obj["tasks"])) {
        for (const task of obj["tasks"]) {
            if (typeof task === "object" && task !== null) {
                addModel(task["model"]);
            }
        }
    }
    return [...seen];
}
