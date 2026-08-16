import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentLiveDetailController } from "../shared/subagent-shortcuts.ts";

/**
 * Toggle the extension-owned live-detail state without touching Pi's global
 * tool-output expansion. The caller supplies the widget rerender so this
 * helper remains independent of async job tracking.
 */
export function handleSubagentLiveDetailShortcut(
  controller: SubagentLiveDetailController,
  ctx: ExtensionContext,
  rerenderWidget?: () => void,
): boolean {
  const expanded = controller.toggle();
  if (ctx.hasUI) rerenderWidget?.();
  return expanded;
}
