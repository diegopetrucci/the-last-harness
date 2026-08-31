import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIDialogOptions,
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
  loadProjectAgentSnapshot,
  reauthorizeTlhProjectAgentTrust,
} from "./project-agent-loader-bridge.mjs";
import { loadProjectDefaults } from "./project-defaults-loader-bridge.mjs";
import {
  lookupTlhProjectAgentRunReference,
  probeTlhProjectAgentRunMarker,
  setTlhProjectAgentAccessProvider,
} from "./project-agent-access.mjs";
import {
  releaseTlhProjectAgentRunReferencesForSession,
  releaseTlhProjectAgentSnapshotReference,
  retainTlhProjectAgentSnapshotReference,
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
import {
  inventoryProjectAgentGuidance,
  type ProjectAgentGuidanceInventory,
} from "../shared/project-agent-guidance.js";
import {
  buildChildSubagentSystemPrompt,
  buildTlhSystemPrompt,
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

type ProjectAgentCapability = Record<string, unknown>;
/** Role names accepted by the project-defaults runtime boundary. */
type ProjectPrimaryAgentName = Exclude<TlhPrimaryAgentSelection, "disabled">;
type ProjectSubagentRoleName =
  | "code-reviewer"
  | "contrarian"
  | "developer"
  | "test-runner"
  | "diff-summarizer"
  | "librarian"
  | "oracle"
  | "repo-scout"
  | "web-scout";

const PROJECT_PRIMARY_AGENT_NAMES: ReadonlySet<string> = new Set([
  "architect",
  "rush",
  "product",
  "bug-hunter",
]);
const PROJECT_SUBAGENT_ROLE_NAMES: ReadonlySet<string> = new Set([
  "code-reviewer",
  "contrarian",
  "developer",
  "test-runner",
  "diff-summarizer",
  "librarian",
  "oracle",
  "repo-scout",
  "web-scout",
]);

/** Keep these bounds aligned with the lazy project-defaults loader. */
const MAX_PROJECT_DEFAULT_WARNINGS = 20;
const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
/** Saturate overflow counts so hostile summaries stay finite and bounded. */
const MAX_PROJECT_DEFAULT_WARNING_COUNT = 1_000_000;
const PROJECT_DEFAULTS_WARNING_SUMMARY_PATTERN =
  /^…and ([1-9][0-9]*) more issues in \.tlh\/defaults\.json$/;

function truncateProjectDefaultsWarning(message: string): string {
  if (message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH) return message;
  return `${message.slice(0, MAX_PROJECT_DEFAULT_WARNING_LENGTH - 1)}…`;
}

function saturatingProjectDefaultsWarningCount(value: number): number {
  if (!Number.isFinite(value) || value >= MAX_PROJECT_DEFAULT_WARNING_COUNT) {
    return MAX_PROJECT_DEFAULT_WARNING_COUNT;
  }
  return value > 0 ? Math.floor(value) : 0;
}

function addProjectDefaultsWarningCounts(current: number, additional: number): number {
  const boundedCurrent = saturatingProjectDefaultsWarningCount(current);
  const boundedAdditional = saturatingProjectDefaultsWarningCount(additional);
  if (
    boundedCurrent >= MAX_PROJECT_DEFAULT_WARNING_COUNT - boundedAdditional ||
    boundedAdditional >= MAX_PROJECT_DEFAULT_WARNING_COUNT
  ) {
    return MAX_PROJECT_DEFAULT_WARNING_COUNT;
  }
  return boundedCurrent + boundedAdditional;
}

function projectDefaultsWarningSummaryCount(message: string): number | undefined {
  const match = PROJECT_DEFAULTS_WARNING_SUMMARY_PATTERN.exec(message);
  if (!match) return undefined;
  return saturatingProjectDefaultsWarningCount(Number(match[1]));
}

function projectDefaultsWarningRoot(projectRoot: string | undefined, cwd: string): string {
  return (
    canonicalExistingProjectRoot(projectRoot) ?? canonicalExistingProjectRoot(cwd) ?? resolve(cwd)
  );
}

function projectDefaultsWarningKey(
  projectRoot: string | undefined,
  cwd: string,
  agent: string | undefined,
  message: string,
  identityMessage = message,
): string {
  const digest = createHash("sha256")
    .update(projectDefaultsWarningRoot(projectRoot, cwd), "utf8")
    .update("\0", "utf8")
    .update(agent ?? "", "utf8")
    .update("\0", "utf8")
    .update(message, "utf8")
    .update("\0", "utf8")
    .update(identityMessage, "utf8")
    .digest("hex");
  return `project-default-warning-${digest}`;
}

function unavailableProjectModelWarningMessage(selection: string, modelReference: string): string {
  const prefix = `TLH project default model "`;
  const suffix = `" for ${selection} is not available; falling back to stored or bundled defaults.`;
  const maxModelLength = Math.max(
    0,
    MAX_PROJECT_DEFAULT_WARNING_LENGTH - prefix.length - suffix.length,
  );
  const boundedModel =
    modelReference.length <= maxModelLength
      ? modelReference
      : maxModelLength > 0
        ? `${modelReference.slice(0, maxModelLength - 1)}…`
        : "";
  return truncateProjectDefaultsWarning(`${prefix}${boundedModel}${suffix}`);
}

/**
 * Bound untrusted loader diagnostics independently from the lazy loader. Exact
 * duplicates do not consume visible warning slots; overflow is one summary.
 */
function normalizeProjectDefaultsWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const retained: string[] = [];
  const seen = new Set<string>();
  let omittedCount = 0;
  let loaderSummaryCount = 0;
  let hasLoaderSummary = false;
  for (const rawWarning of value) {
    if (typeof rawWarning !== "string" || rawWarning.length === 0) continue;
    // Parse a loader-produced summary before truncating it; otherwise a huge
    // decimal count could lose its suffix and evade saturation handling.
    const summaryCount = projectDefaultsWarningSummaryCount(rawWarning);
    if (summaryCount !== undefined) {
      if (!hasLoaderSummary) {
        hasLoaderSummary = true;
        loaderSummaryCount = summaryCount;
      }
      continue;
    }
    const warning = truncateProjectDefaultsWarning(rawWarning);
    if (seen.has(warning)) continue;
    if (retained.length < MAX_PROJECT_DEFAULT_WARNINGS) {
      retained.push(warning);
      seen.add(warning);
    } else {
      omittedCount = addProjectDefaultsWarningCounts(omittedCount, 1);
    }
  }

  const totalOmitted = addProjectDefaultsWarningCounts(loaderSummaryCount, omittedCount);
  if (totalOmitted > 0) {
    retained.push(
      truncateProjectDefaultsWarning(`…and ${totalOmitted} more issues in .tlh/defaults.json`),
    );
  }
  return retained;
}

/**
 * Normalized project defaults loaded from .tlh/defaults.json for this session.
 * This is a TLH-owned shape produced only after the lazy-import boundary is
 * narrowed by normalizeProjectDefaultsResult.
 */
interface ActiveProjectDefaultsEntry {
  readonly model?: string;
  readonly effort?: ThinkingLevel;
}

interface ActiveProjectDefaults {
  readonly status: "loaded" | "denied" | "unavailable";
  /** Canonical root that authorized the loaded defaults, when present. */
  readonly projectRoot: string | undefined;
  readonly primaryAgents: Readonly<
    Partial<Record<ProjectPrimaryAgentName, ActiveProjectDefaultsEntry>>
  >;
  readonly subagents: Readonly<
    Partial<Record<ProjectSubagentRoleName, ActiveProjectDefaultsEntry>>
  >;
  readonly warnings: readonly string[];
}

/**
 * Structural contract used by the injectable bridge. Callers still widen the
 * returned value to unknown before normalizeProjectDefaultsResult parses it.
 */
interface ProjectDefaultsLoaderResult {
  readonly status: string;
  readonly warnings?: readonly unknown[];
  readonly defaults?: Record<string, unknown>;
  readonly projectRoot?: string;
  readonly trust?: Record<string, unknown>;
}

type ProjectDefaultsLoader = (options: {
  cwd: string;
  sessionId?: string;
  agentDir?: string;
  defaultProjectTrust?: "ask" | "always" | "never";
  trust?: {
    sessionId?: string;
    trustOverride?: boolean;
    defaultProjectTrust?: "ask" | "always" | "never";
    createProjectTrustStore?: (agentDir: string) => object;
    hasTrustRequiringProjectResources?: (cwd: string) => boolean;
    isProjectTrusted?: () => boolean;
    hasUI?: boolean;
    trustUiTimeoutMs?: number;
    ui?: {
      confirm(
        title: string,
        message: string,
        options?: ExtensionUIDialogOptions,
      ): Promise<boolean> | boolean;
    };
  };
}) => Promise<ProjectDefaultsLoaderResult>;

interface ProjectAgentSnapshotLoadResult {
  status: string;
  capability?: ProjectAgentCapability;
  trust?: { kind: "project-agent"; trusted: boolean; source: string };
  provenance?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
}

type ProjectAgentTrustReauthorizer = () => Promise<boolean>;

type ProjectAgentRebindRequest = {
  projectRoot: string;
  cwd: string;
  sessionId: string;
  agent: string;
};

type ProjectAgentRebindResult = {
  capability: ProjectAgentCapability;
  expected: Record<string, unknown>;
  capture: {
    provenance: Record<string, unknown>;
    config: Record<string, unknown>;
  };
};

type ProjectAgentRebinder = (
  request: ProjectAgentRebindRequest,
) => Promise<ProjectAgentRebindResult | undefined>;

type ProjectAgentSnapshotLoader = (options: {
  cwd: string;
  sessionId: string;
  agentDir: string;
  trustDependencies: {
    createProjectTrustStore: (agentDir: string) => object;
  };
}) => Promise<ProjectAgentSnapshotLoadResult>;

interface ActiveProjectAgentSnapshot {
  capability: ProjectAgentCapability;
  provenance: {
    projectRoot: string;
    sessionId: string;
    generationId: string;
    processInstanceId: string;
  };
  entries: readonly { name: string; digest: string }[];
  tombstones: readonly string[];
  trust?: { trusted: boolean; source: string };
  reauthorizeTrust?: ProjectAgentTrustReauthorizer;
  rebindProjectAgent?: ProjectAgentRebinder;
}

interface ProjectAgentRuntimeGlobalState {
  referenceId?: string;
  sessionId?: string;
  epoch: number;
}

const PROJECT_AGENT_RUNTIME_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-runtime-state");
const PROJECT_AGENT_RUNTIME_GLOBAL = globalThis as typeof globalThis & {
  [PROJECT_AGENT_RUNTIME_GLOBAL_KEY]?: ProjectAgentRuntimeGlobalState;
};
const PROJECT_AGENT_RUNTIME_STATE =
  PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] ??
  (PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] = { epoch: 0 });

