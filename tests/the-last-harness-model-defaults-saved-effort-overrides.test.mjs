import assert from "node:assert/strict";
import test from "node:test";

import { createModelDefaultsTestContext } from "./the-last-harness-model-defaults-support.mjs";

const {
  agents,
  applyProviderAwareSubagentModels,
  applyRuntimeThinkingSuffix,
  buildPiArgs,
  developer,
  findAvailableProviderModel,
  getProviderAwareFallbackModels,
  reasoningAnthropicAvailable,
  reasoningCodexAvailable,
  reasoningOpenaiAvailable,
  reducedIndependenceNotice,
  resolveProviderAwareSubagentResolution,
  splitKnownThinkingSuffix,
} = createModelDefaultsTestContext();

// =============================================================================
// Stored override tests (re-landed from feat/subagent-model-effort-settings)
// =============================================================================

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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5:high:low"]);
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

test("saved effort is forwarded to the current custom-provider session model", () => {
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
  assert.equal(unsupportedInput.model, "custom-provider/limited:high");
  assert.equal(
    applyRuntimeThinkingSuffix(unsupportedInput.model, "high", false),
    unsupportedInput.model,
  );
  assert.equal(warnings.length, 1);
  const expectedWarning =
    'TLH stored minor-agent effort "high" is not advertised by custom-provider/limited; the :high suffix is forwarded and Pi will validate it.';
  assert.equal(warnings[0], expectedWarning);
  const unsupportedResolution = resolveProviderAwareSubagentResolution(
    overrideDeveloper,
    unsupportedCurrentModel,
    "custom-provider",
    { provider: "custom-provider", id: "limited" },
    { thinking: "high" },
  );
  assert.equal(unsupportedResolution.model, unsupportedCurrentModel[0]);
  assert.equal(unsupportedResolution.thinking, "high");
  assert.equal(unsupportedResolution.warning, expectedWarning);
});

