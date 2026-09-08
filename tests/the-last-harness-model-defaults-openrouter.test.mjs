import assert from "node:assert/strict";
import test from "node:test";

import { createModelDefaultsTestContext } from "./the-last-harness-model-defaults-support.mjs";

const {
  anthropicAvailable,
  applyProviderAwareSubagentModels,
  codexAvailable,
  resolveProviderAwareSubagentResolution,
  resolveProviderThinking,
  selectProviderAwareAgentDefaults,
} = createModelDefaultsTestContext();

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
