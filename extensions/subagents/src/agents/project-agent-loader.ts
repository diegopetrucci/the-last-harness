import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveValidatedGitWorktreeRoot,
  type ValidatedWorktreeFileSystem,
} from "../../../shared/project-agent-worktree.js";
import type { AcceptanceRole, ToolBudgetConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";
import {
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  resolveProjectAgentSnapshot,
  type ProjectAgentSnapshotCapability,
  type ProjectAgentSnapshotEntry,
  type ProjectAgentSnapshotExpected,
  type ProjectAgentSnapshotManifest,
  type ProjectAgentSnapshotProvenance,
} from "./project-agent-snapshot.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName } from "./identity.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import type { AgentConfig } from "./agents.ts";

/** The only project-owned directory considered by the TLH project-agent loader. */
export const PROJECT_AGENT_DIRECTORY = path.join(".tlh", "agents", "custom");
export const PROJECT_AGENT_PARENT_DIRECTORY = path.join(".tlh", "agents");
export const PROJECT_AGENT_PACKAGE = "embedded";

/** Bounds are deliberately finite because this loader runs before project code is trusted. */
export const MAX_PROJECT_AGENT_FILE_BYTES = 64 * 1024;
export const MAX_PROJECT_AGENT_FILES = 128;
export const MAX_PROJECT_AGENT_TOTAL_BYTES = 8 * 1024 * 1024;
/** Retained for API compatibility; custom-agent inventory is non-recursive. */
export const MAX_PROJECT_AGENT_DEPTH = 0;
/** Retained for API compatibility; only the fixed path components are inspected. */
export const MAX_PROJECT_AGENT_DIRECTORIES = 4;
export const MAX_PROJECT_AGENT_SCAN_ATTEMPTS = 3;

const PROJECT_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROJECT_AGENT_FILE_BASENAME_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/;
const PROJECT_AGENT_RUNTIME_NAME_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;
const PROJECT_AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PROJECT_AGENT_DEFINITION_SUFFIX = ".md";
const PROJECT_AGENT_CHAIN_SUFFIX = ".chain.md";

const KNOWN_FRONTMATTER_FIELDS = new Set([
  "name",
  "package",
  "description",
  "tools",
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "inheritProjectContext",
  "inheritSkills",
  "defaultContext",
  "acceptanceRole",
  "skill",
  "skills",
  "extensions",
  "subagentOnlyExtensions",
  "output",
  "defaultReads",
  "defaultProgress",
  "interactive",
  "maxSubagentDepth",
  "maxExecutionTimeMs",
  "completionGuard",
  "toolBudget",
]);

interface ProjectAgentDirectoryEntry {
  readonly name: string;
}

export interface ProjectAgentLoaderFileSystem extends ValidatedWorktreeFileSystem {
  readdirSync(filePath: string, options: { withFileTypes: true }): ProjectAgentDirectoryEntry[];
  /** Descriptor operations are mandatory for trusted definition reads. */
  openSync?: (filePath: string, flags: number) => number;
  fstatSync?: (fd: number) => fs.Stats;
  readSync?: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  closeSync?: (fd: number) => void;
  /** The platform's O_NOFOLLOW value; zero/undefined is fail-closed. */
  noFollowFlag?: number;
}

const DEFAULT_FILE_SYSTEM: ProjectAgentLoaderFileSystem = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  readdirSync: (filePath, options) => fs.readdirSync(filePath, options),
  realpathSync: (filePath) => fs.realpathSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath),
  openSync: (filePath, flags) => fs.openSync(filePath, flags),
  fstatSync: (fd) => fs.fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  noFollowFlag: fs.constants.O_NOFOLLOW,
};

/**
 * Retained as a structural compatibility type for callers that previously
 * injected Git command resolution. The loader no longer invokes Git; root
 * validation is performed by the shared metadata-only resolver.
 */
export interface ProjectAgentGit {
  showToplevel(cwd: string): string | undefined;
}

export interface ProjectAgentTrustStore {
  /** Return the nearest persisted entry so the loader can verify its source path. */
  getEntry(cwd: string): { path: string; decision: boolean } | null;
}

/**
 * Host-owned trust services. The generated native loader receives these from
 * primary-agent-runtime.ts rather than importing the peer-only Pi package.
 */
export interface ProjectAgentTrustDependencies {
  createProjectTrustStore: (agentDir: string) => ProjectAgentTrustStore;
}

/** Inputs for the persisted trust check; no project definition content is exposed here. */
export interface ProjectAgentTrustOptions {
  agentDir?: string;
  trustStore?: ProjectAgentTrustStore;
  /** A local denial may only narrow access; positive values are ignored. */
  trustOverride?: boolean;
  createProjectTrustStore?: (agentDir: string) => ProjectAgentTrustStore;
}

export type ProjectAgentTrustSource =
  | "explicit-negative"
  | "saved-positive"
  | "saved-negative"
  | "trust-path-mismatch"
  | "no-persisted-trust"
  | "trust-store-error"
  | "no-project-agents";

export interface ProjectAgentTrustResult {
  /** Nominally identifies this result as execution-plane agent trust. */
  readonly kind: "project-agent";
  readonly trusted: boolean;
  readonly source: ProjectAgentTrustSource;
}

export interface ProjectAgentDefinitionScanResult {
  readonly status: "stable" | "unstable" | "bounded" | "unavailable";
  readonly projectRoot: string;
  readonly agentsDirectory: string;
  readonly entries: readonly ProjectAgentSnapshotEntry[];
  readonly tombstones: readonly string[];
  readonly diagnostics: readonly string[];
  readonly candidateCount: number;
  readonly totalBytes: number;
}

export interface ProjectAgentDefinitionScanOptions {
  fileSystem?: ProjectAgentLoaderFileSystem;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  maxDirectories?: number;
}

export interface ProjectAgentSnapshotLoadOptions {
  cwd: string;
  sessionId: string;
  agentDir?: string;
  generationId?: string;
  trustOverride?: boolean;
  trust?: ProjectAgentTrustOptions;
  trustDependencies?: ProjectAgentTrustDependencies;
  git?: ProjectAgentGit;
  fileSystem?: ProjectAgentLoaderFileSystem;
  maxAttempts?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  maxDirectories?: number;
}

export interface LoadedProjectAgentSnapshot {
  readonly status: "loaded" | "denied" | "unavailable" | "unstable" | "bounded";
  readonly projectRoot?: string;
  readonly agentsDirectory?: string;
  readonly capability?: ProjectAgentSnapshotCapability;
  readonly provenance?: ProjectAgentSnapshotProvenance;
  readonly manifest?: ProjectAgentSnapshotManifest;
  readonly trust?: ProjectAgentTrustResult;
  readonly scan?: ProjectAgentDefinitionScanResult;
  readonly diagnostics: readonly string[];
}

