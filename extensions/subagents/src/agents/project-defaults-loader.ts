import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveValidatedGitWorktreeRoot,
  type ValidatedWorktreeFileSystem,
} from "../../../shared/project-agent-worktree.js";
import { getPiAgentDir } from "../shared/profile.ts";

/** Path relative to the canonical Git worktree root. */
export const PROJECT_DEFAULTS_FILE = path.join(".tlh", "defaults.json");
const PROJECT_DEFAULTS_WARNING_FILE = ".tlh/defaults.json";

/** Deliberate finite bound; loaded before project code is trusted. */
export const MAX_PROJECT_DEFAULTS_FILE_BYTES = 64 * 1024;

/** Maximum number of distinct validation warnings retained for one load. */
export const MAX_PROJECT_DEFAULT_WARNINGS = 20;

/** Maximum UTF-16 code units retained in one validation warning. */
export const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;

/** Configuration trust prompts are bounded so a broken UI cannot block startup forever. */
const PROJECT_CONFIG_TRUST_UI_TIMEOUT_MS = 10_000;
const PROJECT_CONFIG_TRUST_SESSION_CACHE_LIMIT = 128;

// This cache belongs exclusively to the project-configuration plane. The
// plane tag is part of every key as a belt-and-braces guard against future
// cache sharing with executable custom-agent trust.
const PROJECT_CONFIG_SESSION_TRUST_DECISIONS = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type PrimaryAgentName = "architect" | "rush" | "product" | "bug-hunter";

export type SubagentRoleName =
  | "code-reviewer"
  | "contrarian"
  | "developer"
  | "diff-summarizer"
  | "librarian"
  | "oracle"
  | "repo-scout"
  | "web-scout";

export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Per-agent/role overrides. Both fields are optional but at least one must be present. */
export interface ProjectDefaultsEntry {
  readonly model?: string;
  readonly effort?: EffortLevel;
}

/** Parsed and validated contents of .tlh/defaults.json. */
export interface ProjectDefaults {
  readonly primaryAgents: Readonly<Partial<Record<PrimaryAgentName, ProjectDefaultsEntry>>>;
  readonly subagents: Readonly<Partial<Record<SubagentRoleName, ProjectDefaultsEntry>>>;
}

/**
 * Sources for the project-configuration trust decision. This is deliberately
 * separate from the execution-plane project-agent trust source union.
 */
export type ProjectConfigTrustSource =
  | "explicit-negative"
  | "saved-positive"
  | "saved-negative"
  | "upstream-positive"
  | "default-always"
  | "default-never"
  | "session-positive"
  | "session-negative"
  | "session-unavailable"
  | "trust-store-error";

/** Nominal project-configuration trust result; never authorizes custom agents. */
export interface ProjectConfigTrustResult {
  readonly kind: "project-config";
  readonly trusted: boolean;
  readonly source: ProjectConfigTrustSource;
}

export interface ProjectConfigTrustStore {
  /** Return the nearest persisted entry so its source path can be verified. */
  getEntry(cwd: string): { path: string; decision: boolean } | null;
}

export interface ProjectConfigTrustUI {
  confirm(
    title: string,
    message: string,
    options?: { timeout?: number },
  ): Promise<boolean> | boolean;
}

/** Host-owned inputs for the project-configuration trust policy. */
export interface ProjectConfigTrustOptions {
  /** Session identity scopes a session-only configuration approval. */
  sessionId?: string;
  agentDir?: string;
  trustStore?: ProjectConfigTrustStore;
  /** Only false is a denial override; positive values do not bypass the policy. */
  trustOverride?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  isProjectTrusted?: () => boolean;
  hasTrustRequiringProjectResources?: (cwd: string) => boolean;
  hasUI?: boolean;
  trustUiTimeoutMs?: number;
  confirm?: (projectRoot: string) => Promise<boolean> | boolean;
  ui?: ProjectConfigTrustUI;
  createProjectTrustStore?: (agentDir: string) => ProjectConfigTrustStore;
}

