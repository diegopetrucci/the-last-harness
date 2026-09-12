import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { DISABLED_PRIMARY_AGENT, isEnabledPrimaryAgentSelection, } from "../the-last-harness-primary-agent.mjs";
import { isRecord } from "./common.js";
import { defaultProjectTrustForCwd } from "./primary-agent-runtime-settings.js";
import { isPersistedProjectAgentTrustDenial, normalizeActiveProjectAgentSnapshot, normalizeProjectDefaultsResult, pathWithinProjectRoot, projectDefaultsWarningKey, sessionIdForContext, truncateProjectDefaultsWarning, validatePrimaryProjectAgentCwdContainment, } from "./primary-agent-runtime-boundaries.js";
import { loadProjectAgentSnapshot, reauthorizeTlhProjectAgentTrust, } from "./project-agent-loader-bridge.mjs";
import { loadProjectDefaults } from "./project-defaults-loader-bridge.mjs";
import { releaseTlhProjectAgentRunReferencesForSession, releaseTlhProjectAgentSnapshotReference, retainTlhProjectAgentSnapshotReference, setTlhProjectAgentAccessProvider, } from "./project-agent-access.mjs";
import { inventoryProjectAgentGuidance, } from "../shared/project-agent-guidance.js";
const PROJECT_AGENT_RUNTIME_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-runtime-state");
const PROJECT_AGENT_RUNTIME_GLOBAL = globalThis;
const PROJECT_AGENT_RUNTIME_STATE = PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] ??
    (PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] = { epoch: 0 });
