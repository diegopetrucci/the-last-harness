import { isRecord, readText } from "./common.js";
import { formatProviderModelReference, parseProviderModelReference, selectProviderAwareAgentDefaults, splitKnownThinkingSuffix, } from "./model-defaults.js";
import { tlhStatePath, writeGuardedTlhStateFile } from "./profile-state.js";
export function isKnownProvider(provider) {
    return typeof provider === "string" && provider.length > 0;
}
export function isMeaningfulPrimaryOverride(value) {
    return typeof value === "string" && value.length > 0;
}
export function hasMeaningfulSubagentOverride(override) {
    if (!isRecord(override))
        return false;
    const model = override.model;
    const thinking = override.thinking;
    const hasModel = typeof model === "string" || model === false;
    const hasThinking = typeof thinking === "string" || thinking === false;
    return hasModel || hasThinking;
}
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
            continue;
        }
        if (!isRecord(rawByProvider)) {
            const { byProvider: _, ...rest } = entry;
            result[name] = rest;
            continue;
        }
        const sanitizedByProvider = {};
        for (const [provider, ack] of Object.entries(rawByProvider)) {
            if (provider === "") {
                continue;
            }
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
    const merged = {
        ...current.acknowledgedSnapshot,
    };
    for (const [name, incoming] of Object.entries(snapshot)) {
        const existing = merged[name];
        if (existing != null && incoming.byProvider != null) {
            merged[name] = {
                ...existing,
                byProvider: { ...existing.byProvider, ...incoming.byProvider },
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
    for (const raw of [
        agent.model,
        ...(agent.tlhOpenaiModels ?? []),
        ...(agent.tlhAnthropicModels ?? []),
    ]) {
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
function packagedCandidateModelsForProvider(agent, provider) {
    if (provider === undefined) {
        return [];
    }
    return packagedCandidateModels(agent).filter((m) => m.provider === provider);
}
function resolvePackagedDefaults(agent, provider) {
    if (!agent) {
        return {};
    }
    const providerCandidates = packagedCandidateModelsForProvider(agent, provider);
    const defaults = selectProviderAwareAgentDefaults(agent, providerCandidates, provider);
    return {
        model: defaults.model ? formatProviderModelReference(defaults.model) : undefined,
        thinking: defaults.thinking,
    };
}
export function recordOverrideBaseline(agentName, agent, provider) {
    try {
        if (!isKnownProvider(provider)) {
            return;
        }
        const packaged = resolvePackagedDefaults(agent, provider);
        const ack = {};
        if (packaged.model !== undefined) {
            ack.model = packaged.model;
        }
        if (packaged.thinking !== undefined) {
            ack.thinking = packaged.thinking;
        }
        updateReconcileAcknowledgedSnapshot({
            [agentName]: { byProvider: { [provider]: ack } },
        });
    }
    catch {
    }
}
export function backfillMissingBaselines(primaryAgents, subagentMetadata, settings, currentProvider, existingSnapshot) {
    const snapshot = existingSnapshot ?? {};
    try {
        if (!isKnownProvider(currentProvider)) {
            return snapshot;
        }
        const toBackfill = {};
        const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
        if (isRecord(primaryModelOverrides)) {
            for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
                if (!isMeaningfulPrimaryOverride(overrideValue)) {
                    continue;
                }
                if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
                    continue;
                }
                const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
                const ack = {};
                if (packaged.model !== undefined) {
                    ack.model = packaged.model;
                }
                if (packaged.thinking !== undefined) {
                    ack.thinking = packaged.thinking;
                }
                toBackfill[name] = { byProvider: { [currentProvider]: ack } };
            }
        }
        const subagentOverrides = settings.subagents?.agentOverrides;
        if (isRecord(subagentOverrides)) {
            const subagentMap = new Map(subagentMetadata.map((s) => [s.name, s]));
            for (const [name, rawOverride] of Object.entries(subagentOverrides)) {
                if (!hasMeaningfulSubagentOverride(rawOverride)) {
                    continue;
                }
                if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
                    continue;
                }
                const packaged = resolvePackagedDefaults(subagentMap.get(name), currentProvider);
                const ack = {};
                if (packaged.model !== undefined) {
                    ack.model = packaged.model;
                }
                if (packaged.thinking !== undefined) {
                    ack.thinking = packaged.thinking;
                }
                toBackfill[name] = { byProvider: { [currentProvider]: ack } };
            }
        }
        if (Object.keys(toBackfill).length === 0) {
            return snapshot;
        }
        updateReconcileAcknowledgedSnapshot(toBackfill);
        const merged = { ...snapshot };
        for (const [name, incoming] of Object.entries(toBackfill)) {
            const existing = merged[name];
            if (existing != null && incoming.byProvider != null) {
                merged[name] = {
                    ...existing,
                    byProvider: { ...existing.byProvider, ...incoming.byProvider },
                };
            }
            else {
                merged[name] = incoming;
            }
        }
        return merged;
    }
    catch {
        return snapshot;
    }
}
export function computeModelEffortDrift(primaryAgents, subagentMetadata, settings, currentProvider, acknowledgedSnapshot) {
    const drift = [];
    const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
    if (isRecord(primaryModelOverrides)) {
        for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
            if (!isMeaningfulPrimaryOverride(overrideValue)) {
                continue;
            }
            const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
            const providerEntry = isKnownProvider(currentProvider)
                ? acknowledgedSnapshot?.[name]?.byProvider?.[currentProvider]
                : undefined;
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
            const providerEntry = isKnownProvider(currentProvider)
                ? acknowledgedSnapshot?.[name]?.byProvider?.[currentProvider]
                : undefined;
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
