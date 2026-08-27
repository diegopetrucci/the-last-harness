import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { cleanupTempDir, createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerTlhPrimaryAgentRuntime,
  createPiHarness,
  registerRuntimeHarness,
  writePrimaryConfig,
  createPrimaryPrompt,
  createCommandContext,
  lockedRushPrimary,
  rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");
const { readReconcileState } = await jiti.import(
  "../extensions/the-last-harness/model-effort-reconcile.ts",
);
const {
  __resetModelEffortNoticeForTests,
  __setModelEffortNoticeTestHooks,
  maybeNotifyModelEffortDrift,
} = await jiti.import("../extensions/the-last-harness/model-effort-notice.ts");

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
      assert.equal(first.pi.model, undefined, "unlocked primary leaves session model untouched");
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

test("architect preserves and enforces its OpenRouter minThinking floor", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const sessionModel = { provider: "openrouter", id: "openai/gpt-5.4" };
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-sonnet-4-6",
    minThinking: "medium",
    tlhOpenrouterThinking: "high",
    applyModel: true,
    applyThinking: true,
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectPrimary]]),
        subagentMetadata: [],
      });
      const context = {
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: { getAvailable: () => [sessionModel] },
        model: sessionModel,
      };

      await runtime.applySessionStart(context);
      assert.equal(pi.thinkingLevel, "high");
      pi.thinkingLevel = "medium";
      await beforeAgentStart({ systemPrompt: "base" }, context);
      assert.equal(pi.thinkingLevel, "medium", "a level meeting the floor is preserved");
      pi.thinkingLevel = "low";
      await beforeAgentStart({ systemPrompt: "base" }, context);
      assert.equal(
        pi.thinkingLevel,
        "high",
        "a level below the floor is restored to OpenRouter target",
      );
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