/** Filesystem operations needed after the validated worktree root is known. */
export interface ProjectDefaultsLoaderFileSystem extends ValidatedWorktreeFileSystem {
  /** Descriptor operations are mandatory for trusted defaults reads. */
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

/** Result returned by loadProjectDefaults for later consumption by runtime and dispatch. */
export interface ProjectDefaultsLoadResult {
  readonly status: "loaded" | "denied" | "unavailable";
  readonly projectRoot?: string;
  readonly defaults?: ProjectDefaults;
  readonly trust?: ProjectConfigTrustResult;
  /** Per-entry parse/validation warnings. Present even when status is "loaded". */
  readonly warnings: readonly string[];
}

/** Injectable options for loadProjectDefaults. */
export interface ProjectDefaultsLoadOptions {
  /** Working directory used to resolve the canonical validated Git worktree root. */
  cwd: string;
  sessionId?: string;
  agentDir?: string;
  trustOverride?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  /** Project-configuration trust options; never shared with custom-agent trust. */
  trust?: ProjectConfigTrustOptions;
  fileSystem?: ProjectDefaultsLoaderFileSystem;
  /** Override the default file-size limit. Must be a positive safe integer. */
  maxFileBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PRIMARY_AGENTS = new Set<PrimaryAgentName>([
  "architect",
  "rush",
  "product",
  "bug-hunter",
]);

const VALID_SUBAGENT_ROLES = new Set<SubagentRoleName>([
  "code-reviewer",
  "contrarian",
  "developer",
  "diff-summarizer",
  "librarian",
  "oracle",
  "repo-scout",
  "web-scout",
]);

const VALID_EFFORT_LEVELS = new Set<EffortLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const VALID_ENTRY_KEYS = new Set(["model", "effort"]);

const DEFAULT_FILE_SYSTEM: ProjectDefaultsLoaderFileSystem = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  realpathSync: (filePath) => fs.realpathSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath),
  openSync: (filePath, flags) => fs.openSync(filePath, flags),
  fstatSync: (fd) => fs.fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
  noFollowFlag: fs.constants.O_NOFOLLOW,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function truncateWarning(message: string): string {
  if (message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH) return message;
  return `${message.slice(0, MAX_PROJECT_DEFAULT_WARNING_LENGTH - 1)}…`;
}

function formatWarningSummary(omittedCount: number): string {
  return truncateWarning(`…and ${omittedCount} more issues in ${PROJECT_DEFAULTS_WARNING_FILE}`);
}

/**
 * Keep file-controlled diagnostics bounded while preserving the first useful
 * issues and one deterministic summary for the rest.
 */
class ProjectDefaultsWarningCollector {
  private readonly retained: string[] = [];
  private omittedCount = 0;

  add(message: string): void {
    const warning = truncateWarning(message);
    if (warning.length === 0 || this.retained.includes(warning)) return;
    if (this.retained.length < MAX_PROJECT_DEFAULT_WARNINGS) {
      this.retained.push(warning);
      return;
    }
    this.omittedCount += 1;
  }

