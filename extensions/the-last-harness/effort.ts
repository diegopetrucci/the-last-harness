import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import { handleThinkingLevelCommand } from "./effort-command.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import { thinkingLevelAtLeast } from "./thinking.js";

function getThinkingLevelCompletions(prefix: string, runtime?: TlhPrimaryAgentRuntime) {
  const primary = runtime?.activePrimaryAgentPrompt();
  const normalizedPrefix = prefix.trim().toLowerCase();

  if (primary?.lockThinking) {
    return [];
  }

  const minThinking = primary?.minThinking;
  const filteredLevels =
    minThinking !== undefined
      ? THINKING_LEVELS.filter((level) => thinkingLevelAtLeast(level, minThinking))
      : THINKING_LEVELS;
  const completions = filteredLevels
    .filter((level) => level.startsWith(normalizedPrefix))
    .map((level) => ({
      value: level,
      label: level,
      description: THINKING_LEVEL_DESCRIPTIONS[level],
    }));
  return completions.length > 0 ? completions : null;
}

export function registerEffortCommand(pi: ExtensionAPI, runtime?: TlhPrimaryAgentRuntime): void {
  for (const commandName of ["effort", "thinking"] as const) {
    pi.registerCommand(commandName, {
      description: "Pick the model thinking level",
      getArgumentCompletions: (prefix) => getThinkingLevelCompletions(prefix, runtime),
      handler: (args, ctx) => handleThinkingLevelCommand(pi, args, ctx, runtime),
    });
  }
}
