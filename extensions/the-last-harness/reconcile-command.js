import { SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord } from "./common.js";
import { computeModelEffortDrift, readReconcileState, updateReconcileAcknowledgedSnapshot, } from "./model-effort-reconcile.js";
import { clearPrimaryAgentModelOverrideByName } from "./primary-agent-runtime.js";
import { tlhSettingsPathForWrite } from "./profile-state.js";
import { loadPrimaryAgents, loadSubagentMetadata } from "./prompts.js";
import { resetSubagentOverride } from "./subagent-settings.js";
const RECONCILE_COMMAND = "reconcile";
const RECONCILE_COMMAND_DESCRIPTION = "Review and resolve model/effort override drift from TLH packaged defaults";
function getTlhGlobalSettings(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return isRecord(settings) ? settings : {};
    }
    catch {
        return {};
    }
}
function computeDrift(cwd, provider) {
    const primaryAgents = loadPrimaryAgents();
    const subagentMetadata = loadSubagentMetadata();
    const settings = getTlhGlobalSettings(cwd);
    const reconcileState = readReconcileState();
    return computeModelEffortDrift(primaryAgents, subagentMetadata, settings, provider, reconcileState.acknowledgedSnapshot);
}
function formatOverrideDisplay(override) {
    const parts = [];
    if (override.model !== undefined) {
        parts.push(`model: ${override.model === false ? "disabled" : override.model}`);
    }
    if (override.thinking !== undefined) {
        parts.push(`effort: ${override.thinking === false ? "off" : override.thinking}`);
    }
    return parts.join(", ") || "(none)";
}
function formatPackagedDisplay(packaged) {
    const parts = [];
    if (packaged.model) {
        parts.push(`model: ${packaged.model}`);
    }
    if (packaged.thinking) {
        parts.push(`effort: ${packaged.thinking}`);
    }
    return parts.join(", ") || "(unset)";
}
function driftPickerLabel(entry) {
    return `${entry.name} [${entry.role}] — yours: ${formatOverrideDisplay(entry.override)} → TLH default: ${formatPackagedDisplay(entry.packaged)}`;
}
function formatDriftStatus(drift) {
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
function buildAcknowledgedSnapshot(entries, provider) {
    return Object.fromEntries(entries.map((entry) => [
        entry.name,
        { byProvider: { [provider]: { model: entry.packaged.model, thinking: entry.packaged.thinking } } },
    ]));
}
function buildSingleAcknowledgedSnapshot(entry, provider) {
    return {
        [entry.name]: {
            byProvider: { [provider]: { model: entry.packaged.model, thinking: entry.packaged.thinking } },
        },
    };
}
function notifyResetResult(ctx, result, agentName) {
    const label = result.changed ? "Reset override for" : "No change for";
    const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
    ctx.ui.notify(`TLH reconcile: ${label} ${agentName} in settings at ${formatHomePath(result.settingsPath)}.${backupLabel}`, "info");
}
function unrecognizedPrimaryOverrideMessage(agentName) {
    const settingsPath = tlhSettingsPathForWrite();
    const location = settingsPath ? ` in ${formatHomePath(settingsPath)}` : "";
    return `TLH reconcile: "${agentName}" is not a recognised TLH primary agent, so its override cannot be reset automatically. Remove it by hand from settings.tlh.primaryAgent.modelOverrides${location}.`;
}
function notifyUnrecognizedPrimaryOverride(ctx, agentName) {
    ctx.ui.notify(unrecognizedPrimaryOverrideMessage(agentName), "error");
}
async function clearOverride(ctx, entry, runtime) {
    if (entry.role === "subagent") {
        return { status: "cleared", result: resetSubagentOverride(ctx.cwd, entry.name) };
    }
    if (runtime) {
        const result = await runtime.resetPrimaryAgentModelOverride(ctx, entry.name);
        return result ? { status: "cleared", result } : { status: "unrecognized" };
    }
    const result = clearPrimaryAgentModelOverrideByName(ctx.cwd, entry.name);
    return result ? { status: "cleared", result } : { status: "unrecognized" };
}
async function runReconcilePicker(ctx, provider, runtime) {
    const drift = computeDrift(ctx.cwd, provider);
    if (drift.length === 0) {
        ctx.ui.notify("TLH reconcile: No overrides found. All roles are using TLH packaged defaults (or have no overrides).", "info");
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
        if (!provider) {
            ctx.ui.notify("TLH reconcile: Cannot acknowledge — no provider is known for this session. Run /reconcile when a provider is active.", "warning");
            return;
        }
        const snapshot = buildAcknowledgedSnapshot(drift, provider);
        const acknowledged = updateReconcileAcknowledgedSnapshot(snapshot, new Date().toISOString());
        if (!acknowledged) {
            ctx.ui.notify(`TLH reconcile: Failed to persist acknowledgment. The notice may reappear on the next launch.`, "error");
            return;
        }
        ctx.ui.notify(`TLH reconcile: Acknowledged current TLH packaged defaults for ${drift.length} role(s). Overrides preserved.`, "info");
        return;
    }
    if (selected === RESET_ALL_OPTION) {
        const clearedEntries = [];
        const unrecognizedNames = [];
        const failedNames = [];
        let changedCount = 0;
        let unchangedCount = 0;
        for (const entry of drift) {
            let outcome;
            try {
                outcome = await clearOverride(ctx, entry, runtime);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                failedNames.push(entry.name);
                ctx.ui.notify(`TLH reconcile: Failed to clear override for ${entry.name}: ${message}`, "error");
                continue;
            }
            if (outcome.status === "unrecognized") {
                unrecognizedNames.push(entry.name);
                continue;
            }
            clearedEntries.push(entry);
            if (outcome.result.changed) {
                changedCount += 1;
            }
            else {
                unchangedCount += 1;
            }
            notifyResetResult(ctx, outcome.result, entry.name);
        }
        for (const name of unrecognizedNames) {
            notifyUnrecognizedPrimaryOverride(ctx, name);
        }
        let acknowledgmentFailed = false;
        if (clearedEntries.length > 0 && provider) {
            const acknowledged = updateReconcileAcknowledgedSnapshot(buildAcknowledgedSnapshot(clearedEntries, provider), new Date().toISOString());
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
        if (failedNames.length > 0) {
            summaryParts.push(`${failedNames.length} failed to clear.`);
        }
        if (changedCount > 0) {
            summaryParts.push("Reset roles now resolve to TLH packaged defaults.");
        }
        if (acknowledgmentFailed) {
            summaryParts.push("Acknowledgment could not be persisted; the notice may reappear.");
        }
        ctx.ui.notify(`TLH reconcile: ${summaryParts.join(" ")}`, unrecognizedNames.length > 0 || acknowledgmentFailed || failedNames.length > 0 ? "error" : "info");
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
        if (!provider) {
            ctx.ui.notify(`TLH reconcile: Cannot acknowledge ${entry.name} — no provider is known for this session. Run /reconcile when a provider is active.`, "warning");
            return;
        }
        const snapshot = buildSingleAcknowledgedSnapshot(entry, provider);
        const acknowledged = updateReconcileAcknowledgedSnapshot(snapshot, new Date().toISOString());
        if (!acknowledged) {
            ctx.ui.notify(`TLH reconcile: Failed to persist acknowledgment for ${entry.name}. The notice may reappear on the next launch.`, "error");
            return;
        }
        ctx.ui.notify(`TLH reconcile: Acknowledged TLH packaged default for ${entry.name}. Override preserved.`, "info");
        return;
    }
    if (action === RESET_OPTION) {
        const outcome = await clearOverride(ctx, entry, runtime);
        if (outcome.status === "unrecognized") {
            notifyUnrecognizedPrimaryOverride(ctx, entry.name);
            return;
        }
        notifyResetResult(ctx, outcome.result, entry.name);
        if (provider) {
            const acknowledged = updateReconcileAcknowledgedSnapshot(buildSingleAcknowledgedSnapshot(entry, provider), new Date().toISOString());
            if (!acknowledged) {
                ctx.ui.notify(`TLH reconcile: Failed to persist acknowledgment for ${entry.name}. The notice may reappear on the next launch.`, "error");
            }
        }
    }
}
export function registerReconcileCommand(pi, runtime) {
    pi.registerCommand(RECONCILE_COMMAND, {
        description: RECONCILE_COMMAND_DESCRIPTION,
        handler: async (_args, ctx) => {
            const provider = ctx.model?.provider;
            if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.select !== "function") {
                if (!provider) {
                    ctx.ui.notify("TLH reconcile: No provider is known for this session — packaged defaults cannot be provider-resolved yet. Your overrides are preserved. Run /reconcile when a provider is active.", "info");
                    return;
                }
                const drift = computeDrift(ctx.cwd, provider);
                ctx.ui.notify(formatDriftStatus(drift), "info");
                return;
            }
            try {
                await runReconcilePicker(ctx, provider, runtime);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(message, "error");
            }
        },
    });
}
