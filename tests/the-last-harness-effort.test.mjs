import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ModelSelectorComponent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");
const {
  installTlhModelSelectionPersistenceOverride,
  persistTlhStandaloneThinkingDefaults,
  replayAllTlhUnclaimedModelSelectionDefaults,
  setTlhModelSelectionActiveModelResolver,
} = await jiti.import("../extensions/the-last-harness/model-selection-scope.ts");

// ---------------------------------------------------------------------------
// Minimal harness and helpers
// ---------------------------------------------------------------------------

function createPiHarness() {
  const commands = new Map();
  return {
    commands,
    thinkingLevel: "medium",
    registerCommand(name, options) {
      commands.set(name, options);
    },
    getThinkingLevel() {
      return this.thinkingLevel;
    },
    setThinkingLevel(level) {
      this.thinkingLevel = level;
    },
  };
}

function createFakeRuntime(agentPrompt) {
  return {
    activePrimaryAgentPrompt() {
      return agentPrompt;
    },
  };
}

/**
 * Creates a minimal ctx for the effort handler.
 * @param {object} opts
 * @param {string|undefined} opts.provider  model provider (e.g. "anthropic", "openai")
 * @param {object|undefined} opts.model     full model object — if given, overrides provider
 * @param {boolean}          opts.hasUI     whether the ctx has interactive UI (default: false)
 */
function createCtx({ provider, model, hasUI = false } = {}) {
  const notifications = [];
  const resolvedModel =
    model !== undefined ? model : provider ? { provider, id: "test-model" } : undefined;
  return {
    notifications,
    ctx: {
      model: resolvedModel,
      hasUI,
      ui: {
        notify(message, type = "info") {
          notifications.push({ message, type });
        },
        async select(_prompt, _options) {
          return null;
        },
      },
    },
  };
}

function readSettings(agent) {
  return JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
}

function createPersistedThinkingHarness(manager) {
  const pi = createPiHarness();
  pi.setThinkingLevel = (level) => {
    if (pi.thinkingLevel === level) {
      return;
    }
    pi.thinkingLevel = level;
    manager.setDefaultThinkingLevel(level);
  };
  return pi;
}

async function queueFailedNativeModelWrite(manager, model) {
  let callbackDone;
  const selector = Object.create(ModelSelectorComponent.prototype);
  selector.dispose = () => {};
  selector.settingsManager = manager;
  selector.onSelectCallback = () => {
    callbackDone = Promise.resolve();
  };
  selector.handleSelect(model);
  await callbackDone;
}

function createInteractiveThinkingContext(
  model,
  scopeSelection,
  pickerCalls,
  thinkingSelection = "high",
) {
  const { notifications, ctx } = createCtx({ model, hasUI: true });
  ctx.mode = "tui";
  ctx.ui.select = async (title, options) => {
    pickerCalls.push(title);
    if (title === "Pick thinking level") {
      return options.find((option) => option.includes(` ${thinkingSelection} —`));
    }
    return options[scopeSelection];
  };
  return { notifications, ctx };
}

// ---------------------------------------------------------------------------
// Agent-prompt factories matching actual frontmatter (T1)
// ---------------------------------------------------------------------------

function rushPrimary() {
  return {
    name: "rush",
    description: "Rush primary",
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
    tools: [],
    systemPrompt: "rush",
    filePath: "agents/primary/rush.md",
  };
}

function productPrimary() {
  return {
    name: "product",
    description: "Product primary",
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
    tools: [],
    systemPrompt: "product",
    filePath: "agents/primary/product.md",
  };
}

function bugHunterPrimary() {
  return {
    name: "bug-hunter",
    description: "Bug-hunter primary",
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
    tools: [],
    systemPrompt: "bug-hunter",
    filePath: "agents/primary/bug-hunter.md",
  };
}

