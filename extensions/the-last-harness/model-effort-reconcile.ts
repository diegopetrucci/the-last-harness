// Model/effort drift detection and reconcile state for primary agents and subagents.
// Logic + state only — no UI, no commands, no startup notices.
import { isRecord, readText } from "./common.js";
import {
  formatProviderModelReference,
  listAgentModelDefaultReferences,
  parseProviderModelReference,
  selectProviderAwareAgentDefaults,
  splitKnownThinkingSuffix,
  type ProviderModelReference,
} from "./model-defaults.js";
import { tlhStatePath, writeGuardedTlhStateFile } from "./profile-state.js";
import type { AgentPrompt, SubagentMetadata, ThinkingLevel, TlhSettings } from "./types.js";

/** Cross-module contract: a provider is known only when it is a non-empty string. */
export function isKnownProvider(provider: string | undefined): provider is string {
  return typeof provider === "string" && provider.length > 0;
}

/** Cross-module contract: a primary override counts only when it is a non-empty string. */
export function isMeaningfulPrimaryOverride(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Cross-module contract: a subagent override counts when model or thinking is set. */
export function hasMeaningfulSubagentOverride(override: unknown): boolean {
  if (!isRecord(override)) return false;
  const model = override.model;
  const thinking = override.thinking;
  const hasModel = typeof model === "string" || model === false;
  const hasThinking = typeof thinking === "string" || thinking === false;
  return hasModel || hasThinking;
}

type ProviderAcknowledgment = {
  model?: string;
  thinking?: string;
};

export type AcknowledgedRoleSnapshot = {
  byProvider?: Record<string, ProviderAcknowledgment>;
};

type ReconcileState = {
  acknowledgedSnapshot?: Record<string, AcknowledgedRoleSnapshot>;
  /** ISO timestamp of the last user decision, for diagnostics only. */
  lastDecisionAt?: string;
};

type PackagedRoleDefaults = {
  model?: string;
  thinking?: ThinkingLevel;
};

export type RoleDriftEntry = {
  role: "primary" | "subagent";
  name: string;
  override: {
    model?: string | false;
    thinking?: string | false;
  };
  packaged: PackagedRoleDefaults;
  packagedDefaultsChanged: boolean;
};

export function tlhReconcileStatePath(): string | undefined {
  return tlhStatePath("reconcile-state.json");
}

/**
 * Sanitize the `acknowledgedSnapshot` field of a parsed reconcile-state object.
 *
 * Validates only the fields TLH consumes to prevent crashes during drift
 * computation.  Unknown fields at every level are preserved so future TLH
 * versions that add fields are not silently stripped by an older reader.
 *
 * Specifically prevents a `null` or non-object entry reaching the drift
 * comparator, where `providerEntry.model` would throw a TypeError.
 */
function sanitizeAcknowledgedSnapshot(
  raw: Record<string, unknown>,
): Record<string, AcknowledgedRoleSnapshot> | undefined {
  const rawSnapshot = raw.acknowledgedSnapshot;
  if (rawSnapshot === undefined) {
    return undefined;
  }
  if (!isRecord(rawSnapshot)) {
    return undefined;
  }
  const result: Record<string, AcknowledgedRoleSnapshot> = {};
  for (const [name, entry] of Object.entries(rawSnapshot)) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawByProvider = entry.byProvider;
    if (rawByProvider === undefined) {
      continue;
    }
    if (!isRecord(rawByProvider)) {
      const { byProvider: _, ...rest } = entry;
      result[name] = rest as AcknowledgedRoleSnapshot;
      continue;
    }
    const sanitizedByProvider: Record<string, ProviderAcknowledgment> = {};
    for (const [provider, ack] of Object.entries(rawByProvider)) {
      if (provider === "") {
        continue;
      }
      if (!isRecord(ack)) {
        continue;
      }
      const sanitizedAck: Record<string, unknown> = { ...ack };
      if (sanitizedAck.model !== undefined && typeof sanitizedAck.model !== "string") {
        delete sanitizedAck.model;
      }
      if (sanitizedAck.thinking !== undefined && typeof sanitizedAck.thinking !== "string") {
        delete sanitizedAck.thinking;
      }
      sanitizedByProvider[provider] = sanitizedAck as ProviderAcknowledgment;
    }
    result[name] = { ...entry, byProvider: sanitizedByProvider } as AcknowledgedRoleSnapshot;
  }
  return result;
}

