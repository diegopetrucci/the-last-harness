import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type ProjectTrustDecision,
} from "@earendil-works/pi-coding-agent";

/** Maximum UTF-8 bytes accepted from one project-agent guidance file. */
export const PROJECT_AGENT_GUIDANCE_MAX_BYTES = 64 * 1024;
export const PROJECT_AGENT_GUIDANCE_DIRECTORY = ".tlh";
const PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY = "agents";
const PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY = "builtin";

export const PACKAGED_PRIMARY_AGENT_ROLES = ["architect", "rush", "product", "bug-hunter"] as const;

export const PACKAGED_MINOR_AGENT_ROLES = [
  "developer",
  "code-reviewer",
  "repo-scout",
  "diff-summarizer",
  "librarian",
  "web-scout",
  "oracle",
  "contrarian",
] as const;

export const PROJECT_AGENT_GUIDANCE_ROLES = [
  ...PACKAGED_PRIMARY_AGENT_ROLES,
  ...PACKAGED_MINOR_AGENT_ROLES,
] as const;

export type ProjectAgentGuidanceRole = (typeof PROJECT_AGENT_GUIDANCE_ROLES)[number];
export type ProjectAgentGuidanceTrustState =
  | "trusted"
  | "denied"
  | "undecided"
  | "not-evaluated"
  | "unavailable";

const ROLE_FILENAMES: Readonly<Record<ProjectAgentGuidanceRole, string>> = {
  architect: "ARCHITECT_PROMPT_APPEND.md",
  rush: "RUSH_PROMPT_APPEND.md",
  product: "PRODUCT_PROMPT_APPEND.md",
  "bug-hunter": "BUG-HUNTER_PROMPT_APPEND.md",
  developer: "DEVELOPER_PROMPT_APPEND.md",
  "code-reviewer": "CODE-REVIEWER_PROMPT_APPEND.md",
  "repo-scout": "REPO-SCOUT_PROMPT_APPEND.md",
  "diff-summarizer": "DIFF-SUMMARIZER_PROMPT_APPEND.md",
  librarian: "LIBRARIAN_PROMPT_APPEND.md",
  "web-scout": "WEB-SCOUT_PROMPT_APPEND.md",
  oracle: "ORACLE_PROMPT_APPEND.md",
  contrarian: "CONTRARIAN_PROMPT_APPEND.md",
};

export type ProjectAgentGuidanceDiagnosticCode =
  | "invalid-cwd"
  | "invalid-agent-dir"
  | "trust-inspection-failed"
  | "project-not-trusted"
  | "source-outside-trusted-subtree"
  | "symlink-directory"
  | "invalid-directory"
  | "directory-inspection-failed"
  | "symlink-file"
  | "non-regular-file"
  | "file-inspection-failed"
  | "file-too-large"
  | "file-read-failed";

export interface ProjectAgentGuidanceDiagnostic {
  code: ProjectAgentGuidanceDiagnosticCode;
  message: string;
  path?: string;
  role?: ProjectAgentGuidanceRole;
}

/** A recognized candidate. Content is present only after a trusted read. */
export interface ProjectAgentGuidanceFile {
  role: ProjectAgentGuidanceRole;
  path: string;
  content?: string;
}

/**
 * One filesystem/trust snapshot shared by all role lookups for a process
 * start. Callers can report `files` and `diagnostics` once, then resolve as
 * many roles as needed without rereading untrusted inputs.
 */
export interface ProjectAgentGuidanceInventory {
  cwd: string;
  worktreeRoot?: string;
  trust: ProjectAgentGuidanceTrustState;
  trustDecision: ProjectTrustDecision;
  /** Path covered by the effective persisted trust entry, when evaluated. */
  trustEntryPath?: string;
  files: ProjectAgentGuidanceFile[];
  diagnostics: ProjectAgentGuidanceDiagnostic[];
}

export interface ProjectAgentGuidanceResult {
  role?: ProjectAgentGuidanceRole;
  guidance?: string;
  sourcePath?: string;
  inventory: ProjectAgentGuidanceInventory;
}

export const PROJECT_GUIDANCE_OPEN_DELIMITER = "<tlh_project_agent_guidance>";
export const PROJECT_GUIDANCE_CLOSE_DELIMITER = "</tlh_project_agent_guidance>";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function pushDiagnostic(
  diagnostics: ProjectAgentGuidanceDiagnostic[],
  diagnostic: ProjectAgentGuidanceDiagnostic,
): void {
  diagnostics.push(diagnostic);
}

function resolveInputPath(
  value: unknown,
  label: "cwd" | "agent directory",
  diagnostics: ProjectAgentGuidanceDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    pushDiagnostic(diagnostics, {
      code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
      message: `Project-agent guidance ${label} must be a non-empty path.`,
    });
    return undefined;
  }

  try {
    const resolved = resolve(value);
    if (resolved.includes("\0")) {
      throw new Error("path contains a NUL byte");
    }
    return resolved;
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
      message: `Could not resolve project-agent guidance ${label} '${value}': ${errorMessage(error)}`,
    });
    return undefined;
  }
}