function architectPrimary() {
  return {
    name: "architect",
    description: "Architect primary",
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
    minThinking: "medium",
    tools: [],
    systemPrompt: "architect",
    filePath: "agents/primary/architect.md",
  };
}

/** A reasoning model whose thinkingLevelMap supports xhigh and max. */
function reasoningModel(provider = "anthropic") {
  return {
    provider,
    id: "claude-opus-4-8",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
}

// ---------------------------------------------------------------------------
// 1. Overrideable primaries — rush, product, bug-hunter
// ---------------------------------------------------------------------------

for (const [name, createPrimary] of [
  ["rush", rushPrimary],
  ["product", productPrimary],
  ["bug-hunter", bugHunterPrimary],
]) {
  test(`${name} exposes every supported thinking level`, () => {
    const pi = createPiHarness();
    registerEffortCommand(pi, createFakeRuntime(createPrimary()));
    const completions = pi.commands.get("effort").getArgumentCompletions("");
    assert.deepEqual(
      completions.map((completion) => completion.value),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    );
  });

  test(`${name} accepts a supported thinking selection without a primary floor`, async () => {
    const pi = createPiHarness();
    registerEffortCommand(pi, createFakeRuntime(createPrimary()));
    const { notifications, ctx } = createCtx({ model: reasoningModel() });
    await pi.commands.get("effort").handler("off", ctx);
    assert.equal(pi.thinkingLevel, "off");
    assert.deepEqual(notifications.at(-1), {
      message: "Thinking level set to off.",
      type: "info",
    });
  });
}

// ---------------------------------------------------------------------------
// 2. minThinking floor — architect (minThinking: medium)
// ---------------------------------------------------------------------------

test("getArgumentCompletions for architect returns only medium/high/xhigh/max when no prefix", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.deepEqual(
    completions.map((c) => c.value),
    ["medium", "high", "xhigh", "max"],
  );
});

test("getArgumentCompletions for architect filters correctly with prefix 'h'", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const completions = pi.commands.get("effort").getArgumentCompletions("h");
  assert.deepEqual(
    completions.map((c) => c.value),
    ["high"],
  );
});

test("getArgumentCompletions for architect returns null for prefix below floor (not null vs empty)", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  // "l" matches "low" but low is below the floor — nothing matches
  const completions = pi.commands.get("effort").getArgumentCompletions("l");
  assert.equal(completions, null);
});

test("architect handler accepts medium", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("medium", ctx);
  assert.equal(pi.thinkingLevel, "medium");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts high", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("high", ctx);
  assert.equal(pi.thinkingLevel, "high");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts xhigh when model supports it", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("xhigh", ctx);
  assert.equal(pi.thinkingLevel, "xhigh");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler accepts max when model supports it", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("max", ctx);
  assert.equal(pi.thinkingLevel, "max");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("architect handler rejects off with exact error message", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("off", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "architect requires at least medium thinking.",
    type: "error",
  });
});

test("architect handler rejects minimal with exact error message", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("minimal", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "architect requires at least medium thinking.",
    type: "error",
  });
});

test("architect handler rejects low with exact error message", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("low", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "architect requires at least medium thinking.",
    type: "error",
  });
});

test("architect handler does not change thinking level when rejecting a below-floor selection", async () => {
  const pi = createPiHarness();
  pi.thinkingLevel = "high";
  registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
  const { ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("off", ctx);
  // Level must be unchanged
  assert.equal(pi.thinkingLevel, "high");
});

// ---------------------------------------------------------------------------
// 3. Disabled primary (no active primary) — passthrough regression guard
// ---------------------------------------------------------------------------

test("getArgumentCompletions with no primary returns all thinking levels", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(undefined));
  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.deepEqual(
    completions.map((c) => c.value),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("getArgumentCompletions with no primary filters by prefix normally", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(undefined));
  const completions = pi.commands.get("effort").getArgumentCompletions("m");
  // THINKING_LEVELS order: off, minimal, low, medium, high, xhigh, max — so minimal precedes medium and max.
  assert.deepEqual(
    completions.map((c) => c.value),
    ["minimal", "medium", "max"],
  );
});

