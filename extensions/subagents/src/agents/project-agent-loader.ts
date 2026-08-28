import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
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
export const PROJECT_AGENT_DIRECTORY = path.join(".tlh", "agents");
export const PROJECT_AGENT_PACKAGE = "embedded";

/** Bounds are deliberately finite because this loader runs before project code is trusted. */
export const MAX_PROJECT_AGENT_FILE_BYTES = 512 * 1024;
/** The dedicated trust prompt must not hold session_start open indefinitely. */
export const PROJECT_AGENT_TRUST_UI_TIMEOUT_MS = 60_000;
export const MAX_PROJECT_AGENT_FILES = 128;
export const MAX_PROJECT_AGENT_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_AGENT_DEPTH = 16;
export const MAX_PROJECT_AGENT_DIRECTORIES = 256;
export const MAX_PROJECT_AGENT_SCAN_ATTEMPTS = 3;

const PROJECT_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
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

export interface ProjectAgentLoaderFileSystem {
  lstatSync(filePath: string): fs.Stats;
  /** Follows a symlink only to classify its target; never reads target contents. */
  statSync?: (filePath: string) => fs.Stats;
  readdirSync(filePath: string, options: { withFileTypes: true }): fs.Dirent[];
  realpathSync(filePath: string): string;
  readFileSync(filePath: string): string | Buffer;
}

const DEFAULT_FILE_SYSTEM: ProjectAgentLoaderFileSystem = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  statSync: (filePath) => fs.statSync(filePath),
  readdirSync: (filePath, options) => fs.readdirSync(filePath, options) as fs.Dirent[],
  realpathSync: (filePath) => fs.realpathSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath),
};

export interface ProjectAgentGit {
  showToplevel(cwd: string): string | undefined;
}

const SESSION_TRUST_DECISIONS = new Map<string, boolean>();

const DEFAULT_GIT: ProjectAgentGit = {
  showToplevel(cwd): string | undefined {
    try {
      const output = execFileSync(
        "git",
        ["-C", path.resolve(cwd), "rev-parse", "--show-toplevel"],
        {
          encoding: "utf-8",
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
        },
      );
      const root = output.trim();
      return root || undefined;
    } catch {
      return undefined;
    }
  },
};

export interface ProjectAgentTrustStore {
  getEntry?(cwd: string): { path: string; decision: boolean } | null;
  get?(cwd: string): boolean | null;
}

/**
 * Host-owned trust services. The generated native loader receives these from
 * primary-agent-runtime.ts rather than importing the peer-only Pi package.
 */
export interface ProjectAgentTrustDependencies {
  createProjectTrustStore: (agentDir: string) => ProjectAgentTrustStore;
  hasTrustRequiringProjectResources: (cwd: string) => boolean;
}

export interface ProjectAgentTrustUI {
  confirm(
    title: string,
    message: string,
    options?: ExtensionUIDialogOptions,
  ): Promise<boolean> | boolean;
}

/** Injectable inputs for the trust matrix; no project definition content is exposed here. */
export interface ProjectAgentTrustOptions {
  /** Session identity scopes a session-only interactive decision. */
  sessionId?: string;
  agentDir?: string;
  trustStore?: ProjectAgentTrustStore;
  /** Only false is a denial override; true does not bypass the trust matrix. */
  trustOverride?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  isProjectTrusted?: () => boolean;
  hasUI?: boolean;
  /** Injectable override for tests; production uses PROJECT_AGENT_TRUST_UI_TIMEOUT_MS. */
  trustUiTimeoutMs?: number;
  confirm?: (projectRoot: string) => Promise<boolean> | boolean;
  ui?: ProjectAgentTrustUI;
  createProjectTrustStore?: (agentDir: string) => ProjectAgentTrustStore;
  hasTrustRequiringProjectResources?: (cwd: string) => boolean;
}

export type ProjectAgentTrustSource =
  | "explicit-negative"
  | "saved-positive"
  | "saved-negative"
  | "upstream-positive"
  | "default-always"
  | "default-never"
  | "session-positive"
  | "session-negative"
  | "session-unavailable"
  | "trust-store-error"
  | "no-project-agents";

