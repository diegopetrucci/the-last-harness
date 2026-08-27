import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.js";
import { consumeChildMessageRequestsFromDir, writeChildMessageRequestToDir, } from "../background/control-channel.js";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV, SUBAGENT_STEER_INBOX_ENV, } from "./pi-args.js";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, assertJsonSchemaObject, validateStructuredOutputValue, } from "./structured-output.js";
import { TOOL_BUDGET_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge, } from "./tool-budget.js";
import { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS } from "../../../../shared/subagent-child-boundary.js";
import { formatProjectAgentGuidance, inventoryProjectAgentGuidance, PACKAGED_MINOR_AGENT_ROLES, } from "../../../../shared/project-agent-guidance.js";
import { PARENT_ONLY_NUDGE_TEXTS } from "./nudge-texts.js";
export { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS };
const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const STRUCTURED_OUTPUT_INSTRUCTIONS = [
    "This subagent step has a strict structured output contract.",
    "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
    "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");
const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
    "subagent-orchestration-instructions",
    "subagent-slash-result",
    "subagent-slash-text-result",
    "subagent-notify",
    "subagent_control_notice",
    "subagent-control",
    "subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";
function readBooleanEnv(name) {
    const value = process.env[name];
    if (value === undefined)
        return undefined;
    return value !== "0";
}
function findSectionEnd(prompt, startIndex, nextHeaders) {
    let endIndex = prompt.length;
    for (const header of nextHeaders) {
        const index = prompt.indexOf(header, startIndex);
        if (index !== -1 && index < endIndex) {
            endIndex = index;
        }
    }
    return endIndex;
}
export function stripProjectContext(prompt) {
    const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
    if (startIndex === -1)
        return prompt;
    const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [
        SKILLS_HEADER,
        DATE_HEADER,
    ]);
    return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}
export function stripInheritedSkills(prompt) {
    const startIndex = prompt.indexOf(SKILLS_HEADER);
    if (startIndex === -1)
        return prompt;
    const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
    return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}
export function stripSubagentOrchestrationSkill(prompt) {
    return prompt
        .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
        .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}