export class ProjectAgentDefinitionError extends Error {
  readonly code = "INVALID_PROJECT_AGENT_DEFINITION" as const;

  constructor(filePath: string, reason: string) {
    super(`Invalid TLH project agent '${filePath}': ${reason}`);
    this.name = "ProjectAgentDefinitionError";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export type ProjectAgentCwdContainmentResult =
  | {
      readonly valid: true;
      readonly canonicalRoot: string;
      readonly canonicalCwd: string;
      readonly canonicalTaskCwds: readonly string[];
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

function canonicalExistingDirectory(
  value: unknown,
  label: string,
): { valid: true; path: string } | { valid: false; reason: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, reason: `${label} must be an existing directory path.` };
  }
  try {
    const canonical = fs.realpathSync(value);
    if (!fs.statSync(canonical).isDirectory()) {
      return { valid: false, reason: `${label} is not a directory: ${value}` };
    }
    return { valid: true, path: canonical };
  } catch {
    return { valid: false, reason: `${label} does not exist or cannot be resolved: ${value}` };
  }
}

/**
 * Independently validate the top-level and child execution directories for a
 * project-agent request. Every path must exist, resolve through symlinks, and
 * remain within the canonical project root.
 */
export function validateProjectAgentCwdContainment(
  projectRoot: string,
  cwd: unknown,
  taskCwds: readonly unknown[] = [],
): ProjectAgentCwdContainmentResult {
  const canonicalRoot = canonicalExistingDirectory(projectRoot, "Project root");
  if (!canonicalRoot.valid) return canonicalRoot;

  const canonicalCwd = canonicalExistingDirectory(cwd, "Execution cwd");
  if (!canonicalCwd.valid) return canonicalCwd;
  if (!isPathWithin(canonicalRoot.path, canonicalCwd.path)) {
    return {
      valid: false,
      reason: `Execution cwd is outside the canonical project root: ${cwd}`,
    };
  }

  if (typeof cwd !== "string") {
    return { valid: false, reason: "Execution cwd must be an existing directory path." };
  }
  const canonicalTaskCwds: string[] = [];
  for (let index = 0; index < taskCwds.length; index += 1) {
    const requested = taskCwds[index];
    if (requested !== undefined && typeof requested !== "string") {
      return {
        valid: false,
        reason: `Task ${index + 1} cwd must be an existing directory path.`,
      };
    }
    const taskPath =
      requested === undefined || requested === "" ? cwd : path.resolve(cwd, requested);
    const canonicalTask = canonicalExistingDirectory(taskPath, `Task ${index + 1} cwd`);
    if (!canonicalTask.valid) return canonicalTask;
    if (!isPathWithin(canonicalRoot.path, canonicalTask.path)) {
      return {
        valid: false,
        reason: `Task ${index + 1} cwd is outside the canonical project root: ${taskPath}`,
      };
    }
    canonicalTaskCwds.push(canonicalTask.path);
  }

  return {
    valid: true,
    canonicalRoot: canonicalRoot.path,
    canonicalCwd: canonicalCwd.path,
    canonicalTaskCwds,
  };
}

function statSignature(stat: fs.Stats): string {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    String(stat.size),
    String(stat.mtimeMs),
    String(stat.ctimeMs),
  ].join(":");
}

function isDefinitionFile(fileName: string): boolean {
  return (
    fileName.endsWith(PROJECT_AGENT_DEFINITION_SUFFIX) &&
    !fileName.endsWith(PROJECT_AGENT_CHAIN_SUFFIX)
  );
}

function candidateBasename(fileName: string): string {
  return fileName.endsWith(PROJECT_AGENT_DEFINITION_SUFFIX)
    ? fileName.slice(0, -PROJECT_AGENT_DEFINITION_SUFFIX.length)
    : fileName;
}

function runtimeNameForBasename(basename: string): string | undefined {
  if (!PROJECT_AGENT_FILE_BASENAME_PATTERN.test(basename)) return undefined;
  const localName = basename.toLowerCase();
  if (!PROJECT_AGENT_NAME_PATTERN.test(localName)) return undefined;
  const runtimeName = buildRuntimeName(localName, PROJECT_AGENT_PACKAGE);
  return PROJECT_AGENT_RUNTIME_NAME_PATTERN.test(runtimeName) ? runtimeName : undefined;
}

function normalizeBound(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeAttempts(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : MAX_PROJECT_AGENT_SCAN_ATTEMPTS;
}

/**
 * Resolve the session's project identity without invoking Git or trusting a
 * caller-supplied project path. The `git` option remains accepted only for
 * source compatibility with the pre-#588 loader and is intentionally ignored.
 */
export function resolveCanonicalGitWorktreeRoot(
  cwd: string,
  options: {
    git?: ProjectAgentGit;
    fileSystem?: ProjectAgentLoaderFileSystem;
  } = {},
): string | undefined {
  return resolveValidatedGitWorktreeRoot(cwd, {
    fileSystem: options.fileSystem ?? DEFAULT_FILE_SYSTEM,
  });
}

function trustEntryPathApplies(entryPath: string, projectRoot: string): boolean {
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) return false;
  try {
    const canonicalEntryPath = fs.realpathSync(entryPath);
    const canonicalProjectRoot = fs.realpathSync(projectRoot);
    return isPathWithin(canonicalEntryPath, canonicalProjectRoot);
  } catch {
    // A trust entry whose source cannot be canonicalized is not an approval.
    return false;
  }
}

function isUsableTrustStore(value: unknown): value is ProjectAgentTrustStore {
  try {
    return (
      Boolean(value) &&
      typeof value === "object" &&
      typeof (value as ProjectAgentTrustStore).getEntry === "function"
    );
  } catch {
    return false;
  }
}

function defaultTrustStore(options: ProjectAgentTrustOptions): ProjectAgentTrustStore | undefined {
  if (options.trustStore) {
    if (!isUsableTrustStore(options.trustStore)) {
      throw new Error("Project trust-store dependency returned an invalid store.");
    }
    return options.trustStore;
  }
  const agentDir = options.agentDir ?? getAgentDir();
  // ProjectTrustStore acquires a lock even for reads and therefore creates its
  // parent directory. Avoid that write when no persisted trust can exist.
  if (!fs.existsSync(path.join(agentDir, "trust.json"))) return undefined;
  if (typeof options.createProjectTrustStore !== "function") {
    throw new Error("Project trust-store dependency is unavailable.");
  }
  const store = options.createProjectTrustStore(agentDir);
  if (!isUsableTrustStore(store)) {
    throw new Error("Project trust-store dependency returned an invalid store.");
  }
  return store;
}

