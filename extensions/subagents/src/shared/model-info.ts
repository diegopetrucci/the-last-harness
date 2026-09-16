const MODEL_CONTEXT_WINDOW_POLICY_KEY = Symbol.for("the-last-harness.model-context-window-policy");
const MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY = Symbol.for(
  "the-last-harness.model-context-window-policy-state",
);

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
  nativeContextWindows: Map<string, NativeContextWindowRecord>;
}

export interface ModelContextWindowPolicy {
  nativeContextWindow: number;
  developerChildContextWindow: number;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isModelContextWindowOwner(value: unknown): value is object | Function {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isModelContextWindowPolicy(value: unknown): value is ModelContextWindowPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    positiveFiniteNumber(policy.nativeContextWindow) !== undefined &&
    positiveFiniteNumber(policy.developerChildContextWindow) !== undefined
  );
}

function isSharedContextWindowPolicyState(value: unknown): value is SharedContextWindowPolicyState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<SharedContextWindowPolicyState>;
  return (
    typeof state.active === "boolean" &&
    typeof state.enabled === "boolean" &&
    typeof state.generation === "number" &&
    Number.isInteger(state.generation) &&
    state.generation >= 0 &&
    positiveFiniteNumber(state.primaryContextWindowCap) !== undefined &&
    positiveFiniteNumber(state.developerContextWindowCap) !== undefined &&
    state.nativeContextWindows instanceof Map
  );
}

function isNativeContextWindowRecord(value: unknown): value is NativeContextWindowRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<NativeContextWindowRecord>;
  return (
    positiveFiniteNumber(record.contextWindow) !== undefined &&
    typeof record.generation === "number" &&
    Number.isInteger(record.generation) &&
    record.generation >= 0
  );
}

function getSharedContextWindowPolicyState(): SharedContextWindowPolicyState | undefined {
  const globalValue: unknown = globalThis;
  const globalState = globalValue as Record<PropertyKey, unknown>;
  const state = globalState[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY];
  return isSharedContextWindowPolicyState(state) && state.active ? state : undefined;
}

function modelIdentityKey(model: { provider?: unknown; id?: unknown }): string | undefined {
  if (
    typeof model.provider !== "string" ||
    typeof model.id !== "string" ||
    model.provider.length === 0 ||
    model.id.length === 0
  )
    return undefined;
  return JSON.stringify([model.provider, model.id]);
}

function getGlobalContextWindowPolicy(
  model: RegistryModelLike,
): ModelContextWindowPolicy | undefined {
  const state = getSharedContextWindowPolicyState();
  if (!state) return undefined;
  const current = positiveFiniteNumber(model.contextWindow);
  const rememberedRecord = state.nativeContextWindows.get(modelIdentityKey(model) ?? "");
  const remembered =
    isNativeContextWindowRecord(rememberedRecord) &&
    rememberedRecord.generation === state.generation
      ? rememberedRecord.contextWindow
      : undefined;
  let nativeContextWindow = current ?? remembered;
  if (remembered !== undefined && current !== undefined) {
    const primaryEffective = Math.min(remembered, state.primaryContextWindowCap);
    const developerEffective = state.enabled
      ? Math.min(remembered, state.developerContextWindowCap)
      : remembered;
    if (current === primaryEffective || current === developerEffective) {
      nativeContextWindow = remembered;
    }
  }
  if (nativeContextWindow === undefined) return undefined;
  return {
    nativeContextWindow,
    developerChildContextWindow: state.enabled
      ? Math.min(nativeContextWindow, state.developerContextWindowCap)
      : nativeContextWindow,
  };
}

/**
 * Read process-local model metadata written by the eager context-cap extension.
 * The global symbol and non-enumerable model property keep this handoff intact
 * when TLH's eager and native subagent loaders instantiate separate modules.
 */
