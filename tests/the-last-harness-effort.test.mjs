import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getPackageDir, initTheme } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { registerEffortCommand } = await jiti.import("../extensions/the-last-harness/effort.ts");

initTheme("dark", false);

// Pi 0.85.1 moved keybinding initialisation to interactive app startup; seed
// the global keybindings (pi-coding-agent's pi-tui instance) so that
// ThinkingSelectorComponent hints (e.g. app.thinking.save / Ctrl+S) render
// correctly in tests without a live TUI session.
// Use createRequire anchored at pi-coding-agent's package.json to resolve pi-tui
// from the same location pi-coding-agent uses — preserving the singleton intent
// even when pi-tui is hoisted into the repo's node_modules.
{
  const piPkg = getPackageDir();
  const piKeybindingsUrl = pathToFileURL(join(piPkg, "dist", "core", "keybindings.js")).href;
  const req = createRequire(join(piPkg, "package.json"));
  const piTuiPkgPath = req.resolve("@earendil-works/pi-tui/package.json");
  const piTuiKeybindingsUrl = pathToFileURL(
    join(dirname(piTuiPkgPath), "dist", "keybindings.js"),
  ).href;
  const { KeybindingsManager: PiKeybindingsManager } = await import(piKeybindingsUrl);
  const { setKeybindings: setPiKeybindings } = await import(piTuiKeybindingsUrl);
  setPiKeybindings(new PiKeybindingsManager());
}

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
 * @param {string}            opts.cwd      command working directory
 */
function createCtx({ provider, model, hasUI = false, cwd = process.cwd() } = {}) {
  const notifications = [];
  const resolvedModel =
    model !== undefined ? model : provider ? { provider, id: "test-model" } : undefined;
  return {
    notifications,
    ctx: {
      cwd,
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

function createInteractiveThinkingContext(model, cwd = process.cwd()) {
  const { notifications, ctx } = createCtx({ model, hasUI: true, cwd });
  ctx.mode = "tui";
  let picker;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  ctx.ui.custom = async (factory) => {
    picker = factory({}, {}, {}, (result) => resolveDone(result));
    return done;
  };
  return {
    notifications,
    ctx,
    get picker() {
      return picker;
    },
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

test("effort completions list every native thinking level", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi);
  const completions = pi.commands.get("effort").getArgumentCompletions("");
  assert.deepEqual(
    completions.map((completion) => completion.value),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("effort completions filter by prefix", () => {
  const pi = createPiHarness();
  registerEffortCommand(pi);
  const completions = pi.commands.get("effort").getArgumentCompletions("m");
  assert.deepEqual(
    completions.map((completion) => completion.value),
    ["minimal", "medium", "max"],
  );
});

test("effort handler accepts a native thinking level", async () => {
  const pi = createPiHarness();
  registerEffortCommand(pi);
  const { notifications, ctx } = createCtx({ model: reasoningModel() });
  await pi.commands.get("effort").handler("off", ctx);
  assert.equal(pi.thinkingLevel, "off");
  assert.deepEqual(notifications.at(-1), {
    message: "Thinking level set to off for this session.",
    type: "info",
  });
});

// ---------------------------------------------------------------------------
// Native public thinking picker and guarded persistence
// ---------------------------------------------------------------------------

test("effort opens the native picker whose Enter action is session-only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-native-picker-", {
    cwd: true,
    test: t,
  });
  const original = {
    defaultThinkingLevel: "low",
    unknownSetting: { preserved: true },
  };
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify(original));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker, "the public picker should be shown");
    assert.match(
      interactive.picker.render(120).join("\n"),
      /Enter to select · Ctrl\+S to set as default · Escape\/Ctrl\+C to cancel/,
    );
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput("\r");
    await commandPromise;

    assert.equal(pi.thinkingLevel, "high");
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.agent, "settings.json"))), original);
    assert.match(interactive.notifications.at(-1)?.message ?? "", /for this session/);
  });
});

test("native effort picker marks a valid isolated-profile default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-default-badge-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "high" }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    const highLine = interactive.picker
      .render(120)
      .find((line) => line.includes("  high") || line.includes("→ high"));
    assert.match(highLine ?? "", /default/);
    interactive.picker.handleInput("\u001b");
    await commandPromise;
  });
});

test("native effort picker ignores an invalid persisted default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-invalid-default-badge-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "turbo" }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    const highLine = interactive.picker
      .render(120)
      .find((line) => line.includes("  high") || line.includes("→ high"));
    assert.doesNotMatch(highLine ?? "", /default/);
    interactive.picker.handleInput("\u001b");
    await commandPromise;
  });
});

