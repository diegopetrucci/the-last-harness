import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	normalizeEnabledExperimentalFeatures,
	normalizeExperimentalFeatureId,
	readEnabledExperimentalFeatures,
} from "../the-last-harness-subagent-safety.mjs";
import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { AgentPrompt, TlhExperimentalConfig, TlhExperimentalFeatureId, TlhSettings } from "./types.js";

export const DELTA_FOLLOW_UP_REVIEWS_FEATURE: TlhExperimentalFeatureId = "delta-follow-up-reviews";
export const CI_FAILURE_INVESTIGATION_FEATURE: TlhExperimentalFeatureId = "ci-failure-investigation";
export const TICKET_WORKFLOW_UI_FEATURE: TlhExperimentalFeatureId = "ticket-workflow-ui";
export const EMBEDDED_SUBAGENTS_FEATURE: TlhExperimentalFeatureId = "embedded-subagents";
export const TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT = "tlh:experimental-feature-changed";

const EXPERIMENTAL_COMMAND_HELP = [
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

type TlhExperimentalFeature = {
	id: TlhExperimentalFeatureId;
	description: string;
	primaryAgentPrompt?: string;
	primaryAgentPrompts?: Partial<Record<string, string>>;
	codeReviewerPrompt?: string;
};

type TlhExperimentalSlashAction =
	| { type: "picker" }
	| { type: "list" }
	| { type: "status"; featureId?: string }
	| { type: "enable" | "disable" | "toggle"; featureId: string };

type TlhExperimentalWriteResult = {
	changed: boolean;
	settingsPath: string;
	backupPath?: string;
	enabled: boolean;
};

const TLH_EXPERIMENTAL_FEATURES: TlhExperimentalFeature[] = [
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

function hasRegisteredExperimentalFeatures(): boolean {
	return TLH_EXPERIMENTAL_FEATURES.length > 0;
}

function availableExperimentalFeatureList(): string {
	return hasRegisteredExperimentalFeatures() ? TLH_EXPERIMENTAL_FEATURES.map((feature) => feature.id).join(", ") : "none currently registered";
}

function noExperimentalFeaturesMessage(): string {
	return "TLH experimental features: none currently registered. Future TLH feature flags will appear here when available.";
}

function unknownExperimentalFeatureMessage(featureId: string): string {
	const base = `Unknown TLH experimental feature "${featureId}".`;
	return hasRegisteredExperimentalFeatures()
		? `${base} Available: ${availableExperimentalFeatureList()}.`
		: `${base} ${noExperimentalFeaturesMessage()}`;
}

function validateTlhExperimentalSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isRecord(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isRecord(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const experimental = isRecord(tlh) ? tlh.experimental : undefined;
	if (experimental !== undefined && !isRecord(experimental)) {
		throw new Error("settings field 'tlh.experimental' must be an object if present");
	}
	const enabledFeatures = isRecord(experimental) ? experimental.enabledFeatures : undefined;
	if (enabledFeatures !== undefined && !Array.isArray(enabledFeatures)) {
		throw new Error("settings field 'tlh.experimental.enabledFeatures' must be an array if present");
	}
	if (Array.isArray(enabledFeatures) && enabledFeatures.some((feature) => typeof feature !== "string")) {
		throw new Error("settings field 'tlh.experimental.enabledFeatures' must contain only strings");
	}
}

function parseTlhSettingsContent(content: string | undefined): TlhSettings {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content) as unknown;
	validateTlhExperimentalSettings(parsed);
	return parsed;
}

function ensureMutableExperimentalSettings(settings: TlhSettings): asserts settings is TlhSettings & {
	tlh: { experimental: TlhExperimentalConfig };
} {
	validateTlhExperimentalSettings(settings);
	settings.tlh ??= {};
	settings.tlh.experimental ??= {};
}

function normalizeEnabledFeatures(enabledFeatures: string[] | undefined): string[] {
	return normalizeEnabledExperimentalFeatures(enabledFeatures) as string[];
}

function readEnabledFeatures(config: unknown): string[] {
	return readEnabledExperimentalFeatures(config) as string[];
}

function getExperimentalFeature(featureId: string): TlhExperimentalFeature | undefined {
	const normalized = normalizeExperimentalFeatureId(featureId) as string | undefined;
	return normalized ? TLH_EXPERIMENTAL_FEATURES_BY_ID.get(normalized) : undefined;
}

function enabledExperimentalPrompts(
	config: TlhExperimentalConfig | undefined,
	promptKey: "primaryAgentPrompt" | "codeReviewerPrompt",
): string[] {
	return TLH_EXPERIMENTAL_FEATURES.filter((feature) => isTlhExperimentalFeatureEnabled(config, feature.id))
		.map((feature) => feature[promptKey])
		.filter((prompt): prompt is string => Boolean(prompt));
}

function enabledPrimaryExperimentalPrompts(primary: AgentPrompt, config: TlhExperimentalConfig | undefined): string[] {
	return TLH_EXPERIMENTAL_FEATURES.filter((feature) => isTlhExperimentalFeatureEnabled(config, feature.id))
		.map((feature) => feature.primaryAgentPrompts?.[primary.name] ?? feature.primaryAgentPrompt)
		.filter((prompt): prompt is string => Boolean(prompt));
}

export function getTlhExperimentalConfig(cwd: string): TlhExperimentalConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.experimental;
	} catch {
		return undefined;
	}
}