test("disabled primary handler accepts off", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(undefined));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("off", ctx);
  assert.equal(pi.thinkingLevel, "off");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("disabled primary handler accepts medium", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(undefined));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("medium", ctx);
  assert.equal(pi.thinkingLevel, "medium");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("disabled primary handler accepts high", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi, createFakeRuntime(undefined));
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("high", ctx);
  assert.equal(pi.thinkingLevel, "high");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("no runtime passed behaves identically to disabled primary (full completions)", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi); // no runtime argument
  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.deepEqual(
    completions.map((c) => c.value),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("no runtime passed handler accepts any valid level", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi); // no runtime argument
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("low", ctx);
  assert.equal(pi.thinkingLevel, "low");
  assert.equal(notifications.at(-1)?.type, "info");
});

test("interactive thinking scope replays a pending failed model selector before capturing its write", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-failed-selector-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const failedModel = { provider: "openai-codex", id: "unavailable-model" };
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
      defaultThinkingLevel: "low",
    }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    setTlhModelSelectionActiveModelResolver(() => previousModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    await queueFailedNativeModelWrite(manager, failedModel);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);

    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const pickerCalls = [];
    const { ctx } = createInteractiveThinkingContext(reasoningModel(), 0, pickerCalls);

    await pi.commands.get("thinking").handler("", ctx);
    await manager.flush();

    assert.equal(readSettings(fixture.agent).defaultModel, failedModel.id);
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
    assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
  });
});

test("interactive thinking cancellation reports a failed restoration and resulting level", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-cancel-error-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    const upstreamSetThinkingLevel = pi.setThinkingLevel;
    pi.setThinkingLevel = (level) => {
      if (level === "low") {
        throw new Error("thinking restoration unavailable");
      }
      upstreamSetThinkingLevel(level);
    };
    registerEffortCommand(pi);
    const pickerCalls = [];
    const { notifications, ctx } = createInteractiveThinkingContext(
      reasoningModel(),
      undefined,
      pickerCalls,
    );

    await pi.commands.get("effort").handler("", ctx);
    await manager.flush();

    assert.equal(pi.thinkingLevel, "high");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
    assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
    assert.deepEqual(notifications, [
      {
        message:
          "TLH could not restore thinking level to low after cancelling thinking selection; active level remains high.",
        type: "warning",
      },
    ]);
  });
});

test("interactive thinking All sessions warns when Pi emits no default write", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-no-write-", { cwd: true, test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    pi.setThinkingLevel = (level) => {
      pi.thinkingLevel = level;
    };
    registerEffortCommand(pi);
    const pickerCalls = [];
    const { notifications, ctx } = createInteractiveThinkingContext(
      reasoningModel(),
      1,
      pickerCalls,
    );

    await pi.commands.get("thinking").handler("", ctx);
    await manager.flush();

    assert.equal(pi.thinkingLevel, "high");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
    assert.deepEqual(notifications, [
      {
        message:
          "Thinking level set to high for this session, but TLH could not update the persistent default.",
        type: "warning",
      },
    ]);
  });
});

for (const commandName of ["thinking", "effort"]) {
  test(`${commandName} interactive session-only scope leaves the profile default unchanged`, async (t) => {
    const fixture = createIsolatedProfileFixture(`tlh-${commandName}-session-only-`, {
      cwd: true,
      test: t,
    });
    writeFileSync(
      join(fixture.agent, "settings.json"),
      JSON.stringify({ defaultThinkingLevel: "low" }),
    );
    const model = reasoningModel();

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      assert.equal(installTlhModelSelectionPersistenceOverride(), true);
      replayAllTlhUnclaimedModelSelectionDefaults();
      const manager = SettingsManager.create(fixture.cwd, fixture.agent);
      const pi = createPersistedThinkingHarness(manager);
      pi.thinkingLevel = "low";
      registerEffortCommand(pi);
      const pickerCalls = [];
      const { notifications, ctx } = createInteractiveThinkingContext(model, 0, pickerCalls);

      await pi.commands.get(commandName).handler("", ctx);
      await manager.flush();

      assert.equal(pi.thinkingLevel, "high");
      assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
      assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
      assert.equal(notifications.at(-1)?.type, "info");
    });
  });
}

