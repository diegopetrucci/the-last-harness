import { DynamicBorder, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
const TLH_PACKAGE_UPDATE_NOTICE_PATCHED = Symbol.for("tlh.packageUpdateNoticePatched");
const TLH_PACKAGE_UPDATE_INSTRUCTION = "TLH extension updates are available. Run `tlh update --extensions` to update them.";
function showTlhPackageUpdateNotification(packages) {
    const packageLines = packages.map((pkg) => ` - ${pkg}`).join("\n");
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder((text) => text));
    this.chatContainer.addChild(new Text(`${TLH_PACKAGE_UPDATE_INSTRUCTION}\n${packageLines}`, 1, 0));
    this.chatContainer.addChild(new DynamicBorder((text) => text));
    this.ui.requestRender();
}
export function installTlhPackageUpdateNotificationOverride() {
    const interactiveModePrototype = InteractiveMode.prototype;
    if (interactiveModePrototype[TLH_PACKAGE_UPDATE_NOTICE_PATCHED]) {
        return;
    }
    interactiveModePrototype.showPackageUpdateNotification = showTlhPackageUpdateNotification;
    interactiveModePrototype[TLH_PACKAGE_UPDATE_NOTICE_PATCHED] = true;
}
