import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNestedPathEnv, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.ts";
import { TEMP_ROOT_DIR, type JsonSchemaObject, type ResolvedToolBudget } from "../../shared/types.ts";
import { findModelInfo, getSupportedThinkingLevels, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../../shared/model-info.ts";
import { TOOL_BUDGET_ENV, encodeToolBudgetEnv } from "./tool-budget.ts";

const TASK_ARG_LIMIT = 8000;
const RUNTIME_EXTENSION_SUFFIX = path.extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js";
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), `subagent-prompt-runtime${RUNTIME_EXTENSION_SUFFIX}`);
const FANOUT_CHILD_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", `fanout-child${RUNTIME_EXTENSION_SUFFIX}`);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH_ENV = "PI_SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH";
export type BlockingSupervisorReplyPathCapability = "live" | "unavailable";
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
export const SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
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
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPrompt?: string | null;
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	blockingSupervisorReplyPath?: BlockingSupervisorReplyPathCapability;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	parentEventSink?: string;
	parentControlInbox?: string;
	parentRootRunId?: string;
	parentRunId?: string;
	parentChildIndex?: number;
	parentDepth?: number;
	parentPath?: NestedPathEntry[];
	parentCapabilityToken?: string;
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

function sanitizeSupervisorChannelSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function supervisorChannelDir(runId: string, agent: string, childIndex: number): string {
	return path.join(TEMP_ROOT_DIR, "supervisor-channels", `${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`);
}

export interface ThinkingSuffixOptions {
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
	if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) return undefined;
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

	const declaredBuiltinToolsBase = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	const declaredBuiltinTools = input.requireReadTool && input.tools?.length && !declaredBuiltinToolsBase.includes("read")
		? ["read", ...declaredBuiltinToolsBase]
		: declaredBuiltinToolsBase;
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools = [...declaredBuiltinTools];
		for (const tool of input.tools) {
			if (!declaredBuiltinTools.includes(tool) && (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) {
				toolExtensionPaths.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
	}

	const runtimeExtensions = fanoutAuthorized
		? [PROMPT_RUNTIME_EXTENSION_PATH, FANOUT_CHILD_EXTENSION_PATH]
		: [PROMPT_RUNTIME_EXTENSION_PATH];
	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...input.extensions, ...(input.subagentOnlyExtensions ?? [])])]) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...(input.subagentOnlyExtensions ?? [])])]) {
			args.push("--extension", extPath);
		}
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = fanoutAuthorized ? "1" : "0";
	const inheritedNestedRoute = Boolean(process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] && process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] && process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]);
	const parentRunId = input.parentRunId ?? input.runId ?? (inheritedNestedRoute ? process.env[SUBAGENT_RUN_ID_ENV] : undefined) ?? process.env[SUBAGENT_PARENT_RUN_ID_ENV] ?? "";
	const parentChildIndex = input.parentChildIndex !== undefined
		? String(input.parentChildIndex)
		: input.childIndex !== undefined
			? String(input.childIndex)
			: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] ?? "";
	const inheritedDepth = Number(process.env[SUBAGENT_PARENT_DEPTH_ENV]);
	const parentDepth = input.parentDepth ?? (inheritedNestedRoute && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : 1);
	const parentPath = input.parentPath ?? [
		...parseNestedPathEnv(process.env[SUBAGENT_PARENT_PATH_ENV]),
		...(parentRunId ? [{
			runId: parentRunId,
			...(parentChildIndex && /^\d+$/.test(parentChildIndex) ? { stepIndex: Number(parentChildIndex) } : {}),
			...(input.childAgentName ? { agent: input.childAgentName } : {}),
		}] : []),
	];
	env[SUBAGENT_PARENT_EVENT_SINK_ENV] = fanoutAuthorized
		? input.parentEventSink ?? process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] ?? ""
		: "";
	env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = fanoutAuthorized
		? input.parentControlInbox ?? process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] ?? ""
		: "";
	env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = fanoutAuthorized
		? input.parentRootRunId ?? process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] ?? input.runId ?? ""
		: "";
	env[SUBAGENT_PARENT_RUN_ID_ENV] = fanoutAuthorized ? parentRunId : "";
	env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = fanoutAuthorized ? parentChildIndex : "";
	env[SUBAGENT_PARENT_DEPTH_ENV] = fanoutAuthorized ? String(parentDepth) : "";
	env[SUBAGENT_PARENT_PATH_ENV] = fanoutAuthorized ? encodeNestedPathEnv(parentPath) : "";
	env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = fanoutAuthorized
		? input.parentCapabilityToken ?? process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] ?? ""
		: "";
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
	if (input.intercomSessionName) {
		env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	env[SUBAGENT_BLOCKING_SUPERVISOR_REPLY_PATH_ENV] = input.blockingSupervisorReplyPath ?? "";
	if (input.parentSessionId) {
		env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = input.parentSessionId;
	}
	if (input.orchestratorIntercomTarget && input.parentSessionId && input.runId && input.childAgentName) {
		const childIndex = input.childIndex ?? 0;
		const channelDir = supervisorChannelDir(input.runId, input.childAgentName, childIndex);
		fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true });
		fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true });
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

	env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? "";

	return { args, env, tempDir };
}

export const parseParentPathEnv = parseNestedPathEnv;

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
