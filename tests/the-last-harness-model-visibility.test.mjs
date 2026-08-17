import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InteractiveMode, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  getTlhModelVisibilityConfig,
  getUnfilteredAvailableModels,
  installTlhModelVisibilityFilter,
  isTlhModelHidden,
  matchesTlhModelVisibilityPattern,
  normalizeTlhModelVisibilityConfig,
} = await jiti.import("../extensions/the-last-harness/model-visibility.ts");

function createFakeModelRegistry(models) {
  const runtime = {
    getModels: () => models,
    getAvailableSnapshot: () => models,
    getModel: (provider, modelId) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth: () => true,
    reloadConfig: async () => {},
    getError: () => undefined,
  };
  return new ModelRegistry(runtime);
}

function modelKeys(models) {
  return models.map((model) => `${model.provider}/${model.id}`);
}

function runtimeModel(id) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function createTestModelRuntime(models, refreshModels) {
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
  runtime.registerProvider("tlh-test", {
    baseUrl: "https://tlh-test.example.invalid/v1",
    apiKey: "test-only",
    api: "openai-completions",
    models: models.map(runtimeModel),
    ...(refreshModels ? { refreshModels: async () => refreshModels().map(runtimeModel) } : {}),
  });
  return runtime;
}

function createModelMatchTestHarness(cachedModels, refreshedModels = cachedModels, onRefresh) {
  let availableModels = [...cachedModels];
  let refreshCalls = 0;
  const statusMessages = [];
  const session = { scopedModels: [] };
  const modelRuntime = Object.create({
    [Symbol.for("tlh.modelVisibilityRuntimeGetAvailableSnapshotOriginal")]() {
      return availableModels;
    },
  });
  modelRuntime.getAvailableSnapshot = () =>
    availableModels.filter((model) => !isTlhModelHidden(model));
  modelRuntime.refresh = async () => {
    refreshCalls += 1;
    availableModels = [...refreshedModels];
    onRefresh?.(session);
    return { aborted: false, errors: new Map() };
  };

  session.modelRuntime = modelRuntime;
  const interactiveMode = Object.create(InteractiveMode.prototype);
  interactiveMode.runtimeHost = { session };
  interactiveMode.showStatus = (message) => statusMessages.push(message);
  interactiveMode.showWarning = (message) => {
    throw new Error(`unexpected model refresh warning: ${message}`);
  };

  return {
    interactiveMode,
    modelRuntime,
    statusMessages,
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

test("model visibility matches canonical and bare-id glob patterns with visible overrides", () => {
  const config = normalizeTlhModelVisibilityConfig({
    hidden: ["anthropic/claude-opus-4-*", "claude-3-5-sonnet-*"],
    visible: ["anthropic/claude-opus-4-6"],
    unhide: ["claude-haiku-4-5"],
  });

  assert.equal(
    matchesTlhModelVisibilityPattern(
      { provider: "anthropic", id: "claude-opus-4-5" },
      "anthropic/claude-opus-4-*",
    ),
    true,
  );
  assert.equal(
    matchesTlhModelVisibilityPattern(
      { provider: "anthropic", id: "claude-opus-4-5" },
      "claude-opus-4-*",
    ),
    true,
  );
  assert.equal(
    matchesTlhModelVisibilityPattern(
      { provider: "openai-codex", id: "gpt-5.5" },
      "claude-opus-4-*",
    ),
    false,
  );

  const defaultsOnlyConfig = normalizeTlhModelVisibilityConfig({});

  assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-5" }, config), true);
  assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-opus-4-6" }, config), false);
  assert.equal(isTlhModelHidden({ provider: "anthropic", id: "claude-haiku-4-5" }, config), false);
  assert.equal(
    isTlhModelHidden({ provider: "anthropic", id: "claude-3-5-sonnet-20241022" }, config),
    true,
  );
  assert.equal(
    isTlhModelHidden({ provider: "anthropic", id: "claude-sonnet-4-6" }, defaultsOnlyConfig),
    true,
  );
  assert.equal(
    isTlhModelHidden({ provider: "openai-codex", id: "gpt-5.4" }, defaultsOnlyConfig),
    true,
  );
});

test("model visibility settings are isolated-profile only and normalize hidden/visible arrays", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        tlh: {
          modelVisibility: {
            disabled: true,
            hidden: [" anthropic/claude-opus-4-* ", 42, ""],
            visible: ["anthropic/claude-opus-4-6", false],
            unhide: [" claude-haiku-4-5 ", null],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.deepEqual(getTlhModelVisibilityConfig(), {
      disabled: true,
      hidden: ["anthropic/claude-opus-4-*"],
      visible: ["anthropic/claude-opus-4-6", "claude-haiku-4-5"],
    });
  });

  const normalPiAgent = join(fixture.home, ".pi", "agent");
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: normalPiAgent }, async () => {
    assert.equal(getTlhModelVisibilityConfig().disabled, true);
  });
});

