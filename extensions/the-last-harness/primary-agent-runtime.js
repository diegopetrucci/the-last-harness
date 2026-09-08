import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";
import { getAgentDir, } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PRIMARY_AGENT, DISABLED_PRIMARY_AGENT, PRIMARY_AGENT_CYCLE, PRIMARY_AGENT_SESSION_STATE_ENTRY, isEnabledPrimaryAgentSelection, nextPrimaryAgentSelection, primaryAgentDefaultLabel, primaryAgentSelectionFromBranch, resolvePrimaryAgentConfig, } from "../the-last-harness-primary-agent.mjs";
import { createPrimaryToolState, filterAvailableTools, } from "../the-last-harness-primary-tools.mjs";
import { allowedSubagentsForExperimentalConfig, isEmbeddedSubagentTarget, registerTlhStartupMode, validateSubagentToolInput, } from "../the-last-harness-subagent-safety.mjs";
import { buildTlhCommitAttributionPrompt, getTlhGitCommitAttributionBlockReason, resolveTlhCommitAttribution, } from "./attribution.js";
import { formatHomePath, isRecord } from "./common.js";
import { activeProjectSnapshotIdentityReason, isProjectPrimaryAgentName, projectSnapshotTargets, unavailableProjectModelWarningMessage, } from "./primary-agent-runtime-boundaries.js";
import { clearPrimaryAgentModelOverrideByName, isTlhPrimaryAgentSelection, getTlhDurableThinkingLevel, getTlhGlobalSettings, getTlhPrimaryAgentConfig, getTlhSubagentOverrides, resolvePrimaryAutoApplySetting, writeTlhPrimaryAgentDefault, writeTlhPrimaryAgentModelOverride, } from "./primary-agent-runtime-settings.js";
import { applyOpenRouterModelToProjectTargets, applyProviderAwareModelsToNonProjectTargets, collectSubagentCallTargetsMatching, embeddedDelegationBlockedReason, isOpaqueSubagentManagementActionInput, isSubagentResumeAction, isSubagentSteerAction, primaryToolAllowlist, rushDeveloperDelegationReason, rushResumeDelegationReason, rushSteerDelegationReason, subagentCallTargetsAgent, } from "./primary-agent-runtime-delegation.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, dispatchPreflightBackoffMs, extractDispatchProviders, isHighConfidenceAuthSignatureInAttemptError, processSubagentRunDetails, } from "./primary-agent-runtime-auth.js";
import { lookupTlhProjectAgentRunReference, probeTlhProjectAgentRunMarker, } from "./project-agent-access.mjs";
import { GNOSIS_PROMPT, PRIMARY_AGENT_CYCLE_SHORTCUT, THINKING_LEVELS, TLH_NAME, TLH_PACKAGE_NAME, } from "./constants.js";
import { buildChildExperimentalPrompt, buildPrimaryExperimentalPrompt } from "./experimental.js";
import { shouldAppendGnosisPrompt } from "./gnosis.js";
import { followsOpenrouterSession, formatProviderModelReference, listAgentModelDefaultReferences, resolveProviderThinking, selectProviderAwareAgentDefaults, } from "./model-defaults.js";
import { getUnfilteredAvailableModels } from "./model-visibility.js";
import { beginTlhModelSelectionPersistenceSession, claimTlhModelSelectionDefaults, endTlhModelSelectionPersistenceSession, installTlhModelSelectionPersistenceOverride, isTlhPersistedModelSelection, updateTlhModelSelectionPersistenceContext, } from "./model-selection-scope.js";
import { getAvailableThinkingLevels, isThinkingLevel, setExtensionThinkingLevel, } from "./thinking.js";
import { appendBeforeChildSubagentBoundary } from "../shared/subagent-child-boundary.js";
import { buildChildSubagentSystemPrompt, buildTlhSystemPrompt, loadPrimaryAgents, loadSubagentMetadata, } from "./prompts.js";
import { activateTlhTicketRuntime, activateTlhTicketSessionScope } from "./tickets.js";
import { isMeaningfulPrimaryOverride, recordOverrideBaseline } from "./model-effort-reconcile.js";
import { tlhSettingsPathForWrite } from "./profile-state.js";
import { createTlhPrimaryAgentResourceLifecycle, retireTlhPrimaryAgentResourceRuntime, } from "./primary-agent-runtime-lifecycle.js";
const EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE = "Extension runtime not initialized. Action methods cannot be called during extension loading.";
function isExtensionRuntimeNotInitializedError(error) {
    return error instanceof Error && error.message === EXTENSION_RUNTIME_NOT_INITIALIZED_MESSAGE;
}
function primaryAgentLabel(selection) {
    return selection;
}
function primaryAgentOverrideLabel(selection) {
    return selection ?? "none";
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
function createTlhPrimaryAgentRuntime(pi, primaryAgents, subagentMetadata, runtimeOptions = {}) {
    const { getProviderAuthHealthStore, now: nowFn = Date.now } = runtimeOptions;
    const warned = new Set();
    const noticed = new Set();
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
    function activePrimaryAgent() {
        const selection = currentPrimaryAgentSelection();
        return selection === DISABLED_PRIMARY_AGENT ? undefined : primaryAgents.get(selection);
    }
    const projectAgentLifecycle = createTlhPrimaryAgentResourceLifecycle({
        getPrimaryAgentSelection: currentPrimaryAgentSelection,
        hasActivePrimaryAgent: () => activePrimaryAgent() !== undefined,
        projectAgentLoader: runtimeOptions.projectAgentLoader,
        projectDefaultsLoader: runtimeOptions.projectDefaultsLoader,
    });
    function isCurrentSessionStartOperation(operation) {
        return projectAgentLifecycle.isCurrentSessionStartOperation(operation);
    }
    function activeProjectDefaultsForCwd(cwd) {
        return projectAgentLifecycle.activeProjectDefaultsForCwd(cwd);
    }
    function warnProjectDefaultsOnce(ctx, projectRoot, agent, message, identityMessage) {
        projectAgentLifecycle.warnProjectDefaultsOnce(ctx, projectRoot, agent, message, identityMessage);
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
            buildTlhSystemPrompt(primary, subagentMetadata, primaryEnabled, projectAgentLifecycle.projectAgentGuidanceSnapshot()),
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
        return projectAgentLifecycle.isCurrentRuntime();
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
    async function applySessionStart(ctx) {
        const sessionStartOperation = projectAgentLifecycle.beginSessionStart();
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
        await projectAgentLifecycle.loadSessionResources(ctx, sessionStartOperation);
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
            noticed.clear();
            await projectAgentLifecycle.shutdown(() => {
                endModelSelectionSession();
                lastObservedModel = undefined;
                updateSessionOnlyModel(undefined);
                clearSessionThinkingOverride();
                restorePrimaryToolsIfAppropriate();
                notifiedForReauth.clear();
                pendingReauthNotifications.clear();
                preflightThrottle.clear();
            });
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
            syncPrimaryAgentState(ctx);
            const selection = currentPrimaryAgentSelection();
            const allowedSubagents = allowedSubagentsForExperimentalConfig();
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
            const activeProjectAgentSnapshot = projectAgentLifecycle.activeProjectAgentSnapshot();
            const projectTargets = projectSnapshotTargets(event.input, activeProjectAgentSnapshot);
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
                    const snapshotReason = activeProjectSnapshotIdentityReason(event.input, ctx, projectTargets, activeProjectAgentSnapshot);
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
        projectAgentGuidanceSnapshot: () => projectAgentLifecycle.projectAgentGuidanceSnapshot(),
        currentPrimaryAgentLabel,
        activePrimaryAgentPrompt: activePrimaryAgent,
        recordUserThinkingLevel,
        buildLaunchSystemPrompt,
        resetPrimaryAgentModelOverride,
        registerCommands,
        registerLifecycleHooks,
    };
}
export { clearPrimaryAgentModelOverrideByName, extractDispatchProviders, isHighConfidenceAuthSignatureInAttemptError, processSubagentRunDetails, };
export function registerTlhPrimaryAgentRuntime(pi, options = {}) {
    retireTlhPrimaryAgentResourceRuntime();
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
