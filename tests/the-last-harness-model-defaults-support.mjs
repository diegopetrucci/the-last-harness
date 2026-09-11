import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const modelDefaults = await jiti.import("../extensions/the-last-harness/model-defaults.ts");
const { normalizeAgentModelDefaults } = await jiti.import(
  "../extensions/the-last-harness/prompts.ts",
);
const { findAvailableProviderModel, formatProviderModelReference, splitKnownThinkingSuffix } =
  modelDefaults;
const { getProviderAwareFallbackModels } =
  await import("../extensions/the-last-harness-subagent-safety.mjs");

function frontmatterModelFields(agent) {
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
    const value = agent[key];
    if (Array.isArray(value)) {
      frontmatter[key] = value.join(",");
    } else if (typeof value === "string") {
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

function normalizeAgentFixture(agent) {
  if (!agent) {
    return agent;
  }
  const {
    tlhOpenaiModels: _openaiModels,
    tlhAnthropicModels: _anthropicModels,
    tlhOpenaiThinking: _openaiThinking,
    tlhAnthropicThinking: _anthropicThinking,
    tlhOpenrouterThinking: _openrouterThinking,
    ...withoutLegacyFields
  } = agent;
  return {
    ...withoutLegacyFields,
    ...normalizeAgentModelDefaults(frontmatterModelFields(agent), agent.tlhModelDefaults),
  };
}

function normalizeAgents(agents) {
  return new Map([...agents].map(([name, agent]) => [name, normalizeAgentFixture(agent)]));
}

const { applyThinkingSuffix: applyRuntimeThinkingSuffix } = await jiti.import(
  "../extensions/subagents/src/runs/shared/pi-args.ts",
);

export function createModelDefaultsTestContext() {
  const applyProviderAwareSubagentModels = (input, agents, ...args) =>
    modelDefaults.applyProviderAwareSubagentModels(input, normalizeAgents(agents), ...args);
  const resolveProviderAwareSubagentResolution = (agent, ...args) =>
    modelDefaults.resolveProviderAwareSubagentResolution(normalizeAgentFixture(agent), ...args);
  const resolveProviderThinking = (agent, ...args) =>
    modelDefaults.resolveProviderThinking(normalizeAgentFixture(agent), ...args);
  const selectProviderAwareAgentDefaults = (agent, ...args) =>
    modelDefaults.selectProviderAwareAgentDefaults(normalizeAgentFixture(agent), ...args);

  const developer = {
    name: "developer",
    tlhModelDefaults: [
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
        effort: "max",
      },
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        effort: "medium",
      },
      {
        provider: "xai",
        models: [{ provider: "xai", id: "grok-4" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "medium" },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };

  const codeReviewer = {
    name: "code-reviewer",
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
      {
        provider: "xai",
        models: [{ provider: "xai", id: "grok-4" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "high" },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferOppositeProvider: true,
  };

  const oracle = {
    name: "oracle",
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
      {
        provider: "xai",
        models: [{ provider: "xai", id: "grok-4" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "high" },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferOppositeProvider: true,
  };

  const anthropicParentPrefersCodexReviewer = {
    name: "anthropic-parent-prefers-codex-reviewer",
    model: "anthropic/claude-opus-5",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhAnthropicModels: ["anthropic/claude-opus-5"],
    preferOppositeProvider: true,
  };

  const openaiParentPrefersAnthropicReviewer = {
    name: "openai-parent-prefers-anthropic-reviewer",
    model: "openai-codex/gpt-5.6-sol",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhAnthropicModels: ["anthropic/claude-opus-5"],
    preferOppositeProvider: true,
  };

  const rushLikePrimary = {
    name: "rush",
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
    tlhModelDefaultsSource: "frontmatter",
    preferredModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
    preferCurrentOpenaiModel: true,
  };

  const anthropicFirstPrimary = {
    ...rushLikePrimary,
    name: "architect",
    preferCurrentOpenaiModel: undefined,
  };

  const productPrimary = {
    name: "product",
    tlhModelDefaults: [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-opus-5" }],
        effort: "high",
      },
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "high" },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferredModel: { provider: "anthropic", id: "claude-opus-5" },
  };

  const bugHunterPrimary = {
    name: "bug-hunter",
    tlhModelDefaults: [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-opus-5" }],
        effort: "high",
      },
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        effort: "high",
      },
      { provider: "openrouter", effort: "high" },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferredModel: { provider: "anthropic", id: "claude-opus-5" },
  };

  const agents = new Map([
    [developer.name, developer],
    [codeReviewer.name, codeReviewer],
    [oracle.name, oracle],
  ]);

  const anthropicAvailable = [
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-opus-5" },
  ];

  const codexAvailable = [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];

  const openaiAvailable = [{ provider: "openai", id: "gpt-5.6" }];

  const xaiAvailable = [{ provider: "xai", id: "grok-4" }];

  const reasoningAnthropicAvailable = anthropicAvailable.map((model) => ({
    ...model,
    reasoning: true,
  }));
  const reasoningCodexAvailable = codexAvailable.map((model) => ({ ...model, reasoning: true }));
  const reasoningOpenaiAvailable = [{ provider: "openai", id: "gpt-5.6", reasoning: true }];

  const reducedIndependenceNotice =
    "TLH fell back to a same-provider review model; review independence is reduced.";

  function selectedProviderModelId(agent, availableModels, currentProvider) {
    const model = selectProviderAwareAgentDefaults(agent, availableModels, currentProvider).model;
    return model ? formatProviderModelReference(model) : undefined;
  }

  return {
    applyProviderAwareSubagentModels,
    applyRuntimeThinkingSuffix,
    anthropicAvailable,
    anthropicFirstPrimary,
    anthropicParentPrefersCodexReviewer,
    agents,
    bugHunterPrimary,
    codeReviewer,
    codexAvailable,
    developer,
    findAvailableProviderModel,
    formatProviderModelReference,
    getProviderAwareFallbackModels,
    openaiAvailable,
    openaiParentPrefersAnthropicReviewer,
    oracle,
    productPrimary,
    reasoningAnthropicAvailable,
    reasoningCodexAvailable,
    reasoningOpenaiAvailable,
    reducedIndependenceNotice,
    resolveProviderAwareSubagentResolution,
    resolveProviderThinking,
    rushLikePrimary,
    selectedProviderModelId,
    xaiAvailable,
    selectProviderAwareAgentDefaults,
    splitKnownThinkingSuffix,
  };
}
