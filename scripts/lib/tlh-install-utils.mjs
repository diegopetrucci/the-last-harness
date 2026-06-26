import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathWithinOrEqual, realpathForCompare } from "./tlh-install-paths.mjs";
export function requiredValue(argv, index, flag) {
    const value = argv[index];
    if (!value || value.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
export function assignRequiredEqualsValue(target, key, value, flag) {
    if (!value)
        throw new Error(`${flag} requires a value`);
    target[key] = value;
}
export function readOptionValue(argv, index, flags, { requireEqualsValue = false } = {}) {
    const arg = argv[index];
    if (typeof arg !== "string")
        return undefined;
    for (const flag of Array.isArray(flags) ? flags : [flags]) {
        if (arg === flag) {
            return { flag, value: requiredValue(argv, index + 1, arg), nextIndex: index + 1 };
        }
        const prefix = `${flag}=`;
        if (!arg.startsWith(prefix))
            continue;
        const value = arg.slice(prefix.length);
        if (requireEqualsValue && !value)
            throw new Error(`${flag} requires a value`);
        return { flag, value, nextIndex: index };
    }
    return undefined;
}
export function assignOptionValue(target, key, argv, index, flags, options = {}) {
    const match = readOptionValue(argv, index, flags, options);
    if (!match)
        return undefined;
    target[key] = match.value;
    return match.nextIndex;
}
export function expandHomePath(path, { homeDir = homedir() } = {}) {
    if (typeof path !== "string")
        return path;
    if (path === "~")
        return homeDir;
    if (path.startsWith("~/"))
        return join(homeDir, path.slice(2));
    return path;
}
function firstConfiguredValue(...values) {
    for (const value of values) {
        if (typeof value === "string" && value)
            return value;
    }
    return undefined;
}
export function defaultTlhAgentDir(env = process.env, { homeDir = homedir(), preferTlhAgentDir = false } = {}) {
    const configured = preferTlhAgentDir
        ? firstConfiguredValue(env.TLH_AGENT_DIR, env.PI_CODING_AGENT_DIR)
        : firstConfiguredValue(env.PI_CODING_AGENT_DIR, env.TLH_AGENT_DIR);
    return expandHomePath(configured || join(homeDir, ".the-last-harness", "agent"), { homeDir }) || join(homeDir, ".the-last-harness", "agent");
}
export function resolveTlhAgentDir(agentDir, options = {}) {
    return expandHomePath(agentDir || defaultTlhAgentDir(options.env, options), options) || defaultTlhAgentDir(options.env, options);
}
export function defaultTlhSettingsPath({ agentDir, env = process.env, homeDir = homedir(), preferTlhAgentDir = false, } = {}) {
    return join(resolveTlhAgentDir(agentDir, { env, homeDir, preferTlhAgentDir }), "settings.json");
}
export function defaultTlhKeybindingsPath({ agentDir, env = process.env, homeDir = homedir(), preferTlhAgentDir = false, } = {}) {
    return join(resolveTlhAgentDir(agentDir, { env, homeDir, preferTlhAgentDir }), "keybindings.json");
}
export function defaultTlhBinDir(env = process.env, { homeDir = homedir() } = {}) {
    return expandHomePath(env.TLH_BIN_DIR || join(homeDir, ".local", "bin"), { homeDir }) || join(homeDir, ".local", "bin");
}
export function readJsonFile(path, { missingValue, emptyValue = {} } = {}) {
    if (!existsSync(path)) {
        if (missingValue !== undefined)
            return missingValue;
        throw new Error(`File does not exist: ${path}`);
    }
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim())
        return emptyValue;
    try {
        return JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in ${path}: ${message}`, { cause: error });
    }
}
function throwSymlinkedBackupSource(path, label) {
    throw new Error(`refusing to back up symlinked ${label} source: ${path}`);
}
function throwNonRegularBackupSource(path, label) {
    throw new Error(`refusing to back up non-regular ${label} source: ${path}`);
}
function validateBackupSourcePathStats(stats, path, label) {
    if (stats.isSymbolicLink())
        throwSymlinkedBackupSource(path, label);
    if (!stats.isFile())
        throwNonRegularBackupSource(path, label);
}
function backupSourceIdentity(stats) {
    return { dev: stats.dev, ino: stats.ino };
}
function sameBackupSourceIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
export function readRegularFileForBackup(path, label) {
    const openFlags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
    let fd;
    try {
        try {
            fd = openSync(path, openFlags);
        }
        catch (error) {
            if (error?.code === "ELOOP")
                throwSymlinkedBackupSource(path, label);
            try {
                validateBackupSourcePathStats(lstatSync(path), path, label);
            }
            catch (pathError) {
                if (pathError?.code !== "ENOENT")
                    throw pathError;
            }
            throw error;
        }
        const openedStats = fstatSync(fd);
        if (!openedStats.isFile())
            throwNonRegularBackupSource(path, label);
        const pathStats = lstatSync(path);
        validateBackupSourcePathStats(pathStats, path, label);
        if (!sameBackupSourceIdentity(backupSourceIdentity(openedStats), backupSourceIdentity(pathStats))) {
            throw new Error(`refusing to back up changed ${label} source during read: ${path}`);
        }
        return {
            content: readFileSync(fd),
            mode: openedStats.mode & 0o777,
        };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
export function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
export function shellWord(value) {
    const text = String(value);
    if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(text))
        return text;
    return shellQuote(text);
}
export function renderShellWords(values) {
    return [...values].map(shellWord).join(" ");
}
export function backupTimestampSuffix(date = new Date(), { includeMilliseconds = true } = {}) {
    const iso = date.toISOString();
    if (includeMilliseconds)
        return iso.replace(/[:.]/g, "-");
    return iso.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}
export function backupPathWithTimestamp(path, { marker = "", date = new Date(), includeMilliseconds = true } = {}) {
    const markerText = marker ? `-${marker}` : "";
    return `${path}.backup${markerText}-${backupTimestampSuffix(date, { includeMilliseconds })}`;
}
export function pathIsInNormalPiConfig(path, { homeDir = homedir(), alreadyNormalized = false } = {}) {
    const normalPiRoot = realpathForCompare(join(homeDir, ".pi"));
    const normalizedPath = alreadyNormalized ? path : realpathForCompare(path);
    return pathWithinOrEqual(normalPiRoot, normalizedPath);
}
export function assertNotInNormalPiConfig(path, message, options = {}) {
    if (!pathIsInNormalPiConfig(path, options))
        return;
    throw new Error(typeof message === "function" ? message(path) : message);
}
