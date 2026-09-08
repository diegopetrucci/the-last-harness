import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  discoverAgentsWithProjectSnapshot,
  type AgentConfig,
  type AgentDiscoveryDiagnostic,
  type AgentScope,
} from "../../agents/agents.ts";
import {
  PROJECT_AGENT_DIRECTORY,
  PROJECT_AGENT_PACKAGE,
  resolveCanonicalGitWorktreeRoot,
  validateProjectAgentCwdContainment,
} from "../../agents/project-agent-loader.ts";
import {
  createProjectAgentRunCapture,
  lookupProjectAgentRunReference,
  normalizeProjectAgentRunCapture,
  projectAgentRunCaptureEquals,
  resolveProjectAgentRunReference,
  resolveProjectAgentSnapshot,
  type ProjectAgentRunCapture,
  type ProjectAgentRunReferenceLookup,
  type ProjectAgentSnapshotCapability,
  type ProjectAgentSnapshotExpected,
  type ProjectAgentSnapshotManifest,
} from "../../agents/project-agent-snapshot.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { readStatus } from "../../shared/utils.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import type {
  ExecutorDeps,
  ProjectAgentAccess,
  ProjectAgentRebindResult,
  SubagentParamsLike,
} from "./subagent-executor.ts";

const EMBEDDED_PROJECT_AGENT_NAME_PATTERN = /^embedded\.[a-z0-9][a-z0-9-]*$/;

interface ExecutionTargetIdentity {
  readonly raw: string;
  readonly normalized: string;
}

function isEmbeddedProjectAgentName(value: string): boolean {
  return EMBEDDED_PROJECT_AGENT_NAME_PATTERN.test(value.trim());
}

function executionTargetIdentities(params: SubagentParamsLike): ExecutionTargetIdentity[] {
  const identities: ExecutionTargetIdentity[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    identities.push({ raw: value, normalized: value.trim() });
  };
  add(params.agent);
  for (const task of params.tasks ?? []) add(task.agent);
  return identities;
}

function executionTargetNames(params: SubagentParamsLike): string[] {
  return [...new Set(executionTargetIdentities(params).map((identity) => identity.normalized))];
}

interface ProjectAgentExecutionResolution {
  params: SubagentParamsLike;
  effectiveCwd: string;
  projectAgentCapability?: ProjectAgentSnapshotCapability;
  projectAgentCaptures?: readonly import("../../agents/project-agent-snapshot.ts").ProjectAgentRunCapture[];
  discovered: {
    agents: AgentConfig[];
    modelScope?: ModelScopeConfig;
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
    projectSnapshot?: {
      entries: readonly { name: string; digest: string }[];
      tombstones: readonly string[];
    };
  };
}