const GIT_MARKER_MAX_BYTES = 8 * 1024;

function isSafeDirectory(path: string): boolean {
  try {
    const stat = fs.lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeRegularFile(path: string): boolean {
  try {
    const stat = fs.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readGitMarkerLine(path: string): string | undefined {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GIT_MARKER_MAX_BYTES) {
      return undefined;
    }

    let value = fs.readFileSync(path, "utf8");
    if (Buffer.byteLength(value, "utf8") > GIT_MARKER_MAX_BYTES) return undefined;
    if (value.endsWith("\n")) value = value.slice(0, -1);
    if (value.endsWith("\r")) value = value.slice(0, -1);
    return value.includes("\n") || value.includes("\r") ? undefined : value;
  } catch {
    return undefined;
  }
}

function hasValidGitHead(gitDirectory: string): boolean {
  const head = readGitMarkerLine(join(gitDirectory, "HEAD"));
  if (!head) return false;
  return /^ref: refs\/\S+$/.test(head) || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head);
}

function hasGitDirectoryLayout(gitDirectory: string): boolean {
  return (
    isSafeDirectory(gitDirectory) &&
    hasValidGitHead(gitDirectory) &&
    isSafeRegularFile(join(gitDirectory, "config")) &&
    isSafeDirectory(join(gitDirectory, "objects")) &&
    isSafeDirectory(join(gitDirectory, "refs"))
  );
}

function readGitDirectoryTarget(path: string): string | undefined {
  const marker = readGitMarkerLine(path);
  if (!marker?.startsWith("gitdir: ")) return undefined;
  const target = marker.slice("gitdir: ".length);
  return target.length > 0 ? target : undefined;
}

function isValidLinkedWorktreeDirectory(adminDirectory: string, markerPath: string): boolean {
  if (!isSafeDirectory(adminDirectory) || !hasValidGitHead(adminDirectory)) {
    return false;
  }

  const linkedMarker = readGitMarkerLine(join(adminDirectory, "gitdir"));
  const commonMarker = readGitMarkerLine(join(adminDirectory, "commondir"));
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
    canonicalPathForCompare(linkedMarkerPath) === canonicalPathForCompare(markerPath) &&
    hasGitDirectoryLayout(commonDirectory)
  );
}

type GitWorktreeMarkerState = "absent" | "valid" | "malformed";

