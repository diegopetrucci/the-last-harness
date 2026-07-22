import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { copySafeProfileFile, ensureSafeProfileDir } from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";
import { writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";
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
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export { TLH_SUBAGENT_PROMPTS };
export function settingsRequireTlhSubagentPrompts(defaultsFile, { noSettings = false } = {}) {
    if (noSettings || !defaultsFile || !existsSync(defaultsFile))
        return false;
    try {
        const settings = readJsonFile(defaultsFile);
        if (!isPlainObject(settings))
            return false;
        const subagents = isPlainObject(settings.subagents) ? settings.subagents : undefined;
        const agentDirs = subagents?.agentDirs;
        return Array.isArray(agentDirs) && agentDirs.includes("tlh/agents/subagents");
    }
    catch {
        return false;
    }
}
export function defaultExtensionsRequireCriticalInstall(defaultExtensionsFile, { noSettings = false } = {}) {
    if (noSettings || !defaultExtensionsFile || !existsSync(defaultExtensionsFile))
        return false;
    try {
        const defaults = readJsonFile(defaultExtensionsFile);
        return Array.isArray(defaults)
            && defaults.some((extension) => isPlainObject(extension) && extension.critical === true);
    }
    catch {
        return false;
    }
}
export function missingTlhSubagentPrompts(dir, { prompts = TLH_SUBAGENT_PROMPTS } = {}) {
    return prompts.filter((prompt) => !existsSync(join(dir, prompt)));
}
export function restoreNeededTlhSubagentPrompts(sourceDir, targetDir, { prompts = TLH_SUBAGENT_PROMPTS } = {}) {
    return prompts.filter((prompt) => {
        const sourcePath = join(sourceDir, prompt);
        const targetPath = join(targetDir, prompt);
        if (!existsSync(targetPath)) {
            return true;
        }
        try {
            return readFileSync(targetPath, "utf8") !== readFileSync(sourcePath, "utf8");
        }
        catch {
            return true;
        }
    });
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
/**
 * Provision the subagent extension config at extensions/subagent/config.json
 * with TLH-preferred defaults.
 *
 * Idempotency: if toolDescriptionMode is already present (set to any value,
 * including a user-chosen override such as "full"), it is left untouched.
 * Re-running the installer is therefore safe and will not clobber user edits.
 *
 * Revert path: to disable compact descriptions, open
 * <agentDir>/extensions/subagent/config.json and set
 * "toolDescriptionMode": "full". That value will be preserved on subsequent
 * installer runs. Removing the key is only a temporary revert — the installer
 * will re-provision "compact" on the next install or update run.
 *
 * Runtime note: toolDescriptionMode requires pi-subagents >= v0.33.0
 * (fork feature). Older builds simply ignore the unknown key.
 */
export function provisionSubagentExtensionConfig(config) {
    const relativePath = "extensions/subagent/config.json";
    const configPath = join(config.agentDir, relativePath);
    let existing = {};
    if (existsSync(configPath)) {
        try {
            const parsed = readJsonFile(configPath, { missingValue: {} });
            if (isPlainObject(parsed))
                existing = parsed;
        }
        catch {
            // Unable to read/parse existing config — leave it untouched.
            return;
        }
    }
    // Preserve any value the user has already set (including explicit "full").
    if ("toolDescriptionMode" in existing)
        return;
    ensureSafeProfileDir(config, "extensions/subagent", "TLH subagent extension config directory");
    const updated = { toolDescriptionMode: "compact", ...existing };
    writeSafeProfileFile(config, relativePath, JSON.stringify(updated, null, 2) + "\n", "TLH subagent extension config");
}
