import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";

import {
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
  isEmbeddedSubagentTarget,
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
  activeProjectSnapshotIdentityReason,
  isProjectPrimaryAgentName,
  projectSnapshotTargets,
  unavailableProjectModelWarningMessage,
} from "./primary-agent-runtime-boundaries.js";
import {
  clearPrimaryAgentModelOverrideByName,
  isTlhPrimaryAgentSelection,
  getTlhDurableThinkingLevel,
  getTlhGlobalSettings,
  getTlhPrimaryAgentConfig,
  getTlhSubagentOverrides,
  resolvePrimaryAutoApplySetting,
  writeTlhPrimaryAgentDefault,
  writeTlhPrimaryAgentModelOverride,
} from "./primary-agent-runtime-settings.js";
import {
  applyOpenRouterModelToProjectTargets,
  applyProviderAwareModelsToNonProjectTargets,
  collectSubagentCallTargetsMatching,
  embeddedDelegationBlockedReason,
  isOpaqueSubagentManagementActionInput,
  isSubagentResumeAction,
  isSubagentSteerAction,
  primaryToolAllowlist,
  rushDeveloperDelegationReason,
  rushResumeDelegationReason,
  rushSteerDelegationReason,
  subagentCallTargetsAgent,
} from "./primary-agent-runtime-delegation.js";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  dispatchPreflightBackoffMs,
  extractDispatchProviders,
  isHighConfidenceAuthSignatureInAttemptError,
  processSubagentRunDetails,
} from "./primary-agent-runtime-auth.js";
import {
  lookupTlhProjectAgentRunReference,
  probeTlhProjectAgentRunMarker,
} from "./project-agent-access.mjs";
import {
  GNOSIS_PROMPT,
  PRIMARY_AGENT_CYCLE_SHORTCUT,
  THINKING_LEVELS,
  TLH_NAME,
  TLH_PACKAGE_NAME,
} from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import {
  followsOpenrouterSession,
  formatProviderModelReference,
  listAgentModelDefaultReferences,
  resolveProviderThinking,
  selectProviderAwareAgentDefaults,
} from "./model-defaults.js";
import type { ProviderAuthHealthStore } from "./provider-auth-health.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import {
  beginTlhModelSelectionPersistenceSession,
  claimTlhModelSelectionDefaults,
  endTlhModelSelectionPersistenceSession,
  installTlhModelSelectionPersistenceOverride,
  isTlhPersistedModelSelection,
  type TlhModelSelectionPersistenceSession,
  updateTlhModelSelectionPersistenceContext,
} from "./model-selection-scope.js";
import {
  getAvailableThinkingLevels,
  isThinkingLevel,
  setExtensionThinkingLevel,
} from "./thinking.js";
import { appendBeforeChildSubagentBoundary } from "../shared/subagent-child-boundary.js";
import type { ProjectAgentGuidanceInventory } from "../shared/project-agent-guidance.js";
import {
  buildChildSubagentSystemPrompt,
  buildTlhSystemPrompt,
  loadPrimaryAgents,
  loadSubagentMetadata,
} from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite } from "./profile-state.js";
import {
  createTlhPrimaryAgentResourceLifecycle,
  retireTlhPrimaryAgentResourceRuntime,
  type PrimaryAgentResourceLifecycle,
  type ProjectAgentSnapshotLoader,
  type ProjectDefaultsLoader,
  type SessionStartOperation,
} from "./primary-agent-runtime-lifecycle.js";
import type {
  AgentPrompt,
  ReasoningModel,
  SubagentMetadata,
  ThinkingLevel,
  TlhPrimaryAgentSelection,
  TlhPrimaryAgentSessionState,
  TlhPrimaryAgentWriteResult,
  TlhSettings,
} from "./types.js";

type TlhPrimaryAgentRuntimeOptions = {
  env?: Record<string, string | undefined>;
  primaryAgents?: Map<TlhPrimaryAgentSelection, AgentPrompt>;
  subagentMetadata?: SubagentMetadata[];
  projectAgentLoader?: ProjectAgentSnapshotLoader;
  /** Injectable project-defaults loader for testing. Defaults to the bridge. */
  projectDefaultsLoader?: ProjectDefaultsLoader;
  /**
   * Returns the current session's provider auth-health store, or undefined when
   * called outside a session. Injected from the-last-harness.ts so the tool_call
   * handler can share the same store instance created in session_start.
   */
  getProviderAuthHealthStore?: () => ProviderAuthHealthStore | undefined;
  /**
   * Injectable clock for testing dispatch-time throttle behaviour.
   * Defaults to Date.now.
   */
  now?: () => number;
  /**
   * AgentSession exported by Pi's virtual bundled module when the extension
   * loader provides one. The model persistence seam also validates/uses the
   * published bundle path when this optional route is unavailable.
   */
  bundledAgentSessionConstructor?: unknown;
};

type ActiveModel = NonNullable<ExtensionContext["model"]>;

type SessionThinkingOverride = {
  primary: TlhPrimaryAgentSelection;
  level: ThinkingLevel;
};

