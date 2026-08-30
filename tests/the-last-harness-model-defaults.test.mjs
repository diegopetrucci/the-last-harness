import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const modelDefaults = await jiti.import("../extensions/the-last-harness/model-defaults.ts");
const { normalizeAgentModelDefaults } = await jiti.import(
  "../extensions/the-last-harness/prompts.ts",
);
const { findAvailableProviderModel, formatProviderModelReference, splitKnownThinkingSuffix } =
  modelDefaults;

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

const applyProviderAwareSubagentModels = (input, agents, ...args) =>
  modelDefaults.applyProviderAwareSubagentModels(input, normalizeAgents(agents), ...args);
const resolveProviderAwareSubagentResolution = (agent, ...args) =>
  modelDefaults.resolveProviderAwareSubagentResolution(normalizeAgentFixture(agent), ...args);
const resolveProviderThinking = (agent, ...args) =>
  modelDefaults.resolveProviderThinking(normalizeAgentFixture(agent), ...args);
const selectProviderAwareAgentDefaults = (agent, ...args) =>
  modelDefaults.selectProviderAwareAgentDefaults(normalizeAgentFixture(agent), ...args);
const { applyThinkingSuffix: applyRuntimeThinkingSuffix } = await jiti.import(
  "../extensions/subagents/src/runs/shared/pi-args.ts",
);

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

const reducedIndependenceNotice =
  "TLH fell back to a same-provider review model; review independence is reduced.";

function selectedProviderModelId(agent, availableModels, currentProvider) {
  const model = selectProviderAwareAgentDefaults(agent, availableModels, currentProvider).model;
  return model ? formatProviderModelReference(model) : undefined;
}

test("provider-aware model resolver follows active Anthropic provider for non-review subagents", () => {
  assert.equal(
    selectedProviderModelId(developer, anthropicAvailable, "anthropic"),
    "anthropic/claude-sonnet-4-6",
  );

  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, anthropicAvailable, "anthropic"), 1);
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
});

