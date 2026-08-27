import { AsyncLocalStorage } from "node:async_hooks";
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
  THINKING_LEVELS,
  TLH_NAME,
  TLH_PACKAGE_NAME,
} from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import {
  applyProviderAwareSubagentModels,
  followsOpenrouterSession,
  formatProviderModelReference,
  listAgentModelDefaultReferences,
  parseProviderModelReference,
  resolveProviderThinking,
  selectProviderAwareAgentDefaults,
} from "./model-defaults.js";
import type { ProviderAuthHealthStore } from "./provider-auth-health.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import {
  beginTlhModelSelectionDefaultSuppression,
  beginTlhThinkingDefaultSuppression,
  chooseTlhModelSelectionScope,
  claimTlhModelSelectionDefaults,
  discardTlhModelSelectionDefaults,
  getTlhThinkingChangeContext,
  installTlhModelSelectionPersistenceOverride,
  isTlhNativeModelSelectorClaim,
  persistTlhModelSelectionDefaults,
  persistTlhStandaloneThinkingDefaults,
  replayAllTlhUnclaimedModelSelectionDefaults,
  replayTlhUnmatchedModelSelectionDefaults,
  runTlhThinkingChangeContext,
  setTlhModelSelectionActiveModelResolver,
  setTlhSessionOnlyModel,
} from "./model-selection-scope.js";
import {
  getAvailableThinkingLevels,
  isThinkingLevel,
  setExtensionThinkingLevel,
  thinkingLevelAtLeast,
} from "./thinking.js";
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
  ReasoningModel,
  SubagentMetadata,
  ThinkingLevel,
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
};

type ActiveModel = NonNullable<ExtensionContext["model"]>;

type SessionThinkingOverride = {
  primary: TlhPrimaryAgentSelection;
  level: ThinkingLevel;
};

export type TlhPrimaryAgentRuntime = {
  applySessionStart(ctx: ExtensionContext): Promise<void>;
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

function getTlhDurableThinkingLevel(cwd: string): ThinkingLevel | undefined {
  const level = getTlhGlobalSettings(cwd).defaultThinkingLevel;
  return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
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

// ---------------------------------------------------------------------------
// Result-time auth-health observation (issue #523)
// ---------------------------------------------------------------------------

// Keep in sync with extensions/subagents/src/shared/types.ts:SUBAGENT_ASYNC_COMPLETE_EVENT.
// Do NOT import from that package — it carries its own upstream provenance.
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/**
 * Return true when an error string from a failed ModelAttempt carries a
 * high-confidence runtime auth rejection signature.
 *
 * Matches only these three high-confidence auth-rejection patterns:
 *   - invalid_grant (OAuth token revoked / expired grant)
 *   - token-refresh unauthorized / token refresh unauthorized
 *     (pi-ai/dist/auth/oauth/kimi-coding.js:222-224 pattern)
 *   - provider 401 / 403 embedded in the error message
 *
 * Conservative by design: rate-limit (429), server errors (5xx), network, and
 * credential-store errors must NOT match here — those are transient, not
 * historical auth facts.
 */
export function isHighConfidenceAuthSignatureInAttemptError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("invalid_grant") ||
    lower.includes("token-refresh unauthorized") ||
    lower.includes("token refresh unauthorized") ||
    lower.includes("status 401") ||
    lower.includes("status 403") ||
    lower.includes("(status 401)") ||
    lower.includes("(status 403)") ||
    lower.includes("http 401") ||
    lower.includes("http 403")
  );
}

/**
 * Walk the Details payload from a subagent tool result (or async-complete artifact)
 * and record run-level auth observations for any failed ModelAttempt that carries
 * a high-confidence auth rejection signature.
 *
 * Parses from `unknown` per the TypeScript boundaries skill — this crosses the
 * extensions/subagents open-object boundary (types.ts:650-690). Every field access
 * is guarded; malformed payloads are silently skipped.
 *
 * Associates each failed attempt with the provider parsed from THAT attempt's model
 * id (not the run's final model), so a successful fallback where the run ends on a
 * different provider is correctly attributed.
 */
