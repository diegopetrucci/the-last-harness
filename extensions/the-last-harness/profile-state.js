import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord, pathWithinOrEqual, readText, realpathForCompare } from "./common.js";
export function isDefaultPiAgentDir(agentDir) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home)
        return false;
    try {
        return realpathForCompare(agentDir) === realpathForCompare(join(home, ".pi", "agent"));
    }
    catch {
        return resolve(agentDir) === resolve(home, ".pi", "agent");
    }
}
export function isNormalPiConfigPath(resolvedPath) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) {
        return false;
    }
    const normalPiRoot = realpathForCompare(join(home, ".pi"));
    return pathWithinOrEqual(normalPiRoot, resolvedPath);
}
export function safeTlhProfileFilePath(relativePath) {
    const agentDir = getAgentDir();
    if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
        return undefined;
    }
    const targetPath = join(agentDir, relativePath);
    try {
        const resolvedAgentDir = realpathForCompare(agentDir);
        const resolvedTargetPath = realpathForCompare(targetPath);
        if (!pathWithinOrEqual(resolvedAgentDir, resolvedTargetPath) || isNormalPiConfigPath(resolvedTargetPath)) {
            return undefined;
        }
        return targetPath;
    }
    catch {
        return undefined;
    }
}
export function tlhStateDir() {
    return safeTlhProfileFilePath("tlh");
}
export function tlhStatePath(fileName) {
    return safeTlhProfileFilePath(join("tlh", fileName));
}
export function tlhStartupStatePath() {
    return tlhStatePath("startup-state.json");
}
export function tlhTelemetryStatePath() {
    return tlhStatePath("telemetry-state.json");
}
export function readTlhStartupState() {
    const statePath = tlhStartupStatePath();
    const content = statePath ? readText(statePath) : undefined;
    if (!content) {
        return {};
    }
    try {
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
export function tlhInstallStatePath() {
    return safeTlhProfileFilePath(join("tlh", "install-state.json"));
}
export function readTlhInstallState() {
    const statePath = tlhInstallStatePath();
    const content = statePath ? readText(statePath) : undefined;
    if (!content) {
        return {};
    }
    try {
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function canUseTlhStartupStateDir(statePath) {
    const stateDir = dirname(statePath);
    try {
        const dirStat = lstatSync(stateDir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
            return false;
        }
    }
    catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") {
            return false;
        }
    }
    try {
        mkdirSync(stateDir, { recursive: true });
        const dirStat = lstatSync(stateDir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
            return false;
        }
        return tlhStartupStatePath() === statePath;
    }
    catch {
        return false;
    }
}
function canReplaceTlhStartupStateFile(statePath) {
    try {
        const stateStat = lstatSync(statePath);
        return !stateStat.isSymbolicLink() && stateStat.isFile();
    }
    catch (error) {
        return isRecord(error) && error.code === "ENOENT";
    }
}
function writeTlhStartupStateAtomically(statePath, content) {
    const nofollowFlag = constants.O_NOFOLLOW;
    if (typeof nofollowFlag !== "number" || nofollowFlag === 0) {
        return;
    }
    const stateDir = dirname(statePath);
    const stateBase = basename(statePath);
    const tempPath = join(stateDir, `.${stateBase}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
    let fd;
    let cleanupError;
    try {
        fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollowFlag, 0o600);
        writeFileSync(fd, content, { encoding: "utf8" });
        closeSync(fd);
        fd = undefined;
        renameSync(tempPath, statePath);
    }
    finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
        try {
            unlinkSync(tempPath);
        }
        catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT") {
                cleanupError = error;
            }
        }
    }
    if (cleanupError !== undefined) {
        throw cleanupError;
    }
}
export function writeTlhStartupState(state) {
    try {
        const statePath = tlhStartupStatePath();
        if (!statePath || !canUseTlhStartupStateDir(statePath) || !canReplaceTlhStartupStateFile(statePath)) {
            return;
        }
        writeTlhStartupStateAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    catch {
    }
}
export function updateTlhStartupState(updates) {
    writeTlhStartupState({ ...readTlhStartupState(), ...updates });
}
export function tlhSettingsPathForWrite() {
    const agentDir = getAgentDir();
    if (!process.env.PI_CODING_AGENT_DIR || isDefaultPiAgentDir(agentDir)) {
        return undefined;
    }
    return join(agentDir, "settings.json");
}
function settingsBackupTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
function getSettingsStorageForWrite(cwd) {
    const manager = SettingsManager.create(cwd, getAgentDir());
    if (!manager.storage || typeof manager.storage.withLock !== "function") {
        throw new Error("Pi settings storage is unavailable.");
    }
    return manager.storage;
}
export function withLockedTlhSettingsWrite(cwd, outsideProfileError, update) {
    const settingsPath = tlhSettingsPathForWrite();
    if (!settingsPath) {
        throw new Error(outsideProfileError);
    }
    assertSafeTlhSettingsPath(settingsPath);
    let result;
    getSettingsStorageForWrite(cwd).withLock("global", (current) => {
        const outcome = update(current);
        const { nextContent, ...baseResult } = outcome;
        if (!baseResult.changed) {
            result = { ...baseResult, settingsPath };
            return undefined;
        }
        if (typeof nextContent !== "string") {
            throw new Error("TLH settings write must provide replacement content when changed.");
        }
        if (current) {
            const backupPath = `${settingsPath}.bak-${settingsBackupTimestamp()}`;
            writeFileSync(backupPath, current, { encoding: "utf8", flag: "wx", mode: 0o600 });
            result = { ...baseResult, settingsPath, backupPath };
            return nextContent;
        }
        result = { ...baseResult, settingsPath };
        return nextContent;
    });
    if (!result) {
        throw new Error("Pi settings storage did not return a write result.");
    }
    return result;
}
export function assertSafeTlhSettingsPath(settingsPath) {
    try {
        const settingsStat = lstatSync(settingsPath);
        if (settingsStat.isSymbolicLink()) {
            throw new Error(`Refusing to write symlinked TLH settings file: ${settingsPath}`);
        }
        if (!settingsStat.isFile()) {
            throw new Error(`Refusing to write non-file TLH settings path: ${settingsPath}`);
        }
        if (settingsStat.nlink > 1) {
            throw new Error(`Refusing to write hardlinked TLH settings file: ${settingsPath}`);
        }
    }
    catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") {
            throw error;
        }
    }
    const agentDir = realpathForCompare(getAgentDir());
    const resolvedSettingsPath = realpathForCompare(settingsPath);
    if (!pathWithinOrEqual(agentDir, resolvedSettingsPath)) {
        throw new Error(`Refusing to write settings outside the isolated TLH profile: ${settingsPath}`);
    }
    if (isNormalPiConfigPath(resolvedSettingsPath)) {
        throw new Error(`Refusing to modify normal Pi config from The Last Harness: ${settingsPath}`);
    }
}
export function assertNotNormalPiSettings(settingsPath) {
    const normalPiRoot = realpathForCompare(join(homedir(), ".pi"));
    const resolvedSettingsPath = realpathForCompare(settingsPath);
    if (resolvedSettingsPath === normalPiRoot || resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
        throw new Error(`Refusing to modify normal Pi config from tlh: ${formatHomePath(settingsPath)}`);
    }
}
