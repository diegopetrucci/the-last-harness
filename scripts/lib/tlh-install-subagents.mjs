import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES, packageIdentity, packageSourceOf, readDefaultExtensionProvenance, withLegacyRetiredDefaultPackageIdentities, } from "./default-extensions.mjs";
import { criticalGitSourceSpec, packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { assertProfilePathWithinAgent, copySafeProfileFile, ensureSafeProfileDir, isSymlink } from "./tlh-install-paths.mjs";
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
function logRetiredSubagentCleanup(config, message) {
    if (!config.quiet)
        console.log(message);
}
function warnRetiredSubagentCleanup(message) {
    console.error(`warning: ${message}`);
}
function packageNameFromNpmSource(source) {
    const spec = source.trim().slice("npm:".length).trim();
    if (!spec)
        return undefined;
    if (spec.startsWith("@")) {
        const separator = spec.indexOf("@", 1);
        return separator === -1 ? spec : spec.slice(0, separator);
    }
    const separator = spec.indexOf("@");
    return separator === -1 ? spec : spec.slice(0, separator);
}
function sourceInstallPath(agentDir, source) {
    const trimmed = source.trim();
    if (trimmed.startsWith("npm:")) {
        const packageName = packageNameFromNpmSource(trimmed);
        if (!packageName)
            return undefined;
        return { path: join(agentDir, "npm", "node_modules", packageName), kind: "npm", packageName };
    }
    const spec = criticalGitSourceSpec(trimmed, { agentDir });
    if (!spec)
        return undefined;
    return { path: spec.targetDir, kind: "git" };
}
function pathWithin(root, target) {
    const normalizedRoot = resolve(root);
    const normalizedTarget = resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}
function hasSymlinkedParent(root, target) {
    let current = dirname(target);
    const resolvedRoot = resolve(root);
    while (pathWithin(resolvedRoot, current) && current !== resolvedRoot) {
        if (isSymlink(current))
            return true;
        current = dirname(current);
    }
    return false;
}
function packageInstallationIsOwned(path, kind, packageName) {
    try {
        if (!lstatSync(path).isDirectory())
            return false;
        if (kind === "git")
            return existsSync(join(path, ".git"));
        const packageJson = readJsonFile(join(path, "package.json"));
        return packageJson.name === packageName;
    }
    catch {
        return false;
    }
}
/**
 * Capture package entries that the old TLH default owned before settings merge.
 * A profile without provenance is treated as a pre-provenance TLH profile, as
 * with the other retired defaults; a provenance block makes manual ownership
 * explicit and therefore keeps unlisted external entries safe.
 */
export function managedRetiredSubagentPackages(settings) {
    if (!isPlainObject(settings) || !Array.isArray(settings.packages))
        return [];
    const provenance = readDefaultExtensionProvenance(settings).managedPackageIdentities;
    const managed = withLegacyRetiredDefaultPackageIdentities(settings, provenance, RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES);
    const candidates = [];
    const seen = new Set();
    for (const entry of settings.packages) {
        const source = packageSourceOf(entry);
        const identity = packageIdentity(entry);
        if (!source || !identity || !managed.has(identity) || seen.has(identity))
            continue;
        if (!RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES.some((known) => packageIdentity(known) === identity))
            continue;
        seen.add(identity);
        candidates.push({ source, identity });
    }
    return candidates;
}
/** Read and capture managed retired subagent entries before merge removes them. */
export function captureManagedRetiredSubagentPackages(settingsPath) {
    if (!settingsPath || !existsSync(settingsPath))
        return [];
    try {
        return managedRetiredSubagentPackages(readJsonFile(settingsPath));
    }
    catch {
        return [];
    }
}
/**
 * Remove only package-manager installations corresponding to captured managed
 * entries.  The checks deliberately reject symlinked paths, foreign paths,
 * malformed npm metadata, and non-git directories before any recursive delete.
 */
export function cleanupManagedRetiredSubagentPackages(config, candidates) {
    if (!config.agentDir || isSymlink(config.agentDir)) {
        if (candidates.length > 0)
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe agent dir: ${config.agentDir}`);
        return;
    }
    for (const candidate of candidates) {
        const install = sourceInstallPath(config.agentDir, candidate.source);
        if (!install)
            continue;
        if (!pathWithin(config.agentDir, install.path) || hasSymlinkedParent(config.agentDir, install.path) || isSymlink(install.path)) {
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe path: ${install.path}`);
            continue;
        }
        if (!existsSync(install.path) || !packageInstallationIsOwned(install.path, install.kind, install.packageName))
            continue;
        try {
            assertProfilePathWithinAgent({ agentDir: config.agentDir }, install.path, "retired subagent package");
        }
        catch (error) {
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe path: ${install.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (config.dryRun) {
            logRetiredSubagentCleanup(config, `Would remove retired TLH subagent package installation: ${install.path}`);
            continue;
        }
        try {
            rmSync(install.path, { recursive: true, force: true });
            logRetiredSubagentCleanup(config, `Removed retired TLH subagent package installation: ${install.path}`);
        }
        catch (error) {
            warnRetiredSubagentCleanup(`failed to remove retired subagent package installation ${install.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (install.kind === "git") {
            const gitRoot = join(config.agentDir, "git");
            let parent = dirname(install.path);
            while (pathWithin(gitRoot, parent) && parent !== gitRoot) {
                if (isSymlink(parent))
                    break;
                try {
                    if (readdirSync(parent).length !== 0)
                        break;
                    // rmdirSync removes empty directories atomically and fails with
                    // ENOTEMPTY if the directory becomes non-empty concurrently.
                    rmdirSync(parent);
                }
                catch {
                    break;
                }
                parent = dirname(parent);
            }
        }
    }
}
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
function activeNoticeCanBeProvisioned(existing) {
    return !("control" in existing) || isPlainObject(existing.control);
}
function activeNoticeIsMissing(existing) {
    return activeNoticeCanBeProvisioned(existing)
        && (!isPlainObject(existing.control) || !("activeNoticeAfterMs" in existing.control));
}
function readExistingSubagentExtensionConfig(config) {
    const configPath = join(config.agentDir, "extensions/subagent/config.json");
    if (!existsSync(configPath))
        return {};
    try {
        const parsed = readJsonFile(configPath, { missingValue: {} });
        return isPlainObject(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
function missingSubagentExtensionDefaultLabels(existing) {
    const missingDefaults = [];
    if (!("toolDescriptionMode" in existing))
        missingDefaults.push(`toolDescriptionMode: ${TLH_TOOL_DESCRIPTION_MODE}`);
    if (activeNoticeIsMissing(existing)) {
        missingDefaults.push(`control.activeNoticeAfterMs: ${TLH_ACTIVE_NOTICE_AFTER_MS} (4m30)`);
    }
    return missingDefaults;
}
/**
 * Returns the display labels for defaults that provisionSubagentExtensionConfig
 * can write. An empty result means the existing config is complete, a valid
 * non-object JSON value, or unreadable.
 */
export function subagentExtensionConfigMissingDefaults(config) {
    const existing = readExistingSubagentExtensionConfig(config);
    return existing ? missingSubagentExtensionDefaultLabels(existing) : [];
}
/**
 * Returns true when provisionSubagentExtensionConfig would write to disk,
 * false when it would leave the existing file untouched (all writable defaults
 * are present, the config has a non-object JSON value, or it is unreadable).
 */
export function subagentExtensionConfigNeedsProvisioning(config) {
    return subagentExtensionConfigMissingDefaults(config).length > 0;
}
export function provisionSubagentExtensionConfig(config) {
    const relativePath = "extensions/subagent/config.json";
    const existing = readExistingSubagentExtensionConfig(config);
    if (!existing)
        return;
    const missingToolDescriptionMode = !("toolDescriptionMode" in existing);
    const missingActiveNotice = activeNoticeIsMissing(existing);
    if (!missingToolDescriptionMode && !missingActiveNotice)
        return;
    ensureSafeProfileDir(config, "extensions/subagent", "TLH subagent extension config directory");
    const updated = { ...existing };
    if (missingToolDescriptionMode)
        updated.toolDescriptionMode = TLH_TOOL_DESCRIPTION_MODE;
    if (missingActiveNotice) {
        const existingControl = isPlainObject(existing.control) ? existing.control : {};
        updated.control = { activeNoticeAfterMs: TLH_ACTIVE_NOTICE_AFTER_MS, ...existingControl };
    }
    writeSafeProfileFile(config, relativePath, JSON.stringify(updated, null, 2) + "\n", "TLH subagent extension config");
}
