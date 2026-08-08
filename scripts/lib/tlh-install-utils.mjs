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
    return (expandHomePath(configured || join(homeDir, ".the-last-harness", "agent"), { homeDir }) ||
        join(homeDir, ".the-last-harness", "agent"));
}
export function resolveTlhAgentDir(agentDir, options = {}) {
    return (expandHomePath(agentDir || defaultTlhAgentDir(options.env, options), options) ||
        defaultTlhAgentDir(options.env, options));
}
export function defaultTlhSettingsPath({ agentDir, env = process.env, homeDir = homedir(), preferTlhAgentDir = false, } = {}) {
    return join(resolveTlhAgentDir(agentDir, { env, homeDir, preferTlhAgentDir }), "settings.json");
}
export function defaultTlhKeybindingsPath({ agentDir, env = process.env, homeDir = homedir(), preferTlhAgentDir = false, } = {}) {
    return join(resolveTlhAgentDir(agentDir, { env, homeDir, preferTlhAgentDir }), "keybindings.json");
}
export function defaultTlhBinDir(env = process.env, { homeDir = homedir() } = {}) {
    return (expandHomePath(env.TLH_BIN_DIR || join(homeDir, ".local", "bin"), { homeDir }) || join(homeDir, ".local", "bin"));
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
export function backupPathWithTimestamp(path, { marker = "", date = new Date(), includeMilliseconds = true, } = {}) {
    const markerText = marker ? `-${marker}` : "";
    return `${path}.backup${markerText}-${backupTimestampSuffix(date, { includeMilliseconds })}`;
}
// ---------------------------------------------------------------------------
// Backup-retention helpers (pure / deterministic)
// ---------------------------------------------------------------------------
/**
 * Parse the ISO-8601-derived timestamp embedded in a backup filename produced
 * by backupPathWithTimestamp. Handles all four naming variants:
 *   <base>.backup-<YYYY-MM-DDTHH-MM-SS-mmmZ>          (no marker, with ms)
 *   <base>.backup-<YYYY-MM-DDTHH-MM-SSZ>              (no marker, no ms)
 *   <base>.backup-<marker>-<YYYY-MM-DDTHH-MM-SS-mmmZ> (marker, with ms)
 *   <base>.backup-<marker>-<YYYY-MM-DDTHH-MM-SSZ>     (marker, no ms)
 *
 * Returns undefined when no recognisable timestamp is found or parsing fails.
 */
export function parseBackupTimestamp(filename) {
    // The timestamp always appears at the end of the filename and matches the
    // pattern produced by backupTimestampSuffix: YYYY-MM-DDTHH-MM-SS[-mmmZ|Z].
    const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/.exec(filename);
    if (!match)
        return undefined;
    const [, datePart, hh, mm, ss, ms] = match;
    const iso = ms ? `${datePart}T${hh}:${mm}:${ss}.${ms}Z` : `${datePart}T${hh}:${mm}:${ss}Z`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return undefined;
    return date;
}
/**
 * The exact marker strings that TLH produces via backupPathWithTimestamp.
 * Any marker not in this set belongs to a user-created or third-party file
 * and must never be selected for automatic cleanup.
 */
const TLH_BACKUP_MARKERS = new Set(["", "tlh-tickets", "tlh-defaults", "before-install"]);
/** Timestamp suffix pattern produced by backupTimestampSuffix (full-string match). */
const BACKUP_TIMESTAMP_FULL = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z$/;
/**
 * Returns true only when `filename` is an exact TLH-owned backup for `baseName`:
 *   `<baseName>.backup-<timestamp>`               (empty/no marker)
 *   `<baseName>.backup-<knownMarker>-<timestamp>`  (named marker)
 *
 * Ownership requires **both**:
 *   1. The timestamp occupies the exact expected position with the correct shape
 *      (guaranteed by BACKUP_TIMESTAMP_FULL – shape-only regex anchored to the
 *      full suffix so no marker prefix can bleed into the match).
 *   2. The timestamp is semantically valid (i.e. parseBackupTimestamp returns a
 *      Date, ruling out impossible calendar values like month 99).
 *
 * A file with any other marker segment – e.g.
 *   `settings.json.backup-my-personal-copy-2026-07-11T17-01-16-155Z`
 * – returns false and must not be touched by stale-backup cleanup.
 */
export function isTlhOwnedBackupFilename(filename, baseName) {
    const backupPrefix = `${baseName}.backup-`;
    if (!filename.startsWith(backupPrefix))
        return false;
    const rest = filename.slice(backupPrefix.length); // everything after "<baseName>.backup-"
    for (const marker of TLH_BACKUP_MARKERS) {
        const markerPrefix = marker ? `${marker}-` : "";
        if (rest.startsWith(markerPrefix)) {
            const tsPart = rest.slice(markerPrefix.length);
            if (BACKUP_TIMESTAMP_FULL.test(tsPart) && parseBackupTimestamp(filename) !== undefined)
                return true;
        }
    }
    return false;
}
/**
 * Given a list of backup-filename candidates, return the subset that should be
 * deleted according to the retention policy:
 *
 *   1. Sort candidates newest-first by effective timestamp.
 *   2. Always retain the newest `keepNewest` files regardless of age.
 *   3. Of the remaining files, mark those strictly older than `maxAgeMs` for
 *      deletion.
 *
 * This function is pure and performs no filesystem I/O.
 */
export function selectExpiredBackups(candidates, { maxAgeMs = 28 * 24 * 60 * 60 * 1000, keepNewest = 2, now = new Date(), mtimeFallback, } = {}) {
    if (candidates.length === 0)
        return [];
    const nowMs = now.getTime();
    const withTimestamps = candidates.map((filename) => {
        const parsed = parseBackupTimestamp(filename);
        if (parsed !== undefined)
            return { filename, ts: parsed.getTime() };
        // Fall back to the caller-supplied mtime, or treat as age 0 (very new)
        // so that files with unknown provenance are not accidentally deleted.
        const mtime = mtimeFallback?.(filename);
        return { filename, ts: mtime !== undefined ? mtime : nowMs };
    });
    // Sort newest-first so keepNewest is a simple prefix guard.
    withTimestamps.sort((a, b) => b.ts - a.ts);
    const toDelete = [];
    for (let i = 0; i < withTimestamps.length; i++) {
        if (i < keepNewest)
            continue; // unconditionally retained
        const ageMs = nowMs - withTimestamps[i].ts;
        if (ageMs > maxAgeMs) {
            toDelete.push(withTimestamps[i].filename);
        }
    }
    return toDelete;
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
