/**
 * Tests for the project-defaults integration in the primary-agent runtime (tlha-e4me).
 *
 * Coverage:
 *  - 4-layer precedence ordering (model and effort independently)
 *  - Per-field mixing (model from one layer, effort from another)
 *  - Unavailable-model fallback with warning
 *  - Boundary reapplication (before_agent_start, session_tree)
 *  - Disabled-mode no-op
 *  - Denied / unavailable loader status (no crash, no application)
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { AgentSession, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

import { loadProjectAgentSnapshot } from "../extensions/subagents/src/agents/project-agent-loader.js";
import { loadProjectDefaults } from "../extensions/subagents/src/agents/project-defaults-loader.js";
import { PRIMARY_AGENT_SESSION_STATE_ENTRY } from "../extensions/the-last-harness-primary-agent.mjs";
import {
  cleanupTempDir,
  createIsolatedProfileFixture,
  createSyntheticGitWorktree,
  withEnv,
} from "./test-fixture-helpers.mjs";
import {
  createPrimaryPrompt,
  registerRuntimeHarness,
  writePrimaryConfig,
} from "./the-last-harness-primary-agent-runtime-test-helpers.mjs";

const jiti = createJiti(import.meta.url);
const { setTlhProjectAgentSnapshotOperations } =
  await import("../extensions/the-last-harness/project-agent-access.mjs");
const { parseProviderModelReference } = await jiti.import(
  "../extensions/the-last-harness/model-defaults.ts",
);
const snapshotOperations =
  await import("../extensions/subagents/src/agents/project-agent-snapshot.js");

const { installTlhModelSelectionPersistenceOverride } = await jiti.import(
  "../extensions/the-last-harness/model-selection-scope.ts",
);

const MAX_PROJECT_DEFAULT_WARNINGS = 20;
const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
const MAX_PROJECT_DEFAULT_WARNING_COUNT = 1_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * A loader stub that returns a successful "loaded" result with the given
 * primaryAgents entries.
 */
function makeDefaultsLoader(primaryAgents = {}) {
  return async ({ cwd }) => ({
    status: "loaded",
    projectRoot: cwd,
    defaults: { primaryAgents, subagents: {} },
    trust: { kind: "project-config", trusted: true, source: "session-positive" },
    warnings: [],
  });
}

function addTestDefaultsBoundary(cwd, result) {
  if (result?.status !== "loaded") {
    return result;
  }
  return {
    ...result,
    projectRoot: result.projectRoot ?? cwd,
    trust: result.trust ?? {
      kind: "project-config",
      trusted: true,
      source: "session-positive",
    },
  };
}

