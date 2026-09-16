import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { formatHomePath } from "./common.js";
import { DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
const DEFAULT_CONTEXT_CAP_TOKENS = DUMB_ZONE_THRESHOLD_TOKENS;
const CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS = 272_000;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV = "PI_SUBAGENT_PROJECT_AGENT_GUIDANCE";
const MODEL_CONTEXT_WINDOW_POLICY_KEY = Symbol.for("the-last-harness.model-context-window-policy");
const MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY = Symbol.for("the-last-harness.model-context-window-policy-state");
const TOGGLE_CONTEXT_CAP_COMMAND_HELP = "Usage: /toggle-context-cap";
const originalContextWindows = new WeakMap();
const ownedModelPolicies = new WeakMap();
const lifecycleStatesByRegistry = new WeakMap();
function isChildSession() {
    const childSignal = process.env[SUBAGENT_CHILD_ENV];
    if (childSignal === "0")
        return false;
    if (childSignal === "1")
        return true;
    const childAgent = process.env[SUBAGENT_CHILD_AGENT_ENV];
    return childAgent !== undefined && childAgent.trim() !== "";
}
function positiveFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function isSharedContextWindowPolicyState(value) {
    if (!value || typeof value !== "object")
        return false;
    const state = value;
    return (typeof state.active === "boolean" &&
        typeof state.enabled === "boolean" &&
        typeof state.generation === "number" &&
        Number.isInteger(state.generation) &&
        state.generation >= 0 &&
        state.activeRefreshGenerations instanceof Set &&
        positiveFiniteNumber(state.primaryContextWindowCap) !== undefined &&
        positiveFiniteNumber(state.developerContextWindowCap) !== undefined &&
        state.nativeContextWindows instanceof Map &&
        state.registries instanceof WeakMap &&
        state.hookedRegistries instanceof WeakSet &&
        state.ownedModels instanceof Set);
}
function sharedContextWindowPolicyState() {
    const globalValue = globalThis;
    const globalState = globalValue;
    const existing = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY];
    if (isSharedContextWindowPolicyState(existing))
        return existing;
    const created = {
        active: false,
        enabled: true,
        primaryContextWindowCap: DEFAULT_CONTEXT_CAP_TOKENS,
        developerContextWindowCap: CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS,
        generation: 0,
        activeRefreshGenerations: new Set(),
        nativeContextWindows: new Map(),
        registries: new WeakMap(),
        hookedRegistries: new WeakSet(),
        ownedModels: new Set(),
    };
    try {
        Object.defineProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY, {
            configurable: true,
            enumerable: false,
            value: created,
            writable: false,
        });
    }
    catch {
    }
    return isSharedContextWindowPolicyState(globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY])
        ? globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY]
        : created;
}
function modelIdentityKey(model) {
    const provider = model.provider;
    const id = model.id;
    if (typeof provider !== "string" || typeof id !== "string")
        return undefined;
    if (!provider || !id)
        return undefined;
    return JSON.stringify([provider, id]);
}
function isCanonicalDeveloperChild() {
    return (isChildSession() &&
        process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim() === "developer" &&
        process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] === "1");
}
function resolveChildContextWindow(nativeContextWindow, canonicalDeveloper, contextCapDisabled = false) {
    const native = positiveFiniteNumber(nativeContextWindow);
    if (native === undefined)
        return undefined;
    return !contextCapDisabled && canonicalDeveloper
        ? Math.min(native, CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS)
        : native;
}
function pruneOwnedModelReferences(policyState) {
    for (const modelRef of policyState.ownedModels) {
        if (!modelRef.deref())
            policyState.ownedModels.delete(modelRef);
    }
}
function setModelContextWindowPolicy(model, policy, policyState) {
    const metadata = {
        nativeContextWindow: policy.nativeContextWindow,
        developerChildContextWindow: policy.developerChildContextWindow,
    };
    Object.defineProperty(metadata, "ownerToken", {
        configurable: false,
        enumerable: false,
        value: policy.ownerToken,
        writable: false,
    });
    Object.freeze(metadata);
    Object.defineProperty(model, MODEL_CONTEXT_WINDOW_POLICY_KEY, {
        configurable: true,
        enumerable: false,
        value: metadata,
        writable: false,
    });
    const previousOwnership = ownedModelPolicies.get(model);
    const modelRef = previousOwnership?.modelRef ?? new WeakRef(model);
    const ownership = {
        ownerToken: policy.ownerToken,
        metadata,
        installedContextWindow: policy.installedContextWindow,
        modelRef,
    };
    ownedModelPolicies.set(model, ownership);
    pruneOwnedModelReferences(policyState);
    policyState.ownedModels.add(modelRef);
}
function modelHasOwnedContextWindowMetadata(model, ownership, ownerToken) {
    if (ownership.ownerToken !== ownerToken || ownedModelPolicies.get(model) !== ownership)
        return false;
    return (Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY)?.value ===
        ownership.metadata);
}
function modelHasOwnedInstalledContextWindow(model, ownership, ownerToken) {
    return (modelHasOwnedContextWindowMetadata(model, ownership, ownerToken) &&
        model.contextWindow === ownership.installedContextWindow);
}
function removeOwnedModelMetadataForModel(policyState, model, ownership, ownerToken, clearOriginalContextWindows) {
    if (ownership.ownerToken !== ownerToken || ownedModelPolicies.get(model) !== ownership)
        return;
    if (modelHasOwnedContextWindowMetadata(model, ownership, ownerToken)) {
        try {
            Reflect.deleteProperty(model, MODEL_CONTEXT_WINDOW_POLICY_KEY);
        }
        catch {
        }
    }
    if (clearOriginalContextWindows)
        originalContextWindows.delete(model);
    ownedModelPolicies.delete(model);
    policyState.ownedModels.delete(ownership.modelRef);
}
function removeOwnedModelMetadata(policyState, ownerToken, clearOriginalContextWindows = false) {
    pruneOwnedModelReferences(policyState);
    for (const modelRef of policyState.ownedModels) {
        const model = modelRef.deref();
        if (!model) {
            policyState.ownedModels.delete(modelRef);
            continue;
        }
        const ownership = ownedModelPolicies.get(model);
        if (!ownership || ownership.ownerToken !== ownerToken)
            continue;
        removeOwnedModelMetadataForModel(policyState, model, ownership, ownerToken, clearOriginalContextWindows);
    }
}
function hasCurrentLifecycleModelPolicy(model, policy) {
    if (!policy)
        return false;
    const ownership = ownedModelPolicies.get(model);
    return (ownership !== undefined &&
        ownership.ownerToken === policy.lifecycleToken &&
        modelHasOwnedInstalledContextWindow(model, ownership, policy.lifecycleToken));
}
function effectiveContextWindowForPolicy(nativeContextWindow, policy) {
    if (policy.contextCapDisabled)
        return nativeContextWindow;
    if (policy.child) {
        return (resolveChildContextWindow(nativeContextWindow, policy.canonicalDeveloper) ??
            nativeContextWindow);
    }
    return Math.min(nativeContextWindow, DEFAULT_CONTEXT_CAP_TOKENS);
}
function rememberNativeContextWindow(model, nativeContextWindow, policyState) {
    const identity = modelIdentityKey(model);
    if (identity && positiveFiniteNumber(nativeContextWindow) !== undefined) {
        policyState.nativeContextWindows.set(identity, {
            contextWindow: nativeContextWindow,
            generation: policyState.generation,
        });
    }
}
function getOriginalContextWindow(model, policyState, policy, authoritativeGeneration) {
    const stored = originalContextWindows.get(model);
    const storedIsCurrentLifecycleOwned = hasCurrentLifecycleModelPolicy(model, policy);
    if (stored &&
        (authoritativeGeneration === undefined ||
            stored.generation === authoritativeGeneration ||
            storedIsCurrentLifecycleOwned)) {
        if (policyState)
            rememberNativeContextWindow(model, stored.contextWindow, policyState);
        return stored.contextWindow;
    }
    const current = model.contextWindow;
    const identity = modelIdentityKey(model);
    const rememberedRecord = identity ? policyState?.nativeContextWindows.get(identity) : undefined;
    const remembered = rememberedRecord !== undefined && rememberedRecord.generation === policyState?.generation
        ? rememberedRecord.contextWindow
        : undefined;
    const canUseRememberedContextWindow = policyState === undefined || policyState.activeRefreshGenerations.size === 0;
    const currentPositive = positiveFiniteNumber(current);
    const original = remembered !== undefined &&
        canUseRememberedContextWindow &&
        currentPositive !== undefined &&
        policy !== undefined &&
        authoritativeGeneration === undefined &&
        effectiveContextWindowForPolicy(remembered, policy) === currentPositive
        ? remembered
        : remembered !== undefined &&
            canUseRememberedContextWindow &&
            currentPositive === undefined &&
            authoritativeGeneration === undefined
            ? remembered
            : current;
    const generation = authoritativeGeneration ?? policyState?.generation ?? stored?.generation ?? 0;
    originalContextWindows.set(model, { contextWindow: original, generation });
    if (policyState)
        rememberNativeContextWindow(model, original, policyState);
    return original;
}
function setContextWindow(model, contextWindow, policyState, policy, authoritativeGeneration) {
    if (model.contextWindow === contextWindow)
        return false;
    getOriginalContextWindow(model, policyState, policy, authoritativeGeneration);
    model.contextWindow = contextWindow;
    return true;
}
function restoreContextWindow(model) {
    if (!model)
        return false;
    const original = originalContextWindows.get(model);
    if (!original)
        return false;
    if (model.contextWindow === original.contextWindow) {
        originalContextWindows.delete(model);
        return false;
    }
    model.contextWindow = original.contextWindow;
    originalContextWindows.delete(model);
    return true;
}
function applyContextWindowPolicy(model, policyState, policy, authoritativeGeneration) {
    if (!model)
        return false;
    const nativeContextWindow = getOriginalContextWindow(model, policyState, policy, authoritativeGeneration);
    const developerChildContextWindow = resolveChildContextWindow(nativeContextWindow, true, policy.contextCapDisabled);
    if (developerChildContextWindow === undefined)
        return false;
    const installedContextWindow = effectiveContextWindowForPolicy(nativeContextWindow, policy);
    setModelContextWindowPolicy(model, {
        nativeContextWindow,
        developerChildContextWindow,
        installedContextWindow,
        ownerToken: policy.lifecycleToken,
    }, policyState);
    if (policy.contextCapDisabled)
        return false;
    return setContextWindow(model, installedContextWindow, policyState, policy, authoritativeGeneration);
}
function applyContextWindowPolicyToModels(models, policyState, policy, authoritativeGeneration) {
    let changed = 0;
    for (const model of models ?? []) {
        if (applyContextWindowPolicy(model, policyState, policy, authoritativeGeneration))
            changed++;
    }
    return changed;
}
function applyContextWindowPolicyToRegistry(registry, policyState, policy, authoritativeGeneration) {
    let changed = 0;
    for (const readModels of [registry.getAll, registry.getAvailable]) {
        if (typeof readModels !== "function")
            continue;
        try {
            changed += applyContextWindowPolicyToModels(readModels.call(registry), policyState, policy, authoritativeGeneration);
        }
        catch {
        }
    }
    return changed;
}
function readRegistryCurrentModels(registry, policy) {
    const models = [];
    const seen = new Set();
    for (const readModels of [policy.originalGetAll, policy.originalGetAvailable]) {
        if (typeof readModels !== "function")
            continue;
        try {
            for (const model of readModels.call(registry)) {
                if (seen.has(model))
                    continue;
                seen.add(model);
                models.push(model);
            }
        }
        catch {
        }
    }
    return models;
}
function reconcileRegistryRefreshSnapshot(registry, policyState, policy, modelsBeforeRefresh, authoritativeGeneration) {
    const replacementModels = readRegistryCurrentModels(registry, policy).filter((model) => !modelsBeforeRefresh.has(model));
    if (replacementModels.length === 0)
        return;
    const previousRefreshGeneration = policyState.refreshGeneration;
    policyState.refreshGeneration = authoritativeGeneration;
    try {
        applyContextWindowPolicyToModels(replacementModels, policyState, policy, authoritativeGeneration);
    }
    finally {
        if (policyState.refreshGeneration === authoritativeGeneration) {
            policyState.refreshGeneration = previousRefreshGeneration;
        }
    }
}
function forEachRegistryModel(ctx, callback) {
    const registryValue = ctx.modelRegistry;
    const registry = registryValue;
    const seen = new Set();
    for (const readModels of [registry.getAll, registry.getAvailable]) {
        if (typeof readModels !== "function")
            continue;
        try {
            for (const model of readModels.call(registry)) {
                if (seen.has(model))
                    continue;
                seen.add(model);
                callback(model);
            }
        }
        catch {
        }
    }
}
function activeRegistryPolicy(registry, policyState) {
    if (!policyState.active || policyState.activeRegistry !== registry)
        return undefined;
    return policyState.registries.get(registry);
}
function descriptorsEqual(left, right) {
    if (!left || !right)
        return left === right;
    return (left.configurable === right.configurable &&
        left.enumerable === right.enumerable &&
        left.value === right.value &&
        left.writable === right.writable &&
        left.get === right.get &&
        left.set === right.set);
}
function latestActiveRefreshGeneration(policyState) {
    let latest;
    for (const generation of policyState.activeRefreshGenerations) {
        if (latest === undefined || generation > latest)
            latest = generation;
    }
    return latest;
}
function defineRegistryMethod(registry, name, value) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(registry, name);
    try {
        Object.defineProperty(registry, name, {
            configurable: originalDescriptor?.configurable ?? true,
            enumerable: originalDescriptor?.enumerable ?? false,
            value,
            writable: originalDescriptor?.writable ?? true,
        });
        const installedDescriptor = Object.getOwnPropertyDescriptor(registry, name);
        return installedDescriptor ? { originalDescriptor, installedDescriptor } : undefined;
    }
    catch {
        return undefined;
    }
}
function installRegistryHooks(registry, policyState, policy) {
    if (policyState.hookedRegistries.has(registry))
        return;
    policyState.hookedRegistries.add(registry);
    const install = (name, value) => {
        const hook = defineRegistryMethod(registry, name, value);
        if (hook)
            policy.methodHooks.set(name, hook);
    };
    const originalGetAll = registry.getAll;
    policy.originalGetAll = originalGetAll;
    if (typeof originalGetAll === "function") {
        install("getAll", function () {
            const models = originalGetAll.call(this);
            const currentPolicy = activeRegistryPolicy(registry, policyState);
            if (currentPolicy)
                applyContextWindowPolicyToModels(models, policyState, currentPolicy);
            return models;
        });
    }
    const originalGetAvailable = registry.getAvailable;
    policy.originalGetAvailable = originalGetAvailable;
    if (typeof originalGetAvailable === "function") {
        install("getAvailable", function () {
            const models = originalGetAvailable.call(this);
            const currentPolicy = activeRegistryPolicy(registry, policyState);
            if (currentPolicy)
                applyContextWindowPolicyToModels(models, policyState, currentPolicy);
            return models;
        });
    }
    const originalFind = registry.find;
    if (typeof originalFind === "function") {
        install("find", function (provider, modelId) {
            const model = originalFind.call(this, provider, modelId);
            const currentPolicy = activeRegistryPolicy(registry, policyState);
            if (currentPolicy)
                applyContextWindowPolicy(model, policyState, currentPolicy);
            return model;
        });
    }
    const originalRefresh = registry.refresh;
    if (typeof originalRefresh === "function") {
        install("refresh", async function (...args) {
            const currentPolicy = activeRegistryPolicy(registry, policyState);
            if (!currentPolicy)
                return originalRefresh.apply(this, args);
            const lifecycleToken = currentPolicy.lifecycleToken;
            const modelsBeforeRefresh = new Set(readRegistryCurrentModels(registry, currentPolicy));
            const generation = ++policyState.generation;
            policyState.activeRefreshGenerations.add(generation);
            policyState.refreshGeneration = generation;
            policyState.nativeContextWindows.clear();
            try {
                let outcome;
                try {
                    outcome = {
                        fulfilled: true,
                        value: await originalRefresh.apply(this, args),
                    };
                }
                catch (error) {
                    outcome = { fulfilled: false, error };
                }
                const refreshedPolicy = activeRegistryPolicy(registry, policyState);
                if (refreshedPolicy?.lifecycleToken === lifecycleToken) {
                    try {
                        reconcileRegistryRefreshSnapshot(registry, policyState, refreshedPolicy, modelsBeforeRefresh, generation);
                    }
                    catch (error) {
                        if (outcome.fulfilled)
                            throw error;
                    }
                }
                if (!outcome.fulfilled)
                    throw outcome.error;
                return outcome.value;
            }
            finally {
                policyState.activeRefreshGenerations.delete(generation);
                if (policyState.refreshGeneration === generation) {
                    policyState.refreshGeneration = latestActiveRefreshGeneration(policyState);
                }
            }
        });
    }
}
function restoreRegistryMethodHooks(registry, policyState, policy) {
    for (const [name, hook] of policy.methodHooks) {
        const currentDescriptor = Object.getOwnPropertyDescriptor(registry, name);
        if (!descriptorsEqual(currentDescriptor, hook.installedDescriptor))
            continue;
        try {
            if (hook.originalDescriptor) {
                Object.defineProperty(registry, name, hook.originalDescriptor);
            }
            else {
                Reflect.deleteProperty(registry, name);
            }
        }
        catch {
        }
    }
    policy.methodHooks.clear();
    policyState.hookedRegistries.delete(registry);
}
function activateContextWindowPolicy(ctx, child, canonicalDeveloper, contextCapDisabled, resetNativeContextWindows) {
    const state = sharedContextWindowPolicyState();
    const registryValue = ctx.modelRegistry;
    const registry = registryValue;
    const previousRegistry = state.activeRegistry;
    const startsLifecycle = !state.active || previousRegistry !== registry || resetNativeContextWindows;
    if (previousRegistry && previousRegistry !== registry) {
        const previousPolicy = state.registries.get(previousRegistry);
        if (previousPolicy && state.lifecycleToken === previousPolicy.lifecycleToken) {
            restoreOwnedModelWindows(state);
            restoreRegistryMethodHooks(previousRegistry, state, previousPolicy);
            removeOwnedModelMetadata(state, state.lifecycleToken, true);
        }
        state.registries.delete(previousRegistry);
        lifecycleStatesByRegistry.delete(previousRegistry);
        state.lifecycleToken = undefined;
    }
    if (startsLifecycle) {
        if (state.lifecycleToken) {
            restoreOwnedModelWindows(state);
            removeOwnedModelMetadata(state, state.lifecycleToken, true);
        }
        state.lifecycleToken = Symbol("the-last-harness.context-cap-lifecycle");
        state.generation++;
        state.refreshGeneration = undefined;
        state.activeRefreshGenerations.clear();
        state.nativeContextWindows.clear();
    }
    const lifecycleToken = state.lifecycleToken ?? Symbol("the-last-harness.context-cap-lifecycle");
    state.lifecycleToken = lifecycleToken;
    const policy = state.registries.get(registry) ?? {
        child,
        canonicalDeveloper,
        contextCapDisabled,
        lifecycleToken,
        methodHooks: new Map(),
    };
    policy.child = child;
    policy.canonicalDeveloper = canonicalDeveloper;
    policy.contextCapDisabled = contextCapDisabled;
    policy.lifecycleToken = lifecycleToken;
    state.active = true;
    state.enabled = !contextCapDisabled;
    state.primaryContextWindowCap = DEFAULT_CONTEXT_CAP_TOKENS;
    state.developerContextWindowCap = CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS;
    state.activeRegistry = registry;
    state.registries.set(registry, policy);
    lifecycleStatesByRegistry.set(registry, state);
    installRegistryHooks(registry, state, policy);
    return { state, policy };
}
function deactivateContextWindowPolicy(ctx) {
    const registryValue = ctx.modelRegistry;
    const registry = registryValue;
    const state = lifecycleStatesByRegistry.get(registry) ?? sharedContextWindowPolicyState();
    const policy = state.registries.get(registry);
    if (!policy ||
        state.activeRegistry !== registry ||
        state.lifecycleToken !== policy.lifecycleToken)
        return;
    const lifecycleToken = policy.lifecycleToken;
    state.active = false;
    state.activeRegistry = undefined;
    restoreRegistryMethodHooks(registry, state, policy);
    restoreContextCapForSession(ctx, lifecycleToken);
    restoreOwnedModelWindows(state, lifecycleToken);
    removeOwnedModelMetadata(state, lifecycleToken, true);
    state.registries.delete(registry);
    lifecycleStatesByRegistry.delete(registry);
    const globalValue = globalThis;
    const globalState = globalValue;
    const ownsGlobalState = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY] === state;
    state.active = false;
    state.activeRegistry = undefined;
    state.refreshGeneration = undefined;
    state.activeRefreshGenerations.clear();
    state.nativeContextWindows.clear();
    state.lifecycleToken = undefined;
    if (!ownsGlobalState)
        return;
    try {
        Reflect.deleteProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY);
    }
    catch {
    }
}
function applyContextWindowPolicyToSession(ctx, state, policy) {
    const registryValue = ctx.modelRegistry;
    const registry = registryValue;
    let changed = applyContextWindowPolicyToRegistry(registry, state, policy);
    if (applyContextWindowPolicy(ctx.model, state, policy))
        changed++;
    return changed;
}
function restoreContextCapForSession(ctx, ownerToken) {
    let changed = 0;
    forEachRegistryModel(ctx, (model) => {
        const ownership = ownedModelPolicies.get(model);
        if (ownership && modelHasOwnedInstalledContextWindow(model, ownership, ownerToken)) {
            if (restoreContextWindow(model))
                changed++;
        }
    });
    const model = ctx.model;
    const ownership = model ? ownedModelPolicies.get(model) : undefined;
    if (model && ownership && modelHasOwnedInstalledContextWindow(model, ownership, ownerToken)) {
        if (restoreContextWindow(model))
            changed++;
    }
    return changed;
}
function restoreOwnedModelWindows(policyState, ownerToken = policyState.lifecycleToken) {
    if (!ownerToken)
        return 0;
    let changed = 0;
    pruneOwnedModelReferences(policyState);
    for (const modelRef of policyState.ownedModels) {
        const model = modelRef.deref();
        if (!model) {
            policyState.ownedModels.delete(modelRef);
            continue;
        }
        const ownership = ownedModelPolicies.get(model);
        if (ownership && modelHasOwnedInstalledContextWindow(model, ownership, ownerToken)) {
            if (restoreContextWindow(model))
                changed++;
        }
    }
    return changed;
}
function isContextCapDisabled(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.contextCap?.disabled === true;
    }
    catch {
        return false;
    }
}
function toggleContextCapSetting(cwd) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write context-cap settings outside the isolated TLH profile.", (current) => {
        const settings = current ? JSON.parse(current) : {};
        const currentlyDisabled = settings.tlh?.contextCap?.disabled === true;
        const nowDisabled = !currentlyDisabled;
        settings.tlh ??= {};
        settings.tlh.contextCap ??= {};
        settings.tlh.contextCap.disabled = nowDisabled;
        return {
            changed: true,
            nowDisabled,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
export function registerContextCap(pi) {
    pi.on("session_start", async (_event, ctx) => {
        const child = isChildSession();
        const canonicalDeveloper = isCanonicalDeveloperChild();
        const { state, policy } = activateContextWindowPolicy(ctx, child, canonicalDeveloper, isContextCapDisabled(ctx.cwd), true);
        applyContextWindowPolicyToSession(ctx, state, policy);
    });
    pi.on("model_select", async (event, ctx) => {
        const child = isChildSession();
        const canonicalDeveloper = isCanonicalDeveloperChild();
        const { state, policy } = activateContextWindowPolicy(ctx, child, canonicalDeveloper, isContextCapDisabled(ctx.cwd), false);
        applyContextWindowPolicy(event.model, state, policy);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        deactivateContextWindowPolicy(ctx);
    });
    pi.registerCommand("toggle-context-cap", {
        description: "Toggle the 200k effective context-window cap for auto-compaction",
        handler: async (args, ctx) => {
            if (args.trim()) {
                ctx.ui.notify(TOGGLE_CONTEXT_CAP_COMMAND_HELP, "error");
                return;
            }
            try {
                const result = toggleContextCapSetting(ctx.cwd);
                const backupLabel = result.backupPath
                    ? ` Backup: ${formatHomePath(result.backupPath)}.`
                    : "";
                const { state, policy } = activateContextWindowPolicy(ctx, isChildSession(), isCanonicalDeveloperChild(), result.nowDisabled, false);
                if (result.nowDisabled && state.lifecycleToken) {
                    restoreOwnedModelWindows(state, state.lifecycleToken);
                }
                state.enabled = !result.nowDisabled;
                policy.contextCapDisabled = result.nowDisabled;
                applyContextWindowPolicyToSession(ctx, state, policy);
                ctx.ui.notify(`Context cap ${result.nowDisabled ? "disabled" : "enabled"}. Updated TLH settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`, "info");
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`Could not update context cap setting: ${message}`, "error");
            }
        },
    });
}