test("provider-aware model resolver follows ordered candidates for an active custom provider", () => {
  const customProviderAgent = {
    name: "custom-provider-developer",
    tlhModelDefaults: [
      {
        provider: "google",
        models: [
          { provider: "google", id: "gemini-unavailable" },
          { provider: "google", id: "gemini-available" },
        ],
        effort: "high",
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };
  const customAgents = new Map([[customProviderAgent.name, customProviderAgent]]);
  const available = [
    { provider: "google", id: "gemini-available" },
    { provider: "openai-codex", id: "gpt-family-fallback" },
  ];

  assert.equal(
    selectedProviderModelId(customProviderAgent, available, "google"),
    "google/gemini-available",
  );
  const input = { agent: customProviderAgent.name, task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(input, customAgents, available, "google"), 1);
  assert.equal(input.model, "google/gemini-available:high");
});

test("provider-aware model resolver does not use custom defaults for unrelated providers", () => {
  const customProviderAgent = {
    name: "custom-provider-only",
    tlhModelDefaults: [
      {
        provider: "google",
        models: [{ provider: "google", id: "gemini-available" }],
        effort: "high",
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };
  const customAgents = new Map([[customProviderAgent.name, customProviderAgent]]);
  const available = [{ provider: "google", id: "gemini-available" }];

  for (const currentProvider of ["anthropic", "unrelated-provider"]) {
    assert.equal(
      selectedProviderModelId(customProviderAgent, available, currentProvider),
      undefined,
    );
    const input = { agent: customProviderAgent.name, task: "Implement the ticket" };
    assert.equal(
      applyProviderAwareSubagentModels(input, customAgents, available, currentProvider),
      0,
    );
    assert.equal(input.model, undefined);
  }

  const oppositeAgent = {
    ...customProviderAgent,
    name: "custom-provider-reviewer",
    preferOppositeProvider: true,
  };
  const oppositeInput = { agent: oppositeAgent.name, task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      oppositeInput,
      new Map([[oppositeAgent.name, oppositeAgent]]),
      available,
      "google",
    ),
    0,
  );
  assert.equal(oppositeInput.model, undefined);
});

test("provider-aware model resolver follows active provider for non-review subagents when both providers are available", () => {
  const available = [...anthropicAvailable, ...codexAvailable];

  // OpenAI-Codex is active → picks codex model, not Anthropic (the key fix)
  assert.equal(
    selectedProviderModelId(developer, available, "openai-codex"),
    "openai-codex/gpt-5.6-luna",
  );
  const codexInput = { agent: "developer", task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(codexInput, agents, available, "openai-codex"), 1);
  assert.equal(codexInput.model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(Object.hasOwn(codexInput, "thinking"), false);

  // Anthropic is active → picks Anthropic model
  assert.equal(
    selectedProviderModelId(developer, available, "anthropic"),
    "anthropic/claude-sonnet-4-6",
  );
  const anthropicInput = { agent: "developer", task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(anthropicInput, agents, available, "anthropic"), 1);
  assert.equal(anthropicInput.model, "anthropic/claude-sonnet-4-6:medium");
  assert.equal(Object.hasOwn(anthropicInput, "thinking"), false);
});

test("provider-aware model resolver picks OpenAI Codex when Anthropic is unavailable", () => {
  assert.equal(
    selectedProviderModelId(developer, codexAvailable, "openai-codex"),
    "openai-codex/gpt-5.6-luna",
  );

  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
  assert.equal(input.model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(Object.hasOwn(input, "thinking"), false);
});

test("provider-aware model resolver does not auto-inject OpenAI API models", () => {
  const input = { agent: "code-reviewer", task: "Review the diff" };
  assert.equal(selectedProviderModelId(codeReviewer, openaiAvailable, "openai"), undefined);
  assert.equal(applyProviderAwareSubagentModels(input, agents, openaiAvailable, "openai"), 0);
  assert.equal(input.model, undefined);
});

test("provider-aware model resolver keeps Codex defaults even when regular OpenAI models are also available", () => {
  const available = [...codexAvailable, ...openaiAvailable];
  assert.equal(
    selectedProviderModelId(developer, available, "openai"),
    "openai-codex/gpt-5.6-luna",
  );
  assert.equal(
    selectedProviderModelId(developer, available, "openai-codex"),
    "openai-codex/gpt-5.6-luna",
  );
});

test("provider-aware opposite-provider preference picks Codex for opted-in Anthropic-session reviewers", () => {
  const available = [...anthropicAvailable, ...codexAvailable];
  const agents = new Map([
    [anthropicParentPrefersCodexReviewer.name, anthropicParentPrefersCodexReviewer],
  ]);

  assert.equal(
    selectedProviderModelId(anthropicParentPrefersCodexReviewer, available, "anthropic"),
    "openai-codex/gpt-5.6-sol",
  );

  const input = { agent: anthropicParentPrefersCodexReviewer.name, task: "Review the diff" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, available, "anthropic"), 1);
  assert.equal(input.model, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5"]);
  assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware opposite-provider preference picks Anthropic for opted-in OpenAI-family reviewers", () => {
  const available = [...anthropicAvailable, ...codexAvailable];
  const agents = new Map([
    [openaiParentPrefersAnthropicReviewer.name, openaiParentPrefersAnthropicReviewer],
  ]);

  assert.equal(
    selectedProviderModelId(openaiParentPrefersAnthropicReviewer, available, "openai"),
    "anthropic/claude-opus-5",
  );
  assert.equal(
    selectedProviderModelId(openaiParentPrefersAnthropicReviewer, available, "openai-codex"),
    "anthropic/claude-opus-5",
  );

  const input = { agent: openaiParentPrefersAnthropicReviewer.name, task: "Review the diff" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, available, "openai-codex"), 1);
  assert.equal(input.model, "anthropic/claude-opus-5");
  assert.deepEqual(input.fallbackModels, ["openai-codex/gpt-5.6-sol"]);
  assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware opposite-provider preference does not inject regular OpenAI API models for opted-in Anthropic sessions", () => {
  const agents = new Map([
    [anthropicParentPrefersCodexReviewer.name, anthropicParentPrefersCodexReviewer],
  ]);
  const input = { agent: anthropicParentPrefersCodexReviewer.name, task: "Review the diff" };

  assert.equal(
    selectedProviderModelId(anthropicParentPrefersCodexReviewer, openaiAvailable, "anthropic"),
    undefined,
  );
  assert.equal(applyProviderAwareSubagentModels(input, agents, openaiAvailable, "anthropic"), 0);
  assert.equal(input.model, undefined);
});

test("provider-aware subagent mutation gives code-reviewer the opposite available provider with same-provider fallback", () => {
  const available = [...anthropicAvailable, ...codexAvailable];

  const anthropicInput = { agent: "code-reviewer" };
  assert.equal(applyProviderAwareSubagentModels(anthropicInput, agents, available, "anthropic"), 1);
  assert.equal(anthropicInput.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(anthropicInput.fallbackModels, ["anthropic/claude-opus-5:high"]);
  assert.equal(anthropicInput.modelFallbackNotice, reducedIndependenceNotice);

  const codexInput = { agent: "code-reviewer" };
  assert.equal(applyProviderAwareSubagentModels(codexInput, agents, available, "openai-codex"), 1);
  assert.equal(codexInput.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(codexInput.fallbackModels, ["openai-codex/gpt-5.6-sol:high"]);
  assert.equal(codexInput.modelFallbackNotice, reducedIndependenceNotice);

  const noOppositeInput = { agent: "code-reviewer" };
  assert.equal(
    applyProviderAwareSubagentModels(noOppositeInput, agents, openaiAvailable, "anthropic"),
    0,
  );
  assert.equal(Object.hasOwn(noOppositeInput, "model"), false);
  assert.equal(Object.hasOwn(noOppositeInput, "fallbackModels"), false);
  assert.equal(Object.hasOwn(noOppositeInput, "modelFallbackNotice"), false);
});

// Reconcile intentionally does not drift-check these dynamic OpenRouter candidates: OpenRouter
// has no packaged frontmatter model entries to reconcile against.
test("provider-aware OpenRouter opposite roles use vendor-aware direct candidates and session fallback", () => {
  const openrouterReviewer = {
    name: "openrouter-reviewer",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhAnthropicModels: ["anthropic/claude-opus-5"],
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "medium",
    tlhOpenrouterThinking: "low",
    preferOppositeProvider: true,
  };
  const openrouterAgents = new Map([[openrouterReviewer.name, openrouterReviewer]]);
  const available = [...anthropicAvailable, ...codexAvailable];
  const neutralNotice = "TLH fell back to the session model; review independence is reduced.";

  const anthropicSession = { agent: openrouterReviewer.name };
  assert.equal(
    applyProviderAwareSubagentModels(anthropicSession, openrouterAgents, available, "openrouter", {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4-6",
    }),
    1,
  );
  assert.equal(anthropicSession.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(anthropicSession.fallbackModels, ["openrouter/anthropic/claude-sonnet-4-6:low"]);
  assert.equal(anthropicSession.modelFallbackNotice, neutralNotice);
  assert.equal(
    resolveProviderAwareSubagentResolution(openrouterReviewer, available, "openrouter", {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4-6",
    }).independence,
    "preferred",
  );

  const openaiSession = { agent: openrouterReviewer.name };
  assert.equal(
    applyProviderAwareSubagentModels(openaiSession, openrouterAgents, available, "openrouter", {
      provider: "openrouter",
      id: "openai/gpt-5.6",
    }),
    1,
  );
  assert.equal(openaiSession.model, "anthropic/claude-opus-5:medium");
  assert.deepEqual(openaiSession.fallbackModels, ["openrouter/openai/gpt-5.6:low"]);

  const unknownSession = { agent: openrouterReviewer.name };
  assert.equal(
    applyProviderAwareSubagentModels(unknownSession, openrouterAgents, available, "openrouter", {
      provider: "openrouter",
      id: "google/gemini-2.5",
    }),
    1,
  );
  assert.equal(unknownSession.model, "openai-codex/gpt-5.6-sol:high");
  assert.equal(
    resolveProviderAwareSubagentResolution(openrouterReviewer, available, "openrouter", {
      provider: "openrouter",
      id: "google/gemini-2.5",
    }).independence,
    "unknown",
  );

  const anthropicOnly = { agent: openrouterReviewer.name };
  assert.equal(
    applyProviderAwareSubagentModels(
      anthropicOnly,
      openrouterAgents,
      anthropicAvailable,
      "openrouter",
      { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" },
    ),
    1,
  );
  const resolution = resolveProviderAwareSubagentResolution(
    openrouterReviewer,
    anthropicAvailable,
    "openrouter",
    { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" },
  );
  assert.equal(resolution.independence, "degraded");
});

test("OpenRouter opposite fallback omits generic thinking while direct candidate keeps provider thinking", () => {
  const agent = {
    name: "openrouter-opposite-no-fallback-thinking",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhAnthropicModels: ["anthropic/claude-opus-5"],
    tlhOpenaiThinking: "high",
    thinking: "low",
    preferOppositeProvider: true,
  };
  const currentModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" };
  const resolution = resolveProviderAwareSubagentResolution(
    agent,
    [...anthropicAvailable, ...codexAvailable],
    "openrouter",
    currentModel,
  );

  assert.equal(resolution.model, codexAvailable[1]);
  assert.equal(resolution.thinking, "high");
  assert.deepEqual(resolution.fallbackModels, [{ model: currentModel, thinking: undefined }]);
});

test("OpenRouter registry-missing fallback preserves stored effort and distinguishes unknown from unsupported", () => {
  const openrouterReviewer = {
    name: "openrouter-reviewer-effort",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhAnthropicModels: ["anthropic/claude-opus-5"],
    preferOppositeProvider: true,
  };
  const openrouterAgents = new Map([[openrouterReviewer.name, openrouterReviewer]]);
  const directCandidates = [...reasoningCodexAvailable, ...reasoningAnthropicAvailable];
  const currentModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" };
  const warnings = [];
  const input = { agent: openrouterReviewer.name, task: "Review" };

  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      openrouterAgents,
      directCandidates,
      "openrouter",
      currentModel,
      {
        agentOverrides: new Map([[openrouterReviewer.name, { thinking: "high" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(input.fallbackModels, ["openrouter/anthropic/claude-sonnet-4-6:high"]);
  assert.equal(
    input.modelFallbackNotice,
    "TLH fell back to the session model; review independence is reduced.",
  );
  assert.deepEqual(warnings, []);

  const resolution = resolveProviderAwareSubagentResolution(
    openrouterReviewer,
    directCandidates,
    "openrouter",
    currentModel,
    { thinking: "high" },
  );
  assert.equal(resolution.thinking, "high");
  assert.equal(resolution.fallbackModels[0].thinking, "high");
  assert.equal(resolution.warning, undefined);
  assert.equal(resolution.fallbackWarning, undefined);

  const unsupportedCurrentModel = { ...currentModel, reasoning: false };
  const unsupportedResolution = resolveProviderAwareSubagentResolution(
    openrouterReviewer,
    directCandidates,
    "openrouter",
    unsupportedCurrentModel,
    { thinking: "high" },
  );
  assert.equal(unsupportedResolution.thinking, "high");
  assert.equal(unsupportedResolution.fallbackModels[0].thinking, "off");
  assert.equal(
    unsupportedResolution.fallbackWarning,
    'TLH stored minor-agent effort "high" is not supported by generated fallback openrouter/anthropic/claude-sonnet-4-6; that fallback will use explicit off for this run.',
  );
});

test("provider-aware subagent mutation gives code-reviewer and oracle current-session model fallback first", () => {
  const available = [...anthropicAvailable, ...codexAvailable];

  const reviewerInput = { agent: "code-reviewer" };
  assert.equal(
    applyProviderAwareSubagentModels(reviewerInput, agents, available, "anthropic", {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    }),
    1,
  );
  assert.equal(reviewerInput.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(reviewerInput.fallbackModels, ["anthropic/claude-sonnet-4-6:high"]);
  assert.equal(reviewerInput.modelFallbackNotice, reducedIndependenceNotice);

  const oracleInput = { agent: "oracle" };
  assert.equal(
    applyProviderAwareSubagentModels(oracleInput, agents, available, "openai-codex", {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    }),
    1,
  );
  assert.equal(oracleInput.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(oracleInput.fallbackModels, ["openai-codex/gpt-5.6-luna:high"]);
  assert.equal(oracleInput.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware primary defaults switch Rush-like thinking to the bundled Codex level", () => {
  assert.deepEqual(
    selectProviderAwareAgentDefaults(rushLikePrimary, codexAvailable, "openai-codex"),
    {
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinking: "medium",
    },
  );
  assert.deepEqual(
    selectProviderAwareAgentDefaults(
      rushLikePrimary,
      [...codexAvailable, ...openaiAvailable],
      "openai",
    ),
    {
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinking: "medium",
    },
  );
});

test("provider-aware primary defaults keep Anthropic when regular OpenAI is available without bundled Codex", () => {
  const mixedOpenaiAvailable = [...anthropicAvailable, ...openaiAvailable];

  assert.deepEqual(
    selectProviderAwareAgentDefaults(rushLikePrimary, mixedOpenaiAvailable, "openai"),
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      thinking: "low",
    },
  );
});

test("provider-aware primary defaults keep the Anthropic default first without the Rush-only opt-in", () => {
  const mixedCodexAvailable = [...anthropicAvailable, ...codexAvailable];
  const mixedOpenaiAvailable = [...anthropicAvailable, ...openaiAvailable];

  assert.deepEqual(
    selectProviderAwareAgentDefaults(anthropicFirstPrimary, mixedCodexAvailable, "openai-codex"),
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      thinking: "low",
    },
  );
  assert.deepEqual(
    selectProviderAwareAgentDefaults(anthropicFirstPrimary, mixedOpenaiAvailable, "openai"),
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      thinking: "low",
    },
  );
});

test("Product and Bug-hunter retain their provider-aware packaged defaults", () => {
  for (const primary of [productPrimary, bugHunterPrimary]) {
    assert.deepEqual(selectProviderAwareAgentDefaults(primary, anthropicAvailable, "anthropic"), {
      model: { provider: "anthropic", id: "claude-opus-5" },
      thinking: "high",
    });
    assert.deepEqual(selectProviderAwareAgentDefaults(primary, codexAvailable, "openai-codex"), {
      model: { provider: "openai-codex", id: "gpt-5.6-sol" },
      thinking: "high",
    });
  }
});

test("provider-aware primary defaults retain each declared provider effort", () => {
  assert.deepEqual(
    selectProviderAwareAgentDefaults(rushLikePrimary, anthropicAvailable, "openai-codex"),
    {
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
      thinking: "low",
    },
  );
  assert.deepEqual(
    selectProviderAwareAgentDefaults(rushLikePrimary, codexAvailable, "openai-codex"),
    {
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
      thinking: "medium",
    },
  );
});

test("new provider entries do not inherit generic thinking when effort is omitted", () => {
  const agent = {
    name: "new-format",
    model: "anthropic/legacy-model",
    thinking: "high",
    tlhModelDefaults: [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-new" }],
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };
  const available = [{ provider: "anthropic", id: "claude-new" }];
  assert.deepEqual(selectProviderAwareAgentDefaults(agent, available, "anthropic"), {
    model: available[0],
    thinking: undefined,
  });
  const input = { agent: agent.name, task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(input, new Map([[agent.name, agent]]), available, "anthropic"),
    1,
  );
  assert.equal(input.model, "anthropic/claude-new");
});

test("a present provider block does not supplement an unmatched provider with generic model or thinking", () => {
  const agent = {
    name: "new-format-only-openai",
    model: "anthropic/legacy-model",
    thinking: "high",
    tlhModelDefaults: [
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-new" }],
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };
  const available = [{ provider: "anthropic", id: "claude-legacy" }];
  assert.deepEqual(selectProviderAwareAgentDefaults(agent, available, "anthropic"), {
    model: undefined,
    thinking: undefined,
  });
  const input = { agent: agent.name, task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(input, new Map([[agent.name, agent]]), available, "anthropic"),
    0,
  );
  assert.equal(input.model, undefined);
});

test("legacy-normalized generic thinking still applies when no provider entry matches", () => {
  const agent = {
    name: "legacy-generic",
    thinking: "medium",
    tlhOpenaiModels: ["openai-codex/gpt-legacy"],
  };
  const available = [{ provider: "anthropic", id: "claude-current" }];
  assert.equal(selectProviderAwareAgentDefaults(agent, available, "anthropic").thinking, "medium");
});

// --- legacy provider model compatibility tests ---

test("tlhAnthropicModels: selects Anthropic fallback when primary OpenAI model is absent from registry", () => {
  const agentWithAnthropicFallback = {
    name: "test-agent",
    model: "openai/gpt-5.6",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  };
  // No currentProvider given — iterates tlhAnthropicModels and finds the Anthropic model
  assert.equal(
    selectedProviderModelId(agentWithAnthropicFallback, anthropicAvailable, undefined),
    "anthropic/claude-sonnet-4-6",
  );
  // Same result when currentProvider is explicitly "anthropic"
  assert.equal(
    selectedProviderModelId(agentWithAnthropicFallback, anthropicAvailable, "anthropic"),
    "anthropic/claude-sonnet-4-6",
  );
});

test("tlhAnthropicModels: current-provider Anthropic candidate preferred on Anthropic session", () => {
  const agentWithBothFallbacks = {
    name: "test-agent",
    model: "openai/gpt-5.6",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    tlhAnthropicModels: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-4-6"],
  };
  // currentProvider="anthropic": step-2 current-provider check picks first matching entry
  assert.equal(
    selectedProviderModelId(agentWithBothFallbacks, anthropicAvailable, "anthropic"),
    "anthropic/claude-opus-5",
  );
  // When only the second candidate is available the fallback iteration finds it
  const sonetOnly = [{ provider: "anthropic", id: "claude-sonnet-4-6" }];
  assert.equal(
    selectedProviderModelId(agentWithBothFallbacks, sonetOnly, "anthropic"),
    "anthropic/claude-sonnet-4-6",
  );
});

test("tlhAnthropicModels: regression – agents with only tlhOpenaiModels are unaffected", () => {
  const agentOpenaiOnly = {
    name: "openai-only",
    model: "openai/gpt-5.6",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    // no tlhAnthropicModels
  };
  // Codex available: selects the OpenAI fallback
  assert.equal(
    selectedProviderModelId(agentOpenaiOnly, codexAvailable, "openai-codex"),
    "openai-codex/gpt-5.6-luna",
  );
  // Anthropic-only environment: no tlhAnthropicModels declared → returns undefined
  assert.equal(
    selectedProviderModelId(agentOpenaiOnly, anthropicAvailable, "anthropic"),
    undefined,
  );
  // applyProviderAwareSubagentModels: developer still gets the provider-aware Codex default.
  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
  assert.equal(input.model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(Object.hasOwn(input, "thinking"), false);
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
  assert.equal(Object.hasOwn(input, "modelFallbackNotice"), false);
});

test("legacy provider lists do not treat generic model as an opposite candidate and still generate explicit-list fallback", () => {
  const agent = {
    name: "legacy-opposite-order",
    model: "openai-codex/gpt-generic",
    tlhOpenaiModels: ["openai-codex/gpt-review"],
    tlhAnthropicModels: ["anthropic/claude-same"],
    preferOppositeProvider: true,
  };
  const available = [
    { provider: "openai-codex", id: "gpt-generic" },
    { provider: "openai-codex", id: "gpt-review" },
    { provider: "anthropic", id: "claude-same" },
  ];
  const currentModel = available[2];
  const resolution = resolveProviderAwareSubagentResolution(
    agent,
    available,
    "anthropic",
    currentModel,
  );

  assert.deepEqual(resolution.model, available[1]);
  assert.deepEqual(resolution.fallbackModels, [{ model: currentModel, thinking: undefined }]);
  assert.equal(resolution.modelFallbackNotice, reducedIndependenceNotice);
});

test("provider-aware subagent mutation preserves explicit user-supplied model values", () => {
  const input = { agent: "developer", task: "Implement the ticket", model: "openai/gpt-5.6" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
  assert.equal(input.model, "openai/gpt-5.6");
});

test("provider-aware subagent mutation preserves caller-supplied thinking", () => {
  const input = { agent: "developer", task: "Implement the ticket", thinking: "high" };
  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
  assert.equal(input.model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(input.thinking, "high");
});

test("provider-aware subagent mutation injects model but preserves caller-supplied fallback fields", () => {
  const available = [...anthropicAvailable, ...codexAvailable];

  // Caller supplies fallbackModels but no model → opposite-provider model is injected,
  // caller-provided fallbackModels kept, TLH auto-adds modelFallbackNotice.
  const withFallbackModels = { agent: "code-reviewer", fallbackModels: ["custom/provider-model"] };
  assert.equal(
    applyProviderAwareSubagentModels(withFallbackModels, agents, available, "anthropic"),
    1,
  );
  assert.equal(withFallbackModels.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(withFallbackModels.fallbackModels, ["custom/provider-model"]);
  assert.equal(withFallbackModels.modelFallbackNotice, reducedIndependenceNotice);

  // Caller supplies modelFallbackNotice but no model → opposite-provider model is injected,
  // TLH auto-adds fallbackModels, caller-provided modelFallbackNotice kept.
  const withFallbackNotice = { agent: "oracle", modelFallbackNotice: "custom fallback notice" };
  assert.equal(
    applyProviderAwareSubagentModels(withFallbackNotice, agents, available, "openai-codex"),
    1,
  );
  assert.equal(withFallbackNotice.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(withFallbackNotice.fallbackModels, ["openai-codex/gpt-5.6-sol:high"]);
  assert.equal(withFallbackNotice.modelFallbackNotice, "custom fallback notice");

  // Explicit model still prevents all injection regardless of other fallback fields.
  const withExplicitModel = {
    agent: "code-reviewer",
    model: "anthropic/claude-sonnet-4-6",
    fallbackModels: ["my/fallback"],
  };
  assert.equal(
    applyProviderAwareSubagentModels(withExplicitModel, agents, available, "anthropic"),
    0,
  );
  assert.equal(withExplicitModel.model, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(withExplicitModel.fallbackModels, ["my/fallback"]);
});

test("provider-aware subagent mutation handles parallel tasks", () => {
  const input = {
    tasks: [
      { agent: "developer", task: "Implement" },
      { agent: "code-reviewer", task: "Review", model: "anthropic/claude-sonnet-4-6" },
      { agent: "unknown", task: "Leave alone" },
    ],
  };

  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 1);
  assert.equal(input.tasks[0].model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(input.tasks[1].model, "anthropic/claude-sonnet-4-6");
  assert.equal(input.tasks[2].model, undefined);
});

test("provider-aware subagent mutation ignores legacy chain payloads", () => {
  const input = {
    chain: [
      { agent: "developer", task: "Implement {task}" },
      {
        parallel: [
          { agent: "code-reviewer", task: "Review {previous}" },
          { agent: "developer", task: "Smoke test {previous}", model: "openai/gpt-5.6" },
        ],
      },
    ],
  };

  assert.equal(applyProviderAwareSubagentModels(input, agents, codexAvailable, "openai-codex"), 0);
  assert.equal(input.chain[0].model, undefined);
  assert.equal(input.chain[1].parallel[0].model, undefined);
  assert.equal(input.chain[1].parallel[1].model, "openai/gpt-5.6");
});

// --- tlhAnthropicThinking: model suffix injection (ticket tlhm-r6b8) ---

const developerWithAnthropicThinking = {
  name: "developer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  thinking: "low",
  tlhOpenaiThinking: "max",
  tlhAnthropicThinking: "medium",
};

const reviewerWithThinking = {
  name: "reviewer-with-thinking",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  tlhOpenaiThinking: "max",
  tlhAnthropicThinking: "medium",
  preferOppositeProvider: true,
};

test("tlhAnthropicThinking: resolveThinkingForProvider picks Anthropic level for Anthropic session", () => {
  const result = selectProviderAwareAgentDefaults(
    developerWithAnthropicThinking,
    anthropicAvailable,
    "anthropic",
  );
  assert.deepEqual(result, {
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    thinking: "medium",
  });
});

test("tlhAnthropicThinking: resolveThinkingForProvider picks OpenAI level for OpenAI-Codex session", () => {
  const result = selectProviderAwareAgentDefaults(
    developerWithAnthropicThinking,
    codexAvailable,
    "openai-codex",
  );
  assert.deepEqual(result, {
    model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    thinking: "max",
  });
});

test("tlhAnthropicThinking: falls back to agent.thinking when neither provider-specific field is set", () => {
  const agentFallbackOnly = {
    name: "fallback-only",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    thinking: "low",
  };
  const result = selectProviderAwareAgentDefaults(
    agentFallbackOnly,
    anthropicAvailable,
    "anthropic",
  );
  assert.deepEqual(result, {
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    thinking: "low",
  });
});

test("tlhAnthropicThinking: 'max' suffix round-trips correctly through model string injection", () => {
  const agentMaxAnthropicThinking = {
    name: "dev-max-anthropic",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    tlhAnthropicThinking: "max",
  };
  const agentsMap = new Map([[agentMaxAnthropicThinking.name, agentMaxAnthropicThinking]]);
  const input = { agent: agentMaxAnthropicThinking.name, task: "Do something" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agentsMap, anthropicAvailable, "anthropic"),
    1,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:max");
  // The target must NOT have a separate 'thinking' property injected by TLH.
  assert.equal(Object.hasOwn(input, "thinking"), false);
});

test("tlhAnthropicThinking: injects suffixed model string for Anthropic session", () => {
  const agentsMap = new Map([
    [developerWithAnthropicThinking.name, developerWithAnthropicThinking],
  ]);
  const input = { agent: developerWithAnthropicThinking.name, task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agentsMap, anthropicAvailable, "anthropic"),
    1,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
  assert.equal(Object.hasOwn(input, "thinking"), false);
});

test("tlhAnthropicThinking: injects suffixed model string for OpenAI-Codex session", () => {
  const agentsMap = new Map([
    [developerWithAnthropicThinking.name, developerWithAnthropicThinking],
  ]);
  const input = { agent: developerWithAnthropicThinking.name, task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agentsMap, codexAvailable, "openai-codex"),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-luna:max");
  assert.equal(Object.hasOwn(input, "thinking"), false);
});

test("tlhAnthropicThinking: opposite-provider fallback carries the fallback provider's thinking level", () => {
  const available = [...anthropicAvailable, ...codexAvailable];
  const agentsMap = new Map([[reviewerWithThinking.name, reviewerWithThinking]]);

  // Anthropic session → primary is Codex (opposite) with OpenAI thinking,
  // fallback is Anthropic (same) with Anthropic thinking.
  const anthropicInput = { agent: reviewerWithThinking.name, task: "Review" };
  assert.equal(
    applyProviderAwareSubagentModels(anthropicInput, agentsMap, available, "anthropic"),
    1,
  );
  assert.equal(anthropicInput.model, "openai-codex/gpt-5.6-sol:max");
  assert.deepEqual(anthropicInput.fallbackModels, ["anthropic/claude-opus-5:medium"]);
  assert.equal(anthropicInput.modelFallbackNotice, reducedIndependenceNotice);

  // Codex session → primary is Anthropic (opposite) with Anthropic thinking,
  // fallback is Codex (same) with OpenAI thinking.
  const codexInput = { agent: reviewerWithThinking.name, task: "Review" };
  assert.equal(
    applyProviderAwareSubagentModels(codexInput, agentsMap, available, "openai-codex"),
    1,
  );
  assert.equal(codexInput.model, "anthropic/claude-opus-5:medium");
  assert.deepEqual(codexInput.fallbackModels, ["openai-codex/gpt-5.6-sol:max"]);
  assert.equal(codexInput.modelFallbackNotice, reducedIndependenceNotice);
});

test("tlhAnthropicThinking: no thinking suffix when thinking is undefined for agent", () => {
  const agentNoThinking = {
    name: "no-thinking",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  };
  const agentsMap = new Map([[agentNoThinking.name, agentNoThinking]]);
  const input = { agent: agentNoThinking.name, task: "Do something" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agentsMap, anthropicAvailable, "anthropic"),
    1,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6");
  assert.equal(Object.hasOwn(input, "thinking"), false);
});

// =============================================================================
// Stored override tests (re-landed from feat/subagent-model-effort-settings)
// =============================================================================

// Reasoning model fixtures for override tests
const reasoningAnthropicAvailable = anthropicAvailable.map((model) => ({
  ...model,
  reasoning: true,
}));
const reasoningCodexAvailable = codexAvailable.map((model) => ({ ...model, reasoning: true }));
const reasoningOpenaiAvailable = [{ provider: "openai", id: "gpt-5.6", reasoning: true }];
const limitedReasoningAvailable = [
  {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
    thinkingLevelMap: { xhigh: null },
  },
  {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    reasoning: true,
    thinkingLevelMap: { xhigh: null },
  },
];
const primaryOnlyReasoningAvailable = [
  { provider: "anthropic", id: "claude-opus-5", reasoning: true, thinkingLevelMap: { high: null } },
  { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
];

// Agents used specifically for override tests (kept separate from main's fixtures)
const overrideDeveloper = {
  name: "developer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
};
const overrideCodeReviewer = {
  name: "code-reviewer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  preferOppositeProvider: true,
};
const overrideOracle = {
  name: "oracle",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  preferOppositeProvider: true,
};
const overrideAgents = new Map([
  [overrideDeveloper.name, overrideDeveloper],
  [overrideCodeReviewer.name, overrideCodeReviewer],
  [overrideOracle.name, overrideOracle],
]);

test("exact suffix-like model IDs win shared lookup, resolution, and mutation", () => {
  const available = [
    { provider: "openrouter", id: "reasoner", reasoning: true },
    { provider: "openrouter", id: "reasoner:high", reasoning: true },
  ];
  assert.equal(findAvailableProviderModel(available, "openrouter/reasoner:high"), available[1]);

  const resolution = resolveProviderAwareSubagentResolution(
    overrideDeveloper,
    available,
    "openrouter",
    undefined,
    {
      model: "openrouter/reasoner:high",
    },
  );
  assert.equal(resolution.model, available[1]);

  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(input, overrideAgents, available, "openrouter", undefined, {
      agentOverrides: new Map([["developer", { model: "openrouter/reasoner:high" }]]),
    }),
    1,
  );
  assert.equal(input.model, "openrouter/reasoner:high");
});

test("saved effort appends after the exact saved model identity", () => {
  const available = [{ provider: "openrouter", id: "reasoner:high", reasoning: true }];
  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(input, overrideAgents, available, "openrouter", undefined, {
      agentOverrides: new Map([
        ["developer", { model: "openrouter/reasoner:high", thinking: "low" }],
      ]),
    }),
    1,
  );
  assert.equal(input.model, "openrouter/reasoner:high:low");
});

test("saved effort appends after exact suffix-like primary and generated fallback model IDs", () => {
  const exactSuffixReviewer = {
    name: "exact-suffix-reviewer",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol:high"],
    tlhAnthropicModels: ["anthropic/claude-opus-5:high"],
    preferOppositeProvider: true,
  };
  const exactSuffixAgents = new Map([[exactSuffixReviewer.name, exactSuffixReviewer]]);
  const available = [
    { provider: "openai-codex", id: "gpt-5.6-sol:high", reasoning: true },
    { provider: "anthropic", id: "claude-opus-5:high", reasoning: true },
  ];
  const input = { agent: exactSuffixReviewer.name, task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      exactSuffixAgents,
      available,
      "anthropic",
      { provider: "anthropic", id: "claude-opus-5:high" },
      { agentOverrides: new Map([[exactSuffixReviewer.name, { thinking: "low" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high:low");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:high:low"]);
});

test("model-only exact suffix-like OpenRouter IDs do not receive generic effort", () => {
  const mediumDeveloper = { ...overrideDeveloper, thinking: "medium" };
  const mediumDeveloperAgents = new Map([[mediumDeveloper.name, mediumDeveloper]]);
  const available = [{ provider: "openrouter", id: "reasoner:high", reasoning: true }];
  const resolution = resolveProviderAwareSubagentResolution(
    mediumDeveloper,
    available,
    "openrouter",
    undefined,
    {
      model: "openrouter/reasoner:high",
    },
  );
  assert.equal(resolution.model, available[0]);
  assert.equal(resolution.thinking, undefined);

  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      mediumDeveloperAgents,
      available,
      "openrouter",
      undefined,
      {
        agentOverrides: new Map([["developer", { model: "openrouter/reasoner:high" }]]),
      },
    ),
    1,
  );
  assert.equal(input.model, "openrouter/reasoner:high");
});

test("shared lookup still treats a non-exact recognized suffix as base-model effort", () => {
  const available = [{ provider: "openrouter", id: "reasoner", reasoning: true }];
  assert.equal(findAvailableProviderModel(available, "openrouter/reasoner:high"), available[0]);
});

test("saved effort can use the current OpenAI session model without making it a bundled default", () => {
  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      reasoningOpenaiAvailable,
      "openai",
      { provider: "openai", id: "gpt-5.6" },
      { agentOverrides: new Map([["developer", { thinking: "high" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "openai/gpt-5.6:high");
});

test("saved effort can use the current custom-provider session model only when needed", () => {
  const available = [{ provider: "custom-provider", id: "reasoner", reasoning: true }];
  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      available,
      "custom-provider",
      { provider: "custom-provider", id: "reasoner" },
      { agentOverrides: new Map([["developer", { thinking: "high" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "custom-provider/reasoner:high");

  const noEffortInput = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(noEffortInput, overrideAgents, available, "custom-provider", {
      provider: "custom-provider",
      id: "reasoner",
    }),
    0,
  );
  assert.equal(noEffortInput.model, undefined);

  const unsupportedCurrentModel = [
    {
      provider: "custom-provider",
      id: "limited",
      reasoning: true,
      thinkingLevelMap: { high: null },
    },
  ];
  const unsupportedInput = { agent: "developer", task: "Implement the ticket" };
  const warnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(
      unsupportedInput,
      overrideAgents,
      unsupportedCurrentModel,
      "custom-provider",
      { provider: "custom-provider", id: "limited" },
      {
        agentOverrides: new Map([["developer", { thinking: "high" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(unsupportedInput.model, "custom-provider/limited:off");
  assert.equal(
    applyRuntimeThinkingSuffix(unsupportedInput.model, "high", false),
    unsupportedInput.model,
  );
  assert.equal(warnings.length, 1);
  const expectedWarning =
    'TLH stored minor-agent effort "high" is not supported by custom-provider/limited; using explicit off for this run.';
  assert.equal(warnings[0], expectedWarning);
  const unsupportedResolution = resolveProviderAwareSubagentResolution(
    overrideDeveloper,
    unsupportedCurrentModel,
    "custom-provider",
    { provider: "custom-provider", id: "limited" },
    { thinking: "high" },
  );
  assert.equal(unsupportedResolution.model, unsupportedCurrentModel[0]);
  assert.equal(unsupportedResolution.thinking, "off");
  assert.equal(unsupportedResolution.warning, expectedWarning);
});

test("thinking-only overrides warn when no bundled or current-session model is available", () => {
  const input = { agent: "developer", task: "Implement the ticket" };
  const warnings = [];
  const expectedWarning =
    'TLH stored minor-agent effort "high" for developer could not be capability-checked because no bundled or current-session model is available; the subagents runtime will apply its capability gate if the model resolves and fail open otherwise.';
  const currentModel = { provider: "custom-provider", id: "not-listed" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agents, [], "custom-provider", currentModel, {
      agentOverrides: new Map([["developer", { thinking: "high" }]]),
      onWarning: (warning) => warnings.push(warning.message),
    }),
    0,
  );
  assert.equal(input.model, undefined);
  assert.deepEqual(warnings, [expectedWarning]);

  const resolution = resolveProviderAwareSubagentResolution(
    developer,
    [],
    "custom-provider",
    currentModel,
    {
      thinking: "high",
    },
  );
  assert.equal(resolution.model, undefined);
  assert.equal(resolution.thinking, undefined);
  assert.equal(resolution.warning, expectedWarning);
});

test("explicit plain model keeps its model and receives supported persisted thinking", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-sonnet-4-6" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      reasoningAnthropicAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([
          ["developer", { model: "openai-codex/gpt-5.6-luna", thinking: "high" }],
        ]),
      },
    ),
    1,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:high");
});

test("explicit known thinking suffix wins over persisted thinking", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-sonnet-4-6:low" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      reasoningAnthropicAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { thinking: "high" }]]),
      },
    ),
    0,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:low");
});

test("model false leaves an implicit dispatch and caller fallback fields untouched", () => {
  const input = {
    agent: "code-reviewer",
    task: "Review",
    fallbackModels: ["custom/reviewer"],
    modelFallbackNotice: "caller notice",
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      { provider: "anthropic", id: "claude-opus-5" },
      { agentOverrides: new Map([["code-reviewer", { model: false }]]) },
    ),
    0,
  );
  assert.equal(Object.hasOwn(input, "model"), false);
  assert.deepEqual(input.fallbackModels, ["custom/reviewer"]);
  assert.equal(input.modelFallbackNotice, "caller notice");
});

test("false and saved thinking use the inherited current model when model is false", () => {
  for (const [thinking, suffix] of [
    [false, "off"],
    ["high", "high"],
  ]) {
    const warnings = [];
    const input = { agent: "developer", task: "Implement", fallbackModels: ["caller/fallback"] };
    assert.equal(
      applyProviderAwareSubagentModels(
        input,
        overrideAgents,
        reasoningCodexAvailable,
        "openai-codex",
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        {
          agentOverrides: new Map([["developer", { model: false, thinking }]]),
          onWarning: (warning) => warnings.push(warning.message),
        },
      ),
      1,
    );
    assert.equal(input.model, `openai-codex/gpt-5.6-luna:${suffix}`);
    assert.deepEqual(input.fallbackModels, ["caller/fallback"]);
    assert.deepEqual(warnings, []);
  }
});

test("thinking false applies off without warning while explicit caller model and suffix precedence remain intact", () => {
  const warnings = [];
  const implicitInput = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      implicitInput,
      overrideAgents,
      reasoningCodexAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { thinking: false }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(implicitInput.model, "openai-codex/gpt-5.6-luna:off");

  const explicitInput = {
    agent: "developer",
    task: "Implement",
    model: "openai-codex/gpt-5.6-luna",
    fallbackModels: ["caller/fallback"],
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      explicitInput,
      overrideAgents,
      reasoningCodexAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { model: false, thinking: false }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(explicitInput.model, "openai-codex/gpt-5.6-luna:off");
  assert.deepEqual(explicitInput.fallbackModels, ["caller/fallback"]);

  const suffixedInput = {
    agent: "developer",
    task: "Implement",
    model: "openai-codex/gpt-5.6-luna:high",
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      suffixedInput,
      overrideAgents,
      reasoningCodexAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { thinking: false }]]),
      },
    ),
    0,
  );
  assert.equal(suffixedInput.model, "openai-codex/gpt-5.6-luna:high");
  assert.deepEqual(warnings, []);
});

test("persisted minor-agent overrides win over bundled defaults and apply supported thinking suffixes", () => {
  const input = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      reasoningAnthropicAvailable,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([
          ["developer", { model: "anthropic/claude-sonnet-4-6", thinking: "high" }],
        ]),
      },
    ),
    1,
  );
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:high");
});

test("unavailable persisted string pins stay authoritative without predicting fallback availability", () => {
  const warnings = [];
  const input = { agent: "code-reviewer", task: "Review the diff" };
  const savedOverride = {
    model: "openai-codex/gpt-5.999",
    thinking: "high",
    fallbackModels: ["saved/fallback"],
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", savedOverride]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.999");
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
  assert.equal(Object.hasOwn(input, "modelFallbackNotice"), false);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH saved minor-agent model override "openai-codex/gpt-5.999" for code-reviewer is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults. Update it with /subagent-settings set code-reviewer model <provider/id> or clear it with /subagent-settings reset code-reviewer model.',
  );

  const resolution = resolveProviderAwareSubagentResolution(
    overrideCodeReviewer,
    [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
    "anthropic",
    undefined,
    { model: "openai-codex/gpt-5.999", thinking: "high" },
  );
  assert.equal(resolution.unavailableModel, "openai-codex/gpt-5.999");
  assert.deepEqual(resolution.fallbackModels, undefined);
  assert.equal(resolution.modelFallbackNotice, undefined);
  assert.equal(resolution.independence, "preferred");
});

test("unavailable persisted string pins preserve caller-owned fallback fields and direct-dispatch precedence", () => {
  const callerWarnings = [];
  const callerFallbackInput = {
    agent: "code-reviewer",
    task: "Review",
    fallbackModels: ["caller/fallback"],
    modelFallbackNotice: "caller notice",
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      callerFallbackInput,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", { model: "openai-codex/gpt-5.999" }]]),
        onWarning: (warning) => callerWarnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(callerFallbackInput.model, "openai-codex/gpt-5.999");
  assert.deepEqual(callerFallbackInput.fallbackModels, ["caller/fallback"]);
  assert.equal(callerFallbackInput.modelFallbackNotice, "caller notice");
  assert.equal(callerWarnings.length, 1);
  const unavailableWarning =
    'TLH saved minor-agent model override "openai-codex/gpt-5.999" for code-reviewer is not currently available; forwarding the saved pin unchanged instead of swapping in bundled defaults. Update it with /subagent-settings set code-reviewer model <provider/id> or clear it with /subagent-settings reset code-reviewer model.';
  assert.equal(callerWarnings[0], unavailableWarning);

  const emptyFallbackWarnings = [];
  const emptyFallbackInput = { agent: "code-reviewer", task: "Review", fallbackModels: [] };
  assert.equal(
    applyProviderAwareSubagentModels(
      emptyFallbackInput,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", { model: "openai-codex/gpt-5.999" }]]),
        onWarning: (warning) => emptyFallbackWarnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(emptyFallbackInput.model, "openai-codex/gpt-5.999");
  assert.deepEqual(emptyFallbackInput.fallbackModels, []);
  assert.equal(emptyFallbackWarnings.length, 1);
  assert.equal(emptyFallbackWarnings[0], unavailableWarning);

  const explicitWarnings = [];
  const explicitInput = {
    agent: "code-reviewer",
    task: "Review",
    model: "anthropic/claude-opus-5",
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      explicitInput,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([
          ["code-reviewer", { model: "openai-codex/gpt-5.999", thinking: "high" }],
        ]),
        onWarning: (warning) => explicitWarnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(explicitInput.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(explicitWarnings, []);

  const falseWarnings = [];
  const falseInput = { agent: "code-reviewer", task: "Review" };
  assert.equal(
    applyProviderAwareSubagentModels(
      falseInput,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      { provider: "anthropic", id: "claude-opus-5" },
      {
        agentOverrides: new Map([["code-reviewer", { model: false }]]),
        onWarning: (warning) => falseWarnings.push(warning.message),
      },
    ),
    0,
  );
  assert.equal(Object.hasOwn(falseInput, "model"), false);
  assert.deepEqual(falseWarnings, []);
});

test("model-only overrides keep bundled effort only when the selected model supports it", () => {
  const mediumDeveloper = { ...overrideDeveloper, thinking: "medium" };
  const mediumDeveloperAgents = new Map([[mediumDeveloper.name, mediumDeveloper]]);
  const available = [
    { provider: "openai-codex", id: "plain", reasoning: false },
    { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true },
  ];

  const nonReasoningResolution = resolveProviderAwareSubagentResolution(
    mediumDeveloper,
    available,
    "openai-codex",
    undefined,
    { model: "openai-codex/plain" },
  );
  assert.equal(nonReasoningResolution.model, available[0]);
  assert.equal(nonReasoningResolution.thinking, "off");

  const nonReasoningInput = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      nonReasoningInput,
      mediumDeveloperAgents,
      available,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { model: "openai-codex/plain" }]]),
      },
    ),
    1,
  );
  assert.equal(nonReasoningInput.model, "openai-codex/plain:off");

  const reasoningResolution = resolveProviderAwareSubagentResolution(
    mediumDeveloper,
    available,
    "openai-codex",
    undefined,
    { model: "openai-codex/gpt-5.6-luna" },
  );
  assert.equal(reasoningResolution.model, available[1]);
  assert.equal(reasoningResolution.thinking, "medium");

  const reasoningInput = { agent: "developer", task: "Implement the ticket" };
  assert.equal(
    applyProviderAwareSubagentModels(
      reasoningInput,
      mediumDeveloperAgents,
      available,
      "openai-codex",
      undefined,
      {
        agentOverrides: new Map([["developer", { model: "openai-codex/gpt-5.6-luna" }]]),
      },
    ),
    1,
  );
  assert.equal(reasoningInput.model, "openai-codex/gpt-5.6-luna:medium");
});

test("persisted thinking suffix is applied to opposite-provider fallbacks", () => {
  const input = { agent: "code-reviewer", task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      { agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:high"]);
  assert.equal(input.modelFallbackNotice, reducedIndependenceNotice);
});

test("persisted off effort is explicit on selected and generated fallback models", () => {
  const input = { agent: "code-reviewer", task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
      undefined,
      { agentOverrides: new Map([["code-reviewer", { thinking: "off" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:off");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:off"]);
});

test("unsupported stored effort is neutralized on the primary and generated fallback models", () => {
  const warnings = [];
  const input = { agent: "code-reviewer", task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      limitedReasoningAvailable,
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", { thinking: "xhigh" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:off");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:off"]);

  // The runtime independently reads the persisted xhigh value from the agent.
  // Its replaceExisting=false path must leave TLH's supported neutralizer suffixes alone.
  assert.equal(applyRuntimeThinkingSuffix(input.model, "xhigh", false), input.model);
  assert.equal(
    applyRuntimeThinkingSuffix(input.fallbackModels[0], "xhigh", false),
    input.fallbackModels[0],
  );
  assert.doesNotMatch(input.model, /:xhigh$/);
  assert.doesNotMatch(input.fallbackModels[0], /:xhigh$/);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "xhigh" is not supported by openai-codex/gpt-5.6-sol; using explicit off for this run.',
  );
});

test("nonstandard stored effort prefers provider-resolved bundled suffixes on both generated models", () => {
  const bundledReviewer = {
    ...overrideCodeReviewer,
    name: "bundled-reviewer",
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "medium",
  };
  const bundledAgents = new Map([[bundledReviewer.name, bundledReviewer]]);
  const warnings = [];
  const input = { agent: bundledReviewer.name, task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      bundledAgents,
      limitedReasoningAvailable,
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([[bundledReviewer.name, { thinking: "turbo" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:medium"]);
  assert.equal(applyRuntimeThinkingSuffix(input.model, "turbo", false), input.model);
  assert.equal(
    applyRuntimeThinkingSuffix(input.fallbackModels[0], "turbo", false),
    input.fallbackModels[0],
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH ignored unsupported stored minor-agent effort "turbo" for bundled-reviewer; using bundled defaults for this run.',
  );
});

test("unsupported stored effort remains bare only when no supported neutralizer exists", () => {
  const noNeutralizerModel = {
    provider: "anthropic",
    id: "no-neutralizer",
    fullId: "anthropic/no-neutralizer",
    reasoning: true,
    thinkingLevelMap: { off: null, medium: null },
  };
  const noNeutralizerAgent = {
    name: "no-neutralizer",
    tlhAnthropicModels: ["anthropic/no-neutralizer"],
    thinking: "medium",
  };
  const noNeutralizerAgents = new Map([[noNeutralizerAgent.name, noNeutralizerAgent]]);
  const warnings = [];
  const input = { agent: noNeutralizerAgent.name, task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      noNeutralizerAgents,
      [noNeutralizerModel],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([[noNeutralizerAgent.name, { thinking: "xhigh" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "anthropic/no-neutralizer");
  assert.equal(
    applyRuntimeThinkingSuffix(input.model, "xhigh", false, {
      availableModels: [noNeutralizerModel],
    }),
    input.model,
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "xhigh" is not supported by anthropic/no-neutralizer; no supported suffix can neutralize it, so the subagents runtime will drop the stored value for this run.',
  );
});

test("supported primary saved effort survives an incompatible generated fallback", () => {
  const warnings = [];
  const input = { agent: "code-reviewer", task: "Review the diff" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      primaryOnlyReasoningAvailable,
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(input.fallbackModels, ["anthropic/claude-opus-5:off"]);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "high" is not supported by generated fallback anthropic/claude-opus-5; that fallback will use explicit off for this run.',
  );
});

test("caller-supplied fallbacks suppress warnings for an unused generated fallback", () => {
  const warnings = [];
  const input = {
    agent: "code-reviewer",
    task: "Review the diff",
    fallbackModels: ["custom/provider-model"],
  };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      primaryOnlyReasoningAvailable,
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["code-reviewer", { thinking: "high" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.deepEqual(input.fallbackModels, ["custom/provider-model"]);
  assert.deepEqual(warnings, []);
});

test("subagent resolution reports independence state for bundled and overridden review models", () => {
  assert.equal(
    resolveProviderAwareSubagentResolution(
      overrideCodeReviewer,
      [...reasoningAnthropicAvailable, ...reasoningCodexAvailable],
      "anthropic",
    ).independence,
    "preferred",
  );
  assert.equal(
    resolveProviderAwareSubagentResolution(
      overrideCodeReviewer,
      reasoningAnthropicAvailable,
      "anthropic",
      undefined,
      {
        model: "anthropic/claude-opus-5",
      },
    ).independence,
    "degraded",
  );
});

// --- `max` is a first-class suffixable effort level (PR #305 follow-up) ---
//
// `max` is in THINKING_LEVELS and the subagents runtime that consumes these model
// strings parses `:max` as a valid suffix (extensions/subagents/src/shared/model-info.ts).
// So a model that advertises `max` support must receive an explicit `:max` suffix.
// Model capability is gated separately by getAvailableThinkingLevels, which filters
// `max` unless the model's thinkingLevelMap declares it.

const maxSupportingModel = {
  provider: "anthropic",
  id: "max-model",
  reasoning: true,
  thinkingLevelMap: { max: "budget_tokens:32000" },
};
const agentWithMaxBundled = {
  name: "max-dev",
  tlhAnthropicModels: ["anthropic/max-model"],
  tlhAnthropicThinking: "max",
};
const maxAgentsMap = new Map([[agentWithMaxBundled.name, agentWithMaxBundled]]);

test("bundled max effort emits an explicit :max suffix when the model supports it", () => {
  const available = [maxSupportingModel];

  // Model-only override: bundled thinking is "max" and the model advertises it,
  // so it must be emitted as a suffix rather than dropped or collapsed to "off".
  const resolution = resolveProviderAwareSubagentResolution(
    agentWithMaxBundled,
    available,
    "anthropic",
    undefined,
    {
      model: "anthropic/max-model",
    },
  );
  assert.equal(resolution.thinking, "max");

  const overrideInput = { agent: "max-dev", task: "Do" };
  assert.equal(
    applyProviderAwareSubagentModels(
      overrideInput,
      maxAgentsMap,
      available,
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["max-dev", { model: "anthropic/max-model" }]]),
      },
    ),
    1,
  );
  assert.equal(overrideInput.model, "anthropic/max-model:max");
});

test("stored max effort is honored as a suffix when the model advertises max support", () => {
  const warnings = [];
  const input = { agent: "max-dev", task: "Do" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      maxAgentsMap,
      [maxSupportingModel],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["max-dev", { thinking: "max" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "anthropic/max-model:max");
  assert.deepEqual(warnings, []);
});

test("stored max effort warns and falls back when the model's thinkingLevelMap lacks max", () => {
  // No `max` key in thinkingLevelMap → getAvailableThinkingLevels filters it out.
  const noMaxModel = { provider: "anthropic", id: "plain-reasoner", reasoning: true };
  const noMaxAgent = { name: "max-dev", tlhAnthropicModels: ["anthropic/plain-reasoner"] };
  const noMaxAgents = new Map([[noMaxAgent.name, noMaxAgent]]);

  const resolution = resolveProviderAwareSubagentResolution(
    noMaxAgent,
    [noMaxModel],
    "anthropic",
    undefined,
    {
      thinking: "max",
    },
  );
  assert.equal(resolution.thinking, "off");
  const expectedWarning =
    'TLH stored minor-agent effort "max" is not supported by anthropic/plain-reasoner; using explicit off for this run.';
  assert.equal(resolution.warning, expectedWarning);

  const warnings = [];
  const input = { agent: "max-dev", task: "Do" };
  assert.equal(
    applyProviderAwareSubagentModels(input, noMaxAgents, [noMaxModel], "anthropic", undefined, {
      agentOverrides: new Map([["max-dev", { thinking: "max" }]]),
      onWarning: (warning) => warnings.push(warning.message),
    }),
    1,
  );
  // Falls back to explicit off rather than emitting an unsupported suffix.
  assert.equal(input.model, "anthropic/plain-reasoner:off");
  assert.equal(applyRuntimeThinkingSuffix(input.model, "max", false), input.model);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], expectedWarning);
});

test("splitKnownThinkingSuffix now splits a :max suffix like every other level", () => {
  // Regression guard for the suffix-list unification: `:max` must round-trip.
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/max-model:max"), {
    baseModel: "anthropic/max-model",
    thinkingSuffix: ":max",
  });
  // An unrecognized trailing segment is still part of the base model.
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/model:bogus"), {
    baseModel: "anthropic/model:bogus",
    thinkingSuffix: "",
  });
  // An explicit caller-supplied :max suffix must therefore win over a stored effort.
  const suffixedInput = { agent: "max-dev", task: "Do", model: "anthropic/max-model:max" };
  assert.equal(
    applyProviderAwareSubagentModels(
      suffixedInput,
      maxAgentsMap,
      [maxSupportingModel],
      "anthropic",
      undefined,
      {
        agentOverrides: new Map([["max-dev", { thinking: "low" }]]),
      },
    ),
    0,
  );
  assert.equal(suffixedInput.model, "anthropic/max-model:max");
});

// --- tlhOpenrouterThinking: parsing and provider resolution ---

test("resolveThinkingForProvider returns tlhOpenrouterThinking when provider is openrouter", () => {
  const agentWithOpenrouterThinking = {
    name: "openrouter-agent",
    tlhAnthropicThinking: "high",
    tlhOpenrouterThinking: "medium",
    tlhOpenaiThinking: "max",
    thinking: "low",
  };
  const openrouterAvailable = [{ provider: "openrouter", id: "some-model", reasoning: true }];

  const result = selectProviderAwareAgentDefaults(
    agentWithOpenrouterThinking,
    openrouterAvailable,
    "openrouter",
  );
  assert.equal(result.thinking, "medium");
});

test("resolveThinkingForProvider does not return tlhOpenrouterThinking for anthropic provider", () => {
  const agentWithOpenrouterThinking = {
    name: "openrouter-agent",
    tlhAnthropicThinking: "high",
    tlhOpenrouterThinking: "medium",
    thinking: "low",
  };
  const available = [{ provider: "anthropic", id: "claude-opus-5" }];

  const result = selectProviderAwareAgentDefaults(
    agentWithOpenrouterThinking,
    available,
    "anthropic",
  );
  assert.equal(result.thinking, "high");
});

test("resolveThinkingForProvider does not return tlhOpenrouterThinking for openai-codex provider", () => {
  const agentWithOpenrouterThinking = {
    name: "openrouter-agent",
    tlhOpenaiThinking: "max",
    tlhOpenrouterThinking: "medium",
    thinking: "low",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  };
  const available = [{ provider: "openai-codex", id: "gpt-5.6-luna" }];

  const result = selectProviderAwareAgentDefaults(
    agentWithOpenrouterThinking,
    available,
    "openai-codex",
  );
  assert.equal(result.thinking, "max");
});

test("tlhOpenrouterThinking is undefined when provider is openrouter but key is absent", () => {
  const agentWithoutOpenrouterThinking = {
    name: "no-openrouter-agent",
    tlhAnthropicThinking: "high",
    thinking: "low",
  };
  const openrouterAvailable = [{ provider: "openrouter", id: "some-model", reasoning: true }];

  const result = selectProviderAwareAgentDefaults(
    agentWithoutOpenrouterThinking,
    openrouterAvailable,
    "openrouter",
  );
  assert.equal(result.thinking, undefined);
  assert.equal(resolveProviderThinking(agentWithoutOpenrouterThinking, "openrouter"), undefined);
});

test("selectProviderAwareAgentDefaults uses tlhOpenrouterThinking when no bundled openrouter model is available (fallback via currentProvider)", () => {
  // When no bundled model resolves for 'openrouter', selectProviderAwareAgentDefaults
  // falls back to resolveThinkingForProvider(agent, currentProvider), so tlhOpenrouterThinking
  // is still returned as the thinking level.
  const openrouterDeveloper = {
    name: "developer",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    tlhAnthropicThinking: "medium",
    tlhOpenaiThinking: "max",
    tlhOpenrouterThinking: "medium",
  };
  const openrouterModel = [{ provider: "openrouter", id: "some-model", reasoning: true }];
  // No openrouter entry in tlhOpenaiModels/tlhAnthropicModels → model is undefined.
  // thinking = resolveThinkingForProvider(agent, undefined ?? "openrouter") → "medium".
  const result = selectProviderAwareAgentDefaults(
    openrouterDeveloper,
    openrouterModel,
    "openrouter",
  );
  assert.equal(result.model, undefined);
  assert.equal(result.thinking, "medium");
});

// =============================================================================
// OpenRouter follow-session-model rule (ticket tw-0lu9)
// =============================================================================
// When currentProvider === "openrouter" (literal), non-opposite-role agents follow
// the current session model. Thinking comes from tlhOpenrouterThinking only;
// the generic `thinking` key must not leak through on this path.

const openrouterSessionModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4-5" };
const openrouterAvailableModels = [
  { provider: "openrouter", id: "anthropic/claude-sonnet-4-5", reasoning: true },
  { provider: "openrouter", id: "anthropic/claude-opus-4", reasoning: true },
];
const openrouterDeveloperWithThinking = {
  name: "developer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  tlhAnthropicThinking: "medium",
  tlhOpenaiThinking: "max",
  tlhOpenrouterThinking: "low",
  thinking: "high",
};
const openrouterDeveloperNoOrThinking = {
  name: "developer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
  tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
  tlhAnthropicThinking: "medium",
  tlhOpenaiThinking: "max",
  // no tlhOpenrouterThinking
  thinking: "high",
};
const openrouterCodeReviewer = {
  name: "code-reviewer",
  tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
  tlhAnthropicModels: ["anthropic/claude-opus-5"],
  preferOppositeProvider: true,
};

test("openrouter follow rule: selectProviderAwareAgentDefaults follows session model with tlhOpenrouterThinking", () => {
  const result = selectProviderAwareAgentDefaults(
    openrouterDeveloperWithThinking,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
  );
  assert.deepEqual(result.model, openrouterAvailableModels[0]);
  assert.equal(result.thinking, "low"); // from tlhOpenrouterThinking
});

test("openrouter follow rule: registry-missing session model is still followed", () => {
  const result = selectProviderAwareAgentDefaults(
    openrouterDeveloperWithThinking,
    [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    "openrouter",
    openrouterSessionModel,
  );
  assert.deepEqual(result.model, openrouterSessionModel);
  assert.equal(result.thinking, "low");
});

test("openrouter follow rule: thinking-only override fails open for unknown capability", () => {
  const resolution = resolveProviderAwareSubagentResolution(
    openrouterDeveloperWithThinking,
    [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
    "openrouter",
    openrouterSessionModel,
    { thinking: "high" },
  );
  assert.deepEqual(resolution.model, openrouterSessionModel);
  assert.equal(resolution.thinking, "high");
  assert.equal(resolution.warning, undefined);
});

test("openrouter follow rule: generic thinking key does NOT leak when tlhOpenrouterThinking is absent", () => {
  const result = selectProviderAwareAgentDefaults(
    openrouterDeveloperNoOrThinking,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
  );
  assert.deepEqual(result.model, openrouterAvailableModels[0]);
  // Must be undefined, not the generic 'high' from agent.thinking
  assert.equal(result.thinking, undefined);
});

test("openrouter follow rule: normalized effort-only entry follows the session model", () => {
  const agent = {
    name: "normalized-openrouter-effort-only",
    thinking: "high",
    tlhModelDefaults: [{ provider: "openrouter", effort: "medium" }],
    tlhModelDefaultsSource: "frontmatter",
  };
  const result = selectProviderAwareAgentDefaults(
    agent,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
  );
  assert.deepEqual(result.model, openrouterAvailableModels[0]);
  assert.equal(result.thinking, "medium");

  const resolution = resolveProviderAwareSubagentResolution(
    agent,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
    undefined,
  );
  assert.deepEqual(resolution.model, openrouterAvailableModels[0]);
  assert.equal(resolution.thinking, "medium");
  assert.deepEqual(resolution.fallbackModels, []);
});

test("openrouter follow rule: generic thinking does not leak when normalized entry omits effort", () => {
  const agent = {
    name: "normalized-openrouter-no-effort",
    thinking: "high",
    tlhModelDefaults: [{ provider: "openrouter" }],
    tlhModelDefaultsSource: "frontmatter",
  };
  const result = selectProviderAwareAgentDefaults(
    agent,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
  );
  assert.deepEqual(result.model, openrouterAvailableModels[0]);
  assert.equal(result.thinking, undefined);
});

test("openrouter follow rule: applyProviderAwareSubagentModels follows session model without suffix when no tlhOpenrouterThinking", () => {
  const orAgents = new Map([
    [openrouterDeveloperNoOrThinking.name, openrouterDeveloperNoOrThinking],
  ]);
  const input = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      openrouterAvailableModels,
      "openrouter",
      openrouterSessionModel,
    ),
    1,
  );
  assert.equal(input.model, "openrouter/anthropic/claude-sonnet-4-5");
  assert.equal(Object.hasOwn(input, "thinking"), false);
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
});

test("openrouter follow rule: applyProviderAwareSubagentModels appends tlhOpenrouterThinking suffix when set", () => {
  const orAgents = new Map([
    [openrouterDeveloperWithThinking.name, openrouterDeveloperWithThinking],
  ]);
  const input = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      openrouterAvailableModels,
      "openrouter",
      openrouterSessionModel,
    ),
    1,
  );
  assert.equal(input.model, "openrouter/anthropic/claude-sonnet-4-5:low");
  assert.equal(Object.hasOwn(input, "thinking"), false);
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
});

test("openrouter follow rule: resolveProviderAwareSubagentResolution follows session model (no override)", () => {
  const resolution = resolveProviderAwareSubagentResolution(
    openrouterDeveloperWithThinking,
    openrouterAvailableModels,
    "openrouter",
    openrouterSessionModel,
    undefined,
  );
  assert.deepEqual(resolution.model, openrouterAvailableModels[0]);
  assert.equal(resolution.thinking, "low"); // from tlhOpenrouterThinking
  assert.deepEqual(resolution.fallbackModels, []);
  assert.equal(resolution.independence, "not-applicable");
  assert.equal(resolution.warning, undefined);
});

test("openrouter follow rule: stored thinking-only override is capability-gated on the session model", () => {
  const reasoningOrAvailable = openrouterAvailableModels.map((m) => ({ ...m, reasoning: true }));
  const resolution = resolveProviderAwareSubagentResolution(
    openrouterDeveloperWithThinking,
    reasoningOrAvailable,
    "openrouter",
    openrouterSessionModel,
    { thinking: "high" },
  );
  assert.deepEqual(resolution.model, reasoningOrAvailable[0]);
  assert.equal(resolution.thinking, "high"); // stored thinking, capability-gated
  assert.deepEqual(resolution.fallbackModels, []);
  assert.equal(resolution.independence, "not-applicable");
});

test("openrouter follow rule: stored thinking-only override applied via applyProviderAwareSubagentModels", () => {
  const reasoningOrAvailable = openrouterAvailableModels.map((m) => ({ ...m, reasoning: true }));
  const orAgents = new Map([
    [openrouterDeveloperWithThinking.name, openrouterDeveloperWithThinking],
  ]);
  const input = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      reasoningOrAvailable,
      "openrouter",
      openrouterSessionModel,
      { agentOverrides: new Map([["developer", { thinking: "high" }]]) },
    ),
    1,
  );
  assert.equal(input.model, "openrouter/anthropic/claude-sonnet-4-5:high");
});

test("openrouter follow rule: opposite-role agents (preferOppositeProvider) are NOT affected", () => {
  const orAgents = new Map([[openrouterCodeReviewer.name, openrouterCodeReviewer]]);
  // On openrouter, code-reviewer should NOT follow the session model.
  // With only openrouter models available, opposite-provider logic finds nothing.
  const input = { agent: "code-reviewer", task: "Review" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      openrouterAvailableModels,
      "openrouter",
      openrouterSessionModel,
    ),
    0,
  );
  assert.equal(input.model, undefined);
});

test("openrouter follow rule: non-openrouter sessions behave exactly as before", () => {
  // anthropic session: developer picks bundled Anthropic model, not the session model
  const orAgents = new Map([
    [openrouterDeveloperWithThinking.name, openrouterDeveloperWithThinking],
  ]);
  const anthropicInput = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(anthropicInput, orAgents, anthropicAvailable, "anthropic", {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    }),
    1,
  );
  assert.equal(anthropicInput.model, "anthropic/claude-sonnet-4-6:medium");

  // codex session: developer picks bundled Codex model
  const codexInput = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(codexInput, orAgents, codexAvailable, "openai-codex", {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
    }),
    1,
  );
  assert.equal(codexInput.model, "openai-codex/gpt-5.6-luna:max");
});

test("openrouter follow rule: stored model pin wins over session follow", () => {
  // Stored model pin (case 1 in resolveProviderAwareSubagentResolution) must beat
  // the openrouter follow rule which only applies in case 4 (no stored model).
  const reasoningOrAvailable = [
    ...openrouterAvailableModels.map((m) => ({ ...m, reasoning: true })),
    { provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true },
  ];
  const orAgents = new Map([
    [openrouterDeveloperWithThinking.name, openrouterDeveloperWithThinking],
  ]);
  const input = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      reasoningOrAvailable,
      "openrouter",
      openrouterSessionModel,
      { agentOverrides: new Map([["developer", { model: "anthropic/claude-sonnet-4-6" }]]) },
    ),
    1,
  );
  // Stored pin wins, not the openrouter session model.
  // Thinking resolves from tlhAnthropicThinking (the pinned model's provider), not openrouter.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
});

test("openrouter follow rule: no session model available → fall through to existing bundled defaults", () => {
  // If currentModel is undefined on openrouter, follow rule returns nothing and
  // bundled logic tries to find openai/anthropic candidates (probably none for OR).
  const orAgents = new Map([
    [openrouterDeveloperWithThinking.name, openrouterDeveloperWithThinking],
  ]);
  const input = { agent: "developer", task: "Implement" };
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      orAgents,
      openrouterAvailableModels,
      "openrouter",
      undefined, // no current model
    ),
    0,
  );
  assert.equal(input.model, undefined);
});

// ---------------------------------------------------------------------------
// Project defaults integration tests (tlha-pf6l)
// ---------------------------------------------------------------------------

// Shared fixtures for project defaults tests.
// Developer: anthropic effort "medium" (supported on reasoning:true), openai-codex effort "max"
// (capability-gated to "off" on reasoning:true models without thinkingLevelMap).
const pdDeveloper = {
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
    { provider: "openrouter", effort: "medium" },
  ],
  tlhModelDefaultsSource: "frontmatter",
};

// code-reviewer: opposite-provider, effort "high" on both providers.
const pdCodeReviewer = {
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
    { provider: "openrouter", effort: "high" },
  ],
  tlhModelDefaultsSource: "frontmatter",
  preferOppositeProvider: true,
};

const pdAgents2 = new Map([
  [pdDeveloper.name, pdDeveloper],
  [pdCodeReviewer.name, pdCodeReviewer],
]);

// Available models: reasoning:true (no thinkingLevelMap), so effort "max" capability-gates to "off",
// but effort levels up to "high" resolve correctly.
const pdAnthropicModels = [
  { provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true },
  { provider: "anthropic", id: "claude-opus-5", reasoning: true },
];
const pdCodexModels = [
  { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
];
const pdAllModels = [...pdAnthropicModels, ...pdCodexModels];

test("project defaults: prototype-chain agent names do not resolve inherited entries", () => {
  const inheritedDefaults = {};
  Object.defineProperty(inheritedDefaults, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { model: "anthropic/claude-opus-5", effort: "high" },
  });
  Object.defineProperty(inheritedDefaults, "constructor", {
    configurable: true,
    enumerable: true,
    value: { model: "anthropic/claude-opus-5", effort: "high" },
  });
  const projectDefaults = Object.create(inheritedDefaults);

  for (const agentName of ["__proto__", "constructor"]) {
    const input = { agent: agentName, task: "Ignore inherited project defaults" };
    assert.equal(
      applyProviderAwareSubagentModels(input, pdAgents2, pdAllModels, "anthropic", undefined, {
        projectDefaults,
      }),
      0,
    );
    assert.equal(input.model, undefined);
  }
});

// -----------------------------------------------------------------------
// Precedence layer tests
// -----------------------------------------------------------------------

// Layer 4 (bundled): no project defaults, no persisted override → bundled defaults apply.
// Bundled path is the "override === undefined" fast path using resolveThinkingForProvider
// without capability gating, so "medium" appears directly.
test("project defaults: layer 4 (bundled) applies when no project defaults and no persisted override", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAnthropicModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
  );
  assert.equal(mutations, 1);
  // Bundled defaults: anthropic/claude-sonnet-4-6 with effort "medium".
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
});

// Layer 3 (persisted): persisted model override wins over bundled when no project defaults.
// Note: the persisted-model path calls resolveStoredSubagentThinking, which capability-gates.
// Developer's openai-codex bundled effort is "max", but max requires thinkingLevelMap;
// without it, the capability gate falls to "off".
test("project defaults: layer 3 (persisted) model wins over bundled when no project defaults", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { agentOverrides: new Map([["developer", { model: "openai-codex/gpt-5.6-luna" }]]) },
  );
  assert.equal(mutations, 1);
  // Persisted model pin wins; developer's openai-codex bundled effort "max" is
  // capability-gated to "off" for a reasoning:true model without thinkingLevelMap.
  assert.equal(input.model, "openai-codex/gpt-5.6-luna:off");
});

// Layer 2 model: project model beats persisted model (per-field: model only).
test("project defaults: layer 2 project model beats layer 3 persisted model (anthropic → anthropic)", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["developer", { model: "anthropic/claude-sonnet-4-6", thinking: "low" }],
      ]),
      projectDefaults: { developer: { model: "anthropic/claude-opus-5" } },
    },
  );
  assert.equal(mutations, 1);
  // Project model (claude-opus-5) beats persisted model (claude-sonnet-4-6).
  // Thinking falls through from persisted (low).
  assert.equal(input.model, "anthropic/claude-opus-5:low");
});

// Layer 2 effort: project effort beats persisted thinking.
test("project defaults: layer 2 project effort beats layer 3 persisted thinking", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["developer", { model: "anthropic/claude-sonnet-4-6", thinking: "low" }],
      ]),
      projectDefaults: { developer: { effort: "high" } },
    },
  );
  assert.equal(mutations, 1);
  // Persisted model kept; project effort (high) beats persisted thinking (low).
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:high");
});