export interface ProjectAgentTrustResult {
  readonly trusted: boolean;
  readonly source: ProjectAgentTrustSource;
}

export interface ProjectAgentSnapshotTrustContext {
  isProjectTrusted?: () => boolean;
  hasUI?: boolean;
  ui?: ProjectAgentTrustUI;
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
  defaultProjectTrust?: "ask" | "always" | "never";
  context?: ProjectAgentSnapshotTrustContext;
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
  if (!PROJECT_AGENT_NAME_PATTERN.test(basename)) return undefined;
  const runtimeName = buildRuntimeName(basename, PROJECT_AGENT_PACKAGE);
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

function canonicalRootFromGit(
  cwd: string,
  git: ProjectAgentGit,
  fileSystem: ProjectAgentLoaderFileSystem,
): string | undefined {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return undefined;
  let reportedRoot: string | undefined;
  try {
    reportedRoot = git.showToplevel(cwd);
  } catch {
    return undefined;
  }
  if (!reportedRoot || reportedRoot.trim().length === 0) return undefined;

  try {
    const resolvedReportedRoot = path.resolve(cwd, reportedRoot.trim());
    const canonicalRoot = fileSystem.realpathSync(resolvedReportedRoot);
    const stat = fileSystem.lstatSync(canonicalRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    return canonicalRoot;
  } catch {
    return undefined;
  }
}

/** Resolve the session's project identity without trusting a caller-supplied project path. */
export function resolveCanonicalGitWorktreeRoot(
  cwd: string,
  options: {
    git?: ProjectAgentGit;
    fileSystem?: ProjectAgentLoaderFileSystem;
  } = {},
): string | undefined {
  return canonicalRootFromGit(
    cwd,
    options.git ?? DEFAULT_GIT,
    options.fileSystem ?? DEFAULT_FILE_SYSTEM,
  );
}

function trustEntryPathApplies(entryPath: string, projectRoot: string): boolean {
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) return false;
  try {
    const canonicalEntryPath = fs.realpathSync(entryPath);
    const canonicalProjectRoot = fs.realpathSync(projectRoot);
    return isPathWithin(canonicalEntryPath, canonicalProjectRoot);
  } catch {
    // Trust entries can name a not-yet-existing ancestor. Keep the same
    // lexical containment check used by upstream's normalized trust store.
    try {
      return isPathWithin(path.resolve(entryPath), path.resolve(projectRoot));
    } catch {
      return false;
    }
  }
}

function isUsableTrustStore(value: unknown): value is ProjectAgentTrustStore {
  try {
    return (
      Boolean(value) &&
      typeof value === "object" &&
      (typeof (value as ProjectAgentTrustStore).getEntry === "function" ||
        typeof (value as ProjectAgentTrustStore).get === "function")
    );
  } catch {
    return false;
  }
}

function defaultTrustStore(options: ProjectAgentTrustOptions): ProjectAgentTrustStore {
  if (options.trustStore) {
    if (!isUsableTrustStore(options.trustStore)) {
      throw new Error("Project trust-store dependency returned an invalid store.");
    }
    return options.trustStore;
  }
  const agentDir = options.agentDir ?? getAgentDir();
  // The host-owned trust-store implementation acquires a lock even for reads
  // and therefore creates its parent directory. Avoid that write when no
  // saved trust can exist. A present trust file without the injected host
  // factory is an unavailable dependency, not permission to prompt/fallback.
  if (!fs.existsSync(path.join(agentDir, "trust.json"))) return {};
  if (typeof options.createProjectTrustStore !== "function") {
    throw new Error("Project trust-store dependency is unavailable.");
  }
  const store = options.createProjectTrustStore(agentDir);
  if (!isUsableTrustStore(store)) {
    throw new Error("Project trust-store dependency returned an invalid store.");
  }
  return store;
}

function resolveTrustUiTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : PROJECT_AGENT_TRUST_UI_TIMEOUT_MS;
}

