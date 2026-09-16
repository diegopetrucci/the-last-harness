import {
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import { formatHomePath } from "./common.js";
import { DUMB_ZONE_THRESHOLD_TOKENS } from "./constants.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import type { TlhSettings } from "./types.js";

// Re-exported alias so callers can reference the cap value without coupling to
// the "dumb zone" label used in footer rendering. Both names point to the same
// compile-time constant; 200_000 is defined exactly once in constants.ts.
const DEFAULT_CONTEXT_CAP_TOKENS = DUMB_ZONE_THRESHOLD_TOKENS;
const CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS = 272_000;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
const SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV = "PI_SUBAGENT_PROJECT_AGENT_GUIDANCE";

// Keep these key literals aligned with subagents/src/shared/model-info.ts. The
// eager context-cap extension cannot import that native-loader module without
// violating the lazy-import boundary, so the global symbols are the handoff.
const MODEL_CONTEXT_WINDOW_POLICY_KEY = Symbol.for("the-last-harness.model-context-window-policy");
const MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY = Symbol.for(
  "the-last-harness.model-context-window-policy-state",
);

interface ModelContextWindowPolicy {
  nativeContextWindow: number;
  developerChildContextWindow: number;
  installedContextWindow: number;
  ownerToken: symbol;
}

interface OwnedModelContextWindowPolicy {
  ownerToken: symbol;
  metadata: object;
  installedContextWindow: number;
  modelRef: WeakRef<AnyModel>;
}

type RegistryMethodName = "getAll" | "getAvailable" | "find" | "refresh";

interface RegistryMethodHook {
  originalDescriptor?: PropertyDescriptor;
  installedDescriptor: PropertyDescriptor;
}

interface RegistryContextWindowPolicy {
  child: boolean;
  canonicalDeveloper: boolean;
  contextCapDisabled: boolean;
  lifecycleToken: symbol;
  methodHooks: Map<RegistryMethodName, RegistryMethodHook>;
  originalGetAll?: ModelRegistryLike["getAll"];
  originalGetAvailable?: ModelRegistryLike["getAvailable"];
}

interface NativeContextWindowRecord {
  contextWindow: number;
  generation: number;
}

interface SharedContextWindowPolicyState {
  active: boolean;
  enabled: boolean;
  primaryContextWindowCap: number;
  developerContextWindowCap: number;
  generation: number;
  refreshGeneration?: number;
  activeRefreshGenerations: Set<number>;
  lifecycleToken?: symbol;
  nativeContextWindows: Map<string, NativeContextWindowRecord>;
  registries: WeakMap<object, RegistryContextWindowPolicy>;
  activeRegistry?: object;
  hookedRegistries: WeakSet<object>;
  ownedModels: Set<WeakRef<AnyModel>>;
}

const TOGGLE_CONTEXT_CAP_COMMAND_HELP = "Usage: /toggle-context-cap";

// Local structural aliases derived from ExtensionContext so we never import
// Model/Api directly from the nested @earendil-works/pi-ai transitive dep.
type AnyModel = NonNullable<ExtensionContext["model"]>;
type ModelRegistryLike = Pick<ModelRegistry, "getAll" | "getAvailable" | "find" | "refresh">;

interface OriginalContextWindow {
  contextWindow: number;
  generation: number;
}

// WeakMap stores the original contextWindow before a policy mutation.
// Keyed by model object identity so each Pi model instance is tracked
// independently across multiple concurrent sessions.
const originalContextWindows = new WeakMap<AnyModel, OriginalContextWindow>();
// Weak references keep cleanup handles for every still-live model object without
// retaining transient overlay objects strongly. The set is pruned on reads and
// lifecycle cleanup, while the per-object WeakMap retains the current owner.
const ownedModelPolicies = new WeakMap<AnyModel, OwnedModelContextWindowPolicy>();
const lifecycleStatesByRegistry = new WeakMap<object, SharedContextWindowPolicyState>();

function isChildSession(): boolean {
  const childSignal = process.env[SUBAGENT_CHILD_ENV];
  if (childSignal === "0") return false;
  if (childSignal === "1") return true;
  const childAgent = process.env[SUBAGENT_CHILD_AGENT_ENV];
  return childAgent !== undefined && childAgent.trim() !== "";
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isSharedContextWindowPolicyState(value: unknown): value is SharedContextWindowPolicyState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SharedContextWindowPolicyState>;
  return (
    typeof state.active === "boolean" &&
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
    state.ownedModels instanceof Set
  );
}

function sharedContextWindowPolicyState(): SharedContextWindowPolicyState {
  const globalValue: unknown = globalThis;
  const globalState = globalValue as Record<PropertyKey, unknown>;
  const existing = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY];
  if (isSharedContextWindowPolicyState(existing)) return existing;

  const created: SharedContextWindowPolicyState = {
    active: false,
    enabled: true,
    primaryContextWindowCap: DEFAULT_CONTEXT_CAP_TOKENS,
    developerContextWindowCap: CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS,
    generation: 0,
    activeRefreshGenerations: new Set(),
    nativeContextWindows: new Map(),
    registries: new WeakMap(),
    hookedRegistries: new WeakSet(),
    ownedModels: new Set<WeakRef<AnyModel>>(),
  };
  try {
    Object.defineProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY, {
      configurable: true,
      enumerable: false,
      value: created,
      writable: false,
    });
  } catch {
    // A foreign loader may have installed an immutable value under the shared
    // symbol. The local state still preserves the eager extension's behavior.
  }
  return isSharedContextWindowPolicyState(globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY])
    ? (globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY] as SharedContextWindowPolicyState)
    : created;
}