export type TlhPrimaryAgentRuntime = {
  applySessionStart(ctx: ExtensionContext): Promise<void>;
  projectAgentGuidanceSnapshot(): ProjectAgentGuidanceInventory | undefined;
  currentPrimaryAgentLabel(): string;
  activePrimaryAgentPrompt(): AgentPrompt | undefined;
  /** Remember a validated user thinking selection for this primary/session. */
  recordUserThinkingLevel?(level: ThinkingLevel): void;
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

const EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE =
  "Extension runtime not initialized. Action methods cannot be called during extension loading.";

function isExtensionRuntimeNotInitializedError(error: unknown): boolean {
  return error instanceof Error && error.message === EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE;
}

function primaryAgentLabel(selection: TlhPrimaryAgentSelection): string {
  return selection;
}

function primaryAgentOverrideLabel(selection: TlhPrimaryAgentSelection | undefined): string {
  return selection ?? "none";
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
    const additions = [
      buildChildPrompt(),
      buildChildExperimentalPrompt(childAgentName, settings.tlh?.experimental),
      buildTlhCommitAttributionPrompt(commitAttributionState),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      systemPrompt: appendBeforeChildSubagentBoundary(event.systemPrompt, additions),
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
  runtimeOptions: {
    getProviderAuthHealthStore?: () => ProviderAuthHealthStore | undefined;
    projectAgentLoader?: ProjectAgentSnapshotLoader;
    projectDefaultsLoader?: ProjectDefaultsLoader;
    now?: () => number;
  } = {},
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
  const { getProviderAuthHealthStore, now: nowFn = Date.now } = runtimeOptions;
  const warned = new Set<string>();
  const noticed = new Set<string>();
  const primaryToolState = createPrimaryToolState();
  const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
  let primaryAgentDefaultSelection: TlhPrimaryAgentSelection = DEFAULT_PRIMARY_AGENT;
  let sessionPrimaryAgentOverride: TlhPrimaryAgentSelection | undefined;

  // Per-provider throttle for credential preflights.
  // Key: provider string. Value: { failures, nextAllowedAt (ms timestamp) }.
  // Reset on success; failures increment on reauth-required / transient-unavailable.
  // In-flight coalescing is handled by the store itself; this throttle prevents
  // re-scheduling more often than the chosen backoff window.
  const preflightThrottle = new Map<string, { failures: number; nextAllowedAt: number }>();

  // Session-scoped per-provider notification state for reauth warnings.
  // Tracks which providers have already received a one-time actionable notification
  // (e.g. "run /login"). Deleted (re-armed) when the provider returns to healthy so
  // a later genuine failure can notify again.
  const notifiedForReauth = new Set<string>();

  // Notification intents recorded by the async-complete handler, which has no ctx.
  // Flushed on the next turn_end BEFORE the clearing probe loop, so the probe
  // cannot erase the evidence before the user is told.
  const pendingReauthNotifications = new Set<string>();

  /**
   * Returns true when a credential preflight should be scheduled for `provider`
   * at dispatch time.
   *
   * Rules:
   *  - No prior store entry → probe (first time this provider is seen).
   *  - Healthy → skip (never probe a provider already confirmed healthy).
   *  - All other statuses (reauth-required, transient-unavailable, unknown) are
   *    "not yet confirmed good" — probe when outside the backoff window.
   *
   * Rationale: transient-unavailable and unknown are not "no problem here",
   * they mean "we don't know yet". Skipping them permanently would let a
   * network blip on the first dispatch hide a dead refresh token for the
   * entire session — the exact silent-degradation failure issue #523 exists
   * to prevent. adapterGetProviderAuth short-circuits on a missing-method
   * check with no I/O, so unknown from an unsupported runtime is cheap to
   * retry and needs no special casing.
   */
  function shouldPreflightAtDispatch(
    provider: string,
    store: ProviderAuthHealthStore,
    now: number,
  ): boolean {
    const entry = store.getEntry(provider);
    if (!entry) return true;
    if (entry.status === "healthy") return false;
    // All non-healthy statuses: probe when outside the backoff window.
    const throttle = preflightThrottle.get(provider);
    if (!throttle) return true;
    return now >= throttle.nextAllowedAt;
  }

  /**
   * Returns true when a credential preflight should be re-scheduled for a
   * provider during the turn_end clearing pass.
   *
   * Covers all non-healthy statuses, not just reauth-required: a provider
   * that recorded transient-unavailable or unknown may have recovered or may
   * have a dead credential that was masked by the transient error. Retrying
   * ensures no provider stays permanently invisible in this session.
   */
  function shouldPreflightForClearing(
    provider: string,
    store: ProviderAuthHealthStore,
    now: number,
  ): boolean {
    const entry = store.getEntry(provider);
    if (!entry || entry.status === "healthy") return false;
    // All non-healthy statuses: probe when outside the backoff window.
    const throttle = preflightThrottle.get(provider);
    if (!throttle) return true;
    return now >= throttle.nextAllowedAt;
  }

  /**
   * Emit a one-time notification when a provider is newly flagged as needing
   * attention. Safe to call when ctx.ui is unavailable — never throws. Idempotent
   * per provider: subsequent calls are no-ops until re-armed by a healthy probe.
   *
   * Two message variants exist:
   *  - Probe-confirmed: imperative ("requires re-authentication — run /login now").
   *  - Run-level observation: descriptive ("a run was rejected — run /login if this
   *    recurs"), because the local probe cannot confirm the current state.
   */
  function emitReauthNotificationIfNew(
    provider: string,
    ctx: ExtensionContext,
    message: string,
  ): boolean {
    if (notifiedForReauth.has(provider)) return true;
    try {
      ctx.ui.notify(message, "warning");
      // Mark only after notify returns without throwing, so a UI exception on one
      // call does not permanently suppress the notification for this provider.
      notifiedForReauth.add(provider);
      return true;
    } catch {
      // Best-effort: ctx.ui may be unavailable or non-interactive.
      // Deliberately not marking the provider as notified so the next available
      // context can retry.
      return false;
    }
  }

  /**
   * Fire-and-forget credential preflight.
   *
   * IMPORTANT: getProviderAuth in the pinned runtime can mutate auth.json and
   * hold the auth-file lock while rotating a near-expiry OAuth credential
   * (pi-ai/dist/auth/resolve.js:56-90). This call is intentionally async and
   * non-blocking with respect to the tool_call handler return value.
   *
   * Must never throw into the caller. Uses the store's in-flight coalescing to
   * avoid issuing duplicate auth calls for the same provider.
   */
  function scheduleProviderPreflight(
    provider: string,
    store: ProviderAuthHealthStore,
    modelRegistry: unknown,
    currentNow: number,
    ctx?: ExtensionContext,
  ): void {
    // Tentatively block re-scheduling while the probe is in flight by setting
    // nextAllowedAt to the maximum backoff. The callback will update it to the
    // actual value once the result is known.
    const existing = preflightThrottle.get(provider);
    preflightThrottle.set(provider, {
      failures: existing?.failures ?? 0,
      nextAllowedAt: currentNow + 300_000,
    });

    void store
      .probeProvider(modelRegistry, provider)
      .then((status) => {
        const t = nowFn();
        if (status === "healthy") {
          preflightThrottle.delete(provider);
          notifiedForReauth.delete(provider); // re-arm for a future genuine failure
          // Do NOT clear pendingReauthNotifications here. A pending intent is
          // evidence from a real rejected request — a local healthy probe returning
          // OK does not disprove it (revoked-but-unexpired case). The intent will
          // be flushed at the next turn_end with the run-level message.
        } else {
          const prev = preflightThrottle.get(provider);
          const newFailures = (prev?.failures ?? 0) + 1;
          preflightThrottle.set(provider, {
            failures: newFailures,
            nextAllowedAt: t + dispatchPreflightBackoffMs(newFailures),
          });
          if (status === "reauth-required" && ctx !== undefined) {
            emitReauthNotificationIfNew(
              provider,
              ctx,
              `Provider ${provider} requires re-authentication. Run /login to reconfigure. ` +
                `Opposite-provider independence for code-reviewer, oracle, and contrarian is affected.`,
            );
          }
        }
      })
      .catch(() => {
        // probeProvider captures errors internally; this branch is a safety net only.
      });
  }

  function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    ctx.ui.notify(message, "warning");
  }

  /** Emit a one-time info notice (once per key per session). */
  function noticeOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (noticed.has(key)) {
      return;
    }
    noticed.add(key);
    try {
      ctx.ui.notify(message, "info");
    } catch {
      // A broken UI must not abort a lifecycle boundary after defaults apply.
    }
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
    const previousSelection = currentPrimaryAgentSelection();
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
    if (currentPrimaryAgentSelection() !== previousSelection) {
      clearSessionThinkingOverride();
    }
  }

  function currentPrimaryAgentSelection(): TlhPrimaryAgentSelection {
    return sessionPrimaryAgentOverride ?? primaryAgentDefaultSelection;
  }

  type RetainedProjectActionLookup =
    | { status: "missing"; targetNames: readonly string[] }
    | {
        status: "found";
        runId: string;
        targetNames: readonly string[];
      }
    | {
        status: "ambiguous";
        runIds: readonly string[];
        targetNames: readonly string[];
      };

  async function retainedProjectActionLookup(input: unknown): Promise<RetainedProjectActionLookup> {
    if (!isRecord(input) || (input.action !== "resume" && input.action !== "steer")) {
      return { status: "missing", targetNames: [] };
    }
    const requestedId =
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id.trim()
        : typeof input.dir === "string" && input.dir.trim().length > 0
          ? basename(input.dir)
          : undefined;
    if (!requestedId) return { status: "missing", targetNames: [] };
    try {
      const lookup = await lookupTlhProjectAgentRunReference(requestedId);
      if (!isRecord(lookup) || typeof lookup.status !== "string") {
        return { status: "missing", targetNames: [] };
      }
      const targetNames = [
        ...new Set(
          (Array.isArray(lookup.captures) ? lookup.captures : [])
            .filter(
              (entry): entry is { source?: unknown; agent?: unknown } =>
                isRecord(entry) && entry.source === "project",
            )
            .map((entry) => (typeof entry.agent === "string" ? entry.agent : ""))
            .filter(Boolean),
        ),
      ];
      if (lookup.status === "found" && typeof lookup.runId === "string") {
        return { status: "found", runId: lookup.runId, targetNames };
      }
      if (
        lookup.status === "ambiguous" &&
        Array.isArray(lookup.runIds) &&
        lookup.runIds.every((runId) => typeof runId === "string")
      ) {
        return { status: "ambiguous", runIds: lookup.runIds, targetNames };
      }
    } catch {
      // A bridge failure must not turn a potentially project-owned control into
      // authority; the executor performs the same private lookup independently.
    }
    return { status: "missing", targetNames: [] };
  }

  function activePrimaryAgent(): AgentPrompt | undefined {
    const selection = currentPrimaryAgentSelection();
    return selection === DISABLED_PRIMARY_AGENT ? undefined : primaryAgents.get(selection);
  }

  const projectAgentLifecycle: PrimaryAgentResourceLifecycle =
    createTlhPrimaryAgentResourceLifecycle({
      getPrimaryAgentSelection: currentPrimaryAgentSelection,
      hasActivePrimaryAgent: () => activePrimaryAgent() !== undefined,
      projectAgentLoader: runtimeOptions.projectAgentLoader,
      projectDefaultsLoader: runtimeOptions.projectDefaultsLoader,
    });

  function isCurrentSessionStartOperation(operation: SessionStartOperation): boolean {
    return projectAgentLifecycle.isCurrentSessionStartOperation(operation);
  }

  function activeProjectDefaultsForCwd(cwd: string) {
    return projectAgentLifecycle.activeProjectDefaultsForCwd(cwd);
  }

  function warnProjectDefaultsOnce(
    ctx: ExtensionContext,
    projectRoot: string | undefined,
    agent: string | undefined,
    message: string,
    identityMessage?: string,
  ): void {
    projectAgentLifecycle.warnProjectDefaultsOnce(
      ctx,
      projectRoot,
      agent,
      message,
      identityMessage,
    );
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
      // Project-agent guidance uses a once-per-session snapshot so it remains stable until /reload
      // or a new session, while role changes select the matching entry from the same snapshot.
      buildTlhSystemPrompt(
        primary,
        subagentMetadata,
        primaryEnabled,
        projectAgentLifecycle.projectAgentGuidanceSnapshot(),
      ),
      // Experimental guidance reads settings fresh to preserve its existing mid-session behavior.
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
    primary: AgentPrompt | undefined,
    warnOnMissing = true,
  ): string[] {
    const desiredTools = primaryToolAllowlist(primary);
    const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const validTools = filterAvailableTools(desiredTools, allToolNames);
    const missingTools = desiredTools.filter((tool) => !allToolNames.has(tool));
    if (warnOnMissing && missingTools.length > 0) {
      warnOnce(
        ctx,
        `missing-primary-tools-${primary?.name ?? DISABLED_PRIMARY_AGENT}`,
        `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`,
      );
    }
    return validTools;
  }

  function applyPrimaryTools(
    ctx: ExtensionContext,
    primary: AgentPrompt | undefined,
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
  let tlhApplyingThinking = false;
  const tlhInternalChange = new AsyncLocalStorage<boolean>();
  let lastObservedModel: ActiveModel | undefined;
  let sessionOnlyModel: ActiveModel | undefined;
  let sessionThinkingOverride: SessionThinkingOverride | undefined;
  let modelSelectionContext: ExtensionContext | undefined;
  let modelSelectionSession: TlhModelSelectionPersistenceSession | undefined;

  function updateSessionOnlyModel(model: ActiveModel | undefined): void {
    sessionOnlyModel = model;
  }

  function isCurrentRuntime(): boolean {
    return projectAgentLifecycle.isCurrentRuntime();
  }

  function modelsMatch(left: ActiveModel | undefined, right: ActiveModel | undefined): boolean {
    return left?.provider === right?.provider && left?.id === right?.id;
  }

  function clearSessionThinkingOverride(): void {
    sessionThinkingOverride = undefined;
  }

  function beginModelSelectionSession(ctx: ExtensionContext): void {
    if (!isCurrentRuntime()) {
      return;
    }
    modelSelectionContext = ctx;
    const session = beginTlhModelSelectionPersistenceSession((model) => {
      const currentContext = modelSelectionContext;
      if (currentContext) {
        handlePersistedModelSelection(currentContext, model);
      }
    });
    modelSelectionSession = session;
  }

  function updateModelSelectionContext(ctx: ExtensionContext): void {
    if (!isCurrentRuntime()) {
      return;
    }
    modelSelectionContext = ctx;
    const session = modelSelectionSession;
    if (!session) {
      return;
    }
    updateTlhModelSelectionPersistenceContext(session, (model) => {
      const currentContext = modelSelectionContext;
      if (currentContext) {
        handlePersistedModelSelection(currentContext, model);
      }
    });
  }

  function endModelSelectionSession(): void {
    modelSelectionContext = undefined;
    const session = modelSelectionSession;
    modelSelectionSession = undefined;
    if (session && isCurrentRuntime()) {
      endTlhModelSelectionPersistenceSession(session);
    }
  }

  function setTlhThinkingLevel(level: ThinkingLevel): void {
    // Keep TLH's own default application in an async-local context so the
    // resulting thinking_level_select event is not recorded as user intent.
    tlhApplyingThinking = true;
    try {
      tlhInternalChange.run(true, () => setExtensionThinkingLevel(pi, level));
    } finally {
      tlhApplyingThinking = false;
    }
  }

  function recordUserThinkingLevel(level: ThinkingLevel): void {
    const selection = currentPrimaryAgentSelection();
    if (!isThinkingLevel(level) || !isEnabledPrimaryAgentSelection(selection)) {
      return;
    }
    sessionThinkingOverride = { primary: selection, level };
  }

  function clampThinkingLevelForModel(
    level: ThinkingLevel,
    model: ActiveModel | undefined,
  ): ThinkingLevel {
    // Model metadata can be absent in older/direct contexts. In that case do
    // not guess at provider capabilities and retain the requested level.
    const availableLevels =
      model && "reasoning" in model
        ? getAvailableThinkingLevels(model as ReasoningModel)
        : [...THINKING_LEVELS];
    if (availableLevels.includes(level)) {
      return level;
    }

    const requestedIndex = THINKING_LEVELS.indexOf(level);
    if (requestedIndex >= 0) {
      // Match upstream's clamp policy: prefer the nearest supported level at
      // or above the requested level, then walk down if none exists.
      for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
        const candidate = THINKING_LEVELS[index];
        if (availableLevels.includes(candidate)) {
          return candidate;
        }
      }
      for (let index = requestedIndex - 1; index >= 0; index -= 1) {
        const candidate = THINKING_LEVELS[index];
        if (availableLevels.includes(candidate)) {
          return candidate;
        }
      }
    }
    // A non-reasoning model exposes only `off`, which is the safe fallback
    // instead of replaying a reasoning-only target.
    return availableLevels[0] ?? "off";
  }

  function updateRetainedThinkingForModel(
    selection: TlhPrimaryAgentSelection,
    model: ActiveModel | undefined,
  ): void {
    const override = sessionThinkingOverride;
    if (!override || override.primary !== selection) {
      return;
    }
    override.level = clampThinkingLevelForModel(override.level, model);
  }

  function sessionThinkingLevelForPrimary(
    selection: TlhPrimaryAgentSelection,
    model: ActiveModel | undefined,
  ): ThinkingLevel | undefined {
    const override = sessionThinkingOverride;
    if (!override || override.primary !== selection) {
      return undefined;
    }
    const clamped = clampThinkingLevelForModel(override.level, model);
    // A model switch can make a retained level unavailable. Keep the clamped
    // value as the session intent so later lifecycle reapplication is stable
    // and does not jump back to the packaged role default.
    override.level = clamped;
    return clamped;
  }

  type PrimaryModelSource = "project" | "existing";

  async function applyPrimaryModel(
    ctx: ExtensionContext,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
    _source: PrimaryModelSource,
  ): Promise<ActiveModel | undefined> {
    if (!model) {
      const candidateValues = [
        primary.preferredModel ? formatProviderModelReference(primary.preferredModel) : undefined,
        ...(primary.tlhModelDefaultsSource === "legacy" ? [primary.model] : []),
        ...listAgentModelDefaultReferences(primary).map(formatProviderModelReference),
      ].filter((candidate): candidate is string => Boolean(candidate));
      const candidates = [...new Set(candidateValues)].join(", ");
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
      success = await tlhInternalChange.run(true, () => pi.setModel(model));
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

  function applyPrimaryThinking(
    cwd: string,
    selection: TlhPrimaryAgentSelection,
    thinking: AgentPrompt["thinking"],
    model: ActiveModel | undefined,
    /**
     * Layer-2 effort from project defaults (.tlh/defaults.json).
     * Beats persisted durable thinking (layer 3) and bundled frontmatter (layer 4),
     * but yields to explicit in-session user actions (layer 1).
     */
    projectEffort?: ThinkingLevel,
  ): ThinkingLevel | undefined {
    const sessionThinking = sessionThinkingLevelForPrimary(selection, model); // layer 1
    const durableThinking = getTlhDurableThinkingLevel(cwd); // layer 3
    // Precedence: session (1) > project defaults (2) > durable/global setting (3) > bundled (4)
    const requestedThinking = sessionThinking ?? projectEffort ?? durableThinking ?? thinking;
    if (requestedThinking === undefined) {
      return undefined;
    }

    const projectEffortIsEffective = sessionThinking === undefined && projectEffort !== undefined;
    const targetThinking = clampThinkingLevelForModel(requestedThinking, model);
    if (pi.getThinkingLevel() === targetThinking) {
      return projectEffortIsEffective ? targetThinking : undefined;
    }
    setTlhThinkingLevel(targetThinking);
    return projectEffortIsEffective ? targetThinking : undefined;
  }

  async function applyPrimaryDefaults(
    ctx: ExtensionContext,
    options: {
      warnOnMissing?: boolean;
      sessionStartOperation?: SessionStartOperation;
    } = {},
  ): Promise<void> {
    const { warnOnMissing = true, sessionStartOperation } = options;
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    lastObservedModel = ctx.model;
    const selection = currentPrimaryAgentSelection();
    if (!isEnabledPrimaryAgentSelection(selection)) {
      // Disabled mode keeps the architect capability surface (tools only) while
      // omitting the architect persona and all of its model/thinking defaults.
      if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
      try {
        applyPrimaryTools(ctx, primaryAgents.get(DEFAULT_PRIMARY_AGENT), warnOnMissing);
      } catch (error) {
        // Resource-loader lifecycle smoke tests can invoke disabled session
        // handlers before the action runtime is bound. Retry on the next
        // lifecycle hook instead of failing the session; real runtime errors
        // must still surface.
        if (!isExtensionRuntimeNotInitializedError(error)) {
          throw error;
        }
      }
      return;
    }

    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    const primary = activePrimaryAgent();
    if (!primary) {
      restorePrimaryToolsIfAppropriate();
      return;
    }

    applyPrimaryTools(ctx, primary, warnOnMissing);
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;

    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
    const shouldApplyModel = resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
    const shouldApplyThinking = resolvePrimaryAutoApplySetting(
      primaryConfig,
      primary,
      "applyThinking",
    );
    const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
    const primaryDefaults = selectProviderAwareAgentDefaults(
      primary,
      availableModels,
      ctx.model?.provider,
      ctx.model,
    );

    // Layer 1: detect whether a session-only model is active (explicit in-session user action).
    // Compute early so layers 2-4 can avoid overriding it.
    const preservesSessionOnlyModel =
      sessionOnlyModel !== undefined &&
      ctx.model?.provider === sessionOnlyModel.provider &&
      ctx.model?.id === sessionOnlyModel.id;
    if (sessionOnlyModel && !preservesSessionOnlyModel) {
      // An out-of-band model change must not leave the session-only gate stuck
      // on another model.
      updateSessionOnlyModel(undefined);
    }

    // 4-layer model/effort precedence (per field, independently):
    //   1. Explicit in-session user action (session-only model / session thinking override)
    //   2. Project defaults (.tlh/defaults.json primaryAgents entry)
    //   3. Persisted user overrides (settings.tlh.primaryAgent.modelOverrides.<primary>)
    //   4. Bundled tlhModelDefaults frontmatter

    // Layer 4: bundled frontmatter
    let resolvedModel = primaryDefaults.model;
    let resolvedModelSource: PrimaryModelSource = "existing";
    let projectModelCandidate: { reference: string; model: ActiveModel } | undefined;
    let projectEffort: ThinkingLevel | undefined;

    // Layer 3: persisted user overrides
    const storedOverride = primaryConfig?.modelOverrides?.[selection];
    if (storedOverride) {
      const overrideRef = availableModels.find((m) => `${m.provider}/${m.id}` === storedOverride);
      if (overrideRef) {
        resolvedModel = overrideRef;
      }
      // If stored override is unavailable, fall through to layer 4 (no error)
    }

    // Layer 2: project defaults — model and effort resolve independently per field.
    // Model: gated by preservesSessionOnlyModel (session-only model wins for the model field).
    // Effort: NOT gated by preservesSessionOnlyModel — the layer-1 guard for effort is
    //   sessionThinkingOverride, checked inside applyPrimaryThinking.
    const projectDefaults = activeProjectDefaultsForCwd(ctx.cwd);
    const projectEntry =
      projectDefaults && isProjectPrimaryAgentName(selection)
        ? projectDefaults.primaryAgents[selection]
        : undefined;
    if (projectDefaults?.projectRoot && projectEntry) {
      if (!preservesSessionOnlyModel && projectEntry.model !== undefined) {
        const projectModelRef = availableModels.find(
          (m) => `${m.provider}/${m.id}` === projectEntry.model,
        );
        if (projectModelRef) {
          resolvedModel = projectModelRef;
          resolvedModelSource = "project";
          projectModelCandidate = { reference: projectEntry.model, model: projectModelRef };
        } else {
          // Unavailable model: warn once and fall through to layer 3 / layer 4.
          const warning = unavailableProjectModelWarningMessage(selection, projectEntry.model);
          warnProjectDefaultsOnce(
            ctx,
            projectDefaults.projectRoot,
            selection,
            warning,
            `${warning}\0${projectEntry.model}`,
          );
        }
      }
      if (projectEntry.effort !== undefined && isThinkingLevel(projectEntry.effort)) {
        projectEffort = projectEntry.effort;
      }
    }

    // An out-of-band model change must not leave the session-only gate stuck on another model.
    if (sessionOnlyModel && !preservesSessionOnlyModel) {
      updateSessionOnlyModel(undefined);
    }
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    const activePrimaryModel =
      shouldApplyModel && !preservesSessionOnlyModel
        ? await applyPrimaryModel(ctx, primary, resolvedModel, resolvedModelSource)
        : undefined;
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    const appliedProjectModel =
      projectModelCandidate !== undefined &&
      modelsMatch(activePrimaryModel, projectModelCandidate.model)
        ? projectModelCandidate.reference
        : undefined;
    let appliedProjectEffort: ThinkingLevel | undefined;
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    if (shouldApplyThinking) {
      // Thinking follows the model that is actually effective after stored pins
      // and model-application decisions, rather than the pre-pin selection.
      const effectiveModel = activePrimaryModel ?? ctx.model;
      appliedProjectEffort = applyPrimaryThinking(
        ctx.cwd,
        selection,
        resolveProviderThinking(primary, effectiveModel?.provider),
        effectiveModel,
        projectEffort, // layer 2
      );
    }

    // Show a concise notice when project defaults are actually applied (once per primary per session).
    // Each field is reported only after its project value wins precedence and is effective:
    // the model must be returned by applyPrimaryModel, while thinking reports its clamped target.
    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    if (appliedProjectModel !== undefined || appliedProjectEffort !== undefined) {
      const appliedParts: string[] = [];
      if (appliedProjectModel !== undefined) {
        appliedParts.push(`model ${appliedProjectModel}`);
      }
      if (appliedProjectEffort !== undefined) {
        appliedParts.push(`effort ${appliedProjectEffort}`);
      }
      if (appliedParts.length > 0) {
        noticeOnce(
          ctx,
          `project-defaults-applied-${selection}`,
          `TLH applied project defaults for ${selection}: ${appliedParts.join(", ")}.`,
        );
      }
    }

    if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation)) return;
    lastObservedModel = activePrimaryModel ?? ctx.model;
  }

  async function applyPrimaryModeChange(ctx: ExtensionContext): Promise<void> {
    // A primary-mode change is an explicit request to reapply that mode's
    // defaults, so it ends any model choice scoped to the prior mode/session.
    updateSessionOnlyModel(undefined);
    clearSessionThinkingOverride();
    await applyPrimaryDefaults(ctx);
  }

  /**
   * Apply the TLH primary override side effects for an explicit persisted model
   * default. Pi's model_select event has no persistence bit, so this is called
   * both from the matching setModel dispatch and from the wrapper for same-model saves.
   */
  function handlePersistedModelSelection(
    ctx: ExtensionContext,
    model: Pick<ActiveModel, "provider" | "id">,
  ): void {
    if (tlhApplyingModel) {
      return;
    }
    updateSessionOnlyModel(undefined);
    syncPrimaryAgentState(ctx);
    const selection = currentPrimaryAgentSelection();
    if (!isEnabledPrimaryAgentSelection(selection)) {
      return;
    }
    const primary = activePrimaryAgent();
    if (!primary) {
      return;
    }

    const chosenKey = `${model.provider}/${model.id}`;
    // OpenRouter's non-opposite primary default intentionally follows the active
    // session model, so it is not a packaged default that should clear an override.
    const primaryDefaults = selectProviderAwareAgentDefaults(
      primary,
      getUnfilteredAvailableModels(ctx.modelRegistry),
      model.provider,
      model,
    );
    const bundledKey =
      !followsOpenrouterSession(primary, model.provider) && primaryDefaults.model
        ? `${primaryDefaults.model.provider}/${primaryDefaults.model.id}`
        : undefined;
    // If user picked the bundled default, clear the override; otherwise record it.
    const nextOverride = chosenKey === bundledKey ? undefined : chosenKey;
    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
    const existingOverride = primaryConfig?.modelOverrides?.[selection];
    let writeResult: TlhPrimaryAgentWriteResult | undefined;
    try {
      writeResult = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, nextOverride);
    } catch {
      // Best-effort: model override persistence is non-blocking. `writeResult`
      // stays undefined so a failed write records no baseline.
    }
    // Record a baseline only on the first successful creation (or a
    // remove-then-recreate), never while editing an existing unacknowledged
    // override.
    if (
      writeResult?.changed === true &&
      nextOverride !== undefined &&
      !isMeaningfulPrimaryOverride(existingOverride)
    ) {
      recordOverrideBaseline(selection, primary, model.provider);
    }
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
          try {
            const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, undefined);
            await applyPrimaryModeChange(ctx);
            const backupLabel = result.backupPath
              ? ` Backup: ${formatHomePath(result.backupPath)}.`
              : "";
            ctx.ui.notify(
              `${result.changed ? "Cleared" : "No override to clear for"} model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`,
              "info",
            );
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
    const sessionStartOperation = projectAgentLifecycle.beginSessionStart();
    noticed.clear();
    // Session-only model intent does not cross session_start. This includes
    // /reload: a replacement runtime cannot safely prove that an older
    // process-global call belongs to the new session.
    beginModelSelectionSession(ctx);
    updateSessionOnlyModel(undefined);
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    clearSessionThinkingOverride();
    // Treat session_start as a fresh notification scope even if the host did
    // not deliver the prior session_shutdown event.
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    noticed.clear();
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    activateTlhTicketSessionScope(ctx.cwd);
    await projectAgentLifecycle.loadSessionResources(ctx, sessionStartOperation);
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    syncPrimaryAgentState(ctx);
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    await applyPrimaryDefaults(ctx, {
      warnOnMissing: false,
      sessionStartOperation,
    });
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
  }

  function registerLifecycleHooks(): void {
    pi.on("thinking_level_select", (event, ctx) => {
      // The upstream event has no source field. The async-local guard covers
      // TLH's own default/capability setters. A model change is also
      // distinguishable from native thinking cycling because the live model
      // differs from the last lifecycle observation; it may clamp an existing
      // retained level, but must not create new user thinking intent.
      const modelChanged =
        lastObservedModel !== undefined &&
        ctx.model !== undefined &&
        !modelsMatch(lastObservedModel, ctx.model);
      const internalChange =
        tlhApplyingModel || tlhApplyingThinking || tlhInternalChange.getStore() === true;
      if (!internalChange) {
        if (modelChanged) {
          const selection = currentPrimaryAgentSelection();
          if (activePrimaryAgent()) {
            updateRetainedThinkingForModel(selection, ctx.model);
          }
        } else {
          recordUserThinkingLevel(event.level);
        }
      }
      lastObservedModel = ctx.model;
    });

    pi.on("model_select", async (event, ctx) => {
      // Read the explicit persistence provenance carried by Pi's awaited
      // AgentSession.setModel dispatch before updating the observed model. An
      // Enter/session selection has persist:false and therefore cannot write a
      // TLH primary override.
      const persistedClaim = modelSelectionSession
        ? claimTlhModelSelectionDefaults(modelSelectionSession, event.model, event.previousModel)
        : undefined;
      lastObservedModel = event.model;
      updateModelSelectionContext(ctx);

      // TLH's own primary-agent application is not a user choice. Its model
      // event must not create a session-only gate or a primary override.
      if (tlhApplyingModel) {
        updateSessionOnlyModel(undefined);
        return;
      }

      if (event.source === "set") {
        if (isTlhPersistedModelSelection(persistedClaim)) {
          handlePersistedModelSelection(ctx, event.model);
        } else {
          // Pi 0.84.4's native Enter action changes only this session. Keep
          // active-primary reapplication from replacing that model on later
          // turns, without touching profile defaults or primary overrides.
          updateSessionOnlyModel(event.model);
        }
        return;
      }

      // Cycling and restore/future sources retain their upstream session
      // semantics and are never interpreted as an explicit default save.
      updateSessionOnlyModel(undefined);
      return;
    });

    pi.on("session_tree", async (_event, ctx) => {
      updateModelSelectionContext(ctx);
      syncPrimaryAgentState(ctx);
      await applyPrimaryDefaults(ctx);
    });

    pi.on("turn_end", (_event, ctx) => {
      const authStore = getProviderAuthHealthStore?.();
      if (!authStore) return;

      // Flush notification intents recorded by the async-complete handler.
      //
      // Flushed unconditionally and BEFORE the clearing probe loop:
      //  - Unconditional: a pending intent is evidence from a real rejected run.
      //    A local probe that returned healthy does not disprove the rejection
      //    (revoked-but-unexpired). Letting the probe's weaker signal suppress
      //    the stronger run-level evidence would silently lose the one case this
      //    feature exists to catch.
      //  - Before clearing probes: the clearing probe is fire-and-forget (async)
      //    and cannot update the store during this synchronous section; no race
      //    exists between the flush and the probes scheduled below.
      //
      // Uses the run-level descriptive message (not the imperative probe-confirmed
      // message) because the local credential state may differ from what the remote
      // server observed at run time.
      for (const provider of pendingReauthNotifications) {
        // Delete the intent only when the notification succeeds (or was already
        // sent via another path). If notify throws, keep the intent so the next
        // turn_end can retry rather than silently discarding the evidence.
        const notified = emitReauthNotificationIfNew(
          provider,
          ctx,
          `A subagent run was rejected by ${provider} for credentials. ` +
            `Opposite-provider independence for code-reviewer, oracle, and contrarian ` +
            `was affected for that run. Run /login if this recurs.`,
        );
        if (notified) {
          pendingReauthNotifications.delete(provider);
        }
      }

      // Clearing pass: re-probe any provider currently flagged non-healthy so
      // the footer warning clears automatically once the user re-authenticates.
      // Subject to the same per-provider backoff as dispatch-time preflights.
      const currentNow = nowFn();
      for (const provider of authStore.getNonHealthyProviders()) {
        if (shouldPreflightForClearing(provider, authStore, currentNow)) {
          scheduleProviderPreflight(provider, authStore, ctx.modelRegistry, currentNow, ctx);
        }
      }
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
      // Applied-default notices are session-scoped; clear them before the
      // asynchronous resource cleanup so a stale shutdown cannot retain them.
      noticed.clear();
      await projectAgentLifecycle.shutdown(() => {
        // Keep the facade continuation inside the lifecycle owner's final
        // currentness guard. This callback runs synchronously when shutdown
        // has no reference cleanup to await, preserving the original order.
        endModelSelectionSession();
        lastObservedModel = undefined;
        updateSessionOnlyModel(undefined);
        clearSessionThinkingOverride();
        restorePrimaryToolsIfAppropriate();
        // Clear session-scoped auth-notification state so that a new session
        // (which reuses this closure, because registerTlhPrimaryAgentRuntime runs
        // once per process) starts clean:
        //  • notifiedForReauth: a provider notified in the old session must be
        //    able to notify again in the new one.
        //  • pendingReauthNotifications: a stale intent from the old session must
        //    not fire a notification in the next session's turn_end.
        //  • preflightThrottle: inherited backoff can delay the new session's
        //    first probe by up to 300 s — the same class of bug as the above two.
        notifiedForReauth.clear();
        pendingReauthNotifications.clear();
        preflightThrottle.clear();
      });
    });

    pi.on("before_agent_start", async (event, ctx) => {
      updateModelSelectionContext(ctx);
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
      const projectDefaults = activeProjectDefaultsForCwd(ctx.cwd);
      const subagentProjectDefaults = projectDefaults?.subagents;
      applyProviderAwareModelsToNonProjectTargets(
        event.input,
        subagentsByName,
        getUnfilteredAvailableModels(ctx.modelRegistry),
        ctx.model?.provider,
        ctx.model,
        {
          agentOverrides: subagentOverrides,
          projectDefaults: subagentProjectDefaults,
          onWarning: ({ agent, message, source }) => {
            if (source === "project-default") {
              warnProjectDefaultsOnce(ctx, projectDefaults?.projectRoot, agent, message);
              return;
            }
            warnOnce(ctx, `subagent-override-warning-${agent}-${message}`, message);
          },
        },
      );
      syncPrimaryAgentState(ctx);
      const selection = currentPrimaryAgentSelection();
      const allowedSubagents = allowedSubagentsForExperimentalConfig();
      const retainedProjectAction = await retainedProjectActionLookup(event.input);
      const retainedProjectTargets = retainedProjectAction.targetNames;
      const projectControlRequest =
        isSubagentResumeAction(event.input) || isSubagentSteerAction(event.input);
      let persistedProjectMarker = false;
      if (projectControlRequest && retainedProjectAction.status === "missing") {
        try {
          const probe = await probeTlhProjectAgentRunMarker(event.input);
          persistedProjectMarker = isRecord(probe) && probe.status === "present";
        } catch {
          // A failed deny-only probe cannot create authority. The executor
          // independently rejects marker-bearing targets before discovery.
        }
      }
      // Lookup and deny-only marker probing can yield to a reload or shutdown.
      // Read the live owner only after those awaits so every authorization gate
      // uses the generation that is current at decision time.
      const activeProjectAgentSnapshot = projectAgentLifecycle.activeProjectAgentSnapshot();
      const projectTargets = projectSnapshotTargets(event.input, activeProjectAgentSnapshot);
      const projectControlAction =
        projectControlRequest &&
        (retainedProjectAction.status !== "missing" || persistedProjectMarker);
      const retainedProjectLabel = retainedProjectTargets.length
        ? retainedProjectTargets.join(", ")
        : persistedProjectMarker
          ? "persisted project-agent marker"
          : "retained project-agent run";
      if (
        persistedProjectMarker &&
        (!isSubagentResumeAction(event.input) || !activeProjectAgentSnapshot?.rebindProjectAgent)
      ) {
        return {
          block: true,
          reason: `TLH project-agent control is unavailable because the process-private run reference is missing for ${retainedProjectLabel}; refusing profile fallback.`,
        };
      }
      if (!isEnabledPrimaryAgentSelection(selection)) {
        if (projectControlAction) {
          return {
            block: true,
            reason: `TLH project-agent ${String(event.input.action)} requires the architect primary agent. Target(s): ${retainedProjectLabel}.`,
          };
        }
        // Disabled mode retains the TLH safety plane and may initiate an
        // explicitly requested project-agent execution. Retained project
        // controls remain architect-only and are handled above.
      }
      if (selection === "rush" && isSubagentResumeAction(event.input)) {
        return { block: true, reason: rushResumeDelegationReason() };
      }
      if (selection === "rush" && isSubagentSteerAction(event.input)) {
        return { block: true, reason: rushSteerDelegationReason() };
      }
      if (projectControlAction && selection !== "architect") {
        return {
          block: true,
          reason: `TLH ${selection} may not control a project-agent run; resume/steer is reserved for the architect primary agent. Target(s): ${retainedProjectLabel}.`,
        };
      }
      if (selection === "rush" && subagentCallTargetsAgent(event.input, "developer")) {
        return { block: true, reason: rushDeveloperDelegationReason() };
      }
      const embeddedBlockReason = embeddedDelegationBlockedReason(selection, event.input);
      if (embeddedBlockReason) {
        return { block: true, reason: embeddedBlockReason };
      }
      const allowEmbeddedTargets =
        selection === "architect" || selection === DISABLED_PRIMARY_AGENT;
      const reason = validateSubagentToolInput(event.input, {
        allowedSubagents,
        allowEmbeddedTargets,
      });
      if (reason) {
        return { block: true, reason };
      }
      if (allowEmbeddedTargets && !isOpaqueSubagentManagementActionInput(event.input)) {
        if (projectTargets.length > 0) {
          const snapshotReason = activeProjectSnapshotIdentityReason(
            event.input,
            ctx,
            projectTargets,
            activeProjectAgentSnapshot,
          );
          if (snapshotReason) {
            return { block: true, reason: snapshotReason };
          }
        }

        const projectTargetSet = new Set(projectTargets);
        const requestedProfileTargets = collectSubagentCallTargetsMatching(
          event.input,
          (target) => isEmbeddedSubagentTarget(target) && !projectTargetSet.has(target),
        );
        if (requestedProfileTargets.length > 0) {
          const authorizationSubject =
            selection === DISABLED_PRIMARY_AGENT
              ? "TLH primary-agent infrastructure"
              : "TLH architect";
          return {
            block: true,
            reason: `${authorizationSubject} may delegate to embedded.<slug> only when a valid package: embedded / name: <slug> markdown definition exists at the validated Git-root path .tlh/agents/custom/<UPPERCASE-SLUG>.md. Persist project trust with /trust, then retry. Unauthorized target(s): ${requestedProfileTargets.join(", ")}.`,
          };
        }
      }

      // OpenRouter is the one provider-specific project-agent exception: an
      // omitted model follows the live session model. All other providers
      // leave the captured frontmatter model untouched, and explicit caller
      // models remain authoritative on every provider.
      applyOpenRouterModelToProjectTargets(event.input, projectTargets, ctx.model);

      // Credential preflight — fire-and-forget, never blocks or delays dispatch.
      //
      // Called AFTER all block/authorization checks so we only preflight calls
      // that will actually run. On a confirmed hard failure the model selection
      // is deliberately left unchanged (warn, do not reroute — v1 deliberate decision).
      //
      // getProviderAuth in the pinned runtime can mutate auth.json and hold the
      // auth-file lock while rotating a near-expiry OAuth credential; this is
      // intentional and documented in the store (see provider-auth-health.ts).
      const authStore = getProviderAuthHealthStore?.();
      if (authStore) {
        const currentNow = nowFn();
        const providers = extractDispatchProviders(event.input);
        for (const provider of providers) {
          if (shouldPreflightAtDispatch(provider, authStore, currentNow)) {
            scheduleProviderPreflight(provider, authStore, ctx.modelRegistry, currentNow, ctx);
          }
        }
      }

      return undefined;
    });

    // Result-time auth-health observation — foreground path.
    //
    // Read modelAttempts from the completed result, NOT the top-level error.
    // On a successful fallback the final result carries no auth error at all;
    // the failing attempt's error lives in details.results[*].modelAttempts[*].error.
    // Parsing is from unknown per the TypeScript boundaries skill.
    pi.on("tool_result", (_event, _ctx) => {
      const event = _event as { toolName?: string; details?: unknown };
      if (event.toolName !== "subagent") return;
      const authStore = getProviderAuthHealthStore?.();
      if (!authStore) return;
      const prevReauthProviders = new Set(authStore.getReauthProviders());
      processSubagentRunDetails(event.details, authStore);
      // Notify for any provider that newly entered reauth-required via run-level observation.
      // Uses the descriptive message: the local probe cannot confirm the current state,
      // so the imperative "requires re-authentication now" would be misleading.
      for (const provider of authStore.getReauthProviders()) {
        if (!prevReauthProviders.has(provider)) {
          emitReauthNotificationIfNew(
            provider,
            _ctx,
            `A subagent run was rejected by ${provider} for credentials. ` +
              `Opposite-provider independence for code-reviewer, oracle, and contrarian ` +
              `was affected for that run. Run /login if this recurs.`,
          );
        }
      }
    });

    // Result-time auth-health observation — async path.
    //
    // An async launch's immediate tool_result deliberately carries results: [] so
    // tool_result alone can never observe an async run's fallback. Subscribe
    // read-only to subagent:async-complete (result-watcher.ts:299-319), whose
    // artifact carries the full attempt history.
    //
    // Uses pi.events as an EventBus (duck-typed for test compatibility).
    if (typeof pi.events?.on === "function") {
      void pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: unknown) => {
        const authStore = getProviderAuthHealthStore?.();
        if (!authStore) return;
        const prevReauthProviders = new Set(authStore.getReauthProviders());
        processSubagentRunDetails(data, authStore);
        // We have no ctx here, so we cannot notify immediately. Record intent
        // for any provider that newly entered reauth-required; the next
        // turn_end will flush it before any clearing probe can reset the status.
        for (const provider of authStore.getReauthProviders()) {
          if (!prevReauthProviders.has(provider)) {
            pendingReauthNotifications.add(provider);
          }
        }
      });
    }
  }

  return {
    applySessionStart,
    projectAgentGuidanceSnapshot: () => projectAgentLifecycle.projectAgentGuidanceSnapshot(),
    currentPrimaryAgentLabel,
    activePrimaryAgentPrompt: activePrimaryAgent,
    recordUserThinkingLevel,
    buildLaunchSystemPrompt,
    resetPrimaryAgentModelOverride,
    registerCommands,
    registerLifecycleHooks,
  };
}

