/**
 * Application and precedence coverage for the primary-agent project-defaults
 * runtime.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  architectWithDefaults,
  cleanupTempDir,
  createIsolatedProfileFixture,
  makeDefaultsLoader,
  makeSessionCtx,
  PRIMARY_AGENT_SESSION_STATE_ENTRY,
  readSettings,
  registerRuntimeHarness,
  setModelThroughPublicApi,
  SettingsManager,
  shutdownRuntime,
  withEnv,
  writePrimaryConfig,
  writeSettings,
} from "./the-last-harness-primary-agent-runtime-project-defaults-support.mjs";

test("project-defaults: project model beats bundled frontmatter model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "project default model overrides bundled frontmatter preferred model",
      );
      // effort not specified in project defaults — bundled for anthropic (resolved from project model's provider)
      assert.equal(pi.thinkingLevel, "low", "bundled effort for anthropic applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: project effort beats bundled frontmatter effort", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { effort: "xhigh" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Model from bundled (no project model); effort from project
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "bundled preferred model applies when project has no model",
      );
      assert.equal(
        pi.thinkingLevel,
        "xhigh",
        "project effort overrides bundled frontmatter effort",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: effective project model and effort change runtime state only", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-persistence-", { cwd: true, test: t });
  const initialModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const projectModel = { provider: "anthropic", id: "claude-opus-4-8" };
  const initialSettings = {
    defaultProvider: initialModel.provider,
    defaultModel: initialModel.id,
    defaultThinkingLevel: "low",
    tlh: {
      primaryAgent: {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      },
    },
  };
  writeSettings(fixture.agent, initialSettings);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });
      const manager = SettingsManager.create(fixture.cwd, fixture.agent);
      registration.pi.model = initialModel;
      registration.pi.thinkingLevel = "low";
      const ctx = makeSessionCtx(fixture, {
        model: initialModel,
        modelRegistry: {
          getAvailable: () => [
            initialModel,
            { provider: "anthropic", id: "claude-sonnet-4-6" },
            projectModel,
            { provider: "openai-codex", id: "gpt-5.6-luna" },
          ],
        },
      });
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get: () => registration.pi.model,
      });
      const initialBytes = readFileSync(join(fixture.agent, "settings.json"), "utf8");
      await registration.runtime.applySessionStart(ctx);
      await manager.flush();

      assert.deepEqual(registration.pi.model, projectModel);
      assert.equal(registration.pi.thinkingLevel, "high");
      assert.equal(
        readFileSync(join(fixture.agent, "settings.json"), "utf8"),
        initialBytes,
        "project model and effort must not rewrite the existing settings bytes",
      );
      assert.deepEqual(readSettings(fixture.agent), initialSettings);
      await shutdownRuntime(registration, ctx);
      await manager.flush();
      assert.equal(
        readFileSync(join(fixture.agent, "settings.json"), "utf8"),
        initialBytes,
        "shutdown must not persist or restore project defaults",
      );
      assert.deepEqual(
        readSettings(fixture.agent),
        initialSettings,
        "shutdown must leave every persisted value unchanged",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

for (const scenario of [
  {
    label: "bundled",
    projectEntry: { effort: "high" },
    storedOverride: undefined,
    expectedModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
  },
  {
    label: "stored primary after unavailable project model",
    projectEntry: { model: "anthropic/claude-does-not-exist" },
    storedOverride: "openai-codex/gpt-5.6-luna",
    expectedModel: { provider: "openai-codex", id: "gpt-5.6-luna" },
  },
]) {
  test(`project-defaults: ${scenario.label} primary application stays runtime-only`, async (t) => {
    const fixture = createIsolatedProfileFixture("tlh-pd-persistence-", { cwd: true, test: t });
    const initialModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const initialSettings = {
      defaultProvider: initialModel.provider,
      defaultModel: initialModel.id,
      defaultThinkingLevel: "xhigh",
      ...(scenario.storedOverride
        ? { tlh: { primaryAgent: { modelOverrides: { architect: scenario.storedOverride } } } }
        : {}),
    };
    writeSettings(fixture.agent, initialSettings);

    try {
      await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
        const registration = registerRuntimeHarness({
          primaryAgents: new Map([["architect", architectWithDefaults()]]),
          subagentMetadata: [],
          projectDefaultsLoader: makeDefaultsLoader({ architect: scenario.projectEntry }),
        });
        registration.pi.model = initialModel;
        registration.pi.thinkingLevel = "xhigh";
        const ctx = makeSessionCtx(fixture, {
          model: initialModel,
          modelRegistry: {
            getAvailable: () => [
              initialModel,
              { provider: "anthropic", id: "claude-sonnet-4-6" },
              { provider: "openai-codex", id: "gpt-5.6-luna" },
            ],
          },
        });
        Object.defineProperty(ctx, "model", {
          configurable: true,
          get: () => registration.pi.model,
        });
        const initialBytes = readFileSync(join(fixture.agent, "settings.json"), "utf8");
        await registration.runtime.applySessionStart(ctx);

        assert.deepEqual(registration.pi.model, scenario.expectedModel);
        const written = readSettings(fixture.agent);
        assert.equal(
          readFileSync(join(fixture.agent, "settings.json"), "utf8"),
          initialBytes,
          "internal primary application must not persist the model default",
        );
        assert.deepEqual(written, initialSettings);
        assert.equal(
          written.defaultThinkingLevel,
          "xhigh",
          "TLH thinking application remains runtime-only",
        );
        assert.equal(
          written.tlh?.primaryAgent?.modelOverrides?.architect,
          scenario.storedOverride,
          "internal application must not create or edit a primary override",
        );
        await shutdownRuntime(registration, ctx);
      });
    } finally {
      cleanupTempDir(fixture);
    }
  });
}

test("project-defaults: persisted user choice stays persisted when the next boundary applies project defaults", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-persisted-model-", { cwd: true, test: t });
  const initialModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const selectedModel = { provider: "anthropic", id: "claude-opus-5" };
  const projectModel = { provider: "anthropic", id: "claude-opus-4-8" };
  const initialSettings = {
    defaultProvider: initialModel.provider,
    defaultModel: initialModel.id,
    defaultThinkingLevel: "low",
    tlh: {
      primaryAgent: {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      },
    },
  };
  writeSettings(fixture.agent, initialSettings);

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });
      const manager = SettingsManager.create(fixture.cwd, fixture.agent);
      registration.pi.model = initialModel;
      registration.pi.thinkingLevel = "low";
      const ctx = makeSessionCtx(fixture, {
        model: initialModel,
        modelRegistry: {
          getAvailable: () => [
            initialModel,
            { provider: "anthropic", id: "claude-sonnet-4-6" },
            selectedModel,
            projectModel,
            { provider: "openai-codex", id: "gpt-5.6-luna" },
          ],
        },
      });
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get: () => registration.pi.model,
      });
      const initialBytes = readFileSync(join(fixture.agent, "settings.json"), "utf8");
      await registration.runtime.applySessionStart(ctx);
      assert.deepEqual(registration.pi.model, projectModel);
      assert.equal(registration.pi.thinkingLevel, "high");
      assert.equal(
        readFileSync(join(fixture.agent, "settings.json"), "utf8"),
        initialBytes,
        "the initial project-only application must leave persisted user values untouched",
      );

      // Pi 0.84.4's native Ctrl+S path is represented by persist:true on the
      // public AgentSession.setModel boundary. It writes the global model and
      // lets TLH correlate the same call to the per-primary override handler.
      await setModelThroughPublicApi(registration.pi, ctx, manager, selectedModel, true);

      let written = readSettings(fixture.agent);
      assert.equal(written.defaultProvider, selectedModel.provider);
      assert.equal(written.defaultModel, selectedModel.id);
      assert.equal(
        written.defaultThinkingLevel,
        "low",
        "model persistence does not implicitly rewrite the thinking default",
      );
      assert.equal(
        written.tlh?.primaryAgent?.modelOverrides?.architect,
        "anthropic/claude-opus-5",
        "persisted public model selection records the user's primary role choice",
      );
      const expectedUserSettings = written;

      await registration.beforeAgentStart({ systemPrompt: "base" }, ctx);
      assert.deepEqual(
        registration.pi.model,
        projectModel,
        "the next boundary may activate the higher-precedence project model",
      );
      assert.equal(registration.pi.thinkingLevel, "high");

      written = readSettings(fixture.agent);
      assert.deepEqual(
        written,
        expectedUserSettings,
        "project reapplication must preserve the user's persisted model choice",
      );

      await shutdownRuntime(registration, ctx);
      assert.deepEqual(
        readSettings(fixture.agent),
        expectedUserSettings,
        "shutdown must preserve the user's persisted model choice",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests: Layer 2 vs Layer 3 (project defaults beat stored override)
// ---------------------------------------------------------------------------

test("project-defaults: project model beats persisted user override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      // Stored override: openai-codex/gpt-5.6-luna
      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          // Project default: anthropic/claude-opus-4-8 — should win over stored override
          architect: { model: "anthropic/claude-opus-4-8" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "project default model beats persisted user override",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: stored override applies when project has no model entry", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        // Project defaults present for architect but only has effort, not model
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { effort: "high" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Stored override wins for model (no project model); project effort wins for effort
      assert.deepEqual(
        pi.model,
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        "stored model override applies when project has no model",
      );
      assert.equal(pi.thinkingLevel, "high", "project effort applies independently");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests: Per-field mixing (model from one layer, effort from another)
// ---------------------------------------------------------------------------

test("project-defaults: model from project (layer 2), effort from bundled (layer 4)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          // Model only — effort should fall through to bundled (low for anthropic)
          architect: { model: "anthropic/claude-opus-4-8" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(pi.thinkingLevel, "low", "bundled effort (low for anthropic) applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: effort from project (layer 2), model from stored override (layer 3)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        // Project defaults: effort only (model should fall through to stored override)
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { effort: "max" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Model: stored override (layer 3); Effort: project default (layer 2)
      assert.deepEqual(
        pi.model,
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        "stored model override applies when project has no model",
      );
      assert.equal(pi.thinkingLevel, "max", "project effort applies independently");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: model from stored (layer 3), effort from bundled (layer 4) when project absent", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      // No project defaults for architect
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({}),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "openai-codex", id: "gpt-5.6-luna" });
      // bundled effort for openai-codex: "medium"
      assert.equal(pi.thinkingLevel, "medium", "bundled effort for openai-codex applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tests: project defaults apply without fixed-primary exceptions
// ---------------------------------------------------------------------------

test("project-defaults: project model and effort apply to an editable primary", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const primaryAgents = new Map([["architect", architectWithDefaults()]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(pi.thinkingLevel, "xhigh");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: project defaults reapply at before_agent_start boundary", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(pi.thinkingLevel, "xhigh");

      // Simulate model drifting away (e.g. user changed model outside TLH)
      pi.model = { provider: "anthropic", id: "claude-sonnet-4-6" };
      pi.thinkingLevel = "low";

      // At next boundary, project defaults reapply
      const nextCtx = { ...ctx, model: pi.model };
      await beforeAgentStart({ systemPrompt: "base" }, nextCtx);

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "project default model reapplied at before_agent_start",
      );
      assert.equal(pi.thinkingLevel, "xhigh", "project effort reapplied at before_agent_start");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: project defaults apply at before_agent_start for switched primary", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const primaryAgents = new Map([
        ["architect", architectWithDefaults("architect")],
        ["rush", architectWithDefaults("rush")],
      ]);

      // Use a single runtime — project defaults are loaded at session start and
      // cached; before_agent_start re-reads the branch to sync the primary selection.
      const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
          rush: { model: "anthropic/claude-sonnet-4-6", effort: "medium" },
        }),
      });

      // Start as architect
      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(pi.thinkingLevel, "high");

      // Simulate switching to rush by passing rush in the branch at the next boundary.
      // before_agent_start calls syncPrimaryAgentState which reads the branch.
      const rushCtx = {
        ...ctx,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: "rush" },
            },
          ],
          getSessionId: () => "test-session-123",
        },
        // Model is still the architect default; rush switch will change it
        model: { provider: "anthropic", id: "claude-opus-4-8" },
      };

      await beforeAgentStart({ systemPrompt: "base" }, rushCtx);

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "rush project default model applies when rush is in the branch",
      );
      assert.equal(pi.thinkingLevel, "medium", "rush project effort applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests: Disabled-mode no-op
// ---------------------------------------------------------------------------

test("project-defaults: disabled primary mode — project defaults not applied", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
        }),
      });

      // Disabled mode via session state
      const ctx = makeSessionCtx(fixture);
      const disabledCtx = {
        ...ctx,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: PRIMARY_AGENT_SESSION_STATE_ENTRY,
              data: { selected: "disabled" },
            },
          ],
          getSessionId: () => "test-session-123",
        },
      };

      await runtime.applySessionStart(disabledCtx);

      // Disabled mode: no model applied (undefined)
      assert.equal(pi.model, undefined, "disabled mode: no model applied from project defaults");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: full 4-layer precedence — project (2) beats stored (3) beats bundled (4)", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults(); // bundled: anthropic/claude-sonnet-4-6, effort: low
      const primaryAgents = new Map([["architect", arch]]);

      // Layer 3: stored override = openai-codex/gpt-5.6-luna
      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      // Layer 2: project default = anthropic/claude-opus-4-8, effort: high
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Layer 2 (project) beats layer 3 (stored) beats layer 4 (bundled)
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "project default model (layer 2) beats stored override (layer 3) and bundled (layer 4)",
      );
      assert.equal(
        pi.thinkingLevel,
        "high",
        "project default effort (layer 2) beats bundled effort (layer 4)",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: stored override (layer 3) beats bundled (layer 4) when no project entry", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults(); // bundled: anthropic/claude-sonnet-4-6, effort: low
      const primaryAgents = new Map([["architect", arch]]);

      // Layer 3 only (no project entry)
      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({}), // no architect entry
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(
        pi.model,
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        "stored override (layer 3) beats bundled (layer 4) when no project entry",
      );
      // Effort: bundled for openai-codex = medium (no project effort, no durable thinking)
      assert.equal(pi.thinkingLevel, "medium", "bundled effort for openai-codex applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: bundled (layer 4) applies when no project, stored, or session overrides", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({}), // no entries
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // No overrides at any layer → bundled frontmatter preferred model applies
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "bundled preferred model (layer 4) applies when all higher layers absent",
      );
      assert.equal(pi.thinkingLevel, "low", "bundled effort (layer 4) applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests: Per-field independence — session-only model vs project effort
// ---------------------------------------------------------------------------

test("project-defaults: session thinking override (layer 1) wins over project effort (layer 2)", async (t) => {
  // Regression guard: a user /effort command must always beat the project effort default.
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const { runtime, pi, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        // Layer 2: project effort = xhigh (bundled anthropic effort = low)
        projectDefaultsLoader: makeDefaultsLoader({ architect: { effort: "xhigh" } }),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Project effort (layer 2) is applied at session start
      assert.equal(pi.thinkingLevel, "xhigh", "project effort (layer 2) applied at session start");

      // User explicitly selects a lower effort (layer 1 session override)
      runtime.recordUserThinkingLevel?.("low");

      // At the next boundary the session thinking override must win over the project effort
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      assert.equal(
        pi.thinkingLevel,
        "low",
        "session thinking override (layer 1) wins over project effort (layer 2)",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: project effort applies when session-only model is pinned (per-field independence)", async (t) => {
  // Regression guard: a session-only MODEL choice must not suppress the project EFFORT default.
  // Model and effort must resolve independently per field.
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  const sessionModel = { provider: "openai-codex", id: "gpt-5.6-luna" };

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      // architectWithDefaults has openai-codex bundled effort = "medium";
      // project effort = "xhigh" must survive even when the openai-codex model is session-only.
      const primaryAgents = new Map([["architect", arch]]);

      const { pi, runtime, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
        }),
      });

      // Build a context with a live ctx.model getter (tracks pi.model) so that
      // preservesSessionOnlyModel is computed correctly at each boundary.
      const ctx = makeSessionCtx(fixture, { mode: "tui", hasUI: true });
      // Replace static model property with a live getter so ctx.model === pi.model at all times.
      Object.defineProperty(ctx, "model", { get: () => pi.model, configurable: true });

      // --- Session start: project defaults take effect ---
      await runtime.applySessionStart(ctx);
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "project default model applied at session start",
      );
      assert.equal(pi.thinkingLevel, "xhigh", "project effort applied at session start");

      // --- User picks openai-codex/gpt-5.6-luna as a session-only choice ---
      const manager = SettingsManager.create(fixture.cwd, fixture.agent);
      await setModelThroughPublicApi(pi, ctx, manager, sessionModel, false);
      assert.deepEqual(pi.model, sessionModel, "session-only model applied after user pick");

      // --- At the next boundary ---
      // Model: session-only preserved (NOT overridden by project default claude-opus-4-8).
      // Effort: project effort xhigh still applies independently of the model field.
      // openai-codex bundled effort is "medium", so without the fix thinkingLevel would
      // regress to "medium"; with the fix it stays at "xhigh".
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      assert.deepEqual(
        pi.model,
        sessionModel,
        "session-only model preserved (project model not applied)",
      );
      assert.equal(
        pi.thinkingLevel,
        "xhigh",
        "project effort (layer 2) still applies when session-only model is pinned",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});
