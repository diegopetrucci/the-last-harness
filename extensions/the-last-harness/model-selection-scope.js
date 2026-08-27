import { AsyncLocalStorage } from "node:async_hooks";
import { ModelSelectorComponent, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { safeTlhProfileFilePath } from "./profile-state.js";
export const MODEL_SELECTION_SCOPE_SESSION_ONLY = "This session only — default";
export const MODEL_SELECTION_SCOPE_ALL_SESSIONS = "All sessions";
export const MODEL_SELECTION_SCOPE_OPTIONS = [
    MODEL_SELECTION_SCOPE_SESSION_ONLY,
    MODEL_SELECTION_SCOPE_ALL_SESSIONS,
];
function isModelSelectorRuntimePrototype(value) {
    return (value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "handleSelect" in value &&
        typeof value.handleSelect === "function");
}
const TLH_MODEL_SELECTION_PERSISTENCE_PATCH = Symbol.for("tlh.modelSelectionPersistencePatch");
function getPatchedPrototype() {
    return SettingsManager.prototype;
}
function getInstalledPatch() {
    return getPatchedPrototype()[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
}
function canWriteTlhDefaults() {
    return safeTlhProfileFilePath("settings.json") !== undefined;
}
function createGroupedDefaultWrites() {
    return {
        modelsAndProviders: new Set(),
        thinking: new Set(),
    };
}
function groupedWritesForManager(groups, manager) {
    const group = groups.get(manager) ?? createGroupedDefaultWrites();
    groups.set(manager, group);
    return group;
}
function encodeModel(provider, modelId) {
    return `${provider}\u0000${modelId}`;
}
function modelMatches(left, right) {
    return left.provider === right.provider && left.modelId === right.id;
}
function operationsMatch(left, right) {
    return (left.manager === right.manager &&
        left.provider === right.provider &&
        left.modelId === right.modelId);
}
function applySuppressedWrites(patch, writes) {
    const groups = new Map();
    for (const write of writes) {
        const group = groupedWritesForManager(groups, write.manager);
        switch (write.kind) {
            case "model-and-provider":
                group.modelsAndProviders.add(encodeModel(write.provider, write.modelId));
                break;
            case "thinking":
                group.thinking.add(write.level);
                break;
        }
    }
    for (const [manager, group] of groups) {
        for (const modelKey of group.modelsAndProviders) {
            const separator = modelKey.indexOf("\u0000");
            patch.originals.setDefaultModelAndProvider.call(manager, modelKey.slice(0, separator), modelKey.slice(separator + 1));
        }
        for (const level of group.thinking) {
            patch.originals.setDefaultThinkingLevel.call(manager, level);
        }
    }
    return [...groups.keys()];
}
async function flushManagers(managers) {
    try {
        await Promise.all(managers.map((manager) => manager.flush()));
        return true;
    }
    catch {
        return false;
    }
}
function replayWrites(patch, writes) {
    if (writes.length === 0 || !canWriteTlhDefaults()) {
        return;
    }
    void flushManagers(applySuppressedWrites(patch, writes));
}
function replaySelectorCandidate(patch) {
    const candidate = patch.state.selectorCandidate;
    patch.state.selectorCandidate = undefined;
    if (candidate) {
        replayWrites(patch, candidate.writes);
    }
}
function readTrackedActiveModel(state) {
    if (!state.activeModelResolver) {
        return { known: false, model: undefined };
    }
    try {
        return { known: true, model: state.activeModelResolver() };
    }
    catch {
        return { known: false, model: undefined };
    }
}
function targetIsTrackedActiveModel(active, write) {
    return (active.known &&
        active.model !== undefined &&
        active.model.provider === write.provider &&
        active.model.id === write.modelId);
}
function replayImmediateModelWrite(patch, write) {
    if (!operationsMatch(patch.state.immediateModelWrite ?? write, write)) {
        patch.state.immediateModelWrite = undefined;
    }
    if (!patch.state.immediateModelWrite) {
        replayWrites(patch, [write]);
        patch.state.immediateModelWrite = {
            manager: write.manager,
            provider: write.provider,
            modelId: write.modelId,
        };
    }
}
function interceptCombinedModelWrite(patch, write) {
    if (patch.state.suppressionDepth > 0) {
        return;
    }
    if (patch.nativeSelectorContext.getStore() !== true) {
        replaySelectorCandidate(patch);
        patch.state.immediateModelWrite = undefined;
        replayWrites(patch, [write]);
        return;
    }
    const active = readTrackedActiveModel(patch.state);
    if (!active.known) {
        replaySelectorCandidate(patch);
        patch.state.immediateModelWrite = undefined;
        replayWrites(patch, [write]);
        return;
    }
    const targetIsActive = targetIsTrackedActiveModel(active, write);
    if (targetIsActive &&
        patch.state.sessionOnlyModel !== undefined &&
        modelMatches(write, patch.state.sessionOnlyModel)) {
        replaySelectorCandidate(patch);
        patch.state.immediateModelWrite = undefined;
        return;
    }
    const candidate = patch.state.selectorCandidate;
    if (candidate) {
        if (operationsMatch(candidate, write) && targetIsActive) {
            candidate.writes.push(write);
            patch.state.selectorCandidate = undefined;
            patch.state.selectorClaims.push(candidate);
            patch.state.immediateModelWrite = undefined;
            return;
        }
        replaySelectorCandidate(patch);
    }
    if (targetIsActive) {
        replayImmediateModelWrite(patch, write);
        return;
    }
    patch.state.immediateModelWrite = undefined;
    patch.state.selectorCandidate = {
        manager: write.manager,
        provider: write.provider,
        modelId: write.modelId,
        writes: [write],
        thinkingCaptured: false,
    };
}
export function installTlhModelSelectionPersistenceOverride() {
    if (!canWriteTlhDefaults()) {
        return false;
    }
    const prototype = getPatchedPrototype();
    if (prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH]) {
        return true;
    }
    const modelSelectorPrototypeCandidate = ModelSelectorComponent.prototype;
    if (!isModelSelectorRuntimePrototype(modelSelectorPrototypeCandidate) ||
        typeof prototype.setDefaultModelAndProvider !== "function" ||
        typeof prototype.setDefaultModel !== "function" ||
        typeof prototype.setDefaultProvider !== "function" ||
        typeof prototype.setDefaultThinkingLevel !== "function") {
        console.warn("[TLH] installTlhModelSelectionPersistenceOverride: model selector or SettingsManager default " +
            "setters are unavailable; skipping patch.");
        return false;
    }
    const modelSelectorPrototype = modelSelectorPrototypeCandidate;
    const originals = {
        handleModelSelect: modelSelectorPrototype.handleSelect,
        setDefaultModelAndProvider: prototype.setDefaultModelAndProvider,
        setDefaultModel: prototype.setDefaultModel,
        setDefaultProvider: prototype.setDefaultProvider,
        setDefaultThinkingLevel: prototype.setDefaultThinkingLevel,
    };
    const state = {
        activeModelResolver: undefined,
        sessionOnlyModel: undefined,
        immediateModelWrite: undefined,
        selectorCandidate: undefined,
        selectorClaims: [],
        standaloneThinkingWrites: [],
        interactiveThinkingSelection: undefined,
        suppressionDepth: 0,
        thinkingSuppressionDepth: 0,
    };
    const patch = {
        nativeSelectorContext: new AsyncLocalStorage(),
        thinkingChangeContext: new AsyncLocalStorage(),
        originals,
        state,
    };
    modelSelectorPrototype.handleSelect = function (model) {
        return patch.nativeSelectorContext.run(true, () => originals.handleModelSelect.call(this, model));
    };
    prototype.setDefaultModelAndProvider = function (provider, modelId) {
        interceptCombinedModelWrite(patch, {
            kind: "model-and-provider",
            manager: this,
            provider,
            modelId,
        });
    };
    prototype.setDefaultModel = function (modelId) {
        if (state.suppressionDepth > 0) {
            return;
        }
        replaySelectorCandidate(patch);
        state.immediateModelWrite = undefined;
        originals.setDefaultModel.call(this, modelId);
    };
    prototype.setDefaultProvider = function (provider) {
        if (state.suppressionDepth > 0) {
            return;
        }
        replaySelectorCandidate(patch);
        state.immediateModelWrite = undefined;
        originals.setDefaultProvider.call(this, provider);
    };
    prototype.setDefaultThinkingLevel = function (level) {
        if (state.suppressionDepth > 0 || state.thinkingSuppressionDepth > 0) {
            return;
        }
        const interactiveThinkingSelection = state.interactiveThinkingSelection;
        if (interactiveThinkingSelection) {
            interactiveThinkingSelection.writes.push({ kind: "thinking", manager: this, level });
            state.interactiveThinkingSelection = undefined;
            return;
        }
        let claim;
        for (let index = state.selectorClaims.length - 1; index >= 0; index -= 1) {
            const operation = state.selectorClaims[index];
            if (operation.manager === this && !operation.thinkingCaptured) {
                claim = operation;
                break;
            }
        }
        const write = { kind: "thinking", manager: this, level };
        if (claim) {
            claim.writes.push(write);
            claim.thinkingCaptured = true;
            return;
        }
        replaySelectorCandidate(patch);
        state.standaloneThinkingWrites.push(write);
    };
    Object.defineProperty(prototype, TLH_MODEL_SELECTION_PERSISTENCE_PATCH, {
        configurable: false,
        enumerable: false,
        value: patch,
        writable: false,
    });
    return true;
}
export function setTlhModelSelectionActiveModelResolver(resolver) {
    const patch = getInstalledPatch();
    if (patch) {
        patch.state.activeModelResolver = resolver;
    }
}
export function runTlhThinkingChangeContext(origin, callback) {
    const patch = getInstalledPatch();
    return patch ? patch.thinkingChangeContext.run(origin, callback) : callback();
}
export function getTlhThinkingChangeContext() {
    return getInstalledPatch()?.thinkingChangeContext.getStore();
}
export function beginTlhThinkingDefaultSuppression() {
    const patch = getInstalledPatch();
    if (!patch) {
        return () => { };
    }
    patch.state.thinkingSuppressionDepth += 1;
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        patch.state.thinkingSuppressionDepth = Math.max(0, patch.state.thinkingSuppressionDepth - 1);
    };
}
export function setTlhSessionOnlyModel(model) {
    const patch = getInstalledPatch();
    if (patch) {
        patch.state.sessionOnlyModel = model ? { provider: model.provider, id: model.id } : undefined;
    }
}
export function beginTlhModelSelectionDefaultSuppression() {
    const patch = getInstalledPatch();
    if (!patch) {
        return () => { };
    }
    patch.state.suppressionDepth += 1;
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        patch.state.suppressionDepth = Math.max(0, patch.state.suppressionDepth - 1);
    };
}
export function claimTlhModelSelectionDefaults(model) {
    const patch = getInstalledPatch();
    if (!patch) {
        return undefined;
    }
    const claimIndex = patch.state.selectorClaims.findIndex((operation) => modelMatches(operation, model));
    if (claimIndex >= 0) {
        const [operation] = patch.state.selectorClaims.splice(claimIndex, 1);
        patch.state.immediateModelWrite = undefined;
        return {
            consumed: false,
            nativeSelector: true,
            writes: operation.writes,
        };
    }
    const candidate = patch.state.selectorCandidate;
    if (candidate && modelMatches(candidate, model)) {
        patch.state.selectorCandidate = undefined;
        patch.state.immediateModelWrite = undefined;
        return {
            consumed: false,
            nativeSelector: false,
            writes: candidate.writes,
        };
    }
    patch.state.immediateModelWrite = undefined;
    return undefined;
}
export function isTlhNativeModelSelectorClaim(claim) {
    return claim?.nativeSelector === true;
}
function takeClaimWrites(claim) {
    if (!claim || claim.consumed) {
        return [];
    }
    claim.consumed = true;
    return claim.writes;
}
export function discardTlhModelSelectionDefaults(claim) {
    if (claim) {
        takeClaimWrites(claim);
        return;
    }
    const patch = getInstalledPatch();
    if (patch) {
        patch.state.selectorCandidate = undefined;
        patch.state.immediateModelWrite = undefined;
    }
}
export function replayTlhUnmatchedModelSelectionDefaults() {
    const patch = getInstalledPatch();
    if (!patch) {
        return;
    }
    replaySelectorCandidate(patch);
    patch.state.immediateModelWrite = undefined;
}
export function replayAllTlhUnclaimedModelSelectionDefaults() {
    const patch = getInstalledPatch();
    if (!patch) {
        return;
    }
    const writes = [
        ...(patch.state.selectorCandidate?.writes ?? []),
        ...patch.state.selectorClaims.flatMap((operation) => operation.writes),
        ...patch.state.standaloneThinkingWrites,
    ];
    patch.state.selectorCandidate = undefined;
    patch.state.selectorClaims = [];
    patch.state.standaloneThinkingWrites = [];
    patch.state.immediateModelWrite = undefined;
    replayWrites(patch, writes);
}
export async function persistTlhModelSelectionDefaults(claim, _cwd, _model) {
    const writes = takeClaimWrites(claim);
    if (writes.length === 0) {
        return getInstalledPatch() !== undefined;
    }
    if (!canWriteTlhDefaults()) {
        return false;
    }
    const patch = getInstalledPatch();
    if (!patch) {
        return false;
    }
    return flushManagers(applySuppressedWrites(patch, writes));
}
export function beginTlhThinkingLevelSelection() {
    const patch = getInstalledPatch();
    if (!patch || patch.state.interactiveThinkingSelection) {
        return undefined;
    }
    const claim = { consumed: false, writes: [] };
    patch.state.interactiveThinkingSelection = claim;
    return claim;
}
export function endTlhThinkingLevelSelectionCapture(claim) {
    if (!claim || claim.consumed) {
        return undefined;
    }
    const patch = getInstalledPatch();
    if (patch?.state.interactiveThinkingSelection === claim) {
        patch.state.interactiveThinkingSelection = undefined;
    }
    return claim;
}
function takeTlhThinkingLevelSelectionWrites(claim) {
    if (!claim || claim.consumed) {
        return [];
    }
    claim.consumed = true;
    const patch = getInstalledPatch();
    if (patch?.state.interactiveThinkingSelection === claim) {
        patch.state.interactiveThinkingSelection = undefined;
    }
    return claim.writes;
}
export function discardTlhThinkingLevelSelection(claim) {
    takeTlhThinkingLevelSelectionWrites(claim);
}
export async function persistTlhThinkingLevelSelection(claim) {
    if (!claim || claim.consumed) {
        return false;
    }
    const writes = takeTlhThinkingLevelSelectionWrites(claim);
    if (writes.length === 0 || !canWriteTlhDefaults()) {
        return false;
    }
    const patch = getInstalledPatch();
    if (!patch) {
        return false;
    }
    try {
        return await flushManagers(applySuppressedWrites(patch, writes));
    }
    catch {
        return false;
    }
}
function takeStandaloneThinkingWrites() {
    const patch = getInstalledPatch();
    if (!patch) {
        return [];
    }
    const writes = patch.state.standaloneThinkingWrites;
    patch.state.standaloneThinkingWrites = [];
    return writes;
}
export async function persistTlhStandaloneThinkingDefaults() {
    const writes = takeStandaloneThinkingWrites();
    if (writes.length === 0 || !canWriteTlhDefaults()) {
        return;
    }
    const patch = getInstalledPatch();
    if (!patch) {
        return;
    }
    await flushManagers(applySuppressedWrites(patch, writes));
}
async function chooseTlhSelectionScope(ctx, title) {
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.select !== "function") {
        return "all-sessions";
    }
    try {
        const selected = await ctx.ui.select(title, [...MODEL_SELECTION_SCOPE_OPTIONS]);
        if (selected === MODEL_SELECTION_SCOPE_SESSION_ONLY) {
            return "session-only";
        }
        if (selected === MODEL_SELECTION_SCOPE_ALL_SESSIONS) {
            return "all-sessions";
        }
    }
    catch {
        return "session-only";
    }
    return "cancel";
}
export function chooseTlhModelSelectionScope(ctx) {
    return chooseTlhSelectionScope(ctx, "Model selection scope");
}
export function chooseTlhThinkingSelectionScope(ctx) {
    return chooseTlhSelectionScope(ctx, "Thinking selection scope");
}
