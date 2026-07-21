import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVEL_DESCRIPTIONS, THINKING_LEVELS } from "./constants.js";
import type { TlhPrimaryAgentRuntime } from "./primary-agent-runtime.js";
import { thinkingLevelAtLeast } from "./thinking.js";

type EffortCommandModule = {
	handleThinkingLevelCommand(
		pi: ExtensionAPI,
		args: string,
		ctx: ExtensionCommandContext,
		runtime?: TlhPrimaryAgentRuntime,
	): Promise<void>;
};

type TlhEffortCommandFacadeOptions = {
	loadModule?: () => Promise<EffortCommandModule>;
};

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

export function registerEffortCommand(
	pi: ExtensionAPI,
	runtime?: TlhPrimaryAgentRuntime,
	options: TlhEffortCommandFacadeOptions = {},
): void {
	const loadModule = createRetryableLazyImport(options.loadModule ?? (() => import("./effort-command.js") as Promise<EffortCommandModule>));
	const runHandler = async (args: string, ctx: ExtensionCommandContext) => {
		const module = await loadModule();
		await module.handleThinkingLevelCommand(pi, args, ctx, runtime);
	};

	for (const commandName of ["effort", "thinking"] as const) {
		pi.registerCommand(commandName, {
			description: "Pick the model thinking level",
			getArgumentCompletions: (prefix) => getThinkingLevelCompletions(prefix, runtime),
			handler: runHandler,
		});
	}
}