/**
 * Resolve only persisted trust for the canonical worktree. Session/UI state,
 * upstream trust state, and profile defaults are intentionally non-authoritative.
 */
export async function resolveProjectAgentTrust(
  projectRoot: string,
  options: ProjectAgentTrustOptions = {},
): Promise<ProjectAgentTrustResult> {
  if (options.trustOverride === false) {
    return { kind: "project-agent", trusted: false, source: "explicit-negative" };
  }

  let store: ProjectAgentTrustStore | undefined;
  try {
    store = defaultTrustStore(options);
    if (!store) return { kind: "project-agent", trusted: false, source: "no-persisted-trust" };

    const entry = store.getEntry(projectRoot);
    if (entry !== null && typeof entry !== "object") {
      return { kind: "project-agent", trusted: false, source: "trust-store-error" };
    }
    if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
      return { kind: "project-agent", trusted: false, source: "trust-store-error" };
    }
    if (!entry) return { kind: "project-agent", trusted: false, source: "no-persisted-trust" };
    if (!trustEntryPathApplies(entry.path, projectRoot)) {
      return { kind: "project-agent", trusted: false, source: "trust-path-mismatch" };
    }
    return entry.decision
      ? { kind: "project-agent", trusted: true, source: "saved-positive" }
      : { kind: "project-agent", trusted: false, source: "saved-negative" };
  } catch {
    return { kind: "project-agent", trusted: false, source: "trust-store-error" };
  }
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly canonicalPath: string;
  readonly signature: string;
  readonly identity: FileIdentity;
}

interface Candidate {
  readonly filePath: string;
  readonly relativePath: string;
  /** The exact filename stem; valid candidates use uppercase ASCII here. */
  readonly basename: string;
  readonly signature: string;
  readonly stat: fs.Stats;
  readonly identity?: FileIdentity;
  readonly regular: boolean;
  readonly symlink: boolean;
  readonly directories: readonly DirectorySnapshot[];
}

interface CandidateInventory {
  readonly status: "ok" | "unstable" | "unavailable" | "bounded";
  readonly candidates: readonly Candidate[];
  readonly directories: readonly DirectorySnapshot[];
  readonly diagnostics: readonly string[];
  readonly totalBytes: number;
}

function fileIdentity(stat: fs.Stats): FileIdentity | undefined {
  if (
    !Number.isSafeInteger(stat.dev) ||
    !Number.isSafeInteger(stat.ino) ||
    stat.dev <= 0 ||
    stat.ino <= 0
  ) {
    return undefined;
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

type FixedDirectoryResult =
  | { readonly status: "present"; readonly snapshot: DirectorySnapshot }
  | { readonly status: "missing" }
  | { readonly status: "unstable"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string };

function inspectDirectorySnapshot(
  rootPath: string,
  directoryPath: string,
  label: string,
  stat: fs.Stats,
  fileSystem: ProjectAgentLoaderFileSystem,
): { status: "present"; snapshot: DirectorySnapshot } | { status: "unavailable"; reason: string } {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      status: "unavailable",
      reason: `Project-agent ${label} is not a regular non-symlink directory: ${directoryPath}`,
    };
  }
  const identity = fileIdentity(stat);
  if (!identity) {
    return {
      status: "unavailable",
      reason: `Project-agent ${label} directory identity is unavailable: ${directoryPath}`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpathSync(directoryPath);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `Project-agent ${label} cannot be canonicalized: ${errorMessage(error)}`,
    };
  }
  if (!isPathWithin(rootPath, canonicalPath)) {
    return {
      status: "unavailable",
      reason: `Project-agent ${label} is outside the canonical project root: ${directoryPath}`,
    };
  }
  return {
    status: "present",
    snapshot: {
      path: directoryPath,
      canonicalPath,
      signature: statSignature(stat),
      identity,
    },
  };
}

function inspectFixedDirectory(
  rootPath: string,
  parentPath: string,
  name: string,
  label: string,
  fileSystem: ProjectAgentLoaderFileSystem,
): FixedDirectoryResult {
  let entries: ProjectAgentDirectoryEntry[];
  try {
    entries = fileSystem.readdirSync(parentPath, { withFileTypes: true });
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { status: "unstable", reason: `Project-agent parent disappeared: ${parentPath}` }
      : {
          status: "unavailable",
          reason: `Unable to enumerate project-agent directory '${parentPath}': ${errorMessage(error)}`,
        };
  }
  // Require exact components even on case-insensitive filesystems. Do not
  // lstat a case variant merely because the platform would resolve it.
  if (!entries.some((entry) => entry.name === name)) return { status: "missing" };

  const directoryPath = path.join(parentPath, name);
  let stat: fs.Stats;
  try {
    stat = fileSystem.lstatSync(directoryPath);
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { status: "unstable", reason: `Project-agent directory disappeared: ${directoryPath}` }
      : {
          status: "unavailable",
          reason: `Unable to inspect project-agent directory '${directoryPath}': ${errorMessage(error)}`,
        };
  }
  const snapshot = inspectDirectorySnapshot(rootPath, directoryPath, label, stat, fileSystem);
  return snapshot.status === "present"
    ? snapshot
    : { status: "unavailable", reason: snapshot.reason };
}

function inspectCandidate(
  agentsDirectory: string,
  filePath: string,
  fileName: string,
  stat: fs.Stats,
  directories: readonly DirectorySnapshot[],
): Candidate {
  const identity = fileIdentity(stat);
  return {
    filePath,
    relativePath: path.relative(agentsDirectory, filePath),
    basename: candidateBasename(fileName),
    signature: statSignature(stat),
    stat,
    identity,
    regular: stat.isFile() && !stat.isSymbolicLink() && identity !== undefined,
    symlink: stat.isSymbolicLink(),
    directories,
  };
}

