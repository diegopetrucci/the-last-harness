import { PROVIDER_AWARE_FALLBACK_MODELS, STAFF_DEVELOPER_ROUTING_FEATURE, } from "../the-last-harness-subagent-safety.mjs";
import { isRecord } from "./common.js";
import { findAvailableProviderModel, formatProviderModelReference, listAgentModelDefaultReferences, } from "./model-defaults.js";
import { getTlhGlobalSettings } from "./primary-agent-runtime-settings.js";
import { getTlhSubagentControlTargetAccess } from "./subagent-control-access.mjs";
function staffDeveloperRoutingEnabled(cwd) {
    const enabledFeatures = getTlhGlobalSettings(cwd).tlh?.experimental?.enabledFeatures;
    return (Array.isArray(enabledFeatures) &&
        enabledFeatures.some((feature) => typeof feature === "string" &&
            feature.trim().toLowerCase() === STAFF_DEVELOPER_ROUTING_FEATURE));
}
function staffControlRequest(input) {
    if (!isRecord(input))
        return undefined;
    const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : undefined;
    if (action !== "resume" && action !== "steer")
        return undefined;
    return {
        action,
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        ...(typeof input.dir === "string" ? { dir: input.dir } : {}),
        ...(typeof input.index === "number" ? { index: input.index } : {}),
    };
}
export function getStaffControlTargetAccess(input) {
    const request = staffControlRequest(input);
    return request ? getTlhSubagentControlTargetAccess(request) : undefined;
}
export function staffControlTargetsStaffDeveloper(target) {
    return (target?.status === "found" &&
        Array.isArray(target.agents) &&
        target.agents.some(isStaffDeveloperTarget));
}
export function disabledStaffControlBlockReason(input, cwd, targetAccess) {
    if (staffDeveloperRoutingEnabled(cwd) || !isRecord(input))
        return undefined;
    const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : undefined;
    if (action !== "resume" && action !== "steer")
        return undefined;
    const target = targetAccess ?? getStaffControlTargetAccess(input);
    if (!staffControlTargetsStaffDeveloper(target))
        return undefined;
    const targetLabel = target.runId ? ` run '${target.runId}'` : " target";
    return `TLH ${action} blocked: staff-developer routing is disabled, so controls may not target staff-developer${targetLabel}. Enable the experimental feature 'staff-developer-routing' before retrying.`;
}
function isStaffDeveloperTarget(value) {
    return typeof value === "string" && value.trim().toLowerCase() === "staff-developer";
}
function staffModelSelection(value) {
    if (value === undefined)
        return { kind: "none" };
    if (value === false)
        return { kind: "inherit" };
    if (typeof value !== "string")
        return { kind: "inherit" };
    const normalized = value.trim();
    return normalized.length > 0 && normalized.toLowerCase() !== "inherit"
        ? { kind: "model", model: normalized }
        : { kind: "inherit" };
}
function declaredStaffModelForProvider(staffAgent, currentProvider) {
    const provider = currentProvider?.trim().toLowerCase();
    const declarationProvider = provider === "openai" || provider === "openai-codex"
        ? "openai-codex"
        : provider === "anthropic"
            ? "anthropic"
            : provider === "xai"
                ? "xai"
                : undefined;
    if (!declarationProvider)
        return undefined;
    const declaration = listAgentModelDefaultReferences(staffAgent).find((model) => model.provider === declarationProvider);
    return declaration ? formatProviderModelReference(declaration) : undefined;
}
function removeStaffDispatchOverrides(target) {
    delete target.model;
    delete target.fallbackModels;
    delete target.modelFallbackNotice;
    delete target[PROVIDER_AWARE_FALLBACK_MODELS];
}
function effectiveStaffModelSelection(target, availableModels, storedOverride, projectOverride) {
    const callerSelection = staffModelSelection(Object.hasOwn(target, "model") ? target.model : undefined);
    if (callerSelection.kind !== "none")
        return { selection: callerSelection };
    const projectSelection = staffModelSelection(projectOverride?.model);
    const storedSelection = staffModelSelection(storedOverride?.model);
    if (projectSelection.kind === "model") {
        if (findAvailableProviderModel(availableModels, projectSelection.model)) {
            return { selection: projectSelection };
        }
        if (storedSelection.kind !== "none") {
            return {
                selection: storedSelection,
                unavailableProjectModel: projectSelection.model,
            };
        }
        return { selection: projectSelection, unavailableProjectModel: projectSelection.model };
    }
    if (projectSelection.kind === "inherit") {
        return { selection: storedSelection.kind === "none" ? projectSelection : storedSelection };
    }
    return { selection: storedSelection };
}
export function rerouteUnavailableStaffTargets(input, staffAgent, availableModels, currentProvider, storedOverride, projectOverride, onDowngrade) {
    if (!isRecord(input) || typeof input.action === "string")
        return;
    const candidates = [input, ...(Array.isArray(input.tasks) ? input.tasks : [])].filter((target) => isRecord(target) && isStaffDeveloperTarget(target.agent));
    if (candidates.length === 0)
        return;
    const currentProviderLabel = currentProvider ?? "the current provider";
    for (const target of candidates) {
        const { selection, unavailableProjectModel } = effectiveStaffModelSelection(target, availableModels, storedOverride, projectOverride);
        const bundledModel = declaredStaffModelForProvider(staffAgent, currentProvider);
        const resolvedBundledModel = bundledModel
            ? findAvailableProviderModel(availableModels, bundledModel)
            : undefined;
        if (selection.kind === "model" &&
            findAvailableProviderModel(availableModels, selection.model)) {
            continue;
        }
        if (selection.kind === "none" && resolvedBundledModel)
            continue;
        const reason = selection.kind === "inherit"
            ? `effective staff-developer model selection requests the current session model instead of a resolvable staff-developer model${unavailableProjectModel ? ` after project model '${unavailableProjectModel}' was unavailable` : ""}`
            : selection.kind === "model"
                ? `configured staff-developer model override '${selection.model}' is unavailable in the runtime model registry${unavailableProjectModel && unavailableProjectModel !== selection.model ? ` after project model '${unavailableProjectModel}' was unavailable` : ""}`
                : currentProvider?.trim().toLowerCase() === "openrouter"
                    ? "OpenRouter requires an explicit resolvable staff-developer model override"
                    : bundledModel
                        ? `bundled staff-developer model '${bundledModel}' is unavailable in the runtime model registry for ${currentProviderLabel}`
                        : `no bundled staff-developer model is declared for ${currentProviderLabel}`;
        const unavailableModel = selection.kind === "model"
            ? selection.model
            : selection.kind === "inherit"
                ? unavailableProjectModel
                : bundledModel;
        target.agent = "developer";
        removeStaffDispatchOverrides(target);
        onDowngrade(unavailableModel, reason);
    }
}
