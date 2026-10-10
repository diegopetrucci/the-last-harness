import { lstatSync, realpathSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * The only phases in which a persisted session may be attested.
 *
 * `directory-only` is provisional: callers must invoke this boundary again
 * for the concrete session file immediately before publication.
 */
export const SESSION_MIRROR_ATTESTATION_PHASES = Object.freeze([
  "directory-only",
  "session-file",
] as const);

export type SessionMirrorAttestationPhase = (typeof SESSION_MIRROR_ATTESTATION_PHASES)[number];

/** Stable, aggregate-only reasons for a rejected attestation. */
export const SESSION_MIRROR_ATTESTATION_REASONS = Object.freeze([
  "missing-profile-selection",
  "missing-home",
  "default-or-normal-profile",
  "profile-mismatch",
  "unsafe-profile-metadata",
  "ephemeral-session",
  "session-escape",
  "unsafe-session-metadata",
] as const);

export type SessionMirrorAttestationReason = (typeof SESSION_MIRROR_ATTESTATION_REASONS)[number];

export interface SessionMirrorAttestationInput {
  readonly sessionFile?: string;
}

export interface SessionMirrorAttestationSuccess {
  readonly ok: true;
  readonly phase: SessionMirrorAttestationPhase;
}

export interface SessionMirrorAttestationFailure {
  readonly ok: false;
  readonly reason: SessionMirrorAttestationReason;
}

export type SessionMirrorAttestationResult =
  | SessionMirrorAttestationSuccess
  | SessionMirrorAttestationFailure;

export interface SessionMirrorAttestationEnvironment {
  readonly PI_CODING_AGENT_DIR?: string;
  readonly HOME?: string;
  readonly USERPROFILE?: string;
}

/**
 * The metadata-only filesystem surface used by this boundary.
 *
 * No read or write operation is part of the interface. Tests inject this small
 * surface instead of mocking the native `fs` module.
 */
export interface SessionMirrorAttestationFileSystem {
  readonly lstat: (path: string) => Stats;
  readonly realpath: (path: string) => string;
}

export interface SessionMirrorAttestationDependencies {
  readonly env: SessionMirrorAttestationEnvironment;
  readonly getAgentDir: () => string;
  readonly getAccountHome: () => string;
  readonly fileSystem: SessionMirrorAttestationFileSystem;
}

interface AttestedHome {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
}

interface ProtectedPiRoot {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
}

interface AttestedHomes {
  readonly expansionPath: string;
  readonly protectedPiRoots: readonly ProtectedPiRoot[];
}

interface AttestedProfile {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly runtimeLexicalPath: string;
  readonly runtimeCanonicalPath: string;
}

const PRODUCTION_FILE_SYSTEM: SessionMirrorAttestationFileSystem = Object.freeze({
  lstat: (path: string) => lstatSync(path),
  realpath: (path: string) => realpathSync.native(path),
});

function success(phase: SessionMirrorAttestationPhase): SessionMirrorAttestationSuccess {
  return Object.freeze({ ok: true, phase });
}

function failure(reason: SessionMirrorAttestationReason): SessionMirrorAttestationFailure {
  return Object.freeze({ ok: false, reason });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function absolutePath(value: string, homePath?: string): string {
  let expanded = value;
  if (homePath && expanded === "~") {
    expanded = homePath;
  } else if (homePath && (expanded.startsWith("~/") || expanded.startsWith(`~${sep}`))) {
    expanded = join(homePath, expanded.slice(2));
  }
  return resolve(expanded);
}

function requireAbsolutePath(value: unknown): string {
  if (!isNonEmptyString(value) || !isAbsolute(value)) {
    throw new Error("non-absolute metadata");
  }
  return value;
}

function pathWithinOrEqual(root: string, child: string): boolean {
  const childRelativePath = relative(root, child);
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

/**
 * Resolve an existing path, retaining a safe lexical suffix when the final
 * component has not been created yet. Only ENOENT/ENOTDIR are eligible for the
 * suffix fallback; permission and other metadata failures remain fatal.
 */
function realpathForComparison(
  path: string,
  fileSystem: SessionMirrorAttestationFileSystem,
): string {
  const resolved = resolve(path);
  try {
    return requireAbsolutePath(fileSystem.realpath(resolved));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parent = dirname(resolved);
    if (parent === resolved) return resolved;
    return join(realpathForComparison(parent, fileSystem), basename(resolved));
  }
}

function assertRegularDirectory(
  path: string,
  fileSystem: SessionMirrorAttestationFileSystem,
): void {
  const stats = fileSystem.lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("unsafe directory metadata");
  }
}

function attestHome(
  value: string,
  fileSystem: SessionMirrorAttestationFileSystem,
  requireExistingDirectory: boolean,
): AttestedHome {
  const lexicalPath = absolutePath(value);
  const canonicalPath = requireExistingDirectory
    ? requireAbsolutePath(fileSystem.realpath(lexicalPath))
    : realpathForComparison(lexicalPath, fileSystem);
  if (requireExistingDirectory) assertRegularDirectory(canonicalPath, fileSystem);
  return { lexicalPath, canonicalPath };
}

function attestHomes(
  dependencies: SessionMirrorAttestationDependencies,
): AttestedHomes | SessionMirrorAttestationFailure {
  const envHomeValues = [dependencies.env.HOME, dependencies.env.USERPROFILE].filter(
    isNonEmptyString,
  );

  let accountHomeValue: unknown;
  try {
    accountHomeValue = dependencies.getAccountHome();
  } catch {
    accountHomeValue = undefined;
  }

  if (envHomeValues.length === 0 && !isNonEmptyString(accountHomeValue)) {
    return failure("missing-home");
  }
  if (!isNonEmptyString(accountHomeValue) || !isAbsolute(accountHomeValue)) {
    return failure("unsafe-profile-metadata");
  }

  const fileSystem = dependencies.fileSystem;
  const homeValues = [...envHomeValues, accountHomeValue];
  const homes = homeValues.map((value, index) =>
    attestHome(value, fileSystem, index === homeValues.length - 1),
  );
  const protectedPiRoots = homes.map((home) => {
    const lexicalPath = join(home.lexicalPath, ".pi");
    return {
      lexicalPath,
      canonicalPath: realpathForComparison(lexicalPath, fileSystem),
    };
  });

  return {
    expansionPath: homes[0]?.lexicalPath ?? homes[homes.length - 1]!.lexicalPath,
    protectedPiRoots,
  };
}

function isWithinProtectedPiRoot(
  profile: AttestedProfile,
  protectedPiRoots: readonly ProtectedPiRoot[],
): boolean {
  return protectedPiRoots.some(
    (root) =>
      pathWithinOrEqual(root.lexicalPath, profile.lexicalPath) ||
      pathWithinOrEqual(root.canonicalPath, profile.canonicalPath) ||
      pathWithinOrEqual(root.lexicalPath, profile.runtimeLexicalPath) ||
      pathWithinOrEqual(root.canonicalPath, profile.runtimeCanonicalPath),
  );
}

function attestProfile(
  dependencies: SessionMirrorAttestationDependencies,
): AttestedProfile | SessionMirrorAttestationFailure {
  const selectedValue = dependencies.env.PI_CODING_AGENT_DIR;
  if (!isNonEmptyString(selectedValue)) return failure("missing-profile-selection");

  const homes = attestHomes(dependencies);
  if ("ok" in homes) return homes;

  const fileSystem = dependencies.fileSystem;
  const selectedPath = absolutePath(selectedValue, homes.expansionPath);

  let runtimeValue: unknown;
  try {
    runtimeValue = dependencies.getAgentDir();
  } catch {
    return failure("profile-mismatch");
  }
  if (!isNonEmptyString(runtimeValue)) return failure("profile-mismatch");
  const runtimePath = absolutePath(runtimeValue, homes.expansionPath);

  try {
    assertRegularDirectory(selectedPath, fileSystem);
    assertRegularDirectory(runtimePath, fileSystem);
  } catch {
    return failure("unsafe-profile-metadata");
  }

  let selectedCanonicalPath: string;
  let runtimeCanonicalPath: string;
  try {
    selectedCanonicalPath = requireAbsolutePath(fileSystem.realpath(selectedPath));
    runtimeCanonicalPath = requireAbsolutePath(fileSystem.realpath(runtimePath));
  } catch {
    return failure("unsafe-profile-metadata");
  }
  if (selectedCanonicalPath !== runtimeCanonicalPath) {
    return failure("profile-mismatch");
  }

  const profile: AttestedProfile = {
    lexicalPath: selectedPath,
    canonicalPath: selectedCanonicalPath,
    runtimeLexicalPath: runtimePath,
    runtimeCanonicalPath,
  };
  try {
    if (isWithinProtectedPiRoot(profile, homes.protectedPiRoots)) {
      return failure("default-or-normal-profile");
    }
  } catch {
    return failure("unsafe-profile-metadata");
  }

  return profile;
}

function assertNoSymlinkedComponents(
  rootPath: string,
  targetPath: string,
  fileSystem: SessionMirrorAttestationFileSystem,
): void {
  const childRelativePath = relative(rootPath, targetPath);
  if (
    childRelativePath !== "" &&
    (childRelativePath.startsWith("..") || isAbsolute(childRelativePath))
  ) {
    throw new Error("path escapes profile");
  }

  let currentPath = rootPath;
  for (const component of childRelativePath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, component);
    const stats = fileSystem.lstat(currentPath);
    if (stats.isSymbolicLink()) throw new Error("symlinked session component");
    if (currentPath !== targetPath && !stats.isDirectory()) {
      throw new Error("non-directory session component");
    }
  }
}

function attestSessionPath(
  sessionFile: string,
  profile: AttestedProfile,
  fileSystem: SessionMirrorAttestationFileSystem,
): SessionMirrorAttestationResult {
  const sessionPath = resolve(sessionFile);
  if (!pathWithinOrEqual(profile.lexicalPath, sessionPath)) {
    return failure("session-escape");
  }

  let sessionStats: Stats;
  try {
    sessionStats = fileSystem.lstat(sessionPath);
  } catch (error) {
    if (!isMissingPathError(error)) return failure("unsafe-session-metadata");

    const sessionDirectory = dirname(sessionPath);
    try {
      assertRegularDirectory(sessionDirectory, fileSystem);
      const canonicalDirectory = requireAbsolutePath(fileSystem.realpath(sessionDirectory));
      if (!pathWithinOrEqual(profile.canonicalPath, canonicalDirectory)) {
        return failure("session-escape");
      }
      assertNoSymlinkedComponents(profile.lexicalPath, sessionDirectory, fileSystem);
      return success("directory-only");
    } catch {
      return failure("unsafe-session-metadata");
    }
  }

  if (sessionStats.isSymbolicLink() || !sessionStats.isFile()) {
    return failure("unsafe-session-metadata");
  }

  try {
    const canonicalSessionPath = requireAbsolutePath(fileSystem.realpath(sessionPath));
    if (!pathWithinOrEqual(profile.canonicalPath, canonicalSessionPath)) {
      return failure("session-escape");
    }
    assertNoSymlinkedComponents(profile.lexicalPath, sessionPath, fileSystem);
    return success("session-file");
  } catch {
    return failure("unsafe-session-metadata");
  }
}

/**
 * Pure injectable implementation of the profile/session attestation boundary.
 *
 * The only filesystem operations are `realpath` and `lstat`; no file contents
 * are read and no state is written. `directory-only` is provisional: callers
 * must re-attest the concrete session file immediately before publication.
 * All failures are converted into the closed aggregate-only result type.
 */
export function attestSessionMirrorSessionCore(
  input: SessionMirrorAttestationInput,
  dependencies: SessionMirrorAttestationDependencies,
): SessionMirrorAttestationResult {
  let sessionFile: unknown;
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return failure("unsafe-session-metadata");
    }
    sessionFile = input.sessionFile;
  } catch {
    return failure("unsafe-session-metadata");
  }

  if (sessionFile === undefined) return failure("ephemeral-session");
  if (!isNonEmptyString(sessionFile)) return failure("unsafe-session-metadata");

  let profile: AttestedProfile | SessionMirrorAttestationFailure;
  try {
    profile = attestProfile(dependencies);
  } catch {
    return failure("unsafe-profile-metadata");
  }
  if (!profile || "ok" in profile) return profile;

  try {
    return attestSessionPath(sessionFile, profile, dependencies.fileSystem);
  } catch {
    return failure("unsafe-session-metadata");
  }
}

/**
 * Attest the currently selected isolated profile and one persisted session.
 *
 * This wrapper intentionally obtains only the selected profile environment,
 * the runtime's resolved agent directory, and filesystem metadata. It does not
 * read settings, transcripts, or any other profile content.
 */
export function attestSessionMirrorSession(
  input: SessionMirrorAttestationInput,
): SessionMirrorAttestationResult {
  try {
    return attestSessionMirrorSessionCore(input, {
      env: process.env,
      getAgentDir,
      getAccountHome: () => userInfo().homedir,
      fileSystem: PRODUCTION_FILE_SYSTEM,
    });
  } catch {
    return failure("unsafe-profile-metadata");
  }
}
