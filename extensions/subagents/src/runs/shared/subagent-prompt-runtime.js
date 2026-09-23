import * as fs from "node:fs";
import { getAgentDir, } from "@earendil-works/pi-coding-agent";
import { registerNativeSupervisorClient } from "../../supervisor/native-supervisor-channel.js";
import { consumeChildMessageRequestsFromDir, writeChildMessageRequestToDir, } from "../background/control-channel.js";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_CHILD_INDEX_ENV, SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV, SUBAGENT_RUN_ID_ENV, SUBAGENT_STEER_INBOX_ENV, SUBAGENT_SUPERVISOR_BRIDGE_ENV, SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV, SUBAGENT_TK_TICKET_ID_ENV, } from "./pi-args.js";
import { TOOL_BUDGET_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge, } from "./tool-budget.js";
import { blockForcedSystemPrompt, CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION, setStructuredChildPromptRuntime, } from "../../../../shared/subagent-child-boundary.js";
import { formatProjectAgentGuidance, inventoryProjectAgentGuidance, PACKAGED_MINOR_AGENT_ROLES, } from "../../../../shared/project-agent-guidance.js";
import { normalizeTkTicketId } from "./tk-ticket.js";
export { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS };
const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
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
const SUBAGENT_ORCHESTRATION_SKILL_NAME = "pi-subagents";
function readBooleanEnv(name) {
    const value = process.env[name];
    if (value === undefined)
        return undefined;
    return value !== "0";
}
export function stripSubagentOrchestrationSkill(prompt) {
    return prompt
        .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
        .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}
function isOrchestrationSkill(name) {
    return name.trim().toLowerCase() === SUBAGENT_ORCHESTRATION_SKILL_NAME;
}
function sanitizePromptOption(value) {
    return value === undefined ? undefined : stripSubagentOrchestrationSkill(value);
}
function rewriteStructuredSubagentPrompt(systemPromptOptions, options, projectAgentGuidance, supervisorGuidance, tkTicketGuidance) {
    blockForcedSystemPrompt(systemPromptOptions);
    if (!options.inheritProjectContext) {
        systemPromptOptions.contextFiles = [];
        delete systemPromptOptions.sections.project_context;
    }
    systemPromptOptions.skills = options.inheritSkills
        ? systemPromptOptions.skills.filter((skill) => !isOrchestrationSkill(skill.name))
        : [];
    if (!options.inheritSkills) {
        delete systemPromptOptions.sections.skills;
    }
    else if (systemPromptOptions.sections.skills !== undefined) {
        const sanitizedSkills = stripSubagentOrchestrationSkill(systemPromptOptions.sections.skills);
        if (sanitizedSkills.trim())
            systemPromptOptions.sections.skills = sanitizedSkills;
        else
            delete systemPromptOptions.sections.skills;
    }
    systemPromptOptions.customPrompt = sanitizePromptOption(systemPromptOptions.customPrompt);
    systemPromptOptions.appendSystemPrompt =
        sanitizePromptOption(systemPromptOptions.appendSystemPrompt) ?? "";
    for (const [name, content] of Object.entries(systemPromptOptions.sections)) {
        if (name === CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION)
            continue;
        const sanitized = stripSubagentOrchestrationSkill(content);
        if (sanitized !== content)
            systemPromptOptions.sections[name] = sanitized;
    }
    setStructuredChildPromptRuntime(systemPromptOptions.sections, "explicit", [
        projectAgentGuidance,
        supervisorGuidance,
        tkTicketGuidance,
    ]);
}
export function rewriteSubagentPrompt(systemPromptOptions, options, projectAgentGuidance = "", supervisorGuidance = "", tkTicketGuidance = "") {
    rewriteStructuredSubagentPrompt(systemPromptOptions, options, projectAgentGuidance, supervisorGuidance, tkTicketGuidance);
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
function resolveChildTkTicketId() {
    const childAgentName = process.env[SUBAGENT_CHILD_AGENT_ENV];
    if (childAgentName !== "developer" || process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] !== "1")
        return undefined;
    return normalizeTkTicketId(process.env[SUBAGENT_TK_TICKET_ID_ENV]);
}
function formatChildTkTicketGuidance(ticketId) {
    return [
        "Developer ticket assignment:",
        `Ticket ID: ${ticketId}`,
        `Before making any changes, run \`tk show ${ticketId}\` and treat that ticket as the source of truth.`,
    ].join("\n");
}
function formatDeveloperCompactionReminder(ticketId) {
    return [
        "Developer scope reminder after compaction:",
        `Re-run \`tk show ${ticketId}\`, reread its acceptance criteria, and remain within the ticket's scope before continuing.`,
    ].join("\n");
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
    let tkTicketGuidanceSnapshot = "";
    let tkTicketIdSnapshot;
    const handleSessionStart = (_event, ctx) => {
        if (!nativeSupervisorClientRegistered) {
            nativeSupervisorClientRegistered = true;
            registerNativeSupervisorClient(pi);
        }
        projectAgentGuidanceSnapshot = resolveChildProjectAgentGuidance(ctx.cwd);
        supervisorGuidanceSnapshot = resolveChildSupervisorGuidance();
        tkTicketIdSnapshot = resolveChildTkTicketId();
        tkTicketGuidanceSnapshot = tkTicketIdSnapshot
            ? formatChildTkTicketGuidance(tkTicketIdSnapshot)
            : "";
    };
    pi.on("session_start", handleSessionStart);
    pi.on("session_compact", (event) => {
        if (!tkTicketIdSnapshot)
            return;
        pi.sendMessage({
            customType: "tlh-developer-scope-reminder",
            content: formatDeveloperCompactionReminder(tkTicketIdSnapshot),
            display: true,
        }, { deliverAs: event.willRetry ? "steer" : "nextTurn" });
    });
    pi.on("before_agent_start", (event) => {
        const projectInheritance = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV) ?? true;
        const skillsInheritance = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV) ?? true;
        rewriteSubagentPrompt(event.systemPromptOptions, { inheritProjectContext: projectInheritance, inheritSkills: skillsInheritance }, projectAgentGuidanceSnapshot, supervisorGuidanceSnapshot, tkTicketGuidanceSnapshot);
        return undefined;
    });
}