function projectExecutionError(message: string): { error: string } {
  return { error: message };
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProjectAgentCapability(value: Record<string, unknown>): ProjectAgentSnapshotCapability {
  // SAFETY: The provider resolver below rechecks this opaque object identity before use.
  return value as ProjectAgentSnapshotCapability;
}

function isProjectAgentExpected(
  value: Record<string, unknown>,
): value is ProjectAgentSnapshotExpected & Record<string, unknown> {
  return (
    typeof value.projectRoot === "string" &&
    value.projectRoot.trim().length > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim().length > 0 &&
    typeof value.generationId === "string" &&
    value.generationId.trim().length > 0 &&
    typeof value.processInstanceId === "string" &&
    value.processInstanceId.trim().length > 0
  );
}

export function normalizeProjectAgentAccess(value: unknown): ProjectAgentAccess | undefined {
  if (!isRecordValue(value)) return undefined;
  if (!isRecordValue(value.capability) || !isRecordValue(value.expected)) return undefined;
  if (!isProjectAgentExpected(value.expected) || typeof value.architect !== "boolean") {
    return undefined;
  }
  const canInitiate = typeof value.canInitiate === "boolean" ? value.canInitiate : value.architect;
  return {
    capability: asProjectAgentCapability(value.capability),
    expected: value.expected,
    architect: value.architect,
    canInitiate,
    ...(typeof value.reauthorize === "function"
      ? { reauthorize: value.reauthorize as () => Promise<boolean> }
      : {}),
    ...(typeof value.rebind === "function"
      ? {
          rebind: value.rebind as ProjectAgentAccess["rebind"],
        }
      : {}),
  };
}

export function projectAgentEntryIdentityError(
  projectRoot: string,
  entry: ProjectAgentSnapshotManifest["entries"][number],
): string | undefined {
  const agent = entry.agent;
  const runtimeName = agent.name;
  if (!EMBEDDED_PROJECT_AGENT_NAME_PATTERN.test(runtimeName)) {
    return `runtime name '${runtimeName}' is not a valid embedded project-agent identity`;
  }
  const localName = runtimeName.slice("embedded.".length);
  if (agent.localName !== localName || agent.packageName !== PROJECT_AGENT_PACKAGE) {
    return `runtime name '${runtimeName}' does not match its embedded package/local identity`;
  }
  if (agent.source !== "project") {
    return `runtime name '${runtimeName}' is not sourced from the project snapshot`;
  }
  if (!Array.isArray(agent.tools) || agent.tools.length === 0) {
    return `project agent '${runtimeName}' does not carry an explicit usable tools list`;
  }
  if (agent.extensions !== undefined || agent.subagentOnlyExtensions !== undefined) {
    return `project agent '${runtimeName}' carries a prohibited extension surface`;
  }
  if (typeof agent.filePath !== "string" || !path.isAbsolute(agent.filePath)) {
    return `project agent '${runtimeName}' does not carry an absolute definition path`;
  }
  const expectedDirectory = path.join(projectRoot, PROJECT_AGENT_DIRECTORY);
  const expectedFileName = `${localName.toUpperCase()}.md`;
  if (
    path.dirname(agent.filePath) !== expectedDirectory ||
    path.basename(agent.filePath) !== expectedFileName
  ) {
    return `project agent '${runtimeName}' definition path is not the canonical ${PROJECT_AGENT_DIRECTORY}/${expectedFileName} path`;
  }
  return undefined;
}

function projectAgentConfigMatches(left: AgentConfig, right: AgentConfig): boolean {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isRecordValue(value)) {
      return `{${Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  try {
    return stable(left) === stable(right);
  } catch {
    return false;
  }
}

export function resolveProjectAgentExecution(
  params: SubagentParamsLike,
  effectiveCwd: string,
  scope: AgentScope,
  sessionId: string | null,
  deps: ExecutorDeps,
): ProjectAgentExecutionResolution | { error: string } {
  const targetIdentities = executionTargetIdentities(params);
  const embeddedTargets = [
    ...new Set(
      targetIdentities.map((identity) => identity.normalized).filter(isEmbeddedProjectAgentName),
    ),
  ];
  const whitespaceEmbeddedTargets = targetIdentities.filter(
    (identity) =>
      identity.raw !== identity.normalized && isEmbeddedProjectAgentName(identity.normalized),
  );
  if (whitespaceEmbeddedTargets.length > 0) {
    const details = whitespaceEmbeddedTargets
      .map((identity) => `'${identity.raw}' (use '${identity.normalized}')`)
      .join(", ");
    return projectExecutionError(
      `TLH project-agent execution rejected: target identity has surrounding whitespace: ${details}.`,
    );
  }

  // Ordinary canonical roles retain their normal user/project discovery path.
  // A project target must never fall through to that path: doing so would let
  // a same-name profile/package definition execute without the snapshot.
  if (embeddedTargets.length === 0) {
    return {
      params,
      effectiveCwd,
      discovered: deps.discoverAgents(effectiveCwd, scope),
    };
  }

  const requestedScope =
    typeof params.agentScope === "string" ? params.agentScope.trim() : params.agentScope;
  if (params.agentScope !== undefined && requestedScope !== "" && requestedScope !== "project") {
    return projectExecutionError(
      `TLH project-agent execution requires agentScope: "project"; received '${String(requestedScope)}'.`,
    );
  }

  let rawAccess: ProjectAgentAccess | undefined;
  try {
    rawAccess = deps.getProjectAgentAccess?.({
      cwd: effectiveCwd,
      sessionId,
      targetNames: executionTargetNames(params),
    });
  } catch {
    return projectExecutionError(
      "TLH project-agent execution was rejected: the active snapshot capability is unavailable.",
    );
  }
  const access = normalizeProjectAgentAccess(rawAccess);
  if (!access) {
    return projectExecutionError(
      "TLH project-agent execution was rejected: the active snapshot capability is unavailable or invalid.",
    );
  }

  let manifest: ProjectAgentSnapshotManifest;
  try {
    manifest = resolveProjectAgentSnapshot(access.capability, access.expected);
  } catch {
    return projectExecutionError(
      "TLH project-agent execution was rejected: the active snapshot capability is invalid.",
    );
  }

  const manifestNames = new Set([
    ...manifest.entries.map((entry) => entry.agent.name),
    ...manifest.tombstones,
  ]);
  const missingTargets = embeddedTargets.filter((target) => !manifestNames.has(target));
  if (missingTargets.length > 0) {
    return projectExecutionError(
      `TLH project-agent execution is unavailable for ${missingTargets.join(", ")}; no matching active snapshot entry exists.`,
    );
  }

  if (access.canInitiate !== true) {
    return projectExecutionError(
      `TLH project-agent execution requires the architect or disabled primary mode. Target(s): ${embeddedTargets.join(", ")}.`,
    );
  }
  if (sessionId === null || sessionId !== manifest.provenance.sessionId) {
    return projectExecutionError(
      "TLH project-agent execution was rejected because the active snapshot does not belong to this session.",
    );
  }

  const cwdValidation = validateProjectAgentCwdContainment(
    manifest.provenance.projectRoot,
    effectiveCwd,
    (params.tasks ?? []).map((task) => task.cwd),
  );
  if (!cwdValidation.valid) {
    return projectExecutionError(`TLH project-agent execution blocked: ${cwdValidation.reason}`);
  }
  const trustedRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
  const manifestRoot = resolveCanonicalGitWorktreeRoot(manifest.provenance.projectRoot);
  if (
    !trustedRoot ||
    !manifestRoot ||
    trustedRoot !== cwdValidation.canonicalRoot ||
    manifestRoot !== trustedRoot
  ) {
    return projectExecutionError(
      "TLH project-agent execution was rejected because the execution cwd is not in the trusted snapshot worktree.",
    );
  }
  for (const [index, taskCwd] of cwdValidation.canonicalTaskCwds.entries()) {
    const taskRoot = resolveCanonicalGitWorktreeRoot(taskCwd);
    if (!taskRoot || taskRoot !== trustedRoot) {
      return projectExecutionError(
        `TLH project-agent execution blocked: task ${index + 1} cwd is not in the one trusted snapshot worktree.`,
      );
    }
  }

  for (const target of embeddedTargets) {
    if (manifest.tombstones.includes(target)) {
      return projectExecutionError(
        `TLH project-agent execution is blocked for ${target}; the active snapshot tombstone prevents profile fallback.`,
      );
    }
  }

  const canonicalParams: SubagentParamsLike = {
    ...params,
    agentScope: "project",
    cwd: cwdValidation.canonicalCwd,
    ...(params.tasks
      ? {
          tasks: params.tasks.map((task, index) => ({
            ...task,
            cwd: cwdValidation.canonicalTaskCwds[index],
          })),
        }
      : {}),
  };
  let discovered: ProjectAgentExecutionResolution["discovered"];
  try {
    // This is the sole project execution discovery seam: canonical packaged
    // roles plus the exact immutable snapshot, never generic project sources.
    discovered = discoverAgentsWithProjectSnapshot(
      cwdValidation.canonicalCwd,
      access.capability,
      access.expected,
    );
  } catch (error) {
    return projectExecutionError(error instanceof Error ? error.message : String(error));
  }

  if (!discovered.projectSnapshot) {
    return projectExecutionError(
      "TLH project-agent execution was rejected because snapshot metadata was unavailable.",
    );
  }

  for (const target of embeddedTargets) {
    const expectedEntry = manifest.entries.find((entry) => entry.agent.name === target);
    const selectedAgent = discovered.agents.find((agent) => agent.name === target);
    const selectedMetadata = discovered.projectSnapshot.entries.find(
      (entry) => entry.name === target,
    );
    const identityError = expectedEntry
      ? projectAgentEntryIdentityError(manifestRoot!, expectedEntry)
      : "the snapshot entry is missing";
    if (
      !expectedEntry ||
      identityError ||
      !selectedAgent ||
      selectedAgent.source !== "project" ||
      selectedAgent.filePath !== expectedEntry.agent.filePath ||
      !selectedMetadata ||
      selectedMetadata.digest !== expectedEntry.digest ||
      !projectAgentConfigMatches(selectedAgent, expectedEntry.agent)
    ) {
      return projectExecutionError(
        `TLH project-agent execution was rejected for ${target}: ${identityError ?? "the selected snapshot entry or digest is not active"}.`,
      );
    }
  }

  const projectAgentCaptures = embeddedTargets.flatMap((target) => {
    const selectedAgent = discovered.agents.find((agent) => agent.name === target);
    if (!selectedAgent) return [];
    try {
      return [createProjectAgentRunCapture(manifest, selectedAgent)];
    } catch {
      return [];
    }
  });
  if (projectAgentCaptures.length !== embeddedTargets.length) {
    return projectExecutionError(
      "TLH project-agent execution was rejected: an approved project-agent capture could not be created.",
    );
  }

  return {
    params: canonicalParams,
    effectiveCwd: cwdValidation.canonicalCwd,
    projectAgentCapability: access.capability,
    projectAgentCaptures,
    discovered,
  };
}

export interface AuthorizedProjectAgentRun {
  capture: ProjectAgentRunCapture;
  agentConfig: AgentConfig;
  capability: ProjectAgentSnapshotCapability;
  /** Canonical existing cwd used for discovery and process start. */
  canonicalCwd: string;
  /** Whether the source run reference was absent and a fresh generation was bound. */
  freshRebind: boolean;
  digestChangeNotice?: string;
  modelScope?: ModelScopeConfig;
}

export function projectRunAuthorizationError(message: string): Error {
  return new Error(`TLH project-agent control rejected: ${message}`);
}

function requestedProjectActionRunId(
  params: Pick<SubagentParamsLike, "id" | "dir">,
): string | undefined {
  const id = params.id?.trim();
  if (id) return id;
  const dir = params.dir?.trim();
  return dir ? path.basename(path.resolve(dir)) : undefined;
}

export function lookupPrivateProjectActionReference(
  params: Pick<SubagentParamsLike, "id" | "dir">,
): ProjectAgentRunReferenceLookup {
  const runId = requestedProjectActionRunId(params);
  return runId ? lookupProjectAgentRunReference(runId) : { status: "missing" };
}

/** Recognize persisted project markers as a deny-only signal, even when malformed. */
export function hasProjectAgentControlMarker(value: unknown): boolean {
  if (!isRecordValue(value)) return false;
  if (
    Object.hasOwn(value, "projectAgent") ||
    Object.hasOwn(value, "projectAgents") ||
    Object.hasOwn(value, "projectAgentMarker")
  )
    return true;
  for (const field of ["steps", "results", "children", "nestedChildren"] as const) {
    const children = value[field];
    if (Array.isArray(children) && children.some((child) => hasProjectAgentControlMarker(child))) {
      return true;
    }
  }
  return false;
}

/** Detect malformed persisted captures without treating a valid capture as corrupt. */
export function hasMalformedProjectAgentControlMarker(value: unknown): boolean {
  if (!isRecordValue(value)) return false;
  if (Object.hasOwn(value, "projectAgentMarker")) return true;
  if (
    Object.hasOwn(value, "projectAgent") &&
    !normalizeProjectAgentRunCapture(value.projectAgent)
  ) {
    return true;
  }
  if (Object.hasOwn(value, "projectAgents")) {
    const captures = value.projectAgents;
    if (captures !== undefined) {
      if (!Array.isArray(captures) || captures.length === 0) return true;
      if (captures.some((capture) => !normalizeProjectAgentRunCapture(capture))) return true;
    }
  }
  for (const field of ["steps", "results", "children", "nestedChildren"] as const) {
    const children = value[field];
    if (
      Array.isArray(children) &&
      children.some((child) => hasMalformedProjectAgentControlMarker(child))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Async tracker projections always include `projectAgents`, including as
 * `undefined` for ordinary jobs. In-memory state therefore uses semantic
 * capture presence rather than persisted key-presence detection.
 */
export function hasInMemoryProjectAgentCapture(value: unknown): boolean {
  return (
    isRecordValue(value) && Array.isArray(value.projectAgents) && value.projectAgents.length > 0
  );
}

export function rejectMissingPrivateProjectReference(
  lookup: ProjectAgentRunReferenceLookup,
  target: unknown,
  options: { allowFreshResume?: boolean } = {},
): void {
  const freshChildCapture =
    isRecordValue(target) &&
    Object.hasOwn(target, "projectAgent") &&
    normalizeProjectAgentRunCapture(target.projectAgent) !== undefined;
  if (
    lookup.status === "missing" &&
    !(options.allowFreshResume && freshChildCapture) &&
    hasProjectAgentControlMarker(target)
  ) {
    throw projectRunAuthorizationError(
      "the persisted run carries a project-agent marker, but its process-private reference is unavailable; refusing profile fallback.",
    );
  }
}

export function privateProjectCaptureForTarget(
  lookup: ProjectAgentRunReferenceLookup,
  target: { runId: string; agent: string; projectAgent?: unknown },
): ProjectAgentRunCapture | undefined {
  if (lookup.status === "missing") return undefined;
  if (lookup.status === "ambiguous") {
    throw projectRunAuthorizationError(
      `the requested run id is ambiguous in the retained project-agent registry (${lookup.runIds.join(", ")}). Provide a full run id.`,
    );
  }
  if (target.runId !== lookup.runId) {
    throw projectRunAuthorizationError(
      "the resolved run id does not match the retained run reference.",
    );
  }
  const retainedCapture = lookup.captures.find(
    (capture) => capture.provenance.agent === target.agent,
  );
  if (!retainedCapture) {
    throw projectRunAuthorizationError(
      `the selected child '${target.agent}' has no matching retained project-agent capture; ordinary siblings in a mixed run cannot be controlled safely.`,
    );
  }
  const persistedCapture = normalizeProjectAgentRunCapture(target.projectAgent);
  if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
    throw projectRunAuthorizationError(
      "the selected child is missing or has corrupt persisted project-agent provenance/config.",
    );
  }
  return retainedCapture;
}

export function requirePersistedProjectCaptureForTarget(
  lookup: ProjectAgentRunReferenceLookup,
  target: {
    runId: string;
    agent: string;
    projectAgent?: unknown;
    state: AsyncStatus["state"];
    index: number;
    asyncDir?: string;
  },
): ProjectAgentRunCapture | undefined {
  const retainedCapture = privateProjectCaptureForTarget(lookup, target);
  if (!retainedCapture || !("asyncDir" in target) || !target.asyncDir) return retainedCapture;
  let status: AsyncStatus | null;
  try {
    status = readStatus(target.asyncDir);
  } catch {
    throw projectRunAuthorizationError("the persisted control status is unavailable.");
  }
  const persistedCapture = normalizeProjectAgentRunCapture(
    status?.steps?.[target.index]?.projectAgent,
  );
  if (!persistedCapture || !projectAgentRunCaptureEquals(persistedCapture, retainedCapture)) {
    throw projectRunAuthorizationError(
      "the selected child is missing or has corrupt persisted project-agent provenance/config.",
    );
  }
  return retainedCapture;
}

/**
 * Reauthorize a persisted project run without consulting mutable .tlh files.
 * The active capability proves current trusted project context; the run
 * reference proves that the original generation is still retained in this
 * process. Persisted config is checked against the private capture and never
 * used as executable authority on its own.
 */
async function authorizeRetainedProjectAgentRun(input: {
  target: {
    runId: string;
    agent: string;
    cwd?: string;
    projectAgent?: unknown;
  };
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<AuthorizedProjectAgentRun> {
  const persisted = normalizeProjectAgentRunCapture(input.target.projectAgent);
  if (!persisted) throw projectRunAuthorizationError("persisted provenance/config is corrupt.");
  if (persisted.provenance.agent !== input.target.agent) {
    throw projectRunAuthorizationError("the selected entry does not match persisted provenance.");
  }

  const currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
  if (currentSessionId !== persisted.provenance.sessionId) {
    throw projectRunAuthorizationError("the run belongs to a different session.");
  }
  const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
  const persistedRoot = resolveCanonicalGitWorktreeRoot(persisted.provenance.projectRoot);
  if (!currentRoot || !persistedRoot || currentRoot !== persistedRoot) {
    throw projectRunAuthorizationError(
      "the current canonical project root does not match the run.",
    );
  }
  if (typeof input.target.cwd !== "string") {
    throw projectRunAuthorizationError("the persisted execution cwd is missing.");
  }
  const cwdValidation = validateProjectAgentCwdContainment(
    persisted.provenance.projectRoot,
    input.target.cwd,
  );
  if (!cwdValidation.valid) throw projectRunAuthorizationError(cwdValidation.reason);
  const targetRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
  if (!targetRoot || targetRoot !== persistedRoot) {
    throw projectRunAuthorizationError(
      "the persisted execution cwd is not inside the one trusted project worktree.",
    );
  }

  let activeAccess: ProjectAgentAccess | undefined;
  try {
    activeAccess = normalizeProjectAgentAccess(
      input.deps.getProjectAgentAccess?.({
        cwd: input.ctx.cwd,
        sessionId: currentSessionId,
        targetNames: [input.target.agent],
      }),
    );
  } catch {
    activeAccess = undefined;
  }
  if (!activeAccess) {
    throw projectRunAuthorizationError("the current trusted project snapshot is unavailable.");
  }
  if (!activeAccess.architect) {
    throw projectRunAuthorizationError("the current primary agent is not the architect.");
  }
  let activeManifest: ProjectAgentSnapshotManifest;
  try {
    activeManifest = resolveProjectAgentSnapshot(activeAccess.capability, activeAccess.expected);
  } catch {
    throw projectRunAuthorizationError("the current snapshot capability is invalid.");
  }
  const activeManifestRoot = resolveCanonicalGitWorktreeRoot(activeManifest.provenance.projectRoot);
  if (
    !activeManifestRoot ||
    activeManifestRoot !== currentRoot ||
    activeManifest.provenance.sessionId !== currentSessionId ||
    activeManifest.provenance.processInstanceId !== persisted.provenance.processInstanceId
  ) {
    throw projectRunAuthorizationError("current root, session, or process identity is stale.");
  }
  if (typeof activeAccess.reauthorize !== "function") {
    throw projectRunAuthorizationError("current project trust cannot be reauthorized safely.");
  }
  let trusted = false;
  try {
    trusted = await activeAccess.reauthorize();
  } catch {
    trusted = false;
  }
  if (!trusted) throw projectRunAuthorizationError("current project trust has been revoked.");

  let retained: ReturnType<typeof resolveProjectAgentRunReference>;
  try {
    retained = resolveProjectAgentRunReference(input.target.runId, persisted.provenance);
  } catch {
    throw projectRunAuthorizationError(
      "the retained project-agent generation is missing or does not match this run.",
    );
  }
  const capture = retained.captures.find(
    (candidate) => candidate.provenance.agent === persisted.provenance.agent,
  );
  if (
    !capture ||
    !projectAgentRunCaptureEquals(persisted, capture) ||
    capture.provenance.source !== "project" ||
    capture.provenance.digest !== persisted.provenance.digest
  ) {
    throw projectRunAuthorizationError(
      "the selected source, digest, or captured config is corrupt.",
    );
  }
  const entry = retained.manifest.entries.find(
    (candidate) => candidate.agent.name === persisted.provenance.agent,
  );
  const identityError = entry
    ? projectAgentEntryIdentityError(persistedRoot, entry)
    : "the retained generation entry is missing";
  if (
    !entry ||
    identityError ||
    entry.digest !== persisted.provenance.digest ||
    entry.agent.source !== "project" ||
    entry.agent.filePath !== capture.config.filePath
  ) {
    throw projectRunAuthorizationError(
      `the retained generation entry or digest is invalid${identityError ? `: ${identityError}` : "."}`,
    );
  }
  let modelScope: ModelScopeConfig | undefined;
  try {
    // Re-read only the current profile-side model scope. The returned agent
    // list is intentionally ignored: captured project config remains the sole
    // executable source for this continuation.
    modelScope = discoverAgentsWithProjectSnapshot(
      cwdValidation.canonicalCwd,
      activeAccess.capability,
      activeAccess.expected,
    ).modelScope;
  } catch {
    throw projectRunAuthorizationError("the current profile model scope is unavailable.");
  }
  return {
    capture,
    agentConfig: capture.config,
    capability: retained.capability,
    canonicalCwd: cwdValidation.canonicalCwd,
    freshRebind: false,
    modelScope,
  };
}

/**
 * Authorize a persisted project run for either same-process continuation or a
 * fresh process-starting rebind. Persisted captures are metadata only: when
 * the private generation is unavailable, executable config comes exclusively
 * from the current trusted loader result.
 */
export async function authorizePersistedProjectAgentRun(input: {
  target: {
    runId: string;
    agent: string;
    cwd?: string;
    projectAgent?: unknown;
  };
  ctx: ExtensionContext;
  deps: ExecutorDeps;
}): Promise<AuthorizedProjectAgentRun> {
  const persisted = normalizeProjectAgentRunCapture(input.target.projectAgent);
  if (!persisted) throw projectRunAuthorizationError("persisted provenance/config is corrupt.");
  if (persisted.provenance.agent !== input.target.agent) {
    throw projectRunAuthorizationError("the selected entry does not match persisted provenance.");
  }

  const currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
  if (currentSessionId !== persisted.provenance.sessionId) {
    throw projectRunAuthorizationError("the run belongs to a different session.");
  }
  const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
  const persistedRoot = resolveCanonicalGitWorktreeRoot(persisted.provenance.projectRoot);
  if (!currentRoot || !persistedRoot || currentRoot !== persistedRoot) {
    throw projectRunAuthorizationError(
      "the current canonical project root does not match the run.",
    );
  }
  if (typeof input.target.cwd !== "string") {
    throw projectRunAuthorizationError("the persisted execution cwd is missing.");
  }
  const cwdValidation = validateProjectAgentCwdContainment(
    persisted.provenance.projectRoot,
    input.target.cwd,
  );
  if (!cwdValidation.valid) throw projectRunAuthorizationError(cwdValidation.reason);
  const targetRoot = resolveCanonicalGitWorktreeRoot(cwdValidation.canonicalCwd);
  if (!targetRoot || targetRoot !== persistedRoot) {
    throw projectRunAuthorizationError(
      "the persisted execution cwd is not inside the one trusted project worktree.",
    );
  }

  let activeAccess: ProjectAgentAccess | undefined;
  try {
    activeAccess = normalizeProjectAgentAccess(
      input.deps.getProjectAgentAccess?.({
        cwd: input.ctx.cwd,
        sessionId: currentSessionId,
        targetNames: [input.target.agent],
      }),
    );
  } catch {
    activeAccess = undefined;
  }
  if (!activeAccess) {
    throw projectRunAuthorizationError("the current trusted project snapshot is unavailable.");
  }
  if (!activeAccess.architect) {
    throw projectRunAuthorizationError("the current primary agent is not the architect.");
  }
  let activeManifest: ProjectAgentSnapshotManifest;
  try {
    activeManifest = resolveProjectAgentSnapshot(activeAccess.capability, activeAccess.expected);
  } catch {
    throw projectRunAuthorizationError("the current snapshot capability is invalid.");
  }
  const activeManifestRoot = resolveCanonicalGitWorktreeRoot(activeManifest.provenance.projectRoot);
  if (
    !activeManifestRoot ||
    activeManifestRoot !== currentRoot ||
    activeManifest.provenance.sessionId !== currentSessionId
  ) {
    throw projectRunAuthorizationError("current root or session identity is stale.");
  }
  if (typeof activeAccess.reauthorize !== "function") {
    throw projectRunAuthorizationError("current project trust cannot be reauthorized safely.");
  }
  let trusted = false;
  try {
    trusted = await activeAccess.reauthorize();
  } catch {
    trusted = false;
  }
  if (!trusted) throw projectRunAuthorizationError("current project trust has been revoked.");

  const privateReference = lookupProjectAgentRunReference(input.target.runId);
  if (privateReference.status === "ambiguous") {
    throw projectRunAuthorizationError(
      `the requested run id is ambiguous in the retained project-agent registry (${privateReference.runIds.join(", ")}). Provide a full run id.`,
    );
  }
  if (privateReference.status === "found") {
    return authorizeRetainedProjectAgentRun(input);
  }

  // A missing reference in the same process is not permission to reconstruct
  // the old generation from persisted JSON. The explicit rebind is reserved
  // for a process-starting continuation with a different process identity.
  if (activeManifest.provenance.processInstanceId === persisted.provenance.processInstanceId) {
    throw projectRunAuthorizationError(
      "the persisted project-agent run has no process-private reference; refusing profile fallback.",
    );
  }
  if (typeof activeAccess.rebind !== "function") {
    throw projectRunAuthorizationError(
      "the prior process-private project-agent reference is unavailable and the current runtime cannot perform a fresh rebind.",
    );
  }

  let rebound: ProjectAgentRebindResult | undefined;
  try {
    rebound = await activeAccess.rebind({
      projectRoot: persistedRoot,
      cwd: cwdValidation.canonicalCwd,
      sessionId: currentSessionId,
      agent: input.target.agent,
    });
  } catch {
    rebound = undefined;
  }
  if (!rebound) {
    throw projectRunAuthorizationError(
      "the current project definition could not be reauthorized safely; verify trust and the canonical custom-agent file.",
    );
  }

  let reboundManifest: ProjectAgentSnapshotManifest;
  try {
    reboundManifest = resolveProjectAgentSnapshot(rebound.capability, rebound.expected);
  } catch {
    throw projectRunAuthorizationError("the fresh project-agent snapshot capability is invalid.");
  }
  const reboundRoot = resolveCanonicalGitWorktreeRoot(reboundManifest.provenance.projectRoot);
  if (
    !reboundRoot ||
    reboundRoot !== currentRoot ||
    reboundManifest.provenance.sessionId !== currentSessionId ||
    reboundManifest.provenance.processInstanceId !== activeManifest.provenance.processInstanceId
  ) {
    throw projectRunAuthorizationError(
      "the fresh project-agent snapshot has stale root, session, or process identity.",
    );
  }
  const reboundCapture = normalizeProjectAgentRunCapture(rebound.capture);
  if (!reboundCapture || reboundCapture.provenance.agent !== input.target.agent) {
    throw projectRunAuthorizationError("the fresh project-agent capture is invalid.");
  }
  const reboundEntry = reboundManifest.entries.find(
    (candidate) => candidate.agent.name === input.target.agent,
  );
  const identityError = reboundEntry
    ? projectAgentEntryIdentityError(reboundRoot, reboundEntry)
    : "the current custom-agent definition is missing";
  if (!reboundEntry || identityError || reboundEntry.digest !== reboundCapture.provenance.digest) {
    throw projectRunAuthorizationError(
      `the current project-agent definition is unsafe${identityError ? `: ${identityError}` : "."}`,
    );
  }
  let capture: ProjectAgentRunCapture;
  try {
    capture = createProjectAgentRunCapture(reboundManifest, reboundEntry.agent);
  } catch {
    throw projectRunAuthorizationError("the current project-agent capture could not be created.");
  }
  if (!projectAgentRunCaptureEquals(reboundCapture, capture)) {
    throw projectRunAuthorizationError(
      "the fresh project-agent capture does not match the current validated definition.",
    );
  }
  let modelScope: ModelScopeConfig | undefined;
  try {
    modelScope = discoverAgentsWithProjectSnapshot(
      cwdValidation.canonicalCwd,
      rebound.capability,
      rebound.expected,
    ).modelScope;
  } catch {
    throw projectRunAuthorizationError("the current profile model scope is unavailable.");
  }
  const digestChangeNotice =
    persisted.provenance.digest !== capture.provenance.digest
      ? `Project agent '${input.target.agent}' changed since the original run (digest ${persisted.provenance.digest} → ${capture.provenance.digest}). The resumed child uses the current validated definition; review the change if it was unexpected.`
      : undefined;
  return {
    capture,
    agentConfig: capture.config,
    capability: rebound.capability,
    canonicalCwd: cwdValidation.canonicalCwd,
    freshRebind: true,
    ...(digestChangeNotice ? { digestChangeNotice } : {}),
    modelScope,
  };
}
