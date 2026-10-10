import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockPi as _createMockPi } from "./mock-pi.ts";
import type { MockPi } from "./mock-pi.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { AgentProgress, SubagentState } from "../../src/shared/types.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import type { buildAsyncRunnerPlan } from "../../src/runs/background/async-execution.ts";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  fauxProvider,
  type Api,
  type Credential,
  type CredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { createPlainTheme } from "./themes.ts";

export type { MockPi };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testModelRuntimeAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "tlh-subagents-test-auth-"));
const testModelRuntimeAuthPath = path.join(testModelRuntimeAuthDir, "auth.json");
let testModelRuntimeAuthCleaned = false;
function cleanupTestModelRuntimeAuth(): void {
  if (testModelRuntimeAuthCleaned) return;
  testModelRuntimeAuthCleaned = true;
  try {
    fs.rmSync(testModelRuntimeAuthDir, { recursive: true, force: true });
  } catch {
    // Process exit cleanup is best effort after the test runtime is gone.
  }
}
process.once("exit", cleanupTestModelRuntimeAuth);

const testModelRuntime = await ModelRuntime.create({
  authPath: testModelRuntimeAuthPath,
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});

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

export type TestEventName =
  | "tool_call"
  | "session_start"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_end"
  | "turn_end"
  | "session_shutdown"
  | "context"
  | "before_agent_start";
export type TestEventPayload = Record<string, unknown>;
export type TestEventResult = object | void | Promise<object | void>;
export type TestEventHandler = (payload: TestEventPayload) => TestEventResult;

export interface TestEventRegistration {
  on(event: TestEventName, handler: TestEventHandler): () => void;
}

export type ExtensionAPIOverrides = Partial<Omit<ExtensionAPI, "on">> & {
  /**
   * Test-only registration seam for the overloaded upstream `ExtensionAPI.on`.
   * `makeExtensionAPI` validates the event name and callable handler before
   * adapting it to this deliberately payload-only recorder.
   */
  on?: TestEventRegistration["on"];
};

const defaultExtensionAPI = {
  registerTool(_tool: unknown): void {},
  registerCommand(_name: string, _options: unknown): void {},
  registerShortcut(_shortcut: string, _options: unknown): void {},
  registerFlag(_name: string, _options: unknown): void {},
  getFlag(_name: string): boolean | string | undefined {
    return undefined;
  },
  registerMessageRenderer(_customType: string, _renderer: unknown): void {},
  registerMarkdownTransformer(_transformer: unknown): void {},
  registerEntryRenderer(_customType: string, _renderer: unknown): void {},
  sendMessage(_message: unknown, _options?: unknown): void {},
  sendUserMessage(_content: unknown, _options?: unknown): void {},
  appendEntry(_customType: string, _data?: unknown): void {},
  setSessionName(_name: string): void {},
  getSessionName(): string | undefined {
    return undefined;
  },
  setLabel(_entryId: string, _label: string | undefined): void {},
  exec(_command: string, _args: string[], _options?: unknown): Promise<never> {
    return Promise.reject(new Error("test ExtensionAPI exec was not configured"));
  },
  getActiveTools(): string[] {
    return [];
  },
  getAllTools(): never[] {
    return [];
  },
  setActiveTools(_toolNames: string[]): void {},
  getCommands(): never[] {
    return [];
  },
  setModel(_model: unknown): Promise<boolean> {
    return Promise.resolve(false);
  },
  getThinkingLevel(): "off" {
    return "off";
  },
  setThinkingLevel(_level: unknown): void {},
  registerProvider(_provider: unknown, _config?: unknown): void {},
  unregisterProvider(_name: string): void {},
  getSettings() {
    return {};
  },
  registerMcpServer(_name: string, _config: unknown): void {},
  unregisterMcpServer(_name: string): void {},
  getMcpServers(): never[] {
    return [];
  },
  registerVirtualModel(_model: unknown): void {},
  unregisterVirtualModel(_provider: string, _id: string): void {},
  registerToolRenderer(_resolver: unknown): void {},
} satisfies Omit<ExtensionAPI, "on" | "events">;

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
 * Creates a complete SubagentState fixture with inert runtime services. Tests
 * can override only the state maps relevant to the behavior under inspection.
 */
