import { createHash, randomUUID } from "node:crypto";
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
import { loadProjectDefaults } from "./project-defaults-loader-bridge.mjs";
import { lookupTlhProjectAgentRunReference, probeTlhProjectAgentRunMarker, setTlhProjectAgentAccessProvider, } from "./project-agent-access.mjs";
import { releaseTlhProjectAgentRunReferencesForSession, releaseTlhProjectAgentSnapshotReference, retainTlhProjectAgentSnapshotReference, } from "./project-agent-access.mjs";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, THINKING_LEVELS, TLH_NAME, TLH_PACKAGE_NAME, } from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import { applyProviderAwareSubagentModels, followsOpenrouterSession, formatProviderModelReference, listAgentModelDefaultReferences, parseProviderModelReference, resolveProviderThinking, selectProviderAwareAgentDefaults, } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { beginTlhModelSelectionPersistenceSession, claimTlhModelSelectionDefaults, endTlhModelSelectionPersistenceSession, installTlhModelSelectionPersistenceOverride, isTlhPersistedModelSelection, updateTlhModelSelectionPersistenceContext, } from "./model-selection-scope.js";
import { getAvailableThinkingLevels, isThinkingLevel, setExtensionThinkingLevel, } from "./thinking.js";
import { appendBeforeChildSubagentBoundary } from "../shared/subagent-child-boundary.js";
import { inventoryProjectAgentGuidance, } from "../shared/project-agent-guidance.js";
import { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata, } from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite, withLockedTlhSettingsWrite } from "./profile-state.js";
const PROJECT_PRIMARY_AGENT_NAMES = new Set([
    "architect",
    "rush",
    "product",
    "bug-hunter",
]);
const PROJECT_SUBAGENT_ROLE_NAMES = new Set([
    "code-reviewer",
    "contrarian",
    "developer",
    "diff-summarizer",
    "librarian",
    "oracle",
    "repo-scout",
    "web-scout",
]);
const MAX_PROJECT_DEFAULT_WARNINGS = 20;
const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
const MAX_PROJECT_DEFAULT_WARNING_COUNT = 1_000_000;
const PROJECT_DEFAULTS_WARNING_SUMMARY_PATTERN = /^…and ([1-9][0-9]*) more issues in \.tlh\/defaults\.json$/;
function truncateProjectDefaultsWarning(message) {
    if (message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH)
        return message;
    return `${message.slice(0, MAX_PROJECT_DEFAULT_WARNING_LENGTH - 1)}…`;
}
function saturatingProjectDefaultsWarningCount(value) {
    if (!Number.isFinite(value) || value >= MAX_PROJECT_DEFAULT_WARNING_COUNT) {
        return MAX_PROJECT_DEFAULT_WARNING_COUNT;
    }
    return value > 0 ? Math.floor(value) : 0;
}
function addProjectDefaultsWarningCounts(current, additional) {
    const boundedCurrent = saturatingProjectDefaultsWarningCount(current);
    const boundedAdditional = saturatingProjectDefaultsWarningCount(additional);
    if (boundedCurrent >= MAX_PROJECT_DEFAULT_WARNING_COUNT - boundedAdditional ||
        boundedAdditional >= MAX_PROJECT_DEFAULT_WARNING_COUNT) {
        return MAX_PROJECT_DEFAULT_WARNING_COUNT;
    }
    return boundedCurrent + boundedAdditional;
}
function projectDefaultsWarningSummaryCount(message) {
    const match = PROJECT_DEFAULTS_WARNING_SUMMARY_PATTERN.exec(message);
    if (!match)
        return undefined;
    return saturatingProjectDefaultsWarningCount(Number(match[1]));
}
function projectDefaultsWarningRoot(projectRoot, cwd) {
    return (canonicalExistingProjectRoot(projectRoot) ?? canonicalExistingProjectRoot(cwd) ?? resolve(cwd));
}
function projectDefaultsWarningKey(projectRoot, cwd, agent, message, identityMessage = message) {
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
function unavailableProjectModelWarningMessage(selection, modelReference) {
    const prefix = `TLH project default model "`;
    const suffix = `" for ${selection} is not available; falling back to stored or bundled defaults.`;
    const maxModelLength = Math.max(0, MAX_PROJECT_DEFAULT_WARNING_LENGTH - prefix.length - suffix.length);
    const boundedModel = modelReference.length <= maxModelLength
        ? modelReference
        : maxModelLength > 0
            ? `${modelReference.slice(0, maxModelLength - 1)}…`
            : "";
    return truncateProjectDefaultsWarning(`${prefix}${boundedModel}${suffix}`);
}
function normalizeProjectDefaultsWarnings(value) {
    if (!Array.isArray(value))
        return [];
    const retained = [];
    const seen = new Set();
    let omittedCount = 0;
    let loaderSummaryCount = 0;
    let hasLoaderSummary = false;
    for (const rawWarning of value) {
        if (typeof rawWarning !== "string" || rawWarning.length === 0)
            continue;
        const summaryCount = projectDefaultsWarningSummaryCount(rawWarning);
        if (summaryCount !== undefined) {
            if (!hasLoaderSummary) {
                hasLoaderSummary = true;
                loaderSummaryCount = summaryCount;
            }
            continue;
        }
        const warning = truncateProjectDefaultsWarning(rawWarning);
        if (seen.has(warning))
            continue;
        if (retained.length < MAX_PROJECT_DEFAULT_WARNINGS) {
            retained.push(warning);
            seen.add(warning);
        }
        else {
            omittedCount = addProjectDefaultsWarningCounts(omittedCount, 1);
        }
    }
    const totalOmitted = addProjectDefaultsWarningCounts(loaderSummaryCount, omittedCount);
    if (totalOmitted > 0) {
        retained.push(truncateProjectDefaultsWarning(`…and ${totalOmitted} more issues in .tlh/defaults.json`));
    }
    return retained;
}
const PROJECT_AGENT_RUNTIME_GLOBAL_KEY = Symbol.for("the-last-harness.project-agent-runtime-state");
const PROJECT_AGENT_RUNTIME_GLOBAL = globalThis;
const PROJECT_AGENT_RUNTIME_STATE = PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] ??
    (PROJECT_AGENT_RUNTIME_GLOBAL[PROJECT_AGENT_RUNTIME_GLOBAL_KEY] = { epoch: 0 });
