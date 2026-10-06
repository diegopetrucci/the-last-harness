import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { createIsolatedProfileFixture, withEnv } from "./test-fixture-helpers.mjs";

const subagentsTempRoot = mkdtempSync(join(tmpdir(), "tlh-subagent-model-visibility-runtime-"));
const previousSubagentsTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = subagentsTempRoot;
after(() => {
  rmSync(subagentsTempRoot, { recursive: true, force: true });
  if (previousSubagentsTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
  else process.env.PI_SUBAGENTS_TEMP_ROOT = previousSubagentsTempRoot;
});

const jiti = createJiti(import.meta.url);
const { getUnfilteredAvailableModels, installTlhModelVisibilityFilter } = await jiti.import(
  "../extensions/the-last-harness/model-visibility.ts",
);
const { readModelRegistrySnapshot } = await jiti.import(
  "../extensions/subagents/src/runs/foreground/foreground-support.ts",
);
const { buildModelCandidatePlan } = await jiti.import(
  "../extensions/subagents/src/runs/shared/model-fallback.ts",
);
const { createSubagentExecutor } = await jiti.import(
  "../extensions/subagents/src/runs/foreground/subagent-executor.ts",
);
const { resumeAsyncRun } = await jiti.import(
  "../extensions/subagents/src/runs/foreground/foreground-resume.ts",
);
const { RESULTS_DIR } = await jiti.import("../extensions/subagents/src/shared/types.ts");

const SUBAGENT_ENV_RESET = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => key.startsWith("PI_SUBAGENT_"))
    .map((key) => [key, undefined]),
);
const AUTH_PROVIDER = "tlh-visibility-auth";
const NO_AUTH_PROVIDER = "tlh-visibility-no-auth";
const HIDDEN_MODEL_ID = "hidden-authenticated";
const VISIBLE_MODEL_ID = "visible-authenticated";
const UNAVAILABLE_MODEL_ID = "missing-credentials";
const HIDDEN_MODEL = { provider: AUTH_PROVIDER, id: HIDDEN_MODEL_ID };
const VISIBLE_MODEL = { provider: AUTH_PROVIDER, id: VISIBLE_MODEL_ID };
const UNAVAILABLE_MODEL = { provider: NO_AUTH_PROVIDER, id: UNAVAILABLE_MODEL_ID };

function testEnv(fixture) {
  return { ...SUBAGENT_ENV_RESET, HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agent };
}

function modelReference(model) {
  return `${model.provider}/${model.id}`;
}

