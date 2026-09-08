import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  registerTlhPrimaryAgentRuntime,
  createPiHarness,
  registerRuntimeHarness,
  createPrimaryPrompt,
  rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { readReconcileState } = await jiti.import(
  "../extensions/the-last-harness/model-effort-reconcile.ts",
);
const {
  __resetModelEffortNoticeForTests,
  __setModelEffortNoticeTestHooks,
  maybeNotifyModelEffortDrift,
} = await jiti.import("../extensions/the-last-harness/model-effort-notice.ts");

// --- tlh-3mb3: per-primary model override tests ---

/**
 * Exercise Pi's public AgentSession.setModel boundary for model persistence
 * tests. The small object uses AgentSession.prototype.setModel itself, while
 * supplying only the runtime internals that the published method needs.
 */
function createPublicModelSession(pi, ctx, initialModel) {
  const manager = SettingsManager.create(ctx.cwd);
  const state = { model: initialModel, thinkingLevel: "low" };
  const session = Object.create(AgentSession.prototype);
  session.agent = { state };
  session.sessionManager = { appendModelChange() {} };
  session.settingsManager = manager;
  session._modelRuntime = { checkAuth: async () => true };
  session._scopedModels = [];
  session._getThinkingLevelForModelSwitch = () => state.thinkingLevel;
  session._addPersistedDefaultToNonEmptyScope = () => {};
  session.setThinkingLevel = (level) => {
    state.thinkingLevel = level;
  };
  session._emitModelSelect = async (model, previousModel, source) => {
    if (model?.provider === previousModel?.provider && model?.id === previousModel?.id) {
      return;
    }
    pi.model = model;
    for (const registered of pi.events) {
      if (registered.name === "model_select") {
        await registered.handler({ type: "model_select", model, previousModel, source }, ctx);
      }
    }
  };
  return { manager, session, state };
}

async function persistModelThroughPublicApi(pi, ctx, selected) {
  const { manager, session } = createPublicModelSession(pi, ctx, ctx.model);
  await session.setModel(selected, { persist: true });
  await manager.flush();
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

test("persisted model_select writes an override when Ctrl+S saves a non-default model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);
  // rushLikePrimary has model: "anthropic/claude-sonnet-4-6".
  // The user picks a different Anthropic model that is NOT the bundled default for the architect primary.
  // Available: both claude-sonnet-4-6 (bundled default) and claude-opus-5 (non-default).

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });

    // User explicitly saves a non-default model with native Ctrl+S.
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
    await runtime.applySessionStart(ctx);
    // bundledKey for provider "anthropic" with rushLikePrimary: "anthropic/claude-sonnet-4-6" (the primary's .model field)
    // chosenKey: "anthropic/claude-opus-5" → different → should write override
    await persistModelThroughPublicApi(pi, ctx, overrideModel);

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    assert.equal(written.tlh.primaryAgent.modelOverrides.architect, "anthropic/claude-opus-5");
  });
});

test("persisted model_select clears an override when Ctrl+S saves the bundled default", async (t) => {
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

    // Native Ctrl+S explicitly saves the bundled default and clears the override.
    const bundledDefaultModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
    const ctx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
      model: bundledDefaultModel,
    };
    await runtime.applySessionStart(ctx);
    await persistModelThroughPublicApi(pi, ctx, bundledDefaultModel);

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    // Override for architect should be cleared
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
  });
});