/**
 * Pi dialogs honor the timeout option, but keep a local deadline as well so a
 * broken UI/RPC implementation cannot leave session_start waiting forever.
 */
function waitForTrustDecision(
  decision: Promise<boolean> | boolean | undefined,
  timeoutMs: number,
): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    Promise.resolve(decision)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
  });
}

/**
 * Resolve trust for the canonical worktree. In particular, a true
 * ctx.isProjectTrusted() is ignored when upstream did not observe any of its
 * own trust-requiring resources; `.tlh/agents` is intentionally outside that
 * upstream resource inventory.
 */
export async function resolveProjectAgentTrust(
  projectRoot: string,
  options: ProjectAgentTrustOptions = {},
): Promise<ProjectAgentTrustResult> {
  if (options.trustOverride === false) {
    return { trusted: false, source: "explicit-negative" };
  }
  let store: ProjectAgentTrustStore;
  try {
    store = defaultTrustStore(options);
    if (store.getEntry) {
      const entry = store.getEntry(projectRoot);
      if (entry !== null && typeof entry !== "object") {
        return { trusted: false, source: "trust-store-error" };
      }
      if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
        return { trusted: false, source: "trust-store-error" };
      }
      if (entry && trustEntryPathApplies(entry.path, projectRoot)) {
        return entry.decision
          ? { trusted: true, source: "saved-positive" }
          : { trusted: false, source: "saved-negative" };
      }
    } else if (store.get) {
      const decision = store.get(projectRoot);
      if (decision === true) return { trusted: true, source: "saved-positive" };
      if (decision === false) return { trusted: false, source: "saved-negative" };
      if (decision !== null && decision !== undefined) {
        return { trusted: false, source: "trust-store-error" };
      }
    }
  } catch {
    return { trusted: false, source: "trust-store-error" };
  }

  const hasTrustResources = (() => {
    if (typeof options.hasTrustRequiringProjectResources !== "function") return false;
    try {
      return options.hasTrustRequiringProjectResources(projectRoot);
    } catch {
      return false;
    }
  })();

  try {
    const upstreamDecision = options.isProjectTrusted?.();
    if (upstreamDecision === false) {
      // A negative upstream provenance signal is always a denial, including
      // when upstream did not observe any of its own trust-requiring files.
      return { trusted: false, source: "explicit-negative" };
    }
    if (hasTrustResources && upstreamDecision === true) {
      return { trusted: true, source: "upstream-positive" };
    }
  } catch {
    // A broken upstream context is not positive trust; continue conservatively.
  }

  const sessionKey =
    typeof options.sessionId === "string" && options.sessionId.trim().length > 0
      ? `${options.sessionId.trim()}\u0000${path.resolve(projectRoot)}`
      : undefined;
  const cachedSessionDecision = sessionKey ? SESSION_TRUST_DECISIONS.get(sessionKey) : undefined;
  if (cachedSessionDecision !== undefined) {
    return cachedSessionDecision
      ? { trusted: true, source: "session-positive" }
      : { trusted: false, source: "session-negative" };
  }

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return { trusted: true, source: "default-always" };
    case "never":
      return { trusted: false, source: "default-never" };
    case "ask":
      break;
  }

  if (options.hasUI === false) {
    return { trusted: false, source: "session-unavailable" };
  }

  try {
    const timeoutMs = resolveTrustUiTimeoutMs(options.trustUiTimeoutMs);
    const trusted = await waitForTrustDecision(
      options.confirm
        ? options.confirm(projectRoot)
        : options.ui
          ? options.ui.confirm(
              "Trust project-local TLH agents?",
              `This allows repository-owned agent definitions under ${path.join(projectRoot, PROJECT_AGENT_DIRECTORY)} to be loaded for this session only.`,
              { timeout: timeoutMs },
            )
          : undefined,
      timeoutMs,
    );
    if (trusted === true || trusted === false) {
      if (sessionKey) {
        SESSION_TRUST_DECISIONS.set(sessionKey, trusted);
        if (SESSION_TRUST_DECISIONS.size > 128) {
          const oldestKey = SESSION_TRUST_DECISIONS.keys().next().value;
          if (oldestKey) SESSION_TRUST_DECISIONS.delete(oldestKey);
        }
      }
      return trusted
        ? { trusted: true, source: "session-positive" }
        : { trusted: false, source: "session-negative" };
    }
  } catch {
    return { trusted: false, source: "session-unavailable" };
  }
  return { trusted: false, source: "session-unavailable" };
}

