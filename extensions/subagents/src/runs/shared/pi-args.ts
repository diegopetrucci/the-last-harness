import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
  STRUCTURED_OUTPUT_TOOL_NAME,
} from "./structured-output.ts";
import {
  TEMP_ROOT_DIR,
  type JsonSchemaObject,
  type ResolvedToolBudget,
} from "../../shared/types.ts";
import {
  findModelInfo,
  getSupportedThinkingLevels,
  THINKING_LEVELS,
  type ModelInfo,
  type ThinkingLevel,
} from "../../shared/model-info.ts";
import { TOOL_BUDGET_ENV, encodeToolBudgetEnv } from "./tool-budget.ts";
const TASK_ARG_LIMIT = 8000;
export const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
export const INVALID_LAZY_SKILL_TOOL_POLICY_ERROR =
  "Cannot combine lazy skills with extension-path-only tools: list each extension tool name alongside its extension path (read is injected automatically).";
const RUNTIME_EXTENSION_SUFFIX =
  path.extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js";
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  `subagent-prompt-runtime${RUNTIME_EXTENSION_SUFFIX}`,
);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
export const SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
/** Parent-verified provenance for installer-managed TLH minor-agent prompts. */
export const SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV = "PI_SUBAGENT_PROJECT_AGENT_GUIDANCE";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_PARENT_EVENT_SINK_ENV = "PI_SUBAGENT_PARENT_EVENT_SINK";
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = "PI_SUBAGENT_PARENT_CONTROL_INBOX";
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_ROOT_RUN_ID";
export const SUBAGENT_PARENT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_RUN_ID";
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = "PI_SUBAGENT_PARENT_CHILD_INDEX";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN";
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export const SUBAGENT_STEER_INBOX_ENV = "PI_SUBAGENT_STEER_INBOX";

interface BuildPiArgsInput {
  parentSessionId?: string;
  baseArgs: string[];
  task: string;
  sessionEnabled: boolean;
  sessionDir?: string;
  sessionFile?: string;
  model?: string;
  thinking?: string | false;
  availableModels?: ModelInfo[];
  preferredModelProvider?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext: boolean;
  inheritSkills: boolean;
  requireReadTool?: boolean;
  /**
   * Explicit child tool policy from parsing.
   * `undefined` inherits Pi defaults; `null` is an explicit zero-tool policy; arrays are
   * exact named allowlists with optional extension paths.
   */
  tools?: string[] | null;
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  systemPrompt?: string | null;
  cwd?: string;
  promptFileStem?: string;
  intercomSessionName?: string;
  orchestratorIntercomTarget?: string;
  runId?: string;
  childAgentName?: string;
  /** True only when the parent selected the canonical installer-managed TLH prompt. */
  projectAgentGuidance?: boolean;
  childIndex?: number;
  steerInboxDir?: string;
  structuredOutput?: {
    schema: JsonSchemaObject;
    schemaPath: string;
    outputPath: string;
  };
  toolBudget?: ResolvedToolBudget;
}

interface BuildPiArgsResult {
  args: string[];
  env: Record<string, string | undefined>;
  tempDir?: string;
}

interface ResolvedToolPolicy {
  namedToolNames: string[];
  toolExtensionPaths: string[];
  hasOnlyExtensionPaths: boolean;
  error?: string;
}

function isExtensionToolPath(tool: string): boolean {
  return tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js");
}

function resolveToolPolicy(
  tools: string[] | null | undefined,
  requireReadTool = false,
): ResolvedToolPolicy {
  if (tools === undefined) {
    return { namedToolNames: [], toolExtensionPaths: [], hasOnlyExtensionPaths: false };
  }
  const declaredTools = Array.isArray(tools)
    ? tools
        .filter((tool): tool is string => typeof tool === "string")
        .map((tool) => tool.trim())
        .filter((tool) => tool && !tool.startsWith("mcp:"))
    : [];
  const toolExtensionPaths = [...new Set(declaredTools.filter(isExtensionToolPath))];
  const namedToolNames = [...new Set(declaredTools.filter((tool) => !isExtensionToolPath(tool)))];
  const hasOnlyExtensionPaths = toolExtensionPaths.length > 0 && namedToolNames.length === 0;
  return {
    namedToolNames,
    toolExtensionPaths,
    hasOnlyExtensionPaths,
    ...(hasOnlyExtensionPaths && requireReadTool
      ? { error: INVALID_LAZY_SKILL_TOOL_POLICY_ERROR }
      : {}),
  };
}

