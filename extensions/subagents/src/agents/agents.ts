/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AcceptanceRole, ToolBudgetConfig } from "../shared/types.ts";
import { getLegacyGlobalAgentsDir, isGlobalAgentsDir } from "../shared/profile.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import {
  mergeProjectAgentSnapshot,
  projectAgentSnapshotDiscoveryMetadata,
  ProjectAgentSnapshotCapabilityError,
  resolveProjectAgentSnapshot,
  type ProjectAgentSnapshotCapability,
  type ProjectAgentSnapshotDiscoveryMetadata,
  type ProjectAgentSnapshotExpected,
} from "./project-agent-snapshot.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
import { parseModelScopeConfig, type ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { isCanonicalPackagedMinorAgent } from "../../../shared/project-agent-guidance.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { canonicalAgentMaxExecutionTimeMs, isPositiveSafeInteger } from "./execution-ceiling.ts";

export type AgentScope = "user" | "project" | "both";

type AgentSource = "builtin" | "package" | "user" | "project";
type SystemPromptMode = "append" | "replace";

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
  "supervisorBridge",
  "toolBudget",
]);

interface BuiltinAgentOverrideBase {
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  acceptanceRole?: AcceptanceRole;
  disabled?: boolean;
  systemPrompt: string;
  skills?: string[];
  tools?: string[] | null;
  subagentOnlyExtensions?: string[];
  completionGuard?: boolean;
  supervisorBridge?: boolean;
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
  acceptanceRole?: AcceptanceRole | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false;
  subagentOnlyExtensions?: string[] | false;
  completionGuard?: boolean;
  supervisorBridge?: boolean;
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
  /**
   * Child tool policy after filtering MCP declarations.
   * `undefined` means the tools field was omitted; `null` means it was explicit
   * but contained no named tools; an array is an explicit named allowlist.
   */
  tools?: string[] | null;
  model?: string;
  fallbackModels?: string[];
  thinking?: string | false;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritSkills: boolean;
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
  /** When false, omit generic native supervisor guidance and contact_supervisor runtime support. */
  supervisorBridge?: boolean;
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
  modelScope?: ModelScopeConfig;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = {
  overrides: Object.create(null) as Record<string, BuiltinAgentOverrideConfig>,
};
const agentFrontmatterFields = new WeakMap<AgentConfig, Set<string>>();

class AgentDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDefinitionValidationError";
  }
}

export interface AgentDiscoveryDiagnostic {
  source: AgentSource;
  filePath: string;
  error: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  modelScope?: ModelScopeConfig;
  agentDiagnostics?: AgentDiscoveryDiagnostic[];
}

export interface ProjectAgentSnapshotDiscoveryResult extends AgentDiscoveryResult {
  projectSnapshot: ProjectAgentSnapshotDiscoveryMetadata;
}

function splitToolList(rawTools: string[] | undefined): { tools?: string[] | null } {
  if (rawTools === undefined) return {};
  const tools = rawTools.filter((tool) => !tool.startsWith("mcp:"));
  return { tools: tools.length > 0 ? tools : null };
}

function parsePositiveIntegerFrontmatter(
  value: string | undefined,
  field: string,
  label: string,
): number | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!isPositiveSafeInteger(parsed)) {
    throw new AgentDefinitionValidationError(
      `${label} has invalid ${field} frontmatter; expected a positive safe integer.`,
    );
  }
  return parsed;
}