test("interactive thinking All sessions preserves the profile default write", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-all-sessions-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  const model = reasoningModel();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const pickerCalls = [];
    const { ctx } = createInteractiveThinkingContext(model, 1, pickerCalls);

    await pi.commands.get("thinking").handler("", ctx);
    await manager.flush();

    assert.equal(pi.thinkingLevel, "high");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "high");
    assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
  });
});

test("pending thinking scope does not capture unrelated defaults and survives lifecycle replay", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-pending-scope-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  const model = reasoningModel();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);

    let resolveScope;
    let scopeOptions;
    let markScopeOpen;
    const scopeOpen = new Promise((resolve) => {
      markScopeOpen = resolve;
    });
    const pickerCalls = [];
    const { ctx } = createCtx({ model, hasUI: true });
    ctx.mode = "tui";
    ctx.ui.select = async (title, options) => {
      pickerCalls.push(title);
      if (title === "Pick thinking level") {
        return options.find((option) => option.includes(" high —"));
      }
      scopeOptions = options;
      markScopeOpen();
      return new Promise((resolve) => {
        resolveScope = resolve;
      });
    };

    const commandPromise = pi.commands.get("thinking").handler("", ctx);
    await scopeOpen;
    assert.equal(pi.thinkingLevel, "high");

    // Simulate an unrelated thinking write and lifecycle boundary while the
    // scope picker is open. Only that unrelated write should replay here.
    manager.setDefaultThinkingLevel("medium");
    replayAllTlhUnclaimedModelSelectionDefaults();
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "medium");

    resolveScope(scopeOptions[1]);
    await commandPromise;
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "high");
    assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
  });
});

test("interactive thinking cancellation restores the active level without persistence", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-cancel-", { cwd: true, test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  const model = reasoningModel();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const pickerCalls = [];
    const { notifications, ctx } = createInteractiveThinkingContext(model, undefined, pickerCalls);

    await pi.commands.get("effort").handler("", ctx);
    await manager.flush();

    assert.equal(pi.thinkingLevel, "low");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
    assert.deepEqual(pickerCalls, ["Pick thinking level", "Thinking selection scope"]);
    assert.match(notifications.at(-1)?.message ?? "", /Kept thinking level at low/);
  });
});

test("unchanged interactive and typed thinking selections do not open the scope picker", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-thinking-no-scope-", { cwd: true, test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  const model = reasoningModel();

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    replayAllTlhUnclaimedModelSelectionDefaults();
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const pi = createPersistedThinkingHarness(manager);
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);

    const unchangedCalls = [];
    const unchanged = createInteractiveThinkingContext(model, 1, unchangedCalls, "low");
    await pi.commands.get("thinking").handler("", unchanged.ctx);
    assert.deepEqual(unchangedCalls, ["Pick thinking level"]);
    assert.equal(pi.thinkingLevel, "low");
    assert.deepEqual(unchanged.notifications, [
      { message: "Thinking level set to low.", type: "info" },
    ]);

    const typedCalls = [];
    const typed = createInteractiveThinkingContext(model, 1, typedCalls);
    await pi.commands.get("effort").handler("high", typed.ctx);
    await persistTlhStandaloneThinkingDefaults();
    await manager.flush();
    assert.deepEqual(typedCalls, []);
    assert.equal(pi.thinkingLevel, "high");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "high");
  });
});
