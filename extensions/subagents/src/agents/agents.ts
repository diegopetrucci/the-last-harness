/**
 * Agent discovery and configuration
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AcceptanceInput,
  AcceptanceRole,
  OutputMode,
  ToolBudgetConfig,
} from "../shared/types.ts";
import { expandTildePath, getLegacyGlobalAgentsDir, isGlobalAgentsDir } from "../shared/profile.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import { parseModelScopeConfig, type ModelScopeConfig } from "../runs/shared/model-scope.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { isPositiveSafeInteger } from "./execution-ceiling.ts";

export type AgentScope = "user" | "project" | "both";

type AgentSource = "builtin" | "package" | "user" | "project";
type SystemPromptMode = "append" | "replace";
type AgentDefaultContext = "fresh" | "fork";

function defaultSystemPromptMode(name: string): SystemPromptMode {
  return name === "delegate" ? "append" : "replace";
}

function defaultInheritProjectContext(name: string): boolean {
  return name === "delegate";
}

function defaultInheritSkills(): boolean {
  return false;
}

const KNOWN_FIELDS = new Set([
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

interface BuiltinAgentOverrideBase {
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: AgentDefaultContext;
  acceptanceRole?: AcceptanceRole;
  disabled?: boolean;
  systemPrompt: string;
  skills?: string[];
  tools?: string[];
  subagentOnlyExtensions?: string[];
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
  maxExecutionTimeMs?: number;
}

interface BuiltinAgentOverrideConfig {
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: string | false;
  systemPromptMode?: SystemPromptMode;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: AgentDefaultContext | false;
  acceptanceRole?: AcceptanceRole | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  subagentOnlyExtensions?: string[] | false;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig | false;
  maxExecutionTimeMs?: number | false;
}

interface BuiltinAgentOverrideInfo {
  scope: "user" | "project";
  path: string;
  base: BuiltinAgentOverrideBase;
}

interface AgentModelSourceInfo {
  type: "subagents.defaultModel";
  scope: "user" | "project";
  path: string;
  model: string;
}

export interface AgentConfig {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  defaultContext?: AgentDefaultContext;
  acceptanceRole?: AcceptanceRole;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  skills?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  output?: string;
  defaultReads?: string[];
  defaultProgress?: boolean;
  interactive?: boolean;
  maxSubagentDepth?: number;
  completionGuard?: boolean;
  toolBudget?: ToolBudgetConfig;
  maxExecutionTimeMs?: number;
  disabled?: boolean;
  extraFields?: Record<string, string>;
  override?: BuiltinAgentOverrideInfo;
  modelSource?: AgentModelSourceInfo;
}

interface SubagentSettings {
  overrides: Record<string, BuiltinAgentOverrideConfig>;
  defaultModel?: string;
  agentDirs?: string[];
  modelScope?: ModelScopeConfig;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };
const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

interface ChainStepConfig {
  agent?: string;
  task?: string;
  phase?: string;
  label?: string;
  as?: string;
  outputSchema?: string | Record<string, unknown>;
  output?: string | false;
  outputMode?: OutputMode;
  reads?: string[] | false;
  model?: string;
  skills?: string[] | false;
  progress?: boolean;
  parallel?: unknown;
  expand?: unknown;
  collect?: unknown;
  concurrency?: number;
  failFast?: boolean;
  acceptance?: AcceptanceInput;
  toolBudget?: ToolBudgetConfig;
}

export interface ChainConfig {
  name: string;
  localName?: string;
  packageName?: string;
  description: string;
  source: AgentSource;
  filePath: string;
  steps: ChainStepConfig[];
  extraFields?: Record<string, string>;
}

interface ChainDiscoveryDiagnostic {
  source: AgentSource;
  filePath: string;
  error: string;
}

interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  modelScope?: ModelScopeConfig;
}

function getUserChainDir(): string {
  return path.join(getAgentDir(), "chains");
}

interface PackageSubagentPaths {
  agents: string[];
}

let cachedGlobalNpmRoot: string | null = null;

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function readJsonFileBestEffort(filePath: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    // Installed package scans are opportunistic; bad third-party manifests
    // should not break local agent discovery.
    return null;
  }
}

function readOptionalJsonFile(filePath: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isJsonValue(parsed) ? parsed : null;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function isSafePackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function parseNpmPackageName(source: string): string | undefined {
  const spec = source.slice(4).trim();
  if (!spec) return undefined;
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const packageName = match?.[1] ?? spec;
  return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
  const atIndex = repoPath.indexOf("@");
  const hashIndex = repoPath.indexOf("#");
  const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
  const spec = source.slice(4).trim();
  if (!spec) return undefined;

  let host: string;
  let repoPath: string;
  const scpLike = spec.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1] ?? "";
    repoPath = scpLike[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    try {
      const url = new URL(spec);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else {
    const slashIndex = spec.indexOf("/");
    if (slashIndex < 0) return undefined;
    host = spec.slice(0, slashIndex);
    repoPath = spec.slice(slashIndex + 1);
  }

  const normalizedPath = stripGitRef(repoPath)
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (
    !host ||
    !isSafePackagePath(host) ||
    !isSafePackagePath(normalizedPath) ||
    normalizedPath.split(/[\\/]/).length < 2
  ) {
    return undefined;
  }
  return { host, repoPath: normalizedPath };
}

function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("git:")) {
    const parsed = parseGitPackagePath(trimmed);
    return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
  }
  if (trimmed.startsWith("npm:")) {
    const packageName = parseNpmPackageName(trimmed);
    return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
  }
  const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
  if (path.isAbsolute(normalized)) return normalized;
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("./") ||
    normalized.startsWith("../")
  ) {
    return path.resolve(baseDir, normalized);
  }
  return undefined;
}

function getGlobalNpmRoot(): string | null {
  if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot;
  try {
    cachedGlobalNpmRoot = fs.realpathSync(
      execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim(),
    );
    return cachedGlobalNpmRoot;
  } catch {
    cachedGlobalNpmRoot = "";
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function getPackageSubagentConfigRoots(packageRoot: string): Record<string, unknown>[] {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const pkg = readJsonFileBestEffort(packageJsonPath);
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];

  const roots: Record<string, unknown>[] = [];
  const piSubagents = (pkg as { "pi-subagents"?: unknown })["pi-subagents"];
  if (piSubagents && typeof piSubagents === "object" && !Array.isArray(piSubagents)) {
    roots.push(piSubagents as Record<string, unknown>);
  }

  const pi = (pkg as { pi?: unknown }).pi;
  if (pi && typeof pi === "object" && !Array.isArray(pi)) {
    const subagents = (pi as { subagents?: unknown }).subagents;
    if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) {
      roots.push(subagents as Record<string, unknown>);
    }
  }

  return roots;
}

function hasPackageSubagentConfig(packageRoot: string): boolean {
  return getPackageSubagentConfigRoots(packageRoot).some(
    (root) => stringArray(root.agents).length > 0,
  );
}

function extractSubagentPathsFromPackageRoot(packageRoot: string): PackageSubagentPaths {
  const roots = getPackageSubagentConfigRoots(packageRoot);
  const agents: string[] = [];
  for (const root of roots) {
    for (const entry of stringArray(root.agents)) agents.push(path.resolve(packageRoot, entry));
  }
  return { agents };
}

function collectPackageRootsFromNodeModules(nodeModulesDir: string): string[] {
  const roots: string[] = [];
  if (!fs.existsSync(nodeModulesDir)) return roots;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return roots;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopeEntries: fs.Dirent[];
      try {
        scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopeEntry of scopeEntries) {
        if (scopeEntry.name.startsWith(".")) continue;
        if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
        roots.push(path.join(scopeDir, scopeEntry.name));
      }
      continue;
    }

    roots.push(path.join(nodeModulesDir, entry.name));
  }
  return roots;
}

function collectSettingsPackageRoots(settingsFile: string, baseDir: string): string[] {
  const settings = readOptionalJsonFile(settingsFile);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [];
  const packages = (settings as { packages?: unknown }).packages;
  if (!Array.isArray(packages)) return [];

  const roots: string[] = [];
  for (const entry of packages) {
    const packageSource =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { source?: unknown }).source === "string"
          ? (entry as { source: string }).source
          : undefined;
    if (!packageSource) continue;
    const packageRoot = resolveSettingsPackageRoot(packageSource, baseDir);
    if (packageRoot) roots.push(packageRoot);
  }
  return roots;
}

function findNearestPackageSubagentRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    if (hasPackageSubagentConfig(currentDir)) return currentDir;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function collectPackageSubagentPaths(
  cwd: string,
  options: { includeUser: boolean; includeProject: boolean } = {
    includeUser: true,
    includeProject: true,
  },
): PackageSubagentPaths {
  const agentDir = getAgentDir();
  const projectRoot = findNearestProjectRoot(cwd) ?? findNearestPackageSubagentRoot(cwd) ?? cwd;
  const packageRoots = [projectRoot];

  if (options.includeProject) {
    const projectConfigDir = getProjectConfigDir(projectRoot);
    packageRoots.push(
      ...collectPackageRootsFromNodeModules(path.join(projectConfigDir, "npm", "node_modules")),
      ...collectSettingsPackageRoots(
        path.join(projectConfigDir, "settings.json"),
        projectConfigDir,
      ),
    );
  }

  if (options.includeUser) {
    packageRoots.push(
      ...collectPackageRootsFromNodeModules(path.join(agentDir, "npm", "node_modules")),
      ...collectSettingsPackageRoots(path.join(agentDir, "settings.json"), agentDir),
    );
  }

  if (options.includeUser) {
    const globalRoot = getGlobalNpmRoot();
    if (globalRoot) packageRoots.push(...collectPackageRootsFromNodeModules(globalRoot));
  }

  const seenRoots = new Set<string>();
  const seenAgents = new Set<string>();
  const agents: string[] = [];
  for (const packageRoot of packageRoots) {
    const resolvedRoot = path.resolve(packageRoot);
    if (seenRoots.has(resolvedRoot)) continue;
    seenRoots.add(resolvedRoot);
    const paths = extractSubagentPathsFromPackageRoot(resolvedRoot);
    for (const agentDir of paths.agents) {
      if (seenAgents.has(agentDir)) continue;
      seenAgents.add(agentDir);
      agents.push(agentDir);
    }
  }
  return { agents };
}

function splitToolList(rawTools: string[] | undefined): { tools?: string[] } {
  const tools = (rawTools ?? []).filter((tool) => !tool.startsWith("mcp:"));
  return tools.length > 0 ? { tools } : {};
}

function parsePositiveIntegerFrontmatter(
  value: string | undefined,
  field: string,
  label: string,
): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!isPositiveSafeInteger(parsed)) {
    throw new Error(`${label} has invalid ${field} frontmatter; expected a positive safe integer.`);
  }
  return parsed;
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
  return {
    model: agent.model,
    fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
    thinking: agent.thinking,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    defaultContext: agent.defaultContext,
    acceptanceRole: agent.acceptanceRole,
    disabled: agent.disabled,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills ? [...agent.skills] : undefined,
    tools: agent.tools ? [...agent.tools] : undefined,
    subagentOnlyExtensions: agent.subagentOnlyExtensions
      ? [...agent.subagentOnlyExtensions]
      : undefined,
    completionGuard: agent.completionGuard,
    toolBudget: agent.toolBudget,
    maxExecutionTimeMs: agent.maxExecutionTimeMs,
  };
}

function findNearestProjectRoot(cwd: string): string | null {
  const ignoredProjectConfigDirs = new Set([
    path.resolve(path.dirname(getAgentDir())),
    path.resolve(getProjectConfigDir(os.homedir())),
  ]);
  let currentDir = cwd;
  while (true) {
    const legacyProjectDir = path.join(currentDir, ".agents");
    const hasLegacyProjectDir =
      isDirectory(legacyProjectDir) && !isGlobalAgentsDir(legacyProjectDir);
    const projectConfigDir = getProjectConfigDir(currentDir);
    const hasProjectConfigDir =
      isDirectory(projectConfigDir) &&
      !ignoredProjectConfigDirs.has(path.resolve(projectConfigDir));
    if (hasProjectConfigDir || hasLegacyProjectDir) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function getUserAgentSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

function getProjectAgentSettingsPath(cwd: string): string | null {
  const projectRoot = findNearestProjectRoot(cwd);
  return projectRoot ? path.join(getProjectConfigDir(projectRoot), "settings.json") : null;
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseOverrideStringArrayOrFalse(
  value: unknown,
  meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (!Array.isArray(value)) {
    throw new Error(
      `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
    );
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(
        `Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`,
      );
    }
    const trimmed = item.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

function parseBuiltinOverrideEntry(
  name: string,
  value: unknown,
  filePath: string,
): BuiltinAgentOverrideConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
  }

  const input = value as Record<string, unknown>;
  const override: BuiltinAgentOverrideConfig = {};

  if ("model" in input) {
    if (typeof input.model === "string" || input.model === false) override.model = input.model;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`,
      );
  }

  if ("thinking" in input) {
    if (typeof input.thinking === "string" || input.thinking === false)
      override.thinking = input.thinking;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`,
      );
  }

  if ("systemPromptMode" in input) {
    if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
      override.systemPromptMode = input.systemPromptMode;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`,
      );
    }
  }

  if ("inheritProjectContext" in input) {
    if (typeof input.inheritProjectContext === "boolean") {
      override.inheritProjectContext = input.inheritProjectContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`,
      );
    }
  }

  if ("inheritSkills" in input) {
    if (typeof input.inheritSkills === "boolean") {
      override.inheritSkills = input.inheritSkills;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`,
      );
    }
  }

  if ("defaultContext" in input) {
    if (
      input.defaultContext === "fresh" ||
      input.defaultContext === "fork" ||
      input.defaultContext === false
    ) {
      override.defaultContext = input.defaultContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`,
      );
    }
  }

  if ("acceptanceRole" in input) {
    if (
      input.acceptanceRole === "read-only" ||
      input.acceptanceRole === "writer" ||
      input.acceptanceRole === false
    ) {
      override.acceptanceRole = input.acceptanceRole;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'acceptanceRole'; expected 'read-only', 'writer', or false.`,
      );
    }
  }

  if ("disabled" in input) {
    if (typeof input.disabled === "boolean") {
      override.disabled = input.disabled;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`,
      );
    }
  }

  if ("completionGuard" in input) {
    if (typeof input.completionGuard === "boolean") {
      override.completionGuard = input.completionGuard;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`,
      );
    }
  }

  if ("toolBudget" in input) {
    if (input.toolBudget === false) {
      override.toolBudget = false;
    } else if (
      input.toolBudget &&
      typeof input.toolBudget === "object" &&
      !Array.isArray(input.toolBudget)
    ) {
      override.toolBudget = input.toolBudget as ToolBudgetConfig;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'toolBudget'; expected an object or false.`,
      );
    }
  }

  if ("maxExecutionTimeMs" in input) {
    if (input.maxExecutionTimeMs === false) {
      override.maxExecutionTimeMs = false;
    } else {
      const parsed = input.maxExecutionTimeMs;
      if (!isPositiveSafeInteger(parsed))
        throw new Error(
          `Builtin override '${name}' in '${filePath}' has invalid 'maxExecutionTimeMs'; expected a positive safe integer or false.`,
        );
      override.maxExecutionTimeMs = parsed;
    }
  }

  if ("systemPrompt" in input) {
    if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`,
      );
  }

  const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, {
    filePath,
    name,
    field: "fallbackModels",
  });
  if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

  const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
  if (skills !== undefined) override.skills = skills;

  const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
  if (tools !== undefined) override.tools = tools;

  const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(input.subagentOnlyExtensions, {
    filePath,
    name,
    field: "subagentOnlyExtensions",
  });
  if (subagentOnlyExtensions !== undefined)
    override.subagentOnlyExtensions = subagentOnlyExtensions;

  return Object.keys(override).length > 0 ? override : undefined;
}

function parseSettingsStringArray(
  value: unknown,
  meta: { filePath: string; field: string },
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `Subagent settings in '${meta.filePath}' have invalid '${meta.field}'; expected an array of strings.`,
    );
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(
        `Subagent settings in '${meta.filePath}' have invalid '${meta.field}'; expected an array of strings.`,
      );
    }
    const trimmed = item.trim();
    if (trimmed) items.push(trimmed);
  }
  return items;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
  if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
  const settings = readSettingsFileStrict(filePath);
  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return EMPTY_SUBAGENT_SETTINGS;

  const subagentsObject = subagents as Record<string, unknown>;
  const agentDirs = parseSettingsStringArray(subagentsObject.agentDirs, {
    filePath,
    field: "agentDirs",
  });
  let defaultModel: string | undefined;
  if ("defaultModel" in subagentsObject) {
    if (typeof subagentsObject.defaultModel === "string" && subagentsObject.defaultModel.trim()) {
      defaultModel = subagentsObject.defaultModel.trim();
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`,
      );
    }
  }
  const modelScope = parseModelScopeConfig(subagentsObject.modelScope, { filePath });

  const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
  const agentOverrides = subagentsObject.agentOverrides;
  if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
    return { overrides: parsed, defaultModel, agentDirs, modelScope };
  }
  for (const [name, value] of Object.entries(agentOverrides)) {
    const override = parseBuiltinOverrideEntry(name, value, filePath);
    if (override) parsed[name] = override;
  }
  return { overrides: parsed, defaultModel, agentDirs, modelScope };
}

function resolveSubagentDefaultModel(
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentModelSourceInfo | undefined {
  if (projectSettingsPath && projectSettings.defaultModel !== undefined) {
    return {
      type: "subagents.defaultModel",
      scope: "project",
      path: projectSettingsPath,
      model: projectSettings.defaultModel,
    };
  }
  return userSettings.defaultModel !== undefined
    ? {
        type: "subagents.defaultModel",
        scope: "user",
        path: userSettingsPath,
        model: userSettings.defaultModel,
      }
    : undefined;
}

function applySubagentDefaultModel(
  agents: AgentConfig[],
  defaultModel: AgentModelSourceInfo | undefined,
): AgentConfig[] {
  if (!defaultModel) return agents;
  return agents.map((agent) => {
    if (agent.model !== undefined) return agent;
    const next = { ...agent, model: defaultModel.model, modelSource: defaultModel };
    const frontmatterFields = agentFrontmatterFields.get(agent);
    if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
    return next;
  });
}

function projectScopeUserBuiltinSettings(filePath: string | null): SubagentSettings {
  if (!filePath) return EMPTY_SUBAGENT_SETTINGS;

  let settings: Record<string, unknown>;
  try {
    settings = readSettingsFileStrict(filePath);
  } catch {
    return EMPTY_SUBAGENT_SETTINGS;
  }

  const subagents = settings.subagents;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return EMPTY_SUBAGENT_SETTINGS;

  return EMPTY_SUBAGENT_SETTINGS;
}

function customAgentHasFrontmatterField(agent: AgentConfig, ...fields: string[]): boolean {
  const frontmatterFields = agentFrontmatterFields.get(agent);
  return frontmatterFields ? fields.some((field) => frontmatterFields.has(field)) : false;
}

function applyCustomAgentOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
  meta: { scope: "user" | "project"; path: string },
): AgentConfig {
  let next: AgentConfig | undefined;
  let anyFilled = false;

  const mutable = (): AgentConfig => {
    next ??= { ...agent };
    return next;
  };

  const fill = <K extends keyof AgentConfig>(
    field: K,
    frontmatterFields: string[],
    value: AgentConfig[K],
  ): void => {
    if (customAgentHasFrontmatterField(agent, ...frontmatterFields)) return;
    mutable()[field] = value;
    anyFilled = true;
  };

  if (override.model !== undefined) {
    fill("model", ["model"], override.model === false ? undefined : override.model);
  }
  if (override.fallbackModels !== undefined) {
    fill(
      "fallbackModels",
      ["fallbackModels"],
      override.fallbackModels === false ? undefined : [...override.fallbackModels],
    );
  }
  if (override.thinking !== undefined) {
    fill("thinking", ["thinking"], override.thinking === false ? undefined : override.thinking);
  }
  if (override.systemPromptMode !== undefined) {
    fill("systemPromptMode", ["systemPromptMode"], override.systemPromptMode);
  }
  if (override.inheritProjectContext !== undefined) {
    fill("inheritProjectContext", ["inheritProjectContext"], override.inheritProjectContext);
  }
  if (override.inheritSkills !== undefined) {
    fill("inheritSkills", ["inheritSkills"], override.inheritSkills);
  }
  if (override.defaultContext !== undefined) {
    fill(
      "defaultContext",
      ["defaultContext"],
      override.defaultContext === false ? undefined : override.defaultContext,
    );
  }
  if (override.acceptanceRole !== undefined) {
    fill(
      "acceptanceRole",
      ["acceptanceRole"],
      override.acceptanceRole === false ? undefined : override.acceptanceRole,
    );
  }
  if (override.disabled !== undefined && agent.disabled === undefined) {
    mutable().disabled = override.disabled;
    anyFilled = true;
  }
  if (override.skills !== undefined) {
    fill(
      "skills",
      ["skill", "skills"],
      override.skills === false ? undefined : [...override.skills],
    );
  }
  if (override.tools !== undefined && !customAgentHasFrontmatterField(agent, "tools")) {
    const { tools } = splitToolList(override.tools === false ? [] : override.tools);
    const target = mutable();
    target.tools = tools;
    anyFilled = true;
  }
  if (override.subagentOnlyExtensions !== undefined) {
    fill(
      "subagentOnlyExtensions",
      ["subagentOnlyExtensions"],
      override.subagentOnlyExtensions === false ? undefined : [...override.subagentOnlyExtensions],
    );
  }
  if (override.completionGuard !== undefined) {
    fill("completionGuard", ["completionGuard"], override.completionGuard);
  }
  if (override.toolBudget !== undefined) {
    fill(
      "toolBudget",
      ["toolBudget"],
      override.toolBudget === false ? undefined : override.toolBudget,
    );
  }
  if (override.maxExecutionTimeMs !== undefined) {
    fill(
      "maxExecutionTimeMs",
      ["maxExecutionTimeMs"],
      override.maxExecutionTimeMs === false ? undefined : override.maxExecutionTimeMs,
    );
  }

  if (!anyFilled || !next) return agent;
  next.override = { ...meta, base: cloneOverrideBase(agent) };
  return next;
}

function applyCustomAgentOverrides(
  agents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
  userSettingsPath: string,
  projectSettingsPath: string | null,
): AgentConfig[] {
  return agents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride && projectSettingsPath) {
      return applyCustomAgentOverride(agent, projectOverride, {
        scope: "project",
        path: projectSettingsPath,
      });
    }

    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return applyCustomAgentOverride(agent, userOverride, {
        scope: "user",
        path: userSettingsPath,
      });
    }

    return agent;
  });
}

function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;

  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return files;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(filePath, predicate));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!predicate(entry.name)) continue;
    files.push(filePath);
  }
  return files;
}

function isLegacyAgentSkillPath(rootDir: string, filePath: string): boolean {
  const relative = path.relative(rootDir, filePath);
  const parts = relative.split(path.sep).map((part) => part.toLowerCase());
  if (path.basename(rootDir).toLowerCase() === ".agents") {
    parts.unshift(".agents");
  }
  return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  for (const filePath of listFilesRecursive(
    dir,
    (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md"),
  )) {
    if (isLegacyAgentSkillPath(dir, filePath)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const localName = frontmatter.name;
    const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
    if (parsedPackage.error) continue;
    const packageName = parsedPackage.packageName;
    const runtimeName = buildRuntimeName(localName, packageName);

    const tools =
      frontmatter.tools
        ?.split(",")
        .map((t) => t.trim())
        .filter((t) => Boolean(t) && !t.startsWith("mcp:")) ?? [];

    const defaultReads = frontmatter.defaultReads
      ?.split(",")
      .map((f) => f.trim())
      .filter(Boolean);

    const skillStr = frontmatter.skill || frontmatter.skills;
    const skills = skillStr
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const fallbackModels = frontmatter.fallbackModels
      ?.split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    const systemPromptMode =
      frontmatter.systemPromptMode === "replace"
        ? "replace"
        : frontmatter.systemPromptMode === "append"
          ? "append"
          : defaultSystemPromptMode(localName);
    const inheritProjectContext =
      frontmatter.inheritProjectContext === "true"
        ? true
        : frontmatter.inheritProjectContext === "false"
          ? false
          : defaultInheritProjectContext(localName);
    const inheritSkills =
      frontmatter.inheritSkills === "true"
        ? true
        : frontmatter.inheritSkills === "false"
          ? false
          : defaultInheritSkills();
    const defaultContext =
      frontmatter.defaultContext === "fork"
        ? ("fork" as const)
        : frontmatter.defaultContext === "fresh"
          ? ("fresh" as const)
          : undefined;
    let acceptanceRole: AcceptanceRole | undefined;
    if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim()) {
      if (frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer")
        acceptanceRole = frontmatter.acceptanceRole;
      else
        throw new Error(
          `Agent '${localName}' has invalid acceptanceRole frontmatter; expected 'read-only' or 'writer'.`,
        );
    }

    let extensions: string[] | undefined;
    if (frontmatter.extensions !== undefined) {
      extensions = frontmatter.extensions
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
    }
    let subagentOnlyExtensions: string[] | undefined;
    if (frontmatter.subagentOnlyExtensions !== undefined) {
      subagentOnlyExtensions = frontmatter.subagentOnlyExtensions
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
    }

    const extraFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
    }

    const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
    const maxExecutionTimeMs = parsePositiveIntegerFrontmatter(
      frontmatter.maxExecutionTimeMs,
      "maxExecutionTimeMs",
      `Agent '${localName}'`,
    );
    let toolBudget: ToolBudgetConfig | undefined;
    if (frontmatter.toolBudget !== undefined && frontmatter.toolBudget.trim()) {
      const parsed = JSON.parse(frontmatter.toolBudget) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          `Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`,
        );
      }
      toolBudget = parsed as ToolBudgetConfig;
    }
    const completionGuard =
      frontmatter.completionGuard === "false"
        ? false
        : frontmatter.completionGuard === "true"
          ? true
          : undefined;

    const agent: AgentConfig = {
      name: runtimeName,
      localName,
      packageName,
      description: frontmatter.description,
      tools: tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
      thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
      systemPromptMode,
      inheritProjectContext,
      inheritSkills,
      defaultContext,
      acceptanceRole,
      systemPrompt: body,
      source,
      filePath,
      skills: skills && skills.length > 0 ? skills : undefined,
      extensions,
      subagentOnlyExtensions,
      output: frontmatter.output,
      defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
      defaultProgress: frontmatter.defaultProgress === "true",
      interactive: frontmatter.interactive === "true",
      maxSubagentDepth:
        Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
          ? parsedMaxSubagentDepth
          : undefined,
      completionGuard,
      toolBudget,
      maxExecutionTimeMs,
      extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
    };
    agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
    agents.push(agent);
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function resolveNearestProjectAgentDirs(cwd: string): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const projectRoot = findNearestProjectRoot(cwd);
  if (!projectRoot) return { readDirs: [], preferredDir: null };

  const legacyDir = path.join(projectRoot, ".agents");
  const preferredDir = path.join(getProjectConfigDir(projectRoot), "agents");
  const readDirs: string[] = [];
  if (isDirectory(legacyDir) && !isGlobalAgentsDir(legacyDir)) readDirs.push(legacyDir);
  if (isDirectory(preferredDir)) readDirs.push(preferredDir);

  return {
    readDirs,
    preferredDir,
  };
}

function resolveNearestProjectChainDirs(cwd: string): {
  readDirs: string[];
  preferredDir: string | null;
} {
  const projectRoot = findNearestProjectRoot(cwd);
  if (!projectRoot) return { readDirs: [], preferredDir: null };

  const preferredDir = path.join(getProjectConfigDir(projectRoot), "chains");
  return {
    readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
    preferredDir,
  };
}

function uniqueResolvedDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function resolveConfiguredAgentDirs(settings: SubagentSettings, baseDir: string): string[] {
  return uniqueResolvedDirs(
    (settings.agentDirs ?? []).map((dir) => {
      const expanded = expandTildePath(dir);
      return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
    }),
  );
}

function loadAgentsFromDirs(dirs: string[], source: AgentSource): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();
  for (const dir of uniqueResolvedDirs(dirs)) {
    for (const agent of loadAgentsFromDir(dir, source)) {
      agentMap.set(agent.name, agent);
    }
  }
  return Array.from(agentMap.values());
}

function projectSettingsBaseDir(projectSettingsPath: string | null): string | null {
  return projectSettingsPath ? path.dirname(path.dirname(projectSettingsPath)) : null;
}

export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

// Additional read-only directories to scan for agent definitions, supplied by the
// launcher via PI_SUBAGENT_EXTRA_AGENT_DIRS (PATH-style, split on os/path delimiter).
// Lets a hermetic wrapper (e.g. a Nix-store install) expose bundled agents without
// copying or symlinking them into the writable agent dir. Loaded as "user" source,
// at lower precedence than agents the user placed in their own agent dir.
function extraUserAgentDirs(): string[] {
  const raw = process.env[EXTRA_AGENT_DIRS_ENV];
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDirOld = path.join(getAgentDir(), "agents");
  const userDirNew = getLegacyGlobalAgentsDir();
  const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } =
    resolveNearestProjectAgentDirs(cwd);
  const userSettingsPath = getUserAgentSettingsPath();
  const projectSettingsPath = getProjectAgentSettingsPath(cwd);
  const userSettings =
    scope === "project"
      ? projectScopeUserBuiltinSettings(userSettingsPath)
      : readSubagentSettings(userSettingsPath);
  const projectSettings =
    scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);
  const defaultModel = resolveSubagentDefaultModel(
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const customUserSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : userSettings;
  const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
  const packageSubagentPaths = collectPackageSubagentPaths(cwd, {
    includeUser: scope !== "project",
    includeProject: scope !== "user",
  });

  const builtinAgents: AgentConfig[] = [];

  const userConfiguredAgentDirs =
    scope === "project" ? [] : resolveConfiguredAgentDirs(customUserSettings, getAgentDir());
  const projectBaseDir = projectSettingsBaseDir(projectSettingsPath);
  const projectConfiguredAgentDirs =
    scope === "user" || !projectBaseDir
      ? []
      : resolveConfiguredAgentDirs(projectSettings, projectBaseDir);
  const userAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      scope === "project"
        ? []
        : loadAgentsFromDirs(
            [
              ...extraUserAgentDirs(),
              ...userConfiguredAgentDirs,
              userDirOld,
              ...(userDirNew ? [userDirNew] : []),
            ],
            "user",
          ),
      defaultModel,
    ),
    customUserSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const projectAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      scope === "user"
        ? []
        : loadAgentsFromDirs([...projectConfiguredAgentDirs, ...projectAgentDirs], "project"),
      defaultModel,
    ),
    customUserSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      packageSubagentPaths.agents.flatMap((dir) => loadAgentsFromDir(dir, "package")),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const agents = mergeAgentsForScope(
    scope,
    userAgents,
    projectAgents,
    builtinAgents,
    packageAgents,
  ).filter((agent) => agent.disabled !== true);

  return { agents, projectAgentsDir, modelScope };
}

export function discoverAgentsAll(cwd: string): {
  builtin: AgentConfig[];
  package: AgentConfig[];
  user: AgentConfig[];
  project: AgentConfig[];
  chains: ChainConfig[];
  chainDiagnostics: ChainDiscoveryDiagnostic[];
  userDir: string;
  projectDir: string | null;
  userChainDir: string;
  projectChainDir: string | null;
  userSettingsPath: string;
  projectSettingsPath: string | null;
} {
  const userDirOld = path.join(getAgentDir(), "agents");
  const userDirNew = getLegacyGlobalAgentsDir();
  const userChainDir = getUserChainDir();
  const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
  const { preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
  const userSettingsPath = getUserAgentSettingsPath();
  const projectSettingsPath = getProjectAgentSettingsPath(cwd);
  const userSettings = readSubagentSettings(userSettingsPath);
  const projectSettings = readSubagentSettings(projectSettingsPath);
  const defaultModel = resolveSubagentDefaultModel(
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageSubagentPaths = collectPackageSubagentPaths(cwd);

  const builtin: AgentConfig[] = [];
  const userConfiguredAgentDirs = resolveConfiguredAgentDirs(userSettings, getAgentDir());
  const projectBaseDir = projectSettingsBaseDir(projectSettingsPath);
  const projectConfiguredAgentDirs = projectBaseDir
    ? resolveConfiguredAgentDirs(projectSettings, projectBaseDir)
    : [];
  const user = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      loadAgentsFromDirs(
        [
          ...extraUserAgentDirs(),
          ...userConfiguredAgentDirs,
          userDirOld,
          ...(userDirNew ? [userDirNew] : []),
        ],
        "user",
      ),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const packageMap = new Map<string, AgentConfig>();
  for (const dir of packageSubagentPaths.agents) {
    for (const agent of loadAgentsFromDir(dir, "package")) {
      if (!packageMap.has(agent.name)) packageMap.set(agent.name, agent);
    }
  }
  const packageAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(Array.from(packageMap.values()), defaultModel),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const project = applyCustomAgentOverrides(
    applySubagentDefaultModel(
      loadAgentsFromDirs([...projectConfiguredAgentDirs, ...projectDirs], "project"),
      defaultModel,
    ),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const chains: ChainConfig[] = [];
  const chainDiagnostics: ChainDiscoveryDiagnostic[] = [];
  const userDir = userDirNew && fs.existsSync(userDirNew) ? userDirNew : userDirOld;

  return {
    builtin,
    package: packageAgents,
    user,
    project,
    chains,
    chainDiagnostics,
    userDir,
    projectDir,
    userChainDir,
    projectChainDir,
    userSettingsPath,
    projectSettingsPath,
  };
}