function modelKeys(models, provider) {
  return models
    .filter((model) => provider === undefined || model.provider === provider)
    .map(modelReference);
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

// AuthStorage.inMemory() is not publicly exported from @earendil-works/pi-coding-agent.
function createInMemoryCredentialStore() {
  const store = new Map();
  const tails = new Map();
  const noop = () => {};
  function enqueue(providerId, fn) {
    const tail = tails.get(providerId) ?? Promise.resolve();
    const result = tail.then(() => fn());
    tails.set(providerId, result.then(noop, noop));
    return result;
  }
  return {
    async read(providerId) {
      return store.get(providerId);
    },
    async list() {
      return [...store.entries()].map(([id, credential]) => ({
        providerId: id,
        type: credential.type,
      }));
    },
    modify(providerId, fn) {
      return enqueue(providerId, async () => {
        const current = store.get(providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(providerId, next);
        return next;
      });
    },
    delete(providerId) {
      return enqueue(providerId, async () => {
        store.delete(providerId);
      });
    },
  };
}

async function createModelRegistry({ includeUnavailable = false } = {}) {
  const runtime = await ModelRuntime.create({
    credentials: createInMemoryCredentialStore(),
    allowModelNetwork: false,
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider(AUTH_PROVIDER, {
    baseUrl: "https://tlh-visibility-auth.example.invalid/v1",
    apiKey: "test-only",
    api: "openai-completions",
    models: [runtimeModel(HIDDEN_MODEL_ID), runtimeModel(VISIBLE_MODEL_ID)],
  });
  if (includeUnavailable) {
    runtime.registerProvider(NO_AUTH_PROVIDER, {
      baseUrl: "https://tlh-visibility-no-auth.example.invalid/v1",
      api: "openai-completions",
      models: [runtimeModel(UNAVAILABLE_MODEL_ID)],
    });
  }
  const registry = new ModelRegistry(runtime);
  return {
    runtime,
    registry,
    cleanup: () => {
      runtime.unregisterProvider(AUTH_PROVIDER);
      if (includeUnavailable) runtime.unregisterProvider(NO_AUTH_PROVIDER);
    },
  };
}

function writeVisibilitySettings(fixture) {
  writeFileSync(
    join(fixture.agent, "settings.json"),
    `${JSON.stringify(
      { tlh: { modelVisibility: { hidden: [modelReference(HIDDEN_MODEL)] } } },
      null,
      2,
    )}\n`,
  );
}

function createAgent({
  model = modelReference(HIDDEN_MODEL),
  fallbackModels = [modelReference(VISIBLE_MODEL)],
} = {}) {
  return {
    name: "developer",
    description: "Visibility regression test agent",
    tools: [],
    model,
    fallbackModels,
    thinking: false,
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    systemPrompt: "Test agent.",
    source: "package",
    filePath: "agents/subagents/developer.md",
  };
}

function createContext(cwd, modelRegistry, model) {
  return {
    cwd,
    mode: "json",
    hasUI: false,
    ui: { notify() {}, confirm: async () => false },
    sessionManager: {
      getSessionId: () => "visibility-test-session",
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    modelRegistry,
    model,
    scopedModels: [],
    thinkingLevel: "low",
    isIdle: () => true,
    isProjectTrusted: () => false,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  };
}

function createState() {
  return {
    baseCwd: "",
    currentSessionId: null,
    asyncJobs: new Map(),
    foregroundRuns: new Map(),
    foregroundControls: new Map(),
    lastForegroundControlId: null,
    pendingForegroundControlNotices: new Map(),
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    completionSeen: new Map(),
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear() {} },
  };
}

function createArtifactConfig() {
  return {
    mode: "compact",
    enabled: false,
    includeInput: false,
    includeOutput: false,
    includeJsonl: false,
    includeTranscript: false,
    includeMetadata: false,
    includeChildEventProjections: false,
    cleanupDays: 1,
  };
}

function createExecutor(
  root,
  state,
  { agent = createAgent(), syncDispatches = [], asyncDispatches = [] } = {},
) {
  const deps = {
    pi: {
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      getSessionName: () => "visibility-test-parent",
    },
    state,
    config: { maxSubagentDepth: 2, control: {} },
    artifactConfig: createArtifactConfig(),
    executionPolicy: { maxRunTimeMs: false },
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: () => ({ agents: [agent] }),
    runSync: async (_cwd, _agents, _name, task, options) => {
      syncDispatches.push(options);
      return {
        agent: "developer",
        task,
        exitCode: 0,
        messages: [],
        finalOutput: "done",
        model: options.modelOverride,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      };
    },
    executeAsyncSingle: (id, params) => {
      asyncDispatches.push({ id, params });
      return {
        content: [{ type: "text", text: "captured" }],
        details: {
          mode: "single",
          runId: id,
          asyncId: id,
          asyncDir: join(root, "captured-async", id),
          results: [],
        },
      };
    },
  };
  return { agent, executor: createSubagentExecutor(deps) };
}

function assertContainsModel(models, expected, message = "shared availability snapshot") {
  assert.ok(
    models.some((model) => model.provider === expected.provider && model.id === expected.id),
    `expected ${modelReference(expected)} in ${message}`,
  );
}

function assertFallbackRetained(plan, fallback) {
  assert.ok(
    plan.candidates.includes(fallback),
    `expected fallback ${fallback} to remain a candidate`,
  );
  assert.deepEqual(plan.filteredFallbackModels, []);
  assert.equal(plan.filteringNotice, undefined);
}

function assertUnavailableFallbackFiltered(
  plan,
  fallback,
  expectedPrimary = modelReference(VISIBLE_MODEL),
) {
  assert.deepEqual(plan.filteredFallbackModels, [fallback]);
  assert.deepEqual(plan.candidates, [expectedPrimary]);
  assert.match(plan.filteringNotice ?? "", /unavailable fallback model/i);
  assert.match(plan.filteringNotice ?? "", /primary model was retained/i);
}

test("shared runtime snapshot keeps authenticated hidden models available for single and parallel dispatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-", {
    cwd: true,
    test: t,
  });
  writeVisibilitySettings(fixture);

  await withEnv(testEnv(fixture), async () => {
    installTlhModelVisibilityFilter();
    const { runtime, registry, cleanup } = await createModelRegistry();
    t.after(cleanup);

    const visibleRuntimeModel = runtime.getModel(AUTH_PROVIDER, VISIBLE_MODEL_ID);
    assert.ok(visibleRuntimeModel);

    // The real runtime and registry prototypes retain browsing/list filtering.
    assert.deepEqual(modelKeys(await runtime.getAvailable(AUTH_PROVIDER)), [
      modelReference(VISIBLE_MODEL),
    ]);
    assert.deepEqual(modelKeys(runtime.getAvailableSnapshot(), AUTH_PROVIDER), [
      modelReference(VISIBLE_MODEL),
    ]);
    assert.deepEqual(modelKeys(registry.getAvailable(), AUTH_PROVIDER), [
      modelReference(VISIBLE_MODEL),
    ]);

    // The helper recovers the auth-filtered snapshot through both real
    // ModelRuntime and ModelRegistry prototype facades without bypassing auth.
    assert.deepEqual(modelKeys(getUnfilteredAvailableModels(runtime), AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);
    assert.deepEqual(modelKeys(getUnfilteredAvailableModels(registry), AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);

    const ctx = createContext(fixture.cwd, registry, visibleRuntimeModel);
    const snapshot = readModelRegistrySnapshot(ctx);
    assert.deepEqual(modelKeys(snapshot.availableModels, AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);
    assert.deepEqual(modelKeys(snapshot.evidence.allModels, AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);

    const sharedPlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(HIDDEN_MODEL)],
      snapshot.availableModels,
      AUTH_PROVIDER,
      { registry: snapshot.evidence },
    );
    assert.deepEqual(sharedPlan.candidates, [
      modelReference(VISIBLE_MODEL),
      modelReference(HIDDEN_MODEL),
    ]);
    assertFallbackRetained(sharedPlan, modelReference(HIDDEN_MODEL));

    const syncDispatches = [];
    const single = createExecutor(fixture.dir, createState(), { syncDispatches });
    const singleResult = await single.executor.execute(
      "single-dispatch",
      { agent: "developer", task: "single" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(singleResult.isError, undefined);
    assert.equal(syncDispatches.length, 1);
    assert.equal(syncDispatches[0].modelOverride, modelReference(HIDDEN_MODEL));
    assertContainsModel(
      syncDispatches[0].availableModels,
      HIDDEN_MODEL,
      "single dispatch snapshot",
    );
    assertContainsModel(
      syncDispatches[0].availableModels,
      VISIBLE_MODEL,
      "single dispatch snapshot",
    );
    assertContainsModel(
      syncDispatches[0].modelRegistry.allModels,
      HIDDEN_MODEL,
      "single dispatch catalog evidence",
    );

    const parallelDispatches = [];
    const parallel = createExecutor(fixture.dir, createState(), {
      syncDispatches: parallelDispatches,
    });
    const parallelResult = await parallel.executor.execute(
      "parallel-dispatch",
      {
        tasks: [
          { agent: "developer", task: "first" },
          { agent: "developer", task: "second" },
        ],
      },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(parallelResult.isError, undefined);
    assert.equal(parallelDispatches.length, 2);
    for (const options of parallelDispatches) {
      assert.equal(options.modelOverride, modelReference(HIDDEN_MODEL));
      assertContainsModel(options.availableModels, HIDDEN_MODEL, "parallel dispatch snapshot");
      assertContainsModel(
        options.modelRegistry.allModels,
        HIDDEN_MODEL,
        "parallel dispatch catalog evidence",
      );
    }
  });
});

test("initial async single dispatch uses the capture seam without launching a detached runner", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-async-", {
    cwd: true,
    test: t,
  });
  writeVisibilitySettings(fixture);

  await withEnv(testEnv(fixture), async () => {
    installTlhModelVisibilityFilter();
    const { runtime, registry, cleanup } = await createModelRegistry();
    t.after(cleanup);
    const visibleRuntimeModel = runtime.getModel(AUTH_PROVIDER, VISIBLE_MODEL_ID);
    assert.ok(visibleRuntimeModel);
    const ctx = createContext(fixture.cwd, registry, visibleRuntimeModel);
    const asyncDispatches = [];
    const execution = createExecutor(fixture.dir, createState(), { asyncDispatches });

    const result = await execution.executor.execute(
      "async-dispatch",
      { agent: "developer", task: "async", async: true },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(asyncDispatches.length, 1);
    const dispatch = asyncDispatches[0].params;
    assert.equal(dispatch.modelOverride, modelReference(HIDDEN_MODEL));
    assertContainsModel(dispatch.availableModels, HIDDEN_MODEL, "async dispatch snapshot");
    assertContainsModel(dispatch.availableModels, VISIBLE_MODEL, "async dispatch snapshot");
    assertContainsModel(
      dispatch.modelRegistry.allModels,
      HIDDEN_MODEL,
      "async dispatch catalog evidence",
    );

    const plan = buildModelCandidatePlan(
      dispatch.modelOverride,
      dispatch.agentConfig.fallbackModels,
      dispatch.availableModels,
      AUTH_PROVIDER,
      { registry: dispatch.modelRegistry },
    );
    assert.deepEqual(plan.candidates, [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);
    assertFallbackRetained(plan, modelReference(VISIBLE_MODEL));
  });
});

test("fallback planning filters unavailable credentials but retains legacy and stale evidence conservatively", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-evidence-", {
    test: t,
  });
  writeVisibilitySettings(fixture);

  await withEnv(testEnv(fixture), async () => {
    installTlhModelVisibilityFilter();
    const { runtime, registry, cleanup } = await createModelRegistry({ includeUnavailable: true });
    t.after(cleanup);

    const visibleRuntimeModel = runtime.getModel(AUTH_PROVIDER, VISIBLE_MODEL_ID);
    assert.ok(visibleRuntimeModel);
    const snapshot = readModelRegistrySnapshot(
      createContext(fixture.dir, registry, visibleRuntimeModel),
    );
    assert.deepEqual(modelKeys(snapshot.availableModels, AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);
    assert.deepEqual(modelKeys(snapshot.availableModels, NO_AUTH_PROVIDER), []);
    assert.deepEqual(modelKeys(snapshot.evidence.allModels, NO_AUTH_PROVIDER), [
      modelReference(UNAVAILABLE_MODEL),
    ]);

    const unavailablePlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(UNAVAILABLE_MODEL)],
      snapshot.availableModels,
      AUTH_PROVIDER,
      { registry: snapshot.evidence },
    );
    assertUnavailableFallbackFiltered(unavailablePlan, modelReference(UNAVAILABLE_MODEL));

    const hiddenPlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(HIDDEN_MODEL)],
      snapshot.availableModels,
      AUTH_PROVIDER,
      { registry: snapshot.evidence },
    );
    assert.deepEqual(hiddenPlan.candidates, [
      modelReference(VISIBLE_MODEL),
      modelReference(HIDDEN_MODEL),
    ]);
    assertFallbackRetained(hiddenPlan, modelReference(HIDDEN_MODEL));

    // A legacy getAvailable-only facade has no authoritative catalog, so an
    // empty view remains uncertainty and never erases configured fallbacks.
    const legacySnapshot = readModelRegistrySnapshot({
      modelRegistry: { getAvailable: () => [] },
    });
    assert.deepEqual(legacySnapshot.availableModels, []);
    assert.deepEqual(legacySnapshot.evidence, {});
    const legacyPlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(UNAVAILABLE_MODEL)],
      legacySnapshot.availableModels,
      AUTH_PROVIDER,
      { registry: legacySnapshot.evidence },
    );
    assert.deepEqual(legacyPlan.candidates, [
      modelReference(VISIBLE_MODEL),
      modelReference(UNAVAILABLE_MODEL),
    ]);
    assert.deepEqual(legacyPlan.filteredFallbackModels, []);
    assert.equal(legacyPlan.filteringNotice, undefined);

    // Error evidence is conservative even when the partial view and catalog
    // would otherwise identify a fallback as unavailable.
    const staleSnapshot = readModelRegistrySnapshot({
      modelRegistry: {
        getAvailable: () => [VISIBLE_MODEL],
        getAll: () => [HIDDEN_MODEL, VISIBLE_MODEL],
        getError: () => "provider availability is stale",
      },
    });
    const stalePlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(HIDDEN_MODEL)],
      staleSnapshot.availableModels,
      AUTH_PROVIDER,
      { registry: staleSnapshot.evidence },
    );
    assert.equal(staleSnapshot.evidence.error, "provider availability is stale");
    assert.deepEqual(stalePlan.candidates, [
      modelReference(VISIBLE_MODEL),
      modelReference(HIDDEN_MODEL),
    ]);
    assert.deepEqual(stalePlan.filteredFallbackModels, []);

    const errorSnapshot = readModelRegistrySnapshot({
      modelRegistry: {
        getAvailable: () => [VISIBLE_MODEL],
        getAll: () => {
          throw new Error("stale catalog");
        },
      },
    });
    const errorPlan = buildModelCandidatePlan(
      modelReference(VISIBLE_MODEL),
      [modelReference(HIDDEN_MODEL)],
      errorSnapshot.availableModels,
      AUTH_PROVIDER,
      { registry: errorSnapshot.evidence },
    );
    assert.equal(errorSnapshot.evidence.error, "model catalog unavailable");
    assert.deepEqual(errorPlan.filteredFallbackModels, []);
  });
});

