/**
 * Suppresses the upstream Pi "Update Available — Run `pi update`" banner at launch.
 * See ../../docs/upstream-sync-inventory.md for sync/review guidance.
 *
 * WHY: TLH pins Pi to a supported version window, so the upstream update prompt is
 * misleading noise — the correct update path is `tlh update`, not `pi update`.
 *
 * HOW TO UNDO: remove the `installTlhNewVersionNotificationOverride()` call from
 * `extensions/the-last-harness.ts`.
 *
 * PI_SKIP_VERSION_CHECK semantics are intentionally unchanged: it remains a TLH
 * update-check opt-out; the upstream Pi version fetch still runs harmlessly.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const TLH_NEW_VERSION_NOTICE_PATCHED = Symbol.for("tlh.newVersionNoticePatched");

type TlhInteractiveModePrototype = typeof InteractiveMode.prototype & {
  [TLH_NEW_VERSION_NOTICE_PATCHED]?: boolean;
};

// Intentional no-op: TLH pins Pi to a supported version window, so the upstream
// "Update Available — Run `pi update`" banner shown at launch is misleading noise.
function noOpShowNewVersionNotification(): void {}

export function installTlhNewVersionNotificationOverride(): void {
  const interactiveModePrototype = InteractiveMode.prototype as TlhInteractiveModePrototype;
  if (interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED]) {
    return;
  }

  if (typeof interactiveModePrototype.showNewVersionNotification !== "function") {
    // Fail-open: if the upstream method is absent or not a function (e.g. API changed),
    // skip the patch with a non-fatal warning instead of throwing.
    console.warn(
      "[TLH] installTlhNewVersionNotificationOverride: InteractiveMode.prototype.showNewVersionNotification is not a function; skipping patch.",
    );
    return;
  }

  interactiveModePrototype.showNewVersionNotification =
    noOpShowNewVersionNotification as unknown as typeof interactiveModePrototype.showNewVersionNotification;
  interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED] = true;
}
