/**
 * Suppresses Pi's "Updated <package>" / "Extension Updates" changelog notices at launch.
 * See ../../docs/upstream-sync-inventory.md for sync/review guidance.
 *
 * WHY: TLH keeps startup quiet and surfaces only its own update signals (header
 * version + releases link after a TLH update, `/tlh-changelog`, and the startup tip).
 * Pi's `getExtensionChangelogUpdates()` is also the only writer of
 * `extensionChangelogVersions` in settings, so returning [] prevents those writes too.
 *
 * HOW TO UNDO: remove the `installTlhExtensionChangelogNoticeOverride()` call from
 * `extensions/the-last-harness.ts`.
 */
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED = Symbol.for("tlh.extensionChangelogNoticePatched");

type TlhInteractiveModePrototype = {
  getExtensionChangelogUpdates: unknown;
  [TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED]?: boolean;
};

const noExtensionChangelogUpdates = (): [] => [];

// The method is private in Pi's declarations, so narrow the prototype structurally.
function hasExtensionChangelogUpdates(value: unknown): value is TlhInteractiveModePrototype {
  return (
    typeof value === "object" &&
    value !== null &&
    "getExtensionChangelogUpdates" in value &&
    typeof value.getExtensionChangelogUpdates === "function"
  );
}

export function installTlhExtensionChangelogNoticeOverride(): void {
  const interactiveModePrototype: unknown = InteractiveMode.prototype;
  if (!hasExtensionChangelogUpdates(interactiveModePrototype)) {
    // Fail-open: if the upstream method is absent or not a function (e.g. API changed),
    // skip the patch with a non-fatal warning instead of throwing.
    console.warn(
      "[TLH] installTlhExtensionChangelogNoticeOverride: InteractiveMode.prototype.getExtensionChangelogUpdates is not a function; skipping patch.",
    );
    return;
  }

  if (interactiveModePrototype[TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED]) {
    return;
  }

  interactiveModePrototype.getExtensionChangelogUpdates = noExtensionChangelogUpdates;
  interactiveModePrototype[TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED] = true;
}