test("project and stored effort warnings retain their source provenance", () => {
  const limitedModel = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    reasoning: true,
    thinkingLevelMap: { medium: null, high: null },
  };
  const projectInput = { agent: "developer", task: "Implement" };
  const projectWarnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(
      projectInput,
      pdAgents2,
      [limitedModel],
      "anthropic",
      limitedModel,
      {
        projectDefaults: { developer: { effort: "high" } },
        onWarning: ({ message }) => projectWarnings.push(message),
      },
    ),
    1,
  );
  assert.equal(projectInput.model, "anthropic/claude-sonnet-4-6:off");
  assert.deepEqual(projectWarnings, [
    'TLH project default effort "high" from .tlh/defaults.json is not supported by anthropic/claude-sonnet-4-6; using explicit off for this run.',
  ]);

  const storedInput = { agent: "developer", task: "Implement" };
  const storedWarnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(
      storedInput,
      pdAgents2,
      [limitedModel],
      "anthropic",
      limitedModel,
      {
        agentOverrides: new Map([["developer", { thinking: "high" }]]),
        onWarning: ({ message }) => storedWarnings.push(message),
      },
    ),
    1,
  );
  assert.equal(storedInput.model, "anthropic/claude-sonnet-4-6:off");
  assert.deepEqual(storedWarnings, [
    'TLH stored minor-agent effort "high" is not supported by anthropic/claude-sonnet-4-6; using explicit off for this run.',
  ]);
});