function modelIdentityKey(model: AnyModel): string | undefined {
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  if (!provider || !id) return undefined;
  return JSON.stringify([provider, id]);
}

function isCanonicalDeveloperChild(): boolean {
  return (
    isChildSession() &&
    process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim() === "developer" &&
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] === "1"
  );
}

function resolveChildContextWindow(
  nativeContextWindow: unknown,
  canonicalDeveloper: boolean,
  contextCapDisabled = false,
): number | undefined {
  const native = positiveFiniteNumber(nativeContextWindow);
  if (native === undefined) return undefined;
  return !contextCapDisabled && canonicalDeveloper
    ? Math.min(native, CANONICAL_DEVELOPER_CONTEXT_CAP_TOKENS)
    : native;
}

function pruneOwnedModelReferences(policyState: SharedContextWindowPolicyState): void {
  for (const modelRef of policyState.ownedModels) {
    if (!modelRef.deref()) policyState.ownedModels.delete(modelRef);
  }
}

/**
 * Attach native/effective child windows without importing the native subagent
 * model-info module into this eager extension graph. A symbol property is
 * invisible to model serialization and shared by all loaders in this process.
 */
function setModelContextWindowPolicy(
  model: AnyModel,
  policy: ModelContextWindowPolicy,
  policyState: SharedContextWindowPolicyState,
): void {
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
  const ownership: OwnedModelContextWindowPolicy = {
    ownerToken: policy.ownerToken,
    metadata,
    installedContextWindow: policy.installedContextWindow,
    modelRef,
  };
  ownedModelPolicies.set(model, ownership);
  pruneOwnedModelReferences(policyState);
  policyState.ownedModels.add(modelRef);
}

function modelHasOwnedContextWindowMetadata(
  model: AnyModel,
  ownership: OwnedModelContextWindowPolicy,
  ownerToken: symbol,
): boolean {
  if (ownership.ownerToken !== ownerToken || ownedModelPolicies.get(model) !== ownership)
    return false;
  return (
    Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY)?.value ===
    ownership.metadata
  );
}

function modelHasOwnedInstalledContextWindow(
  model: AnyModel,
  ownership: OwnedModelContextWindowPolicy,
  ownerToken: symbol,
): boolean {
  return (
    modelHasOwnedContextWindowMetadata(model, ownership, ownerToken) &&
    model.contextWindow === ownership.installedContextWindow
  );
}

