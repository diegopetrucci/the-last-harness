import { InteractiveMode } from "@earendil-works/pi-coding-agent";
const TLH_NEW_VERSION_NOTICE_PATCHED = Symbol.for("tlh.newVersionNoticePatched");
function noOpShowNewVersionNotification() { }
export function installTlhNewVersionNotificationOverride() {
    const interactiveModePrototype = InteractiveMode.prototype;
    if (interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED]) {
        return;
    }
    if (typeof interactiveModePrototype.showNewVersionNotification !== "function") {
        console.warn("[TLH] installTlhNewVersionNotificationOverride: InteractiveMode.prototype.showNewVersionNotification is not a function; skipping patch.");
        return;
    }
    interactiveModePrototype.showNewVersionNotification =
        noOpShowNewVersionNotification;
    interactiveModePrototype[TLH_NEW_VERSION_NOTICE_PATCHED] = true;
}
