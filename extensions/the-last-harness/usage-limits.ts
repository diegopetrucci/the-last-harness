import { writeFileSync } from "node:fs";

import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import { assertSafeTlhSettingsPath, tlhSettingsPathForWrite } from "./profile-state.js";
import type {
	SettingsStorageLike,
	TlhSettings,
	TlhUsageLimitsConfig,
	TlhUsageLimitsWriteResult,
	TlhUsageWeeklyAction,
} from "./types.js";

type TlhUsageSlashAction =
	| { type: "status" }
	| { type: "weekly"; action: TlhUsageWeeklyAction };

const USAGE_COMMAND_HELP = "Usage: /usage [status|weekly on|weekly off|weekly toggle]. With no argument, /usage shows status.";

export function getTlhUsageLimitsConfig(cwd: string): TlhUsageLimitsConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.usageLimits;
	} catch {
		return undefined;
	}
}

export function shouldShowTlhUsageWeekly(config: TlhUsageLimitsConfig | undefined): boolean {
	return config?.showWeekly === true;
}

function validateTlhUsageLimitsSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isRecord(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isRecord(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const usageLimits = isRecord(tlh) ? tlh.usageLimits : undefined;
	if (usageLimits !== undefined && !isRecord(usageLimits)) {
		throw new Error("settings field 'tlh.usageLimits' must be an object if present");
	}
}

function ensureMutableUsageLimitsSettings(settings: TlhSettings): asserts settings is TlhSettings & {
	tlh: { usageLimits: TlhUsageLimitsConfig };
} {
	validateTlhUsageLimitsSettings(settings);
	settings.tlh ??= {};
	settings.tlh.usageLimits ??= {};
}

function parseTlhSettingsContent(content: string | undefined): TlhSettings {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content) as unknown;
	validateTlhUsageLimitsSettings(parsed);
	return parsed;
}

function settingsBackupTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function getSettingsStorageForWrite(cwd: string): SettingsStorageLike {
	const manager = SettingsManager.create(cwd, getAgentDir()) as unknown as { storage?: SettingsStorageLike };
	if (!manager.storage || typeof manager.storage.withLock !== "function") {
		throw new Error("Pi settings storage is unavailable.");
	}
	return manager.storage;
}

function writeTlhUsageWeeklyPreference(cwd: string, showWeekly: boolean): TlhUsageLimitsWriteResult {
	const settingsPath = tlhSettingsPathForWrite();
	if (!settingsPath) {
		throw new Error("Refusing to write usage-limit settings outside the isolated TLH profile.");
	}
	assertSafeTlhSettingsPath(settingsPath);

	let result: TlhUsageLimitsWriteResult | undefined;
	getSettingsStorageForWrite(cwd).withLock("global", (current) => {
		const settings = parseTlhSettingsContent(current);
		ensureMutableUsageLimitsSettings(settings);

		if (settings.tlh.usageLimits.showWeekly === showWeekly) {
			result = { settingsPath, changed: false };
			return undefined;
		}

		settings.tlh.usageLimits.showWeekly = showWeekly;
		const backupPath = current ? `${settingsPath}.bak-${settingsBackupTimestamp()}` : undefined;
		if (backupPath) {
			writeFileSync(backupPath, current, { encoding: "utf8", flag: "wx", mode: 0o600 });
		}
		result = { settingsPath, backupPath, changed: true };
		return `${JSON.stringify(settings, null, 2)}\n`;
	});

	if (!result) {
		throw new Error("Pi settings storage did not return a write result.");
	}
	return result;
}

function parseUsageSlashAction(args: string): TlhUsageSlashAction | undefined {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return { type: "status" };
	}
	if (parts.length === 1 && parts[0] === "status") {
		return { type: "status" };
	}
	if (parts.length === 2 && parts[0] === "weekly") {
		const action = parts[1];
		if (action === "on" || action === "off" || action === "toggle") {
			return { type: "weekly", action };
		}
	}
	return undefined;
}

function nextWeeklyPreference(current: boolean, action: TlhUsageWeeklyAction): boolean {
	if (action === "on") return true;
	if (action === "off") return false;
	return !current;
}

function formatUsageWeeklyStatus(showWeekly: boolean): string {
	return showWeekly
		? "TLH usage weekly window is shown. Use /usage weekly off to hide it, or /usage weekly toggle."
		: "TLH usage weekly window is hidden (default when unset). Use /usage weekly on to show it, or /usage weekly toggle.";
}

function usageCommandCompletions(prefix: string) {
	const options = [
		{ value: "status", description: "Show TLH usage-limit footer preferences" },
		{ value: "weekly on", description: "Show the weekly usage-limit window in the footer" },
		{ value: "weekly off", description: "Hide the weekly usage-limit window in the footer" },
		{ value: "weekly toggle", description: "Toggle the weekly usage-limit window in the footer" },
	];
	const normalizedPrefix = prefix.trim().toLowerCase();
	const completions = options
		.filter((option) => option.value.startsWith(normalizedPrefix))
		.map((option) => ({ value: option.value, label: option.value, description: option.description }));
	return completions.length > 0 ? completions : null;
}

export function registerUsageCommand(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show or change TLH usage-limit footer preferences",
		getArgumentCompletions: usageCommandCompletions,
		handler: async (args, ctx) => {
			const command = parseUsageSlashAction(args);
			if (!command) {
				ctx.ui.notify(USAGE_COMMAND_HELP, "error");
				return;
			}

			const currentShowWeekly = shouldShowTlhUsageWeekly(getTlhUsageLimitsConfig(ctx.cwd));
			if (command.type === "status") {
				ctx.ui.notify(formatUsageWeeklyStatus(currentShowWeekly), "info");
				return;
			}

			const nextShowWeekly = nextWeeklyPreference(currentShowWeekly, command.action);
			try {
				const result = writeTlhUsageWeeklyPreference(ctx.cwd, nextShowWeekly);
				const changedLabel = result.changed ? "Updated" : "No change to";
				const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
				ctx.ui.notify(
					`${changedLabel} TLH usage weekly-window preference at ${formatHomePath(result.settingsPath)}. ${formatUsageWeeklyStatus(nextShowWeekly)}${backupLabel}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not update TLH usage weekly-window preference: ${message}`, "error");
			}
		},
	});
}
