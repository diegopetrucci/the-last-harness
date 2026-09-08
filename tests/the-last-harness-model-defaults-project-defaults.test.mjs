import assert from "node:assert/strict";
import test from "node:test";

import { createModelDefaultsTestContext } from "./the-last-harness-model-defaults-support.mjs";

const { applyProviderAwareSubagentModels, getProviderAwareFallbackModels } =
  createModelDefaultsTestContext();

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
  assert.ok(
    Array.isArray(getProviderAwareFallbackModels(input)),
    "fallback models generated for opposite-role",
  );
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
  assert.ok(
    Array.isArray(getProviderAwareFallbackModels(input)),
    "fallback models generated for opposite-role",
  );
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
  assert.equal(getProviderAwareFallbackModels(input), undefined);
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
  assert.equal(getProviderAwareFallbackModels(input), undefined);
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

test("project defaults: mixed packaged and embedded dispatch only mutates packaged targets", () => {
  const input = {
    tasks: [
      { agent: "developer", task: "Implement the packaged task" },
      { agent: "embedded.reviewer", task: "Run the captured project reviewer" },
    ],
  };
  const beforeEmbedded = { ...input.tasks[1] };
  const mutations = applyProviderAwareSubagentModels(
    input,
    new Map([...pdAgents2, ["embedded.reviewer", { ...pdDeveloper, name: "embedded.reviewer" }]]),
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["developer", { model: "openai-codex/gpt-5.6-luna", thinking: "high" }],
        ["embedded.reviewer", { model: "openai-codex/gpt-5.6-luna", thinking: "max" }],
      ]),
      projectDefaults: {
        developer: { model: "anthropic/claude-opus-5", effort: "high" },
        "embedded.reviewer": { model: "openai-codex/gpt-5.6-luna", effort: "max" },
      },
    },
  );
  assert.equal(mutations, 1);
  assert.equal(input.tasks[0].model, "anthropic/claude-opus-5:high");
  assert.deepEqual(input.tasks[1], beforeEmbedded);
});

test("project defaults: direct embedded target guard ignores project and stored model policy", () => {
  const input = {
    agent: "embedded.reviewer",
    task: "Run from the exact captured configuration",
    model: "anthropic/claude-sonnet-4-6",
    fallbackModels: ["caller/fallback"],
  };
  const before = { ...input, fallbackModels: [...input.fallbackModels] };
  const mutations = applyProviderAwareSubagentModels(
    input,
    new Map([["embedded.reviewer", { ...pdDeveloper, name: "embedded.reviewer" }]]),
    pdAllModels,
    "anthropic",
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    {
      agentOverrides: new Map([
        ["embedded.reviewer", { model: "openai-codex/gpt-5.6-luna", thinking: "max" }],
      ]),
      projectDefaults: {
        "embedded.reviewer": { model: "openai-codex/gpt-5.6-luna", effort: "high" },
      },
    },
  );
  assert.equal(mutations, 0);
  assert.deepEqual(input, before);
});