test("Rush persists a model override through public setModel for a non-default user model", async (t) => {
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
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });

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
    await runtime.applySessionStart(ctx);
    await persistModelThroughPublicApi(pi, ctx, nonDefaultModel);

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
  test(`${selection} persists a model override through public setModel for a non-default user model`, async (t) => {
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
      const { pi, runtime } = registerRuntimeHarness({
        primaryAgents: new Map([[selection, primary]]),
        subagentMetadata: [],
      });

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
        model: { provider: "anthropic", id: "claude-opus-5" },
      };
      await runtime.applySessionStart(ctx);
      await persistModelThroughPublicApi(pi, ctx, nonDefaultModel);

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

test("echo guard: TLH's own public setModel application does not record a model override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-primary-runtime-test-", { cwd: true, test: t });
  const primaryAgents = new Map([["architect", rushLikePrimary()]]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    const initialModel = { provider: "anthropic", id: "claude-opus-5" };
    pi.model = initialModel;
    const applyCtx = {
      cwd: fixture.cwd,
      sessionManager: { getBranch: () => [] },
      ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4-6" }] },
      get model() {
        return pi.model;
      },
    };
    const runtime = registerTlhPrimaryAgentRuntime(pi, {
      env: {},
      primaryAgents,
      subagentMetadata: [],
    });
    assert.ok(runtime);

    const { manager, session } = createPublicModelSession(pi, applyCtx, initialModel);
    pi.setModel = async (model) => {
      await session.setModel(model);
      return true;
    };

    // The primary runtime reaches Pi's public setModel boundary. Its internal
    // application must not be mistaken for a persisted user selection.
    await runtime.applySessionStart(applyCtx);
    await manager.flush();

    let settings;
    try {
      settings = JSON.parse(readFileSync(join(fixture.agent, "settings.json"), "utf8"));
    } catch {
      settings = null;
    }
    assert.equal(
      settings?.tlh?.primaryAgent?.modelOverrides?.architect,
      undefined,
      "TLH's own public setModel application must not record a model override",
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

test("public setModel persistence records override baseline on first creation", async (t) => {
  // Verifies that a persisted public setModel call for a first-time override
  // writes the packaged default of that moment as the baseline in reconcile-state.json.
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
    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });

    // User explicitly saves a non-default model with native Ctrl+S.
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
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    };
    await runtime.applySessionStart(ctx);
    await persistModelThroughPublicApi(pi, ctx, nonDefaultModel);

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

    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });

    // User explicitly saves a different non-default model (this is an edit, not a first creation).
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
      model: { provider: "anthropic", id: "claude-opus-4-8" },
    };
    await runtime.applySessionStart(ctx);
    await persistModelThroughPublicApi(pi, ctx, newOverrideModel);

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
  // 1. Packaged default is X. User saves an override via public setModel/Ctrl+S → baseline X is recorded.
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
    // User saves a non-default model via Ctrl+S/model_select.
    // This should record baseline {model: "anthropic/claude-sonnet-4-6"} for architect@anthropic.
    const { pi, runtime } = registerRuntimeHarness({
      primaryAgents: primaryAgentsWithX,
      subagentMetadata: [],
    });

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
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    };
    await runtime.applySessionStart(ctx);
    await persistModelThroughPublicApi(pi, ctx, overrideModel);

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
 * Drives the user-facing override-creation path through Pi's public
 * AgentSession.setModel({ persist: true }) boundary. Everything downstream
 * (primary override + baseline recording) is production code.
 */
async function createPrimaryOverrideViaRealPath(
  fixture,
  primaryAgents,
  chosenModel,
  availableModels,
) {
  const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });
  const initialModel =
    availableModels.find(
      (candidate) => candidate.provider !== chosenModel.provider || candidate.id !== chosenModel.id,
    ) ?? chosenModel;
  const ctx = {
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => [] },
    ui: { notify() {} },
    modelRegistry: { getAvailable: () => availableModels },
    model: initialModel,
  };
  await runtime.applySessionStart(ctx);
  await persistModelThroughPublicApi(pi, ctx, chosenModel);
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

    const { pi, runtime } = registerRuntimeHarness({ primaryAgents, subagentMetadata: [] });

    const chosen = { provider: "anthropic", id: "claude-opus-5" };
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
      model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    };
    await runtime.applySessionStart(ctx);
    const { manager, session } = createPublicModelSession(pi, ctx, ctx.model);
    // Pi's settings manager records the load failure and lets the public model
    // mutation complete; TLH must not record a primary baseline for a write that
    // the profile guard refused.
    await session.setModel(chosen, { persist: true });
    await manager.flush();

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