export function isTlhExperimentalFeatureEnabled(config: unknown, featureId: TlhExperimentalFeatureId): boolean {
	const feature = getExperimentalFeature(featureId);
	return feature ? readEnabledFeatures(config).includes(feature.id) : false;
}

function parseExperimentalSlashAction(args: string): TlhExperimentalSlashAction | undefined {
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

function experimentalCommandCompletions(prefix: string) {
	const options = [
		{ value: "list", description: "List TLH experimental features" },
		{ value: "status", description: "Show TLH experimental feature status" },
		...TLH_EXPERIMENTAL_FEATURES.flatMap((feature) => [
			{ value: `status ${feature.id}`, description: `Show status for ${feature.id}` },
			{ value: `enable ${feature.id}`, description: `Enable ${feature.id}` },
			{ value: `disable ${feature.id}`, description: `Disable ${feature.id}` },
			{ value: `toggle ${feature.id}`, description: `Toggle ${feature.id}` },
		]),
	];
	const normalizedPrefix = prefix.trim().toLowerCase();
	const completions = options
		.filter((option) => option.value.startsWith(normalizedPrefix))
		.map((option) => ({ value: option.value, label: option.value, description: option.description }));
	return completions.length > 0 ? completions : null;
}

function formatExperimentalFeatureStatus(feature: TlhExperimentalFeature, enabled: boolean): string {
	const enabledLabel = enabled ? "enabled" : "disabled (default)";
	const nextStep = enabled
		? `Disable with /experimental disable ${feature.id}.`
		: `Enable with /experimental enable ${feature.id}.`;
	return `- ${feature.id}: ${enabledLabel}. ${feature.description} ${nextStep}`;
}

function formatExperimentalStatusMessage(config: TlhExperimentalConfig | undefined, featureId?: string): string {
	if (featureId) {
		const feature = getExperimentalFeature(featureId);
		if (!feature) {
			return unknownExperimentalFeatureMessage(featureId);
		}
		return formatExperimentalFeatureStatus(feature, isTlhExperimentalFeatureEnabled(config, feature.id));
	}
	if (!hasRegisteredExperimentalFeatures()) {
		return noExperimentalFeaturesMessage();
	}
	return [
		"TLH experimental features:",
		...TLH_EXPERIMENTAL_FEATURES.map((feature) => formatExperimentalFeatureStatus(feature, isTlhExperimentalFeatureEnabled(config, feature.id))),
	].join("\n");
}

function experimentalFeaturePickerOption(feature: TlhExperimentalFeature, enabled: boolean): string {
	const stateLabel = enabled ? "enabled" : "disabled (default)";
	return `${enabled ? "●" : "○"} ${feature.id} — ${stateLabel} — ${feature.description}`;
}

function notifyExperimentalWriteResult(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	featureId: string,
	result: TlhExperimentalWriteResult,
): void {
	const changedLabel = result.changed ? "Updated" : "No change to";
	const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
	const stateLabel = result.enabled ? "enabled" : "disabled";
	const undoLabel = result.enabled ? `Undo with /experimental disable ${featureId}.` : `Undo with /experimental enable ${featureId}.`;
	pi.events?.emit?.(TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT, {
		cwd: ctx.cwd,
		enabled: result.enabled,
		featureId,
	});
	ctx.ui.notify(
		`${changedLabel} TLH experimental feature ${featureId} at ${formatHomePath(result.settingsPath)}. It is now ${stateLabel}. ${undoLabel}${backupLabel}`,
		"info",
	);
}

async function showExperimentalFeaturePicker(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI || !hasRegisteredExperimentalFeatures() || typeof ctx.ui.select !== "function") {
		ctx.ui.notify(formatExperimentalStatusMessage(getTlhExperimentalConfig(ctx.cwd)), "info");
		return;
	}

	while (true) {
		const config = getTlhExperimentalConfig(ctx.cwd);
		const featureIdsByOption = new Map(
			TLH_EXPERIMENTAL_FEATURES.map((feature) => {
				const option = experimentalFeaturePickerOption(feature, isTlhExperimentalFeatureEnabled(config, feature.id));
				return [option, feature.id] as const;
			}),
		);
		const selectedOption = await ctx.ui.select("Toggle TLH experimental features (Esc to close)", [...featureIdsByOption.keys()]);
		if (!selectedOption) {
			return;
		}
		const selectedFeatureId = featureIdsByOption.get(selectedOption);
		if (!selectedFeatureId) {
			ctx.ui.notify("Unknown TLH experimental feature picker selection.", "error");
			return;
		}

		try {
			notifyExperimentalWriteResult(pi, ctx, selectedFeatureId, writeExperimentalFeaturePreference(ctx.cwd, selectedFeatureId, "toggle"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not update TLH experimental feature ${selectedFeatureId}: ${message}`, "error");
		}
	}
}

function nextEnabledState(currentEnabled: boolean, action: "enable" | "disable" | "toggle"): boolean {
	if (action === "enable") return true;
	if (action === "disable") return false;
	return !currentEnabled;
}

function writeExperimentalFeaturePreference(
	cwd: string,
	featureId: string,
	action: "enable" | "disable" | "toggle",
): TlhExperimentalWriteResult {
	const feature = getExperimentalFeature(featureId);
	if (!feature) {
		throw new Error(unknownExperimentalFeatureMessage(featureId));
	}
	return withLockedTlhSettingsWrite(cwd, "Refusing to write experimental settings outside the isolated TLH profile.", (current) => {
		const settings = parseTlhSettingsContent(current);
		const currentEnabledFeatures = normalizeEnabledFeatures(settings.tlh?.experimental?.enabledFeatures);
		const currentEnabled = currentEnabledFeatures.includes(feature.id);
		const enabled = nextEnabledState(currentEnabled, action);
		if (enabled === currentEnabled) {
			return { changed: false, enabled };
		}

		const nextEnabledFeatures = enabled
			? normalizeEnabledFeatures([...currentEnabledFeatures, feature.id])
			: currentEnabledFeatures.filter((currentFeatureId) => currentFeatureId !== feature.id);

		ensureMutableExperimentalSettings(settings);
		settings.tlh.experimental.enabledFeatures = nextEnabledFeatures;
		return {
			changed: true,
			enabled,
			nextContent: `${JSON.stringify(settings, null, 2)}\n`,
		};
	});
}

export function buildPrimaryExperimentalPrompt(
	primary: AgentPrompt | undefined,
	config: TlhExperimentalConfig | undefined,
): string | undefined {
	if (!primary) {
		return undefined;
	}
	return enabledPrimaryExperimentalPrompts(primary, config).join("\n\n") || undefined;
}

export function buildChildExperimentalPrompt(
	childAgentName: string | undefined,
	config: TlhExperimentalConfig | undefined,
): string | undefined {
	if (childAgentName?.trim().toLowerCase() !== "code-reviewer") {
		return undefined;
	}
	return enabledExperimentalPrompts(config, "codeReviewerPrompt").join("\n\n") || undefined;
}

export function registerExperimentalCommand(pi: ExtensionAPI): void {
	pi.registerCommand("experimental", {
		description: "List or change TLH experimental features",
		getArgumentCompletions: experimentalCommandCompletions,
		handler: async (args, ctx) => {
			const command = parseExperimentalSlashAction(args);
			if (!command) {
				ctx.ui.notify(`${EXPERIMENTAL_COMMAND_HELP} Available: ${availableExperimentalFeatureList()}.`, "error");
				return;
			}

			if (command.type === "picker") {
				await showExperimentalFeaturePicker(pi, ctx);
				return;
			}

			if (command.type === "list" || command.type === "status") {
				const featureId = command.type === "status" ? command.featureId : undefined;
				ctx.ui.notify(formatExperimentalStatusMessage(getTlhExperimentalConfig(ctx.cwd), featureId), "info");
				return;
			}

			try {
				notifyExperimentalWriteResult(pi, ctx, command.featureId, writeExperimentalFeaturePreference(ctx.cwd, command.featureId, command.type));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update TLH experimental feature ${command.featureId}: ${message}`, "error");
			}
		},
	});
}