export function validatePiToolPolicy(input: {
  tools?: string[] | null;
  requireReadTool?: boolean;
}): string | undefined {
  return resolveToolPolicy(input.tools, input.requireReadTool).error;
}

function sanitizeSupervisorChannelSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function supervisorChannelDir(runId: string, agent: string, childIndex: number): string {
  return path.join(
    TEMP_ROOT_DIR,
    "supervisor-channels",
    `${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`,
  );
}

interface ThinkingSuffixOptions {
  availableModels?: ModelInfo[];
  preferredModelProvider?: string;
}

function shouldDropThinkingLevel(modelInfo: ModelInfo | undefined, thinking: string): boolean {
  if (!modelInfo) return false;
  if (modelInfo.reasoning === false) return thinking !== "off";

  // Do not reuse getSupportedThinkingLevels' no-map default here: settings
  // validation can be strict, but absent runtime metadata must fail open.
  if (!modelInfo.thinkingLevelMap) return false;
  return !getSupportedThinkingLevels(modelInfo).includes(thinking as ThinkingLevel);
}

/**
 * Return the user-facing note for a capability-gated thinking level, if the
 * gate would drop it. This deliberately mirrors applyThinkingSuffix's gate
 * without changing the value that function returns.
 */
export function getThinkingLevelDropNote(
  model: string | undefined,
  thinking: string | false | undefined,
  replaceExisting = false,
  options?: ThinkingSuffixOptions,
): string | undefined {
  if (!model || !thinking || replaceExisting) return undefined;
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1)))
    return undefined;
  const modelInfo = findModelInfo(model, options?.availableModels, options?.preferredModelProvider);
  if (!shouldDropThinkingLevel(modelInfo, thinking)) return undefined;
  return `Notice: Thinking level "${thinking}" was dropped for model "${model}" because the model registry does not advertise support.`;
}

export function applyThinkingSuffix(
  model: string | undefined,
  thinking: string | false | undefined,
  replaceExisting = false,
  options?: ThinkingSuffixOptions,
): string | undefined {
  if (!model || !thinking) return model;
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) {
    return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
  }
  // replaceExisting is reserved for explicit caller overrides; preserve that deliberate instruction.
  if (!replaceExisting && getThinkingLevelDropNote(model, thinking, false, options)) return model;
  return `${model}:${thinking}`;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
  let tempDir: string | undefined;
  try {
    return buildPiArgsInternal(input, (createdTempDir) => {
      tempDir = createdTempDir;
    });
  } catch (error) {
    cleanupTempDir(tempDir);
    throw error;
  }
}

