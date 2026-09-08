import assert from "node:assert/strict";
import test from "node:test";

import { createModelDefaultsTestContext } from "./the-last-harness-model-defaults-support.mjs";

const {
  agents,
  anthropicAvailable,
  anthropicFirstPrimary,
  anthropicParentPrefersCodexReviewer,
  applyProviderAwareSubagentModels,
  bugHunterPrimary,
  codeReviewer,
  codexAvailable,
  developer,
  getProviderAwareFallbackModels,
  openaiAvailable,
  openaiParentPrefersAnthropicReviewer,
  productPrimary,
  reasoningAnthropicAvailable,
  reasoningCodexAvailable,
  reducedIndependenceNotice,
  resolveProviderAwareSubagentResolution,
  rushLikePrimary,
  selectedProviderModelId,
  selectProviderAwareAgentDefaults,
} = createModelDefaultsTestContext();

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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5"]);
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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["openai-codex/gpt-5.6-sol"]);
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
  assert.deepEqual(getProviderAwareFallbackModels(anthropicInput), [
    "anthropic/claude-opus-5:high",
  ]);
  assert.equal(anthropicInput.modelFallbackNotice, reducedIndependenceNotice);

  const codexInput = { agent: "code-reviewer" };
  assert.equal(applyProviderAwareSubagentModels(codexInput, agents, available, "openai-codex"), 1);
  assert.equal(codexInput.model, "anthropic/claude-opus-5:high");
  assert.deepEqual(getProviderAwareFallbackModels(codexInput), ["openai-codex/gpt-5.6-sol:high"]);
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
  assert.deepEqual(getProviderAwareFallbackModels(anthropicSession), [
    "openrouter/anthropic/claude-sonnet-4-6:low",
  ]);
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
  assert.deepEqual(getProviderAwareFallbackModels(openaiSession), [
    "openrouter/openai/gpt-5.6:low",
  ]);

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
  assert.deepEqual(getProviderAwareFallbackModels(input), [
    "openrouter/anthropic/claude-sonnet-4-6:high",
  ]);
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
  assert.deepEqual(getProviderAwareFallbackModels(reviewerInput), [
    "anthropic/claude-sonnet-4-6:high",
  ]);
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
  assert.deepEqual(getProviderAwareFallbackModels(oracleInput), ["openai-codex/gpt-5.6-luna:high"]);
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
  assert.deepEqual(getProviderAwareFallbackModels(withFallbackNotice), [
    "openai-codex/gpt-5.6-sol:high",
  ]);
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
  assert.deepEqual(getProviderAwareFallbackModels(anthropicInput), [
    "anthropic/claude-opus-5:medium",
  ]);
  assert.equal(anthropicInput.modelFallbackNotice, reducedIndependenceNotice);

  // Codex session → primary is Anthropic (opposite) with Anthropic thinking,
  // fallback is Codex (same) with OpenAI thinking.
  const codexInput = { agent: reviewerWithThinking.name, task: "Review" };
  assert.equal(
    applyProviderAwareSubagentModels(codexInput, agentsMap, available, "openai-codex"),
    1,
  );
  assert.equal(codexInput.model, "anthropic/claude-opus-5:medium");
  assert.deepEqual(getProviderAwareFallbackModels(codexInput), ["openai-codex/gpt-5.6-sol:max"]);
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
