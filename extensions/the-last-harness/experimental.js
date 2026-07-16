import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeEnabledExperimentalFeatures, normalizeExperimentalFeatureId, readEnabledExperimentalFeatures, } from "../the-last-harness-subagent-safety.mjs";
export const DELTA_FOLLOW_UP_REVIEWS_FEATURE = "delta-follow-up-reviews";
export const CI_FAILURE_INVESTIGATION_FEATURE = "ci-failure-investigation";
export const TICKET_WORKFLOW_UI_FEATURE = "ticket-workflow-ui";
export const EMBEDDED_SUBAGENTS_FEATURE = "embedded-subagents";
export const TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT = "tlh:experimental-feature-changed";
export const EXPERIMENTAL_COMMAND_HELP = [
    "Usage: /experimental [list|status [feature]|enable <feature>|disable <feature>|toggle <feature>]",
    "With no argument, /experimental opens the TLH experimental feature picker when UI is available, otherwise it lists feature status.",
].join(" ");
const DELTA_FOLLOW_UP_REVIEWS_ARCHITECT_PROMPT = `
## TLH Experimental Feature: delta-follow-up-reviews

This TLH experiment is enabled for the architect primary agent.

When a \`code-reviewer\` finding leads to a developer fix round:

1. Default the follow-up \`code-reviewer\` request to the delta since the last reviewed checkpoint instead of rereading the full branch diff.
2. In every follow-up review request, pass the prior findings plus the exact delta baseline, git range or checkpoint, or explicit changed-file list to review.
3. Keep or expand to targeted wider review or full re-review for installer or other destructive-path changes, trust-boundary changes, auth or execution changes, unresolved reviewer disagreement, or whenever the delta cannot be validated safely without wider context.
`;
const DELTA_FOLLOW_UP_REVIEWS_CODE_REVIEWER_PROMPT = `
## TLH Experimental Feature: delta-follow-up-reviews

This TLH experiment is enabled for the \`code-reviewer\` child agent.

For follow-up review after fixes:

1. Expect prior findings plus an exact delta baseline, git range or checkpoint, or explicit changed-file list from the delegating primary agent. Do not assume every follow-up review includes the full branch diff.
2. Default to the requested delta and prior findings: verify the reported fixes, check touched areas for regressions, and avoid rereading the full branch diff unless wider context is needed.
3. You may read adjacent code or other targeted context when needed for safety or correctness, and should widen to targeted or full re-review for installer or other destructive-path changes, trust-boundary changes, auth or execution changes, unresolved reviewer disagreement, or whenever the requested delta cannot be validated safely without wider context.
`;
const CI_FAILURE_INVESTIGATION_ARCHITECT_PROMPT = `
## TLH Experimental Feature: ci-failure-investigation

This TLH experiment is enabled for the architect primary agent.

This experiment overrides the default post-PR monitor-and-ask-only step for this specific case.

After TLH opens a PR and CI/status checks fail:

1. You may do a read-only investigation before asking the user whether to proceed.
2. Keep that investigation read-only: inspect failed checks, logs, workflow/config files, diffs, and relevant code or tests as needed to understand the failure.
3. Do not edit files, commit, push, rerun jobs, change the PR, or take any other follow-up action during this investigation.
4. After the investigation, summarize the failure and likely cause, then ask the user whether to proceed.
5. Before any edits, commits, pushes, reruns, PR changes, or other follow-up changes, ask for explicit user approval.
`;
export const TLH_EXPERIMENTAL_FEATURES = [
    {
        id: DELTA_FOLLOW_UP_REVIEWS_FEATURE,
        description: "Architect and code-reviewer guidance to scope follow-up reviews to a requested delta after fixes.",
        primaryAgentPrompts: {
            architect: DELTA_FOLLOW_UP_REVIEWS_ARCHITECT_PROMPT.trim(),
        },
        codeReviewerPrompt: DELTA_FOLLOW_UP_REVIEWS_CODE_REVIEWER_PROMPT.trim(),
    },
    {
        id: CI_FAILURE_INVESTIGATION_FEATURE,
        description: "Architect-only guidance to perform read-only PR CI/status-check investigation before asking whether to proceed.",
        primaryAgentPrompts: {
            architect: CI_FAILURE_INVESTIGATION_ARCHITECT_PROMPT.trim(),
        },
    },
    {
        id: TICKET_WORKFLOW_UI_FEATURE,
        description: "Enables the experimental ticket workflow UI as a read-only tk-backed surface.",
    },
    {
        id: EMBEDDED_SUBAGENTS_FEATURE,
        description: "Gates architect-only delegation to trusted user-owned embedded.<slug> subagents.",
    },
];
const TLH_EXPERIMENTAL_FEATURES_BY_ID = new Map(TLH_EXPERIMENTAL_FEATURES.map((feature) => [feature.id, feature]));
export function hasRegisteredExperimentalFeatures() {
    return TLH_EXPERIMENTAL_FEATURES.length > 0;
}
export function availableExperimentalFeatureList() {
    return hasRegisteredExperimentalFeatures() ? TLH_EXPERIMENTAL_FEATURES.map((feature) => feature.id).join(", ") : "none currently registered";
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
    return Object.fromEntries(TLH_EXPERIMENTAL_FEATURES.map((feature) => [telemetryExperimentalFeatureKey(feature.id), enabledFeatures.has(feature.id) ? "on" : "off"]));
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
    if (parts.length === 2 && (parts[0] === "enable" || parts[0] === "disable" || parts[0] === "toggle")) {
        return { type: parts[0], featureId: parts[1] };
    }
    return undefined;
}
export const EXPERIMENTAL_COMMAND_COMPLETIONS = [
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
function createRetryableLazyImport(loader) {
    let modulePromise;
    return () => {
        if (!modulePromise) {
            modulePromise = loader().catch((error) => {
                modulePromise = undefined;
                throw error;
            });
        }
        return modulePromise;
    };
}
export function registerExperimentalCommand(pi, options = {}) {
    const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./experimental-command.js")));
    pi.registerCommand("experimental", {
        description: "List or change TLH experimental features",
        getArgumentCompletions: (prefix) => {
            const normalizedPrefix = prefix.trim().toLowerCase();
            const completions = EXPERIMENTAL_COMMAND_COMPLETIONS
                .filter((option) => option.value.startsWith(normalizedPrefix))
                .map((option) => ({ value: option.value, label: option.value, description: option.description }));
            return completions.length > 0 ? completions : null;
        },
        handler: async (args, ctx) => {
            const module = await loadModule();
            await module.handleExperimentalCommand(pi, args, ctx);
        },
    });
}
