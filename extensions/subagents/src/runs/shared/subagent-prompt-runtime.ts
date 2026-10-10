import * as fs from "node:fs";
import {
  getAgentDir,
  type ExtensionAPI,
  type NormalizedBuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { registerNativeSupervisorClient } from "../../supervisor/native-supervisor-channel.ts";
import {
  consumeChildMessageRequestsFromDir,
  writeChildMessageRequestToDir,
  type ChildMessageRequest,
  type ResumeRequest,
  type SteerRequest,
} from "../background/control-channel.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_CHILD_INDEX_ENV,
  SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_STEER_INBOX_ENV,
  SUBAGENT_SUPERVISOR_BRIDGE_ENV,
  SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
  SUBAGENT_TK_TICKET_ID_ENV,
} from "./pi-args.ts";
import {
  TOOL_BUDGET_ENV,
  decodeToolBudgetEnv,
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
} from "./tool-budget.ts";
import type { ResolvedToolBudget } from "../../shared/types.ts";
import {
  blockForcedSystemPrompt,
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION,
  setStructuredChildPromptRuntime,
} from "../../../../shared/subagent-child-boundary.ts";
import {
  formatProjectAgentGuidance,
  inventoryProjectAgentGuidance,
  PACKAGED_MINOR_AGENT_ROLES,
} from "../../../../shared/project-agent-guidance.ts";
import { normalizeTkTicketId } from "./tk-ticket.ts";

export { CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS };

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";

/** Neutral fallback for custom/project agents whose prompt has no role guidance. */
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

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return value !== "0";
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
  return prompt
    .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
    .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) =>
      SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block,
    );
}

type ChildPromptInheritanceOptions = {
  inheritProjectContext: boolean;
  inheritSkills: boolean;
};

function isOrchestrationSkill(name: string): boolean {
  return name.trim().toLowerCase() === SUBAGENT_ORCHESTRATION_SKILL_NAME;
}

function sanitizePromptOption(value: string | undefined): string | undefined {
  return value === undefined ? undefined : stripSubagentOrchestrationSkill(value);
}

function rewriteStructuredSubagentPrompt(
  systemPromptOptions: NormalizedBuildSystemPromptOptions,
  options: ChildPromptInheritanceOptions,
  projectAgentGuidance: string,
  supervisorGuidance: string,
  tkTicketGuidance: string,
): void {
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
  } else if (systemPromptOptions.sections.skills !== undefined) {
    const sanitizedSkills = stripSubagentOrchestrationSkill(systemPromptOptions.sections.skills);
    if (sanitizedSkills.trim()) systemPromptOptions.sections.skills = sanitizedSkills;
    else delete systemPromptOptions.sections.skills;
  }

  systemPromptOptions.customPrompt = sanitizePromptOption(systemPromptOptions.customPrompt);
  systemPromptOptions.appendSystemPrompt =
    sanitizePromptOption(systemPromptOptions.appendSystemPrompt) ?? "";
  for (const [name, content] of Object.entries(systemPromptOptions.sections)) {
    if (name === CHILD_SUBAGENT_EXPLICIT_RUNTIME_SECTION) continue;
    const sanitized = stripSubagentOrchestrationSkill(content);
    if (sanitized !== content) systemPromptOptions.sections[name] = sanitized;
  }

  // Keep the child runtime in a dedicated structured section. Pi renders custom
  // sections after its standard context, skills, and cwd sections, so the
  // stable safety boundary remains after those sections without replacing or
  // reparsing the rendered system prompt.
  setStructuredChildPromptRuntime(systemPromptOptions.sections, "explicit", [
    projectAgentGuidance,
    supervisorGuidance,
    tkTicketGuidance,
  ]);
}

/** Rewrite a Pi 0.87 structured prompt in place. */
export function rewriteSubagentPrompt(
  systemPromptOptions: NormalizedBuildSystemPromptOptions,
  options: ChildPromptInheritanceOptions,
  projectAgentGuidance = "",
  supervisorGuidance = "",
  tkTicketGuidance = "",
): void {
  rewriteStructuredSubagentPrompt(
    systemPromptOptions,
    options,
    projectAgentGuidance,
    supervisorGuidance,
    tkTicketGuidance,
  );
}

function formatSteerMessage(request: SteerRequest): string {
  return [
    "Mid-run steering from the parent orchestrator:",
    "",
    request.message,
    "",
    "Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
  ].join("\n");
}

function formatResumeMessage(request: ResumeRequest): string {
  return [
    "Resume follow-up from the parent orchestrator:",
    "",
    request.message,
    "",
    "Continue the current task with this follow-up at the next safe point. Do not restart the task unless the follow-up explicitly asks you to.",
  ].join("\n");
}

function formatChildMessage(request: ChildMessageRequest): string {
  return request.type === "resume" ? formatResumeMessage(request) : formatSteerMessage(request);
}

function resolveChildProjectAgentGuidance(cwd: string): string {
  const childAgentName = process.env[SUBAGENT_CHILD_AGENT_ENV];
  const childRole = PACKAGED_MINOR_AGENT_ROLES.find((role) => role === childAgentName);
  if (!childRole || process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] !== "1") return "";

  const inventory = inventoryProjectAgentGuidance(cwd, getAgentDir());
  return formatProjectAgentGuidance(inventory, childRole);
}

