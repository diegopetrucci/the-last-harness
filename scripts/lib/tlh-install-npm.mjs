import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { disabledDefaultExtensionIds, packageIdentity, packageSourceOf, readDefaultExtensions, } from "./default-extensions.mjs";
import { assertProfilePathWithinAgent, isSymlink } from "./tlh-install-paths.mjs";
import { readJsonFile } from "./tlh-install-utils.mjs";
const EXACT_NPM_VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_PREINSTALL_STAGE_PREFIX = ".tlh-npm-defaults-";
function spawnErrorCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    return error.code;
}
function isJsonRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function npmPinnedSpec(source) {
    const trimmed = source.trim();
    if (!trimmed.startsWith("npm:"))
        return undefined;
    const spec = trimmed.slice("npm:".length).trim();
    const separator = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.lastIndexOf("@");
    if (separator <= 0)
        return undefined;
    const version = spec.slice(separator + 1);
    if (!EXACT_NPM_VERSION_RE.test(version))
        return undefined;
    return spec;
}
function readNpmPreinstallSettings(config, io) {
    try {
        const parsed = readJsonFile(config.settingsPath, { emptyValue: null });
        if (!isJsonRecord(parsed))
            throw new Error("settings must be a JSON object");
        if (parsed.packages !== undefined && !Array.isArray(parsed.packages)) {
            throw new Error("settings.packages must be an array when present");
        }
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const prefix = config.dryRun ? "Would skip" : "Skipping";
        io.log(`${prefix} pinned npm default-extension pre-install because merged settings are unreadable or malformed (${message}).`);
        return undefined;
    }
}
function configuredPlainNpmCommand(settings) {
    if (!Object.hasOwn(settings, "npmCommand"))
        return ["npm"];
    const value = settings.npmCommand;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        return undefined;
    }
    if (value.length === 0)
        return ["npm"];
    if (value.length !== 1)
        return undefined;
    const command = value[0];
    if (!command)
        return undefined;
    const commandName = command.split(/[\\/]/).at(-1)?.toLowerCase() || "";
    if (commandName !== "npm" && commandName !== "npm.cmd" && commandName !== "npm.exe") {
        return undefined;
    }
    return [command];
}
function truthyEnvironmentValue(value) {
    return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
function npmDestinationExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (spawnErrorCode(error) === "ENOENT")
            return false;
        throw error;
    }
}
function ensureNpmStageParent(config) {
    const agentDir = resolve(config.agentDir);
    if (isSymlink(agentDir)) {
        throw new Error(`refusing to create npm staging root through symlinked TLH profile path: ${agentDir}`);
    }
    if (existsSync(agentDir) && !lstatSync(agentDir).isDirectory()) {
        throw new Error(`refusing to use non-directory TLH profile root for npm staging: ${agentDir}`);
    }
    assertProfilePathWithinAgent(config, agentDir, "npm staging root parent");
    if (!existsSync(agentDir))
        mkdirSync(agentDir, { recursive: true });
    return agentDir;
}
function markNpmStageIgnoredByCloudSync(config, stagePath, io) {
    const attributes = process.platform === "darwin"
        ? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
        : process.platform === "linux"
            ? ["user.com.dropbox.ignored"]
            : [];
    if (attributes.length === 0)
        return;
    const command = process.platform === "darwin" ? "xattr" : "setfattr";
    for (const attribute of attributes) {
        try {
            spawnSync(command, process.platform === "darwin"
                ? ["-w", attribute, "1", stagePath]
                : ["-n", attribute, "-v", "1", stagePath], { env: io.inheritedCommandEnv(), stdio: "ignore" });
        }
        catch {
            // Cloud-sync metadata is an optional parity improvement. npm installation
            // remains safe when xattr/setfattr is unavailable or rejects the path.
        }
    }
}
function assertNpmStageDirectory(config, stagePath, phase) {
    const stats = lstatSync(stagePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`npm staging root is not a regular directory ${phase}: ${stagePath}`);
    }
    assertProfilePathWithinAgent(config, stagePath, `npm staging root ${phase}`);
}
function prepareNpmStage(config, stagePath, io) {
    assertNpmStageDirectory(config, stagePath, "before install");
    markNpmStageIgnoredByCloudSync(config, stagePath, io);
    writeFileSync(join(stagePath, ".gitignore"), "*\n!.gitignore\n", {
        encoding: "utf8",
        flag: "wx",
    });
    writeFileSync(join(stagePath, "package.json"), JSON.stringify({ name: "pi-extensions", private: true }, null, 2), { encoding: "utf8", flag: "wx" });
}
function cleanupNpmStage(config, stagePath, io) {
    if (!stagePath)
        return;
    try {
        const stats = lstatSync(stagePath);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            unlinkSync(stagePath);
            return;
        }
        assertProfilePathWithinAgent(config, stagePath, "npm staging cleanup");
        rmSync(stagePath, { recursive: true, force: true });
    }
    catch (error) {
        if (spawnErrorCode(error) === "ENOENT")
            return;
        io.warn(`could not clean npm staging root ${stagePath}: ${String(error)}`);
    }
}
function promoteNpmStage(stagePath, npmRoot, io) {
    if (npmDestinationExists(npmRoot)) {
        io.warn(`npm pre-install destination appeared during staging; leaving the existing npm root untouched: ${npmRoot}`);
        return false;
    }
    try {
        renameSync(stagePath, npmRoot);
        return true;
    }
    catch (error) {
        const destinationAppeared = (() => {
            try {
                return npmDestinationExists(npmRoot);
            }
            catch {
                return false;
            }
        })();
        const code = spawnErrorCode(error);
        if (destinationAppeared || code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") {
            io.warn(`npm pre-install destination appeared during promotion; leaving the existing npm root untouched: ${npmRoot}`);
            return false;
        }
        throw error;
    }
}
/**
 * Pre-install enabled, pinned npm defaults into a fresh staging root and
 * atomically promote that root to the profile's npm project after npm exits
 * successfully. Pi's startup package manager remains the fallback for every
 * skipped, offline, failed, or raced install.
 */
