import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  readTlhStartupState,
  tlhStartupStatePath,
  updateTlhStartupState,
} from "./profile-state.js";

export const LEGACY_THEME_NAME = "the-last-harness";
export const LEGACY_THEME_NOTICE =
  "TLH can now follow your terminal's theme colors. To switch: /settings → Theme → system.";

type TlhSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * Show the one-off migration guidance for the old TLH theme without changing
 * the user's selected theme. The marker is deliberately written only after
 * notify returns, and all state/UI failures are best effort.
 */
export function maybeNotifyLegacyThemeNotice(
  ctx: ExtensionContext,
  reason: TlhSessionStartReason,
): void {
  try {
    if (
      reason !== "startup" ||
      ctx.mode !== "tui" ||
      !ctx.hasUI ||
      process.env.PI_SUBAGENT_CHILD === "1" ||
      !tlhStartupStatePath()
    ) {
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
  } catch {
    // A startup notice or its profile marker must never block launch.
  }
}
