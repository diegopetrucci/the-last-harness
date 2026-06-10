import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
	DefaultPackageManager,
	SettingsManager,
	VERSION,
	getAgentDir,
	loadProjectContextFiles,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { formatPathFromCwd, pathWithinOrEqual, readText, realpathForCompare, uniqueSorted } from "./common.js";
import { parseFrontmatterValue } from "./prompts.js";
import type { StartupResources } from "./types.js";

const PROJECT_TRUST_MIN_VERSION = "0.79.0";
const PROJECT_CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export type CollectStartupResourcesOptions = {
	projectTrusted?: boolean;
	piVersion?: string;
};

function packageSourceLabel(source: string | undefined): string | undefined {
	if (!source) {
		return undefined;
	}
	const github = source.match(/^git:github\.com\/([^@]+)(?:@.*)?$/);
	if (github) {
		return github[1];
	}
	const npm = source.match(/^npm:(.+)$/);
	if (npm) {
		return npm[1];
	}
	return source;
}

function labelSkill(resource: ResolvedResource): string {
	const content = readText(resource.path);
	return parseFrontmatterValue(content, "name") ?? basename(dirname(resource.path));
}

function labelPrompt(resource: ResolvedResource): string {
	const content = readText(resource.path);
	const name = parseFrontmatterValue(content, "name") ?? basename(resource.path, extname(resource.path));
	return `/${name}`;
}

function labelExtension(resource: ResolvedResource): string {
	const sourceLabel = packageSourceLabel(resource.metadata.source);
	const fileLabel = basename(resource.path);
	return sourceLabel ? `${sourceLabel}:${fileLabel}` : fileLabel;
}

function labelTheme(resource: ResolvedResource): string {
	try {
		const theme = JSON.parse(readFileSync(resource.path, "utf8"));
		if (typeof theme.name === "string" && theme.name.trim()) {
			return theme.name.trim();
		}
	} catch {
		// fall through to filename
	}
	return basename(resource.path, extname(resource.path));
}

function parseVersion(version: string): [number, number, number] | undefined {
	const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: string, minimum: string): boolean {
	const parsed = parseVersion(version);
	const min = parseVersion(minimum);
	if (!parsed || !min) {
		return false;
	}
	for (let i = 0; i < min.length; i++) {
		if (parsed[i] > min[i]) return true;
		if (parsed[i] < min[i]) return false;
	}
	return true;
}

function hasProjectTrustInputs(cwd: string): boolean {
	let currentDir = resolve(cwd);
	if (existsSync(join(currentDir, ".pi"))) {
		return true;
	}

	while (true) {
		for (const filename of PROJECT_CONTEXT_FILE_NAMES) {
			if (existsSync(join(currentDir, filename))) {
				return true;
			}
		}
		if (existsSync(join(currentDir, ".agents", "skills"))) {
			return true;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

function readSavedProjectTrust(agentDir: string, cwd: string): boolean | undefined {
	const content = readText(join(agentDir, "trust.json"));
	if (!content) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const value = (parsed as Record<string, unknown>)[realpathForCompare(cwd)];
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

function resolveProjectTrusted(cwd: string, agentDir: string, options: CollectStartupResourcesOptions): boolean {
	if (typeof options.projectTrusted === "boolean") {
		return options.projectTrusted;
	}
	if (!versionAtLeast(options.piVersion ?? VERSION, PROJECT_TRUST_MIN_VERSION)) {
		return true;
	}
	if (!hasProjectTrustInputs(cwd)) {
		return true;
	}
	return readSavedProjectTrust(agentDir, cwd) === true;
}

function createSettingsManager(cwd: string, agentDir: string, projectTrusted: boolean) {
	const create = SettingsManager.create as unknown as (
		cwd: string,
		agentDir: string,
		options?: { projectTrusted?: boolean },
	) => ReturnType<typeof SettingsManager.create>;
	return create(cwd, agentDir, { projectTrusted });
}

function loadContextFiles(cwd: string, agentDir: string, projectTrusted: boolean): Array<{ path: string; content: string }> {
	const load = loadProjectContextFiles as unknown as (options: {
		cwd: string;
		agentDir: string;
		projectTrusted?: boolean;
	}) => Array<{ path: string; content: string }>;
	return load({ cwd, agentDir, projectTrusted });
}

function filterVisibleResources(resources: ResolvedResource[], projectTrusted: boolean): ResolvedResource[] {
	return resources.filter(
		(resource) =>
			resource.enabled &&
			existsSync(resource.path) &&
			(projectTrusted || resource.metadata.scope !== "project"),
	);
}

function filterVisibleContext(
	contextFiles: Array<{ path: string; content: string }>,
	agentDir: string,
	projectTrusted: boolean,
): Array<{ path: string; content: string }> {
	if (projectTrusted) {
		return contextFiles;
	}
	const resolvedAgentDir = realpathForCompare(agentDir);
	return contextFiles.filter((contextFile) => pathWithinOrEqual(resolvedAgentDir, realpathForCompare(contextFile.path)));
}

export async function collectStartupResources(
	cwd: string,
	options: CollectStartupResourcesOptions = {},
): Promise<StartupResources> {
	const agentDir = getAgentDir();
	const projectTrusted = resolveProjectTrusted(cwd, agentDir, options);
	const settingsManager = createSettingsManager(cwd, agentDir, projectTrusted);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const enabled = (resources: ResolvedResource[]) => filterVisibleResources(resources, projectTrusted);

	return {
		context: filterVisibleContext(loadContextFiles(cwd, agentDir, projectTrusted), agentDir, projectTrusted).map((contextFile) =>
			formatPathFromCwd(cwd, contextFile.path),
		),
		skills: uniqueSorted(enabled(resolved.skills).map(labelSkill)),
		prompts: uniqueSorted(enabled(resolved.prompts).map(labelPrompt)),
		extensions: uniqueSorted(enabled(resolved.extensions).map(labelExtension)),
		themes: uniqueSorted(enabled(resolved.themes).map(labelTheme)),
	};
}
