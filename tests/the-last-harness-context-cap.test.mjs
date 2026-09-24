import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerContextCap } = await jiti.import("../extensions/the-last-harness/context-cap.ts");

// Production uses the eager TLH extension through Jiti and the subagent runtime
// through a separate native ESM loader graph. Keep these imports native so this
// regression exercises the real cross-loader metadata handoff.
const { toModelInfo, contextWindowsForChildModels, resolveRuntimeModelContext } =
  await import("../extensions/subagents/src/shared/model-info.js");
const { resolveEffectiveContextWindow } =
  await import("../extensions/subagents/src/shared/context-diagnostics.js");
const { contextWindowForModel } =
  await import("../extensions/subagents/src/runs/background/pi-streaming.js");

const CAP = 200_000;
const NON_CHILD_ENV = {
  PI_SUBAGENT_CHILD: undefined,
  PI_SUBAGENT_CHILD_AGENT: undefined,
  PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: undefined,
};
const CANONICAL_DEVELOPER_ENV = {
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_CHILD_AGENT: "developer",
  PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: "1",
};
const MODEL_CONTEXT_WINDOW_POLICY_KEY = Symbol.for("the-last-harness.model-context-window-policy");
const MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY = Symbol.for(
  "the-last-harness.model-context-window-policy-state",
);

function createPiHarness() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

function createModel(contextWindow = 1_000_000, provider = "test-provider", id = "test-model") {
  return { contextWindow, provider, id };
}

function createCtx(options = {}) {
  const model = options.model ?? createModel();
  const allModels = options.allModels ?? [model];
  const notifications = [];
  return {
    notifications,
    model,
    cwd: options.cwd ?? "/tmp",
    hasUI: true,
    modelRegistry: options.modelRegistry ?? {
      getAll: () => allModels,
    },
    ui: {
      notify(message, type = "info") {
        notifications.push({ message, type });
      },
    },
  };
}

async function createRealModelRegistry(fixture, contextWindow = 450_000) {
  const modelsPath = join(fixture.agent, "models.json");
  const authPath = join(fixture.agent, "auth.json");
  writeFileSync(
    modelsPath,
    `${JSON.stringify(
      {
        providers: {
          "refresh-provider": {
            baseUrl: "https://example.invalid/v1",
            apiKey: "test-key",
            api: "openai-completions",
            models: [
              {
                id: "refresh-model",
                contextWindow,
                maxTokens: 1_000,
                reasoning: true,
              },
            ],
            modelOverrides: {
              "refresh-model": { name: "overlaid-refresh-model" },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return { modelsPath, registry: new ModelRegistry(runtime), runtime };
}

function writeConfiguredContextWindow(modelsPath, contextWindow) {
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  models.providers["refresh-provider"].models[0].contextWindow = contextWindow;
  writeFileSync(modelsPath, `${JSON.stringify(models, null, 2)}\n`);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

// ─── command registration ─────────────────────────────────────────────────────

test("registerContextCap registers /toggle-context-cap command", () => {
  const pi = createPiHarness();
  registerContextCap(pi);
  assert.ok(pi.commands.has("toggle-context-cap"), "registers /toggle-context-cap");
  assert.ok(!pi.commands.has("context-cap"), "does not register /context-cap");
});

test("registerContextCap registers session_start, model_select, session_shutdown handlers", () => {
  const pi = createPiHarness();
  registerContextCap(pi);
  assert.ok(pi.handlers.has("session_start"), "registers session_start handler");
  assert.ok(pi.handlers.has("model_select"), "registers model_select handler");
  assert.ok(pi.handlers.has("session_shutdown"), "registers session_shutdown handler");
});

// ─── /toggle-context-cap arg rejection ───────────────────────────────────────

test("/toggle-context-cap rejects non-empty args with error notify and does not touch settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const command = pi.commands.get("toggle-context-cap");
      assert.ok(command, "command must be registered");

      const ctx = createCtx({ cwd: fixture.dir });
      await command.handler("something", ctx);

      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].type, "error");
      assert.match(ctx.notifications[0].message, /Usage: \/toggle-context-cap/);

      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(written.tlh?.contextCap, undefined, "settings must remain unchanged");
    },
  );
});

// ─── session_start caps large model ──────────────────────────────────────────

test("session_start caps a 1M-contextWindow model to 200_000 by default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const model = createModel(1_000_000);
      const ctx = createCtx({ model, cwd: fixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(model.contextWindow, CAP, "contextWindow must be capped to 200_000");
    },
  );
});

test("session_start does not cap a model whose contextWindow is already <= 200_000", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const model = createModel(128_000);
      const ctx = createCtx({ model, cwd: fixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(
        model.contextWindow,
        128_000,
        "contextWindow must remain unchanged when already within cap",
      );
    },
  );
});

test("session_start keeps non-child Codex GPT-5.6 at the 200_000 cap", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const model = createModel(372_000, "openai-codex", "gpt-5.6");
      const ctx = createCtx({ model, cwd: fixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(model.contextWindow, CAP);
    },
  );
});

// ─── child context-window policy ─────────────────────────────────────────────

test("child detection honors supported signals, role provenance, and explicit PI_SUBAGENT_CHILD=0", async (t) => {
  const cases = [
    {
      name: "child signal without role provenance remains native",
      env: { PI_SUBAGENT_CHILD: "1" },
      contextWindow: 450_000,
    },
    {
      name: "child-agent marker without parent provenance remains native",
      env: { PI_SUBAGENT_CHILD_AGENT: "developer" },
      contextWindow: 450_000,
    },
    {
      name: "non-developer child retains native context",
      env: {
        PI_SUBAGENT_CHILD: "1",
        PI_SUBAGENT_CHILD_AGENT: "test-runner",
        PI_SUBAGENT_PROJECT_AGENT_GUIDANCE: "1",
      },
      contextWindow: 450_000,
    },
    {
      name: "canonical developer child is capped",
      env: CANONICAL_DEVELOPER_ENV,
      contextWindow: 272_000,
    },
    {
      name: "explicit non-child signal wins over stale marker",
      env: { PI_SUBAGENT_CHILD: "0", PI_SUBAGENT_CHILD_AGENT: "developer" },
      contextWindow: CAP,
    },
    { name: "no child signal", env: NON_CHILD_ENV, contextWindow: CAP },
  ];

  for (const testCase of cases) {
    const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
    writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        ...NON_CHILD_ENV,
        ...testCase.env,
      },
      async () => {
        const pi = createPiHarness();
        registerContextCap(pi);

        const model = createModel(450_000, "test-provider", "test-model");
        const ctx = createCtx({ model, cwd: fixture.dir });
        await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

        assert.equal(model.contextWindow, testCase.contextWindow, testCase.name);
        await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      },
    );
  }
});

test("canonical developer child applies the 272_000 ceiling uniformly", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  const initialSettings = `${JSON.stringify(
    { tlh: { primaryAgent: { enabled: false, selected: "disabled" } } },
    null,
    2,
  )}\n`;
  writeFileSync(settingsPath, initialSettings);

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...CANONICAL_DEVELOPER_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const codexGpt56 = createModel(272_000, "openai-codex", "gpt-5.6-luna");
      const native372 = createModel(372_000, "test-provider", "native-372k");
      const native450 = createModel(450_000, "anthropic", "claude-sonnet-4.6");
      const native1m = createModel(1_000_000, "test-provider", "large-model");
      const native200 = createModel(200_000, "test-provider", "small-model");
      const ctx = createCtx({
        model: codexGpt56,
        allModels: [codexGpt56, native372, native450, native1m, native200],
        cwd: fixture.dir,
      });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(codexGpt56.contextWindow, 272_000);
      assert.equal(native372.contextWindow, 272_000);
      assert.equal(native450.contextWindow, 272_000);
      assert.equal(native1m.contextWindow, 272_000);
      assert.equal(native200.contextWindow, 200_000);
      assert.equal(readFileSync(settingsPath, "utf8"), initialSettings);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);

      assert.equal(codexGpt56.contextWindow, 272_000);
      assert.equal(native372.contextWindow, 372_000);
      assert.equal(native450.contextWindow, 450_000);
      assert.equal(native1m.contextWindow, 1_000_000);
      assert.equal(native200.contextWindow, 200_000);
    },
  );
});

test("canonical developer child model_select applies 272_000 and shutdown restores native", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...CANONICAL_DEVELOPER_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const selectedModel = createModel(1_000_000, "openai-codex", "gpt-5.6-sol");
      const ctx = createCtx({ model: selectedModel, cwd: fixture.dir });

      await pi.handlers.get("model_select")?.[0]?.({ model: selectedModel }, ctx);
      assert.equal(selectedModel.contextWindow, 272_000);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(selectedModel.contextWindow, 1_000_000);
    },
  );
});

test("child context policy honors tlh.contextCap.disabled and toggle restoration", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify({ tlh: { contextCap: { disabled: true } } })}\n`);

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...CANONICAL_DEVELOPER_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const command = pi.commands.get("toggle-context-cap");
      assert.ok(command, "command must be registered");

      const model = createModel(1_000_000, "openai-codex", "gpt-5.6-sol");
      const ctx = createCtx({ model, cwd: fixture.dir });
      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, 1_000_000, "disabled child policy must not mutate models");

      await command.handler("", ctx);
      assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).tlh.contextCap.disabled, false);
      assert.equal(model.contextWindow, 272_000, "enabling applies the developer ceiling live");

      await command.handler("", ctx);
      assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).tlh.contextCap.disabled, true);
      assert.equal(model.contextWindow, 1_000_000, "disabling restores the native child window");
    },
  );
});