const TRAILING_WHITESPACE_PATTERN = /\s*$/u;
const RUNTIME_SEPARATOR_PATTERN = /[ \t]*(?:\r?\n[ \t]*)+$/u;
function stripTerminalRuntimeBlock(prompt, block) {
    const trailingWhitespace = prompt.match(TRAILING_WHITESPACE_PATTERN)?.[0] ?? "";
    const contentEnd = prompt.length - trailingWhitespace.length;
    const blockStart = contentEnd - block.length;
    if (blockStart < 0 || prompt.slice(blockStart, contentEnd) !== block)
        return undefined;
    return prompt.slice(0, blockStart).replace(RUNTIME_SEPARATOR_PATTERN, "");
}
function stripRuntimeOwnedSuffix(prompt, projectAgentGuidance) {
    const withoutBoundary = stripTerminalRuntimeBlock(prompt, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS);
    if (withoutBoundary === undefined)
        return prompt;
    let rewritten = withoutBoundary;
    rewritten = stripTerminalRuntimeBlock(rewritten, STRUCTURED_OUTPUT_INSTRUCTIONS) ?? rewritten;
    if (projectAgentGuidance) {
        rewritten = stripTerminalRuntimeBlock(rewritten, projectAgentGuidance) ?? rewritten;
    }
    return rewritten;
}
export function rewriteSubagentPrompt(prompt, options, projectAgentGuidance = "") {
    let rewritten = prompt;
    if (!options.inheritProjectContext) {
        rewritten = stripProjectContext(rewritten);
    }
    if (!options.inheritSkills) {
        rewritten = stripInheritedSkills(rewritten);
    }
    rewritten = stripSubagentOrchestrationSkill(rewritten);
    rewritten = stripRuntimeOwnedSuffix(rewritten, projectAgentGuidance);
    const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]
        ? STRUCTURED_OUTPUT_INSTRUCTIONS
        : "";
    return [rewritten, projectAgentGuidance, structured, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS]
        .filter(Boolean)
        .join("\n\n");
}
function userMessageTextContent(message) {
    const m = message;
    if (m?.role !== "user")
        return undefined;
    if (typeof m.content === "string")
        return m.content.trim();
    if (Array.isArray(m.content) && m.content.length === 1) {
        const block = m.content[0];
        if (block?.type === "text" && typeof block.text === "string")
            return block.text.trim();
    }
    return undefined;
}
function isParentOnlySubagentMessage(message) {
    const m = message;
    if (m?.role === "custom" &&
        typeof m.customType === "string" &&
        PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType))
        return true;
    const text = userMessageTextContent(message);
    if (text !== undefined && PARENT_ONLY_NUDGE_TEXTS.has(text))
        return true;
    return false;
}
function isSubagentToolResultMessage(message) {
    const m = message;
    return m?.role === "toolResult" && m.toolName === "subagent";
}
function isSubagentToolCallBlock(block) {
    const b = block;
    return b?.type === "toolCall" && b.name === "subagent";
}
function stripAssistantSubagentToolCallBlocks(message) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return message;
    const filteredContent = message.content.filter((block) => !isSubagentToolCallBlock(block));
    if (filteredContent.length === message.content.length)
        return message;
    if (filteredContent.length === 0)
        return undefined;
    return { ...message, content: filteredContent };
}
export function stripParentOnlySubagentMessages(messages) {
    let changed = false;
    const filtered = [];
    for (const message of messages) {
        if (isParentOnlySubagentMessage(message) || isSubagentToolResultMessage(message)) {
            changed = true;
            continue;
        }
        const stripped = stripAssistantSubagentToolCallBlocks(message);
        if (stripped === undefined) {
            changed = true;
            continue;
        }
        if (stripped !== message)
            changed = true;
        filtered.push(stripped);
    }
    return changed ? filtered : messages;
}
function formatSteerMessage(request) {
    return [
        "Mid-run steering from the parent orchestrator:",
        "",
        request.message,
        "",
        "Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
    ].join("\n");
}
function formatResumeMessage(request) {
    return [
        "Resume follow-up from the parent orchestrator:",
        "",
        request.message,
        "",
        "Continue the current task with this follow-up at the next safe point. Do not restart the task unless the follow-up explicitly asks you to.",
    ].join("\n");
}
function formatChildMessage(request) {
    return request.type === "resume" ? formatResumeMessage(request) : formatSteerMessage(request);
}
function resolveChildProjectAgentGuidance(cwd) {
    const childAgentName = process.env[SUBAGENT_CHILD_AGENT_ENV];
    const childRole = PACKAGED_MINOR_AGENT_ROLES.find((role) => role === childAgentName);
    if (!childRole || process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] !== "1")
        return "";
    const inventory = inventoryProjectAgentGuidance(cwd, getAgentDir());
    return formatProjectAgentGuidance(inventory, childRole);
}
function registerToolBudget(pi, budget) {
    if (!budget)
        return;
    let toolCount = 0;
    let softNudged = false;
    const sendUserMessage = typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;
    pi.on("tool_call", (event) => {
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
        toolCount++;
        if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
            softNudged = true;
            try {
                sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
            }
            catch {
            }
        }
        if (!shouldBlockToolForBudget(budget, toolName, toolCount))
            return undefined;
        return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
    });
}
function registerSteeringInbox(pi) {
    const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
    if (!steerInbox)
        return;
    const sendUserMessage = typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;
    if (!sendUserMessage)
        return;
    let canSteer = false;
    let disposed = false;
    let flushing = false;
    let started = false;
    let watcher;
    let interval;
    const flush = () => {
        if (disposed || flushing || !canSteer)
            return;
        flushing = true;
        try {
            const requests = consumeChildMessageRequestsFromDir(steerInbox);
            for (let index = 0; index < requests.length; index++) {
                const request = requests[index];
                try {
                    sendUserMessage(formatChildMessage(request), { deliverAs: "steer" });
                }
                catch {
                    for (const pending of requests.slice(index))
                        writeChildMessageRequestToDir(steerInbox, pending);
                    break;
                }
            }
        }
        finally {
            flushing = false;
        }
    };
    const start = () => {
        if (started || disposed)
            return;
        try {
            fs.mkdirSync(steerInbox, { recursive: true });
        }
        catch {
            return;
        }
        started = true;
        try {
            watcher = fs.watch(steerInbox, () => flush());
            watcher.on("error", () => { });
        }
        catch {
            watcher = undefined;
        }
        interval = setInterval(flush, 250);
        interval.unref?.();
    };
    const activate = () => {
        start();
        canSteer = true;
        flush();
    };
    pi.on("session_start", () => start());
    pi.on("message_start", activate);
    pi.on("message_update", activate);
    pi.on("message_end", activate);
    pi.on("tool_execution_start", activate);
    pi.on("tool_execution_end", activate);
    pi.on("turn_end", activate);
    pi.on("session_shutdown", () => {
        disposed = true;
        try {
            watcher?.close();
        }
        catch {
        }
        if (interval)
            clearInterval(interval);
    });
}
export default function registerSubagentPromptRuntime(pi) {
    registerSteeringInbox(pi);
    registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV]));
    let nativeSupervisorClientRegistered = false;
    let projectAgentGuidanceSnapshot = "";
    const handleSessionStart = (_event, ctx) => {
        if (!nativeSupervisorClientRegistered) {
            nativeSupervisorClientRegistered = true;
            registerNativeSupervisorClient(pi);
        }
        projectAgentGuidanceSnapshot = resolveChildProjectAgentGuidance(ctx.cwd);
    };
    pi.on("session_start", handleSessionStart);
    const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
    const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
    if (structuredOutputPath && structuredSchemaPath) {
        const parsedSchema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8"));
        assertJsonSchemaObject(parsedSchema, "structured output schema");
        const schema = parsedSchema;
        const parameters = Type.Unsafe({
            type: "object",
            properties: { value: schema },
            required: ["value"],
            additionalProperties: false,
        });
        pi.registerTool({
            name: "structured_output",
            label: "Structured Output",
            description: "Submit the required final structured output for this subagent step. This terminates the step.",
            parameters,
            async execute(_id, params) {
                const validation = validateStructuredOutputValue(schema, params.value);
                if (validation.status === "invalid") {
                    throw new Error(`Structured output validation failed: ${validation.message}`);
                }
                fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
                fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
                return {
                    content: [{ type: "text", text: "Structured output captured." }],
                    details: { path: structuredOutputPath },
                    terminate: true,
                };
            },
        });
    }
    pi.on("context", (event) => {
        const messages = stripParentOnlySubagentMessages(event.messages);
        if (messages === event.messages)
            return undefined;
        return { messages };
    });
    pi.on("before_agent_start", (event) => {
        const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
        if (intercomSessionName && typeof pi.setSessionName === "function") {
            pi.setSessionName(intercomSessionName);
        }
        const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
        const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
        if (inheritProjectContext === undefined &&
            inheritSkills === undefined &&
            projectAgentGuidanceSnapshot.length === 0)
            return undefined;
        const rewritten = rewriteSubagentPrompt(event.systemPrompt, {
            inheritProjectContext: inheritProjectContext ?? true,
            inheritSkills: inheritSkills ?? true,
        }, projectAgentGuidanceSnapshot);
        if (rewritten === event.systemPrompt)
            return undefined;
        return { systemPrompt: rewritten };
    });
}
