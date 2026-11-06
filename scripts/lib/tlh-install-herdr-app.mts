import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  isSymlink,
  pathIsProtectedPiConfig,
  pathWithinOrEqual,
  realpathForCompare,
} from "./tlh-install-paths.mjs";
import { backupPathWithTimestamp, expandHomePath } from "./tlh-install-utils.mjs";

// ---------------------------------------------------------------------------
// Herdr.app program entry (deliberate exception to the isolated-profile rule)
// ---------------------------------------------------------------------------
//
// Install and `tlh update` merge a TLH-managed `programs.tlh` entry into the
// Herdr desktop app's `programs.json` so Herdr shows TLH's own name, icon, and
// launcher. This is the only sanctioned write outside the isolated profile. The
// only opt-out is the persistent isolated setting `tlh.herdrApp.enabled: false`
// (an existing entry is never removed). Safety is carried by the write itself:
//   - the app home is never created; a missing app home is only reported
//   - an existing programs.json is backed up before its first change
//   - invalid JSON, a non-object root, or a non-object `programs` value is
//     reported and left untouched
//   - an already-current entry writes nothing and creates no backup
//   - `--dry-run` only reports
//   - every other programs.json key/entry and the file's other top-level keys
//     are preserved; TLH owns the whole `programs.tlh` object and replaces it
type JsonRecord = Record<string, unknown>;

export interface HerdrAppConfig {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir: string;
  noWrapper: boolean;
  wrapperPath: string;
  settingsPath: string;
  dryRun: boolean;
  ref: string;
  /** Packaged TLH icon (support file); empty when it was not fetched (dry-run). */
  iconSourcePath: string;
}

export interface HerdrAppIo {
  log(message: string): void;
  detail(message: string): void;
  warn(message: string): void;
}