  toArray(): string[] {
    return this.omittedCount === 0
      ? [...this.retained]
      : [...this.retained, formatWarningSummary(this.omittedCount)];
  }
}

function boundedWarnings(...messages: string[]): string[] {
  const collector = new ProjectDefaultsWarningCollector();
  for (const message of messages) collector.add(message);
  return collector.toArray();
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Match the provider/model grammar used by runtime registry lookups. This
 * equivalent stays local because this loader is a lazy subagents target and
 * cannot import the eager the-last-harness model-defaults module without
 * violating the native lazy-import boundary.
 */
function isValidModelReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

/** Match the sibling project-agent loader's identity/signature recheck. */
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

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
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

function isUsableConfigTrustStore(value: unknown): value is ProjectConfigTrustStore {
  try {
    return (
      Boolean(value) &&
      typeof value === "object" &&
      typeof (value as ProjectConfigTrustStore).getEntry === "function"
    );
  } catch {
    return false;
  }
}

function configTrustResult(
  trusted: boolean,
  source: ProjectConfigTrustSource,
): ProjectConfigTrustResult {
  return { kind: "project-config", trusted, source };
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

function defaultConfigTrustStore(
  options: ProjectConfigTrustOptions,
): ProjectConfigTrustStore | undefined {
  if (options.trustStore) {
    if (!isUsableConfigTrustStore(options.trustStore)) {
      throw new Error("Project configuration trust-store dependency returned an invalid store.");
    }
    return options.trustStore;
  }

  const agentDir = options.agentDir ?? getPiAgentDir();
  // ProjectTrustStore acquires a lock even for reads and therefore creates its
  // parent directory. Avoid that write when no persisted trust can exist.
  if (!fs.existsSync(path.join(agentDir, "trust.json"))) return undefined;
  if (typeof options.createProjectTrustStore !== "function") {
    throw new Error("Project configuration trust-store dependency is unavailable.");
  }
  const store = options.createProjectTrustStore(agentDir);
  if (!isUsableConfigTrustStore(store)) {
    throw new Error("Project configuration trust-store dependency returned an invalid store.");
  }
  return store;
}

function resolveConfigTrustUiTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : PROJECT_CONFIG_TRUST_UI_TIMEOUT_MS;
}

/** Keep the configuration prompt bounded even if an injected UI never settles. */
function waitForConfigTrustDecision(
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
 * Resolve trust for .tlh/defaults.json only. Its result and session cache are
 * intentionally non-interchangeable with resolveProjectAgentTrust: a
 * session-approved configuration can select model/effort defaults, but it
 * cannot authorize project custom-agent definitions.
 */
export async function resolveProjectConfigTrust(
  projectRoot: string,
  options: ProjectConfigTrustOptions = {},
): Promise<ProjectConfigTrustResult> {
  if (options.trustOverride === false) {
    return configTrustResult(false, "explicit-negative");
  }

  try {
    const store = defaultConfigTrustStore(options);
    if (store) {
      const entry = store.getEntry(projectRoot);
      if (entry !== null && typeof entry !== "object") {
        return configTrustResult(false, "trust-store-error");
      }
      if (entry && (typeof entry.path !== "string" || typeof entry.decision !== "boolean")) {
        return configTrustResult(false, "trust-store-error");
      }
      if (entry && trustEntryPathApplies(entry.path, projectRoot)) {
        return configTrustResult(
          entry.decision,
          entry.decision ? "saved-positive" : "saved-negative",
        );
      }
    }
  } catch {
    return configTrustResult(false, "trust-store-error");
  }

  let hasTrustResources = false;
  try {
    hasTrustResources = options.hasTrustRequiringProjectResources?.(projectRoot) === true;
  } catch {
    // A broken upstream resource probe is not positive configuration trust.
  }
  let upstreamDecision: boolean | undefined;
  try {
    upstreamDecision = options.isProjectTrusted?.();
  } catch {
    upstreamDecision = undefined;
  }
  if (upstreamDecision === false) {
    return configTrustResult(false, "explicit-negative");
  }
  if (hasTrustResources && upstreamDecision === true) {
    return configTrustResult(true, "upstream-positive");
  }

  const sessionId =
    typeof options.sessionId === "string" && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : undefined;
  const sessionKey = sessionId
    ? `project-config\u0000${sessionId}\u0000${path.resolve(projectRoot)}`
    : undefined;
  const cachedDecision = sessionKey
    ? PROJECT_CONFIG_SESSION_TRUST_DECISIONS.get(sessionKey)
    : undefined;
  if (cachedDecision !== undefined) {
    return configTrustResult(
      cachedDecision,
      cachedDecision ? "session-positive" : "session-negative",
    );
  }

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return configTrustResult(true, "default-always");
    case "never":
      return configTrustResult(false, "default-never");
    case "ask":
      break;
  }

  if (options.hasUI === false || (!options.confirm && !options.ui)) {
    return configTrustResult(false, "session-unavailable");
  }

  try {
    const timeoutMs = resolveConfigTrustUiTimeoutMs(options.trustUiTimeoutMs);
    const decision = await waitForConfigTrustDecision(
      options.confirm
        ? options.confirm(projectRoot)
        : options.ui
          ? options.ui.confirm(
              "Trust project-local TLH defaults?",
              `This allows repository-owned model/effort defaults in ${path.join(projectRoot, PROJECT_DEFAULTS_FILE)} to be applied for this session only. Project custom agents require persisted /trust authorization.`,
              { timeout: timeoutMs },
            )
          : undefined,
      timeoutMs,
    );
    if (decision === true || decision === false) {
      if (sessionKey) {
        PROJECT_CONFIG_SESSION_TRUST_DECISIONS.set(sessionKey, decision);
        if (
          PROJECT_CONFIG_SESSION_TRUST_DECISIONS.size > PROJECT_CONFIG_TRUST_SESSION_CACHE_LIMIT
        ) {
          const oldestKey = PROJECT_CONFIG_SESSION_TRUST_DECISIONS.keys().next().value;
          if (oldestKey) PROJECT_CONFIG_SESSION_TRUST_DECISIONS.delete(oldestKey);
        }
      }
      return configTrustResult(decision, decision ? "session-positive" : "session-negative");
    }
  } catch {
    return configTrustResult(false, "session-unavailable");
  }
  return configTrustResult(false, "session-unavailable");
}

function normalizeMaxFileBytes(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : MAX_PROJECT_DEFAULTS_FILE_BYTES;
}

type DefaultsPreflight =
  | { readonly kind: "absent" }
  | { readonly kind: "unsafe"; readonly reason: string }
  | { readonly kind: "present" };

/**
 * Probe for a plausible defaults resource without reading its contents. An
 * absent path skips trust resolution; unsafe/unloadable paths fail closed
 * without prompting. readDefaultsFile repeats the full safety checks after
 * trust has been established.
 */
function preflightDefaultsFile(
  projectRoot: string,
  fileSystem: ProjectDefaultsLoaderFileSystem,
  maxFileBytes: number,
): DefaultsPreflight {
  const tlhPath = path.join(projectRoot, ".tlh");
  const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);

  let tlhStat: fs.Stats;
  try {
    tlhStat = fileSystem.lstatSync(tlhPath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { kind: "absent" };
    }
    return {
      kind: "unsafe",
      reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
    };
  }
  if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
    return {
      kind: "unsafe",
      reason: `.tlh is not a regular directory (symlinks are not allowed)`,
    };
  }

