import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  embeddedSlugFromName,
  loadProjectAgent,
  normalizeProjectAgentIdentity,
  resolveCanonicalGitWorktreeRoot,
  validateProjectAgentCwdContainment,
  type ProjectAgentIdentity,
  type ProjectAgentTrustStore,
} from "../../agents/project-agent-loader.ts";
import type { AgentConfig, AgentDiscoveryDiagnostic, AgentScope } from "../../agents/agents.ts";
import type { ModelScopeConfig } from "./model-scope.ts";
import type { ExecutorDeps, ProjectAgentAccess, SubagentParamsLike } from "./executor-types.ts";

const EMBEDDED_TARGET_PATTERN = /^embedded\.([a-z0-9][a-z0-9-]*)$/;

export interface ProjectAgentExecutionResolution {
  params: SubagentParamsLike;
  effectiveCwd: string;
  projectAgentIdentities?: readonly ProjectAgentIdentity[];
  discovered: {
    agents: AgentConfig[];
    modelScope?: ModelScopeConfig;
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
  };
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeProjectAgentAccess(value: unknown): ProjectAgentAccess | undefined {
  if (!isRecordValue(value) || typeof value.architect !== "boolean") return undefined;
  const canInitiate = typeof value.canInitiate === "boolean" ? value.canInitiate : value.architect;
  const agentDir = typeof value.agentDir === "string" ? value.agentDir : undefined;
  const trustStore = value.trustStore as ProjectAgentTrustStore | undefined;
  const createProjectTrustStore =
    typeof value.createProjectTrustStore === "function"
      ? (value.createProjectTrustStore as (agentDir: string) => ProjectAgentTrustStore)
      : undefined;
  if (trustStore !== undefined && typeof trustStore.getEntry !== "function") return undefined;
  return {
    architect: value.architect,
    canInitiate,
    ...(agentDir ? { agentDir } : {}),
    ...(trustStore ? { trustStore } : {}),
    ...(createProjectTrustStore ? { createProjectTrustStore } : {}),
  };
}

function projectExecutionError(message: string): { error: string } {
  return { error: message };
}

function targetCwd(effectiveCwd: string, taskCwd: string | undefined): string {
  return taskCwd ? path.resolve(effectiveCwd, taskCwd) : effectiveCwd;
}

function targetKey(name: string, cwd: string): string {
  return `${name}\0${cwd}`;
}

function projectAgentDefinitionKey(value: Awaited<ReturnType<typeof loadProjectAgent>>): string {
  const normalize = (input: string): string =>
    process.platform === "win32" ? path.normalize(input).toLowerCase() : path.normalize(input);
  return `${normalize(value.identity.root)}\0${normalize(value.agent.filePath)}`;
}

function projectAgentTrustOptions(access: ProjectAgentAccess): {
  agentDir?: string;
  trustStore?: ProjectAgentTrustStore;
  createProjectTrustStore?: (agentDir: string) => ProjectAgentTrustStore;
} {
  return {
    ...(access.agentDir ? { agentDir: access.agentDir } : {}),
    ...(access.trustStore ? { trustStore: access.trustStore } : {}),
    ...(access.createProjectTrustStore
      ? { createProjectTrustStore: access.createProjectTrustStore }
      : {}),
  };
}

function addProjectAgents(
  discovered: ProjectAgentExecutionResolution["discovered"],
  loaded: readonly { agent: AgentConfig }[],
): ProjectAgentExecutionResolution["discovered"] {
  const byName = new Map(discovered.agents.map((agent) => [agent.name, agent]));
  for (const entry of loaded) byName.set(entry.agent.name, entry.agent);
  return { ...discovered, agents: [...byName.values()] };
}

export async function resolveProjectAgentExecution(
  params: SubagentParamsLike,
  effectiveCwd: string,
  scope: AgentScope,
  _sessionId: string | null,
  deps: ExecutorDeps,
): Promise<ProjectAgentExecutionResolution | { error: string }> {
  const names = [
    ...(typeof params.agent === "string" ? [params.agent] : []),
    ...(params.tasks ?? []).map((task) => task.agent),
  ];
  const whitespaceTargets = names.filter(
    (name) =>
      typeof name === "string" && name.trim() !== name && EMBEDDED_TARGET_PATTERN.test(name.trim()),
  );
  if (whitespaceTargets.length > 0) {
    return projectExecutionError(
      `TLH project-agent execution rejected: target identity has surrounding whitespace: ${whitespaceTargets.map((name) => `'${name}'`).join(", ")}.`,
    );
  }

  const embeddedTargets = [...new Set(names.filter((name) => EMBEDDED_TARGET_PATTERN.test(name)))];
  const discovered = deps.discoverAgents(effectiveCwd, scope);

  if (embeddedTargets.length === 0) {
    return { params, effectiveCwd, discovered };
  }
  let access: ProjectAgentAccess | undefined;
  try {
    access = normalizeProjectAgentAccess(
      deps.getProjectAgentAccess?.({
        cwd: effectiveCwd,
        sessionId: _sessionId,
        targetNames: embeddedTargets,
      }),
    );
  } catch {
    access = undefined;
  }

  if (!access) {
    return projectExecutionError(
      "TLH project-agent execution was rejected: project-agent authorization is unavailable.",
    );
  }
  if (access.canInitiate !== true) {
    return projectExecutionError(
      `TLH project-agent execution requires the architect or disabled primary mode. Target(s): ${embeddedTargets.join(", ")}.`,
    );
  }

  const requestedTargets = [
    ...(typeof params.agent === "string" && embeddedTargets.includes(params.agent)
      ? [{ name: params.agent, cwd: effectiveCwd }]
      : []),
    ...(params.tasks ?? [])
      .filter((task) => embeddedTargets.includes(task.agent))
      .map((task) => ({ name: task.agent, cwd: targetCwd(effectiveCwd, task.cwd) })),
  ];
  const loadedByTarget = new Map<string, Awaited<ReturnType<typeof loadProjectAgent>>>();
  const loadedByName = new Map<string, Awaited<ReturnType<typeof loadProjectAgent>>>();

  for (const { name, cwd } of requestedTargets) {
    const key = targetKey(name, cwd);
    if (loadedByTarget.has(key)) continue;
    const slug = embeddedSlugFromName(name);
    if (!slug) return projectExecutionError(`Invalid embedded project-agent target '${name}'.`);
    let loaded: Awaited<ReturnType<typeof loadProjectAgent>>;
    try {
      loaded = await loadProjectAgent({ cwd, slug, ...projectAgentTrustOptions(access) });
    } catch (error) {
      return projectExecutionError(error instanceof Error ? error.message : String(error));
    }
    const prior = loadedByName.get(name);
    if (prior && projectAgentDefinitionKey(prior) !== projectAgentDefinitionKey(loaded)) {
      return projectExecutionError(
        `TLH project-agent execution rejected: ${name} resolves to multiple canonical definitions in one dispatch.`,
      );
    }
    loadedByTarget.set(key, loaded);
    if (!prior) loadedByName.set(name, loaded);
  }

  const identities = [...loadedByTarget.values()].map(({ identity }) => identity);

  const nextParams: SubagentParamsLike = {
    ...params,
    cwd: effectiveCwd,
    ...(params.tasks
      ? {
          tasks: params.tasks.map((task) => {
            if (!embeddedTargets.includes(task.agent)) return task;
            const loaded = loadedByTarget.get(
              targetKey(task.agent, targetCwd(effectiveCwd, task.cwd)),
            );
            return loaded ? { ...task, cwd: loaded.identity.cwd } : task;
          }),
        }
      : {}),
  };

  const nextDiscovered = addProjectAgents(
    discovered,
    [...loadedByName.values()].map(({ agent }) => ({ agent })),
  );
  return {
    params: nextParams,
    effectiveCwd,
    projectAgentIdentities: identities,
    discovered: nextDiscovered,
  };
}

export function projectRunAuthorizationError(message: string): Error {
  return new Error(`TLH project-agent control rejected: ${message}`);
}

export function hasMalformedProjectAgentControlMarker(value: unknown): boolean {
  if (!isRecordValue(value) || !Object.hasOwn(value, "projectAgent")) return false;
  return normalizeProjectAgentIdentity(value.projectAgent) === undefined;
}

export interface AuthorizedProjectAgentRun {
  identity: ProjectAgentIdentity;
  agentConfig: AgentConfig;
  canonicalCwd: string;
  modelScope?: ModelScopeConfig;
}

export async function authorizePersistedProjectAgentRun(input: {
  target: {
    runId: string;
    agent: string;
    cwd?: string;
    projectAgent?: unknown;
  };
  ctx: ExtensionContext;
  deps: ExecutorDeps;
  requireArchitect?: boolean;
}): Promise<AuthorizedProjectAgentRun> {
  const identity = normalizeProjectAgentIdentity(input.target.projectAgent);
  if (!identity)
    throw projectRunAuthorizationError("persisted project-agent identity is missing or invalid.");

  const slug = embeddedSlugFromName(input.target.agent);
  if (!slug || slug !== identity.slug) {
    throw projectRunAuthorizationError(
      "persisted project-agent slug does not match the selected child.",
    );
  }

  const resolvedRoot = resolveCanonicalGitWorktreeRoot(identity.cwd);
  const persistedRoot = resolveCanonicalGitWorktreeRoot(identity.root);
  const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
  if (
    !resolvedRoot ||
    !persistedRoot ||
    !currentRoot ||
    resolvedRoot !== persistedRoot ||
    currentRoot !== persistedRoot
  ) {
    throw projectRunAuthorizationError(
      "the current canonical project root does not match the run.",
    );
  }

  const cwdValidation = validateProjectAgentCwdContainment(
    identity.root,
    input.target.cwd ?? identity.cwd,
  );
  if (!cwdValidation.valid || cwdValidation.canonicalCwd !== identity.cwd) {
    throw projectRunAuthorizationError(
      cwdValidation.valid ? "the persisted execution cwd changed." : cwdValidation.reason,
    );
  }

  const access = normalizeProjectAgentAccess(
    input.deps.getProjectAgentAccess?.({
      cwd: input.ctx.cwd,
      sessionId: resolveSessionId(input.ctx),
      targetNames: [input.target.agent],
    }),
  );
  if (input.requireArchitect !== false && !access?.architect) {
    throw projectRunAuthorizationError("the current primary agent is not the architect.");
  }
  if (!access) {
    throw projectRunAuthorizationError("project-agent authorization is unavailable.");
  }

  let loaded: Awaited<ReturnType<typeof loadProjectAgent>>;
  try {
    loaded = await loadProjectAgent({
      cwd: identity.cwd,
      slug,
      ...projectAgentTrustOptions(access),
    });
  } catch (error) {
    throw projectRunAuthorizationError(error instanceof Error ? error.message : String(error));
  }

  if (
    identity.slug !== loaded.identity.slug ||
    identity.root !== loaded.identity.root ||
    identity.cwd !== loaded.identity.cwd
  ) {
    throw projectRunAuthorizationError(
      "the project-agent root or cwd changed while reauthorizing.",
    );
  }

  const discovered = input.deps.discoverAgents(identity.cwd, "user");
  return {
    identity: loaded.identity,
    agentConfig: loaded.agent,
    canonicalCwd: loaded.identity.cwd,
    modelScope: discovered.modelScope,
  };
}

function resolveSessionId(ctx: ExtensionContext): string | null {
  try {
    const value = ctx.sessionManager.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
