// Generated from extensions/the-last-harness/new-version-notice.ts by scripts/runtime-typescript.mjs; edit the source, not this file.
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
const TLH_NEW_VERSION_NOTICE_PATCHED = Symbol.for("tlh.newVersionNoticePatched");
const noOpShowNewVersionNotification = () => { };
export function installTlhNewVersionNotificationOverride() {
    const interactiveModePrototype = InteractiveMode.prototype;
    if (interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED]) {
        return;
    }
    if (typeof interactiveModePrototype.showNewVersionNotification !== "function") {
        console.warn("[TLH] installTlhNewVersionNotificationOverride: InteractiveMode.prototype.showNewVersionNotification is not a function; skipping patch.");
        return;
    }
    interactiveModePrototype.showNewVersionNotification = noOpShowNewVersionNotification;
    interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED] = true;
}
