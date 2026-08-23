import { FALLBACK_THINKING_LEVELS, THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS, } from "./constants.js";
export function getAvailableThinkingLevels(model) {
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
        if (level === "xhigh" || level === "max") {
            return mapped !== undefined;
        }
        return true;
    });
}
export function isThinkingLevel(value) {
    return THINKING_LEVELS.includes(value);
}
export function formatThinkingLevelOption(level, currentLevel) {
    const marker = level === currentLevel ? "✓" : " ";
    return `${marker} ${level} — ${THINKING_LEVEL_DESCRIPTIONS[level]}`;
}
export function parseThinkingLevelOption(option) {
    return THINKING_LEVELS.find((level) => option.includes(` ${level} —`));
}
export function thinkingLevelAtLeast(level, floor) {
    return THINKING_LEVELS.indexOf(level) >= THINKING_LEVELS.indexOf(floor);
}
export function setExtensionThinkingLevel(pi, level) {
    pi.setThinkingLevel(level);
}
