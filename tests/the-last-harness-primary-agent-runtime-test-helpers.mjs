import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
export const { TLH_DEFAULT_COMMIT_ATTRIBUTION } = await jiti.import(
  "../extensions/the-last-harness/attribution.ts",
);
export const { CI_FAILURE_INVESTIGATION_FEATURE, DELTA_FOLLOW_UP_REVIEWS_FEATURE } =
  await jiti.import("../extensions/the-last-harness/experimental.ts");
// Retained only as a stale-settings fixture value: the runtime no longer registers this feature.
export const EMBEDDED_SUBAGENTS_FEATURE = "embedded-subagents";
export const { registerTlhPrimaryAgentRuntime } = await jiti.import(
  "../extensions/the-last-harness/primary-agent-runtime.ts",
);
export const { normalizeAgentModelDefaults } = await jiti.import(
  "../extensions/the-last-harness/prompts.ts",
);

export function createPiHarness() {
  const commands = new Map();
  const shortcuts = new Map();
  // pi.events serves two roles in the harness:
  //   - Lifecycle registry (pi.on calls push here; test assertions use .find/.filter)
  //   - EventBus (pi.events.on / pi.events.emit for intercom channels like subagent:async-complete)
  // Making it a single object with both interfaces avoids breaking the many existing tests
  // that use pi.events.find(...) while allowing new tests to emit intercom events.
  const lifecycleHandlers = [];
  const eventBusSubscribers = new Map();
  const events = {
    // Array-like interface used by existing tests
    push(item) {
      lifecycleHandlers.push(item);
    },
    find(pred) {
      return lifecycleHandlers.find(pred);
    },
    filter(pred) {
      return lifecycleHandlers.filter(pred);
    },
    map(fn) {
      return lifecycleHandlers.map(fn);
    },
    some(pred) {
      return lifecycleHandlers.some(pred);
    },
    forEach(fn) {
      lifecycleHandlers.forEach(fn);
    },
    get length() {
      return lifecycleHandlers.length;
    },
    [Symbol.iterator]() {
      return lifecycleHandlers[Symbol.iterator]();
    },
    // EventBus interface used by subagent:async-complete subscriptions
    on(channel, handler) {
      if (!eventBusSubscribers.has(channel)) eventBusSubscribers.set(channel, []);
      eventBusSubscribers.get(channel).push(handler);
      return () => {
        const list = eventBusSubscribers.get(channel) ?? [];
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    emit(channel, data) {
      for (const h of eventBusSubscribers.get(channel) ?? []) h(data);
    },
  };
  return {
    events,
    commands,
    shortcuts,
    activeTools: [],
    allTools: [{ name: "subagent" }],
    thinkingLevel: "normal",
    on(name, handler) {
      this.events.push({ name, handler });
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerShortcut(name, options) {
      shortcuts.set(name, options);
    },
    getAllTools() {
      return this.allTools;
    },
    getActiveTools() {
      return this.activeTools;
    },
    setActiveTools(tools) {
      this.activeTools = tools;
    },
    async setModel(model) {
      this.model = model;
      return true;
    },
    getThinkingLevel() {
      return this.thinkingLevel;
    },
    setThinkingLevel(level) {
      this.thinkingLevel = level;
    },
    appendEntry() {},
  };
}

export function createToolCallContext(branchEntries = [], notifications, overrides = {}) {
  return {
    cwd: process.cwd(),
    sessionManager: { getBranch: () => branchEntries },
    ui: {
      notify(message, type = "info") {
        notifications?.push({ message, type });
      },
    },
    modelRegistry: {
      getAvailable: () => [
        {
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        },
      ],
    },
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    },
    ...overrides,
  };
}

export function registerRuntimeHarness(options = {}) {
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, { env: {}, ...options });
  const beforeAgentStart = pi.events.find((event) => event.name === "before_agent_start")?.handler;
  const toolCall = pi.events.find((event) => event.name === "tool_call")?.handler;
  assert.equal(typeof beforeAgentStart, "function");
  assert.equal(typeof toolCall, "function");
  const applySessionStart = (ctx) => runtime?.applySessionStart(ctx);
  return { pi, runtime, beforeAgentStart, toolCall, applySessionStart };
}

export function writePrimaryConfig(agentDir, primaryAgent = {}) {
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ tlh: { primaryAgent } }, null, 2)}\n`,
  );
}

function frontmatterModelFields(overrides) {
  const frontmatter = {};
  for (const key of [
    "model",
    "thinking",
    "tlhOpenaiModels",
    "tlhAnthropicModels",
    "tlhOpenaiThinking",
    "tlhAnthropicThinking",
    "tlhOpenrouterThinking",
  ]) {
    const value = overrides[key];
    if (Array.isArray(value)) {
      frontmatter[key] = value.join(",");
    } else if (typeof value === "string") {
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

export function createPrimaryPrompt(name, overrides = {}) {
  const normalized = normalizeAgentModelDefaults(
    frontmatterModelFields(overrides),
    overrides.tlhModelDefaults,
  );
  const {
    tlhOpenaiModels: _tlhOpenaiModels,
    tlhAnthropicModels: _tlhAnthropicModels,
    tlhOpenaiThinking: _tlhOpenaiThinking,
    tlhAnthropicThinking: _tlhAnthropicThinking,
    tlhOpenrouterThinking: _tlhOpenrouterThinking,
    ...withoutLegacyFields
  } = overrides;
  return {
    name,
    description: "Test primary",
    tools: ["subagent"],
    systemPrompt: "test",
    filePath: `agents/primary/${name}.md`,
    ...withoutLegacyFields,
    ...normalized,
    ...(overrides.preferredModel ? { preferredModel: overrides.preferredModel } : {}),
  };
}

export function selectablePrimaryAgents() {
  return new Map([
    ["architect", createPrimaryPrompt("architect")],
    ["rush", createPrimaryPrompt("rush")],
    ["product", createPrimaryPrompt("product")],
    ["bug-hunter", createPrimaryPrompt("bug-hunter")],
  ]);
}

export function contrarianMetadata() {
  return {
    name: "contrarian",
    description:
      "Stress-tests plans, designs, and conclusions by steelmanning the strongest opposing case.",
    tlhModelDefaults: [
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        effort: "high",
      },
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-opus-5" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "high" },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferOppositeProvider: true,
  };
}

export function rushLikePrimary(name = "architect") {
  return createPrimaryPrompt(name, {
    tlhModelDefaults: [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        effort: "low",
      },
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
        effort: "medium",
      },
      { provider: "openrouter", effort: "low" },
    ],
    preferredModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
    applyModel: true,
    applyThinking: true,
  });
}

export function createCommandContext(branchEntries = [], overrides = {}) {
  const notifications = [];
  return { notifications, ctx: createToolCallContext(branchEntries, notifications, overrides) };
}