function removeOwnedModelMetadataForModel(
  policyState: SharedContextWindowPolicyState,
  model: AnyModel,
  ownership: OwnedModelContextWindowPolicy,
  ownerToken: symbol,
  clearOriginalContextWindows: boolean,
): void {
  if (ownership.ownerToken !== ownerToken || ownedModelPolicies.get(model) !== ownership) return;
  if (modelHasOwnedContextWindowMetadata(model, ownership, ownerToken)) {
    try {
      Reflect.deleteProperty(model, MODEL_CONTEXT_WINDOW_POLICY_KEY);
    } catch {
      // A later wrapper may have made the metadata property non-configurable.
    }
  }
  if (clearOriginalContextWindows) originalContextWindows.delete(model);
  ownedModelPolicies.delete(model);
  policyState.ownedModels.delete(ownership.modelRef);
}

function removeOwnedModelMetadata(
  policyState: SharedContextWindowPolicyState,
  ownerToken: symbol,
  clearOriginalContextWindows = false,
): void {
  pruneOwnedModelReferences(policyState);
  for (const modelRef of policyState.ownedModels) {
    const model = modelRef.deref();
    if (!model) {
      policyState.ownedModels.delete(modelRef);
      continue;
    }
    const ownership = ownedModelPolicies.get(model);
    if (!ownership || ownership.ownerToken !== ownerToken) continue;
    removeOwnedModelMetadataForModel(
      policyState,
      model,
      ownership,
      ownerToken,
      clearOriginalContextWindows,
    );
  }
}

function hasCurrentLifecycleModelPolicy(
  model: AnyModel,
  policy?: RegistryContextWindowPolicy,
): boolean {
  if (!policy) return false;
  const ownership = ownedModelPolicies.get(model);
  return (
    ownership !== undefined &&
    ownership.ownerToken === policy.lifecycleToken &&
    modelHasOwnedInstalledContextWindow(model, ownership, policy.lifecycleToken)
  );
}

function effectiveContextWindowForPolicy(
  nativeContextWindow: number,
  policy: RegistryContextWindowPolicy,
): number {
  if (policy.contextCapDisabled) return nativeContextWindow;
  if (policy.child) {
    return (
      resolveChildContextWindow(nativeContextWindow, policy.canonicalDeveloper) ??
      nativeContextWindow
    );
  }
  return Math.min(nativeContextWindow, DEFAULT_CONTEXT_CAP_TOKENS);
}

function rememberNativeContextWindow(
  model: AnyModel,
  nativeContextWindow: number,
  policyState: SharedContextWindowPolicyState,
): void {
  const identity = modelIdentityKey(model);
  if (identity && positiveFiniteNumber(nativeContextWindow) !== undefined) {
    policyState.nativeContextWindows.set(identity, {
      contextWindow: nativeContextWindow,
      generation: policyState.generation,
    });
  }
}

function getOriginalContextWindow(
  model: AnyModel,
  policyState?: SharedContextWindowPolicyState,
  policy?: RegistryContextWindowPolicy,
  authoritativeGeneration?: number,
): number {
  const stored = originalContextWindows.get(model);
  const storedIsCurrentLifecycleOwned = hasCurrentLifecycleModelPolicy(model, policy);
  if (
    stored &&
    (authoritativeGeneration === undefined ||
      stored.generation === authoritativeGeneration ||
      storedIsCurrentLifecycleOwned)
  ) {
    if (policyState) rememberNativeContextWindow(model, stored.contextWindow, policyState);
    return stored.contextWindow;
  }

  const current = model.contextWindow;
  const identity = modelIdentityKey(model);
  const rememberedRecord = identity ? policyState?.nativeContextWindows.get(identity) : undefined;
  const remembered =
    rememberedRecord !== undefined && rememberedRecord.generation === policyState?.generation
      ? rememberedRecord.contextWindow
      : undefined;
  // A pending refresh can repopulate the identity cache from a stable
  // pre-refresh object. New objects must use their own current window until
  // settlement; stable objects were handled by the per-object WeakMap above.
  const canUseRememberedContextWindow =
    policyState === undefined || policyState.activeRefreshGenerations.size === 0;
  const currentPositive = positiveFiniteNumber(current);
  const original =
    remembered !== undefined &&
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
  if (policyState) rememberNativeContextWindow(model, original, policyState);
  return original;
}

