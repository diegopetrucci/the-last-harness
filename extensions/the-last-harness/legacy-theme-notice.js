import { readTlhStartupState, tlhStartupStatePath, updateTlhStartupState, } from "./profile-state.js";
export const LEGACY_THEME_NAME = "the-last-harness";
export const LEGACY_THEME_NOTICE = "TLH can now follow your terminal's theme colors. To switch: /settings → Theme → system.";
export function maybeNotifyLegacyThemeNotice(ctx, reason) {
    try {
        if (reason !== "startup" ||
            ctx.mode !== "tui" ||
            !ctx.hasUI ||
            process.env.PI_SUBAGENT_CHILD === "1" ||
            !tlhStartupStatePath()) {
            return;
        }
        if (ctx.ui.theme?.name !== LEGACY_THEME_NAME) {
            return;
        }
        if (readTlhStartupState().legacyThemeNoticeDisplayed === true) {
            return;
        }
        ctx.ui.notify(LEGACY_THEME_NOTICE, "info");
        updateTlhStartupState({ legacyThemeNoticeDisplayed: true });
    }
    catch {
    }
}