const PROJECT_AGENT_TRUST_DEPENDENCIES = {
  createProjectTrustStore: (agentDir: string) => new ProjectTrustStore(agentDir),
};

const PERSISTED_PROJECT_AGENT_TRUST_DENIAL_SOURCES = new Set([
  "saved-negative",
  "no-persisted-trust",
  "trust-path-mismatch",
  "trust-store-error",
]);

const PROJECT_CONFIG_TRUST_POSITIVE_SOURCES = new Set([
  "saved-positive",
  "upstream-positive",
  "default-always",
  "session-positive",
]);

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProjectPrimaryAgentName(value: string): value is ProjectPrimaryAgentName {
  return PROJECT_PRIMARY_AGENT_NAMES.has(value);
}

function isProjectSubagentRoleName(value: string): value is ProjectSubagentRoleName {
  return PROJECT_SUBAGENT_ROLE_NAMES.has(value);
}

/** Use the eager runtime's shared registry parser for project model references. */
function isValidProjectModelReference(value: unknown): value is string {
  return typeof value === "string" && parseProviderModelReference(value) !== undefined;
}

function canonicalExistingProjectRoot(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  try {
    const canonical = fs.realpathSync(value);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep only the opaque capability and identity metadata needed by the primary
 * authorization path. Definition/config fields never enter this runtime state.
 */
function normalizeActiveProjectAgentSnapshot(
  value: unknown,
): ActiveProjectAgentSnapshot | undefined {
  if (!isRecord(value) || value.status !== "loaded") return undefined;
  const capability = value.capability;
  const provenance = value.provenance;
  const manifest = value.manifest;
  if (!isRecord(capability) || !isRecord(provenance) || !isRecord(manifest)) return undefined;

  if (
    !nonEmptyString(provenance.projectRoot) ||
    !nonEmptyString(provenance.sessionId) ||
    !nonEmptyString(provenance.generationId) ||
    !nonEmptyString(provenance.processInstanceId)
  ) {
    return undefined;
  }
  const manifestProvenance = manifest.provenance;
  if (!isRecord(manifestProvenance)) return undefined;
  if (
    manifestProvenance.projectRoot !== provenance.projectRoot ||
    manifestProvenance.sessionId !== provenance.sessionId ||
    manifestProvenance.generationId !== provenance.generationId ||
    manifestProvenance.processInstanceId !== provenance.processInstanceId
  ) {
    return undefined;
  }

  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.tombstones)) return undefined;
  const entries: Array<{ name: string; digest: string }> = [];
  for (const rawEntry of manifest.entries) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.agent)) return undefined;
    if (!nonEmptyString(rawEntry.agent.name) || !nonEmptyString(rawEntry.digest)) {
      return undefined;
    }
    entries.push({ name: rawEntry.agent.name, digest: rawEntry.digest });
  }
  const tombstones: string[] = [];
  for (const rawTombstone of manifest.tombstones) {
    if (!nonEmptyString(rawTombstone)) return undefined;
    tombstones.push(rawTombstone);
  }

  const rawTrust = value.trust;
  const trust =
    isRecord(rawTrust) &&
    rawTrust.kind === "project-agent" &&
    rawTrust.trusted === true &&
    typeof rawTrust.source === "string"
      ? { trusted: true, source: rawTrust.source }
      : undefined;
  return {
    capability,
    provenance: {
      projectRoot: provenance.projectRoot,
      sessionId: provenance.sessionId,
      generationId: provenance.generationId,
      processInstanceId: provenance.processInstanceId,
    },
    entries,
    tombstones,
    ...(trust ? { trust } : {}),
  };
}

