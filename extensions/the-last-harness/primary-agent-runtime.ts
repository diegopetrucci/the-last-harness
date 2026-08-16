import { join } from "node:path";

import {
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_PRIMARY_AGENT,
  DISABLED_PRIMARY_AGENT,
  PRIMARY_AGENT_CYCLE,
  PRIMARY_AGENT_SESSION_STATE_ENTRY,
  isEnabledPrimaryAgentSelection,
  nextPrimaryAgentSelection,
  primaryAgentDefaultLabel,
  primaryAgentSelectionFromBranch,
  resolvePrimaryAgentConfig,
} from "../the-last-harness-primary-agent.mjs";
import {
  createPrimaryToolState,
  filterAvailableTools,
} from "../the-last-harness-primary-tools.mjs";
import {
  allowedSubagentsForExperimentalConfig,
  collectSubagentTargets,
  isEmbeddedSubagentTarget,
  isExperimentalFeatureEnabled,
  registerTlhStartupMode,
  validateSubagentToolInput,
} from "../the-last-harness-subagent-safety.mjs";
import {
  buildTlhCommitAttributionPrompt,
  getTlhGitCommitAttributionBlockReason,
  resolveTlhCommitAttribution,
} from "./attribution.js";
import { formatHomePath, isRecord } from "./common.js";
import {
  GNOSIS_PROMPT,
  PRIMARY_AGENT_CYCLE_SHORTCUT,
  TLH_NAME,
  TLH_PACKAGE_NAME,
} from "./constants.js";
import {
  EMBEDDED_SUBAGENTS_FEATURE,
  buildChildExperimentalPrompt,
  buildPrimaryExperimentalPrompt,
} from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import {
  applyProviderAwareSubagentModels,
  selectProviderAwareAgentDefaults,
} from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import {
  beginTlhModelSelectionDefaultSuppression,
  chooseTlhModelSelectionScope,
  claimTlhModelSelectionDefaults,
  discardTlhModelSelectionDefaults,
  installTlhModelSelectionPersistenceOverride,
  isTlhNativeModelSelectorClaim,
  persistTlhModelSelectionDefaults,
  persistTlhStandaloneThinkingDefaults,
  replayAllTlhUnclaimedModelSelectionDefaults,
  replayTlhUnmatchedModelSelectionDefaults,
  setTlhModelSelectionActiveModelResolver,
  setTlhSessionOnlyModel,
} from "./model-selection-scope.js";
import { isThinkingLevel, setExtensionThinkingLevel, thinkingLevelAtLeast } from "./thinking.js";
import {
  buildChildSubagentSystemPrompt,
  buildTlhSystemPrompt,
  loadAuthorizedEmbeddedSubagentRuntimeNames,
  loadPrimaryAgents,
  loadSubagentMetadata,
} from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite, withLockedTlhSettingsWrite } from "./profile-state.js";
import type {
  AgentPrompt,
  SubagentMetadata,
  TlhExperimentalConfig,
  TlhPrimaryAgentConfig,
  TlhPrimaryAgentSelection,
  TlhPrimaryAgentSessionState,
  TlhPrimaryAgentWriteResult,
  TlhSettings,
  TlhSubagentOverride,
} from "./types.js";

type TlhPrimaryAgentRuntimeOptions = {
  env?: Record<string, string | undefined>;
  primaryAgents?: Map<TlhPrimaryAgentSelection, AgentPrompt>;
  subagentMetadata?: SubagentMetadata[];
};

type ActiveModel = NonNullable<ExtensionContext["model"]>;

export type TlhPrimaryAgentRuntime = {
  applySessionStart(ctx: ExtensionContext): Promise<void>;
  currentPrimaryAgentLabel(): string;
  activePrimaryAgentPrompt(): AgentPrompt | undefined;
  buildLaunchSystemPrompt(ctx: ExtensionContext, baseSystemPrompt: string): string;
  /**
   * Clear the stored model override for a named primary agent and reapply
   * the packaged default to the active session, matching /switch-primary-agent
   * model reset behaviour.
   *
   * Returns `undefined` when `agentName` is not a recognised primary-agent
   * selection (unrecognised-name refusal semantics: no write, no apply).
   */
  resetPrimaryAgentModelOverride(
    ctx: ExtensionContext,
    agentName: string,
  ): Promise<TlhPrimaryAgentWriteResult | undefined>;
};

function getTlhGlobalSettings(cwd: string): TlhSettings {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
    return isRecord(settings) ? (settings as TlhSettings) : {};
  } catch {
    return {};
  }
}

function getTlhPrimaryAgentConfig(cwd: string): TlhPrimaryAgentConfig | undefined {
  return getTlhGlobalSettings(cwd).tlh?.primaryAgent;
}

function getTlhSubagentOverrides(cwd: string): ReadonlyMap<string, TlhSubagentOverride> {
  const overrides = getTlhGlobalSettings(cwd).subagents?.agentOverrides;
  if (!isRecord(overrides)) {
    return new Map();
  }
  return new Map(
    Object.entries(overrides)
      .filter(([, value]) => isRecord(value))
      .map(([agent, value]) => [agent, value as TlhSubagentOverride]),
  );
}

function resolvePrimaryAutoApplySetting(
  primaryConfig: TlhPrimaryAgentConfig | undefined,
  primary: AgentPrompt,
  key: "applyModel" | "applyThinking",
): boolean {
  const configured = primaryConfig?.[key];
  if (typeof configured === "boolean") {
    return configured;
  }
  return primary[key] === true;
}

function shouldForceApplyForLock(primary: AgentPrompt): boolean {
  return primary.lockThinking === true;
}

function parseTlhSettingsContent(content: string | undefined): Record<string, unknown> {
  if (!content) {
    return {};
  }
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("settings.json must contain a JSON object");
  }
  return parsed;
}

