import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./common.js";
import { backfillMissingBaselines, computeModelEffortDrift, isKnownProvider, readReconcileState, } from "./model-effort-reconcile.js";
import { loadPrimaryAgents, loadSubagentMetadata } from "./prompts.js";
let notifiedThisProcess = false;
function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
export function hasAnyModelEffortOverride(settings) {
    const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
    if (isRecord(primaryModelOverrides)) {
        for (const overrideValue of Object.values(primaryModelOverrides)) {
            if (typeof overrideValue === "string" && overrideValue) {
                return true;
            }
        }
    }
    const subagentOverrides = settings.subagents?.agentOverrides;
    if (isRecord(subagentOverrides)) {
        for (const rawOverride of Object.values(subagentOverrides)) {
            if (!isRecord(rawOverride)) {
                continue;
            }
            const rawModel = rawOverride.model;
            const rawThinking = rawOverride.thinking;
            const hasModel = typeof rawModel === "string" || rawModel === false;
            const hasThinking = typeof rawThinking === "string" || rawThinking === false;
            if (hasModel || hasThinking) {
                return true;
            }
        }
    }
    return false;
}
export function getChangedOverriddenRoles(primaryAgents, subagentMetadata, settings, provider, acknowledgedSnapshot) {
    const drift = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, provider, acknowledgedSnapshot);
    return drift.filter((entry) => entry.packagedDefaultsChanged).map((entry) => entry.name);
}
export function buildModelEffortNoticeMessage(roleNames) {
    const roles = roleNames.join(", ");
    return `TLH default model/effort changed for ${roles} — run /reconcile to review`;
}
const defaultHooks = {
    shouldSkip: () => false,
    loadPrimaryAgents,
    loadSubagentMetadata,
};
let hooks = defaultHooks;
export function maybeNotifyModelEffortDrift(ctx) {
    try {
        if (!ctx.hasUI || hooks.shouldSkip()) {
            return;
        }
        if (notifiedThisProcess) {
            return;
        }
        if (!isKnownProvider(ctx.model?.provider)) {
            return;
        }
        const settings = getTlhGlobalSettings(ctx.cwd);
        if (!hasAnyModelEffortOverride(settings)) {
            return;
        }
        const primaryAgents = hooks.loadPrimaryAgents();
        const subagentMetadata = hooks.loadSubagentMetadata();
        const reconcileState = readReconcileState();
        const activeSnapshot = backfillMissingBaselines(primaryAgents, subagentMetadata, settings, ctx.model?.provider, reconcileState.acknowledgedSnapshot);
        const changedRoles = getChangedOverriddenRoles(primaryAgents, subagentMetadata, settings, ctx.model?.provider, activeSnapshot);
        if (changedRoles.length === 0) {
            return;
        }
        notifiedThisProcess = true;
        ctx.ui.notify(buildModelEffortNoticeMessage(changedRoles), "warning");
    }
    catch {
    }
}
export function __setModelEffortNoticeTestHooks(overrides = {}) {
    hooks = { ...defaultHooks, ...overrides };
}
export function __resetModelEffortNoticeForTests() {
    hooks = defaultHooks;
    notifiedThisProcess = false;
}
