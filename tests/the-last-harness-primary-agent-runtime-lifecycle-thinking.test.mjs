import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createToolCallContext,
  registerRuntimeHarness,
  writePrimaryConfig,
  createPrimaryPrompt,
  rushLikePrimary,
  selectablePrimaryAgents,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");

const PRE_BIND_RUNTIME_ERROR =
  "Extension runtime not initialized. Action methods cannot be called during extension loading.";

const { getTlhProjectAgentAccess } =
  await import("../extensions/the-last-harness/project-agent-access.mjs");

function projectAgentSessionContext(fixture, notifications, sessionId) {
  const branch = [
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ];
  return createToolCallContext(branch, notifications, {
    cwd: fixture.cwd,
    hasUI: true,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
    },
  });
}

test("primary runtime warns once when persisted project trust denies an exact custom directory", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-project-trust-warning-", {
    cwd: true,
    test: t,
  });
  const customDirectory = join(fixture.cwd, ".tlh", "agents", "custom");
  mkdirSync(customDirectory, { recursive: true });
  writeFileSync(join(customDirectory, "SECRET.md"), "definition content must not surface\n");
  const notifications = [];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
      projectAgentLoader: async () => ({
        status: "denied",
        projectRoot: fixture.cwd,
        agentsDirectory: customDirectory,
        trust: { kind: "project-agent", trusted: false, source: "no-persisted-trust" },
        diagnostics: ["definition content must not surface"],
      }),
    });
    await applySessionStart(projectAgentSessionContext(fixture, notifications, "trust-session"));

    const trustWarnings = notifications.filter(
      ({ message, type }) => type === "warning" && /project custom agents/i.test(message),
    );
    assert.equal(trustWarnings.length, 1);
    assert.match(trustWarnings[0].message, /\/trust/);
    assert.match(trustWarnings[0].message, /persist.*trust/i);
    assert.match(trustWarnings[0].message, /retry/i);
    assert.doesNotMatch(trustWarnings[0].message, /definition content must not surface/);
  });
});

test("primary runtime does not treat project-config trust as persisted project-agent denial", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-project-trust-kind-", {
    cwd: true,
    test: t,
  });
  const customDirectory = join(fixture.cwd, ".tlh", "agents", "custom");
  mkdirSync(customDirectory, { recursive: true });
  const notifications = [];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
      projectAgentLoader: async () => ({
        status: "denied",
        projectRoot: fixture.cwd,
        agentsDirectory: customDirectory,
        // A configuration-plane denial must not trigger the persisted agent
        // denial warning, even though its shape is otherwise valid.
        trust: { kind: "project-config", trusted: false, source: "saved-negative" },
        diagnostics: [],
      }),
    });
    await applySessionStart(
      projectAgentSessionContext(fixture, notifications, "trust-kind-session"),
    );

    assert.equal(
      notifications.some(
        ({ message, type }) => type === "warning" && /project custom agents/i.test(message),
      ),
      false,
      "project-config trust must not trigger the persisted project-agent denial warning",
    );
  });
});

test("primary runtime rejects a config-plane-shaped result at the agent boundary", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-project-agent-trust-kind-", {
    cwd: true,
    test: t,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
      // Configuration defaults do not carry the capability/provenance/manifest
      // required by the agent plane, so even a config trust tag cannot create
      // project-agent authority.
      projectAgentLoader: async () => ({
        status: "loaded",
        trust: { kind: "project-config", trusted: true, source: "saved-positive" },
      }),
      projectDefaultsLoader: async () => ({ status: "unavailable", warnings: [] }),
    });
    await applySessionStart(projectAgentSessionContext(fixture, [], "trust-kind-session"));

    assert.equal(
      getTlhProjectAgentAccess({ cwd: fixture.cwd, sessionId: "trust-kind-session" }),
      undefined,
      "a config-plane-shaped result must not create project-agent authority",
    );
  });
});

test("primary runtime keeps the absent project-agent fast path quiet", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-project-trust-empty-", {
    cwd: true,
    test: t,
  });
  const notifications = [];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
      projectAgentLoader: async () => ({
        status: "loaded",
        trust: { kind: "project-agent", trusted: true, source: "no-project-agents" },
      }),
    });
    await applySessionStart(projectAgentSessionContext(fixture, notifications, "empty-session"));

    assert.equal(
      notifications.filter(
        ({ message, type }) => type === "warning" && /project custom agents/i.test(message),
      ).length,
      0,
    );
  });
});

