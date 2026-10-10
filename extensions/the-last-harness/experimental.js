import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeEnabledExperimentalFeatures, normalizeExperimentalFeatureId, readEnabledExperimentalFeatures, } from "../the-last-harness-subagent-safety.mjs";
export const SESSION_MIRROR_OBSERVER_FEATURE = "session-mirror-observer";
export const TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT = "tlh:experimental-feature-changed";
export const EXPERIMENTAL_COMMAND_HELP = [
    "Usage: /experimental [list|status [feature]|enable <feature>|disable <feature>|toggle <feature>]",
    "With no argument, /experimental opens the TLH experimental feature picker when UI is available, otherwise it lists feature status.",
].join(" ");
export const TLH_EXPERIMENTAL_FEATURES = [
    {
        id: SESSION_MIRROR_OBSERVER_FEATURE,
        description: "Opt-in iPhone companion session mirroring and replies; a paired companion can submit bounded plain-text user-message replies. Changes take effect on the next session.",
        telemetry: false,
        nextSessionOnly: true,
    },
];
const TLH_EXPERIMENTAL_FEATURES_BY_ID = new Map(TLH_EXPERIMENTAL_FEATURES.map((feature) => [feature.id, feature]));
export function hasRegisteredExperimentalFeatures() {
    return TLH_EXPERIMENTAL_FEATURES.length > 0;
}
export function availableExperimentalFeatureList() {
    return hasRegisteredExperimentalFeatures()
        ? TLH_EXPERIMENTAL_FEATURES.map((feature) => feature.id).join(", ")
        : "none currently registered";
}
export function noExperimentalFeaturesMessage() {
    return "TLH experimental features: none currently registered. Future TLH feature flags will appear here when available.";
}
export function unknownExperimentalFeatureMessage(featureId) {
    const base = `Unknown TLH experimental feature "${featureId}".`;
    return hasRegisteredExperimentalFeatures()
        ? `${base} Available: ${availableExperimentalFeatureList()}.`
        : `${base} ${noExperimentalFeaturesMessage()}`;
}
export function normalizeEnabledFeatures(enabledFeatures) {
    return normalizeEnabledExperimentalFeatures(enabledFeatures);
}
function readEnabledFeatures(config) {
    return readEnabledExperimentalFeatures(config);
}
function telemetryExperimentalFeatureKey(featureId) {
    return `Tlh.Experimental.${featureId}`;
}
export function buildExperimentalFeatureTelemetryPayload(config) {
    const enabledFeatures = new Set(readEnabledFeatures(config));
    return Object.fromEntries(TLH_EXPERIMENTAL_FEATURES.filter((feature) => feature.telemetry !== false).map((feature) => [
        telemetryExperimentalFeatureKey(feature.id),
        enabledFeatures.has(feature.id) ? "on" : "off",
    ]));
}
export function getExperimentalFeature(featureId) {
    const normalized = normalizeExperimentalFeatureId(featureId);
    return normalized ? TLH_EXPERIMENTAL_FEATURES_BY_ID.get(normalized) : undefined;
}
function enabledExperimentalPrompts(config, promptKey) {
    return TLH_EXPERIMENTAL_FEATURES.filter((feature) => isTlhExperimentalFeatureEnabled(config, feature.id))
        .map((feature) => feature[promptKey])
        .filter((prompt) => Boolean(prompt));
}
function enabledPrimaryExperimentalPrompts(primary, config) {
    return TLH_EXPERIMENTAL_FEATURES.filter((feature) => isTlhExperimentalFeatureEnabled(config, feature.id))
        .map((feature) => feature.primaryAgentPrompts?.[primary.name] ?? feature.primaryAgentPrompt)
        .filter((prompt) => Boolean(prompt));
}
export function getTlhExperimentalConfig(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.experimental;
    }
    catch {
        return undefined;
    }
}
export function isTlhExperimentalFeatureEnabled(config, featureId) {
    const feature = getExperimentalFeature(featureId);
    return feature ? readEnabledFeatures(config).includes(feature.id) : false;
}
export function parseExperimentalSlashAction(args) {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return { type: "picker" };
    }
    if (parts[0] === "list") {
        return parts.length === 1 ? { type: "list" } : undefined;
    }
    if (parts[0] === "status") {
        return parts.length <= 2 ? { type: "status", featureId: parts[1] } : undefined;
    }
    if (parts.length === 2 &&
        (parts[0] === "enable" || parts[0] === "disable" || parts[0] === "toggle")) {
        return { type: parts[0], featureId: parts[1] };
    }
    return undefined;
}
const EXPERIMENTAL_COMMAND_COMPLETIONS = [
    { value: "list", description: "List TLH experimental features" },
    { value: "status", description: "Show TLH experimental feature status" },
    ...TLH_EXPERIMENTAL_FEATURES.flatMap((feature) => [
        { value: `status ${feature.id}`, description: `Show status for ${feature.id}` },
        { value: `enable ${feature.id}`, description: `Enable ${feature.id}` },
        { value: `disable ${feature.id}`, description: `Disable ${feature.id}` },
        { value: `toggle ${feature.id}`, description: `Toggle ${feature.id}` },
    ]),
];
export function buildPrimaryExperimentalPrompt(primary, config) {
    if (!primary) {
        return undefined;
    }
    return enabledPrimaryExperimentalPrompts(primary, config).join("\n\n") || undefined;
}
export function buildChildExperimentalPrompt(childAgentName, config) {
    if (childAgentName?.trim().toLowerCase() !== "code-reviewer") {
        return undefined;
    }
    return enabledExperimentalPrompts(config, "codeReviewerPrompt").join("\n\n") || undefined;
}
import { handleExperimentalCommand } from "./experimental-command.js";
export function registerExperimentalCommand(pi) {
    pi.registerCommand("experimental", {
        description: "List or change TLH experimental features",
        getArgumentCompletions: (prefix) => {
            const normalizedPrefix = prefix.trim().toLowerCase();
            const completions = EXPERIMENTAL_COMMAND_COMPLETIONS.filter((option) => option.value.startsWith(normalizedPrefix)).map((option) => ({
                value: option.value,
                label: option.value,
                description: option.description,
            }));
            return completions.length > 0 ? completions : null;
        },
        handler: (args, ctx) => handleExperimentalCommand(pi, args, ctx),
    });
}
