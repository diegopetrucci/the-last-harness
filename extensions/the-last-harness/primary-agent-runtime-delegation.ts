import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { applyProviderAwareSubagentModels } from "./model-defaults.js";
import {
  collectSubagentTargets,
  isEmbeddedSubagentTarget,
} from "../the-last-harness-subagent-safety.mjs";
import type { AgentPrompt, SubagentMetadata, TlhPrimaryAgentSelection } from "./types.js";

export type ActiveModel = NonNullable<ExtensionContext["model"]>;

export function primaryToolAllowlist(primary: AgentPrompt | undefined): string[] {
  return primary?.tools.length
    ? primary.tools
    : ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"];
}

function matchesSubagentName(value: unknown, target: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === target;
}

export function isSubagentResumeAction(input: unknown): boolean {
  return isRecord(input) && matchesSubagentName(input.action, "resume");
}

export function isSubagentSteerAction(input: unknown): boolean {
  return isRecord(input) && matchesSubagentName(input.action, "steer");
}

export function subagentCallTargetsAgent(input: unknown, target: string): boolean {
  return subagentCallTargetsMatching(input, (agent) => matchesSubagentName(agent, target));
}

export function rushResumeDelegationReason(): string {
  return "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.";
}

export function rushSteerDelegationReason(): string {
  return "TLH Rush may not use subagent action=steer because an opaque steer carries no agent field, so TLH cannot prove the steered child is not a developer subagent. Rush must edit directly.";
}

export function rushDeveloperDelegationReason(): string {
  return "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
}

export function collectSubagentCallTargetsMatching(
  input: unknown,
  predicate: (agent: string) => boolean,
): string[] {
  return collectSubagentTargets(input).filter((agent) => predicate(agent));
}

function subagentCallTargetsMatching(
  input: unknown,
  predicate: (agent: string) => boolean,
): boolean {
  return collectSubagentCallTargetsMatching(input, predicate).length > 0;
}

function hasExplicitDispatchModel(target: unknown): boolean {
  if (!isRecord(target)) return false;
  const model = target.model;
  if (typeof model !== "string") return false;
  const normalized = model.trim();
  return normalized.length > 0 && normalized !== "inherit";
}

/**
 * Generic provider-aware defaults must never rewrite a project snapshot entry.
 * Embedded model policy is applied below after the snapshot identity gate, so
 * the only mutable exception is OpenRouter's omitted-model session inheritance.
 */
export function applyProviderAwareModelsToNonProjectTargets(
  input: unknown,
  agents: ReadonlyMap<string, SubagentMetadata>,
  availableModels: Parameters<typeof applyProviderAwareSubagentModels>[2],
  currentProvider: string | undefined,
  currentModel: Parameters<typeof applyProviderAwareSubagentModels>[4],
  options: Parameters<typeof applyProviderAwareSubagentModels>[5],
): void {
  if (!isRecord(input)) return;
  // applyProviderAwareSubagentModels also walks `tasks`; only use it for a
  // single target here, then handle task targets individually so a project
  // entry can never be rewritten and generic tasks are not visited twice.
  if (
    (!Array.isArray(input.tasks) || input.tasks.length === 0) &&
    !isEmbeddedSubagentTarget(input.agent)
  ) {
    applyProviderAwareSubagentModels(
      input,
      agents,
      availableModels,
      currentProvider,
      currentModel,
      options,
    );
    return;
  }
  if (!Array.isArray(input.tasks)) return;
  for (const task of input.tasks) {
    if (isRecord(task) && !isEmbeddedSubagentTarget(task.agent)) {
      applyProviderAwareSubagentModels(
        task,
        agents,
        availableModels,
        currentProvider,
        currentModel,
        options,
      );
    }
  }
}

export function applyOpenRouterModelToProjectTargets(
  input: unknown,
  projectTargets: readonly string[],
  currentModel: ActiveModel | undefined,
): void {
  if (!isRecord(input) || currentModel?.provider !== "openrouter") return;
  const projectTargetSet = new Set(projectTargets);
  const apply = (target: unknown): void => {
    if (
      !isRecord(target) ||
      typeof target.agent !== "string" ||
      !projectTargetSet.has(target.agent.trim()) ||
      hasExplicitDispatchModel(target)
    ) {
      return;
    }
    target.model = `${currentModel.provider}/${currentModel.id}`;
  };
  apply(input);
  if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) apply(task);
  }
}

export function isOpaqueSubagentManagementActionInput(input: unknown): boolean {
  return isRecord(input) && typeof input.action === "string" && input.action.trim().length > 0;
}

export function embeddedDelegationBlockedReason(
  selection: TlhPrimaryAgentSelection,
  input: unknown,
): string | undefined {
  // Opaque management actions (including resume) stay exempt from embedded-target checks.
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
