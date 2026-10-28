// Generated from extensions/subagents/src/runs/shared/project-agent-control.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import * as path from "node:path";
import { embeddedSlugFromName, loadProjectAgent, normalizeProjectAgentIdentity, resolveCanonicalGitWorktreeRoot, validateProjectAgentCwdContainment, } from "../../agents/project-agent-loader.js";
import { isCurrentInvocationEmbeddedOnly } from "../../../../the-last-harness/project-agent-access.mjs";
import { resolveProjectAgentSessionId } from "../../shared/session-identity.js";
const EMBEDDED_TARGET_PATTERN = /^embedded\.([a-z0-9][a-z0-9-]*)$/;
export function isRecordValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function restrictedDenyAccess(value) {
    return {
        architect: false,
        canManage: false,
        canInitiate: false,
        controlRestrictedToEmbedded: true,
        ...(typeof value.noDeveloper === "boolean" ? { noDeveloper: value.noDeveloper } : {}),
        ...(value.noDeveloper !== undefined && typeof value.noDeveloper !== "boolean"
            ? { noDeveloperPolicyInvalid: true }
            : {}),
        ...(typeof value.resumeRestrictionReason === "string"
            ? { resumeRestrictionReason: value.resumeRestrictionReason }
            : {}),
        ...(typeof value.steerRestrictionReason === "string"
            ? { steerRestrictionReason: value.steerRestrictionReason }
            : {}),
    };
}
function malformedNoDeveloperAccess(value) {
    return {
        architect: false,
        canManage: false,
        canInitiate: false,
        ...(typeof value.noDeveloper === "boolean" ? { noDeveloper: value.noDeveloper } : {}),
        ...(typeof value.noDeveloper === "boolean" ? {} : { noDeveloperPolicyInvalid: true }),
    };
}
export function normalizeProjectAgentAccess(value) {
    if (!isRecordValue(value))
        return undefined;
    const normalized = normalizeWellFormedAccess(value);
    if (normalized)
        return normalized;
    if (value.controlRestrictedToEmbedded === true)
        return restrictedDenyAccess(value);
    return Object.hasOwn(value, "noDeveloper") ? malformedNoDeveloperAccess(value) : undefined;
}
export function isNoDeveloperPolicyActive(access) {
    return access?.noDeveloper === true || access?.noDeveloperPolicyInvalid === true;
}
function normalizeWellFormedAccess(value) {
    const architect = typeof value.architect === "boolean" ? value.architect : undefined;
    const canManage = typeof value.canManage === "boolean" ? value.canManage : architect;
    if (canManage === undefined)
        return undefined;
    if (value.canInitiate !== undefined && typeof value.canInitiate !== "boolean")
        return undefined;
    if (value.canManage !== undefined && typeof value.canManage !== "boolean")
        return undefined;
    const noDeveloperPolicyInvalid = value.noDeveloper !== undefined && typeof value.noDeveloper !== "boolean";
    const canInitiate = typeof value.canInitiate === "boolean" ? value.canInitiate : canManage;
    const agentDir = typeof value.agentDir === "string" ? value.agentDir : undefined;
    const trustStore = value.trustStore;
    const createProjectTrustStore = typeof value.createProjectTrustStore === "function"
        ? value.createProjectTrustStore
        : undefined;
    if (trustStore !== undefined && typeof trustStore.getEntry !== "function")
        return undefined;
    return {
        architect: architect ?? false,
        canManage,
        canInitiate,
        ...(value.controlRestrictedToEmbedded === true ? { controlRestrictedToEmbedded: true } : {}),
        ...(typeof value.noDeveloper === "boolean" ? { noDeveloper: value.noDeveloper } : {}),
        ...(noDeveloperPolicyInvalid ? { noDeveloperPolicyInvalid: true } : {}),
        ...(typeof value.resumeRestrictionReason === "string"
            ? { resumeRestrictionReason: value.resumeRestrictionReason }
            : {}),
        ...(typeof value.steerRestrictionReason === "string"
            ? { steerRestrictionReason: value.steerRestrictionReason }
            : {}),
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
            ? { trustDependencies: { createProjectTrustStore: access.createProjectTrustStore } }
            : {}),
    };
}
function addProjectAgents(discovered, loaded) {
    const byName = new Map(discovered.agents.map((agent) => [agent.name, agent]));
    for (const entry of loaded)
        byName.set(entry.agent.name, entry.agent);
    return { ...discovered, agents: [...byName.values()] };
}
export async function resolveProjectAgentExecution(params, effectiveCwd, scope, sessionId, deps) {
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
            sessionId,
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
        return projectExecutionError(`TLH project-agent execution is not authorized for the current primary-agent mode. Target(s): ${embeddedTargets.join(", ")}.`);
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
        sessionId: resolveProjectAgentSessionId(input.ctx.sessionManager),
        targetNames: [input.target.agent],
    }));
    if (input.requireArchitect !== false && access?.canManage !== true) {
        throw projectRunAuthorizationError("the current primary agent cannot manage project-agent runs.");
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
function noDeveloperControlReason(action) {
    return `Primary agent may not ${action} the bundled developer subagent while the host no-developer policy is active.`;
}
export async function embeddedControlRestrictionError(input) {
    const invocationRestricted = isCurrentInvocationEmbeddedOnly();
    let access;
    try {
        access = normalizeProjectAgentAccess(input.deps.getProjectAgentAccess?.({
            cwd: input.ctx.cwd,
            sessionId: resolveProjectAgentSessionId(input.ctx.sessionManager),
            targetNames: input.targets.map((target) => target.agent),
        }));
    }
    catch {
        return `Primary agent may only ${input.action} embedded project-agent runs.`;
    }
    const noDeveloperRestricted = isNoDeveloperPolicyActive(access);
    const rushRestricted = invocationRestricted || access?.controlRestrictedToEmbedded === true;
    if (!rushRestricted && !noDeveloperRestricted)
        return undefined;
    const rushReason = (input.action === "resume"
        ? access?.resumeRestrictionReason
        : access?.steerRestrictionReason) ??
        `Primary agent may only ${input.action} embedded project-agent runs.`;
    if (rushRestricted) {
        if (input.targets.length === 0)
            return rushReason;
        for (const target of input.targets) {
            if (target.conflict === true ||
                typeof target.agent !== "string" ||
                !EMBEDDED_TARGET_PATTERN.test(target.agent) ||
                normalizeProjectAgentIdentity(target.projectAgent) === undefined) {
                return rushReason;
            }
            try {
                await authorizePersistedProjectAgentRun({ target, ctx: input.ctx, deps: input.deps });
            }
            catch {
                return rushReason;
            }
        }
        return undefined;
    }
    const noDeveloperReason = noDeveloperControlReason(input.action);
    if (input.targets.length === 0 || access?.noDeveloperPolicyInvalid === true)
        return noDeveloperReason;
    for (const target of input.targets) {
        if (target.conflict === true ||
            target.noDeveloperConflict === true ||
            typeof target.agent !== "string" ||
            target.agent.trim() !== target.agent ||
            target.agent.length === 0) {
            return noDeveloperReason;
        }
        if (target.agent === "developer")
            return noDeveloperReason;
    }
    return undefined;
}