export function makeSubagentState(overrides: Partial<SubagentState> = {}): SubagentState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: {
      schedule: () => false,
      clear: () => {},
    },
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
    provider === "openai"
      ? "https://api.openai.com"
      : provider === "anthropic"
        ? "https://api.anthropic.com"
        : "";
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

type TestModelProvider = {
  provider: string;
  models: readonly Model<Api>[];
  authenticated?: boolean;
};

interface TestModelRuntimeFixture {
  runtime: ModelRuntime;
  registry: ModelRegistry;
}

function createTestCredentialStore(providerIds: readonly string[]): CredentialStore {
  const credentials = new Map<string, Credential>(
    providerIds.map((providerId) => [providerId, { type: "api_key", key: "tlh-test-only" }]),
  );
  const tails = new Map<string, Promise<void>>();

  function enqueue<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(providerId) ?? Promise.resolve();
    const result = previous.then(operation);
    tails.set(
      providerId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  return {
    async read(providerId: string): Promise<Credential | undefined> {
      return credentials.get(providerId);
    },
    async list() {
      return [...credentials].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify(providerId, operation) {
      return enqueue(providerId, async () => {
        const next = await operation(credentials.get(providerId));
        if (next !== undefined) credentials.set(providerId, next);
        return credentials.get(providerId);
      });
    },
    delete(providerId) {
      return enqueue(providerId, async () => {
        credentials.delete(providerId);
      });
    },
  };
}

function createTestModelProvider(providerId: string, models: readonly Model<Api>[]): Provider {
  if (models.length === 0) throw new Error(`Test model provider ${providerId} needs a model`);
  if (models.some((model) => model.provider !== providerId)) {
    throw new Error(`Test model provider ${providerId} received a model from another provider`);
  }

  // The provider implementation is never called by these integration tests;
  // fauxProvider supplies a complete, typed hermetic stream owner so the
  // ModelRuntime/ModelRegistry remain real SDK instances without network I/O.
  const streamOwner = fauxProvider({ provider: `tlh-fixture-stream-${providerId}` });
  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl: models[0].baseUrl,
    auth: {
      apiKey: {
        name: "TLH test credential",
        resolve: async ({ credential }) =>
          credential?.type === "api_key" && credential.key
            ? { auth: { apiKey: credential.key }, source: "stored" }
            : undefined,
      },
    },
    models,
    api: {
      stream: streamOwner.provider.stream,
      streamSimple: streamOwner.provider.streamSimple,
    },
  });
}

