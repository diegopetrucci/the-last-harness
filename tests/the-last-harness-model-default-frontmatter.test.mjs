import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadPrimaryAgents, loadSubagentMetadata, normalizeAgentModelDefaults, parseFrontmatter } =
  await jiti.import("../extensions/the-last-harness/prompts.ts");
const { listAgentModelDefaultReferences, selectProviderAwareAgentDefaults } = await jiti.import(
  "../extensions/the-last-harness/model-defaults.ts",
);

function parseDefaultsDocument(block) {
  const indentedBlock = block
    .trim()
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
  return parseFrontmatter(`---
name: fixture
description: Fixture
tlhModelDefaults:
${indentedBlock}
---
Fixture body
`).tlhModelDefaults;
}

test("parses the approved provider-default frontmatter block into canonical references", () => {
  const parsed = parseFrontmatter(`---
name: fixture
description: Fixture
tlhModelDefaults:
  - provider: openai-codex
    models: [gpt-5.6-luna]
    effort: max
  - provider: anthropic
    models: [claude-sonnet-4-6]
    effort: medium
  - provider: openrouter
    effort: medium
---
Fixture body
`);

  assert.deepEqual(parsed.tlhModelDefaults, [
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
  ]);
  assert.equal(parsed.frontmatter.tlhModelDefaults, undefined);
  assert.equal(parsed.body, "Fixture body");
});

test("drops malformed provider-default entries without weakening valid entries", () => {
  assert.deepEqual(
    parseDefaultsDocument(`
- provider: openai-codex
  models: [gpt-5.6-luna]
  effort: max
- provider: anthropic
  models: claude-sonnet-4-6
  effort: high
- provider: invalid/provider
  models: [must-not-leak]
  effort: high
- provider: openrouter
  effort: unsupported
- provider: openrouter
  effort: medium
`),
    [
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "gpt-5.6-luna" }],
        effort: "max",
      },
      { provider: "openrouter", effort: "medium" },
    ],
  );
});

test("rejects double-prefixed model IDs while preserving internal model slashes", () => {
  assert.deepEqual(
    parseDefaultsDocument(`
- provider: openai-codex
  models: [openai-codex/gpt-5.6-luna]
  effort: max
- provider: openrouter
  models: [vendor/openrouter/model]
  effort: medium
`),
    [
      {
        provider: "openrouter",
        models: [{ provider: "openrouter", id: "vendor/openrouter/model" }],
        effort: "medium",
      },
    ],
  );
});

test("keeps the first valid entry for each provider", () => {
  assert.deepEqual(
    parseDefaultsDocument(`
- provider: anthropic
  models: []
- provider: anthropic
  models: [claude-sonnet-4-6]
  effort: high
- provider: anthropic
  models: [claude-opus-5]
  effort: max
`),
    [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        effort: "high",
      },
    ],
  );
});

test("rejects unknown fields and entries without models or effort", () => {
  assert.deepEqual(
    parseDefaultsDocument(`
- provider: openai-codex
  modelz: [gpt-5.6-luna]
  effort: max
- provider: anthropic
- provider: openrouter
  models: []
- provider: openrouter
  models: []
  effort: medium
`),
    [{ provider: "openrouter", models: [], effort: "medium" }],
  );
});

test("a present provider-default block is authoritative over legacy fields", () => {
  const parsed = parseFrontmatter(`---
name: fixture
description: Fixture
tlhModelDefaults:
  - provider: openrouter
    effort: medium
tlhOpenaiModels: openai-codex/legacy-model
tlhOpenaiThinking: max
---
Fixture body
`);

  assert.deepEqual(parsed.tlhModelDefaults, [{ provider: "openrouter", effort: "medium" }]);
});

