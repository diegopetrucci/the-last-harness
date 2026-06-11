import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { copySafeProfileFile, ensureSafeProfileDir } from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";

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
