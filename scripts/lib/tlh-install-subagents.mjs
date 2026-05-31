import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { copySafeProfileFile, ensureSafeProfileDir } from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";

export const TLH_SUBAGENT_PROMPTS = Object.freeze([
	"developer.md",
	"code-reviewer.md",
	"repo-scout.md",
	"diff-summarizer.md",
	"librarian.md",
	"oracle.md",
	"web-scout.md",
]);

function isPlainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function settingsRequireTlhSubagentPrompts(defaultsFile, { noSettings = false } = {}) {
	if (noSettings || !defaultsFile || !existsSync(defaultsFile)) return false;
	try {
		const settings = readJsonFile(defaultsFile);
		const agentDirs = settings?.subagents?.agentDirs;
		return Array.isArray(agentDirs) && agentDirs.includes("tlh/agents/subagents");
	} catch {
		return false;
	}
}

export function defaultExtensionsRequireCriticalInstall(defaultExtensionsFile, { noSettings = false } = {}) {
	if (noSettings || !defaultExtensionsFile || !existsSync(defaultExtensionsFile)) return false;
	try {
		const defaults = readJsonFile(defaultExtensionsFile);
		return Array.isArray(defaults) && defaults.some((extension) => isPlainObject(extension) && extension.critical === true);
	} catch {
		return false;
	}
}

export function missingTlhSubagentPrompts(dir, { prompts = TLH_SUBAGENT_PROMPTS } = {}) {
	return prompts.filter((prompt) => !existsSync(join(dir, prompt)));
}

function tlhSubagentPromptsComplete(dir, options = {}) {
	return existsSync(dir) && missingTlhSubagentPrompts(dir, options).length === 0;
}

export function findTlhSubagentsDir(config, { localRepoDir = "", prompts = TLH_SUBAGENT_PROMPTS } = {}) {
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

export function copyTlhSubagentPrompts(config, sourceDir, { prompts = TLH_SUBAGENT_PROMPTS } = {}) {
	const supportSubagentsDir = ensureSafeProfileDir(config, "tlh/agents/subagents", "TLH subagent prompt directory");
	for (const prompt of prompts) {
		copySafeProfileFile(config, join(sourceDir, prompt), `tlh/agents/subagents/${prompt}`, `TLH subagent prompt ${prompt}`);
	}
	return supportSubagentsDir;
}