const PROJECT_AGENT_TRUST_DEPENDENCIES = {
    createProjectTrustStore: (agentDir) => new ProjectTrustStore(agentDir),
};
export function retireTlhPrimaryAgentResourceRuntime() {
    setTlhProjectAgentAccessProvider(undefined);
    if (!PROJECT_AGENT_RUNTIME_STATE.referenceId)
        return;
    const previousReferenceId = PROJECT_AGENT_RUNTIME_STATE.referenceId;
    PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
    void releaseTlhProjectAgentSnapshotReference(previousReferenceId).catch(() => {
    });
}
export function createTlhPrimaryAgentResourceLifecycle(options) {
    const { getPrimaryAgentSelection, hasActivePrimaryAgent, projectAgentLoader = loadProjectAgentSnapshot, projectDefaultsLoader: projectDefaultsLoaderFn = loadProjectDefaults, } = options;
    const runtimeOwnerPrefix = `runtime:${randomUUID()}`;
    let runtimeReferenceId = `${runtimeOwnerPrefix}:owner:${randomUUID()}`;
    const runtimeEpoch = ++PROJECT_AGENT_RUNTIME_STATE.epoch;
    let activeProjectAgentSnapshot;
    let projectAgentLoadRequest = 0;
    let projectAgentTrustWarningSessionId;
    const projectDefaultsWarned = new Set();
    let activeProjectDefaults;
    let sessionStartRequestId = 0;
    let sessionProjectAgentGuidanceSnapshot;
    const isCurrentProjectAgentOperation = (loadRequest, sessionId) => runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
        projectAgentLoadRequest === loadRequest &&
        PROJECT_AGENT_RUNTIME_STATE.sessionId === sessionId;
    const releaseProjectAgentReferenceQuietly = async (referenceId) => {
        try {
            await releaseTlhProjectAgentSnapshotReference(referenceId);
        }
        catch {
        }
    };
    const retainProjectAgentReferenceTemporarily = async (capability, kind) => {
        const referenceId = `${runtimeOwnerPrefix}:${kind}:${randomUUID()}`;
        try {
            await retainTlhProjectAgentSnapshotReference(capability, referenceId);
        }
        catch {
            return undefined;
        }
        let retained = true;
        return {
            referenceId,
            release: async () => {
                if (!retained)
                    return;
                retained = false;
                await releaseProjectAgentReferenceQuietly(referenceId);
            },
        };
    };
    const isCurrentSessionStartOperation = (operation) => operation.requestId === sessionStartRequestId &&
        operation.runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch;
    setTlhProjectAgentAccessProvider(() => {
        const snapshot = activeProjectAgentSnapshot;
        if (!snapshot)
            return undefined;
        const selection = getPrimaryAgentSelection();
        const architect = selection === "architect" &&
            isEnabledPrimaryAgentSelection(selection) &&
            hasActivePrimaryAgent();
        return {
            capability: snapshot.capability,
            expected: snapshot.provenance,
            architect,
            canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
            ...(snapshot.reauthorizeTrust ? { reauthorize: snapshot.reauthorizeTrust } : {}),
            ...(snapshot.rebindProjectAgent ? { rebind: snapshot.rebindProjectAgent } : {}),
        };
    });
    function warnProjectDefaultsOnce(ctx, projectRoot, agent, message, identityMessage = message) {
        const boundedMessage = truncateProjectDefaultsWarning(message);
        if (boundedMessage.length === 0)
            return;
        try {
            if (ctx.hasUI === false)
                return;
            const key = projectDefaultsWarningKey(projectRoot, ctx.cwd, agent, boundedMessage, identityMessage);
            if (projectDefaultsWarned.has(key))
                return;
            ctx.ui.notify(boundedMessage, "warning");
            projectDefaultsWarned.add(key);
        }
        catch {
        }
    }
    function warnPersistedProjectAgentTrustDenied(ctx, sessionId, loaded) {
        if (ctx.hasUI === false ||
            projectAgentTrustWarningSessionId === sessionId ||
            !isPersistedProjectAgentTrustDenial(loaded)) {
            return;
        }
        try {
            ctx.ui.notify("TLH project custom agents are unavailable because persisted project trust does not authorize this project. Run /trust, persist trust for this project, then retry.", "warning");
            projectAgentTrustWarningSessionId = sessionId;
        }
        catch {
        }
    }
    function notifyUndecidedProjectAgentGuidance(ctx, inventory) {
        if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
            return;
        }
        const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
        if (!diagnostic)
            return;
        try {
            ctx.ui.notify(diagnostic.message, "warning");
        }
        catch {
        }
    }
    function activeProjectDefaultsForCwd(cwd) {
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch)
            return undefined;
        const defaults = activeProjectDefaults;
        if (defaults?.status !== "loaded" || !defaults.projectRoot)
            return undefined;
        const validation = validatePrimaryProjectAgentCwdContainment(defaults.projectRoot, cwd, []);
        return validation.valid ? defaults : undefined;
    }
    function attachProjectAgentRuntimeCallbacks(snapshot) {
        if (!snapshot.trust)
            return;
        snapshot.reauthorizeTrust = async () => {
            try {
                const current = await reauthorizeTlhProjectAgentTrust(snapshot.provenance.projectRoot, {
                    agentDir: getAgentDir(),
                    trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
                });
                return current?.trusted === true;
            }
            catch {
                return false;
            }
        };
        snapshot.rebindProjectAgent = async (request) => {
            const runtimeLoadRequest = projectAgentLoadRequest;
            const runtimeSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
            const runtimeReferenceIdAtStart = runtimeReferenceId;
            const activeSnapshotAtStart = activeProjectAgentSnapshot;
            const agentMatch = /^embedded\.([a-z0-9][a-z0-9-]*)$/.exec(request.agent);
            if (!agentMatch ||
                !runtimeSessionId ||
                request.sessionId !== runtimeSessionId ||
                runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                activeSnapshotAtStart !== snapshot ||
                PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart) {
                return undefined;
            }
            const cwdValidation = validatePrimaryProjectAgentCwdContainment(request.projectRoot, request.cwd, []);
            if (!cwdValidation.valid)
                return undefined;
            let loaded;
            try {
                loaded = await projectAgentLoader({
                    cwd: request.cwd,
                    sessionId: request.sessionId,
                    agentDir: getAgentDir(),
                    trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
                });
            }
            catch {
                return undefined;
            }
            const rebound = normalizeActiveProjectAgentSnapshot(loaded);
            if (!rebound)
                return undefined;
            const reboundLease = await retainProjectAgentReferenceTemporarily(rebound.capability, "rebind");
            if (!reboundLease)
                return undefined;
            let adopted = false;
            try {
                if (!isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
                    !activeSnapshotAtStart ||
                    rebound.trust?.trusted !== true ||
                    rebound.provenance.sessionId !== request.sessionId ||
                    rebound.provenance.processInstanceId !== snapshot.provenance.processInstanceId) {
                    return undefined;
                }
                let requestedRoot;
                let activeRoot;
                let reboundRoot;
                let reboundCwd;
                try {
                    requestedRoot = fs.realpathSync(request.projectRoot);
                    activeRoot = fs.realpathSync(snapshot.provenance.projectRoot);
                    reboundRoot = fs.realpathSync(rebound.provenance.projectRoot);
                    reboundCwd = fs.realpathSync(request.cwd);
                }
                catch {
                    return undefined;
                }
                if (requestedRoot !== activeRoot ||
                    requestedRoot !== reboundRoot ||
                    !pathWithinProjectRoot(requestedRoot, reboundCwd)) {
                    return undefined;
                }
                const rawManifest = isRecord(loaded) && isRecord(loaded.manifest) ? loaded.manifest : undefined;
                const rawEntries = rawManifest?.entries;
                if (!Array.isArray(rawEntries))
                    return undefined;
                const rawEntry = rawEntries.find((entry) => isRecord(entry) && isRecord(entry.agent) && entry.agent.name === request.agent);
                if (!rawEntry || !isRecord(rawEntry.agent) || typeof rawEntry.digest !== "string") {
                    return undefined;
                }
                const expectedPath = join(reboundRoot, ".tlh", "agents", "custom", `${agentMatch[1].toUpperCase()}.md`);
                if (rawEntry.agent.name !== request.agent ||
                    rawEntry.agent.localName !== agentMatch[1] ||
                    rawEntry.agent.packageName !== "embedded" ||
                    rawEntry.agent.source !== "project" ||
                    rawEntry.agent.filePath !== expectedPath) {
                    return undefined;
                }
                const sameActiveCapability = activeSnapshotAtStart === snapshot &&
                    PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceIdAtStart &&
                    activeSnapshotAtStart.capability === rebound.capability;
                const makeRebindResult = () => ({
                    capability: rebound.capability,
                    expected: { ...rebound.provenance },
                    capture: {
                        provenance: {
                            ...rebound.provenance,
                            source: "project",
                            agent: request.agent,
                            digest: rawEntry.digest,
                        },
                        config: rawEntry.agent,
                    },
                });
                if (sameActiveCapability)
                    return makeRebindResult();
                if (!isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
                    activeProjectAgentSnapshot !== activeSnapshotAtStart ||
                    PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart) {
                    return undefined;
                }
                try {
                    await releaseTlhProjectAgentSnapshotReference(runtimeReferenceIdAtStart);
                }
                catch {
                    return undefined;
                }
                if (!isCurrentProjectAgentOperation(runtimeLoadRequest, request.sessionId) ||
                    activeProjectAgentSnapshot !== activeSnapshotAtStart ||
                    PROJECT_AGENT_RUNTIME_STATE.referenceId !== runtimeReferenceIdAtStart) {
                    return undefined;
                }
                attachProjectAgentRuntimeCallbacks(rebound);
                runtimeReferenceId = reboundLease.referenceId;
                PROJECT_AGENT_RUNTIME_STATE.referenceId = reboundLease.referenceId;
                activeProjectAgentSnapshot = rebound;
                adopted = true;
                return makeRebindResult();
            }
            finally {
                if (!adopted)
                    await reboundLease.release();
            }
        };
    }
    async function loadProjectAgentSnapshotForSession(ctx) {
        const requestId = ++projectAgentLoadRequest;
        const previousReferenceId = runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
            PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
            ? runtimeReferenceId
            : undefined;
        activeProjectAgentSnapshot = undefined;
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch)
            return;
        if (previousReferenceId) {
            try {
                await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
            }
            catch {
                return;
            }
            if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                requestId !== projectAgentLoadRequest ||
                PROJECT_AGENT_RUNTIME_STATE.referenceId !== previousReferenceId) {
                return;
            }
            PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
        }
        const sessionId = sessionIdForContext(ctx);
        if (!sessionId)
            return;
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
            return;
        const previousSessionId = PROJECT_AGENT_RUNTIME_STATE.sessionId;
        if (previousSessionId && previousSessionId !== sessionId) {
            try {
                await releaseTlhProjectAgentRunReferencesForSession(previousSessionId);
            }
            catch {
            }
            if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                requestId !== projectAgentLoadRequest ||
                PROJECT_AGENT_RUNTIME_STATE.sessionId !== previousSessionId) {
                return;
            }
        }
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch || requestId !== projectAgentLoadRequest)
            return;
        PROJECT_AGENT_RUNTIME_STATE.sessionId = sessionId;
        let loaded;
        try {
            loaded = await projectAgentLoader({
                cwd: ctx.cwd,
                sessionId,
                agentDir: getAgentDir(),
                trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
            });
        }
        catch {
            return;
        }
        if (isCurrentProjectAgentOperation(requestId, sessionId)) {
            warnPersistedProjectAgentTrustDenied(ctx, sessionId, loaded);
        }
        const normalized = normalizeActiveProjectAgentSnapshot(loaded);
        if (!normalized)
            return;
        const loadLease = await retainProjectAgentReferenceTemporarily(normalized.capability, "load");
        if (!loadLease)
            return;
        let adopted = false;
        try {
            if (!isCurrentProjectAgentOperation(requestId, sessionId))
                return;
            attachProjectAgentRuntimeCallbacks(normalized);
            if (PROJECT_AGENT_RUNTIME_STATE.referenceId !== undefined)
                return;
            runtimeReferenceId = loadLease.referenceId;
            PROJECT_AGENT_RUNTIME_STATE.referenceId = loadLease.referenceId;
            activeProjectAgentSnapshot = normalized;
            adopted = true;
        }
        finally {
            if (!adopted)
                await loadLease.release();
        }
    }
    async function loadProjectDefaultsForSession(ctx, operation) {
        if (!isCurrentSessionStartOperation(operation))
            return;
        activeProjectDefaults = undefined;
        const sessionId = sessionIdForContext(ctx);
        if (!sessionId)
            return;
        let loaded;
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
                    ui: typeof ctx.ui?.confirm === "function"
                        ? {
                            confirm: (title, message, options) => ctx.ui.confirm(title, message, options),
                        }
                        : undefined,
                },
            });
        }
        catch {
            return;
        }
        if (!isCurrentSessionStartOperation(operation))
            return;
        let normalized;
        try {
            normalized = normalizeProjectDefaultsResult(loaded, ctx.cwd);
        }
        catch {
            return;
        }
        if (!isCurrentSessionStartOperation(operation))
            return;
        if (normalized?.status === "loaded") {
            for (const warning of normalized.warnings) {
                if (!isCurrentSessionStartOperation(operation))
                    return;
                warnProjectDefaultsOnce(ctx, normalized.projectRoot, undefined, warning);
            }
        }
        if (!isCurrentSessionStartOperation(operation))
            return;
        activeProjectDefaults = normalized ?? undefined;
    }
    function beginSessionStart() {
        const operation = {
            requestId: ++sessionStartRequestId,
            runtimeEpoch,
        };
        activeProjectDefaults = undefined;
        projectDefaultsWarned.clear();
        return operation;
    }
    async function loadSessionResources(ctx, operation) {
        if (!isCurrentSessionStartOperation(operation))
            return;
        await loadProjectAgentSnapshotForSession(ctx);
        if (!isCurrentSessionStartOperation(operation))
            return;
        sessionProjectAgentGuidanceSnapshot = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
        notifyUndecidedProjectAgentGuidance(ctx, sessionProjectAgentGuidanceSnapshot);
        if (!isCurrentSessionStartOperation(operation))
            return;
        await loadProjectDefaultsForSession(ctx, operation);
    }
    async function shutdown(onCurrent) {
        sessionStartRequestId += 1;
        const shutdownRequestId = ++projectAgentLoadRequest;
        const previousReferenceId = runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
            PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId
            ? runtimeReferenceId
            : undefined;
        activeProjectDefaults = undefined;
        projectDefaultsWarned.clear();
        activeProjectAgentSnapshot = undefined;
        if (previousReferenceId) {
            let released = true;
            try {
                await releaseTlhProjectAgentSnapshotReference(previousReferenceId);
            }
            catch {
                released = false;
            }
            if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                shutdownRequestId !== projectAgentLoadRequest) {
                return false;
            }
            if (released && PROJECT_AGENT_RUNTIME_STATE.referenceId === previousReferenceId) {
                PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
            }
        }
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
            shutdownRequestId !== projectAgentLoadRequest) {
            return false;
        }
        sessionProjectAgentGuidanceSnapshot = undefined;
        projectAgentTrustWarningSessionId = undefined;
        onCurrent?.();
        return true;
    }
    return {
        beginSessionStart,
        isCurrentRuntime: () => runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch,
        isCurrentSessionStartOperation,
        loadSessionResources,
        activeProjectAgentSnapshot: () => activeProjectAgentSnapshot,
        activeProjectDefaultsForCwd,
        projectAgentGuidanceSnapshot: () => sessionProjectAgentGuidanceSnapshot,
        warnProjectDefaultsOnce,
        shutdown,
    };
}
