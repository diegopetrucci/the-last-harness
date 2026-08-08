import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir, loadProjectContextFiles, } from "@earendil-works/pi-coding-agent";
import { formatPathFromCwd, readText, realpathForCompare, uniqueSorted } from "./common.js";
import { parseFrontmatterValue } from "./prompts.js";
function packageSourceLabel(source) {
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
function labelSkill(resource) {
    const content = readText(resource.path);
    return parseFrontmatterValue(content, "name") ?? basename(dirname(resource.path));
}
function labelPrompt(resource) {
    const content = readText(resource.path);
    const name = parseFrontmatterValue(content, "name") ?? basename(resource.path, extname(resource.path));
    return `/${name}`;
}
function labelExtension(resource) {
    const sourceLabel = packageSourceLabel(resource.metadata.source);
    const fileLabel = basename(resource.path);
    return sourceLabel ? `${sourceLabel}:${fileLabel}` : fileLabel;
}
function labelTheme(resource) {
    try {
        const theme = JSON.parse(readFileSync(resource.path, "utf8"));
        if (typeof theme.name === "string" && theme.name.trim()) {
            return theme.name.trim();
        }
    }
    catch {
    }
    return basename(resource.path, extname(resource.path));
}
function hasProjectTrustInputs(cwd) {
    let currentDir = resolve(cwd);
    if (existsSync(join(currentDir, ".pi"))) {
        return true;
    }
    while (true) {
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
function readSavedProjectTrust(agentDir, cwd) {
    const content = readText(join(agentDir, "trust.json"));
    if (!content) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
        }
        const trustByPath = parsed;
        let currentDir = realpathForCompare(cwd);
        while (true) {
            const value = trustByPath[currentDir];
            if (typeof value === "boolean") {
                return value;
            }
            const parentDir = dirname(currentDir);
            if (parentDir === currentDir) {
                return undefined;
            }
            currentDir = parentDir;
        }
    }
    catch {
        return undefined;
    }
}
function resolveProjectTrusted(cwd, agentDir, options) {
    if (typeof options.projectTrusted === "boolean") {
        return options.projectTrusted;
    }
    if (!hasProjectTrustInputs(cwd)) {
        return true;
    }
    return readSavedProjectTrust(agentDir, cwd) === true;
}
function createSettingsManager(cwd, agentDir, projectTrusted) {
    const create = SettingsManager.create;
    return create(cwd, agentDir, { projectTrusted });
}
function loadContextFiles(cwd, agentDir) {
    const load = loadProjectContextFiles;
    return load({ cwd, agentDir });
}
function filterVisibleResources(resources, projectTrusted) {
    return resources.filter((resource) => resource.enabled && existsSync(resource.path) && (projectTrusted || resource.metadata.scope !== "project"));
}
export async function collectStartupResources(cwd, options = {}) {
    const agentDir = getAgentDir();
    const projectTrusted = resolveProjectTrusted(cwd, agentDir, options);
    const settingsManager = createSettingsManager(cwd, agentDir, projectTrusted);
    const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve(async () => "skip");
    const enabled = (resources) => filterVisibleResources(resources, projectTrusted);
    return {
        context: loadContextFiles(cwd, agentDir).map((contextFile) => formatPathFromCwd(cwd, contextFile.path)),
        skills: uniqueSorted(enabled(resolved.skills).map(labelSkill)),
        prompts: uniqueSorted(enabled(resolved.prompts).map(labelPrompt)),
        extensions: uniqueSorted(enabled(resolved.extensions).map(labelExtension)),
        themes: uniqueSorted(enabled(resolved.themes).map(labelTheme)),
    };
}
