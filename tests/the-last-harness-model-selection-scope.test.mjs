import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import {
  AgentSession,
  getPackageDir,
  initTheme,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";
import {
  createPiHarness,
  createPrimaryPrompt,
  rushLikePrimary,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const {
  beginTlhModelSelectionPersistenceSession,
  claimTlhModelSelectionDefaults,
  endTlhModelSelectionPersistenceSession,
  installTlhModelSelectionPersistenceOverride,
  readTlhModelSelectionPersistence,
  updateTlhModelSelectionPersistenceContext,
} = await jiti.import("../extensions/the-last-harness/model-selection-scope.ts");
const { registerTlhPrimaryAgentRuntime } = await jiti.import(
  "../extensions/the-last-harness/primary-agent-runtime.ts",
);

// Pi 0.85.1 moved keybinding initialisation to interactive app startup; tests
// must seed the global keybindings so that model-picker handleInput and rendered
// hints (e.g. app.models.save / Ctrl+S) behave correctly without a live TUI
// session.  Use file-URL dynamic imports to reach pi-coding-agent's internal
// deep paths (not in the package exports map) and pi-coding-agent's own nested
// pi-tui instance (which has a separate module singleton from the repo-level one).
{
  const piPkg = getPackageDir();
  const piKeybindingsUrl = pathToFileURL(join(piPkg, "dist", "core", "keybindings.js")).href;
  const piTuiKeybindingsUrl = pathToFileURL(
    join(piPkg, "node_modules", "@earendil-works", "pi-tui", "dist", "keybindings.js"),
  ).href;
  const { KeybindingsManager: PiKeybindingsManager } = await import(piKeybindingsUrl);
  const { setKeybindings: setPiKeybindings } = await import(piTuiKeybindingsUrl);
  // PiKeybindingsManager bakes KEYBINDINGS (all pi-coding-agent bindings) into
  // its constructor via super(); call it with no args to get the full defaults.
  setPiKeybindings(new PiKeybindingsManager());
}

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

function model(provider, id) {
  return { provider, id };
}

function modelsMatch(left, right) {
  return left?.provider === right?.provider && left?.id === right?.id;
}

function copyPublishedPiPackage(t, suffix) {
  const packageDir = mkdtempSync(join(tmpdir(), `tlh-pi-private-${suffix}-`));
  cpSync(join(getPackageDir(), "package.json"), join(packageDir, "package.json"));
  cpSync(join(getPackageDir(), "dist"), join(packageDir, "dist"), { recursive: true });
  // Pi 0.85.1 introduced @earendil-works/chord as a runtime bundle dependency.
  // Copy it into the temp package's node_modules so the isolated dist/bundle
  // chunks can resolve it without access to the repo-level node_modules.
  cpSync(
    join(getPackageDir(), "node_modules", "@earendil-works", "chord"),
    join(packageDir, "node_modules", "@earendil-works", "chord"),
    { recursive: true },
  );
  t.after(() => rmSync(packageDir, { recursive: true, force: true }));
  return packageDir;
}

function createModelContext(fixture, active, options = {}) {
  const availableModels = options.availableModels ?? [active.current];
  return {
    mode: "tui",
    hasUI: options.hasUI ?? true,
    cwd: fixture.cwd,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: {
      select: options.select ?? (async () => undefined),
      notify() {},
    },
    modelRegistry: { getAvailable: () => availableModels },
    get model() {
      return active.current;
    },
  };
}

function registerRuntime(primaryAgents, beforeRegistration) {
  const pi = createPiHarness();
  beforeRegistration?.(pi);
  const runtime = registerTlhPrimaryAgentRuntime(pi, {
    env: {},
    primaryAgents: primaryAgents ?? new Map([["architect", rushLikePrimary()]]),
    subagentMetadata: [],
  });
  assert.ok(runtime);
  return {
    pi,
    runtime,
    modelSelect: pi.events.find((event) => event.name === "model_select")?.handler,
    beforeAgentStart: pi.events.find((event) => event.name === "before_agent_start")?.handler,
    sessionTree: pi.events.find((event) => event.name === "session_tree")?.handler,
    sessionShutdown: pi.events.find((event) => event.name === "session_shutdown")?.handler,
  };
}

function assertHandlers(runtimeHarness) {
  assert.equal(typeof runtimeHarness.modelSelect, "function");
  assert.equal(typeof runtimeHarness.beforeAgentStart, "function");
  assert.equal(typeof runtimeHarness.sessionShutdown, "function");
}

async function startSession(runtimeHarness, context) {
  await runtimeHarness.runtime.applySessionStart(context);
}

async function fireModelSelect(runtimeHarness, context, selected, previous, source = "set") {
  await runtimeHarness.modelSelect(
    { type: "model_select", model: selected, previousModel: previous, source },
    context,
  );
}

function primaryWithModel(name, reference, options = {}) {
  return createPrimaryPrompt(name, {
    model: reference,
    applyModel: options.applyModel ?? false,
    applyThinking: options.applyThinking ?? false,
    tlhAnthropicThinking: options.tlhAnthropicThinking,
    tlhOpenaiModels: options.tlhOpenaiModels,
  });
}

/**
 * Exercise the published AgentSession.setModel implementation while routing its
 * model_select dispatch through the registered TLH and test handlers. This is
 * deliberately not a SettingsManager shortcut: Pi's public mutation boundary
 * owns persistence and awaits every extension handler before resolving.
 */
function createAgentSessionHarness(fixture, runtimeHarness, context, initialModel, options = {}) {
  const manager = SettingsManager.create(fixture.cwd, fixture.agent);
  const state = { model: initialModel, thinkingLevel: "low" };
  const session = Object.create(AgentSession.prototype);
  session.agent = { state };
  session.sessionManager = { appendModelChange() {} };
  session.settingsManager = manager;
  session._modelRuntime = {
    checkAuth: options.checkAuth ?? (async () => true),
    getAvailableSnapshot:
      options.getAvailableSnapshot ?? (() => options.availableModels ?? [initialModel]),
  };
  session._scopedModels = [];
  session._getThinkingLevelForModelSwitch = () => state.thinkingLevel;
  session._addPersistedDefaultToNonEmptyScope = () => {};
  session.setThinkingLevel = (level) => {
    state.thinkingLevel = level;
  };
  session._emitModelSelect = async (nextModel, previousModel, source) => {
    if (modelsMatch(nextModel, previousModel)) {
      return;
    }
    context.active.current = nextModel;
    runtimeHarness.pi.model = nextModel;
    for (const registered of runtimeHarness.pi.events) {
      if (registered.name !== "model_select") {
        continue;
      }
      await registered.handler(
        {
          type: "model_select",
          model: nextModel,
          previousModel,
          source,
        },
        context,
      );
    }
  };
  return { manager, session, state };
}

function createRuntimeContext(fixture, initialModel, availableModels) {
  const active = { current: initialModel };
  const context = createModelContext(fixture, active, { availableModels });
  context.active = active;
  return context;
}

test("native model selection has no TLH model-scope prompt and the selector prototype is untouched", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-native-picker-", { cwd: true, test: t });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const originalHandleSelect = ModelSelectorComponent.prototype.handleSelect;
    const runtimeHarness = registerRuntime();
    assertHandlers(runtimeHarness);
    const active = { current: previous };
    const context = createModelContext(fixture, active, {
      availableModels: [previous, selected],
      select: async (title) => {
        throw new Error(`unexpected TLH picker: ${title}`);
      },
    });
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);

    initTheme("dark", false);
    const nativeSelector = new ModelSelectorComponent(
      { requestRender() {} },
      previous,
      {
        getAvailableSnapshot: () => [previous, selected],
        getModel: (_provider, id) => [previous, selected].find((candidate) => candidate.id === id),
        refresh: async () => ({ aborted: false, errors: new Map() }),
      },
      [],
      () => {},
      () => {},
      undefined,
      () => {},
      previous,
    );
    assert.match(
      nativeSelector.render(120).join("\n"),
      /Enter to select · Ctrl\+S to set as default · Escape\/Ctrl\+C to cancel/,
    );
    nativeSelector.dispose();

    let callbackModel;
    const selector = Object.create(ModelSelectorComponent.prototype);
    selector.dispose = () => {};
    selector.onSelectCallback = (value) => {
      callbackModel = value;
    };
    selector.handleSelect(selected);
    assert.deepEqual(callbackModel, selected);
    assert.equal(ModelSelectorComponent.prototype.handleSelect, originalHandleSelect);

    active.current = selected;
    runtimeHarness.pi.model = selected;
    await fireModelSelect(runtimeHarness, context, selected, previous);
    await runtimeHarness.beforeAgentStart({ systemPrompt: "base" }, context);
    assert.deepEqual(runtimeHarness.pi.model, selected);
    assert.deepEqual(readSettings(fixture.agent), {
      defaultProvider: previous.provider,
      defaultModel: previous.id,
    });
    assert.equal(
      readSettings(fixture.agent).tlh?.primaryAgent?.modelOverrides?.architect,
      undefined,
    );
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("native Ctrl+S remains available when the model picker has a non-empty scope", (t) => {
  initTheme("dark", false);
  const previous = model("anthropic", "claude-sonnet-4-6");
  const scoped = model("anthropic", "claude-opus-5");
  const saved = [];
  const selector = new ModelSelectorComponent(
    { requestRender() {} },
    previous,
    {
      getAvailableSnapshot: () => [previous, scoped],
      getModel: (_provider, id) => [previous, scoped].find((candidate) => candidate.id === id),
      refresh: async () => ({ aborted: false, errors: new Map() }),
    },
    [{ model: scoped }],
    () => {},
    () => {},
    undefined,
    (selected) => saved.push(selected),
    previous,
  );
  t.after(() => selector.dispose());

  selector.handleInput(String.fromCharCode(19));
  assert.deepEqual(saved, [scoped]);
});

test("changed persisted selection survives earlier asynchronous model_select handlers", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-async-dispatch-", {
    cwd: true,
    test: t,
  });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const dispatchOrder = [];
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", {
            applyModel: false,
          }),
        ],
      ]),
      (pi) => {
        pi.on("model_select", async () => {
          dispatchOrder.push("earlier-start");
          await new Promise((resolve) => setTimeout(resolve, 2));
          dispatchOrder.push("earlier-finished");
        });
      },
    );
    assertHandlers(runtimeHarness);
    const context = createRuntimeContext(fixture, previous, [previous, selected]);
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);
    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      previous,
    );

    const options = { persist: true };
    await session.setModel(selected, options);
    await manager.flush();

    assert.deepEqual(dispatchOrder, ["earlier-start", "earlier-finished"]);
    assert.equal(readSettings(fixture.agent).defaultModel, selected.id);
    assert.equal(
      readSettings(fixture.agent).tlh.primaryAgent.modelOverrides.architect,
      "anthropic/claude-opus-5",
    );
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("same-model persist:true invokes the owner callback only after AgentSession.setModel succeeds", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-same-save-", { cwd: true, test: t });
  const activeModel = model("anthropic", "claude-opus-5");
  const previousDefault = model("openai-codex", "gpt-5.4");
  writeSettings(fixture.agent, {
    defaultProvider: previousDefault.provider,
    defaultModel: previousDefault.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", {
            applyModel: false,
          }),
        ],
      ]),
    );
    assertHandlers(runtimeHarness);
    const context = createRuntimeContext(fixture, activeModel, [activeModel, previousDefault]);
    runtimeHarness.pi.model = activeModel;
    await startSession(runtimeHarness, context);
    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      activeModel,
    );

    await session.setModel(activeModel, { persist: true });
    await manager.flush();

    assert.equal(readSettings(fixture.agent).defaultModel, activeModel.id);
    assert.equal(
      readSettings(fixture.agent).tlh.primaryAgent.modelOverrides.architect,
      "anthropic/claude-opus-5",
    );
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("persist:false remains session-only and never writes a primary override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-session-only-", { cwd: true, test: t });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", {
            applyModel: false,
          }),
        ],
      ]),
    );
    assertHandlers(runtimeHarness);
    const context = createRuntimeContext(fixture, previous, [previous, selected]);
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);
    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      previous,
    );

    await session.setModel(selected, { persist: false });
    await runtimeHarness.beforeAgentStart({ systemPrompt: "base" }, context);
    await manager.flush();

    assert.equal(readSettings(fixture.agent).defaultModel, previous.id);
    assert.equal(readSettings(fixture.agent).tlh.primaryAgent.modelOverrides?.architect, undefined);
    assert.deepEqual(context.active.current, selected);
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("session-only Enter survives turn/tree reapplication and clears at primary and new-session boundaries", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-session-lifecycle-", {
    cwd: true,
    test: t,
  });
  const defaultModel = model("anthropic", "claude-sonnet-4-6");
  const sessionModel = model("anthropic", "claude-opus-5");
  const rushModel = model("anthropic", "claude-haiku-4-5");
  writeSettings(fixture.agent, {
    defaultProvider: defaultModel.provider,
    defaultModel: defaultModel.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", { applyModel: true }),
        ],
        ["rush", primaryWithModel("rush", "anthropic/claude-haiku-4-5", { applyModel: true })],
      ]),
    );
    assertHandlers(runtimeHarness);
    assert.equal(typeof runtimeHarness.sessionTree, "function");
    runtimeHarness.pi.model = defaultModel;
    const context = createRuntimeContext(fixture, defaultModel, [
      defaultModel,
      sessionModel,
      rushModel,
    ]);
    Object.defineProperty(context, "model", {
      configurable: true,
      get: () => runtimeHarness.pi.model,
    });
    await startSession(runtimeHarness, context);

    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      defaultModel,
      { availableModels: [defaultModel, sessionModel, rushModel] },
    );
    await session.setModel(sessionModel, { persist: false });
    await manager.flush();

    await runtimeHarness.beforeAgentStart({ systemPrompt: "base" }, context);
    assert.deepEqual(
      runtimeHarness.pi.model,
      sessionModel,
      "Enter/session-only selection survives the next turn with model application enabled",
    );
    await runtimeHarness.sessionTree({}, context);
    assert.deepEqual(
      runtimeHarness.pi.model,
      sessionModel,
      "Enter/session-only selection survives session-tree reapplication",
    );

    await runtimeHarness.pi.commands.get("switch-primary-agent").handler("rush", context);
    assert.deepEqual(
      runtimeHarness.pi.model,
      rushModel,
      "an explicit primary-mode boundary clears session-only model intent and applies Rush",
    );

    const nextSession = createAgentSessionHarness(fixture, runtimeHarness, context, rushModel, {
      availableModels: [defaultModel, sessionModel, rushModel],
    });
    await nextSession.session.setModel(sessionModel, { persist: false });
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
    await startSession(runtimeHarness, context);
    assert.deepEqual(
      runtimeHarness.pi.model,
      defaultModel,
      "a new session clears the prior Enter selection and reapplies the packaged default",
    );
    assert.deepEqual(readSettings(fixture.agent).defaultModel, defaultModel.id);
    assert.equal(readSettings(fixture.agent).tlh.primaryAgent.modelOverrides?.architect, undefined);
    assert.equal(readSettings(fixture.agent).tlh.primaryAgent.modelOverrides?.rush, undefined);
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("rejected setModel does not invoke same-model persistence or write settings", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-rejected-", { cwd: true, test: t });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime();
    assertHandlers(runtimeHarness);
    const context = createRuntimeContext(fixture, previous, [previous, selected]);
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);
    const { manager, session, state } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      previous,
      { checkAuth: async () => false },
    );

    await assert.rejects(
      () => session.setModel(selected, { persist: true }),
      /No API key for anthropic\/claude-opus-5/,
    );
    await manager.flush();

    assert.deepEqual(state.model, previous);
    assert.equal(readSettings(fixture.agent).defaultModel, previous.id);
    assert.equal(readSettings(fixture.agent).tlh.primaryAgent.modelOverrides?.architect, undefined);
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("provider-auth/programmatic persist:true follows the durable compatibility policy", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-provider-auth-", {
    cwd: true,
    test: t,
  });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", {
            applyModel: false,
          }),
        ],
      ]),
    );
    assertHandlers(runtimeHarness);
    const context = createRuntimeContext(fixture, previous, [previous, selected]);
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);
    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      previous,
    );

    // Pi provides no origin bit for provider-auth/programmatic calls. A
    // successful public persist:true call is intentionally treated as durable.
    await session.setModel(selected, { persist: true });
    await manager.flush();

    assert.equal(readSettings(fixture.agent).defaultModel, selected.id);
    assert.equal(
      readSettings(fixture.agent).tlh.primaryAgent.modelOverrides.architect,
      "anthropic/claude-opus-5",
    );
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});