const PROJECT_AGENT_TRUST_DEPENDENCIES = {
    createProjectTrustStore: (agentDir) => new ProjectTrustStore(agentDir),
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
function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isProjectPrimaryAgentName(value) {
    return PROJECT_PRIMARY_AGENT_NAMES.has(value);
}
function isProjectSubagentRoleName(value) {
    return PROJECT_SUBAGENT_ROLE_NAMES.has(value);
}
function isValidProjectModelReference(value) {
    return typeof value === "string" && parseProviderModelReference(value) !== undefined;
}
function canonicalExistingProjectRoot(value) {
    if (!nonEmptyString(value))
        return undefined;
    try {
        const canonical = fs.realpathSync(value);
        return fs.statSync(canonical).isDirectory() ? canonical : undefined;
    }
    catch {
        return undefined;
    }
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
    const rawTrust = value.trust;
    const trust = isRecord(rawTrust) &&
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
function isPersistedProjectAgentTrustDenial(value) {
    if (!isRecord(value) || value.status !== "denied")
        return false;
    if (!nonEmptyString(value.projectRoot) || !nonEmptyString(value.agentsDirectory))
        return false;
    const trust = value.trust;
    return (isRecord(trust) &&
        trust.kind === "project-agent" &&
        trust.trusted === false &&
        typeof trust.source === "string" &&
        PERSISTED_PROJECT_AGENT_TRUST_DENIAL_SOURCES.has(trust.source));
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
function hasExplicitDispatchModel(target) {
    if (!isRecord(target))
        return false;
    const model = target.model;
    if (typeof model !== "string")
        return false;
    const normalized = model.trim();
    return normalized.length > 0 && normalized !== "inherit";
}
function applyProviderAwareModelsToNonProjectTargets(input, agents, availableModels, currentProvider, currentModel, options) {
    if (!isRecord(input))
        return;
    if ((!Array.isArray(input.tasks) || input.tasks.length === 0) &&
        !isEmbeddedSubagentTarget(input.agent)) {
        applyProviderAwareSubagentModels(input, agents, availableModels, currentProvider, currentModel, options);
        return;
    }
    if (!Array.isArray(input.tasks))
        return;
    for (const task of input.tasks) {
        if (isRecord(task) && !isEmbeddedSubagentTarget(task.agent)) {
            applyProviderAwareSubagentModels(task, agents, availableModels, currentProvider, currentModel, options);
        }
    }
}
function applyOpenRouterModelToProjectTargets(input, projectTargets, currentModel) {
    if (!isRecord(input) || currentModel?.provider !== "openrouter")
        return;
    const projectTargetSet = new Set(projectTargets);
    const apply = (target) => {
        if (!isRecord(target) ||
            typeof target.agent !== "string" ||
            !projectTargetSet.has(target.agent.trim()) ||
            hasExplicitDispatchModel(target)) {
            return;
        }
        target.model = `${currentModel.provider}/${currentModel.id}`;
    };
    apply(input);
    if (Array.isArray(input.tasks)) {
        for (const task of input.tasks)
            apply(task);
    }
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
    const { getProviderAuthHealthStore, projectAgentLoader = loadProjectAgentSnapshot, projectDefaultsLoader: projectDefaultsLoaderFn = loadProjectDefaults, now: nowFn = Date.now, } = runtimeOptions;
    const warned = new Set();
    const projectDefaultsWarned = new Set();
    const runtimeOwnerPrefix = `runtime:${randomUUID()}`;
    let runtimeReferenceId = `${runtimeOwnerPrefix}:owner:${randomUUID()}`;
    const runtimeEpoch = ++PROJECT_AGENT_RUNTIME_STATE.epoch;
    let activeProjectAgentSnapshot;
    let projectAgentLoadRequest = 0;
    let projectAgentTrustWarningSessionId;
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
    const noticed = new Set();
    let activeProjectDefaults;
    let sessionStartRequestId = 0;
    function isCurrentSessionStartOperation(operation) {
        return (operation.requestId === sessionStartRequestId &&
            operation.runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch);
    }
    setTlhProjectAgentAccessProvider(() => {
        const snapshot = activeProjectAgentSnapshot;
        if (!snapshot)
            return undefined;
        const selection = currentPrimaryAgentSelection();
        const architect = selection === "architect" &&
            isEnabledPrimaryAgentSelection(selection) &&
            activePrimaryAgent() !== undefined;
        return {
            capability: snapshot.capability,
            expected: snapshot.provenance,
            architect,
            canInitiate: architect || selection === DISABLED_PRIMARY_AGENT,
            ...(snapshot.reauthorizeTrust ? { reauthorize: snapshot.reauthorizeTrust } : {}),
            ...(snapshot.rebindProjectAgent ? { rebind: snapshot.rebindProjectAgent } : {}),
        };
    });
    const primaryToolState = createPrimaryToolState();
    const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
    let primaryAgentDefaultSelection = DEFAULT_PRIMARY_AGENT;
    let sessionPrimaryAgentOverride;
    let sessionProjectAgentGuidanceSnapshot;
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
    function noticeOnce(ctx, key, message) {
        if (noticed.has(key)) {
            return;
        }
        noticed.add(key);
        try {
            ctx.ui.notify(message, "info");
        }
        catch {
        }
    }
    function normalizeProjectDefaultsResult(value, cwd) {
        if (!isRecord(value) || !Object.hasOwn(value, "status"))
            return undefined;
        const status = value.status;
        if (status !== "loaded" && status !== "denied" && status !== "unavailable")
            return undefined;
        const warnings = normalizeProjectDefaultsWarnings(value.warnings);
        if (status !== "loaded") {
            return { status, projectRoot: undefined, primaryAgents: {}, subagents: {}, warnings };
        }
        const rawDefaults = Object.hasOwn(value, "defaults") ? value.defaults : undefined;
        const primaryAgents = {};
        const subagents = {};
        function normalizeSection(raw, target, isAllowedRole) {
            if (!isRecord(raw))
                return;
            for (const [name, rawEntry] of Object.entries(raw)) {
                if (!isAllowedRole(name) || !isRecord(rawEntry))
                    continue;
                if (Object.keys(rawEntry).some((key) => key !== "model" && key !== "effort")) {
                    continue;
                }
                let model;
                if (Object.hasOwn(rawEntry, "model")) {
                    if (!isValidProjectModelReference(rawEntry.model))
                        continue;
                    model = rawEntry.model;
                }
                let effort;
                if (Object.hasOwn(rawEntry, "effort")) {
                    if (typeof rawEntry.effort !== "string" || !isThinkingLevel(rawEntry.effort)) {
                        continue;
                    }
                    effort = rawEntry.effort;
                }
                if (model === undefined && effort === undefined)
                    continue;
                const entry = {};
                if (model !== undefined)
                    entry.model = model;
                if (effort !== undefined)
                    entry.effort = effort;
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
        const hasActiveDefaults = Object.keys(primaryAgents).length > 0 || Object.keys(subagents).length > 0;
        if (hasActiveDefaults) {
            if (!projectRoot)
                return undefined;
            const cwdValidation = validatePrimaryProjectAgentCwdContainment(projectRoot, cwd, []);
            if (!cwdValidation.valid)
                return undefined;
            const trust = value.trust;
            if (!isRecord(trust) ||
                !Object.hasOwn(trust, "kind") ||
                !Object.hasOwn(trust, "trusted") ||
                !Object.hasOwn(trust, "source") ||
                trust.kind !== "project-config" ||
                trust.trusted !== true ||
                typeof trust.source !== "string" ||
                !PROJECT_CONFIG_TRUST_POSITIVE_SOURCES.has(trust.source)) {
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
    function activeProjectDefaultsForCwd(cwd) {
        if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch)
            return undefined;
        const defaults = activeProjectDefaults;
        if (defaults?.status !== "loaded" || !defaults.projectRoot)
            return undefined;
        const validation = validatePrimaryProjectAgentCwdContainment(defaults.projectRoot, cwd, []);
        return validation.valid ? defaults : undefined;
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
            buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled, sessionProjectAgentGuidanceSnapshot),
            buildPrimaryExperimentalPrompt(primary, settings.tlh?.experimental),
            buildTlhCommitAttributionPrompt(commitAttributionState),
        ];
        if (shouldAppendGnosisPrompt(cwd)) {
            prompts.push(GNOSIS_PROMPT);
        }
        return prompts.filter(Boolean).join("\n\n");
    }
    function notifyUndecidedProjectAgentGuidance(ctx, inventory) {
        if (ctx.hasUI === false || inventory.trust !== "undecided" || inventory.files.length === 0) {
            return;
        }
        const diagnostic = inventory.diagnostics.find(({ code }) => code === "project-not-trusted");
        if (!diagnostic) {
            return;
        }
        try {
            ctx.ui.notify(diagnostic.message, "warning");
        }
        catch {
        }
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
    async function applyPrimaryModel(ctx, primary, model, _source) {
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
    function applyPrimaryThinking(cwd, selection, thinking, model, projectEffort) {
        const sessionThinking = sessionThinkingLevelForPrimary(selection, model);
        const durableThinking = getTlhDurableThinkingLevel(cwd);
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
    async function applyPrimaryDefaults(ctx, options = {}) {
        const { warnOnMissing = true, sessionStartOperation } = options;
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        lastObservedModel = ctx.model;
        const selection = currentPrimaryAgentSelection();
        if (!isEnabledPrimaryAgentSelection(selection)) {
            if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
                return;
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
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        const primary = activePrimaryAgent();
        if (!primary) {
            restorePrimaryToolsIfAppropriate();
            return;
        }
        applyPrimaryTools(ctx, primary, warnOnMissing);
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
        const shouldApplyModel = resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
        const shouldApplyThinking = resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyThinking");
        const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
        const primaryDefaults = selectProviderAwareAgentDefaults(primary, availableModels, ctx.model?.provider, ctx.model);
        const preservesSessionOnlyModel = sessionOnlyModel !== undefined &&
            ctx.model?.provider === sessionOnlyModel.provider &&
            ctx.model?.id === sessionOnlyModel.id;
        if (sessionOnlyModel && !preservesSessionOnlyModel) {
            updateSessionOnlyModel(undefined);
        }
        let resolvedModel = primaryDefaults.model;
        let resolvedModelSource = "existing";
        let projectModelCandidate;
        let projectEffort;
        const storedOverride = primaryConfig?.modelOverrides?.[selection];
        if (storedOverride) {
            const overrideRef = availableModels.find((m) => `${m.provider}/${m.id}` === storedOverride);
            if (overrideRef) {
                resolvedModel = overrideRef;
            }
        }
        const projectDefaults = activeProjectDefaultsForCwd(ctx.cwd);
        const projectEntry = projectDefaults && isProjectPrimaryAgentName(selection)
            ? projectDefaults.primaryAgents[selection]
            : undefined;
        if (projectDefaults?.projectRoot && projectEntry) {
            if (!preservesSessionOnlyModel && projectEntry.model !== undefined) {
                const projectModelRef = availableModels.find((m) => `${m.provider}/${m.id}` === projectEntry.model);
                if (projectModelRef) {
                    resolvedModel = projectModelRef;
                    resolvedModelSource = "project";
                    projectModelCandidate = { reference: projectEntry.model, model: projectModelRef };
                }
                else {
                    const warning = unavailableProjectModelWarningMessage(selection, projectEntry.model);
                    warnProjectDefaultsOnce(ctx, projectDefaults.projectRoot, selection, warning, `${warning}\0${projectEntry.model}`);
                }
            }
            if (projectEntry.effort !== undefined && isThinkingLevel(projectEntry.effort)) {
                projectEffort = projectEntry.effort;
            }
        }
        if (sessionOnlyModel && !preservesSessionOnlyModel) {
            updateSessionOnlyModel(undefined);
        }
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        const activePrimaryModel = shouldApplyModel && !preservesSessionOnlyModel
            ? await applyPrimaryModel(ctx, primary, resolvedModel, resolvedModelSource)
            : undefined;
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        const appliedProjectModel = projectModelCandidate !== undefined &&
            modelsMatch(activePrimaryModel, projectModelCandidate.model)
            ? projectModelCandidate.reference
            : undefined;
        let appliedProjectEffort;
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        if (shouldApplyThinking) {
            const effectiveModel = activePrimaryModel ?? ctx.model;
            appliedProjectEffort = applyPrimaryThinking(ctx.cwd, selection, resolveProviderThinking(primary, effectiveModel?.provider), effectiveModel, projectEffort);
        }
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
        if (appliedProjectModel !== undefined || appliedProjectEffort !== undefined) {
            const appliedParts = [];
            if (appliedProjectModel !== undefined) {
                appliedParts.push(`model ${appliedProjectModel}`);
            }
            if (appliedProjectEffort !== undefined) {
                appliedParts.push(`effort ${appliedProjectEffort}`);
            }
            if (appliedParts.length > 0) {
                noticeOnce(ctx, `project-defaults-applied-${selection}`, `TLH applied project defaults for ${selection}: ${appliedParts.join(", ")}.`);
            }
        }
        if (sessionStartOperation && !isCurrentSessionStartOperation(sessionStartOperation))
            return;
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
    async function applySessionStart(ctx) {
        const sessionStartOperation = {
            requestId: ++sessionStartRequestId,
            runtimeEpoch,
        };
        activeProjectDefaults = undefined;
        projectDefaultsWarned.clear();
        noticed.clear();
        beginModelSelectionSession(ctx);
        updateSessionOnlyModel(undefined);
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        clearSessionThinkingOverride();
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        noticed.clear();
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        activateTlhTicketSessionScope(ctx.cwd);
        await loadProjectAgentSnapshotForSession(ctx);
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        sessionProjectAgentGuidanceSnapshot = inventoryProjectAgentGuidance(ctx.cwd, getAgentDir());
        notifyUndecidedProjectAgentGuidance(ctx, sessionProjectAgentGuidanceSnapshot);
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        await loadProjectDefaultsForSession(ctx, sessionStartOperation);
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        syncPrimaryAgentState(ctx);
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
        await applyPrimaryDefaults(ctx, {
            warnOnMissing: false,
            sessionStartOperation,
        });
        if (!isCurrentSessionStartOperation(sessionStartOperation))
            return;
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
            sessionStartRequestId += 1;
            const shutdownRequestId = ++projectAgentLoadRequest;
            const previousReferenceId = runtimeEpoch === PROJECT_AGENT_RUNTIME_STATE.epoch &&
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
                }
                catch {
                    released = false;
                }
                if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                    shutdownRequestId !== projectAgentLoadRequest) {
                    return;
                }
                if (released && PROJECT_AGENT_RUNTIME_STATE.referenceId === previousReferenceId) {
                    PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
                }
            }
            if (runtimeEpoch !== PROJECT_AGENT_RUNTIME_STATE.epoch ||
                shutdownRequestId !== projectAgentLoadRequest) {
                return;
            }
            endModelSelectionSession();
            lastObservedModel = undefined;
            updateSessionOnlyModel(undefined);
            clearSessionThinkingOverride();
            sessionProjectAgentGuidanceSnapshot = undefined;
            noticed.clear();
            restorePrimaryToolsIfAppropriate();
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
            const projectDefaults = activeProjectDefaultsForCwd(ctx.cwd);
            const subagentProjectDefaults = projectDefaults?.subagents;
            applyProviderAwareModelsToNonProjectTargets(event.input, subagentsByName, getUnfilteredAvailableModels(ctx.modelRegistry), ctx.model?.provider, ctx.model, {
                agentOverrides: subagentOverrides,
                projectDefaults: subagentProjectDefaults,
                onWarning: ({ agent, message, source }) => {
                    if (source === "project-default") {
                        warnProjectDefaultsOnce(ctx, projectDefaults?.projectRoot, agent, message);
                        return;
                    }
                    warnOnce(ctx, `subagent-override-warning-${agent}-${message}`, message);
                },
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
            if (persistedProjectMarker &&
                (!isSubagentResumeAction(event.input) || !activeProjectAgentSnapshot?.rebindProjectAgent)) {
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
                    const authorizationSubject = selection === DISABLED_PRIMARY_AGENT
                        ? "TLH primary-agent infrastructure"
                        : "TLH architect";
                    return {
                        block: true,
                        reason: `${authorizationSubject} may delegate to embedded.<slug> only when a valid package: embedded / name: <slug> markdown definition exists at the validated Git-root path .tlh/agents/custom/<UPPERCASE-SLUG>.md. Persist project trust with /trust, then retry. Unauthorized target(s): ${requestedProfileTargets.join(", ")}.`,
                    };
                }
            }
            applyOpenRouterModelToProjectTargets(event.input, projectTargets, ctx.model);
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
export function registerTlhPrimaryAgentRuntime(pi, options = {}) {
    setTlhProjectAgentAccessProvider(undefined);
    if (PROJECT_AGENT_RUNTIME_STATE.referenceId) {
        const previousReferenceId = PROJECT_AGENT_RUNTIME_STATE.referenceId;
        PROJECT_AGENT_RUNTIME_STATE.referenceId = undefined;
        void releaseTlhProjectAgentSnapshotReference(previousReferenceId).catch(() => {
        });
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
        projectDefaultsLoader: options.projectDefaultsLoader,
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
