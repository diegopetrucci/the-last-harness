import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join, resolve } from "node:path";

import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GNOSIS_VALIDATION_TIMEOUT_MS } from "./constants.js";
import { expandHomePath, formatHomePath, isPlainObject } from "./common.js";
import { assertNotNormalPiSettings } from "./profile-state.js";
import type { TlhGnosisConfig, TlhGnosisSlashAction, TlhGnosisState, TlhSettings } from "./types.js";

function getTlhGnosisConfig(cwd: string): TlhGnosisConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.gnosis;
	} catch {
		return undefined;
	}
}

function configuredGnosisPath(config: TlhGnosisConfig | undefined): string | undefined {
	const installPath = config?.installPath;
	if (typeof installPath !== "string" || !installPath.trim()) {
		return undefined;
	}
	return resolve(expandHomePath(installPath.trim()));
}

function validateTlhSettings(settings: unknown): asserts settings is TlhSettings {
	if (!isPlainObject(settings)) {
		throw new Error("settings.json must contain a JSON object");
	}
	const tlh = settings.tlh;
	if (tlh !== undefined && !isPlainObject(tlh)) {
		throw new Error("settings field 'tlh' must be an object if present");
	}
	const gnosis = isPlainObject(tlh) ? tlh.gnosis : undefined;
	if (gnosis !== undefined && !isPlainObject(gnosis)) {
		throw new Error("settings field 'tlh.gnosis' must be an object if present");
	}
}

function ensureMutableGnosisSettings(settings: TlhSettings): asserts settings is TlhSettings & { tlh: { gnosis: TlhGnosisConfig } } {
	validateTlhSettings(settings);
	settings.tlh ??= {};
	settings.tlh.gnosis ??= {};
}

function readTlhSettingsForWrite(settingsPath: string): { settings: TlhSettings; previousRaw: string } {
	const previousRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "") : "";
	if (!previousRaw.trim()) {
		return { settings: {}, previousRaw };
	}

	let settings: unknown;
	try {
		settings = JSON.parse(previousRaw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in ${formatHomePath(settingsPath)}: ${message}`);
	}
	validateTlhSettings(settings);
	return { settings, previousRaw };
}

function gnosisState(settings: TlhSettings): TlhGnosisState {
	const enabled = settings.tlh?.gnosis?.enabled;
	if (enabled === true) return "enabled";
	if (enabled === false) return "disabled";
	return "unset";
}

function currentGnosisState(): TlhGnosisState {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		const { settings } = readTlhSettingsForWrite(settingsPath);
		return gnosisState(settings);
	} catch {
		return "unset";
	}
}

export function formatGnosisToggleDescription(state: TlhGnosisState = currentGnosisState()): string {
	return `Toggle gnosis ${state === "enabled" ? "off" : "on"}`;
}

function backupPathFor(settingsPath: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${settingsPath}.backup-tlh-gnosis-${stamp}`;
}

function writeTlhSettings(settingsPath: string, settings: TlhSettings, previousRaw: string): { changed: boolean; backupPath?: string } {
	const formatted = `${JSON.stringify(settings, null, 2)}\n`;
	if (formatted === previousRaw) {
		return { changed: false };
	}

	mkdirSync(dirname(settingsPath), { recursive: true });
	let backupPath: string | undefined;
	if (existsSync(settingsPath)) {
		backupPath = backupPathFor(settingsPath);
		copyFileSync(settingsPath, backupPath);
	}

	const tempPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tempPath, formatted, "utf8");
	renameSync(tempPath, settingsPath);
	return { changed: true, backupPath };
}

function uniqueGnosisCandidates(candidates: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const key = candidate === "gn" ? candidate : resolve(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(candidate);
	}
	return unique;
}

function validateGnosisCommand(command: string): boolean {
	try {
		for (const args of [["help", "plan"], ["help", "review"]]) {
			execFileSync(command, args, { stdio: "ignore", timeout: GNOSIS_VALIDATION_TIMEOUT_MS });
		}
		return true;
	} catch {
		return false;
	}
}

function prependProcessPath(dir: string): void {
	const currentPath = process.env.PATH || "";
	const entries = currentPath.split(delimiter).filter(Boolean);
	if (entries.includes(dir)) {
		return;
	}
	process.env.PATH = [dir, ...entries].join(delimiter);
}

