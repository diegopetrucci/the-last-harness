import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { RETIRED_TLH_SUBAGENTS_DEFAULT_PACKAGE_SOURCES, packageIdentity, packageSourceOf, readDefaultExtensionProvenance, withLegacyRetiredDefaultPackageIdentities, } from "./default-extensions.mjs";
import { criticalGitSourceSpec, packageSourceInstallDir } from "./tlh-install-package-source.mjs";
import { assertProfilePathWithinAgent, copySafeProfileFile, ensureSafeProfileDir, isSymlink, pathIsProtectedPiConfig, } from "./tlh-install-paths.mjs";
import { backupPathWithTimestamp, readConfiguredNpmCommand, readJsonFile, } from "./tlh-install-utils.mjs";
import { writeProfileFileWithBackup, writeSafeProfileFile } from "./tlh-safe-profile-write.mjs";
const TLH_SUBAGENT_PROMPTS = Object.freeze([
    "developer.md",
    "test-runner.md",
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
        return { path: join(agentDir, "npm"), kind: "npm", packageName };
    }
    const spec = criticalGitSourceSpec(trimmed, { agentDir });
    if (!spec)
        return undefined;
    return { path: spec.targetDir, kind: "git" };
}
function pathWithin(root, target) {
    const normalizedRoot = resolve(root);
    const normalizedTarget = resolve(target);
    return (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`));
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
function gitInstallationIsOwned(path) {
    try {
        return lstatSync(path).isDirectory() && existsSync(join(path, ".git"));
    }
    catch {
        return false;
    }
}
/** Read the package-manager command that was active before settings migration. */
export function captureRetiredSubagentNpmCommand(settingsPath) {
    return readConfiguredNpmCommand(settingsPath);
}
function packageManagerCommand(config) {
    const configured = config.npmCommand ??
        (config.settingsPath ? captureRetiredSubagentNpmCommand(config.settingsPath) : undefined);
    const values = configured && configured.length > 0 ? [...configured] : ["npm"];
    const [command, ...args] = values;
    if (!command)
        throw new Error("invalid npmCommand: first entry must be a non-empty command");
    const separatorIndex = values.lastIndexOf("--");
    const packageManagerExecutable = separatorIndex >= 0 ? values[separatorIndex + 1] : command;
    const name = packageManagerExecutable
        ? basename(packageManagerExecutable).replace(/\.(cmd|exe)$/i, "")
        : "";
    return { command, args, name };
}
function packageManagerUninstallArgs(packageName, installRoot, packageManagerName) {
    if (packageManagerName === "bun") {
        return ["uninstall", packageName, "--cwd", installRoot];
    }
    const args = ["uninstall", packageName, "--prefix", installRoot];
    if (packageManagerName !== "pnpm")
        args.push("--legacy-peer-deps");
    return args;
}
function defaultPackageManagerRunner(command, args, options) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });
    return {
        status: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        error: result.error,
    };
}
function commandFailureSummary(result) {
    if (result.error)
        return result.error.message;
    const lines = `${result.stderr || ""}\n${result.stdout || ""}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const conciseLines = lines.length > 8 ? [...lines.slice(0, 4), ...lines.slice(-4)] : lines;
    return conciseLines.join(" | ") || `exit ${result.status ?? "unknown"}`;
}
function npmPackageStillDeclared(installRoot, packageName) {
    const packageJsonPath = join(installRoot, "package.json");
    if (!existsSync(packageJsonPath))
        return false;
    try {
        const packageJson = readJsonFile(packageJsonPath);
        return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((field) => {
            const dependencies = packageJson[field];
            return isPlainObject(dependencies) && Object.hasOwn(dependencies, packageName);
        });
    }
    catch {
        return true;
    }
}
function npmPackageStillInstalled(installRoot, packageName) {
    const packagePath = join(installRoot, "node_modules", packageName);
    if (!existsSync(packagePath))
        return false;
    try {
        return readJsonFile(join(packagePath, "package.json")).name === packageName;
    }
    catch {
        return true;
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
 * Physically remove entries captured from settings before merging those settings.
 * This preserves package ownership evidence when npm uninstall fails, so a later
 * installer or doctor run can retry. npm entries use the same configured package-
 * manager semantics as Pi so package.json, lockfiles, and node_modules converge
 * together. Git entries retain guarded filesystem cleanup because their package-
 * manager state lives in settings.json.
 */
export function cleanupManagedRetiredSubagentPackages(config, candidates) {
    const cleanupResult = {
        uninstalledNpmPackages: [],
        removedGitPaths: [],
        plannedNpmPackages: [],
        plannedGitPaths: [],
    };
    if (!config.agentDir || isSymlink(config.agentDir)) {
        if (candidates.length > 0)
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe agent dir: ${config.agentDir}`);
        return cleanupResult;
    }
    for (const candidate of candidates) {
        const install = sourceInstallPath(config.agentDir, candidate.source);
        if (!install)
            continue;
        if (!pathWithin(config.agentDir, install.path) ||
            hasSymlinkedParent(config.agentDir, install.path) ||
            isSymlink(install.path)) {
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe path: ${install.path}`);
            continue;
        }
        if (!existsSync(install.path))
            continue;
        try {
            if (!lstatSync(install.path).isDirectory()) {
                warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for non-directory path: ${install.path}`);
                continue;
            }
            assertProfilePathWithinAgent({ agentDir: config.agentDir }, install.path, "retired subagent package");
        }
        catch (error) {
            warnRetiredSubagentCleanup(`skipping retired subagent package cleanup for unsafe path: ${install.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (install.kind === "npm") {
            if (!npmPackageStillDeclared(install.path, install.packageName) &&
                !npmPackageStillInstalled(install.path, install.packageName)) {
                continue;
            }
            if (config.dryRun) {
                cleanupResult.plannedNpmPackages.push(install.packageName);
                logRetiredSubagentCleanup(config, `Would uninstall retired TLH subagent npm package: ${install.packageName} from ${install.path}`);
                continue;
            }
            const npmCommand = packageManagerCommand(config);
            const args = [
                ...npmCommand.args,
                ...packageManagerUninstallArgs(install.packageName, install.path, npmCommand.name),
            ];
            const runner = config.runPackageManager ?? defaultPackageManagerRunner;
            const commandResult = runner(npmCommand.command, args, {
                cwd: config.agentDir,
                env: {
                    ...process.env,
                    ...config.env,
                    NPM_CONFIG_AUDIT: "false",
                    NPM_CONFIG_FUND: "false",
                    NPM_CONFIG_LOGLEVEL: "error",
                },
            });
            if (commandResult.status !== 0) {
                throw new Error(`failed to uninstall retired TLH subagent npm package ${install.packageName}: ${commandFailureSummary(commandResult)}`);
            }
            if (npmPackageStillDeclared(install.path, install.packageName) ||
                npmPackageStillInstalled(install.path, install.packageName)) {
                throw new Error(`package manager reported success but retired TLH subagent npm package remains installed: ${install.packageName}`);
            }
            cleanupResult.uninstalledNpmPackages.push(install.packageName);
            logRetiredSubagentCleanup(config, `Uninstalled retired TLH subagent npm package: ${install.packageName} from ${install.path}`);
            continue;
        }
        if (!gitInstallationIsOwned(install.path))
            continue;
        if (config.dryRun) {
            cleanupResult.plannedGitPaths.push(install.path);
            logRetiredSubagentCleanup(config, `Would remove retired TLH subagent git package installation: ${install.path}`);
            continue;
        }
        try {
            rmSync(install.path, { recursive: true, force: true });
            cleanupResult.removedGitPaths.push(install.path);
            logRetiredSubagentCleanup(config, `Removed retired TLH subagent git package installation: ${install.path}`);
        }
        catch (error) {
            warnRetiredSubagentCleanup(`failed to remove retired subagent git package installation ${install.path}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
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
    return cleanupResult;
}
export function defaultExtensionsRequireCriticalInstall(defaultExtensionsFile, { noSettings = false } = {}) {
    if (noSettings || !defaultExtensionsFile || !existsSync(defaultExtensionsFile))
        return false;
    try {
        const defaults = readJsonFile(defaultExtensionsFile);
        return (Array.isArray(defaults) &&
            defaults.some((extension) => isPlainObject(extension) && extension.critical === true));
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
export function findTlhSubagentsDir(config, { localRepoDir = "", prompts = TLH_SUBAGENT_PROMPTS, } = {}) {
    const options = { prompts };
    if (!config.packageSourceIsDefault) {
        const packageRoot = packageSourceInstallDir(config.packageSource, {
            agentDir: config.agentDir,
        });
        if (packageRoot &&
            tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)) {
            return join(packageRoot, "agents", "subagents");
        }
    }
    if (localRepoDir &&
        tlhSubagentPromptsComplete(join(localRepoDir, "agents", "subagents"), options)) {
        return join(localRepoDir, "agents", "subagents");
    }
    if (config.packageSourceIsDefault) {
        const packageRoot = packageSourceInstallDir(config.packageSource, {
            agentDir: config.agentDir,
        });
        if (packageRoot &&
            tlhSubagentPromptsComplete(join(packageRoot, "agents", "subagents"), options)) {
            return join(packageRoot, "agents", "subagents");
        }
    }
    if (config.tmpDir &&
        tlhSubagentPromptsComplete(join(config.tmpDir, "agents", "subagents"), options)) {
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
 * The isolated profile owns these attention controls. The runtime may still
 * accept per-dispatch overrides, but persistent profile configuration must
 * converge to this policy on every installer lifecycle that can write it.
 */
const TLH_NEEDS_ATTENTION_AFTER_MS = 180000;
const RETIRED_SUBAGENT_CONTROL_KEYS = [
    "activeNoticeAfterMs",
    "activeNoticeAfterTurns",
    "activeNoticeAfterTokens",
];
const RETIRED_SUBAGENT_NOTIFY_EVENT = "active_long_running";
const SUBAGENT_EXTENSION_CONFIG_RELATIVE_PATH = "extensions/subagent/config.json";
export function formatSubagentExtensionConfigMigration(result, { dryRun }) {
    if (!result.changed)
        return dryRun
            ? "Would leave existing subagent extension config (extensions/subagent/config.json) untouched."
            : undefined;
    const action = dryRun ? "Would enforce" : "Enforced";
    const backup = result.backupPath
        ? `; ${dryRun ? "would back up existing config to" : "backed up previous config to"}: ${result.backupPath}`
        : "";
    return `${action} TLH subagent attention config (extensions/subagent/config.json): ${result.changes.join("; ")}${backup}.`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function configWarning(path, detail) {
    return `could not safely enforce TLH subagent attention config at ${path}: ${detail}; existing configuration was preserved; inspect the file and repair it manually before rerunning`;
}
function migrationBoundaryWarning(agentDir, path) {
    try {
        if (pathIsProtectedPiConfig(agentDir) || pathIsProtectedPiConfig(path)) {
            return `refusing to migrate TLH subagent attention config under normal Pi config root: ${agentDir}; normal Pi configuration was preserved`;
        }
    }
    catch (error) {
        return configWarning(path, `could not verify that the target is outside normal Pi configuration (${errorMessage(error)})`);
    }
    return undefined;
}
function readExistingSubagentExtensionConfig(config) {
    const path = join(config.agentDir, SUBAGENT_EXTENSION_CONFIG_RELATIVE_PATH);
    let stats;
    try {
        stats = lstatSync(path);
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return { kind: "missing", path };
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, `could not inspect the file (${errorMessage(error)})`),
        };
    }
    if (stats.isSymbolicLink()) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "the config path is a symbolic link"),
        };
    }
    if (!stats.isFile()) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "the config path is not a regular file"),
        };
    }
    if (stats.nlink !== 1) {
        return { kind: "unsafe", path, warning: configWarning(path, "the config file is hard-linked") };
    }
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (error) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, `the config file is unreadable (${errorMessage(error)})`),
        };
    }
    const normalized = raw.replace(/^\uFEFF/, "");
    if (!normalized.trim()) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "the config file is empty; expected a JSON object"),
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(normalized);
    }
    catch (error) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, `the config file contains invalid JSON (${errorMessage(error)})`),
        };
    }
    if (!isPlainObject(parsed)) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "the top-level JSON value must be an object"),
        };
    }
    if ("control" in parsed && !isPlainObject(parsed.control)) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "control must be an object when present"),
        };
    }
    if (isPlainObject(parsed.control) &&
        "notifyOn" in parsed.control &&
        !Array.isArray(parsed.control.notifyOn)) {
        return {
            kind: "unsafe",
            path,
            warning: configWarning(path, "control.notifyOn must be an array when present"),
        };
    }
    return { kind: "valid", path, value: parsed };
}
function migrationPlan(config) {
    const path = join(config.agentDir, SUBAGENT_EXTENSION_CONFIG_RELATIVE_PATH);
    const boundaryWarning = migrationBoundaryWarning(config.agentDir, path);
    if (boundaryWarning) {
        return {
            path,
            existing: {},
            updated: {},
            changes: [],
            existed: false,
            warning: boundaryWarning,
        };
    }
    const readResult = readExistingSubagentExtensionConfig(config);
    if (readResult.kind === "unsafe") {
        return {
            path: readResult.path,
            existing: {},
            updated: {},
            changes: [],
            existed: true,
            warning: readResult.warning,
        };
    }
    if (readResult.kind === "missing") {
        return {
            path: readResult.path,
            existing: {},
            updated: { control: { needsAttentionAfterMs: TLH_NEEDS_ATTENTION_AFTER_MS } },
            changes: [`set control.needsAttentionAfterMs: ${TLH_NEEDS_ATTENTION_AFTER_MS}`],
            existed: false,
        };
    }
    const existing = readResult.value;
    const existingControl = isPlainObject(existing.control) ? existing.control : {};
    const updatedControl = { ...existingControl };
    const changes = [];
    for (const key of RETIRED_SUBAGENT_CONTROL_KEYS) {
        if (!Object.hasOwn(updatedControl, key))
            continue;
        delete updatedControl[key];
        changes.push(`remove control.${key}`);
    }
    if (Array.isArray(updatedControl.notifyOn)) {
        const scrubbedNotifyOn = updatedControl.notifyOn.filter((entry) => entry !== RETIRED_SUBAGENT_NOTIFY_EVENT);
        if (scrubbedNotifyOn.length !== updatedControl.notifyOn.length) {
            updatedControl.notifyOn = scrubbedNotifyOn;
            changes.push(`remove ${RETIRED_SUBAGENT_NOTIFY_EVENT} from control.notifyOn`);
        }
    }
    if (updatedControl.needsAttentionAfterMs !== TLH_NEEDS_ATTENTION_AFTER_MS) {
        updatedControl.needsAttentionAfterMs = TLH_NEEDS_ATTENTION_AFTER_MS;
        changes.push(`set control.needsAttentionAfterMs: ${TLH_NEEDS_ATTENTION_AFTER_MS}`);
    }
    return {
        path: readResult.path,
        existing,
        updated: { ...existing, control: updatedControl },
        changes,
        existed: true,
    };
}
/**
 * Enforce the persistent isolated-profile subagent attention policy. Existing
 * valid objects are migrated conservatively, while malformed or unsafe input
 * is left untouched and returned as an actionable warning. A dry run computes
 * and reports the same plan without creating directories, backups, or files.
 */
export function migrateSubagentExtensionConfig(config) {
    const plan = migrationPlan(config);
    if (plan.warning)
        return { changed: false, changes: [], warning: plan.warning };
    if (plan.changes.length === 0)
        return { changed: false, changes: [] };
    const backupPath = plan.existed ? backupPathWithTimestamp(plan.path) : undefined;
    if (config.dryRun)
        return { changed: true, changes: plan.changes, backupPath };
    try {
        ensureSafeProfileDir(config, "extensions/subagent", "TLH subagent extension config directory");
        const formatted = `${JSON.stringify(plan.updated, null, 2)}\n`;
        if (backupPath) {
            writeProfileFileWithBackup(plan.path, formatted, {
                targetLabel: "TLH subagent extension config",
                sourceLabel: "TLH subagent extension config",
                backupLabel: "TLH subagent extension config backup",
                backupPath,
            });
        }
        else {
            writeSafeProfileFile(config, SUBAGENT_EXTENSION_CONFIG_RELATIVE_PATH, formatted, "TLH subagent extension config");
        }
    }
    catch (error) {
        return {
            changed: false,
            changes: plan.changes,
            warning: configWarning(plan.path, `the managed write failed (${errorMessage(error)})`),
        };
    }
    return { changed: true, changes: plan.changes, backupPath };
}
