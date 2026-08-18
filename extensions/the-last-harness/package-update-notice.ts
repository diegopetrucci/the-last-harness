// Pi compatibility shim for TLH-specific package-update copy.
// See ../../docs/upstream-sync-inventory.md for sync/review guidance.
import { DynamicBorder, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";

const TLH_PACKAGE_UPDATE_NOTICE_PATCHED = Symbol.for("tlh.packageUpdateNoticePatched");
const TLH_PACKAGE_UPDATE_INSTRUCTION =
  "TLH extension updates are available. Run `tlh update --extensions` to update them.";

type TlhPackageUpdateNotificationTarget = {
  chatContainer: {
    addChild(component: unknown): void;
  };
  ui: {
    requestRender(): void;
  };
};

type TlhInteractiveModePrototype = typeof InteractiveMode.prototype & {
  [TLH_PACKAGE_UPDATE_NOTICE_PATCHED]?: boolean;
};

function showTlhPackageUpdateNotification(
  this: TlhPackageUpdateNotificationTarget,
  packages: string[],
): void {
  const packageLines = packages.map((pkg) => ` - ${pkg}`).join("\n");

  this.chatContainer.addChild(new Spacer(1));
  this.chatContainer.addChild(new DynamicBorder((text) => text));
  this.chatContainer.addChild(new Text(`${TLH_PACKAGE_UPDATE_INSTRUCTION}\n${packageLines}`, 1, 0));
  this.chatContainer.addChild(new DynamicBorder((text) => text));
  this.ui.requestRender();
}

export function installTlhPackageUpdateNotificationOverride(): void {
  const interactiveModePrototype = InteractiveMode.prototype as TlhInteractiveModePrototype;
  if (interactiveModePrototype[TLH_PACKAGE_UPDATE_NOTICE_PATCHED]) {
    return;
  }

  interactiveModePrototype.showPackageUpdateNotification = showTlhPackageUpdateNotification;
  interactiveModePrototype[TLH_PACKAGE_UPDATE_NOTICE_PATCHED] = true;
}
