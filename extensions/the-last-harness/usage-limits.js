import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
export const USAGE_COMMAND_HELP = "Usage: /usage [status|weekly on|weekly off|weekly toggle]. With no argument, /usage shows status.";
const USAGE_COMMAND_COMPLETIONS = [
    { value: "status", description: "Show TLH usage-limit footer preferences" },
    { value: "weekly on", description: "Show the weekly usage-limit window in the footer" },
    { value: "weekly off", description: "Hide the weekly usage-limit window in the footer" },
    { value: "weekly toggle", description: "Toggle the weekly usage-limit window in the footer" },
];
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
export function getTlhUsageLimitsConfig(cwd) {
    try {
        const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings();
        return settings.tlh?.usageLimits;
    }
    catch {
        return undefined;
    }
}
export function shouldShowTlhUsageWeekly(config) {
    return config?.showWeekly;
}
function usageCommandCompletions(prefix) {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const completions = USAGE_COMMAND_COMPLETIONS
        .filter((option) => option.value.startsWith(normalizedPrefix))
        .map((option) => ({ value: option.value, label: option.value, description: option.description }));
    return completions.length > 0 ? completions : null;
}
export function registerUsageCommand(pi, options = {}) {
    const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./usage-limits-command.js")));
    pi.registerCommand("usage", {
        description: "Show or change TLH usage-limit footer preferences",
        getArgumentCompletions: usageCommandCompletions,
        handler: async (args, ctx) => {
            const module = await loadModule();
            await module.handleUsageCommand(args, ctx);
        },
    });
}