test("normalization ignores generic compatibility fields when a provider block is present", () => {
  const normalized = normalizeAgentModelDefaults(
    { model: "anthropic/legacy-model", thinking: "high" },
    [{ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-new" }] }],
  );
  assert.equal(normalized.model, undefined);
  assert.equal(normalized.thinking, undefined);
  assert.equal(normalized.preferredModel, undefined);
  assert.equal(normalized.tlhModelDefaultsSource, "frontmatter");
});

const OPENAI_PROVIDERS = new Set(["openai", "openai-codex"]);
const ANTHROPIC_PROVIDERS = new Set(["anthropic"]);

function loadedModelEntries(agent) {
  return (agent.tlhModelDefaults ?? []).flatMap((entry) =>
    (entry.models ?? [])
      .filter((model) => model.provider === entry.provider)
      .map((model) => ({ entry, model })),
  );
}

function firstModelForFamily(agent, providers) {
  return loadedModelEntries(agent).find(({ model }) => providers.has(model.provider));
}

function effortForModel(agent, model) {
  return loadedModelEntries(agent).find(
    ({ model: candidate }) => candidate.provider === model.provider && candidate.id === model.id,
  )?.entry.effort;
}

test("loaded primaries preserve preferred selection relationships", () => {
  const primaryAgents = [...loadPrimaryAgents().values()];
  assert.ok(primaryAgents.length > 0, "production loader must return primary agents");

  let currentOpenaiOptInCount = 0;
  for (const agent of primaryAgents) {
    const declaredModels = loadedModelEntries(agent);
    const preferred = agent.preferredModel;
    assert.ok(preferred, `${agent.name} must expose its preferred model relationship`);
    assert.deepEqual(preferred, declaredModels[0]?.model, `${agent.name} preferred model`);

    const currentOpenai = firstModelForFamily(agent, OPENAI_PROVIDERS)?.model;
    assert.ok(currentOpenai, `${agent.name} must declare an OpenAI-family model`);
    const available = listAgentModelDefaultReferences(agent);
    const selected = selectProviderAwareAgentDefaults(agent, available, currentOpenai.provider);
    const expected = agent.preferCurrentOpenaiModel ? currentOpenai : preferred;
    assert.deepEqual(selected.model, expected, `${agent.name} selected model`);
    assert.equal(selected.thinking, effortForModel(agent, expected), `${agent.name} effort`);

    if (agent.preferCurrentOpenaiModel) {
      currentOpenaiOptInCount += 1;
    }
  }
  assert.ok(currentOpenaiOptInCount > 0, "a loaded primary must exercise current OpenAI opt-in");
});

test("loaded normal subagents follow each declared provider without primary preferred metadata", () => {
  const normalSubagents = loadSubagentMetadata().filter((agent) => !agent.preferOppositeProvider);
  assert.ok(normalSubagents.length > 0, "production loader must return normal subagents");

  for (const agent of normalSubagents) {
    assert.equal(Object.hasOwn(agent, "preferredModel"), false, `${agent.name} preferred metadata`);
    const declaredModels = loadedModelEntries(agent);
    assert.ok(declaredModels.length > 0, `${agent.name} must declare selectable models`);
    const available = listAgentModelDefaultReferences(agent);
    const providers = new Set(declaredModels.map(({ model }) => model.provider));

    for (const provider of providers) {
      const expected = declaredModels.find(({ model }) => model.provider === provider);
      assert.ok(expected, `${agent.name} expected ${provider} model`);
      const selected = selectProviderAwareAgentDefaults(agent, available, provider);
      assert.deepEqual(selected.model, expected.model, `${agent.name} follows ${provider}`);
      assert.equal(selected.thinking, expected.entry.effort, `${agent.name} ${provider} effort`);
    }
  }
});

test("loaded effort-only OpenRouter defaults follow each current session model", () => {
  const loadedAgents = [...loadPrimaryAgents().values(), ...loadSubagentMetadata()];
  const followAgents = loadedAgents.filter((agent) => !agent.preferOppositeProvider);
  assert.ok(followAgents.length > 0, "production loader must return OpenRouter follow roles");

  for (const agent of followAgents) {
    const openrouterEntry = agent.tlhModelDefaults?.find(
      (entry) => entry.provider === "openrouter",
    );
    assert.ok(openrouterEntry, `${agent.name} must declare OpenRouter defaults`);
    assert.equal(
      openrouterEntry.models,
      undefined,
      `${agent.name} OpenRouter entry is effort-only`,
    );

    const sessionModel = { provider: "openrouter", id: `session/${agent.name}` };
    const selected = selectProviderAwareAgentDefaults(
      agent,
      [sessionModel],
      "openrouter",
      sessionModel,
    );
    assert.deepEqual(selected.model, sessionModel, `${agent.name} follows the session model`);
    assert.equal(selected.thinking, openrouterEntry.effort, `${agent.name} OpenRouter effort`);
  }
});

test("loaded opposite-provider roles select opposite families and retain same-provider fallbacks", () => {
  const oppositeRoles = loadSubagentMetadata().filter((agent) => agent.preferOppositeProvider);
  assert.ok(oppositeRoles.length > 0, "production loader must return opposite-provider roles");

  for (const agent of oppositeRoles) {
    const anthropic = firstModelForFamily(agent, ANTHROPIC_PROVIDERS);
    const openai = firstModelForFamily(agent, OPENAI_PROVIDERS);
    assert.ok(anthropic, `${agent.name} must declare an Anthropic model`);
    assert.ok(openai, `${agent.name} must declare an OpenAI-family model`);

    const bothProviders = [anthropic.model, openai.model];
    const anthropicSelection = selectProviderAwareAgentDefaults(
      agent,
      bothProviders,
      anthropic.model.provider,
    );
    assert.deepEqual(anthropicSelection.model, openai.model, `${agent.name} Anthropic opposite`);
    assert.equal(
      anthropicSelection.thinking,
      openai.entry.effort,
      `${agent.name} Anthropic opposite effort`,
    );
    const anthropicFallback = selectProviderAwareAgentDefaults(
      agent,
      [anthropic.model],
      anthropic.model.provider,
    );
    assert.deepEqual(anthropicFallback.model, anthropic.model, `${agent.name} Anthropic fallback`);

    const openaiSelection = selectProviderAwareAgentDefaults(
      agent,
      bothProviders,
      openai.model.provider,
    );
    assert.deepEqual(openaiSelection.model, anthropic.model, `${agent.name} OpenAI opposite`);
    assert.equal(
      openaiSelection.thinking,
      anthropic.entry.effort,
      `${agent.name} OpenAI opposite effort`,
    );
    const openaiFallback = selectProviderAwareAgentDefaults(
      agent,
      [openai.model],
      openai.model.provider,
    );
    assert.deepEqual(openaiFallback.model, openai.model, `${agent.name} OpenAI fallback`);

    const openrouterSessionModel = {
      provider: "openrouter",
      id: `anthropic/${anthropic.model.id}/session`,
    };
    const openrouterSelection = selectProviderAwareAgentDefaults(
      agent,
      bothProviders,
      "openrouter",
      openrouterSessionModel,
    );
    assert.deepEqual(openrouterSelection.model, openai.model, `${agent.name} OpenRouter opposite`);
    const openrouterFallback = selectProviderAwareAgentDefaults(
      agent,
      [anthropic.model],
      "openrouter",
      openrouterSessionModel,
    );
    assert.deepEqual(
      openrouterFallback.model,
      anthropic.model,
      `${agent.name} OpenRouter same-family fallback`,
    );
  }
});

test("legacy normalization copies generic thinking onto provider entries and preserves fallback provenance", () => {
  const normalized = normalizeAgentModelDefaults({
    model: "anthropic/legacy-model",
    thinking: "medium",
    tlhOpenaiModels: "openai-codex/codex-model",
  });
  assert.equal(normalized.tlhModelDefaultsSource, "legacy");
  assert.equal(normalized.model, "anthropic/legacy-model");
  assert.deepEqual(normalized.preferredModel, {
    provider: "anthropic",
    id: "legacy-model",
  });
  assert.deepEqual(normalized.tlhModelDefaults, [
    {
      provider: "openai-codex",
      models: [{ provider: "openai-codex", id: "codex-model" }],
      effort: "medium",
    },
  ]);
});

test("legacy normalization preserves interleaved OpenAI provider order for family and exact-provider scans", () => {
  const normalized = normalizeAgentModelDefaults({
    tlhOpenaiModels: "openai-codex/codex-first, openai/openai-middle, openai-codex/codex-last",
    tlhAnthropicModels: "anthropic/anthropic-last",
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "medium",
  });
  const expectedReferences = [
    { provider: "openai-codex", id: "codex-first" },
    { provider: "openai", id: "openai-middle" },
    { provider: "openai-codex", id: "codex-last" },
    { provider: "anthropic", id: "anthropic-last" },
  ];

  assert.deepEqual(
    normalized.tlhModelDefaults,
    expectedReferences.map((model) => ({
      provider: model.provider,
      models: [model],
      effort: model.provider === "anthropic" ? "medium" : "high",
    })),
  );
  const agent = { name: "legacy-interleaved", ...normalized };
  assert.deepEqual(listAgentModelDefaultReferences(agent), expectedReferences);

  // The first codex candidate is unavailable. Legacy family order must then
  // select openai/middle before the later codex candidate, even in a codex session.
  const available = [expectedReferences[1], expectedReferences[2]];
  assert.deepEqual(
    selectProviderAwareAgentDefaults(agent, available, "openai-codex").model,
    expectedReferences[1],
  );
});

test("legacy normalization rejects misplaced cross-family provider-list candidates", () => {
  const normalized = normalizeAgentModelDefaults({
    tlhOpenaiModels: "anthropic/wrong-openai-entry, openai-codex/codex-valid, openai/openai-valid",
    tlhAnthropicModels: "openai-codex/wrong-anthropic-entry, anthropic/anthropic-valid",
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "medium",
  });
  const expectedReferences = [
    { provider: "openai-codex", id: "codex-valid" },
    { provider: "openai", id: "openai-valid" },
    { provider: "anthropic", id: "anthropic-valid" },
  ];

  assert.deepEqual(normalized.tlhModelDefaults, [
    {
      provider: "openai-codex",
      models: [expectedReferences[0]],
      effort: "high",
    },
    {
      provider: "openai",
      models: [expectedReferences[1]],
      effort: "high",
    },
    {
      provider: "anthropic",
      models: [expectedReferences[2]],
      effort: "medium",
    },
  ]);
  assert.deepEqual(
    listAgentModelDefaultReferences({ name: "legacy-cross-family", ...normalized }),
    expectedReferences,
  );
});

test("legacy provider-specific effort keeps missing provider entries available", () => {
  const normalized = normalizeAgentModelDefaults({
    tlhOpenaiModels: "anthropic/misplaced-openai-entry",
    tlhAnthropicModels: "openai-codex/misplaced-anthropic-entry",
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "medium",
    tlhOpenrouterThinking: "low",
  });

  assert.deepEqual(normalized.tlhModelDefaults, [
    { provider: "openai", effort: "high" },
    { provider: "openai-codex", effort: "high" },
    { provider: "anthropic", effort: "medium" },
    { provider: "openrouter", effort: "low" },
  ]);
});