export function readReconcileState(): ReconcileState {
  const statePath = tlhReconcileStatePath();
  const content = statePath ? readText(statePath) : undefined;
  if (!content) {
    return {};
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    // Spread the full object first to preserve any unknown top-level fields, then
    // replace acknowledgedSnapshot with the sanitized version so downstream
    // drift computation cannot crash on malformed persisted entries.
    return {
      ...parsed,
      acknowledgedSnapshot: sanitizeAcknowledgedSnapshot(parsed),
    } as ReconcileState;
  } catch {
    return {};
  }
}

/**
 * Best-effort write. Concurrent sessions can race and drop one acknowledgment;
 * the only consequence is a repeated startup notice, so this stays unlocked.
 */
export function writeReconcileState(state: ReconcileState): boolean {
  try {
    const statePath = tlhReconcileStatePath();
    if (!statePath) {
      return false;
    }
    // Symlink / O_NOFOLLOW / atomic-replacement guards live in profile-state.ts.
    return writeGuardedTlhStateFile(
      statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      tlhReconcileStatePath,
    );
  } catch {
    return false;
  }
}

/**
 * Merge-update the acknowledged snapshot for one or more roles, preserving
 * existing acknowledged entries for roles not in the update.
 *
 * For roles that are already in state, `byProvider` entries are deep-merged so
 * that acknowledging under one provider does not erase prior acknowledgments
 * recorded under a different provider.
 *
 * Returns `true` when state is successfully persisted, `false` otherwise (see
 * `writeReconcileState` for the accepted concurrency limitation).
 */
export function updateReconcileAcknowledgedSnapshot(
  snapshot: Record<string, AcknowledgedRoleSnapshot>,
  lastDecisionAt?: string,
): boolean {
  const current = readReconcileState();
  const merged: Record<string, AcknowledgedRoleSnapshot> = {
    ...current.acknowledgedSnapshot,
  };
  for (const [name, incoming] of Object.entries(snapshot)) {
    const existing = merged[name];
    if (existing != null && incoming.byProvider != null) {
      // Deep-merge byProvider so a new-provider acknowledgment does not erase
      // previous ones recorded under other providers.
      merged[name] = {
        ...existing,
        byProvider: { ...existing.byProvider, ...incoming.byProvider },
      };
    } else {
      // No existing entry, or incoming lacks byProvider (old-shape passthrough): replace.
      merged[name] = incoming;
    }
  }
  return writeReconcileState({
    ...current,
    acknowledgedSnapshot: merged,
    ...(lastDecisionAt !== undefined ? { lastDecisionAt } : {}),
  });
}

type PackagedAgent = Pick<AgentPrompt, "name" | "tlhModelDefaults" | "tlhModelDefaultsSource"> &
  Partial<
    Pick<
      AgentPrompt,
      | "model"
      | "preferredModel"
      | "thinking"
      | "preferOppositeProvider"
      | "preferCurrentOpenaiModel"
    >
  >;

/**
 * Every model the agent's normalized provider entries declares, plus a legacy generic
 * `model` when reconciliation historically included it, parsed and de-duplicated.
 *
 * Returns all packaged models regardless of provider. Used internally by
 * `packagedCandidateModelsForProvider`; not used directly by `resolvePackagedDefaults`.
 */
function packagedCandidateModels(agent: PackagedAgent): ProviderModelReference[] {
  const seen = new Map<string, ProviderModelReference>();
  const rawModels = [
    ...(agent.tlhModelDefaultsSource === "legacy" ? [agent.model] : []),
    ...listAgentModelDefaultReferences(agent).map(formatProviderModelReference),
  ];
  for (const raw of rawModels) {
    // Frontmatter model strings may carry a thinking suffix; the catalog holds base models.
    const parsed = parseProviderModelReference(splitKnownThinkingSuffix(raw).baseModel);
    if (!parsed) {
      continue;
    }
    const key = formatProviderModelReference(parsed);
    if (!seen.has(key)) {
      seen.set(key, parsed);
    }
  }
  return [...seen.values()];
}

/**
 * The subset of an agent's packaged models whose provider is exactly `provider`.
 *
 * Uses exact string equality rather than provider-family matching. This matters
 * for multi-variant providers: filtering by an OpenAI family would admit
 * `openai-codex` models into a hypothetical `openai`-only environment where they
 * may be unavailable (and vice versa).
 */
