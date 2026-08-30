import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import { handleThinkingLevelCommand } from "./effort-command.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";

function getThinkingLevelCompletions(prefix: string) {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const completions = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map(
    (level) => ({
      value: level,
      label: level,
      description: THINKING_LEVEL_DESCRIPTIONS[level],
    }),
  );
  return completions.length > 0 ? completions : null;
}

export function registerEffortCommand(pi: ExtensionAPI, runtime?: TlhPrimaryAgentRuntime): void {
  pi.registerCommand("effort", {
    description: "Pick the model thinking level",
    getArgumentCompletions: getThinkingLevelCompletions,
    handler: (args, ctx) => handleThinkingLevelCommand(pi, args, ctx, runtime),
  });
}