test("custom locked primaries reject typed effort without recording session thinking intent", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-locked-thinking-", {
    cwd: true,
    test: t,
  });
  const { notifications, ctx } = createCommandContext([
    {
      type: "custom",
      customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
      data: { selected: "rush" },
    },
  ]);
  ctx.cwd = fixture.cwd;
  writePrimaryConfig(fixture.agent, { selected: "rush" });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi, runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["rush", lockedRushPrimary()]]),
        subagentMetadata: [],
      });
      assert.ok(runtime, "runtime should register outside child sessions");
      const recordedThinkingLevels = [];
      runtime.recordUserThinkingLevel = (level) => {
        recordedThinkingLevels.push(level);
      };
      registerEffortCommand(pi, runtime);

      await runtime.applySessionStart(ctx);
      assert.equal(pi.thinkingLevel, "medium", "the custom lock keeps its provider default active");

      await pi.commands.get("effort").handler("high", ctx);

      assert.deepEqual(notifications, [
        {
          message: 'Thinking is locked at "medium" for the rush primary agent.',
          type: "error",
        },
      ]);
      assert.deepEqual(
        recordedThinkingLevels,
        [],
        "a rejected effort must not create session intent",
      );
      assert.equal(
        pi.thinkingLevel,
        "medium",
        "a rejected effort must not change the active level",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("unlocked primaries retain explicit thinking through turns, model switches, and mode boundaries", async (t) => {
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

test("unlocked primaries honor an explicit durable thinking level across sessions and mode changes", async (t) => {
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
    minThinking: "medium",
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

test("native thinking cycle changes are retained for every unlocked primary and survive a new session", async (t) => {
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
        const manager = SettingsManager.create(fixture.cwd, fixture.agent);

        await runtime.applySessionStart(context);
        assert.equal(pi.thinkingLevel, definition.thinking);

        // A native Shift+Tab/Ctrl+thinking cycle writes the upstream durable
        // default before the extension event reaches TLH.
        pi.thinkingLevel = "medium";
        manager.setDefaultThinkingLevel("medium");
        await thinkingSelect(
          { type: "thinking_level_select", level: "medium", previousLevel: definition.thinking },
          context,
        );
        await manager.flush();

        await beforeAgentStart({ systemPrompt: "base" }, context);
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} retains native thinking on the next turn`,
        );

        await runtime.applySessionStart(context);
        assert.equal(
          pi.thinkingLevel,
          "medium",
          `${definition.name} restores native thinking from defaultThinkingLevel in a new session`,
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
        manager.setDefaultThinkingLevel(level);
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

test("unlocked retained thinking clamps across direct and OpenRouter model changes", async (t) => {
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

test("architect applies a durable thinking choice without violating its medium floor", async (t) => {
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
    minThinking: "medium",
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
      assert.equal(pi.thinkingLevel, "medium");
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

test("architect before_agent_start preserves its floor and restores its default after Rush", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const architectPrimary = createPrimaryPrompt("architect", {
    model: "anthropic/claude-opus-5",
    thinking: "high",
    minThinking: "medium",
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
      "medium",
      "before_agent_start preserves a current level that satisfies architect's floor",
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

test("primary runtime defers missing-tool startup warnings and restores late supervisor tools when primary mode is disabled", async (t) => {
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
      ["read", "grep", "find", "ls", "bash", "subagent", "subagent_supervisor", "intercom"],
      "disabled primary mode must restore late-registered supervisor tools alongside the unrestricted tool set",
    );
  });
});

// --- tlh-3mb3: per-primary model override tests ---

function createPiHarnessWithFiringModelSelect(getCtx) {
  const pi = createPiHarness();
  const modelSelectHandlers = [];
  const origOn = pi.on.bind(pi);
  pi.on = function (name, handler) {
    origOn(name, handler);
    if (name === "model_select") {
      modelSelectHandlers.push(handler);
    }
  };
  pi.setModel = async function (model) {
    const previousModel = this.model;
    this.model = model;
    const ctx = getCtx();
    if (ctx) {
      for (const h of modelSelectHandlers) {
        await h({ type: "model_select", model, previousModel, source: "set" }, ctx);
      }
    }
    return true;
  };
  return pi;
}

test("model override resolution: stored override is applied when the model is in the registry", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  // Bundled default for rushLikePrimary on Anthropic is anthropic/claude-sonnet-4-6.
  // Store a different available Anthropic model so override precedence is observable.
  const initialSettings =
    JSON.stringify(
      {
        tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-opus-5" } } },
      },
      null,
      2,
    ) + "\n";

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime);

    await runtime.applySessionStart({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
      },
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
    });

    // Override should win over the bundled anthropic/claude-sonnet-4-6 default.
    assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-5" });
  });
});

test("model override resolution: falls back to bundled default when override model is unavailable", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  const initialSettings =
    JSON.stringify(
      {
        tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.6-luna" } } },
      },
      null,
      2,
    ) + "\n";

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime);

    await runtime.applySessionStart({
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      // Override model (openai-codex/gpt-5.6-luna) is NOT in the registry
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
      model: { provider: "anthropic", id: "claude-opus-5" },
    });

    // Falls back to bundled Anthropic default
    assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
  });
});

for (const [selection, defaultModel] of [
  ["product", "anthropic/claude-opus-5"],
  ["bug-hunter", "anthropic/claude-opus-5"],
]) {
  test(`${selection} applies its stored model override before the packaged default`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", {
      cwd: true,
      test: t,
    });
    const overrideModel = { provider: "anthropic", id: "anthropic-custom" };
    const primary = createPrimaryPrompt(selection, {
      model: defaultModel,
      tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
      tlhAnthropicThinking: "high",
      tlhOpenaiThinking: "high",
      applyModel: true,
      applyThinking: true,
    });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writeFileSync(
        join(fixture.agent, "settings.json"),
        `${JSON.stringify({ tlh: { primaryAgent: { enabled: true, selected: selection, modelOverrides: { [selection]: `${overrideModel.provider}/${overrideModel.id}` } } } }, null, 2)}\n`,
      );
      const { pi, runtime } = registerRuntimeHarness({
        primaryAgents: new Map([[selection, primary]]),
        subagentMetadata: [],
      });
      await runtime.applySessionStart({
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: defaultModel.replace("anthropic/", "") },
            overrideModel,
          ],
        },
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
      });
      assert.deepEqual(pi.model, overrideModel);
    });
  });
}

test("model_select listener writes override to settings when user picks a non-default model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  // rushLikePrimary has model: "anthropic/claude-sonnet-4-6".
  // The user picks a different Anthropic model that is NOT the bundled default for the architect primary.
  // Available: both claude-sonnet-4-6 (bundled default) and claude-opus-5 (non-default).

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    // User picks a non-default model: anthropic/claude-opus-5
    const overrideModel = { provider: "anthropic", id: "claude-opus-5" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      // Registry includes the bundled default (claude-sonnet-4-6) and the override target (claude-opus-5)
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
      },
      model: overrideModel,
    };
    // bundledKey for provider "anthropic" with rushLikePrimary: "anthropic/claude-sonnet-4-6" (the primary's .model field)
    // chosenKey: "anthropic/claude-opus-5" → different → should write override
    await modelSelectHandler(
      { type: "model_select", model: overrideModel, previousModel: undefined, source: "set" },
      ctx,
    );

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(written.tlh.primaryAgent.modelOverrides.architect, "anthropic/claude-opus-5");
  });
});

test("model_select listener clears override when user reselects the primary's bundled default model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  const initialSettings =
    JSON.stringify(
      {
        tlh: { primaryAgent: { modelOverrides: { architect: "openai-codex/gpt-5.6-luna" } } },
      },
      null,
      2,
    ) + "\n";

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    // rushLikePrimary with only anthropic available: bundled default is anthropic/claude-sonnet-4-6
    const bundledDefaultModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
      model: bundledDefaultModel,
    };
    await modelSelectHandler(
      { type: "model_select", model: bundledDefaultModel, previousModel: undefined, source: "set" },
      ctx,
    );

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    // Override for architect should be cleared
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
  });
});

test("Rush persists a model override when model_select fires for a non-default user model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const rushPrimary = createPrimaryPrompt("rush", {
    model: "anthropic/claude-sonnet-4-6",
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    tlhAnthropicThinking: "low",
    tlhOpenrouterThinking: "low",
    tlhOpenaiThinking: "medium",
    preferCurrentOpenaiModel: true,
    applyModel: true,
    applyThinking: true,
  });
  const primaryAgents = new Map([["rush", rushPrimary]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    const nonDefaultModel = { provider: "anthropic", id: "claude-opus-5" };
    const ctx = {
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
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
      },
      model: nonDefaultModel,
    };
    await modelSelectHandler(
      { type: "model_select", model: nonDefaultModel, previousModel: undefined, source: "set" },
      ctx,
    );

    const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(
      settings.tlh.primaryAgent.modelOverrides.rush,
      "anthropic/claude-opus-5",
      "Rush must record a per-primary model override",
    );
    assert.equal(
      readReconcileState().acknowledgedSnapshot?.rush?.byProvider?.anthropic?.model,
      "anthropic/claude-sonnet-4-6",
      "Rush override creation must record its packaged baseline",
    );
  });
});

for (const selection of ["product", "bug-hunter"]) {
  test(`${selection} persists a model override when model_select fires for a non-default user model`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", {
      cwd: true,
      test: t,
    });
    const primary = createPrimaryPrompt(selection, {
      model: "anthropic/claude-opus-5",
      tlhOpenaiModels: ["openai-codex/gpt-5.6-sol"],
      tlhAnthropicThinking: "high",
      tlhOpenaiThinking: "high",
      applyModel: true,
      applyThinking: true,
    });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { pi } = registerRuntimeHarness({
        primaryAgents: new Map([[selection, primary]]),
        subagentMetadata: [],
      });
      const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
      assert.ok(modelSelectHandler, "model_select handler must be registered");

      const nonDefaultModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
      const ctx = {
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
        modelRegistry: {
          getAvailable: () => [{ provider: "anthropic", id: "claude-opus-5" }, nonDefaultModel],
        },
        model: nonDefaultModel,
      };
      await modelSelectHandler(
        { type: "model_select", model: nonDefaultModel, previousModel: undefined, source: "set" },
        ctx,
      );

      const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
      assert.equal(
        settings.tlh.primaryAgent.modelOverrides[selection],
        "anthropic/claude-sonnet-4-6",
        `${selection} must record its own per-primary model override`,
      );
      assert.equal(
        readReconcileState().acknowledgedSnapshot?.[selection]?.byProvider?.anthropic?.model,
        "anthropic/claude-opus-5",
        `${selection} override creation must record its packaged baseline`,
      );
    });
  });
}

test("echo guard: TLH's own applyPrimaryModel does not record a model override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  let capturedCtx = null;

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarnessWithFiringModelSelect(() => capturedCtx);
    const runtime = registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      primaryAgents,
      subagentMetadata: [],
    });
    assert.ok(runtime);

    const applyCtx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
      model: { provider: "anthropic", id: "claude-opus-5" }, // different from bundled default
    };
    capturedCtx = applyCtx;

    // This will call pi.setModel which fires model_select with source="set".
    // The echo guard (tlhApplyingModel=true) must suppress writing the override.
    await runtime.applySessionStart(applyCtx);

    // settings.json should NOT have been written (no override)
    let settings;
    try {
      settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    } catch {
      settings = null;
    }
    const overrides = settings?.tlh?.primaryAgent?.modelOverrides;
    assert.equal(
      overrides?.architect,
      undefined,
      "TLH's own setModel must not record a model override",
    );
  });
});

// --- ts-nm9m: /reconcile Reset must reapply the packaged default to the ACTIVE session ---

/**
 * Build a ctx whose `model` tracks what the host most recently applied.
 *
 * `applyPrimaryModel` compares its target against `ctx.model` to decide whether a
 * switch is needed, so a static `model` would make the apply path a no-op after the
 * first switch and mask the very bug these tests guard.
 */
function createModelTrackingCtx(fixture, pi, availableModels, initialModel) {
  return {
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => [] },
    ui: { notify() {} },
    modelRegistry: { getAvailable: () => availableModels },
    get model() {
      return pi.model ?? initialModel;
    },
  };
}

function spyOnSetModel(pi) {
  const calls = [];
  const original = pi.setModel.bind(pi);
  pi.setModel = async (model) => {
    calls.push(model);
    return original(model);
  };
  return calls;
}

test("resetPrimaryAgentModelOverride clears the stored override AND applies the packaged default to the active session", async (t) => {
  // Regression guard for the /reconcile Reset blocker: clearing the persisted JSON is
  // not enough. Without `await applyPrimaryModeChange(ctx)` inside the runtime method,
  // the live session keeps running the overridden model until relaunch, contradicting
  // docs/commands.md. This asserts the APPLIED model changes, not just settings.json.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  // rushLikePrimary's packaged Anthropic default is anthropic/claude-sonnet-4-6.
  // Store a different, available Anthropic model so the reset is observable.
  const initialSettings = `${JSON.stringify(
    { tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-opus-5" } } } },
    null,
    2,
  )}\n`;
  const availableModels = [
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-opus-5" },
  ];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime, "runtime should register outside child sessions");

    const setModelCalls = spyOnSetModel(pi);
    const ctx = createModelTrackingCtx(fixture, pi, availableModels, {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });

    await runtime.applySessionStart(ctx);

    // Precondition: the stored override is what the session is actually running.
    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-opus-5" },
      "session should start on the stored override",
    );

    setModelCalls.length = 0;

    const result = await runtime.resetPrimaryAgentModelOverride(ctx, "architect");

    assert.ok(result, "reset should report a write result for a recognised primary agent");

    // The persisted override is gone...
    const settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(
      settings.tlh?.primaryAgent?.modelOverrides?.architect,
      undefined,
      "reset should clear the persisted architect model override",
    );

    // ...AND the active session was switched to the packaged default. This is the
    // assertion a settings-only reset would fail.
    assert.deepEqual(
      setModelCalls,
      [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
      "reset must apply the packaged default to the active session",
    );
    assert.deepEqual(
      pi.model,
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      "active model must resolve to the TLH packaged default after reset",
    );
  });
});

test("resetPrimaryAgentModelOverride refuses an unrecognised name: no write, no model change", async (t) => {
  // The refusal semantics are deliberate: an unknown key has no packaged default to
  // reconcile against, so TLH must not rewrite settings it does not understand and
  // must not touch the active session either.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  // A typo'd / stale primary-agent key straight out of user-editable JSON.
  const initialSettings = `${JSON.stringify(
    { tlh: { primaryAgent: { modelOverrides: { architekt: "anthropic/claude-opus-5" } } } },
    null,
    2,
  )}\n`;
  const availableModels = [
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "anthropic", id: "claude-opus-5" },
  ];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(join(fixture.agent, "settings.json"), initialSettings);
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    assert.ok(runtime, "runtime should register outside child sessions");

    const setModelCalls = spyOnSetModel(pi);
    const ctx = createModelTrackingCtx(fixture, pi, availableModels, {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });

    await runtime.applySessionStart(ctx);

    // The unrecognised key is ignored during resolution, so the session runs the default.
    assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });

    const settingsBefore = readFileSync(join(fixture.agent, "settings.json"), "utf8");
    setModelCalls.length = 0;

    const result = await runtime.resetPrimaryAgentModelOverride(ctx, "architekt");

    assert.equal(result, undefined, "unrecognised names must be refused with undefined");
    assert.equal(
      readFileSync(join(fixture.agent, "settings.json"), "utf8"),
      settingsBefore,
      "refusal must not rewrite settings",
    );
    assert.deepEqual(setModelCalls, [], "refusal must not apply a model change");
  });
});

// ---------------------------------------------------------------------------
// Override baseline recording (ts-sjlt)
// ---------------------------------------------------------------------------

test("model_select records override baseline on first creation", async (t) => {
  // Verifies that firing model_select for a first-time override writes the packaged
  // default of that moment as the baseline in reconcile-state.json.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  // Agent with Anthropic packaged default claude-sonnet-4-6.
  const agentWithModelX = createPrimaryPrompt("architect", {
    model: "anthropic/claude-sonnet-4-6",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    applyModel: true,
  });
  const primaryAgents = new Map([["architect", agentWithModelX]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    // User picks a non-default model for the first time (no prior override in settings).
    const nonDefaultModel = { provider: "anthropic", id: "claude-opus-5" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
      },
      model: nonDefaultModel,
    };
    await modelSelectHandler(
      { type: "model_select", model: nonDefaultModel, previousModel: undefined, source: "set" },
      ctx,
    );

    // Baseline must record the packaged default for anthropic at override-creation time.
    const reconcileState = readReconcileState();
    const baseline = reconcileState.acknowledgedSnapshot?.architect?.byProvider?.anthropic;
    assert.ok(
      baseline,
      "baseline must be recorded in reconcile state after first override creation",
    );
    assert.equal(
      baseline.model,
      "anthropic/claude-sonnet-4-6",
      "baseline model must be the packaged default at override-creation time",
    );
  });
});

test("model_select does not rebaseline when editing an existing override", async (t) => {
  // Regression guard: rebaselining on every edit would silently erase pending drift
  // the user has not yet been notified about. Only a first-creation (no prior override)
  // should record a baseline.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const agentWithModelX = createPrimaryPrompt("architect", {
    model: "anthropic/claude-sonnet-4-6",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    applyModel: true,
  });
  const primaryAgents = new Map([["architect", agentWithModelX]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Pre-seed settings with an existing override — simulates a second edit session.
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { modelOverrides: { architect: "anthropic/claude-opus-4-8" } } } }, null, 2)}\n`,
    );
    // Pre-seed reconcile state that already has a baseline with an OLD packaged default.
    // If baseline recording were mistakenly applied on edit, it would overwrite this.
    const staleBaseline = {
      acknowledgedSnapshot: {
        architect: { byProvider: { anthropic: { model: "anthropic/OLD-packaged-default" } } },
      },
    };
    const statePath = join(fixture.agent, "tlh", "reconcile-state.json");
    mkdirSync(join(fixture.agent, "tlh"), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(staleBaseline, null, 2)}\n`);

    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    // User picks a different non-default model (this is an edit, not a first creation).
    const newOverrideModel = { provider: "anthropic", id: "claude-opus-5" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
          { provider: "anthropic", id: "claude-opus-4-8" },
        ],
      },
      model: newOverrideModel,
    };
    await modelSelectHandler(
      { type: "model_select", model: newOverrideModel, previousModel: undefined, source: "set" },
      ctx,
    );

    // Stale baseline must NOT have been overwritten — the edit must not rebaseline.
    const reconcileState = readReconcileState();
    const baseline = reconcileState.acknowledgedSnapshot?.architect?.byProvider?.anthropic;
    assert.equal(
      baseline?.model,
      "anthropic/OLD-packaged-default",
      "editing an existing override must not overwrite the existing baseline",
    );
  });
});

test("end-to-end: override created under packaged default X triggers notice after packaged default changes to Y", async (t) => {
  // This is the primary regression test for ts-sjlt.
  //
  // Journey:
  // 1. Packaged default is X. User creates override via model_select → baseline X is recorded.
  // 2. TLH is updated: packaged default changes to Y.
  // 3. On next startup, maybeNotifyModelEffortDrift must fire because baseline X ≠ current Y.
  //
  // Before the fix, step 1 never recorded a baseline, so step 3 always saw no prior
  // acknowledgment and returned packagedDefaultsChanged=false, and no notice ever fired.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  // Step 1: packaged default is claude-sonnet-4-6 (model X).
  const agentWithModelX = createPrimaryPrompt("architect", {
    model: "anthropic/claude-sonnet-4-6",
    tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
    tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
    applyModel: true,
  });
  const primaryAgentsWithX = new Map([["architect", agentWithModelX]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // User creates override by picking a non-default model via model_select.
    // This should record baseline {model: "anthropic/claude-sonnet-4-6"} for architect@anthropic.
    const { pi } = registerRuntimeHarness({
      primaryAgents: primaryAgentsWithX,
      subagentMetadata: [],
    });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    const overrideModel = { provider: "anthropic", id: "claude-opus-5" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: {
        getAvailable: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6" },
          { provider: "anthropic", id: "claude-opus-5" },
        ],
      },
      model: overrideModel,
    };
    await modelSelectHandler(
      { type: "model_select", model: overrideModel, previousModel: undefined, source: "set" },
      ctx,
    );

    // Confirm override and baseline were recorded.
    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(
      written.tlh.primaryAgent.modelOverrides.architect,
      "anthropic/claude-opus-5",
      "override must be written",
    );
    const baseline = readReconcileState().acknowledgedSnapshot?.architect?.byProvider?.anthropic;
    assert.equal(
      baseline?.model,
      "anthropic/claude-sonnet-4-6",
      "baseline must record the packaged default at override-creation time",
    );

    // Step 2: TLH update — packaged default changes to claude-opus-5 (model Y).
    const agentWithModelY = createPrimaryPrompt("architect", {
      model: "anthropic/claude-opus-5",
      tlhAnthropicModels: ["anthropic/claude-opus-5"],
      tlhOpenaiModels: ["openai-codex/gpt-5.6-luna"],
      applyModel: true,
    });
    const primaryAgentsWithY = new Map([["architect", agentWithModelY]]);

    // Step 3: next startup — notice must fire because baseline X ≠ current packaged Y.
    __resetModelEffortNoticeForTests();
    __setModelEffortNoticeTestHooks({
      loadPrimaryAgents() {
        return primaryAgentsWithY;
      },
      loadSubagentMetadata() {
        return [];
      },
    });
    t.after(() => __resetModelEffortNoticeForTests());

    const notifications = [];
    const startupCtx = {
      cwd: fixture.cwd,
      hasUI: true,
      model: { provider: "anthropic", id: "claude-opus-5" },
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    };
    maybeNotifyModelEffortDrift(startupCtx);

    assert.equal(
      notifications.length,
      1,
      "notice must fire because packaged default changed since override was created (baseline X ≠ current Y)",
    );
    assert.ok(
      notifications[0].message.includes("architect"),
      `notice message must mention the role, got: ${notifications[0].message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure end-to-end journey (ts-sjlt acceptance criterion)
//
// These tests deliberately contain NO hand-written reconcile state and NO
// intermediate assertions on the stored baseline.  The only thing asserted is
// the user-visible outcome: does the startup notice fire?
//
// That matters for mutation-resistance.  A test that asserts the baseline was
// written and then asserts the notice fired will fail at the *baseline* assert
// when baseline recording is broken, which proves only that the write happened —
// not that the write is what makes the notice fire.  Asserting solely on the
// notice forces the failure to land on the connection between the two halves.
// ---------------------------------------------------------------------------

/**
 * Drives the real user-facing override-creation path: fires model_select exactly
 * as the pi runtime does when a user picks a model. Everything downstream
 * (settings write + baseline recording) is production code.
 */
async function createPrimaryOverrideViaRealPath(
  fixture,
  primaryAgents,
  chosenModel,
  availableModels,
) {
  const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
  const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
  assert.ok(modelSelectHandler, "model_select handler must be registered");
  await modelSelectHandler(
    { type: "model_select", model: chosenModel, previousModel: undefined, source: "set" },
    {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => availableModels },
      model: chosenModel,
    },
  );
}

/** Runs the startup notice against a supplied packaged catalog, returning notifications. */
function runStartupNotice(fixture, primaryAgents, t, provider = "anthropic") {
  __resetModelEffortNoticeForTests();
  __setModelEffortNoticeTestHooks({
    loadPrimaryAgents: () => primaryAgents,
    loadSubagentMetadata: () => [],
  });
  t.after(() => __resetModelEffortNoticeForTests());
  const notifications = [];
  maybeNotifyModelEffortDrift({
    cwd: fixture.cwd,
    hasUI: true,
    model: { provider, id: "some-model" },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });
  return notifications;
}

const ANTHROPIC_TWO_MODELS = [
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  { provider: "anthropic", id: "claude-opus-5" },
];

test("journey: primary override created under packaged X fires the startup notice once packaged default is Y", async (t) => {
  // The exact journey ts-sjlt exists to restore, with /reconcile never run.
  //
  // 1. Packaged default is X. User overrides to a different model  -> production
  //    code records baseline X.
  // 2. TLH ships an update: packaged default for that role becomes Y.
  // 3. Next launch must warn that the role's packaged default changed.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  const packagedX = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-sonnet-4-6",
        tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
        applyModel: true,
      }),
    ],
  ]);
  const packagedY = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-opus-5",
        tlhAnthropicModels: ["anthropic/claude-opus-5"],
        applyModel: true,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    await createPrimaryOverrideViaRealPath(
      fixture,
      packagedX,
      { provider: "anthropic", id: "claude-opus-5" },
      ANTHROPIC_TWO_MODELS,
    );

    const notifications = runStartupNotice(fixture, packagedY, t);

    assert.equal(
      notifications.length,
      1,
      "startup must warn that the packaged default changed for an overridden role whose baseline was recorded at override-creation time",
    );
    assert.match(
      notifications[0].message,
      /architect/,
      `notice must name the drifted role, got: ${notifications[0].message}`,
    );
  });
});