test("owner tokens isolate overlapping runtimes and stale shutdowns", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-overlapping-runtime-", {
    cwd: true,
    test: t,
  });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const first = registerRuntime();
    const firstContext = createRuntimeContext(fixture, previous, [previous, selected]);
    first.pi.model = previous;
    await startSession(first, firstContext);

    const second = registerRuntime();
    const secondContext = createRuntimeContext(fixture, previous, [previous, selected]);
    second.pi.model = previous;
    await startSession(second, secondContext);

    // The older runtime's lifecycle callback is stale and must not end the
    // newer owner-scoped context.
    await first.sessionShutdown({ type: "session_shutdown" }, firstContext);

    const { manager, session } = createAgentSessionHarness(
      fixture,
      second,
      secondContext,
      previous,
    );
    await session.setModel(selected, { persist: true });
    await manager.flush();

    assert.equal(
      readSettings(fixture.agent).tlh.primaryAgent.modelOverrides.architect,
      "anthropic/claude-opus-5",
    );
    await second.sessionShutdown({ type: "session_shutdown" }, secondContext);
  });
});

test("OpenRouter persisted selections keep distinct primary overrides across switches and new sessions", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-openrouter-primaries-", {
    cwd: true,
    test: t,
  });
  const profileDefault = model("anthropic", "claude-sonnet-4-6");
  const selectedModels = new Map([
    ["architect", model("openrouter", "anthropic/claude-sonnet-4-6")],
    ["rush", model("openrouter", "openai/gpt-5.4")],
    ["product", model("openrouter", "anthropic/claude-opus-5")],
    ["bug-hunter", model("openrouter", "openai/gpt-5.6")],
  ]);
  const availableModels = [profileDefault, ...selectedModels.values()];
  const primaryAgents = new Map(
    [...selectedModels.keys()].map((selection) => [
      selection,
      primaryWithModel(selection, "anthropic/claude-sonnet-4-6", { applyModel: true }),
    ]),
  );
  writeSettings(fixture.agent, {
    defaultProvider: profileDefault.provider,
    defaultModel: profileDefault.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(primaryAgents);
    assertHandlers(runtimeHarness);
    const branch = [];
    runtimeHarness.pi.appendEntry = (_type, data) => {
      branch.push({ type: "custom", customType: PRIMARY_AGENT_SESSION_STATE_ENTRY, data });
    };
    runtimeHarness.pi.model = profileDefault;
    const context = createRuntimeContext(fixture, profileDefault, availableModels);
    Object.defineProperty(context, "model", {
      configurable: true,
      get: () => runtimeHarness.pi.model,
    });
    context.sessionManager = { getBranch: () => branch };
    await startSession(runtimeHarness, context);

    const switchPrimary = runtimeHarness.pi.commands.get("switch-primary-agent");
    assert.ok(switchPrimary);
    for (const [selection, selectedModel] of selectedModels) {
      if (selection !== "architect") {
        await switchPrimary.handler(selection, context);
      }
      const { manager, session } = createAgentSessionHarness(
        fixture,
        runtimeHarness,
        context,
        runtimeHarness.pi.model,
        { availableModels },
      );
      await session.setModel(selectedModel, { persist: true });
      await manager.flush();
      assert.equal(
        readSettings(fixture.agent).tlh.primaryAgent.modelOverrides[selection],
        `${selectedModel.provider}/${selectedModel.id}`,
        `${selection} keeps its own OpenRouter persisted override`,
      );
    }

    const overrides = readSettings(fixture.agent).tlh.primaryAgent.modelOverrides;
    assert.deepEqual(
      overrides,
      Object.fromEntries(
        [...selectedModels].map(([selection, selectedModel]) => [
          selection,
          `${selectedModel.provider}/${selectedModel.id}`,
        ]),
      ),
    );
    assert.equal(readSettings(fixture.agent).defaultProvider, "openrouter");
    assert.equal(readSettings(fixture.agent).defaultModel, selectedModels.get("bug-hunter").id);

    for (const [selection, selectedModel] of [...selectedModels].reverse()) {
      await switchPrimary.handler(selection, context);
      assert.deepEqual(
        runtimeHarness.pi.model,
        selectedModel,
        `${selection} reapplies its persisted OpenRouter override on a primary switch`,
      );
    }

    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
    branch.length = 0;
    runtimeHarness.pi.model = selectedModels.get("bug-hunter");
    await startSession(runtimeHarness, context);
    assert.deepEqual(
      runtimeHarness.pi.model,
      selectedModels.get("architect"),
      "a new session reapplies the persistent default primary's OpenRouter override",
    );
  });
});

