import * as path from "node:path";
import { embeddedSlugFromName, loadProjectAgent, normalizeProjectAgentIdentity, resolveCanonicalGitWorktreeRoot, validateProjectAgentCwdContainment, } from "../../agents/project-agent-loader.js";
const EMBEDDED_TARGET_PATTERN = /^embedded\.([a-z0-9][a-z0-9-]*)$/;
export function isRecordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeProjectAgentAccess(value) {
    if (!isRecordValue(value) || typeof value.architect !== "boolean")
        return undefined;
    const canInitiate = typeof value.canInitiate === "boolean" ? value.canInitiate : value.architect;
    const agentDir = typeof value.agentDir === "string" ? value.agentDir : undefined;
    const trustStore = value.trustStore;
    const createProjectTrustStore = typeof value.createProjectTrustStore === "function"
        ? value.createProjectTrustStore
        : undefined;
    if (trustStore !== undefined && typeof trustStore.getEntry !== "function")
        return undefined;
    return {
        architect: value.architect,
        canInitiate,
        ...(agentDir ? { agentDir } : {}),
        ...(trustStore ? { trustStore } : {}),
        ...(createProjectTrustStore ? { createProjectTrustStore } : {}),
    };
}
function projectExecutionError(message) {
    return { error: message };
}
function targetCwd(effectiveCwd, taskCwd) {
    return taskCwd ? path.resolve(effectiveCwd, taskCwd) : effectiveCwd;
}
function targetKey(name, cwd) {
    return `${name}\0${cwd}`;
}
function projectAgentDefinitionKey(value) {
    const normalize = (input) => process.platform === "win32" ? path.normalize(input).toLowerCase() : path.normalize(input);
    return `${normalize(value.identity.root)}\0${normalize(value.agent.filePath)}`;
}
function projectAgentTrustOptions(access) {
    return {
        ...(access.agentDir ? { agentDir: access.agentDir } : {}),
        ...(access.trustStore ? { trustStore: access.trustStore } : {}),
        ...(access.createProjectTrustStore
            ? { createProjectTrustStore: access.createProjectTrustStore }
            : {}),
    };
}
function addProjectAgents(discovered, loaded) {
    const byName = new Map(discovered.agents.map((agent) => [agent.name, agent]));
    for (const entry of loaded)
        byName.set(entry.agent.name, entry.agent);
    return { ...discovered, agents: [...byName.values()] };
}
export async function resolveProjectAgentExecution(params, effectiveCwd, scope, _sessionId, deps) {
    const names = [
        ...(typeof params.agent === "string" ? [params.agent] : []),
        ...(params.tasks ?? []).map((task) => task.agent),
    ];
    const whitespaceTargets = names.filter((name) => typeof name === "string" && name.trim() !== name && EMBEDDED_TARGET_PATTERN.test(name.trim()));
    if (whitespaceTargets.length > 0) {
        return projectExecutionError(`TLH project-agent execution rejected: target identity has surrounding whitespace: ${whitespaceTargets.map((name) => `'${name}'`).join(", ")}.`);
    }
    const embeddedTargets = [...new Set(names.filter((name) => EMBEDDED_TARGET_PATTERN.test(name)))];
    const discovered = deps.discoverAgents(effectiveCwd, scope);
    if (embeddedTargets.length === 0) {
        return { params, effectiveCwd, discovered };
    }
    let access;
    try {
        access = normalizeProjectAgentAccess(deps.getProjectAgentAccess?.({
            cwd: effectiveCwd,
            sessionId: _sessionId,
            targetNames: embeddedTargets,
        }));
    }
    catch {
        access = undefined;
    }
    if (!access) {
        return projectExecutionError("TLH project-agent execution was rejected: project-agent authorization is unavailable.");
    }
    if (access.canInitiate !== true) {
        return projectExecutionError(`TLH project-agent execution requires the architect or disabled primary mode. Target(s): ${embeddedTargets.join(", ")}.`);
    }
    const requestedTargets = [
        ...(typeof params.agent === "string" && embeddedTargets.includes(params.agent)
            ? [{ name: params.agent, cwd: effectiveCwd }]
            : []),
        ...(params.tasks ?? [])
            .filter((task) => embeddedTargets.includes(task.agent))
            .map((task) => ({ name: task.agent, cwd: targetCwd(effectiveCwd, task.cwd) })),
    ];
    const loadedByTarget = new Map();
    const loadedByName = new Map();
    for (const { name, cwd } of requestedTargets) {
        const key = targetKey(name, cwd);
        if (loadedByTarget.has(key))
            continue;
        const slug = embeddedSlugFromName(name);
        if (!slug)
            return projectExecutionError(`Invalid embedded project-agent target '${name}'.`);
        let loaded;
        try {
            loaded = await loadProjectAgent({ cwd, slug, ...projectAgentTrustOptions(access) });
        }
        catch (error) {
            return projectExecutionError(error instanceof Error ? error.message : String(error));
        }
        const prior = loadedByName.get(name);
        if (prior && projectAgentDefinitionKey(prior) !== projectAgentDefinitionKey(loaded)) {
            return projectExecutionError(`TLH project-agent execution rejected: ${name} resolves to multiple canonical definitions in one dispatch.`);
        }
        loadedByTarget.set(key, loaded);
        if (!prior)
            loadedByName.set(name, loaded);
    }
    const identities = [...loadedByTarget.values()].map(({ identity }) => identity);
    const nextParams = {
        ...params,
        cwd: effectiveCwd,
        ...(params.tasks
            ? {
                tasks: params.tasks.map((task) => {
                    if (!embeddedTargets.includes(task.agent))
                        return task;
                    const loaded = loadedByTarget.get(targetKey(task.agent, targetCwd(effectiveCwd, task.cwd)));
                    return loaded ? { ...task, cwd: loaded.identity.cwd } : task;
                }),
            }
            : {}),
    };
    const nextDiscovered = addProjectAgents(discovered, [...loadedByName.values()].map(({ agent }) => ({ agent })));
    return {
        params: nextParams,
        effectiveCwd,
        projectAgentIdentities: identities,
        discovered: nextDiscovered,
    };
}
export function projectRunAuthorizationError(message) {
    return new Error(`TLH project-agent control rejected: ${message}`);
}
export function hasMalformedProjectAgentControlMarker(value) {
    if (!isRecordValue(value) || !Object.hasOwn(value, "projectAgent"))
        return false;
    return normalizeProjectAgentIdentity(value.projectAgent) === undefined;
}
export async function authorizePersistedProjectAgentRun(input) {
    const identity = normalizeProjectAgentIdentity(input.target.projectAgent);
    if (!identity)
        throw projectRunAuthorizationError("persisted project-agent identity is missing or invalid.");
    const slug = embeddedSlugFromName(input.target.agent);
    if (!slug || slug !== identity.slug) {
        throw projectRunAuthorizationError("persisted project-agent slug does not match the selected child.");
    }
    const resolvedRoot = resolveCanonicalGitWorktreeRoot(identity.cwd);
    const persistedRoot = resolveCanonicalGitWorktreeRoot(identity.root);
    const currentRoot = resolveCanonicalGitWorktreeRoot(input.ctx.cwd);
    if (!resolvedRoot ||
        !persistedRoot ||
        !currentRoot ||
        resolvedRoot !== persistedRoot ||
        currentRoot !== persistedRoot) {
        throw projectRunAuthorizationError("the current canonical project root does not match the run.");
    }
    const cwdValidation = validateProjectAgentCwdContainment(identity.root, input.target.cwd ?? identity.cwd);
    if (!cwdValidation.valid || cwdValidation.canonicalCwd !== identity.cwd) {
        throw projectRunAuthorizationError(cwdValidation.valid ? "the persisted execution cwd changed." : cwdValidation.reason);
    }
    const access = normalizeProjectAgentAccess(input.deps.getProjectAgentAccess?.({
        cwd: input.ctx.cwd,
        sessionId: resolveSessionId(input.ctx),
        targetNames: [input.target.agent],
    }));
    if (input.requireArchitect !== false && !access?.architect) {
        throw projectRunAuthorizationError("the current primary agent is not the architect.");
    }
    if (!access) {
        throw projectRunAuthorizationError("project-agent authorization is unavailable.");
    }
    let loaded;
    try {
        loaded = await loadProjectAgent({
            cwd: identity.cwd,
            slug,
            ...projectAgentTrustOptions(access),
        });
    }
    catch (error) {
        throw projectRunAuthorizationError(error instanceof Error ? error.message : String(error));
    }
    if (identity.slug !== loaded.identity.slug ||
        identity.root !== loaded.identity.root ||
        identity.cwd !== loaded.identity.cwd) {
        throw projectRunAuthorizationError("the project-agent root or cwd changed while reauthorizing.");
    }
    const discovered = input.deps.discoverAgents(identity.cwd, "user");
    return {
        identity: loaded.identity,
        agentConfig: loaded.agent,
        canonicalCwd: loaded.identity.cwd,
        modelScope: discovered.modelScope,
    };
}
function resolveSessionId(ctx) {
    try {
        const value = ctx.sessionManager.getSessionId();
        return typeof value === "string" && value.length > 0 ? value : null;
    }
    catch {
        return null;
    }
}
