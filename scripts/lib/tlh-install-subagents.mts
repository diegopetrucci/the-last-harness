import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { copySafeProfileFile, ensureSafeProfileDir } from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";

interface PlainObject {
	[key: string]: unknown;
}

interface SubagentConfig {
	agentDir: string;
	packageSource: string;
	packageSourceIsDefault: boolean;
	tmpDir?: string;
	repo: string;
}

const TLH_SUBAGENT_PROMPTS = Object.freeze([
	"developer.md",
	"code-reviewer.md",
	"repo-scout.md",
	"diff-summarizer.md",
	"librarian.md",
	"oracle.md",
	"contrarian.md",
	"web-scout.md",
]);

function isPlainObject(value: unknown): value is PlainObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { TLH_SUBAGENT_PROMPTS };

export function settingsRequireTlhSubagentPrompts(defaultsFile: string, { noSettings = false }: { noSettings?: boolean } = {}): boolean {
	if (noSettings || !defaultsFile || !existsSync(defaultsFile)) return false;
	try {
		const settings = readJsonFile(defaultsFile);
		if (!isPlainObject(settings)) return false;
		const subagents = isPlainObject(settings.subagents) ? settings.subagents : undefined;
		const agentDirs = subagents?.agentDirs;
		return Array.isArray(agentDirs) && agentDirs.includes("tlh/agents/subagents");
	} catch {
		return false;
	}
}

export function defaultExtensionsRequireCriticalInstall(
	defaultExtensionsFile: string,
	{ noSettings = false }: { noSettings?: boolean } = {},
): boolean {
	if (noSettings || !defaultExtensionsFile || !existsSync(defaultExtensionsFile)) return false;
	try {
		const defaults = readJsonFile(defaultExtensionsFile);
		return Array.isArray(defaults)
			&& defaults.some((extension) => isPlainObject(extension) && extension.critical === true);
	} catch {
		return false;
	}
}

