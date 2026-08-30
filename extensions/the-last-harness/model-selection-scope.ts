// Pi-sensitive model-selector persistence shim.
// See ../../docs/upstream-sync-inventory.md before changing this compatibility seam.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ModelSelectorComponent,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { safeTlhProfileFilePath } from "./profile-state.js";

export const MODEL_SELECTION_SCOPE_SESSION_ONLY = "This session only — default";
export const MODEL_SELECTION_SCOPE_ALL_SESSIONS = "All sessions";
export const MODEL_SELECTION_SCOPE_OPTIONS = [
  MODEL_SELECTION_SCOPE_SESSION_ONLY,
  MODEL_SELECTION_SCOPE_ALL_SESSIONS,
] as const;

type TlhModelSelectionScope = "session-only" | "all-sessions" | "cancel";
type TlhThinkingChangeOrigin = "internal" | "interactive";
type TlhModelSelection = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
type DefaultThinkingLevel = Parameters<typeof SettingsManager.prototype.setDefaultThinkingLevel>[0];

type CombinedModelWrite = {
  kind: "model-and-provider";
  manager: SettingsManager;
  provider: string;
  modelId: string;
};

type ThinkingWrite = {
  kind: "thinking";
  manager: SettingsManager;
  level: DefaultThinkingLevel;
};

type SuppressedDefaultWrite = CombinedModelWrite | ThinkingWrite;

type ModelOperation = {
  manager: SettingsManager;
  provider: string;
  modelId: string;
  writes: SuppressedDefaultWrite[];
  thinkingCaptured: boolean;
};

type ImmediateModelWrite = Pick<ModelOperation, "manager" | "provider" | "modelId">;

type TlhModelSelectionPersistenceState = {
  activeModelResolver: (() => TlhModelSelection | undefined) | undefined;
  sessionOnlyModel: TlhModelSelection | undefined;
  immediateModelWrite: ImmediateModelWrite | undefined;
  selectorCandidate: ModelOperation | undefined;
  selectorClaims: ModelOperation[];
  standaloneThinkingWrites: ThinkingWrite[];
  interactiveThinkingSelection: TlhThinkingLevelSelectionClaim | undefined;
  suppressionDepth: number;
  thinkingSuppressionDepth: number;
};

type ModelSelectorRuntimePrototype = {
  // The upstream private handleSelect implementation returns void; the model
  // remains opaque because this shim only wraps the call for async-local scope.
  handleSelect(this: ModelSelectorComponent, model: unknown): void;
};

function isModelSelectorRuntimePrototype(value: unknown): value is ModelSelectorRuntimePrototype {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "handleSelect" in value &&
    typeof value.handleSelect === "function"
  );
}

type TlhModelSelectionPersistencePatch = {
  nativeSelectorContext: AsyncLocalStorage<boolean>;
  thinkingChangeContext: AsyncLocalStorage<TlhThinkingChangeOrigin>;
  originals: {
    handleModelSelect: ModelSelectorRuntimePrototype["handleSelect"];
    setDefaultModelAndProvider: typeof SettingsManager.prototype.setDefaultModelAndProvider;
    setDefaultModel: typeof SettingsManager.prototype.setDefaultModel;
    setDefaultProvider: typeof SettingsManager.prototype.setDefaultProvider;
    setDefaultThinkingLevel: typeof SettingsManager.prototype.setDefaultThinkingLevel;
  };
  state: TlhModelSelectionPersistenceState;
};

type TlhModelSelectionDefaultsClaim = {
  consumed: boolean;
  nativeSelector: boolean;
  writes: SuppressedDefaultWrite[];
};

/** Captures the settings write emitted by one interactive thinking selection. */
type TlhThinkingLevelSelectionClaim = {
  consumed: boolean;
  writes: ThinkingWrite[];
};

type PatchedSettingsManagerPrototype = typeof SettingsManager.prototype & {
  [TLH_MODEL_SELECTION_PERSISTENCE_PATCH]?: TlhModelSelectionPersistencePatch;
};