test("thinking-only overrides retain recognized effort without a selected model", () => {
  const input = { agent: "developer", task: "Implement the ticket" };
  const warnings = [];
  const currentModel = { provider: "custom-provider", id: "not-listed" };
  assert.equal(
    applyProviderAwareSubagentModels(input, agents, [], "custom-provider", currentModel, {
      agentOverrides: new Map([["developer", { thinking: "high" }]]),
      onWarning: (warning) => warnings.push(warning.message),
    }),
    0,
  );
  assert.equal(input.model, undefined);
  assert.deepEqual(warnings, []);

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
  assert.equal(resolution.thinking, "high");
  assert.equal(resolution.warning, undefined);
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

test("explicit unknown models retain configured effort even when the registry is empty", () => {
  for (const available of [reasoningAnthropicAvailable, []]) {
    const input = { agent: "developer", task: "Implement", model: "vendor/unknown" };
    const warnings = [];
    assert.equal(
      applyProviderAwareSubagentModels(
        input,
        overrideAgents,
        available,
        "openai-codex",
        undefined,
        {
          agentOverrides: new Map([["developer", { thinking: "high" }]]),
          onWarning: (warning) => warnings.push(warning.message),
        },
      ),
      1,
    );
    assert.equal(input.model, "vendor/unknown:high");
    assert.deepEqual(warnings, []);
  }
});

test("known registry models forward unadvertised effort", () => {
  const available = [
    {
      provider: "custom-provider",
      id: "no-neutralizer",
      reasoning: true,
      thinkingLevelMap: { off: null, high: null, xhigh: null, max: null },
    },
  ];
  const input = { agent: "developer", task: "Implement", model: "custom-provider/no-neutralizer" };
  const warnings = [];
  assert.equal(
    applyProviderAwareSubagentModels(
      input,
      overrideAgents,
      available,
      "custom-provider",
      undefined,
      {
        agentOverrides: new Map([["developer", { thinking: "high" }]]),
        onWarning: (warning) => warnings.push(warning.message),
      },
    ),
    1,
  );
  assert.equal(input.model, "custom-provider/no-neutralizer:high");
  assert.deepEqual(warnings, [
    'TLH stored minor-agent effort "high" is not advertised by custom-provider/no-neutralizer; the :high suffix is forwarded and Pi will validate it.',
  ]);
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

test("unavailable persisted string pins retain recognized effort for Pi validation", () => {
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
  assert.equal(input.model, "openai-codex/gpt-5.999:high");
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
  assert.equal(Object.hasOwn(input, "modelFallbackNotice"), false);
  assert.equal(warnings.length, 2);
  assert.equal(
    warnings[0],
    'TLH saved minor-agent model override "openai-codex/gpt-5.999" is not in the available registry for code-reviewer; forwarding the model argument to Pi for validation instead of swapping in bundled defaults. Update it with /subagent-settings set code-reviewer model <provider/id> or clear it with /subagent-settings reset code-reviewer model.',
  );
  assert.equal(
    warnings[1],
    'TLH stored minor-agent effort "high" had unavailable capability metadata for saved model "openai-codex/gpt-5.999"; the :high suffix is forwarded and Pi will validate it for code-reviewer.',
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
  assert.equal(resolution.thinking, "high");
  assert.equal(
    resolution.warning,
    'TLH stored minor-agent effort "high" had unavailable capability metadata for saved model "openai-codex/gpt-5.999"; the :high suffix is forwarded and Pi will validate it for code-reviewer.',
  );
});

test("recognized defaults efforts reach subagent argv for every model provenance", () => {
  const cases = [
    {
      label: "explicit unknown model",
      input: { agent: "developer", task: "Review the diff", model: "custom/unknown" },
      available: reasoningAnthropicAvailable,
      override: { thinking: "max" },
      expected: "custom/unknown:max",
    },
    {
      label: "unavailable saved pin",
      input: { agent: "code-reviewer", task: "Review the diff" },
      available: reasoningAnthropicAvailable,
      override: { model: "openai-codex/gpt-5.999", thinking: "high" },
      expected: "openai-codex/gpt-5.999:high",
    },
    {
      label: "known model without advertised effort",
      input: { agent: "developer", task: "Review the diff" },
      available: [
        {
          provider: "custom-provider",
          id: "limited",
          reasoning: true,
          thinkingLevelMap: { high: null },
        },
      ],
      override: { model: "custom-provider/limited", thinking: "high" },
      expected: "custom-provider/limited:high",
    },
  ];

  for (const testCase of cases) {
    const input = { ...testCase.input };
    assert.equal(
      applyProviderAwareSubagentModels(
        input,
        overrideAgents,
        testCase.available,
        "anthropic",
        undefined,
        { agentOverrides: new Map([[testCase.input.agent, testCase.override]]) },
      ),
      1,
      testCase.label,
    );
    assert.equal(input.model, testCase.expected, testCase.label);

    const { args } = buildPiArgs({
      baseArgs: [],
      task: input.task,
      sessionEnabled: false,
      model: input.model,
      inheritProjectContext: false,
      inheritSkills: false,
      supervisorBridge: false,
    });
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, testCase.label);
    assert.equal(args[modelIndex + 1], testCase.expected, testCase.label);
  }
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
    'TLH saved minor-agent model override "openai-codex/gpt-5.999" is not in the available registry for code-reviewer; forwarding the model argument to Pi for validation instead of swapping in bundled defaults. Update it with /subagent-settings set code-reviewer model <provider/id> or clear it with /subagent-settings reset code-reviewer model.';
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

test("model-only overrides forward bundled effort without capability filtering", () => {
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
  assert.equal(nonReasoningResolution.thinking, "medium");

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
  assert.equal(nonReasoningInput.model, "openai-codex/plain:medium");

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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5:high"]);
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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5:off"]);
});

test("unsupported stored effort is forwarded on the primary and generated fallback models", () => {
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
  assert.equal(input.model, "openai-codex/gpt-5.6-sol:xhigh");
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5:xhigh"]);
  const fallbackModels = getProviderAwareFallbackModels(input);
  assert.ok(fallbackModels);

  // The runtime receives the recognized suffix directly and leaves it intact.
  assert.equal(applyRuntimeThinkingSuffix(input.model, "xhigh", false), input.model);
  assert.equal(applyRuntimeThinkingSuffix(fallbackModels[0], "xhigh", false), fallbackModels[0]);
  assert.match(input.model, /:xhigh$/);
  assert.match(fallbackModels[0], /:xhigh$/);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "xhigh" is not advertised by openai-codex/gpt-5.6-sol; the :xhigh suffix is forwarded and Pi will validate it.',
  );
});

test("invalid stored effort is omitted with an invalid-effort warning", () => {
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
  assert.equal(input.model, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5"]);
  const fallbackModels = getProviderAwareFallbackModels(input);
  assert.ok(fallbackModels);
  assert.equal(
    applyRuntimeThinkingSuffix(input.model, "turbo", false),
    "openai-codex/gpt-5.6-sol:turbo",
  );
  assert.equal(
    applyRuntimeThinkingSuffix(fallbackModels[0], "turbo", false),
    "anthropic/claude-opus-5:turbo",
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH ignored invalid stored minor-agent effort "turbo" for bundled-reviewer; expected one of off, minimal, low, medium, high, xhigh, max, so no effort suffix was applied.',
  );
});

test("defaults layer forwards unadvertised stored effort", () => {
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
  assert.equal(input.model, "anthropic/no-neutralizer:xhigh");
  // Pi receives the recognized suffix and validates it at model dispatch time.
  assert.equal(applyRuntimeThinkingSuffix(input.model, "xhigh", false), input.model);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "xhigh" is not advertised by anthropic/no-neutralizer; the :xhigh suffix is forwarded and Pi will validate it.',
  );
});

test("recognized effort survives an incompatible generated fallback", () => {
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
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/claude-opus-5:high"]);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    'TLH stored minor-agent effort "high" is not advertised by generated fallback anthropic/claude-opus-5; the :high suffix is forwarded and Pi will validate it.',
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
// `max` is always a valid suffix; the defaults layer forwards it and Pi validates
// whether the selected model accepts it.

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

test("stored max effort warns but remains a suffix when capability metadata lacks max", () => {
  // No `max` key means Pi may reject the forwarded suffix at dispatch time.
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
  assert.equal(resolution.thinking, "max");
  const expectedWarning =
    'TLH stored minor-agent effort "max" is not advertised by anthropic/plain-reasoner; the :max suffix is forwarded and Pi will validate it.';
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
  // The recognized suffix is forwarded rather than replaced with `off`.
  assert.equal(input.model, "anthropic/plain-reasoner:max");
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