export function preInstallNpmDefaultExtensions(config, io) {
    if (config.noSettings) {
        io.log("Skipping pinned npm default-extension pre-install (--no-settings).");
        return;
    }
    if (truthyEnvironmentValue(config.env?.PI_OFFLINE)) {
        io.log("Skipping pinned npm default-extension pre-install (PI_OFFLINE is set).");
        return;
    }
    if (!config.supportFilePaths.DEFAULT_EXTENSIONS_FILE ||
        !existsSync(config.supportFilePaths.DEFAULT_EXTENSIONS_FILE)) {
        if (config.dryRun) {
            io.log("Would pre-install pinned npm default extensions after settings merge.");
        }
        return;
    }
    const settingsExists = existsSync(config.settingsPath);
    const settings = settingsExists || !config.dryRun ? readNpmPreinstallSettings(config, io) : undefined;
    if (settingsExists && !settings)
        return;
    if (!settingsExists && !config.dryRun)
        return;
    let defaultExtensions;
    try {
        defaultExtensions = readDefaultExtensions(config.supportFilePaths.DEFAULT_EXTENSIONS_FILE);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.warn(`could not read bundled default extensions for npm pre-install: ${message}`);
        return;
    }
    const disabledIds = settings
        ? disabledDefaultExtensionIds(settings, defaultExtensions)
        : new Set();
    const configuredEntries = settings && Array.isArray(settings.packages) ? settings.packages : [];
    const configuredSources = configuredEntries
        .map(packageSourceOf)
        .filter((source) => typeof source === "string")
        .map((source) => source.trim());
    const configuredIdentities = new Set(configuredEntries
        .map(packageIdentity)
        .filter((identity) => typeof identity === "string"));
    const npmSpecs = [];
    for (const extension of defaultExtensions) {
        if (disabledIds.has(extension.id))
            continue;
        const spec = npmPinnedSpec(extension.source);
        if (!spec)
            continue;
        const sourceMatches = configuredSources.some((source) => source === extension.source);
        const identity = packageIdentity(extension.source);
        const dryRunMergeWouldAddDefault = config.dryRun && identity !== undefined && !configuredIdentities.has(identity);
        if (!sourceMatches && !dryRunMergeWouldAddDefault)
            continue;
        npmSpecs.push(spec);
    }
    if (npmSpecs.length === 0) {
        io.verboseLog("No enabled pinned npm default extensions match merged settings.");
        return;
    }
    const npmCommand = configuredPlainNpmCommand(settings || {});
    if (!npmCommand) {
        io.log("Skipping pinned npm default-extension pre-install because Pi's configured npmCommand is not plain npm.");
        return;
    }
    const npmRoot = join(config.agentDir, "npm");
    try {
        if (npmDestinationExists(npmRoot)) {
            io.verboseLog(`Skipping pinned npm default-extension pre-install because the npm root already exists (left untouched): ${npmRoot}`);
            return;
        }
    }
    catch (error) {
        io.warn(`could not inspect the npm root safely; skipping pinned npm default-extension pre-install: ${String(error)}`);
        return;
    }
    const displayStagePath = join(config.agentDir, `${NPM_PREINSTALL_STAGE_PREFIX}<fresh>`);
    const installArgs = [
        ...npmCommand,
        "install",
        ...npmSpecs,
        "--prefix",
        config.dryRun ? displayStagePath : "<staging-root>",
        "--legacy-peer-deps",
    ];
    io.log(`Pre-installing ${npmSpecs.length} pinned npm default extension(s) in a fresh staging root...`);
    if (config.dryRun) {
        io.log(`Would create a fresh npm staging root under ${config.agentDir}; existing npm roots are not read or changed.`);
        io.runCommand(installArgs.map((arg) => (arg === "<staging-root>" ? displayStagePath : arg)));
        io.log(`Would atomically promote the successful staging root to ${npmRoot}.`);
        return;
    }
    let stagePath;
    try {
        const stageParent = ensureNpmStageParent(config);
        stagePath = mkdtempSync(join(stageParent, NPM_PREINSTALL_STAGE_PREFIX));
        assertProfilePathWithinAgent(config, stagePath, "npm staging root");
        prepareNpmStage(config, stagePath, io);
        const commandArgs = [
            ...npmCommand,
            "install",
            ...npmSpecs,
            "--prefix",
            stagePath,
            "--legacy-peer-deps",
        ];
        io.runCommand(commandArgs);
        assertNpmStageDirectory(config, stagePath, "after npm install");
        if (promoteNpmStage(stagePath, npmRoot, io))
            stagePath = undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.warn(`npm pre-install of pinned default extensions failed: ${message}; Pi will install missing packages on first launch.`);
    }
    finally {
        cleanupNpmStage(config, stagePath, io);
    }
}