test("primary runtime deduplicates project trust warnings per session", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-project-trust-dedupe-", {
    cwd: true,
    test: t,
  });
  const customDirectory = join(fixture.cwd, ".tlh", "agents", "custom");
  mkdirSync(customDirectory, { recursive: true });
  const notifications = [];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { applySessionStart } = registerRuntimeHarness({
      primaryAgents: selectablePrimaryAgents(),
      subagentMetadata: [],
      projectAgentLoader: async () => ({
        status: "denied",
        projectRoot: fixture.cwd,
        agentsDirectory: customDirectory,
        trust: { kind: "project-agent", trusted: false, source: "saved-negative" },
        diagnostics: [],
      }),
    });
    await applySessionStart(projectAgentSessionContext(fixture, notifications, "same-session"));
    await applySessionStart(projectAgentSessionContext(fixture, notifications, "same-session"));
    assert.equal(
      notifications.filter(({ message }) => /project custom agents/i.test(message)).length,
      1,
    );

    await applySessionStart(projectAgentSessionContext(fixture, notifications, "new-session"));
    assert.equal(
      notifications.filter(({ message }) => /project custom agents/i.test(message)).length,
      2,
    );
  });
});

test("primary runtime explains the canonical custom-agent path when blocking an unknown embedded target", async () => {
  const { toolCall } = registerRuntimeHarness({
    primaryAgents: selectablePrimaryAgents(),
    subagentMetadata: [],
  });
  const ctx = createToolCallContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "architect" },
    },
  ]);
  const result = await toolCall(
    {
      toolName: "subagent",
      input: { agent: "embedded.unknown-helper", task: "blocked" },
    },
    ctx,
  );

  assert.equal(result?.block, true);
  assert.match(
    result?.reason ?? "",
    /validated Git-root path \.tlh\/agents\/custom\/<UPPERCASE-SLUG>\.md/,
  );
  assert.match(result?.reason ?? "", /\/trust/);
  assert.match(result?.reason ?? "", /retry/i);
  assert.doesNotMatch(
    result?.reason ?? "",
    /<agent-dir>\/agents|\.the-last-harness\/agent\/agents/,
  );
});

