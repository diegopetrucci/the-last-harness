import { isRecord, readText } from "./common.js";
import { formatProviderModelReference, parseProviderModelReference, selectProviderAwareAgentDefaults, splitKnownThinkingSuffix, } from "./model-defaults.js";
import { tlhStatePath, writeGuardedTlhStateFile } from "./profile-state.js";
export function tlhReconcileStatePath() {
    return tlhStatePath("reconcile-state.json");
}
function sanitizeAcknowledgedSnapshot(raw) {
    const rawSnapshot = raw.acknowledgedSnapshot;
    if (rawSnapshot === undefined) {
        return undefined;
    }
    if (!isRecord(rawSnapshot)) {
        return undefined;
    }
    const result = {};
    for (const [name, entry] of Object.entries(rawSnapshot)) {
        if (!isRecord(entry)) {
            continue;
        }
        const rawByProvider = entry.byProvider;
        if (rawByProvider === undefined) {
            result[name] = entry;
            continue;
        }
        if (!isRecord(rawByProvider)) {
            const { byProvider: _, ...rest } = entry;
            result[name] = rest;
            continue;
        }
        const sanitizedByProvider = {};
        for (const [provider, ack] of Object.entries(rawByProvider)) {
            if (!isRecord(ack)) {
                continue;
            }
            const sanitizedAck = { ...ack };
            if (sanitizedAck.model !== undefined && typeof sanitizedAck.model !== "string") {
                delete sanitizedAck.model;
            }
            if (sanitizedAck.thinking !== undefined && typeof sanitizedAck.thinking !== "string") {
                delete sanitizedAck.thinking;
            }
            sanitizedByProvider[provider] = sanitizedAck;
        }
        result[name] = { ...entry, byProvider: sanitizedByProvider };
    }
    return result;
}
export function readReconcileState() {
    const statePath = tlhReconcileStatePath();
    const content = statePath ? readText(statePath) : undefined;
    if (!content) {
        return {};
    }
    try {
        const parsed = JSON.parse(content);
        if (!isRecord(parsed)) {
            return {};
        }
        return {
            ...parsed,
            acknowledgedSnapshot: sanitizeAcknowledgedSnapshot(parsed),
        };
    }
    catch {
        return {};
    }
}
export function writeReconcileState(state) {
    try {
        const statePath = tlhReconcileStatePath();
        if (!statePath) {
            return false;
        }
        return writeGuardedTlhStateFile(statePath, `${JSON.stringify(state, null, 2)}\n`, tlhReconcileStatePath);
    }
    catch {
        return false;
    }
}
export function updateReconcileAcknowledgedSnapshot(snapshot, lastDecisionAt) {
    const current = readReconcileState();
    const merged = { ...(current.acknowledgedSnapshot ?? {}) };
    for (const [name, incoming] of Object.entries(snapshot)) {
        const existing = merged[name];
        if (existing != null && incoming.byProvider != null) {
            merged[name] = {
                ...existing,
                byProvider: { ...(existing.byProvider ?? {}), ...incoming.byProvider },
            };
        }
        else {
            merged[name] = incoming;
        }
    }
    return writeReconcileState({
        ...current,
        acknowledgedSnapshot: merged,
        ...(lastDecisionAt !== undefined ? { lastDecisionAt } : {}),
    });
}
function packagedCandidateModels(agent) {
    const seen = new Map();
    for (const raw of [agent.model, ...(agent.tlhOpenaiModels ?? []), ...(agent.tlhAnthropicModels ?? [])]) {
        const parsed = parseProviderModelReference(splitKnownThinkingSuffix(raw).baseModel);
        if (!parsed) {
            continue;
        }
        const key = formatProviderModelReference(parsed);
        if (!seen.has(key)) {
            seen.set(key, parsed);
        }
    }
    return [...seen.values()];
}
function resolvePackagedDefaults(agent, provider) {
    if (!agent) {
        return {};
    }
    const defaults = selectProviderAwareAgentDefaults(agent, packagedCandidateModels(agent), provider);
    return {
        model: defaults.model ? formatProviderModelReference(defaults.model) : undefined,
        thinking: defaults.thinking,
    };
}
export function computeModelEffortDrift(primaryAgents, subagentMetadata, settings, currentProvider, acknowledgedSnapshot) {
    const drift = [];
    const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
    if (isRecord(primaryModelOverrides)) {
        for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
            if (typeof overrideValue !== "string" || !overrideValue) {
                continue;
            }
            const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
            const providerKey = currentProvider ?? "";
            const providerEntry = acknowledgedSnapshot?.[name]?.byProvider?.[providerKey];
            const packagedDefaultsChanged = providerEntry !== undefined &&
                (providerEntry.model !== packaged.model || providerEntry.thinking !== packaged.thinking);
            drift.push({
                role: "primary",
                name,
                override: { model: overrideValue },
                packaged,
                packagedDefaultsChanged,
            });
        }
    }
    const subagentOverrides = settings.subagents?.agentOverrides;
    if (isRecord(subagentOverrides)) {
        const subagentMap = new Map(subagentMetadata.map((s) => [s.name, s]));
        for (const [name, rawOverride] of Object.entries(subagentOverrides)) {
            if (!isRecord(rawOverride)) {
                continue;
            }
            const rawModel = rawOverride.model;
            const rawThinking = rawOverride.thinking;
            const model = rawModel === undefined || typeof rawModel === "string" || rawModel === false
                ? rawModel
                : undefined;
            const thinking = rawThinking === undefined || typeof rawThinking === "string" || rawThinking === false
                ? rawThinking
                : undefined;
            if (model === undefined && thinking === undefined) {
                continue;
            }
            const packaged = resolvePackagedDefaults(subagentMap.get(name), currentProvider);
            const providerKey = currentProvider ?? "";
            const providerEntry = acknowledgedSnapshot?.[name]?.byProvider?.[providerKey];
            const packagedDefaultsChanged = providerEntry !== undefined &&
                (providerEntry.model !== packaged.model || providerEntry.thinking !== packaged.thinking);
            const overrideEntry = {};
            if (model !== undefined) {
                overrideEntry.model = model;
            }
            if (thinking !== undefined) {
                overrideEntry.thinking = thinking;
            }
            drift.push({
                role: "subagent",
                name,
                override: overrideEntry,
                packaged,
                packagedDefaultsChanged,
            });
        }
    }
    return drift;
}
