import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import {
	availableExperimentalFeatureList,
	EXPERIMENTAL_COMMAND_COMPLETIONS,
	EXPERIMENTAL_COMMAND_HELP,
	getExperimentalFeature,
	getTlhExperimentalConfig,
	hasRegisteredExperimentalFeatures,
	isTlhExperimentalFeatureEnabled,
	noExperimentalFeaturesMessage,
	normalizeEnabledFeatures,
	parseExperimentalSlashAction,
	TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT,
	TLH_EXPERIMENTAL_FEATURES,
	unknownExperimentalFeatureMessage,
} from "./experimental.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhExperimentalConfig, TlhExperimentalFeatureId, TlhSettings } from "./types.js";

type TlhExperimentalWriteResult = {
	changed: boolean;
	settingsPath: string;
	backupPath?: string;
	enabled: boolean;
};

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

function formatExperimentalFeatureStatus(featureId: TlhExperimentalFeatureId, enabled: boolean): string {
	const feature = getExperimentalFeature(featureId);
	if (!feature) {
		return unknownExperimentalFeatureMessage(featureId);
	}
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
		return formatExperimentalFeatureStatus(feature.id, isTlhExperimentalFeatureEnabled(config, feature.id));
	}
	if (!hasRegisteredExperimentalFeatures()) {
		return noExperimentalFeaturesMessage();
	}
	return [
		"TLH experimental features:",
		...TLH_EXPERIMENTAL_FEATURES.map((feature) =>
			formatExperimentalFeatureStatus(feature.id, isTlhExperimentalFeatureEnabled(config, feature.id)),
		),
	].join("\n");
}

function experimentalFeaturePickerOption(featureId: TlhExperimentalFeatureId, enabled: boolean): string {
	const feature = getExperimentalFeature(featureId);
	if (!feature) {
		return featureId;
	}
	const stateLabel = enabled ? "enabled" : "disabled (default)";
	return `${enabled ? "●" : "○"} ${feature.id} — ${stateLabel} — ${feature.description}`;
}

function notifyExperimentalWriteResult(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	featureId: TlhExperimentalFeatureId,
	result: TlhExperimentalWriteResult,
): void {
	const changedLabel = result.changed ? "Updated" : "No change to";
	const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
	const stateLabel = result.enabled ? "enabled" : "disabled";
	const undoLabel = result.enabled
		? `Undo with /experimental disable ${featureId}.`
		: `Undo with /experimental enable ${featureId}.`;
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
				const option = experimentalFeaturePickerOption(feature.id, isTlhExperimentalFeatureEnabled(config, feature.id));
				return [option, feature.id] as const;
			}),
		);
		const selectedOption = await ctx.ui.select("Toggle TLH experimental features (Esc to close)", [
			...featureIdsByOption.keys(),
		]);
		if (!selectedOption) {
			return;
		}
		const selectedFeatureId = featureIdsByOption.get(selectedOption);
		if (!selectedFeatureId) {
			ctx.ui.notify("Unknown TLH experimental feature picker selection.", "error");
			return;
		}

		try {
			notifyExperimentalWriteResult(
				pi,
				ctx,
				selectedFeatureId,
				writeExperimentalFeaturePreference(ctx.cwd, selectedFeatureId, "toggle"),
			);
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
	featureId: TlhExperimentalFeatureId,
	action: "enable" | "disable" | "toggle",
): TlhExperimentalWriteResult {
	const feature = getExperimentalFeature(featureId);
	if (!feature) {
		throw new Error(unknownExperimentalFeatureMessage(featureId));
	}
	return withLockedTlhSettingsWrite(
		cwd,
		"Refusing to write experimental settings outside the isolated TLH profile.",
		(current) => {
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
		},
	);
}

export function getExperimentalCommandCompletions(prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const completions = EXPERIMENTAL_COMMAND_COMPLETIONS.filter((option) =>
		option.value.startsWith(normalizedPrefix),
	).map((option) => ({ value: option.value, label: option.value, description: option.description }));
	return completions.length > 0 ? completions : null;
}

export async function handleExperimentalCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
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
		notifyExperimentalWriteResult(
			pi,
			ctx,
			command.featureId,
			writeExperimentalFeaturePreference(ctx.cwd, command.featureId, command.type),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Could not update TLH experimental feature ${command.featureId}: ${message}`, "error");
	}
}