test("resume forwards the real hidden snapshot and plans distinct persisted primary/fallback models", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-resume-", {
    cwd: true,
    test: t,
  });
  writeVisibilitySettings(fixture);
  const runId = "visibility-resume-run";
  const sessionFile = join(fixture.dir, "child-session.jsonl");
  writeFileSync(sessionFile, "{}\n");
  mkdirSync(RESULTS_DIR, { recursive: true });
  const resultPath = join(RESULTS_DIR, `${runId}.json`);
  writeFileSync(
    resultPath,
    `${JSON.stringify(
      {
        id: runId,
        mode: "single",
        state: "complete",
        success: true,
        cwd: fixture.cwd,
        results: [
          {
            agent: "developer",
            success: true,
            sessionFile,
            model: modelReference(HIDDEN_MODEL),
            modelIdentity: { provider: HIDDEN_MODEL.provider, model: HIDDEN_MODEL.id },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  t.after(() => rmSync(resultPath, { force: true }));

  await withEnv(testEnv(fixture), async () => {
    installTlhModelVisibilityFilter();
    const { runtime, registry, cleanup } = await createModelRegistry({ includeUnavailable: true });
    t.after(cleanup);
    const visibleRuntimeModel = runtime.getModel(AUTH_PROVIDER, VISIBLE_MODEL_ID);
    assert.ok(visibleRuntimeModel);
    const calls = [];
    const state = createState();
    const agent = createAgent({
      model: modelReference(HIDDEN_MODEL),
      fallbackModels: [modelReference(VISIBLE_MODEL)],
    });

    const result = await resumeAsyncRun({
      params: { action: "resume", id: runId, message: "Continue" },
      requestCwd: fixture.cwd,
      ctx: createContext(fixture.cwd, registry, visibleRuntimeModel),
      artifactConfig: createArtifactConfig(),
      executionPolicy: { maxRunTimeMs: false },
      deps: {
        pi: {
          events: {
            emit() {},
            on() {
              return () => {};
            },
          },
          getSessionName: () => "visibility-test-parent",
        },
        state,
        config: { maxSubagentDepth: 2, control: {} },
        tempArtifactsDir: fixture.dir,
        getSubagentSessionRoot: () => fixture.dir,
        expandTilde: (value) => value,
        discoverAgents: () => ({ agents: [agent] }),
        executeAsyncSingle: (id, params) => {
          calls.push({ id, params });
          return {
            content: [{ type: "text", text: "captured continuation" }],
            details: {
              mode: "single",
              runId: id,
              asyncId: id,
              asyncDir: join(fixture.dir, "captured-async", id),
              results: [],
            },
          };
        },
      },
    });

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const dispatch = calls[0].params;
    assertContainsModel(dispatch.availableModels, HIDDEN_MODEL, "resume snapshot");
    assertContainsModel(dispatch.availableModels, VISIBLE_MODEL, "resume snapshot");
    assert.equal(dispatch.restoredModelIdentity?.provider, HIDDEN_MODEL.provider);
    assert.equal(dispatch.restoredModelIdentity?.model, HIDDEN_MODEL.id);
    assert.deepEqual(modelKeys(dispatch.modelRegistry.allModels, AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);

    // Use the same candidate planner as the detached runner with a distinct
    // persisted primary and configured fallback. A hidden authenticated model
    // remains a candidate and produces neither a false missing-model notice
    // nor a visibility-generated fallback filter.
    const resumedPlan = buildModelCandidatePlan(
      `${dispatch.restoredModelIdentity.provider}/${dispatch.restoredModelIdentity.model}`,
      agent.fallbackModels,
      dispatch.availableModels,
      AUTH_PROVIDER,
      { registry: dispatch.modelRegistry },
    );
    assert.deepEqual(resumedPlan.candidates, [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);
    assertFallbackRetained(resumedPlan, modelReference(VISIBLE_MODEL));

    // Also exercise the real unavailable-fallback notice path with distinct
    // primary/fallback spelling, rather than a duplicate primary assertion.
    const missingPrimary = "tlh-visibility-auth/persisted-primary-no-longer-listed";
    const missingPrimaryPlan = buildModelCandidatePlan(
      missingPrimary,
      [modelReference(UNAVAILABLE_MODEL)],
      dispatch.availableModels,
      AUTH_PROVIDER,
      { registry: dispatch.modelRegistry },
    );
    assertUnavailableFallbackFiltered(
      missingPrimaryPlan,
      modelReference(UNAVAILABLE_MODEL),
      missingPrimary,
    );
  });

  // Keep the result-only fixture inspectable in a failure report without
  // relying on a child process or a home-profile install.
  assert.ok(readFileSync(resultPath, "utf8").includes(runId));
});