function collectCandidateInventory(
  projectRoot: string,
  options: Required<Pick<ProjectAgentDefinitionScanOptions, "maxFiles" | "maxTotalBytes">> & {
    fileSystem: ProjectAgentLoaderFileSystem;
  },
): CandidateInventory {
  const agentsDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
  const candidates: Candidate[] = [];
  const diagnostics: string[] = [];
  let totalBytes = 0;
  const directories: DirectorySnapshot[] = [];

  // Check each fixed component independently. lstat on the final path would
  // follow a symlink in `.tlh`, which would make the accepted tree broader than
  // the repository-owned path promised by this loader.
  let rootStat: fs.Stats;
  try {
    rootStat = options.fileSystem.lstatSync(projectRoot);
  } catch (error) {
    return {
      status: isErrno(error, "ENOENT") ? "unstable" : "unavailable",
      candidates: [],
      directories,
      diagnostics: [
        `Unable to inspect canonical project root '${projectRoot}': ${errorMessage(error)}`,
      ],
      totalBytes: 0,
    };
  }
  const rootResult = inspectDirectorySnapshot(
    projectRoot,
    projectRoot,
    "root",
    rootStat,
    options.fileSystem,
  );
  if (rootResult.status !== "present") {
    return {
      status: "unavailable",
      candidates: [],
      directories,
      diagnostics: [rootResult.reason],
      totalBytes: 0,
    };
  }
  directories.push(rootResult.snapshot);

  const tlhResult = inspectFixedDirectory(
    projectRoot,
    projectRoot,
    ".tlh",
    ".tlh",
    options.fileSystem,
  );
  if (tlhResult.status === "missing") {
    return { status: "ok", candidates: [], directories, diagnostics: [], totalBytes: 0 };
  }
  if (tlhResult.status !== "present") {
    return {
      status: tlhResult.status,
      candidates: [],
      directories,
      diagnostics: [tlhResult.reason],
      totalBytes: 0,
    };
  }
  directories.push(tlhResult.snapshot);

  const agentsResult = inspectFixedDirectory(
    projectRoot,
    tlhResult.snapshot.path,
    "agents",
    ".tlh/agents",
    options.fileSystem,
  );
  if (agentsResult.status === "missing") {
    return { status: "ok", candidates: [], directories, diagnostics: [], totalBytes: 0 };
  }
  if (agentsResult.status !== "present") {
    return {
      status: agentsResult.status,
      candidates: [],
      directories,
      diagnostics: [agentsResult.reason],
      totalBytes: 0,
    };
  }
  directories.push(agentsResult.snapshot);

  const customResult = inspectFixedDirectory(
    projectRoot,
    agentsResult.snapshot.path,
    "custom",
    ".tlh/agents/custom",
    options.fileSystem,
  );
  if (customResult.status === "missing") {
    return { status: "ok", candidates: [], directories, diagnostics: [], totalBytes: 0 };
  }
  if (customResult.status !== "present") {
    return {
      status: customResult.status,
      candidates: [],
      directories,
      diagnostics: [customResult.reason],
      totalBytes: 0,
    };
  }
  directories.push(customResult.snapshot);

  const directory = agentsDirectory;
  let entries: ProjectAgentDirectoryEntry[];
  try {
    entries = options.fileSystem
      .readdirSync(directory, { withFileTypes: true })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    return {
      status: isErrno(error, "ENOENT") ? "unstable" : "unavailable",
      candidates: [],
      directories,
      diagnostics: [
        `Unable to enumerate project-agent directory '${directory}': ${errorMessage(error)}`,
      ],
      totalBytes: 0,
    };
  }

  for (const entry of entries) {
    // Only direct Markdown definition-looking entries are inventoried. Nested
    // directories and their contents are never traversed or inspected.
    if (!isDefinitionFile(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    let stat: fs.Stats;
    try {
      stat = options.fileSystem.lstatSync(filePath);
    } catch (error) {
      return {
        status: isErrno(error, "ENOENT") ? "unstable" : "unavailable",
        candidates: [],
        directories,
        diagnostics: [`Unable to inspect project-agent path '${filePath}': ${errorMessage(error)}`],
        totalBytes: 0,
      };
    }
    const candidate = inspectCandidate(directory, filePath, entry.name, stat, directories);
    candidates.push(candidate);
    totalBytes += Math.max(0, candidate.stat.size);
    if (candidates.length > options.maxFiles || totalBytes > options.maxTotalBytes) {
      return {
        status: "bounded",
        candidates,
        directories,
        diagnostics: [
          candidates.length > options.maxFiles
            ? `Project-agent file count exceeds ${options.maxFiles}.`
            : `Project-agent byte count exceeds ${options.maxTotalBytes}.`,
        ],
        totalBytes,
      };
    }
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { status: "ok", candidates, directories, diagnostics, totalBytes };
}

function sameInventory(left: CandidateInventory, right: CandidateInventory): boolean {
  if (left.status !== "ok" || right.status !== "ok") return false;
  if (left.totalBytes !== right.totalBytes) return false;
  if (left.directories.length !== right.directories.length) return false;
  for (const [index, directory] of left.directories.entries()) {
    const other = right.directories[index];
    if (
      !other ||
      directory.path !== other.path ||
      directory.canonicalPath !== other.canonicalPath ||
      directory.signature !== other.signature ||
      !sameFileIdentity(directory.identity, other.identity)
    ) {
      return false;
    }
  }
  if (left.candidates.length !== right.candidates.length) return false;
  return left.candidates.every((candidate, index) => {
    const other = right.candidates[index];
    return (
      other !== undefined &&
      candidate.relativePath === other.relativePath &&
      candidate.signature === other.signature &&
      candidate.regular === other.regular &&
      candidate.symlink === other.symlink &&
      (candidate.identity === undefined) === (other.identity === undefined) &&
      (candidate.identity === undefined ||
        (other.identity !== undefined && sameFileIdentity(candidate.identity, other.identity)))
    );
  });
}

function validateDirectorySnapshots(
  projectRoot: string,
  candidate: Candidate,
  fileSystem: ProjectAgentLoaderFileSystem,
): { valid: true } | { valid: false; reason: string } {
  for (const directory of candidate.directories) {
    let stat: fs.Stats;
    try {
      stat = fileSystem.lstatSync(directory.path);
    } catch (error) {
      return { valid: false, reason: `directory cannot be inspected: ${errorMessage(error)}` };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { valid: false, reason: "directory component is not a regular non-symlink directory" };
    }
    const identity = fileIdentity(stat);
    if (!identity) return { valid: false, reason: "directory identity cannot be proven" };
    if (!sameFileIdentity(directory.identity, identity)) {
      return { valid: false, reason: `directory identity changed: ${directory.path}` };
    }
    let canonicalPath: string;
    try {
      canonicalPath = fileSystem.realpathSync(directory.path);
    } catch (error) {
      return { valid: false, reason: `directory cannot be canonicalized: ${errorMessage(error)}` };
    }
    if (!isPathWithin(projectRoot, canonicalPath) || canonicalPath !== directory.canonicalPath) {
      return { valid: false, reason: "directory canonical containment changed" };
    }
  }
  return { valid: true };
}

function validateCandidatePath(
  projectRoot: string,
  candidate: Candidate,
  fileSystem: ProjectAgentLoaderFileSystem,
):
  | { valid: true; canonicalPath: string; stat: fs.Stats; identity: FileIdentity }
  | { valid: false; reason: string } {
  if (!candidate.regular || candidate.symlink || !candidate.identity) {
    return { valid: false, reason: "candidate is not a regular non-symlink file" };
  }
  const customDirectory = candidate.directories[candidate.directories.length - 1];
  if (!customDirectory) return { valid: false, reason: "custom directory identity is unavailable" };
  if (
    path.dirname(candidate.filePath) !== customDirectory.path ||
    !isPathWithin(projectRoot, candidate.filePath)
  ) {
    return { valid: false, reason: "candidate is outside the canonical custom-agent directory" };
  }
  const directories = validateDirectorySnapshots(projectRoot, candidate, fileSystem);
  if (!directories.valid) return directories;

  let stat: fs.Stats;
  try {
    stat = fileSystem.lstatSync(candidate.filePath);
  } catch (error) {
    return { valid: false, reason: `file cannot be inspected: ${errorMessage(error)}` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { valid: false, reason: "candidate is not a regular non-symlink file" };
  }
  const identity = fileIdentity(stat);
  if (!identity) return { valid: false, reason: "candidate file identity cannot be proven" };
  if (!sameFileIdentity(candidate.identity, identity)) {
    return { valid: false, reason: "candidate file identity changed" };
  }
  if (statSignature(stat) !== candidate.signature) {
    return { valid: false, reason: "candidate changed before reading" };
  }

  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpathSync(candidate.filePath);
  } catch (error) {
    return { valid: false, reason: `file cannot be canonicalized: ${errorMessage(error)}` };
  }
  if (
    !isPathWithin(projectRoot, canonicalPath) ||
    path.dirname(canonicalPath) !== customDirectory.canonicalPath
  ) {
    return { valid: false, reason: "canonical file path is outside the custom-agent directory" };
  }
  return { valid: true, canonicalPath, stat, identity };
}

function bytesFromRead(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
}

function parseUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`definition bytes are not valid UTF-8: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function splitCommaList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseStrictBoolean(
  frontmatter: Record<string, string>,
  field: string,
  defaultValue: boolean,
  filePath: string,
): boolean {
  const value = frontmatter[field];
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ProjectAgentDefinitionError(filePath, `${field} must be true or false when provided`);
}

function parseStrictPositiveInteger(
  frontmatter: Record<string, string>,
  field: string,
  filePath: string,
): number | undefined {
  const value = frontmatter[field];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProjectAgentDefinitionError(filePath, `${field} must be a positive safe integer`);
  }
  return parsed;
}

function parseStrictNonNegativeInteger(
  frontmatter: Record<string, string>,
  field: string,
  filePath: string,
): number | undefined {
  const value = frontmatter[field];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProjectAgentDefinitionError(filePath, `${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseToolBudget(
  value: string | undefined,
  filePath: string,
): ToolBudgetConfig | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ProjectAgentDefinitionError(
      filePath,
      `toolBudget is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const normalized = validateToolBudgetConfig(parsed, "toolBudget");
  if (normalized.error) {
    throw new ProjectAgentDefinitionError(filePath, normalized.error);
  }
  if (!normalized.budget) {
    throw new ProjectAgentDefinitionError(filePath, "toolBudget must define a valid budget");
  }
  return normalized.budget;
}

function frontmatterEnvelopeError(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return "frontmatter must start with '---'";
  const firstLineEnd = normalized.indexOf("\n");
  if (firstLineEnd === -1 || normalized.slice(0, firstLineEnd).trim() !== "---") {
    return "frontmatter opening delimiter is invalid";
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return "frontmatter closing delimiter is missing";
  const closeLineEnd = normalized.indexOf("\n", endIndex + 1);
  const closeLine =
    closeLineEnd === -1
      ? normalized.slice(endIndex + 1)
      : normalized.slice(endIndex + 1, closeLineEnd);
  if (closeLine.trim() !== "---") return "frontmatter closing delimiter is invalid";
  return undefined;
}

function duplicateFrontmatterField(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return undefined;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return undefined;
  const fields = new Set<string>();
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1]!;
    if (fields.has(field)) return field;
    fields.add(field);
  }
  return undefined;
}

function parseProjectAgentDefinitionFromText(
  filePath: string,
  content: string,
  exactBytes: Buffer = Buffer.from(content, "utf-8"),
): ProjectAgentSnapshotEntry {
  const basename = candidateBasename(path.basename(filePath));
  const envelopeError = frontmatterEnvelopeError(content);
  if (envelopeError) throw new ProjectAgentDefinitionError(filePath, envelopeError);
  const { frontmatter, body } = parseFrontmatter(content);
  const frontmatterFields = Object.keys(frontmatter);
  const duplicateField = duplicateFrontmatterField(content);
  if (duplicateField) {
    throw new ProjectAgentDefinitionError(
      filePath,
      `frontmatter field '${duplicateField}' is declared more than once`,
    );
  }

  if (!PROJECT_AGENT_FILE_BASENAME_PATTERN.test(basename)) {
    throw new ProjectAgentDefinitionError(
      filePath,
      "file basename must contain only uppercase ASCII letters, digits, and hyphens",
    );
  }
  const localName = basename.toLowerCase();
  if (!PROJECT_AGENT_NAME_PATTERN.test(localName)) {
    throw new ProjectAgentDefinitionError(filePath, "file basename is not a valid agent name");
  }
  if (frontmatter.name !== localName) {
    throw new ProjectAgentDefinitionError(
      filePath,
      `frontmatter name must exactly equal lowercase file basename '${localName}'`,
    );
  }
  if (frontmatter.package !== PROJECT_AGENT_PACKAGE) {
    throw new ProjectAgentDefinitionError(
      filePath,
      `package must exactly be '${PROJECT_AGENT_PACKAGE}'`,
    );
  }
  if (frontmatter.description === undefined || frontmatter.description.trim() === "") {
    throw new ProjectAgentDefinitionError(filePath, "description must be non-empty");
  }
  if (!Object.prototype.hasOwnProperty.call(frontmatter, "tools")) {
    throw new ProjectAgentDefinitionError(filePath, "tools must be explicitly declared");
  }

  const rawTools = splitCommaList(frontmatter.tools) ?? [];
  const tools = rawTools.filter((tool) => !tool.startsWith("mcp:"));
  if (tools.length === 0) {
    throw new ProjectAgentDefinitionError(filePath, "tools must declare at least one usable tool");
  }
  for (const tool of tools) {
    if (!PROJECT_AGENT_TOOL_NAME_PATTERN.test(tool)) {
      throw new ProjectAgentDefinitionError(
        filePath,
        `tool '${tool}' is not a valid runtime tool name`,
      );
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(frontmatter, "extensions") ||
    Object.prototype.hasOwnProperty.call(frontmatter, "subagentOnlyExtensions")
  ) {
    throw new ProjectAgentDefinitionError(
      filePath,
      "extensions and subagentOnlyExtensions are prohibited for project agents",
    );
  }

  const runtimeName = buildRuntimeName(localName, PROJECT_AGENT_PACKAGE);
  if (!PROJECT_AGENT_RUNTIME_NAME_PATTERN.test(runtimeName)) {
    throw new ProjectAgentDefinitionError(filePath, "runtime name is invalid");
  }

  const fallbackModels = splitCommaList(frontmatter.fallbackModels);
  const skillString = frontmatter.skill || frontmatter.skills;
  const skills = splitCommaList(skillString);
  const defaultReads = splitCommaList(frontmatter.defaultReads);
  const systemPromptMode = frontmatter.systemPromptMode;
  if (
    systemPromptMode !== undefined &&
    systemPromptMode !== "append" &&
    systemPromptMode !== "replace"
  ) {
    throw new ProjectAgentDefinitionError(
      filePath,
      "systemPromptMode must be 'append' or 'replace'",
    );
  }
  const defaultContext = frontmatter.defaultContext;
  if (defaultContext !== undefined && defaultContext !== "fresh" && defaultContext !== "fork") {
    throw new ProjectAgentDefinitionError(filePath, "defaultContext must be 'fresh' or 'fork'");
  }

  let acceptanceRole: AcceptanceRole | undefined;
  if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim() !== "") {
    if (frontmatter.acceptanceRole !== "read-only" && frontmatter.acceptanceRole !== "writer") {
      throw new ProjectAgentDefinitionError(
        filePath,
        "acceptanceRole must be 'read-only' or 'writer'",
      );
    }
    acceptanceRole = frontmatter.acceptanceRole;
  }

  const parsedMaxSubagentDepth = parseStrictNonNegativeInteger(
    frontmatter,
    "maxSubagentDepth",
    filePath,
  );
  const maxExecutionTimeMs = parseStrictPositiveInteger(
    frontmatter,
    "maxExecutionTimeMs",
    filePath,
  );
  const toolBudget = parseToolBudget(frontmatter.toolBudget, filePath);
  const completionGuard =
    frontmatter.completionGuard === undefined
      ? undefined
      : parseStrictBoolean(frontmatter, "completionGuard", false, filePath);
  const defaultProgress = parseStrictBoolean(frontmatter, "defaultProgress", false, filePath);
  const interactive = parseStrictBoolean(frontmatter, "interactive", false, filePath);
  const inheritProjectContext = parseStrictBoolean(
    frontmatter,
    "inheritProjectContext",
    localName === "delegate",
    filePath,
  );
  const inheritSkills = parseStrictBoolean(frontmatter, "inheritSkills", false, filePath);

  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FRONTMATTER_FIELDS.has(key)) extraFields[key] = value;
  }

  const agent: AgentConfig = {
    name: runtimeName,
    localName,
    packageName: PROJECT_AGENT_PACKAGE,
    description: frontmatter.description,
    tools,
    model: frontmatter.model,
    fallbackModels,
    thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
    systemPromptMode:
      systemPromptMode === "append"
        ? "append"
        : systemPromptMode === "replace"
          ? "replace"
          : localName === "delegate"
            ? "append"
            : "replace",
    inheritProjectContext,
    inheritSkills,
    defaultContext,
    acceptanceRole,
    systemPrompt: body,
    source: "project",
    filePath,
    skills,
    output: frontmatter.output,
    defaultReads,
    defaultProgress,
    interactive,
    maxSubagentDepth: parsedMaxSubagentDepth,
    completionGuard,
    toolBudget,
    maxExecutionTimeMs,
    extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
  };

  const digest = createHash("sha256").update(exactBytes).digest("hex");
  return { agent, digest, frontmatterFields };
}

/** Parse one exact definition byte sequence and derive all field metadata from those bytes. */
export function parseProjectAgentDefinition(
  filePath: string,
  content: string | Buffer,
): ProjectAgentSnapshotEntry {
  const bytes = bytesFromRead(content);
  return parseProjectAgentDefinitionFromText(filePath, parseUtf8(bytes), bytes);
}

function readCandidate(
  projectRoot: string,
  candidate: Candidate,
  options: {
    fileSystem: ProjectAgentLoaderFileSystem;
    maxFileBytes: number;
  },
):
  | { status: "valid"; entry: ProjectAgentSnapshotEntry }
  | { status: "invalid"; reason: string }
  | { status: "unstable"; reason: string } {
  const fileSystem = options.fileSystem;
  const validation = validateCandidatePath(projectRoot, candidate, fileSystem);
  if (!validation.valid) return { status: "invalid", reason: validation.reason };
  if (validation.stat.size > options.maxFileBytes) {
    return {
      status: "invalid",
      reason: `file size exceeds ${options.maxFileBytes} bytes`,
    };
  }

  const noFollow = fileSystem.noFollowFlag;
  if (typeof noFollow !== "number" || !Number.isSafeInteger(noFollow) || noFollow <= 0) {
    return {
      status: "invalid",
      reason: "the O_NOFOLLOW open flag is unavailable; refusing an unbound path read",
    };
  }
  if (
    typeof fileSystem.openSync !== "function" ||
    typeof fileSystem.fstatSync !== "function" ||
    typeof fileSystem.readSync !== "function" ||
    typeof fileSystem.closeSync !== "function"
  ) {
    return {
      status: "invalid",
      reason: "safe descriptor operations are unavailable; refusing to read the definition",
    };
  }

  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW protects the final component. Directory and containment
    // identities are rechecked before and after this descriptor is read.
    descriptor = fileSystem.openSync(candidate.filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
      return { status: "unstable", reason: "candidate changed before descriptor open" };
    }
    return { status: "invalid", reason: `file cannot be opened safely: ${errorMessage(error)}` };
  }

  try {
    const descriptorStat = fileSystem.fstatSync(descriptor);
    if (descriptorStat.isSymbolicLink() || !descriptorStat.isFile()) {
      return { status: "invalid", reason: "opened descriptor is not a regular file" };
    }
    const descriptorIdentity = fileIdentity(descriptorStat);
    if (!descriptorIdentity) {
      return { status: "invalid", reason: "opened file identity cannot be proven" };
    }
    if (!sameFileIdentity(validation.identity, descriptorIdentity)) {
      return { status: "unstable", reason: "opened descriptor identity changed" };
    }
    if (descriptorStat.size > options.maxFileBytes) {
      return {
        status: "invalid",
        reason: `file size exceeds ${options.maxFileBytes} bytes`,
      };
    }
    if (statSignature(descriptorStat) !== candidate.signature) {
      return { status: "unstable", reason: "candidate changed before reading" };
    }
    const beforeReadPath = validateCandidatePath(projectRoot, candidate, fileSystem);
    if (!beforeReadPath.valid) {
      return { status: "unstable", reason: beforeReadPath.reason };
    }
    if (!sameFileIdentity(beforeReadPath.identity, descriptorIdentity)) {
      return { status: "unstable", reason: "opened descriptor no longer matches candidate" };
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= options.maxFileBytes) {
      const remaining = options.maxFileBytes + 1 - bytesRead;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
      const count = fileSystem.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.byteLength) {
        return { status: "invalid", reason: "safe descriptor read returned an invalid byte count" };
      }
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
      if (bytesRead > options.maxFileBytes) {
        return {
          status: "invalid",
          reason: `file size exceeds ${options.maxFileBytes} bytes`,
        };
      }
    }
    const bytes = Buffer.concat(chunks, bytesRead);
    const afterReadStat = fileSystem.fstatSync(descriptor);
    if (
      !afterReadStat.isFile() ||
      !fileIdentity(afterReadStat) ||
      !sameFileIdentity(descriptorIdentity, fileIdentity(afterReadStat)!) ||
      statSignature(afterReadStat) !== candidate.signature
    ) {
      return { status: "unstable", reason: "candidate changed while being read" };
    }
    if (bytes.byteLength !== validation.stat.size) {
      return { status: "unstable", reason: "file size changed while reading" };
    }
    const afterReadPath = validateCandidatePath(projectRoot, candidate, fileSystem);
    if (!afterReadPath.valid) {
      return { status: "unstable", reason: afterReadPath.reason };
    }
    if (!sameFileIdentity(afterReadPath.identity, descriptorIdentity)) {
      return { status: "unstable", reason: "candidate path identity changed after reading" };
    }

    try {
      const entry = parseProjectAgentDefinitionFromText(
        candidate.filePath,
        parseUtf8(bytes),
        bytes,
      );
      return { status: "valid", entry };
    } catch (error) {
      return {
        status: "invalid",
        reason: error instanceof ProjectAgentDefinitionError ? error.message : errorMessage(error),
      };
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
      return { status: "unstable", reason: "candidate changed while being read" };
    }
    return { status: "invalid", reason: `file cannot be read safely: ${errorMessage(error)}` };
  } finally {
    try {
      fileSystem.closeSync(descriptor);
    } catch {
      // The candidate result is already determined; close is best effort.
    }
  }
}

function emptyScanResult(
  projectRoot: string,
  status: ProjectAgentDefinitionScanResult["status"],
  diagnostics: readonly string[] = [],
): ProjectAgentDefinitionScanResult {
  return {
    status,
    projectRoot,
    agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
    entries: [],
    tombstones: [],
    diagnostics,
    candidateCount: 0,
    totalBytes: 0,
  };
}

function scanProjectAgentsOnce(
  projectRoot: string,
  options: Required<
    Pick<
      ProjectAgentDefinitionScanOptions,
      "maxFileBytes" | "maxFiles" | "maxTotalBytes" | "maxDepth" | "maxDirectories"
    >
  > & {
    fileSystem: ProjectAgentLoaderFileSystem;
  },
): ProjectAgentDefinitionScanResult {
  const before = collectCandidateInventory(projectRoot, options);
  if (before.status !== "ok") {
    return emptyScanResult(projectRoot, before.status, before.diagnostics);
  }

  const basenameCounts = new Map<string, number>();
  const caseFoldedBasenameCounts = new Map<string, number>();
  for (const candidate of before.candidates) {
    basenameCounts.set(candidate.basename, (basenameCounts.get(candidate.basename) ?? 0) + 1);
    const caseFolded = candidate.basename.toLowerCase();
    caseFoldedBasenameCounts.set(caseFolded, (caseFoldedBasenameCounts.get(caseFolded) ?? 0) + 1);
  }

  const entries: ProjectAgentSnapshotEntry[] = [];
  const tombstones = new Set<string>();
  const diagnostics = [...before.diagnostics];
  let unstable = false;
  for (const candidate of before.candidates) {
    const runtimeName = runtimeNameForBasename(candidate.basename);
    if (!runtimeName) {
      diagnostics.push(`Ignoring invalid project-agent basename '${candidate.basename}'.`);
      continue;
    }
    if (
      (basenameCounts.get(candidate.basename) ?? 0) > 1 ||
      (caseFoldedBasenameCounts.get(candidate.basename.toLowerCase()) ?? 0) > 1
    ) {
      tombstones.add(runtimeName);
      diagnostics.push(
        `Case-insensitive duplicate project-agent basename '${candidate.basename}' fails closed.`,
      );
      continue;
    }

    const result = readCandidate(projectRoot, candidate, options);
    if (result.status === "unstable") {
      unstable = true;
      diagnostics.push(`${candidate.filePath}: ${result.reason}`);
      continue;
    }
    if (result.status === "invalid") {
      tombstones.add(runtimeName);
      diagnostics.push(`${candidate.filePath}: ${result.reason}`);
      continue;
    }
    entries.push(result.entry);
  }

  const after = collectCandidateInventory(projectRoot, options);
  if (unstable || after.status !== "ok" || !sameInventory(before, after)) {
    const instabilityDiagnostics =
      after.status === "ok"
        ? ["Project-agent candidate inventory changed during scan."]
        : after.diagnostics;
    return emptyScanResult(projectRoot, "unstable", [...diagnostics, ...instabilityDiagnostics]);
  }

  entries.sort((left, right) => left.agent.name.localeCompare(right.agent.name));
  const sortedTombstones = [...tombstones].sort((left, right) => left.localeCompare(right));
  return {
    status: "stable",
    projectRoot,
    agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
    entries,
    tombstones: sortedTombstones,
    diagnostics,
    candidateCount: before.candidates.length,
    totalBytes: before.totalBytes,
  };
}

/**
 * Scan only the canonical project's `.tlh/agents/custom` tree. This function assumes
 * its caller has already established trust; it never consults generic agent
 * scopes, project settings, packages, or configured directories.
 */
export function scanProjectAgentDefinitions(
  projectRoot: string,
  options: ProjectAgentDefinitionScanOptions = {},
): ProjectAgentDefinitionScanResult {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const canonicalRoot = resolveValidatedGitWorktreeRoot(projectRoot, { fileSystem });
  if (!canonicalRoot) {
    return emptyScanResult(projectRoot, "unavailable", [
      "Canonical project root is not a validated Git worktree.",
    ]);
  }
  try {
    const rootStat = fileSystem.lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !fileIdentity(rootStat)) {
      return emptyScanResult(projectRoot, "unavailable", [
        "Canonical project root is not a regular directory with a valid identity.",
      ]);
    }
  } catch (error) {
    return emptyScanResult(projectRoot, "unavailable", [
      `Unable to inspect canonical project root: ${errorMessage(error)}`,
    ]);
  }

  const scanOptions = {
    fileSystem,
    maxFileBytes: normalizeBound(options.maxFileBytes, MAX_PROJECT_AGENT_FILE_BYTES),
    maxFiles: normalizeBound(options.maxFiles, MAX_PROJECT_AGENT_FILES),
    maxTotalBytes: normalizeBound(options.maxTotalBytes, MAX_PROJECT_AGENT_TOTAL_BYTES),
    maxDepth: normalizeBound(options.maxDepth, MAX_PROJECT_AGENT_DEPTH),
    maxDirectories: normalizeBound(options.maxDirectories, MAX_PROJECT_AGENT_DIRECTORIES),
  };
  return scanProjectAgentsOnce(canonicalRoot, scanOptions);
}

function projectAgentDirectoryExists(
  projectRoot: string,
  fileSystem: ProjectAgentLoaderFileSystem,
): boolean {
  const tlh = inspectFixedDirectory(projectRoot, projectRoot, ".tlh", ".tlh", fileSystem);
  if (tlh.status === "missing") return false;
  if (tlh.status !== "present") return true;

  const agents = inspectFixedDirectory(
    projectRoot,
    tlh.snapshot.path,
    "agents",
    ".tlh/agents",
    fileSystem,
  );
  if (agents.status === "missing") return false;
  if (agents.status !== "present") return true;

  const custom = inspectFixedDirectory(
    projectRoot,
    agents.snapshot.path,
    "custom",
    ".tlh/agents/custom",
    fileSystem,
  );
  return custom.status !== "missing";
}

function registerLoadedProjectAgentSnapshot(
  projectRoot: string,
  options: ProjectAgentSnapshotLoadOptions,
  trust: ProjectAgentTrustResult,
  scan: ProjectAgentDefinitionScanResult,
): LoadedProjectAgentSnapshot {
  const generationId =
    typeof options.generationId === "string" && options.generationId.trim().length > 0
      ? options.generationId.trim()
      : randomUUID();
  const sessionId = options.sessionId.trim();
  const capability = registerProjectAgentSnapshot({
    projectRoot,
    sessionId,
    generationId,
    entries: scan.entries,
    tombstones: scan.tombstones,
  });
  // Resolve once through the provider and retain its immutable manifest. The
  // provider, not this loader, remains the authority for capability identity.
  const expected: ProjectAgentSnapshotExpected = getProjectAgentSnapshotProvenance(capability);
  const manifest = resolveProjectAgentSnapshot(capability, expected);
  return {
    status: "loaded",
    projectRoot,
    agentsDirectory: scan.agentsDirectory,
    capability,
    provenance: manifest.provenance,
    manifest,
    trust,
    scan,
    diagnostics: scan.diagnostics,
  };
}

function mergeTrustOptions(options: ProjectAgentSnapshotLoadOptions): ProjectAgentTrustOptions {
  return {
    ...options.trust,
    agentDir: options.trust?.agentDir ?? options.agentDir,
    trustOverride: options.trust?.trustOverride ?? options.trustOverride,
    createProjectTrustStore:
      options.trust?.createProjectTrustStore ?? options.trustDependencies?.createProjectTrustStore,
  };
}

/**
 * Resolve trust, scan stable bytes, and register one immutable generation.
 * Failed trust, unstable scans, and bound violations never register partial data.
 */
export async function loadProjectAgentSnapshot(
  options: ProjectAgentSnapshotLoadOptions,
): Promise<LoadedProjectAgentSnapshot> {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const projectRoot = resolveCanonicalGitWorktreeRoot(options.cwd, {
    git: options.git,
    fileSystem,
  });
  if (!projectRoot) {
    return {
      status: "unavailable",
      diagnostics: ["Current directory is not inside a canonical Git worktree."],
    };
  }
  if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
    return {
      status: "unavailable",
      projectRoot,
      diagnostics: ["Session identity is unavailable; project-agent loading is disabled."],
    };
  }

  const trustOptions = mergeTrustOptions(options);
  const projectAgentDirectoryPresent = projectAgentDirectoryExists(projectRoot, fileSystem);
  if (!projectAgentDirectoryPresent && trustOptions.trustOverride !== false) {
    // The existence probe is intentionally the last filesystem operation for
    // this load. An absent inventory grants no executable authority; if the
    // directory appears later, it stays inactive until a later load captures
    // a new generation after the persisted-trust check.
    const trust = {
      kind: "project-agent",
      trusted: true,
      source: "no-project-agents",
    } satisfies ProjectAgentTrustResult;
    return registerLoadedProjectAgentSnapshot(
      projectRoot,
      options,
      trust,
      emptyScanResult(projectRoot, "stable"),
    );
  }
  if (
    typeof trustOptions.createProjectTrustStore !== "function" &&
    !isUsableTrustStore(trustOptions.trustStore)
  ) {
    return {
      status: "unavailable",
      projectRoot,
      agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
      diagnostics: ["Project-agent trust dependencies are unavailable; loading is disabled."],
    };
  }

  const trust = await resolveProjectAgentTrust(projectRoot, trustOptions);
  if (!trust.trusted) {
    return {
      status: "denied",
      projectRoot,
      agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
      trust,
      diagnostics: [`Project-agent loading denied (${trust.source}).`],
    };
  }

  const scanOptions: ProjectAgentDefinitionScanOptions = {
    fileSystem,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
    maxTotalBytes: options.maxTotalBytes,
    maxDepth: options.maxDepth,
    maxDirectories: options.maxDirectories,
  };
  const maxAttempts = normalizeAttempts(options.maxAttempts);
  let scan: ProjectAgentDefinitionScanResult = emptyScanResult(projectRoot, "unstable");
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    scan = scanProjectAgentDefinitions(projectRoot, scanOptions);
    if (scan.status !== "unstable") break;
  }
  if (scan.status !== "stable") {
    return {
      status: scan.status,
      projectRoot,
      agentsDirectory: scan.agentsDirectory,
      trust,
      scan,
      diagnostics: scan.diagnostics,
    };
  }

  return registerLoadedProjectAgentSnapshot(projectRoot, options, trust, scan);
}
