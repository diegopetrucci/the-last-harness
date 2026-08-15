import { beginTlhModelSelectionDefaultSuppression, beginTlhThinkingLevelSelection, chooseTlhThinkingSelectionScope, discardTlhThinkingLevelSelection, endTlhThinkingLevelSelectionCapture, persistTlhStandaloneThinkingDefaults, persistTlhThinkingLevelSelection, replayTlhUnmatchedModelSelectionDefaults, } from "./model-selection-scope.js";
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
    await persistTlhStandaloneThinkingDefaults();
    replayTlhUnmatchedModelSelectionDefaults();
    const thinkingCapture = beginTlhThinkingLevelSelection();
    let thinkingSelection = thinkingCapture;
    try {
        try {
            setExtensionThinkingLevel(pi, selectedLevel);
        }
        finally {
            thinkingSelection = endTlhThinkingLevelSelectionCapture(thinkingCapture);
        }
        const nextLevel = pi.getThinkingLevel();
        if (nextLevel === currentLevel) {
            discardTlhThinkingLevelSelection(thinkingSelection);
            ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
            return;
        }
        if (!thinkingSelection) {
            ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
            return;
        }
        const scope = await chooseTlhThinkingSelectionScope(ctx);
        if (scope === "cancel") {
            discardTlhThinkingLevelSelection(thinkingSelection);
            let resultingLevel;
            const releaseDefaultSuppression = beginTlhModelSelectionDefaultSuppression();
            try {
                try {
                    setExtensionThinkingLevel(pi, currentLevel);
                }
                catch {
                }
            }
            finally {
                releaseDefaultSuppression();
            }
            try {
                resultingLevel = pi.getThinkingLevel();
            }
            catch {
            }
            if (resultingLevel === currentLevel) {
                ctx.ui.notify(`Kept thinking level at ${resultingLevel} after cancelling thinking selection.`, "info");
            }
            else if (resultingLevel !== undefined) {
                ctx.ui.notify(`TLH could not restore thinking level to ${currentLevel} after cancelling thinking selection; active level remains ${resultingLevel}.`, "warning");
            }
            else {
                ctx.ui.notify(`TLH could not verify the active thinking level after cancelling thinking selection; expected ${currentLevel}.`, "warning");
            }
            return;
        }
        if (scope === "session-only") {
            discardTlhThinkingLevelSelection(thinkingSelection);
            ctx.ui.notify(`Thinking level set to ${nextLevel} for this session.`, "info");
            return;
        }
        const persisted = await persistTlhThinkingLevelSelection(thinkingSelection);
        if (!persisted) {
            ctx.ui.notify(`Thinking level set to ${nextLevel} for this session, but TLH could not update the persistent default.`, "warning");
            return;
        }
        ctx.ui.notify(`Thinking level set to ${nextLevel}.`, "info");
    }
    catch (error) {
        await persistTlhThinkingLevelSelection(thinkingSelection);
        throw error;
    }
}
