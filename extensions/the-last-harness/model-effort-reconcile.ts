// Model/effort drift detection and reconcile state for primary agents and subagents.
// Logic + state only — no UI, no commands, no startup notices.
import { isRecord, readText } from "./common.js";
import {
	formatProviderModelReference,
	parseProviderModelReference,
	selectProviderAwareAgentDefaults,
	splitKnownThinkingSuffix,
	type ProviderModelReference,
} from "./model-defaults.js";
import { tlhStatePath, writeGuardedTlhStateFile } from "./profile-state.js";
import type { AgentPrompt, SubagentMetadata, ThinkingLevel, TlhSettings } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Packaged defaults recorded for one (role, provider) pair at acknowledge time. */
export type ProviderAcknowledgment = {
	/** Packaged model at acknowledge time (base model without thinking suffix). */
	model?: string;
	/** Packaged thinking level at acknowledge time. */
	thinking?: string;
};

/**
 * Per-role snapshot stored when the user acknowledges a reconcile prompt.
 *
 * Provider-keyed: `byProvider[provider]` holds the packaged defaults that were
 * current when the user acknowledged under that provider.  Switching providers
 * will not trigger a false "packaged default changed" notice; only a genuine TLH
 * update to the active provider's packaged default fires the notice.
 *
 * `model` and `thinking` at the top level are legacy flat fields written by
 * earlier TLH releases (before provider-keyed acknowledgments).  They are
 * preserved in the type so old state files parse without error, but new code
 * reads `byProvider` only and never writes the flat fields.
 */
export type AcknowledgedRoleSnapshot = {
	/**
	 * Keyed by provider string (or `""` when the session provider is unknown).
	 * Populated by /reconcile; read by drift detection to scope comparisons to the
	 * active session provider.
	 */
	byProvider?: Record<string, ProviderAcknowledgment>;
	/** @deprecated Legacy flat field — present in pre-provider-keyed state files only. */
	model?: string;
	/** @deprecated Legacy flat field — present in pre-provider-keyed state files only. */
	thinking?: string;
};

/** Persisted reconcile state under tlh/reconcile-state.json. */
export type ReconcileState = {
	/**
	 * Keyed by agent name (primary and subagent names live in separate pools and
	 * do not overlap in the bundled catalog).
	 */
	acknowledgedSnapshot?: Record<string, AcknowledgedRoleSnapshot>;
	/** ISO timestamp of the last user decision, for diagnostics only. */
	lastDecisionAt?: string;
};

/** Provider-resolved packaged defaults for a single role. */
export type PackagedRoleDefaults = {
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
			// No byProvider field — pass through as-is (legacy flat shape or empty entry).
			result[name] = entry as AcknowledgedRoleSnapshot;
			continue;
		}
		if (!isRecord(rawByProvider)) {
			// byProvider exists but is not a record — strip it, preserve other fields.
			const { byProvider: _, ...rest } = entry;
			result[name] = rest as AcknowledgedRoleSnapshot;
			continue;
		}
		// Sanitize each provider entry: drop non-records and strip consumed fields
		// whose values are not the expected types.
		const sanitizedByProvider: Record<string, ProviderAcknowledgment> = {};
		for (const [provider, ack] of Object.entries(rawByProvider)) {
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
		return writeGuardedTlhStateFile(statePath, `${JSON.stringify(state, null, 2)}\n`, tlhReconcileStatePath);
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
	const merged: Record<string, AcknowledgedRoleSnapshot> = { ...(current.acknowledgedSnapshot ?? {}) };
	for (const [name, incoming] of Object.entries(snapshot)) {
		const existing = merged[name];
		if (existing != null && incoming.byProvider != null) {
			// Deep-merge byProvider so a new-provider acknowledgment does not erase
			// previous ones recorded under other providers.
			merged[name] = {
				...existing,
				byProvider: { ...(existing.byProvider ?? {}), ...incoming.byProvider },
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

/** Frontmatter fields that declare an agent's packaged model catalog. */
type PackagedAgent = Pick<AgentPrompt, "name" | "model" | "tlhOpenaiModels" | "tlhAnthropicModels"> &
	Partial<Pick<AgentPrompt, "thinking" | "tlhOpenaiThinking" | "tlhAnthropicThinking" | "preferOppositeProvider">> &
	Partial<Pick<AgentPrompt, "preferCurrentOpenaiModel">>;

/**
 * Every model the agent's frontmatter declares, parsed and de-duplicated.
 *
 * This synthesises the "registry" handed to `selectProviderAwareAgentDefaults`,
 * i.e. it answers the packaged question "what would TLH pick if every model this
 * agent ships with were available?". Deliberately independent of the user's real
 * model registry — see the note on `resolvePackagedDefaults`.
 */
function packagedCandidateModels(agent: PackagedAgent): ProviderModelReference[] {
	const seen = new Map<string, ProviderModelReference>();
	for (const raw of [agent.model, ...(agent.tlhOpenaiModels ?? []), ...(agent.tlhAnthropicModels ?? [])]) {
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
 * Resolve the packaged model + effort defaults for one role.
 *
 * Delegates to the production selector `selectProviderAwareAgentDefaults` so this
 * module can never disagree with what TLH actually applies at dispatch time. That
 * matters because `/reconcile` shows this value as "the default" and a Reset moves
 * the user onto it: a private re-implementation that missed `preferOppositeProvider`
 * (code-reviewer, contrarian, oracle) or `preferCurrentOpenaiModel` (rush) would
 * report — and reset to — the wrong model.
 *
 * Availability semantics: the candidate registry is the agent's own packaged model
 * catalog, not the user's live model registry. "Packaged default" therefore means
 * "what this TLH release declares", independent of the user's environment. This is
 * required by the ticket's trigger model: drift must fire only when packaged
 * defaults change, never when the user's model availability changes. The tradeoff
 * is that the reported default can name a model the user cannot currently reach;
 * presenting that is ts-tr52's job.
 */
function resolvePackagedDefaults(agent: PackagedAgent | undefined, provider: string | undefined): PackagedRoleDefaults {
	if (!agent) {
		return {};
	}
	const defaults = selectProviderAwareAgentDefaults(agent, packagedCandidateModels(agent), provider);
	return {
		model: defaults.model ? formatProviderModelReference(defaults.model) : undefined,
		thinking: defaults.thinking,
	};
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
			if (typeof overrideValue !== "string" || !overrideValue) {
				continue;
			}
			const packaged = resolvePackagedDefaults(primaryAgents.get(name), currentProvider);
			const providerKey = currentProvider ?? "";
			const providerEntry = acknowledgedSnapshot?.[name]?.byProvider?.[providerKey];
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
			const providerKey = currentProvider ?? "";
			const providerEntry = acknowledgedSnapshot?.[name]?.byProvider?.[providerKey];
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