test("model cycling never creates or edits a primary override", async (t) => {
  for (const existingOverride of [undefined, "anthropic/claude-opus-5"]) {
    const fixture = createIsolatedProfileFixture("tlh-model-cycle-", { cwd: true, test: t });
    const defaultModel = model("anthropic", "claude-sonnet-4-6");
    const alternateModel = model("anthropic", "claude-opus-5");
    const availableModels = [defaultModel, alternateModel, model("anthropic", "claude-haiku-4-5")];
    writeSettings(fixture.agent, {
      defaultProvider: defaultModel.provider,
      defaultModel: defaultModel.id,
      tlh: {
        primaryAgent: {
          enabled: true,
          selected: "architect",
          ...(existingOverride ? { modelOverrides: { architect: existingOverride } } : {}),
        },
      },
    });

    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const runtimeHarness = registerRuntime(
        new Map([
          [
            "architect",
            primaryWithModel("architect", "anthropic/claude-sonnet-4-6", { applyModel: true }),
          ],
        ]),
      );
      assertHandlers(runtimeHarness);
      runtimeHarness.pi.model = defaultModel;
      const context = createRuntimeContext(fixture, defaultModel, availableModels);
      Object.defineProperty(context, "model", {
        configurable: true,
        get: () => runtimeHarness.pi.model,
      });
      await startSession(runtimeHarness, context);

      const initialModel = existingOverride ? alternateModel : defaultModel;
      assert.deepEqual(runtimeHarness.pi.model, initialModel);
      const { manager, session } = createAgentSessionHarness(
        fixture,
        runtimeHarness,
        context,
        initialModel,
        { availableModels },
      );
      await session.cycleModel("forward", { persist: true });
      await manager.flush();

      assert.equal(
        readSettings(fixture.agent).tlh.primaryAgent.modelOverrides?.architect,
        existingOverride,
        existingOverride
          ? "cycle must not edit an existing primary override"
          : "cycle must not create a primary override",
      );
      await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
    });
  }
});

