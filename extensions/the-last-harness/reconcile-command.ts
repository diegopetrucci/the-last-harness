// /reconcile command: review and resolve model/effort override drift from TLH packaged defaults.
// TUI-only picker; non-TUI invocation prints read-only drift status.
import {
	SettingsManager,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { formatHomePath, isRecord } from "./common.js";
import {
	computeModelEffortDrift,
	readReconcileState,
	updateReconcileAcknowledgedSnapshot,
	type AcknowledgedRoleSnapshot,
	type RoleDriftEntry,
} from "./model-effort-reconcile.js";
import { clearPrimaryAgentModelOverrideByName, type TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import { tlhSettingsPathForWrite } from "./profile-state.js";
import { loadPrimaryAgents, loadSubagentMetadata } from "./prompts.js";
import { resetSubagentOverride } from "./subagent-settings.js";
import type { TlhSettings } from "./types.js";

const RECONCILE_COMMAND = "reconcile";
const RECONCILE_COMMAND_DESCRIPTION = "Review and resolve model/effort override drift from TLH packaged defaults";

// ---------------------------------------------------------------------------
// Settings helpers
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
// Drift computation
// ---------------------------------------------------------------------------

function computeDrift(cwd: string, provider: string | undefined): RoleDriftEntry[] {
	const primaryAgents = loadPrimaryAgents();
	const subagentMetadata = loadSubagentMetadata();
	const settings = getTlhGlobalSettings(cwd);
	const reconcileState = readReconcileState();
	return computeModelEffortDrift(
		primaryAgents,
		subagentMetadata,
		settings,
		provider,
		reconcileState.acknowledgedSnapshot,
	);
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

function formatOverrideDisplay(override: RoleDriftEntry["override"]): string {
	const parts: string[] = [];
	if (override.model !== undefined) {
		parts.push(`model: ${override.model === false ? "disabled" : override.model}`);
	}
	if (override.thinking !== undefined) {
		parts.push(`effort: ${override.thinking === false ? "off" : override.thinking}`);
	}
	return parts.join(", ") || "(none)";
}

function formatPackagedDisplay(packaged: RoleDriftEntry["packaged"]): string {
	const parts: string[] = [];
	if (packaged.model) {
		parts.push(`model: ${packaged.model}`);
	}
	if (packaged.thinking) {
		parts.push(`effort: ${packaged.thinking}`);
	}
	return parts.join(", ") || "(unset)";
}

/**
 * Format a drift entry as a picker option label.
 * Note: `packaged.model` is the TLH-packaged default, resolved environment-independently.
 * It may name a model that is not currently available to the user.
 */
function driftPickerLabel(entry: RoleDriftEntry): string {
	return `${entry.name} [${entry.role}] — yours: ${formatOverrideDisplay(entry.override)} → TLH default: ${formatPackagedDisplay(entry.packaged)}`;
}

function formatDriftStatus(drift: RoleDriftEntry[]): string {
	if (drift.length === 0) {
		return "TLH reconcile: No overrides found. All roles are using TLH packaged defaults (or have no overrides).";
	}
	const lines = [
		"TLH model/effort override status (yours → TLH packaged default):",
		...drift.map((entry) => `  ${driftPickerLabel(entry)}`),
		"",
		"Note: TLH packaged defaults are environment-independent and may name a model you cannot currently reach.",
		"Run /reconcile in TUI mode to keep or reset overrides interactively.",
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Acknowledge snapshot helpers
// ---------------------------------------------------------------------------

function buildAcknowledgedSnapshot(
	entries: RoleDriftEntry[],
	provider: string | undefined,
): Record<string, AcknowledgedRoleSnapshot> {
	const providerKey = provider ?? "";
	return Object.fromEntries(
		entries.map((entry) => [
			entry.name,
			{ byProvider: { [providerKey]: { model: entry.packaged.model, thinking: entry.packaged.thinking } } },
		]),
	);
}

function buildSingleAcknowledgedSnapshot(
	entry: RoleDriftEntry,
	provider: string | undefined,
): Record<string, AcknowledgedRoleSnapshot> {
	const providerKey = provider ?? "";
	return {
		[entry.name]: {
			byProvider: { [providerKey]: { model: entry.packaged.model, thinking: entry.packaged.thinking } },
		},
	};
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

type WriteResult = { changed: boolean; settingsPath: string; backupPath?: string };

/**
 * Outcome of attempting to clear one role's override.
 *
 * `unrecognized` means no write path owns this name (an unknown primary-agent key
 * from user-edited settings), so the override is still in settings. Only `cleared`
 * outcomes may be acknowledged — acknowledging an `unrecognized` role would suppress
 * future drift reporting for an override that was never actually removed.
 */
type ClearOutcome = { status: "cleared"; result: WriteResult } | { status: "unrecognized" };

function notifyResetResult(ctx: Pick<ExtensionCommandContext, "ui">, result: WriteResult, agentName: string): void {
	const label = result.changed ? "Reset override for" : "No change for";
	const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
	ctx.ui.notify(
		`TLH reconcile: ${label} ${agentName} in settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`,
		"info",
	);
}

function unrecognizedPrimaryOverrideMessage(agentName: string): string {
	const settingsPath = tlhSettingsPathForWrite();
	const location = settingsPath ? ` in ${formatHomePath(settingsPath)}` : "";
	return `TLH reconcile: "${agentName}" is not a recognised TLH primary agent, so its override cannot be reset automatically. Remove it by hand from settings.tlh.primaryAgent.modelOverrides${location}.`;
}

function notifyUnrecognizedPrimaryOverride(ctx: Pick<ExtensionCommandContext, "ui">, agentName: string): void {
	ctx.ui.notify(unrecognizedPrimaryOverrideMessage(agentName), "error");
}

async function clearOverride(
	ctx: ExtensionCommandContext,
	entry: RoleDriftEntry,
	runtime: TlhPrimaryAgentRuntime | undefined,
): Promise<ClearOutcome> {
	if (entry.role === "subagent") {
		return { status: "cleared", result: resetSubagentOverride(ctx.cwd, entry.name) };
	}
	// Route primary-agent Reset through the runtime so the packaged default is
	// reapplied to the active session, matching /switch-primary-agent model reset
	// behaviour. Fall back to settings-only clear when runtime is unavailable.
	if (runtime) {
		const result = await runtime.resetPrimaryAgentModelOverride(ctx, entry.name);
		return result ? { status: "cleared", result } : { status: "unrecognized" };
	}
	const result = clearPrimaryAgentModelOverrideByName(ctx.cwd, entry.name);
	return result ? { status: "cleared", result } : { status: "unrecognized" };
}

// ---------------------------------------------------------------------------
// TUI picker
// ---------------------------------------------------------------------------

async function runReconcilePicker(
	ctx: ExtensionCommandContext,
	runtime: TlhPrimaryAgentRuntime | undefined,
): Promise<void> {
	const drift = computeDrift(ctx.cwd, ctx.model?.provider);

	if (drift.length === 0) {
		ctx.ui.notify(
			"TLH reconcile: No overrides found. All roles are using TLH packaged defaults (or have no overrides).",
			"info",
		);
		return;
	}

	const KEEP_ALL_OPTION = "Keep all — acknowledge TLH defaults, keep my overrides";
	const RESET_ALL_OPTION = "Reset all — clear all overrides, use TLH packaged defaults";

	const roleOptions = drift.map((entry) => driftPickerLabel(entry));
	const driftByLabel = new Map(drift.map((entry) => [driftPickerLabel(entry), entry]));
	const allOptions = [...roleOptions, KEEP_ALL_OPTION, RESET_ALL_OPTION];

	const selected = await ctx.ui.select("TLH reconcile: model/effort overrides", allOptions);
	if (!selected) {
		return;
	}

	if (selected === KEEP_ALL_OPTION) {
		const snapshot = buildAcknowledgedSnapshot(drift, ctx.model?.provider);
		const acknowledged = updateReconcileAcknowledgedSnapshot(snapshot, new Date().toISOString());
		if (!acknowledged) {
			ctx.ui.notify(
				`TLH reconcile: Failed to persist acknowledgment. The notice may reappear on the next launch.`,
				"error",
			);
			return;
		}
		ctx.ui.notify(
			`TLH reconcile: Acknowledged current TLH packaged defaults for ${drift.length} role(s). Overrides preserved.`,
			"info",
		);
		return;
	}

	if (selected === RESET_ALL_OPTION) {
		// Acknowledge only what the write path actually owns. `changed: false` still counts
		// as cleared: the underlying writers report it when the override key is already
		// absent, so nothing is left behind. `unrecognized` roles are excluded because
		// their override survives the attempt.
		const clearedEntries: RoleDriftEntry[] = [];
		const unrecognizedNames: string[] = [];
		let changedCount = 0;
		let unchangedCount = 0;

		for (const entry of drift) {
			const outcome = await clearOverride(ctx, entry, runtime);
			if (outcome.status === "unrecognized") {
				unrecognizedNames.push(entry.name);
				continue;
			}
			clearedEntries.push(entry);
			if (outcome.result.changed) {
				changedCount += 1;
			} else {
				unchangedCount += 1;
			}
			// Each reset is its own locked write with its own backup; surface them all.
			notifyResetResult(ctx, outcome.result, entry.name);
		}

		for (const name of unrecognizedNames) {
			notifyUnrecognizedPrimaryOverride(ctx, name);
		}

		let acknowledgmentFailed = false;
		if (clearedEntries.length > 0) {
			const acknowledged = updateReconcileAcknowledgedSnapshot(
				buildAcknowledgedSnapshot(clearedEntries, ctx.model?.provider),
				new Date().toISOString(),
			);
			if (!acknowledged) {
				acknowledgmentFailed = true;
			}
		}

		const summaryParts = [`Reset ${changedCount} of ${drift.length} role(s).`];
		if (unchangedCount > 0) {
			summaryParts.push(`${unchangedCount} already had no stored override.`);
		}
		if (unrecognizedNames.length > 0) {
			summaryParts.push(`${unrecognizedNames.length} unrecognised and left untouched.`);
		}
		if (changedCount > 0) {
			summaryParts.push("Reset roles now resolve to TLH packaged defaults.");
		}
		if (acknowledgmentFailed) {
			summaryParts.push("Acknowledgment could not be persisted; the notice may reappear.");
		}
		ctx.ui.notify(
			`TLH reconcile: ${summaryParts.join(" ")}`,
			unrecognizedNames.length > 0 || acknowledgmentFailed ? "error" : "info",
		);
		return;
	}

	const entry = driftByLabel.get(selected);
	if (!entry) {
		ctx.ui.notify("Unknown TLH reconcile picker selection.", "error");
		return;
	}

	const KEEP_OPTION = "Keep — acknowledge TLH default, keep my override";
	const RESET_OPTION = "Reset — clear override, use TLH packaged default";

	const action = await ctx.ui.select(`Reconcile ${entry.name}`, [KEEP_OPTION, RESET_OPTION]);
	if (!action) {
		return;
	}

	if (action === KEEP_OPTION) {
		const snapshot = buildSingleAcknowledgedSnapshot(entry, ctx.model?.provider);
		const acknowledged = updateReconcileAcknowledgedSnapshot(snapshot, new Date().toISOString());
		if (!acknowledged) {
			ctx.ui.notify(
				`TLH reconcile: Failed to persist acknowledgment for ${entry.name}. The notice may reappear on the next launch.`,
				"error",
			);
			return;
		}
		ctx.ui.notify(`TLH reconcile: Acknowledged TLH packaged default for ${entry.name}. Override preserved.`, "info");
		return;
	}

	if (action === RESET_OPTION) {
		const outcome = await clearOverride(ctx, entry, runtime);
		if (outcome.status === "unrecognized") {
			// The override survives, so do not acknowledge it: the role must keep being reported.
			notifyUnrecognizedPrimaryOverride(ctx, entry.name);
			return;
		}
		notifyResetResult(ctx, outcome.result, entry.name);
		const acknowledged = updateReconcileAcknowledgedSnapshot(
			buildSingleAcknowledgedSnapshot(entry, ctx.model?.provider),
			new Date().toISOString(),
		);
		if (!acknowledged) {
			ctx.ui.notify(
				`TLH reconcile: Failed to persist acknowledgment for ${entry.name}. The notice may reappear on the next launch.`,
				"error",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReconcileCommand(pi: ExtensionAPI, runtime?: TlhPrimaryAgentRuntime): void {
	pi.registerCommand(RECONCILE_COMMAND, {
		description: RECONCILE_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.select !== "function") {
				const drift = computeDrift(ctx.cwd, ctx.model?.provider);
				ctx.ui.notify(formatDriftStatus(drift), "info");
				return;
			}
			try {
				await runReconcilePicker(ctx, runtime);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});
}