test("native effort picker does not badge or write a non-isolated profile default", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-normal-profile-badge-", {
    cwd: true,
    test: t,
  });
  const normalAgent = join(fixture.home, ".pi", "agent");
  mkdirSync(normalAgent, { recursive: true });
  const original = { defaultThinkingLevel: "high", unknown: true };
  writeFileSync(join(normalAgent, "settings.json"), JSON.stringify(original));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    const highLine = interactive.picker
      .render(120)
      .find((line) => line.includes("  high") || line.includes("→ high"));
    assert.doesNotMatch(highLine ?? "", /default/);
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput(String.fromCharCode(19));
    await commandPromise;

    assert.deepEqual(JSON.parse(readFileSync(join(normalAgent, "settings.json"))), original);
  });
});

test("native Ctrl+S persists a same-level selection with a guarded backup and unknown fields", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-native-save-", { cwd: true, test: t });
  const original = {
    defaultThinkingLevel: "low",
    unknownSetting: { preserved: true },
  };
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify(original));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "high";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput(String.fromCharCode(19));
    // A second save keypress must not duplicate the guarded persistence callback.
    interactive.picker.handleInput(String.fromCharCode(19));
    await commandPromise;

    const written = JSON.parse(readFileSync(join(fixture.agent, "settings.json")));
    assert.equal(pi.thinkingLevel, "high");
    assert.equal(written.defaultThinkingLevel, "high");
    assert.deepEqual(written.unknownSetting, original.unknownSetting);
    const backups = readdirSync(fixture.agent).filter((name) =>
      name.startsWith("settings.json.bak-"),
    );
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.agent, backups[0]))), original);
  });
});

test("Esc cancels the native effort picker without changing session or profile", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-native-cancel-", {
    cwd: true,
    test: t,
  });
  const original = { defaultThinkingLevel: "low" };
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify(original));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput("\u001b");
    await commandPromise;

    assert.equal(pi.thinkingLevel, "low");
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.agent, "settings.json"))), original);
    assert.deepEqual(interactive.notifications, []);
  });
});

test("effort typed levels are session-only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-typed-session-", {
    cwd: true,
    test: t,
  });
  writeFileSync(
    join(fixture.agent, "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const { ctx } = createCtx({ model: reasoningModel() });
    await pi.commands.get("effort").handler("high", ctx);

    assert.equal(pi.thinkingLevel, "high");
    assert.equal(readSettings(fixture.agent).defaultThinkingLevel, "low");
  });
});

test("native effort picker applies model capability filtering without a primary floor", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-filtered-picker-", {
    cwd: true,
    test: t,
  });
  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi, createFakeRuntime(architectPrimary()));
    const model = {
      provider: "anthropic",
      id: "limited",
      reasoning: true,
      thinkingLevelMap: { low: null, high: null, xhigh: "xhigh", max: null },
    };
    const interactive = createInteractiveThinkingContext(model, fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    const rendered = interactive.picker.render(120).join("\n");
    const hasLevel = (level) =>
      rendered
        .split("\n")
        .some((line) => line.includes(`  ${level}`) || line.includes(`→ ${level}`));
    for (const level of ["off", "minimal", "medium", "xhigh"]) {
      assert.equal(hasLevel(level), true, `${level} should be available`);
    }
    for (const level of ["low", "high", "max"]) {
      assert.equal(hasLevel(level), false, `${level} should be filtered`);
    }
    interactive.picker.handleInput("\u001b");
    await commandPromise;
  });
});

test("Ctrl+S persistence failure keeps the new level session-only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-save-failure-", {
    cwd: true,
    test: t,
  });
  mkdirSync(join(fixture.agent, "settings.json"));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput(String.fromCharCode(19));
    await commandPromise;

    assert.equal(pi.thinkingLevel, "high");
    assert.match(interactive.notifications.at(-1)?.message ?? "", /session only/);
    assert.equal(readdirSync(join(fixture.agent, "settings.json")).length, 0);
  });
});

test("Ctrl+S refuses the normal Pi profile without changing it", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-effort-normal-profile-", {
    cwd: true,
    test: t,
  });
  const normalAgent = join(fixture.home, ".pi", "agent");
  mkdirSync(normalAgent, { recursive: true });
  const original = { defaultThinkingLevel: "low", unknown: true };
  writeFileSync(join(normalAgent, "settings.json"), JSON.stringify(original));

  await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: undefined }, async () => {
    const pi = createPiHarness();
    pi.thinkingLevel = "low";
    registerEffortCommand(pi);
    const interactive = createInteractiveThinkingContext(reasoningModel(), fixture.cwd);
    const commandPromise = pi.commands.get("effort").handler("", interactive.ctx);
    assert.ok(interactive.picker);
    interactive.picker.getSelectList().setSelectedIndex(4);
    interactive.picker.handleInput(String.fromCharCode(19));
    await commandPromise;

    assert.equal(pi.thinkingLevel, "high");
    assert.match(interactive.notifications.at(-1)?.message ?? "", /session only/);
    assert.deepEqual(JSON.parse(readFileSync(join(normalAgent, "settings.json"))), original);
  });
});
