import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { parseProviderModelReference } from "./model-defaults.js";
import { isThinkingLevel } from "./thinking.js";
import type { ThinkingLevel, TlhPrimaryAgentSelection } from "./types.js";
import {
  collectSubagentTargets,
  isEmbeddedSubagentTarget,
} from "../the-last-harness-subagent-safety.mjs";

export type ProjectAgentCapability = Record<string, unknown>;

/** Role names accepted by the project-defaults runtime boundary. */
export type ProjectPrimaryAgentName = Exclude<TlhPrimaryAgentSelection, "disabled">;
export type ProjectSubagentRoleName =
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

export type ProjectAgentTrustReauthorizer = () => Promise<boolean>;

export type ProjectAgentRebindRequest = {
  projectRoot: string;
  cwd: string;
  sessionId: string;
  agent: string;
};

export type ProjectAgentRebindResult = {
  capability: ProjectAgentCapability;
  expected: Record<string, unknown>;
  capture: {
    provenance: Record<string, unknown>;
    config: Record<string, unknown>;
  };
};

export type ProjectAgentRebinder = (
  request: ProjectAgentRebindRequest,
) => Promise<ProjectAgentRebindResult | undefined>;

export interface ActiveProjectAgentSnapshot {
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

export interface ActiveProjectDefaultsEntry {
  readonly model?: string;
  readonly effort?: ThinkingLevel;
}

export interface ActiveProjectDefaults {
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

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isProjectPrimaryAgentName(value: string): value is ProjectPrimaryAgentName {
  return PROJECT_PRIMARY_AGENT_NAMES.has(value);
}

function isProjectSubagentRoleName(value: string): value is ProjectSubagentRoleName {
  return PROJECT_SUBAGENT_ROLE_NAMES.has(value);
}

/** Use the eager runtime's shared registry parser for project model references. */
function isValidProjectModelReference(value: unknown): value is string {
  return typeof value === "string" && parseProviderModelReference(value) !== undefined;
}

export function canonicalExistingProjectRoot(value: unknown): string | undefined {
  if (!nonEmptyString(value)) return undefined;
  try {
    const canonical = fs.realpathSync(value);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function truncateProjectDefaultsWarning(message: string): string {
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

export function projectDefaultsWarningKey(
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

export function unavailableProjectModelWarningMessage(
  selection: string,
  modelReference: string,
): string {
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
export function normalizeProjectDefaultsWarnings(value: unknown): string[] {
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
 * Keep only the opaque capability and identity metadata needed by the primary
 * authorization path. Definition/config fields never enter this runtime state.
 */
export function normalizeActiveProjectAgentSnapshot(
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

export function isPersistedProjectAgentTrustDenial(value: unknown): boolean {
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

export function sessionIdForContext(ctx: ExtensionContext): string | undefined {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return nonEmptyString(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

export type PrimaryProjectAgentCwdValidation = { valid: true } | { valid: false; reason: string };

export function pathWithinProjectRoot(projectRoot: string, candidate: string): boolean {
  const relativePath = relative(projectRoot, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function validatePrimaryProjectAgentCwdContainment(
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

/**
 * Validate and narrow the raw result from the project-defaults bridge.
 * Treats the value as unknown (external I/O boundary).
 */
export function normalizeProjectDefaultsResult(
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

export function projectSnapshotTargets(
  input: unknown,
  snapshot: ActiveProjectAgentSnapshot | undefined,
): string[] {
  if (!snapshot) return [];
  const projectNames = new Set([
    ...snapshot.entries.map((entry) => entry.name),
    ...snapshot.tombstones,
  ]);
  return collectSubagentTargets(input).filter(
    (target) => isEmbeddedSubagentTarget(target) && projectNames.has(target),
  );
}

export function projectSnapshotCwdReason(
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
  return validation.valid ? undefined : `TLH project-agent execution blocked: ${validation.reason}`;
}

export function activeProjectSnapshotIdentityReason(
  input: unknown,
  ctx: ExtensionContext,
  targets: readonly string[],
  snapshot: ActiveProjectAgentSnapshot | undefined,
): string | undefined {
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
