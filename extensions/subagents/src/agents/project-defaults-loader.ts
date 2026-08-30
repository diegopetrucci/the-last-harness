import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveCanonicalGitWorktreeRoot,
  resolveProjectAgentTrust,
  type ProjectAgentGit,
  type ProjectAgentLoaderFileSystem,
  type ProjectAgentTrustOptions,
  type ProjectAgentTrustResult,
  type ProjectAgentTrustStore,
} from "./project-agent-loader.ts";

/** Path relative to the canonical Git worktree root. */
export const PROJECT_DEFAULTS_FILE = path.join(".tlh", "defaults.json");
const PROJECT_DEFAULTS_WARNING_FILE = ".tlh/defaults.json";

/** Deliberate finite bound; loaded before project code is trusted. */
export const MAX_PROJECT_DEFAULTS_FILE_BYTES = 64 * 1024;

/** Maximum number of distinct validation warnings retained for one load. */
export const MAX_PROJECT_DEFAULT_WARNINGS = 20;

/** Maximum UTF-16 code units retained in one validation warning. */
export const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;

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

/** Result returned by loadProjectDefaults for later consumption by runtime and dispatch. */
export interface ProjectDefaultsLoadResult {
  readonly status: "loaded" | "denied" | "unavailable";
  readonly projectRoot?: string;
  readonly defaults?: ProjectDefaults;
  readonly trust?: ProjectAgentTrustResult;
  /** Per-entry parse/validation warnings. Present even when status is "loaded". */
  readonly warnings: readonly string[];
}

/** Injectable options for loadProjectDefaults. */
export interface ProjectDefaultsLoadOptions {
  /** Working directory used to resolve the canonical Git worktree root. */
  cwd: string;
  sessionId?: string;
  agentDir?: string;
  trustOverride?: boolean;
  defaultProjectTrust?: "ask" | "always" | "never";
  /** Full trust option bag; individual fields merge with the top-level options. */
  trust?: ProjectAgentTrustOptions;
  git?: ProjectAgentGit;
  fileSystem?: ProjectAgentLoaderFileSystem;
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

const DEFAULT_FILE_SYSTEM: ProjectAgentLoaderFileSystem = {
  lstatSync: (filePath) => fs.lstatSync(filePath),
  readdirSync: (filePath, options) => fs.readdirSync(filePath, options) as fs.Dirent[],
  realpathSync: (filePath) => fs.realpathSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath),
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
  fileSystem: ProjectAgentLoaderFileSystem,
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
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "content"; readonly text: string };

/**
 * Resolve and read .tlh/defaults.json using lstat-based checks at every path
 * component. Symlinks anywhere on the path, non-regular files, and
 * out-of-root canonical paths are all rejected. Fail-closed on any anomaly.
 */