type GroupedDefaultWrites = {
  modelsAndProviders: Set<string>;
  thinking: Set<DefaultThinkingLevel>;
};

type TrackedActiveModel = {
  known: boolean;
  model: TlhModelSelection | undefined;
};

const TLH_MODEL_SELECTION_PERSISTENCE_PATCH = Symbol.for("tlh.modelSelectionPersistencePatch");

function getPatchedPrototype(): PatchedSettingsManagerPrototype {
  return SettingsManager.prototype as PatchedSettingsManagerPrototype;
}

function getInstalledPatch(): TlhModelSelectionPersistencePatch | undefined {
  return getPatchedPrototype()[TLH_MODEL_SELECTION_PERSISTENCE_PATCH];
}

function canWriteTlhDefaults(): boolean {
  // The TLH wrapper always supplies a safe isolated path. Do not install the
  // process-wide patch for normal Pi: upstream persistence must remain intact.
  return safeTlhProfileFilePath("settings.json") !== undefined;
}

function createGroupedDefaultWrites(): GroupedDefaultWrites {
  return {
    modelsAndProviders: new Set(),
    thinking: new Set(),
  };
}

function groupedWritesForManager(
  groups: Map<SettingsManager, GroupedDefaultWrites>,
  manager: SettingsManager,
): GroupedDefaultWrites {
  const group = groups.get(manager) ?? createGroupedDefaultWrites();
  groups.set(manager, group);
  return group;
}

function encodeModel(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function modelMatches(
  left: Pick<ModelOperation, "provider" | "modelId">,
  right: TlhModelSelection,
): boolean {
  return left.provider === right.provider && left.modelId === right.id;
}

function operationsMatch(
  left: ImmediateModelWrite | ModelOperation,
  right: CombinedModelWrite,
): boolean {
  return (
    left.manager === right.manager &&
    left.provider === right.provider &&
    left.modelId === right.modelId
  );
}

function applySuppressedWrites(
  patch: TlhModelSelectionPersistencePatch,
  writes: readonly SuppressedDefaultWrite[],
): SettingsManager[] {
  const groups = new Map<SettingsManager, GroupedDefaultWrites>();
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
      patch.originals.setDefaultModelAndProvider.call(
        manager,
        modelKey.slice(0, separator),
        modelKey.slice(separator + 1),
      );
    }
    for (const level of group.thinking) {
      patch.originals.setDefaultThinkingLevel.call(manager, level);
    }
  }
  return [...groups.keys()];
}

async function flushManagers(managers: readonly SettingsManager[]): Promise<boolean> {
  try {
    await Promise.all(managers.map((manager) => manager.flush()));
    return true;
  } catch {
    return false;
  }
}

function replayWrites(
  patch: TlhModelSelectionPersistencePatch,
  writes: readonly SuppressedDefaultWrite[],
): void {
  if (writes.length === 0 || !canWriteTlhDefaults()) {
    return;
  }
  void flushManagers(applySuppressedWrites(patch, writes));
}

function replaySelectorCandidate(patch: TlhModelSelectionPersistencePatch): void {
  const candidate = patch.state.selectorCandidate;
  patch.state.selectorCandidate = undefined;
  if (candidate) {
    replayWrites(patch, candidate.writes);
  }
}

function readTrackedActiveModel(state: TlhModelSelectionPersistenceState): TrackedActiveModel {
  if (!state.activeModelResolver) {
    return { known: false, model: undefined };
  }
  try {
    return { known: true, model: state.activeModelResolver() };
  } catch {
    // A context captured before /reload is stale. Preserve upstream behavior
    // until the replacement runtime supplies its live model resolver.
    return { known: false, model: undefined };
  }
}

function targetIsTrackedActiveModel(
  active: TrackedActiveModel,
  write: CombinedModelWrite,
): boolean {
  return (
    active.known &&
    active.model !== undefined &&
    active.model.provider === write.provider &&
    active.model.id === write.modelId
  );
}

