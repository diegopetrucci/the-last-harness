import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	CONTRARIAN_EXPERIMENTAL_FEATURE,
	normalizeEnabledExperimentalFeatures,
	normalizeExperimentalFeatureId,
	readEnabledExperimentalFeatures,
} from "../the-last-harness-subagent-safety.mjs";
import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { AgentPrompt, TlhExperimentalConfig, TlhExperimentalFeatureId, TlhSettings } from "./types.js";

export const TLH_CONTRARIAN_FEATURE: TlhExperimentalFeatureId = CONTRARIAN_EXPERIMENTAL_FEATURE;
export const DELTA_FOLLOW_UP_REVIEWS_FEATURE: TlhExperimentalFeatureId = "delta-follow-up-reviews";

const EXPERIMENTAL_COMMAND_HELP = [
	"Usage: /experimental [list|status [feature]|enable <feature>|disable <feature>|toggle <feature>]",
	"With no argument, /experimental lists TLH experimental features.",
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

const CONTRARIAN_ARCHITECT_PROMPT = `
## TLH Experimental Feature: contrarian

This TLH experiment enables the \`contrarian\` minor agent for the architect primary agent.

Additional minor agent:
- \`contrarian\`: adversarially stress-test plans, designs, assumptions, product directions, bug hypotheses, or review conclusions by steelmanning the strongest opposing case.

Use \`contrarian\` sparingly when you need an adversarial challenge pass on reasoning or direction. It is not the normal diff reviewer — \`code-reviewer\` owns review against tasks and diffs — and it is narrower than \`oracle\`, which provides a broader high-reasoning second opinion.

Pre-ticket planning is the primary useful moment for \`contrarian\`. Apply a similarly sparing bar to \`contrarian\` as to \`oracle\`: consider it before ticket creation only when a proposed change has meaningful uncertainty, tradeoffs, blast radius, a hard-to-undo direction, or debatable assumptions, and name the specific risk or strongest opposing case you want stress-tested. Unlike \`oracle\`, \`contrarian\` should focus on the strongest credible opposition brief rather than a broad second opinion. Do not use \`contrarian\` as the normal diff reviewer or as an automatic step for routine localized work; use it sparingly.
`;

const CONTRARIAN_RUSH_PROMPT = `
## TLH Experimental Feature: contrarian

This TLH experiment enables the \`contrarian\` minor agent for TLH Rush.

Additional minor agent:
- \`contrarian\` only when a plan, bug hypothesis, or review conclusion needs an adversarial stress-test. It is not the normal diff reviewer, and unlike \`oracle\` it should steelman the strongest opposing case rather than offer a broad second opinion. Use it sparingly rather than as a routine extra pass.
`;

const CONTRARIAN_PRODUCT_PROMPT = `
## TLH Experimental Feature: contrarian

This TLH experiment enables the \`contrarian\` minor agent for the product primary agent.

Additional minor agent:
- \`contrarian\` for sparing adversarial stress-tests of product directions, tradeoffs, assumptions, or ticket framing by steelmanning the strongest opposing case. It is not code review — \`code-reviewer\` reviews diffs against tasks — and it is narrower than \`oracle\`, which is the broader second-opinion path.
`;

const CONTRARIAN_BUG_HUNTER_PROMPT = `
## TLH Experimental Feature: contrarian

This TLH experiment enables the \`contrarian\` minor agent for the bug-hunter primary agent.

Additional minor agent:
- \`contrarian\`: adversarially stress-test bug hypotheses or review conclusions by steelmanning the strongest opposing case. Use it sparingly when you need to challenge your diagnosis; it does not replace \`code-reviewer\`, which reviews code changes, or \`oracle\`, which gives a broader second opinion.
`;

type TlhExperimentalFeature = {
	id: TlhExperimentalFeatureId;
	description: string;
	primaryAgentPrompt?: string;
	primaryAgentPrompts?: Partial<Record<string, string>>;
	codeReviewerPrompt?: string;
};

type TlhExperimentalSlashAction =
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
		id: TLH_CONTRARIAN_FEATURE,
		description: "Enables the contrarian minor agent and primary-agent guidance for sparing adversarial challenge passes.",
		primaryAgentPrompts: {
			architect: CONTRARIAN_ARCHITECT_PROMPT.trim(),
			rush: CONTRARIAN_RUSH_PROMPT.trim(),
			product: CONTRARIAN_PRODUCT_PROMPT.trim(),
			"bug-hunter": CONTRARIAN_BUG_HUNTER_PROMPT.trim(),
		},
	},
	{
		id: DELTA_FOLLOW_UP_REVIEWS_FEATURE,
		description: "Architect and code-reviewer guidance to scope follow-up reviews to a requested delta after fixes.",
		primaryAgentPrompts: {
			architect: DELTA_FOLLOW_UP_REVIEWS_ARCHITECT_PROMPT.trim(),
		},
		codeReviewerPrompt: DELTA_FOLLOW_UP_REVIEWS_CODE_REVIEWER_PROMPT.trim(),
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
	if (parts.length === 0 || parts[0] === "list") {
		return parts.length === 0 || parts.length === 1 ? { type: "list" } : undefined;
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

			if (command.type === "list" || command.type === "status") {
				const featureId = command.type === "status" ? command.featureId : undefined;
				ctx.ui.notify(formatExperimentalStatusMessage(getTlhExperimentalConfig(ctx.cwd), featureId), "info");
				return;
			}

			try {
				const result = writeExperimentalFeaturePreference(ctx.cwd, command.featureId, command.type);
				const changedLabel = result.changed ? "Updated" : "No change to";
				const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
				const stateLabel = result.enabled ? "enabled" : "disabled";
				const undoLabel = result.enabled
					? `Undo with /experimental disable ${command.featureId}.`
					: `Undo with /experimental enable ${command.featureId}.`;
				ctx.ui.notify(
					`${changedLabel} TLH experimental feature ${command.featureId} at ${formatHomePath(result.settingsPath)}. It is now ${stateLabel}. ${undoLabel}${backupLabel}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update TLH experimental feature ${command.featureId}: ${message}`, "error");
			}
		},
	});
}
