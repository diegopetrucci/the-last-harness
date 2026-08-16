import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ModelSelectorComponent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createPiHarness,
  createPrimaryPrompt,
  lockedRushPrimary,
  rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  MODEL_SELECTION_SCOPE_ALL_SESSIONS,
  MODEL_SELECTION_SCOPE_OPTIONS,
  MODEL_SELECTION_SCOPE_SESSION_ONLY,
  chooseTlhModelSelectionScope,
  installTlhModelSelectionPersistenceOverride,
  replayAllTlhUnclaimedModelSelectionDefaults,
  setTlhModelSelectionActiveModelResolver,
  setTlhSessionOnlyModel,
} = await jiti.import("../extensions/the-last-harness/model-selection-scope.ts");
const { registerTlhPrimaryAgentRuntime } = await jiti.import(
  "../extensions/the-last-harness/primary-agent-runtime.ts",
);

function readSettings(agent) {
  try {
    return JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(agent, settings) {
  writeFileSync(join(agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function installScopeOverride(getActiveModel = () => undefined) {
  assert.equal(installTlhModelSelectionPersistenceOverride(), true);
  replayAllTlhUnclaimedModelSelectionDefaults();
  setTlhSessionOnlyModel(undefined);
  setTlhModelSelectionActiveModelResolver(getActiveModel);
}

async function queueNativeSelectorWrites(manager, model, applyActiveModel, thinkingLevel) {
  let callbackDone;
  const selector = Object.create(ModelSelectorComponent.prototype);
  selector.dispose = () => {};
  selector.settingsManager = manager;
  selector.onSelectCallback = () => {
    callbackDone = (async () => {
      // AgentSession.setModel first crosses its async auth check. The shim's
      // native-selector context must survive this boundary deterministically.
      await Promise.resolve();
      if (!applyActiveModel) {
        return;
      }
      applyActiveModel();
      manager.setDefaultModelAndProvider(model.provider, model.id);
      if (thinkingLevel) {
        manager.setDefaultThinkingLevel(thinkingLevel);
      }
    })();
  };
  selector.handleSelect(model);
  await callbackDone;
}

async function dispatchLikeExtensionRunner(handlers, event, context) {
  for (const handler of handlers) {
    await handler(event, context);
  }
}

function createScopeContext(fixture, selection, model, modelRegistry = [model]) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => [] },
    ui: {
      async select(_title, options) {
        return selection === "cancel" ? undefined : options[selection];
      },
      notify() {},
    },
    modelRegistry: { getAvailable: () => modelRegistry },
    model,
  };
}

function registerScopeRuntime(primaryAgents) {
  const pi = createPiHarness();
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents ?? new Map([["architect", createPrimaryPrompt("architect")]]),
    subagentMetadata: [],
  });
  assert.ok(runtime);
  const handler = (name) => {
    const value = pi.events.find((event) => event.name === name)?.handler;
    assert.equal(typeof value, "function", `${name} handler must be registered`);
    return value;
  };
  return {
    pi,
    runtime,
    beforeAgentStart: handler("before_agent_start"),
    modelSelect: handler("model_select"),
    sessionShutdown: handler("session_shutdown"),
    sessionTree: handler("session_tree"),
    thinkingSelect: handler("thinking_level_select"),
  };
}

test("model scope picker exposes the approved labels in order with session-only as default", async () => {
  assert.deepEqual(
    [...MODEL_SELECTION_SCOPE_OPTIONS],
    [MODEL_SELECTION_SCOPE_SESSION_ONLY, MODEL_SELECTION_SCOPE_ALL_SESSIONS],
  );
  const calls = [];
  const scope = await chooseTlhModelSelectionScope({
    mode: "tui",
    hasUI: true,
    ui: {
      async select(title, options) {
        calls.push({ title, options });
        return options[0];
      },
    },
  });
  assert.equal(scope, "session-only");
  assert.deepEqual(calls, [
    { title: "Model selection scope", options: [...MODEL_SELECTION_SCOPE_OPTIONS] },
  ]);
});

test("scope picker exceptions keep the native selection session-only without restoring", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-picker-error-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, pi } = registerScopeRuntime();
    pi.model = previousModel;
    installScopeOverride(() => pi.model);
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    context.ui.select = async () => {
      throw new Error("picker unavailable");
    };
    let restorationCalls = 0;
    pi.setModel = async (model) => {
      restorationCalls += 1;
      pi.model = model;
      return true;
    };

    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    await manager.flush();

    assert.deepEqual(pi.model, selectedModel);
    assert.equal(restorationCalls, 0);
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
    });
    assert.equal(
      readSettings(fixture.agent).tlh?.primaryAgent?.modelOverrides?.architect,
      undefined,
    );
  });
});