function packagedCandidateModelsForProvider(
  agent: PackagedAgent,
  provider: string | undefined,
): ProviderModelReference[] {
  if (provider === undefined) {
    return [];
  }
  return packagedCandidateModels(agent).filter((m) => m.provider === provider);
}

/**
 * Resolve the packaged model + effort defaults for one role.
 *
 * Delegates to the production selector `selectProviderAwareAgentDefaults` so this
 * module can never disagree with what TLH actually applies at dispatch time. That
 * matters because `/reconcile` shows this value as "the default" and a Reset moves
 * the user onto it: a private re-implementation that missed `preferOppositeProvider`
 * (code-reviewer, contrarian, oracle) or `preferCurrentOpenaiModel` (rush) would
 * report — and reset to — the wrong model.
 *
 * Availability semantics: the candidate registry is restricted to packaged models
 * whose provider is exactly `provider` — not the user's live model registry and not
 * the full cross-provider catalog. "Packaged default for provider P" therefore means
 * "what this TLH release declares for an environment that has only provider-P models",
 * independent of the user's actual availability.
 *
 * This scoping is required by the ticket's trigger model: drift must fire only when
 * packaged defaults change, never when the user's model availability changes. The
 * tradeoff is that the reported default can name a model the user cannot currently
 * reach; presenting that is ts-tr52's job.
 *
 * Irreducible limitation: roles with `preferOppositeProvider` (e.g. code-reviewer,
 * contrarian, oracle) will resolve to their same-provider fallback in a
 * provider-P-only hypothetical, while a real dual-provider registry may pick the
 * opposite-provider model. This means the displayed packaged default for those roles
 * may differ from what Reset actually produces in a live session with both providers
 * available. The alternative — consulting the live registry — would cause spurious
 * drift notices when model availability changes, which is worse.
 */
function resolvePackagedDefaults(
  agent: PackagedAgent | undefined,
  provider: string | undefined,
): PackagedRoleDefaults {
  if (!agent) {
    return {};
  }
  const providerCandidates = packagedCandidateModelsForProvider(agent, provider);
  const defaults = selectProviderAwareAgentDefaults(agent, providerCandidates, provider);
  return {
    model: defaults.model ? formatProviderModelReference(defaults.model) : undefined,
    thinking: defaults.thinking,
  };
}

function packagedProviderAcknowledgment(
  agent: PackagedAgent | undefined,
  provider: string,
): ProviderAcknowledgment {
  const packaged = resolvePackagedDefaults(agent, provider);
  const ack: ProviderAcknowledgment = {};
  if (packaged.model !== undefined) {
    ack.model = packaged.model;
  }
  if (packaged.thinking !== undefined) {
    ack.thinking = packaged.thinking;
  }
  return ack;
}

/** Call only when an override is created. Rebaselining an edit hides unacknowledged drift. */
export function recordOverrideBaseline(
  agentName: string,
  agent: AgentPrompt | SubagentMetadata | undefined,
  provider: string | undefined,
): void {
  try {
    if (!isKnownProvider(provider)) {
      return;
    }
    updateReconcileAcknowledgedSnapshot({
      [agentName]: { byProvider: { [provider]: packagedProviderAcknowledgment(agent, provider) } },
    });
  } catch {
    // Best-effort: never throw into the command path.
  }
}

/**
 * **Accepted information loss:** The function cannot know about packaged-default
 * changes that happened between when the override was created and this startup,
 * including changes across skipped releases. Guessing a baseline from the override
 * value would manufacture false positives, so recording the current packaged default
 * is the least-bad deterministic migration. Do not use this as a substitute for the
 * override-creation baseline written by `recordOverrideBaseline`.
 *
 * **Failed write:** A best-effort write failure simply leaves detection unarmed
 * until a later launch succeeds. The returned in-memory snapshot still prevents a
 * spurious notice in the current pass even when the disk write does not complete.
 */
