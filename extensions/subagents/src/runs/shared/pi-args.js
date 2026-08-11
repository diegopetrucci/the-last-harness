import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.js";
import { TEMP_ROOT_DIR } from "../../shared/types.js";
import { findModelInfo, getSupportedThinkingLevels, THINKING_LEVELS, } from "../../shared/model-info.js";
import { TOOL_BUDGET_ENV, encodeToolBudgetEnv } from "./tool-budget.js";
const TASK_ARG_LIMIT = 8000;
const RUNTIME_EXTENSION_SUFFIX = path.extname(fileURLToPath(import.meta.url)) === ".ts" ? ".ts" : ".js";
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), `subagent-prompt-runtime${RUNTIME_EXTENSION_SUFFIX}`);
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
export const SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
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
function sanitizeSupervisorChannelSegment(value) {
    return (value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown");
}
function supervisorChannelDir(runId, agent, childIndex) {
    return path.join(TEMP_ROOT_DIR, "supervisor-channels", `${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`);
}
function shouldDropThinkingLevel(modelInfo, thinking) {
    if (!modelInfo)
        return false;
    if (modelInfo.reasoning === false)
        return thinking !== "off";
    if (!modelInfo.thinkingLevelMap)
        return false;
    return !getSupportedThinkingLevels(modelInfo).includes(thinking);
}
export function getThinkingLevelDropNote(model, thinking, replaceExisting = false, options) {
    if (!model || !thinking || replaceExisting)
        return undefined;
    const colonIdx = model.lastIndexOf(":");
    if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1)))
        return undefined;
    const modelInfo = findModelInfo(model, options?.availableModels, options?.preferredModelProvider);
    if (!shouldDropThinkingLevel(modelInfo, thinking))
        return undefined;
    return `Notice: Thinking level "${thinking}" was dropped for model "${model}" because the model registry does not advertise support.`;
}
export function applyThinkingSuffix(model, thinking, replaceExisting = false, options) {
    if (!model || !thinking)
        return model;
    const colonIdx = model.lastIndexOf(":");
    if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) {
        return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
    }
    if (!replaceExisting && getThinkingLevelDropNote(model, thinking, false, options))
        return model;
    return `${model}:${thinking}`;
}
export function buildPiArgs(input) {
    const args = [...input.baseArgs];
    if (input.sessionFile) {
        fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
        args.push("--session", input.sessionFile);
    }
    else {
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
    const toolExtensionPaths = [];
    if (input.tools?.length) {
        const builtinTools = [...declaredBuiltinTools];
        for (const tool of input.tools) {
            if (!declaredBuiltinTools.includes(tool) &&
                (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) {
                toolExtensionPaths.push(tool);
            }
        }
        if (builtinTools.length > 0) {
            args.push("--tools", builtinTools.join(","));
        }
    }
    const runtimeExtensions = [PROMPT_RUNTIME_EXTENSION_PATH];
    if (input.extensions !== undefined) {
        args.push("--no-extensions");
        for (const extPath of [
            ...new Set([
                ...runtimeExtensions,
                ...toolExtensionPaths,
                ...input.extensions,
                ...(input.subagentOnlyExtensions ?? []),
            ]),
        ]) {
            args.push("--extension", extPath);
        }
    }
    else {
        for (const extPath of [
            ...new Set([...runtimeExtensions, ...toolExtensionPaths, ...(input.subagentOnlyExtensions ?? [])]),
        ]) {
            args.push("--extension", extPath);
        }
    }
    if (!input.inheritSkills) {
        args.push("--no-skills");
    }
    let tempDir;
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
    }
    else {
        args.push(`Task: ${input.task}`);
    }
    const env = {};
    env[SUBAGENT_CHILD_ENV] = "1";
    env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
    env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
    if (input.intercomSessionName) {
        env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
    }
    if (input.orchestratorIntercomTarget) {
        env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
    }
    if (input.parentSessionId) {
        env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = input.parentSessionId;
    }
    if (input.orchestratorIntercomTarget && input.parentSessionId && input.runId && input.childAgentName) {
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
    env.MCP_DIRECT_TOOLS = "__none__";
    if (input.structuredOutput) {
        env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
        env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
    }
    if (input.steerInboxDir) {
        env[SUBAGENT_STEER_INBOX_ENV] = input.steerInboxDir;
    }
    const encodedToolBudget = encodeToolBudgetEnv(input.toolBudget);
    if (encodedToolBudget)
        env[TOOL_BUDGET_ENV] = encodedToolBudget;
    env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? "";
    return { args, env, tempDir };
}
export function cleanupTempDir(tempDir) {
    if (!tempDir)
        return;
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    catch {
    }
}