test("model persistence interception is idempotent across repeated installation", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-idempotent-", {
    cwd: true,
    test: t,
  });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    installScopeOverride();
    const patchedSetter = SettingsManager.prototype.setDefaultModelAndProvider;
    const patchedSelector = ModelSelectorComponent.prototype.handleSelect;
    installScopeOverride();
    assert.equal(SettingsManager.prototype.setDefaultModelAndProvider, patchedSetter);
    assert.equal(ModelSelectorComponent.prototype.handleSelect, patchedSelector);
  });
});

test("unsafe non-TLH profiles keep the original upstream SettingsManager behavior", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-unsafe-", { cwd: true, test: t });
  const script = `
		import assert from "node:assert/strict";
		import { mkdirSync, readFileSync } from "node:fs";
		import { join } from "node:path";
		import { SettingsManager } from "@earendil-works/pi-coding-agent";
		import { installTlhModelSelectionPersistenceOverride } from "./extensions/the-last-harness/model-selection-scope.js";
		const agent = join(process.env.HOME, ".pi", "agent");
		mkdirSync(agent, { recursive: true });
		const original = SettingsManager.prototype.setDefaultModelAndProvider;
		assert.equal(installTlhModelSelectionPersistenceOverride(), false);
		assert.equal(SettingsManager.prototype.setDefaultModelAndProvider, original);
		const manager = SettingsManager.create(process.cwd(), agent);
		manager.setDefaultModelAndProvider("anthropic", "outside-tlh");
		await manager.flush();
		const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
		assert.equal(settings.defaultModel, "outside-tlh");
	`;
  const env = { ...process.env, HOME: fixture.home };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("session-only survives turn and tree reapplication, then resets on explicit mode and new session", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-session-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  const availableModels = [previousModel, selectedModel];
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });
  const sessionSentinel = join(fixture.cwd, "existing-session.jsonl");
  writeFileSync(sessionSentinel, "existing session content\n");

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const primaryAgents = new Map([["architect", rushLikePrimary()]]);
    const { beforeAgentStart, modelSelect, pi, runtime, sessionTree } =
      registerScopeRuntime(primaryAgents);
    pi.model = previousModel;
    installScopeOverride(() => pi.model);
    const context = createScopeContext(fixture, 0, selectedModel, availableModels);
    Object.defineProperty(context, "model", { get: () => pi.model });
    await runtime.applySessionStart(context);

    await queueNativeSelectorWrites(
      manager,
      selectedModel,
      () => {
        pi.model = selectedModel;
      },
      "high",
    );
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    assert.deepEqual(pi.model, selectedModel);

    await beforeAgentStart({ systemPrompt: "base" }, context);
    assert.deepEqual(
      pi.model,
      selectedModel,
      "next turn must preserve the accepted session-only model",
    );
    await sessionTree({ type: "session_tree" }, context);
    assert.deepEqual(
      pi.model,
      selectedModel,
      "session-tree reapplication must preserve the session-only model",
    );

    await pi.commands.get("switch-primary-agent").handler("architect", context);
    assert.deepEqual(
      pi.model,
      previousModel,
      "an explicit primary mode change reapplies its packaged model",
    );

    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    await runtime.applySessionStart(context);
    assert.deepEqual(
      pi.model,
      previousModel,
      "a new session must not inherit the prior session-only model",
    );
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
    });
    assert.equal(readFileSync(sessionSentinel, "utf8"), "existing session content\n");
  });
});

test("All sessions persists one upstream default and the applicable primary override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-all-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let activeModel = previousModel;
    installScopeOverride(() => activeModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();
    await queueNativeSelectorWrites(
      manager,
      selectedModel,
      () => {
        activeModel = selectedModel;
      },
      "high",
    );
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      createScopeContext(fixture, 1, selectedModel, [previousModel, selectedModel]),
    );

    const written = readSettings(fixture.agent);
    assert.equal(written.defaultProvider, selectedModel.provider);
    assert.equal(written.defaultModel, selectedModel.id);
    assert.equal(written.defaultThinkingLevel, "high");
    assert.equal(written.tlh.primaryAgent.modelOverrides.architect, "anthropic/claude-opus-5");
  });
});