// Keep this corpus in the top-level integration test so it can compare the
// eager runtime parser with the lazy loader without introducing a production
// import from the subagents target back into TLH's eager target.
test("project defaults accept exactly the eager provider/model reference grammar", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-model-grammar-", { cwd: true, test: t });
  createSyntheticGitWorktree(fixture.cwd);
  mkdirSync(join(fixture.cwd, ".tlh"), { recursive: true });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const references = [
        "anthropic/claude-sonnet-4-6",
        "openrouter/anthropic/vendor/model",
        "provider/model:high",
        "provider//model",
        "",
        "model-without-provider",
        "/model-without-provider",
        "provider/",
      ];
      for (const reference of references) {
        writeFileSync(
          join(fixture.cwd, ".tlh", "defaults.json"),
          JSON.stringify({ primaryAgents: { architect: { model: reference } } }),
          "utf8",
        );
        const result = await loadProjectDefaults({
          cwd: fixture.cwd,
          sessionId: "grammar-test-session",
          trust: {
            trustStore: {
              getEntry: () => ({ path: fixture.cwd, decision: true }),
            },
            hasTrustRequiringProjectResources: () => false,
            hasUI: false,
          },
        });
        const eagerAccepts = parseProviderModelReference(reference) !== undefined;
        const lazyAccepts = result.defaults?.primaryAgents.architect?.model === reference;
        assert.equal(
          lazyAccepts,
          eagerAccepts,
          `lazy defaults loader grammar disagrees for ${JSON.stringify(reference)}`,
        );
      }
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

/**
 * A loader stub that returns "denied" (trust refused).
 */
function makeDeniedLoader() {
  return async () => ({
    status: "denied",
    warnings: ["Project-defaults loading denied (session-negative)."],
  });
}

/**
 * A loader stub that returns "unavailable" (not in a git worktree, etc.).
 */
function makeUnavailableLoader() {
  return async () => ({
    status: "unavailable",
    warnings: ["Current directory is not inside a canonical Git worktree."],
  });
}

function makeDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function shutdownRuntime(registration, ctx) {
  const handler = registration?.pi.events.find(
    (event) => event.name === "session_shutdown",
  )?.handler;
  if (typeof handler === "function") {
    await handler({}, ctx);
  }
}

/**
 * Exercise the real generated trust loaders through the primary runtime with
 * both resources present and an undecided persisted custom-agent trust state.
 */
async function assertBothResourceTrustFailure(t, confirm, timeoutMs) {
  const fixture = createIsolatedProfileFixture("tlh-pd-trust-flow-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      mkdirSync(join(fixture.cwd, ".tlh", "agents", "custom"), { recursive: true });
      writeFileSync(
        join(fixture.cwd, ".tlh", "agents", "custom", "REVIEWER.md"),
        "---\nname: reviewer\npackage: embedded\ndescription: Reviewer\ntools: read\n---\nReview.\n",
        "utf8",
      );
      writeFileSync(
        join(fixture.cwd, ".tlh", "defaults.json"),
        JSON.stringify({ primaryAgents: { architect: { effort: "high" } } }),
        "utf8",
      );
      execFileSync("git", ["-C", fixture.cwd, "init", "--quiet"]);

      let prompts = 0;
      let agentResult;
      let defaultsResult;
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async (options) => {
          agentResult = await loadProjectAgentSnapshot({
            ...options,
            trust: {
              ...options.trustDependencies,
              ...options.context,
              trustUiTimeoutMs: timeoutMs,
            },
          });
          return agentResult;
        },
        projectDefaultsLoader: async (options) => {
          defaultsResult = await loadProjectDefaults({
            ...options,
            trust: { ...options.trust, trustUiTimeoutMs: timeoutMs },
          });
          return defaultsResult;
        },
      });
      const ctx = makeSessionCtx(fixture, {
        // Keep upstream trust unavailable so the configuration plane exercises
        // its own bounded session decision. The execution plane must remain
        // persisted-trust-only regardless of this result.
        isProjectTrusted: () => {
          throw new Error("upstream trust is unavailable");
        },
        hasUI: true,
        ui: {
          notify() {},
          confirm: (...args) => {
            prompts += 1;
            return confirm(...args);
          },
        },
      });

      await runtime.applySessionStart(ctx);

      assert.equal(prompts, 1, "defaults trust should prompt independently of custom-agent trust");
      assert.equal(agentResult?.status, "denied");
      assert.equal(agentResult?.trust?.source, "no-persisted-trust");
      assert.equal(defaultsResult?.status, "denied");
      assert.equal(defaultsResult?.trust?.source, "session-unavailable");
      assert.equal(
        pi.model.provider,
        "anthropic",
        "bundled defaults remain the only applied layer",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
}

/**
 * Minimal session context. The starting model is openai-codex/gpt-5.6-sol
 * (not the bundled primary default), so pi.setModel is always called when
 * a model switch happens, making pi.model reliably observable.
 */
function makeSessionCtx(fixture, overrides = {}) {
  return {
    cwd: fixture.cwd,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test-session-123",
    },
    ui: { notify() {} },
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-opus-4-8" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "openai-codex", id: "gpt-5.6-sol" },
      ],
    },
    // Start on openai-codex/gpt-5.6-sol so any model switch triggers pi.setModel
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    isProjectTrusted: () => false,
    hasUI: false,
    ...overrides,
  };
}