test("primary runtime applies OpenAI Rush-like metadata defaults with no settings opt-in", async () => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      assert.ok(runtime, "runtime should register outside child sessions");

      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.6-luna" }] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      });

      assert.deepEqual(pi.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
      assert.equal(pi.thinkingLevel, "medium");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("primary runtime follows OpenRouter session models and resolves effective provider thinking", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const openrouterModel = { provider: "openrouter", id: "openai/gpt-5.4" };
  const availableModels = [
    openrouterModel,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-sonnet-4-6",
    thinking: "low",
    tlhAnthropicThinking: "high",
    tlhOpenaiThinking: "medium",
    tlhOpenrouterThinking: "max",
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([["architect", architectPrimary]]);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const makeCtx = () => ({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => availableModels },
        model: openrouterModel,
      });

      const first = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      await first.runtime.applySessionStart(makeCtx());
      assert.equal(
        first.pi.model,
        undefined,
        "primary leaves the OpenRouter session model untouched",
      );
      assert.equal(
        first.pi.thinkingLevel,
        "max",
        "OpenRouter thinking applies to effective session model",
      );

      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "anthropic/claude-sonnet-4-6" },
      });
      const anthropicPin = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      await anthropicPin.runtime.applySessionStart(makeCtx());
      assert.deepEqual(anthropicPin.pi.model, availableModels[1]);
      assert.equal(
        anthropicPin.pi.thinkingLevel,
        "high",
        "stored Anthropic pin selects Anthropic thinking",
      );

      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });
      const codexPin = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      await codexPin.runtime.applySessionStart(makeCtx());
      assert.deepEqual(codexPin.pi.model, availableModels[2]);
      assert.equal(codexPin.pi.thinkingLevel, "medium", "stored Codex pin selects OpenAI thinking");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("overrideable primary on OpenRouter keeps the session model while applying its default thinking", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const sessionModel = { provider: "openrouter", id: "anthropic/claude-sonnet-4-6" };
  const rushPrimary = createPrimaryPrompt("rush", {
    model: "anthropic/claude-opus-4-8",
    thinking: "low",
    tlhOpenrouterThinking: "high",
    applyModel: true,
    applyThinking: true,
  });
  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi, runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["rush", rushPrimary]]),
        subagentMetadata: [],
      });
      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: "rush" },
            },
          ],
        },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [sessionModel] },
        model: sessionModel,
      });
      assert.equal(pi.model, undefined, "OpenRouter primary follows the active session model");
      assert.equal(pi.thinkingLevel, "high", "OpenRouter primary applies its default thinking");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("primaries retain explicit thinking through turns, model switches, and mode boundaries", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-thinking-lifecycle-", {
    cwd: true,
    test: t,
  });
  const primaryDefinitions = [
    {
      name: "rush",
      model: "anthropic/claude-sonnet-4-6",
      openaiModel: "openai-codex/gpt-5.6-luna",
      thinking: "low",
      openaiThinking: "medium",
      anthropicThinking: "low",
      openrouterThinking: "low",
    },
    {
      name: "product",
      model: "anthropic/claude-opus-5",
      openaiModel: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      openaiThinking: "high",
      anthropicThinking: "high",
      openrouterThinking: "high",
    },
    {
      name: "bug-hunter",
      model: "anthropic/claude-opus-5",
      openaiModel: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      openaiThinking: "high",
      anthropicThinking: "high",
      openrouterThinking: "high",
    },
  ];
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
    tlhOpenaiThinking: "high",
    tlhAnthropicThinking: "high",
    tlhOpenrouterThinking: "high",
    applyModel: true,
    applyThinking: true,
  });
  const reasoning = { reasoning: true };
  const directModels = [
    { provider: "anthropic", id: "claude-sonnet-4-6", ...reasoning },
    { provider: "anthropic", id: "claude-opus-5", ...reasoning },
    { provider: "openai-codex", id: "gpt-5.4", ...reasoning },
    { provider: "openai-codex", id: "gpt-5.6-luna", ...reasoning },
    { provider: "openai-codex", id: "gpt-5.6-sol", ...reasoning },
  ];
  const openrouterModels = [
    { provider: "openrouter", id: "anthropic/claude-opus-5", ...reasoning },
    { provider: "openrouter", id: "openai/gpt-5.4", ...reasoning },
  ];

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      for (const scenario of [
        {
          label: "direct provider",
          models: directModels,
          initial: (definition) =>
            directModels.find(
              (model) => model.id === definition.model.slice(definition.model.indexOf("/") + 1),
            ),
          switched: directModels.find((model) => model.id === "gpt-5.4"),
          switchedProvider: "openai-codex",
        },
        {
          label: "OpenRouter",
          models: openrouterModels,
          initial: () => openrouterModels[0],
          switched: openrouterModels[1],
          switchedProvider: "openrouter",
        },
      ]) {
        for (const definition of primaryDefinitions) {
          const primary = createPrimaryPrompt(definition.name, {
            model: definition.model,
            tlhOpenaiModels: [definition.openaiModel],
            thinking: definition.thinking,
            tlhOpenaiThinking: definition.openaiThinking,
            tlhAnthropicThinking: definition.anthropicThinking,
            tlhOpenrouterThinking: definition.openrouterThinking,
            preferCurrentOpenaiModel: definition.name === "rush",
            applyModel: true,
            applyThinking: true,
          });
          const primaryAgents = new Map([
            ["architect", architectPrimary],
            [definition.name, primary],
          ]);
          writePrimaryConfig(fixture.agent, { selected: definition.name });
          const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
            primaryAgents,
            subagentMetadata: [],
          });
          assert.ok(runtime, `${scenario.label}/${definition.name} runtime should register`);
          registerEffortCommand(pi, runtime);
          const sessionBranch = (selection) => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: selection },
            },
          ];
          const makeContext = (selection, model) => ({
            cwd: fixture.cwd,
            sessionManager: { getBranch: () => sessionBranch(selection) },
            ui: { notify() {} },
            modelRegistry: { getAvailable: () => scenario.models },
            model,
          });
          const initialModel = scenario.initial(definition);
          assert.ok(initialModel, `${scenario.label}/${definition.name} initial model exists`);
          const initialContext = makeContext(definition.name, initialModel);

          await runtime.applySessionStart(initialContext);
          assert.equal(
            pi.thinkingLevel,
            definition.thinking,
            `${scenario.label}/${definition.name} applies its packaged initial thinking`,
          );

          await pi.commands.get("effort").handler("off", {
            model: initialModel,
            hasUI: false,
            ui: { notify() {} },
          });
          assert.equal(pi.thinkingLevel, "off");

          await beforeAgentStart({ systemPrompt: "base" }, initialContext);
          assert.equal(
            pi.thinkingLevel,
            "off",
            `${scenario.label}/${definition.name} keeps the selected level on the next turn`,
          );

          const sessionTree = pi.events.find((event) => event.name === "session_tree")?.handler;
          assert.equal(typeof sessionTree, "function");
          await sessionTree({}, initialContext);
          assert.equal(
            pi.thinkingLevel,
            "off",
            `${scenario.label}/${definition.name} keeps the selected level on session-tree replay`,
          );

          const switchedContext = makeContext(definition.name, scenario.switched);
          await beforeAgentStart({ systemPrompt: "base" }, switchedContext);
          assert.equal(
            pi.thinkingLevel,
            "off",
            `${scenario.label}/${definition.name} keeps the selected level after ${scenario.switchedProvider} model reapplication`,
          );

          const architectContext = makeContext("architect", scenario.switched);
          await sessionTree({}, architectContext);
          assert.equal(
            pi.thinkingLevel,
            "high",
            `${scenario.label}/${definition.name} clears the session selection at an explicit mode boundary`,
          );

          await sessionTree({}, switchedContext);
          const switchedThinking =
            scenario.switchedProvider === "openai-codex"
              ? definition.openaiThinking
              : definition.openrouterThinking;
          assert.equal(
            pi.thinkingLevel,
            switchedThinking,
            `${scenario.label}/${definition.name} restores the switched-provider packaged default`,
          );

          await pi.commands.get("effort").handler("off", {
            model: scenario.switched,
            hasUI: false,
            ui: { notify() {} },
          });
          await runtime.applySessionStart(switchedContext);
          assert.equal(
            pi.thinkingLevel,
            switchedThinking,
            `${scenario.label}/${definition.name} clears the selection at a new session`,
          );
        }
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("primaries honor an explicit durable thinking level across sessions and mode changes", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-durable-thinking-", {
    cwd: true,
    test: t,
  });
  const model = {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const definitions = [
    { name: "rush", thinking: "low", model: "anthropic/claude-sonnet-4-6" },
    { name: "product", thinking: "high", model: "anthropic/claude-opus-5" },
    { name: "bug-hunter", thinking: "high", model: "anthropic/claude-opus-5" },
  ];
  const architect = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    applyModel: false,
    applyThinking: true,
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      for (const definition of definitions) {
        writeFileSync(
          join(fixture.agent, "settings.json"),
          `${JSON.stringify(
            {
              defaultThinkingLevel: "medium",
              tlh: { primaryAgent: { enabled: true, selected: definition.name } },
            },
            null,
            2,
          )}\n`,
        );
        const primary = createPrimaryPrompt(definition.name, {
          model: definition.model,
          thinking: definition.thinking,
          tlhAnthropicThinking: definition.thinking,
          tlhOpenrouterThinking: definition.thinking,
          applyModel: false,
          applyThinking: true,
        });
        const primaryAgents = new Map([
          ["architect", architect],
          [definition.name, primary],
        ]);
        const { pi, runtime } = registerRuntimeHarness({
          primaryAgents,
          subagentMetadata: [],
        });
        const branch = { selected: definition.name };
        const context = (selection = branch.selected) => ({
          cwd: fixture.cwd,
          sessionManager: {
            getBranch: () => [
              {
                type: "custom",
                customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
                data: { selected: selection },
              },
            ],
          },
          ui: { notify() {} },
          modelRegistry: { getAvailable: () => [model] },
          model,
        });

        await runtime.applySessionStart(context());
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} honors the persisted upstream thinking choice on startup`,
        );

        const sessionTree = pi.events.find((event) => event.name === "session_tree")?.handler;
        assert.equal(typeof sessionTree, "function");
        await sessionTree({}, context("architect"));
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} keeps the durable choice after an explicit primary-mode change`,
        );

        await runtime.applySessionStart(context());
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} restores the durable choice in a new session`,
        );
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("native thinking cycle changes are retained for every primary without a default write", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-native-thinking-", {
    cwd: true,
    test: t,
  });
  const model = {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const definitions = [
    { name: "rush", thinking: "low" },
    { name: "product", thinking: "high" },
    { name: "bug-hunter", thinking: "high" },
  ];

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      for (const definition of definitions) {
        writeFileSync(
          join(fixture.agent, "settings.json"),
          `${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: definition.name } } }, null, 2)}\n`,
        );
        const primary = createPrimaryPrompt(definition.name, {
          model: "anthropic/claude-opus-5",
          thinking: definition.thinking,
          tlhAnthropicThinking: definition.thinking,
          applyModel: false,
          applyThinking: true,
        });
        const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
          primaryAgents: new Map([[definition.name, primary]]),
          subagentMetadata: [],
        });
        const context = {
          cwd: fixture.cwd,
          sessionManager: { getBranch: () => [] },
          ui: { notify() {} },
          modelRegistry: { getAvailable: () => [model] },
          model,
        };
        const thinkingSelect = pi.events.find(
          (event) => event.name === "thinking_level_select",
        )?.handler;
        assert.equal(typeof thinkingSelect, "function");
        await runtime.applySessionStart(context);
        assert.equal(pi.thinkingLevel, definition.thinking);

        // A native Shift+Tab/Ctrl+thinking cycle is session-only; the
        // event still records retained session intent without a default write.
        pi.thinkingLevel = "medium";
        await thinkingSelect(
          { type: "thinking_level_select", level: "medium", previousLevel: definition.thinking },
          context,
        );
        await beforeAgentStart({ systemPrompt: "base" }, context);
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} retains native thinking on the next turn`,
        );

        await runtime.applySessionStart(context);
        assert.equal(
          pi.thinkingLevel,
          definition.thinking,
          `${definition.name} restores the packaged thinking level after a new session`,
        );
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("TLH default thinking application is not mistaken for native user intent", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-thinking-guard-", {
    cwd: true,
    test: t,
  });
  const model = {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const primary = createPrimaryPrompt("product", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    applyModel: false,
    applyThinking: true,
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writePrimaryConfig(fixture.agent, { enabled: true, selected: "product" });
      const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents: new Map([["product", primary]]),
        subagentMetadata: [],
      });
      const context = {
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [model] },
        model,
      };
      const thinkingSelect = pi.events.find(
        (event) => event.name === "thinking_level_select",
      )?.handler;
      assert.equal(typeof thinkingSelect, "function");
      const manager = SettingsManager.create(fixture.cwd, fixture.agent);
      const pendingEvents = [];
      pi.setThinkingLevel = (level) => {
        const previousLevel = pi.thinkingLevel;
        pi.thinkingLevel = level;
        pendingEvents.push(
          thinkingSelect({ type: "thinking_level_select", level, previousLevel }, context),
        );
      };

      await runtime.applySessionStart(context);
      await Promise.all(pendingEvents);
      await manager.flush();
      assert.equal(
        JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8")).defaultThinkingLevel,
        undefined,
        "TLH's startup setter must not create a durable user thinking choice",
      );
      pi.thinkingLevel = "medium";
      await beforeAgentStart({ systemPrompt: "base" }, context);
      assert.equal(
        pi.thinkingLevel,
        "high",
        "a later turn reapplies the packaged default because TLH's own setter was guarded",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("retained thinking clamps across direct and OpenRouter model changes", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-thinking-clamp-", {
    cwd: true,
    test: t,
  });
  const definitions = ["rush", "product", "bug-hunter"];
  const scenarios = [
    {
      label: "direct provider",
      full: { provider: "anthropic", id: "claude-opus-5", reasoning: true },
      limited: {
        provider: "anthropic",
        id: "claude-haiku-4-5",
        reasoning: true,
        thinkingLevelMap: { high: null, xhigh: null, max: null },
      },
    },
    {
      label: "OpenRouter",
      full: { provider: "openrouter", id: "anthropic/claude-opus-5", reasoning: true },
      limited: {
        provider: "openrouter",
        id: "openai/gpt-5-mini",
        reasoning: true,
        thinkingLevelMap: { high: null, xhigh: null, max: null },
      },
    },
  ];

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      for (const scenario of scenarios) {
        for (const name of definitions) {
          writeFileSync(
            join(fixture.agent, "settings.json"),
            `${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: name } } }, null, 2)}\n`,
          );
          const primary = createPrimaryPrompt(name, {
            model: "anthropic/claude-opus-5",
            thinking: "high",
            tlhOpenrouterThinking: "high",
            applyModel: false,
            applyThinking: true,
          });
          const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
            primaryAgents: new Map([[name, primary]]),
            subagentMetadata: [],
          });
          const makeContext = (model) => ({
            cwd: fixture.cwd,
            sessionManager: { getBranch: () => [] },
            ui: { notify() {} },
            modelRegistry: { getAvailable: () => [scenario.full, scenario.limited] },
            model,
          });

          await runtime.applySessionStart(makeContext(scenario.full));
          runtime.recordUserThinkingLevel("high");
          await beforeAgentStart({ systemPrompt: "base" }, makeContext(scenario.limited));
          assert.equal(
            pi.thinkingLevel,
            "medium",
            `${scenario.label}/${name} clamps high to the nearest supported level`,
          );
          await beforeAgentStart({ systemPrompt: "base" }, makeContext(scenario.limited));
          assert.equal(
            pi.thinkingLevel,
            "medium",
            `${scenario.label}/${name} retains the clamped level on the next turn`,
          );

          const nonReasoning = {
            ...scenario.limited,
            id: `${scenario.limited.id}-plain`,
            reasoning: false,
          };
          await beforeAgentStart({ systemPrompt: "base" }, makeContext(nonReasoning));
          assert.equal(
            pi.thinkingLevel,
            "off",
            `${scenario.label}/${name} safely clamps retained thinking for a non-reasoning model`,
          );
          await beforeAgentStart({ systemPrompt: "base" }, makeContext(nonReasoning));
          assert.equal(pi.thinkingLevel, "off");
        }
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("architect applies a durable thinking choice", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-architect-durable-thinking-", {
    cwd: true,
    test: t,
  });
  const model = {
    provider: "anthropic",
    id: "claude-opus-5",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const architect = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    applyModel: false,
    applyThinking: true,
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ defaultThinkingLevel: "low" }, null, 2)}\n`,
      );
      const { pi, runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architect]]),
        subagentMetadata: [],
      });
      const context = {
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [model] },
        model,
      };
      await runtime.applySessionStart(context);
      assert.equal(pi.thinkingLevel, "low");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("primary runtime scopes tickets during session start before later session work", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const { runtime } = registerRuntimeHarness({ subagentMetadata: [] });
      assert.ok(runtime, "runtime should register outside child sessions");

      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      });

      assert.equal(process.env.TICKETS_DIR, join(fixture.cwd, ".tickets"));
    },
  );
});

test("primary runtime before_agent_start restores the revisited session's auto-scoped tickets dir", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { test: t });
  const repoA = join(fixture.dir, "repo-a");
  const repoB = join(fixture.dir, "repo-b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, TICKETS_DIR: undefined },
    async () => {
      const { runtime, beforeAgentStart } = registerRuntimeHarness({ subagentMetadata: [] });
      assert.ok(runtime, "runtime should register outside child sessions");

      const createCtx = (cwd) => ({
        cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.4" }] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      });

      await runtime.applySessionStart(createCtx(repoA));
      assert.equal(process.env.TICKETS_DIR, join(repoA, ".tickets"));

      await runtime.applySessionStart(createCtx(repoB));
      assert.equal(process.env.TICKETS_DIR, join(repoB, ".tickets"));

      await beforeAgentStart({ systemPrompt: "base prompt" }, createCtx(repoA));
      assert.equal(process.env.TICKETS_DIR, join(repoA, ".tickets"));
    },
  );
});

test("primary runtime falls back to Anthropic Rush-like metadata defaults when only Anthropic is available", async () => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      assert.ok(runtime, "runtime should register outside child sessions");

      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      });

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
      assert.equal(pi.thinkingLevel, "low");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("primary runtime respects explicit false settings over Rush-like metadata defaults", async () => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });
      const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
      assert.ok(runtime, "runtime should register outside child sessions");

      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-5.6-luna" }] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      });

      assert.equal(pi.model, undefined);
      assert.equal(pi.thinkingLevel, "normal");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("architect before_agent_start reapplies its default after Rush", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    applyModel: true,
    applyThinking: true,
  });
  const rushPrimary = createPrimaryPrompt("rush", {
    model: "anthropic/claude-opus-4-8",
    thinking: "low",
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([
    ["architect", architectPrimary],
    ["rush", rushPrimary],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
      primaryAgents,
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");

    const makeCtx = (branch) => ({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => branch },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-opus-5" },
          { provider: "anthropic", id: "claude-opus-4-8" },
        ],
      },
      model: { provider: "anthropic", id: "claude-opus-5" },
    });

    await runtime.applySessionStart(makeCtx([]));
    assert.equal(pi.thinkingLevel, "high", "architect starts at its declared default");

    pi.thinkingLevel = "medium";
    await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
    assert.equal(
      pi.thinkingLevel,
      "high",
      "before_agent_start reapplies the provider-aware primary default",
    );

    await beforeAgentStart(
      { systemPrompt: "base prompt" },
      makeCtx([
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "rush" },
        },
      ]),
    );
    assert.equal(pi.thinkingLevel, "low", "Rush applies its bundled default thinking");

    await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
    assert.equal(
      pi.thinkingLevel,
      "high",
      "architect restores its declared default after returning from rush",
    );
  });
});

test("primary runtime applies a max thinking default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "max",
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([["architect", architectPrimary]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
      primaryAgents,
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");

    const makeCtx = (branch) => ({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => branch },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-5" }] },
      model: { provider: "anthropic", id: "claude-opus-5" },
    });

    await runtime.applySessionStart(makeCtx([]));
    assert.equal(pi.thinkingLevel, "max");

    pi.thinkingLevel = "off";
    await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx([]));
    assert.equal(pi.thinkingLevel, "max");
  });
});

test("overrideable primary (rush) honors global applyThinking=false and applyModel=false", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const rushPrimary = createPrimaryPrompt("rush", {
    model: "anthropic/claude-opus-4-8",
    thinking: "low",
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([["rush", rushPrimary]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Global opt-outs remain respected by an overrideable primary.
    writePrimaryConfig(fixture.agent, { applyModel: false, applyThinking: false });

    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime, "runtime should register outside child sessions");

    // Use a different initial model so an enabled applyModel setting would be observable.
    await runtime.applySessionStart({
      cwd: fixture.cwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "rush" },
          },
        ],
      },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-4-8" }] },
      model: { provider: "anthropic", id: "claude-opus-4-6" },
    });

    assert.equal(pi.model, undefined, "applyModel=false leaves the active model untouched");
    assert.equal(pi.thinkingLevel, "normal", "applyThinking=false leaves thinking untouched");
  });
});

test("overrideable primary (architect) honors global applyThinking=false override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([["architect", architectPrimary]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // User opts out of thinking auto-apply for architect
    writePrimaryConfig(fixture.agent, { applyThinking: false });

    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime, "runtime should register outside child sessions");

    await runtime.applySessionStart({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-opus-5" }] },
      model: { provider: "anthropic", id: "claude-opus-5" },
    });

    // Global applyThinking: false is respected for an overrideable primary.
    assert.equal(pi.thinkingLevel, "normal");
  });
});

test("disabled primary mode applies architect tools without forcing model or thinking defaults", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    tools: ["read", "grep"],
    applyModel: true,
    applyThinking: true,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writePrimaryConfig(fixture.agent, {
      modelOverrides: { disabled: "anthropic/claude-opus-5" },
    });
    const { pi, runtime } = registerRuntimeHarness({
      primaryAgents: new Map([["architect", architectPrimary]]),
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");
    pi.allTools = ["read", "grep", "edit"].map((name) => ({ name }));
    pi.activeTools = ["edit"];

    await runtime.applySessionStart({
      cwd: fixture.cwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "disabled" },
          },
        ],
      },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [{ provider: "anthropic", id: "claude-opus-5" }],
      },
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    });

    assert.deepEqual(pi.activeTools, ["read", "grep"]);
    assert.equal(pi.model, undefined, "disabled mode must leave the session model untouched");
    assert.equal(pi.thinkingLevel, "normal", "disabled mode must leave thinking untouched");
    assert.equal(runtime.activePrimaryAgentPrompt(), undefined);
  });
});

test("disabled primary mode tolerates pre-bind lifecycle and reapplies architect tools after runtime binding", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    tools: ["read", "grep"],
    applyModel: false,
    applyThinking: false,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
      primaryAgents: new Map([["architect", architectPrimary]]),
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");
    pi.allTools = ["read", "grep", "edit"].map((name) => ({ name }));
    pi.activeTools = ["edit"];

    const getAllTools = pi.getAllTools.bind(pi);
    let runtimeBound = false;
    pi.getAllTools = () => {
      if (!runtimeBound) {
        throw new Error(
          "Extension runtime not initialized. Action methods cannot be called during extension loading.",
        );
      }
      return getAllTools();
    };
    const makeCtx = () => ({
      cwd: fixture.cwd,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
            data: { selected: "disabled" },
          },
        ],
      },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [] },
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });

    await runtime.applySessionStart(makeCtx());
    assert.deepEqual(
      pi.activeTools,
      ["edit"],
      "pre-bind session_start must leave tools untouched until action APIs are available",
    );

    runtimeBound = true;
    await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx());
    assert.deepEqual(pi.activeTools, ["read", "grep"]);

    runtimeBound = false;
    await runtime.applySessionStart(makeCtx());
    assert.deepEqual(
      pi.activeTools,
      ["read", "grep"],
      "pre-bind reload must not disturb the previously applied capability allowlist",
    );

    runtimeBound = true;
    await runtime.applySessionStart(makeCtx());
    assert.deepEqual(pi.activeTools, ["read", "grep"]);
  });
});

test("disabled primary mode propagates unrelated errors sharing the pre-bind prefix", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const unrelatedError = `${PRE_BIND_RUNTIME_ERROR} unrelated action failure`;
  const architectPrimary = createPrimaryPrompt("architect", {
    tools: ["read", "grep"],
    applyModel: false,
    applyThinking: false,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime } = registerRuntimeHarness({
      primaryAgents: new Map([["architect", architectPrimary]]),
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");
    pi.getAllTools = () => {
      throw new Error(unrelatedError);
    };

    await assert.rejects(
      runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: "disabled" },
            },
          ],
        },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      }),
      { message: unrelatedError },
    );
  });
});

test("enabled architect primary mode propagates the pre-bind action runtime error", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    tools: ["read", "grep"],
    applyModel: false,
    applyThinking: false,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime } = registerRuntimeHarness({
      primaryAgents: new Map([["architect", architectPrimary]]),
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");
    pi.getAllTools = () => {
      throw new Error(PRE_BIND_RUNTIME_ERROR);
    };

    await assert.rejects(
      runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: "architect" },
            },
          ],
        },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [] },
        model: { provider: "openai-codex", id: "gpt-5.4" },
      }),
      { message: PRE_BIND_RUNTIME_ERROR },
    );
  });
});

test("primary runtime defers missing-tool startup warnings and keeps the architect capability allowlist when disabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        tools: ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"],
        applyModel: false,
        applyThinking: false,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const notifications = [];
    const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
      primaryAgents,
      subagentMetadata: [],
    });
    assert.ok(runtime, "runtime should register outside child sessions");

    pi.allTools = ["read", "grep", "find", "ls", "bash", "subagent"].map((name) => ({ name }));
    pi.activeTools = ["read", "grep", "find", "ls", "bash", "subagent"];

    const makeCtx = (branch = []) => ({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => branch },
      ui: {
        notify(message, type = "info") {
          notifications.push({ message, type });
        },
      },
      modelRegistry: { getAvailable: () => [] },
      model: { provider: "openai-codex", id: "gpt-5.4" },
    });

    await runtime.applySessionStart(makeCtx());
    assert.equal(
      notifications.some(({ message }) => message.includes("subagent_supervisor")),
      false,
      "session_start should not warn about supervisor tools that register later in the lifecycle",
    );

    pi.allTools = [
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "subagent",
      "subagent_supervisor",
      "intercom",
    ].map((name) => ({
      name,
    }));
    pi.activeTools = [...pi.activeTools, "subagent_supervisor", "intercom"];

    await beforeAgentStart({ systemPrompt: "base prompt" }, makeCtx());
    assert.deepEqual(
      pi.activeTools,
      ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"],
      "enabled primary mode must keep subagent_supervisor while excluding the unrestricted intercom alias",
    );

    await beforeAgentStart(
      { systemPrompt: "base prompt" },
      makeCtx([
        {
          type: "custom",
          customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
          data: { selected: "disabled" },
        },
      ]),
    );
    assert.deepEqual(
      pi.activeTools,
      ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor"],
      "disabled primary mode must keep the architect capability allowlist and exclude unrestricted tools",
    );
  });
});