function inspectGitWorktreeMarker(directory: string): GitWorktreeMarkerState {
  const markerPath = join(directory, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (error) {
    // Only a genuinely absent marker permits discovery to continue through an
    // ancestor. An unreadable marker is fail-closed and shadows outer roots.
    return isMissingError(error) ? "absent" : "malformed";
  }

  if (stat.isSymbolicLink()) return "malformed";
  if (stat.isDirectory()) return hasGitDirectoryLayout(markerPath) ? "valid" : "malformed";
  if (!stat.isFile()) return "malformed";

  const target = readGitDirectoryTarget(markerPath);
  if (!target) return "malformed";

  let gitDirectory: string;
  try {
    gitDirectory = resolve(dirname(markerPath), target);
  } catch {
    return "malformed";
  }
  if (!isSafeDirectory(gitDirectory)) return "malformed";

  return hasGitDirectoryLayout(gitDirectory) ||
    isValidLinkedWorktreeDirectory(gitDirectory, markerPath)
    ? "valid"
    : "malformed";
}

function findValidatedGitWorktreeRoot(cwd: string): string | undefined {
  let directory = cwd;
  while (true) {
    // A worktree root is identified without invoking an executable. Validate
    // Git's ordinary directory layout or its linked-worktree gitdir marker so
    // an arbitrary .git entry cannot widen the guidance search boundary.
    const markerState = inspectGitWorktreeMarker(directory);
    if (markerState === "valid") return directory;
    if (markerState === "malformed") return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

interface GitWorktreeSearch {
  /** Canonical path used only to search the physical worktree. */
  searchCwd: string;
  root?: string;
}

function findGitWorktree(cwd: string): GitWorktreeSearch {
  let canonicalCwd: string;
  try {
    // Canonicalize before discovery so a symlink path nested in another
    // repository cannot make that lexical host repository win over the target.
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    // A not-yet-existing cwd cannot be canonicalized; retain the prior
    // cwd-only/ancestor behavior for that input.
    const lexicalRoot = findValidatedGitWorktreeRoot(cwd);
    return lexicalRoot ? { searchCwd: cwd, root: lexicalRoot } : { searchCwd: cwd };
  }

  const canonicalRoot = findValidatedGitWorktreeRoot(canonicalCwd);
  if (!canonicalRoot) return { searchCwd: cwd };

  // Keep lexical paths for an ordinary cwd (including platform aliases such
  // as macOS /var) when they identify the same physical root and directory
  // within that root. A symlinked cwd can otherwise have the same root while
  // pointing at a different physical ancestor (for example /repo/link ->
  // /repo/sub); in that case canonical paths must drive the search.
  const lexicalRoot = findValidatedGitWorktreeRoot(cwd);
  if (
    lexicalRoot !== undefined &&
    canonicalPathForCompare(lexicalRoot) === canonicalPathForCompare(canonicalRoot) &&
    relative(lexicalRoot, cwd) === relative(canonicalRoot, canonicalCwd)
  ) {
    return { searchCwd: cwd, root: lexicalRoot };
  }
  return { searchCwd: canonicalCwd, root: canonicalRoot };
}

/**
 * Resolve an existing cwd to the canonical root of a validated Git worktree.
 * Custom embedded agents use this stricter physical-root result rather than
 * the lexical ancestor search used by packaged prompt guidance.
 */
export function resolveValidatedGitWorktreeRoot(cwdInput: unknown): string | undefined {
  if (typeof cwdInput !== "string" || cwdInput.trim().length === 0) return undefined;
  let cwd: string;
  try {
    cwd = resolve(cwdInput);
    if (cwd.includes("\0")) return undefined;
    cwd = fs.realpathSync(cwd);
  } catch {
    return undefined;
  }
  const root = findValidatedGitWorktreeRoot(cwd);
  return root ? strictCanonicalPath(root) : undefined;
}

function searchDirectories(cwd: string, worktreeRoot: string | undefined): string[] {
  if (!worktreeRoot) return [cwd];

  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.push(current);
    if (current === worktreeRoot) return directories;
    const parent = dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
}

interface GuidanceDirectoryIdentities {
  tlh?: FileIdentity;
  agents?: FileIdentity;
  builtin?: FileIdentity;
}

interface GuidanceDirectoryCheck {
  status: "missing" | "blocked" | "valid";
  entries?: ReadonlySet<string>;
  identities?: GuidanceDirectoryIdentities;
}

function checkGuidanceDirectory(
  directory: string,
  diagnostics: ProjectAgentGuidanceDiagnostic[],
): GuidanceDirectoryCheck {
  const guidanceRoot = join(directory, PROJECT_AGENT_GUIDANCE_DIRECTORY);
  let parentEntries: string[];
  try {
    parentEntries = fs.readdirSync(directory);
  } catch (error) {
    if (isMissingError(error)) return { status: "missing" };
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
      path: guidanceRoot,
    });
    return { status: "blocked" };
  }
  // Do not let case-insensitive filesystems turn `.TLH` into the exact
  // `.tlh` convention. Each directory entry must have the required spelling
  // before lstat/open are attempted.
  if (!parentEntries.includes(PROJECT_AGENT_GUIDANCE_DIRECTORY)) {
    return { status: "missing" };
  }

  let tlhStat: fs.Stats;
  try {
    tlhStat = fs.lstatSync(guidanceRoot);
  } catch (error) {
    if (isMissingError(error)) return { status: "missing" };
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
      path: guidanceRoot,
    });
    return { status: "blocked" };
  }

  if (tlhStat.isSymbolicLink()) {
    pushDiagnostic(diagnostics, {
      code: "symlink-directory",
      message: `Project-agent guidance directory '${guidanceRoot}' is a symlink; refusing to inspect it. Use a real '.tlh' directory containing 'agents/builtin'.`,
      path: guidanceRoot,
    });
    return { status: "blocked" };
  }
  if (!tlhStat.isDirectory()) {
    pushDiagnostic(diagnostics, {
      code: "invalid-directory",
      message: `Project-agent guidance path '${guidanceRoot}' is not a directory; refusing to inspect it.`,
      path: guidanceRoot,
    });
    return { status: "blocked" };
  }

  let tlhEntries: string[];
  try {
    tlhEntries = fs.readdirSync(guidanceRoot);
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${guidanceRoot}': ${errorMessage(error)}`,
      path: guidanceRoot,
    });
    return { status: "blocked" };
  }
  if (!tlhEntries.includes(PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY)) {
    return { status: "missing" };
  }

  const agentsDirectory = join(guidanceRoot, PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY);
  let agentsStat: fs.Stats;
  try {
    agentsStat = fs.lstatSync(agentsDirectory);
  } catch (error) {
    if (isMissingError(error)) return { status: "missing" };
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${agentsDirectory}': ${errorMessage(error)}`,
      path: agentsDirectory,
    });
    return { status: "blocked" };
  }
  if (agentsStat.isSymbolicLink()) {
    pushDiagnostic(diagnostics, {
      code: "symlink-directory",
      message: `Project-agent guidance directory '${agentsDirectory}' is a symlink; refusing to inspect it. Use a real '.tlh/agents' directory.`,
      path: agentsDirectory,
    });
    return { status: "blocked" };
  }
  if (!agentsStat.isDirectory()) {
    pushDiagnostic(diagnostics, {
      code: "invalid-directory",
      message: `Project-agent guidance path '${agentsDirectory}' is not a directory; refusing to inspect it.`,
      path: agentsDirectory,
    });
    return { status: "blocked" };
  }

  let agentsEntries: string[];
  try {
    agentsEntries = fs.readdirSync(agentsDirectory);
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${agentsDirectory}': ${errorMessage(error)}`,
      path: agentsDirectory,
    });
    return { status: "blocked" };
  }
  if (!agentsEntries.includes(PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY)) {
    return { status: "missing" };
  }

  const builtinDirectory = join(agentsDirectory, PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY);
  let builtinStat: fs.Stats;
  try {
    builtinStat = fs.lstatSync(builtinDirectory);
  } catch (error) {
    if (isMissingError(error)) return { status: "missing" };
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${builtinDirectory}': ${errorMessage(error)}`,
      path: builtinDirectory,
    });
    return { status: "blocked" };
  }
  if (builtinStat.isSymbolicLink()) {
    pushDiagnostic(diagnostics, {
      code: "symlink-directory",
      message: `Project-agent guidance directory '${builtinDirectory}' is a symlink; refusing to inspect it. Use a real '.tlh/agents/builtin' directory.`,
      path: builtinDirectory,
    });
    return { status: "blocked" };
  }
  if (!builtinStat.isDirectory()) {
    pushDiagnostic(diagnostics, {
      code: "invalid-directory",
      message: `Project-agent guidance path '${builtinDirectory}' is not a directory; refusing to inspect it.`,
      path: builtinDirectory,
    });
    return { status: "blocked" };
  }

  let builtinEntries: string[];
  try {
    builtinEntries = fs.readdirSync(builtinDirectory);
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "directory-inspection-failed",
      message: `Could not inspect project-agent guidance directory '${builtinDirectory}': ${errorMessage(error)}`,
      path: builtinDirectory,
    });
    return { status: "blocked" };
  }
  return {
    status: "valid",
    entries: new Set(builtinEntries),
    identities: {
      tlh: fileIdentity(tlhStat),
      agents: fileIdentity(agentsStat),
      builtin: fileIdentity(builtinStat),
    },
  };
}