/**
 * Pi 0.84.4 carries model-persistence provenance through AgentSession.setModel.
 * Keep this test helper on that public boundary so project defaults are verified
 * against the same awaited persistence-session seam used by the runtime.
 */
function createPublicModelSession(pi, ctx, manager, initialModel) {
  const state = { model: initialModel, thinkingLevel: pi.thinkingLevel };
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
    pi.thinkingLevel = level;
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
  return session;
}

async function setModelThroughPublicApi(pi, ctx, manager, model, persist) {
  assert.equal(installTlhModelSelectionPersistenceOverride(), true);
  const session = createPublicModelSession(pi, ctx, manager, pi.model);
  await session.setModel(model, { persist });
  await manager.flush();
}

/**
 * Primary with applyModel + applyThinking and clear anthropic / openai frontmatter.
 * Bundled model: anthropic/claude-sonnet-4-6 (preferred), effort: low for anthropic,
 * gpt-5.6-luna / medium for openai-codex.
 */
function architectWithDefaults(name = "architect") {
  return createPrimaryPrompt(name, {
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
    ],
    preferredModel: { provider: "anthropic", id: "claude-sonnet-4-6" },
    applyModel: true,
    applyThinking: true,
  });
}

// ---------------------------------------------------------------------------
// Tests: Loader status edge cases
// ---------------------------------------------------------------------------

test("project-defaults: denied loader status — no model or effort applied, no crash", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeDeniedLoader(),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      // Denied: project defaults should not apply; bundled frontmatter model is used
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "denied loader: bundled frontmatter preferred model applies",
      );
      assert.equal(pi.thinkingLevel, "low", "denied loader: bundled frontmatter effort applies");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: unavailable loader status — no crash, no changed defaults", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: makeUnavailableLoader(),
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "unavailable loader: bundled frontmatter preferred model applies",
      );
      assert.equal(
        pi.thinkingLevel,
        "low",
        "unavailable loader: bundled frontmatter effort applies",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: runtime supplies interactive UI for a defaults-only trust decision", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      let prompts = 0;
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        // Keep the agents path out of this focused test: the defaults loader
        // must be able to obtain trust when there is no agent directory.
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async (options) => {
          assert.equal(options.trust?.hasUI, true);
          assert.equal(options.trust?.sessionId, "test-session-123");
          assert.equal(typeof options.trust?.hasTrustRequiringProjectResources, "function");
          assert.equal(options.trust?.defaultProjectTrust, "ask");
          assert.equal(typeof options.trust?.ui?.confirm, "function");
          const approved = await options.trust.ui.confirm(
            "Trust project-local TLH defaults?",
            "Approve defaults for this session.",
          );
          return approved
            ? {
                status: "loaded",
                projectRoot: fixture.cwd,
                defaults: { primaryAgents: { architect: { effort: "xhigh" } }, subagents: {} },
                trust: { kind: "project-config", trusted: true, source: "session-positive" },
                warnings: [],
              }
            : { status: "denied", projectRoot: fixture.cwd, warnings: [] };
        },
      });

      const ctx = makeSessionCtx(fixture, {
        isProjectTrusted: () => true,
        hasUI: true,
        ui: {
          notify() {},
          confirm: async () => {
            prompts += 1;
            return true;
          },
        },
      });
      await runtime.applySessionStart(ctx);

      assert.equal(prompts, 1, "defaults-only runtime path should prompt once");
      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
      assert.equal(pi.thinkingLevel, "xhigh");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: both resources do not re-prompt after agent trust timeout", async (t) => {
  await assertBothResourceTrustFailure(t, () => new Promise(() => {}), 10);
});

test("project-defaults: both resources do not re-prompt after agent trust rejection", async (t) => {
  await assertBothResourceTrustFailure(
    t,
    async () => {
      throw new Error("simulated UI disconnect");
    },
    10,
  );
});