test("session tokens are opaque and stale reads/updates cannot claim a newer context", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-owner-api-", { cwd: true, test: t });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    const receivedA = [];
    const receivedB = [];
    const sessionA = beginTlhModelSelectionPersistenceSession((value) => receivedA.push(value));
    const sessionB = beginTlhModelSelectionPersistenceSession((value) => receivedB.push(value));
    assert.ok(sessionA);
    assert.ok(sessionB);
    assert.notEqual(sessionA, sessionB);
    assert.equal(readTlhModelSelectionPersistence(sessionA), undefined);
    assert.equal(readTlhModelSelectionPersistence(sessionB), undefined);

    updateTlhModelSelectionPersistenceContext(sessionA, (value) => receivedA.push(value));
    endTlhModelSelectionPersistenceSession(sessionA);
    assert.equal(claimTlhModelSelectionDefaults(sessionA, selected, previous), undefined);
    assert.equal(claimTlhModelSelectionDefaults(sessionB, selected, previous), undefined);
    assert.deepEqual(receivedA, []);
    assert.deepEqual(receivedB, []);
    endTlhModelSelectionPersistenceSession(sessionB);
  });
});

test("failed runtime registration does not install the AgentSession wrapper", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-registration-failure-", {
    cwd: true,
    test: t,
  });
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession } from "@earendil-works/pi-coding-agent";
    import { registerTlhPrimaryAgentRuntime } from "./extensions/the-last-harness/primary-agent-runtime.js";

    const original = AgentSession.prototype.setModel;
    const pi = {
      on() {},
      registerCommand() {
        throw new Error("simulated command registration failure");
      },
    };
    assert.throws(
      () => registerTlhPrimaryAgentRuntime(pi, { env: process.env, subagentMetadata: [] }),
      /simulated command registration failure/,
    );
    assert.equal(AgentSession.prototype.setModel, original);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundled primary-runtime registration failure leaves both AgentSession prototypes untouched", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-bundle-runtime-rollback-", {
    cwd: true,
    test: t,
  });
  const bundlePath = join(getPackageDir(), "dist", "bundle", "index.js");
  const bundleEntrypoint = join(getPackageDir(), "dist", "bundle", "cli.js");
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";
    const bundledModule = await import(${JSON.stringify(bundlePath)});
    const BundledAgentSession = bundledModule.AgentSession;
    process.argv[1] = ${JSON.stringify(bundleEntrypoint)};
    const originalModular = ModularAgentSession.prototype.setModel;
    const originalBundled = BundledAgentSession.prototype.setModel;
    Object.defineProperty(BundledAgentSession.prototype, "setModel", {
      configurable: true,
      enumerable: true,
      value: originalBundled,
      writable: false,
    });
    const { registerTlhPrimaryAgentRuntime } = await import(
      "./extensions/the-last-harness/primary-agent-runtime.js"
    );
    const pi = {
      on() {},
      registerCommand() {},
      registerShortcut() {},
    };
    assert.throws(
      () => registerTlhPrimaryAgentRuntime(pi, { env: process.env, subagentMetadata: [] }),
      /Could not install the Pi AgentSession.setModel persistence seam/,
    );
    assert.equal(ModularAgentSession.prototype.setModel, originalModular);
    assert.equal(BundledAgentSession.prototype.setModel, originalBundled);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundled Node and modular AgentSession constructors share one exact public wrapper", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-bundle-identity-", {
    cwd: true,
    test: t,
  });
  const bundlePath = join(getPackageDir(), "dist", "bundle", "index.js");
  const bundleEntrypoint = join(getPackageDir(), "dist", "bundle", "cli.js");
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";

    const bundledModule = await import(${JSON.stringify(bundlePath)});
    const BundledAgentSession = bundledModule.AgentSession;
    assert.notEqual(
      ModularAgentSession,
      BundledAgentSession,
      "Pi 0.85.1 must expose distinct modular and bundled AgentSession constructors",
    );

    // The extension loader resolves this module through the normal package root,
    // while this synthetic argv selects the same bundled-Node path used by Pi.
    process.argv[1] = ${JSON.stringify(bundleEntrypoint)};
    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");

    const calls = [];
    const rejected = Promise.reject(new Error("bundled rejection"));
    const modularResult = Promise.resolve("modular-result");
    const bundledResult = Promise.resolve("bundled-result");
    ModularAgentSession.prototype.setModel = function (model, options) {
      calls.push({ owner: "modular", receiver: this, model, options, argumentCount: arguments.length });
      return model.id === "reject" ? rejected : modularResult;
    };
    BundledAgentSession.prototype.setModel = function (model, options) {
      calls.push({ owner: "bundled", receiver: this, model, options, argumentCount: arguments.length });
      return model.id === "reject" ? rejected : bundledResult;
    };

    assert.equal(scope.installTlhModelSelectionPersistenceOverride(), true);

    const previous = { provider: "anthropic", id: "previous" };
    const next = { provider: "anthropic", id: "next" };
    const sameCalls = [];
    const owner = scope.beginTlhModelSelectionPersistenceSession((model) => sameCalls.push(model));
    assert.ok(owner);

    const modularReceiver = Object.create(ModularAgentSession.prototype);
    Object.defineProperty(modularReceiver, "model", { configurable: true, value: previous });
    const modularOptions = { persist: true };
    const modularPromise = modularReceiver.setModel(next, modularOptions);
    assert.equal(modularPromise, modularResult, "modular wrapper must return the original Promise");
    assert.equal(await modularPromise, "modular-result");

    const bundledReceiver = Object.create(BundledAgentSession.prototype);
    Object.defineProperty(bundledReceiver, "model", { configurable: true, value: next });
    const bundledOptions = { persist: true };
    const bundledPromise = bundledReceiver.setModel(next, bundledOptions);
    assert.equal(bundledPromise, bundledResult, "bundle wrapper must return the original Promise");
    assert.equal(await bundledPromise, "bundled-result");
    assert.deepEqual(sameCalls, [next], "the bundled wrapper must feed the shared owner callback");

    assert.equal(calls[0].owner, "modular");
    assert.equal(calls[0].receiver, modularReceiver, "wrapper must preserve this");
    assert.equal(calls[0].options, modularOptions, "wrapper must preserve options identity");
    assert.equal(calls[0].argumentCount, 2, "wrapper must preserve argument count");
    assert.equal(calls[1].owner, "bundled");
    assert.equal(calls[1].receiver, bundledReceiver, "bundle wrapper must preserve this");
    assert.equal(calls[1].options, bundledOptions, "bundle wrapper must preserve options identity");
    assert.equal(calls[1].argumentCount, 2, "bundle wrapper must preserve argument count");

    const rejectedReceiver = Object.create(BundledAgentSession.prototype);
    Object.defineProperty(rejectedReceiver, "model", { configurable: true, value: previous });
    const rejectedPromise = rejectedReceiver.setModel({ provider: "anthropic", id: "reject" }, { persist: true });
    assert.equal(rejectedPromise, rejected, "rejection identity must be preserved");
    await assert.rejects(() => rejectedPromise, /bundled rejection/);
    assert.deepEqual(sameCalls, [next], "failed calls must not claim the owner callback");
    scope.endTlhModelSelectionPersistenceSession(owner);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("a virtual bundled AgentSession constructor is patched without path guessing", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-virtual-bundle-", { cwd: true, test: t });
  const bundlePath = join(getPackageDir(), "dist", "bundle", "index.js");
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";
    const bundledModule = await import(${JSON.stringify(bundlePath)});
    const BundledAgentSession = bundledModule.AgentSession;
    process.argv[1] = process.execPath;
    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");
    const marker = Symbol.for("tlh.modelSelectionPersistencePatch");
    assert.equal(
      scope.installTlhModelSelectionPersistenceOverride(BundledAgentSession),
      true,
    );
    assert.ok(ModularAgentSession.prototype[marker]);
    assert.equal(
      ModularAgentSession.prototype[marker],
      BundledAgentSession.prototype[marker],
    );
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("a separate private Pi runtime is resolved from its canonical bundle CLI", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-private-bundle-", { cwd: true, test: t });
  const privatePackageDir = copyPublishedPiPackage(t, "separate");
  const privateCliPath = join(privatePackageDir, "dist", "bundle", "cli.js");
  const privateBundlePath = join(privatePackageDir, "dist", "bundle", "index.js");
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";

    const privateModule = await import(${JSON.stringify(privateBundlePath)});
    const PrivateAgentSession = privateModule.AgentSession;
    assert.notEqual(ModularAgentSession, PrivateAgentSession);
    process.argv[1] = ${JSON.stringify(privateCliPath)};

    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");
    const marker = Symbol.for("tlh.modelSelectionPersistencePatch");
    assert.equal(scope.installTlhModelSelectionPersistenceOverride(), true);
    assert.ok(ModularAgentSession.prototype[marker]);
    assert.ok(PrivateAgentSession.prototype[marker]);
    assert.equal(
      ModularAgentSession.prototype[marker],
      PrivateAgentSession.prototype[marker],
      "both runtime constructors must share one owner token",
    );
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("installed bundle patch remains stable after bundle metadata becomes unavailable", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-private-bundle-stable-", {
    cwd: true,
    test: t,
  });
  const privatePackageDir = copyPublishedPiPackage(t, "stable");
  const privateCliPath = join(privatePackageDir, "dist", "bundle", "cli.js");
  const privatePackageJsonPath = join(privatePackageDir, "package.json");
  const privateBundlePath = join(privatePackageDir, "dist", "bundle", "index.js");
  const script = `
    import assert from "node:assert/strict";
    import { rmSync } from "node:fs";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";

    const privateModule = await import(${JSON.stringify(privateBundlePath)});
    const PrivateAgentSession = privateModule.AgentSession;
    assert.notEqual(ModularAgentSession, PrivateAgentSession);
    process.argv[1] = ${JSON.stringify(privateCliPath)};

    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");
    let owner;
    let observedInvocation;
    let observedClaim;
    const selected = { provider: "anthropic", id: "claude-opus-5" };
    PrivateAgentSession.prototype.setModel = function (model) {
      observedInvocation = scope.readTlhModelSelectionPersistence(owner);
      observedClaim = scope.claimTlhModelSelectionDefaults(owner, model, model);
      return Promise.resolve();
    };
    assert.equal(scope.installTlhModelSelectionPersistenceOverride(), true);

    // Keep the active CLI entrypoint in place, but make the validated package
    // layout unavailable. Post-registration calls must use their stable patch.
    rmSync(${JSON.stringify(privatePackageJsonPath)});
    const persisted = [];
    owner = scope.beginTlhModelSelectionPersistenceSession((model) => persisted.push(model));
    assert.ok(owner);

    const receiver = Object.create(PrivateAgentSession.prototype);
    Object.defineProperty(receiver, "model", { configurable: true, value: selected });
    await receiver.setModel(selected, { persist: true });
    assert.equal(observedInvocation?.model.id, selected.id);
    assert.deepEqual(observedClaim, { persisted: true });
    assert.deepEqual(persisted, [selected]);

    for (let index = 0; index < 3; index += 1) {
      scope.updateTlhModelSelectionPersistenceContext(owner);
      assert.equal(scope.readTlhModelSelectionPersistence(owner), undefined);
      scope.endTlhModelSelectionPersistenceSession(owner);
      owner = scope.beginTlhModelSelectionPersistenceSession(() => {});
      assert.ok(owner);
    }
    scope.endTlhModelSelectionPersistenceSession(owner);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("unsafe private bundle metadata, layout, and symlink escapes fail closed", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-private-bundle-unsafe-", {
    cwd: true,
    test: t,
  });
  const wrongMetadataDir = copyPublishedPiPackage(t, "wrong-metadata");
  const wrongMetadata = JSON.parse(readFileSync(join(wrongMetadataDir, "package.json"), "utf8"));
  wrongMetadata.name = "malicious-pi-runtime";
  wrongMetadata.version = "0.84.3";
  writeFileSync(join(wrongMetadataDir, "package.json"), `${JSON.stringify(wrongMetadata)}\\n`);
  const missingIndexDir = copyPublishedPiPackage(t, "missing-index");
  rmSync(join(missingIndexDir, "dist", "bundle", "index.js"));
  const symlinkDir = copyPublishedPiPackage(t, "symlink-index");
  const escapedTargetDir = mkdtempSync(join(tmpdir(), "tlh-pi-escaped-index-"));
  t.after(() => rmSync(escapedTargetDir, { recursive: true, force: true }));
  cpSync(join(symlinkDir, "dist", "bundle", "index.js"), join(escapedTargetDir, "index.js"));
  rmSync(join(symlinkDir, "dist", "bundle", "index.js"));
  symlinkSync(join(escapedTargetDir, "index.js"), join(symlinkDir, "dist", "bundle", "index.js"));

  const cases = [wrongMetadataDir, missingIndexDir, symlinkDir];
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession } from "@earendil-works/pi-coding-agent";
    import { join } from "node:path";
    const original = AgentSession.prototype.setModel;
    const marker = Symbol.for("tlh.modelSelectionPersistencePatch");
    for (const [index, packageDir] of ${JSON.stringify(cases)}.entries()) {
      const scope = await import(
        "./extensions/the-last-harness/model-selection-scope.js?unsafe-" + index,
      );
      process.argv[1] = join(packageDir, "dist", "bundle", "cli.js");
      assert.equal(scope.installTlhModelSelectionPersistenceOverride(), false);
      assert.equal(AgentSession.prototype.setModel, original);
      assert.equal(AgentSession.prototype[marker], undefined);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("unknown or non-bundle entrypoints do not load a second Pi runtime", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-unknown-entrypoint-", {
    cwd: true,
    test: t,
  });
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";
    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");
    process.argv[1] = process.execPath;
    const original = ModularAgentSession.prototype.setModel;
    const marker = Symbol.for("tlh.modelSelectionPersistencePatch");
    assert.equal(scope.installTlhModelSelectionPersistenceOverride(), true);
    assert.notEqual(ModularAgentSession.prototype.setModel, original);
    assert.ok(ModularAgentSession.prototype[marker]);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("bundle installation rolls back the modular wrapper on a partial failure", (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-bundle-rollback-", {
    cwd: true,
    test: t,
  });
  const bundlePath = join(getPackageDir(), "dist", "bundle", "index.js");
  const bundleEntrypoint = join(getPackageDir(), "dist", "bundle", "cli.js");
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession as ModularAgentSession } from "@earendil-works/pi-coding-agent";

    const bundledModule = await import(${JSON.stringify(bundlePath)});
    const BundledAgentSession = bundledModule.AgentSession;
    process.argv[1] = ${JSON.stringify(bundleEntrypoint)};
    const originalModular = ModularAgentSession.prototype.setModel;
    const originalBundled = BundledAgentSession.prototype.setModel;
    Object.defineProperty(BundledAgentSession.prototype, "setModel", {
      configurable: true,
      enumerable: true,
      value: originalBundled,
      writable: false,
    });

    const scope = await import("./extensions/the-last-harness/model-selection-scope.js");
    assert.equal(
      scope.installTlhModelSelectionPersistenceOverride(),
      false,
      "a failed second-prototype mutation must fail atomically",
    );
    assert.equal(ModularAgentSession.prototype.setModel, originalModular);
    assert.equal(scope.beginTlhModelSelectionPersistenceSession(() => {}), undefined);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PI_CODING_AGENT_DIR: fixture.agent,
      PI_SUBAGENT_CHILD: "0",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("unsafe non-TLH registration does not consume a later safe installation", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-unsafe-", { cwd: true, test: t });
  const script = `
    import assert from "node:assert/strict";
    import { AgentSession } from "@earendil-works/pi-coding-agent";
    import { installTlhModelSelectionPersistenceOverride } from "./extensions/the-last-harness/model-selection-scope.js";

    const marker = Symbol.for("tlh.modelSelectionPersistencePatch");
    const original = AgentSession.prototype.setModel;
    assert.equal(installTlhModelSelectionPersistenceOverride(), false);
    assert.equal(AgentSession.prototype.setModel, original);
    assert.equal(AgentSession.prototype[marker], undefined);

    process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(fixture.agent)};
    assert.equal(installTlhModelSelectionPersistenceOverride(), true);
    assert.notEqual(AgentSession.prototype.setModel, original);
    assert.ok(AgentSession.prototype[marker]);
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

