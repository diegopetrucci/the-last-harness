import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import { selectProviderAwareAgentDefaults } from "./model-defaults.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import {
	formatThinkingLevelOption,
	getAvailableThinkingLevels,
	isThinkingLevel,
	parseThinkingLevelOption,
	setExtensionThinkingLevel,
	thinkingLevelAtLeast,
} from "./thinking.js";
import type { ReasoningModel } from "./types.js";

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
	const completions = filteredLevels.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
		value: level,
		label: level,
		description: THINKING_LEVEL_DESCRIPTIONS[level],
	}));
	return completions.length > 0 ? completions : null;
}

async function handleThinkingLevelCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	runtime?: TlhPrimaryAgentRuntime,
): Promise<void> {
	const primary = runtime?.activePrimaryAgentPrompt();

	if (primary?.lockThinking) {
		const defaults = selectProviderAwareAgentDefaults(primary, [], ctx.model?.provider);
		const level = defaults.thinking ?? "off";
		ctx.ui.notify(`Thinking is locked at "${level}" for the ${primary.name} primary agent.`, "error");
		return;
	}

	const currentLevel = pi.getThinkingLevel();
	const availableLevels = getAvailableThinkingLevels(ctx.model as ReasoningModel | undefined);
	const requestedLevel = args.trim().toLowerCase();
	const minThinking = primary?.minThinking;

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
		if (minThinking !== undefined && !thinkingLevelAtLeast(requestedLevel, minThinking)) {
			ctx.ui.notify(`${primary!.name} requires at least ${minThinking} thinking.`, "error");
			return;
		}
		setExtensionThinkingLevel(pi, requestedLevel);
		ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
		return;
	}

	const pickerLevels =
		minThinking !== undefined
			? availableLevels.filter((level) => thinkingLevelAtLeast(level, minThinking))
			: availableLevels;

	if (!ctx.hasUI) {
		ctx.ui.notify(`Available thinking levels: ${pickerLevels.join(", ")}. Current: ${currentLevel}.`, "info");
		return;
	}

	const options = pickerLevels.map((level) => formatThinkingLevelOption(level, currentLevel));
	const selected = await ctx.ui.select("Pick thinking level", options);
	const selectedLevel = selected ? parseThinkingLevelOption(selected) : undefined;
	if (!selectedLevel) {
		return;
	}

	setExtensionThinkingLevel(pi, selectedLevel);
	ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
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
