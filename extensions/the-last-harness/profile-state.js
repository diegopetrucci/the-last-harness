import { closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord, pathWithinOrEqual, readText, realpathForCompare, } from "./common.js";
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
        if (!pathWithinOrEqual(resolvedAgentDir, resolvedTargetPath) ||
            isNormalPiConfigPath(resolvedTargetPath)) {
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
export async function readTlhInstallStateAsync() {
    const statePath = tlhInstallStatePath();
    if (!statePath) {
        return {};
    }
    try {
        const content = await readFile(statePath, "utf8");
        if (!content) {
            return {};
        }
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function canUseTlhStateDir(statePath, resolveExpectedPath) {
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
        return resolveExpectedPath() === statePath;
    }
    catch {
        return false;
    }
}
function canReplaceTlhStateFile(statePath) {
    try {
        const stateStat = lstatSync(statePath);
        return !stateStat.isSymbolicLink() && stateStat.isFile();
    }
    catch (error) {
        return isRecord(error) && error.code === "ENOENT";
    }
}
function writeTlhStateFileAtomicallyCore(statePath, content, nofollowFlag) {
    if (typeof nofollowFlag !== "number" || nofollowFlag === 0) {
        return false;
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
    return true;
}
function writeTlhStateFileAtomically(statePath, content) {
    return writeTlhStateFileAtomicallyCore(statePath, content, constants.O_NOFOLLOW);
}
export function writeGuardedTlhStateFile(statePath, content, resolveExpectedPath) {
    const managedDir = tlhStateDir();
    if (!managedDir) {
        return false;
    }
    try {
        if (!pathWithinOrEqual(realpathForCompare(managedDir), realpathForCompare(statePath))) {
            return false;
        }
    }
    catch {
        return false;
    }
    if (!canUseTlhStateDir(statePath, resolveExpectedPath) || !canReplaceTlhStateFile(statePath)) {
        return false;
    }
    return writeTlhStateFileAtomically(statePath, content);
}
export function writeTlhStartupState(state) {
    try {
        const statePath = tlhStartupStatePath();
        if (!statePath) {
            return;
        }
        writeGuardedTlhStateFile(statePath, `${JSON.stringify(state, null, 2)}\n`, tlhStartupStatePath);
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
const SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT = 32;
function settingsBackupTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
function writeCollisionSafeSettingsBackup(settingsPath, current) {
    const timestamp = settingsBackupTimestamp();
    for (let suffix = 0; suffix <= SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT; suffix += 1) {
        const backupPath = suffix === 0
            ? `${settingsPath}.bak-${timestamp}`
            : `${settingsPath}.bak-${timestamp}-${suffix}`;
        try {
            writeFileSync(backupPath, current, { encoding: "utf8", flag: "wx", mode: 0o600 });
            return backupPath;
        }
        catch (error) {
            if (!isRecord(error) || error.code !== "EEXIST") {
                throw error;
            }
        }
    }
    throw new Error(`Could not create a unique TLH settings backup after ${SETTINGS_BACKUP_SUFFIX_RETRY_LIMIT + 1} attempts: ${settingsPath}.bak-${timestamp}`);
}
function isSettingsStorageLike(value) {
    return isRecord(value) && typeof value.withLock === "function";
}
function getSettingsStorageForWrite(cwd) {
    const manager = SettingsManager.create(cwd, getAgentDir());
    const storage = isRecord(manager) ? manager.storage : undefined;
    if (!isSettingsStorageLike(storage)) {
        throw new Error("Pi settings storage is unavailable.");
    }
    return storage;
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
            const backupPath = writeCollisionSafeSettingsBackup(settingsPath, current);
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
    if (resolvedSettingsPath === normalPiRoot ||
        resolvedSettingsPath.startsWith(`${normalPiRoot}${sep}`)) {
        throw new Error(`Refusing to modify normal Pi config from tlh: ${formatHomePath(settingsPath)}`);
    }
}
export const __testing = {
    writeTlhStateFileAtomicallyCore,
};
