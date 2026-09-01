import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerNativeSupervisorClient } from "../../supervisor/native-supervisor-channel.js";
import { consumeChildMessageRequestsFromDir, writeChildMessageRequestToDir, } from "../background/control-channel.js";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_CHILD_INDEX_ENV, SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV, SUBAGENT_RUN_ID_ENV, SUBAGENT_STEER_INBOX_ENV, SUBAGENT_SUPERVISOR_BRIDGE_ENV, SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV, } from "./pi-args.js";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, STRUCTURED_OUTPUT_TOOL_NAME, assertJsonSchemaObject, validateStructuredOutputValue, } from "./structured-output.js";
import { TOOL_BUDGET_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge, } from "./tool-budget.js";
import { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, composeChildPromptRuntime, } from "../../../../shared/subagent-child-boundary.js";
import { formatProjectAgentGuidance, inventoryProjectAgentGuidance, PACKAGED_MINOR_AGENT_ROLES, } from "../../../../shared/project-agent-guidance.js";
export { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS };
const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
const STRUCTURED_OUTPUT_INSTRUCTIONS = [
    "This subagent step has a strict structured output contract.",
    "Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
    "Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");
export const NATIVE_SUPERVISOR_GUIDANCE = [
    "Native supervisor coordination:",
    "The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.",
    "",
    "Use `contact_supervisor` when you need supervisor coordination:",
    '- Need a decision, blocked, approval, or product/API/scope clarification: contact_supervisor({ reason: "need_decision", message: "<question>" })',
    "- Blocking supervisor requests durably pause the child. Once that blocking tool call starts, this OS process will stop; no child process keeps running during the pause.",
    "- The parent must explicitly resume the paused child unchanged, resume it with guidance, or cancel it. Do not retry the request or assume the same child process will still be live.",
    '- Meaningful progress or an unexpected discovery that changes the plan: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })',
    "",
    "Do not use contact_supervisor for routine completion handoffs. If no coordination is needed, return a focused task result.",
].join("\n");
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
export function rewriteSubagentPrompt(prompt, options, projectAgentGuidance = "", supervisorGuidance = "") {
    let rewritten = prompt;
    if (!options.inheritProjectContext) {
        rewritten = stripProjectContext(rewritten);
    }
    if (!options.inheritSkills) {
        rewritten = stripInheritedSkills(rewritten);
    }
    rewritten = stripSubagentOrchestrationSkill(rewritten);
    const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]
        ? STRUCTURED_OUTPUT_INSTRUCTIONS
        : "";
    return composeChildPromptRuntime(rewritten, [projectAgentGuidance, supervisorGuidance, structured], "explicit");
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
function hasNativeSupervisorMetadata() {
    const required = [
        SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
        SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
        SUBAGENT_RUN_ID_ENV,
        SUBAGENT_CHILD_AGENT_ENV,
    ];
    if (required.some((name) => !process.env[name]?.trim()))
        return false;
    const childIndex = process.env[SUBAGENT_CHILD_INDEX_ENV]?.trim();
    return childIndex !== undefined && /^\d+$/.test(childIndex);
}
function resolveChildSupervisorGuidance() {
    if (process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] === "0")
        return "";
    if (process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] === "1")
        return "";
    return hasNativeSupervisorMetadata() ? NATIVE_SUPERVISOR_GUIDANCE : "";
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
    let supervisorGuidanceSnapshot = "";
    const handleSessionStart = (_event, ctx) => {
        if (!nativeSupervisorClientRegistered) {
            nativeSupervisorClientRegistered = true;
            registerNativeSupervisorClient(pi);
        }
        projectAgentGuidanceSnapshot = resolveChildProjectAgentGuidance(ctx.cwd);
        supervisorGuidanceSnapshot = resolveChildSupervisorGuidance();
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
            name: STRUCTURED_OUTPUT_TOOL_NAME,
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
    pi.on("before_agent_start", (event) => {
        const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
        const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
        if (inheritProjectContext === undefined &&
            inheritSkills === undefined &&
            projectAgentGuidanceSnapshot.length === 0 &&
            supervisorGuidanceSnapshot.length === 0)
            return undefined;
        const rewritten = rewriteSubagentPrompt(event.systemPrompt, {
            inheritProjectContext: inheritProjectContext ?? true,
            inheritSkills: inheritSkills ?? true,
        }, projectAgentGuidanceSnapshot, supervisorGuidanceSnapshot);
        if (rewritten === event.systemPrompt)
            return undefined;
        return { systemPrompt: rewritten };
    });
}
