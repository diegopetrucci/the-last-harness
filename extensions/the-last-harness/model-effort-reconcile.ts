// Model/effort drift detection and reconcile state for primary agents and subagents.
// Logic + state only — no UI, no commands, no startup notices.
//
// Baseline backfill (ts-8kfb):
// On the first startup with a known provider where an override has no usable baseline,
// `backfillMissingBaselines` silently records the current packaged default as that
// baseline.  This is a deliberate, accepted information loss: the function cannot know
// about packaged-default changes that occurred between the time the override was created
// and this startup — including changes across skipped releases.  Guessing a baseline
// from the override value would manufacture false positives, so recording the current
// default is the least-bad deterministic migration.
// A failed best-effort write simply leaves detection unarmed until a later launch
// succeeds; the in-memory snapshot returned by the function still prevents a spurious
// notice in the current pass.
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

// ---------------------------------------------------------------------------
// Shared provider and override predicates
// ---------------------------------------------------------------------------

/**
 * True when `provider` is a known (non-empty string) provider.
 *
 * Both `undefined` and `""` are treated as unknown per ts-7w6o. The empty-string
 * case is reachable from user-editable settings.json or a misconfigured session.
 *
 * Using a single shared predicate ensures all layers (startup guard, drift
 * comparator, backfill, baseline write, sanitizer) agree on what "unknown provider"
 * means and cannot drift apart again.
 */
export function isKnownProvider(provider: string | undefined): provider is string {
  return typeof provider === "string" && provider.length > 0;
}

/**
 * True when `value` is a meaningful (non-empty string) primary-agent model override.
 *
 * Mirrors `computeModelEffortDrift`'s primary acceptance predicate. `null`, `""`,
 * and non-string values are all treated as absent; settings.json is user-editable
 * and any of these can appear at runtime.
 *
 * Exported so override-creation transition checks in primary-agent-runtime.ts can
 * import a single shared definition rather than a private ad-hoc comparison.
 */