function parseOptionalBooleanFrontmatter(
  value: string | undefined,
  field: string,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AgentDefinitionValidationError(
    `${label} has invalid ${field} frontmatter; expected 'true' or 'false'.`,
  );
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
  return {
    model: agent.model,
    fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
    thinking: agent.thinking,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    acceptanceRole: agent.acceptanceRole,
    disabled: agent.disabled,
    systemPrompt: agent.systemPrompt,
    skills: agent.skills ? [...agent.skills] : undefined,
    tools: agent.tools === undefined ? undefined : agent.tools === null ? null : [...agent.tools],
    subagentOnlyExtensions: agent.subagentOnlyExtensions
      ? [...agent.subagentOnlyExtensions]
      : undefined,
    completionGuard: agent.completionGuard,
    supervisorBridge: agent.supervisorBridge,
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
): BuiltinAgentOverrideConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
  }

  const input = value as Record<string, unknown>;
  const override: BuiltinAgentOverrideConfig = {};

  if (Object.hasOwn(input, "model")) {
    if (typeof input.model === "string" || input.model === false) override.model = input.model;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`,
      );
  }

  if (Object.hasOwn(input, "thinking")) {
    if (typeof input.thinking === "string" || input.thinking === false)
      override.thinking = input.thinking;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`,
      );
  }

  if (Object.hasOwn(input, "systemPromptMode")) {
    if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
      override.systemPromptMode = input.systemPromptMode;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`,
      );
    }
  }

  if (Object.hasOwn(input, "inheritProjectContext")) {
    if (typeof input.inheritProjectContext === "boolean") {
      override.inheritProjectContext = input.inheritProjectContext;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`,
      );
    }
  }

  if (Object.hasOwn(input, "inheritSkills")) {
    if (typeof input.inheritSkills === "boolean") {
      override.inheritSkills = input.inheritSkills;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`,
      );
    }
  }

  if (Object.hasOwn(input, "acceptanceRole")) {
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

  if (Object.hasOwn(input, "disabled")) {
    if (typeof input.disabled === "boolean") {
      override.disabled = input.disabled;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`,
      );
    }
  }

  if (Object.hasOwn(input, "completionGuard")) {
    if (typeof input.completionGuard === "boolean") {
      override.completionGuard = input.completionGuard;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`,
      );
    }
  }

  if (Object.hasOwn(input, "supervisorBridge")) {
    if (typeof input.supervisorBridge === "boolean") {
      override.supervisorBridge = input.supervisorBridge;
    } else {
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'supervisorBridge'; expected a boolean.`,
      );
    }
  }

  if (Object.hasOwn(input, "toolBudget")) {
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

  if (Object.hasOwn(input, "maxExecutionTimeMs")) {
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

  if (Object.hasOwn(input, "systemPrompt")) {
    if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
    else
      throw new Error(
        `Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`,
      );
  }

  const fallbackModels = parseOverrideStringArrayOrFalse(
    Object.hasOwn(input, "fallbackModels") ? input.fallbackModels : undefined,
    {
      filePath,
      name,
      field: "fallbackModels",
    },
  );
  if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

  const skills = parseOverrideStringArrayOrFalse(
    Object.hasOwn(input, "skills") ? input.skills : undefined,
    { filePath, name, field: "skills" },
  );
  if (skills !== undefined) override.skills = skills;

  const tools = parseOverrideStringArrayOrFalse(
    Object.hasOwn(input, "tools") ? input.tools : undefined,
    { filePath, name, field: "tools" },
  );
  if (tools !== undefined) override.tools = tools;

  const subagentOnlyExtensions = parseOverrideStringArrayOrFalse(
    Object.hasOwn(input, "subagentOnlyExtensions") ? input.subagentOnlyExtensions : undefined,
    {
      filePath,
      name,
      field: "subagentOnlyExtensions",
    },
  );
  if (subagentOnlyExtensions !== undefined)
    override.subagentOnlyExtensions = subagentOnlyExtensions;

  return override;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
  if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
  const settings = readSettingsFileStrict(filePath);
  const subagents = Object.hasOwn(settings, "subagents") ? settings.subagents : undefined;
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents))
    return EMPTY_SUBAGENT_SETTINGS;

  const subagentsObject = subagents as Record<string, unknown>;
  let defaultModel: string | undefined;
  if (Object.hasOwn(subagentsObject, "defaultModel")) {
    if (typeof subagentsObject.defaultModel === "string" && subagentsObject.defaultModel.trim()) {
      defaultModel = subagentsObject.defaultModel.trim();
    } else {
      throw new Error(
        `Subagent settings in '${filePath}' have invalid 'defaultModel'; expected a non-empty string.`,
      );
    }
  }
  const modelScope = parseModelScopeConfig(
    Object.hasOwn(subagentsObject, "modelScope") ? subagentsObject.modelScope : undefined,
    { filePath },
  );

  const parsed = Object.create(null) as Record<string, BuiltinAgentOverrideConfig>;
  const agentOverrides = Object.hasOwn(subagentsObject, "agentOverrides")
    ? subagentsObject.agentOverrides
    : undefined;
  if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
    return { overrides: parsed, defaultModel, modelScope };
  }
  for (const [name, value] of Object.entries(agentOverrides)) {
    parsed[name] = parseBuiltinOverrideEntry(name, value, filePath);
  }
  return { overrides: parsed, defaultModel, modelScope };
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
    if (!next) {
      next = { ...agent };
      const frontmatterFields = agentFrontmatterFields.get(agent);
      if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
    }
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
    const tools = override.tools === false ? undefined : splitToolList(override.tools).tools;
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
  if (override.supervisorBridge !== undefined) {
    fill("supervisorBridge", ["supervisorBridge"], override.supervisorBridge);
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
    if (projectSettingsPath && Object.hasOwn(projectSettings.overrides, agent.name)) {
      return applyCustomAgentOverride(agent, projectSettings.overrides[agent.name]!, {
        scope: "project",
        path: projectSettingsPath,
      });
    }

    if (Object.hasOwn(userSettings.overrides, agent.name)) {
      return applyCustomAgentOverride(agent, userSettings.overrides[agent.name]!, {
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

function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
  agentDiagnosticsOut?: AgentDiscoveryDiagnostic[],
): AgentConfig[] {
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

    try {
      const { frontmatter, body } = parseFrontmatter(content);
      if (Object.keys(frontmatter).length === 0) continue;

      const missingRequiredFields = (["name", "description"] as const).filter(
        (field) => !frontmatter[field],
      );
      if (missingRequiredFields.length > 0) {
        agentDiagnosticsOut?.push({
          source,
          filePath,
          error: `Agent frontmatter is missing required fields: ${missingRequiredFields.join(", ")}.`,
        });
        continue;
      }

      const localName = frontmatter.name;
      const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
      if (parsedPackage.error) {
        throw new AgentDefinitionValidationError(parsedPackage.error);
      }
      const packageName = parsedPackage.packageName;
      const runtimeName = buildRuntimeName(localName, packageName);

      const hasDeclaredToolsField = "tools" in frontmatter;
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
      if (Object.prototype.hasOwnProperty.call(frontmatter, "defaultContext")) {
        throw new AgentDefinitionValidationError(
          `Agent '${localName}' uses retired defaultContext; remove it because TLH always starts child sessions fresh.`,
        );
      }
      let acceptanceRole: AcceptanceRole | undefined;
      if (frontmatter.acceptanceRole !== undefined && frontmatter.acceptanceRole.trim()) {
        if (frontmatter.acceptanceRole === "read-only" || frontmatter.acceptanceRole === "writer")
          acceptanceRole = frontmatter.acceptanceRole;
        else
          throw new AgentDefinitionValidationError(
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(frontmatter.toolBudget) as unknown;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new AgentDefinitionValidationError(
            `Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object: ${error.message}`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new AgentDefinitionValidationError(
            `Agent '${localName}' has invalid toolBudget frontmatter; expected a JSON object.`,
          );
        }
        const normalizedToolBudget = validateToolBudgetConfig(parsed);
        if (normalizedToolBudget.error) {
          throw new AgentDefinitionValidationError(
            `Agent '${localName}' has invalid toolBudget frontmatter: ${normalizedToolBudget.error}`,
          );
        }
        toolBudget = normalizedToolBudget.budget;
      }
      const completionGuard =
        frontmatter.completionGuard === "false"
          ? false
          : frontmatter.completionGuard === "true"
            ? true
            : undefined;
      const supervisorBridge = parseOptionalBooleanFrontmatter(
        frontmatter.supervisorBridge,
        "supervisorBridge",
        `Agent '${localName}'`,
      );

      const agent: AgentConfig = {
        name: runtimeName,
        localName,
        packageName,
        description: frontmatter.description,
        tools: hasDeclaredToolsField ? (tools.length > 0 ? tools : null) : undefined,
        model: frontmatter.model,
        fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
        thinking: frontmatter.thinking === "false" ? false : frontmatter.thinking,
        systemPromptMode,
        inheritProjectContext,
        inheritSkills,
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
        supervisorBridge,
        toolBudget,
        maxExecutionTimeMs,
        extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
      };
      agentFrontmatterFields.set(agent, new Set(Object.keys(frontmatter)));
      agents.push(agent);
    } catch (error) {
      if (!(error instanceof AgentDefinitionValidationError)) throw error;
      agentDiagnosticsOut?.push({ source, filePath, error: error.message });
    }
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

function resolveNearestProjectAgentDirs(cwd: string): { preferredDir: string | null } {
  const projectRoot = findNearestProjectRoot(cwd);
  if (!projectRoot) return { preferredDir: null };

  return { preferredDir: path.join(getProjectConfigDir(projectRoot), "agents") };
}

/**
 * @deprecated Retained only for callers that clear the retired generic source.
 * TLH does not read this environment variable for agent discovery.
 */
export const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

/**
 * The installer-managed TLH role files are the only supported user/extra
 * definitions. Generic profile, legacy, configured, and extra-dir files are
 * intentionally not part of TLH's active discovery surface.
 */
function loadCanonicalPackagedAgents(agentDiagnostics: AgentDiscoveryDiagnostic[]): AgentConfig[] {
  const canonicalDir = path.resolve(getAgentDir(), "tlh", "agents", "subagents");
  const byName = new Map<string, AgentConfig>();
  for (const agent of loadAgentsFromDir(canonicalDir, "user", agentDiagnostics)) {
    if (!isCanonicalPackagedMinorAgent(agent)) continue;
    byName.set(agent.name, agent);
  }

  // Keep role ceilings code-owned and apply them before any human settings
  // overrides. An explicit false override therefore clears this value rather
  // than being replaced by a fallback later in discovery.
  return Array.from(byName.values()).map((agent) => {
    const defaultMaxExecutionTimeMs = canonicalAgentMaxExecutionTimeMs(agent.name);
    if (defaultMaxExecutionTimeMs === undefined || agent.maxExecutionTimeMs !== undefined) {
      return agent;
    }
    const next = { ...agent, maxExecutionTimeMs: defaultMaxExecutionTimeMs };
    const frontmatterFields = agentFrontmatterFields.get(agent);
    if (frontmatterFields) agentFrontmatterFields.set(next, frontmatterFields);
    return next;
  });
}

// `excludeProjectPackages` remains accepted for the snapshot seam's call shape; generic package
// roots are no longer loaded, so there is nothing else to exclude here.
export function discoverAgents(
  cwd: string,
  scope: AgentScope,
  _options: { excludeProjectPackages?: boolean } = {},
): AgentDiscoveryResult {
  const { preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
  const userSettingsPath = getUserAgentSettingsPath();
  const projectSettingsPath = getProjectAgentSettingsPath(cwd);
  const userSettings =
    scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
  const projectSettings =
    scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);
  const defaultModel = resolveSubagentDefaultModel(
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  const modelScope = projectSettings.modelScope ?? userSettings.modelScope;
  const agentDiagnostics: AgentDiscoveryDiagnostic[] = [];

  const canonicalAgents = applyCustomAgentOverrides(
    applySubagentDefaultModel(loadCanonicalPackagedAgents(agentDiagnostics), defaultModel),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );

  const agents = mergeAgentsForScope(scope, [], [], canonicalAgents, []).filter(
    (agent) => agent.disabled !== true,
  );

  return { agents, projectAgentsDir, modelScope, agentDiagnostics };
}

/**
 * Internal-only discovery seam for an already validated project snapshot.
 * This seam intentionally discovers only effective user/profile agents;
 * public agentScope and ordinary project discovery remain unchanged.
 */
export function discoverAgentsWithProjectSnapshot(
  cwd: string,
  capability: ProjectAgentSnapshotCapability,
  expected: ProjectAgentSnapshotExpected,
): ProjectAgentSnapshotDiscoveryResult {
  const manifest = resolveProjectAgentSnapshot(capability, expected);
  let canonicalCwd: string;
  let canonicalProjectRoot: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
    canonicalProjectRoot = fs.realpathSync(manifest.provenance.projectRoot);
  } catch {
    throw new ProjectAgentSnapshotCapabilityError();
  }
  const relativeCwd = path.relative(canonicalProjectRoot, canonicalCwd);
  if (relativeCwd !== "" && (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd))) {
    throw new ProjectAgentSnapshotCapabilityError();
  }
  const discovered = discoverAgents(cwd, "user", { excludeProjectPackages: true });
  const userSettings = readSubagentSettings(getUserAgentSettingsPath());
  for (const entry of manifest.entries) {
    agentFrontmatterFields.set(entry.agent, new Set(entry.frontmatterFields));
  }
  // Project definitions are immutable snapshot data. The only profile-local
  // setting that may affect one is an explicit deny; model, effort, prompt,
  // tool, and default fields never modify or replace the captured agent.
  const disabledNames = manifest.entries
    .filter(
      (entry) =>
        Object.hasOwn(userSettings.overrides, entry.agent.name) &&
        userSettings.overrides[entry.agent.name]?.disabled === true,
    )
    .map((entry) => entry.agent.name);
  const disabledNameSet = new Set(disabledNames);
  const activeEntries = manifest.entries.filter((entry) => !disabledNameSet.has(entry.agent.name));
  const mergeOptions = {
    entries: activeEntries,
    tombstones: [...manifest.tombstones, ...disabledNames],
  };
  return {
    ...discovered,
    agents: mergeProjectAgentSnapshot(discovered.agents, manifest, mergeOptions),
    projectAgentsDir: null,
    projectSnapshot: projectAgentSnapshotDiscoveryMetadata(manifest, disabledNames),
  };
}

export function discoverAgentsAll(cwd: string): {
  builtin: AgentConfig[];
  package: AgentConfig[];
  user: AgentConfig[];
  project: AgentConfig[];
  agentDiagnostics?: AgentDiscoveryDiagnostic[];
  userDir: string;
  projectDir: string | null;
  userSettingsPath: string;
  projectSettingsPath: string | null;
} {
  const userDirOld = path.join(getAgentDir(), "agents");
  const userDirNew = getLegacyGlobalAgentsDir();
  const { preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
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
  const builtin: AgentConfig[] = [];
  const agentDiagnostics: AgentDiscoveryDiagnostic[] = [];
  const user = applyCustomAgentOverrides(
    applySubagentDefaultModel(loadCanonicalPackagedAgents(agentDiagnostics), defaultModel),
    userSettings,
    projectSettings,
    userSettingsPath,
    projectSettingsPath,
  );
  // Package and project custom agents are supplied only through the validated snapshot seam.
  // Generic package/project agent directories remain inert for inventory and management.
  const packageAgents: AgentConfig[] = [];
  const project: AgentConfig[] = [];

  const userDir = userDirNew && fs.existsSync(userDirNew) ? userDirNew : userDirOld;

  return {
    builtin,
    package: packageAgents,
    user,
    project,
    agentDiagnostics,
    userDir,
    projectDir,
    userSettingsPath,
    projectSettingsPath,
  };
}