interface Candidate {
  readonly filePath: string;
  readonly relativePath: string;
  readonly basename: string;
  readonly signature: string;
  readonly stat: fs.Stats;
  readonly regular: boolean;
  readonly symlink: boolean;
}

interface CandidateInventory {
  readonly status: "ok" | "unstable" | "unavailable" | "bounded";
  readonly candidates: readonly Candidate[];
  readonly diagnostics: readonly string[];
  readonly totalBytes: number;
}

function pathParts(relativePath: string): string[] {
  return relativePath.split(path.sep).filter((part) => part.length > 0 && part !== ".");
}

function symlinkTargetIsDirectory(
  filePath: string,
  fileSystem: ProjectAgentLoaderFileSystem,
): boolean | undefined {
  if (!fileSystem.statSync) return undefined;
  try {
    return fileSystem.statSync(filePath).isDirectory();
  } catch {
    return undefined;
  }
}

function inspectCandidate(
  projectRoot: string,
  agentsDirectory: string,
  filePath: string,
  fileName: string,
  stat: fs.Stats,
  fileSystem: ProjectAgentLoaderFileSystem,
): Candidate {
  const relativePath = path.relative(agentsDirectory, filePath);
  const regular = stat.isFile() && !stat.isSymbolicLink();
  const symlink = stat.isSymbolicLink();
  if (!symlink && regular) {
    try {
      const canonicalFilePath = fileSystem.realpathSync(filePath);
      if (!isPathWithin(projectRoot, canonicalFilePath)) {
        return {
          filePath,
          relativePath,
          basename: candidateBasename(fileName),
          signature: statSignature(stat),
          stat,
          regular: false,
          symlink: true,
        };
      }
    } catch {
      // The candidate will fail closed when its bytes are considered.
    }
  }
  return {
    filePath,
    relativePath,
    basename: candidateBasename(fileName),
    signature: statSignature(stat),
    stat,
    regular,
    symlink,
  };
}

