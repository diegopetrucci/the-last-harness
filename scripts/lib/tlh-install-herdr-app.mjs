// Generated from scripts/lib/tlh-install-herdr-app.mts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isSymlink, pathIsProtectedPiConfig, pathWithinOrEqual, realpathForCompare, } from "./tlh-install-paths.mjs";
import { backupPathWithTimestamp, expandHomePath } from "./tlh-install-utils.mjs";
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
const HERDR_APP_HOME_ENV = "HERDR_APP_HOME";
const HERDR_PROGRAMS_FILENAME = "programs.json";
const HERDR_TLH_PROGRAM_KEY = "tlh";
const HERDR_TLH_PROGRAM_NAME = "TLH";
// TLH-owned subfolder of the app home: Herdr rewrites its own `icons/` on start.
const HERDR_TLH_ICON_DIRECTORY = "tlh";
const HERDR_TLH_ICON_FILENAME = "tlh.svg";
const HERDR_PROGRAMS_BACKUP_MARKER = "herdr";
function isJsonRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function herdrAppHomePath(config) {
    const configured = (config.env[HERDR_APP_HOME_ENV] || "").trim();
    if (configured) {
        return resolve(expandHomePath(configured, { homeDir: config.homeDir }) || configured);
    }
    return join(config.homeDir, ".config", "herdr-app");
}
function isDirectoryPath(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function herdrAppHomeKind(appHome) {
    if (!existsSync(appHome))
        return "missing";
    return isDirectoryPath(appHome) ? "directory" : "other";
}
// Herdr reloads programs.json live, so a partially written file would be seen by
// the running app. Mirror the runtime-marker write: unique temp file in the same
// directory (flag "wx" refuses to follow or reuse anything already there), then
// rename over the target. An existing file's mode is preserved so a user
// permissions change survives an install.
function writeFileAtomically(targetPath, content) {
    const existingMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : undefined;
    const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
    try {
        writeFileSync(tempPath, content, { flag: "wx", mode: existingMode ?? 0o666 });
        // writeFileSync applies the process umask to a new file, so chmod afterwards
        // is the only way to carry an existing file's exact mode across the rename.
        if (existingMode !== undefined)
            chmodSync(tempPath, existingMode);
        renameSync(tempPath, targetPath);
    }
    catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
}
function readHerdrProgramsFile(programsPath) {
    if (!existsSync(programsPath))
        return { ok: true, document: {} };
    let raw;
    try {
        raw = readFileSync(programsPath, "utf8").replace(/^\uFEFF/, "");
    }
    catch (error) {
        return { ok: false, reason: `unreadable (${errorText(error)})` };
    }
    if (!raw.trim())
        return { ok: true, document: {} };
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        return { ok: false, reason: `invalid JSON (${errorText(error)})` };
    }
    if (!isJsonRecord(parsed))
        return { ok: false, reason: "JSON root is not an object" };
    return { ok: true, document: parsed };
}
function herdrTlhProgramEntry(config) {
    const entry = {
        name: HERDR_TLH_PROGRAM_NAME,
        icon: `${HERDR_TLH_ICON_DIRECTORY}/${HERDR_TLH_ICON_FILENAME}`,
        tint: false,
    };
    // `--no-wrapper` installs have no launcher command to start.
    if (!config.noWrapper)
        entry.run = [config.wrapperPath];
    return entry;
}
function herdrIconNeedsWrite(iconPath, iconSourcePath) {
    if (!iconSourcePath || !existsSync(iconSourcePath))
        return true;
    if (!existsSync(iconPath))
        return true;
    try {
        return !readFileSync(iconPath).equals(readFileSync(iconSourcePath));
    }
    catch {
        return true;
    }
}
// Exclusive backup: COPYFILE_EXCL never overwrites (or follows a symlink at) an
// existing path, so a name taken after we looked is retried with the next suffix.
export function backupHerdrPrograms(programsPath, date = new Date()) {
    const base = backupPathWithTimestamp(programsPath, {
        marker: HERDR_PROGRAMS_BACKUP_MARKER,
        date,
    });
    for (let suffix = 0; suffix < 100; suffix += 1) {
        const candidate = suffix === 0 ? base : `${base}-${suffix}`;
        try {
            copyFileSync(programsPath, candidate, constants.COPYFILE_EXCL);
            return candidate;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    throw new Error(`could not find a free backup name for ${programsPath}`);
}
// Re-checked immediately before each mutation: the app home may have been
// removed or swapped, and programs.json, tlh/ or tlh.svg replaced by symlinks,
// since the earlier checks.
function assertHerdrPathsSafe(appHome, paths) {
    if (!isDirectoryPath(appHome) || isSymlink(appHome)) {
        throw new Error(`app home is no longer a directory: ${appHome}`);
    }
    for (const path of paths) {
        if (isSymlink(path))
            throw new Error(`refusing to write through a symlink: ${path}`);
    }
}
// The app home is user-configurable (HERDR_APP_HOME), so refuse locations that
// are never a Herdr.app home: normal Pi config, the isolated agent dir, $HOME, `/`.
// Compared physically (symlinked ancestors resolved).
function protectedAppHomeReason(appHome, config) {
    const physical = realpathForCompare(appHome);
    const home = realpathForCompare(config.homeDir);
    if (physical === sep || physical === home)
        return "it is the home directory or filesystem root";
    if (pathIsProtectedPiConfig(physical, { homeDir: config.homeDir, alreadyNormalized: true })) {
        return "it is inside the normal Pi config (~/.pi)";
    }
    const agentDir = realpathForCompare(dirname(config.settingsPath));
    if (pathWithinOrEqual(agentDir, physical)) {
        return "it is inside the isolated TLH agent directory";
    }
    return undefined;
}
// Any Herdr failure is a warning, never an install failure: branding is auxiliary.
export function configureHerdrPrograms(config, io) {
    try {
        mergeHerdrProgramEntry(config, io);
    }
    catch (error) {
        io.warn(`failed to configure the Herdr.app program entry: ${errorText(error)}`);
    }
}
function herdrAppDisabledBySettings(settingsPath) {
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
        if (!isJsonRecord(parsed) || !isJsonRecord(parsed.tlh))
            return false;
        const herdrApp = parsed.tlh.herdrApp;
        return isJsonRecord(herdrApp) && herdrApp.enabled === false;
    }
    catch {
        return false;
    }
}
function mergeHerdrProgramEntry(config, io) {
    if (herdrAppDisabledBySettings(config.settingsPath)) {
        io.log("Skipping Herdr.app program entry (tlh.herdrApp.enabled is false in settings).");
        return;
    }
    const configuredAppHome = herdrAppHomePath(config);
    // The app home may itself be a symlink (dotfile managers): resolve it once and
    // use the physical path for every check, write, and re-check below.
    let appHome = configuredAppHome;
    try {
        appHome = realpathSync(configuredAppHome);
    }
    catch {
        // Missing or unresolvable: reported as "missing" below.
    }
    if (appHome !== configuredAppHome) {
        io.detail(`Herdr.app home ${configuredAppHome} resolves to ${appHome}`);
    }
    const protectedReason = protectedAppHomeReason(appHome, config);
    if (protectedReason) {
        io.warn(`skipping Herdr.app program entry: app home ${appHome} is protected (${protectedReason})`);
        return;
    }
    const kind = herdrAppHomeKind(appHome);
    if (kind === "missing") {
        io.log(`Skipping Herdr.app program entry (app home not found: ${appHome}).`);
        return;
    }
    if (kind !== "directory") {
        io.warn(`skipping Herdr.app program entry: app home is not a directory: ${appHome}`);
        return;
    }
    const programsPath = join(appHome, HERDR_PROGRAMS_FILENAME);
    const iconDirectory = join(appHome, HERDR_TLH_ICON_DIRECTORY);
    // `tlh/` must be a real directory: a file there would make the icon write fail
    // mid-step, and the leaf lstat below would throw ENOTDIR instead of reporting.
    if (existsSync(iconDirectory) && !isDirectoryPath(iconDirectory)) {
        io.warn(`skipping Herdr.app program entry: ${iconDirectory} exists and is not a directory`);
        return;
    }
    const iconPath = join(iconDirectory, HERDR_TLH_ICON_FILENAME);
    // Refuse a symlinked programs.json, icon file, or `tlh/` directory: a symlinked
    // directory would let the recursive mkdir + icon write land outside the app home.
    if (isSymlink(programsPath) || isSymlink(iconDirectory) || isSymlink(iconPath)) {
        io.warn(`skipping Herdr.app program entry: refusing to write through a symlink in ${appHome}`);
        return;
    }
    const programsFile = readHerdrProgramsFile(programsPath);
    if (!programsFile.ok) {
        io.warn(`skipping Herdr.app program entry: ${programsPath}: ${programsFile.reason}`);
        return;
    }
    const document = programsFile.document;
    const existingPrograms = document.programs;
    if (existingPrograms !== undefined && !isJsonRecord(existingPrograms)) {
        io.warn(`skipping Herdr.app program entry: "programs" is not an object in ${programsPath}`);
        return;
    }
    const iconSourcePath = config.iconSourcePath;
    const iconSourceAvailable = Boolean(iconSourcePath) && existsSync(iconSourcePath);
    if (!config.dryRun && !iconSourceAvailable) {
        io.warn(`skipping Herdr.app program entry: the TLH icon support file is missing for ref ${config.ref}`);
        return;
    }
    const entry = herdrTlhProgramEntry(config);
    const programsCurrent = isJsonRecord(existingPrograms) &&
        JSON.stringify(existingPrograms[HERDR_TLH_PROGRAM_KEY]) === JSON.stringify(entry);
    const iconCurrent = !herdrIconNeedsWrite(iconPath, iconSourcePath);
    if (programsCurrent && iconCurrent) {
        io.detail(`Herdr.app program entry is already up to date: ${programsPath}`);
        return;
    }
    if (config.dryRun) {
        if (!iconCurrent) {
            io.log(`Would copy the TLH icon into the Herdr.app home: ${iconPath}`);
        }
        if (!programsCurrent) {
            io.log(`Would merge the TLH program entry into the Herdr.app programs.json: ${programsPath}`);
        }
        return;
    }
    const guarded = [programsPath, iconDirectory, iconPath];
    if (!iconCurrent) {
        assertHerdrPathsSafe(appHome, guarded);
        // Non-recursive: the app home itself must never be (re)created.
        if (!existsSync(iconDirectory))
            mkdirSync(iconDirectory);
        assertHerdrPathsSafe(appHome, guarded);
        if (!isDirectoryPath(iconDirectory))
            throw new Error(`${iconDirectory} is not a directory`);
        writeFileAtomically(iconPath, readFileSync(iconSourcePath));
        io.detail(`Copied the TLH icon into the Herdr.app home: ${iconPath}`);
    }
    if (programsCurrent)
        return;
    assertHerdrPathsSafe(appHome, guarded);
    if (existsSync(programsPath)) {
        const backupPath = backupHerdrPrograms(programsPath);
        io.detail(`Backed up Herdr.app programs.json to: ${backupPath}`);
    }
    const nextDocument = {
        ...document,
        programs: {
            ...(isJsonRecord(existingPrograms) ? existingPrograms : {}),
            [HERDR_TLH_PROGRAM_KEY]: entry,
        },
    };
    assertHerdrPathsSafe(appHome, guarded);
    writeFileAtomically(programsPath, `${JSON.stringify(nextDocument, null, 2)}\n`);
    io.detail(`Merged the TLH program entry into: ${programsPath}`);
}