function setContextWindow(
  model: AnyModel,
  contextWindow: number,
  policyState?: SharedContextWindowPolicyState,
  policy?: RegistryContextWindowPolicy,
  authoritativeGeneration?: number,
): boolean {
  if (model.contextWindow === contextWindow) return false;
  getOriginalContextWindow(model, policyState, policy, authoritativeGeneration);
  model.contextWindow = contextWindow;
  return true;
}

function restoreContextWindow(model: AnyModel | undefined): boolean {
  if (!model) return false;
  const original = originalContextWindows.get(model);
  if (!original) return false;
  if (model.contextWindow === original.contextWindow) {
    originalContextWindows.delete(model);
    return false;
  }
  model.contextWindow = original.contextWindow;
  originalContextWindows.delete(model);
  return true;
}

function applyContextWindowPolicy(
  model: AnyModel | undefined,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
  authoritativeGeneration?: number,
): boolean {
  if (!model) return false;
  const nativeContextWindow = getOriginalContextWindow(
    model,
    policyState,
    policy,
    authoritativeGeneration,
  );
  const developerChildContextWindow = resolveChildContextWindow(
    nativeContextWindow,
    true,
    policy.contextCapDisabled,
  );
  if (developerChildContextWindow === undefined) return false;
  const installedContextWindow = effectiveContextWindowForPolicy(nativeContextWindow, policy);
  setModelContextWindowPolicy(
    model,
    {
      nativeContextWindow,
      developerChildContextWindow,
      installedContextWindow,
      ownerToken: policy.lifecycleToken,
    },
    policyState,
  );
  if (policy.contextCapDisabled) return false;
  return setContextWindow(
    model,
    installedContextWindow,
    policyState,
    policy,
    authoritativeGeneration,
  );
}

function applyContextWindowPolicyToModels(
  models: readonly AnyModel[] | undefined,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
  authoritativeGeneration?: number,
): number {
  let changed = 0;
  for (const model of models ?? []) {
    if (applyContextWindowPolicy(model, policyState, policy, authoritativeGeneration)) changed++;
  }
  return changed;
}

function applyContextWindowPolicyToRegistry(
  registry: ModelRegistryLike,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
  authoritativeGeneration?: number,
): number {
  let changed = 0;
  for (const readModels of [registry.getAll, registry.getAvailable]) {
    if (typeof readModels !== "function") continue;
    try {
      changed += applyContextWindowPolicyToModels(
        readModels.call(registry),
        policyState,
        policy,
        authoritativeGeneration,
      );
    } catch {
      // Best effort. The active ctx.model is handled separately.
    }
  }
  return changed;
}

function readRegistryCurrentModels(
  registry: ModelRegistryLike,
  policy: RegistryContextWindowPolicy,
): AnyModel[] {
  const models: AnyModel[] = [];
  const seen = new Set<AnyModel>();
  for (const readModels of [policy.originalGetAll, policy.originalGetAvailable]) {
    if (typeof readModels !== "function") continue;
    try {
      for (const model of readModels.call(registry)) {
        if (seen.has(model)) continue;
        seen.add(model);
        models.push(model);
      }
    } catch {
      // Best effort. A failed registry read should not mask refresh results.
    }
  }
  return models;
}

function reconcileRegistryRefreshSnapshot(
  registry: ModelRegistryLike,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
  modelsBeforeRefresh: ReadonlySet<AnyModel>,
  authoritativeGeneration: number,
): void {
  const replacementModels = readRegistryCurrentModels(registry, policy).filter(
    (model) => !modelsBeforeRefresh.has(model),
  );
  if (replacementModels.length === 0) return;

  const previousRefreshGeneration = policyState.refreshGeneration;
  policyState.refreshGeneration = authoritativeGeneration;
  try {
    applyContextWindowPolicyToModels(
      replacementModels,
      policyState,
      policy,
      authoritativeGeneration,
    );
  } finally {
    if (policyState.refreshGeneration === authoritativeGeneration) {
      policyState.refreshGeneration = previousRefreshGeneration;
    }
  }
}