test("native subagent loader keeps async-runner role policies aligned", async (t) => {
  const enabledFixture = createIsolatedProfileFixture("tlh-cap-loader-test-", { test: t });
  writeFileSync(join(enabledFixture.agent, "settings.json"), "{}\n");

  await withEnv(
    { HOME: enabledFixture.home, PI_CODING_AGENT_DIR: enabledFixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const codex = createModel(372_000, "openai-codex", "gpt-5.6-luna");
      const native = createModel(450_000, "anthropic", "claude-sonnet-4.6");
      const ctx = createCtx({
        model: codex,
        allModels: [codex, native],
        cwd: enabledFixture.dir,
      });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(codex.contextWindow, CAP, "the non-child parent must cap Codex to 200k");
      assert.equal(
        native.contextWindow,
        CAP,
        "the non-child parent must cap native models to 200k",
      );

      const availableModels = ctx.modelRegistry.getAll().map(toModelInfo);
      const nativeContextWindows = contextWindowsForChildModels(availableModels);
      const developerContextWindows = contextWindowsForChildModels(availableModels, {
        canonicalDeveloper: true,
      });
      assert.equal(
        resolveEffectiveContextWindow("openai-codex/gpt-5.6-luna:high", availableModels),
        372_000,
        "non-developer async-runner diagnostics must recover native context across loaders",
      );
      assert.equal(
        resolveEffectiveContextWindow("anthropic/claude-sonnet-4.6", availableModels),
        450_000,
        "non-developer async-runner diagnostics must recover native context across loaders",
      );
      assert.equal(
        resolveEffectiveContextWindow(
          "openai-codex/gpt-5.6-luna:high",
          availableModels,
          undefined,
          { canonicalDeveloper: true },
        ),
        272_000,
        "canonical developer async-runner diagnostics must apply the uniform ceiling",
      );
      assert.equal(
        resolveEffectiveContextWindow("anthropic/claude-sonnet-4.6", availableModels, undefined, {
          canonicalDeveloper: true,
        }),
        272_000,
      );
      assert.deepEqual(
        resolveRuntimeModelContext("openai-codex", "gpt-5.6-luna:high", nativeContextWindows),
        {
          identity: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
          contextWindow: 372_000,
        },
      );
      assert.deepEqual(
        resolveRuntimeModelContext("openai-codex", "gpt-5.6-luna:high", developerContextWindows),
        {
          identity: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
          contextWindow: 272_000,
        },
      );
      assert.equal(
        contextWindowForModel("anthropic/claude-sonnet-4.6", nativeContextWindows),
        450_000,
      );
      assert.equal(
        contextWindowForModel("anthropic/claude-sonnet-4.6", developerContextWindows),
        272_000,
      );

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );

  const disabledFixture = createIsolatedProfileFixture("tlh-cap-loader-test-", { test: t });
  writeFileSync(
    join(disabledFixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { contextCap: { disabled: true } } })}\n`,
  );

  await withEnv(
    {
      HOME: disabledFixture.home,
      PI_CODING_AGENT_DIR: disabledFixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const codex = createModel(1_000_000, "openai-codex", "gpt-5.6-luna");
      const ctx = createCtx({ model: codex, cwd: disabledFixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      const availableModels = ctx.modelRegistry.getAll().map(toModelInfo);
      const nativeContextWindows = contextWindowsForChildModels(availableModels);
      const developerContextWindows = contextWindowsForChildModels(availableModels, {
        canonicalDeveloper: true,
      });
      assert.equal(codex.contextWindow, 1_000_000);
      assert.equal(
        resolveEffectiveContextWindow("openai-codex/gpt-5.6-luna", availableModels, undefined, {
          canonicalDeveloper: true,
        }),
        1_000_000,
        "disabled canonical-developer diagnostics must use native context",
      );
      assert.equal(
        contextWindowForModel("openai-codex/gpt-5.6-luna", nativeContextWindows),
        1_000_000,
      );
      assert.equal(
        contextWindowForModel("openai-codex/gpt-5.6-luna", developerContextWindows),
        1_000_000,
      );
      assert.deepEqual(
        resolveRuntimeModelContext("openai-codex", "gpt-5.6-luna", developerContextWindows),
        {
          identity: { provider: "openai-codex", model: "gpt-5.6-luna" },
          contextWindow: 1_000_000,
        },
      );

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );
});

test("a pending refresh read recaptures native context for a stable model identity", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-pending-read-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const stableModel = createModel(300_000, "pending-provider", "stable-model");
      const refreshDeferred = createDeferred();
      const registry = {
        getAll: () => [stableModel],
        refresh: () => refreshDeferred.promise,
      };
      const ctx = createCtx({ model: stableModel, cwd: fixture.dir, modelRegistry: registry });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(stableModel.contextWindow, 272_000);

      const refreshPromise = registry.refresh();
      const pendingRead = registry.getAll()[0];
      assert.equal(pendingRead, stableModel, "the pending read must preserve stable identity");
      assert.equal(pendingRead.contextWindow, 272_000);
      assert.equal(toModelInfo(pendingRead).nativeContextWindow, 300_000);
      assert.equal(toModelInfo(pendingRead).developerChildContextWindow, 272_000);

      const refreshError = new Error("pending refresh rejected");
      refreshDeferred.reject(refreshError);
      await assert.rejects(refreshPromise, (error) => error === refreshError);
      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(stableModel.contextWindow, 300_000);
    },
  );
});

test("session shutdown preserves an independent context-window change", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-window-owner-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const model = createModel(450_000, "window-owner-provider", "window-owner-model");
      const registry = { getAll: () => [model] };
      const ctx = createCtx({ model, cwd: fixture.dir, modelRegistry: registry });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, 272_000);
      model.contextWindow = 123_000;

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(
        model.contextWindow,
        123_000,
        "shutdown must preserve a window changed by an independent owner",
      );
      assert.equal(
        Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY),
        undefined,
        "lifecycle metadata is still removed when the window changed independently",
      );
    },
  );
});

test("session shutdown preserves policy metadata installed by a later owner", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-owner-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const model = createModel(450_000, "owner-provider", "owner-model");
      const registry = { getAll: () => [model] };
      const ctx = createCtx({ model, cwd: fixture.dir, modelRegistry: registry });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, 272_000);

      const installedGetAll = registry.getAll;
      let laterPolicy;
      registry.getAll = () => {
        const models = installedGetAll();
        laterPolicy = Object.freeze({
          nativeContextWindow: 123_000,
          developerChildContextWindow: 123_000,
          ownerToken: Symbol("later-owner"),
        });
        Object.defineProperty(models[0], MODEL_CONTEXT_WINDOW_POLICY_KEY, {
          configurable: true,
          enumerable: false,
          value: laterPolicy,
          writable: false,
        });
        models[0].contextWindow = 123_000;
        return models;
      };

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(
        model.contextWindow,
        123_000,
        "shutdown must not restore a later owner's window",
      );
      assert.equal(
        Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY)?.value,
        laterPolicy,
        "shutdown must not delete metadata owned by a later wrapper",
      );
      assert.equal(toModelInfo(model).nativeContextWindow, 123_000);
    },
  );
});

test("weak read tracking cleans up original and latest transient model objects", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-transient-model-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const transientModel = createModel(450_000, "transient-provider", "transient-model");
      let models = [transientModel];
      const registry = { getAll: () => models };
      const ctx = createCtx({
        model: createModel(128_000),
        cwd: fixture.dir,
        modelRegistry: registry,
      });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(transientModel.contextWindow, 272_000);
      const state = globalThis[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY];
      assert.ok(state?.ownedModels instanceof Set);
      assert.ok(
        [...(state?.ownedModels ?? [])].every((modelRef) => modelRef instanceof WeakRef),
        "transient cleanup handles must be weak references",
      );

      const replacementTransientModel = createModel(
        450_000,
        "transient-provider",
        "transient-model",
      );
      models = [replacementTransientModel];
      assert.equal(registry.getAll()[0], replacementTransientModel);
      const trackedModels = [...(state?.ownedModels ?? [])]
        .map((modelRef) => modelRef.deref())
        .filter(Boolean);
      assert.ok(
        trackedModels.includes(transientModel),
        "the original still-live transient model must retain a cleanup handle",
      );
      assert.ok(
        trackedModels.includes(replacementTransientModel),
        "the latest still-live transient model must retain a cleanup handle",
      );

      models = [];
      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      for (const model of [transientModel, replacementTransientModel]) {
        assert.equal(model.contextWindow, 450_000);
        assert.equal(
          Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY),
          undefined,
          "shutdown must remove owned metadata from every still-live transient model",
        );
      }
    },
  );
});

test("provider/id native policy keys remain collision-safe for embedded NULs", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-key-collision-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const embeddedNull = String.fromCharCode(0);
      const first = createModel(450_000, `collision${embeddedNull}provider`, "model");
      const second = createModel(600_000, "collision", `provider${embeddedNull}model`);
      const registry = { getAll: () => [first, second] };
      const ctx = createCtx({ model: first, cwd: fixture.dir, modelRegistry: registry });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(first.contextWindow, 272_000);
      assert.equal(second.contextWindow, 272_000);

      const unannotatedFirst = {
        provider: first.provider,
        id: first.id,
        contextWindow: 272_000,
      };
      const unannotatedSecond = {
        provider: second.provider,
        id: second.id,
        contextWindow: 272_000,
      };
      assert.deepEqual(toModelInfo(unannotatedFirst), {
        provider: `collision${embeddedNull}provider`,
        id: "model",
        fullId: `collision${embeddedNull}provider/model`,
        contextWindow: 272_000,
        nativeContextWindow: 450_000,
        developerChildContextWindow: 272_000,
      });
      assert.deepEqual(toModelInfo(unannotatedSecond), {
        provider: "collision",
        id: `provider${embeddedNull}model`,
        fullId: `collision/provider${embeddedNull}model`,
        contextWindow: 272_000,
        nativeContextWindow: 600_000,
        developerChildContextWindow: 272_000,
      });

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );
});

test("refresh settlement overrides stale pending-read metadata for 272k and 200k replacements", async (t) => {
  const cases = [
    { name: "canonical developer", nativeContextWindow: 272_000, env: CANONICAL_DEVELOPER_ENV },
    { name: "primary", nativeContextWindow: 200_000, env: NON_CHILD_ENV },
  ];

  for (const testCase of cases) {
    const fixture = createIsolatedProfileFixture("tlh-cap-pending-replacement-test-", { test: t });
    writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

    await withEnv(
      {
        HOME: fixture.home,
        PI_CODING_AGENT_DIR: fixture.agent,
        ...testCase.env,
      },
      async () => {
        const oldModel = createModel(450_000, "pending-replacement-provider", "pending-model");
        const replacementModel = createModel(
          testCase.nativeContextWindow,
          "pending-replacement-provider",
          "pending-model",
        );
        let models = [oldModel];
        const refreshStarted = createDeferred();
        const beforeInstall = createDeferred();
        const replacementInstalled = createDeferred();
        const settlement = createDeferred();
        const registry = {
          getAll: () => models,
          refresh: async () => {
            refreshStarted.resolve();
            await beforeInstall.promise;
            models = [replacementModel];
            replacementInstalled.resolve();
            await settlement.promise;
          },
        };
        const ctx = createCtx({ model: oldModel, cwd: fixture.dir, modelRegistry: registry });
        const pi = createPiHarness();
        registerContextCap(pi);

        await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
        assert.equal(
          oldModel.contextWindow,
          testCase.nativeContextWindow === 272_000 ? 272_000 : 200_000,
          `${testCase.name}: old model must receive its role cap`,
        );

        const refreshPromise = registry.refresh();
        await refreshStarted.promise;
        const oldPendingRead = registry.getAll()[0];
        assert.equal(oldPendingRead, oldModel);
        assert.equal(toModelInfo(oldPendingRead).nativeContextWindow, 450_000);

        beforeInstall.resolve();
        await replacementInstalled.promise;
        const replacementPendingRead = registry.getAll()[0];
        assert.equal(replacementPendingRead, replacementModel);
        assert.equal(
          replacementPendingRead.contextWindow,
          testCase.nativeContextWindow,
          `${testCase.name}: replacement read must expose its native window`,
        );
        assert.equal(
          toModelInfo(replacementPendingRead).nativeContextWindow,
          testCase.nativeContextWindow,
          `${testCase.name}: pending replacement diagnostics must not inherit stale native metadata`,
        );

        settlement.resolve();
        await refreshPromise;
        const settledReplacement = registry.getAll()[0];
        assert.equal(settledReplacement, replacementModel);
        assert.equal(
          toModelInfo(settledReplacement).nativeContextWindow,
          testCase.nativeContextWindow,
        );
        assert.equal(
          toModelInfo({
            provider: replacementModel.provider,
            id: replacementModel.id,
            contextWindow: testCase.nativeContextWindow,
          }).nativeContextWindow,
          testCase.nativeContextWindow,
          `${testCase.name}: identity fallback must use the settled native window`,
        );

        await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
        assert.equal(
          replacementModel.contextWindow,
          testCase.nativeContextWindow,
          `${testCase.name}: shutdown must leave the replacement native window installed`,
        );
      },
    );
  }
});

test("overlapping refreshes preserve owned native metadata across generation advancement", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-overlap-pending-read-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const oldModel = createModel(450_000, "overlap-pending-provider", "overlap-model");
      const replacementModel = createModel(450_000, "overlap-pending-provider", "overlap-model");
      let models = [oldModel];
      let refreshCount = 0;
      const firstStarted = createDeferred();
      const firstInstall = createDeferred();
      const firstInstalled = createDeferred();
      const firstSettlement = createDeferred();
      const secondStarted = createDeferred();
      const secondSettlement = createDeferred();
      const registry = {
        getAll: () => models,
        refresh: async () => {
          refreshCount++;
          if (refreshCount === 1) {
            firstStarted.resolve();
            await firstInstall.promise;
            models = [replacementModel];
            firstInstalled.resolve();
            await firstSettlement.promise;
            return "first";
          }
          secondStarted.resolve();
          await secondSettlement.promise;
          return "second";
        },
      };
      const ctx = createCtx({ model: oldModel, cwd: fixture.dir, modelRegistry: registry });
      const pi = createPiHarness();
      registerContextCap(pi);

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(oldModel.contextWindow, 272_000);

      const firstRefresh = registry.refresh();
      await firstStarted.promise;
      firstInstall.resolve();
      await firstInstalled.promise;

      const secondRefresh = registry.refresh();
      await secondStarted.promise;
      const pendingReplacement = registry.getAll()[0];
      assert.equal(pendingReplacement, replacementModel);
      assert.equal(pendingReplacement.contextWindow, 272_000);
      assert.equal(toModelInfo(pendingReplacement).nativeContextWindow, 450_000);

      replacementModel.contextWindow = 123_000;
      firstSettlement.resolve();
      await firstRefresh;
      assert.equal(
        toModelInfo(replacementModel).nativeContextWindow,
        123_000,
        "settlement must recapture a later independently installed window",
      );
      assert.equal(replacementModel.contextWindow, 123_000);

      secondSettlement.resolve();
      await secondRefresh;
      assert.equal(toModelInfo(replacementModel).nativeContextWindow, 123_000);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(replacementModel.contextWindow, 123_000);
    },
  );
});

test("ModelRegistry.refresh treats replacement generations as authoritative", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-refresh-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_OFFLINE: "1",
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { modelsPath, registry } = await createRealModelRegistry(fixture);
      const initial = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(initial, "configured model must load before refresh");
      const ctx = createCtx({ model: initial, cwd: fixture.dir, modelRegistry: registry });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(initial.contextWindow, 272_000);
      const modelsBeforeRefresh = registry.getAll();
      assert.equal(
        modelsBeforeRefresh.find((model) => model.provider === "refresh-provider")?.contextWindow,
        272_000,
      );

      const modelsFileBeforeRefresh = readFileSync(modelsPath, "utf8");
      await registry.refresh({ allowNetwork: false });
      const replacement = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      const availableReplacement = registry
        .getAvailable()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(replacement, "refreshed configured model must remain available");
      assert.notEqual(replacement, initial, "refresh must exercise a replacement model object");
      assert.equal(replacement.contextWindow, 272_000);
      assert.equal(availableReplacement?.contextWindow, 272_000);
      assert.equal(registry.find("refresh-provider", "refresh-model")?.contextWindow, 272_000);
      assert.equal(readFileSync(modelsPath, "utf8"), modelsFileBeforeRefresh);

      const modelInfo = toModelInfo(replacement);
      assert.equal(modelInfo.nativeContextWindow, 450_000);
      assert.equal(modelInfo.developerChildContextWindow, 272_000);
      const unannotatedReplacement = {
        provider: "refresh-provider",
        id: "refresh-model",
        contextWindow: 450_000,
      };
      const unannotatedInfo = toModelInfo(unannotatedReplacement);
      assert.equal(unannotatedInfo.nativeContextWindow, 450_000);
      assert.equal(unannotatedInfo.developerChildContextWindow, 272_000);
      const modelInfos = [modelInfo];
      const nativeContextWindows = contextWindowsForChildModels(modelInfos);
      const developerContextWindows = contextWindowsForChildModels(modelInfos, {
        canonicalDeveloper: true,
      });
      assert.equal(
        resolveEffectiveContextWindow("refresh-provider/refresh-model", modelInfos),
        450_000,
      );
      assert.equal(
        resolveEffectiveContextWindow("refresh-provider/refresh-model", modelInfos, undefined, {
          canonicalDeveloper: true,
        }),
        272_000,
      );
      assert.deepEqual(
        resolveRuntimeModelContext("refresh-provider", "refresh-model", nativeContextWindows),
        {
          identity: { provider: "refresh-provider", model: "refresh-model" },
          contextWindow: 450_000,
        },
      );
      assert.equal(
        contextWindowForModel("refresh-provider/refresh-model", developerContextWindows),
        272_000,
      );

      writeConfiguredContextWindow(modelsPath, 200_000);
      const modelsFileBefore200Refresh = readFileSync(modelsPath, "utf8");
      await registry.refresh({ allowNetwork: false });
      const replacement200 = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(replacement200, "200k refreshed model must remain available");
      assert.notEqual(replacement200, replacement, "each refresh must replace the model object");
      assert.equal(replacement200.contextWindow, 200_000);
      assert.equal(readFileSync(modelsPath, "utf8"), modelsFileBefore200Refresh);
      const modelInfo200 = toModelInfo(replacement200);
      assert.equal(modelInfo200.nativeContextWindow, 200_000);
      assert.equal(modelInfo200.developerChildContextWindow, 200_000);
      const unannotatedInfo200 = toModelInfo({
        provider: "refresh-provider",
        id: "refresh-model",
        contextWindow: 200_000,
      });
      assert.equal(unannotatedInfo200.nativeContextWindow, 200_000);
      assert.equal(unannotatedInfo200.developerChildContextWindow, 200_000);

      writeConfiguredContextWindow(modelsPath, 450_000);
      const modelsFileBefore450Refresh = readFileSync(modelsPath, "utf8");
      await registry.refresh({ allowNetwork: false });
      const replacement450 = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(replacement450, "restored 450k model must remain available");
      assert.notEqual(replacement450, replacement200, "each refresh must replace the model object");
      assert.equal(replacement450.contextWindow, 272_000);
      assert.equal(readFileSync(modelsPath, "utf8"), modelsFileBefore450Refresh);
      const modelInfo450 = toModelInfo(replacement450);
      assert.equal(modelInfo450.nativeContextWindow, 450_000);
      assert.equal(modelInfo450.developerChildContextWindow, 272_000);

      writeConfiguredContextWindow(modelsPath, 272_000);
      const modelsFileBefore272Refresh = readFileSync(modelsPath, "utf8");
      await registry.refresh({ allowNetwork: false });
      const replacement272 = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(replacement272, "272k refreshed model must remain available");
      assert.notEqual(replacement272, replacement450, "each refresh must replace the model object");
      assert.equal(replacement272.contextWindow, 272_000);
      assert.equal(readFileSync(modelsPath, "utf8"), modelsFileBefore272Refresh);
      const modelInfo272 = toModelInfo(replacement272);
      assert.equal(modelInfo272.nativeContextWindow, 272_000);
      assert.equal(modelInfo272.developerChildContextWindow, 272_000);
      const unannotatedInfo272 = toModelInfo({
        provider: "refresh-provider",
        id: "refresh-model",
        contextWindow: 272_000,
      });
      assert.equal(unannotatedInfo272.nativeContextWindow, 272_000);
      assert.equal(unannotatedInfo272.developerChildContextWindow, 272_000);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );
});

test("rejected refresh without a replacement preserves capped model metadata", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-refresh-unchanged-rejection-test-", {
    test: t,
  });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_OFFLINE: "1",
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { registry, runtime } = await createRealModelRegistry(fixture);
      const model = registry
        .getAll()
        .find(
          (candidate) =>
            candidate.provider === "refresh-provider" && candidate.id === "refresh-model",
        );
      assert.ok(model, "configured model must load before refresh");
      const ctx = createCtx({ model, cwd: fixture.dir, modelRegistry: registry });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, 272_000);
      assert.equal(toModelInfo(model).nativeContextWindow, 450_000);

      const rejection = new Error("unchanged refresh failed");
      runtime.refresh = async () => {
        throw rejection;
      };
      await assert.rejects(registry.refresh({ allowNetwork: false }), rejection);
      assert.equal(model.contextWindow, 272_000);
      assert.equal(
        toModelInfo(model).nativeContextWindow,
        450_000,
        "unchanged capped models must retain their captured native metadata",
      );

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(model.contextWindow, 450_000);
    },
  );
});

test("overlapping ModelRegistry.refresh applies the late 272k snapshot authoritatively", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-refresh-overlap-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_OFFLINE: "1",
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { modelsPath, registry, runtime } = await createRealModelRegistry(fixture);
      const initial = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(initial, "configured model must load before refresh");
      const ctx = createCtx({ model: initial, cwd: fixture.dir, modelRegistry: registry });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(initial.contextWindow, 272_000);

      const nativeRefresh = runtime.refresh.bind(runtime);
      const refreshGates = [];
      runtime.refresh = async (...args) => {
        const gate = createDeferred();
        refreshGates.push(gate);
        await gate.promise;
        return nativeRefresh(...args);
      };

      writeConfiguredContextWindow(modelsPath, 272_000);
      const late272Refresh = registry.refresh({ allowNetwork: false });
      writeConfiguredContextWindow(modelsPath, 450_000);
      const early450Refresh = registry.refresh({ allowNetwork: false });
      assert.equal(refreshGates.length, 2, "both refreshes must overlap before either resumes");

      // Let the second invocation install 450k first, then let the first
      // invocation install 272k last. The completion order is authoritative.
      refreshGates[1].resolve();
      await early450Refresh;
      writeConfiguredContextWindow(modelsPath, 272_000);
      refreshGates[0].resolve();
      await late272Refresh;

      const lateReplacement = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(lateReplacement, "late refreshed model must remain available");
      assert.equal(lateReplacement.contextWindow, 272_000);
      const lateInfo = toModelInfo(lateReplacement);
      assert.equal(lateInfo.nativeContextWindow, 272_000);
      assert.equal(lateInfo.developerChildContextWindow, 272_000);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(
        lateReplacement.contextWindow,
        272_000,
        "shutdown must leave the late snapshot's native window unchanged",
      );
      assert.equal(
        toModelInfo(lateReplacement).nativeContextWindow,
        undefined,
        "shutdown must remove lifecycle-owned metadata",
      );
    },
  );
});

test("rejected overlapping refresh reconciles its installed 272k replacement", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-refresh-rejected-overlap-test-", {
    test: t,
  });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_OFFLINE: "1",
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { modelsPath, registry, runtime } = await createRealModelRegistry(fixture);
      const initial = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(initial, "configured model must load before refresh");
      const ctx = createCtx({ model: initial, cwd: fixture.dir, modelRegistry: registry });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(initial.contextWindow, 272_000);

      const nativeRefresh = runtime.refresh.bind(runtime);
      const refreshGates = [];
      runtime.refresh = async (...args) => {
        const refreshIndex = refreshGates.length;
        const gate = createDeferred();
        refreshGates.push(gate);
        await gate.promise;
        const result = await nativeRefresh(...args);
        if (refreshIndex === 1) throw new Error("late refresh failed");
        return result;
      };

      writeConfiguredContextWindow(modelsPath, 450_000);
      const successful450Refresh = registry.refresh({ allowNetwork: false });
      writeConfiguredContextWindow(modelsPath, 272_000);
      const rejected272Refresh = registry.refresh({ allowNetwork: false });
      assert.equal(refreshGates.length, 2, "both refreshes must overlap before either resumes");

      // The successful 450k snapshot lands first. The later refresh installs
      // 272k before rejecting; its installed snapshot remains authoritative.
      writeConfiguredContextWindow(modelsPath, 450_000);
      refreshGates[0].resolve();
      await successful450Refresh;
      writeConfiguredContextWindow(modelsPath, 272_000);
      refreshGates[1].resolve();
      await assert.rejects(rejected272Refresh, /late refresh failed/);

      const rejectedReplacement = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(rejectedReplacement, "rejected refreshed model must remain available");
      assert.equal(rejectedReplacement.contextWindow, 272_000);
      const rejectedInfo = toModelInfo(rejectedReplacement);
      assert.equal(rejectedInfo.nativeContextWindow, 272_000);
      assert.equal(rejectedInfo.developerChildContextWindow, 272_000);

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(
        rejectedReplacement.contextWindow,
        272_000,
        "shutdown must leave the rejected snapshot's native window unchanged",
      );
    },
  );
});

test("ModelRegistry.refresh preserves native windows when context cap is disabled", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-refresh-disabled-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { contextCap: { disabled: true } } })}\n`,
  );

  await withEnv(
    {
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_OFFLINE: "1",
      ...CANONICAL_DEVELOPER_ENV,
    },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { modelsPath, registry } = await createRealModelRegistry(fixture, 450_000);
      const initial = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(initial, "configured model must load before refresh");
      const ctx = createCtx({ model: initial, cwd: fixture.dir, modelRegistry: registry });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(initial.contextWindow, 450_000);
      const modelsFileBeforeRefresh = readFileSync(modelsPath, "utf8");
      await registry.refresh({ allowNetwork: false });
      const replacement = registry
        .getAll()
        .find((model) => model.provider === "refresh-provider" && model.id === "refresh-model");
      assert.ok(replacement, "refreshed configured model must remain available");
      assert.notEqual(replacement, initial, "refresh must exercise a replacement model object");
      assert.equal(replacement.contextWindow, 450_000);
      assert.equal(readFileSync(modelsPath, "utf8"), modelsFileBeforeRefresh);

      const modelInfo = toModelInfo(replacement);
      assert.equal(modelInfo.nativeContextWindow, 450_000);
      assert.equal(modelInfo.developerChildContextWindow, 450_000);
      const unannotatedReplacement = {
        provider: "refresh-provider",
        id: "refresh-model",
        contextWindow: 450_000,
      };
      const unannotatedInfo = toModelInfo(unannotatedReplacement);
      assert.equal(unannotatedInfo.nativeContextWindow, 450_000);
      assert.equal(unannotatedInfo.developerChildContextWindow, 450_000);
      assert.equal(
        resolveEffectiveContextWindow("refresh-provider/refresh-model", [modelInfo], undefined, {
          canonicalDeveloper: true,
        }),
        450_000,
      );
      assert.equal(
        contextWindowForModel(
          "refresh-provider/refresh-model",
          contextWindowsForChildModels([modelInfo], { canonicalDeveloper: true }),
        ),
        450_000,
      );

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
    },
  );
});