  let fileStat: fs.Stats;
  try {
    fileStat = fileSystem.lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { kind: "absent" };
    }
    return {
      kind: "unsafe",
      reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
  if (fileStat.isSymbolicLink()) {
    return {
      kind: "unsafe",
      reason: `${PROJECT_DEFAULTS_FILE} is a symlink (symlinks are not allowed)`,
    };
  }
  if (!fileStat.isFile()) {
    return {
      kind: "unsafe",
      reason: `${PROJECT_DEFAULTS_FILE} is not a regular file`,
    };
  }
  if (fileStat.size > maxFileBytes) {
    return {
      kind: "unsafe",
      reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
    };
  }
  return { kind: "present" };
}

// ---------------------------------------------------------------------------
// Hardened file resolution
// ---------------------------------------------------------------------------

type ReadResult =
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "content"; readonly text: string };

type DefaultsPathInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "valid";
      readonly tlhCanonicalPath: string;
      readonly tlhStat: fs.Stats;
      readonly tlhIdentity: FileIdentity;
      readonly canonicalPath: string;
      readonly fileStat: fs.Stats;
      readonly fileIdentity: FileIdentity;
    };

function inspectDefaultsPath(
  projectRoot: string,
  fileSystem: ProjectDefaultsLoaderFileSystem,
  maxFileBytes: number,
): DefaultsPathInspection {
  const tlhPath = path.join(projectRoot, ".tlh");
  const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);

  let tlhStat: fs.Stats;
  try {
    tlhStat = fileSystem.lstatSync(tlhPath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { kind: "absent" };
    }
    return {
      kind: "error",
      reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
    };
  }
  const tlhIdentity = fileIdentity(tlhStat);
  if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
    return {
      kind: "error",
      reason: `.tlh is not a regular directory (symlinks are not allowed)`,
    };
  }
  if (!tlhIdentity) {
    return {
      kind: "error",
      reason: `.tlh directory identity cannot be proven`,
    };
  }

  let tlhCanonicalPath: string;
  try {
    tlhCanonicalPath = fileSystem.realpathSync(tlhPath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot canonicalize .tlh directory: ${errorMessage(error)}`,
    };
  }
  if (!isPathWithin(projectRoot, tlhCanonicalPath)) {
    return {
      kind: "error",
      reason: `.tlh canonical path is outside the project root`,
    };
  }

  let fileStat: fs.Stats;
  try {
    fileStat = fileSystem.lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { kind: "absent" };
    }
    return {
      kind: "error",
      reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
  const fileIdentityValue = fileIdentity(fileStat);
  if (fileStat.isSymbolicLink()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} is a symlink (symlinks are not allowed)`,
    };
  }
  if (!fileStat.isFile()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} is not a regular file`,
    };
  }
  if (!fileIdentityValue) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} file identity cannot be proven`,
    };
  }
  if (!Number.isSafeInteger(fileStat.size) || fileStat.size < 0) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} size cannot be bounded safely`,
    };
  }
  if (fileStat.size > maxFileBytes) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpathSync(filePath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot canonicalize ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
  if (
    !isPathWithin(projectRoot, canonicalPath) ||
    path.dirname(canonicalPath) !== tlhCanonicalPath
  ) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} canonical path is outside the project root`,
    };
  }

  return {
    kind: "valid",
    tlhCanonicalPath,
    tlhStat,
    tlhIdentity,
    canonicalPath,
    fileStat,
    fileIdentity: fileIdentityValue,
  };
}

