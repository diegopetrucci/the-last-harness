import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockPi as _createMockPi } from "./mock-pi.ts";
import type { MockPi } from "./mock-pi.ts";

export type { MockPi };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMockPi(): MockPi {
	return _createMockPi();
}

export function createTempDir(prefix = "pi-subagent-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Test cleanup is best effort when a fixture already removed the directory.
	}
}

export function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of listeners.get(channel) ?? []) handler(payload);
		},
	};
}

interface AgentConfig {
	name: string;
	description?: string;
	systemPrompt?: string;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	skills?: string[];
	thinking?: string;
	systemPromptMode?: string;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	scope?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	mcpDirectTools?: string[];
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	maxExecutionTimeMs?: number;
}

export function makeAgentConfigs(names: string[]): AgentConfig[] {
	return names.map((name) => ({
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
	}));
}

export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

interface MinimalCtx {
	cwd: string;
	hasUI: boolean;
	ui: Record<string, never>;
	sessionManager: {
		getSessionId: () => string;
		getSessionFile: () => string | null;
	};
	modelRegistry: {
		getAvailable: () => Array<{ provider: string; id: string }>;
	};
	model?: { provider: string; id?: string };
}

export function makeMinimalCtx(cwd: string): MinimalCtx {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => null,
		},
		modelRegistry: {
			getAvailable: () => [],
		},
	};
}

/**
 * Dynamically import a required test module.
 *
 * Relative paths are resolved from the embedded package root. Import failures
 * intentionally propagate: a missing dependency or broken source must fail the
 * suite instead of being converted into a skipped test.
 */
export async function tryImport<T>(specifier: string): Promise<T> {
	if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
		return await import(specifier) as T;
	}
	const projectRoot = path.resolve(__dirname, "..", "..");
	const abs = path.resolve(projectRoot, specifier);
	const url = pathToFileURL(abs).href;
	return await import(url) as T;
}

export const events = {
	assistantMessage(text: string, model = "mock/test-model"): object {
		return {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				model,
				stopReason: "stop",
				usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
			},
		};
	},

	toolStart(toolName: string, args: Record<string, unknown> = {}): object {
		return { type: "tool_execution_start", toolName, args };
	},

	toolEnd(toolName: string): object {
		return { type: "tool_execution_end", toolName };
	},

	toolResult(toolName: string, text: string, isError = false): object {
		return {
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName,
				isError,
				content: [{ type: "text", text }],
			},
		};
	},
};