test("native selector claims survive preceding async extension dispatch and stay session-only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-dispatch-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let activeModel = previousModel;
    installScopeOverride(() => activeModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      activeModel = selectedModel;
    });
    let pickerCalls = 0;
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    context.ui.select = async (_title, options) => {
      pickerCalls += 1;
      return options[0];
    };
    // context-cap registers first as an async handler with no internal await;
    // the runner's `await handler(...)` still yields before TLH runs.
    const precedingContextCapLikeHandler = async () => {};

    await dispatchLikeExtensionRunner(
      [precedingContextCapLikeHandler, modelSelect],
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    await manager.flush();
    assert.equal(pickerCalls, 1);
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
    });
  });
});

test("reconfirming an active session-only model does not persist it globally", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-session-noop-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, pi } = registerScopeRuntime();
    pi.model = previousModel;
    installScopeOverride(() => pi.model);
    let pickerCalls = 0;
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    context.ui.select = async (_title, options) => {
      pickerCalls += 1;
      return options[0];
    };

    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    await manager.flush();
    assert.equal(pickerCalls, 1);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);

    // Pi's picker writes once before AgentSession notices the model is already
    // active; no second write or model_select event follows that no-op.
    await queueNativeSelectorWrites(manager, selectedModel, undefined);
    await manager.flush();
    assert.equal(pickerCalls, 1, "a no-op selection emits no event and opens no scope prompt");
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
    });
  });
});

test("an active-model re-selection persists synchronously without stale state and thinking still persists", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-no-event-", { cwd: true, test: t });
  const activeModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const laterModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, { defaultProvider: "openai-codex", defaultModel: "old-default" });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let currentModel = activeModel;
    installScopeOverride(() => currentModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, thinkingSelect } = registerScopeRuntime();

    await queueNativeSelectorWrites(manager, activeModel, () => {}, "medium");
    await thinkingSelect(
      { type: "thinking_level_select", level: "medium", previousLevel: "low" },
      {},
    );
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultModel, activeModel.id);
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "medium");

    manager.setDefaultThinkingLevel("high");
    await thinkingSelect(
      { type: "thinking_level_select", level: "high", previousLevel: "medium" },
      {},
    );
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "high");

    await queueNativeSelectorWrites(manager, laterModel, () => {
      currentModel = laterModel;
    });
    await modelSelect(
      { type: "model_select", model: laterModel, previousModel: activeModel, source: "set" },
      createScopeContext(fixture, 0, laterModel, [activeModel, laterModel]),
    );
    const written = readSettings(fixture.agent);
    assert.equal(written.defaultModel, activeModel.id);
    assert.equal(written.defaultThinkingLevel, "high");
  });
});

test("a failed selector write is bounded and replayed before the next unrelated selection", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-failed-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const failedModel = { provider: "openai-codex", id: "unavailable-model" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let activeModel = previousModel;
    installScopeOverride(() => activeModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();

    // The selector wrote, but AgentSession.setModel rejected before its write/event.
    await queueNativeSelectorWrites(manager, failedModel, undefined);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);

    await queueNativeSelectorWrites(manager, selectedModel, () => {
      activeModel = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]),
    );
    await manager.flush();
    const written = readSettings(fixture.agent);
    assert.equal(
      written.defaultModel,
      failedModel.id,
      "the old upstream write is replayed, not merged",
    );
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
  });
});

test("session shutdown replays and clears a failed-selector candidate", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-failed-shutdown-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const failedModel = { provider: "openai-codex", id: "unavailable-model" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    installScopeOverride(() => previousModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { sessionShutdown } = registerScopeRuntime();

    await queueNativeSelectorWrites(manager, failedModel, undefined);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);
    await sessionShutdown({ type: "session_shutdown" }, {});
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultModel, failedModel.id);

    // A second boundary must not replay the already-drained candidate.
    manager.setDefaultModelAndProvider(previousModel.provider, previousModel.id);
    await manager.flush();
    await sessionShutdown({ type: "session_shutdown" }, {});
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);
  });
});

test("unknown model event sources fail open by replaying unmatched writes", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-future-source-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const failedModel = { provider: "openai-codex", id: "unavailable-model" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    installScopeOverride(() => previousModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();
    await queueNativeSelectorWrites(manager, failedModel, undefined);

    await modelSelect(
      {
        type: "model_select",
        model: previousModel,
        previousModel: failedModel,
        source: "future-source",
      },
      createScopeContext(fixture, 0, previousModel, [previousModel, failedModel]),
    );
    await manager.flush();
    assert.equal(readSettings(fixture.agent).defaultModel, failedModel.id);
  });
});