function readDefaultsFile(
  projectRoot: string,
  fileSystem: ProjectAgentLoaderFileSystem,
  maxFileBytes: number,
): ReadResult {
  const tlhPath = path.join(projectRoot, ".tlh");
  const filePath = path.join(projectRoot, PROJECT_DEFAULTS_FILE);

  // Inspect .tlh component using lstat (never follows symlinks).
  let tlhStat: fs.Stats;
  try {
    tlhStat = fileSystem.lstatSync(tlhPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "absent" };
    return {
      kind: "error",
      reason: `Cannot inspect .tlh directory: ${errorMessage(error)}`,
    };
  }
  if (tlhStat.isSymbolicLink() || !tlhStat.isDirectory()) {
    return {
      kind: "error",
      reason: `.tlh is not a regular directory (symlinks are not allowed)`,
    };
  }

  // Inspect defaults.json using lstat.
  let fileStat: fs.Stats;
  try {
    fileStat = fileSystem.lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "absent" };
    return {
      kind: "error",
      reason: `Cannot inspect ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
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
  if (fileStat.size > maxFileBytes) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} exceeds maximum allowed size of ${maxFileBytes} bytes`,
    };
  }

  // Canonicalize path and verify it stays inside the project root.
  let canonicalPath: string;
  try {
    canonicalPath = fileSystem.realpathSync(filePath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot canonicalize ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
  if (!isPathWithin(projectRoot, canonicalPath)) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} canonical path is outside the project root`,
    };
  }

  // Recheck the path after realpath and immediately before reading. This
  // catches same-size replacements and regular-file-to-symlink swaps that can
  // occur after the initial lstat.
  const initialSignature = statSignature(fileStat);
  let beforeReadStat: fs.Stats;
  try {
    beforeReadStat = fileSystem.lstatSync(filePath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot recheck ${PROJECT_DEFAULTS_FILE} before reading: ${errorMessage(error)}`,
    };
  }
  if (beforeReadStat.isSymbolicLink()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} became a symlink before reading`,
    };
  }
  if (!beforeReadStat.isFile()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} is no longer a regular file before reading`,
    };
  }
  if (statSignature(beforeReadStat) !== initialSignature) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} changed before reading`,
    };
  }

  // Read bytes only after trust and all path checks have succeeded.
  let raw: string | Buffer;
  try {
    raw = fileSystem.readFileSync(canonicalPath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot read ${PROJECT_DEFAULTS_FILE}: ${errorMessage(error)}`,
    };
  }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf-8");

  // Preserve the bounded-read guard and verify identity after reading.
  if (bytes.byteLength !== fileStat.size) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} size changed while reading`,
    };
  }

  let afterReadStat: fs.Stats;
  try {
    afterReadStat = fileSystem.lstatSync(filePath);
  } catch (error) {
    return {
      kind: "error",
      reason: `Cannot recheck ${PROJECT_DEFAULTS_FILE} after reading: ${errorMessage(error)}`,
    };
  }
  if (afterReadStat.isSymbolicLink()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} became a symlink while reading`,
    };
  }
  if (!afterReadStat.isFile()) {
    return {
      kind: "error",
      reason: `${PROJECT_DEFAULTS_FILE} is no longer a regular file after reading`,
    };
  }
  if (statSignature(afterReadStat) !== initialSignature) {
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

function mergeTrustOptions(options: ProjectDefaultsLoadOptions): ProjectAgentTrustOptions {
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
 * Load and validate .tlh/defaults.json from the canonical Git worktree root.
 *
 * Trust is gated identically to .tlh/agents: canonical worktree root
 * resolution, lstat-based path checks, symlink rejection, regular-file-only,
 * bounded file size. Any unsafe condition fails closed — defaults are not
 * partially applied.
 *
 * Per-entry validation uses warn-and-ignore: unknown role names, unknown keys,
 * invalid model/effort values, or missing model+effort all produce a warning
 * and skip that entry; the rest of the file still applies. Malformed JSON
 * warns and applies nothing.
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

  // Resolve canonical worktree root (same as agents loader).
  const projectRoot = resolveCanonicalGitWorktreeRoot(options.cwd, {
    git: options.git,
    fileSystem,
  });
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

  // Merge and validate trust options.
  const trustOptions = mergeTrustOptions(options);

  // Same dependency pre-check as agents loader: fail closed if the trust store
  // mechanism is unavailable rather than silently skipping.
  if (
    typeof trustOptions.hasTrustRequiringProjectResources !== "function" ||
    (typeof trustOptions.createProjectTrustStore !== "function" &&
      !isUsableTrustStore(trustOptions.trustStore))
  ) {
    return {
      status: "unavailable",
      projectRoot,
      warnings: boundedWarnings(
        "Project-defaults trust dependencies are unavailable; loading is disabled.",
      ),
    };
  }

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

  // Resolve trust (reuses the exact same function as the agents loader,
  // including the module-level session trust cache).
  const trust = await resolveProjectAgentTrust(projectRoot, trustOptions);
  if (!trust.trusted) {
    return {
      status: "denied",
      projectRoot,
      trust,
      warnings: boundedWarnings(`Project-defaults loading denied (${trust.source}).`),
    };
  }

  // Harden-read the defaults file.
  const readResult = readDefaultsFile(projectRoot, fileSystem, maxFileBytes);

  if (readResult.kind === "absent") {
    // No file is not an error; return empty defaults.
    return {
      status: "loaded",
      projectRoot,
      trust,
      defaults: { primaryAgents: {}, subagents: {} },
      warnings: boundedWarnings(),
    };
  }

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