test("installed model visibility filter is idempotent, hides defaults, and preserves an unfiltered internal escape hatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  const registry = createFakeModelRegistry([
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "openai-codex", id: "gpt-5.4" },
    { provider: "openai-codex", id: "gpt-5.5" },
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(settingsPath, `${JSON.stringify({}, null, 2)}\n`);

    installTlhModelVisibilityFilter();
    const patchedGetAvailable = ModelRegistry.prototype.getAvailable;
    const patchedFindExactModelMatch = InteractiveMode.prototype.findExactModelMatch;
    installTlhModelVisibilityFilter();
    assert.equal(ModelRegistry.prototype.getAvailable, patchedGetAvailable);
    assert.equal(InteractiveMode.prototype.findExactModelMatch, patchedFindExactModelMatch);

    assert.deepEqual(modelKeys(registry.getAvailable()), ["openai-codex/gpt-5.5"]);
    assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry)), [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
    ]);

    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          tlh: {
            modelVisibility: {
              hidden: ["anthropic/claude-opus-4-6"],
              unhide: ["claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "openai-codex/gpt-5.4"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    assert.deepEqual(modelKeys(registry.getAvailable()), [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
    ]);

    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { disabled: true } } }, null, 2)}\n`,
    );
    assert.deepEqual(modelKeys(registry.getAvailable()), [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
    ]);
  });
});

test("ModelRuntime filters async availability and current/refreshed snapshots while preserving the unfiltered escape hatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  let refreshedModels = ["hidden-refreshed", "visible-refreshed"];

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { hidden: ["tlh-test/hidden-*"] } } }, null, 2)}\n`,
    );
    installTlhModelVisibilityFilter();
    const patchedGetAvailable = ModelRuntime.prototype.getAvailable;
    const patchedGetAvailableSnapshot = ModelRuntime.prototype.getAvailableSnapshot;
    installTlhModelVisibilityFilter();
    assert.equal(ModelRuntime.prototype.getAvailable, patchedGetAvailable);
    assert.equal(ModelRuntime.prototype.getAvailableSnapshot, patchedGetAvailableSnapshot);

    const runtime = await createTestModelRuntime(
      ["hidden-current", "visible-current"],
      () => refreshedModels,
    );
    const registry = new ModelRegistry(runtime);

    assert.deepEqual(
      modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")),
      ["tlh-test/visible-current"],
    );

    const originalModelsGetAvailable = runtime.models.getAvailable;
    const getAvailableCalls = [];
    const providerModels = getUnfilteredAvailableModels(runtime).filter(
      (model) => model.provider === "tlh-test",
    );
    runtime.models.getAvailable = async (providerId, options) => {
      getAvailableCalls.push({ options, providerId });
      return providerModels;
    };
    const controller = new AbortController();
    const availabilityOptions = { signal: controller.signal };
    try {
      assert.deepEqual(modelKeys(await runtime.getAvailable("tlh-test", availabilityOptions)), [
        "tlh-test/visible-current",
      ]);
    } finally {
      runtime.models.getAvailable = originalModelsGetAvailable;
    }
    assert.equal(getAvailableCalls.length, 1);
    assert.equal(getAvailableCalls[0].providerId, "tlh-test");
    assert.equal(getAvailableCalls[0].options, availabilityOptions);
    assert.equal(getAvailableCalls[0].options.signal, controller.signal);

    assert.deepEqual(
      modelKeys(registry.getAvailable()).filter((key) => key.startsWith("tlh-test/")),
      ["tlh-test/visible-current"],
    );
    assert.deepEqual(
      modelKeys(getUnfilteredAvailableModels(runtime)).filter((key) => key.startsWith("tlh-test/")),
      ["tlh-test/hidden-current", "tlh-test/visible-current"],
    );
    assert.deepEqual(
      modelKeys(getUnfilteredAvailableModels(registry)).filter((key) =>
        key.startsWith("tlh-test/"),
      ),
      ["tlh-test/hidden-current", "tlh-test/visible-current"],
    );

    refreshedModels = ["hidden-after-refresh", "visible-after-refresh"];
    await runtime.refresh({ allowNetwork: false, force: true });
    assert.deepEqual(
      modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")),
      ["tlh-test/visible-after-refresh"],
    );
    assert.deepEqual(modelKeys(await runtime.getAvailable("tlh-test")), [
      "tlh-test/visible-after-refresh",
    ]);
    assert.deepEqual(
      modelKeys(getUnfilteredAvailableModels(registry)).filter((key) =>
        key.startsWith("tlh-test/"),
      ),
      ["tlh-test/hidden-after-refresh", "tlh-test/visible-after-refresh"],
    );
  });
});

