import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  getAgentDir,
  ProjectTrustStore,
  type ProjectTrustDecision,
} from "@earendil-works/pi-coding-agent";
import { resolveValidatedGitWorktreeRoot } from "./project-agent-guidance.js";

/** Maximum UTF-8 bytes accepted from one project custom-agent definition. */
export const PROJECT_CUSTOM_AGENT_MAX_BYTES = 64 * 1024;
export const PROJECT_CUSTOM_AGENT_DIRECTORY = ".tlh/agents/custom";
export const PROJECT_CUSTOM_AGENT_RUNTIME_PREFIX = "embedded.";

const CUSTOM_AGENT_FILENAME_PATTERN = /^[A-Z0-9][A-Z0-9-]*\.md$/;
const CUSTOM_AGENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EMBEDDED_RUNTIME_NAME_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;
const FRONTMATTER_KEY_PATTERN = /^[\w-]+$/;

export interface ProjectCustomAgentFileIdentity {
  dev: number;
  ino: number;
}

/** Exact file identity authorized by the primary tool-call gate. */
export interface ProjectCustomAgentBinding {
  runtimeName: string;
  filename: string;
  worktreeRoot: string;
  canonicalPath: string;
  identity: ProjectCustomAgentFileIdentity;
}

export type ProjectCustomAgentTrustState = "trusted" | "denied" | "undecided" | "unavailable";

export type ProjectCustomAgentDiagnosticCode =
  | "invalid-cwd"
  | "invalid-agent-dir"
  | "no-git-root"
  | "trust-inspection-failed"
  | "project-not-trusted"
  | "invalid-directory"
  | "symlink-directory"
  | "directory-inspection-failed"
  | "invalid-filename"
  | "symlink-file"
  | "non-regular-file"
  | "file-inspection-failed"
  | "file-too-large"
  | "file-read-failed"
  | "invalid-frontmatter"
  | "unsupported-extension";

export interface ProjectCustomAgentDiagnostic {
  code: ProjectCustomAgentDiagnosticCode;
  message: string;
  path?: string;
  runtimeName?: string;
}

export interface ProjectCustomAgentFile {
  runtimeName: string;
  filename: string;
  path: string;
  content?: string;
  binding?: ProjectCustomAgentBinding;
}

export interface ProjectCustomAgentInventory {
  cwd: string;
  worktreeRoot?: string;
  trust: ProjectCustomAgentTrustState;
  trustDecision: ProjectTrustDecision;
  trustEntryPath?: string;
  files: ProjectCustomAgentFile[];
  diagnostics: ProjectCustomAgentDiagnostic[];
}

export interface ProjectCustomAgentDispatchBinding {
  target: string;
  /** Undefined for a top-level single-agent target; otherwise zero-based task index. */
  taskIndex?: number;
  cwd: string;
  binding: ProjectCustomAgentBinding;
}

export interface ProjectCustomAgentAuthorization {
  bindings: ProjectCustomAgentDispatchBinding[];
}

const AUTHORIZATION_TTL_MS = 5 * 60 * 1_000;
const MAX_AUTHORIZATIONS_BY_TOOL_CALL_ID = 256;

interface StoredProjectCustomAgentAuthorization {
  authorization: ProjectCustomAgentAuthorization;
  expiresAt: number;
}

const authorizationByToolCallId = new Map<string, StoredProjectCustomAgentAuthorization>();
const authorizationByInput = new WeakMap<object, ProjectCustomAgentAuthorization>();

function pruneProjectCustomAgentAuthorizations(now = Date.now()): void {
  for (const [toolCallId, stored] of authorizationByToolCallId) {
    if (stored.expiresAt <= now) authorizationByToolCallId.delete(toolCallId);
  }
  while (authorizationByToolCallId.size > MAX_AUTHORIZATIONS_BY_TOOL_CALL_ID) {
    const oldest = authorizationByToolCallId.keys().next().value;
    if (typeof oldest !== "string") break;
    authorizationByToolCallId.delete(oldest);
  }
}

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