// ─── tlh.contextCap.disabled=true opt-out ────────────────────────────────────

test("session_start leaves contextWindow untouched when tlh.contextCap.disabled=true", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const model = createModel(1_000_000);
      const ctx = createCtx({ model, cwd: fixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

      assert.equal(
        model.contextWindow,
        1_000_000,
        "contextWindow must remain 1M when cap is disabled",
      );
    },
  );
});

// ─── model_select caps newly selected model ───────────────────────────────────

test("model_select caps a large model to 200_000", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const newModel = createModel(900_000);
      const ctx = createCtx({ cwd: fixture.dir });

      await pi.handlers.get("model_select")?.[0]?.({ model: newModel }, ctx);

      assert.equal(newModel.contextWindow, CAP, "model_select must cap new model contextWindow");
    },
  );
});

test("model_select leaves contextWindow untouched when tlh.contextCap.disabled=true", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const newModel = createModel(900_000);
      const ctx = createCtx({ cwd: fixture.dir });

      await pi.handlers.get("model_select")?.[0]?.({ model: newModel }, ctx);

      assert.equal(
        newModel.contextWindow,
        900_000,
        "model_select must not cap new model when disabled",
      );
    },
  );
});

// ─── session_shutdown restores original contextWindow ─────────────────────────

test("session_shutdown restores original contextWindow after session_start capped it", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);

      const model = createModel(1_000_000);
      const ctx = createCtx({ model, cwd: fixture.dir });

      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, CAP, "contextWindow must be capped first");

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);
      assert.equal(model.contextWindow, 1_000_000, "contextWindow must be restored after shutdown");
    },
  );
});