test("installed model visibility filter keeps getAll direct lookup unfiltered while getAvailable stays filtered", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");
  const registry = createFakeModelRegistry([
    { provider: "anthropic", id: "claude-opus-4-6" },
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    { provider: "openai-codex", id: "gpt-5.5" },
  ]);

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(settingsPath, `${JSON.stringify({}, null, 2)}\n`);
    installTlhModelVisibilityFilter();

    assert.deepEqual(modelKeys(registry.getAvailable()), ["openai-codex/gpt-5.5"]);
    assert.deepEqual(modelKeys(registry.getAll()), [
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "openai-codex/gpt-5.5",
    ]);
    assert.deepEqual(
      registry
        .getAll()
        .find((model) => `${model.provider}/${model.id}` === "anthropic/claude-opus-4-6"),
      { provider: "anthropic", id: "claude-opus-4-6" },
    );
  });
});

test("exact /model provider/model lookup uses the unfiltered ModelRuntime snapshot without bypassing scoped models", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { hidden: ["tlh-test/hidden-*"] } } }, null, 2)}\n`,
    );
    installTlhModelVisibilityFilter();
    const runtime = await createTestModelRuntime(["hidden-exact", "hidden-scoped", "visible"]);
    const registry = new ModelRegistry(runtime);
    const interactiveMode = Object.create(InteractiveMode.prototype);
    interactiveMode.runtimeHost = {
      session: {
        scopedModels: [],
        modelRegistry: registry,
        modelRuntime: runtime,
      },
    };

    const originalRefresh = runtime.refresh.bind(runtime);
    let refreshCalls = 0;
    runtime.refresh = async (...args) => {
      refreshCalls += 1;
      throw new Error(`unexpected catalog refresh: ${args.length}`);
    };
    interactiveMode.showStatus = () => {
      throw new Error("unexpected catalog refresh status");
    };

    const hiddenExactMatch = await InteractiveMode.prototype.findExactModelMatch.call(
      interactiveMode,
      "tlh-test/hidden-exact",
    );
    assert.equal(`${hiddenExactMatch?.provider}/${hiddenExactMatch?.id}`, "tlh-test/hidden-exact");
    assert.equal(refreshCalls, 0, "hidden canonical lookup must not refresh model catalogs");

    const visibleMatch = await InteractiveMode.prototype.findExactModelMatch.call(
      interactiveMode,
      "tlh-test/visible",
    );
    assert.equal(`${visibleMatch?.provider}/${visibleMatch?.id}`, "tlh-test/visible");
    assert.equal(refreshCalls, 0, "visible canonical lookup should retain Pi's cached behavior");
    assert.deepEqual(
      modelKeys(runtime.getAvailableSnapshot()).filter((key) => key.startsWith("tlh-test/")),
      ["tlh-test/visible"],
    );

    // Bare and missing references remain delegated to Pi's normal matcher path;
    // give that path the minimal UI it needs after the hidden-canonical canary.
    runtime.refresh = originalRefresh;
    interactiveMode.showStatus = () => {};
    assert.equal(
      await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "hidden-exact"),
      undefined,
    );
    assert.equal(
      await InteractiveMode.prototype.findExactModelMatch.call(interactiveMode, "tlh-test/missing"),
      undefined,
    );

    interactiveMode.runtimeHost.session.scopedModels = [
      { model: runtime.getModel("tlh-test", "hidden-scoped") },
    ];
    assert.equal(
      await InteractiveMode.prototype.findExactModelMatch.call(
        interactiveMode,
        "tlh-test/hidden-exact",
      ),
      undefined,
    );
    const scopedMatch = await InteractiveMode.prototype.findExactModelMatch.call(
      interactiveMode,
      "tlh-test/hidden-scoped",
    );
    assert.equal(`${scopedMatch?.provider}/${scopedMatch?.id}`, "tlh-test/hidden-scoped");
  });
});

test("exact model lookup preserves Pi's visible bare-id collision priority over a hidden canonical match", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { hidden: ["hidden-provider/model"] } } }, null, 2)}\n`,
    );
    installTlhModelVisibilityFilter();
    const hiddenCanonicalModel = { provider: "hidden-provider", id: "model" };
    const visibleBareIdModel = { provider: "visible-provider", id: "hidden-provider/model" };
    assert.equal(isTlhModelHidden(hiddenCanonicalModel), true);
    assert.equal(isTlhModelHidden(visibleBareIdModel), false);
    const harness = createModelMatchTestHarness([hiddenCanonicalModel, visibleBareIdModel]);

    const match = await InteractiveMode.prototype.findExactModelMatch.call(
      harness.interactiveMode,
      "hidden-provider/model",
    );

    assert.equal(`${match?.provider}/${match?.id}`, "visible-provider/hidden-provider/model");
    assert.deepEqual(modelKeys(harness.modelRuntime.getAvailableSnapshot()), [
      "visible-provider/hidden-provider/model",
    ]);
    assert.equal(harness.refreshCalls, 0);
    assert.deepEqual(harness.statusMessages, []);
  });
});

