import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRIMARY_AGENT, DISABLED_PRIMARY_AGENT, PRIMARY_AGENT_CYCLE, PRIMARY_AGENT_SESSION_STATE_ENTRY, isEnabledPrimaryAgentSelection, nextPrimaryAgentSelection, primaryAgentDefaultLabel, primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig, } from "../the-last-harness-primary-agent.mjs";
import { createPrimaryToolState, filterAvailableTools, } from "../the-last-harness-primary-tools.mjs";
import { allowedSubagentsForExperimentalConfig, collectSubagentTargets, isEmbeddedSubagentTarget, registerTlhStartupMode, validateSubagentToolInput, } from "../the-last-harness-subagent-safety.mjs";
import { buildTlhCommitAttributionPrompt, getTlhGitCommitAttributionBlockReason, resolveTlhCommitAttribution, } from "./attribution.js";
import { formatHomePath, isRecord } from "./common.js";
import { loadProjectAgentSnapshot, reauthorizeTlhProjectAgentTrust, } from "./project-agent-loader-bridge.mjs";
import { lookupTlhProjectAgentRunReference, probeTlhProjectAgentRunMarker, setTlhProjectAgentAccessProvider, } from "./project-agent-access.mjs";
import { releaseTlhProjectAgentRunReferencesForSession, releaseTlhProjectAgentSnapshotReference, retainTlhProjectAgentSnapshotReference, } from "./project-agent-access.mjs";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, THINKING_LEVELS, TLH_NAME, TLH_PACKAGE_NAME, } from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import { applyProviderAwareSubagentModels, followsOpenrouterSession, formatProviderModelReference, listAgentModelDefaultReferences, parseProviderModelReference, resolveProviderThinking, selectProviderAwareAgentDefaults, } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { beginTlhModelSelectionPersistenceSession, claimTlhModelSelectionDefaults, endTlhModelSelectionPersistenceSession, installTlhModelSelectionPersistenceOverride, isTlhPersistedModelSelection, updateTlhModelSelectionPersistenceContext, } from "./model-selection-scope.js";
import { getAvailableThinkingLevels, isThinkingLevel, setExtensionThinkingLevel, } from "./thinking.js";
import { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadAuthorizedEmbeddedSubagentRuntimeNames, loadPrimaryAgents, loadSubagentMetadata, } from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite, withLockedTlhSettingsWrite } from "./profile-state.js";
const PROJECT_AGENT_RUNTIME_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-runtime-state");
const PROJECT_AGENT_RUNTIME_GLOBAL = globalThis;
const PROJECT_AGENT_RUNTIME_STATE = PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] ??
    (PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] = { epoch: 0 });