function buildPiArgsInternal(
  input: BuildPiArgsInput,
  onTempDirCreated: (tempDir: string) => void,
): BuildPiArgsResult {
  const args = [...input.baseArgs];

  if (input.sessionFile) {
    fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
    args.push("--session", input.sessionFile);
  } else {
    if (!input.sessionEnabled) {
      args.push("--no-session");
    }
    if (input.sessionDir) {
      fs.mkdirSync(input.sessionDir, { recursive: true });
      args.push("--session-dir", input.sessionDir);
    }
  }

  const modelArg = applyThinkingSuffix(input.model, input.thinking, false, {
    availableModels: input.availableModels,
    preferredModelProvider: input.preferredModelProvider,
  });
  if (modelArg) {
    args.push("--model", modelArg);
  }

  const hasStructuredOutput = Boolean(input.structuredOutput);
  const requiresContactSupervisor = Boolean(input.orchestratorIntercomTarget?.trim());
  const requiresReadTool = input.inheritSkills || input.requireReadTool === true;
  const toolPolicy = resolveToolPolicy(input.tools, requiresReadTool);
  if (toolPolicy.error) throw new Error(toolPolicy.error);
  const { namedToolNames, toolExtensionPaths, hasOnlyExtensionPaths } = toolPolicy;

  if (input.tools !== undefined) {
    if (hasOnlyExtensionPaths) {
      // Pi's --no-builtin-tools suppresses only its default builtins. Unlike --no-tools, it
      // leaves extension/custom tools (including the runtime structured_output tool) active.
      args.push("--no-builtin-tools");
    } else {
      const allowedToolNames = [...namedToolNames];
      if (requiresReadTool && !allowedToolNames.includes("read")) {
        allowedToolNames.unshift("read");
      }
      if (requiresContactSupervisor && !allowedToolNames.includes(CONTACT_SUPERVISOR_TOOL_NAME)) {
        allowedToolNames.push(CONTACT_SUPERVISOR_TOOL_NAME);
      }
      if (hasStructuredOutput && !allowedToolNames.includes(STRUCTURED_OUTPUT_TOOL_NAME)) {
        allowedToolNames.push(STRUCTURED_OUTPUT_TOOL_NAME);
      }
      if (allowedToolNames.length > 0) {
        args.push("--tools", allowedToolNames.join(","));
      } else {
        // Fail closed: an explicit policy that resolves to zero tools must not inherit Pi defaults.
        args.push("--no-tools");
      }
    }
  }

  const runtimeExtensions = [PROMPT_RUNTIME_EXTENSION_PATH];
  if (input.extensions !== undefined) {
    args.push("--no-extensions");
    for (const extPath of new Set([
      ...runtimeExtensions,
      ...toolExtensionPaths,
      ...input.extensions,
      ...(input.subagentOnlyExtensions ?? []),
    ])) {
      args.push("--extension", extPath);
    }
  } else {
    for (const extPath of new Set([
      ...runtimeExtensions,
      ...toolExtensionPaths,
      ...(input.subagentOnlyExtensions ?? []),
    ])) {
      args.push("--extension", extPath);
    }
  }

  if (!input.inheritSkills) {
    args.push("--no-skills");
  }

  let tempDir: string | undefined;
  if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
    onTempDirCreated(tempDir);
    const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
    const promptPath = path.join(tempDir, `${stem}.md`);
    fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
    args.push(
      input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      promptPath,
    );
  }

  if (input.task.length > TASK_ARG_LIMIT) {
    if (!tempDir) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
      onTempDirCreated(tempDir);
    }
    const taskFilePath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
    args.push(`@${taskFilePath}`);
  } else {
    args.push(`Task: ${input.task}`);
  }

  const env: Record<string, string | undefined> = {};
  env[SUBAGENT_CHILD_ENV] = "1";
  env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
  env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
  // Always write the provenance sentinel. An inherited "1" must never opt a
  // same-name custom agent into project guidance.
  env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = input.projectAgentGuidance === true ? "1" : "0";
  if (input.intercomSessionName) {
    env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
  }
  if (input.orchestratorIntercomTarget) {
    env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
  }
  if (input.parentSessionId) {
    env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = input.parentSessionId;
  }
  if (
    input.orchestratorIntercomTarget &&
    input.parentSessionId &&
    input.runId &&
    input.childAgentName
  ) {
    const childIndex = input.childIndex ?? 0;
    const channelDir = supervisorChannelDir(input.runId, input.childAgentName, childIndex);
    fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true });
    env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
  }
  if (input.runId) {
    env[SUBAGENT_RUN_ID_ENV] = input.runId;
  }
  if (input.childAgentName) {
    env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
  }
  if (input.childIndex !== undefined) {
    env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
  }
  // Sentinel required by @diegopetrucci/pi-mcp-adapter (bundled in TLH):
  // the adapter's init.ts checks envDirect !== "__none__" before bootstrapping direct MCP tools.
  // An unset MCP_DIRECT_TOOLS means "bootstrap everything configured", which would silently
  // widen every child subagent's tool surface. This assignment must not be removed.
  env.MCP_DIRECT_TOOLS = "__none__";
  if (input.structuredOutput) {
    env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
    env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
  }
  if (input.steerInboxDir) {
    env[SUBAGENT_STEER_INBOX_ENV] = input.steerInboxDir;
  }
  const encodedToolBudget = encodeToolBudgetEnv(input.toolBudget);
  if (encodedToolBudget) env[TOOL_BUDGET_ENV] = encodedToolBudget;

  env[SUBAGENT_PARENT_SESSION_ENV] =
    input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? "";

  return { args, env, tempDir };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}
