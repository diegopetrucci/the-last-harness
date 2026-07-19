import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { resolveTlhCommitAttribution } from "./attribution.js";
const TOGGLE_TLH_GIT_ATTRIBUTION_COMMAND_HELP = "Usage: /toggle-tlh-git-attribution";
function validateTlhAttributionSettings(settings) {
    if (!isRecord(settings)) {
        throw new Error("settings.json must contain a JSON object");
    }
    const tlh = settings.tlh;
    if (tlh !== undefined && !isRecord(tlh)) {
        throw new Error("settings field 'tlh' must be an object if present");
    }
    const attribution = isRecord(tlh) ? tlh.attribution : undefined;
    if (attribution !== undefined && !isRecord(attribution)) {
        throw new Error("settings field 'tlh.attribution' must be an object if present");
    }
    const commit = isRecord(attribution) ? attribution.commit : undefined;
    if (commit !== undefined && typeof commit !== "boolean") {
        throw new Error("settings field 'tlh.attribution.commit' must be a boolean if present");
    }
}
function parseTlhSettingsContent(content) {
    if (!content) {
        return {};
    }
    const parsed = JSON.parse(content);
    validateTlhAttributionSettings(parsed);
    return parsed;
}
function ensureMutableAttributionSettings(settings) {
    validateTlhAttributionSettings(settings);
    settings.tlh ??= {};
    settings.tlh.attribution ??= {};
}
function toggleTlhCommitAttribution(cwd) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write attribution settings outside the isolated TLH profile.", (current) => {
        const settings = parseTlhSettingsContent(current);
        const currentState = resolveTlhCommitAttribution(settings.tlh?.attribution);
        const nextEnabled = !currentState.enabled;
        ensureMutableAttributionSettings(settings);
        settings.tlh.attribution = { commit: nextEnabled };
        return {
            changed: true,
            state: resolveTlhCommitAttribution(settings.tlh.attribution),
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function formatCommitAttributionStatus(state) {
    return state.enabled ? "TLH commit attribution is enabled." : "TLH commit attribution is disabled.";
}
export async function handleToggleTlhGitAttributionCommand(_pi, args, ctx) {
    if (args.trim()) {
        ctx.ui.notify(TOGGLE_TLH_GIT_ATTRIBUTION_COMMAND_HELP, "error");
        return;
    }
    try {
        const result = toggleTlhCommitAttribution(ctx.cwd);
        const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
        ctx.ui.notify(`Updated TLH commit attribution at ${formatHomePath(result.settingsPath)}. ${formatCommitAttributionStatus(result.state)}${backupLabel}`, "info");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not update TLH commit attribution: ${message}`, "error");
    }
}
