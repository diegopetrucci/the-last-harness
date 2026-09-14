import { SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  normalizeEnabledExperimentalFeatures,
  normalizeExperimentalFeatureId,
  readEnabledExperimentalFeatures,
  STAFF_DEVELOPER_ROUTING_FEATURE,
} from "../the-last-harness-subagent-safety.mjs";
import type {
  AgentPrompt,
  TlhExperimentalConfig,
  TlhExperimentalFeatureId,
  TlhSettings,
} from "./types.js";

export const DELTA_FOLLOW_UP_REVIEWS_FEATURE: TlhExperimentalFeatureId = "delta-follow-up-reviews";
export const CI_FAILURE_INVESTIGATION_FEATURE: TlhExperimentalFeatureId =
  "ci-failure-investigation";
export { STAFF_DEVELOPER_ROUTING_FEATURE };
export const TLH_EXPERIMENTAL_FEATURE_CHANGED_EVENT = "tlh:experimental-feature-changed";

export const EXPERIMENTAL_COMMAND_HELP = [
  "Usage: /experimental [list|status [feature]|enable <feature>|disable <feature>|toggle <feature>]",
  "With no argument, /experimental opens the TLH experimental feature picker when UI is available, otherwise it lists feature status.",
].join(" ");

const DELTA_FOLLOW_UP_REVIEWS_ARCHITECT_PROMPT = `
## TLH Experimental Feature: delta-follow-up-reviews

This TLH experiment is enabled for the architect primary agent.

When a \`code-reviewer\` finding leads to a developer fix round:

1. Default the follow-up \`code-reviewer\` request to the delta since the last reviewed checkpoint instead of rereading the full branch diff.
2. In every follow-up review request, pass the prior findings plus the exact delta baseline, git range or checkpoint, or explicit changed-file list to review.
3. Keep or expand to targeted wider review or full re-review for installer or other destructive-path changes, trust-boundary changes, auth or execution changes, unresolved reviewer disagreement, or whenever the delta cannot be validated safely without wider context.
`;

const DELTA_FOLLOW_UP_REVIEWS_CODE_REVIEWER_PROMPT = `
## TLH Experimental Feature: delta-follow-up-reviews

This TLH experiment is enabled for the \`code-reviewer\` child agent.

For follow-up review after fixes:

1. Expect prior findings plus an exact delta baseline, git range or checkpoint, or explicit changed-file list from the delegating primary agent. Do not assume every follow-up review includes the full branch diff.
2. Default to the requested delta and prior findings: verify the reported fixes, check touched areas for regressions, and avoid rereading the full branch diff unless wider context is needed.
3. You may read adjacent code or other targeted context when needed for safety or correctness, and should widen to targeted or full re-review for installer or other destructive-path changes, trust-boundary changes, auth or execution changes, unresolved reviewer disagreement, or whenever the requested delta cannot be validated safely without wider context.
`;

const CI_FAILURE_INVESTIGATION_ARCHITECT_PROMPT = `
## TLH Experimental Feature: ci-failure-investigation

This TLH experiment is enabled for the architect primary agent.

This experiment overrides the default post-PR monitor-and-ask-only step for this specific case.

After TLH opens a PR and CI/status checks fail:

1. You may do a read-only investigation before asking the user whether to proceed.
2. Keep that investigation read-only: inspect failed checks, logs, workflow/config files, diffs, and relevant code or tests as needed to understand the failure.
3. Do not edit files, commit, push, rerun jobs, change the PR, or take any other follow-up action during this investigation.
4. After the investigation, summarize the failure and likely cause, then ask the user whether to proceed.
5. Before any edits, commits, pushes, reruns, PR changes, or other follow-up changes, ask for explicit user approval.
`;