test("session_shutdown restores owned registry methods and clears policy handoff state", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-shutdown-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { registry } = await createRealModelRegistry(fixture, 1_000_000);
      const model = registry
        .getAll()
        .find(
          (candidate) =>
            candidate.provider === "refresh-provider" && candidate.id === "refresh-model",
        );
      assert.ok(model, "configured model must load before shutdown cleanup");
      const ctx = createCtx({ model, cwd: fixture.dir, modelRegistry: registry });
      const methodNames = ["getAll", "getAvailable", "find", "refresh"];
      const descriptorsBefore = new Map(
        methodNames.map((name) => [name, Object.getOwnPropertyDescriptor(registry, name)]),
      );

      await pi.handlers.get("session_start")?.[0]?.({}, ctx);
      assert.equal(model.contextWindow, CAP);
      assert.ok(
        Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY),
        "session lifecycle must attach model policy metadata",
      );
      assert.ok(
        globalThis[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY],
        "session lifecycle must publish process policy state",
      );

      await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);

      for (const name of methodNames) {
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(registry, name),
          descriptorsBefore.get(name),
          `${name} descriptor must be restored after shutdown`,
        );
      }
      assert.equal(
        Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY),
        undefined,
        "lifecycle-owned model metadata must be removed",
      );
      assert.equal(globalThis[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY], undefined);
      assert.equal(toModelInfo(model).nativeContextWindow, undefined);
      assert.equal(toModelInfo(model).developerChildContextWindow, undefined);
    },
  );
});

