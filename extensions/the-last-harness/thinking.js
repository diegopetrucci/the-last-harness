import { THINKING_LEVELS } from "./constants.js";
export function getAvailableThinkingLevels(model) {
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
export function isThinkingLevel(value) {
    return THINKING_LEVELS.includes(value);
}
export function setExtensionThinkingLevel(pi, level) {
    pi.setThinkingLevel(level);
}