test("project-defaults: session approval cannot authorize custom agents", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-trust-isolation-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      mkdirSync(join(fixture.cwd, ".tlh", "agents", "custom"), { recursive: true });
      writeFileSync(
        join(fixture.cwd, ".tlh", "agents", "custom", "REVIEWER.md"),
        "---\nname: reviewer\npackage: embedded\ndescription: Reviewer\ntools: read\n---\nReview.\n",
        "utf8",
      );
      writeFileSync(
        join(fixture.cwd, ".tlh", "defaults.json"),
        JSON.stringify({ primaryAgents: { architect: { effort: "xhigh" } } }),
        "utf8",
      );
      execFileSync("git", ["-C", fixture.cwd, "init", "--quiet"]);

      let prompts = 0;
      let agentResult;
      let defaultsResult;
      const notifications = [];
      const { runtime, pi, toolCall } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async (options) => {
          agentResult = await loadProjectAgentSnapshot(options);
          return agentResult;
        },
        projectDefaultsLoader: async (options) => {
          defaultsResult = await loadProjectDefaults(options);
          return defaultsResult;
        },
      });
      const ctx = makeSessionCtx(fixture, {
        // The config resolver must reach its own session prompt. The custom-agent
        // loader receives no UI/trust authority and therefore cannot use this.
        isProjectTrusted: () => {
          throw new Error("upstream trust unavailable");
        },
        hasUI: true,
        ui: {
          notify: (message, type) => notifications.push({ message, type }),
          confirm: async () => {
            prompts += 1;
            return true;
          },
        },
      });

      await runtime.applySessionStart(ctx);

      assert.equal(prompts, 1, "only the defaults trust plane should prompt");
      assert.equal(agentResult?.status, "denied");
      assert.equal(agentResult?.trust?.source, "no-persisted-trust");
      assert.equal(defaultsResult?.status, "loaded");
      assert.equal(defaultsResult?.trust?.kind, "project-config");
      assert.equal(defaultsResult?.trust?.source, "session-positive");
      assert.equal(pi.thinkingLevel, "xhigh");

      const blocked = await toolCall(
        { toolName: "subagent", input: { agent: "embedded.reviewer", task: "Review" } },
        ctx,
      );
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /Persist project trust with \/trust/);
      assert.ok(
        notifications.some((entry) => /custom agents are unavailable/i.test(entry.message)),
        "custom-agent denial should remain visible and independent from defaults approval",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: persisted trust enables custom agents and defaults without prompting", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-trust-persisted-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      mkdirSync(join(fixture.cwd, ".tlh", "agents", "custom"), { recursive: true });
      writeFileSync(
        join(fixture.cwd, ".tlh", "agents", "custom", "REVIEWER.md"),
        "---\nname: reviewer\npackage: embedded\ndescription: Reviewer\ntools: read\n---\nReview.\n",
        "utf8",
      );
      writeFileSync(
        join(fixture.cwd, ".tlh", "defaults.json"),
        JSON.stringify({ primaryAgents: { architect: { effort: "xhigh" } } }),
        "utf8",
      );
      execFileSync("git", ["-C", fixture.cwd, "init", "--quiet"]);
      new ProjectTrustStore(fixture.agent).set(fixture.cwd, true);

      let prompts = 0;
      let agentResult;
      let defaultsResult;
      const { runtime, pi, toolCall } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async (options) => {
          agentResult = await loadProjectAgentSnapshot(options);
          return agentResult;
        },
        projectDefaultsLoader: async (options) => {
          defaultsResult = await loadProjectDefaults(options);
          return defaultsResult;
        },
      });
      const ctx = makeSessionCtx(fixture, {
        isProjectTrusted: () => false,
        hasUI: true,
        ui: {
          notify() {},
          confirm: async () => {
            prompts += 1;
            return false;
          },
        },
      });

      await runtime.applySessionStart(ctx);

      assert.equal(prompts, 0, "persisted trust should satisfy both planes without prompting");
      assert.equal(agentResult?.status, "loaded");
      assert.equal(agentResult?.trust?.source, "saved-positive");
      assert.equal(defaultsResult?.status, "loaded");
      assert.equal(defaultsResult?.trust?.kind, "project-config");
      assert.equal(defaultsResult?.trust?.source, "saved-positive");
      assert.equal(pi.thinkingLevel, "xhigh");
      assert.equal(
        await toolCall(
          { toolName: "subagent", input: { agent: "embedded.reviewer", task: "Review" } },
          ctx,
        ),
        undefined,
        "persisted trust should also retain custom-agent execution authority",
      );
      const openRouterInput = { agent: "embedded.reviewer", task: "Review" };
      await toolCall(
        { toolName: "subagent", input: openRouterInput },
        makeSessionCtx(fixture, {
          model: { provider: "openrouter", id: "openai/gpt-5.6" },
        }),
      );
      assert.equal(
        openRouterInput.model,
        "openrouter/openai/gpt-5.6",
        "OpenRouter project-target inheritance remains the only project-target model mutation",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: shutdown clears defaults before an active-agent release failure", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-shutdown-release-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      mkdirSync(join(fixture.cwd, ".tlh", "agents", "custom"), { recursive: true });
      writeFileSync(
        join(fixture.cwd, ".tlh", "agents", "custom", "REVIEWER.md"),
        "---\nname: reviewer\npackage: embedded\ndescription: Reviewer\ntools: read\n---\nReview.\n",
        "utf8",
      );
      execFileSync("git", ["-C", fixture.cwd, "init", "--quiet"]);
      new ProjectTrustStore(fixture.agent).set(fixture.cwd, true);

      const notifications = [];
      const registration = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async (options) => loadProjectAgentSnapshot(options),
        projectDefaultsLoader: makeDefaultsLoader({ architect: { effort: "xhigh" } }),
      });
      const ctx = makeSessionCtx(fixture);
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      await registration.runtime.applySessionStart(ctx);
      assert.equal(registration.pi.thinkingLevel, "xhigh");

      setTlhProjectAgentSnapshotOperations({
        retainSnapshotReference: snapshotOperations.retainProjectAgentSnapshotReference,
        releaseSnapshotReference: () => {
          throw new Error("simulated shutdown release failure");
        },
        releaseRunReferencesForSession:
          snapshotOperations.releaseProjectAgentRunReferencesForSession,
        getRunReferenceMetadata: snapshotOperations.getProjectAgentRunReferenceMetadata,
        lookupRunReference: snapshotOperations.lookupProjectAgentRunReference,
      });
      const shutdown = registration.pi.events.find(
        (event) => event.name === "session_shutdown",
      )?.handler;
      assert.equal(typeof shutdown, "function");
      await shutdown({}, ctx);

      // The failed capability release intentionally leaves its owner for retry,
      // but defaults must already be cleared before that failure path returns.
      await registration.beforeAgentStart({ systemPrompt: "base" }, ctx);
      assert.equal(registration.pi.thinkingLevel, "low");
      assert.equal(
        notifications.filter(
          (entry) => entry.type === "info" && entry.message.includes("project defaults"),
        ).length,
        1,
        "clearing defaults also clears the applied-default notice scope",
      );
    });
  } finally {
    setTlhProjectAgentSnapshotOperations(undefined);
    cleanupTempDir(fixture);
  }
});