test("project defaults: project model merge retains persisted effort warning provenance", () => {
  const limitedModel = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    reasoning: true,
    thinkingLevelMap: { medium: null, high: null },
  };
  const input = { agent: "developer", task: "Implement" };
  const warnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(input, pdAgents2, [limitedModel], "anthropic", limitedModel, {
      agentOverrides: new Map([["developer", { thinking: "high" }]]),
      projectDefaults: { developer: { model: "anthropic/claude-sonnet-4-6" } },
      onWarning: ({ message }) => warnings.push(message),
    }),
    1,
  );
  // The project model is selected, while the persisted unsupported effort still
  // follows the existing capability neutralization path.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:off");
  assert.deepEqual(warnings, [
    'TLH stored minor-agent effort "high" is not supported by anthropic/claude-sonnet-4-6; using explicit off for this run.',
  ]);
  assert.doesNotMatch(warnings[0], /project default|\.tlh\/defaults\.json/);
});

test("project defaults: no-model capability warning identifies the project defaults file", () => {
  const input = { agent: "developer", task: "Implement" };
  const warnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(input, pdAgents2, [], "custom-provider", undefined, {
      projectDefaults: { developer: { effort: "high" } },
      onWarning: ({ message }) => warnings.push(message),
    }),
    0,
  );
  assert.equal(input.model, undefined);
  assert.deepEqual(warnings, [
    'TLH project default effort "high" from .tlh/defaults.json for developer could not be capability-checked because no bundled or current-session model is available; the subagents runtime will apply its capability gate if the model resolves and fail open otherwise.',
  ]);
  assert.match(warnings[0], /\.tlh\/defaults\.json/);
});

