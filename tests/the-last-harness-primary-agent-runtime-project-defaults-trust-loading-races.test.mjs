/**
 * Trust, loader-status and stale-load race coverage for the primary-agent
 * project-defaults runtime.
 */

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  addTestDefaultsBoundary,
  architectWithDefaults,
  assertBothResourceTrustFailure,
  cleanupTempDir,
  createIsolatedProfileFixture,
  createSyntheticGitWorktree,
  loadProjectAgentSnapshot,
  loadProjectDefaults,
  makeDefaultsLoader,
  makeDeferred,
  makeDeniedLoader,
  makeSessionCtx,
  makeUnavailableLoader,
  parseProviderModelReference,
  ProjectTrustStore,
  registerRuntimeHarness,
  setTlhProjectAgentSnapshotOperations,
  shutdownRuntime,
  snapshotOperations,
  withEnv,
} from "./the-last-harness-primary-agent-runtime-project-defaults-support.mjs";

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