test("project-defaults: stale defaults result is ignored after session shutdown", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });
  const defaultsDeferred = makeDeferred();
  let defaultsStartedResolve;
  const defaultsStarted = new Promise((resolve) => {
    defaultsStartedResolve = resolve;
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async () => {
          defaultsStartedResolve();
          return defaultsDeferred.promise;
        },
      });
      const ctx = makeSessionCtx(fixture);
      const startPromise = runtime.applySessionStart(ctx);
      await defaultsStarted;

      const sessionShutdown = pi.events.find((event) => event.name === "session_shutdown")?.handler;
      assert.equal(typeof sessionShutdown, "function");
      await sessionShutdown({}, ctx);

      defaultsDeferred.resolve({
        status: "loaded",
        defaults: {
          primaryAgents: {
            architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
          },
          subagents: {},
        },
        warnings: [],
      });
      await startPromise;

      assert.equal(pi.model, undefined, "shutdown must prevent stale model application");
      assert.equal(pi.thinkingLevel, "normal", "shutdown must prevent stale effort application");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: stale agent load cannot start defaults or clear newer state", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });
  const staleAgent = makeDeferred();
  let agentCalls = 0;
  let staleAgentStartedResolve;
  const staleAgentStarted = new Promise((resolve) => {
    staleAgentStartedResolve = resolve;
  });
  let defaultsCalls = 0;

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const notifications = [];
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => {
          agentCalls += 1;
          if (agentCalls === 1) {
            staleAgentStartedResolve();
            return staleAgent.promise;
          }
          return { status: "unavailable", warnings: [] };
        },
        projectDefaultsLoader: async ({ cwd }) => {
          defaultsCalls += 1;
          if (defaultsCalls === 1) {
            return addTestDefaultsBoundary(cwd, {
              status: "loaded",
              defaults: {
                primaryAgents: {
                  architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
                },
                subagents: {},
              },
              warnings: ["B defaults warning"],
            });
          }
          return addTestDefaultsBoundary(cwd, {
            status: "loaded",
            defaults: {
              primaryAgents: {
                architect: { model: "openai-codex/gpt-5.6-luna", effort: "max" },
              },
              subagents: {},
            },
            warnings: ["A defaults warning"],
          });
        },
      });
      const ctx = makeSessionCtx(fixture, { hasUI: true });
      ctx.ui.notify = (message, type) => notifications.push({ message, type });

      const startA = runtime.applySessionStart(ctx);
      await staleAgentStarted;

      // B must finish its full agent/default/primary sequence before A resumes.
      const startB = runtime.applySessionStart(ctx);
      await startB;
      assert.equal(agentCalls, 2, "B must complete its own project-agent load");
      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-opus-4-8" });
      assert.equal(pi.thinkingLevel, "high");

      staleAgent.resolve({ status: "unavailable", warnings: ["A agent result"] });
      await startA;

      assert.equal(defaultsCalls, 1, "stale A must not call the project-defaults loader");
      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "stale A must not replace B's project model",
      );
      assert.equal(pi.thinkingLevel, "high", "stale A must not replace B's project effort");
      assert.ok(
        notifications.some((notification) => notification.message === "B defaults warning"),
        "B's defaults warning should be published",
      );
      assert.equal(
        notifications.some((notification) => notification.message === "A defaults warning"),
        false,
        "stale A's defaults warning must not be published",
      );
    });
  } finally {
    staleAgent.resolve({ status: "unavailable", warnings: [] });
    cleanupTempDir(fixture);
  }
});