// Layer 1 (explicit dispatch model): human model wins; project effort still attaches.
test("project defaults: layer 1 explicit dispatch model beats project model (human-only rule)", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-opus-5" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { developer: { model: "openai-codex/gpt-5.6-luna" } } },
  );
  // Explicit dispatch model wins; no effort suffix (no thinking override).
  assert.equal(mutations, 0);
  assert.equal(input.model, "anthropic/claude-opus-5");
});

test("project defaults: explicit dispatch model wins; project effort attaches as suffix", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-opus-5" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { developer: { effort: "high" } } },
  );
  // Human model wins; project effort (high) appends.
  assert.equal(mutations, 1);
  assert.equal(input.model, "anthropic/claude-opus-5:high");
});

test("project defaults: unavailable project model is ignored for explicit dispatch", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-opus-5" };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      projectDefaults: { developer: { model: "anthropic/claude-not-available" } },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  assert.equal(mutations, 0);
  assert.equal(input.model, "anthropic/claude-opus-5");
  assert.deepEqual(warnings, []);
});

test("project defaults: explicit model keeps project effort when project model is unavailable", () => {
  const input = { agent: "developer", task: "Implement", model: "anthropic/claude-opus-5" };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      projectDefaults: {
        developer: { model: "anthropic/claude-not-available", effort: "high" },
      },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  assert.equal(mutations, 1);
  assert.equal(input.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(warnings, []);
});

test("project defaults: explicit thinking suffix stays untouched when project model is unavailable", () => {
  const input = {
    agent: "developer",
    task: "Implement",
    model: "anthropic/claude-opus-5:low",
  };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      projectDefaults: {
        developer: { model: "anthropic/claude-not-available", effort: "high" },
      },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  assert.equal(mutations, 0);
  assert.equal(input.model, "anthropic/claude-opus-5:low");
  assert.deepEqual(warnings, []);
});

// -----------------------------------------------------------------------
// Per-field mixing tests
// -----------------------------------------------------------------------

// Project model only (no project effort) + persisted effort.
test("project defaults: per-field — project model, effort from persisted thinking", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([["developer", { thinking: "low" }]]),
      projectDefaults: { developer: { model: "anthropic/claude-opus-5" } },
    },
  );
  assert.equal(mutations, 1);
  // Project model + persisted thinking (low) from per-field merge.
  assert.equal(input.model, "anthropic/claude-opus-5:low");
});