const PROJECT_AGENT_TRUST_DEPENDENCIES = {
    createProjectTrustStore: (agentDir) => new ProjectTrustStore(agentDir),
    hasTrustRequiringProjectResources,
};
function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function normalizeActiveProjectAgentSnapshot(value) {
    if (!isRecord(value) || value.status !== "loaded")
        return undefined;
    const capability = value.capability;
    const provenance = value.provenance;
    const manifest = value.manifest;
    if (!isRecord(capability) || !isRecord(provenance) || !isRecord(manifest))
        return undefined;
    if (!nonEmptyString(provenance.projectRoot) ||
        !nonEmptyString(provenance.sessionId) ||
        !nonEmptyString(provenance.generationId) ||
        !nonEmptyString(provenance.processInstanceId)) {
        return undefined;
    }
    const manifestProvenance = manifest.provenance;
    if (!isRecord(manifestProvenance))
        return undefined;
    if (manifestProvenance.projectRoot !== provenance.projectRoot ||
        manifestProvenance.sessionId !== provenance.sessionId ||
        manifestProvenance.generationId !== provenance.generationId ||
        manifestProvenance.processInstanceId !== provenance.processInstanceId) {
        return undefined;
    }
    if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.tombstones))
        return undefined;
    const entries = [];
    for (const rawEntry of manifest.entries) {
        if (!isRecord(rawEntry) || !isRecord(rawEntry.agent))
            return undefined;
        if (!nonEmptyString(rawEntry.agent.name) || !nonEmptyString(rawEntry.digest)) {
            return undefined;
        }
        entries.push({ name: rawEntry.agent.name, digest: rawEntry.digest });
    }
    const tombstones = [];
    for (const rawTombstone of manifest.tombstones) {
        if (!nonEmptyString(rawTombstone))
            return undefined;
        tombstones.push(rawTombstone);
    }
    const trust = isRecord(value.trust) && value.trust.trusted === true && typeof value.trust.source === "string"
        ? { trusted: true, source: value.trust.source }
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
function defaultProjectTrustForCwd(cwd) {
    try {
        const value = SettingsManager.create(cwd, getAgentDir(), {
            projectTrusted: false,
        }).getDefaultProjectTrust();
        return value === "always" || value === "never" ? value : "ask";
    }
    catch {
        return "ask";
    }
}
function sessionIdForContext(ctx) {
    try {
        const sessionId = ctx.sessionManager.getSessionId();
        return nonEmptyString(sessionId) ? sessionId : undefined;
    }
    catch {
        return undefined;
    }
}
function pathWithinProjectRoot(projectRoot, candidate) {
    const relativePath = relative(projectRoot, candidate);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
function validatePrimaryProjectAgentCwdContainment(projectRoot, cwd, taskCwds) {
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
        return { valid: false, reason: "the canonical project root is unavailable" };
    }
    let canonicalRoot;
    try {
        canonicalRoot = fs.realpathSync(projectRoot);
        if (!fs.statSync(canonicalRoot).isDirectory()) {
            return { valid: false, reason: "the canonical project root is not a directory" };
        }
    }
    catch {
        return { valid: false, reason: "the canonical project root cannot be resolved" };
    }
    const canonicalDirectory = (value, label) => {
        if (typeof value !== "string" || value.trim().length === 0) {
            return { valid: false, reason: `${label} must be an existing directory` };
        }
        try {
            const canonical = fs.realpathSync(value);
            if (!fs.statSync(canonical).isDirectory()) {
                return { valid: false, reason: `${label} is not a directory` };
            }
            return { valid: true, path: canonical };
        }
        catch {
            return { valid: false, reason: `${label} does not exist or cannot be resolved` };
        }
    };
    const canonicalCwd = canonicalDirectory(cwd, "execution cwd");
    if (!canonicalCwd.valid)
        return canonicalCwd;
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
        if (!canonicalTaskCwd.valid)
            return canonicalTaskCwd;
        if (!pathWithinProjectRoot(canonicalRoot, canonicalTaskCwd.path)) {
            return {
                valid: false,
                reason: `task ${index + 1} cwd is outside the canonical project root`,
            };
        }
    }
    return { valid: true };
}
const EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE = "Extension runtime not initialized. Action methods cannot be called during extension loading.";
function isExtensionRuntimeNotInitializedError(error) {
    return error instanceof Error && error.message === EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE;
}
function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
function getTlhPrimaryAgentConfig(cwd) {
    return getTlhGlobalSettings(cwd).tlh?.primaryAgent;
}
function getTlhDurableThinkingLevel(cwd) {
    const level = getTlhGlobalSettings(cwd).defaultThinkingLevel;
    return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
}
function getTlhSubagentOverrides(cwd) {
    const overrides = getTlhGlobalSettings(cwd).subagents?.agentOverrides;
    if (!isRecord(overrides)) {
        return new Map();
    }
    return new Map(Object.entries(overrides)
        .filter(([, value]) => isRecord(value))
        .map(([agent, value]) => [agent, value]));
}
function resolvePrimaryAutoApplySetting(primaryConfig, primary, key) {
    const configured = primaryConfig?.[key];
    if (typeof configured === "boolean") {
        return configured;
    }
    return primary[key] === true;
}
function parseTlhSettingsContent(content) {
    if (!content) {
        return {};
    }
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
        throw new Error("settings.json must contain a JSON object");
    }
    return parsed;
}
function writeTlhPrimaryAgentModelOverride(cwd, primary, modelKey) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write model-override settings outside the isolated TLH profile.", (current) => {
        const settings = parseTlhSettingsContent(current);
        const rawTlh = settings.tlh;
        let tlh;
        if (rawTlh === undefined) {
            tlh = {};
            settings.tlh = tlh;
        }
        else if (isRecord(rawTlh)) {
            tlh = rawTlh;
        }
        else {
            throw new Error("settings.tlh must be an object to update model-override settings.");
        }
        const rawPrimaryAgent = tlh.primaryAgent;
        let primaryAgent;
        if (rawPrimaryAgent === undefined) {
            primaryAgent = {};
            tlh.primaryAgent = primaryAgent;
        }
        else if (isRecord(rawPrimaryAgent)) {
            primaryAgent = rawPrimaryAgent;
        }
        else {
            throw new Error("settings.tlh.primaryAgent must be an object to update model-override settings.");
        }
        const rawModelOverrides = primaryAgent.modelOverrides;
        let modelOverrides;
        if (rawModelOverrides === undefined) {
            modelOverrides = {};
            primaryAgent.modelOverrides = modelOverrides;
        }
        else if (isRecord(rawModelOverrides)) {
            modelOverrides = rawModelOverrides;
        }
        else {
            throw new Error("settings.tlh.primaryAgent.modelOverrides must be an object.");
        }
        const existingOverride = modelOverrides[primary];
        if (modelKey === undefined) {
            if (!Object.hasOwn(modelOverrides, primary)) {
                return { changed: false };
            }
            delete modelOverrides[primary];
        }
        else {
            if (existingOverride === modelKey) {
                return { changed: false };
            }
            modelOverrides[primary] = modelKey;
        }
        if (Object.keys(modelOverrides).length === 0) {
            delete primaryAgent.modelOverrides;
        }
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function writeTlhPrimaryAgentDefault(cwd, selection) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write primary-agent settings outside the isolated TLH profile.", (current) => {
        const settings = parseTlhSettingsContent(current);
        const rawTlh = settings.tlh;
        let tlh;
        if (rawTlh === undefined) {
            tlh = {};
            settings.tlh = tlh;
        }
        else if (isRecord(rawTlh)) {
            tlh = rawTlh;
        }
        else {
            throw new Error("settings.tlh must be an object to update primary-agent settings.");
        }
        const rawPrimaryAgent = tlh.primaryAgent;
        let primaryAgent;
        if (rawPrimaryAgent === undefined) {
            primaryAgent = {};
            tlh.primaryAgent = primaryAgent;
        }
        else if (isRecord(rawPrimaryAgent)) {
            primaryAgent = rawPrimaryAgent;
        }
        else {
            throw new Error("settings.tlh.primaryAgent must be an object to update primary-agent defaults.");
        }
        let changed = false;
        const setField = (key, value) => {
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
        }
        else if (selection === DISABLED_PRIMARY_AGENT) {
            setField("enabled", false);
            setField("selected", DISABLED_PRIMARY_AGENT);
        }
        else {
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
    });
}
function primaryToolAllowlist(primary) {
    return primary?.tools.length
        ? primary.tools
        : ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"];
}
function primaryAgentLabel(selection) {
    return selection;
}
function primaryAgentOverrideLabel(selection) {
    return selection ?? "none";
}
function matchesSubagentName(value, target) {
    return typeof value === "string" && value.trim().toLowerCase() === target;
}
function isSubagentResumeAction(input) {
    return isRecord(input) && matchesSubagentName(input.action, "resume");
}
function isSubagentSteerAction(input) {
    return isRecord(input) && matchesSubagentName(input.action, "steer");
}
function subagentCallTargetsAgent(input, target) {
    return subagentCallTargetsMatching(input, (agent) => matchesSubagentName(agent, target));
}
function rushResumeDelegationReason() {
    return "TLH Rush may not use subagent action=resume because resuming by run id or index can continue a prior developer subagent without an explicit safe target. Rush must edit directly or start a new allowed subagent with an explicit agent target.";
}
function rushSteerDelegationReason() {
    return "TLH Rush may not use subagent action=steer because an opaque steer carries no agent field, so TLH cannot prove the steered child is not a developer subagent. Rush must edit directly.";
}
function rushDeveloperDelegationReason() {
    return "TLH Rush may not delegate implementation to developer. Rush must edit directly; use code-reviewer, repo-scout, diff-summarizer, librarian, or oracle only when Rush prompt rules allow it.";
}
function collectSubagentCallTargetsMatching(input, predicate) {
    return collectSubagentTargets(input).filter((agent) => predicate(agent));
}
function subagentCallTargetsMatching(input, predicate) {
    return collectSubagentCallTargetsMatching(input, predicate).length > 0;
}
const SCOUT_RUN_MAX_TIMEOUT_MS = 360_000;
const SCOUT_TIMEOUT_CAPPED_SUBAGENTS = new Set([
    "librarian",
    "web-scout",
    "repo-scout",
    "diff-summarizer",
]);
function isOpaqueSubagentManagementActionInput(input) {
    return isRecord(input) && typeof input.action === "string" && input.action.trim().length > 0;
}
function capScoutSubagentTimeout(input) {
    if (!isRecord(input) ||
        isOpaqueSubagentManagementActionInput(input) ||
        isSubagentResumeAction(input) ||
        !subagentCallTargetsMatching(input, (agent) => SCOUT_TIMEOUT_CAPPED_SUBAGENTS.has(agent.trim().toLowerCase()))) {
        return;
    }
    const { timeoutMs } = input;
    if (typeof timeoutMs === "number" &&
        Number.isFinite(timeoutMs) &&
        timeoutMs <= SCOUT_RUN_MAX_TIMEOUT_MS) {
        return;
    }
    input.timeoutMs = SCOUT_RUN_MAX_TIMEOUT_MS;
}
function embeddedDelegationBlockedReason(selection, input) {
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
function registerChildSubagentRuntime(pi, buildChildPrompt, env) {
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
        if (typeof event.input.command !== "string") {
            return undefined;
        }
        const commitAttributionState = resolveTlhCommitAttribution(getTlhGlobalSettings(ctx.cwd).tlh?.attribution);
        const reason = getTlhGitCommitAttributionBlockReason(event.input.command, commitAttributionState);
        return reason ? { block: true, reason } : undefined;
    });
}
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export function isHighConfidenceAuthSignatureInAttemptError(error) {
    const lower = error.toLowerCase();
    return (lower.includes("invalid_grant") ||
        lower.includes("token-refresh unauthorized") ||
        lower.includes("token refresh unauthorized") ||
        lower.includes("status 401") ||
        lower.includes("status 403") ||
        lower.includes("(status 401)") ||
        lower.includes("(status 403)") ||
        lower.includes("http 401") ||
        lower.includes("http 403"));
}
export function processSubagentRunDetails(details, authStore) {
    if (!isRecord(details))
        return;
    const { results } = details;
    if (!Array.isArray(results))
        return;
    for (const result of results) {
        if (!isRecord(result))
            continue;
        const { modelAttempts } = result;
        if (!Array.isArray(modelAttempts)) {
            continue;
        }
        for (const attempt of modelAttempts) {
            if (!isRecord(attempt))
                continue;
            const { model, success, error } = attempt;
            if (typeof model !== "string" || typeof success !== "boolean")
                continue;
            if (success === true)
                continue;
            if (typeof error !== "string" || error.length === 0)
                continue;
            const parsed = parseProviderModelReference(model);
            if (!parsed?.provider)
                continue;
            if (isHighConfidenceAuthSignatureInAttemptError(error)) {
                authStore.recordRunLevelAuthObservation(parsed.provider);
            }
        }
    }
}
function dispatchPreflightBackoffMs(failures) {
    if (failures <= 1)
        return 60_000;
    if (failures === 2)
        return 120_000;
    return 300_000;
}
export function extractDispatchProviders(input) {
    if (typeof input !== "object" || input === null)
        return [];
    const obj = input;
    const seen = new Set();
    function addModel(model) {
        if (typeof model !== "string")
            return;
        const parsed = parseProviderModelReference(model);
        if (parsed?.provider)
            seen.add(parsed.provider);
    }
    addModel(obj["model"]);
    if (Array.isArray(obj["tasks"])) {
        for (const task of obj["tasks"]) {
            if (typeof task === "object" && task !== null) {
                addModel(task["model"]);
            }
        }
    }
    return [...seen];
}
function createTlhPrimaryAgentRuntime(pi, primaryAgents, subagentMetadata, runtimeOptions = {}) {
    const { getProviderAuthHealthStore, projectAgentLoader = loadProjectAgentSnapshot, now: nowFn = Date.now, } = runtimeOptions;
    const warned = new Set();
    const runtimeReferenceId = `runtime:${randomUUID()}`;
    const runtimeEpoch = ++PROJECT_AGENT_RUNTIME_STATE.epoch;
    let activeProjectAgentSnapshot;
    let projectAgentLoadRequest = 0;
    setTlhProjectAgentAccessProvider(() => {
        const snapshot = activeProjectAgentSnapshot;
        if (!snapshot)
            return undefined;
        const architect = currentPrimaryAgentSelection() === "architect" &&
            isEnabledPrimaryAgentSelection(currentPrimaryAgentSelection()) &&
            activePrimaryAgent() !== undefined;
        return {
            capability: snapshot.capability,
            expected: snapshot.provenance,
            architect,
            ...(snapshot.reauthorizeTrust ? { reauthorize: snapshot.reauthorizeTrust } : {}),
        };
    });
    const primaryToolState = createPrimaryToolState();
    const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
    let primaryAgentDefaultSelection = DEFAULT_PRIMARY_AGENT;
    let sessionPrimaryAgentOverride;
    const preflightThrottle = new Map();
    const notifiedForReauth = new Set();
    const pendingReauthNotifications = new Set();
    function shouldPreflightAtDispatch(provider, store, now) {
        const entry = store.getEntry(provider);
        if (!entry)
            return true;
        if (entry.status === "healthy")
            return false;
        const throttle = preflightThrottle.get(provider);
        if (!throttle)
            return true;
        return now >= throttle.nextAllowedAt;
    }
    function shouldPreflightForClearing(provider, store, now) {
        const entry = store.getEntry(provider);
        if (!entry || entry.status === "healthy")
            return false;
        const throttle = preflightThrottle.get(provider);
        if (!throttle)
            return true;
        return now >= throttle.nextAllowedAt;
    }
    function emitReauthNotificationIfNew(provider, ctx, message) {
        if (notifiedForReauth.has(provider))
            return true;
        try {
            ctx.ui.notify(message, "warning");
            notifiedForReauth.add(provider);
            return true;
        }
        catch {
            return false;
        }
    }
    function scheduleProviderPreflight(provider, store, modelRegistry, currentNow, ctx) {
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
                notifiedForReauth.delete(provider);
            }
            else {
                const prev = preflightThrottle.get(provider);
                const newFailures = (prev?.failures ?? 0) + 1;
                preflightThrottle.set(provider, {
                    failures: newFailures,
                    nextAllowedAt: t + dispatchPreflightBackoffMs(newFailures),
                });
                if (status === "reauth-required" && ctx !== undefined) {
                    emitReauthNotificationIfNew(provider, ctx, `Provider ${provider} requires re-authentication. Run /login to reconfigure. ` +
                        `Opposite-provider independence for code-reviewer, oracle, and contrarian is affected.`);
                }
            }
        })
            .catch(() => {
        });
    }
    function warnOnce(ctx, key, message) {
        if (warned.has(key)) {
            return;
        }
        warned.add(key);
        ctx.ui.notify(message, "warning");
    }
    function warnInvalidPrimarySelection(ctx, source, value) {
        warnOnce(ctx, `invalid-primary-agent-${source}-${value}`, `TLH primary agent "${value}" is not valid; falling back to ${DEFAULT_PRIMARY_AGENT}. Available: ${PRIMARY_AGENT_CYCLE.join(", ")}.`);
    }
    function ensureLoadedPrimarySelection(ctx, selection, source) {
        if (selection === DISABLED_PRIMARY_AGENT || primaryAgents.has(selection)) {
            return selection;
        }
        warnOnce(ctx, `missing-primary-agent-${source}-${selection}`, `TLH primary agent "${selection}" is not available; falling back to ${DEFAULT_PRIMARY_AGENT}.`);
        return primaryAgents.has(DEFAULT_PRIMARY_AGENT)
            ? DEFAULT_PRIMARY_AGENT
            : DISABLED_PRIMARY_AGENT;
    }
    function syncPrimaryAgentState(ctx) {
        const previousSelection = currentPrimaryAgentSelection();
        const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
        const defaultResolution = resolvePrimaryAgentConfig(primaryConfig);
        if (defaultResolution.invalidSelected) {
            warnInvalidPrimarySelection(ctx, "default", defaultResolution.invalidSelected);
        }
        primaryAgentDefaultSelection = ensureLoadedPrimarySelection(ctx, defaultResolution.selection, "default");
        const sessionResolution = primaryAgentSelectionFromBranch(ctx.sessionManager.getBranch());
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
    function currentPrimaryAgentSelection() {
        return sessionPrimaryAgentOverride ?? primaryAgentDefaultSelection;
    }
    async function retainedProjectActionLookup(input) {
        if (!isRecord(input) || (input.action !== "resume" && input.action !== "steer")) {
            return { status: "missing", targetNames: [] };
        }
        const requestedId = typeof input.id === "string" && input.id.trim().length > 0
            ? input.id.trim()
            : typeof input.dir === "string" && input.dir.trim().length > 0
                ? basename(input.dir)
                : undefined;
        if (!requestedId)
            return { status: "missing", targetNames: [] };
        try {
            const lookup = await lookupTlhProjectAgentRunReference(requestedId);
            if (!isRecord(lookup) || typeof lookup.status !== "string") {
                return { status: "missing", targetNames: [] };
            }
            const targetNames = [
                ...new Set((Array.isArray(lookup.captures) ? lookup.captures : [])
                    .filter((entry) => isRecord(entry) && entry.source === "project")
                    .map((entry) => (typeof entry.agent === "string" ? entry.agent : ""))
                    .filter(Boolean)),
            ];
            if (lookup.status === "found" && typeof lookup.runId === "string") {
                return { status: "found", runId: lookup.runId, targetNames };
            }
            if (lookup.status === "ambiguous" &&
                Array.isArray(lookup.runIds) &&
                lookup.runIds.every((runId) => typeof runId === "string")) {
                return { status: "ambiguous", runIds: lookup.runIds, targetNames };
            }
        }
        catch {
        }
        return { status: "missing", targetNames: [] };
    }
    function projectSnapshotTargets(input) {
        const snapshot = activeProjectAgentSnapshot;
        if (!snapshot)
            return [];
        const projectNames = new Set([
            ...snapshot.entries.map((entry) => entry.name),
            ...snapshot.tombstones,
        ]);
        return collectSubagentCallTargetsMatching(input, (target) => isEmbeddedSubagentTarget(target) && projectNames.has(target));
    }
    function projectSnapshotCwdReason(input, ctx, snapshot) {
        if (!isRecord(input))
            return "TLH project-agent execution requires an object input.";
        const requestedCwd = input.cwd;
        if (requestedCwd !== undefined && typeof requestedCwd !== "string") {
            return "TLH project-agent execution requires a valid top-level cwd.";
        }
        const topLevelCwd = typeof requestedCwd === "string" && requestedCwd.length > 0
            ? resolve(ctx.cwd, requestedCwd)
            : ctx.cwd;
        const taskCwds = [];
        if (Array.isArray(input.tasks)) {
            for (const task of input.tasks) {
                taskCwds.push(isRecord(task) ? task.cwd : undefined);
            }
        }
        const validation = validatePrimaryProjectAgentCwdContainment(snapshot.provenance.projectRoot, topLevelCwd, taskCwds);
        return validation.valid
            ? undefined
            : `TLH project-agent execution blocked: ${validation.reason}`;
    }
    function activeProjectSnapshotIdentityReason(input, ctx, targets) {
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
    function activePrimaryAgent() {
        const selection = currentPrimaryAgentSelection();
        return selection === DISABLED_PRIMARY_AGENT ? undefined : primaryAgents.get(selection);
    }
    function currentPrimaryAgentLabel() {
        return primaryAgentLabel(currentPrimaryAgentSelection());
    }
    function buildActivePrimarySystemPrompt(baseSystemPrompt, cwd, settings) {
        const primary = activePrimaryAgent();
        const primaryEnabled = isEnabledPrimaryAgentSelection(currentPrimaryAgentSelection());
        const commitAttributionState = resolveTlhCommitAttribution(settings.tlh?.attribution);
        const prompts = [
            baseSystemPrompt,
            buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled),
            buildPrimaryExperimentalPrompt(primary, settings.tlh?.experimental),
            buildTlhCommitAttributionPrompt(commitAttributionState),
        ];
        if (shouldAppendGnosisPrompt(cwd)) {
            prompts.push(GNOSIS_PROMPT);
        }
        return prompts.filter(Boolean).join("\n\n");
    }
    function buildLaunchSystemPrompt(ctx, baseSystemPrompt) {
        return buildActivePrimarySystemPrompt(baseSystemPrompt, ctx.cwd, getTlhGlobalSettings(ctx.cwd));
    }
    function primaryAgentStatusMessage(ctx) {
        syncPrimaryAgentState(ctx);
        const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
        const override = sessionPrimaryAgentOverride;
        const effective = currentPrimaryAgentSelection();
        const settingsPath = tlhSettingsPathForWrite();
        const settingsLabel = settingsPath
            ? formatHomePath(settingsPath)
            : "unavailable outside isolated TLH profile";
        const activePrimary = effective !== DISABLED_PRIMARY_AGENT ? primaryAgents.get(effective) : undefined;
        const rawModelOverrides = primaryConfig?.modelOverrides;
        const modelOverride = activePrimary &&
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
    function setSessionPrimaryAgentOverride(selection) {
        sessionPrimaryAgentOverride = selection;
        if (selection === undefined) {
            pi.appendEntry(PRIMARY_AGENT_SESSION_STATE_ENTRY, {});
            return;
        }
        pi.appendEntry(PRIMARY_AGENT_SESSION_STATE_ENTRY, {
            enabled: selection !== DISABLED_PRIMARY_AGENT,
            selected: selection,
        });
    }
    function getValidPrimaryTools(ctx, primary, warnOnMissing = true) {
        const desiredTools = primaryToolAllowlist(primary);
        const allToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
        const validTools = filterAvailableTools(desiredTools, allToolNames);
        const missingTools = desiredTools.filter((tool) => !allToolNames.has(tool));
        if (warnOnMissing && missingTools.length > 0) {
            warnOnce(ctx, `missing-primary-tools-${primary?.name ?? DISABLED_PRIMARY_AGENT}`, `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`);
        }
        return validTools;
    }
    function applyPrimaryTools(ctx, primary, warnOnMissing = true) {
        const validTools = getValidPrimaryTools(ctx, primary, warnOnMissing);
        if (validTools.length === 0) {
            return;
        }
        pi.setActiveTools(primaryToolState.apply(validTools, pi.getActiveTools()));
    }
    function restorePrimaryToolsIfAppropriate() {
        if (!primaryToolState.hasPrePrimaryTools()) {
            return;
        }
        const restoredTools = primaryToolState.restoreIfAppropriate(pi.getActiveTools(), () => new Set(pi.getAllTools().map((tool) => tool.name)));
        if (restoredTools) {
            pi.setActiveTools(restoredTools);
        }
    }
    let tlhApplyingModel = false;
    let tlhApplyingThinking = false;
    const tlhInternalChange = new AsyncLocalStorage();
    let lastObservedModel;
    let sessionOnlyModel;
    let sessionThinkingOverride;
    let modelSelectionContext;
    let modelSelectionSession;
    function updateSessionOnlyModel(model) {
        sessionOnlyModel = model;
    }
    function isCurrentRuntime() {
        return runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch;
    }
    function modelsMatch(left, right) {
        return left?.provider === right?.provider && left?.id === right?.id;
    }
    function clearSessionThinkingOverride() {
        sessionThinkingOverride = undefined;
    }
    function beginModelSelectionSession(ctx) {
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
    function updateModelSelectionContext(ctx) {
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
    function endModelSelectionSession() {
        modelSelectionContext = undefined;
        const session = modelSelectionSession;
        modelSelectionSession = undefined;
        if (session && isCurrentRuntime()) {
            endTlhModelSelectionPersistenceSession(session);
        }
    }
    function setTlhThinkingLevel(level) {
        tlhApplyingThinking = true;
        try {
            tlhInternalChange.run(true, () => setExtensionThinkingLevel(pi, level));
        }
        finally {
            tlhApplyingThinking = false;
        }
    }
    function recordUserThinkingLevel(level) {
        const selection = currentPrimaryAgentSelection();
        if (!isThinkingLevel(level) || !isEnabledPrimaryAgentSelection(selection)) {
            return;
        }
        sessionThinkingOverride = { primary: selection, level };
    }
    function clampThinkingLevelForModel(level, model) {
        const availableLevels = model && "reasoning" in model
            ? getAvailableThinkingLevels(model)
            : [...THINKING_LEVELS];
        if (availableLevels.includes(level)) {
            return level;
        }
        const requestedIndex = THINKING_LEVELS.indexOf(level);
        if (requestedIndex >= 0) {
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
        return availableLevels[0] ?? "off";
    }
    function updateRetainedThinkingForModel(selection, model) {
        const override = sessionThinkingOverride;
        if (!override || override.primary !== selection) {
            return;
        }
        override.level = clampThinkingLevelForModel(override.level, model);
    }
    function sessionThinkingLevelForPrimary(selection, model) {
        const override = sessionThinkingOverride;
        if (!override || override.primary !== selection) {
            return undefined;
        }
        const clamped = clampThinkingLevelForModel(override.level, model);
        override.level = clamped;
        return clamped;
    }
    async function applyPrimaryModel(ctx, primary, model) {
        if (!model) {
            const candidateValues = [
                primary.preferredModel ? formatProviderModelReference(primary.preferredModel) : undefined,
                ...(primary.tlhModelDefaultsSource === "legacy" ? [primary.model] : []),
                ...listAgentModelDefaultReferences(primary).map(formatProviderModelReference),
            ].filter((candidate) => Boolean(candidate));
            const candidates = [...new Set(candidateValues)].join(", ");
            warnOnce(ctx, `missing-primary-model-${primary.name}`, `TLH primary agent models are not available for configured providers: ${candidates}`);
            return undefined;
        }
        if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
            return model;
        }
        tlhApplyingModel = true;
        let success;
        try {
            success = await tlhInternalChange.run(true, () => pi.setModel(model));
        }
        finally {
            tlhApplyingModel = false;
        }
        if (!success) {
            warnOnce(ctx, `primary-model-unavailable-${primary.name}`, `TLH could not switch to primary agent model: ${model.provider}/${model.id}`);
            return undefined;
        }
        return model;
    }
    function applyPrimaryThinking(cwd, selection, thinking, model) {
        const sessionThinking = sessionThinkingLevelForPrimary(selection, model);
        const durableThinking = getTlhDurableThinkingLevel(cwd);
        const requestedThinking = sessionThinking ?? durableThinking ?? thinking;
        if (requestedThinking === undefined) {
            return;
        }
        const targetThinking = clampThinkingLevelForModel(requestedThinking, model);
        if (pi.getThinkingLevel() === targetThinking) {
            return;
        }
        setTlhThinkingLevel(targetThinking);
    }
    async function applyPrimaryDefaults(ctx, options = {}) {
        const { warnOnMissing = true } = options;
        lastObservedModel = ctx.model;
        const selection = currentPrimaryAgentSelection();
        if (!isEnabledPrimaryAgentSelection(selection)) {
            try {
                applyPrimaryTools(ctx, primaryAgents.get(DEFAULT_PRIMARY_AGENT), warnOnMissing);
            }
            catch (error) {
                if (!isExtensionRuntimeNotInitializedError(error)) {
                    throw error;
                }
            }
            return;
        }
        const primary = activePrimaryAgent();
        if (!primary) {
            restorePrimaryToolsIfAppropriate();
            return;
        }
        applyPrimaryTools(ctx, primary, warnOnMissing);
        const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
        const shouldApplyModel = resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
        const shouldApplyThinking = resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyThinking");
        const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
        const primaryDefaults = selectProviderAwareAgentDefaults(primary, availableModels, ctx.model?.provider, ctx.model);
        let resolvedModel = primaryDefaults.model;
        const storedOverride = primaryConfig?.modelOverrides?.[selection];
        if (storedOverride) {
            const overrideRef = availableModels.find((m) => `${m.provider}/${m.id}` === storedOverride);
            if (overrideRef) {
                resolvedModel = overrideRef;
            }
        }
        const preservesSessionOnlyModel = sessionOnlyModel !== undefined &&
            ctx.model?.provider === sessionOnlyModel.provider &&
            ctx.model.id === sessionOnlyModel.id;
        if (sessionOnlyModel && !preservesSessionOnlyModel) {
            updateSessionOnlyModel(undefined);
        }
        const activePrimaryModel = shouldApplyModel && !preservesSessionOnlyModel
            ? await applyPrimaryModel(ctx, primary, resolvedModel)
            : undefined;
        if (shouldApplyThinking) {
            const effectiveModel = activePrimaryModel ?? ctx.model;
            applyPrimaryThinking(ctx.cwd, selection, resolveProviderThinking(primary, effectiveModel?.provider), effectiveModel);
        }
        lastObservedModel = activePrimaryModel ?? ctx.model;
    }
    async function applyPrimaryModeChange(ctx) {
        updateSessionOnlyModel(undefined);
        clearSessionThinkingOverride();
        await applyPrimaryDefaults(ctx);
    }
    function handlePersistedModelSelection(ctx, model) {
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
        const primaryDefaults = selectProviderAwareAgentDefaults(primary, getUnfilteredAvailableModels(ctx.modelRegistry), model.provider, model);
        const bundledKey = !followsOpenrouterSession(primary, model.provider) && primaryDefaults.model
            ? `${primaryDefaults.model.provider}/${primaryDefaults.model.id}`
            : undefined;
        const nextOverride = chosenKey === bundledKey ? undefined : chosenKey;
        const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
        const existingOverride = primaryConfig?.modelOverrides?.[selection];
        let writeResult;
        try {
            writeResult = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, nextOverride);
        }
        catch {
        }
        if (writeResult?.changed === true &&
            nextOverride !== undefined &&
            !isMeaningfulPrimaryOverride(existingOverride)) {
            recordOverrideBaseline(selection, primary, model.provider);
        }
    }
    async function resetPrimaryAgentModelOverride(ctx, agentName) {
        if (!isTlhPrimaryAgentSelection(agentName)) {
            return undefined;
        }
        const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, agentName, undefined);
        await applyPrimaryModeChange(ctx);
        return result;
    }
    function cleanDisabledPrimarySessionHint(selection) {
        return selection === DISABLED_PRIMARY_AGENT
            ? " Existing conversation history may still contain TLH primary-agent guidance; start a new session for a completely clean context."
            : "";
    }
    async function cycleSessionPrimaryAgent(ctx) {
        syncPrimaryAgentState(ctx);
        const nextOverride = nextPrimaryAgentSelection(currentPrimaryAgentSelection());
        setSessionPrimaryAgentOverride(nextOverride);
        await applyPrimaryModeChange(ctx);
        ctx.ui.notify(`Shift+Tab switched TLH primary agent to ${primaryAgentLabel(nextOverride)} for this session.${cleanDisabledPrimarySessionHint(nextOverride)}`, "info");
    }
    function parsePrimaryAgentSelection(value) {
        const normalized = value?.trim().toLowerCase();
        return normalized !== undefined && PRIMARY_AGENT_CYCLE.includes(normalized)
            ? normalized
            : undefined;
    }
    function switchPrimaryAgentCommandCompletions(prefix) {
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
    function registerCommands() {
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
                    ctx.ui.notify(`Cleared TLH primary-agent session override. Primary agent: ${currentPrimaryAgentLabel()}.`, "info");
                    return;
                }
                if (command === "model") {
                    if (parts.length !== 2 || value !== "reset") {
                        ctx.ui.notify("Usage: /switch-primary-agent model reset", "error");
                        return;
                    }
                    const selection = currentPrimaryAgentSelection();
                    if (selection === DISABLED_PRIMARY_AGENT) {
                        ctx.ui.notify("Cannot clear model override: primary agents are disabled. Enable a primary agent first with /switch-primary-agent <agent>.", "error");
                        return;
                    }
                    try {
                        const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, undefined);
                        await applyPrimaryModeChange(ctx);
                        const backupLabel = result.backupPath
                            ? ` Backup: ${formatHomePath(result.backupPath)}.`
                            : "";
                        ctx.ui.notify(`${result.changed ? "Cleared" : "No override to clear for"} model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`, "info");
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        ctx.ui.notify(`Could not clear model override: ${message}`, "error");
                    }
                    return;
                }
                const selected = parsePrimaryAgentSelection(command);
                if (selected) {
                    if (parts.length !== 1) {
                        ctx.ui.notify("Usage: /switch-primary-agent architect|rush|product|bug-hunter|disabled", "error");
                        return;
                    }
                    setSessionPrimaryAgentOverride(selected);
                    await applyPrimaryModeChange(ctx);
                    ctx.ui.notify(`TLH primary agent set to ${primaryAgentLabel(selected)} for this session.${cleanDisabledPrimarySessionHint(selected)}`, "info");
                    return;
                }
                if (command === "default") {
                    if (parts.length !== 2) {
                        ctx.ui.notify("Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset", "error");
                        return;
                    }
                    const defaultSelection = value === "reset" ? undefined : parsePrimaryAgentSelection(value);
                    if (value !== "reset" && !defaultSelection) {
                        ctx.ui.notify("Usage: /switch-primary-agent default architect|rush|product|bug-hunter|disabled|reset", "error");
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
                        ctx.ui.notify(`${changedLabel} TLH primary-agent persistent default at ${formatHomePath(result.settingsPath)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`, "info");
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        ctx.ui.notify(`Could not update TLH primary-agent persistent default: ${message}`, "error");
                    }
                    return;
                }
                ctx.ui.notify("Usage: /switch-primary-agent [status|architect|rush|product|bug-hunter|disabled|reset|model reset|default architect|default rush|default product|default bug-hunter|default disabled|default reset]", "error");
            },
        });
        pi.registerShortcut(PRIMARY_AGENT_CYCLE_SHORTCUT, {
            description: "Cycle TLH primary agent (architect/rush/product/bug-hunter/disabled)",
            handler: async (ctx) => {
                await cycleSessionPrimaryAgent(ctx);
            },
        });
    }
    async function loadProjectAgentSnapshotForSession(ctx) {
        const requestId = ++projectAgentLoadRequest;
        activeProjectAgentSnapshot = undefined;
        if (PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId) {
            await releaseTlhProjectAgentSnapshotReference(runtimeReferenceId);
            PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
        }
        const sessionId = sessionIdForContext(ctx);
        if (!sessionId)
            return;
        if (PROJECT_AGENT_RUNTIME_STATE.sessionId &&
            PROJECT_AGENT_RUNTIME_STATE.sessionId !== sessionId) {
            try {
                await releaseTlhProjectAgentRunReferencesForSession(PROJECT_AGENT_RUNTIME_STATE.sessionId);
            }
            catch {
            }
        }
        PROJECT_AGENT_RUNTIME_STATE.sessionId = sessionId;
        let loaded;
        try {
            loaded = await projectAgentLoader({
                cwd: ctx.cwd,
                sessionId,
                agentDir: getAgentDir(),
                defaultProjectTrust: defaultProjectTrustForCwd(ctx.cwd),
                trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
                context: {
                    isProjectTrusted: () => ctx.isProjectTrusted(),
                    hasUI: ctx.hasUI,
                    ui: typeof ctx.ui.confirm === "function"
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
        if (requestId !== projectAgentLoadRequest || runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch)
            return;
        const normalized = normalizeActiveProjectAgentSnapshot(loaded);
        if (!normalized)
            return;
        if (normalized.trust) {
            const loadedTrust = normalized.trust;
            normalized.reauthorizeTrust = async () => {
                try {
                    const current = await reauthorizeTlhProjectAgentTrust(normalized.provenance.projectRoot, {
                        sessionId,
                        agentDir: getAgentDir(),
                        defaultProjectTrust: defaultProjectTrustForCwd(ctx.cwd),
                        trustDependencies: PROJECT_AGENT_TRUST_DEPENDENCIES,
                        hasUI: false,
                        isProjectTrusted: () => ctx.isProjectTrusted(),
                    });
                    return Boolean(current?.trusted === true ||
                        (loadedTrust.source === "no-project-agents" &&
                            current?.source === "session-unavailable"));
                }
                catch {
                    return false;
                }
            };
        }
        try {
            await retainTlhProjectAgentSnapshotReference(normalized.capability, runtimeReferenceId);
            if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch) {
                await releaseTlhProjectAgentSnapshotReference(runtimeReferenceId);
                return;
            }
            PROJECT_AGENT_RUNTIME_STATE.referenceId = runtimeReferenceId;
        }
        catch {
        }
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch)
            return;
        activeProjectAgentSnapshot = normalized;
    }
    async function applySessionStart(ctx) {
        beginModelSelectionSession(ctx);
        updateSessionOnlyModel(undefined);
        clearSessionThinkingOverride();
        activateTlhTicketSessionScope(ctx.cwd);
        await loadProjectAgentSnapshotForSession(ctx);
        syncPrimaryAgentState(ctx);
        await applyPrimaryDefaults(ctx, { warnOnMissing: false });
    }
    function registerLifecycleHooks() {
        pi.on("thinking_level_select", (event, ctx) => {
            const modelChanged = lastObservedModel !== undefined &&
                ctx.model !== undefined &&
                !modelsMatch(lastObservedModel, ctx.model);
            const internalChange = tlhApplyingModel || tlhApplyingThinking || tlhInternalChange.getStore() === true;
            if (!internalChange) {
                if (modelChanged) {
                    const selection = currentPrimaryAgentSelection();
                    if (activePrimaryAgent()) {
                        updateRetainedThinkingForModel(selection, ctx.model);
                    }
                }
                else {
                    recordUserThinkingLevel(event.level);
                }
            }
            lastObservedModel = ctx.model;
        });
        pi.on("model_select", async (event, ctx) => {
            const persistedClaim = modelSelectionSession
                ? claimTlhModelSelectionDefaults(modelSelectionSession, event.model, event.previousModel)
                : undefined;
            lastObservedModel = event.model;
            updateModelSelectionContext(ctx);
            if (tlhApplyingModel) {
                updateSessionOnlyModel(undefined);
                return;
            }
            if (event.source === "set") {
                if (isTlhPersistedModelSelection(persistedClaim)) {
                    handlePersistedModelSelection(ctx, event.model);
                }
                else {
                    updateSessionOnlyModel(event.model);
                }
                return;
            }
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
            if (!authStore)
                return;
            for (const provider of pendingReauthNotifications) {
                const notified = emitReauthNotificationIfNew(provider, ctx, `A subagent run was rejected by ${provider} for credentials. ` +
                    `Opposite-provider independence for code-reviewer, oracle, and contrarian ` +
                    `was affected for that run. Run /login if this recurs.`);
                if (notified) {
                    pendingReauthNotifications.delete(provider);
                }
            }
            const currentNow = nowFn();
            for (const provider of authStore.getNonHealthyProviders()) {
                if (shouldPreflightForClearing(provider, authStore, currentNow)) {
                    scheduleProviderPreflight(provider, authStore, ctx.modelRegistry, currentNow, ctx);
                }
            }
        });
        pi.on("session_shutdown", async (_event, _ctx) => {
            projectAgentLoadRequest += 1;
            activeProjectAgentSnapshot = undefined;
            if (PROJECT_AGENT_RUNTIME_STATE.referenceId === runtimeReferenceId) {
                await releaseTlhProjectAgentSnapshotReference(runtimeReferenceId);
                PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
            }
            endModelSelectionSession();
            lastObservedModel = undefined;
            updateSessionOnlyModel(undefined);
            clearSessionThinkingOverride();
            restorePrimaryToolsIfAppropriate();
            notifiedForReauth.clear();
            pendingReauthNotifications.clear();
            preflightThrottle.clear();
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
                if (typeof event.input.command !== "string") {
                    return undefined;
                }
                const commitAttributionState = resolveTlhCommitAttribution(getTlhGlobalSettings(ctx.cwd).tlh?.attribution);
                const reason = getTlhGitCommitAttributionBlockReason(event.input.command, commitAttributionState);
                return reason ? { block: true, reason } : undefined;
            }
            if (event.toolName !== "subagent") {
                return undefined;
            }
            const subagentOverrides = getTlhSubagentOverrides(ctx.cwd);
            applyProviderAwareSubagentModels(event.input, subagentsByName, getUnfilteredAvailableModels(ctx.modelRegistry), ctx.model?.provider, ctx.model, {
                agentOverrides: subagentOverrides,
                onWarning: ({ agent, message }) => warnOnce(ctx, `subagent-override-warning-${agent}-${message}`, message),
            });
            capScoutSubagentTimeout(event.input);
            syncPrimaryAgentState(ctx);
            const selection = currentPrimaryAgentSelection();
            const allowedSubagents = allowedSubagentsForExperimentalConfig();
            const projectTargets = projectSnapshotTargets(event.input);
            const retainedProjectAction = await retainedProjectActionLookup(event.input);
            const retainedProjectTargets = retainedProjectAction.targetNames;
            const projectControlRequest = isSubagentResumeAction(event.input) || isSubagentSteerAction(event.input);
            let persistedProjectMarker = false;
            if (projectControlRequest && retainedProjectAction.status === "missing") {
                try {
                    const probe = await probeTlhProjectAgentRunMarker(event.input);
                    persistedProjectMarker = isRecord(probe) && probe.status === "present";
                }
                catch {
                }
            }
            const projectControlAction = projectControlRequest &&
                (retainedProjectAction.status !== "missing" || persistedProjectMarker);
            const retainedProjectLabel = retainedProjectTargets.length
                ? retainedProjectTargets.join(", ")
                : persistedProjectMarker
                    ? "persisted project-agent marker"
                    : "retained project-agent run";
            if (persistedProjectMarker) {
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
                if (projectTargets.length > 0 && !isOpaqueSubagentManagementActionInput(event.input)) {
                    return {
                        block: true,
                        reason: `TLH project-agent execution requires the architect primary agent. Target(s): ${projectTargets.join(", ")}.`,
                    };
                }
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
            const allowEmbeddedTargets = selection === "architect" || selection === DISABLED_PRIMARY_AGENT;
            const reason = validateSubagentToolInput(event.input, {
                allowedSubagents,
                allowEmbeddedTargets,
            });
            if (reason) {
                return { block: true, reason };
            }
            if (allowEmbeddedTargets && !isOpaqueSubagentManagementActionInput(event.input)) {
                if (projectTargets.length > 0) {
                    const snapshotReason = activeProjectSnapshotIdentityReason(event.input, ctx, projectTargets);
                    if (snapshotReason) {
                        return { block: true, reason: snapshotReason };
                    }
                }
                const projectTargetSet = new Set(projectTargets);
                const requestedProfileTargets = collectSubagentCallTargetsMatching(event.input, (target) => isEmbeddedSubagentTarget(target) && !projectTargetSet.has(target));
                if (requestedProfileTargets.length > 0) {
                    const authorizedEmbeddedTargets = new Set(loadAuthorizedEmbeddedSubagentRuntimeNames(getAgentDir()));
                    const unauthorizedTargets = requestedProfileTargets.filter((target) => !authorizedEmbeddedTargets.has(target));
                    if (unauthorizedTargets.length > 0) {
                        const authorizationSubject = selection === DISABLED_PRIMARY_AGENT
                            ? "TLH primary-agent infrastructure"
                            : "TLH architect";
                        return {
                            block: true,
                            reason: `${authorizationSubject} may delegate to embedded.<slug> only when a valid package: embedded / name: <slug> markdown definition currently exists under ${formatHomePath(join(getAgentDir(), "agents"))}. Unauthorized target(s): ${unauthorizedTargets.join(", ")}.`,
                        };
                    }
                }
            }
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
        pi.on("tool_result", (_event, _ctx) => {
            const event = _event;
            if (event.toolName !== "subagent")
                return;
            const authStore = getProviderAuthHealthStore?.();
            if (!authStore)
                return;
            const prevReauthProviders = new Set(authStore.getReauthProviders());
            processSubagentRunDetails(event.details, authStore);
            for (const provider of authStore.getReauthProviders()) {
                if (!prevReauthProviders.has(provider)) {
                    emitReauthNotificationIfNew(provider, _ctx, `A subagent run was rejected by ${provider} for credentials. ` +
                        `Opposite-provider independence for code-reviewer, oracle, and contrarian ` +
                        `was affected for that run. Run /login if this recurs.`);
                }
            }
        });
        if (typeof pi.events?.on === "function") {
            void pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
                const authStore = getProviderAuthHealthStore?.();
                if (!authStore)
                    return;
                const prevReauthProviders = new Set(authStore.getReauthProviders());
                processSubagentRunDetails(data, authStore);
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
export function registerTlhPrimaryAgentRuntime(pi, options = {}) {
    setTlhProjectAgentAccessProvider(undefined);
    if (PROJECT_AGENT_RUNTIME_STATE.referenceId) {
        const previousReferenceId = PROJECT_AGENT_RUNTIME_STATE.referenceId;
        PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
        void releaseTlhProjectAgentSnapshotReference(previousReferenceId);
    }
    const env = options.env ?? process.env;
    const childPromptBuilder = () => buildChildSubagentSystemPrompt();
    if (registerTlhStartupMode(pi, {
        env,
        buildChildSubagentSystemPrompt: childPromptBuilder,
        registerChild: () => {
            registerChildSubagentRuntime(pi, childPromptBuilder, env);
        },
    }) === "child") {
        return undefined;
    }
    const runtime = createTlhPrimaryAgentRuntime(pi, options.primaryAgents ?? loadPrimaryAgents(), options.subagentMetadata ?? loadSubagentMetadata(), {
        getProviderAuthHealthStore: options.getProviderAuthHealthStore,
        projectAgentLoader: options.projectAgentLoader,
        now: options.now,
    });
    runtime.registerCommands();
    runtime.registerLifecycleHooks();
    if (!installTlhModelSelectionPersistenceOverride(options.bundledAgentSessionConstructor) &&
        tlhSettingsPathForWrite()) {
        throw new Error("[TLH] Could not install the Pi AgentSession.setModel persistence seam for the isolated profile.");
    }
    return runtime;
}
function isTlhPrimaryAgentSelection(value) {
    return PRIMARY_AGENT_CYCLE.includes(value);
}
export function clearPrimaryAgentModelOverrideByName(cwd, agentName) {
    if (!isTlhPrimaryAgentSelection(agentName)) {
        return undefined;
    }
    return writeTlhPrimaryAgentModelOverride(cwd, agentName, undefined);
}
