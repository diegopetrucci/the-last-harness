import * as fs from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
  composeChildPromptRuntime,
} from "../../../../shared/subagent-child-boundary.ts";
import {
  formatProjectAgentGuidance,
  inventoryProjectAgentGuidance,
  PACKAGED_MINOR_AGENT_ROLES,
} from "../../../../shared/project-agent-guidance.ts";

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
const PROJECT_CONTEXT_HEADER =
  "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER =
  "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return value !== "0";
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
  let endIndex = prompt.length;
  for (const header of nextHeaders) {
    const index = prompt.indexOf(header, startIndex);
    if (index !== -1 && index < endIndex) {
      endIndex = index;
    }
  }
  return endIndex;
}

export function stripProjectContext(prompt: string): string {
  const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
  if (startIndex === -1) return prompt;
  const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [
    SKILLS_HEADER,
    DATE_HEADER,
  ]);
  return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
  const startIndex = prompt.indexOf(SKILLS_HEADER);
  if (startIndex === -1) return prompt;
  const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
  return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
  return prompt
    .replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
    .replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) =>
      SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block,
    );
}

export function rewriteSubagentPrompt(
  prompt: string,
  options: { inheritProjectContext: boolean; inheritSkills: boolean },
  projectAgentGuidance = "",
  supervisorGuidance = "",
): string {
  let rewritten = prompt;
  if (!options.inheritProjectContext) {
    rewritten = stripProjectContext(rewritten);
  }
  if (!options.inheritSkills) {
    rewritten = stripInheritedSkills(rewritten);
  }
  rewritten = stripSubagentOrchestrationSkill(rewritten);
  return composeChildPromptRuntime(
    rewritten,
    [projectAgentGuidance, supervisorGuidance],
    "explicit",
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
  const handleSessionStart = (_event: unknown, ctx: { cwd: string }): void => {
    if (!nativeSupervisorClientRegistered) {
      nativeSupervisorClientRegistered = true;
      registerNativeSupervisorClient(pi);
    }
    projectAgentGuidanceSnapshot = resolveChildProjectAgentGuidance(ctx.cwd);
    supervisorGuidanceSnapshot = resolveChildSupervisorGuidance();
  };
  pi.on("session_start", handleSessionStart);
  pi.on("before_agent_start", (event) => {
    const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
    const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
    if (
      inheritProjectContext === undefined &&
      inheritSkills === undefined &&
      projectAgentGuidanceSnapshot.length === 0 &&
      supervisorGuidanceSnapshot.length === 0
    )
      return undefined;
    const rewritten = rewriteSubagentPrompt(
      event.systemPrompt,
      {
        inheritProjectContext: inheritProjectContext ?? true,
        inheritSkills: inheritSkills ?? true,
      },
      projectAgentGuidanceSnapshot,
      supervisorGuidanceSnapshot,
    );
    if (rewritten === event.systemPrompt) return undefined;
    return { systemPrompt: rewritten };
  });
}
