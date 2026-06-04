import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import {
	formatThinkingLevelOption,
	getAvailableThinkingLevels,
	isThinkingLevel,
	parseThinkingLevelOption,
} from "./thinking.js";
import type { ReasoningModel } from "./types.js";

function getThinkingLevelCompletions(prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const completions = THINKING_LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
		value: level,
		label: level,
		description: THINKING_LEVEL_DESCRIPTIONS[level],
	}));
	return completions.length > 0 ? completions : null;
}

async function handleThinkingLevelCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const currentLevel = pi.getThinkingLevel();
	const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
	const requestedLevel = args.trim().toLowerCase();

	if (requestedLevel) {
		if (!isThinkingLevel(requestedLevel)) {
			ctx.ui.notify(`Unknown thinking level "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
			return;
		}
		if (!availableLevels.includes(requestedLevel)) {
			ctx.ui.notify(
				`Thinking level "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`,
				"warning",
			);
			return;
		}
		pi.setThinkingLevel(requestedLevel);
		ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(`Available thinking levels: ${availableLevels.join(", ")}. Current: ${currentLevel}.`, "info");
		return;
	}

	const options = availableLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
	const selected = await ctx.ui.select("Pick thinking level", options);
	const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
	if (!selectedLevel) {
		return;
	}

	pi.setThinkingLevel(selectedLevel);
	ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
}

export function registerEffortCommand(pi: ExtensionAPI): void {
	for (const commandName of ["effort", "thinking"] as const) {
		pi.registerCommand(commandName, {
			description: "Pick the model thinking level",
			getArgumentCompletions: getThinkingLevelCompletions,
			handler: (args, ctx) => handleThinkingLevelCommand(pi, args, ctx),
		});
	}
}