function collectCandidateInventory(
  projectRoot: string,
  options: Required<
    Pick<
      ProjectAgentDefinitionScanOptions,
      "maxFiles" | "maxDepth" | "maxTotalBytes" | "maxDirectories"
    >
  > & {
    fileSystem: ProjectAgentLoaderFileSystem;
  },
): CandidateInventory {
  const agentsDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
  const candidates: Candidate[] = [];
  const diagnostics: string[] = [];
  let totalBytes = 0;
  let directoryCount = 0;
  let status: CandidateInventory["status"] = "ok";

  // Check each fixed component independently. lstat on the final path would
  // follow a symlink in `.tlh`, which would make the accepted tree broader than
  // the repository-owned path promised by this loader.
  let tlhDirectoryStat: fs.Stats;
  try {
    tlhDirectoryStat = options.fileSystem.lstatSync(path.join(projectRoot, ".tlh"));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { status: "ok", candidates: [], diagnostics: [], totalBytes: 0 };
    }
    return {
      status: "unavailable",
      candidates: [],
      diagnostics: [
        `Unable to inspect project-agent directory '${agentsDirectory}': ${errorMessage(error)}`,
      ],
      totalBytes: 0,
    };
  }
  if (tlhDirectoryStat.isSymbolicLink() || !tlhDirectoryStat.isDirectory()) {
    return {
      status: "unavailable",
      candidates: [],
      diagnostics: [
        `Project-agent directory component is not a regular directory: ${path.join(projectRoot, ".tlh")}`,
      ],
      totalBytes: 0,
    };
  }

  const walk = (directory: string, depth: number): void => {
    if (status !== "ok") return;
    let directoryStat: fs.Stats;
    try {
      directoryStat = options.fileSystem.lstatSync(directory);
    } catch (error) {
      status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
      diagnostics.push(
        `Unable to inspect project-agent directory '${directory}': ${errorMessage(error)}`,
      );
      return;
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      status = "unavailable";
      diagnostics.push(
        `Project-agent directory component is not a regular directory: ${directory}`,
      );
      return;
    }
    if (depth > options.maxDepth) {
      status = "bounded";
      diagnostics.push(`Project-agent directory depth exceeds ${options.maxDepth}: ${directory}`);
      return;
    }
    directoryCount += 1;
    if (directoryCount > options.maxDirectories) {
      status = "bounded";
      diagnostics.push(`Project-agent directory count exceeds ${options.maxDirectories}.`);
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = options.fileSystem
        .readdirSync(directory, { withFileTypes: true })
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
      diagnostics.push(
        `Unable to enumerate project-agent directory '${directory}': ${errorMessage(error)}`,
      );
      return;
    }

    for (const entry of entries) {
      if (status !== "ok") return;
      const filePath = path.join(directory, entry.name);
      let stat: fs.Stats;
      try {
        // lstat is intentional: neither directory traversal nor candidate discovery follows links.
        stat = options.fileSystem.lstatSync(filePath);
      } catch (error) {
        status = isErrno(error, "ENOENT") ? "unstable" : "unavailable";
        diagnostics.push(
          `Unable to inspect project-agent path '${filePath}': ${errorMessage(error)}`,
        );
        return;
      }

      if (stat.isSymbolicLink()) {
        const targetIsDirectory = symlinkTargetIsDirectory(filePath, options.fileSystem);
        if (targetIsDirectory !== false) {
          status = "unavailable";
          diagnostics.push(`Symlinked project-agent directory/path is not allowed: ${filePath}`);
          return;
        }
        if (!isDefinitionFile(entry.name)) continue;
      }

      if (isDefinitionFile(entry.name)) {
        // A same-name directory, FIFO, or symlink to a regular file is still
        // an invalid candidate. Keep its basename so it can tombstone profile fallback.
        const candidate = inspectCandidate(
          projectRoot,
          agentsDirectory,
          filePath,
          entry.name,
          stat,
          options.fileSystem,
        );
        candidates.push(candidate);
        totalBytes += candidate.stat.size;
        if (candidates.length > options.maxFiles || totalBytes > options.maxTotalBytes) {
          status = "bounded";
          diagnostics.push(
            candidates.length > options.maxFiles
              ? `Project-agent file count exceeds ${options.maxFiles}.`
              : `Project-agent byte count exceeds ${options.maxTotalBytes}.`,
          );
          return;
        }
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(filePath, depth + 1);
        continue;
      }
    }
  };

  let agentsStat: fs.Stats;
  try {
    agentsStat = options.fileSystem.lstatSync(agentsDirectory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        status: "ok",
        candidates: [],
        diagnostics: [],
        totalBytes: 0,
      };
    }
    return {
      status: "unavailable",
      diagnostics: [
        `Unable to inspect project-agent directory '${agentsDirectory}': ${errorMessage(error)}`,
      ],
      candidates: [],
      totalBytes: 0,
    };
  }
  if (agentsStat.isSymbolicLink() || !agentsStat.isDirectory()) {
    return {
      status: "unavailable",
      candidates: [],
      diagnostics: [`Project-agent directory is not a regular directory: ${agentsDirectory}`],
      totalBytes: 0,
    };
  }

  walk(agentsDirectory, 0);
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { status, candidates, diagnostics, totalBytes };
}

function sameInventory(left: CandidateInventory, right: CandidateInventory): boolean {
  if (left.status !== "ok" || right.status !== "ok") return false;
  if (left.candidates.length !== right.candidates.length) return false;
  return left.candidates.every((candidate, index) => {
    const other = right.candidates[index];
    return (
      other !== undefined &&
      candidate.relativePath === other.relativePath &&
      candidate.signature === other.signature &&
      candidate.regular === other.regular &&
      candidate.symlink === other.symlink
    );
  });
}