function forEachRegistryModel(ctx: ExtensionContext, callback: (model: AnyModel) => void): void {
  const registryValue: unknown = ctx.modelRegistry;
  const registry = registryValue as ModelRegistryLike;
  const seen = new Set<AnyModel>();
  for (const readModels of [registry.getAll, registry.getAvailable]) {
    if (typeof readModels !== "function") continue;
    try {
      for (const model of readModels.call(registry)) {
        if (seen.has(model)) continue;
        seen.add(model);
        callback(model);
      }
    } catch {
      // Best effort. The active ctx.model is handled separately.
    }
  }
}

function activeRegistryPolicy(
  registry: ModelRegistryLike,
  policyState: SharedContextWindowPolicyState,
): RegistryContextWindowPolicy | undefined {
  if (!policyState.active || policyState.activeRegistry !== registry) return undefined;
  return policyState.registries.get(registry);
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.value === right.value &&
    left.writable === right.writable &&
    left.get === right.get &&
    left.set === right.set
  );
}

function latestActiveRefreshGeneration(
  policyState: SharedContextWindowPolicyState,
): number | undefined {
  let latest: number | undefined;
  for (const generation of policyState.activeRefreshGenerations) {
    if (latest === undefined || generation > latest) latest = generation;
  }
  return latest;
}

function defineRegistryMethod(
  registry: ModelRegistryLike,
  name: RegistryMethodName,
  value: unknown,
): RegistryMethodHook | undefined {
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
  } catch {
    // Some callers may provide a sealed registry facade. The global policy
    // fallback still keeps native/effective diagnostics correct in that case.
    return undefined;
  }
}

/**
 * Decorate registry reads as well as refreshes. Configured/overlaid providers
 * commonly create a fresh model object for every getAll/getAvailable call, so
 * applying only at session_start would leave later diagnostics uncapped.
 */
function installRegistryHooks(
  registry: ModelRegistryLike,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
): void {
  if (policyState.hookedRegistries.has(registry)) return;
  policyState.hookedRegistries.add(registry);

  const install = (name: RegistryMethodName, value: unknown): void => {
    const hook = defineRegistryMethod(registry, name, value);
    if (hook) policy.methodHooks.set(name, hook);
  };

  const originalGetAll = registry.getAll;
  policy.originalGetAll = originalGetAll;
  if (typeof originalGetAll === "function") {
    install("getAll", function (this: ModelRegistryLike) {
      const models = originalGetAll.call(this);
      const currentPolicy = activeRegistryPolicy(registry, policyState);
      if (currentPolicy) applyContextWindowPolicyToModels(models, policyState, currentPolicy);
      return models;
    });
  }

  const originalGetAvailable = registry.getAvailable;
  policy.originalGetAvailable = originalGetAvailable;
  if (typeof originalGetAvailable === "function") {
    install("getAvailable", function (this: ModelRegistryLike) {
      const models = originalGetAvailable.call(this);
      const currentPolicy = activeRegistryPolicy(registry, policyState);
      if (currentPolicy) applyContextWindowPolicyToModels(models, policyState, currentPolicy);
      return models;
    });
  }

  const originalFind = registry.find;
  if (typeof originalFind === "function") {
    install("find", function (this: ModelRegistryLike, provider: string, modelId: string) {
      const model = originalFind.call(this, provider, modelId);
      const currentPolicy = activeRegistryPolicy(registry, policyState);
      if (currentPolicy) applyContextWindowPolicy(model, policyState, currentPolicy);
      return model;
    });
  }

  const originalRefresh = registry.refresh;
  if (typeof originalRefresh === "function") {
    install(
      "refresh",
      async function (this: ModelRegistryLike, ...args: Parameters<ModelRegistryLike["refresh"]>) {
        const currentPolicy = activeRegistryPolicy(registry, policyState);
        if (!currentPolicy) return originalRefresh.apply(this, args);

        const lifecycleToken = currentPolicy.lifecycleToken;
        const modelsBeforeRefresh = new Set(readRegistryCurrentModels(registry, currentPolicy));
        const generation = ++policyState.generation;
        policyState.activeRefreshGenerations.add(generation);
        policyState.refreshGeneration = generation;
        policyState.nativeContextWindows.clear();
        try {
          let outcome:
            | { fulfilled: true; value: Awaited<ReturnType<ModelRegistryLike["refresh"]>> }
            | { fulfilled: false; error: unknown };
          try {
            outcome = {
              fulfilled: true,
              value: await originalRefresh.apply(this, args),
            };
          } catch (error) {
            outcome = { fulfilled: false, error };
          }

          const refreshedPolicy = activeRegistryPolicy(registry, policyState);
          // Completion order determines which snapshot is current; every
          // completing refresh, including rejected installs, must reapply
          // policy to its replacement snapshot.
          if (refreshedPolicy?.lifecycleToken === lifecycleToken) {
            try {
              reconcileRegistryRefreshSnapshot(
                registry,
                policyState,
                refreshedPolicy,
                modelsBeforeRefresh,
                generation,
              );
            } catch (error) {
              // Preserve a refresh rejection even if best-effort reconciliation
              // encounters a model that cannot be updated.
              if (outcome.fulfilled) throw error;
            }
          }

          if (!outcome.fulfilled) throw outcome.error;
          return outcome.value;
        } finally {
          policyState.activeRefreshGenerations.delete(generation);
          if (policyState.refreshGeneration === generation) {
            policyState.refreshGeneration = latestActiveRefreshGeneration(policyState);
          }
        }
      },
    );
  }
}