function replayImmediateModelWrite(
  patch: TlhModelSelectionPersistencePatch,
  write: CombinedModelWrite,
): void {
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

function interceptCombinedModelWrite(
  patch: TlhModelSelectionPersistencePatch,
  write: CombinedModelWrite,
): void {
  if (patch.state.suppressionDepth > 0) {
    return;
  }

  if (patch.nativeSelectorContext.getStore() !== true) {
    // `/model <exact-name>`, provider-auth auto-selection, cycling, and TLH
    // applications call AgentSession.setModel outside ModelSelector.handleSelect.
    // Preserve their one-write upstream behavior and never merge them with a
    // failed native-selector candidate, even when the target is identical.
    replaySelectorCandidate(patch);
    patch.state.immediateModelWrite = undefined;
    replayWrites(patch, [write]);
    return;
  }

  const active = readTrackedActiveModel(patch.state);
  if (!active.known) {
    // Without a live session model we cannot distinguish an unchanged native
    // selection from a changing one. Fail open to upstream behavior.
    replaySelectorCandidate(patch);
    patch.state.immediateModelWrite = undefined;
    replayWrites(patch, [write]);
    return;
  }

  const targetIsActive = targetIsTrackedActiveModel(active, write);
  if (
    targetIsActive &&
    patch.state.sessionOnlyModel !== undefined &&
    modelMatches(write, patch.state.sessionOnlyModel)
  ) {
    // AgentSession emits no model_select when the native picker confirms its
    // already-active model. Preserve the prior session-only decision by dropping
    // that no-op picker write instead of silently turning it into a global default.
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
    // A repeated picker write while the target is still inactive is a new
    // attempt after the previous selector callback failed. Replay the bounded
    // old candidate before starting the new operation so they never merge.
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

/**
 * Suppress Pi's automatic native-selector writes while retaining the original
 * setters for an explicit scope decision. Async-local selector context excludes
 * direct/programmatic setModel calls; a live ExtensionContext model getter then
 * distinguishes the picker write (target not active yet) from AgentSession's
 * duplicate write (target is active).
 */
export function installTlhModelSelectionPersistenceOverride(): boolean {
  if (!canWriteTlhDefaults()) {
    return false;
  }

  const prototype = getPatchedPrototype();
  if (prototype[TLH_MODEL_SELECTION_PERSISTENCE_PATCH]) {
    return true;
  }

  const modelSelectorPrototypeCandidate: unknown = ModelSelectorComponent.prototype;
  if (
    !isModelSelectorRuntimePrototype(modelSelectorPrototypeCandidate) ||
    typeof prototype.setDefaultModelAndProvider !== "function" ||
    typeof prototype.setDefaultModel !== "function" ||
    typeof prototype.setDefaultProvider !== "function" ||
    typeof prototype.setDefaultThinkingLevel !== "function"
  ) {
    console.warn(
      "[TLH] installTlhModelSelectionPersistenceOverride: model selector or SettingsManager default " +
        "setters are unavailable; skipping patch.",
    );
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

  const state: TlhModelSelectionPersistenceState = {
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
  const patch: TlhModelSelectionPersistencePatch = {
    nativeSelectorContext: new AsyncLocalStorage<boolean>(),
    thinkingChangeContext: new AsyncLocalStorage<TlhThinkingChangeOrigin>(),
    originals,
    state,
  };

  modelSelectorPrototype.handleSelect = function (model: unknown): void {
    return patch.nativeSelectorContext.run(true, () =>
      originals.handleModelSelect.call(this, model),
    );
  };
  prototype.setDefaultModelAndProvider = function (provider: string, modelId: string): void {
    interceptCombinedModelWrite(patch, {
      kind: "model-and-provider",
      manager: this,
      provider,
      modelId,
    });
  };
  prototype.setDefaultModel = function (modelId: string): void {
    if (state.suppressionDepth > 0) {
      return;
    }
    replaySelectorCandidate(patch);
    state.immediateModelWrite = undefined;
    originals.setDefaultModel.call(this, modelId);
  };
  prototype.setDefaultProvider = function (provider: string): void {
    if (state.suppressionDepth > 0) {
      return;
    }
    replaySelectorCandidate(patch);
    state.immediateModelWrite = undefined;
    originals.setDefaultProvider.call(this, provider);
  };
  prototype.setDefaultThinkingLevel = function (level: DefaultThinkingLevel): void {
    if (state.suppressionDepth > 0 || state.thinkingSuppressionDepth > 0) {
      return;
    }
    const interactiveThinkingSelection = state.interactiveThinkingSelection;
    if (interactiveThinkingSelection) {
      interactiveThinkingSelection.writes.push({ kind: "thinking", manager: this, level });
      // AgentSession.setThinkingLevel performs this default write synchronously.
      // Detach after that one write so later work cannot be captured while the
      // command awaits its scope picker.
      state.interactiveThinkingSelection = undefined;
      return;
    }
    let claim: ModelOperation | undefined;
    for (let index = state.selectorClaims.length - 1; index >= 0; index -= 1) {
      const operation = state.selectorClaims[index];
      if (operation.manager === this && !operation.thinkingCaptured) {
        claim = operation;
        break;
      }
    }
    const write = { kind: "thinking", manager: this, level } as const;
    if (claim) {
      claim.writes.push(write);
      claim.thinkingCaptured = true;
      return;
    }
    // A thinking-only change is an explicit unrelated boundary for a failed
    // selector candidate, so preserve that candidate before draining thinking.
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

/** Supply the live active-model getter used to classify selector and AgentSession writes. */
export function setTlhModelSelectionActiveModelResolver(
  resolver: (() => TlhModelSelection | undefined) | undefined,
): void {
  const patch = getInstalledPatch();
  if (patch) {
    patch.state.activeModelResolver = resolver;
  }
}

/** Run a TLH-owned or interactive thinking setter with source context preserved for async events. */
export function runTlhThinkingChangeContext<T>(
  origin: TlhThinkingChangeOrigin,
  callback: () => T,
): T {
  const patch = getInstalledPatch();
  return patch ? patch.thinkingChangeContext.run(origin, callback) : callback();
}

/** Return the source of the current thinking setter/event dispatch, when known. */
export function getTlhThinkingChangeContext(): TlhThinkingChangeOrigin | undefined {
  return getInstalledPatch()?.thinkingChangeContext.getStore();
}

/** Temporarily suppress only upstream thinking-default writes from TLH-owned changes. */
export function beginTlhThinkingDefaultSuppression(): () => void {
  const patch = getInstalledPatch();
  if (!patch) {
    return () => {};
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

/** Keep no-op native re-selections from persisting the active session-only model. */
export function setTlhSessionOnlyModel(model: TlhModelSelection | undefined): void {
  const patch = getInstalledPatch();
  if (patch) {
    patch.state.sessionOnlyModel = model ? { provider: model.provider, id: model.id } : undefined;
  }
}

/**
 * Temporarily discard default writes from an intentionally ephemeral setModel,
 * such as cancel restoration. The returned release function is idempotent.
 */
export function beginTlhModelSelectionDefaultSuppression(): () => void {
  const patch = getInstalledPatch();
  if (!patch) {
    return () => {};
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

/** Claim writes without relying on this handler's position in extension dispatch. */
export function claimTlhModelSelectionDefaults(
  model: TlhModelSelection,
): TlhModelSelectionDefaultsClaim | undefined {
  const patch = getInstalledPatch();
  if (!patch) {
    return undefined;
  }

  const claimIndex = patch.state.selectorClaims.findIndex((operation) =>
    modelMatches(operation, model),
  );
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

export function isTlhNativeModelSelectorClaim(
  claim: TlhModelSelectionDefaultsClaim | undefined,
): boolean {
  return claim?.nativeSelector === true;
}

function takeClaimWrites(
  claim: TlhModelSelectionDefaultsClaim | undefined,
): SuppressedDefaultWrite[] {
  if (!claim || claim.consumed) {
    return [];
  }
  claim.consumed = true;
  return claim.writes;
}

/** Drop claimed writes, or drain an unmatched candidate during guarded recovery. */
export function discardTlhModelSelectionDefaults(claim?: TlhModelSelectionDefaultsClaim): void {
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

/** Replay the one bounded unmatched selector write at a safe explicit boundary. */
export function replayTlhUnmatchedModelSelectionDefaults(): void {
  const patch = getInstalledPatch();
  if (!patch) {
    return;
  }
  replaySelectorCandidate(patch);
  patch.state.immediateModelWrite = undefined;
}

/** Replay all unclaimed writes while ending or replacing the active runtime session. */
export function replayAllTlhUnclaimedModelSelectionDefaults(): void {
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

/** Re-apply the default writes claimed for one model operation, deduplicated. */
export async function persistTlhModelSelectionDefaults(
  claim: TlhModelSelectionDefaultsClaim | undefined,
  _cwd: string,
  _model: TlhModelSelection,
): Promise<boolean> {
  const writes = takeClaimWrites(claim);
  if (writes.length === 0) {
    // A programmatic/direct/cycle write was already replayed synchronously.
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

/** Start capturing the synchronous default write for an interactive /thinking selection. */
export function beginTlhThinkingLevelSelection(): TlhThinkingLevelSelectionClaim | undefined {
  const patch = getInstalledPatch();
  if (!patch || patch.state.interactiveThinkingSelection) {
    return undefined;
  }
  const claim: TlhThinkingLevelSelectionClaim = { consumed: false, writes: [] };
  patch.state.interactiveThinkingSelection = claim;
  return claim;
}

/** Detach a thinking claim before any asynchronous scope decision. */
export function endTlhThinkingLevelSelectionCapture(
  claim: TlhThinkingLevelSelectionClaim | undefined,
): TlhThinkingLevelSelectionClaim | undefined {
  if (!claim || claim.consumed) {
    return undefined;
  }
  const patch = getInstalledPatch();
  if (patch?.state.interactiveThinkingSelection === claim) {
    patch.state.interactiveThinkingSelection = undefined;
  }
  return claim;
}

function takeTlhThinkingLevelSelectionWrites(
  claim: TlhThinkingLevelSelectionClaim | undefined,
): ThinkingWrite[] {
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

/** Discard the default write captured for an interactive /thinking selection. */
export function discardTlhThinkingLevelSelection(claim?: TlhThinkingLevelSelectionClaim): void {
  takeTlhThinkingLevelSelectionWrites(claim);
}

/** Persist the default write captured for an interactive /thinking selection. */
export async function persistTlhThinkingLevelSelection(
  claim: TlhThinkingLevelSelectionClaim | undefined,
): Promise<boolean> {
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
  } catch {
    return false;
  }
}

function takeStandaloneThinkingWrites(): ThinkingWrite[] {
  const patch = getInstalledPatch();
  if (!patch) {
    return [];
  }
  const writes = patch.state.standaloneThinkingWrites;
  patch.state.standaloneThinkingWrites = [];
  return writes;
}

/** Restore a standalone /effort or Ctrl+thinking write that was not part of a model switch. */
export async function persistTlhStandaloneThinkingDefaults(): Promise<void> {
  // Drain first: a profile-safety refusal must never leave process-global writes
  // that can leak into a later operation.
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

async function chooseTlhSelectionScope(
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
  title: string,
): Promise<TlhModelSelectionScope> {
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
  } catch {
    // A picker failure leaves the active selection in place but cannot
    // establish persistent scope. Keep it session-only; only an explicit
    // dismissal below cancels and restores the previous selection.
    return "session-only";
  }
  return "cancel";
}

export function chooseTlhModelSelectionScope(
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
): Promise<TlhModelSelectionScope> {
  return chooseTlhSelectionScope(ctx, "Model selection scope");
}

export function chooseTlhThinkingSelectionScope(
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">,
): Promise<TlhModelSelectionScope> {
  return chooseTlhSelectionScope(ctx, "Thinking selection scope");
}