test("session_shutdown preserves later registry, model, and process wrappers", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-shutdown-wrapper-test-", { test: t });
  writeFileSync(join(fixture.agent, "settings.json"), "{}\n");

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const { registry } = await createRealModelRegistry(fixture, 1_000_000);
      const model = registry
        .getAll()
        .find(
          (candidate) =>
            candidate.provider === "refresh-provider" && candidate.id === "refresh-model",
        );
      assert.ok(model, "configured model must load before shutdown wrapper test");
      const ctx = createCtx({ model, cwd: fixture.dir, modelRegistry: registry });
      const getAvailableBefore = Object.getOwnPropertyDescriptor(registry, "getAvailable");

      await pi.handlers.get("session_start")?.[0]?.({}, ctx);
      const ownedGetAll = registry.getAll;
      const laterGetAll = function (...args) {
        return ownedGetAll.apply(this, args);
      };
      registry.getAll = laterGetAll;
      const laterPolicy = Object.freeze({
        nativeContextWindow: 123_000,
        developerChildContextWindow: 123_000,
      });
      Object.defineProperty(model, MODEL_CONTEXT_WINDOW_POLICY_KEY, {
        configurable: true,
        enumerable: false,
        value: laterPolicy,
        writable: false,
      });
      const laterState = { owner: "later-wrapper" };
      Object.defineProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY, {
        configurable: true,
        enumerable: false,
        value: laterState,
        writable: false,
      });

      try {
        await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);

        assert.equal(
          registry.getAll,
          laterGetAll,
          "shutdown must not replace a later registry wrapper",
        );
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(registry, "getAvailable"),
          getAvailableBefore,
          "still-owned registry methods must be restored",
        );
        assert.equal(
          globalThis[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY],
          laterState,
          "shutdown must not remove later process state",
        );
        assert.equal(
          Object.getOwnPropertyDescriptor(model, MODEL_CONTEXT_WINDOW_POLICY_KEY)?.value,
          laterPolicy,
          "shutdown must not remove later model metadata",
        );
      } finally {
        if (globalThis[MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY] === laterState) {
          Reflect.deleteProperty(globalThis, MODEL_CONTEXT_WINDOW_POLICY_STATE_KEY);
        }
      }
    },
  );
});