function restoreRegistryMethodHooks(
  registry: ModelRegistryLike,
  policyState: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
): void {
  for (const [name, hook] of policy.methodHooks) {
    const currentDescriptor = Object.getOwnPropertyDescriptor(registry, name);
    if (!descriptorsEqual(currentDescriptor, hook.installedDescriptor)) continue;
    try {
      if (hook.originalDescriptor) {
        Object.defineProperty(registry, name, hook.originalDescriptor);
      } else {
        Reflect.deleteProperty(registry, name);
      }
    } catch {
      // Preserve a descriptor that became non-configurable during the lifecycle.
    }
  }
  policy.methodHooks.clear();
  policyState.hookedRegistries.delete(registry);
}

function activateContextWindowPolicy(
  ctx: ExtensionContext,
  child: boolean,
  canonicalDeveloper: boolean,
  contextCapDisabled: boolean,
  resetNativeContextWindows: boolean,
): { state: SharedContextWindowPolicyState; policy: RegistryContextWindowPolicy } {
  const state = sharedContextWindowPolicyState();
  const registryValue: unknown = ctx.modelRegistry;
  const registry = registryValue as ModelRegistryLike;
  const previousRegistry = state.activeRegistry;
  const startsLifecycle =
    !state.active || previousRegistry !== registry || resetNativeContextWindows;

  if (previousRegistry && previousRegistry !== registry) {
    const previousPolicy = state.registries.get(previousRegistry);
    if (previousPolicy && state.lifecycleToken === previousPolicy.lifecycleToken) {
      restoreOwnedModelWindows(state);
      restoreRegistryMethodHooks(previousRegistry as ModelRegistryLike, state, previousPolicy);
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
    methodHooks: new Map<RegistryMethodName, RegistryMethodHook>(),
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

function deactivateContextWindowPolicy(ctx: ExtensionContext): void {
  const registryValue: unknown = ctx.modelRegistry;
  const registry = registryValue as ModelRegistryLike;
  const state = lifecycleStatesByRegistry.get(registry) ?? sharedContextWindowPolicyState();
  const policy = state.registries.get(registry);
  if (
    !policy ||
    state.activeRegistry !== registry ||
    state.lifecycleToken !== policy.lifecycleToken
  )
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

  const globalValue: unknown = globalThis;
  const globalState = globalValue as Record<PropertyKey, unknown>;
  const ownsGlobalState = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY] === state;

  state.active = false;
  state.activeRegistry = undefined;
  state.refreshGeneration = undefined;
  state.activeRefreshGenerations.clear();
  state.nativeContextWindows.clear();
  state.lifecycleToken = undefined;
  if (!ownsGlobalState) return;
  try {
    Reflect.deleteProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY);
  } catch {
    // An immutable foreign state holder remains inactive but is not clobbered.
  }
}

function applyContextWindowPolicyToSession(
  ctx: ExtensionContext,
  state: SharedContextWindowPolicyState,
  policy: RegistryContextWindowPolicy,
): number {
  const registryValue: unknown = ctx.modelRegistry;
  const registry = registryValue as ModelRegistryLike;
  let changed = applyContextWindowPolicyToRegistry(registry, state, policy);
  if (applyContextWindowPolicy(ctx.model, state, policy)) changed++;
  return changed;
}

function restoreContextCapForSession(ctx: ExtensionContext, ownerToken: symbol): number {
  let changed = 0;
  forEachRegistryModel(ctx, (model) => {
    const ownership = ownedModelPolicies.get(model);
    if (ownership && modelHasOwnedInstalledContextWindow(model, ownership, ownerToken)) {
      if (restoreContextWindow(model)) changed++;
    }
  });
  const model = ctx.model;
  const ownership = model ? ownedModelPolicies.get(model) : undefined;
  if (model && ownership && modelHasOwnedInstalledContextWindow(model, ownership, ownerToken)) {
    if (restoreContextWindow(model)) changed++;
  }
  return changed;
}

function restoreOwnedModelWindows(
  policyState: SharedContextWindowPolicyState,
  ownerToken = policyState.lifecycleToken,
): number {
  if (!ownerToken) return 0;
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
      if (restoreContextWindow(model)) changed++;
    }
  }
  return changed;
}