// Project effort only (no project model) + persisted model.
test("project defaults: per-field — project effort, model from persisted override", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["developer", { model: "anthropic/claude-sonnet-4-6", thinking: "low" }],
      ]),
      projectDefaults: { developer: { effort: "high" } },
    },
  );
  assert.equal(mutations, 1);
  // Persisted model + project effort (high); persisted thinking overridden by project.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:high");
});

// -----------------------------------------------------------------------
// Opposite-role behavior tests (code-reviewer / oracle / contrarian)
// -----------------------------------------------------------------------

// Effort-only project entry preserves dynamic opposite-provider selection.
test("project defaults: code-reviewer effort-only preserves opposite-provider selection (anthropic session → codex)", () => {
  const input = { agent: "code-reviewer", task: "Review" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { "code-reviewer": { effort: "high" } } },
  );
  assert.equal(mutations, 1);
  // Opposite-provider selection preserved: codex reviewer for anthropic session.
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.ok(Array.isArray(input.fallbackModels), "fallback models generated for opposite-role");
});

test("project defaults: code-reviewer effort-only preserves opposite-provider selection (codex session → anthropic)", () => {
  const input = { agent: "code-reviewer", task: "Review" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "openai-codex",
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { projectDefaults: { "code-reviewer": { effort: "high" } } },
  );
  assert.equal(mutations, 1);
  // Opposite-provider selection preserved: anthropic reviewer for codex session.
  assert.equal(input.model, "anthropic/claude-opus-5:high");
  assert.ok(Array.isArray(input.fallbackModels), "fallback models generated for opposite-role");
});