test("project-defaults: newer defaults load wins over an older deferred result", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });
  const firstDefaults = makeDeferred();
  const secondDefaults = makeDeferred();
  let defaultsCall = 0;
  let firstStartedResolve;
  let secondStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const secondStarted = new Promise((resolve) => {
    secondStartedResolve = resolve;
  });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async ({ cwd }) => {
          defaultsCall += 1;
          if (defaultsCall === 1) {
            firstStartedResolve();
            return addTestDefaultsBoundary(cwd, await firstDefaults.promise);
          }
          secondStartedResolve();
          return addTestDefaultsBoundary(cwd, await secondDefaults.promise);
        },
      });
      const ctx = makeSessionCtx(fixture);
      const firstStart = runtime.applySessionStart(ctx);
      await firstStarted;
      const secondStart = runtime.applySessionStart(ctx);
      await secondStarted;

      secondDefaults.resolve({
        status: "loaded",
        defaults: {
          primaryAgents: {
            architect: { model: "anthropic/claude-opus-4-8", effort: "high" },
          },
          subagents: {},
        },
        warnings: [],
      });
      await secondStart;

      firstDefaults.resolve({
        status: "loaded",
        defaults: {
          primaryAgents: {
            architect: { model: "openai-codex/gpt-5.6-luna", effort: "max" },
          },
          subagents: {},
        },
        warnings: [],
      });
      await firstStart;

      assert.deepEqual(
        pi.model,
        { provider: "anthropic", id: "claude-opus-4-8" },
        "older deferred result must not overwrite newer project model",
      );
      assert.equal(
        pi.thinkingLevel,
        "high",
        "older deferred result must not overwrite newer project effort",
      );
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