test("first persisted override records its packaged baseline", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-model-baseline-", { cwd: true, test: t });
  const previous = model("anthropic", "claude-sonnet-4-6");
  const selected = model("anthropic", "claude-opus-5");
  writeSettings(fixture.agent, {
    defaultProvider: previous.provider,
    defaultModel: previous.id,
    tlh: { primaryAgent: { enabled: true, selected: "architect" } },
  });

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const runtimeHarness = registerRuntime(
      new Map([
        [
          "architect",
          primaryWithModel("architect", "anthropic/claude-sonnet-4-6", {
            applyModel: false,
          }),
        ],
      ]),
    );
    const context = createRuntimeContext(fixture, previous, [previous, selected]);
    runtimeHarness.pi.model = previous;
    await startSession(runtimeHarness, context);
    const { manager, session } = createAgentSessionHarness(
      fixture,
      runtimeHarness,
      context,
      previous,
    );

    await session.setModel(selected, { persist: true });
    await manager.flush();

    const statePath = join(fixture.agent, "tlh", "reconcile-state.json");
    assert.equal(existsSync(statePath), true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(
      state.acknowledgedSnapshot.architect.byProvider.anthropic.model,
      "anthropic/claude-sonnet-4-6",
    );
    await runtimeHarness.sessionShutdown({ type: "session_shutdown" }, context);
  });
});