test("exact model lookup resolves a refresh-only hidden canonical model after Pi delegates", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { hidden: ["refresh-provider/hidden-model"] } } }, null, 2)}\n`,
    );
    installTlhModelVisibilityFilter();
    const refreshedHiddenModel = { provider: "refresh-provider", id: "hidden-model" };
    assert.equal(isTlhModelHidden(refreshedHiddenModel), true);
    const harness = createModelMatchTestHarness([], [refreshedHiddenModel]);

    const match = await InteractiveMode.prototype.findExactModelMatch.call(
      harness.interactiveMode,
      "refresh-provider/hidden-model",
    );

    assert.equal(`${match?.provider}/${match?.id}`, "refresh-provider/hidden-model");
    assert.deepEqual(harness.modelRuntime.getAvailableSnapshot(), []);
    assert.equal(harness.refreshCalls, 1);
    assert.deepEqual(harness.statusMessages, ["Refreshing model catalogs…"]);
  });
});

test("post-refresh hidden fallback respects a model scope activated while Pi refreshes", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-visibility-test-", { test: t });
  const settingsPath = join(fixture.agent, "settings.json");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ tlh: { modelVisibility: { hidden: ["refresh-provider/hidden-model"] } } }, null, 2)}\n`,
    );
    installTlhModelVisibilityFilter();
    const refreshedHiddenModel = { provider: "refresh-provider", id: "hidden-model" };
    const scopedModel = { provider: "scope-provider", id: "scoped-model" };
    assert.equal(isTlhModelHidden(refreshedHiddenModel), true);
    const harness = createModelMatchTestHarness([], [refreshedHiddenModel], (session) => {
      session.scopedModels = [{ model: scopedModel }];
    });

    const match = await InteractiveMode.prototype.findExactModelMatch.call(
      harness.interactiveMode,
      "refresh-provider/hidden-model",
    );

    assert.equal(match, undefined);
    assert.deepEqual(modelKeys(getUnfilteredAvailableModels(harness.modelRuntime)), [
      "refresh-provider/hidden-model",
    ]);
    assert.deepEqual(harness.interactiveMode.runtimeHost.session.scopedModels, [
      { model: scopedModel },
    ]);
    assert.equal(harness.refreshCalls, 1);
    assert.deepEqual(harness.statusMessages, ["Refreshing model catalogs…"]);
  });
});