// Model pin bypasses opposite-provider selection on both provider families.
test("project defaults: code-reviewer model pin bypasses opposite-provider selection (anthropic session)", () => {
  const input = { agent: "code-reviewer", task: "Review" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { "code-reviewer": { model: "anthropic/claude-opus-5" } } },
  );
  assert.equal(mutations, 1);
  // Model pin bypasses opposite selection; no generated fallback.
  assert.equal(input.model, "anthropic/claude-opus-5:high");
  assert.equal(input.fallbackModels, undefined);
});

test("project defaults: code-reviewer model pin bypasses opposite-provider selection (codex session)", () => {
  const input = { agent: "code-reviewer", task: "Review" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "openai-codex",
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { projectDefaults: { "code-reviewer": { model: "openai-codex/gpt-5.6-sol" } } },
  );
  assert.equal(mutations, 1);
  // Model pin bypasses opposite selection; no generated fallback.
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:high");
  assert.equal(input.fallbackModels, undefined);
});

// -----------------------------------------------------------------------
// Unavailable project model: warn and fall through
// -----------------------------------------------------------------------

test("project defaults: implicit dispatch warns for unavailable project model and falls through to bundled defaults", () => {
  const input = { agent: "developer", task: "Implement" };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAnthropicModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      projectDefaults: { developer: { model: "anthropic/claude-not-available" } },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  assert.equal(mutations, 1);
  // Falls through to bundled defaults; unavailable project pin warned, not forwarded.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
  assert.equal(warnings.length, 1, "implicit dispatch emits one project-model warning");
  assert.ok(
    warnings.some((w) => w.includes("claude-not-available")),
    "warning mentions model",
  );
  assert.ok(
    warnings.some((w) => w.includes("developer")),
    "warning mentions role",
  );
});