export function isMeaningfulPrimaryOverride(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * True when `override` contains at least one meaningful field (model or thinking).
 *
 * Mirrors `computeModelEffortDrift`'s per-entry subagent acceptance predicates:
 * model and thinking must be string or false to count as active. `null`, numbers,
 * and objects are treated as absent — settings.json is user-editable and any of
 * these can appear at runtime.
 *
 * Exported so `subagent-settings.ts` and override-creation transition checks can
 * import a single shared definition rather than writing independent copies that
 * could drift out of sync with the drift comparator.
 */
export function hasMeaningfulSubagentOverride(override: unknown): boolean {
  if (!isRecord(override)) return false;
  const model = override.model;
  const thinking = override.thinking;
  const hasModel = typeof model === "string" || model === false;
  const hasThinking = typeof thinking === "string" || thinking === false;
  return hasModel || hasThinking;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Packaged defaults recorded for one (role, provider) pair when the baseline is
 * established or updated — either when the user creates an override (written by the
 * override write paths in primary-agent-runtime.ts and subagent-settings.ts) or when
 * they run /reconcile (written by reconcile-command.ts).
 *
 * Seeding on override creation ensures drift detection can fire on the very first
 * TLH update, even if /reconcile has never been run.
 */
type ProviderAcknowledgment = {
  /** Packaged model at baseline time (base model without thinking suffix). */
  model?: string;
  /** Packaged thinking level at baseline time. */
  thinking?: string;
};

/**
 * Per-role baseline snapshot storing the packaged defaults that were current when
 * the baseline was last established.
 *
 * The baseline is written in two situations:
 * 1. When the user **creates** an override (transition from no meaningful override
 *    to an active one) — written by primary-agent-runtime.ts and subagent-settings.ts.
 *    A remove-then-recreate replaces stale state, since packaged defaults may have
 *    changed while no override existed.
 * 2. When the user runs `/reconcile` and makes a keep/reset decision — written by
 *    reconcile-command.ts.
 *
 * Provider-keyed: `byProvider[provider]` holds the packaged defaults that were
 * current when the baseline was last set under that provider.  Switching providers
 * will not trigger a false "packaged default changed" notice; only a genuine TLH
 * update to the active provider's packaged default fires the notice.
 *
 * Sessions with an unknown provider defer baseline writes and comparison; no
 * empty-string key is ever written (ts-7w6o).
 */
export type AcknowledgedRoleSnapshot = {
  /**
   * Keyed by provider string.  Populated on override creation and by /reconcile
   * when the session provider is known; read by drift detection to scope
   * comparisons to the active provider.
   */
  byProvider?: Record<string, ProviderAcknowledgment>;
};

/** Persisted reconcile state under tlh/reconcile-state.json. */
type ReconcileState = {
  /**
   * Per-role baseline snapshots.  Keyed by agent name (primary and subagent names
   * live in separate pools and do not overlap in the bundled catalog).
   *
   * Entries are established when the user creates an override (via
   * primary-agent-runtime.ts or subagent-settings.ts) or updated when they run
   * /reconcile.  The drift comparator in `computeModelEffortDrift` reads these to
   * determine whether `packagedDefaultsChanged` is true.
   */
  acknowledgedSnapshot?: Record<string, AcknowledgedRoleSnapshot>;
  /** ISO timestamp of the last user decision, for diagnostics only. */
  lastDecisionAt?: string;
};

/** Provider-resolved packaged defaults for a single role. */
type PackagedRoleDefaults = {
  /** Base model string (no thinking suffix) resolved for the current provider. */
  model?: string;
  /** Packaged thinking level resolved for the current provider. */
  thinking?: ThinkingLevel;
};

/** One entry per role where the user has an active override. */
export type RoleDriftEntry = {
  role: "primary" | "subagent";
  name: string;
  /** The user's stored override for this role. */
  override: {
    /** For primary: stored model string (may include thinking suffix). For subagents: string | false | undefined. */
    model?: string | false;
    /** Only present for subagent overrides. */
    thinking?: string | false;
  };
  /** Current packaged defaults, provider-resolved. */
  packaged: PackagedRoleDefaults;
  /**
   * True when the user previously acknowledged this role's packaged defaults and
   * those defaults have since changed. False when there is no prior acknowledgment
   * or the defaults are unchanged.
   */
  packagedDefaultsChanged: boolean;
};

// ---------------------------------------------------------------------------
// State path
// ---------------------------------------------------------------------------

export function tlhReconcileStatePath(): string | undefined {
  return tlhStatePath("reconcile-state.json");
}

// ---------------------------------------------------------------------------
// State read
// ---------------------------------------------------------------------------

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
    // acknowledgedSnapshot is not a plain object — drop it.
    return undefined;
  }
  const result: Record<string, AcknowledgedRoleSnapshot> = {};
  for (const [name, entry] of Object.entries(rawSnapshot)) {
    if (!isRecord(entry)) {
      // null, string, number, etc. — drop to prevent crashes on entry?.byProvider.
      continue;
    }
    const rawByProvider = entry.byProvider;
    if (rawByProvider === undefined) {
      // No byProvider field — entry carries no provider-keyed acknowledgment data;
      // drop it so the comparator never sees a stale or empty entry.
      continue;
    }
    if (!isRecord(rawByProvider)) {
      // byProvider exists but is not a record — strip it, preserve other fields.
      const { byProvider: _, ...rest } = entry;
      result[name] = rest as AcknowledgedRoleSnapshot;
      continue;
    }
    // Sanitize each provider entry: drop non-records, drop empty-string provider
    // keys (treated as unknown per ts-7w6o), and strip consumed fields whose
    // values are not the expected types.
    const sanitizedByProvider: Record<string, ProviderAcknowledgment> = {};
    for (const [provider, ack] of Object.entries(rawByProvider)) {
      // Empty-string provider is unknown — drop it so the comparator never
      // reads a byProvider[""] entry and reports spurious drift.
      if (provider === "") {
        continue;
      }
      if (!isRecord(ack)) {
        // null or non-object acknowledgment — drop to prevent crash on providerEntry.model.
        continue;
      }
      // Validate consumed fields: model and thinking must be string or undefined.
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

// ---------------------------------------------------------------------------
// State write
// ---------------------------------------------------------------------------

/**
 * Persist the reconcile state to disk.
 *
 * Returns `true` when the file is written successfully, `false` when any guard
 * rejects or when the write fails for any other reason.
 *
 * Best-effort: never throws so a failed write never blocks launch.
 *
 * Concurrency note: two simultaneous sessions can race on this write and one
 * acknowledgment may be lost. The only consequence is a repeated startup notice
 * on the next launch. Adding a file lock is not worth the complexity for this
 * failure mode, so it is accepted and documented here instead.
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
    // Reconcile state is best-effort; never block launch.
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

// ---------------------------------------------------------------------------
// Packaged-default resolution
// ---------------------------------------------------------------------------

/** Normalized agent fields that declare a packaged model catalog. */
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
 *
 * When `provider` is `undefined` the filtered list is always empty, which causes
 * `resolvePackagedDefaults` to return no model for an unknown session provider.
 * Startup and /reconcile both defer all comparison and acknowledgment when no
 * provider is known (ts-7w6o), so this empty-list path is never reached in a
 * context where it could produce a spurious drift entry.
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

// ---------------------------------------------------------------------------
// Override baseline recording
// ---------------------------------------------------------------------------

/**
 * Record the current packaged default for one role and provider as that role's
 * override baseline.
 *
 * Call this after a settings write that **transitions** a role from having no
 * meaningful override to having an active override (first creation, or a
 * remove-then-recreate where packaged defaults may have changed while no override
 * existed).  Do NOT call on every edit of an existing override: rebaselining
 * silently converts an unacknowledged drift into an acknowledged one.
 *
 * Uses the same provider-exact packaged-default resolver as `computeModelEffortDrift`
 * so the baseline is in identical terms to the later drift comparison.  Any
 * mismatch in resolution terms would recreate the class of bug this repair set
 * exists to fix.
 *
 * Rules enforced here:
 * - Defers (no-op) when `provider` is unknown — per ts-7w6o defer semantics.
 * - Merges into existing state; other roles and other providers are preserved.
 * - Best-effort: never throws, so a recording failure never blocks the command path.
 *
 * @param agentName  The role name (primary agent name or subagent name).
 * @param agent      Frontmatter descriptor for the role, used to resolve the
 *                   packaged default.  `undefined` for unknown/unrecognised names
 *                   (resolves to empty defaults, which still suppresses no notice).
 * @param provider   Active provider string.  `undefined` defers the write entirely.
 */
export function recordOverrideBaseline(
  agentName: string,
  agent: AgentPrompt | SubagentMetadata | undefined,
  provider: string | undefined,
): void {
  try {
    if (!isKnownProvider(provider)) {
      // Defer: no baseline is recorded for an unknown or empty-string provider (ts-7w6o).
      return;
    }
    const packaged = resolvePackagedDefaults(agent, provider);
    const ack: ProviderAcknowledgment = {};
    if (packaged.model !== undefined) {
      ack.model = packaged.model;
    }
    if (packaged.thinking !== undefined) {
      ack.thinking = packaged.thinking;
    }
    updateReconcileAcknowledgedSnapshot({
      [agentName]: { byProvider: { [provider]: ack } },
    });
  } catch {
    // Best-effort: never throw into the command path.
  }
}

// ---------------------------------------------------------------------------
// Startup baseline backfill
// ---------------------------------------------------------------------------

/**
 * Startup backfill: silently record the current packaged default as the baseline
 * for any (role, provider) pair that has an active override but no prior baseline.
 *
 * Intended for overrides that were created before baseline recording shipped (e.g.
 * by 0.34.0 /model or /subagent-settings commands). Those overrides have no
 * `byProvider[provider]` entry and therefore can never trigger a drift notice;
 * backfill repairs the journey going forward.
 *
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
 *
 * **Defer rule (ts-7w6o):** When `currentProvider` is unknown, no comparison, no
 * seed, no notice, and nothing is written.
 *
 * @param primaryAgents    Loaded primary-agent map.
 * @param subagentMetadata Loaded subagent metadata array.
 * @param settings         Parsed TLH global settings.
 * @param currentProvider  Active session provider. `undefined` skips all backfill.
 * @param existingSnapshot The currently persisted acknowledged snapshot.
 * @returns The snapshot to use for the current notification pass. Incorporates newly
 *   established baselines in-memory so a role that was just backfilled cannot also
 *   produce a notice in this same pass, even if the disk write failed.
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
      // Defer: no backfill when provider is unknown or empty string (ts-7w6o).
      return snapshot;
    }
    const toBackfill: Record<string, AcknowledgedRoleSnapshot> = {};

    // --- Primary agent overrides ---
    const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
    if (isRecord(primaryModelOverrides)) {
      for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
        if (!isMeaningfulPrimaryOverride(overrideValue)) {
          continue;
        }
        // Skip when a baseline for this provider already exists.
        if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
          continue;
        }
        const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
        const ack: ProviderAcknowledgment = {};
        if (packaged.model !== undefined) {
          ack.model = packaged.model;
        }
        if (packaged.thinking !== undefined) {
          ack.thinking = packaged.thinking;
        }
        toBackfill[name] = { byProvider: { [currentProvider]: ack } };
      }
    }

    // --- Subagent overrides ---
    const subagentOverrides = settings.subagents?.agentOverrides;
    if (isRecord(subagentOverrides)) {
      const subagentMap = new Map(subagentMetadata.map((s) => [s.name, s]));
      for (const [name, rawOverride] of Object.entries(subagentOverrides)) {
        // Use shared predicate that mirrors computeModelEffortDrift's acceptance logic.
        if (!hasMeaningfulSubagentOverride(rawOverride)) {
          continue;
        }
        // Skip when a baseline for this provider already exists.
        if (snapshot[name]?.byProvider?.[currentProvider] !== undefined) {
          continue;
        }
        const packaged = resolvePackagedDefaults(subagentMap.get(name), currentProvider);
        const ack: ProviderAcknowledgment = {};
        if (packaged.model !== undefined) {
          ack.model = packaged.model;
        }
        if (packaged.thinking !== undefined) {
          ack.thinking = packaged.thinking;
        }
        toBackfill[name] = { byProvider: { [currentProvider]: ack } };
      }
    }

    if (Object.keys(toBackfill).length === 0) {
      return snapshot;
    }

    // Persist best-effort; failure is non-blocking.
    updateReconcileAcknowledgedSnapshot(toBackfill);

    // Build merged in-memory snapshot for this notification pass, regardless of
    // whether the disk write succeeded, so backfilled roles cannot produce a notice.
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
    // Best-effort: never throw into launch.
    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// Drift computation — main export
// ---------------------------------------------------------------------------

/**
 * Compute the list of overridden roles that deviate from packaged defaults.
 *
 * Returns one entry per role that has an active user override (model or thinking),
 * reporting the override value(s), the current packaged defaults, and whether the
 * packaged defaults have changed since the user last acknowledged them.
 *
 * @param primaryAgents     Map of primary agent name → AgentPrompt loaded from agents/primary/
 * @param subagentMetadata  SubagentMetadata array loaded from agents/subagents/
 * @param settings          Parsed TLH global settings
 * @param currentProvider   Active provider string (e.g. "anthropic", "openai-codex"), for provider-aware resolution
 * @param acknowledgedSnapshot  Previously acknowledged packaged defaults, keyed by agent name
 */
export function computeModelEffortDrift(
  primaryAgents: ReadonlyMap<string, AgentPrompt>,
  subagentMetadata: readonly SubagentMetadata[],
  settings: TlhSettings,
  currentProvider?: string,
  acknowledgedSnapshot?: Record<string, AcknowledgedRoleSnapshot>,
): RoleDriftEntry[] {
  const drift: RoleDriftEntry[] = [];

  // --- Primary agent overrides: settings.tlh.primaryAgent.modelOverrides ---
  const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
  if (isRecord(primaryModelOverrides)) {
    for (const [name, overrideValue] of Object.entries(primaryModelOverrides)) {
      if (!isMeaningfulPrimaryOverride(overrideValue)) {
        continue;
      }
      const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
      // When provider is unknown or empty, skip comparison — defer semantics (ts-7w6o).
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

  // --- Subagent overrides: settings.subagents.agentOverrides ---
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
      // Skip entries with no meaningful validated override.
      if (model === undefined && thinking === undefined) {
        continue;
      }
      const packaged = resolvePackagedDefaults(subagentMap.get(name), currentProvider);
      // When provider is unknown or empty, skip comparison — defer semantics (ts-7w6o).
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
