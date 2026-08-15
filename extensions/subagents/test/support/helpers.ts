import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockPi as _createMockPi } from "./mock-pi.ts";
import type { MockPi } from "./mock-pi.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { AgentProgress, PublicNestedRunSummary, NestedRunState } from "../../src/shared/types.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import type { AsyncRunnerStepBuildParams } from "../../src/runs/background/async-execution.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

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

// AgentConfig is imported from production so test fixtures stay in sync with the
// real shape; exporting it lets test files import the type from this helper.
export type { AgentConfig };

export function makeAgentConfigs(names: string[]): AgentConfig[] {
	return names.map((name) => ({
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace" as const,
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user" as const,
		filePath: "",
	}));
}

/**
 * Creates a minimal AgentConfig for test fixtures.
 */
export function makeAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "",
		...overrides,
	};
}

/**
 * Creates a complete RunnerSubagentStep fixture typed from the production interface.
 * Only `agent` and `task` are required; all optional fields may be supplied via
 * overrides. Defaults `inheritProjectContext` and `inheritSkills` to `false`.
 */
export function makeRunnerStep(
	agent: string,
	task: string,
	overrides: Partial<RunnerSubagentStep> = {},
): RunnerSubagentStep {
	return {
		agent,
		task,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

/**
 * Creates a complete AgentProgress fixture typed from the production interface.
 * `agent`, `status`, and `task` are required parameters; all other required
 * fields default to inert/zero values so call sites express only what they test.
 */
export function makeAgentProgress(
	overrides: Pick<AgentProgress, "agent" | "status" | "task"> & Partial<AgentProgress>,
): AgentProgress {
	return {
		index: 0,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		...overrides,
	};
}

/**
 * Creates a complete PublicNestedRunSummary fixture typed from the production type.
 * `id` is required; required address fields default to inert values.
 */
export function makePublicNestedRunSummary(
	id: string,
	overrides: Partial<PublicNestedRunSummary> & { state?: NestedRunState } = {},
): PublicNestedRunSummary {
	return {
		id,
		parentRunId: "root",
		depth: 1,
		path: [{ runId: "root" }],
		state: "complete",
		...overrides,
	};
}

/**
 * Creates a minimal Model<Api> fixture typed from the production interface.
 * Defaults are inert (zero cost, empty input types). Supply `contextWindow` and
 * other fields via overrides when the test logic depends on them.
 *
 * `api` and `baseUrl` are derived from the effective provider so the fixture
 * stays coherent when `provider` is overridden. Explicit `api` or `baseUrl`
 * values in `overrides` take precedence over the derived values.
 */
export function makeModel(
	id: string,
	overrides: Partial<Model<Api>> & { provider?: string; contextWindow?: number } = {},
): Model<Api> {
	const provider = overrides.provider ?? "anthropic";
	// Derive coherent api/baseUrl from provider so overriding provider to "openai"
	// or "mock" does not leave Anthropic metadata in the fixture.
	const derivedApi: Api =
		provider === "openai"
			? ("openai-completions" as Api)
			: provider === "anthropic"
				? ("anthropic-messages" as Api)
				: (provider as Api);
	const derivedBaseUrl =
		provider === "openai" ? "https://api.openai.com" : provider === "anthropic" ? "https://api.anthropic.com" : "";
	return {
		id,
		name: id,
		api: derivedApi,
		provider,
		baseUrl: derivedBaseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

/**
 * Creates a minimal AsyncExecutionContext for tests of buildAsyncRunnerSteps,
 * executeAsyncChain, and executeAsyncSingle. The `pi` field is stubbed with a
 * no-op EventBus; the tested code paths in those functions only access
 * pi.events.emit() and only after precondition guards that fire before pi is used.
 *
 * Typed from AsyncRunnerStepBuildParams['ctx'] (AsyncExecutionContext) so that
 * newly required fields surface here rather than at each call site.
 */
export function makeAsyncCtx(
	cwd: string,
	overrides: Partial<AsyncRunnerStepBuildParams["ctx"]> = {},
): AsyncRunnerStepBuildParams["ctx"] {
	return {
		// ExtensionAPI has 25+ methods; the code paths exercised in async-execution
		// tests only call pi.events.emit() (and only after reviewed-rejection checks).
		// A structural cast is used instead of a full mock to avoid duplicating the
		// SDK interface and to keep the fixture small and auditable.
		pi: {
			events: {
				emit(_channel: string, _data: unknown) {},
				on(_channel: string, _handler: (data: unknown) => void) {
					return () => {};
				},
			},
		} as unknown as ExtensionAPI,
		cwd,
		currentSessionId: "session-1",
		currentModel: undefined,
		currentModelProvider: undefined,
		modelScope: undefined,
		...overrides,
	};
}

/**
 * Creates a minimal ExtensionContext for test fixtures. Typed from the production
 * interface so that newly required fields surface at this factory rather than at
 * every call site. Complex SDK sub-types (ExtensionUIContext, ModelRegistry,
 * ReadonlySessionManager) are stubbed via structural casts; only the methods used
 * by the tested code paths are implemented.
 */
export function makeMinimalCtx(cwd: string): ExtensionContext {
	// Explicit type annotation ensures TypeScript checks all required top-level
	// fields of ExtensionContext here. SDK sub-interfaces that require private
	// class members or complex TUI types are stubbed with as-unknown casts.
	const ctx: ExtensionContext = {
		cwd,
		mode: "json",
		hasUI: false,
		// ExtensionUIContext has 15+ async methods requiring TUI/Theme types from
		// the SDK; none are called in tests that use makeMinimalCtx.
		ui: {} as unknown as ExtensionUIContext,
		sessionManager: {
			getSessionId: () => "session-123",
			getSessionFile: () => undefined,
			// Remaining ReadonlySessionManager methods are unused in these tests.
		} as unknown as ExtensionContext["sessionManager"],
		// ModelRegistry is a class with a private `runtime` field; structural
		// casting is the only way to supply a no-op instance.
		modelRegistry: {
			getAvailable: () => [],
		} as unknown as ModelRegistry,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
	return ctx;
}

/**
 * Creates a minimal ExtensionAPI stub for unit tests.
 * The real ExtensionAPI has 25+ methods; most tests only need a small subset.
 * Using `as unknown as ExtensionAPI` once here keeps call sites clean and avoids
 * scattered suppression casts throughout the test suite.
 */
export function makeExtensionAPI(overrides: Record<string, unknown> = {}): ExtensionAPI {
	return overrides as unknown as ExtensionAPI;
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
		return (await import(specifier)) as T;
	}
	const projectRoot = path.resolve(__dirname, "..", "..");
	const abs = path.resolve(projectRoot, specifier);
	const url = pathToFileURL(abs).href;
	return (await import(url)) as T;
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