test("project defaults: unavailable project model warns and falls through to persisted override", () => {
  const input = { agent: "developer", task: "Implement" };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["developer", { model: "anthropic/claude-sonnet-4-6", thinking: "low" }],
      ]),
      projectDefaults: { developer: { model: "anthropic/claude-not-available" } },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  assert.equal(mutations, 1);
  // Falls through to persisted override (anthropic/claude-sonnet-4-6:low).
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:low");
  assert.ok(warnings.length > 0, "warning emitted for unavailable project model");
  assert.ok(
    warnings.some((w) => w.includes("claude-not-available")),
    "warning mentions model",
  );
});

// -----------------------------------------------------------------------
// model:false interaction: project defaults (layer 2) override persisted model:false (layer 3)
// -----------------------------------------------------------------------

test("project defaults: project model overrides persisted model:false (available project model wins)", () => {
  // model:false is a persisted value for the model field (layer 3). Project defaults
  // (layer 2) beat it, just as they beat a persisted model string.
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([["developer", { model: false }]]),
      projectDefaults: { developer: { model: "anthropic/claude-opus-5" } },
    },
  );
  // Project model wins over persisted model:false; step-1 resolution applies.
  assert.equal(mutations, 1);
  assert.equal(input.model, "anthropic/claude-opus-5:medium");
});

test("project defaults: unavailable project model + persisted model:false → warns, preserves false (session-inherit kept)", () => {
  // When the project model is NOT in the registry, we warn and fall through to the
  // persisted value — which is false here, so model:false is preserved.
  const input = { agent: "developer", task: "Implement" };
  const warnings = [];
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([["developer", { model: false }]]),
      projectDefaults: { developer: { model: "anthropic/claude-not-available" } },
      onWarning: ({ message }) => warnings.push(message),
    },
  );
  // Project model unavailable → fall through to persisted false.
  // model:false + thinking:undefined → fast path returns 0.
  assert.equal(mutations, 0);
  assert.equal(Object.hasOwn(input, "model"), false);
  assert.ok(warnings.length > 0, "warning emitted");
  assert.ok(
    warnings.some((w) => w.includes("claude-not-available")),
    "warning mentions model",
  );
});

test("project defaults: effort-only project entry + persisted model:false → model stays false, project effort applied", () => {
  // Project entry has only effort (no model). Effective model field stays false
  // (session-inherit). Project effort is applied to the inherited session model.
  // Merged override: { model: false, thinking: "high" } → step-3 path.
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([["developer", { model: false }]]),
      projectDefaults: { developer: { effort: "high" } },
    },
  );
  // step-3: inherits session model (anthropic/claude-sonnet-4-6) with project effort (high).
  assert.equal(mutations, 1);
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:high");
});

// -----------------------------------------------------------------------
// Denied/unavailable loader status: undefined projectDefaults = no effect
// -----------------------------------------------------------------------

test("project defaults: denied/unavailable status (undefined projectDefaults) applies nothing", () => {
  // Callers must pass undefined when loader status is denied or unavailable.
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAnthropicModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: undefined },
  );
  assert.equal(mutations, 1);
  // Falls through to bundled defaults.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
});

test("project defaults: empty projectDefaults object (no entry for role) falls through to bundled", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAnthropicModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: {} },
  );
  assert.equal(mutations, 1);
  // No project entry for developer → bundled defaults.
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:medium");
});

// -----------------------------------------------------------------------
// Project model beats bundled defaults (layer 2 > layer 4)
// -----------------------------------------------------------------------

test("project defaults: project model beats bundled defaults with no persisted override", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { developer: { model: "anthropic/claude-opus-5" } } },
  );
  assert.equal(mutations, 1);
  // Project model (claude-opus-5) wins over bundled (claude-sonnet-4-6).
  // No thinking override → bundled effort "medium" for anthropic, capability-gated to "medium"
  // (medium is supported on reasoning:true models).
  assert.equal(input.model, "anthropic/claude-opus-5:medium");
});

test("project defaults: project effort overrides bundled effort for the resolved model", () => {
  const input = { agent: "developer", task: "Implement" };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { developer: { effort: "low" } } },
  );
  assert.equal(mutations, 1);
  // Bundled model selected, project effort (low) overrides bundled effort (medium).
  assert.equal(input.model, "anthropic/claude-sonnet-4-6:low");
});

// -----------------------------------------------------------------------
// tasks[] batch dispatch: project defaults apply to each task target
// -----------------------------------------------------------------------

test("project defaults: project defaults apply to each task target in tasks[] batch", () => {
  const input = {
    tasks: [
      { agent: "developer", task: "Implement A" },
      { agent: "developer", task: "Implement B" },
    ],
  };
  const mutations = applyProviderAwareSubagentModels(
    input,
    pdAgents2,
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { projectDefaults: { developer: { model: "anthropic/claude-opus-5", effort: "high" } } },
  );
  assert.equal(mutations, 2);
  assert.equal(input.tasks[0].model, "anthropic/claude-opus-5:high");
  assert.equal(input.tasks[1].model, "anthropic/claude-opus-5:high");
});
