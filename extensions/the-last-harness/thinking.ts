import { FALLBACK_THINKING_LEVELS, THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import type { ReasoningModel, ThinkingLevel } from "./types.js";

export function getAvailableThinkingLevels(model: ReasoningModel | undefined): ThinkingLevel[] {
	if (!model) {
		return FALLBACK_THINKING_LEVELS;
	}
	if (!model.reasoning) {
		return ["off"];
	}

	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) {
			return false;
		}
		if (level === "xhigh") {
			return mapped !== undefined;
		}
		return true;
	});
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function formatThinkingLevelOption(level: ThinkingLevel, currentLevel: ThinkingLevel): string {
	const marker = level === currentLevel ? "✓" : " ";
	return `${marker} ${level} — ${THINKING_LEVEL_DESCRIPTIONS[level]}`;
}

export function parseThinkingLevelOption(option: string): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => option.includes(` ${level} —`));
}
