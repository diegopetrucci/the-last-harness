import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installableSupportFiles, requiredSupportFiles, } from "./tlh-install-support-manifest.mjs";
import { settingsRequireTlhSubagentPrompts as settingsFileRequiresTlhSubagentPrompts } from "./tlh-install-subagents.mjs";
const DOWNLOAD_TIMEOUT_MS = 30_000;
function callLog(config, message, io) {
    if (typeof io.log === "function")
        io.log(config, message);
}
function callVerboseLog(config, message, io) {
    if (typeof io.verboseLog === "function")
        io.verboseLog(config, message);
}
function callWarn(message, io) {
    if (typeof io.warn === "function")
        io.warn(message);
    else
        console.error(`warning: ${message}`);
}
export function resetSupportFilePaths(config) {
    for (const file of config.supportFiles)
        config.supportFilePaths[file.variable] = "";
}
export function supportFilePathsArePrepared(config) {
    return config.supportFiles.some((file) => Boolean(config.supportFilePaths[file.variable]));
}
export function installableSupportFilesArePrepared(config) {
    return installableSupportFiles({ noSettings: config.noSettings }).some((file) => Boolean(config.supportFilePaths[file.variable]));
}
export function localRepoHasRequiredSupportFiles(config, dir) {
    return requiredSupportFiles({ noSettings: config.noSettings }).every((file) => existsSync(join(dir, file.relativePath)));
}
export function findLocalRepoDir(config) {
    if (localRepoHasRequiredSupportFiles(config, config.localRepoCandidate))
        return config.localRepoCandidate;
    return undefined;
}
export function prepareSupportFilesFromLocalRepo(config, localDir) {
    for (const file of config.supportFiles) {
        const sourcePath = join(localDir, file.relativePath);
        if (existsSync(sourcePath))
            config.supportFilePaths[file.variable] = sourcePath;
        else if (file.requirement === "required")
            return false;
        else
            config.supportFilePaths[file.variable] = "";
    }
    return true;
}
export function supportFileDryRunMessage(variable) {
    if (variable === "TLH_GNOSIS_SCRIPT")
        return "Would fetch Gnosis integration support files.";
    if (variable === "TLH_TICKETS_SCRIPT")
        return "Would fetch tlh tickets support files.";
    if (variable === "TLH_UPDATE_SCRIPT")
        return "Would fetch tlh update support files.";
    if (variable === "TLH_WRAPPER_SCRIPT")
        return "Would fetch tlh wrapper support files.";
    if (variable === "TLH_INSTALL_STATE_SCRIPT")
        return "Would fetch tlh install-state support files.";
    return "";
}
export function warnMissingOptionalSupportFile(config, variable, relativePath, io = {}) {
    if (variable === "TLH_UPDATE_SCRIPT") {
        callWarn(`tlh update support script not found for ref ${config.ref}; the wrapper update helper will be unavailable`, io);
    }
    else if (variable === "TLH_WRAPPER_SCRIPT") {
        callWarn(`tlh wrapper support script not found for ref ${config.ref}; wrapper creation will be unavailable`, io);
    }
    else if (variable === "TLH_INSTALL_STATE_SCRIPT") {
        callWarn(`tlh install-state support script not found for ref ${config.ref}; update metadata helper will be unavailable`, io);
    }
    else {
        callWarn(`optional installer support file not found for ref ${config.ref}: ${relativePath}`, io);
    }
}
export async function fetchToFile(url, path, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
    const response = await fetchImpl(url, {
        headers: { "User-Agent": "tlh-stage-1-installer" },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
        throw new Error(`${response.status} ${response.statusText}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}
export async function prepareSupportFilesFromRemote(config, io = {}) {
    if (typeof io.requireCommand === "function")
        io.requireCommand(config, "curl");
    config.tmpDir = mkdtempSync(join(tmpdir(), "tlh-install-"));
    callVerboseLog(config, `Fetching installer support files from ${config.rawBase}`, io);
    const fetchFile = io.fetchToFile || fetchToFile;
    for (const file of config.supportFiles) {
        const targetPath = join(config.tmpDir, file.tempPath);
        config.supportFilePaths[file.variable] = targetPath;
        try {
            await fetchFile(`${config.rawBase}/${file.relativePath}`, targetPath, io);
        }
        catch {
            if (file.requirement === "required") {
                throw new Error(`required installer support file not found for ref ${config.ref}: ${file.relativePath}`);
            }
            rmSync(targetPath, { force: true });
            config.supportFilePaths[file.variable] = "";
            warnMissingOptionalSupportFile(config, file.variable, file.relativePath, io);
        }
    }
    if (settingsFileRequiresTlhSubagentPrompts(config.supportFilePaths.DEFAULTS_FILE, {
        noSettings: config.noSettings,
    })) {
        const targetDir = join(config.tmpDir, "agents", "subagents");
        mkdirSync(targetDir, { recursive: true });
        for (const prompt of config.subagentPrompts) {
            const targetPath = join(targetDir, prompt);
            try {
                await fetchFile(`${config.rawBase}/agents/subagents/${prompt}`, targetPath, io);
            }
            catch {
                callWarn(`TLH subagent prompt not found in raw support files: ${prompt}; will try the installed package checkout.`, io);
                rmSync(targetPath, { force: true });
            }
        }
    }
}
export async function prepareSupportFiles(config, io = {}) {
    resetSupportFilePaths(config);
    const localDir = findLocalRepoDir(config);
    if (localDir)
        return prepareSupportFilesFromLocalRepo(config, localDir);
    await prepareSupportFilesFromRemote(config, io);
    return true;
}
export function prepareSupportFilesForDryRun(config, io = {}) {
    resetSupportFilePaths(config);
    const localDir = findLocalRepoDir(config);
    if (localDir)
        return prepareSupportFilesFromLocalRepo(config, localDir);
    if (config.supportFilesDryRunSkipped)
        return false;
    config.supportFilesDryRunSkipped = true;
    callLog(config, `Would fetch installer support files from ${config.rawBase}`, io);
    if (config.noSettings) {
        callLog(config, "Would skip settings and keybinding defaults merge (--no-settings).", io);
        callLog(config, "Would skip bundled default extension packages (--no-settings).", io);
    }
    else {
        callLog(config, `Would merge settings defaults into: ${config.settingsPath}`, io);
        callLog(config, `Would merge keybinding defaults into: ${config.keybindingsPath}`, io);
        callLog(config, "Would install bundled default extension packages after settings merge.", io);
    }
    for (const file of config.supportFiles) {
        const message = supportFileDryRunMessage(file.variable);
        if (message)
            callLog(config, message, io);
    }
    callLog(config, "Dry run only; no support files were downloaded.", io);
    return false;
}
export async function ensureSupportFilesPrepared(config, io = {}) {
    if (supportFilePathsArePrepared(config))
        return true;
    if (config.dryRun)
        return prepareSupportFilesForDryRun(config, io);
    return prepareSupportFiles(config, io);
}
export async function preflightRuntimeSupportFiles(config, io = {}) {
    if (config.dryRun)
        return;
    const prepared = await ensureSupportFilesPrepared(config, io);
    if (!prepared)
        throw new Error(`installer support files are unavailable for ref ${config.ref}`);
    const missing = [];
    if (!config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT ||
        !existsSync(config.supportFilePaths.TLH_INSTALL_STATE_SCRIPT)) {
        missing.push("scripts/tlh-install-state.mjs");
    }
    if (!config.noWrapper &&
        (!config.supportFilePaths.TLH_WRAPPER_SCRIPT ||
            !existsSync(config.supportFilePaths.TLH_WRAPPER_SCRIPT))) {
        missing.push("scripts/tlh-wrapper.mjs");
    }
    if (missing.length > 0) {
        throw new Error(`required installer support files not found for ref ${config.ref}: ${missing.join(" ")}`);
    }
}