function errorText(error: unknown): string {
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

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type HerdrProgramsFile = { ok: true; document: JsonRecord } | { ok: false; reason: string };

function herdrAppHomePath(config: HerdrAppConfig): string {
  const configured = (config.env[HERDR_APP_HOME_ENV] || "").trim();
  if (configured) {
    return resolve(expandHomePath(configured, { homeDir: config.homeDir }) || configured);
  }
  return join(config.homeDir, ".config", "herdr-app");
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function herdrAppHomeKind(appHome: string): "missing" | "directory" | "other" {
  if (!existsSync(appHome)) return "missing";
  return isDirectoryPath(appHome) ? "directory" : "other";
}

// Herdr reloads programs.json live, so a partially written file would be seen by
// the running app. Mirror the runtime-marker write: unique temp file in the same
// directory (flag "wx" refuses to follow or reuse anything already there), then
// rename over the target. An existing file's mode is preserved so a user
// permissions change survives an install.
function writeFileAtomically(targetPath: string, content: string | Buffer): void {
  const existingMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o777 : undefined;
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, { flag: "wx", mode: existingMode ?? 0o666 });
    // writeFileSync applies the process umask to a new file, so chmod afterwards
    // is the only way to carry an existing file's exact mode across the rename.
    if (existingMode !== undefined) chmodSync(tempPath, existingMode);
    renameSync(tempPath, targetPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function readHerdrProgramsFile(programsPath: string): HerdrProgramsFile {
  if (!existsSync(programsPath)) return { ok: true, document: {} };
  let raw: string;
  try {
    raw = readFileSync(programsPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    return { ok: false, reason: `unreadable (${errorText(error)})` };
  }
  if (!raw.trim()) return { ok: true, document: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, reason: `invalid JSON (${errorText(error)})` };
  }
  if (!isJsonRecord(parsed)) return { ok: false, reason: "JSON root is not an object" };
  return { ok: true, document: parsed };
}

function herdrTlhProgramEntry(config: HerdrAppConfig): JsonRecord {
  const entry: JsonRecord = {
    name: HERDR_TLH_PROGRAM_NAME,
    icon: `${HERDR_TLH_ICON_DIRECTORY}/${HERDR_TLH_ICON_FILENAME}`,
    tint: false,
  };
  // `--no-wrapper` installs have no launcher command to start.
  if (!config.noWrapper) entry.run = [config.wrapperPath];
  return entry;
}

function herdrIconNeedsWrite(iconPath: string, iconSourcePath: string): boolean {
  if (!iconSourcePath || !existsSync(iconSourcePath)) return true;
  if (!existsSync(iconPath)) return true;
  try {
    return !readFileSync(iconPath).equals(readFileSync(iconSourcePath));
  } catch {
    return true;
  }
}

// Exclusive backup: COPYFILE_EXCL never overwrites (or follows a symlink at) an
// existing path, so a name taken after we looked is retried with the next suffix.
export function backupHerdrPrograms(programsPath: string, date = new Date()): string {
  const base = backupPathWithTimestamp(programsPath, {
    marker: HERDR_PROGRAMS_BACKUP_MARKER,
    date,
  });
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      copyFileSync(programsPath, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not find a free backup name for ${programsPath}`);
}

// Re-checked immediately before each mutation: the app home may have been
// removed or swapped, and programs.json, tlh/ or tlh.svg replaced by symlinks,
// since the earlier checks.
function assertHerdrPathsSafe(appHome: string, paths: string[]): void {
  if (!isDirectoryPath(appHome) || isSymlink(appHome)) {
    throw new Error(`app home is no longer a directory: ${appHome}`);
  }
  for (const path of paths) {
    if (isSymlink(path)) throw new Error(`refusing to write through a symlink: ${path}`);
  }
}

// The app home is user-configurable (HERDR_APP_HOME), so refuse locations that
// are never a Herdr.app home: normal Pi config, the isolated agent dir, $HOME, `/`.
// Compared physically (symlinked ancestors resolved).
function protectedAppHomeReason(appHome: string, config: HerdrAppConfig): string | undefined {
  const physical = realpathForCompare(appHome);
  const home = realpathForCompare(config.homeDir);
  if (physical === sep || physical === home) return "it is the home directory or filesystem root";
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
export function configureHerdrPrograms(config: HerdrAppConfig, io: HerdrAppIo): void {
  try {
    mergeHerdrProgramEntry(config, io);
  } catch (error) {
    io.warn(`failed to configure the Herdr.app program entry: ${errorText(error)}`);
  }
}

function herdrAppDisabledBySettings(settingsPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "")) as unknown;
    if (!isJsonRecord(parsed) || !isJsonRecord(parsed.tlh)) return false;
    const herdrApp = parsed.tlh.herdrApp;
    return isJsonRecord(herdrApp) && herdrApp.enabled === false;
  } catch {
    return false;
  }
}

function mergeHerdrProgramEntry(config: HerdrAppConfig, io: HerdrAppIo): void {
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
  } catch {
    // Missing or unresolvable: reported as "missing" below.
  }
  if (appHome !== configuredAppHome) {
    io.detail(`Herdr.app home ${configuredAppHome} resolves to ${appHome}`);
  }
  const protectedReason = protectedAppHomeReason(appHome, config);
  if (protectedReason) {
    io.warn(
      `skipping Herdr.app program entry: app home ${appHome} is protected (${protectedReason})`,
    );
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
    io.warn(
      `skipping Herdr.app program entry: the TLH icon support file is missing for ref ${config.ref}`,
    );
    return;
  }

  const entry = herdrTlhProgramEntry(config);
  const programsCurrent =
    isJsonRecord(existingPrograms) &&
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
    if (!existsSync(iconDirectory)) mkdirSync(iconDirectory);
    assertHerdrPathsSafe(appHome, guarded);
    if (!isDirectoryPath(iconDirectory)) throw new Error(`${iconDirectory} is not a directory`);
    writeFileAtomically(iconPath, readFileSync(iconSourcePath));
    io.detail(`Copied the TLH icon into the Herdr.app home: ${iconPath}`);
  }
  if (programsCurrent) return;
  assertHerdrPathsSafe(appHome, guarded);
  if (existsSync(programsPath)) {
    const backupPath = backupHerdrPrograms(programsPath);
    io.detail(`Backed up Herdr.app programs.json to: ${backupPath}`);
  }
  const nextDocument: JsonRecord = {
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
