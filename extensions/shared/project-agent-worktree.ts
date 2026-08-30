import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Filesystem operations needed to identify a Git worktree. This deliberately
 * contains no host/peer dependencies so it can be shared by the eager guidance
 * path and the native subagent snapshot loader.
 */
export interface ValidatedWorktreeFileSystem {
  lstatSync(filePath: string): fs.Stats;
  realpathSync(filePath: string): string;
  readFileSync(filePath: string): string | Buffer;
}

const DEFAULT_FILE_SYSTEM: ValidatedWorktreeFileSystem = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  realpathSync: (filePath) => fs.realpathSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath),
};

const GIT_MARKER_MAX_BYTES = 8 * 1024;

export interface ValidatedGitWorktreeSearch {
  /** Path used by the guidance caller for nearest-directory lookup. */
  readonly searchCwd: string;
  /** A canonical or same-physical-path validated worktree root, when present. */
  readonly root?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function bytesFromRead(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

function hasPositiveIdentity(stat: fs.Stats): boolean {
  return (
    Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.dev > 0 && stat.ino > 0
  );
}

function isSafeDirectory(filePath: string, fileSystem: ValidatedWorktreeFileSystem): boolean {
  try {
    const stat = fileSystem.lstatSync(filePath);
    return !stat.isSymbolicLink() && stat.isDirectory() && hasPositiveIdentity(stat);
  } catch {
    return false;
  }
}

function isSafeRegularFile(filePath: string, fileSystem: ValidatedWorktreeFileSystem): boolean {
  try {
    const stat = fileSystem.lstatSync(filePath);
    return !stat.isSymbolicLink() && stat.isFile() && hasPositiveIdentity(stat);
  } catch {
    return false;
  }
}

function readGitMarkerLine(
  filePath: string,
  fileSystem: ValidatedWorktreeFileSystem,
): string | undefined {
  try {
    const stat = fileSystem.lstatSync(filePath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      !hasPositiveIdentity(stat) ||
      stat.size > GIT_MARKER_MAX_BYTES
    ) {
      return undefined;
    }

    const value = bytesFromRead(fileSystem.readFileSync(filePath));
    if (value.byteLength > GIT_MARKER_MAX_BYTES) return undefined;
    let text = value.toString("utf8");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    return text.includes("\n") || text.includes("\r") ? undefined : text;
  } catch {
    return undefined;
  }
}

function hasValidGitHead(gitDirectory: string, fileSystem: ValidatedWorktreeFileSystem): boolean {
  const head = readGitMarkerLine(join(gitDirectory, "HEAD"), fileSystem);
  if (!head) return false;
  return /^ref: refs\/\S+$/.test(head) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head);
}

function canonicalPathForCompare(
  filePath: string,
  fileSystem: ValidatedWorktreeFileSystem,
): string {
  try {
    return fileSystem.realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function hasGitDirectoryLayout(
  gitDirectory: string,
  fileSystem: ValidatedWorktreeFileSystem,
): boolean {
  return (
    isSafeDirectory(gitDirectory, fileSystem) &&
    hasValidGitHead(gitDirectory, fileSystem) &&
    isSafeRegularFile(join(gitDirectory, "config"), fileSystem) &&
    isSafeDirectory(join(gitDirectory, "objects"), fileSystem) &&
    isSafeDirectory(join(gitDirectory, "refs"), fileSystem)
  );
}

function readGitDirectoryTarget(
  markerPath: string,
  fileSystem: ValidatedWorktreeFileSystem,
): string | undefined {
  const marker = readGitMarkerLine(markerPath, fileSystem);
  if (!marker?.startsWith("gitdir: ")) return undefined;
  const target = marker.slice("gitdir: ".length);
  return target.length > 0 ? target : undefined;
}

function isValidLinkedWorktreeDirectory(
  adminDirectory: string,
  markerPath: string,
  fileSystem: ValidatedWorktreeFileSystem,
): boolean {
  if (
    !isSafeDirectory(adminDirectory, fileSystem) ||
    !hasValidGitHead(adminDirectory, fileSystem)
  ) {
    return false;
  }

  const linkedMarker = readGitMarkerLine(join(adminDirectory, "gitdir"), fileSystem);
  const commonMarker = readGitMarkerLine(join(adminDirectory, "commondir"), fileSystem);
  if (!linkedMarker || !commonMarker) return false;

  let linkedMarkerPath: string;
  let commonDirectory: string;
  try {
    linkedMarkerPath = resolve(adminDirectory, linkedMarker);
    commonDirectory = resolve(adminDirectory, commonMarker);
  } catch {
    return false;
  }

  return (
    canonicalPathForCompare(linkedMarkerPath, fileSystem) ===
      canonicalPathForCompare(markerPath, fileSystem) &&
    hasGitDirectoryLayout(commonDirectory, fileSystem)
  );
}

type GitWorktreeMarkerState = "absent" | "valid" | "malformed";

function inspectGitWorktreeMarker(
  directory: string,
  fileSystem: ValidatedWorktreeFileSystem,
): GitWorktreeMarkerState {
  const markerPath = join(directory, ".git");
  let stat: fs.Stats;
  try {
    stat = fileSystem.lstatSync(markerPath);
  } catch (error) {
    // Only a genuinely absent marker permits discovery to continue through an
    // ancestor. An unreadable marker is fail-closed and shadows outer roots.
    return isMissingError(error) ? "absent" : "malformed";
  }

  if (!hasPositiveIdentity(stat) || stat.isSymbolicLink()) return "malformed";
  if (stat.isDirectory()) {
    return hasGitDirectoryLayout(markerPath, fileSystem) ? "valid" : "malformed";
  }
  if (!stat.isFile()) return "malformed";

  const target = readGitDirectoryTarget(markerPath, fileSystem);
  if (!target) return "malformed";

  let gitDirectory: string;
  try {
    gitDirectory = resolve(dirname(markerPath), target);
  } catch {
    return "malformed";
  }
  if (!isSafeDirectory(gitDirectory, fileSystem)) return "malformed";

  return hasGitDirectoryLayout(gitDirectory, fileSystem) ||
    isValidLinkedWorktreeDirectory(gitDirectory, markerPath, fileSystem)
    ? "valid"
    : "malformed";
}

function findValidatedGitWorktreeRootAt(
  startDirectory: string,
  fileSystem: ValidatedWorktreeFileSystem,
): string | undefined {
  let directory = startDirectory;
  while (true) {
    // Validate Git's ordinary directory layout or linked-worktree marker. An
    // arbitrary .git entry must never widen the guidance search boundary.
    const markerState = inspectGitWorktreeMarker(directory, fileSystem);
    if (markerState === "valid") return directory;
    if (markerState === "malformed") return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function strictCanonicalPath(
  filePath: string,
  fileSystem: ValidatedWorktreeFileSystem,
): string | undefined {
  try {
    return fileSystem.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * Resolve one cwd for both callers that need nearest guidance lookup and the
 * stricter custom-agent root lookup. This function never invokes Git.
 */
export function findValidatedGitWorktree(
  cwdInput: unknown,
  options: { fileSystem?: ValidatedWorktreeFileSystem } = {},
): ValidatedGitWorktreeSearch {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  if (typeof cwdInput !== "string" || cwdInput.trim().length === 0) {
    return { searchCwd: "" };
  }

  let cwd: string;
  try {
    cwd = resolve(cwdInput);
    if (cwd.includes("\0")) return { searchCwd: cwd };
  } catch {
    return { searchCwd: "" };
  }

  let canonicalCwd: string;
  try {
    // Canonicalize before discovery so a symlink path nested in another
    // repository cannot make that lexical host repository win over the target.
    canonicalCwd = fileSystem.realpathSync(cwd);
  } catch {
    const lexicalRoot = findValidatedGitWorktreeRootAt(cwd, fileSystem);
    return lexicalRoot ? { searchCwd: cwd, root: lexicalRoot } : { searchCwd: cwd };
  }

  const canonicalRoot = findValidatedGitWorktreeRootAt(canonicalCwd, fileSystem);
  if (!canonicalRoot) return { searchCwd: cwd };

  // Keep lexical paths for an ordinary cwd (including platform aliases such
  // as macOS /var) when they identify the same physical root and directory.
  const lexicalRoot = findValidatedGitWorktreeRootAt(cwd, fileSystem);
  if (
    lexicalRoot !== undefined &&
    canonicalPathForCompare(lexicalRoot, fileSystem) ===
      canonicalPathForCompare(canonicalRoot, fileSystem) &&
    relative(lexicalRoot, cwd) === relative(canonicalRoot, canonicalCwd)
  ) {
    return { searchCwd: cwd, root: lexicalRoot };
  }
  return { searchCwd: canonicalCwd, root: canonicalRoot };
}

/** Resolve an existing cwd to the canonical root of a validated Git worktree. */
export function resolveValidatedGitWorktreeRoot(
  cwdInput: unknown,
  options: { fileSystem?: ValidatedWorktreeFileSystem } = {},
): string | undefined {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  if (typeof cwdInput !== "string" || cwdInput.trim().length === 0) return undefined;

  let cwd: string;
  try {
    cwd = resolve(cwdInput);
    if (cwd.includes("\0")) return undefined;
  } catch {
    return undefined;
  }
  const canonicalCwd = strictCanonicalPath(cwd, fileSystem);
  if (!canonicalCwd || !isSafeDirectory(canonicalCwd, fileSystem)) return undefined;

  // The strict loader path requires the supplied cwd itself to exist as a
  // directory. Guidance may retain a cwd-only fallback for a not-yet-created
  // path, but a project-agent root must never be selected for a file or ghost
  // directory supplied by an untrusted caller.
  const search = findValidatedGitWorktree(canonicalCwd, { fileSystem });
  if (!search.root) return undefined;
  return strictCanonicalPath(search.root, fileSystem);
}

/** @internal Exported for focused path-resolution tests only. */
export const __testing = {
  findValidatedGitWorktreeRootAt,
  inspectGitWorktreeMarker,
};
