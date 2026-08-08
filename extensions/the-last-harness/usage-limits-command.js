import { formatHomePath, isRecord } from "./common.js";
import { withLockedTlhSettingsWrite } from "./profile-state.js";
import { getCachedTlhUsageWeeklyVisibility, getPersistedTlhUsageWeeklyVisibility, refreshCachedTlhUsageWeeklyVisibility, setCachedTlhUsageWeeklyVisibility, USAGE_COMMAND_HELP, } from "./usage-limits.js";
function validateTlhUsageLimitsSettings(settings) {
    if (!isRecord(settings)) {
        throw new Error("settings.json must contain a JSON object");
    }
    const tlh = settings.tlh;
    if (tlh !== undefined && !isRecord(tlh)) {
        throw new Error("settings field 'tlh' must be an object if present");
    }
    const usageLimits = isRecord(tlh) ? tlh.usageLimits : undefined;
    if (usageLimits !== undefined && !isRecord(usageLimits)) {
        throw new Error("settings field 'tlh.usageLimits' must be an object if present");
    }
}
function ensureMutableUsageLimitsSettings(settings) {
    validateTlhUsageLimitsSettings(settings);
    settings.tlh ??= {};
    settings.tlh.usageLimits ??= {};
}
function parseTlhSettingsContent(content) {
    if (!content) {
        return {};
    }
    const parsed = JSON.parse(content);
    validateTlhUsageLimitsSettings(parsed);
    return parsed;
}
function writeTlhUsageWeeklyPreference(cwd, showWeekly) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write usage-limit settings outside the isolated TLH profile.", (current) => {
        const settings = parseTlhSettingsContent(current);
        ensureMutableUsageLimitsSettings(settings);
        if (settings.tlh.usageLimits.showWeekly === showWeekly) {
            return { changed: false };
        }
        settings.tlh.usageLimits.showWeekly = showWeekly;
        return {
            changed: true,
            nextContent: `${JSON.stringify(settings, null, 2)}\n`,
        };
    });
}
function parseUsageSlashAction(args) {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return { type: "status" };
    }
    if (parts.length === 1 && parts[0] === "status") {
        return { type: "status" };
    }
    if (parts.length === 2 && parts[0] === "weekly") {
        const action = parts[1];
        if (action === "on" || action === "off" || action === "toggle") {
            return { type: "weekly", action };
        }
    }
    return undefined;
}
function nextWeeklyPreference(current, action) {
    if (action === "on")
        return true;
    if (action === "off")
        return false;
    return !current;
}
function formatUsageWeeklyStatus(showWeekly) {
    if (showWeekly === true) {
        return "TLH usage weekly window is shown. Use /usage weekly off to hide it, or /usage weekly toggle.";
    }
    if (showWeekly === false) {
        return "TLH usage weekly window is hidden. Use /usage weekly on to show it, or /usage weekly toggle.";
    }
    return "TLH usage weekly window follows the default auto mode: it shows only when weekly remaining capacity is below 25%. Use /usage weekly on to always show it, /usage weekly off to always hide it, or /usage weekly toggle.";
}
export async function handleUsageCommand(args, ctx) {
    const command = parseUsageSlashAction(args);
    if (!command) {
        ctx.ui.notify(USAGE_COMMAND_HELP, "error");
        return;
    }
    if (command.type === "status") {
        const currentShowWeekly = refreshCachedTlhUsageWeeklyVisibility(ctx.cwd);
        ctx.ui.notify(formatUsageWeeklyStatus(currentShowWeekly), "info");
        return;
    }
    const currentShowWeekly = command.action === "toggle" ? getPersistedTlhUsageWeeklyVisibility(ctx.cwd) : getCachedTlhUsageWeeklyVisibility();
    const nextShowWeekly = nextWeeklyPreference(currentShowWeekly === true, command.action);
    try {
        const result = writeTlhUsageWeeklyPreference(ctx.cwd, nextShowWeekly);
        setCachedTlhUsageWeeklyVisibility(nextShowWeekly);
        const changedLabel = result.changed ? "Updated" : "No change to";
        const backupLabel = result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
        ctx.ui.notify(`${changedLabel} TLH usage weekly-window preference at ${formatHomePath(result.settingsPath)}. ${formatUsageWeeklyStatus(nextShowWeekly)}${backupLabel}`, "info");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not update TLH usage weekly-window preference: ${message}`, "error");
    }
}
