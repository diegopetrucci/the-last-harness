import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
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
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
/** Child-runtime sentinel controlling native supervisor guidance and tool registration. */
export const SUBAGENT_SUPERVISOR_BRIDGE_ENV = "PI_SUBAGENT_SUPERVISOR_BRIDGE";
export const SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
/** Parent-verified provenance for installer-managed TLH minor-agent prompts. */
export const SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV = "PI_SUBAGENT_PROJECT_AGENT_GUIDANCE";
/** Parent-owned ticket identity retained so developer reminders survive compaction. */
export const SUBAGENT_TK_TICKET_ID_ENV = "PI_SUBAGENT_TK_TICKET_ID";
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
  /** Explicit agent capability; false opts out of native supervisor coordination. */
  supervisorBridge?: boolean;
  systemPrompt?: string | null;
  cwd?: string;
  promptFileStem?: string;
  runId?: string;
  childAgentName?: string;
  /** True only when the parent selected the canonical installer-managed TLH prompt. */
  projectAgentGuidance?: boolean;
  /** Validated ticket identity for the canonical developer child. */
  ticketId?: string;
  childIndex?: number;
  steerInboxDir?: string;
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

function canonicalChildExtensionPath(extensionPath: string, cwd: string): string {
  const resolvedPath = path.resolve(cwd, extensionPath);
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function appendUniqueChildExtensionPath(
  extensionPaths: string[],
  seenCanonicalPaths: Set<string>,
  extensionPath: string,
  cwd: string,
): void {
  const canonicalPath = canonicalChildExtensionPath(extensionPath, cwd);
  if (seenCanonicalPaths.has(canonicalPath)) return;
  seenCanonicalPaths.add(canonicalPath);
  extensionPaths.push(extensionPath);
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

/**
 * Append the requested thinking suffix and let Pi validate whether the model
 * accepts it. Registry capability metadata is intentionally not consulted.
 */
export function applyThinkingSuffix(
  model: string | undefined,
  thinking: string | false | undefined,
  replaceExisting = false,
): string | undefined {
  if (!model || !thinking) return model;
  const { thinkingSuffix } = splitKnownThinkingSuffix(model);
  if (thinkingSuffix) {
    return replaceExisting ? `${model.slice(0, -thinkingSuffix.length)}:${thinking}` : model;
  }
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

  const modelArg = applyThinkingSuffix(input.model, input.thinking);
  if (modelArg) {
    args.push("--model", modelArg);
  }

  const contactSupervisorDisallowed = input.supervisorBridge === false;
  const requiresContactSupervisor = !contactSupervisorDisallowed;
  const requiresReadTool = input.inheritSkills || input.requireReadTool === true;
  const toolPolicy = resolveToolPolicy(input.tools, requiresReadTool);
  if (toolPolicy.error) throw new Error(toolPolicy.error);
  const { namedToolNames, toolExtensionPaths, hasOnlyExtensionPaths } = toolPolicy;

  if (input.tools !== undefined) {
    if (hasOnlyExtensionPaths) {
      // Pi's --no-builtin-tools suppresses only its default builtins. Unlike --no-tools, it
      // leaves extension/custom tools active.
      args.push("--no-builtin-tools");
    } else {
      const allowedToolNames = [...namedToolNames];
      if (requiresReadTool && !allowedToolNames.includes("read")) {
        allowedToolNames.unshift("read");
      }
      if (requiresContactSupervisor && !allowedToolNames.includes(CONTACT_SUPERVISOR_TOOL_NAME)) {
        allowedToolNames.push(CONTACT_SUPERVISOR_TOOL_NAME);
      }
      if (allowedToolNames.length > 0) {
        args.push("--tools", allowedToolNames.join(","));
      } else {
        // Fail closed: an explicit policy that resolves to zero tools must not inherit Pi defaults.
        args.push("--no-tools");
      }
    }
  }
  if (contactSupervisorDisallowed) {
    args.push("--exclude-tools", CONTACT_SUPERVISOR_TOOL_NAME);
  }

  const extensionPaths: string[] = [];
  const seenCanonicalExtensionPaths = new Set<string>();
  const childCwd = input.cwd ?? process.cwd();
  for (const extPath of [
    ...toolExtensionPaths,
    ...(input.extensions ?? []),
    ...(input.subagentOnlyExtensions ?? []),
  ]) {
    // Keep the first spelling and position while matching Pi's realpath-based
    // extension identity for aliases and symlinked paths.
    appendUniqueChildExtensionPath(extensionPaths, seenCanonicalExtensionPaths, extPath, childCwd);
  }
  // Keep the prompt runtime final among CLI child extensions; its durable
  // forceSystemPrompt guard also survives later discovered handlers.
  const runtimeCanonicalPath = canonicalChildExtensionPath(PROMPT_RUNTIME_EXTENSION_PATH, childCwd);
  const runtimeIndex = extensionPaths.findIndex(
    (extPath) => canonicalChildExtensionPath(extPath, childCwd) === runtimeCanonicalPath,
  );
  const runtimeExtensionPath =
    runtimeIndex === -1 ? PROMPT_RUNTIME_EXTENSION_PATH : extensionPaths[runtimeIndex];
  if (runtimeIndex !== -1) extensionPaths.splice(runtimeIndex, 1);
  extensionPaths.push(runtimeExtensionPath);
  if (input.extensions !== undefined) {
    args.push("--no-extensions");
  }
  for (const extPath of extensionPaths) {
    args.push("--extension", extPath);
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
  // Always overwrite inherited ticket state. A missing assignment clears it so
  // a child cannot accidentally retain its parent's ticket reminder.
  env[SUBAGENT_TK_TICKET_ID_ENV] =
    input.projectAgentGuidance === true && input.childAgentName === "developer"
      ? input.ticketId
      : undefined;
  // Omitted supervisorBridge preserves native supervision; false must suppress
  // both prompt guidance and runtime tool registration in the child.
  env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] = contactSupervisorDisallowed ? "0" : "1";
  if (input.parentSessionId) {
    env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = input.parentSessionId;
  }
  if (
    !contactSupervisorDisallowed &&
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
  if (input.steerInboxDir) {
    env[SUBAGENT_STEER_INBOX_ENV] = input.steerInboxDir;
  }

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