export function missingTlhSubagentPrompts(
	dir: string,
	{ prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string[] {
	return prompts.filter((prompt) => !existsSync(join(dir, prompt)));
}

export function restoreNeededTlhSubagentPrompts(
	sourceDir: string,
	targetDir: string,
	{ prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string[] {
	return prompts.filter((prompt) => {
		const sourcePath = join(sourceDir, prompt);
		const targetPath = join(targetDir, prompt);
		if (!existsSync(targetPath)) {
			return true;
		}
		try {
			return readFileSync(targetPath, "utf8") !== readFileSync(sourcePath, "utf8");
		} catch {
			return true;
		}
	});
}

function tlhSubagentPromptsComplete(dir: string, options: { prompts?: readonly string[] } = {}): boolean {
	return existsSync(dir) && missingTlhSubagentPrompts(dir, options).length === 0;
}

export function findTlhSubagentsDir(
	config: SubagentConfig,
	{ localRepoDir = "", prompts = TLH_SUBAGENT_PROMPTS }: { localRepoDir?: string; prompts?: readonly string[] } = {},
): string {
	const options = { prompts };
	if (!config.packageSourceIsDefault) {
		const packageRoot = packageSourceInstallDir(config.packageSource, { agentDir: config.agentDir });
		if (packageRoot && tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)) {
			return join(packageRoot, "agents", "subagents");
		}
	}

	if (localRepoDir && tlhSubagentPromptsComplete(join(localRepoDir, "agents", "subagents"), options)) {
		return join(localRepoDir, "agents", "subagents");
	}

	if (config.packageSourceIsDefault) {
		const packageRoot = packageSourceInstallDir(config.packageSource, { agentDir: config.agentDir });
		if (packageRoot && tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)) {
			return join(packageRoot, "agents", "subagents");
		}
	}

	if (config.tmpDir && tlhSubagentPromptsComplete(join(config.tmpDir, "agents", "subagents"), options)) {
		return join(config.tmpDir, "agents", "subagents");
	}

	const fallbackPackageRoot = join(config.agentDir, "git", "github.com", config.repo);
	if (tlhSubagentPromptsComplete(join(fallbackPackageRoot, "agents", "subagents"), options)) {
		return join(fallbackPackageRoot, "agents", "subagents");
	}
	return "";
}

export function copyTlhSubagentPrompts(
	config: { agentDir: string },
	sourceDir: string,
	{ prompts = TLH_SUBAGENT_PROMPTS }: { prompts?: readonly string[] } = {},
): string {
	const supportSubagentsDir = ensureSafeProfileDir(config, "tlh/agents/subagents", "TLH subagent prompt directory");
	for (const prompt of prompts) {
		copySafeProfileFile(config, join(sourceDir, prompt), `tlh/agents/subagents/${prompt}`, `TLH subagent prompt ${prompt}`);
	}
	return supportSubagentsDir;
}

/**
 * Provision the subagent extension config at extensions/subagent/config.json
 * with TLH-preferred defaults: compact tool descriptions and a first active
 * long-running notice after 270000ms (4m30).
 *
 * Each default is added independently when its setting is missing. Existing
 * user values, including a user-chosen toolDescriptionMode such as "full" or
 * an activeNoticeAfterMs override, are left untouched. Re-running the
 * installer is therefore safe and will not clobber user edits.
 *
 * Revert path: open <agentDir>/extensions/subagent/config.json and set either
 * "toolDescriptionMode" or "control.activeNoticeAfterMs" to the value you
 * want. Existing values are preserved on subsequent installer runs. To return
 * a setting to the managed default, remove that key and rerun install or
 * update; missing defaults are re-provisioned. Valid non-object or unreadable
 * config files are preserved untouched.
 *
 * Runtime note: toolDescriptionMode requires pi-subagents >= v0.33.0
 * (fork feature). Older builds simply ignore the unknown key.
 */
const TLH_TOOL_DESCRIPTION_MODE = "compact";
const TLH_ACTIVE_NOTICE_AFTER_MS = 270000;

function activeNoticeCanBeProvisioned(existing: PlainObject): boolean {
	return !("control" in existing) || isPlainObject(existing.control);
}

function activeNoticeIsMissing(existing: PlainObject): boolean {
	return activeNoticeCanBeProvisioned(existing)
		&& (!isPlainObject(existing.control) || !("activeNoticeAfterMs" in existing.control));
}

/**
 * Returns true when provisionSubagentExtensionConfig would write to disk,
 * false when it would leave the existing file untouched (all writable defaults
 * are present, the config has a non-object JSON value, or it is unreadable).
 */
export function subagentExtensionConfigNeedsProvisioning(config: { agentDir: string }): boolean {
	const configPath = join(config.agentDir, "extensions/subagent/config.json");
	if (!existsSync(configPath)) return true;
	try {
		const parsed = readJsonFile<unknown>(configPath, { missingValue: {} as unknown });
		if (!isPlainObject(parsed)) return false;
		return !("toolDescriptionMode" in parsed) || activeNoticeIsMissing(parsed);
	} catch {
		return false;
	}
}

export function provisionSubagentExtensionConfig(config: { agentDir: string }): void {
	const relativePath = "extensions/subagent/config.json";
	const configPath = join(config.agentDir, relativePath);

	let existing: PlainObject = {};
	if (existsSync(configPath)) {
		try {
			const parsed = readJsonFile<unknown>(configPath, { missingValue: {} as unknown });
			if (isPlainObject(parsed)) existing = parsed;
			else return; // Valid JSON but not a plain object (e.g. null, array, scalar) — preserve untouched.
		} catch {
			// Unable to read/parse existing config — leave it untouched.
			return;
		}
	}

	const missingToolDescriptionMode = !("toolDescriptionMode" in existing);
	const missingActiveNotice = activeNoticeIsMissing(existing);
	if (!missingToolDescriptionMode && !missingActiveNotice) return;

	ensureSafeProfileDir(config, "extensions/subagent", "TLH subagent extension config directory");
	const updated: PlainObject = { ...existing };
	if (missingToolDescriptionMode) updated.toolDescriptionMode = TLH_TOOL_DESCRIPTION_MODE;
	if (missingActiveNotice) {
		const existingControl = isPlainObject(existing.control) ? existing.control : {};
		updated.control = { activeNoticeAfterMs: TLH_ACTIVE_NOTICE_AFTER_MS, ...existingControl };
	}
	writeSafeProfileFile(config, relativePath, JSON.stringify(updated, null, 2) + "\n", "TLH subagent extension config");
}