function validateCandidatePath(
  projectRoot: string,
  candidate: Candidate,
  fileSystem: ProjectAgentLoaderFileSystem,
): { valid: true; canonicalPath: string; stat: fs.Stats } | { valid: false; reason: string } {
  if (!candidate.regular || candidate.symlink) {
    return { valid: false, reason: "candidate is not a regular non-symlink file" };
  }
  const relative = path.relative(projectRoot, candidate.filePath);
  if (!isPathWithin(projectRoot, candidate.filePath) || relative === "") {
    return { valid: false, reason: "candidate is outside the canonical project root" };
  }
  const parts = pathParts(relative);
  if (parts.length < 1) return { valid: false, reason: "candidate path is empty" };

  let current = projectRoot;
  for (const component of parts.slice(0, -1)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fileSystem.lstatSync(current);
    } catch (error) {
      return { valid: false, reason: `path component cannot be inspected: ${errorMessage(error)}` };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { valid: false, reason: "path component is not a regular non-symlink directory" };
    }
  }

  let stat: fs.Stats;
  try {
    stat = fileSystem.lstatSync(candidate.filePath);
  } catch (error) {
    return { valid: false, reason: `file cannot be inspected: ${errorMessage(error)}` };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { valid: false, reason: "candidate is not a regular non-symlink file" };
  }
  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpathSync(candidate.filePath);
  } catch (error) {
    return { valid: false, reason: `file cannot be canonicalized: ${errorMessage(error)}` };
  }
  if (!isPathWithin(projectRoot, canonicalPath)) {
    return { valid: false, reason: "canonical file path is outside the project root" };
  }
  return { valid: true, canonicalPath, stat };
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

  if (!PROJECT_AGENT_NAME_PATTERN.test(basename)) {
    throw new ProjectAgentDefinitionError(filePath, "file basename is not a valid agent name");
  }
  if (frontmatter.name !== basename) {
    throw new ProjectAgentDefinitionError(
      filePath,
      `frontmatter name must exactly equal file basename '${basename}'`,
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

  const runtimeName = buildRuntimeName(basename, PROJECT_AGENT_PACKAGE);
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
    basename === "delegate",
    filePath,
  );
  const inheritSkills = parseStrictBoolean(frontmatter, "inheritSkills", false, filePath);

  const extraFields: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FRONTMATTER_FIELDS.has(key)) extraFields[key] = value;
  }

  const agent: AgentConfig = {
    name: runtimeName,
    localName: basename,
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
          : basename === "delegate"
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
  const validation = validateCandidatePath(projectRoot, candidate, options.fileSystem);
  if (!validation.valid) return { status: "invalid", reason: validation.reason };
  if (validation.stat.size > options.maxFileBytes) {
    return {
      status: "invalid",
      reason: `file size exceeds ${options.maxFileBytes} bytes`,
    };
  }
  if (statSignature(validation.stat) !== candidate.signature) {
    return { status: "unstable", reason: "candidate changed before reading" };
  }

  let raw: string | Buffer;
  try {
    // This is the sole content read for a candidate in one scan attempt.
    raw = options.fileSystem.readFileSync(validation.canonicalPath);
  } catch (error) {
    let current: fs.Stats | undefined;
    try {
      current = options.fileSystem.lstatSync(candidate.filePath);
    } catch {
      return { status: "unstable", reason: "candidate disappeared while reading" };
    }
    return statSignature(current) === candidate.signature
      ? { status: "invalid", reason: `file cannot be read: ${errorMessage(error)}` }
      : { status: "unstable", reason: "candidate changed while reading" };
  }

  const bytes = bytesFromRead(raw);
  if (bytes.byteLength !== validation.stat.size) {
    return { status: "unstable", reason: "file size changed while reading" };
  }

  let afterRead: fs.Stats;
  try {
    afterRead = options.fileSystem.lstatSync(candidate.filePath);
  } catch {
    return { status: "unstable", reason: "candidate disappeared after reading" };
  }
  if (statSignature(afterRead) !== candidate.signature) {
    return { status: "unstable", reason: "candidate changed after reading" };
  }

  try {
    const entry = parseProjectAgentDefinitionFromText(candidate.filePath, parseUtf8(bytes), bytes);
    return { status: "valid", entry };
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof ProjectAgentDefinitionError ? error.message : errorMessage(error),
    };
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
  for (const candidate of before.candidates) {
    basenameCounts.set(candidate.basename, (basenameCounts.get(candidate.basename) ?? 0) + 1);
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
    if ((basenameCounts.get(candidate.basename) ?? 0) > 1) {
      tombstones.add(runtimeName);
      diagnostics.push(`Duplicate project-agent basename '${candidate.basename}' fails closed.`);
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
 * Scan only the canonical project's `.tlh/agents` tree. This function assumes
 * its caller has already established trust; it never consults generic agent
 * scopes, project settings, packages, or configured directories.
 */
export function scanProjectAgentDefinitions(
  projectRoot: string,
  options: ProjectAgentDefinitionScanOptions = {},
): ProjectAgentDefinitionScanResult {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  let canonicalRoot: string;
  try {
    canonicalRoot = fileSystem.realpathSync(projectRoot);
    const rootStat = fileSystem.lstatSync(canonicalRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return emptyScanResult(projectRoot, "unavailable", [
        "Canonical project root is not a regular directory.",
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
  const tlhDirectory = path.join(projectRoot, ".tlh");
  const agentsDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
  try {
    const tlhStat = fileSystem.lstatSync(tlhDirectory);
    if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) return true;
    fileSystem.lstatSync(agentsDirectory);
    return true;
  } catch (error) {
    return !isErrno(error, "ENOENT");
  }
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
    sessionId: options.trust?.sessionId ?? options.sessionId,
    agentDir: options.trust?.agentDir ?? options.agentDir,
    trustOverride: options.trust?.trustOverride ?? options.trustOverride,
    defaultProjectTrust: options.trust?.defaultProjectTrust ?? options.defaultProjectTrust,
    isProjectTrusted: options.trust?.isProjectTrusted ?? options.context?.isProjectTrusted,
    hasUI: options.trust?.hasUI ?? options.context?.hasUI,
    ui: options.trust?.ui ?? options.context?.ui,
    createProjectTrustStore:
      options.trust?.createProjectTrustStore ?? options.trustDependencies?.createProjectTrustStore,
    hasTrustRequiringProjectResources:
      options.trust?.hasTrustRequiringProjectResources ??
      options.trustDependencies?.hasTrustRequiringProjectResources,
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
  if (
    typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
    (typeof trustOptions.createProjectTrustStore !== "function" &&
      !isUsableTrustStore(trustOptions.trustStore))
  ) {
    return {
      status: "unavailable",
      projectRoot,
      agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
      diagnostics: ["Project-agent trust dependencies are unavailable; loading is disabled."],
    };
  }
  const projectAgentDirectoryPresent = projectAgentDirectoryExists(projectRoot, fileSystem);
  if (!projectAgentDirectoryPresent && trustOptions.trustOverride !== false) {
    // A negative upstream trust signal is authoritative even when the
    // project has no trust-requiring files known to upstream. Keep the
    // no-directory fast path only for neutral/positive provenance; positive
    // trust remains conditional because .tlh/agents is outside that inventory.
    let upstreamDenied = false;
    try {
      upstreamDenied = trustOptions.isProjectTrusted?.() === false;
    } catch {
      upstreamDenied = false;
    }
    if (upstreamDenied) {
      const trust = {
        trusted: false,
        source: "explicit-negative",
      } satisfies ProjectAgentTrustResult;
      return {
        status: "denied",
        projectRoot,
        agentsDirectory: path.join(projectRoot, PROJECT_AGENT_DIRECTORY),
        trust,
        diagnostics: [`Project-agent loading denied (${trust.source}).`],
      };
    }

    // The existence probe is intentionally the last filesystem operation for
    // this load. If the directory appears after this point, it stays inactive
    // until a later load establishes trust and captures a new generation.
    const trust = {
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