test("project-defaults: an older runtime cannot apply defaults after a newer runtime is registered", async (t) => {
  const fixtureA = createIsolatedProfileFixture("tlh-pd-runtime-a-", { cwd: true, test: t });
  const fixtureB = createIsolatedProfileFixture("tlh-pd-runtime-b-", { cwd: true, test: t });
  const defaultsA = makeDeferred();
  let defaultsStartedResolve;
  const defaultsStarted = new Promise((resolve) => {
    defaultsStartedResolve = resolve;
  });
  let registrationA;
  let contextA;
  let startA;

  try {
    await withEnv({ HOME: fixtureA.home, PI_CODING_AGENT_DIR: fixtureA.agent }, async () => {
      try {
        registrationA = registerRuntimeHarness({
          primaryAgents: new Map([["architect", architectWithDefaults()]]),
          subagentMetadata: [],
          projectAgentLoader: async () => ({ status: "unavailable" }),
          projectDefaultsLoader: async () => {
            defaultsStartedResolve();
            return defaultsA.promise;
          },
        });
        contextA = makeSessionCtx(fixtureA);
        startA = registrationA.runtime.applySessionStart(contextA);
        await defaultsStarted;

        await withEnv({ HOME: fixtureB.home, PI_CODING_AGENT_DIR: fixtureB.agent }, async () => {
          let registrationB;
          let contextB;
          try {
            registrationB = registerRuntimeHarness({
              primaryAgents: new Map([["architect", architectWithDefaults()]]),
              subagentMetadata: [],
              projectAgentLoader: async () => ({ status: "unavailable" }),
              projectDefaultsLoader: makeDefaultsLoader({
                architect: { model: "openai-codex/gpt-5.6-luna", effort: "max" },
              }),
            });
            contextB = makeSessionCtx(fixtureB);
            await registrationB.runtime.applySessionStart(contextB);
            assert.deepEqual(registrationB.pi.model, {
              provider: "openai-codex",
              id: "gpt-5.6-luna",
            });
            assert.equal(registrationB.pi.thinkingLevel, "max");
          } finally {
            await shutdownRuntime(registrationB, contextB);
          }
        });

        defaultsA.resolve({
          status: "loaded",
          defaults: {
            primaryAgents: {
              architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
            },
            subagents: {},
          },
          warnings: [],
        });
        await startA;

        assert.equal(
          registrationA.pi.model,
          undefined,
          "runtime A must not apply any stale model after runtime B registration",
        );
        assert.equal(
          registrationA.pi.thinkingLevel,
          "normal",
          "runtime A must not apply any stale effort after runtime B registration",
        );
      } finally {
        defaultsA.resolve({ status: "unavailable", warnings: [] });
        if (startA) {
          await startA.catch(() => {});
        }
        await shutdownRuntime(registrationA, contextA);
      }
    });
  } finally {
    cleanupTempDir(fixtureA);
    cleanupTempDir(fixtureB);
  }
});

