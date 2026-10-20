/**
 * Regression suite: TLH hidden-model visibility for subagent dispatch.
 *
 * Verifies that the TLH hidden-model list (modelVisibility.hidden) only
 * suppresses models from the user-facing picker and does NOT prevent
 * subagents from resolving or receiving those models.
 *
 * Ported from main (06d8f4a8) to branch paths:
 *   - readModelRegistrySnapshot: runs/shared/run-support.ts (was: foreground-support.ts)
 *   - createSubagentExecutor: extension/subagent-executor.ts (was: foreground/subagent-executor.ts)
 *
 * Omitted assertions (each with reason):
 *   1. snapshot.evidence (allModels/error fields) — branch's readModelRegistrySnapshot returns
 *      { availableModels } only; the evidence field was part of the retired foreground-support module.
 *   2. buildModelCandidatePlan availability-based filtering — branch's function in
 *      runs/shared/model-fallback.ts takes (primaryModel, fallbackModels, options?) and does not
 *      accept an availableModels array or evidence object; no availability-based fallback filtering.
 *   3. "fallback planning filters unavailable credentials" test entirely — all assertions depended
 *      on evidence fields and the 5-arg buildModelCandidatePlan signature (both retired on branch).
 *   4. Parallel dispatch model-override assertions — executeAsyncParallel has no injectable mock
 *      seam on the branch (no deps.executeAsyncParallel override); coverage of snapshot pass-through
 *      is provided by the single and async dispatch paths.
 *   5. resumeAsyncRun from foreground-resume.ts — foreground resume is retired; branch's
 *      async-control-resume.ts resumeAsyncRun requires fully persisted async run state (async dir,
 *      result file, pause claims) that is too complex to fixture for this regression test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// Branch path: runs/shared/run-support.ts (not foreground-support.ts).
const { readModelRegistrySnapshot } = await jiti.import(
  "../extensions/subagents/src/runs/shared/run-support.ts",
);
// Branch path: extension/subagent-executor.ts (not foreground/subagent-executor.ts).
const { createSubagentExecutor } = await jiti.import(
  "../extensions/subagents/src/extension/subagent-executor.ts",
);

const SUBAGENT_ENV_RESET = Object.fromEntries(
  Object.keys(process.env)
    .filter(
      (key) =>
        key.startsWith("PI_SUBAGENT_") ||
        key.startsWith("PI_SUBAGENTS_") ||
        key === "NODE_TEST_CONTEXT",
    )
    .map((key) => [key, undefined]),
);
const AUTH_PROVIDER = "tlh-visibility-auth";
const HIDDEN_MODEL_ID = "hidden-authenticated";
const VISIBLE_MODEL_ID = "visible-authenticated";
const HIDDEN_MODEL = { provider: AUTH_PROVIDER, id: HIDDEN_MODEL_ID };
const VISIBLE_MODEL = { provider: AUTH_PROVIDER, id: VISIBLE_MODEL_ID };

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

async function createModelRegistry() {
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
  const registry = new ModelRegistry(runtime);
  return {
    runtime,
    registry,
    cleanup: () => {
      runtime.unregisterProvider(AUTH_PROVIDER);
    },
  };
}

function writeTestVisibilitySettings(fixture) {
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
    cleanupTimers: new Map(),
    lastUiContext: null,
    poller: null,
    watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear() {} },
  };
}

function createExecutor(root, state, { agent = createAgent(), asyncDispatches = [] } = {}) {
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
    tempArtifactsDir: root,
    getSubagentSessionRoot: () => root,
    expandTilde: (value) => value,
    discoverAgents: (_cwd, _scope) => ({ agents: [agent] }),
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

test("shared runtime snapshot keeps authenticated hidden models available for single and async dispatch", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-", {
    cwd: true,
    test: t,
  });
  writeTestVisibilitySettings(fixture);

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

    // readModelRegistrySnapshot uses getUnfilteredAvailableModels, so hidden
    // models appear in the snapshot forwarded to the child runner.
    const ctx = createContext(fixture.cwd, registry, visibleRuntimeModel);
    const snapshot = readModelRegistrySnapshot(ctx);
    assert.deepEqual(modelKeys(snapshot.availableModels, AUTH_PROVIDER), [
      modelReference(HIDDEN_MODEL),
      modelReference(VISIBLE_MODEL),
    ]);

    // Single (awaited) dispatch: verify modelOverride and availableModels forwarded.
    const asyncDispatches = [];
    const single = createExecutor(fixture.dir, createState(), { asyncDispatches });
    const singleResult = await single.executor.execute(
      "single-dispatch",
      { agent: "developer", task: "single" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(singleResult.isError, undefined);
    assert.equal(asyncDispatches.length, 1);
    assert.equal(asyncDispatches[0].params.modelOverride, modelReference(HIDDEN_MODEL));
    assertContainsModel(
      asyncDispatches[0].params.availableModels,
      HIDDEN_MODEL,
      "single dispatch snapshot",
    );
    assertContainsModel(
      asyncDispatches[0].params.availableModels,
      VISIBLE_MODEL,
      "single dispatch snapshot",
    );
  });
});

test("initial async single dispatch uses the capture seam without launching a detached runner", async (t) => {
  const fixture = createIsolatedProfileFixture("tlh-subagent-model-visibility-async-", {
    cwd: true,
    test: t,
  });
  writeTestVisibilitySettings(fixture);

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
  });
});
