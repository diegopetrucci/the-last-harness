/**
 * Shared, stateless support for the split project-defaults runtime suites.
 *
 * This module intentionally does not register tests or create mutable fixtures
 * shared between cases. Each suite owns its runtime registry, environment and
 * temporary directories.
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export {
  AgentSession,
  PRIMARY_AGENT_SESSION_STATE_ENTRY,
  ProjectTrustStore,
  SettingsManager,
  cleanupTempDir,
  createIsolatedProfileFixture,
  createPrimaryPrompt,
  createSyntheticGitWorktree,
  installTlhModelSelectionPersistenceOverride,
  loadProjectAgentSnapshot,
  loadProjectDefaults,
  parseProviderModelReference,
  registerRuntimeHarness,
  setTlhProjectAgentSnapshotOperations,
  snapshotOperations,
  withEnv,
  writePrimaryConfig,
};

export const MAX_PROJECT_DEFAULT_WARNINGS = 20;
export const MAX_PROJECT_DEFAULT_WARNING_LENGTH = 512;
export const MAX_PROJECT_DEFAULT_WARNING_COUNT = 1_000_000;

export function readSettings(agent) {
  try {
    return JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

export function writeSettings(agent, settings) {
  writeFileSync(join(agent, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * A loader stub that returns a successful "loaded" result with the given
 * primaryAgents entries.
 */
export function makeDefaultsLoader(primaryAgents = {}) {
  return async ({ cwd }) => ({
    status: "loaded",
    projectRoot: cwd,
    defaults: { primaryAgents, subagents: {} },
    trust: { kind: "project-config", trusted: true, source: "session-positive" },
    warnings: [],
  });
}

export function addTestDefaultsBoundary(cwd, result) {
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

/**
 * A loader stub that returns "denied" (trust refused).
 */
export function makeDeniedLoader() {
  return async () => ({
    status: "denied",
    warnings: ["Project-defaults loading denied (session-negative)."],
  });
}

/**
 * A loader stub that returns "unavailable" (not in a git worktree, etc.).
 */
export function makeUnavailableLoader() {
  return async () => ({
    status: "unavailable",
    warnings: ["Current directory is not inside a canonical Git worktree."],
  });
}

export function makeDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

export async function shutdownRuntime(registration, ctx) {
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
export async function assertBothResourceTrustFailure(t, confirm, timeoutMs) {
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
export function makeSessionCtx(fixture, overrides = {}) {
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
export function createPublicModelSession(pi, ctx, manager, initialModel) {
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

export async function setModelThroughPublicApi(pi, ctx, manager, model, persist) {
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
export function architectWithDefaults(name = "architect") {
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
