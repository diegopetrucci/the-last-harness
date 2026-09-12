import { isRecord } from "./common.js";
import { applyProviderAwareSubagentModels } from "./model-defaults.js";
import { collectSubagentTargets, isEmbeddedSubagentTarget, } from "../the-last-harness-subagent-safety.mjs";
export function primaryToolAllowlist(primary) {
    return primary?.tools.length
        ? primary.tools
        : ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"];
}
function matchesSubagentName(value, target) {
    return typeof value === "string" && value.trim().toLowerCase() === target;
}
export function isSubagentResumeAction(input) {
    return isRecord(input) && matchesSubagentName(input.action, "resume");
}
export function isSubagentSteerAction(input) {
    return isRecord(input) && matchesSubagentName(input.action, "steer");
}
export function subagentCallTargetsAgent(input, target) {
    return subagentCallTargetsMatching(input, (agent) => matchesSubagentName(agent, target));
}
export function rushResumeDelegationReason() {
    return "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.";
}
export function rushSteerDelegationReason() {
    return "TLH Rush may not use subagent action=steer because an opaque steer carries no agent field, so TLH cannot prove the steered child is not a developer subagent. Rush must edit directly.";
}
export function rushDeveloperDelegationReason() {
    return "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
}
export function collectSubagentCallTargetsMatching(input, predicate) {
    return collectSubagentTargets(input).filter((agent) => predicate(agent));
}
function subagentCallTargetsMatching(input, predicate) {
    return collectSubagentCallTargetsMatching(input, predicate).length > 0;
}
function hasExplicitDispatchModel(target) {
    if (!isRecord(target))
        return false;
    const model = target.model;
    if (typeof model !== "string")
        return false;
    const normalized = model.trim();
    return normalized.length > 0 && normalized !== "inherit";
}
export function applyProviderAwareModelsToNonProjectTargets(input, agents, availableModels, currentProvider, currentModel, options) {
    if (!isRecord(input))
        return;
    if ((!Array.isArray(input.tasks) || input.tasks.length === 0) &&
        !isEmbeddedSubagentTarget(input.agent)) {
        applyProviderAwareSubagentModels(input, agents, availableModels, currentProvider, currentModel, options);
        return;
    }
    if (!Array.isArray(input.tasks))
        return;
    for (const task of input.tasks) {
        if (isRecord(task) && !isEmbeddedSubagentTarget(task.agent)) {
            applyProviderAwareSubagentModels(task, agents, availableModels, currentProvider, currentModel, options);
        }
    }
}
export function applyOpenRouterModelToProjectTargets(input, projectTargets, currentModel) {
    if (!isRecord(input) || currentModel?.provider !== "openrouter")
        return;
    const projectTargetSet = new Set(projectTargets);
    const apply = (target) => {
        if (!isRecord(target) ||
            typeof target.agent !== "string" ||
            !projectTargetSet.has(target.agent.trim()) ||
            hasExplicitDispatchModel(target)) {
            return;
        }
        target.model = `${currentModel.provider}/${currentModel.id}`;
    };
    apply(input);
    if (Array.isArray(input.tasks)) {
        for (const task of input.tasks)
            apply(task);
    }
}
export function isOpaqueSubagentManagementActionInput(input) {
    return isRecord(input) && typeof input.action === "string" && input.action.trim().length > 0;
}
export function embeddedDelegationBlockedReason(selection, input) {
    if (isOpaqueSubagentManagementActionInput(input)) {
        return undefined;
    }
    if (!subagentCallTargetsMatching(input, isEmbeddedSubagentTarget)) {
        return undefined;
    }
    if (selection === "rush") {
        return "TLH Rush may not delegate to embedded subagents. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
    }
    if (selection === "product") {
        return "TLH Product may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.";
    }
    if (selection === "bug-hunter") {
        return "TLH Bug-Hunter may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.";
    }
    return undefined;
}