function findValidGnosisCommand(config: TlhGnosisConfig | undefined, agentDir: string, options: { prependPath?: boolean } = {}): string | undefined {
	const candidates = uniqueGnosisCandidates([configuredGnosisPath(config), join(agentDir, "bin", "gn"), "gn"]);
	for (const candidate of candidates) {
		if (!validateGnosisCommand(candidate)) continue;
		if (options.prependPath && candidate !== "gn") {
			prependProcessPath(dirname(candidate));
		}
		return candidate;
	}
	return undefined;
}

function findEnabledGnosisCommand(cwd: string): string | undefined {
	const config = getTlhGnosisConfig(cwd);
	if (config?.enabled !== true) {
		return undefined;
	}

	return findValidGnosisCommand(config, getAgentDir(), { prependPath: true });
}

export function shouldAppendGnosisPrompt(cwd: string): boolean {
	return Boolean(findEnabledGnosisCommand(cwd));
}

function parseGnosisSlashAction(args: string): TlhGnosisSlashAction | undefined {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "toggle";
	}
	if (parts.length > 1) {
		return undefined;
	}
	const [action] = parts;
	if (action === "toggle") return "toggle";
	if (action === "status") return "status";
	if (action === "enable" || action === "on") return "enable";
	if (action === "disable" || action === "off") return "disable";
	return undefined;
}

function formatGnosisStatus(settings: TlhSettings, validCommand: string | undefined): string {
	const state = gnosisState(settings);
	const active = state === "enabled" && Boolean(validCommand);
	const binary = validCommand ? formatHomePath(validCommand) : "not found";
	return `Gnosis setting: ${state}. Active: ${active ? "yes" : "no"}. Binary: ${binary}.`;
}

function notifyGnosisWriteResult(ctx: ExtensionContext, result: { changed: boolean; backupPath?: string }): void {
	if (!result.changed) {
		ctx.ui.notify("No Gnosis settings changes were needed.", "info");
	}
}

export function registerGnosisCommand(pi: ExtensionAPI): void {
	pi.registerCommand("gnosis", {
		description: formatGnosisToggleDescription(),
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const actions = [
				{ value: "status", label: "status", description: "Show the current Gnosis setting and detected binary" },
				{ value: "enable", label: "enable", description: "Turn gnosis on" },
				{ value: "disable", label: "disable", description: "Turn gnosis off" },
				{ value: "toggle", label: "toggle", description: formatGnosisToggleDescription() },
			];
			const completions = actions.filter((action) => action.value.startsWith(normalizedPrefix));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const action = parseGnosisSlashAction(args);
			if (!action) {
				ctx.ui.notify("Usage: /gnosis [status|enable|disable|toggle]. With no argument, /gnosis toggles the integration.", "error");
				return;
			}

			try {
				const agentDir = getAgentDir();
				const settingsPath = join(agentDir, "settings.json");
				assertNotNormalPiSettings(settingsPath);

				const { settings, previousRaw } = readTlhSettingsForWrite(settingsPath);
				const validCommand = findValidGnosisCommand(settings.tlh?.gnosis, agentDir);

				if (action === "status") {
					ctx.ui.notify(formatGnosisStatus(settings, validCommand), "info");
					return;
				}

				const shouldEnable = action === "enable" || (action === "toggle" && gnosisState(settings) !== "enabled");
				ensureMutableGnosisSettings(settings);
				settings.tlh.gnosis.enabled = shouldEnable;
				if (shouldEnable && validCommand && validCommand !== "gn") {
					settings.tlh.gnosis.installPath = resolve(validCommand);
					prependProcessPath(dirname(validCommand));
				}

				const writeResult = writeTlhSettings(settingsPath, settings, previousRaw);
				if (shouldEnable && validCommand) {
					ctx.ui.notify("Gnosis enabled for tlh. Prompt instructions will apply on the next agent turn.", "info");
				} else if (shouldEnable) {
					ctx.ui.notify("Gnosis enabled in tlh settings, but no valid `gn` binary was found. Run `tlh update --with-gnosis` or install Gnosis manually.", "warning");
				} else {
					ctx.ui.notify("Gnosis disabled for tlh. Existing .gnosis project memory was not deleted.", "info");
				}
				notifyGnosisWriteResult(ctx, writeResult);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to update Gnosis integration: ${message}`, "error");
			}
		},
	});
}