const STAFF_DEVELOPER_ROUTING_ARCHITECT_PROMPT = `
## TLH Experimental Feature: staff-developer-routing

This TLH experiment is enabled for the architect primary agent. It is disabled by default and does not change the primary-agent mode.

### Semantic worker assignment

For each implementation ticket, choose exactly one execution tier from the work itself—never from line counts, file counts, a hidden classifier, or a worker's request to self-escalate:

- **staff-developer** is for design judgment that remains during implementation: foundational or new-subsystem scaffolding; cross-cutting API or data-shape changes; concurrency, lifecycle, security, or trust boundaries; migration or compatibility sequencing; broad refactors whose target shape is unresolved; or material implementation uncertainty.
- **developer** is for localized and well-specified work, broad-but-mechanical changes, tests, documentation, and repetitive follow-ups. When uncertain, choose developer.

Product mode does not assign execution tiers. Staff routing is only for architect implementation delegation. An explicit human request for either tier is honored only while this experiment is enabled; it does not override the role boundaries or the approved-ticket contract. While this experiment is enabled, its two-tier assignment rule supersedes and narrows the base architect wording that implementation goes to \`developer\`: a ticket explicitly assigned to \`staff-developer\` is dispatched there without contradiction.

### Approval and handoff protocol

Before asking for ticket approval, make the assignment auditable in the plan:

- Show one line for every implementation ticket in the exact form \`Worker: developer|staff-developer — Reason: <one line>\`. Keep the reason concrete and limited to one line.
- Show the aggregate line \`Staff tickets: <count>\` before approval, counting only tickets assigned to staff-developer.
- The assignment, reason, and count must appear before the user is asked to approve ticket creation or implementation handoff. Treat only the exact word \`approved\` as approval.

After a ticket has been approved, do not silently change its worker. Upgrading an approved developer ticket to staff-developer requires explaining the changed design risk, showing the new one-line reason, and asking for renewed approval. If a staff assignment is downgraded to developer, announce the downgrade and its reason before dispatch. Preserve one-writer sequencing: dispatch one approved ticket to one worker, and have that worker run \`tk show <id>\` before editing.

A staff-developer run remains a developer implementation run in the same ticket and cannot delegate further, commit, or bypass the architect's approval boundary. If the staff model is unavailable, runtime routing may report a downgrade to the actual developer role; do not describe that run as staff-developer.
`;

type TlhExperimentalFeature = {
  id: TlhExperimentalFeatureId;
  description: string;
  primaryAgentPrompt?: string;
  primaryAgentPrompts?: Partial<Record<string, string>>;
  codeReviewerPrompt?: string;
};

type TlhExperimentalSlashAction =
  | { type: "picker" }
  | { type: "list" }
  | { type: "status"; featureId?: string }
  | { type: "enable" | "disable" | "toggle"; featureId: string };

export const TLH_EXPERIMENTAL_FEATURES: TlhExperimentalFeature[] = [
  {
    id: DELTA_FOLLOW_UP_REVIEWS_FEATURE,
    description:
      "Architect and code-reviewer guidance to scope follow-up reviews to a requested delta after fixes.",
    primaryAgentPrompts: {
      architect: DELTA_FOLLOW_UP_REVIEWS_ARCHITECT_PROMPT.trim(),
    },
    codeReviewerPrompt: DELTA_FOLLOW_UP_REVIEWS_CODE_REVIEWER_PROMPT.trim(),
  },
  {
    id: CI_FAILURE_INVESTIGATION_FEATURE,
    description:
      "Architect-only guidance to perform read-only PR CI/status-check investigation before asking whether to proceed.",
    primaryAgentPrompts: {
      architect: CI_FAILURE_INVESTIGATION_ARCHITECT_PROMPT.trim(),
    },
  },
  {
    id: STAFF_DEVELOPER_ROUTING_FEATURE,
    description:
      "Architect guidance for disabled-by-default semantic developer and staff-developer ticket routing, visible reasons, counts, and approval sequencing.",
    primaryAgentPrompts: {
      architect: STAFF_DEVELOPER_ROUTING_ARCHITECT_PROMPT.trim(),
    },
  },
];

const TLH_EXPERIMENTAL_FEATURES_BY_ID = new Map(
  TLH_EXPERIMENTAL_FEATURES.map((feature) => [feature.id, feature]),
);

export function hasRegisteredExperimentalFeatures(): boolean {
  return TLH_EXPERIMENTAL_FEATURES.length > 0;
}

export function availableExperimentalFeatureList(): string {
  return hasRegisteredExperimentalFeatures()
    ? TLH_EXPERIMENTAL_FEATURES.map((feature) => feature.id).join(", ")
    : "none currently registered";
}

export function noExperimentalFeaturesMessage(): string {
  return "TLH experimental features: none currently registered. Future TLH feature flags will appear here when available.";
}

export function unknownExperimentalFeatureMessage(featureId: string): string {
  const base = `Unknown TLH experimental feature "${featureId}".`;
  return hasRegisteredExperimentalFeatures()
    ? `${base} Available: ${availableExperimentalFeatureList()}.`
    : `${base} ${noExperimentalFeaturesMessage()}`;
}

export function normalizeEnabledFeatures(enabledFeatures: string[] | undefined): string[] {
  return normalizeEnabledExperimentalFeatures(enabledFeatures) as string[];
}

function readEnabledFeatures(config: unknown): string[] {
  return readEnabledExperimentalFeatures(config) as string[];
}

function telemetryExperimentalFeatureKey(featureId: TlhExperimentalFeatureId): string {
  return `Tlh.Experimental.${featureId}`;
}