test("journey control: primary override with unchanged packaged default fires no startup notice", async (t) => {
  // Negative control for the test above. Without this, a notice that fired for any
  // reason at all (e.g. a bug making every overridden role report drift) would still
  // make the journey test pass.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  const packagedX = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-sonnet-4-6",
        tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
        applyModel: true,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    await createPrimaryOverrideViaRealPath(
      fixture,
      packagedX,
      { provider: "anthropic", id: "claude-opus-5" },
      ANTHROPIC_TWO_MODELS,
    );

    // Same packaged catalog as at override-creation time: nothing drifted.
    const notifications = runStartupNotice(fixture, packagedX, t);

    assert.deepEqual(
      notifications,
      [],
      "unchanged packaged defaults must not produce a startup notice",
    );
  });
});

test("primary baseline is not recorded when the settings write is refused", async (t) => {
  // The ticket requires the baseline to be written only after a *successful*
  // settings write. Otherwise a refused write leaves a baseline describing an
  // override that was never persisted, which would later suppress or misreport
  // drift for a role the user never actually overrode.
  //
  // The refusal is induced the way the guard really triggers: settings.json is a
  // directory, so assertSafeTlhSettingsPath throws. The profile itself stays valid,
  // so reconcile-state.json remains writable — meaning a baseline appearing here
  // would be a genuine bug, not merely an unwritable state file.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-sonnet-4-6",
        tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
        applyModel: true,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Make the settings path unwritable-by-guard.
    mkdirSync(join(fixture.agent, "settings.json"), { recursive: true });

    const { pi } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
    const modelSelectHandler = pi.events.find((e) => e.name === "model_select")?.handler;
    assert.ok(modelSelectHandler, "model_select handler must be registered");

    const chosen = { provider: "anthropic", id: "claude-opus-5" };
    // Must not throw into the command path even though the write is refused.
    await modelSelectHandler(
      { type: "model_select", model: chosen, previousModel: undefined, source: "set" },
      {
        cwd: fixture.cwd,
        sessionManager: { getBranch: () => [] },
        ui: { notify() {} },
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-6" },
            { provider: "anthropic", id: "claude-opus-5" },
          ],
        },
        model: chosen,
      },
    );

    const baseline = readReconcileState().acknowledgedSnapshot?.architect;
    assert.equal(
      baseline,
      undefined,
      "a refused settings write must not record an override baseline",
    );
  });
});

