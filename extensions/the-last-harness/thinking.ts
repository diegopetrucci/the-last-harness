// Legacy Pi typing-compatibility shim retained for re-evaluation on the next Pi bump.
// See ../../docs/upstream-sync-inventory.md for sync/review guidance.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVELS } from "./constants.js";
import type { ReasoningModel, ThinkingLevel } from "./types.js";

// Legacy compatibility alias/cast; Pi 0.82.0 already includes "max" in this API.
type RuntimeThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export function getAvailableThinkingLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
  if (!model) {
    return [...THINKING_LEVELS];
  }
  if (!model.reasoning) {
    return ["off"];
  }

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined;
    }
    return true;
  });
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function setExtensionThinkingLevel(
  pi: Pick<ExtensionAPI, "setThinkingLevel">,
  level: ThinkingLevel,
): void {
  pi.setThinkingLevel(level as RuntimeThinkingLevel);
}
