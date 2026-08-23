import { join } from "node:path";
import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRIMARY_AGENT, DISABLED_PRIMARY_AGENT, PRIMARY_AGENT_CYCLE, PRIMARY_AGENT_SESSION_STATE_ENTRY, isEnabledPrimaryAgentSelection, nextPrimaryAgentSelection, primaryAgentDefaultLabel, primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig, } from "../the-last-harness-primary-agent.mjs";
import { createPrimaryToolState, filterAvailableTools, } from "../the-last-harness-primary-tools.mjs";
import { allowedSubagentsForExperimentalConfig, collectSubagentTargets, isEmbeddedSubagentTarget, isExperimentalFeatureEnabled, registerTlhStartupMode, validateSubagentToolInput, } from "../the-last-harness-subagent-safety.mjs";
import { buildTlhCommitAttributionPrompt, getTlhGitCommitAttributionBlockReason, resolveTlhCommitAttribution, } from "./attribution.js";
import { formatHomePath, isRecord } from "./common.js";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, TLH_NAME, TLH_PACKAGE_NAME, } from "./constants.js";
import { EMBEDDED_SUBAGENTS_FEATURE, buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt, } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import { applyProviderAwareSubagentModels, parseProviderModelReference, resolveProviderThinking, selectProviderAwareAgentDefaults, } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { beginTlhModelSelectionDefaultSuppression, chooseTlhModelSelectionScope, claimTlhModelSelectionDefaults, discardTlhModelSelectionDefaults, installTlhModelSelectionPersistenceOverride, isTlhNativeModelSelectorClaim, persistTlhModelSelectionDefaults, persistTlhStandaloneThinkingDefaults, replayAllTlhUnclaimedModelSelectionDefaults, replayTlhUnmatchedModelSelectionDefaults, setTlhModelSelectionActiveModelResolver, setTlhSessionOnlyModel, } from "./model-selection-scope.js";
import { isThinkingLevel, setExtensionThinkingLevel, thinkingLevelAtLeast } from "./thinking.js";
import { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadAuthorizedEmbeddedSubagentRuntimeNames, loadPrimaryAgents, loadSubagentMetadata, } from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite, withLockedTlhSettingsWrite } from "./profile-state.js";
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
function shouldForceApplyForLock(primary) {
    return primary.lockThinking === true;
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
        return "TLH Product may not delegate to embedded subagents. Embedded subagent delegation is reserved for the architect primary agent.";
    }
    if (selection === "bug-hunter") {
        return "TLH Bug-Hunter may not delegate to embedded subagents. Embedded subagent delegation is reserved for the architect primary agent.";
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
    const { getProviderAuthHealthStore, now: nowFn = Date.now } = runtimeOptions;
    const warned = new Set();
    const primaryToolState = createPrimaryToolState();
    const subagentsByName = new Map(subagentMetadata.map((agent) => [agent.name, agent]));
    let primaryAgentDefaultSelection = DEFAULT_PRIMARY_AGENT;
    let sessionPrimaryAgentOverride;
    let sessionExperimentalSnapshot;
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
    }
    function currentPrimaryAgentSelection() {
        return sessionPrimaryAgentOverride ?? primaryAgentDefaultSelection;
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
            buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled, sessionExperimentalSnapshot),
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
            warnOnce(ctx, `missing-primary-tools-${primary.name}`, `TLH primary agent tools are not available yet: ${missingTools.join(", ")}`);
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
    let tlhRestoringCancelledModel = false;
    let sessionOnlyModel;
    function updateSessionOnlyModel(model) {
        sessionOnlyModel = model;
        setTlhSessionOnlyModel(model);
    }
    async function applyPrimaryModel(ctx, primary, model) {
        if (!model) {
            const candidates = [primary.model, ...(primary.tlhOpenaiModels ?? [])]
                .filter(Boolean)
                .join(", ");
            warnOnce(ctx, `missing-primary-model-${primary.name}`, `TLH primary agent models are not available for configured providers: ${candidates}`);
            return undefined;
        }
        if (ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
            return model;
        }
        tlhApplyingModel = true;
        let success;
        try {
            success = await pi.setModel(model);
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
    function currentThinkingSatisfiesPrimaryFloor(primary, currentThinking) {
        return (primary.lockThinking !== true &&
            primary.minThinking !== undefined &&
            isThinkingLevel(currentThinking) &&
            thinkingLevelAtLeast(currentThinking, primary.minThinking));
    }
    function applyPrimaryThinking(primary, thinking) {
        if (!thinking) {
            return;
        }
        const currentThinking = pi.getThinkingLevel();
        if (currentThinking === thinking ||
            currentThinkingSatisfiesPrimaryFloor(primary, currentThinking)) {
            return;
        }
        setExtensionThinkingLevel(pi, thinking);
    }
    async function restoreCancelledModel(ctx, previousModel) {
        if (!previousModel) {
            return;
        }
        const releaseDefaultSuppression = beginTlhModelSelectionDefaultSuppression();
        tlhRestoringCancelledModel = true;
        tlhApplyingModel = true;
        try {
            const restored = await pi.setModel(previousModel);
            if (restored) {
                setImmediate(() => {
                    try {
                        if (ctx.model?.provider === previousModel.provider &&
                            ctx.model.id === previousModel.id) {
                            ctx.ui.notify(`Kept ${previousModel.provider}/${previousModel.id} after cancelling model selection.`, "info");
                        }
                    }
                    catch {
                    }
                });
            }
            else {
                ctx.ui.notify(`TLH could not restore the previous model: ${previousModel.provider}/${previousModel.id}`, "warning");
            }
        }
        catch {
            ctx.ui.notify(`TLH could not restore the previous model: ${previousModel.provider}/${previousModel.id}`, "warning");
        }
        finally {
            releaseDefaultSuppression();
            discardTlhModelSelectionDefaults();
            tlhApplyingModel = false;
            tlhRestoringCancelledModel = false;
        }
    }
    async function applyPrimaryDefaults(ctx, options = {}) {
        const { warnOnMissing = true } = options;
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
        const shouldApplyModel = forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyModel");
        const shouldApplyThinking = forceApply || resolvePrimaryAutoApplySetting(primaryConfig, primary, "applyThinking");
        const availableModels = getUnfilteredAvailableModels(ctx.modelRegistry);
        const primaryDefaults = selectProviderAwareAgentDefaults(primary, availableModels, ctx.model?.provider, ctx.model);
        let resolvedModel = primaryDefaults.model;
        if (!forceApply) {
            const storedOverride = primaryConfig?.modelOverrides?.[selection];
            if (storedOverride) {
                const overrideRef = availableModels.find((m) => `${m.provider}/${m.id}` === storedOverride);
                if (overrideRef) {
                    resolvedModel = overrideRef;
                }
            }
        }
        const preservesSessionOnlyModel = !forceApply &&
            sessionOnlyModel !== undefined &&
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
            applyPrimaryThinking(primary, resolveProviderThinking(primary, effectiveModel?.provider));
        }
    }
    async function applyPrimaryModeChange(ctx) {
        replayTlhUnmatchedModelSelectionDefaults();
        updateSessionOnlyModel(undefined);
        await applyPrimaryDefaults(ctx);
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
                    const primary = activePrimaryAgent();
                    const primaryConfig = getTlhPrimaryAgentConfig(ctx.cwd);
                    const rawModelOverrides = primaryConfig?.modelOverrides;
                    const hasStoredOverride = isRecord(rawModelOverrides) && Object.hasOwn(rawModelOverrides, selection);
                    if (primary && shouldForceApplyForLock(primary) && !hasStoredOverride) {
                        ctx.ui.notify(`No model override to clear: ${primaryAgentLabel(selection)} uses fixed model defaults and does not persist overrides.`, "info");
                        return;
                    }
                    try {
                        const result = writeTlhPrimaryAgentModelOverride(ctx.cwd, selection, undefined);
                        await applyPrimaryModeChange(ctx);
                        const backupLabel = result.backupPath
                            ? ` Backup: ${formatHomePath(result.backupPath)}.`
                            : "";
                        const message = primary && shouldForceApplyForLock(primary)
                            ? `Cleared stale ignored model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()} uses fixed model defaults.${backupLabel}`
                            : `${result.changed ? "Cleared" : "No override to clear for"} model override for ${primaryAgentLabel(selection)}. Primary agent: ${currentPrimaryAgentLabel()}.${backupLabel}`;
                        ctx.ui.notify(message, "info");
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
    async function applySessionStart(ctx) {
        replayAllTlhUnclaimedModelSelectionDefaults();
        setTlhModelSelectionActiveModelResolver(() => ctx.model);
        updateSessionOnlyModel(undefined);
        activateTlhTicketSessionScope(ctx.cwd);
        sessionExperimentalSnapshot = getTlhGlobalSettings(ctx.cwd).tlh?.experimental;
        syncPrimaryAgentState(ctx);
        await applyPrimaryDefaults(ctx, { warnOnMissing: false });
    }
    function registerLifecycleHooks() {
        pi.on("thinking_level_select", async () => {
            await persistTlhStandaloneThinkingDefaults();
        });
        pi.on("model_select", async (event, ctx) => {
            const defaultsClaim = claimTlhModelSelectionDefaults(event.model);
            setTlhModelSelectionActiveModelResolver(() => ctx.model);
            if (tlhRestoringCancelledModel) {
                discardTlhModelSelectionDefaults(defaultsClaim);
                return;
            }
            if (tlhApplyingModel) {
                updateSessionOnlyModel(undefined);
                await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(() => false);
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
                        updateSessionOnlyModel(event.model);
                        discardTlhModelSelectionDefaults(defaultsClaim);
                        return;
                    }
                }
                updateSessionOnlyModel(undefined);
                await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(() => false);
            }
            else if (event.source === "cycle") {
                updateSessionOnlyModel(undefined);
                await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(() => false);
                return;
            }
            else {
                updateSessionOnlyModel(undefined);
                await persistTlhModelSelectionDefaults(defaultsClaim, ctx.cwd, event.model).catch(() => false);
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
            if (shouldForceApplyForLock(primary)) {
                return;
            }
            const chosenKey = `${event.model.provider}/${event.model.id}`;
            const primaryDefaults = selectProviderAwareAgentDefaults(primary, getUnfilteredAvailableModels(ctx.modelRegistry), event.model.provider, event.model);
            const bundledKey = primaryDefaults.model
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
                recordOverrideBaseline(selection, primary, event.model.provider);
            }
        });
        pi.on("session_tree", async (_event, ctx) => {
            replayTlhUnmatchedModelSelectionDefaults();
            setTlhModelSelectionActiveModelResolver(() => ctx.model);
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
            replayAllTlhUnclaimedModelSelectionDefaults();
            setTlhModelSelectionActiveModelResolver(undefined);
            updateSessionOnlyModel(undefined);
            restorePrimaryToolsIfAppropriate();
            notifiedForReauth.clear();
            pendingReauthNotifications.clear();
            preflightThrottle.clear();
        });
        pi.on("before_agent_start", async (event, ctx) => {
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
            const allowedSubagents = allowedSubagentsForExperimentalConfig(getTlhGlobalSettings(ctx.cwd).tlh?.experimental);
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
            const embeddedFeatureEnabled = isExperimentalFeatureEnabled(sessionExperimentalSnapshot, EMBEDDED_SUBAGENTS_FEATURE);
            if (embeddedFeatureEnabled) {
                const embeddedBlockReason = embeddedDelegationBlockedReason(selection, event.input);
                if (embeddedBlockReason) {
                    return { block: true, reason: embeddedBlockReason };
                }
            }
            const allowEmbeddedTargets = embeddedFeatureEnabled && selection === "architect";
            const reason = validateSubagentToolInput(event.input, {
                allowedSubagents,
                allowEmbeddedTargets,
            });
            if (reason) {
                return { block: true, reason };
            }
            if (allowEmbeddedTargets && !isOpaqueSubagentManagementActionInput(event.input)) {
                const requestedEmbeddedTargets = collectSubagentCallTargetsMatching(event.input, isEmbeddedSubagentTarget);
                if (requestedEmbeddedTargets.length > 0) {
                    const authorizedEmbeddedTargets = new Set(loadAuthorizedEmbeddedSubagentRuntimeNames(getAgentDir()));
                    const unauthorizedTargets = requestedEmbeddedTargets.filter((target) => !authorizedEmbeddedTargets.has(target));
                    if (unauthorizedTargets.length > 0) {
                        return {
                            block: true,
                            reason: `TLH architect may delegate to embedded.<slug> only when a valid package: embedded / name: <slug> markdown definition currently exists under ${formatHomePath(join(getAgentDir(), "agents"))}. Unauthorized target(s): ${unauthorizedTargets.join(", ")}.`,
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
        buildLaunchSystemPrompt,
        resetPrimaryAgentModelOverride,
        registerCommands,
        registerLifecycleHooks,
    };
}
export function registerTlhPrimaryAgentRuntime(pi, options = {}) {
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
    installTlhModelSelectionPersistenceOverride();
    const runtime = createTlhPrimaryAgentRuntime(pi, options.primaryAgents ?? loadPrimaryAgents(), options.subagentMetadata ?? loadSubagentMetadata(), {
        getProviderAuthHealthStore: options.getProviderAuthHealthStore,
        now: options.now,
    });
    runtime.registerCommands();
    runtime.registerLifecycleHooks();
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
