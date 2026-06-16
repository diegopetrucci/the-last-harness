import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { AgentPrompt, TlhExperimentalConfig, TlhExperimentalFeatureId, TlhSettings } from "./types.js";

const EXPERIMENTAL_COMMAND_HELP = [
	"Usage: /experimental [list|status [feature]|enable <feature>|disable <feature>|toggle <feature>]",
	"With no argument, /experimental lists TLH experimental features.",
].join(" ");

type TlhExperimentalFeature = {
	id: TlhExperimentalFeatureId;
	description: string;
	primaryAgentPrompt?: string;
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

const TLH_EXPERIMENTAL_FEATURES: TlhExperimentalFeature[] = [];
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
	return [...new Set((enabledFeatures ?? []).map((feature) => feature.trim()).filter(Boolean))].sort();
}

function readEnabledFeatures(config: unknown): string[] {
	if (!isRecord(config)) {
		return [];
	}
	const { enabledFeatures } = config;
	if (enabledFeatures === undefined) {
		return [];
	}
	if (!Array.isArray(enabledFeatures) || enabledFeatures.some((feature) => typeof feature !== "string")) {
		return [];
	}
	return normalizeEnabledFeatures(enabledFeatures);
}

function getExperimentalFeature(featureId: string): TlhExperimentalFeature | undefined {
	const normalized = featureId.trim().toLowerCase();
	return normalized ? TLH_EXPERIMENTAL_FEATURES_BY_ID.get(normalized) : undefined;
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
	if (primary?.name !== "architect") {
		return undefined;
	}
	return (
		TLH_EXPERIMENTAL_FEATURES.filter((feature) => isTlhExperimentalFeatureEnabled(config, feature.id))
			.map((feature) => feature.primaryAgentPrompt)
			.filter(Boolean)
			.join("\n\n") || undefined
	);
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
				ctx.ui.notify(formatExperimentalStatusMessage(getTlhExperimentalConfig(ctx.cwd), command.featureId), "info");
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