export function buildExperimentalFeatureTelemetryPayload(
  config: unknown,
): Record<string, "on" | "off"> {
  const enabledFeatures = new Set(readEnabledFeatures(config));
  return Object.fromEntries(
    TLH_EXPERIMENTAL_FEATURES.map((feature) => [
      telemetryExperimentalFeatureKey(feature.id),
      enabledFeatures.has(feature.id) ? "on" : "off",
    ]),
  ) as Record<string, "on" | "off">;
}

export function getExperimentalFeature(featureId: string): TlhExperimentalFeature | undefined {
  const normalized = normalizeExperimentalFeatureId(featureId) as string | undefined;
  return normalized ? TLH_EXPERIMENTAL_FEATURES_BY_ID.get(normalized) : undefined;
}

function enabledExperimentalPrompts(
  config: TlhExperimentalConfig | undefined,
  promptKey: "primaryAgentPrompt" | "codeReviewerPrompt",
): string[] {
  return TLH_EXPERIMENTAL_FEATURES.filter((feature) =>
    isTlhExperimentalFeatureEnabled(config, feature.id),
  )
    .map((feature) => feature[promptKey])
    .filter((prompt): prompt is string => Boolean(prompt));
}

function enabledPrimaryExperimentalPrompts(
  primary: AgentPrompt,
  config: TlhExperimentalConfig | undefined,
): string[] {
  return TLH_EXPERIMENTAL_FEATURES.filter((feature) =>
    isTlhExperimentalFeatureEnabled(config, feature.id),
  )
    .map((feature) => feature.primaryAgentPrompts?.[primary.name] ?? feature.primaryAgentPrompt)
    .filter((prompt): prompt is string => Boolean(prompt));
}

export function getTlhExperimentalConfig(cwd: string): TlhExperimentalConfig | undefined {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
    return settings.tlh?.experimental;
  } catch {
    return undefined;
  }
}

export function isTlhExperimentalFeatureEnabled(
  config: unknown,
  featureId: TlhExperimentalFeatureId,
): boolean {
  const feature = getExperimentalFeature(featureId);
  return feature ? readEnabledFeatures(config).includes(feature.id) : false;
}

export function parseExperimentalSlashAction(args: string): TlhExperimentalSlashAction | undefined {
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { type: "picker" };
  }
  if (parts[0] === "list") {
    return parts.length === 1 ? { type: "list" } : undefined;
  }
  if (parts[0] === "status") {
    return parts.length <= 2 ? { type: "status", featureId: parts[1] } : undefined;
  }
  if (
    parts.length === 2 &&
    (parts[0] === "enable" || parts[0] === "disable" || parts[0] === "toggle")
  ) {
    return { type: parts[0], featureId: parts[1] };
  }
  return undefined;
}

const EXPERIMENTAL_COMMAND_COMPLETIONS = [
  { value: "list", description: "List TLH experimental features" },
  { value: "status", description: "Show TLH experimental feature status" },
  ...TLH_EXPERIMENTAL_FEATURES.flatMap((feature) => [
    { value: `status ${feature.id}`, description: `Show status for ${feature.id}` },
    { value: `enable ${feature.id}`, description: `Enable ${feature.id}` },
    { value: `disable ${feature.id}`, description: `Disable ${feature.id}` },
    { value: `toggle ${feature.id}`, description: `Toggle ${feature.id}` },
  ]),
] as const;

export function buildPrimaryExperimentalPrompt(
  primary: AgentPrompt | undefined,
  config: TlhExperimentalConfig | undefined,
): string | undefined {
  if (!primary) {
    return undefined;
  }
  return enabledPrimaryExperimentalPrompts(primary, config).join("\n\n") || undefined;
}

export function buildChildExperimentalPrompt(
  childAgentName: string | undefined,
  config: TlhExperimentalConfig | undefined,
): string | undefined {
  if (childAgentName?.trim().toLowerCase() !== "code-reviewer") {
    return undefined;
  }
  return enabledExperimentalPrompts(config, "codeReviewerPrompt").join("\n\n") || undefined;
}

import { handleExperimentalCommand } from "./experimental-command.js";

export function registerExperimentalCommand(pi: ExtensionAPI): void {
  pi.registerCommand("experimental", {
    description: "List or change TLH experimental features",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const completions = EXPERIMENTAL_COMMAND_COMPLETIONS.filter((option) =>
        option.value.startsWith(normalizedPrefix),
      ).map((option) => ({
        value: option.value,
        label: option.value,
        description: option.description,
      }));
      return completions.length > 0 ? completions : null;
    },
    handler: (args, ctx) => handleExperimentalCommand(pi, args, ctx),
  });
}