function fileIdentity(stat: fs.Stats): ProjectCustomAgentFileIdentity | undefined {
  if (!Number.isSafeInteger(stat.dev) || !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
    return undefined;
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(
  left: ProjectCustomAgentFileIdentity,
  right: ProjectCustomAgentFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function isProjectCustomAgentBinding(value: unknown): value is ProjectCustomAgentBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    runtimeName?: unknown;
    filename?: unknown;
    worktreeRoot?: unknown;
    canonicalPath?: unknown;
    identity?: unknown;
  };
  if (
    typeof candidate.runtimeName !== "string" ||
    typeof candidate.filename !== "string" ||
    typeof candidate.worktreeRoot !== "string" ||
    typeof candidate.canonicalPath !== "string" ||
    typeof candidate.identity !== "object" ||
    candidate.identity === null ||
    Array.isArray(candidate.identity)
  ) {
    return false;
  }
  const identity = candidate.identity as { dev?: unknown; ino?: unknown };
  return (
    Number.isSafeInteger(identity.dev) &&
    Number.isSafeInteger(identity.ino) &&
    (identity.dev as number) >= 0 &&
    (identity.ino as number) > 0
  );
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const childRelative = relative(parentPath, childPath);
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}

function strictCanonicalPath(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}

function resolveInputPath(
  value: unknown,
  label: "cwd" | "agent directory",
  diagnostics: ProjectCustomAgentDiagnostic[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    diagnostics.push({
      code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
      message: `Project custom-agent ${label} must be a non-empty path.`,
    });
    return undefined;
  }
  try {
    const resolved = resolve(value);
    if (resolved.includes("\0")) throw new Error("path contains a NUL byte");
    return resolved;
  } catch (error) {
    diagnostics.push({
      code: label === "cwd" ? "invalid-cwd" : "invalid-agent-dir",
      message: `Could not resolve project custom-agent ${label} '${value}': ${errorMessage(error)}`,
    });
    return undefined;
  }
}

function inspectDirectory(
  parentDirectory: string,
  name: string,
  diagnostics: ProjectCustomAgentDiagnostic[],
): {
  path?: string;
  identity?: ProjectCustomAgentFileIdentity;
  present: boolean;
  blocked: boolean;
} {
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDirectory);
  } catch (error) {
    if (isMissingError(error)) return { present: false, blocked: false };
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Could not inspect project custom-agent directory '${join(parentDirectory, name)}': ${errorMessage(error)}`,
      path: join(parentDirectory, name),
    });
    return { present: false, blocked: true };
  }
  if (!entries.includes(name)) return { present: false, blocked: false };

  const directoryPath = join(parentDirectory, name);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    if (isMissingError(error)) return { present: false, blocked: false };
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Could not inspect project custom-agent directory '${directoryPath}': ${errorMessage(error)}`,
      path: directoryPath,
    });
    return { present: false, blocked: true };
  }
  if (stat.isSymbolicLink()) {
    diagnostics.push({
      code: "symlink-directory",
      message: `Project custom-agent directory '${directoryPath}' is a symlink; refusing to inspect it.`,
      path: directoryPath,
    });
    return { present: true, blocked: true };
  }
  if (!stat.isDirectory()) {
    diagnostics.push({
      code: "invalid-directory",
      message: `Project custom-agent path '${directoryPath}' is not a directory; refusing to inspect it.`,
      path: directoryPath,
    });
    return { present: true, blocked: true };
  }
  const identity = fileIdentity(stat);
  if (!identity) {
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Project custom-agent directory '${directoryPath}' has no provable filesystem identity.`,
      path: directoryPath,
    });
    return { present: true, blocked: true };
  }
  return { path: directoryPath, identity, present: true, blocked: false };
}

function parseSimpleFrontmatter(content: string): Record<string, string> | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const lines = normalized.split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return undefined;
  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!match || match[1]?.length !== 0) continue;
    const key = match[2];
    if (!key || !FRONTMATTER_KEY_PATTERN.test(key)) continue;
    let value = match[3]?.trim() ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return frontmatter;
}

function validateCustomFrontmatter(
  file: ProjectCustomAgentFile,
  content: string,
  diagnostics: ProjectCustomAgentDiagnostic[],
): boolean {
  const frontmatter = parseSimpleFrontmatter(content);
  const expectedSlug = file.filename.slice(0, -3).toLowerCase();
  const expectedRuntimeName = `${PROJECT_CUSTOM_AGENT_RUNTIME_PREFIX}${expectedSlug}`;
  if (!frontmatter) {
    diagnostics.push({
      code: "invalid-frontmatter",
      message: `Project custom-agent file '${file.path}' must contain a valid frontmatter block with package: embedded, name, and description.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (frontmatter.package !== "embedded") {
    diagnostics.push({
      code: "invalid-frontmatter",
      message: `Project custom-agent file '${file.path}' must declare package: embedded.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (frontmatter.name !== expectedSlug || !CUSTOM_AGENT_SLUG_PATTERN.test(frontmatter.name)) {
    diagnostics.push({
      code: "invalid-frontmatter",
      message: `Project custom-agent file '${file.path}' must declare name: ${expectedSlug}, matching its uppercase filename stem.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (!frontmatter.description?.trim()) {
    diagnostics.push({
      code: "invalid-frontmatter",
      message: `Project custom-agent file '${file.path}' must declare a non-empty description.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (
    Object.hasOwn(frontmatter, "extensions") ||
    Object.hasOwn(frontmatter, "subagentOnlyExtensions")
  ) {
    diagnostics.push({
      code: "unsupported-extension",
      message: `Project custom-agent file '${file.path}' may not declare extensions or subagentOnlyExtensions.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (
    frontmatter.acceptanceRole !== undefined &&
    frontmatter.acceptanceRole !== "read-only" &&
    frontmatter.acceptanceRole !== "writer"
  ) {
    diagnostics.push({
      code: "invalid-frontmatter",
      message: `Project custom-agent file '${file.path}' has invalid acceptanceRole; expected read-only or writer.`,
      path: file.path,
      runtimeName: expectedRuntimeName,
    });
    return false;
  }
  if (frontmatter.maxExecutionTimeMs !== undefined && frontmatter.maxExecutionTimeMs.trim()) {
    const value = Number(frontmatter.maxExecutionTimeMs);
    if (!Number.isSafeInteger(value) || value <= 0) {
      diagnostics.push({
        code: "invalid-frontmatter",
        message: `Project custom-agent file '${file.path}' has invalid maxExecutionTimeMs; expected a positive safe integer.`,
        path: file.path,
        runtimeName: expectedRuntimeName,
      });
      return false;
    }
  }
  if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frontmatter.toolBudget);
    } catch {
      parsed = undefined;
    }
    const budget = parsed as
      | {
          hard?: unknown;
          soft?: unknown;
          block?: unknown;
        }
      | undefined;
    const validBudget =
      budget !== undefined &&
      typeof budget === "object" &&
      budget !== null &&
      !Array.isArray(budget) &&
      typeof budget.hard === "number" &&
      Number.isInteger(budget.hard) &&
      budget.hard >= 1 &&
      (budget.soft === undefined ||
        (typeof budget.soft === "number" &&
          Number.isInteger(budget.soft) &&
          budget.soft >= 1 &&
          budget.soft <= budget.hard)) &&
      (budget.block === undefined ||
        budget.block === "*" ||
        (Array.isArray(budget.block) &&
          budget.block.length > 0 &&
          budget.block.every((item) => typeof item === "string" && item.trim())));
    if (!validBudget) {
      diagnostics.push({
        code: "invalid-frontmatter",
        message: `Project custom-agent file '${file.path}' has invalid toolBudget frontmatter.`,
        path: file.path,
        runtimeName: expectedRuntimeName,
      });
      return false;
    }
  }
  return true;
}

function readBoundedCustomFile(input: {
  filePath: string;
  root: string;
  directories: Array<{ path: string; identity: ProjectCustomAgentFileIdentity }>;
  initialIdentity: ProjectCustomAgentFileIdentity;
  runtimeName: string;
  filename: string;
  diagnostics: ProjectCustomAgentDiagnostic[];
}): ProjectCustomAgentFile | undefined {
  const { filePath, root, directories, initialIdentity, runtimeName, filename, diagnostics } =
    input;
  let descriptor: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (typeof noFollow !== "number" || noFollow === 0) {
      diagnostics.push({
        code: "file-read-failed",
        message: `Could not safely read project custom-agent file '${filePath}': O_NOFOLLOW is unavailable.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    for (const directory of directories) {
      const stat = fs.lstatSync(directory.path);
      const identity = fileIdentity(stat);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        diagnostics.push({
          code: stat.isSymbolicLink() ? "symlink-directory" : "invalid-directory",
          message: `Project custom-agent directory '${directory.path}' changed before it could be read; refusing to inspect it.`,
          path: directory.path,
          runtimeName,
        });
        return undefined;
      }
      if (!identity || !sameIdentity(directory.identity, identity)) {
        diagnostics.push({
          code: "file-read-failed",
          message: `Project custom-agent directory '${directory.path}' changed while file '${filePath}' was being opened.`,
          path: filePath,
          runtimeName,
        });
        return undefined;
      }
    }

    const canonicalRoot = strictCanonicalPath(root);
    const canonicalFile = strictCanonicalPath(filePath);
    const canonicalCustom = strictCanonicalPath(dirname(filePath));
    if (
      !canonicalRoot ||
      !canonicalFile ||
      !canonicalCustom ||
      !isPathWithin(canonicalRoot, canonicalCustom) ||
      !isPathWithin(canonicalRoot, canonicalFile) ||
      dirname(canonicalFile) !== canonicalCustom ||
      canonicalCustom !== join(canonicalRoot, PROJECT_CUSTOM_AGENT_DIRECTORY)
    ) {
      diagnostics.push({
        code: "file-read-failed",
        message: `Project custom-agent file '${filePath}' no longer resolves directly under the validated Git root custom-agent directory.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }

    const descriptorStat = fs.fstatSync(descriptor);
    const descriptorIdentity = fileIdentity(descriptorStat);
    const currentLstat = fs.lstatSync(filePath);
    if (currentLstat.isSymbolicLink() || !currentLstat.isFile()) {
      diagnostics.push({
        code: currentLstat.isSymbolicLink() ? "symlink-file" : "non-regular-file",
        message: `Project custom-agent file '${filePath}' changed to a non-regular file before it could be read.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }
    const currentStat = fs.statSync(canonicalFile);
    const currentIdentity = fileIdentity(currentStat);
    if (
      !descriptorIdentity ||
      !currentIdentity ||
      !sameIdentity(descriptorIdentity, currentIdentity)
    ) {
      diagnostics.push({
        code: "file-read-failed",
        message: `Project custom-agent file '${filePath}' changed while it was being opened; refusing to use a substituted file.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }
    if (!sameIdentity(initialIdentity, descriptorIdentity)) {
      diagnostics.push({
        code: "file-read-failed",
        message: `Project custom-agent file '${filePath}' changed while it was being validated.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }
    if (descriptorStat.size > PROJECT_CUSTOM_AGENT_MAX_BYTES) {
      diagnostics.push({
        code: "file-too-large",
        message: `Project custom-agent file '${filePath}' is larger than ${PROJECT_CUSTOM_AGENT_MAX_BYTES} bytes (64 KiB); refusing to read it.`,
        path: filePath,
        runtimeName,
      });
      return undefined;
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= PROJECT_CUSTOM_AGENT_MAX_BYTES) {
      const remaining = PROJECT_CUSTOM_AGENT_MAX_BYTES + 1 - bytesRead;
      if (remaining <= 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(8192, remaining));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      bytesRead += count;
      if (bytesRead > PROJECT_CUSTOM_AGENT_MAX_BYTES) {
        diagnostics.push({
          code: "file-too-large",
          message: `Project custom-agent file '${filePath}' grew beyond ${PROJECT_CUSTOM_AGENT_MAX_BYTES} bytes (64 KiB) while being read; refusing to use it.`,
          path: filePath,
          runtimeName,
        });
        return undefined;
      }
    }
    const content = Buffer.concat(chunks, bytesRead).toString("utf8");
    const file: ProjectCustomAgentFile = {
      runtimeName,
      filename,
      path: canonicalFile,
      content,
      binding: {
        runtimeName,
        filename,
        worktreeRoot: canonicalRoot,
        canonicalPath: canonicalFile,
        identity: descriptorIdentity,
      },
    };
    return validateCustomFrontmatter(file, content, diagnostics) ? file : undefined;
  } catch (error) {
    diagnostics.push({
      code: errorCode(error) === "ELOOP" ? "symlink-file" : "file-read-failed",
      message: `Could not safely read project custom-agent file '${filePath}': ${errorMessage(error)}`,
      path: filePath,
      runtimeName,
    });
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best-effort close after a fail-closed read.
      }
    }
  }
}

function inspectTrust(
  cwd: string,
  root: string,
  agentDir: string,
  diagnostics: ProjectCustomAgentDiagnostic[],
): { trust: ProjectCustomAgentTrustState; decision: ProjectTrustDecision; entryPath?: string } {
  try {
    const entry = new ProjectTrustStore(agentDir).getEntry(cwd);
    const decision = entry?.decision ?? null;
    const entryPath = entry?.path;
    if (decision !== true) {
      diagnostics.push({
        code: "project-not-trusted",
        message: `Project custom-agent execution is disabled because persisted project trust is not granted for '${cwd}'. Run \`/trust\`, persist the decision, then retry.`,
        path: cwd,
      });
      return {
        trust: decision === false ? "denied" : "undecided",
        decision,
        ...(entryPath ? { entryPath } : {}),
      };
    }
    const canonicalBoundary = entryPath ? strictCanonicalPath(entryPath) : undefined;
    if (
      !canonicalBoundary ||
      canonicalBoundary !== entryPath ||
      !isPathWithin(canonicalBoundary, root)
    ) {
      diagnostics.push({
        code: "project-not-trusted",
        message: `Project custom-agent execution is disabled because persisted trust does not cover validated Git root '${root}'. Run \`/trust\` for the repository root, persist the decision, then retry.`,
        path: root,
      });
      return {
        trust: "denied",
        decision: false,
        ...(entryPath ? { entryPath } : {}),
      };
    }
    return { trust: "trusted", decision, entryPath };
  } catch (error) {
    diagnostics.push({
      code: "trust-inspection-failed",
      message: `Could not inspect persisted project trust for '${cwd}': ${errorMessage(error)} Project custom-agent execution remains disabled until a readable persisted trust decision is available.`,
      path: agentDir,
    });
    return { trust: "unavailable", decision: null };
  }
}

/**
 * Discover only direct uppercase-slug files under the validated worktree root.
 * No other Pi/TLH agent directory is consulted by this inventory.
 */
export function inventoryProjectCustomAgents(
  cwdInput: unknown,
  agentDirInput: unknown = getAgentDir(),
): ProjectCustomAgentInventory {
  const diagnostics: ProjectCustomAgentDiagnostic[] = [];
  const cwd = resolveInputPath(cwdInput, "cwd", diagnostics);
  const agentDir = resolveInputPath(agentDirInput, "agent directory", diagnostics);
  const inventory: ProjectCustomAgentInventory = {
    cwd: cwd ?? "",
    trust: "unavailable",
    trustDecision: null,
    files: [],
    diagnostics,
  };
  if (!cwd || !agentDir) return inventory;

  const root = resolveValidatedGitWorktreeRoot(cwd);
  // A missing or malformed Git worktree is a normal no-candidate result for
  // ordinary management/discovery calls. Primary authorization adds the
  // actionable root-specific error when an embedded target is requested.
  if (!root) return inventory;
  inventory.worktreeRoot = root;
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Could not inspect validated Git worktree root '${root}': ${errorMessage(error)}`,
      path: root,
    });
    return inventory;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    diagnostics.push({
      code: rootStat.isSymbolicLink() ? "symlink-directory" : "invalid-directory",
      message: `Validated Git worktree root '${root}' is not a stable regular directory; refusing project custom-agent discovery.`,
      path: root,
    });
    return inventory;
  }
  const rootIdentity = fileIdentity(rootStat);
  if (!rootIdentity) {
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Validated Git worktree root '${root}' has no provable filesystem identity.`,
      path: root,
    });
    return inventory;
  }

  const tlhCheck = inspectDirectory(root, ".tlh", diagnostics);
  if (!tlhCheck.present || tlhCheck.blocked || !tlhCheck.path || !tlhCheck.identity)
    return inventory;
  const agentsCheck = inspectDirectory(tlhCheck.path, "agents", diagnostics);
  if (!agentsCheck.present || agentsCheck.blocked || !agentsCheck.path || !agentsCheck.identity)
    return inventory;
  const customCheck = inspectDirectory(agentsCheck.path, "custom", diagnostics);
  if (!customCheck.present || customCheck.blocked || !customCheck.path || !customCheck.identity)
    return inventory;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(customCheck.path, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      code: "directory-inspection-failed",
      message: `Could not inspect project custom-agent directory '${customCheck.path}': ${errorMessage(error)}`,
      path: customCheck.path,
    });
    return inventory;
  }
  const candidateEntries = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (candidateEntries.length === 0) return inventory;

  const trust = inspectTrust(cwd, root, agentDir, diagnostics);
  inventory.trust = trust.trust;
  inventory.trustDecision = trust.decision;
  inventory.trustEntryPath = trust.entryPath;
  if (trust.trust !== "trusted") {
    for (const entry of candidateEntries) {
      if (!CUSTOM_AGENT_FILENAME_PATTERN.test(entry.name)) continue;
      const stem = entry.name.slice(0, -3).toLowerCase();
      inventory.files.push({
        runtimeName: `${PROJECT_CUSTOM_AGENT_RUNTIME_PREFIX}${stem}`,
        filename: entry.name,
        path: join(customCheck.path, entry.name),
      });
    }
    return inventory;
  }

  const directories = [
    { path: root, identity: rootIdentity },
    { path: tlhCheck.path, identity: tlhCheck.identity },
    { path: agentsCheck.path, identity: agentsCheck.identity },
    { path: customCheck.path, identity: customCheck.identity },
  ].filter(
    (directory): directory is { path: string; identity: ProjectCustomAgentFileIdentity } =>
      directory.identity !== undefined,
  );
  for (const entry of candidateEntries) {
    const entryPath = join(customCheck.path, entry.name);
    if (!CUSTOM_AGENT_FILENAME_PATTERN.test(entry.name)) {
      diagnostics.push({
        code: "invalid-filename",
        message: `Project custom-agent file '${entryPath}' has an invalid filename; use <UPPERCASE-SLUG>.md with an uppercase stem.`,
        path: entryPath,
      });
      continue;
    }
    const stem = entry.name.slice(0, -3);
    const runtimeName = `${PROJECT_CUSTOM_AGENT_RUNTIME_PREFIX}${stem.toLowerCase()}`;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch (error) {
      diagnostics.push({
        code: isMissingError(error) ? "file-inspection-failed" : "file-inspection-failed",
        message: `Could not inspect project custom-agent file '${entryPath}': ${errorMessage(error)}`,
        path: entryPath,
        runtimeName,
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      diagnostics.push({
        code: "symlink-file",
        message: `Project custom-agent file '${entryPath}' is a symlink; refusing to use it.`,
        path: entryPath,
        runtimeName,
      });
      continue;
    }
    if (!stat.isFile()) {
      diagnostics.push({
        code: "non-regular-file",
        message: `Project custom-agent path '${entryPath}' is not a regular file; refusing to use it.`,
        path: entryPath,
        runtimeName,
      });
      continue;
    }
    if (stat.size > PROJECT_CUSTOM_AGENT_MAX_BYTES) {
      diagnostics.push({
        code: "file-too-large",
        message: `Project custom-agent file '${entryPath}' is larger than ${PROJECT_CUSTOM_AGENT_MAX_BYTES} bytes (64 KiB); refusing to use it.`,
        path: entryPath,
        runtimeName,
      });
      continue;
    }
    const initialIdentity = fileIdentity(stat);
    if (!initialIdentity) {
      diagnostics.push({
        code: "file-inspection-failed",
        message: `Project custom-agent file '${entryPath}' has no provable filesystem identity.`,
        path: entryPath,
        runtimeName,
      });
      continue;
    }
    const file = readBoundedCustomFile({
      filePath: entryPath,
      root,
      directories,
      initialIdentity,
      runtimeName,
      filename: entry.name,
      diagnostics,
    });
    if (file) inventory.files.push(file);
  }
  return inventory;
}

export function isProjectCustomAgentRuntimeName(value: unknown): value is string {
  return typeof value === "string" && EMBEDDED_RUNTIME_NAME_PATTERN.test(value.trim());
}

export function customAgentFileForRuntimeName(
  inventory: ProjectCustomAgentInventory,
  runtimeName: string,
): ProjectCustomAgentFile | undefined {
  if (!EMBEDDED_RUNTIME_NAME_PATTERN.test(runtimeName)) return undefined;
  return inventory.files.find((file) => file.runtimeName === runtimeName);
}

export function sameProjectCustomAgentBinding(
  left: ProjectCustomAgentBinding | undefined,
  right: ProjectCustomAgentBinding | undefined,
): boolean {
  if (!isProjectCustomAgentBinding(left) || !isProjectCustomAgentBinding(right)) return false;
  return Boolean(
    left.runtimeName === right.runtimeName &&
    left.filename === right.filename &&
    left.worktreeRoot === right.worktreeRoot &&
    left.canonicalPath === right.canonicalPath &&
    sameIdentity(left.identity, right.identity),
  );
}

/** Re-check one serialized binding before a detached child is started. */
export function validateProjectCustomAgentBinding(
  bindingInput: unknown,
  cwdInput: unknown,
  agentDirInput: unknown = getAgentDir(),
): { valid: true } | { valid: false; error: string } {
  if (!isProjectCustomAgentBinding(bindingInput)) {
    return { valid: false, error: "the serialized project custom-agent binding is malformed" };
  }
  const binding = bindingInput;
  const inventory = inventoryProjectCustomAgents(cwdInput, agentDirInput);
  const current = customAgentFileForRuntimeName(inventory, binding.runtimeName);
  if (!current?.binding || !sameProjectCustomAgentBinding(current.binding, binding)) {
    const diagnostic = inventory.diagnostics.find(
      (candidate) => candidate.runtimeName === binding.runtimeName,
    );
    return {
      valid: false,
      error:
        diagnostic?.message ??
        `Project custom-agent binding for '${binding.runtimeName}' no longer matches the exact trusted file '${binding.canonicalPath}'.`,
    };
  }
  return { valid: true };
}

function normalizeDispatchPath(value: unknown, baseCwd = process.cwd()): string {
  const raw = typeof value === "string" && value.trim() ? value : baseCwd;
  const absolute = resolve(baseCwd, raw);
  return strictCanonicalPath(absolute) ?? absolute;
}

function targetEntries(input: unknown, runtimeCwd: string): ProjectCustomAgentDispatchBinding[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const normalizedRuntimeCwd = normalizeDispatchPath(runtimeCwd);
  const baseCwd = normalizeDispatchPath(record.cwd, normalizedRuntimeCwd);
  const entries: Array<{ target: string; taskIndex?: number; cwd: string }> = [];
  if (typeof record.agent === "string" && EMBEDDED_RUNTIME_NAME_PATTERN.test(record.agent.trim())) {
    entries.push({ target: record.agent.trim(), cwd: baseCwd });
  }
  if (Array.isArray(record.tasks)) {
    record.tasks.forEach((task, taskIndex) => {
      if (typeof task !== "object" || task === null || Array.isArray(task)) return;
      const taskRecord = task as Record<string, unknown>;
      if (typeof taskRecord.agent !== "string") return;
      const target = taskRecord.agent.trim();
      if (!EMBEDDED_RUNTIME_NAME_PATTERN.test(target)) return;
      const cwd =
        typeof taskRecord.cwd === "string" && taskRecord.cwd.trim()
          ? normalizeDispatchPath(taskRecord.cwd, baseCwd)
          : baseCwd;
      entries.push({ target, taskIndex, cwd });
    });
  }
  return entries as ProjectCustomAgentDispatchBinding[];
}

/**
 * Resolve all embedded targets against one validated root and return runtime-owned
 * exact-file bindings. Callers must treat a missing binding as authorization failure.
 */
export function authorizeProjectCustomAgentInput(
  input: unknown,
  runtimeCwd: string,
  agentDirInput: unknown = getAgentDir(),
): { authorization?: ProjectCustomAgentAuthorization; error?: string } {
  const entries = targetEntries(input, runtimeCwd);
  if (entries.length === 0) return {};
  const dispatchRoot = resolveValidatedGitWorktreeRoot(runtimeCwd);
  if (!dispatchRoot) {
    return {
      error: `No validated Git worktree root was found for dispatch cwd '${runtimeCwd}'; project custom-agent execution is disabled.`,
    };
  }
  const bindings: ProjectCustomAgentDispatchBinding[] = [];
  let worktreeRoot: string | undefined;
  for (const entry of entries) {
    const inventory = inventoryProjectCustomAgents(entry.cwd, agentDirInput);
    const file = customAgentFileForRuntimeName(inventory, entry.target);
    if (!file?.binding) {
      const detail = inventory.diagnostics.find(
        (diagnostic) => diagnostic.runtimeName === entry.target,
      )?.message;
      const trustGuidance =
        inventory.trust === "denied"
          ? " Persisted trust for this Git root is denied; run /trust in this project to approve it, then retry the delegation."
          : inventory.trust === "undecided"
            ? " No persisted trust decision exists for this Git root; run /trust in this project to approve it, then retry the delegation."
            : "";
      return {
        error:
          detail ??
          `No valid trusted project custom-agent file was found for '${entry.target}' under the validated Git root. Expected .tlh/agents/custom/${entry.target.slice("embedded.".length).toUpperCase()}.md.${trustGuidance}`,
      };
    }
    if (dispatchRoot !== file.binding.worktreeRoot) {
      return {
        error: `Embedded target '${entry.target}' resolved to Git root '${file.binding.worktreeRoot}', but dispatch cwd '${runtimeCwd}' is under '${dispatchRoot}'. Cwd overrides for embedded agents must remain inside one validated Git worktree root.`,
      };
    }
    if (worktreeRoot && worktreeRoot !== file.binding.worktreeRoot) {
      return {
        error: `Embedded targets in one dispatch must share one validated Git worktree root; '${entry.target}' resolved to '${file.binding.worktreeRoot}' while another target resolved to '${worktreeRoot}'.`,
      };
    }
    worktreeRoot = file.binding.worktreeRoot;
    bindings.push({ ...entry, binding: file.binding });
  }
  return { authorization: { bindings } };
}

export function setProjectCustomAgentAuthorization(
  toolCallId: unknown,
  input: unknown,
  authorization: ProjectCustomAgentAuthorization,
): void {
  pruneProjectCustomAgentAuthorizations();
  if (typeof toolCallId === "string" && toolCallId.trim()) {
    authorizationByToolCallId.set(toolCallId, {
      authorization,
      expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
    });
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    authorizationByInput.set(input, authorization);
  }
  pruneProjectCustomAgentAuthorizations();
}

export function takeProjectCustomAgentAuthorization(
  toolCallId: unknown,
  input: unknown,
): ProjectCustomAgentAuthorization | undefined {
  pruneProjectCustomAgentAuthorizations();
  let authorization: ProjectCustomAgentAuthorization | undefined;
  if (typeof toolCallId === "string" && toolCallId.trim()) {
    const stored = authorizationByToolCallId.get(toolCallId);
    authorization = stored?.authorization;
    authorizationByToolCallId.delete(toolCallId);
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const inputAuthorization = authorizationByInput.get(input);
    authorization ??= inputAuthorization;
    authorizationByInput.delete(input);
  }
  return authorization;
}

export function clearProjectCustomAgentAuthorization(toolCallId: unknown): void {
  pruneProjectCustomAgentAuthorizations();
  if (typeof toolCallId === "string" && toolCallId.trim()) {
    authorizationByToolCallId.delete(toolCallId);
  }
}

/** @internal Exported for focused filesystem tests. */
export const __testing = {
  parseSimpleFrontmatter,
  validateCustomFrontmatter,
  targetEntries,
  authorizationByToolCallIdSize: () => {
    pruneProjectCustomAgentAuthorizations();
    return authorizationByToolCallId.size;
  },
};
