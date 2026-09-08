/**
 * Warning and input-boundary coverage for the primary-agent project-defaults
 * runtime.
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  architectWithDefaults,
  cleanupTempDir,
  createIsolatedProfileFixture,
  loadProjectDefaults,
  makeDefaultsLoader,
  makeDeniedLoader,
  makeSessionCtx,
  MAX_PROJECT_DEFAULT_WARNING_COUNT,
  MAX_PROJECT_DEFAULT_WARNING_LENGTH,
  MAX_PROJECT_DEFAULT_WARNINGS,
  registerRuntimeHarness,
  shutdownRuntime,
  withEnv,
  writePrimaryConfig,
} from "./the-last-harness-primary-agent-runtime-project-defaults-support.mjs";

test("project-defaults: unavailable project model emits warning and falls back to layer 3", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      // Stored override: available model
      writePrimaryConfig(fixture.agent, {
        modelOverrides: { architect: "openai-codex/gpt-5.6-luna" },
      });

      const notifications = [];
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          // This model is NOT in the available models registry
          architect: { model: "anthropic/claude-opus-99-nonexistent" },
        }),
      });

      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(ctx);

      // Project model unavailable → warn and fall back to layer 3 (stored override)
      assert.deepEqual(
        pi.model,
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        "falls back to stored override when project model is unavailable",
      );

      const unavailableWarning = notifications.find(
        (n) => n.type === "warning" && n.message.includes("claude-opus-99-nonexistent"),
      );
      assert.ok(unavailableWarning, "emits a warning when project default model is not available");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: unavailable project model falls back to layer 4 when no stored override", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const notifications = [];
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-nonexistent" },
        }),
      });

      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(ctx);

      // Falls back to bundled preferred model (layer 4)
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "falls back to bundled default when project model is unavailable and no stored override",
      );

      const unavailableWarning = notifications.find(
        (n) => n.type === "warning" && n.message.includes("claude-nonexistent"),
      );
      assert.ok(unavailableWarning, "emits a warning");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: unavailable project model warning fires only once per session", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const notifications = [];
      const { runtime, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-nonexistent" },
        }),
      });

      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await runtime.applySessionStart(ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);

      const warnings = notifications.filter(
        (n) => n.type === "warning" && n.message.includes("claude-nonexistent"),
      );
      assert.equal(warnings.length, 1, "unavailable-model warning fires only once per session");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: unavailable model warnings are distinct for later model references", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-key-", { cwd: true, test: t });
  let defaultsCall = 0;

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: {
              architect: {
                model:
                  defaultsCall++ === 0
                    ? "anthropic/claude-unavailable-first"
                    : "anthropic/claude-unavailable-second",
              },
            },
            subagents: {},
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await runtime.applySessionStart(ctx);
      await runtime.applySessionStart(ctx);

      const warnings = notifications.filter(
        (entry) => entry.type === "warning" && entry.message.includes("project default model"),
      );
      assert.equal(warnings.length, 2, "each unavailable project model should warn once");
      assert.ok(
        warnings.some((entry) => entry.message.includes("claude-unavailable-first")),
        "first unavailable model warning should be retained",
      );
      assert.ok(
        warnings.some((entry) => entry.message.includes("claude-unavailable-second")),
        "later unavailable model warning should not be suppressed",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: long unavailable model warnings stay bounded and distinguish full references", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-long-", { cwd: true, test: t });
  const modelPrefix = `anthropic/${"x".repeat(60_000)}`;
  const modelReferences = [modelPrefix, `${modelPrefix}y`];
  let defaultsCall = 0;

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: {
              architect: {
                // The simple provider/model grammar accepts this long reference;
                // the file-backed loader still enforces its independent 64 KiB bound.
                model: modelReferences[Math.min(defaultsCall++, modelReferences.length - 1)],
              },
            },
            subagents: {},
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await runtime.applySessionStart(ctx);
      await runtime.applySessionStart(ctx);

      const warnings = notifications.filter(
        (entry) => entry.type === "warning" && entry.message.includes("project default model"),
      );
      assert.equal(
        warnings.length,
        2,
        "references with the same bounded prefix must still have distinct warning identities",
      );
      assert.ok(
        warnings.every((entry) => entry.message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH),
        "long model references must not expand the notification",
      );
      assert.ok(
        warnings.every((entry) => entry.message.endsWith("defaults.")),
        "bounded warnings retain their fallback explanation",
      );
      assert.ok(
        warnings.every((entry) => !entry.message.includes("x".repeat(1024))),
        "the raw long model reference must not be emitted",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: overlong subagent model warnings stay bounded", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-subagent-long-", {
    cwd: true,
    test: t,
  });
  const longModel = `anthropic/${"z".repeat(60_000)}`;
  const developer = {
    name: "developer",
    description: "Test developer",
    tools: ["read"],
    systemPrompt: "test",
    filePath: "agents/subagents/developer.md",
    tlhModelDefaults: [
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
        effort: "low",
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
  };

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [developer],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: {},
            subagents: { developer: { model: longModel } },
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      const input = { agent: "developer", task: "Check warning bounds" };
      await registration.toolCall({ toolName: "subagent", input }, ctx);

      const warnings = notifications.filter(
        (entry) => entry.type === "warning" && entry.message.includes("project default model"),
      );
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH);
      assert.ok(!warnings[0].message.includes("z".repeat(1024)));
      assert.equal(input.model, "anthropic/claude-sonnet-4-6:low");
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// Only one project-defaults root is active in a session. The root remains in the
// warning key as defense-in-depth, while this test proves re-notification at a
// new session boundary after the active root changes.
test("project-defaults: the same unavailable model re-notifies per session after the root changes", async (t) => {
  const fixtureA = createIsolatedProfileFixture("tlh-pd-warning-root-a-", { cwd: true, test: t });
  const fixtureB = createIsolatedProfileFixture("tlh-pd-warning-root-b-", { cwd: true, test: t });
  const unavailableModel = "anthropic/claude-same-unavailable";

  try {
    await withEnv({ HOME: fixtureA.home, PI_CODING_AGENT_DIR: fixtureA.agent }, async () => {
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: { architect: { model: unavailableModel } },
            subagents: {},
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      const contextA = makeSessionCtx(fixtureA, { hasUI: true });
      const contextB = makeSessionCtx(fixtureB, { hasUI: true });
      const notify = (message, type) => notifications.push({ message, type });
      contextA.ui.notify = notify;
      contextB.ui.notify = notify;

      await registration.runtime.applySessionStart(contextA);
      await registration.runtime.applySessionStart(contextB);

      const warnings = notifications.filter(
        (entry) => entry.type === "warning" && entry.message.includes("project default model"),
      );
      assert.equal(
        warnings.length,
        2,
        "the same unavailable model must re-notify once in each session after the root changes",
      );
      assert.equal(new Set(warnings.map((entry) => entry.message)).size, 1);
      await shutdownRuntime(registration, contextB);
    });
  } finally {
    cleanupTempDir(fixtureA);
    cleanupTempDir(fixtureB);
  }
});

test("project-defaults: applied-defaults notice emitted when project default takes effect", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });

      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(ctx);

      const appliedNotice = notifications.find(
        (n) => n.type === "info" && n.message.includes("project defaults for architect"),
      );
      assert.ok(appliedNotice, "applied-defaults notice emitted when project defaults take effect");
      assert.ok(
        appliedNotice.message.includes("model anthropic/claude-opus-4-8"),
        "notice includes applied model",
      );
      assert.ok(appliedNotice.message.includes("effort high"), "notice includes applied effort");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: applied-defaults notice not emitted for denied loader", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDeniedLoader(),
      });

      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(ctx);

      const appliedNotice = notifications.find(
        (n) => n.type === "info" && n.message.includes("project defaults"),
      );
      assert.equal(appliedNotice, undefined, "no applied-defaults notice for denied loader");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: applied-defaults notice not emitted when project has no entry for primary", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);

      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        // Loaded, but no entry for architect
        projectDefaultsLoader: makeDefaultsLoader({ rush: { effort: "high" } }),
      });

      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(ctx);

      const appliedNotice = notifications.find(
        (n) => n.type === "info" && n.message.includes("project defaults for architect"),
      );
      assert.equal(
        appliedNotice,
        undefined,
        "no notice when architect has no project defaults entry",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: applyModel false does not announce the project model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writePrimaryConfig(fixture.agent, { applyModel: false });
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);

      const appliedNotices = notifications.filter(
        (entry) =>
          entry.type === "info" && entry.message.includes("project defaults for architect"),
      );
      assert.equal(appliedNotices.length, 1);
      assert.match(appliedNotices[0].message, /effort high/);
      assert.doesNotMatch(appliedNotices[0].message, /model anthropic\/claude-opus-4-8/);
      assert.deepEqual(registration.pi.model, undefined, "applyModel false leaves the model alone");
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: applyThinking false does not announce the project effort", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      writePrimaryConfig(fixture.agent, { applyThinking: false });
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
        }),
      });
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);

      const appliedNotices = notifications.filter(
        (entry) =>
          entry.type === "info" && entry.message.includes("project defaults for architect"),
      );
      assert.equal(appliedNotices.length, 1);
      assert.match(appliedNotices[0].message, /model anthropic\/claude-opus-4-8/);
      assert.doesNotMatch(appliedNotices[0].message, /effort high/);
      assert.equal(
        registration.pi.thinkingLevel,
        "normal",
        "applyThinking false leaves effort alone",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: session thinking precedence suppresses the project effort notice", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      // Keep the first application from consuming the once-per-session notice;
      // the second boundary then exercises the layer-1 session-thinking guard.
      writePrimaryConfig(fixture.agent, { applyThinking: false });
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({ architect: { effort: "xhigh" } }),
      });
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      writePrimaryConfig(fixture.agent, { applyThinking: true });
      registration.runtime.recordUserThinkingLevel("low");
      await registration.beforeAgentStart({ systemPrompt: "base" }, ctx);

      assert.equal(registration.pi.thinkingLevel, "low");
      assert.equal(
        notifications.some(
          (entry) =>
            entry.type === "info" && entry.message.includes("project defaults for architect"),
        ),
        false,
        "a session thinking override must suppress the project effort notice",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: failed project model application does not announce the project model", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8" },
        }),
      });
      registration.pi.setModel = async () => false;
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);

      assert.equal(
        notifications.some(
          (entry) =>
            entry.type === "info" && entry.message.includes("model anthropic/claude-opus-4-8"),
        ),
        false,
        "a failed setModel must not claim that the project model applied",
      );
      assert.ok(
        notifications.some(
          (entry) =>
            entry.type === "warning" &&
            entry.message.includes("could not switch to primary agent model"),
        ),
        "failed model application still warns",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: successful model and clamped effort are announced once per session", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const initialModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
      const projectModel = {
        provider: "anthropic",
        id: "claude-opus-4-8",
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: null },
      };
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectDefaultsLoader: makeDefaultsLoader({
          architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
        }),
      });
      registration.pi.model = initialModel;
      const ctx = makeSessionCtx(fixture, {
        model: initialModel,
        modelRegistry: {
          getAvailable: () => [
            initialModel,
            { provider: "anthropic", id: "claude-sonnet-4-6" },
            projectModel,
          ],
        },
      });
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get: () => registration.pi.model,
      });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      await registration.beforeAgentStart({ systemPrompt: "base" }, ctx);

      const appliedNotices = notifications.filter(
        (entry) =>
          entry.type === "info" && entry.message.includes("project defaults for architect"),
      );
      assert.equal(appliedNotices.length, 1, "notice is emitted once per primary/session");
      assert.match(appliedNotices[0].message, /model anthropic\/claude-opus-4-8/);
      assert.match(appliedNotices[0].message, /effort high/);
      assert.doesNotMatch(appliedNotices[0].message, /effort xhigh/);
      assert.equal(registration.pi.thinkingLevel, "high", "effort is reported after clamping");

      await shutdownRuntime(registration, ctx);
      await registration.runtime.applySessionStart(ctx);
      assert.equal(
        notifications.filter(
          (entry) =>
            entry.type === "info" && entry.message.includes("project defaults for architect"),
        ).length,
        2,
        "the next session may announce the effective project defaults again",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: loaded-result warnings are once per session and reappear later", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const warnings = [
        "Ignoring unknown role in .tlh/defaults.json.",
        "Ignoring unknown key in .tlh/defaults.json.",
        ".tlh/defaults.json is not valid JSON.",
        "Ignoring invalid effort in .tlh/defaults.json.",
      ];
      const injectedResult = /** @type {unknown} */ ({
        status: "loaded",
        defaults: { primaryAgents: {}, subagents: {} },
        warnings: [...warnings, warnings[0]],
      });
      const notifications = [];
      const { runtime, pi, beforeAgentStart } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => injectedResult,
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await runtime.applySessionStart(ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);
      await beforeAgentStart({ systemPrompt: "base" }, ctx);

      for (const warning of warnings) {
        assert.equal(
          notifications.filter((entry) => entry.type === "warning" && entry.message === warning)
            .length,
          1,
          `loaded warning should be shown once per session: ${warning}`,
        );
      }

      await shutdownRuntime({ pi }, ctx);
      const laterCtx = makeSessionCtx(fixture, {
        hasUI: true,
        sessionManager: {
          getBranch: () => [],
          getSessionId: () => "later-test-session",
        },
      });
      laterCtx.ui.notify = (message, type) => notifications.push({ message, type });
      await runtime.applySessionStart(laterCtx);

      for (const warning of warnings) {
        assert.equal(
          notifications.filter((entry) => entry.type === "warning" && entry.message === warning)
            .length,
          2,
          `loaded warning should reappear in a later session: ${warning}`,
        );
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: real loader bounds warnings and preserves valid entries", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-bound-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const primaryAgents = { architect: { effort: "high" } };
      const subagents = {};
      for (let index = 0; index < 3000; index += 1) {
        primaryAgents[`p${index.toString(36)}`] = {};
        subagents[`s${index.toString(36)}`] = {};
      }
      const content = JSON.stringify({ primaryAgents, subagents });
      assert.ok(Buffer.byteLength(content, "utf8") <= 64 * 1024);
      mkdirSync(join(fixture.cwd, ".tlh"), { recursive: true });
      writeFileSync(join(fixture.cwd, ".tlh", "defaults.json"), content, "utf8");
      execFileSync("git", ["-C", fixture.cwd, "init", "--quiet"]);

      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async (options) => loadProjectDefaults(options),
      });
      const ctx = makeSessionCtx(fixture, {
        isProjectTrusted: () => true,
        hasUI: true,
        ui: {
          notify() {},
          confirm: async () => true,
        },
      });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      const firstWarningNotifications = notifications.filter((entry) => entry.type === "warning");
      assert.ok(firstWarningNotifications.length <= MAX_PROJECT_DEFAULT_WARNINGS + 1);
      assert.ok(
        firstWarningNotifications.every(
          (entry) => entry.message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH,
        ),
      );
      assert.equal(
        firstWarningNotifications.filter((entry) => entry.message.includes("more issues in"))
          .length,
        1,
      );
      assert.equal(registration.pi.thinkingLevel, "high", "valid architect entry still applies");

      await registration.beforeAgentStart({ systemPrompt: "base" }, ctx);
      const secondWarningNotifications = notifications.filter((entry) => entry.type === "warning");
      assert.equal(
        secondWarningNotifications.length,
        firstWarningNotifications.length,
        "later lifecycle boundaries must not re-notify the same warnings",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: runtime independently bounds injected warning arrays", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-bound-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const repeatedWarning = `duplicate-${"x".repeat(2048)}`;
      const warnings = Array.from({ length: 100 }, () => repeatedWarning);
      for (let index = 0; index < 25; index += 1) {
        warnings.push(`unique-${index}-${"y".repeat(2048)}`);
      }
      warnings.push(`…and ${"9".repeat(2048)} more issues in .tlh/defaults.json`);
      const injectedResult = /** @type {unknown} */ ({
        status: "loaded",
        defaults: { primaryAgents: {}, subagents: {} },
        warnings,
      });
      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => injectedResult,
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      const warningNotifications = notifications.filter((entry) => entry.type === "warning");
      assert.equal(warningNotifications.length, MAX_PROJECT_DEFAULT_WARNINGS + 1);
      assert.ok(
        warningNotifications.every(
          (entry) => entry.message.length <= MAX_PROJECT_DEFAULT_WARNING_LENGTH,
        ),
      );
      const summaryNotifications = warningNotifications.filter((entry) =>
        entry.message.includes("more issues in .tlh/defaults.json"),
      );
      assert.equal(summaryNotifications.length, 1);
      assert.equal(
        summaryNotifications[0].message,
        `…and ${MAX_PROJECT_DEFAULT_WARNING_COUNT} more issues in .tlh/defaults.json`,
        "overflow summary count must saturate at the documented safe bound",
      );
      const individualNotifications = warningNotifications.filter(
        (entry) => !entry.message.includes("more issues in .tlh/defaults.json"),
      );
      assert.equal(new Set(individualNotifications.map((entry) => entry.message)).size, 20);
      assert.ok(
        individualNotifications.some((entry) => entry.message.startsWith("unique-18-")),
        "duplicate injected warnings must not consume all visible slots",
      );
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: throwing injected result fails closed", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-malformed-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const malformedResult = /** @type {unknown} */ ({
        get status() {
          throw new Error("malformed status getter");
        },
      });
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => malformedResult,
      });
      const ctx = makeSessionCtx(fixture);

      await assert.doesNotReject(
        registration.runtime.applySessionStart(ctx),
        "throwing result getters must not escape session_start",
      );
      assert.deepEqual(registration.pi.model, {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      });
      assert.equal(registration.pi.thinkingLevel, "low");
      await shutdownRuntime(registration, ctx);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: warning notifications fail closed for broken and headless UI", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-ui-", { cwd: true, test: t });
  const warning = "Repository-owned defaults warning with a broken notifier.";

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: { primaryAgents: {}, subagents: {} },
          warnings: [warning],
        }),
      });
      const throwingContext = makeSessionCtx(fixture, {
        hasUI: true,
        ui: {
          notify() {
            throw new Error("simulated notifier failure");
          },
        },
      });
      await assert.doesNotReject(
        registration.runtime.applySessionStart(throwingContext),
        "a throwing notifier must not escape session_start",
      );

      const headlessContext = makeSessionCtx(fixture, {
        hasUI: false,
        ui: {
          notify() {
            throw new Error("headless notifier must not be called");
          },
        },
      });
      await assert.doesNotReject(
        registration.runtime.applySessionStart(headlessContext),
        "headless defaults warnings must not escape session_start",
      );
      await shutdownRuntime(registration, headlessContext);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: denied-result warnings remain silent", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-warning-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const deniedWarning = "Project-defaults loading denied (session-negative).";
      const notifications = [];
      const { runtime } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => ({
          status: "denied",
          warnings: [deniedWarning],
        }),
      });
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await runtime.applySessionStart(ctx);

      assert.equal(
        notifications.some((entry) => entry.type === "warning" && entry.message === deniedWarning),
        false,
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: boundary drops invalid primary entries, arrays, and prototype keys", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-boundary-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const primaryAgents = {
        architect: { model: "not-a-model-ref", effort: "max" },
        unknown_primary: { effort: "max" },
      };
      // Object literal __proto__ changes the prototype instead of creating an
      // own enumerable property, so construct both sensitive keys explicitly.
      Object.defineProperty(primaryAgents, "__proto__", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { architect: { effort: "max" } },
      });
      Object.defineProperty(primaryAgents, "constructor", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { architect: { effort: "max" } },
      });
      const injectedResult = /** @type {unknown} */ ({
        status: "loaded",
        defaults: { primaryAgents, subagents: [] },
        warnings: [],
      });
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => injectedResult,
      });
      const ctx = makeSessionCtx(fixture);

      await runtime.applySessionStart(ctx);

      // Invalid model must reject the whole entry, including its valid effort;
      // the invalid array section and prototype-sensitive names must not apply.
      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
      assert.equal(pi.thinkingLevel, "low");
      assert.equal(Object.prototype.effort, undefined);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: boundary drops invalid subagent entries and prototype keys", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-boundary-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const subagents = {
        developer: { model: "openai-codex/gpt-5.6-luna", effort: "HIGH" },
        unknown_role: { model: "openai-codex/gpt-5.6-luna", effort: "high" },
      };
      Object.defineProperty(subagents, "__proto__", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { developer: { effort: "high" } },
      });
      Object.defineProperty(subagents, "constructor", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: { developer: { effort: "high" } },
      });
      const injectedResult = /** @type {unknown} */ ({
        status: "loaded",
        defaults: { primaryAgents: [], subagents },
        warnings: [],
      });
      const developer = {
        name: "developer",
        description: "Test developer",
        tools: ["read"],
        systemPrompt: "test",
        filePath: "agents/subagents/developer.md",
        tlhModelDefaults: [
          {
            provider: "anthropic",
            models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
            effort: "low",
          },
        ],
        tlhModelDefaultsSource: "frontmatter",
      };
      const { runtime, toolCall } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [developer],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => injectedResult,
      });
      const ctx = makeSessionCtx(fixture, {
        model: { provider: "anthropic", id: "claude-sonnet-4-6" },
        modelRegistry: {
          getAvailable: () => [
            { provider: "anthropic", id: "claude-sonnet-4-6" },
            { provider: "openai-codex", id: "gpt-5.6-luna" },
          ],
        },
      });
      const input = { agent: "developer", task: "Check the defaults boundary" };

      await runtime.applySessionStart(ctx);
      await toolCall({ toolName: "subagent", input }, ctx);

      // Invalid effort rejects the whole entry, including its valid model;
      // the bundled anthropic model/effort therefore remain in effect.
      assert.equal(input.model, "anthropic/claude-sonnet-4-6:low");
      assert.equal(Object.prototype.effort, undefined);
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: consumption is bound to the loaded root and current cwd", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-root-binding-", { cwd: true, test: t });
  const other = createIsolatedProfileFixture("tlh-pd-root-binding-other-", {
    cwd: true,
    test: t,
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const developer = {
        name: "developer",
        description: "Test developer",
        tools: ["read"],
        systemPrompt: "test",
        filePath: "agents/subagents/developer.md",
        tlhModelDefaults: [
          {
            provider: "anthropic",
            models: [{ provider: "anthropic", id: "claude-sonnet-4-6" }],
            effort: "low",
          },
        ],
        tlhModelDefaultsSource: "frontmatter",
      };
      const projectModel = { provider: "anthropic", id: "claude-opus-4-8" };
      const { runtime, pi, beforeAgentStart, toolCall } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [developer],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => ({
          status: "loaded",
          projectRoot: fixture.cwd,
          defaults: {
            primaryAgents: { architect: { model: "anthropic/claude-opus-4-8" } },
            subagents: { developer: { model: "anthropic/claude-opus-4-8" } },
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);
      assert.deepEqual(pi.model, projectModel);

      const outsideCtx = makeSessionCtx(other, { model: pi.model });
      pi.model = { provider: "anthropic", id: "claude-sonnet-4-6" };
      await beforeAgentStart({ systemPrompt: "base" }, outsideCtx);
      assert.notDeepEqual(
        pi.model,
        projectModel,
        "a primary defaults entry from another worktree must not reapply",
      );

      const outsideDispatch = { agent: "developer", task: "Use the current worktree" };
      await toolCall({ toolName: "subagent", input: outsideDispatch }, outsideCtx);
      assert.equal(
        outsideDispatch.model,
        "anthropic/claude-sonnet-4-6:low",
        "packaged defaults must not cross a worktree/cwd boundary",
      );
    });
  } finally {
    cleanupTempDir(fixture);
    cleanupTempDir(other);
  }
});

test("project-defaults: active entries require positive project-config trust", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-trust-kind-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: { architect: { effort: "xhigh" } },
            subagents: {},
          },
          // An execution-plane result is never valid at this boundary.
          trust: { kind: "project-agent", trusted: true, source: "saved-positive" },
          warnings: [],
        }),
      });
      await runtime.applySessionStart(makeSessionCtx(fixture));
      assert.equal(
        pi.thinkingLevel,
        "low",
        "a loaded defaults entry with the wrong trust kind must be ignored",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});
