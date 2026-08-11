// Startup notice for model/effort override drift from TLH packaged defaults.
// Fires at most once per launch when packaged defaults changed for an overridden role.
// Display alone must NOT acknowledge the snapshot; that is /reconcile's job.
import { SettingsManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isRecord } from "./common.js";
import { computeModelEffortDrift, readReconcileState } from "./model-effort-reconcile.js";
import { loadPrimaryAgents, loadSubagentMetadata } from "./prompts.js";
import type { TlhSettings } from "./types.js";

// ---------------------------------------------------------------------------
// Internal state (in-process dedupe)
// ---------------------------------------------------------------------------

let notifiedThisProcess = false;

// ---------------------------------------------------------------------------
// Settings helper
// ---------------------------------------------------------------------------

function getTlhGlobalSettings(cwd: string): TlhSettings {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as unknown;
		return isRecord(settings) ? (settings as TlhSettings) : {};
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Cheap override existence check
// ---------------------------------------------------------------------------

/**
 * True when settings contain at least one override that `computeModelEffortDrift`
 * would turn into a drift entry.
 *
 * This deliberately mirrors that function's per-entry acceptance predicates. When
 * neither pool has an accepted entry it returns an empty list regardless of the
 * packaged agent maps, so the launch path can skip loading them entirely. Keeping
 * the predicates in sync matters: a stricter check here would silently suppress a
 * real notice. A looser one only costs an avoidable load, so err loose if unsure.
 *
 * Settings-only, no filesystem reads beyond the already-read settings object.
 */
export function hasAnyModelEffortOverride(settings: TlhSettings): boolean {
	const primaryModelOverrides = settings.tlh?.primaryAgent?.modelOverrides;
	if (isRecord(primaryModelOverrides)) {
		for (const overrideValue of Object.values(primaryModelOverrides)) {
			if (typeof overrideValue === "string" && overrideValue) {
				return true;
			}
		}
	}

	const subagentOverrides = settings.subagents?.agentOverrides;
	if (isRecord(subagentOverrides)) {
		for (const rawOverride of Object.values(subagentOverrides)) {
			if (!isRecord(rawOverride)) {
				continue;
			}
			// Mirror computeModelEffortDrift's per-entry acceptance predicate:
			// model and thinking must be string, false, or undefined to count as
			// a meaningful override. Other types (null, number, object, …) are
			// treated as absent so this predicate stays in sync with drift output.
			const rawModel = rawOverride.model;
			const rawThinking = rawOverride.thinking;
			const hasModel = typeof rawModel === "string" || rawModel === false;
			const hasThinking = typeof rawThinking === "string" || rawThinking === false;
			if (hasModel || hasThinking) {
				return true;
			}
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Gating logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns the roles that have packagedDefaultsChanged === true.
 * Only these trigger the startup notice.
 */
export function getChangedOverriddenRoles(
	primaryAgents: Parameters<typeof computeModelEffortDrift>[0],
	subagentMetadata: Parameters<typeof computeModelEffortDrift>[1],
	settings: TlhSettings,
	provider: string | undefined,
	acknowledgedSnapshot: Record<string, import("./model-effort-reconcile.js").AcknowledgedRoleSnapshot> | undefined,
): string[] {
	const drift = computeModelEffortDrift(primaryAgents, subagentMetadata, settings, provider, acknowledgedSnapshot);
	return drift.filter((entry) => entry.packagedDefaultsChanged).map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// Notice message builder (exported for tests)
// ---------------------------------------------------------------------------

export function buildModelEffortNoticeMessage(roleNames: readonly string[]): string {
	const roles = roleNames.join(", ");
	return `TLH default model/effort changed for ${roles} — run /reconcile to review`;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

type ModelEffortNoticeTestHooks = {
	shouldSkip?: () => boolean;
	/** Injectable so tests can assert the zero-override path never loads packaged agents. */
	loadPrimaryAgents?: typeof loadPrimaryAgents;
	loadSubagentMetadata?: typeof loadSubagentMetadata;
};

const defaultHooks: Required<ModelEffortNoticeTestHooks> = {
	shouldSkip: () => false,
	loadPrimaryAgents,
	loadSubagentMetadata,
};

let hooks: Required<ModelEffortNoticeTestHooks> = defaultHooks;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Non-blocking startup notice: if packaged model/effort defaults changed for any
 * overridden role since the user last acknowledged them via /reconcile, show a
 * one-line prompt at most once per process lifetime.
 *
 * Displaying this notice does NOT update the acknowledged snapshot — that is
 * exclusively /reconcile's job. An ignored notice reappears on the next launch.
 *
 * Launch-path cost is ordered cheapest-first: UI/dedupe flags, then settings, then
 * an override existence check. Packaged agent prompts are only read when at least
 * one override exists, so the common no-override install does no agent-file I/O.
 */
export function maybeNotifyModelEffortDrift(ctx: ExtensionContext): void {
	try {
		if (!ctx.hasUI || hooks.shouldSkip()) {
			return;
		}
		if (notifiedThisProcess) {
			return;
		}

		const settings = getTlhGlobalSettings(ctx.cwd);
		// Nothing overridden means no drift entries are possible, so avoid the
		// recursive markdown read + frontmatter parse of the packaged agent set.
		if (!hasAnyModelEffortOverride(settings)) {
			return;
		}

		const reconcileState = readReconcileState();
		const primaryAgents = hooks.loadPrimaryAgents();
		const subagentMetadata = hooks.loadSubagentMetadata();

		const changedRoles = getChangedOverriddenRoles(
			primaryAgents,
			subagentMetadata,
			settings,
			ctx.model?.provider,
			reconcileState.acknowledgedSnapshot,
		);

		if (changedRoles.length === 0) {
			return;
		}

		notifiedThisProcess = true;
		ctx.ui.notify(buildModelEffortNoticeMessage(changedRoles), "warning");
	} catch {
		// Best-effort only; never block or throw into launch.
	}
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

export function __setModelEffortNoticeTestHooks(overrides: ModelEffortNoticeTestHooks = {}): void {
	hooks = { ...defaultHooks, ...overrides };
}

export function __resetModelEffortNoticeForTests(): void {
	hooks = defaultHooks;
	notifiedThisProcess = false;
}