export function getModelContextWindowPolicy(model: unknown): ModelContextWindowPolicy | undefined {
  if (!isModelContextWindowOwner(model)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY);
  const policy: unknown = descriptor?.value;
  if (!isModelContextWindowPolicy(policy)) return undefined;
  return {
    nativeContextWindow: policy.nativeContextWindow,
    developerChildContextWindow: policy.developerChildContextWindow,
  };
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Parse a persisted thinking level against the canonical runtime vocabulary. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" ? THINKING_LEVELS.find((level) => level === value) : undefined;
}

export interface ModelInfo {
  provider: string;
  id: string;
  fullId: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /** The model registry's current in-process context window. */
  contextWindow?: number;
  /** The provider's native context window before TLH's primary-session cap. */
  nativeContextWindow?: number;
  /** The effective window for a canonical packaged developer child. */
  developerChildContextWindow?: number;
}

interface RegistryModelLike {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  contextWindow?: number;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
  const contextWindowPolicy =
    getModelContextWindowPolicy(model) ?? getGlobalContextWindowPolicy(model);
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    contextWindow: model.contextWindow,
    ...(contextWindowPolicy
      ? {
          nativeContextWindow: contextWindowPolicy.nativeContextWindow,
          developerChildContextWindow: contextWindowPolicy.developerChildContextWindow,
        }
      : {}),
  };
}

function positiveContextWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface ChildContextWindowOptions {
  /** Select the canonical packaged developer-child policy instead of native. */
  canonicalDeveloper?: boolean;
}

/** Resolve the effective context window for a child from captured model metadata. */
export function contextWindowForChildModel(
  model: ModelInfo,
  options: ChildContextWindowOptions = {},
): number | undefined {
  return options.canonicalDeveloper === true
    ? (positiveContextWindow(model.developerChildContextWindow) ??
        positiveContextWindow(model.nativeContextWindow) ??
        positiveContextWindow(model.contextWindow))
    : (positiveContextWindow(model.nativeContextWindow) ??
        positiveContextWindow(model.contextWindow));
}

/** Build the provider-qualified child-window map passed to foreground/background runners. */
export function contextWindowsForChildModels(
  models: readonly ModelInfo[] | undefined,
  options: ChildContextWindowOptions = {},
): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const model of models ?? []) {
    const contextWindow = contextWindowForChildModel(model, options);
    if (contextWindow !== undefined) entries.push([model.fullId, contextWindow]);
  }
  return Object.fromEntries(entries);
}

/** Resolve the effective thinking level from a model string (which may contain a known suffix like `:high`)
 * and an explicit thinking config value. Returns `undefined` when no thinking is applicable
 * (e.g. no model was specified, or the model has no suffix and no config was provided). */
export function resolveEffectiveThinking(
  model: string | undefined,
  configThinking: string | false | undefined,
): string | undefined {
  if (!model) return undefined;
  const { thinkingSuffix } = splitKnownThinkingSuffix(model);
  if (thinkingSuffix) return thinkingSuffix.slice(1);
  return THINKING_LEVELS.find((level) => level === configThinking);
}

export function splitKnownThinkingSuffix(model: string): {
  baseModel: string;
  thinkingSuffix: string;
} {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
  const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
  if (!suffix) return { baseModel: model, thinkingSuffix: "" };
  return {
    baseModel: model.substring(0, colonIdx),
    thinkingSuffix: `:${suffix}`,
  };
}

export function findModelInfo(
  model: string | undefined,
  availableModels: ModelInfo[] | undefined,
  preferredProvider?: string,
): ModelInfo | undefined {
  if (!model || !availableModels || availableModels.length === 0) return undefined;
  const { baseModel } = splitKnownThinkingSuffix(model);
  const exact = availableModels.find((entry) => entry.fullId === baseModel);
  if (exact) return exact;

  const matches = availableModels.filter((entry) => entry.id === baseModel);
  if (preferredProvider) {
    const preferred = matches.find((entry) => entry.provider === preferredProvider);
    if (preferred) return preferred;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  if (!model) return THINKING_LEVELS.filter((level) => level !== "max");
  if (model.reasoning === false) return ["off"];

  if (!model.thinkingLevelMap) return THINKING_LEVELS.filter((level) => level !== "max");

  const levels = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
  return levels;
}
