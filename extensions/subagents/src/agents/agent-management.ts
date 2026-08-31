import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentConfig,
  type AgentDiscoveryDiagnostic,
  type AgentScope,
  discoverAgentsAll,
  frontmatterNameForConfig,
} from "./agents.ts";
import type { Details, ExtensionConfig, SubagentToolResult } from "../shared/types.ts";
import { isCanonicalPackagedMinorAgent } from "../../../shared/project-agent-guidance.ts";

type ManagementAction = "list" | "get";
type ManagementContext = Pick<ExtensionContext, "cwd"> & { config?: ExtensionConfig };

interface ManagementParams {
  action?: string;
  agent?: string;
  chainName?: string;
  agentScope?: unknown;
  config?: unknown;
}

function result(text: string, isError = false): SubagentToolResult<Details> {
  return {
    content: [{ type: "text", text }],
    isError,
    details: { mode: "management", results: [] },
  };
}

const SAVED_CHAIN_UNSUPPORTED =
  "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";

function unsupportedSavedChainResult(detail: string): SubagentToolResult<Details> {
  return result(`${SAVED_CHAIN_UNSUPPORTED} ${detail}`, true);
}

function normalizeListScope(scope: unknown): AgentScope | undefined {
  if (scope === undefined) return "both";
  if (scope === "user" || scope === "project" || scope === "both") return scope;
  return undefined;
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function allAgents(d: {
  builtin: AgentConfig[];
  package: AgentConfig[];
  user: AgentConfig[];
  project: AgentConfig[];
}): AgentConfig[] {
  return [...d.builtin, ...d.package, ...d.user, ...d.project];
}

function isSourceVisibleInScope(
  source: AgentDiscoveryDiagnostic["source"],
  scope: AgentScope,
): boolean {
  return scope === "both" || source === "builtin" || source === "package" || source === scope;
}

function availableNames(cwd: string): string[] {
  return [...new Set(allAgents(discoverAgentsAll(cwd)).map((agent) => agent.name))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
  const d = discoverAgentsAll(cwd);
  const raw = name.trim();
  const sanitized = sanitizeName(raw);
  return allAgents(d)
    .filter(
      (a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized),
    )
    .sort((a, b) => a.source.localeCompare(b.source));
}

function formatAgentDetail(agent: AgentConfig): string {
  const lines: string[] = [
    `Agent: ${agent.name} (${agent.source})`,
    `Path: ${agent.filePath}`,
    `Description: ${agent.description}`,
  ];
  if (agent.packageName) {
    lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
    lines.push(`Package: ${agent.packageName}`);
  }
  if (agent.model) lines.push(`Model: ${agent.model}`);
  if (agent.fallbackModels?.length)
    lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
  if (agent.tools !== undefined)
    lines.push(`Tools: ${agent.tools?.length ? agent.tools.join(", ") : "(none)"}`);
  if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
  lines.push(`System prompt mode: ${agent.systemPromptMode}`);
  lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
  lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
  if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
  if (agent.acceptanceRole) lines.push(`Acceptance role: ${agent.acceptanceRole}`);
  if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
  if (agent.extensions !== undefined)
    lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
  if (agent.subagentOnlyExtensions !== undefined)
    lines.push(
      `Subagent-only extensions: ${agent.subagentOnlyExtensions.length ? agent.subagentOnlyExtensions.join(", ") : "(none)"}`,
    );
  if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
  if (agent.output) lines.push(`Output: ${agent.output}`);
  if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
  if (agent.defaultProgress) lines.push("Progress: true");
  if (agent.maxSubagentDepth !== undefined)
    lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
  if (agent.maxExecutionTimeMs !== undefined)
    lines.push(`Max execution time: ${agent.maxExecutionTimeMs}ms`);
  if (agent.completionGuard === false) lines.push("Completion guard: false");
  if (agent.supervisorBridge === false) lines.push("Supervisor bridge: false");
  if (agent.toolBudget) lines.push(`Tool budget: ${JSON.stringify(agent.toolBudget)}`);
  if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
  return lines.join("\n");
}

export function handleList(
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentToolResult<Details> {
  const scope = normalizeListScope(params.agentScope) ?? "both";
  const d = discoverAgentsAll(ctx.cwd);
  const scopedAgents = allAgents(d)
    .filter(
      (a) =>
        scope === "both" ||
        a.source === "builtin" ||
        a.source === "package" ||
        a.source === scope ||
        (scope === "project" && isCanonicalPackagedMinorAgent(a)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const agents = scopedAgents.filter((a) => !a.disabled);
  const lines = [
    "Executable agents:",
    ...(agents.length
      ? agents.map(
          (a) =>
            `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`,
        )
      : ["- (none)"]),
  ];
  const visibleDiagnostics = (d.agentDiagnostics ?? []).filter((diagnostic) =>
    isSourceVisibleInScope(diagnostic.source, scope),
  );
  if (visibleDiagnostics.length > 0) {
    lines.push(
      "",
      "Agent load warnings:",
      ...visibleDiagnostics.map((diagnostic) => `- ${diagnostic.filePath}: ${diagnostic.error}`),
    );
  }
  return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): SubagentToolResult<Details> {
  if (params.chainName)
    return unsupportedSavedChainResult("Use 'agent' for action='get'; omit chainName.");
  if (!params.agent) return result("Specify 'agent' for get.", true);
  const matches = findAgents(params.agent, ctx.cwd, "both");
  if (!matches.length) {
    return result(
      `Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd).join(", ") || "none"}.`,
      true,
    );
  }
  return result(matches.map(formatAgentDetail).join("\n\n"));
}

// handleCreate through handleReset removed: these seven write verbs are unreachable — the
// tool's 'action' schema enum (schemas.ts) admits only list/get/status/interrupt/
// resume/steer/doctor.

export function handleManagementAction(
  action: string,
  params: ManagementParams,
  ctx: ManagementContext,
): SubagentToolResult<Details> {
  switch (action as ManagementAction) {
    case "list":
      return handleList(params, ctx);
    case "get":
      return handleGet(params, ctx);
    default:
      return result(`Unknown action: ${action}`, true);
  }
}
