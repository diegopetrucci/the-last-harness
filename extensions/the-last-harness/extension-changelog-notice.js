// Generated from extensions/the-last-harness/extension-changelog-notice.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
const TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED = Symbol.for("tlh.extensionChangelogNoticePatched");
const noExtensionChangelogUpdates = () => [];
function hasExtensionChangelogUpdates(value) {
    return (typeof value === "object" &&
        value !== null &&
        "getExtensionChangelogUpdates" in value &&
        typeof value.getExtensionChangelogUpdates === "function");
}
export function installTlhExtensionChangelogNoticeOverride() {
    const interactiveModePrototype = InteractiveMode.prototype;
    if (!hasExtensionChangelogUpdates(interactiveModePrototype)) {
        console.warn("[TLH] installTlhExtensionChangelogNoticeOverride: InteractiveMode.prototype.getExtensionChangelogUpdates is not a function; skipping patch.");
        return;
    }
    if (interactiveModePrototype[TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED]) {
        return;
    }
    interactiveModePrototype.getExtensionChangelogUpdates = noExtensionChangelogUpdates;
    interactiveModePrototype[TLH_EXTENSION_CHANGELOG_NOTICE_PATCHED] = true;
}