export function backfillMissingBaselines(
  primaryAgents: ReadonlyMap<string, AgentPrompt>,
  subagentMetadata: readonly SubagentMetadata[],
  settings: TlhSettings,
  currentProvider: string | undefined,
  existingSnapshot: Record<string, AcknowledgedRoleSnapshot> | undefined,
): Record<string, AcknowledgedRoleSnapshot> {
  const snapshot = existingSnapshot ?? {};
  try {
    if (!isKnownProvider(currentProvider)) {
      return snapshot;
    }
    const toBackfill: Record<string, AcknowledgedRoleSnapshot> = {};

    const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
    if (isRecord(primaryModelOverrides)) {
      for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
        if (!isMeaningfulPrimaryOverride(overrideValue)) {
          continue;
        }
        if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
          continue;
        }
        toBackfill[name] = {
          byProvider: {
            [currentProvider]: packagedProviderAcknowledgment(
              primaryAgents.get(name),
              currentProvider,
            ),
          },
        };
      }
    }

    const subagentOverrides = settings.subagents?.agentOverrides;
    if (isRecord(subagentOverrides)) {
      const subagentMap = new Map(subagentMetadata.map((s) => [s.name, s]));
      for (const [name, rawOverride] of Object.entries(subagentOverrides)) {
        if (!hasMeaningfulSubagentOverride(rawOverride)) {
          continue;
        }
        if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
          continue;
        }
        toBackfill[name] = {
          byProvider: {
            [currentProvider]: packagedProviderAcknowledgment(
              subagentMap.get(name),
              currentProvider,
            ),
          },
        };
      }
    }

    if (Object.keys(toBackfill).length === 0) {
      return snapshot;
    }

    updateReconcileAcknowledgedSnapshot(toBackfill);

    const merged: Record<string, AcknowledgedRoleSnapshot> = { ...snapshot };
    for (const [name, incoming] of Object.entries(toBackfill)) {
      const existing = merged[name];
      if (existing != null && incoming.byProvider != null) {
        merged[name] = {
          ...existing,
          byProvider: { ...existing.byProvider, ...incoming.byProvider },
        };
      } else {
        merged[name] = incoming;
      }
    }
    return merged;
  } catch {
    return snapshot;
  }
}

export function computeModelEffortDrift(
  primaryAgents: ReadonlyMap<string, AgentPrompt>,
  subagentMetadata: readonly SubagentMetadata[],
  settings: TlhSettings,
  currentProvider?: string,
  acknowledgedSnapshot?: Record<string, AcknowledgedRoleSnapshot>,
): RoleDriftEntry[] {
  const drift: RoleDriftEntry[] = [];

  const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
  if (isRecord(primaryModelOverrides)) {
    for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
      if (!isMeaningfulPrimaryOverride(overrideValue)) {
        continue;
      }
      const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
      const providerEntry = isKnownProvider(currentProvider)
        ? acknowledgedSnapshot?.[name]?.byProvider?.[currentProvider]
        : undefined;
      const packagedDefaultsChanged =
        providerEntry !== undefined &&
        (providerEntry.model !== packaged.model || providerEntry.thinking !== packaged.thinking);
      drift.push({
        role: "primary",
        name,
        override: { model: overrideValue },
        packaged,
        packagedDefaultsChanged,
      });
    }
  }

  const subagentOverrides = settings.subagents?.agentOverrides;
  if (isRecord(subagentOverrides)) {
    const subagentMap = new Map(subagentMetadata.map((s) => [s.name, s]));
    for (const [name, rawOverride] of Object.entries(subagentOverrides)) {
      if (!isRecord(rawOverride)) {
        continue;
      }
      // Validate fields TLH consumes; preserve unrelated unknown fields by not
      // dropping the entry outright — only the type-invalid consumed fields are
      // stripped.  model and thinking must be string, false, or undefined.
      const rawModel = rawOverride.model;
      const rawThinking = rawOverride.thinking;
      const model: string | false | undefined =
        rawModel === undefined || typeof rawModel === "string" || rawModel === false
          ? (rawModel as string | false | undefined)
          : undefined;
      const thinking: string | false | undefined =
        rawThinking === undefined || typeof rawThinking === "string" || rawThinking === false
          ? (rawThinking as string | false | undefined)
          : undefined;
      if (model === undefined && thinking === undefined) {
        continue;
      }
      const packaged = resolvePackagedDefaults(subagentMap.get(name), currentProvider);
      const providerEntry = isKnownProvider(currentProvider)
        ? acknowledgedSnapshot?.[name]?.byProvider?.[currentProvider]
        : undefined;
      const packagedDefaultsChanged =
        providerEntry !== undefined &&
        (providerEntry.model !== packaged.model || providerEntry.thinking !== packaged.thinking);
      const overrideEntry: RoleDriftEntry["override"] = {};
      if (model !== undefined) {
        overrideEntry.model = model;
      }
      if (thinking !== undefined) {
        overrideEntry.thinking = thinking;
      }
      drift.push({
        role: "subagent",
        name,
        override: overrideEntry,
        packaged,
        packagedDefaultsChanged,
      });
    }
  }

  return drift;
}