test("/model exact-name and provider-auth-style source=set persist without the picker", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-programmatic-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
    tlh: { primaryAgent: { enabled: false, selected: "disabled" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let activeModel = previousModel;
    installScopeOverride(() => activeModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();
    // Leave the same target behind as a failed native-selector candidate.
    await queueNativeSelectorWrites(manager, selectedModel, undefined);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);
    // Direct/programmatic AgentSession.setModel updates the active model first
    // and produces only this one settings write. It must drain, not merge with,
    // the failed picker candidate or provider-auth would open the scope dialog.
    activeModel = selectedModel;
    manager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);
    let pickerCalls = 0;
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    context.ui.select = async () => {
      pickerCalls += 1;
      return MODEL_SELECTION_SCOPE_SESSION_ONLY;
    };
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    assert.equal(pickerCalls, 0);
    assert.equal(readSettings(fixture.agent).defaultModel, selectedModel.id);
    activeModel = selectedModel;
  });
});

test("model cycling keeps persistent upstream behavior without creating a TLH primary override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-cycle-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    installScopeOverride(() => selectedModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect } = registerScopeRuntime();
    manager.setDefaultModelAndProvider(selectedModel.provider, selectedModel.id);
    let pickerCalls = 0;
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    context.ui.select = async () => {
      pickerCalls += 1;
      return MODEL_SELECTION_SCOPE_SESSION_ONLY;
    };
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "cycle" },
      context,
    );

    assert.equal(pickerCalls, 0);
    const written = readSettings(fixture.agent);
    assert.equal(written.defaultModel, selectedModel.id);
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
  });
});

test("cancel restores the previous active model without persisting attempted or restoration writes", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-cancel-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, pi } = registerScopeRuntime();
    pi.model = previousModel;
    installScopeOverride(() => pi.model);
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    const notifications = [];
    const context = createScopeContext(fixture, "cancel", selectedModel, [
      previousModel,
      selectedModel,
    ]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    context.ui.notify = (message, type) => notifications.push({ message, type });
    pi.setModel = async (model) => {
      const prior = pi.model;
      pi.model = model;
      manager.setDefaultModelAndProvider(model.provider, model.id);
      await modelSelect(
        { type: "model_select", model, previousModel: prior, source: "set" },
        context,
      );
      return true;
    };
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );

    assert.deepEqual(pi.model, previousModel);
    assert.deepEqual(
      notifications,
      [],
      "the corrected status waits for upstream's attempted-model status",
    );
    notifications.push({ message: `Model: ${selectedModel.id}`, type: "upstream-status" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications.at(-1), {
      message: `Kept ${previousModel.provider}/${previousModel.id} after cancelling model selection.`,
      type: "info",
    });
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previousModel.provider,
      defaultModel: previousModel.id,
    });
  });
});

test("cancel restoration failures are caught and reported without persisting the attempted model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-cancel-error-", {
    cwd: true,
    test: t,
  });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    let activeModel = previousModel;
    installScopeOverride(() => activeModel);
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, pi } = registerScopeRuntime();
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      activeModel = selectedModel;
    });
    const notifications = [];
    const context = createScopeContext(fixture, "cancel", selectedModel, [
      previousModel,
      selectedModel,
    ]);
    context.ui.notify = (message, type) => notifications.push({ message, type });
    pi.setModel = async () => {
      throw new Error("No API key");
    };
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    assert.deepEqual(notifications, [
      {
        message: `TLH could not restore the previous model: ${previousModel.provider}/${previousModel.id}`,
        type: "warning",
      },
    ]);
    assert.equal(readSettings(fixture.agent).defaultModel, previousModel.id);
  });
});