// ─── /toggle-context-cap persistence + live apply/restore ────────────────────

test("/toggle-context-cap enables cap (flips disabled=true to false) and applies live", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ tlh: { contextCap: { disabled: true } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const command = pi.commands.get("toggle-context-cap");
      assert.ok(command, "command must be registered");

      const model = createModel(1_000_000);
      const ctx = createCtx({ model, cwd: fixture.dir });

      // Cap is currently disabled (disabled=true). Toggle should enable it.
      await command.handler("", ctx);

      // Check setting persisted
      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(
        written.tlh?.contextCap?.disabled,
        false,
        "disabled must be set to false after toggle",
      );

      // Check live apply
      assert.equal(
        model.contextWindow,
        CAP,
        "model contextWindow must be capped immediately after toggle",
      );

      // Check notification
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].type, "info");
      assert.match(ctx.notifications[0].message, /Context cap enabled/i);
    },
  );
});

test("/toggle-context-cap disables cap (flips enabled to disabled=true) and restores live", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ tlh: { primaryAgent: { enabled: false, selected: "disabled" } } }, null, 2)}\n`,
  );

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const command = pi.commands.get("toggle-context-cap");
      assert.ok(command, "command must be registered");

      // First, apply the cap so the model has been capped
      const model = createModel(1_000_000);
      const ctx = createCtx({ model, cwd: fixture.dir });
      await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
      assert.equal(model.contextWindow, CAP, "contextWindow must be capped before toggle");

      // Toggle should disable the cap
      await command.handler("", ctx);

      // Check setting persisted
      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(
        written.tlh?.contextCap?.disabled,
        true,
        "disabled must be set to true after toggle",
      );

      // Check live restore
      assert.equal(
        model.contextWindow,
        1_000_000,
        "model contextWindow must be restored immediately after disabling cap",
      );

      // Check notification
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].type, "info");
      assert.match(ctx.notifications[0].message, /Context cap disabled/i);
    },
  );
});

test("/toggle-context-cap creates a backup when overwriting existing settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-cap-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  const initialSettings = `${JSON.stringify({ tlh: { contextCap: { disabled: false } } }, null, 2)}\n`;
  writeFileSync(settingsPath, initialSettings);

  await withEnv(
    { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent, ...NON_CHILD_ENV },
    async () => {
      const pi = createPiHarness();
      registerContextCap(pi);
      const command = pi.commands.get("toggle-context-cap");
      assert.ok(command, "command must be registered");

      const ctx = createCtx({ cwd: fixture.dir });
      await command.handler("", ctx);

      // A backup should exist
      const backups = readdirSync(fixture.agent).filter((f) => f.startsWith("settings.json.bak-"));
      assert.equal(backups.length, 1, "exactly one backup file must exist");
      assert.equal(readFileSync(join(fixture.agent, backups[0]), "utf8"), initialSettings);

      // Notification should mention "disabled"
      assert.equal(ctx.notifications.length, 1);
      assert.equal(ctx.notifications[0].type, "info");
      assert.match(ctx.notifications[0].message, /Context cap disabled/i);
    },
  );
});

test("/toggle-context-cap fails gracefully when outside isolated profile", async () => {
  const pi = createPiHarness();
  registerContextCap(pi);
  const command = pi.commands.get("toggle-context-cap");
  assert.ok(command, "command must be registered");

  // No PI_CODING_AGENT_DIR set → write should fail with a safe error
  const savedEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
    PI_SUBAGENT_CHILD_AGENT: process.env.PI_SUBAGENT_CHILD_AGENT,
  };
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD_AGENT;
    const ctx = createCtx({ cwd: "/tmp" });
    await command.handler("", ctx);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].type, "error");
    assert.match(ctx.notifications[0].message, /Could not update context cap setting/);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
