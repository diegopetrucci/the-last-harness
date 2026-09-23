import type { SubagentModelIdentity } from "./types.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
/** Parse a persisted thinking level against the canonical runtime vocabulary. */
export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === "string" ? THINKING_LEVELS.find((level) => level === value) : undefined;
}

export interface ModelInfo {
  provider: string;
  id: string;
  fullId: string;
  contextWindow?: number;
}

interface RegistryModelLike {
  provider: string;
  id: string;
  contextWindow?: number;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    contextWindow: model.contextWindow,
  };
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
  availableModels: readonly ModelInfo[] | undefined,
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

/** Runtime model identity plus its exact context-window denominator. */
export interface RuntimeModelContextResolution {
  identity: SubagentModelIdentity;
  contextWindow: number;
}

const SAFE_RUNTIME_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Model ids are registry-owned values. Keep the boundary conservative without
// treating `/` or `:` as separators: providers such as OpenRouter and Ollama
// legitimately report those characters in the model id itself.
const SAFE_RUNTIME_MODEL = /^(?!\/)(?!.*\/$)[^\s\0]+$/;

function runtimeIdentityFromFullId(
  fullId: string,
  thinkingSuffix: string,
): SubagentModelIdentity | undefined {
  // Only the first slash separates the provider, so nested provider model ids
  // remain intact.
  const separator = fullId.indexOf("/");
  if (separator <= 0 || separator === fullId.length - 1) return undefined;
  const provider = fullId.slice(0, separator);
  const model = fullId.slice(separator + 1);
  if (!SAFE_RUNTIME_PROVIDER.test(provider) || !SAFE_RUNTIME_MODEL.test(model)) return undefined;
  return {
    provider,
    model,
    ...(thinkingSuffix ? { thinking: thinkingSuffix.slice(1) } : {}),
  };
}

/**
 * Resolve an exact model identity reported by an untrusted child message when
 * its configured context-window map contains the model. A separately
 * reported provider scopes the otherwise opaque model id.
 */
export function resolveRuntimeModelContext(
  providerValue: unknown,
  modelValue: unknown,
  contextWindows: Record<string, number> | undefined,
): RuntimeModelContextResolution | undefined {
  if (
    !contextWindows ||
    (typeof contextWindows !== "object" && typeof contextWindows !== "function") ||
    typeof modelValue !== "string" ||
    (providerValue !== undefined && typeof providerValue !== "string")
  )
    return undefined;
  const provider = typeof providerValue === "string" ? providerValue.trim() : "";
  const model = modelValue.trim();
  if (model === "") return undefined;
  if (provider !== "" && !SAFE_RUNTIME_PROVIDER.test(provider)) return undefined;
  const parsed = splitKnownThinkingSuffix(model);
  if (!SAFE_RUNTIME_MODEL.test(parsed.baseModel)) return undefined;

  // With a separately reported provider, the model portion is opaque. This
  // preserves registry ids such as openrouter/anthropic/claude-* and
  // ollama/qwen3:8b instead of mis-parsing their model portions as providers.
  const fullId = provider ? `${provider}/${parsed.baseModel}` : parsed.baseModel;
  if (!Object.hasOwn(contextWindows, fullId)) return undefined;
  const identity = runtimeIdentityFromFullId(fullId, parsed.thinkingSuffix);
  if (!identity) return undefined;
  const contextWindow = contextWindows[fullId];
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
    return undefined;
  return { identity, contextWindow };
}
