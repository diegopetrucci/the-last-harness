import {} from "@earendil-works/pi-coding-agent";
import { selectProviderAwareAgentDefaults } from "./model-defaults.js";
import { formatThinkingLevelOption, getAvailableThinkingLevels, isThinkingLevel, parseThinkingLevelOption, setExtensionThinkingLevel, thinkingLevelAtLeast, } from "./thinking.js";
export async function handleThinkingLevelCommand(pi, args, ctx, runtime) {
    const primary = runtime?.activePrimaryAgentPrompt();
    if (primary?.lockThinking) {
        const defaults = selectProviderAwareAgentDefaults(primary, [], ctx.model?.provider);
        const level = defaults.thinking ?? "off";
        ctx.ui.notify(`Thinking is locked at "${level}" for the ${primary.name} primary agent.`, "error");
        return;
    }
    const currentLevel = pi.getThinkingLevel();
    const availableLevels = getAvailableThinkingLevels(ctx.model);
    const requestedLevel = args.trim().toLowerCase();
    const minThinking = primary?.minThinking;
    if (requestedLevel) {
        if (!isThinkingLevel(requestedLevel)) {
            ctx.ui.notify(`Unknown thinking level "${args.trim()}". Available: ${availableLevels.join(", ")}.`, "error");
            return;
        }
        if (!availableLevels.includes(requestedLevel)) {
            ctx.ui.notify(`Thinking level "${requestedLevel}" is not available for the current model. Available: ${availableLevels.join(", ")}.`, "warning");
            return;
        }
        if (minThinking !== undefined && !thinkingLevelAtLeast(requestedLevel, minThinking)) {
            ctx.ui.notify(`${primary.name} requires at least ${minThinking} thinking.`, "error");
            return;
        }
        setExtensionThinkingLevel(pi, requestedLevel);
        ctx.ui.notify(`Thinking level set to ${pi.getThinkingLevel()}.`, "info");
        return;
    }
    const pickerLevels = minThinking !== undefined
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