function hasNativeSupervisorMetadata(): boolean {
  const required = [
    SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
    SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
    SUBAGENT_RUN_ID_ENV,
    SUBAGENT_CHILD_AGENT_ENV,
  ];
  if (required.some((name) => !process.env[name]?.trim())) return false;
  const childIndex = process.env[SUBAGENT_CHILD_INDEX_ENV]?.trim();
  return childIndex !== undefined && /^\d+$/.test(childIndex);
}

function resolveChildTkTicketId(): string | undefined {
  const childAgentName = process.env[SUBAGENT_CHILD_AGENT_ENV];
  if (childAgentName !== "developer" || process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] !== "1")
    return undefined;
  return normalizeTkTicketId(process.env[SUBAGENT_TK_TICKET_ID_ENV]);
}

function formatChildTkTicketGuidance(ticketId: string): string {
  return [
    "Developer ticket assignment:",
    `Ticket ID: ${ticketId}`,
    `Before making any changes, run \`tk show ${ticketId}\` and treat that ticket as the source of truth.`,
  ].join("\n");
}

function formatDeveloperCompactionReminder(ticketId: string): string {
  return [
    "Developer scope reminder after compaction:",
    `Re-run \`tk show ${ticketId}\`, reread its acceptance criteria, and remain within the ticket's scope before continuing.`,
  ].join("\n");
}

function resolveChildSupervisorGuidance(): string {
  if (process.env[SUBAGENT_SUPERVISOR_BRIDGE_ENV] === "0") return "";
  // Canonical packaged minor prompts already carry role-specific guidance. The
  // parent-verified provenance sentinel prevents same-name custom agents from
  // being mistaken for those prompts.
  if (process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] === "1") return "";
  return hasNativeSupervisorMetadata() ? NATIVE_SUPERVISOR_GUIDANCE : "";
}

function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
  if (!budget) return;
  let toolCount = 0;
  let softNudged = false;
  const sendUserMessage =
    typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;
  pi.on("tool_call", (event) => {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    toolCount++;
    if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
      softNudged = true;
      try {
        sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
      } catch {
        // Budget nudges are advisory; blocking below remains authoritative.
      }
    }
    if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
    return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
  });
}

function registerSteeringInbox(pi: ExtensionAPI): void {
  const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
  if (!steerInbox) return;
  const sendUserMessage =
    typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;
  if (!sendUserMessage) return;

  let canSteer = false;
  let disposed = false;
  let flushing = false;
  let started = false;
  let watcher: fs.FSWatcher | undefined;
  let interval: NodeJS.Timeout | undefined;
  const flush = (): void => {
    if (disposed || flushing || !canSteer) return;
    flushing = true;
    try {
      const requests = consumeChildMessageRequestsFromDir(steerInbox);
      for (let index = 0; index < requests.length; index++) {
        const request = requests[index]!;
        try {
          sendUserMessage(formatChildMessage(request), { deliverAs: "steer" });
        } catch {
          for (const pending of requests.slice(index))
            writeChildMessageRequestToDir(steerInbox, pending);
          break;
        }
      }
    } finally {
      flushing = false;
    }
  };
  const start = (): void => {
    if (started || disposed) return;
    try {
      fs.mkdirSync(steerInbox, { recursive: true });
    } catch {
      return;
    }
    started = true;
    try {
      watcher = fs.watch(steerInbox, () => flush());
      watcher.on("error", () => {});
    } catch {
      watcher = undefined;
    }
    interval = setInterval(flush, 250);
    interval.unref?.();
  };
  const activate = (): void => {
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
    } catch {
      // Watcher shutdown is best-effort.
    }
    if (interval) clearInterval(interval);
  });
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
  registerSteeringInbox(pi);
  registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV]));
  let nativeSupervisorClientRegistered = false;
  let projectAgentGuidanceSnapshot = "";
  let supervisorGuidanceSnapshot = "";
  let tkTicketGuidanceSnapshot = "";
  let tkTicketIdSnapshot: string | undefined;
  const handleSessionStart = (_event: unknown, ctx: { cwd: string }): void => {
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
    if (!tkTicketIdSnapshot) return;
    pi.sendMessage(
      {
        customType: "tlh-developer-scope-reminder",
        content: formatDeveloperCompactionReminder(tkTicketIdSnapshot),
        display: true,
      },
      // Overflow compaction already has a guaranteed continuation, so steering
      // places the reminder before its retry. Non-retry compaction must defer
      // the reminder to the next real prompt; steering would make Pi's
      // post-compaction queue look nonempty and start an extra assistant turn.
      { deliverAs: event.willRetry ? "steer" : "nextTurn" },
    );
  });
  pi.on("before_agent_start", (event) => {
    const projectInheritance = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV) ?? true;
    const skillsInheritance = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV) ?? true;
    rewriteSubagentPrompt(
      event.systemPromptOptions,
      { inheritProjectContext: projectInheritance, inheritSkills: skillsInheritance },
      projectAgentGuidanceSnapshot,
      supervisorGuidanceSnapshot,
      tkTicketGuidanceSnapshot,
    );
    return undefined;
  });
}
