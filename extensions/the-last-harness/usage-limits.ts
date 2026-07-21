import { SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { TlhSettings, TlhUsageLimitsConfig } from "./types.js";

export const USAGE_COMMAND_HELP = "Usage: /usage [status|weekly on|weekly off|weekly toggle]. With no argument, /usage shows status.";

const USAGE_COMMAND_COMPLETIONS = [
	{ value: "status", description: "Show TLH usage-limit footer preferences" },
	{ value: "weekly on", description: "Show the weekly usage-limit window in the footer" },
	{ value: "weekly off", description: "Hide the weekly usage-limit window in the footer" },
	{ value: "weekly toggle", description: "Toggle the weekly usage-limit window in the footer" },
] as const;

type UsageLimitsCommandModule = {
	handleUsageCommand(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

type TlhUsageCommandFacadeOptions = {
	loadModule?: () => Promise<UsageLimitsCommandModule>;
};

let cachedTlhUsageWeeklyVisibility: boolean | undefined;

function createRetryableLazyImport<TModule>(loader: () => Promise<TModule>): () => Promise<TModule> {
	let modulePromise: Promise<TModule> | undefined;
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

export function getTlhUsageLimitsConfig(cwd: string): TlhUsageLimitsConfig | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir()).getGlobalSettings() as TlhSettings;
		return settings.tlh?.usageLimits;
	} catch {
		return undefined;
	}
}

export function shouldShowTlhUsageWeekly(config: TlhUsageLimitsConfig | undefined): boolean | undefined {
	return config?.showWeekly;
}

export function getPersistedTlhUsageWeeklyVisibility(cwd: string): boolean | undefined {
	return shouldShowTlhUsageWeekly(getTlhUsageLimitsConfig(cwd));
}

export function getCachedTlhUsageWeeklyVisibility(): boolean | undefined {
	return cachedTlhUsageWeeklyVisibility;
}

export function refreshCachedTlhUsageWeeklyVisibility(cwd: string): boolean | undefined {
	cachedTlhUsageWeeklyVisibility = getPersistedTlhUsageWeeklyVisibility(cwd);
	return cachedTlhUsageWeeklyVisibility;
}

export function setCachedTlhUsageWeeklyVisibility(showWeekly: boolean | undefined): void {
	cachedTlhUsageWeeklyVisibility = showWeekly;
}

function usageCommandCompletions(prefix: string) {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const completions = USAGE_COMMAND_COMPLETIONS
		.filter((option) => option.value.startsWith(normalizedPrefix))
		.map((option) => ({ value: option.value, label: option.value, description: option.description }));
	return completions.length > 0 ? completions : null;
}

export function registerUsageCommand(pi: ExtensionAPI, options: TlhUsageCommandFacadeOptions = {}): void {
	const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./usage-limits-command.js") as Promise<UsageLimitsCommandModule>));
	pi.registerCommand("usage", {
		description: "Show or change TLH usage-limit footer preferences",
		getArgumentCompletions: usageCommandCompletions,
		handler: async (args, ctx) => {
			const module = await loadModule();
			await module.handleUsageCommand(args, ctx);
		},
	});
}