test("TLH-internal model application persists defaults without prompting or recording an override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-internal-", { cwd: true, test: t });
  const initialModel = { provider: "anthropic", id: "claude-opus-5" };
  const primaryModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  writeSettings(fixture.agent, {
    defaultProvider: initialModel.provider,
    defaultModel: initialModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const primaryAgents = new Map([["architect", rushLikePrimary()]]);
    const { modelSelect, pi, runtime } = registerScopeRuntime(primaryAgents);
    pi.model = initialModel;
    installScopeOverride(() => pi.model);
    let pickerCalls = 0;
    const context = createScopeContext(fixture, 0, initialModel, [initialModel, primaryModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    context.ui.select = async () => {
      pickerCalls += 1;
      return MODEL_SELECTION_SCOPE_SESSION_ONLY;
    };
    pi.setModel = async (model) => {
      const previousModel = pi.model;
      pi.model = model;
      manager.setDefaultModelAndProvider(model.provider, model.id);
      await modelSelect({ type: "model_select", model, previousModel, source: "set" }, context);
      return true;
    };

    await runtime.applySessionStart(context);
    assert.equal(pickerCalls, 0);
    assert.deepEqual(pi.model, primaryModel);
    const written = readSettings(fixture.agent);
    assert.equal(written.defaultModel, primaryModel.id);
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.architect, undefined);
  });
});

test("locked-primary All sessions persists globally without creating a role override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-locked-all-", {
    cwd: true,
    test: t,
  });
  const primaryModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: primaryModel.provider,
    defaultModel: primaryModel.id,
    tlh: { primaryAgent: { enabled: true, selected: "rush" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const primaryAgents = new Map([["rush", lockedRushPrimary()]]);
    const { beforeAgentStart, modelSelect, pi } = registerScopeRuntime(primaryAgents);
    pi.model = primaryModel;
    installScopeOverride(() => pi.model);
    const context = createScopeContext(fixture, 1, selectedModel, [primaryModel, selectedModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel: primaryModel, source: "set" },
      context,
    );
    let written = readSettings(fixture.agent);
    assert.equal(written.defaultModel, selectedModel.id);
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.rush, undefined);

    await beforeAgentStart({ systemPrompt: "base" }, context);
    assert.deepEqual(pi.model, primaryModel);
    written = readSettings(fixture.agent);
    assert.equal(written.tlh?.primaryAgent?.modelOverrides?.rush, undefined);
  });
});

test("locked-primary session-only is reapplied on the next before_agent_start", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-locked-session-", {
    cwd: true,
    test: t,
  });
  const primaryModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: primaryModel.provider,
    defaultModel: primaryModel.id,
    tlh: { primaryAgent: { enabled: true, selected: "rush" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const primaryAgents = new Map([["rush", lockedRushPrimary()]]);
    const { beforeAgentStart, modelSelect, pi } = registerScopeRuntime(primaryAgents);
    pi.model = primaryModel;
    installScopeOverride(() => pi.model);
    const context = createScopeContext(fixture, 0, selectedModel, [primaryModel, selectedModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel: primaryModel, source: "set" },
      context,
    );
    assert.deepEqual(pi.model, selectedModel);
    assert.equal(readSettings(fixture.agent).defaultModel, primaryModel.id);

    await beforeAgentStart({ systemPrompt: "base" }, context);
    assert.deepEqual(
      pi.model,
      primaryModel,
      "locked primary must force its model on the next turn",
    );
    assert.equal(readSettings(fixture.agent).tlh?.primaryAgent?.modelOverrides?.rush, undefined);
  });
});

test("non-TUI native model events retain persistent upstream behavior without showing the scope picker", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-scope-nontui-", { cwd: true, test: t });
  const previousModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  writeSettings(fixture.agent, {
    defaultProvider: previousModel.provider,
    defaultModel: previousModel.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const manager = SettingsManager.create(fixture.cwd, fixture.agent);
    const { modelSelect, pi } = registerScopeRuntime();
    pi.model = previousModel;
    installScopeOverride(() => pi.model);
    const context = createScopeContext(fixture, 0, selectedModel, [previousModel, selectedModel]);
    Object.defineProperty(context, "model", { get: () => pi.model });
    context.mode = "json";
    context.hasUI = false;
    let pickerCalls = 0;
    context.ui.select = async () => {
      pickerCalls += 1;
      return MODEL_SELECTION_SCOPE_SESSION_ONLY;
    };

    // Exercise the native selector path instead of calling the settings manager
    // directly; the non-TUI guard must still bypass the scope picker.
    await queueNativeSelectorWrites(manager, selectedModel, () => {
      pi.model = selectedModel;
    });
    await modelSelect(
      { type: "model_select", model: selectedModel, previousModel, source: "set" },
      context,
    );
    await manager.flush();
    assert.equal(pickerCalls, 0);
    assert.deepEqual(pi.model, selectedModel);
    assert.deepEqual(context.model, selectedModel);
    assert.equal(readSettings(fixture.agent).defaultModel, selectedModel.id);
  });
});