function writeTlhPrimaryAgentModelOverride(
  cwd: string,
  primary: TlhPrimaryAgentSelection,
  modelKey: string | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write model-override settings outside the isolated TLH profile.",
    (current) => {
      const settings = parseTlhSettingsContent(current);
      const rawTlh = settings.tlh;
      let tlh: Record<string, unknown>;
      if (rawTlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
      } else if (isRecord(rawTlh)) {
        tlh = rawTlh;
      } else {
        throw new Error("settings.tlh must be an object to update model-override settings.");
      }

      const rawPrimaryAgent = tlh.primaryAgent;
      let primaryAgent: Record<string, unknown>;
      if (rawPrimaryAgent === undefined) {
        primaryAgent = {};
        tlh.primaryAgent = primaryAgent;
      } else if (isRecord(rawPrimaryAgent)) {
        primaryAgent = rawPrimaryAgent;
      } else {
        throw new Error(
          "settings.tlh.primaryAgent must be an object to update model-override settings.",
        );
      }

      const rawModelOverrides = primaryAgent.modelOverrides;
      let modelOverrides: Record<string, unknown>;
      if (rawModelOverrides === undefined) {
        modelOverrides = {};
        primaryAgent.modelOverrides = modelOverrides;
      } else if (isRecord(rawModelOverrides)) {
        modelOverrides = rawModelOverrides;
      } else {
        throw new Error("settings.tlh.primaryAgent.modelOverrides must be an object.");
      }

      const existingOverride = modelOverrides[primary];
      if (modelKey === undefined) {
        if (!Object.hasOwn(modelOverrides, primary)) {
          return { changed: false };
        }
        delete modelOverrides[primary];
      } else {
        if (existingOverride === modelKey) {
          return { changed: false };
        }
        modelOverrides[primary] = modelKey;
      }

      // Clean up empty modelOverrides object
      if (Object.keys(modelOverrides).length === 0) {
        delete primaryAgent.modelOverrides;
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

function writeTlhPrimaryAgentDefault(
  cwd: string,
  selection: TlhPrimaryAgentSelection | undefined,
): TlhPrimaryAgentWriteResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write primary-agent settings outside the isolated TLH profile.",
    (current) => {
      const settings = parseTlhSettingsContent(current);
      const rawTlh = settings.tlh;
      let tlh: Record<string, unknown>;
      if (rawTlh === undefined) {
        tlh = {};
        settings.tlh = tlh;
      } else if (isRecord(rawTlh)) {
        tlh = rawTlh;
      } else {
        throw new Error("settings.tlh must be an object to update primary-agent settings.");
      }

      const rawPrimaryAgent = tlh.primaryAgent;
      let primaryAgent: Record<string, unknown>;
      if (rawPrimaryAgent === undefined) {
        primaryAgent = {};
        tlh.primaryAgent = primaryAgent;
      } else if (isRecord(rawPrimaryAgent)) {
        primaryAgent = rawPrimaryAgent;
      } else {
        throw new Error(
          "settings.tlh.primaryAgent must be an object to update primary-agent defaults.",
        );
      }

      let changed = false;
      const setField = (key: "enabled" | "selected", value: boolean | string | undefined) => {
        if (value === undefined) {
          if (Object.hasOwn(primaryAgent, key)) {
            delete primaryAgent[key];
            changed = true;
          }
          return;
        }
        if (primaryAgent[key] !== value) {
          primaryAgent[key] = value;
          changed = true;
        }
      };

      if (selection === undefined) {
        setField("enabled", undefined);
        setField("selected", undefined);
      } else if (selection === DISABLED_PRIMARY_AGENT) {
        setField("enabled", false);
        setField("selected", DISABLED_PRIMARY_AGENT);
      } else {
        setField("enabled", true);
        setField("selected", selection);
      }

      if (!changed) {
        return { changed: false };
      }

      return {
        changed: true,
        nextContent: `${JSON.stringify(settings, null, 2)}\n`,
      };
    },
  );
}

function primaryToolAllowlist(primary: AgentPrompt | undefined): string[] {
  return primary?.tools.length
    ? primary.tools
    : ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"];
}

function primaryAgentLabel(selection: TlhPrimaryAgentSelection): string {
  return selection;
}

function primaryAgentOverrideLabel(selection: TlhPrimaryAgentSelection | undefined): string {
  return selection ?? "none";
}

function matchesSubagentName(value: unknown, target: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === target;
}

function isSubagentResumeAction(input: unknown): boolean {
  return isRecord(input) && matchesSubagentName(input.action, "resume");
}

function isSubagentSteerAction(input: unknown): boolean {
  return isRecord(input) && matchesSubagentName(input.action, "steer");
}

function subagentCallTargetsAgent(input: unknown, target: string): boolean {
  return subagentCallTargetsMatching(input, (agent) => matchesSubagentName(agent, target));
}

function rushResumeDelegationReason(): string {
  return "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.";
}

function rushSteerDelegationReason(): string {
  return "TLH Rush may not use subagent action=steer because an opaque steer carries no agent field, so TLH cannot prove the steered child is not a developer subagent. Rush must edit directly.";
}

function rushDeveloperDelegationReason(): string {
  return "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
}

function collectSubagentCallTargetsMatching(
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

const SCOUT_RUN_MAX_TIMEOUT_MS = 360_000;
const SCOUT_TIMEOUT_CAPPED_SUBAGENTS = new Set([
  "librarian",
  "web-scout",
  "repo-scout",
  "diff-summarizer",
]);

function isOpaqueSubagentManagementActionInput(input: unknown): boolean {
  return isRecord(input) && typeof input.action === "string" && input.action.trim().length > 0;
}

function capScoutSubagentTimeout(input: unknown): void {
  if (
    !isRecord(input) ||
    isOpaqueSubagentManagementActionInput(input) ||
    // pi-subagents 0.31.12 fixed resume timeout propagation end to end (fork issue #112) and made
    // agent ceilings cumulative across resume segments. TLH deliberately retains this resume
    // exemption pending live-session re-evaluation; see issue #420 for that investigation.
    isSubagentResumeAction(input) ||
    !subagentCallTargetsMatching(input, (agent) =>
      SCOUT_TIMEOUT_CAPPED_SUBAGENTS.has(agent.trim().toLowerCase()),
    )
  ) {
    return;
  }
  const { timeoutMs } = input;
  if (
    typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs <= SCOUT_RUN_MAX_TIMEOUT_MS
  ) {
    return;
  }
  // The current subagent API exposes only a run-level timeout, so any execution batch containing
  // a capped scout target must cap the whole execution request.
  input.timeoutMs = SCOUT_RUN_MAX_TIMEOUT_MS;
}

function embeddedDelegationBlockedReason(
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
    return "TLH Product may not delegate to embedded subagents. Embedded subagent delegation is reserved for the architect primary agent.";
  }
  if (selection === "bug-hunter") {
    return "TLH Bug-Hunter may not delegate to embedded subagents. Embedded subagent delegation is reserved for the architect primary agent.";
  }
  return undefined;
}

function registerChildSubagentRuntime(
  pi: ExtensionAPI,
  buildChildPrompt: () => string,
  env: Record<string, string | undefined>,
): void {
  pi.on("session_start", async (_event, ctx) => {
    activateTlhTicketSessionScope(ctx.cwd);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const settings = getTlhGlobalSettings(ctx.cwd);
    const commitAttributionState = resolveTlhCommitAttribution(settings.tlh?.attribution);
    const childAgentName = env.PI_SUBAGENT_CHILD_AGENT;
    return {
      systemPrompt: [
        event.systemPrompt,
        buildChildPrompt(),
        buildChildExperimentalPrompt(childAgentName, settings.tlh?.experimental),
        buildTlhCommitAttributionPrompt(commitAttributionState),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") {
      return undefined;
    }
    // `toolName` narrows the branch, but not the shared mutable `input` payload.
    // Keep a runtime guard so direct/custom tool-call objects cannot pass a non-string command.
    if (typeof event.input.command !== "string") {
      return undefined;
    }
    const commitAttributionState = resolveTlhCommitAttribution(
      getTlhGlobalSettings(ctx.cwd).tlh?.attribution,
    );
    const reason = getTlhGitCommitAttributionBlockReason(
      event.input.command,
      commitAttributionState,
    );
    return reason ? { block: true, reason } : undefined;
  });
}

function createTlhPrimaryAgentRuntime(
  pi: ExtensionAPI,
  primaryAgents: Map<TlhPrimaryAgentSelection, AgentPrompt>,
  subagentMetadata: SubagentMetadata[],
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
  const warned = new Set<string>();
  const primaryToolState = createPrimaryToolState();
  const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
  let primaryAgentDefaultSelection: TlhPrimaryAgentSelection = DEFAULT_PRIMARY_AGENT;
  let sessionPrimaryAgentOverride: TlhPrimaryAgentSelection | undefined;
  let sessionExperimentalSnapshot: TlhExperimentalConfig | undefined;

  function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    ctx.ui.notify(message, "warning");
  }

  function warnInvalidPrimarySelection(ctx: ExtensionContext, source: string, value: string): void {
    warnOnce(
      ctx,
      `invalid-primary-agent-${source}-${value}`,
      `TLH primary agent "${value}" is not valid; falling back to ${DEFAULT_PRIMARY_AGENT}. Available: ${PRIMARY_AGENT_CYCLE.join(", ")}.`,
    );
  }

  function ensureLoadedPrimarySelection(
    ctx: ExtensionContext,
    selection: TlhPrimaryAgentSelection,
    source: string,
  ): TlhPrimaryAgentSelection {
    if (selection === DISABLED_PRIMARY_AGENT || primaryAgents.has(selection)) {
      return selection;
    }
    warnOnce(
      ctx,
      `missing-primary-agent-${source}-${selection}`,
      `TLH primary agent "${selection}" is not available; falling back to ${DEFAULT_PRIMARY_AGENT}.`,
    );
    return primaryAgents.has(DEFAULT_PRIMARY_AGENT)
      ? DEFAULT_PRIMARY_AGENT
      : DISABLED_PRIMARY_AGENT;
  }

  function syncPrimaryAgentState(ctx: ExtensionContext): void {
    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
    const defaultResolution = resolvePrimaryAgentConfig(primaryConfig) as {
      selection: TlhPrimaryAgentSelection;
      invalidSelected?: string;
    };
    if (defaultResolution.invalidSelected) {
      warnInvalidPrimarySelection(ctx, "default", defaultResolution.invalidSelected);
    }
    primaryAgentDefaultSelection = ensureLoadedPrimarySelection(
      ctx,
      defaultResolution.selection,
      "default",
    );

    const sessionResolution = primaryAgentSelectionFromBranch(ctx.sessionManager.getBranch()) as {
      selection?: TlhPrimaryAgentSelection;
      invalidSelected?: string;
    };
    if (sessionResolution.invalidSelected) {
      warnInvalidPrimarySelection(ctx, "session", sessionResolution.invalidSelected);
    }
    sessionPrimaryAgentOverride = sessionResolution.selection
      ? ensureLoadedPrimarySelection(ctx, sessionResolution.selection, "session")
      : undefined;
  }

  function currentPrimaryAgentSelection(): TlhPrimaryAgentSelection {
    return sessionPrimaryAgentOverride ?? primaryAgentDefaultSelection;
  }

  function activePrimaryAgent(): AgentPrompt | undefined {
    const selection = currentPrimaryAgentSelection();
    return selection === DISABLED_PRIMARY_AGENT ? undefined : primaryAgents.get(selection);
  }

  function currentPrimaryAgentLabel(): string {
    return primaryAgentLabel(currentPrimaryAgentSelection());
  }

  function buildActivePrimarySystemPrompt(
    baseSystemPrompt: string,
    cwd: string,
    settings: TlhSettings,
  ): string {
    const primary = activePrimaryAgent();
    const primaryEnabled = isEnabledPrimaryAgentSelection(currentPrimaryAgentSelection());
    const commitAttributionState = resolveTlhCommitAttribution(settings.tlh?.attribution);
    const prompts = [
      baseSystemPrompt,
      // Embedded-subagent guidance uses the once-per-session snapshot so it matches the
      // session-start delegation gate and keeps its documented next-session-only semantics.
      buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled, sessionExperimentalSnapshot),
      // Other experimental guidance reads settings fresh to preserve its existing mid-session behavior.
      buildPrimaryExperimentalPrompt(primary, settings.tlh?.experimental),
      buildTlhCommitAttributionPrompt(commitAttributionState),
    ];
    if (shouldAppendGnosisPrompt(cwd)) {
      prompts.push(GNOSIS_PROMPT);
    }
    return prompts.filter(Boolean).join("\n\n");
  }

  function buildLaunchSystemPrompt(ctx: ExtensionContext, baseSystemPrompt: string): string {
    return buildActivePrimarySystemPrompt(baseSystemPrompt, ctx.cwd, getTlhGlobalSettings(ctx.cwd));
  }

  function primaryAgentStatusMessage(ctx: ExtensionContext): string {
    syncPrimaryAgentState(ctx);
    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
    const override = sessionPrimaryAgentOverride;
    const effective = currentPrimaryAgentSelection();
    const settingsPath = tlhSettingsPathForWrite();
    const settingsLabel = settingsPath
      ? formatHomePath(settingsPath)
      : "unavailable outside isolated TLH profile";
    const activePrimary =
      effective !== DISABLED_PRIMARY_AGENT ? primaryAgents.get(effective) : undefined;
    const rawModelOverrides = primaryConfig?.modelOverrides as unknown;
    const modelOverride =
      activePrimary &&
      !shouldForceApplyForLock(activePrimary) &&
      isRecord(rawModelOverrides) &&
      typeof rawModelOverrides[effective] === "string"
        ? rawModelOverrides[effective]
        : "none";
    return [
      `${TLH_PACKAGE_NAME} (${TLH_NAME}) is active.`,
      `Primary agent: ${primaryAgentLabel(effective)}.`,
      `Session override: ${primaryAgentOverrideLabel(override)}.`,
      `Persistent default: ${primaryAgentDefaultLabel(primaryConfig)}.`,
      `Model override: ${modelOverride}.`,
      `Settings: ${settingsLabel}.`,
    ].join("\n");
  }

  function setSessionPrimaryAgentOverride(selection: TlhPrimaryAgentSelection | undefined): void {
    sessionPrimaryAgentOverride = selection;
    if (selection === undefined) {
      pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, {});
      return;
    }
    pi.appendEntry<TlhPrimaryAgentSessionState>(PRIMARY_AGENT_SESSION_STATE_ENTRY, {
      enabled: selection !== DISABLED_PRIMARY_AGENT,
      selected: selection,
    });
  }

  function getValidPrimaryTools(
    ctx: ExtensionContext,
    primary: AgentPrompt,
    warnOnMissing = true,
  ): string[] {
    const desiredTools = primaryToolAllowlist(primary);
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const validTools = filterAvailableTools(desiredTools, allToolNames);
    const missingTools = desiredTools.filter((tool) => !allToolNames.has(tool));
    if (warnOnMissing && missingTools.length > 0) {
      warnOnce(
        ctx,
        `missing-primary-tools-${primary.name}`,
        `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`,
      );
    }
    return validTools;
  }

  function applyPrimaryTools(
    ctx: ExtensionContext,
    primary: AgentPrompt,
    warnOnMissing = true,
  ): void {
    const validTools = getValidPrimaryTools(ctx, primary, warnOnMissing);
    if (validTools.length === 0) {
      return;
    }
    pi.setActiveTools(primaryToolState.apply(validTools, pi.getActiveTools()));
  }

  function restorePrimaryToolsIfAppropriate(): void {
    if (!primaryToolState.hasPrePrimaryTools()) {
      return;
    }
    const restoredTools = primaryToolState.restoreIfAppropriate(
      pi.getActiveTools(),
      () => new Set(pi.getAllTools().map((tool) => tool.name)),
    );
    if (restoredTools) {
      pi.setActiveTools(restoredTools);
    }
  }

  let tlhApplyingModel = false;
  let tlhRestoringCancelledModel = false;
  let sessionOnlyModel: ActiveModel | undefined;

  function updateSessionOnlyModel(model: ActiveModel | undefined): void {
    sessionOnlyModel = model;
    setTlhSessionOnlyModel(model);
  }

  async function applyPrimaryModel(
    ctx: ExtensionContext,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
  ): Promise<ActiveModel | undefined> {
    if (!model) {
      const candidates = [primary.model, ...(primary.tlhOpenaiModels ?? [])]
        .filter(Boolean)
        .join(", ");
      warnOnce(
        ctx,
        `missing-primary-model-${primary.name}`,
        `TLH primary agent models are not available for configured providers: ${candidates}`,
      );
      return undefined;
    }
    if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
      return model;
    }
    tlhApplyingModel = true;
    let success: boolean;
    try {
      success = await pi.setModel(model);
    } finally {
      tlhApplyingModel = false;
    }
    if (!success) {
      warnOnce(
        ctx,
        `primary-model-unavailable-${primary.name}`,
        `TLH could not switch to primary agent model: ${model.provider}/${model.id}`,
      );
      return undefined;
    }
    return model;
  }

  function currentThinkingSatisfiesPrimaryFloor(
    primary: AgentPrompt,
    currentThinking: string,
  ): boolean {
    return (
      primary.lockThinking !== true &&
      primary.minThinking !== undefined &&
      isThinkingLevel(currentThinking) &&
      thinkingLevelAtLeast(currentThinking, primary.minThinking)
    );
  }

  function applyPrimaryThinking(primary: AgentPrompt, thinking: AgentPrompt["thinking"]): void {
    if (!thinking) {
      return;
    }
    const currentThinking = pi.getThinkingLevel();
    if (
      currentThinking === thinking ||
      currentThinkingSatisfiesPrimaryFloor(primary, currentThinking)
    ) {
      return;
    }
    setExtensionThinkingLevel(pi, thinking);
  }

  async function restoreCancelledModel(
    ctx: ExtensionContext,
    previousModel: ActiveModel | undefined,
  ): Promise<void> {
    if (!previousModel) {
      return;
    }
    const releaseDefaultSuppression = beginTlhModelSelectionDefaultSuppression();
    tlhRestoringCancelledModel = true;
    tlhApplyingModel = true;
    try {
      const restored = await pi.setModel(previousModel);
      if (restored) {
        // The upstream picker posts `Model: <attempted>` after model_select
        // dispatch completes. Run on the next event-loop turn so the accurate
        // restored-model status remains the final visible message.
        setImmediate(() => {
          try {
            if (
              ctx.model?.provider === previousModel.provider &&
              ctx.model.id === previousModel.id
            ) {
              ctx.ui.notify(
                `Kept ${previousModel.provider}/${previousModel.id} after cancelling model selection.`,
                "info",
              );
            }
          } catch {
            // The originating extension context was replaced before the deferred
            // status could render; never report a model for another session.
          }
        });
      } else {
        ctx.ui.notify(
          `TLH could not restore the previous model: ${previousModel.provider}/${previousModel.id}`,
          "warning",
        );
      }
    } catch {
      ctx.ui.notify(
        `TLH could not restore the previous model: ${previousModel.provider}/${previousModel.id}`,
        "warning",
      );
    } finally {
      releaseDefaultSuppression();
      discardTlhModelSelectionDefaults();
      tlhApplyingModel = false;
      tlhRestoringCancelledModel = false;
    }
  }

  async function applyPrimaryDefaults(
    ctx: ExtensionContext,
    options: { warnOnMissing?: boolean } = {},
  ): Promise<void> {
    const { warnOnMissing = true } = options;
    const selection = currentPrimaryAgentSelection();
    if (!isEnabledPrimaryAgentSelection(selection)) {
      restorePrimaryToolsIfAppropriate();
      return;
    }

    const primary = activePrimaryAgent();
    if (!primary) {
      restorePrimaryToolsIfAppropriate();
      return;
    }

    applyPrimaryTools(ctx, primary, warnOnMissing);

    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
    const forceApply = shouldForceApplyForLock(primary);
    const shouldApplyModel =
      forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
    const shouldApplyThinking =
      forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyThinking");
    const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
    const primaryDefaults = selectProviderAwareAgentDefaults(
      primary,
      availableModels,
      ctx.model?.provider,
    );
    const currentProviderDefaults = selectProviderAwareAgentDefaults(
      primary,
      [],
      ctx.model?.provider,
    );

    // Resolve model: stored override (if still available in registry) takes precedence over frontmatter default
    let resolvedModel = primaryDefaults.model;
    if (!forceApply) {
      const storedOverride = primaryConfig?.modelOverrides?.[selection];
      if (storedOverride) {
        const overrideRef = availableModels.find((m) => `${m.provider}/${m.id}` === storedOverride);
        if (overrideRef) {
          resolvedModel = overrideRef;
        }
        // If override is unavailable, fall through to primaryDefaults.model (no error)
      }
    }

    const preservesSessionOnlyModel =
      !forceApply &&
      sessionOnlyModel !== undefined &&
      ctx.model?.provider === sessionOnlyModel.provider &&
      ctx.model.id === sessionOnlyModel.id;
    if (sessionOnlyModel && !preservesSessionOnlyModel) {
      // Locked primaries remain unconditional, and an out-of-band model
      // change must not leave the session-only gate stuck on another model.
      updateSessionOnlyModel(undefined);
    }
    const activePrimaryModel =
      shouldApplyModel && !preservesSessionOnlyModel
        ? await applyPrimaryModel(ctx, primary, resolvedModel)
        : undefined;
    if (shouldApplyThinking) {
      applyPrimaryThinking(
        primary,
        activePrimaryModel ? primaryDefaults.thinking : currentProviderDefaults.thinking,
      );
    }
  }

  async function applyPrimaryModeChange(ctx: ExtensionContext): Promise<void> {
    // A primary-mode change is an explicit request to reapply that mode's
    // defaults, so it ends any model choice scoped to the prior mode/session.
    replayTlhUnmatchedModelSelectionDefaults();
    updateSessionOnlyModel(undefined);
    await applyPrimaryDefaults(ctx);
  }

  async function resetPrimaryAgentModelOverride(
    ctx: ExtensionContext,
    agentName: string,
  ): Promise<TlhPrimaryAgentWriteResult | undefined> {
    if (!isTlhPrimaryAgentSelection(agentName)) {
      return undefined;
    }
    const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, agentName, undefined);
    await applyPrimaryModeChange(ctx);
    return result;
  }

  function cleanDisabledPrimarySessionHint(selection: TlhPrimaryAgentSelection): string {
    return selection === DISABLED_PRIMARY_AGENT
      ? " Existing conversation history may still contain TLH primary-agent guidance; start a new session for a completely clean context."
      : "";
  }

  async function cycleSessionPrimaryAgent(ctx: ExtensionContext): Promise<void> {
    syncPrimaryAgentState(ctx);
    const nextOverride = nextPrimaryAgentSelection(
      currentPrimaryAgentSelection(),
    ) as TlhPrimaryAgentSelection;
    setSessionPrimaryAgentOverride(nextOverride);
    await applyPrimaryModeChange(ctx);
    ctx.ui.notify(
      `Shift+Tab switched TLH primary agent to ${primaryAgentLabel(nextOverride)} for this session.${cleanDisabledPrimarySessionHint(nextOverride)}`,
      "info",
    );
  }

  function parsePrimaryAgentSelection(
    value: string | undefined,
  ): TlhPrimaryAgentSelection | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized !== undefined && PRIMARY_AGENT_CYCLE.includes(normalized)
      ? (normalized as TlhPrimaryAgentSelection)
      : undefined;
  }

  function switchPrimaryAgentCommandCompletions(prefix: string) {
    const options = [
      { value: "status", description: "Show TLH primary-agent status" },
      { value: "architect", description: "Use the architect primary agent for this session" },
      { value: "rush", description: "Use the Rush primary agent for this session" },
      { value: "product", description: "Use the product primary agent for this session" },
      { value: "bug-hunter", description: "Use the bug-hunter primary agent for this session" },
      { value: "disabled", description: "Disable TLH primary agents for this session" },
      { value: "reset", description: "Clear the session primary-agent override" },
      { value: "model reset", description: "Clear the active primary's persisted model override" },
      {
        value: "default architect",
        description: "Persistently select architect for future sessions",
      },
      { value: "default rush", description: "Persistently select Rush for future sessions" },
      { value: "default product", description: "Persistently select product for future sessions" },
      {
        value: "default bug-hunter",
        description: "Persistently select bug-hunter for future sessions",
      },
      {
        value: "default disabled",
        description: "Persistently disable TLH primaries for future sessions",
      },
      { value: "default reset", description: "Remove the persistent primary-agent setting" },
    ];
    const normalizedPrefix = prefix.trim().toLowerCase();
    const completions = options
      .filter((option) => option.value.startsWith(normalizedPrefix))
      .map((option) => ({
        value: option.value,
        label: option.value,
        description: option.description,
      }));
    return completions.length > 0 ? completions : null;
  }

  function registerCommands(): void {
    pi.registerCommand("switch-primary-agent", {
      description: "Show or switch the TLH primary agent",
      getArgumentCompletions: switchPrimaryAgentCommandCompletions,
      handler: async (args, ctx) => {
        syncPrimaryAgentState(ctx);
        const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const [command, value] = parts;

        if (!command || command === "status") {
          ctx.ui.notify(primaryAgentStatusMessage(ctx), "info");
          return;
        }

        if (command === "reset") {
          if (parts.length !== 1) {
            ctx.ui.notify("Usage: /switch-primary-agent reset", "error");
            return;
          }
          setSessionPrimaryAgentOverride(undefined);
          await applyPrimaryModeChange(ctx);
          ctx.ui.notify(
            `Cleared TLH primary-agent session override. Primary agent: ${currentPrimaryAgentLabel()}.`,
            "info",
          );
          return;
        }

        if (command === "model") {
          if (parts.length !== 2 || value !== "reset") {
            ctx.ui.notify("Usage: /switch-primary-agent model reset", "error");
            return;
          }
          const selection = currentPrimaryAgentSelection();
          if (selection === DISABLED_PRIMARY_AGENT) {
            ctx.ui.notify(
              "Cannot clear model override: primary agents are disabled. Enable a primary agent first with /switch-primary-agent <agent>.",
              "error",
            );
            return;
          }
          const primary = activePrimaryAgent();
          const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
          const rawModelOverrides = primaryConfig?.modelOverrides as unknown;
          const hasStoredOverride =
            isRecord(rawModelOverrides) && Object.hasOwn(rawModelOverrides, selection);
          if (primary && shouldForceApplyForLock(primary) && !hasStoredOverride) {
            ctx.ui.notify(
              `No model override to clear: ${primaryAgentLabel(selection)} uses fixed model defaults and does not persist overrides.`,
              "info",
            );
            return;
          }
          try {
            const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, undefined);
            await applyPrimaryModeChange(ctx);
            const backupLabel = result.backupPath
              ? ` Backup: ${formatHomePath(result.backupPath)}.`
              : "";
            const message =
              primary && shouldForceApplyForLock(primary)
                ? `Cleared stale ignored model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()} uses fixed model defaults.${backupLabel}`
                : `${result.changed ? "Cleared" : "No override to clear for"} model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`;
            ctx.ui.notify(message, "info");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Could not clear model override: ${message}`, "error");
          }
          return;
        }

        const selected = parsePrimaryAgentSelection(command);
        if (selected) {
          if (parts.length !== 1) {
            ctx.ui.notify(
              "Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled",
              "error",
            );
            return;
          }
          setSessionPrimaryAgentOverride(selected);
          await applyPrimaryModeChange(ctx);
          ctx.ui.notify(
            `TLH primary agent set to ${primaryAgentLabel(selected)} for this session.${cleanDisabledPrimarySessionHint(selected)}`,
            "info",
          );
          return;
        }

        if (command === "default") {
          if (parts.length !== 2) {
            ctx.ui.notify(
              "Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset",
              "error",
            );
            return;
          }
          const defaultSelection =
            value === "reset" ? undefined : parsePrimaryAgentSelection(value);
          if (value !== "reset" && !defaultSelection) {
            ctx.ui.notify(
              "Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset",
              "error",
            );
            return;
          }

          try {
            const result = writeTlhPrimaryAgentDefault(ctx.cwd, defaultSelection);
            syncPrimaryAgentState(ctx);
            await applyPrimaryModeChange(ctx);
            const changedLabel = result.changed ? "Updated" : "No change to";
            const backupLabel = result.backupPath
              ? ` Backup: ${formatHomePath(result.backupPath)}.`
              : "";
            ctx.ui.notify(
              `${changedLabel} TLH primary-agent persistent default at ${formatHomePath(result.settingsPath)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`,
              "info",
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
              `Could not update TLH primary-agent persistent default: ${message}`,
              "error",
            );
          }
          return;
        }

        ctx.ui.notify(
          "Usage: /switch-primary-agent [status|architect|rush|product|bug-hunter|disabled|reset|model reset|default architect|default rush|default product|default bug-hunter|default disabled|default reset]",
          "error",
        );
      },
    });

    pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT, {
      description: "Cycle TLH primary agent (architect/rush/product/bug-hunter/disabled)",
      handler: async (ctx) => {
        await cycleSessionPrimaryAgent(ctx);
      },
    });
  }

  async function applySessionStart(ctx: ExtensionContext): Promise<void> {
    // Session-only model intent does not cross session_start. This includes
    // /reload: the replacement runtime cannot safely prove that process-global
    // shim state belongs to the same session rather than a switched session.
    replayAllTlhUnclaimedModelSelectionDefaults();
    setTlhModelSelectionActiveModelResolver(() => ctx.model);
    updateSessionOnlyModel(undefined);
    activateTlhTicketSessionScope(ctx.cwd);
    sessionExperimentalSnapshot = getTlhGlobalSettings(ctx.cwd).tlh?.experimental;
    syncPrimaryAgentState(ctx);
    await applyPrimaryDefaults(ctx, { warnOnMissing: false });
  }

  function registerLifecycleHooks(): void {
    pi.on("thinking_level_select", async () => {
      // Native model-selector thinking writes stay attached to the pending
      // model claim. Independent /effort and thinking-cycle writes are drained
      // and restored through the retained upstream setter here.
      await persistTlhStandaloneThinkingDefaults();
    });

    pi.on("model_select", async (event, ctx) => {
      // The claim remains pending for the full upstream dispatch, regardless
      // of earlier async extension handlers. Refresh the live getter only after
      // claiming the operation classified during AgentSession.setModel.
      const defaultsClaim = claimTlhModelSelectionDefaults(event.model);
      setTlhModelSelectionActiveModelResolver(() => ctx.model);

      // Cancel restoration is intentionally ephemeral. It emits its own
      // source="set" event, which must not prompt or restore defaults again.
      if (tlhRestoringCancelledModel) {
        discardTlhModelSelectionDefaults(defaultsClaim);
        return;
      }
      // TLH's own primary-agent application is not a user choice. Keep its
      // previous persistence behavior without opening the scope picker or
      // recording a role override.
      if (tlhApplyingModel) {
        updateSessionOnlyModel(undefined);
        await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(
          () => false,
        );
        return;
      }

      if (event.source === "set") {
        if (isTlhNativeModelSelectorClaim(defaultsClaim)) {
          const scope = await chooseTlhModelSelectionScope(ctx);
          if (scope === "cancel") {
            discardTlhModelSelectionDefaults(defaultsClaim);
            await restoreCancelledModel(ctx, event.previousModel);
            return;
          }
          if (scope === "session-only") {
            // The active AgentSession already appended the model change. Keep
            // primary reapplication from replacing it for this active session,
            // and keep a no-op native re-selection from persisting it globally.
            updateSessionOnlyModel(event.model);
            discardTlhModelSelectionDefaults(defaultsClaim);
            return;
          }
        }
        // A single intercepted write is a programmatic setModel call, not the
        // native /model or Ctrl+L selector. Preserve its prior persistence
        // behavior without prompting (including provider-auth auto-selection).
        updateSessionOnlyModel(undefined);
        await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(
          () => false,
        );
      } else if (event.source === "cycle") {
        // Cycling has no scope picker and retains upstream behavior, but
        // does not create or edit a TLH primary override.
        updateSessionOnlyModel(undefined);
        await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(
          () => false,
        );
        return;
      } else {
        // Restore and future sources are outside TLH's scoped interaction.
        // Fail open by restoring claimed and unmatched upstream writes.
        updateSessionOnlyModel(undefined);
        await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(
          () => false,
        );
        replayTlhUnmatchedModelSelectionDefaults();
        return;
      }

      syncPrimaryAgentState(ctx);
      const selection = currentPrimaryAgentSelection();
      if (!isEnabledPrimaryAgentSelection(selection)) {
        return;
      }
      const primary = activePrimaryAgent();
      if (!primary) {
        return;
      }
      // Locked primaries (e.g. rush) keep their fixed provider defaults and do not persist user model overrides.
      if (shouldForceApplyForLock(primary)) {
        return;
      }
      const chosenKey = `${event.model.provider}/${event.model.id}`;
      // Determine the primary's bundled default model to know whether to clear the override.
      const primaryDefaults = selectProviderAwareAgentDefaults(
        primary,
        getUnfilteredAvailableModels(ctx.modelRegistry),
        event.model.provider,
      );
      const bundledKey = primaryDefaults.model
        ? `${primaryDefaults.model.provider}/${primaryDefaults.model.id}`
        : undefined;
      // If user picked the bundled default, clear the override; otherwise record it.
      const nextOverride = chosenKey === bundledKey ? undefined : chosenKey;
      // Capture before write to detect the no-override → override transition.
      const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
      const existingOverride = primaryConfig?.modelOverrides?.[selection];
      let writeResult: TlhPrimaryAgentWriteResult | undefined;
      try {
        writeResult = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, nextOverride);
      } catch {
        // Best-effort: model override persistence is non-blocking.  `writeResult`
        // stays undefined so a thrown or refused write records no baseline.
      }
      // Record override baseline on first creation (or remove-then-recreate), and
      // only after the settings write actually succeeded: a refused or failed write
      // must never leave a baseline behind for an override that was not persisted.
      // Do NOT rebaseline on edits of an existing override: that would silently
      // erase a pending drift the user has not yet been notified about.
      // Use isMeaningfulPrimaryOverride so null/"" stored by a user-edited
      // settings.json are treated as absent, not as an existing override.
      if (
        writeResult?.changed === true &&
        nextOverride !== undefined &&
        !isMeaningfulPrimaryOverride(existingOverride)
      ) {
        recordOverrideBaseline(selection, primary, event.model.provider);
      }
    });

    pi.on("session_tree", async (_event, ctx) => {
      replayTlhUnmatchedModelSelectionDefaults();
      setTlhModelSelectionActiveModelResolver(() => ctx.model);
      syncPrimaryAgentState(ctx);
      await applyPrimaryDefaults(ctx);
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
      replayAllTlhUnclaimedModelSelectionDefaults();
      setTlhModelSelectionActiveModelResolver(undefined);
      updateSessionOnlyModel(undefined);
      restorePrimaryToolsIfAppropriate();
    });

    pi.on("before_agent_start", async (event, ctx) => {
      replayTlhUnmatchedModelSelectionDefaults();
      setTlhModelSelectionActiveModelResolver(() => ctx.model);
      const settings = getTlhGlobalSettings(ctx.cwd);
      syncPrimaryAgentState(ctx);
      activateTlhTicketRuntime(settings, getAgentDir(), ctx.cwd);
      await applyPrimaryDefaults(ctx);
      return {
        systemPrompt: buildActivePrimarySystemPrompt(event.systemPrompt, ctx.cwd, settings),
      };
    });

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "bash") {
        // `toolName` narrows this branch, but not the shared mutable `input` payload.
        // Keep a runtime guard so direct/custom tool-call objects cannot pass a non-string command.
        if (typeof event.input.command !== "string") {
          return undefined;
        }
        const commitAttributionState = resolveTlhCommitAttribution(
          getTlhGlobalSettings(ctx.cwd).tlh?.attribution,
        );
        const reason = getTlhGitCommitAttributionBlockReason(
          event.input.command,
          commitAttributionState,
        );
        return reason ? { block: true, reason } : undefined;
      }
      if (event.toolName !== "subagent") {
        return undefined;
      }
      const subagentOverrides = getTlhSubagentOverrides(ctx.cwd);
      applyProviderAwareSubagentModels(
        event.input,
        subagentsByName,
        getUnfilteredAvailableModels(ctx.modelRegistry),
        ctx.model?.provider,
        ctx.model,
        {
          agentOverrides: subagentOverrides,
          onWarning: ({ agent, message }) =>
            warnOnce(ctx, `subagent-override-warning-${agent}-${message}`, message),
        },
      );
      capScoutSubagentTimeout(event.input);
      syncPrimaryAgentState(ctx);
      const selection = currentPrimaryAgentSelection();
      const allowedSubagents = allowedSubagentsForExperimentalConfig(
        getTlhGlobalSettings(ctx.cwd).tlh?.experimental,
      );
      if (!isEnabledPrimaryAgentSelection(selection)) {
        if (!isSubagentResumeAction(event.input)) {
          return undefined;
        }
        const disabledReason = validateSubagentToolInput(event.input, { allowedSubagents });
        return disabledReason ? { block: true, reason: disabledReason } : undefined;
      }
      if (selection === "rush" && isSubagentResumeAction(event.input)) {
        return { block: true, reason: rushResumeDelegationReason() };
      }
      if (selection === "rush" && isSubagentSteerAction(event.input)) {
        return { block: true, reason: rushSteerDelegationReason() };
      }
      if (selection === "rush" && subagentCallTargetsAgent(event.input, "developer")) {
        return { block: true, reason: rushDeveloperDelegationReason() };
      }
      const embeddedFeatureEnabled = isExperimentalFeatureEnabled(
        sessionExperimentalSnapshot,
        EMBEDDED_SUBAGENTS_FEATURE,
      );
      if (embeddedFeatureEnabled) {
        const embeddedBlockReason = embeddedDelegationBlockedReason(selection, event.input);
        if (embeddedBlockReason) {
          return { block: true, reason: embeddedBlockReason };
        }
      }
      const allowEmbeddedTargets = embeddedFeatureEnabled && selection === "architect";
      const reason = validateSubagentToolInput(event.input, {
        allowedSubagents,
        allowEmbeddedTargets,
      });
      if (reason) {
        return { block: true, reason };
      }
      if (allowEmbeddedTargets && !isOpaqueSubagentManagementActionInput(event.input)) {
        const requestedEmbeddedTargets = collectSubagentCallTargetsMatching(
          event.input,
          isEmbeddedSubagentTarget,
        );
        if (requestedEmbeddedTargets.length > 0) {
          const authorizedEmbeddedTargets = new Set(
            loadAuthorizedEmbeddedSubagentRuntimeNames(getAgentDir()),
          );
          const unauthorizedTargets = requestedEmbeddedTargets.filter(
            (target) => !authorizedEmbeddedTargets.has(target),
          );
          if (unauthorizedTargets.length > 0) {
            return {
              block: true,
              reason: `TLH architect may delegate to embedded.<slug> only when a valid package: embedded / name: <slug> markdown definition currently exists under ${formatHomePath(join(getAgentDir(), "agents"))}. Unauthorized target(s): ${unauthorizedTargets.join(", ")}.`,
            };
          }
        }
      }
      return undefined;
    });
  }

  return {
    applySessionStart,
    currentPrimaryAgentLabel,
    activePrimaryAgentPrompt: activePrimaryAgent,
    buildLaunchSystemPrompt,
    resetPrimaryAgentModelOverride,
    registerCommands,
    registerLifecycleHooks,
  };
}

export function registerTlhPrimaryAgentRuntime(
  pi: ExtensionAPI,
  options: TlhPrimaryAgentRuntimeOptions = {},
): TlhPrimaryAgentRuntime | undefined {
  const env = options.env ?? process.env;
  const childPromptBuilder = (): string => buildChildSubagentSystemPrompt();
  if (
    registerTlhStartupMode(pi, {
      env,
      buildChildSubagentSystemPrompt: childPromptBuilder,
      registerChild: () => {
        registerChildSubagentRuntime(pi, childPromptBuilder, env);
      },
    }) === "child"
  ) {
    return undefined;
  }

  installTlhModelSelectionPersistenceOverride();
  const runtime = createTlhPrimaryAgentRuntime(
    pi,
    options.primaryAgents ?? loadPrimaryAgents(),
    options.subagentMetadata ?? loadSubagentMetadata(),
  );
  runtime.registerCommands();
  runtime.registerLifecycleHooks();
  return runtime;
}

/**
 * Narrow an untrusted string to a known primary-agent selection.
 *
 * Primary-agent override names reach TLH from `settings.tlh.primaryAgent.modelOverrides`,
 * which is user-editable JSON, i.e. an external I/O boundary. Callers must validate
 * before treating a key as a `TlhPrimaryAgentSelection` rather than asserting the type.
 */
export function isTlhPrimaryAgentSelection(value: string): value is TlhPrimaryAgentSelection {
  return (PRIMARY_AGENT_CYCLE as readonly string[]).includes(value);
}

/**
 * Clear the stored model override for a named primary agent.
 *
 * Used by the /reconcile command to reset a primary-agent override via the same
 * guarded write path used by the primary-agent-runtime picker.
 *
 * Returns `undefined` when `agentName` is not a recognised primary-agent selection,
 * which is deliberately a refusal rather than a best-effort delete. An unrecognised
 * key (a typo or a stale name) has no packaged default to reconcile against, so TLH
 * reports it instead of quietly rewriting settings it does not understand. Callers
 * must not treat a refusal as a successful reset: acknowledging it would suppress
 * future reporting for an override that is still present.
 */
export function clearPrimaryAgentModelOverrideByName(
  cwd: string,
  agentName: string,
): TlhPrimaryAgentWriteResult | undefined {
  if (!isTlhPrimaryAgentSelection(agentName)) {
    return undefined;
  }
  return writeTlhPrimaryAgentModelOverride(cwd, agentName, undefined);
}