test("project-defaults: an adopted defaults snapshot is ignored after a newer runtime registers", async (t) => {
  const fixtureA = createIsolatedProfileFixture("tlh-pd-runtime-adopted-a-", {
    cwd: true,
    test: t,
  });
  const fixtureB = createIsolatedProfileFixture("tlh-pd-runtime-adopted-b-", {
    cwd: true,
    test: t,
  });
  let registrationA;
  let contextA;
  let registrationB;
  let contextB;
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
    await withEnv({ HOME: fixtureA.home, PI_CODING_AGENT_DIR: fixtureA.agent }, async () => {
      registrationA = registerRuntimeHarness({
        primaryAgents: new Map([["architect", architectWithDefaults()]]),
        subagentMetadata: [developer],
        projectAgentLoader: async () => ({ status: "unavailable" }),
        projectDefaultsLoader: async ({ cwd }) => ({
          status: "loaded",
          projectRoot: cwd,
          defaults: {
            primaryAgents: {
              architect: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
            },
            subagents: {
              developer: { model: "anthropic/claude-opus-4-8", effort: "xhigh" },
            },
          },
          trust: { kind: "project-config", trusted: true, source: "session-positive" },
          warnings: [],
        }),
      });
      contextA = makeSessionCtx(fixtureA);
      await registrationA.runtime.applySessionStart(contextA);
      assert.deepEqual(registrationA.pi.model, {
        provider: "anthropic",
        id: "claude-opus-4-8",
      });
      assert.equal(registrationA.pi.thinkingLevel, "xhigh");

      // Registering B retires A's runtime epoch without delivering A a shutdown.
      await withEnv({ HOME: fixtureB.home, PI_CODING_AGENT_DIR: fixtureB.agent }, async () => {
        registrationB = registerRuntimeHarness({
          primaryAgents: new Map([["architect", architectWithDefaults()]]),
          subagentMetadata: [],
          projectAgentLoader: async () => ({ status: "unavailable" }),
          projectDefaultsLoader: makeUnavailableLoader(),
        });
        contextB = makeSessionCtx(fixtureB);
      });

      const subagentInput = { agent: "developer", task: "Use the packaged developer defaults" };
      await registrationA.toolCall(
        { toolName: "subagent", input: subagentInput },
        {
          ...contextA,
          model: { provider: "anthropic", id: "claude-sonnet-4-6" },
        },
      );
      assert.equal(
        subagentInput.model,
        "anthropic/claude-sonnet-4-6:low",
        "retired runtime must not apply adopted project subagent defaults",
      );

      registrationA.pi.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
      registrationA.pi.thinkingLevel = "normal";
      await registrationA.beforeAgentStart(
        { systemPrompt: "base" },
        { ...contextA, model: registrationA.pi.model },
      );

      assert.deepEqual(
        registrationA.pi.model,
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        "retired runtime must fall back to bundled defaults, not its adopted project model",
      );
      assert.equal(
        registrationA.pi.thinkingLevel,
        "low",
        "retired runtime must fall back to bundled effort, not its adopted project effort",
      );
    });
  } finally {
    await shutdownRuntime(registrationB, contextB);
    await shutdownRuntime(registrationA, contextA);
    cleanupTempDir(fixtureA);
    cleanupTempDir(fixtureB);
  }
});

test("project-defaults: loader that throws — no crash, bundled defaults apply", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-pd-test-", { cwd: true, test: t });

  try {
    await withEnv({ HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent }, async () => {
      const arch = architectWithDefaults();
      const primaryAgents = new Map([["architect", arch]]);
      const { runtime, pi } = registerRuntimeHarness({
        primaryAgents,
        subagentMetadata: [],
        projectDefaultsLoader: async () => {
          throw new Error("simulated loader failure");
        },
      });

      const ctx = makeSessionCtx(fixture);
      await runtime.applySessionStart(ctx);

      assert.deepEqual(pi.model, { provider: "anthropic", id: "claude-sonnet-4-6" });
      assert.equal(pi.thinkingLevel, "low");
    });
  } finally {
    cleanupTempDir(fixture);
  }
});

// ---------------------------------------------------------------------------
// Tests: Layer 2 vs Layer 4 (project defaults beat bundled frontmatter)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: Unavailable project model — fallback and warning
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: Boundary reapplication
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: Applied-defaults notice
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: loaded-result warnings and boundary normalization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: Full 4-layer precedence (all layers present)
// ---------------------------------------------------------------------------

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