export function processSubagentRunDetails(
  details: unknown,
  authStore: ProviderAuthHealthStore,
): void {
  if (!isRecord(details)) return;
  const { results } = details;
  if (!Array.isArray(results)) return;

  for (const result of results) {
    if (!isRecord(result)) continue;
    const { modelAttempts } = result;
    if (!Array.isArray(modelAttempts)) {
      continue;
    }

    for (const attempt of modelAttempts) {
      if (!isRecord(attempt)) continue;
      const { model, success, error } = attempt;
      // Validate required fields per the TypeScript boundaries skill.
      if (typeof model !== "string" || typeof success !== "boolean") continue;
      // Only failed attempts carry auth errors worth recording.
      if (success === true) continue;
      if (typeof error !== "string" || error.length === 0) continue;

      // Attribute the failure to the provider from THIS attempt's model id,
      // not the run's final model. On a successful fallback the final result
      // carries no auth error, so attributing from the run level would miss it.
      const parsed = parseProviderModelReference(model);
      if (!parsed?.provider) continue;

      if (isHighConfidenceAuthSignatureInAttemptError(error)) {
        authStore.recordRunLevelAuthObservation(parsed.provider);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch-time credential preflight (issue #523)
// ---------------------------------------------------------------------------

/**
 * Backoff intervals for per-provider credential preflight throttle.
 * After the Nth consecutive failure, wait at least this long before re-probing.
 *
 * Chosen intervals: 60 s (1st failure), 120 s (2nd), 300 s (3rd+).
 * Reset to zero on a successful probe.
 */
function dispatchPreflightBackoffMs(failures: number): number {
  if (failures <= 1) return 60_000;
  if (failures === 2) return 120_000;
  return 300_000;
}

/**
 * Extract the unique provider strings from a subagent tool-call input after
 * applyProviderAwareSubagentModels has mutated it.
 *
 * Reads `input.model` (single dispatch) and `input.tasks[].model` (parallel
 * dispatch). Non-string and unparseable model values are silently skipped so
 * a malformed input never prevents the tool call from proceeding.
 */
export function extractDispatchProviders(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const obj = input as Record<string, unknown>;
  const seen = new Set<string>();

  function addModel(model: unknown): void {
    if (typeof model !== "string") return;
    const parsed = parseProviderModelReference(model);
    if (parsed?.provider) seen.add(parsed.provider);
  }

  addModel(obj["model"]);

  if (Array.isArray(obj["tasks"])) {
    for (const task of obj["tasks"]) {
      if (typeof task === "object" && task !== null) {
        addModel((task as Record<string, unknown>)["model"]);
      }
    }
  }

  return [...seen];
}

function createTlhPrimaryAgentRuntime(
  pi: ExtensionAPI,
  primaryAgents: Map<TlhPrimaryAgentSelection, AgentPrompt>,
  subagentMetadata: SubagentMetadata[],
  runtimeOptions: {
    getProviderAuthHealthStore?: () => ProviderAuthHealthStore | undefined;
    now?: () => number;
  } = {},
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
  const { getProviderAuthHealthStore, now: nowFn = Date.now } = runtimeOptions;
  const warned = new Set<string>();
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
      buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled),
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
  let tlhApplyingThinking = false;
  let tlhRestoringCancelledModel = false;
  const tlhInternalChange = new AsyncLocalStorage<boolean>();
  let lastObservedModel: ActiveModel | undefined;
  let sessionOnlyModel: ActiveModel | undefined;
  let sessionThinkingOverride: SessionThinkingOverride | undefined;

  function updateSessionOnlyModel(model: ActiveModel | undefined): void {
    sessionOnlyModel = model;
    setTlhSessionOnlyModel(model);
  }

  function modelsMatch(left: ActiveModel | undefined, right: ActiveModel | undefined): boolean {
    return left?.provider === right?.provider && left?.id === right?.id;
  }

  function clearSessionThinkingOverride(): void {
    sessionThinkingOverride = undefined;
  }

  function setTlhThinkingLevel(level: ThinkingLevel): void {
    // `thinking_level_select` is emitted synchronously as the upstream setter
    // starts its async extension dispatch. Keep this guard active for that
    // dispatch so TLH's own lifecycle/default work is never recorded as a user
    // selection.
    const releaseThinkingSuppression = beginTlhThinkingDefaultSuppression();
    tlhApplyingThinking = true;
    try {
      tlhInternalChange.run(true, () =>
        runTlhThinkingChangeContext("internal", () => setExtensionThinkingLevel(pi, level)),
      );
    } finally {
      releaseThinkingSuppression();
      tlhApplyingThinking = false;
    }
  }

  function recordUserThinkingLevel(level: ThinkingLevel): void {
    const selection = currentPrimaryAgentSelection();
    const primary = activePrimaryAgent();
    if (
      !isThinkingLevel(level) ||
      !isEnabledPrimaryAgentSelection(selection) ||
      !primary ||
      primary.lockThinking === true
    ) {
      return;
    }
    const retainedLevel =
      primary.minThinking !== undefined && !thinkingLevelAtLeast(level, primary.minThinking)
        ? primary.minThinking
        : level;
    sessionThinkingOverride = { primary: selection, level: retainedLevel };
  }

  function clampThinkingLevelForPrimary(
    level: ThinkingLevel,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
  ): ThinkingLevel {
    // Model metadata can be absent in older/direct contexts. In that case only
    // apply a primary floor; do not guess at provider capabilities.
    let availableLevels =
      model && "reasoning" in model
        ? getAvailableThinkingLevels(model as ReasoningModel)
        : [...THINKING_LEVELS];
    const minThinking = primary.minThinking;
    if (minThinking !== undefined) {
      availableLevels = availableLevels.filter((candidate) =>
        thinkingLevelAtLeast(candidate, minThinking),
      );
    }
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
    // A non-reasoning model exposes no level meeting Architect's floor. `off`
    // is the only safe fallback instead of replaying a reasoning-only target.
    return availableLevels[0] ?? "off";
  }

  function updateRetainedThinkingForModel(
    selection: TlhPrimaryAgentSelection,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
  ): void {
    const override = sessionThinkingOverride;
    if (!override || override.primary !== selection || primary.lockThinking === true) {
      return;
    }
    override.level = clampThinkingLevelForPrimary(override.level, primary, model);
  }

  function sessionThinkingLevelForPrimary(
    selection: TlhPrimaryAgentSelection,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
  ): ThinkingLevel | undefined {
    const override = sessionThinkingOverride;
    if (!override || override.primary !== selection || primary.lockThinking === true) {
      return undefined;
    }
    const clamped = clampThinkingLevelForPrimary(override.level, primary, model);
    // A model switch can make a retained level unavailable. Keep the clamped
    // value as the session intent so later lifecycle reapplication is stable
    // and does not jump back to the packaged role default.
    override.level = clamped;
    return clamped;
  }

  async function applyPrimaryModel(
    ctx: ExtensionContext,
    primary: AgentPrompt,
    model: ActiveModel | undefined,
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
    const releaseThinkingSuppression = beginTlhThinkingDefaultSuppression();
    tlhApplyingModel = true;
    let success: boolean;
    try {
      success = await tlhInternalChange.run(true, () =>
        runTlhThinkingChangeContext("internal", () => pi.setModel(model)),
      );
    } finally {
      releaseThinkingSuppression();
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

  function applyPrimaryThinking(
    cwd: string,
    selection: TlhPrimaryAgentSelection,
    primary: AgentPrompt,
    thinking: AgentPrompt["thinking"],
    model: ActiveModel | undefined,
  ): void {
    const sessionThinking = sessionThinkingLevelForPrimary(selection, primary, model);
    const durableThinking = getTlhDurableThinkingLevel(cwd);
    const requestedThinking = sessionThinking ?? durableThinking ?? thinking;
    if (requestedThinking === undefined) {
      return;
    }
    const hasExplicitThinking = sessionThinking !== undefined || durableThinking !== undefined;
    const targetThinking = clampThinkingLevelForPrimary(requestedThinking, primary, model);
    const currentThinking = pi.getThinkingLevel();
    if (
      currentThinking === targetThinking ||
      (!hasExplicitThinking && currentThinkingSatisfiesPrimaryFloor(primary, currentThinking))
    ) {
      return;
    }
    setTlhThinkingLevel(targetThinking);
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
      const restored = await tlhInternalChange.run(true, () =>
        runTlhThinkingChangeContext("internal", () => pi.setModel(previousModel)),
      );
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
    lastObservedModel = ctx.model;
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
      ctx.model,
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
      // Fixed primaries remain unconditional, and an out-of-band model change
      // must not leave the session-only gate stuck on another model.
      updateSessionOnlyModel(undefined);
    }
    const activePrimaryModel =
      shouldApplyModel && !preservesSessionOnlyModel
        ? await applyPrimaryModel(ctx, primary, resolvedModel)
        : undefined;
    if (shouldApplyThinking) {
      // Thinking follows the model that is actually effective after stored pins
      // and model-application decisions, rather than the pre-pin selection.
      const effectiveModel = activePrimaryModel ?? ctx.model;
      applyPrimaryThinking(
        ctx.cwd,
        selection,
        primary,
        resolveProviderThinking(primary, effectiveModel?.provider),
        effectiveModel,
      );
    }
    lastObservedModel = activePrimaryModel ?? ctx.model;
  }

  async function applyPrimaryModeChange(ctx: ExtensionContext): Promise<void> {
    // A primary-mode change is an explicit request to reapply that mode's
    // defaults, so it ends any model choice scoped to the prior mode/session.
    await persistTlhStandaloneThinkingDefaults();
    replayTlhUnmatchedModelSelectionDefaults();
    updateSessionOnlyModel(undefined);
    clearSessionThinkingOverride();
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
    await persistTlhStandaloneThinkingDefaults();
    replayAllTlhUnclaimedModelSelectionDefaults();
    setTlhModelSelectionActiveModelResolver(() => ctx.model);
    updateSessionOnlyModel(undefined);
    clearSessionThinkingOverride();
    activateTlhTicketSessionScope(ctx.cwd);
    syncPrimaryAgentState(ctx);
    await applyPrimaryDefaults(ctx, { warnOnMissing: false });
  }

  function registerLifecycleHooks(): void {
    pi.on("thinking_level_select", async (event, ctx) => {
      // Native model-selector thinking writes stay attached to the pending
      // model claim. Independent /effort and thinking-cycle writes are drained
      // and restored through the retained upstream setter here.
      //
      // The upstream event has no source field. The synchronous/async-local
      // guard covers TLH's own default/capability setters. A model change is
      // also distinguishable from native thinking cycling because the live
      // model differs from the last lifecycle observation; it may clamp an
      // existing retained level, but must not create new user thinking intent.
      const modelChanged =
        lastObservedModel !== undefined &&
        ctx.model !== undefined &&
        !modelsMatch(lastObservedModel, ctx.model);
      const thinkingChangeContext = getTlhThinkingChangeContext();
      const internalChange =
        tlhApplyingModel ||
        tlhApplyingThinking ||
        tlhInternalChange.getStore() === true ||
        thinkingChangeContext === "internal";
      const interactiveChange = thinkingChangeContext === "interactive";
      if (!internalChange && !interactiveChange) {
        if (modelChanged) {
          const selection = currentPrimaryAgentSelection();
          const primary = activePrimaryAgent();
          if (primary) {
            updateRetainedThinkingForModel(selection, primary, ctx.model);
          }
        } else {
          recordUserThinkingLevel(event.level);
        }
      }
      lastObservedModel = ctx.model;
      await persistTlhStandaloneThinkingDefaults();
    });

    pi.on("model_select", async (event, ctx) => {
      lastObservedModel = event.model;
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
      // Fixed primaries keep their provider defaults and do not persist user model overrides.
      if (shouldForceApplyForLock(primary)) {
        return;
      }
      const chosenKey = `${event.model.provider}/${event.model.id}`;
      // OpenRouter's non-opposite primary default intentionally follows the active
      // session model, so it is not a packaged default that should clear an override.
      const primaryDefaults = selectProviderAwareAgentDefaults(
        primary,
        getUnfilteredAvailableModels(ctx.modelRegistry),
        event.model.provider,
        event.model,
      );
      const bundledKey =
        !followsOpenrouterSession(primary, event.model.provider) && primaryDefaults.model
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
      await persistTlhStandaloneThinkingDefaults();
      replayTlhUnmatchedModelSelectionDefaults();
      setTlhModelSelectionActiveModelResolver(() => ctx.model);
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
      replayAllTlhUnclaimedModelSelectionDefaults();
      setTlhModelSelectionActiveModelResolver(undefined);
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

    pi.on("before_agent_start", async (event, ctx) => {
      await persistTlhStandaloneThinkingDefaults();
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
      const allowedSubagents = allowedSubagentsForExperimentalConfig();
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
      const embeddedBlockReason = embeddedDelegationBlockedReason(selection, event.input);
      if (embeddedBlockReason) {
        return { block: true, reason: embeddedBlockReason };
      }
      const allowEmbeddedTargets = selection === "architect";
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
    currentPrimaryAgentLabel,
    activePrimaryAgentPrompt: activePrimaryAgent,
    recordUserThinkingLevel,
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
    {
      getProviderAuthHealthStore: options.getProviderAuthHealthStore,
      now: options.now,
    },
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
function isTlhPrimaryAgentSelection(value: string): value is TlhPrimaryAgentSelection {
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
