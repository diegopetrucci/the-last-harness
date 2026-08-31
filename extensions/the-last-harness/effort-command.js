import { ThinkingSelectorComponent, } from "@earendil-works/pi-coding-agent";
import { formatHomePath, isRecord, readText } from "./common.js";
import { safeTlhProfileFilePath, withLockedTlhSettingsWrite } from "./profile-state.js";
import { getAvailableThinkingLevels, isThinkingLevel, setExtensionThinkingLevel, } from "./thinking.js";
function parseSettingsObject(content) {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!isRecord(parsed)) {
        throw new Error("settings.json must contain a JSON object");
    }
    return parsed;
}
function readTlhThinkingDefault() {
    const settingsPath = safeTlhProfileFilePath("settings.json");
    const content = settingsPath ? readText(settingsPath) : undefined;
    if (!content || !content.trim()) {
        return undefined;
    }
    try {
        const settings = parseSettingsObject(content);
        const level = settings.defaultThinkingLevel;
        return typeof level === "string" && isThinkingLevel(level) ? level : undefined;
    }
    catch {
        return undefined;
    }
}
export function persistTlhThinkingDefault(cwd, level) {
    return withLockedTlhSettingsWrite(cwd, "Refusing to write thinking defaults outside the isolated TLH profile.", (current) => {
        const settings = current && current.trim() ? parseSettingsObject(current) : {};
        if (settings.defaultThinkingLevel === level) {
            return { changed: false };
        }
        return {
            changed: true,
            nextContent: `${JSON.stringify({ ...settings, defaultThinkingLevel: level }, null, 2)}\n`,
        };
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function formatBackupNotice(result) {
    return result.backupPath ? ` Backup: ${formatHomePath(result.backupPath)}.` : "";
}
export async function handleThinkingLevelCommand(pi, args, ctx, runtime) {
    const currentLevel = pi.getThinkingLevel();
    const availableLevels = getAvailableThinkingLevels(ctx.model);
    const requestedLevel = args.trim().toLowerCase();
    if (requestedLevel) {
        if (!isThinkingLevel(requestedLevel)) {
            ctx.ui.notify(`Unknown thinking level "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
            return;
        }
        if (!availableLevels.includes(requestedLevel)) {
            ctx.ui.notify(`Thinking level "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`, "warning");
            return;
        }
        setExtensionThinkingLevel(pi, requestedLevel);
        runtime?.recordUserThinkingLevel?.(pi.getThinkingLevel());
        ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()} for this session.`, "info");
        return;
    }
    const pickerLevels = availableLevels;
    if (pickerLevels.length === 0) {
        ctx.ui.notify("No thinking levels are available for the current model.", "warning");
        return;
    }
    if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify(`Available thinking levels: ${pickerLevels.join(", ")}. Current: ${currentLevel}.`, "info");
        return;
    }
    try {
        await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
            let savingDefault = false;
            const selectForSession = (level) => {
                try {
                    setExtensionThinkingLevel(pi, level);
                    const nextLevel = pi.getThinkingLevel();
                    runtime?.recordUserThinkingLevel?.(nextLevel);
                    ctx.ui.notify(`Thinking level set to ${nextLevel} for this session.`, "info");
                    done({ level: nextLevel, persisted: false });
                }
                catch (error) {
                    ctx.ui.notify(`Could not set thinking level: ${errorMessage(error)}`, "error");
                    done(undefined);
                }
            };
            const selectAsDefault = (level) => {
                if (savingDefault) {
                    return;
                }
                savingDefault = true;
                let nextLevel;
                try {
                    setExtensionThinkingLevel(pi, level);
                    nextLevel = pi.getThinkingLevel();
                    runtime?.recordUserThinkingLevel?.(nextLevel);
                }
                catch (error) {
                    ctx.ui.notify(`Could not set thinking level: ${errorMessage(error)}`, "error");
                    done(undefined);
                    return;
                }
                void (async () => {
                    try {
                        const result = persistTlhThinkingDefault(ctx.cwd, nextLevel);
                        ctx.ui.notify(`Thinking level set to ${nextLevel} and saved as the default for future sessions.${formatBackupNotice(result)}`, "info");
                        done({ level: nextLevel, persisted: true });
                    }
                    catch (error) {
                        ctx.ui.notify(`Thinking level set to ${nextLevel} for this session only; TLH could not save the persistent default: ${errorMessage(error)}`, "warning");
                        done({ level: nextLevel, persisted: false });
                    }
                })();
            };
            return new ThinkingSelectorComponent(currentLevel, pickerLevels, selectForSession, () => done(undefined), selectAsDefault, readTlhThinkingDefault());
        });
    }
    catch (error) {
        ctx.ui.notify(`Could not open thinking level picker: ${errorMessage(error)}`, "error");
    }
}
