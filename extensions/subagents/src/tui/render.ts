/**
 * Stable rendering entry points for subagent widgets and tool results.
 */

export { clearLegacyResultAnimationTimer, renderSubagentResult } from "./render-result.ts";
export {
  buildWidgetLines,
  renderWidget,
  widgetPhraseSlotKey,
  widgetRenderKey,
} from "./render-widget.ts";