async function createTestModelRuntimeFixture(
  providers: readonly TestModelProvider[],
): Promise<TestModelRuntimeFixture> {
  const authenticatedProviderIds = providers
    .filter((provider) => provider.authenticated !== false)
    .map((provider) => provider.provider);
  const runtime = await ModelRuntime.create({
    credentials: createTestCredentialStore(authenticatedProviderIds),
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registered = new Set<string>();
  for (const provider of providers) {
    if (registered.has(provider.provider)) {
      throw new Error(`Duplicate test model provider ${provider.provider}`);
    }
    registered.add(provider.provider);
    runtime.registerNativeProvider(createTestModelProvider(provider.provider, provider.models));
  }
  await runtime.refresh({ allowNetwork: false });
  return { runtime, registry: new ModelRegistry(runtime) };
}

/**
 * Builds a per-test real ModelRuntime/ModelRegistry pair with static models,
 * isolated in-memory credentials, and no network-capable refresh.
 */
export async function makeModelRegistryContext(
  cwd: string,
  providers: readonly TestModelProvider[],
): Promise<{ context: ExtensionContext; runtime: ModelRuntime; registry: ModelRegistry }> {
  const fixture = await createTestModelRuntimeFixture(providers);
  const context = makeMinimalCtx(cwd);
  context.modelRegistry = fixture.registry;
  return { context, ...fixture };
}

/**
 * Creates a minimal AsyncExecutionContext for tests of buildAsyncRunnerPlan
 * and executeAsyncSingle. The `pi` field receives a fresh,
 * isolated functional EventBus from makeExtensionAPI(); the tested code paths
 * only access pi.events.emit() and only after precondition guards that fire before pi is used.
 *
 * Typed from buildAsyncRunnerPlan's parameter context (AsyncExecutionContext) so that
 * newly required fields surface here rather than at each call site.
 */
type AsyncExecutionContext = Parameters<typeof buildAsyncRunnerPlan>[1]["ctx"];

export function makeAsyncCtx(
  cwd: string,
  overrides: Partial<AsyncExecutionContext> = {},
): AsyncExecutionContext {
  return {
    pi: makeExtensionAPI(),
    cwd,
    currentSessionId: "session-1",
    currentModel: undefined,
    currentModelProvider: undefined,
    modelScope: undefined,
    ...overrides,
  };
}

/**
 * Creates a complete no-UI context fixture from the upstream SDK contracts.
 * SessionManager and ModelRegistry are real owner instances; only their
 * externally observable test values are replaced.
 */
function createMinimalUiContext(): ExtensionUIContext {
  const ui: ExtensionUIContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>(_factory: unknown, _options?: unknown): Promise<T> => {
      throw new Error("test UI context does not support custom components");
    },
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: createPlainTheme(),
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "test UI context has no themes" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return ui;
}

/**
 * Creates a minimal ExtensionContext for test fixtures while preserving the
 * complete upstream SDK contracts at every nested boundary.
 */
export function makeMinimalCtx(cwd: string): ExtensionContext {
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.getSessionId = () => "session-123";
  sessionManager.getSessionFile = () => undefined;

  return {
    cwd,
    mode: "json",
    hasUI: false,
    ui: createMinimalUiContext(),
    sessionManager,
    modelRegistry: new ModelRegistry(testModelRuntime),
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
}

function isTestEventName(value: string): value is TestEventName {
  return (
    value === "tool_call" ||
    value === "session_start" ||
    value === "message_start" ||
    value === "message_update" ||
    value === "message_end" ||
    value === "tool_execution_start" ||
    value === "tool_execution_end" ||
    value === "turn_end" ||
    value === "session_shutdown" ||
    value === "context" ||
    value === "before_agent_start"
  );
}

type RegisteredExtensionHandler = (
  payload: TestEventPayload,
  context: ExtensionContext,
) => TestEventResult;

function isRegisteredExtensionHandler(value: unknown): value is RegisteredExtensionHandler {
  return typeof value === "function";
}

let testExtensionContext: ExtensionContext | undefined;
function getTestExtensionContext(): ExtensionContext {
  return (testExtensionContext ??= makeMinimalCtx(process.cwd()));
}

/**
 * Creates a complete, typed ExtensionAPI owner object with inert defaults.
 * Non-event overrides are checked against the upstream ExtensionAPI. The
 * overloaded `on` method is an explicit test-only adapter: it accepts only
 * runtime events exercised by these tests, narrows the registered value to a
 * callable handler, and records payload-only callbacks for direct invocation.
 */
export function makeExtensionAPI(overrides: ExtensionAPIOverrides = {}): ExtensionAPI {
  const { on: testOn, events: overrideEvents, ...extensionOverrides } = overrides;
  const on: ExtensionAPI["on"] = (event: string, handler: unknown): (() => void) => {
    if (!testOn || !isTestEventName(event)) return () => {};
    if (!isRegisteredExtensionHandler(handler)) return () => {};
    return testOn(event, (payload) => handler(payload, getTestExtensionContext()));
  };
  return {
    ...defaultExtensionAPI,
    ...extensionOverrides,
    on,
    events: overrideEvents ?? createEventBus(),
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
    return (await import(specifier)) as T;
  }
  const projectRoot = path.resolve(__dirname, "..", "..");
  const abs = path.resolve(projectRoot, specifier);
  const url = pathToFileURL(abs).href;
  return (await import(url)) as T;
}

export const events = {
  assistantMessage(
    text: string,
    model = "mock/test-model",
    stopReason: "stop" | "tool_use" = "stop",
  ): object {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        content:
          stopReason === "tool_use"
            ? [
                { type: "text", text },
                { type: "toolCall", name: "bash", arguments: { command: "echo test" } },
              ]
            : [{ type: "text", text }],
        model,
        stopReason,
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

  compactionStart(reason: "manual" | "threshold" | "overflow" = "manual"): object {
    return { type: "compaction_start", reason };
  },

  compactionEnd(
    reason: "manual" | "threshold" | "overflow" = "manual",
    options: { aborted?: boolean; willRetry?: boolean; errorMessage?: string } = {},
  ): object {
    return {
      type: "compaction_end",
      reason,
      aborted: options.aborted ?? false,
      willRetry: options.willRetry ?? false,
      ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    };
  },
};