// ---------------------------------------------------------------------------
// Gap 2: Override-creation detection with invalid stored values (ts-8k8z)
// ---------------------------------------------------------------------------

test("journey: null stored primary override is treated as absent, baseline created, notice fires on packaged change", async (t) => {
  // Regression guard: a null value in settings.json modelOverrides (user-editable)
  // must be treated as "no meaningful override" so baseline recording fires when a
  // real override is created. Before the fix, existingOverride === undefined would
  // fail for null, silently skipping baseline creation and breaking the notice journey.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  const packagedX = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-sonnet-4-6",
        tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
        applyModel: true,
      }),
    ],
  ]);
  const packagedY = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-opus-5",
        tlhAnthropicModels: ["anthropic/claude-opus-5"],
        applyModel: true,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Pre-seed settings with a null override (user-edited, invalid value).
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { modelOverrides: { architect: null } } } }, null, 2)}\n`,
    );

    // User picks a real model — this transitions from invalid (null) to a meaningful override.
    await createPrimaryOverrideViaRealPath(
      fixture,
      packagedX,
      { provider: "anthropic", id: "claude-opus-5" },
      ANTHROPIC_TWO_MODELS,
    );

    // Baseline must have been recorded because null is not a meaningful override.
    const baseline = readReconcileState().acknowledgedSnapshot?.architect?.byProvider?.anthropic;
    assert.ok(baseline, "baseline must be recorded when replacing a null stored override");

    // User-visible outcome: notice fires after packaged default changes to Y.
    const notifications = runStartupNotice(fixture, packagedY, t);
    assert.equal(
      notifications.length,
      1,
      "notice must fire because packaged default changed (null was not treated as an existing override)",
    );
    assert.match(notifications[0].message, /architect/, "notice must name the drifted role");
  });
});

test("journey: empty-string stored primary override is treated as absent, baseline created, notice fires on packaged change", async (t) => {
  // Regression guard: an empty-string value in modelOverrides (user-editable) must
  // be treated as absent so baseline recording fires when a real override is created.
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });

  const packagedX = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-sonnet-4-6",
        tlhAnthropicModels: ["anthropic/claude-sonnet-4-6"],
        applyModel: true,
      }),
    ],
  ]);
  const packagedY = new Map([
    [
      "architect",
      createPrimaryPrompt("architect", {
        model: "anthropic/claude-opus-5",
        tlhAnthropicModels: ["anthropic/claude-opus-5"],
        applyModel: true,
      }),
    ],
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    // Pre-seed settings with an empty-string override (user-edited, invalid value).
    writeFileSync(
      join(fixture.agent, "settings.json"),
      `${JSON.stringify({ tlh: { primaryAgent: { modelOverrides: { architect: "" } } } }, null, 2)}\n`,
    );

    await createPrimaryOverrideViaRealPath(
      fixture,
      packagedX,
      { provider: "anthropic", id: "claude-opus-5" },
      ANTHROPIC_TWO_MODELS,
    );

    const baseline = readReconcileState().acknowledgedSnapshot?.architect?.byProvider?.anthropic;
    assert.ok(baseline, "baseline must be recorded when replacing an empty-string stored override");

    const notifications = runStartupNotice(fixture, packagedY, t);
    assert.equal(
      notifications.length,
      1,
      "notice must fire because packaged default changed (empty string was not treated as an existing override)",
    );
    assert.match(notifications[0].message, /architect/, "notice must name the drifted role");
  });
});