function isPersistedProjectAgentTrustDenial(value: unknown): boolean {
  if (!isRecord(value) || value.status !== "denied") return false;
  if (!nonEmptyString(value.projectRoot) || !nonEmptyString(value.agentsDirectory)) return false;
  const trust = value.trust;
  return (
    isRecord(trust) &&
    trust.kind === "project-agent" &&
    trust.trusted === false &&
    typeof trust.source === "string" &&
    PERSISTED_PROJECT_AGENT_TRUST_DENIAL_SOURCES.has(trust.source)
  );
}

function defaultProjectTrustForCwd(cwd: string): "ask" | "always" | "never" {
  try {
    const value = SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted: false,
    }).getDefaultProjectTrust();
    return value === "always" || value === "never" ? value : "ask";
  } catch {
    return "ask";
  }
}

function sessionIdForContext(ctx: ExtensionContext): string | undefined {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return nonEmptyString(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

type PrimaryProjectAgentCwdValidation = { valid: true } | { valid: false; reason: string };

function pathWithinProjectRoot(projectRoot: string, candidate: string): boolean {
  const relativePath = relative(projectRoot, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function validatePrimaryProjectAgentCwdContainment(
  projectRoot: string,
  cwd: unknown,
  taskCwds: readonly unknown[],
): PrimaryProjectAgentCwdValidation {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    return { valid: false, reason: "the canonical project root is unavailable" };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(projectRoot);
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      return { valid: false, reason: "the canonical project root is not a directory" };
    }
  } catch {
    return { valid: false, reason: "the canonical project root cannot be resolved" };
  }

  const canonicalDirectory = (
    value: unknown,
    label: string,
  ): { valid: true; path: string } | { valid: false; reason: string } => {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { valid: false, reason: `${label} must be an existing directory` };
    }
    try {
      const canonical = fs.realpathSync(value);
      if (!fs.statSync(canonical).isDirectory()) {
        return { valid: false, reason: `${label} is not a directory` };
      }
      return { valid: true, path: canonical };
    } catch {
      return { valid: false, reason: `${label} does not exist or cannot be resolved` };
    }
  };

  const canonicalCwd = canonicalDirectory(cwd, "execution cwd");
  if (!canonicalCwd.valid) return canonicalCwd;
  if (!pathWithinProjectRoot(canonicalRoot, canonicalCwd.path)) {
    return { valid: false, reason: "execution cwd is outside the canonical project root" };
  }
  if (typeof cwd !== "string") {
    return { valid: false, reason: "execution cwd must be an existing directory" };
  }
  for (let index = 0; index < taskCwds.length; index += 1) {
    const taskCwd = taskCwds[index];
    if (taskCwd !== undefined && typeof taskCwd !== "string") {
      return { valid: false, reason: `task ${index + 1} cwd must be an existing directory` };
    }
    const resolvedTaskCwd = taskCwd === undefined || taskCwd === "" ? cwd : resolve(cwd, taskCwd);
    const canonicalTaskCwd = canonicalDirectory(resolvedTaskCwd, `task ${index + 1} cwd`);
    if (!canonicalTaskCwd.valid) return canonicalTaskCwd;
    if (!pathWithinProjectRoot(canonicalRoot, canonicalTaskCwd.path)) {
      return {
        valid: false,
        reason: `task ${index + 1} cwd is outside the canonical project root`,
      };
    }
  }
  return { valid: true };
}

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
function applyProviderAwareModelsToNonProjectTargets(
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

function applyOpenRouterModelToProjectTargets(
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
    return "TLH Product may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.";
  }
  if (selection === "bug-hunter") {
    return "TLH Bug-Hunter may not delegate to embedded subagents. Embedded subagent delegation is available only while architect or disabled mode is active.";
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
    projectAgentLoader?: ProjectAgentSnapshotLoader;
    projectDefaultsLoader?: ProjectDefaultsLoader;
    now?: () => number;
  } = {},
): TlhPrimaryAgentRuntime & { registerCommands(): void; registerLifecycleHooks(): void } {
  const {
    getProviderAuthHealthStore,
    projectAgentLoader = loadProjectAgentSnapshot,
    projectDefaultsLoader: projectDefaultsLoaderFn = loadProjectDefaults,
    now: nowFn = Date.now,
  } = runtimeOptions;
  const warned = new Set<string>();
  // Repository-controlled project-default diagnostics are intentionally scoped
  // to one session. Their hashed keys keep attacker-controlled roots, roles,
  // and messages out of long-lived notification state.
  const projectDefaultsWarned = new Set<string>();
  const runtimeOwnerPrefix = `runtime:${randomUUID()}`;
  let runtimeReferenceId = `${runtimeOwnerPrefix}:owner:${randomUUID()}`;
  const runtimeEpoch = ++PROJECT_AGENT_RUNTIME_STATE.epoch;
  let activeProjectAgentSnapshot: ActiveProjectAgentSnapshot | undefined;
  let projectAgentLoadRequest = 0;
  let projectAgentTrustWarningSessionId: string | undefined;

  const isCurrentProjectAgentOperation = (loadRequest: number, sessionId: string): boolean =>
    runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
    projectAgentLoadRequest === loadRequest &&
    PROJECT_AGENT_RUNTIME_STATE.sessionId === sessionId;
  const releaseProjectAgentReferenceQuietly = async (referenceId: string): Promise<void> => {
    try {
      await releaseTlhProjectAgentSnapshotReference(referenceId);
    } catch {
      // A failed cleanup can never become execution authority. Keep the
      // active state unchanged and do not fall back to the unverified result.
    }
  };
  type ProjectAgentReferenceLease = {
    referenceId: string;
    release: () => Promise<void>;
  };
  const retainProjectAgentReferenceTemporarily = async (
    capability: ProjectAgentCapability,
    kind: "load" | "rebind",
  ): Promise<ProjectAgentReferenceLease | undefined> => {
    const referenceId = `${runtimeOwnerPrefix}:${kind}:${randomUUID()}`;
    try {
      await retainTlhProjectAgentSnapshotReference(capability, referenceId);
    } catch {
      // A structurally valid loader result without a registry capability is
      // not execution authority. Do not fall back to the returned metadata.
      return undefined;
    }
    let retained = true;
    return {
      referenceId,
      release: async () => {
        if (!retained) return;
        retained = false;
        await releaseProjectAgentReferenceQuietly(referenceId);
      },
    };
  };
  const noticed = new Set<string>();
  let activeProjectDefaults: ActiveProjectDefaults | undefined;
  let sessionStartRequestId = 0;

  type SessionStartOperation = {
    readonly requestId: number;
    readonly runtimeEpoch: number;
  };

  function isCurrentSessionStartOperation(operation: SessionStartOperation): boolean {
    return (
      operation.requestId === sessionStartRequestId &&
      operation.runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch
    );
  }

  // The access provider is process-private and carries no model-facing fields.
  // It remains installed for this runtime's lifetime while its captured
  // capability is replaced on each session_start/reload.
  setTlhProjectAgentAccessProvider(() => {
    const snapshot = activeProjectAgentSnapshot;
    if (!snapshot) return undefined;
    const selection = currentPrimaryAgentSelection();
    const architect =
      selection === "architect" &&
      isEnabledPrimaryAgentSelection(selection) &&
      activePrimaryAgent() !== undefined;
    return {
      capability: snapshot.capability,
      expected: snapshot.provenance,
      architect,
      // Disabled mode keeps the TLH safety plane active but intentionally has
      // no primary persona. It may still initiate an explicitly requested
      // project custom run; retained controls remain architect-only.
      canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
      ...(snapshot.reauthorizeTrust ? { reauthorize: snapshot.reauthorizeTrust } : {}),
      ...(snapshot.rebindProjectAgent ? { rebind: snapshot.rebindProjectAgent } : {}),
    };
  });
  const primaryToolState = createPrimaryToolState();
  const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
  let primaryAgentDefaultSelection: TlhPrimaryAgentSelection = DEFAULT_PRIMARY_AGENT;
  let sessionPrimaryAgentOverride: TlhPrimaryAgentSelection | undefined;
  let sessionProjectAgentGuidanceSnapshot: ProjectAgentGuidanceInventory | undefined;

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

  /**
   * Publish a repository-controlled project-default warning once per session.
   * The display text is bounded independently from the fixed-size hashed key;
   * a headless or broken UI cannot make session_start fail.
   */
  function warnProjectDefaultsOnce(
    ctx: ExtensionContext,
    projectRoot: string | undefined,
    agent: string | undefined,
    message: string,
    identityMessage = message,
  ): void {
    const boundedMessage = truncateProjectDefaultsWarning(message);
    if (boundedMessage.length === 0) return;
    try {
      if (ctx.hasUI === false) return;
      const key = projectDefaultsWarningKey(
        projectRoot,
        ctx.cwd,
        agent,
        boundedMessage,
        identityMessage,
      );
      if (projectDefaultsWarned.has(key)) return;
      ctx.ui.notify(boundedMessage, "warning");
      projectDefaultsWarned.add(key);
    } catch {
      // Project/defaults diagnostics are advisory. A non-interactive or broken
      // notification surface must never escape session_start or dispatch.
    }
  }

  function warnPersistedProjectAgentTrustDenied(
    ctx: ExtensionContext,
    sessionId: string,
    loaded: unknown,
  ): void {
    if (
      ctx.hasUI === false ||
      projectAgentTrustWarningSessionId === sessionId ||
      !isPersistedProjectAgentTrustDenial(loaded)
    ) {
      return;
    }
    try {
      ctx.ui.notify(
        "TLH project custom agents are unavailable because persisted project trust does not authorize this project. Run /trust, persist trust for this project, then retry.",
        "warning",
      );
      projectAgentTrustWarningSessionId = sessionId;
    } catch {
      // A non-interactive or unavailable UI must not affect the fail-closed load.
    }
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

  /**
   * Validate and narrow the raw result from the project-defaults bridge.
   * Treats the value as unknown (external I/O boundary).
   */
  function normalizeProjectDefaultsResult(
    value: unknown,
    cwd: string,
  ): ActiveProjectDefaults | undefined {
    if (!isRecord(value) || !Object.hasOwn(value, "status")) return undefined;
    const status = value.status;
    if (status !== "loaded" && status !== "denied" && status !== "unavailable") return undefined;

    const warnings = normalizeProjectDefaultsWarnings(value.warnings);

    if (status !== "loaded") {
      return { status, projectRoot: undefined, primaryAgents: {}, subagents: {}, warnings };
    }

    const rawDefaults = Object.hasOwn(value, "defaults") ? value.defaults : undefined;
    const primaryAgents: Partial<Record<ProjectPrimaryAgentName, ActiveProjectDefaultsEntry>> = {};
    const subagents: Partial<Record<ProjectSubagentRoleName, ActiveProjectDefaultsEntry>> = {};

    function normalizeSection<Role extends string>(
      raw: unknown,
      target: Partial<Record<Role, ActiveProjectDefaultsEntry>>,
      isAllowedRole: (name: string) => name is Role,
    ): void {
      // Arrays, null, and other non-record section values are rejected rather
      // than being treated as maps.
      if (!isRecord(raw)) return;
      for (const [name, rawEntry] of Object.entries(raw)) {
        // Check the exact role allowlist before assigning to the target. In
        // particular, __proto__ and constructor can never become target keys.
        if (!isAllowedRole(name) || !isRecord(rawEntry)) continue;
        if (Object.keys(rawEntry).some((key) => key !== "model" && key !== "effort")) {
          continue;
        }

        let model: string | undefined;
        if (Object.hasOwn(rawEntry, "model")) {
          if (!isValidProjectModelReference(rawEntry.model)) continue;
          model = rawEntry.model;
        }

        let effort: ThinkingLevel | undefined;
        if (Object.hasOwn(rawEntry, "effort")) {
          if (typeof rawEntry.effort !== "string" || !isThinkingLevel(rawEntry.effort)) {
            continue;
          }
          effort = rawEntry.effort;
        }

        // Reject the whole entry when neither recognized field survives
        // narrowing; do not apply effort on an invalid model entry.
        if (model === undefined && effort === undefined) continue;

        const entry: { model?: string; effort?: ThinkingLevel } = {};
        if (model !== undefined) entry.model = model;
        if (effort !== undefined) entry.effort = effort;
        target[name] = entry;
      }
    }

    if (isRecord(rawDefaults)) {
      if (Object.hasOwn(rawDefaults, "primaryAgents")) {
        normalizeSection(rawDefaults.primaryAgents, primaryAgents, isProjectPrimaryAgentName);
      }
      if (Object.hasOwn(rawDefaults, "subagents")) {
        normalizeSection(rawDefaults.subagents, subagents, isProjectSubagentRoleName);
      }
    }

    const projectRoot = Object.hasOwn(value, "projectRoot")
      ? canonicalExistingProjectRoot(value.projectRoot)
      : undefined;
    const hasActiveDefaults =
      Object.keys(primaryAgents).length > 0 || Object.keys(subagents).length > 0;
    if (hasActiveDefaults) {
      // Active values must carry a canonical root and be authorized by the
      // configuration trust plane. A project-agent trust result is never valid
      // here, even if it happens to report trusted=true.
      if (!projectRoot) return undefined;
      const cwdValidation = validatePrimaryProjectAgentCwdContainment(projectRoot, cwd, []);
      if (!cwdValidation.valid) return undefined;
      const trust = value.trust;
      if (
        !isRecord(trust) ||
        !Object.hasOwn(trust, "kind") ||
        !Object.hasOwn(trust, "trusted") ||
        !Object.hasOwn(trust, "source") ||
        trust.kind !== "project-config" ||
        trust.trusted !== true ||
        typeof trust.source !== "string" ||
        !PROJECT_CONFIG_TRUST_POSITIVE_SOURCES.has(trust.source)
      ) {
        return undefined;
      }
    }

    return {
      status: "loaded",
      projectRoot,
      primaryAgents,
      subagents,
      warnings,
    };
  }

  function activeProjectDefaultsForCwd(cwd: string): ActiveProjectDefaults | undefined {
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch) return undefined;
    const defaults = activeProjectDefaults;
    if (defaults?.status !== "loaded" || !defaults.projectRoot) return undefined;
    const validation = validatePrimaryProjectAgentCwdContainment(defaults.projectRoot, cwd, []);
    return validation.valid ? defaults : undefined;
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

  function projectSnapshotTargets(input: unknown): string[] {
    const snapshot = activeProjectAgentSnapshot;
    if (!snapshot) return [];
    const projectNames = new Set([
      ...snapshot.entries.map((entry) => entry.name),
      ...snapshot.tombstones,
    ]);
    return collectSubagentCallTargetsMatching(
      input,
      (target) => isEmbeddedSubagentTarget(target) && projectNames.has(target),
    );
  }

  function projectSnapshotCwdReason(
    input: unknown,
    ctx: ExtensionContext,
    snapshot: ActiveProjectAgentSnapshot,
  ): string | undefined {
    if (!isRecord(input)) return "TLH project-agent execution requires an object input.";
    const requestedCwd = input.cwd;
    if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
      return "TLH project-agent execution requires a valid top-level cwd.";
    }
    const topLevelCwd =
      typeof requestedCwd === "string" && requestedCwd.length > 0
        ? resolve(ctx.cwd, requestedCwd)
        : ctx.cwd;
    const taskCwds: unknown[] = [];
    if (Array.isArray(input.tasks)) {
      for (const task of input.tasks) {
        taskCwds.push(isRecord(task) ? task.cwd : undefined);
      }
    }
    const validation = validatePrimaryProjectAgentCwdContainment(
      snapshot.provenance.projectRoot,
      topLevelCwd,
      taskCwds,
    );
    return validation.valid
      ? undefined
      : `TLH project-agent execution blocked: ${validation.reason}`;
  }

  function activeProjectSnapshotIdentityReason(
    input: unknown,
    ctx: ExtensionContext,
    targets: readonly string[],
  ): string | undefined {
    const snapshot = activeProjectAgentSnapshot;
    if (!snapshot) {
      return `TLH project-agent execution is unavailable for ${targets.join(", ")}; no active trusted snapshot exists.`;
    }
    const sessionId = sessionIdForContext(ctx);
    if (sessionId !== snapshot.provenance.sessionId) {
      return `TLH project-agent execution is unavailable for ${targets.join(", ")}; the active snapshot does not belong to this session.`;
    }
    for (const target of targets) {
      const entry = snapshot.entries.find((candidate) => candidate.name === target);
      const tombstoned = snapshot.tombstones.includes(target);
      if (tombstoned) {
        return `TLH project-agent execution is blocked for ${target}; the active snapshot tombstone prevents profile fallback.`;
      }
      if (!entry) {
        return `TLH project-agent execution is unavailable for ${target}; the selected snapshot entry is missing.`;
      }
      if (!nonEmptyString(entry.digest)) {
        return `TLH project-agent execution is unavailable for ${target}; its snapshot digest is invalid.`;
      }
    }
    return projectSnapshotCwdReason(input, ctx, snapshot);
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
      // Project-agent guidance uses a once-per-session snapshot so it remains stable until /reload
      // or a new session, while role changes select the matching entry from the same snapshot.
      buildTlhSystemPrompt(
        primary,
        subagentMetadata,
        primaryEnabled,
        sessionProjectAgentGuidanceSnapshot,
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

  function notifyUndecidedProjectAgentGuidance(
    ctx: ExtensionContext,
    inventory: ProjectAgentGuidanceInventory,
  ): void {
    if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
      return;
    }

    const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
    if (!diagnostic) {
      return;
    }

    try {
      ctx.ui.notify(diagnostic.message, "warning");
    } catch {
      // Startup should remain usable when a non-interactive UI rejects a notification.
    }
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
    return runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch;
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

  function attachProjectAgentRuntimeCallbacks(snapshot: ActiveProjectAgentSnapshot): void {
    if (!snapshot.trust) return;
    snapshot.reauthorizeTrust = async () => {
      try {
        const current = await reauthorizeTlhProjectAgentTrust(snapshot.provenance.projectRoot, {
          agentDir: getAgentDir(),
          trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
        });
        return current?.trusted === true;
      } catch {
        return false;
      }
    };
    snapshot.rebindProjectAgent = async (request) => {
      const runtimeLoadRequest = projectAgentLoadRequest;
      const runtimeSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
      const runtimeReferenceIdAtStart = runtimeReferenceId;
      const activeSnapshotAtStart = activeProjectAgentSnapshot;
      const agentMatch = /^embedded\.([a-z0-9][a-z0-9-]*)$/.exec(request.agent);
      if (
        !agentMatch ||
        !runtimeSessionId ||
        request.sessionId !== runtimeSessionId ||
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        activeSnapshotAtStart !== snapshot ||
        PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
      ) {
        return undefined;
      }
      const cwdValidation = validatePrimaryProjectAgentCwdContainment(
        request.projectRoot,
        request.cwd,
        [],
      );
      if (!cwdValidation.valid) return undefined;

      let loaded: unknown;
      try {
        loaded = await projectAgentLoader({
          cwd: request.cwd,
          sessionId: request.sessionId,
          agentDir: getAgentDir(),
          trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
        });
      } catch {
        return undefined;
      }
      const rebound = normalizeActiveProjectAgentSnapshot(loaded);
      if (!rebound) return undefined;

      // A loader registers the capability before returning it. Retain it before
      // any validation or stale-operation check can reject this load, then
      // release the lease in the finally block on every non-adoption path.
      const reboundLease = await retainProjectAgentReferenceTemporarily(
        rebound.capability,
        "rebind",
      );
      if (!reboundLease) return undefined;
      let adopted = false;
      try {
        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          !activeSnapshotAtStart ||
          rebound.trust?.trusted !== true ||
          rebound.provenance.sessionId !== request.sessionId ||
          rebound.provenance.processInstanceId !== snapshot.provenance.processInstanceId
        ) {
          return undefined;
        }

        let requestedRoot: string;
        let activeRoot: string;
        let reboundRoot: string;
        let reboundCwd: string;
        try {
          requestedRoot = fs.realpathSync(request.projectRoot);
          activeRoot = fs.realpathSync(snapshot.provenance.projectRoot);
          reboundRoot = fs.realpathSync(rebound.provenance.projectRoot);
          reboundCwd = fs.realpathSync(request.cwd);
        } catch {
          return undefined;
        }
        if (
          requestedRoot !== activeRoot ||
          requestedRoot !== reboundRoot ||
          !pathWithinProjectRoot(requestedRoot, reboundCwd)
        ) {
          return undefined;
        }

        const rawManifest =
          isRecord(loaded) && isRecord(loaded.manifest) ? loaded.manifest : undefined;
        const rawEntries = rawManifest?.entries;
        if (!Array.isArray(rawEntries)) return undefined;
        const rawEntry = rawEntries.find(
          (entry) => isRecord(entry) && isRecord(entry.agent) && entry.agent.name === request.agent,
        );
        if (!rawEntry || !isRecord(rawEntry.agent) || typeof rawEntry.digest !== "string") {
          return undefined;
        }
        const expectedPath = join(
          reboundRoot,
          ".tlh",
          "agents",
          "custom",
          `${agentMatch[1]!.toUpperCase()}.md`,
        );
        if (
          rawEntry.agent.name !== request.agent ||
          rawEntry.agent.localName !== agentMatch[1] ||
          rawEntry.agent.packageName !== "embedded" ||
          rawEntry.agent.source !== "project" ||
          rawEntry.agent.filePath !== expectedPath
        ) {
          return undefined;
        }

        const sameActiveCapability =
          activeSnapshotAtStart === snapshot &&
          PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceIdAtStart &&
          activeSnapshotAtStart.capability === rebound.capability;
        const makeRebindResult = (): ProjectAgentRebindResult => ({
          capability: rebound.capability,
          expected: { ...rebound.provenance },
          capture: {
            provenance: {
              ...rebound.provenance,
              source: "project",
              agent: request.agent,
              digest: rawEntry.digest as string,
            },
            config: rawEntry.agent as Record<string, unknown>,
          },
        });
        if (sameActiveCapability) return makeRebindResult();

        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          activeProjectAgentSnapshot !== activeSnapshotAtStart ||
          PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
        ) {
          return undefined;
        }
        try {
          // Retain-before-release preserves authority while the active owner
          // is transferred to this fresh generation.
          await releaseTlhProjectAgentSnapshotReference(runtimeReferenceIdAtStart);
        } catch {
          return undefined;
        }
        if (
          !isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
          activeProjectAgentSnapshot !== activeSnapshotAtStart ||
          PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart
        ) {
          return undefined;
        }

        attachProjectAgentRuntimeCallbacks(rebound);
        runtimeReferenceId = reboundLease.referenceId;
        PROJECT_AGENT_RUNTIME_STATE.referenceId = reboundLease.referenceId;
        activeProjectAgentSnapshot = rebound;
        adopted = true;
        return makeRebindResult();
      } finally {
        if (!adopted) await reboundLease.release();
      }
    };
  }

  async function loadProjectAgentSnapshotForSession(ctx: ExtensionContext): Promise<void> {
    // Replace only the active generation. Retained run references are owned by
    // the process-private snapshot registry and therefore survive same-session
    // reloads, while failed loads never authorize a new generation.
    const requestId = ++projectAgentLoadRequest;
    const previousReferenceId =
      runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
      PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
        ? runtimeReferenceId
        : undefined;
    activeProjectAgentSnapshot = undefined;
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch) return;
    if (previousReferenceId) {
      try {
        await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
      } catch {
        // A release failure leaves the old owner unavailable but must never
        // authorize a new capability or create an ambiguous owner reference.
        return;
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        requestId !== projectAgentLoadRequest ||
        PROJECT_AGENT_RUNTIME_STATE.referenceId !== previousReferenceId
      ) {
        return;
      }
      PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
    }
    const sessionId = sessionIdForContext(ctx);
    if (!sessionId) return;
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
      return;
    const previousSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
    if (previousSessionId && previousSessionId !== sessionId) {
      try {
        await releaseTlhProjectAgentRunReferencesForSession(previousSessionId);
      } catch {
        // Old-session run references cannot authorize a different current
        // session; continue loading, but never use them as the new authority.
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        requestId !== projectAgentLoadRequest ||
        PROJECT_AGENT_RUNTIME_STATE.sessionId !== previousSessionId
      ) {
        return;
      }
    }
    if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
      return;
    PROJECT_AGENT_RUNTIME_STATE.sessionId = sessionId;

    let loaded: unknown;
    try {
      loaded = await projectAgentLoader({
        cwd: ctx.cwd,
        sessionId,
        agentDir: getAgentDir(),
        trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
      });
    } catch {
      // Trust/scan failures are deliberately silent here. In particular, do
      // not turn an exception into permission to use an untrusted definition.
      return;
    }
    // Preserve the existing warning for a current persisted trust denial. A
    // denied result has no registered capability, while a loaded result is
    // retained immediately below before any stale-load rejection can abandon
    // its generation.
    if (isCurrentProjectAgentOperation(requestId, sessionId)) {
      warnPersistedProjectAgentTrustDenied(ctx, sessionId, loaded);
    }
    const normalized = normalizeActiveProjectAgentSnapshot(loaded);
    if (!normalized) return;

    // Retain the loader's newly registered capability before the current-load
    // check can reject a stale session start. The lease is transferred to the
    // runtime owner only after all adoption checks pass.
    const loadLease = await retainProjectAgentReferenceTemporarily(normalized.capability, "load");
    if (!loadLease) return;
    let adopted = false;
    try {
      if (!isCurrentProjectAgentOperation(requestId, sessionId)) return;
      attachProjectAgentRuntimeCallbacks(normalized);
      if (PROJECT_AGENT_RUNTIME_STATE.referenceId !== undefined) return;
      runtimeReferenceId = loadLease.referenceId;
      PROJECT_AGENT_RUNTIME_STATE.referenceId = loadLease.referenceId;
      activeProjectAgentSnapshot = normalized;
      adopted = true;
    } finally {
      if (!adopted) await loadLease.release();
    }
  }

  /**
   * Load .tlh/defaults.json project defaults for the current session.
   *
   * Configuration trust is deliberately separate from custom-agent execution
   * trust. A session/defaults approval can authorize model/effort defaults,
   * but can never authorize project custom-agent definitions.
   */
  async function loadProjectDefaultsForSession(
    ctx: ExtensionContext,
    operation: SessionStartOperation,
  ): Promise<void> {
    if (!isCurrentSessionStartOperation(operation)) return;
    activeProjectDefaults = undefined;
    const sessionId = sessionIdForContext(ctx);
    if (!sessionId) return;

    let loaded: unknown;
    try {
      const defaultProjectTrust = defaultProjectTrustForCwd(ctx.cwd);
      loaded = await projectDefaultsLoaderFn({
        cwd: ctx.cwd,
        sessionId,
        agentDir: getAgentDir(),
        defaultProjectTrust,
        trust: {
          sessionId,
          defaultProjectTrust,
          createProjectTrustStore: PROJECT_AGENT_TRUST_DEPENDENCIES.createProjectTrustStore,
          hasTrustRequiringProjectResources,
          isProjectTrusted: () => ctx.isProjectTrusted(),
          hasUI: ctx.hasUI,
          ui:
            typeof ctx.ui?.confirm === "function"
              ? {
                  confirm: (title: string, message: string, options?: ExtensionUIDialogOptions) =>
                    ctx.ui.confirm(title, message, options),
                }
              : undefined,
        },
      });
    } catch {
      // Defaults-load failures are deliberately silent; never crash the session.
      return;
    }

    if (!isCurrentSessionStartOperation(operation)) return;

    let normalized: ActiveProjectDefaults | undefined;
    try {
      normalized = normalizeProjectDefaultsResult(loaded, ctx.cwd);
    } catch {
      // Malformed injected bridge values (including throwing getters/proxies)
      // must fail closed without escaping session_start.
      return;
    }
    if (!isCurrentSessionStartOperation(operation)) return;
    if (normalized?.status === "loaded") {
      for (const warning of normalized.warnings) {
        if (!isCurrentSessionStartOperation(operation)) return;
        warnProjectDefaultsOnce(ctx, normalized.projectRoot, undefined, warning);
      }
    }
    if (!isCurrentSessionStartOperation(operation)) return;
    activeProjectDefaults = normalized ?? undefined;
  }

  async function applySessionStart(ctx: ExtensionContext): Promise<void> {
    const sessionStartOperation: SessionStartOperation = {
      requestId: ++sessionStartRequestId,
      runtimeEpoch,
    };
    // Invalidate the prior session's configuration plane immediately. A slow
    // capability load must not leave old project defaults available to a new
    // session before its own defaults operation reaches the loader.
    activeProjectDefaults = undefined;
    projectDefaultsWarned.clear();
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
    await loadProjectAgentSnapshotForSession(ctx);
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    sessionProjectAgentGuidanceSnapshot = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
    notifyUndecidedProjectAgentGuidance(ctx, sessionProjectAgentGuidanceSnapshot);
    if (!isCurrentSessionStartOperation(sessionStartOperation)) return;
    await loadProjectDefaultsForSession(ctx, sessionStartOperation);
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
      sessionStartRequestId += 1;
      const shutdownRequestId = ++projectAgentLoadRequest;
      const previousReferenceId =
        runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
        PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
          ? runtimeReferenceId
          : undefined;
      activeProjectDefaults = undefined;
      projectDefaultsWarned.clear();
      noticed.clear();
      activeProjectAgentSnapshot = undefined;
      if (previousReferenceId) {
        let released = true;
        try {
          await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
        } catch {
          released = false;
          // A release failure must not turn the stale capability into a new
          // authorization path. Leave the owner id for a later retry while
          // keeping this runtime's active snapshot unavailable.
        }
        if (
          runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
          shutdownRequestId !== projectAgentLoadRequest
        ) {
          return;
        }
        if (released && PROJECT_AGENT_RUNTIME_STATE.referenceId === previousReferenceId) {
          PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
        }
      }
      if (
        runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
        shutdownRequestId !== projectAgentLoadRequest
      ) {
        return;
      }
      endModelSelectionSession();
      lastObservedModel = undefined;
      updateSessionOnlyModel(undefined);
      clearSessionThinkingOverride();
      sessionProjectAgentGuidanceSnapshot = undefined;
      // Applied-default notices are session-scoped; allow the next session to
      // report its effective project fields again.
      noticed.clear();
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
      projectAgentTrustWarningSessionId = undefined;
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
      capScoutSubagentTimeout(event.input);
      syncPrimaryAgentState(ctx);
      const selection = currentPrimaryAgentSelection();
      const allowedSubagents = allowedSubagentsForExperimentalConfig();
      const projectTargets = projectSnapshotTargets(event.input);
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
    projectAgentGuidanceSnapshot: () => sessionProjectAgentGuidanceSnapshot,
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
  // Extension reloads and child-process test harnesses can construct a new
  // runtime before the prior closure receives shutdown. Retire its access
  // bridge and active-generation reference immediately so no stale generation
  // can reach the new executor while run references remain protected.
  setTlhProjectAgentAccessProvider(undefined);
  if (PROJECT_AGENT_RUNTIME_STATE.referenceId) {
    const previousReferenceId = PROJECT_AGENT_RUNTIME_STATE.referenceId;
    PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
    void releaseTlhProjectAgentSnapshotReference(previousReferenceId).catch(() => {
      // The new runtime starts without active project authority. A failed
      // cleanup cannot be used as authorization for the new runtime.
    });
  }
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
