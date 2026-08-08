import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import { thinkingLevelAtLeast } from "./thinking.js";
function createRetryableLazyImport(loader) {
    let modulePromise;
    return () => {
        if (!modulePromise) {
            modulePromise = loader().catch((error) => {
                modulePromise = undefined;
                throw error;
            });
        }
        return modulePromise;
    };
}
function getThinkingLevelCompletions(prefix, runtime) {
    const primary = runtime?.activePrimaryAgentPrompt();
    const normalizedPrefix = prefix.trim().toLowerCase();
    if (primary?.lockThinking) {
        return [];
    }
    const minThinking = primary?.minThinking;
    const filteredLevels = minThinking !== undefined
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
export function registerEffortCommand(pi, runtime, options = {}) {
    const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./effort-command.js")));
    const runHandler = async (args, ctx) => {
        const module = await loadModule();
        await module.handleThinkingLevelCommand(pi, args, ctx, runtime);
    };
    for (const commandName of ["effort", "thinking"]) {
        pi.registerCommand(commandName, {
            description: "Pick the model thinking level",
            getArgumentCompletions: (prefix) => getThinkingLevelCompletions(prefix, runtime),
            handler: runHandler,
        });
    }
}