export {
  clearPrimaryAgentModelOverrideByName,
  extractDispatchProviders,
  isHighConfidenceAuthSignatureInAttemptError,
  processSubagentRunDetails,
};

export function registerTlhPrimaryAgentRuntime(
  pi: ExtensionAPI,
  options: TlhPrimaryAgentRuntimeOptions = {},
): TlhPrimaryAgentRuntime | undefined {
  // Extension reloads and child-process test harnesses can construct a new
  // runtime before the prior closure receives shutdown. Retire its access
  // bridge and active-generation reference immediately so no stale generation
  // can reach the new executor while run references remain protected.
  retireTlhPrimaryAgentResourceRuntime();
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

  const runtime = createTlhPrimaryAgentRuntime(
    pi,
    options.primaryAgents ?? loadPrimaryAgents(),
    options.subagentMetadata ?? loadSubagentMetadata(),
    {
      getProviderAuthHealthStore: options.getProviderAuthHealthStore,
      projectAgentLoader: options.projectAgentLoader,
      projectDefaultsLoader: options.projectDefaultsLoader,
      now: options.now,
    },
  );
  runtime.registerCommands();
  runtime.registerLifecycleHooks();
  // Register the process-wide compatibility shim only after this runtime has
  // completed all command and lifecycle registration. A failed registration
  // therefore cannot leave a setter wrapper behind for a later runtime. A
  // safe isolated profile must fail closed if the pinned bundled constructor
  // cannot be covered; the extension loader will then roll back these pending
  // registrations as one factory transaction.
  if (
    !installTlhModelSelectionPersistenceOverride(options.bundledAgentSessionConstructor) &&
    tlhSettingsPathForWrite()
  ) {
    throw new Error(
      "[TLH] Could not install the Pi AgentSession.setModel persistence seam for the isolated profile.",
    );
  }
  return runtime;
}