function sameDefaultsPath(left: DefaultsPathInspection, right: DefaultsPathInspection): boolean {
  if (left.kind !== "valid" || right.kind !== "valid") return false;
  return (
    left.tlhCanonicalPath === right.tlhCanonicalPath &&
    sameFileIdentity(left.tlhIdentity, right.tlhIdentity) &&
    statSignature(left.tlhStat) === statSignature(right.tlhStat) &&
    left.canonicalPath === right.canonicalPath &&
    sameFileIdentity(left.fileIdentity, right.fileIdentity) &&
    statSignature(left.fileStat) === statSignature(right.fileStat)
  );
}

function pathInspectionError(
  inspection: DefaultsPathInspection,
  phase: "before reading" | "while reading",
): ReadResult {
  if (inspection.kind === "absent") {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} disappeared ${phase}`,
    };
  }
  if (inspection.kind === "error") {
    const reason = inspection.reason.includes("is a symlink")
      ? `${PROJECT_DEFAULTS_FILE} became a symlink ${phase}`
      : `${PROJECT_DEFAULTS_FILE} changed ${phase}: ${inspection.reason}`;
    return { kind: "error", reason };
  }
  return {
    kind: "error",
    reason: `${PROJECT_DEFAULTS_FILE} changed ${phase}`,
  };
}

/**
 * Resolve and read .tlh/defaults.json with stable descriptor-based bounds.
 * Symlinks anywhere on the path, non-regular files, out-of-root canonical
 * paths, unstable identities, unavailable O_NOFOLLOW, and unbounded reads are
 * all rejected. Fail-closed on any anomaly.
 */
function readDefaultsFile(
  projectRoot: string,
  fileSystem: ProjectDefaultsLoaderFileSystem,
  maxFileBytes: number,
): ReadResult {
  const initial = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
  if (initial.kind !== "valid") {
    return pathInspectionError(initial, "before reading");
  }

  // Recheck both the fixed .tlh directory and the file immediately before
  // opening. This prevents a same-size replacement from reaching the reader.
  const beforeOpen = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
  if (beforeOpen.kind !== "valid") return pathInspectionError(beforeOpen, "before reading");
  if (!sameDefaultsPath(initial, beforeOpen)) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
    };
  }

  const noFollow = fileSystem.noFollowFlag;
  if (typeof noFollow !== "number" || !Number.isSafeInteger(noFollow) || noFollow <= 0) {
    return {
      kind: "error",
      reason: "the O_NOFOLLOW open flag is unavailable; refusing an unbound defaults read",
    };
  }
  if (
    typeof fileSystem.openSync !== "function" ||
    typeof fileSystem.fstatSync !== "function" ||
    typeof fileSystem.readSync !== "function" ||
    typeof fileSystem.closeSync !== "function"
  ) {
    return {
      kind: "error",
      reason: "safe descriptor operations are unavailable; refusing to read project defaults",
    };
  }

  let descriptor: number | undefined;
  try {
    // Open the exact canonical file. O_NOFOLLOW protects the final component;
    // the fixed-directory identity is checked again after opening and reading.
    descriptor = fileSystem.openSync(beforeOpen.canonicalPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
      };
    }
    return {
      kind: "error",
      reason: `Cannot open ${PROJECT_DEFAULTS_FILE} safely: ${errorMessage(error)}`,
    };
  }

  try {
    const descriptorStat = fileSystem.fstatSync(descriptor);
    const descriptorIdentity = fileIdentity(descriptorStat);
    if (descriptorStat.isSymbolicLink() || !descriptorStat.isFile() || !descriptorIdentity) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} opened descriptor is not a regular file`,
      };
    }
    if (
      !sameFileIdentity(beforeOpen.fileIdentity, descriptorIdentity) ||
      descriptorStat.size !== beforeOpen.fileStat.size ||
      statSignature(descriptorStat) !== statSignature(beforeOpen.fileStat)
    ) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
      };
    }
    if (descriptorStat.size > maxFileBytes) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
      };
    }

    const afterOpen = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
    if (afterOpen.kind !== "valid") return pathInspectionError(afterOpen, "before reading");
    if (!sameDefaultsPath(beforeOpen, afterOpen)) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
      };
    }

    // Read maxFileBytes plus one sentinel byte. The extra byte distinguishes an
    // exact-boundary file from a file that grew during the descriptor read.
    const readLimit = maxFileBytes === Number.MAX_SAFE_INTEGER ? maxFileBytes : maxFileBytes + 1;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < readLimit) {
      const remaining = readLimit - bytesRead;
      const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
      const count = fileSystem.readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.byteLength) {
        return {
          kind: "error",
          reason: "safe descriptor read returned an invalid byte count",
        };
      }
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
      if (bytesRead > maxFileBytes) {
        return {
          kind: "error",
          reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
        };
      }
    }
    const bytes = Buffer.concat(chunks, bytesRead);

    const afterReadDescriptorStat = fileSystem.fstatSync(descriptor);
    const afterReadDescriptorIdentity = fileIdentity(afterReadDescriptorStat);
    if (
      afterReadDescriptorStat.isSymbolicLink() ||
      !afterReadDescriptorStat.isFile() ||
      !afterReadDescriptorIdentity ||
      !sameFileIdentity(descriptorIdentity, afterReadDescriptorIdentity) ||
      statSignature(afterReadDescriptorStat) !== statSignature(beforeOpen.fileStat)
    ) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
      };
    }
    if (bytes.byteLength !== beforeOpen.fileStat.size) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} size changed while reading`,
      };
    }

    // Keep the path and fixed-directory checks after the descriptor read so a
    // containment or replacement change fails closed before parsing bytes.
    const afterRead = inspectDefaultsPath(projectRoot, fileSystem, maxFileBytes);
    if (afterRead.kind !== "valid") return pathInspectionError(afterRead, "while reading");
    if (!sameDefaultsPath(beforeOpen, afterRead)) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
      };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} contains invalid UTF-8: ${errorMessage(error)}`,
      };
    }

    return { kind: "content", text };
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ELOOP")) {
      return {
        kind: "error",
        reason: `${PROJECT_DEFAULTS_FILE} changed while reading`,
      };
    }
    return {
      kind: "error",
      reason: `Cannot read ${PROJECT_DEFAULTS_FILE} safely: ${errorMessage(error)}`,
    };
  } finally {
    try {
      fileSystem.closeSync(descriptor);
    } catch {
      // The read result is already determined; close is best effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Schema validation (per-entry warn-and-ignore)
// ---------------------------------------------------------------------------

function validateDefaultsEntry(
  section: "primaryAgents" | "subagents",
  role: string,
  rawEntry: unknown,
  warnings: ProjectDefaultsWarningCollector,
): ProjectDefaultsEntry | null {
  // Validate the role name for this section.
  if (section === "primaryAgents") {
    if (!VALID_PRIMARY_AGENTS.has(role as PrimaryAgentName)) {
      warnings.add(
        `Ignoring unknown primary agent name "${role}" in ${PROJECT_DEFAULTS_FILE}` +
          ` (valid names: ${[...VALID_PRIMARY_AGENTS].join(", ")}).`,
      );
      return null;
    }
  } else {
    if (!VALID_SUBAGENT_ROLES.has(role as SubagentRoleName)) {
      warnings.add(
        `Ignoring unknown subagent role "${role}" in ${PROJECT_DEFAULTS_FILE}` +
          ` (valid roles: ${[...VALID_SUBAGENT_ROLES].join(", ")}).`,
      );
      return null;
    }
  }

  if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    warnings.add(
      `Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}: entry must be an object.`,
    );
    return null;
  }
  const entryObj = rawEntry as Record<string, unknown>;

  // Reject unknown keys.
  const unknownKeys = Object.keys(entryObj).filter((key) => !VALID_ENTRY_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.add(
      `Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}: unknown key(s)` +
        ` ${unknownKeys.map((k) => `"${k}"`).join(", ")}.`,
    );
    return null;
  }

  // Validate model using the same provider/model reference grammar as the
  // runtime registry lookup. Reject the whole entry so a valid effort value
  // cannot leak through an invalid model reference.
  let model: string | undefined;
  if (Object.prototype.hasOwnProperty.call(entryObj, "model")) {
    if (!isValidModelReference(entryObj.model)) {
      warnings.add(
        `Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
          ` "model" must be a provider/model reference with non-empty provider and model id.`,
      );
      return null;
    }
    model = entryObj.model;
  }

  // Validate effort (case-sensitive).
  let effort: EffortLevel | undefined;
  if (Object.prototype.hasOwnProperty.call(entryObj, "effort")) {
    if (
      typeof entryObj.effort !== "string" ||
      !VALID_EFFORT_LEVELS.has(entryObj.effort as EffortLevel)
    ) {
      warnings.add(
        `Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
          ` "effort" must be one of ${[...VALID_EFFORT_LEVELS].join(", ")} (case-sensitive).`,
      );
      return null;
    }
    effort = entryObj.effort as EffortLevel;
  }

  // At least one of model/effort must be present.
  if (model === undefined && effort === undefined) {
    warnings.add(
      `Ignoring ${section}["${role}"] in ${PROJECT_DEFAULTS_FILE}:` +
        ` entry must have at least one of "model" or "effort".`,
    );
    return null;
  }

  const entry: { model?: string; effort?: EffortLevel } = {};
  if (model !== undefined) entry.model = model;
  if (effort !== undefined) entry.effort = effort;
  return entry;
}

function parseDefaultsContent(
  text: string,
  warnings: ProjectDefaultsWarningCollector,
): ProjectDefaults | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.add(
      `${PROJECT_DEFAULTS_FILE} is not valid JSON: ${errorMessage(error)}. No defaults applied.`,
    );
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.add(
      `${PROJECT_DEFAULTS_FILE} must be a JSON object at the top level. No defaults applied.`,
    );
    return null;
  }
  const root = parsed as Record<string, unknown>;

  const primaryAgents: Partial<Record<PrimaryAgentName, ProjectDefaultsEntry>> = {};
  const subagents: Partial<Record<SubagentRoleName, ProjectDefaultsEntry>> = {};

  if (Object.prototype.hasOwnProperty.call(root, "primaryAgents")) {
    const section = root.primaryAgents;
    if (section !== null && typeof section === "object" && !Array.isArray(section)) {
      for (const [role, rawEntry] of Object.entries(section as Record<string, unknown>)) {
        const entry = validateDefaultsEntry("primaryAgents", role, rawEntry, warnings);
        if (entry !== null) {
          primaryAgents[role as PrimaryAgentName] = entry;
        }
      }
    } else {
      warnings.add(
        `${PROJECT_DEFAULTS_FILE} "primaryAgents" must be an object if present; section ignored.`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(root, "subagents")) {
    const section = root.subagents;
    if (section !== null && typeof section === "object" && !Array.isArray(section)) {
      for (const [role, rawEntry] of Object.entries(section as Record<string, unknown>)) {
        const entry = validateDefaultsEntry("subagents", role, rawEntry, warnings);
        if (entry !== null) {
          subagents[role as SubagentRoleName] = entry;
        }
      }
    } else {
      warnings.add(
        `${PROJECT_DEFAULTS_FILE} "subagents" must be an object if present; section ignored.`,
      );
    }
  }

  return { primaryAgents, subagents };
}

// ---------------------------------------------------------------------------
// Merge trust options
// ---------------------------------------------------------------------------

function mergeTrustOptions(options: ProjectDefaultsLoadOptions): ProjectConfigTrustOptions {
  return {
    ...options.trust,
    sessionId: options.trust?.sessionId ?? options.sessionId,
    agentDir: options.trust?.agentDir ?? options.agentDir,
    trustOverride: options.trust?.trustOverride ?? options.trustOverride,
    defaultProjectTrust: options.trust?.defaultProjectTrust ?? options.defaultProjectTrust,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate .tlh/defaults.json from the canonical validated Git
 * worktree root.
 *
 * Configuration trust is deliberately a separate policy from custom-agent
 * execution trust. Persisted, upstream-positive, default, and session-only
 * decisions can authorize these model/effort defaults; no result from this
 * loader authorizes project custom-agent definitions.
 *
 * Path checks are metadata-only before trust, reject symlinks and non-regular
 * files, and enforce a bounded stable read. Per-entry validation uses
 * warn-and-ignore: unknown role names, unknown keys, invalid model/effort
 * values, or missing model+effort skip that entry while the rest of the file
 * still applies. Malformed JSON warns and applies nothing.
 *
 * This function loads and validates; primary-agent runtime integration is
 * handled by primary-agent-runtime.ts and subagent dispatch integration by
 * its caller.
 */
export async function loadProjectDefaults(
  options: ProjectDefaultsLoadOptions,
): Promise<ProjectDefaultsLoadResult> {
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
  const maxFileBytes = normalizeMaxFileBytes(options.maxFileBytes);

  // Resolve the root through the shared metadata-only validated worktree
  // primitive. This loader never invokes Git or imports the agent loader.
  const projectRoot = resolveValidatedGitWorktreeRoot(options.cwd, { fileSystem });
  if (!projectRoot) {
    return {
      status: "unavailable",
      warnings: boundedWarnings("Current directory is not inside a canonical Git worktree."),
    };
  }
  if (typeof options.sessionId !== "string" || options.sessionId.trim().length === 0) {
    return {
      status: "unavailable",
      projectRoot,
      warnings: boundedWarnings(
        "Session identity is unavailable; project-defaults loading is disabled.",
      ),
    };
  }

  // Probe only resource metadata before consulting any trust service. An
  // absent defaults file must not prompt, read trust state, or require a trust
  // dependency at all.
  const preflight = preflightDefaultsFile(projectRoot, fileSystem, maxFileBytes);
  if (preflight.kind === "absent") {
    return {
      status: "loaded",
      projectRoot,
      defaults: { primaryAgents: {}, subagents: {} },
      warnings: boundedWarnings(),
    };
  }
  if (preflight.kind === "unsafe") {
    return {
      status: "unavailable",
      projectRoot,
      warnings: boundedWarnings(preflight.reason),
    };
  }

  // The file exists, so trust dependencies are now required. Keep this check
  // separate from the custom-agent dependency object and resolver.
  const trustOptions = mergeTrustOptions(options);
  if (
    typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
    (typeof trustOptions.createProjectTrustStore !== "function" &&
      !isUsableConfigTrustStore(trustOptions.trustStore))
  ) {
    return {
      status: "unavailable",
      projectRoot,
      warnings: boundedWarnings(
        "Project-defaults trust dependencies are unavailable; loading is disabled.",
      ),
    };
  }

  const trust = await resolveProjectConfigTrust(projectRoot, trustOptions);
  if (!trust.trusted) {
    return {
      status: "denied",
      projectRoot,
      trust,
      warnings: boundedWarnings(`Project-defaults loading denied (${trust.source}).`),
    };
  }

  // Harden-read the defaults file. A disappearance after preflight is an
  // error; only the metadata-only preflight owns the absent-file fast path.
  const readResult = readDefaultsFile(projectRoot, fileSystem, maxFileBytes);

  if (readResult.kind === "error") {
    return {
      status: "unavailable",
      projectRoot,
      trust,
      warnings: boundedWarnings(readResult.reason),
    };
  }

  // Parse and validate content. Malformed JSON → empty defaults + warning.
  const warnings = new ProjectDefaultsWarningCollector();
  const defaults = parseDefaultsContent(readResult.text, warnings);

  return {
    status: "loaded",
    projectRoot,
    trust,
    defaults: defaults ?? { primaryAgents: {}, subagents: {} },
    warnings: warnings.toArray(),
  };
}