function canonicalPathForCompare(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function strictCanonicalPath(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function isCanonicalPathWithin(parentPath: string, childPath: string): boolean {
  const childRelative = relative(parentPath, childPath);
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function fileIdentity(stat: fs.Stats): FileIdentity | undefined {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
    return undefined;
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const childRelative = relative(
    canonicalPathForCompare(parentPath),
    canonicalPathForCompare(childPath),
  );
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}

interface GuidanceCandidate {
  role: ProjectAgentGuidanceRole;
  path: string;
  guidanceDirectoryIdentities?: GuidanceDirectoryIdentities;
}

interface RoleScan {
  candidate?: GuidanceCandidate;
}

/**
 * Select the nearest exact filename for a role before validating it. A
 * selected file shadows every farther same-role file, including when it is
 * invalid or whitespace-only.
 */
function scanRoleCandidates(
  role: ProjectAgentGuidanceRole,
  directories: string[],
  diagnostics: ProjectAgentGuidanceDiagnostic[],
  directoryChecks: Map<string, GuidanceDirectoryCheck>,
): RoleScan {
  const filename = ROLE_FILENAMES[role];

  for (const directory of directories) {
    let directoryCheck = directoryChecks.get(directory);
    if (directoryCheck === undefined) {
      directoryCheck = checkGuidanceDirectory(directory, diagnostics);
      directoryChecks.set(directory, directoryCheck);
    }
    if (directoryCheck.status === "missing") continue;
    if (directoryCheck.status === "blocked") return {};
    if (!directoryCheck.entries?.has(filename)) continue;

    // The exact filename has now been selected. Do not inspect any farther
    // same-role candidate if this validation fails.
    const builtinDirectory = join(
      directory,
      PROJECT_AGENT_GUIDANCE_DIRECTORY,
      PROJECT_AGENT_GUIDANCE_AGENTS_DIRECTORY,
      PROJECT_AGENT_GUIDANCE_BUILTIN_DIRECTORY,
    );
    const filePath = join(builtinDirectory, filename);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (!isMissingError(error)) {
        pushDiagnostic(diagnostics, {
          code: "file-inspection-failed",
          message: `Could not inspect project-agent guidance file '${filePath}': ${errorMessage(error)}`,
          path: filePath,
          role,
        });
      }
      return {};
    }

    if (stat.isSymbolicLink()) {
      pushDiagnostic(diagnostics, {
        code: "symlink-file",
        message: `Project-agent guidance file '${filePath}' is a symlink; refusing to read it. Replace it with a regular file.`,
        path: filePath,
        role,
      });
      return {};
    }
    if (!stat.isFile()) {
      pushDiagnostic(diagnostics, {
        code: "non-regular-file",
        message: `Project-agent guidance path '${filePath}' is not a regular file; refusing to read it.`,
        path: filePath,
        role,
      });
      return {};
    }
    if (stat.size > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
      pushDiagnostic(diagnostics, {
        code: "file-too-large",
        message: `Project-agent guidance file '${filePath}' is larger than ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB); refusing to read it.`,
        path: filePath,
        role,
      });
      return {};
    }
    return {
      candidate: {
        role,
        path: filePath,
        guidanceDirectoryIdentities: directoryCheck.identities,
      },
    };
  }

  return {};
}

function addFileReadFailure(
  diagnostics: ProjectAgentGuidanceDiagnostic[],
  candidate: GuidanceCandidate,
  detail: string,
): void {
  pushDiagnostic(diagnostics, {
    code: "file-read-failed",
    message: `Could not safely read project-agent guidance file '${candidate.path}': ${detail}`,
    path: candidate.path,
    role: candidate.role,
  });
}

function readGuidanceFileCore(
  candidate: GuidanceCandidate,
  trustBoundaryPath: string,
  diagnostics: ProjectAgentGuidanceDiagnostic[],
  noFollowFlag: unknown,
): string | undefined {
  let descriptor: number | undefined;
  try {
    const noFollow = noFollowFlag;
    if (typeof noFollow !== "number" || noFollow === 0) {
      addFileReadFailure(
        diagnostics,
        candidate,
        "the O_NOFOLLOW open flag is unavailable; refusing an unbound path read",
      );
      return undefined;
    }
    descriptor = fs.openSync(candidate.path, fs.constants.O_RDONLY | noFollow);

    // O_NOFOLLOW protects only the final component. Re-check every
    // intermediate directory, canonical containment, and the opened path
    // after open so a replaced .tlh/agents/builtin path cannot redirect this
    // descriptor to an external source.
    const builtinDirectory = dirname(candidate.path);
    const agentsDirectory = dirname(builtinDirectory);
    const tlhDirectory = dirname(agentsDirectory);
    const expectedDirectoryIdentities = candidate.guidanceDirectoryIdentities;
    const directoryChecks = [
      { label: ".tlh", path: tlhDirectory, identity: expectedDirectoryIdentities?.tlh },
      {
        label: ".tlh/agents",
        path: agentsDirectory,
        identity: expectedDirectoryIdentities?.agents,
      },
      {
        label: ".tlh/agents/builtin",
        path: builtinDirectory,
        identity: expectedDirectoryIdentities?.builtin,
      },
    ] as const;
    for (const directoryCheck of directoryChecks) {
      const stat = fs.lstatSync(directoryCheck.path);
      if (stat.isSymbolicLink()) {
        pushDiagnostic(diagnostics, {
          code: "symlink-directory",
          message: `Project-agent guidance directory '${directoryCheck.path}' became a symlink before the file could be read; refusing to inspect it.`,
          path: directoryCheck.path,
          role: candidate.role,
        });
        return undefined;
      }
      if (!stat.isDirectory()) {
        pushDiagnostic(diagnostics, {
          code: "invalid-directory",
          message: `Project-agent guidance path '${directoryCheck.path}' is no longer a directory; refusing to inspect it.`,
          path: directoryCheck.path,
          role: candidate.role,
        });
        return undefined;
      }
      const currentIdentity = fileIdentity(stat);
      if (!directoryCheck.identity || !currentIdentity) {
        addFileReadFailure(
          diagnostics,
          candidate,
          `the ${directoryCheck.label} directory identity could not be proven`,
        );
        return undefined;
      }
      if (!sameFileIdentity(directoryCheck.identity, currentIdentity)) {
        addFileReadFailure(
          diagnostics,
          candidate,
          `the ${directoryCheck.label} directory changed while the file was being opened`,
        );
        return undefined;
      }
    }

    const pathStat = fs.lstatSync(candidate.path);
    if (pathStat.isSymbolicLink()) {
      pushDiagnostic(diagnostics, {
        code: "symlink-file",
        message: `Project-agent guidance file '${candidate.path}' became a symlink before it could be read; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }
    if (!pathStat.isFile()) {
      pushDiagnostic(diagnostics, {
        code: "non-regular-file",
        message: `Project-agent guidance file '${candidate.path}' is no longer a regular file; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }

    const canonicalTrustBoundary = strictCanonicalPath(trustBoundaryPath);
    if (!canonicalTrustBoundary || canonicalTrustBoundary !== trustBoundaryPath) {
      addFileReadFailure(
        diagnostics,
        candidate,
        "the persisted trust boundary could not be strictly canonicalized",
      );
      return undefined;
    }
    const canonicalTlhDirectory = strictCanonicalPath(tlhDirectory);
    const canonicalAgentsDirectory = strictCanonicalPath(agentsDirectory);
    const canonicalBuiltinDirectory = strictCanonicalPath(builtinDirectory);
    const canonicalCandidatePath = strictCanonicalPath(candidate.path);
    if (
      !canonicalTlhDirectory ||
      !canonicalAgentsDirectory ||
      !canonicalBuiltinDirectory ||
      !canonicalCandidatePath
    ) {
      addFileReadFailure(
        diagnostics,
        candidate,
        "the guidance directories and file could not be strictly canonicalized",
      );
      return undefined;
    }
    if (
      !isCanonicalPathWithin(canonicalTrustBoundary, canonicalTlhDirectory) ||
      !isCanonicalPathWithin(canonicalTrustBoundary, canonicalAgentsDirectory) ||
      !isCanonicalPathWithin(canonicalTrustBoundary, canonicalBuiltinDirectory) ||
      !isCanonicalPathWithin(canonicalTrustBoundary, canonicalCandidatePath)
    ) {
      pushDiagnostic(diagnostics, {
        code: "source-outside-trusted-subtree",
        message: `Skipped project-agent guidance file '${candidate.path}' because its opened path is outside the persisted trusted subtree '${trustBoundaryPath}'. Run \`/trust\` for the source project path, persist that decision, then run \`/reload\` or restart.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }
    if (
      dirname(canonicalAgentsDirectory) !== canonicalTlhDirectory ||
      dirname(canonicalBuiltinDirectory) !== canonicalAgentsDirectory ||
      dirname(canonicalCandidatePath) !== canonicalBuiltinDirectory
    ) {
      addFileReadFailure(
        diagnostics,
        candidate,
        "the opened file no longer resolves directly under its validated .tlh/agents/builtin directory",
      );
      return undefined;
    }

    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) {
      pushDiagnostic(diagnostics, {
        code: "non-regular-file",
        message: `Project-agent guidance file '${candidate.path}' is not a regular file; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }

    // Compare the descriptor with the currently resolved regular file before
    // reading. This closes the file replacement window between scan and open.
    const currentPathLstat = fs.lstatSync(candidate.path);
    if (currentPathLstat.isSymbolicLink()) {
      pushDiagnostic(diagnostics, {
        code: "symlink-file",
        message: `Project-agent guidance file '${candidate.path}' became a symlink before it could be read; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }
    if (!currentPathLstat.isFile()) {
      pushDiagnostic(diagnostics, {
        code: "non-regular-file",
        message: `Project-agent guidance file '${candidate.path}' is no longer a regular file; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }
    const currentPathStat = fs.statSync(canonicalCandidatePath);
    if (!currentPathStat.isFile()) {
      pushDiagnostic(diagnostics, {
        code: "non-regular-file",
        message: `Project-agent guidance file '${candidate.path}' no longer resolves to a regular file; refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }
    const descriptorIdentity = fileIdentity(descriptorStat);
    const currentPathIdentity = fileIdentity(currentPathStat);
    if (!descriptorIdentity || !currentPathIdentity) {
      addFileReadFailure(diagnostics, candidate, "opened-file identity could not be proven");
      return undefined;
    }
    if (!sameFileIdentity(descriptorIdentity, currentPathIdentity)) {
      addFileReadFailure(
        diagnostics,
        candidate,
        "the opened file no longer matches the currently resolved path",
      );
      return undefined;
    }
    if (descriptorStat.size > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
      pushDiagnostic(diagnostics, {
        code: "file-too-large",
        message: `Project-agent guidance file '${candidate.path}' is larger than ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB); refusing to read it.`,
        path: candidate.path,
        role: candidate.role,
      });
      return undefined;
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
      const remaining = PROJECT_AGENT_GUIDANCE_MAX_BYTES + 1 - bytesRead;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
      if (bytesRead > PROJECT_AGENT_GUIDANCE_MAX_BYTES) {
        pushDiagnostic(diagnostics, {
          code: "file-too-large",
          message: `Project-agent guidance file '${candidate.path}' grew beyond ${PROJECT_AGENT_GUIDANCE_MAX_BYTES} bytes (64 KiB) while being read; refusing to use it.`,
          path: candidate.path,
          role: candidate.role,
        });
        return undefined;
      }
    }

    const content = Buffer.concat(chunks, bytesRead).toString("utf8");
    return content.trim().length === 0 ? "" : content;
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      pushDiagnostic(diagnostics, {
        code: "symlink-file",
        message: `Project-agent guidance file '${candidate.path}' is a symlink; refusing to read it. Replace it with a regular file.`,
        path: candidate.path,
        role: candidate.role,
      });
    } else {
      pushDiagnostic(diagnostics, {
        code: "file-read-failed",
        message: `Could not read project-agent guidance file '${candidate.path}': ${errorMessage(error)}`,
        path: candidate.path,
        role: candidate.role,
      });
    }
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The guidance result is already determined; close is best effort.
      }
    }
  }
}

function readGuidanceFile(
  candidate: GuidanceCandidate,
  trustBoundaryPath: string,
  diagnostics: ProjectAgentGuidanceDiagnostic[],
): string | undefined {
  return readGuidanceFileCore(candidate, trustBoundaryPath, diagnostics, fs.constants.O_NOFOLLOW);
}

function trustState(decision: ProjectTrustDecision): ProjectAgentGuidanceTrustState {
  if (decision === true) return "trusted";
  if (decision === false) return "denied";
  return "undecided";
}

function inspectProjectTrust(
  cwd: string,
  agentDir: string,
  diagnostics: ProjectAgentGuidanceDiagnostic[],
): {
  state: ProjectAgentGuidanceTrustState;
  decision: ProjectTrustDecision;
  entryPath?: string;
} {
  try {
    const entry = new ProjectTrustStore(agentDir).getEntry(cwd);
    const decision = entry?.decision ?? null;
    return {
      state: trustState(decision),
      decision,
      // ProjectTrustStore returns the canonical persisted key. Keep this
      // physical path for containment checks; mapping it through a lexical
      // symlinked cwd could turn the trusted subtree into an unrelated host
      // path and authorize guidance from outside it.
      entryPath: entry?.path,
    };
  } catch (error) {
    pushDiagnostic(diagnostics, {
      code: "trust-inspection-failed",
      message: `Could not inspect persisted project trust for '${cwd}': ${errorMessage(error)} Project-agent guidance remains disabled until a readable trust decision is available. Run \`/trust\`, persist the decision, then run \`/reload\` or restart.`,
      path: agentDir,
    });
    return { state: "unavailable", decision: null };
  }
}

function addTrustDiagnostic(
  inventory: Pick<ProjectAgentGuidanceInventory, "trust" | "cwd" | "diagnostics">,
): void {
  if (inventory.trust === "trusted" || inventory.trust === "unavailable") return;
  const detail =
    inventory.trust === "denied"
      ? "persisted project trust is denied"
      : "no persisted project trust decision was found";
  pushDiagnostic(inventory.diagnostics, {
    code: "project-not-trusted",
    message: `Project-agent guidance is disabled because ${detail} for '${inventory.cwd}'. Run \`/trust\`, persist the decision, then run \`/reload\` or restart before using files under '${PROJECT_AGENT_GUIDANCE_DIRECTORY}/agents/builtin'.`,
    path: inventory.cwd,
  });
}

function addSkippedSourceDiagnostic(
  inventory: Pick<
    ProjectAgentGuidanceInventory,
    "trust" | "cwd" | "trustEntryPath" | "diagnostics"
  >,
  candidate: GuidanceCandidate,
): boolean {
  if (inventory.trust !== "trusted") return false;

  if (inventory.trustEntryPath === undefined) {
    pushDiagnostic(inventory.diagnostics, {
      code: "source-outside-trusted-subtree",
      message: `Skipped project-agent guidance file '${candidate.path}' because the trusted project containment boundary could not be established. Run \`/trust\`, persist the decision, then run \`/reload\` or restart.`,
      path: candidate.path,
      role: candidate.role,
    });
    return true;
  }
  if (isPathWithin(inventory.trustEntryPath, candidate.path)) return false;

  pushDiagnostic(inventory.diagnostics, {
    code: "source-outside-trusted-subtree",
    message: `Skipped project-agent guidance file '${candidate.path}' because persisted trust for '${inventory.cwd}' covers '${inventory.trustEntryPath}' but not this source. Run \`/trust\` for the source project path, persist that decision, then run \`/reload\` or restart.`,
    path: candidate.path,
    role: candidate.role,
  });
  return true;
}

/**
 * Return whether an agent config is the installer-managed TLH minor-agent file.
 *
 * The loader intentionally reports copied TLH prompts as `source: "user"`, so
 * source metadata cannot establish first-party provenance. Require both the
 * exact unqualified packaged role and the exact profile-relative path instead;
 * this keeps same-name user/project/package/extra agents out while allowing
 * settings overrides to clone the canonical config without losing provenance.
 */
export function isCanonicalPackagedMinorAgent(agent: unknown): boolean {
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return false;
  const candidate = agent as { name?: unknown; filePath?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.filePath !== "string") return false;

  const role = PACKAGED_MINOR_AGENT_ROLES.find((packagedRole) => packagedRole === candidate.name);
  if (!role) return false;

  let canonicalPath: string;
  try {
    canonicalPath = resolve(getAgentDir(), "tlh", "agents", "subagents", `${role}.md`);
    return resolve(candidate.filePath) === canonicalPath;
  } catch {
    return false;
  }
}

/** Map one exact packaged role id to its required uppercase guidance filename. */
export function projectAgentGuidanceFilename(role: unknown): string | undefined {
  if (typeof role !== "string" || !Object.hasOwn(ROLE_FILENAMES, role)) return undefined;
  return ROLE_FILENAMES[role as ProjectAgentGuidanceRole];
}

/**
 * Build one safe, read-bounded inventory for all packaged roles. Unknown and
 * embedded role names are intentionally absent from this inventory.
 */
export function inventoryProjectAgentGuidance(
  cwdInput: unknown,
  agentDirInput: unknown,
): ProjectAgentGuidanceInventory {
  const diagnostics: ProjectAgentGuidanceDiagnostic[] = [];
  const cwd = resolveInputPath(cwdInput, "cwd", diagnostics);
  const agentDir = resolveInputPath(agentDirInput, "agent directory", diagnostics);
  const inventory: ProjectAgentGuidanceInventory = {
    cwd: cwd ?? "",
    trust: "unavailable",
    trustDecision: null,
    files: [],
    diagnostics,
  };
  if (!cwd || !agentDir) return inventory;

  const worktree = findGitWorktree(cwd);
  if (worktree.root) inventory.worktreeRoot = worktree.root;
  const directories = searchDirectories(worktree.searchCwd, worktree.root);
  const directoryChecks = new Map<string, GuidanceDirectoryCheck>();
  const scans = new Map<ProjectAgentGuidanceRole, RoleScan>();
  let hasReadableCandidate = false;

  for (const role of PROJECT_AGENT_GUIDANCE_ROLES) {
    const scan = scanRoleCandidates(role, directories, diagnostics, directoryChecks);
    scans.set(role, scan);
    if (scan.candidate !== undefined) hasReadableCandidate = true;
  }

  if (!hasReadableCandidate) {
    // No readable packaged role file means trust was not needed or evaluated.
    // This avoids creating an isolated trust-store directory just to resolve
    // an absent or rejected file.
    inventory.trust = "not-evaluated";
    return inventory;
  }

  const trust = inspectProjectTrust(cwd, agentDir, diagnostics);
  inventory.trust = trust.state;
  inventory.trustDecision = trust.decision;
  inventory.trustEntryPath = trust.entryPath;
  addTrustDiagnostic(inventory);

  for (const role of PROJECT_AGENT_GUIDANCE_ROLES) {
    const scan = scans.get(role);
    const candidate = scan?.candidate;
    if (!candidate) continue;

    // The nearest exact filename was selected before this stage. It shadows
    // farther same-role files even when it is whitespace-only or unreadable.
    if (inventory.trust !== "trusted") {
      inventory.files.push({ role, path: candidate.path });
      continue;
    }
    if (addSkippedSourceDiagnostic(inventory, candidate)) {
      inventory.files.push({ role, path: candidate.path });
      continue;
    }

    const trustBoundaryPath = inventory.trustEntryPath;
    if (trustBoundaryPath === undefined) {
      // addSkippedSourceDiagnostic() normally handles this branch; keep the
      // read boundary explicit so no trusted file is read without one.
      inventory.files.push({ role, path: candidate.path });
      continue;
    }
    const content = readGuidanceFile(candidate, trustBoundaryPath, diagnostics);
    if (content === undefined) {
      // A read failure is fail-closed: the selected nearest file cannot fall
      // back to a farther same-role file.
      continue;
    }
    if (content.length === 0) {
      // Whitespace-only nearest guidance is an explicit opt-out, not a reason
      // to fall through to a farther file.
      continue;
    }

    inventory.files.push({ role, path: candidate.path, content });
  }

  return inventory;
}

/** Resolve a role from a previously created inventory without filesystem I/O. */
export function resolveProjectAgentGuidanceFromInventory(
  inventory: ProjectAgentGuidanceInventory,
  roleInput: unknown,
): ProjectAgentGuidanceResult {
  const role =
    typeof roleInput === "string" && Object.hasOwn(ROLE_FILENAMES, roleInput)
      ? (roleInput as ProjectAgentGuidanceRole)
      : undefined;
  if (!role) return { inventory };

  const file = inventory.files.find((candidate) => candidate.role === role);
  return file?.content === undefined
    ? { role, inventory }
    : { role, guidance: file.content, sourcePath: file.path, inventory };
}

/**
 * Resolve one packaged role and retain the complete inventory for callers that
 * need to report all recognized files and diagnostics once.
 */
export function resolveProjectAgentGuidance(
  cwdInput: unknown,
  agentDirInput: unknown,
  roleInput: unknown,
): ProjectAgentGuidanceResult {
  const inventory = inventoryProjectAgentGuidance(cwdInput, agentDirInput);
  return resolveProjectAgentGuidanceFromInventory(inventory, roleInput);
}

function encodeProjectGuidanceSourceLabel(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    if (character === "\\") {
      return "\\\\";
    }
    return character;
  }).join("");
}

function projectGuidanceSourceLabel(
  inventory: ProjectAgentGuidanceInventory,
  sourcePath: string,
): string {
  const root = inventory.worktreeRoot ?? inventory.cwd;
  const relativePath = relative(root, sourcePath);
  const outsideRoot =
    isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`);
  const label = outsideRoot ? "[outside-worktree]" : relativePath || ".";
  return encodeProjectGuidanceSourceLabel(label.split(sep).join("/"));
}

function escapeProjectGuidanceDelimiter(guidance: string): string {
  return guidance.replaceAll(PROJECT_GUIDANCE_CLOSE_DELIMITER, "<\\/tlh_project_agent_guidance>");
}

/** Format one trusted, role-matched guidance block for a runtime system prompt. */
export function formatProjectAgentGuidance(
  inventory: ProjectAgentGuidanceInventory | undefined,
  role: unknown,
): string {
  if (!inventory) {
    return "";
  }

  const result = resolveProjectAgentGuidanceFromInventory(inventory, role);
  if (!result.guidance || !result.sourcePath) {
    return "";
  }

  return [
    "## TLH Project Agent Guidance",
    "",
    `Source: ${projectGuidanceSourceLabel(inventory, result.sourcePath)}`,
    "",
    PROJECT_GUIDANCE_OPEN_DELIMITER,
    escapeProjectGuidanceDelimiter(result.guidance.trim()),
    PROJECT_GUIDANCE_CLOSE_DELIMITER,
  ].join("\n");
}

/** @internal Exported only for tests; do not use outside this module. */
export const __testing = {
  readGuidanceFileCore,
};