function isContextCapDisabled(cwd: string): boolean {
  try {
    const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
    return settings.tlh?.contextCap?.disabled === true;
  } catch {
    return false;
  }
}

type ContextCapToggleResult = {
  changed: boolean;
  nowDisabled: boolean;
  settingsPath: string;
  backupPath?: string;
};

function toggleContextCapSetting(cwd: string): ContextCapToggleResult {
  return withLockedTlhSettingsWrite(
    cwd,
    "Refusing to write context-cap settings outside the isolated TLH profile.",
    (current) => {
      const settings: TlhSettings = current ? (JSON.parse(current) as TlhSettings) : {};
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
    },
  );
}

export function registerContextCap(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const child = isChildSession();
    const canonicalDeveloper = isCanonicalDeveloperChild();
    const { state, policy } = activateContextWindowPolicy(
      ctx,
      child,
      canonicalDeveloper,
      isContextCapDisabled(ctx.cwd),
      true,
    );
    applyContextWindowPolicyToSession(ctx, state, policy);
  });

  pi.on("model_select", async (event, ctx) => {
    const child = isChildSession();
    const canonicalDeveloper = isCanonicalDeveloperChild();
    const { state, policy } = activateContextWindowPolicy(
      ctx,
      child,
      canonicalDeveloper,
      isContextCapDisabled(ctx.cwd),
      false,
    );
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
        const { state, policy } = activateContextWindowPolicy(
          ctx,
          isChildSession(),
          isCanonicalDeveloperChild(),
          result.nowDisabled,
          false,
        );
        if (result.nowDisabled && state.lifecycleToken) {
          restoreOwnedModelWindows(state, state.lifecycleToken);
        }
        state.enabled = !result.nowDisabled;
        policy.contextCapDisabled = result.nowDisabled;
        applyContextWindowPolicyToSession(ctx, state, policy);
        ctx.ui.notify(
          `Context cap ${result.nowDisabled ? "disabled" : "enabled"}. Updated TLH settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not update context cap setting: ${message}`, "error");
      }
    },
  });
}
