// Generated from extensions/subagents/src/agents/agent-management.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as path from "node:path";
import { discoverAgentsAll, frontmatterNameForConfig, } from "./agents.js";
import { resolveExecutionAgentScope } from "./agent-scope.js";
import { isCanonicalPackagedMinorAgent } from "../../../shared/project-agent-guidance.js";
function result(text, isError = false) {
    return {
        content: [{ type: "text", text }],
        isError,
        details: { mode: "management", results: [] },
    };
}
const SAVED_CHAIN_UNSUPPORTED = "Saved chains are deliberately unsupported in The Last Harness; existing .chain.md/.chain.json files are left untouched.";
function unsupportedSavedChainResult(detail) {
    return result(`${SAVED_CHAIN_UNSUPPORTED} ${detail}`, true);
}
function sanitizeName(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function allAgents(d) {
    return [...d.builtin, ...d.package, ...d.user, ...d.project];
}
function isBundledDeveloperName(name) {
    return name === "developer";
}
function isHiddenByNoDeveloper(entry, noDeveloperActive) {
    if (!noDeveloperActive)
        return false;
    if (entry.name === "developer")
        return true;
    return isCanonicalPackagedMinorAgent({ name: "developer", filePath: entry.filePath });
}
function isVisibleInScope(entry, scope) {
    if (scope === "both" ||
        entry.source === "builtin" ||
        entry.source === "package" ||
        entry.source === scope) {
        return true;
    }
    if (scope !== "project")
        return false;
    if (isCanonicalPackagedMinorAgent(entry))
        return true;
    if (typeof entry.filePath !== "string")
        return false;
    const role = path.basename(entry.filePath, ".md");
    if (!role || role === path.basename(entry.filePath))
        return false;
    return isCanonicalPackagedMinorAgent({ name: role, filePath: entry.filePath });
}
function availableNames(cwd, noDeveloperActive) {
    return [
        ...new Set(allAgents(discoverAgentsAll(cwd))
            .filter((agent) => !isHiddenByNoDeveloper(agent, noDeveloperActive))
            .map((agent) => agent.name)),
    ].sort((a, b) => a.localeCompare(b));
}
function findAgents(name, cwd, scope = "both", noDeveloperActive = false) {
    const d = discoverAgentsAll(cwd);
    const raw = name.trim();
    const sanitized = sanitizeName(raw);
    return allAgents(d)
        .filter((a) => !isHiddenByNoDeveloper(a, noDeveloperActive) &&
        (scope === "both" || a.source === scope) &&
        (a.name === raw || a.name === sanitized))
        .sort((a, b) => a.source.localeCompare(b.source));
}
function formatAgentDetail(agent) {
    const lines = [
        `Agent: ${agent.name} (${agent.source})`,
        `Path: ${agent.filePath}`,
        `Description: ${agent.description}`,
    ];
    if (agent.packageName) {
        lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
        lines.push(`Package: ${agent.packageName}`);
    }
    if (agent.model)
        lines.push(`Model: ${agent.model}`);
    if (agent.fallbackModels?.length)
        lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
    if (agent.tools !== undefined)
        lines.push(`Tools: ${agent.tools?.length ? agent.tools.join(", ") : "(none)"}`);
    if (agent.skills?.length)
        lines.push(`Skills: ${agent.skills.join(", ")}`);
    lines.push(`System prompt mode: ${agent.systemPromptMode}`);
    lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
    lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
    if (agent.source === "builtin")
        lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
    if (agent.extensions !== undefined)
        lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
    if (agent.subagentOnlyExtensions !== undefined)
        lines.push(`Subagent-only extensions: ${agent.subagentOnlyExtensions.length ? agent.subagentOnlyExtensions.join(", ") : "(none)"}`);
    if (agent.thinking)
        lines.push(`Thinking: ${agent.thinking}`);
    if (agent.output)
        lines.push(`Output: ${agent.output}`);
    if (agent.defaultReads?.length)
        lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
    if (agent.defaultProgress)
        lines.push("Progress: true");
    if (agent.maxSubagentDepth !== undefined)
        lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
    if (agent.maxExecutionTimeMs !== undefined)
        lines.push(`Max execution time: ${agent.maxExecutionTimeMs}ms`);
    if (agent.supervisorBridge === false)
        lines.push("Supervisor bridge: false");
    if (agent.systemPrompt.trim())
        lines.push("", "System Prompt:", agent.systemPrompt);
    return lines.join("\n");
}
export function handleList(params, ctx) {
    const scope = resolveExecutionAgentScope(params.agentScope);
    const d = discoverAgentsAll(ctx.cwd);
    const scopedAgents = allAgents(d)
        .filter((a) => isVisibleInScope(a, scope))
        .sort((a, b) => a.name.localeCompare(b.name));
    const agents = scopedAgents.filter((a) => !a.disabled && !isHiddenByNoDeveloper(a, ctx.noDeveloperActive === true));
    const lines = [
        "Executable agents:",
        ...(agents.length
            ? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`)
            : ["- (none)"]),
    ];
    const visibleDiagnostics = (d.agentDiagnostics ?? []).filter((diagnostic) => isVisibleInScope(diagnostic, scope) &&
        !isHiddenByNoDeveloper(diagnostic, ctx.noDeveloperActive === true));
    if (visibleDiagnostics.length > 0) {
        lines.push("", "Agent load warnings:", ...visibleDiagnostics.map((diagnostic) => `- ${diagnostic.filePath}: ${diagnostic.error}`));
    }
    return result(lines.join("\n"));
}
function handleGet(params, ctx) {
    if (params.chainName)
        return unsupportedSavedChainResult("Use 'agent' for action='get'; omit chainName.");
    if (!params.agent)
        return result("Specify 'agent' for get.", true);
    const noDeveloperActive = ctx.noDeveloperActive === true;
    if (noDeveloperActive && isBundledDeveloperName(sanitizeName(params.agent))) {
        return result(`The bundled developer agent is unavailable while the host no-developer policy is active. Available: ${availableNames(ctx.cwd, true).join(", ") || "none"}.`, true);
    }
    const matches = findAgents(params.agent, ctx.cwd, "both", noDeveloperActive);
    if (!matches.length) {
        return result(`Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd, noDeveloperActive).join(", ") || "none"}.`, true);
    }
    return result(matches.map(formatAgentDetail).join("\n\n"));
}
export function handleManagementAction(action, params, ctx) {
    switch (action) {
        case "list":
            return handleList(params, ctx);
        case "get":
            return handleGet(params, ctx);
        default:
            return result(`Unknown action: ${action}`, true);
    }
}
