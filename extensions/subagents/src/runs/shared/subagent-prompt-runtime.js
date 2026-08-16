import * as fs from "node:fs";
import * as path from "node:path";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.js";
import { consumeChildMessageRequestsFromDir, writeChildMessageRequestToDir, } from "../background/control-channel.js";
import { SUBAGENT_STEER_INBOX_ENV } from "./pi-args.js";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue, } from "./structured-output.js";
import { TOOL_BUDGET_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge, } from "./tool-budget.js";
import { PARENT_ONLY_NUDGE_TEXTS } from "./nudge-texts.js";
const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const STRUCTURED_OUTPUT_INSTRUCTIONS = [
    "This subagent step has a strict structured output contract.",
    "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
    "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");
export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
    "You are a child subagent, not the parent orchestrator.",
    "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
    "Ignore prior parent-only orchestration instructions in inherited conversation history.",
    "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
    "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
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
function stripChildBoundaryInstructions(prompt) {
    let rewritten = prompt;
    rewritten = rewritten.split(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS).join("");
    return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}
export function rewriteSubagentPrompt(prompt, options) {
    let rewritten = prompt;
    if (!options.inheritProjectContext) {
        rewritten = stripProjectContext(rewritten);
    }
    if (!options.inheritSkills) {
        rewritten = stripInheritedSkills(rewritten);
    }
    rewritten = stripSubagentOrchestrationSkill(rewritten);
    rewritten = stripChildBoundaryInstructions(rewritten);
    const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]
        ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}`
        : "";
    return `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}${structured}\n\n${rewritten}`;
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
    const m = message;
    if (m?.role !== "assistant" || !Array.isArray(m.content))
        return message;
    const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
    if (filteredContent.length === m.content.length)
        return message;
    if (filteredContent.length === 0)
        return undefined;
    return { ...m, content: filteredContent };
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
export function formatSteerMessage(request) {
    return [
        "Mid-run steering from the parent orchestrator:",
        "",
        request.message,
        "",
        "Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
    ].join("\n");
}
export function formatResumeMessage(request) {
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
function registerToolBudget(pi, budget) {
    if (!budget)
        return;
    let toolCount = 0;
    let softNudged = false;
    const sendUserMessage = pi.sendUserMessage;
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("tool_call", (event) => {
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
    const sendUserMessage = pi.sendUserMessage;
    if (typeof sendUserMessage !== "function")
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
        return undefined;
    };
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("session_start", () => start());
    for (const eventName of [
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "turn_end",
    ]) {
        onRuntimeEvent(eventName, activate);
    }
    onRuntimeEvent("session_shutdown", () => {
        disposed = true;
        try {
            watcher?.close();
        }
        catch {
            void 0;
        }
        if (interval)
            clearInterval(interval);
    });
}
export default function registerSubagentPromptRuntime(pi) {
    registerSteeringInbox(pi);
    registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV]));
    let nativeSupervisorClientRegistered = false;
    const registerNativeSupervisorClientOnce = () => {
        if (nativeSupervisorClientRegistered)
            return;
        nativeSupervisorClientRegistered = true;
        registerNativeSupervisorClient(pi);
    };
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("session_start", registerNativeSupervisorClientOnce);
    const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
    const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
    if (structuredOutputPath && structuredSchemaPath) {
        const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8"));
        const parameters = {
            type: "object",
            properties: { value: schema },
            required: ["value"],
            additionalProperties: false,
        };
        const registerTool = pi.registerTool;
        registerTool({
            name: "structured_output",
            label: "Structured Output",
            description: "Submit the required final structured output for this subagent step. This terminates the step.",
            parameters: parameters,
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
    onRuntimeEvent("context", (event) => {
        if (!event ||
            typeof event !== "object" ||
            !Array.isArray(event.messages))
            return undefined;
        const contextEvent = event;
        const messages = stripParentOnlySubagentMessages(contextEvent.messages);
        if (messages === contextEvent.messages)
            return undefined;
        return { messages };
    });
    onRuntimeEvent("before_agent_start", async (event) => {
        if (!event ||
            typeof event !== "object" ||
            typeof event.systemPrompt !== "string")
            return undefined;
        const startEvent = event;
        const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
        if (intercomSessionName && typeof pi.setSessionName === "function") {
            pi.setSessionName(intercomSessionName);
        }
        const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
        const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
        if (inheritProjectContext === undefined && inheritSkills === undefined)
            return;
        const rewritten = rewriteSubagentPrompt(startEvent.systemPrompt, {
            inheritProjectContext: inheritProjectContext ?? true,
            inheritSkills: inheritSkills ?? true,
        });
        if (rewritten === startEvent.systemPrompt)
            return;
        return { systemPrompt: rewritten };
    });
}
