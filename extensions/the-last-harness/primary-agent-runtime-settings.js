import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { DISABLED_PRIMARY_AGENT, PRIMARY_AGENT_CYCLE } from "../the-last-harness-primary-agent.mjs";
import { isThinkingLevel } from "./thinking.js";
export function defaultProjectTrustForCwd(cwd) {
    try {
        const value = SettingsManager.create(cwd, getAgentDir(), {
            projectTrusted: false,
        }).getDefaultProjectTrust();
        return value === "always" || value === "never" ? value : "ask";
    }
    catch {
        return "ask";
    }
}
export function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
export function getTlhPrimaryAgentConfig(cwd) {
    return getTlhGlobalSettings(cwd).tlh?.primaryAgent;
}
export function getTlhDurableThinkingLevel(cwd) {
    const level = getTlhGlobalSettings(cwd).defaultThinkingLevel;
    return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
}
export function getTlhSubagentOverrides(cwd) {
    const overrides = getTlhGlobalSettings(cwd).subagents?.agentOverrides;
    if (!isRecord(overrides)) {
        return new Map();
    }
    return new Map(Object.entries(overrides)
        .filter(([, value]) => isRecord(value))
        .map(([agent, value]) => [agent, value]));
}
export function resolvePrimaryAutoApplySetting(primaryConfig, primary, key) {
    const configured = primaryConfig?.[key];
    if (typeof configured === "boolean") {
        return configured;
    }
    return primary[key] === true;
}
export function parseTlhSettingsContent(content) {
    if (!content) {
        return {};
    }
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
        throw new Error("settings.json must contain a JSON object");
    }
    return parsed;
}
function prepareTlhPrimaryAgentSettings(content, invalidTlhMessage, invalidPrimaryAgentMessage) {
    const settings = parseTlhSettingsContent(content);
    const rawTlh = settings.tlh;
    let tlh;
    if (rawTlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
    }
    else if (isRecord(rawTlh)) {
        tlh = rawTlh;
    }
    else {
        throw new Error(invalidTlhMessage);
    }
    const rawPrimaryAgent = tlh.primaryAgent;
    let primaryAgent;
    if (rawPrimaryAgent === undefined) {
        primaryAgent = {};
        tlh.primaryAgent = primaryAgent;
    }
    else if (isRecord(rawPrimaryAgent)) {
        primaryAgent = rawPrimaryAgent;
    }
    else {
        throw new Error(invalidPrimaryAgentMessage);
    }
    return { settings, primaryAgent };
}
export function writeTlhPrimaryAgentModelOverride(cwd, primary, modelKey) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write model-override settings outside the isolated TLH profile.", (current) => {
        const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(current, "settings.tlh must be an object to update model-override settings.", "settings.tlh.primaryAgent must be an object to update model-override settings.");
        const rawModelOverrides = primaryAgent.modelOverrides;
        let modelOverrides;
        if (rawModelOverrides === undefined) {
            modelOverrides = {};
            primaryAgent.modelOverrides = modelOverrides;
        }
        else if (isRecord(rawModelOverrides)) {
            modelOverrides = rawModelOverrides;
        }
        else {
            throw new Error("settings.tlh.primaryAgent.modelOverrides must be an object.");
        }
        const existingOverride = modelOverrides[primary];
        if (modelKey === undefined) {
            if (!Object.hasOwn(modelOverrides, primary)) {
                return { changed: false };
            }
            delete modelOverrides[primary];
        }
        else {
            if (existingOverride === modelKey) {
                return { changed: false };
            }
            modelOverrides[primary] = modelKey;
        }
        if (Object.keys(modelOverrides).length === 0) {
            delete primaryAgent.modelOverrides;
        }
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
export function writeTlhPrimaryAgentDefault(cwd, selection) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write primary-agent settings outside the isolated TLH profile.", (current) => {
        const { settings, primaryAgent } = prepareTlhPrimaryAgentSettings(current, "settings.tlh must be an object to update primary-agent settings.", "settings.tlh.primaryAgent must be an object to update primary-agent defaults.");
        let changed = false;
        const setField = (key, value) => {
            if (value === undefined) {
                if (Object.hasOwn(primaryAgent, key)) {
                    delete primaryAgent[key];
                    changed = true;
                }
                return;
            }
            if (primaryAgent[key] !== value) {
                primaryAgent[key] = value;
                changed = true;
            }
        };
        if (selection === undefined) {
            setField("enabled", undefined);
            setField("selected", undefined);
        }
        else if (selection === DISABLED_PRIMARY_AGENT) {
            setField("enabled", false);
            setField("selected", DISABLED_PRIMARY_AGENT);
        }
        else {
            setField("enabled", true);
            setField("selected", selection);
        }
        if (!changed) {
            return { changed: false };
        }
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
export function isTlhPrimaryAgentSelection(value) {
    return PRIMARY_AGENT_CYCLE.includes(value);
}
export function clearPrimaryAgentModelOverrideByName(cwd, agentName) {
    if (!isTlhPrimaryAgentSelection(agentName)) {
        return undefined;
    }
    return writeTlhPrimaryAgentModelOverride(cwd, agentName, undefined);
}
