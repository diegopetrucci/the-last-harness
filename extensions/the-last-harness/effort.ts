import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import {
	formatThinkingLevelOption,
	getAvailableThinkingLevels,
	isThinkingLevel,
	parseThinkingLevelOption,
} from "./thinking.js";
import type { ReasoningModel } from "./types.js";

export function registerEffortCommand(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "Pick the model reasoning effort / thinking level",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const completions = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
				value: level,
				label: level,
				description: THINKING_LEVEL_DESCRIPTIONS[level],
			}));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const currentLevel = pi.getThinkingLevel();
			const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
			const requestedLevel = args.trim().toLowerCase();

			if (requestedLevel) {
				if (!isThinkingLevel(requestedLevel)) {
					ctx.ui.notify(`Unknown effort "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
					return;
				}
				if (!availableLevels.includes(requestedLevel)) {
					ctx.ui.notify(`Effort "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`, "warning");
					return;
				}
				pi.setThinkingLevel(requestedLevel);
				ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Available efforts: ${availableLevels.join(", ")}. Current: ${currentLevel}.`, "info");
				return;
			}

			const options = availableLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
			const selected = await ctx.ui.select("Pick reasoning effort", options);
			const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
			if (!selectedLevel) {
				return;
			}

			pi.setThinkingLevel(selectedLevel);
			ctx.ui.notify(`Effort set to ${pi.getThinkingLevel()}.`, "info");
		},
	});
}
