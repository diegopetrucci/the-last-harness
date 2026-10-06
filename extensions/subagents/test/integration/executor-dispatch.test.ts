import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { discoverAgents } from "../../src/agents/agents.ts";
import {
  ASYNC_DIR,
  DEFAULT_MAX_OUTPUT,
  RESULTS_DIR,
  type ExtensionConfig,
} from "../../src/shared/types.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeExtensionAPI,
  makeMinimalCtx,
  makeModel,
  makeModelRegistryContext,
  makeSubagentState,
  removeTempDir,
  tryImport,
} from "../support/helpers.ts";
import {
  getProviderAwareFallbackModels,
  PROVIDER_AWARE_FALLBACK_MODELS,
} from "../../../the-last-harness-subagent-safety.mjs";
import type { MockPi } from "../support/helpers.ts";
import { readAsyncPayload } from "../support/async-execution-helpers.ts";

type DiscoverAgents = typeof discoverAgents;

interface ExecutorResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
  details?: {
    mode?: "single" | "parallel" | "management";
    asyncId?: string;
    progress?: Array<{ status?: string }>;
    results?: Array<{ skills?: string[]; attemptedModels?: string[] }>;
  };
}

interface ExecutorModule {
  createSubagentExecutor: (...args: unknown[]) => {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal,
      onUpdate: ((result: ExecutorResult) => void) | undefined,
      ctx: unknown,
    ) => Promise<ExecutorResult>;
  };
}

const { createSubagentExecutor } = await tryImport<ExecutorModule>(
  "./src/runs/foreground/subagent-executor.ts",
);

interface ProviderAwareModelDefaultsModule {
  applyProviderAwareSubagentModels(
    input: unknown,
    agents: ReadonlyMap<string, Record<string, unknown>>,
    availableModels: readonly unknown[],
    currentProvider?: string,
  ): number;
}

const { applyProviderAwareSubagentModels } = await tryImport<ProviderAwareModelDefaultsModule>(
  "../the-last-harness/model-defaults.ts",
);

function providerAwareModelDefaultsAgent(): Record<string, unknown> {
  return {
    name: "echo",
    tlhModelDefaults: [
      {
        provider: "openai-codex",
        models: [{ provider: "openai-codex", id: "primary" }],
        effort: "high",
      },
      {
        provider: "anthropic",
        models: [{ provider: "anthropic", id: "fallback" }],
        effort: "high",
      },
    ],
    tlhModelDefaultsSource: "frontmatter",
    preferOppositeProvider: true,
  };
}

function providerAwareAvailableModels() {
  return [
    makeModel("primary", { provider: "openai-codex" }),
    makeModel("fallback", { provider: "anthropic" }),
  ];
}

function applyGeneratedProviderFallback(input: Record<string, unknown>): void {
  assert.equal(Symbol.keyFor(PROVIDER_AWARE_FALLBACK_MODELS), "tlh.providerAwareFallbackModels");
  const jsonCallerInput: unknown = JSON.parse(
    '{"tlh.providerAwareFallbackModels":["spoofed/model"]}',
  );
  assert.equal(getProviderAwareFallbackModels(jsonCallerInput), undefined);

  const availableModels = providerAwareAvailableModels();
  const mutations = applyProviderAwareSubagentModels(
    input,
    new Map([["echo", providerAwareModelDefaultsAgent()]]),
    availableModels,
    "anthropic",
  );
  assert.equal(mutations, 1);
  assert.deepEqual(getProviderAwareFallbackModels(input), ["anthropic/fallback:high"]);
  assert.equal(Object.hasOwn(input, "fallbackModels"), false);
}

function providerErrorResponse(model: string) {
  return {
    jsonl: [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "quota hit" }],
          model,
          errorMessage: "429 quota exceeded",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
    ],
    exitCode: 0,
  };
}

async function providerAwareContext(
  cwd: string,
  availableModels: ReturnType<typeof providerAwareAvailableModels>,
) {
  const { context: ctx } = await makeModelRegistryContext(
    cwd,
    availableModels.map((model) => ({ provider: model.provider, models: [model] })),
  );
  ctx.model = makeModel("session", { provider: "anthropic" });
  return ctx;
}

function writeProjectOverride(projectRoot: string, agentName: string, model: string): void {
  const settingsPath = path.join(projectRoot, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ subagents: { agentOverrides: { [agentName]: { model } } } }, null, 2),
    "utf-8",
  );
}

function writePackageSkill(packageRoot: string, skillName: string): void {
  const skillDir = path.join(packageRoot, "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify(
      { name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
    "utf-8",
  );
}

describe("subagent executor dispatch wiring", () => {
  let tempDir: string;
  let mockPi: MockPi;

  before(() => {
    mockPi = createMockPi();
    mockPi.install();
  });

  after(() => {
    mockPi.uninstall();
  });

  beforeEach(() => {
    tempDir = createTempDir("pi-subagent-executor-test-");
    mockPi.reset();
    mockPi.onCall({ output: "ok" });
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  function makeExecutorWithDiscoverAgents(
    discoverAgentsImpl: DiscoverAgents = () => ({
      agents: [
        makeAgent("echo", { description: "Echo test agent" }),
        makeAgent("second", { description: "Second test agent" }),
      ],
      projectAgentsDir: null,
    }),
    config: ExtensionConfig = {},
    overrides: { runSync?: typeof runSync } = {},
  ) {
    return createSubagentExecutor({
      pi: makeExtensionAPI({ events: createEventBus() }),
      state: makeSubagentState({ baseCwd: tempDir }),
      config,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: discoverAgentsImpl,
      ...overrides,
    });
  }

  function makeExecutor(config: ExtensionConfig = {}) {
    return makeExecutorWithDiscoverAgents(undefined, config);
  }

  function readCallArgs(): string[] {
    const callFile = fs
      .readdirSync(mockPi.dir)
      .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
      .sort()
      .at(-1);
    assert.ok(callFile, "expected a recorded mock pi call");
    const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as {
      args?: unknown;
    };
    assert.ok(Array.isArray(payload.args), "expected recorded args");
    return payload.args as string[];
  }

  it("runs a single agent when task is omitted", async () => {
    const result = await makeExecutor().execute(
      "id",
      { agent: "echo" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    assert.ok((readCallArgs().at(-1) ?? "").startsWith("Task: \n\n## Acceptance Contract"));
  });

  it("uses tasks instead of the top-level agent for parallel mode", async () => {
    const result = await makeExecutor().execute(
      "id",
      { agent: "echo", tasks: [{ agent: "second", task: "parallel task" }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details?.mode, "parallel");
    assert.ok(
      (readCallArgs().at(-1) ?? "").startsWith("Task: parallel task\n\n## Acceptance Contract"),
    );
  });

  it("reports unknown top-level parallel agents before launch", async () => {
    const result = await makeExecutor().execute(
      "id",
      {
        tasks: [
          { agent: "echo", task: "one" },
          { agent: "missing", task: "two" },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Unknown agent: missing/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /persisted parent session/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("expands top-level parallel task counts before launch", async () => {
    const result = await makeExecutor().execute(
      "id",
      { tasks: [{ agent: "echo", task: "task one", count: 3 }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details?.mode, "parallel");
    assert.equal(result.details?.results?.length, 3);
    assert.equal(mockPi.callCount(), 3);
  });

  it("rejects top-level parallel counts that exceed the default limit", async () => {
    const result = await makeExecutor().execute(
      "id",
      { tasks: [{ agent: "echo", task: "task one", count: 9 }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Max 8 tasks/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects retired execution controls before foreground or async child launch", async () => {
    const cases: Array<{
      label: string;
      params: Record<string, unknown>;
      guidance: RegExp;
    }> = [
      {
        label: "parallel-task reads",
        params: { tasks: [{ agent: "echo", task: "task one", reads: ["legacy.md"] }] },
        guidance: /tasks\[0\]\.reads is no longer supported.*defaultReads/,
      },
      {
        label: "parallel-task progress",
        params: { tasks: [{ agent: "echo", task: "task one", progress: true }] },
        guidance: /tasks\[0\]\.progress is no longer supported.*defaultProgress/,
      },
      {
        label: "parallel concurrency",
        params: { tasks: [{ agent: "echo", task: "task one" }], concurrency: 1 },
        guidance:
          /concurrency is no longer supported.*parallel\.concurrency.*extensions\/subagent\/config\.json/,
      },
      {
        label: "single fallbackModels",
        params: { agent: "echo", task: "task one", fallbackModels: ["legacy/model"] },
        guidance: /fallbackModels is no longer supported.*agent definition/,
      },
      {
        label: "includeProgress",
        params: { agent: "echo", task: "task one", includeProgress: true },
        guidance: /includeProgress is no longer supported.*tracked automatically/,
      },
      {
        label: "top-level maxOutput",
        params: { agent: "echo", task: "task one", maxOutput: { lines: 1, bytes: 100 } },
        guidance: /maxOutput is no longer supported.*Output bounds are managed internally/,
      },
      {
        label: "parallel-task maxOutput",
        params: {
          tasks: [{ agent: "echo", task: "task one", maxOutput: { lines: 1, bytes: 100 } }],
        },
        guidance:
          /tasks\[0\]\.maxOutput is no longer supported.*Output bounds are managed internally/,
      },
    ];

    for (const testCase of cases) {
      for (const asyncMode of [false, true]) {
        mockPi.reset();
        const params = { ...testCase.params, ...(asyncMode ? { async: true } : {}) };
        const result = await makeExecutor().execute(
          "id",
          params,
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true, `${testCase.label} (${asyncMode ? "async" : "sync"})`);
        assert.match(result.content[0]?.text ?? "", testCase.guidance);
        assert.equal(result.details?.asyncId, undefined);
        assert.equal(mockPi.callCount(), 0);
      }
    }
  });

  it("leaves maxOutput absent across foreground and async dispatch paths", async () => {
    const observedForeground: string[] = [];
    const observedRunSync: typeof runSync = async (
      runtimeCwd,
      agents,
      agentName,
      task,
      options,
    ) => {
      assert.equal(options.maxOutput, undefined);
      observedForeground.push(agentName);
      return runSync(runtimeCwd, agents, agentName, task, options);
    };
    const tailSentinel = "ASYNC_DEFAULT_MAX_OUTPUT_TAIL_SENTINEL";
    const longOutput = `${Array.from(
      { length: DEFAULT_MAX_OUTPUT.lines + 25 },
      (_, index) => `output-line-${index}`,
    ).join("\n")}\n${tailSentinel}`;
    mockPi.onCall({ output: longOutput });
    mockPi.onCall({ output: longOutput });
    const executor = makeExecutorWithDiscoverAgents(undefined, {}, { runSync: observedRunSync });
    const asyncIds: string[] = [];
    try {
      const foregroundSingle = await executor.execute(
        "default-absence-foreground-single",
        { agent: "echo", task: "single" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(foregroundSingle.isError, undefined);

      const foregroundParallel = await executor.execute(
        "default-absence-foreground-parallel",
        { tasks: [{ agent: "echo", task: "parallel" }] },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(foregroundParallel.isError, undefined);

      const asyncSingle = await executor.execute(
        "default-absence-async-single",
        { agent: "echo", task: "async single", async: true },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(asyncSingle.isError, undefined);
      assert.ok(asyncSingle.details?.asyncId);
      asyncIds.push(asyncSingle.details.asyncId);

      const asyncParallel = await executor.execute(
        "default-absence-async-parallel",
        { tasks: [{ agent: "echo", task: "async parallel" }], async: true },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );
      assert.equal(asyncParallel.isError, undefined);
      assert.ok(asyncParallel.details?.asyncId);
      asyncIds.push(asyncParallel.details.asyncId);

      const payloads = await Promise.all(asyncIds.map((id) => readAsyncPayload(id)));
      for (const payload of payloads) {
        assert.equal(payload.state, "complete");
        assert.equal(payload.success, true);
        assert.equal(payload.truncated, false);
        assert.ok(payload.summary.includes(tailSentinel));
      }
      assert.deepEqual(observedForeground, ["echo", "echo"]);
    } finally {
      for (const id of asyncIds) {
        fs.rmSync(path.join(ASYNC_DIR, id), { recursive: true, force: true });
        fs.rmSync(path.join(RESULTS_DIR, `${id}.json`), { force: true });
      }
    }
  });

  it("passes model-defaults generated provider fallbacks through single dispatch", async () => {
    mockPi.reset();
    const availableModels = providerAwareAvailableModels();
    mockPi.onCall(providerErrorResponse("openai-codex/primary:high"));
    mockPi.onCall({ output: "Recovered on the generated fallback" });

    const input: Record<string, unknown> = { agent: "echo", task: "Task" };
    applyGeneratedProviderFallback(input);
    const result = await makeExecutor().execute(
      "single-provider-aware-fallback",
      input,
      new AbortController().signal,
      undefined,
      await providerAwareContext(tempDir, availableModels),
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [
      "openai-codex/primary:high",
      "anthropic/fallback:high",
    ]);
    assert.equal(mockPi.callCount(), 2);
  });

  it("passes model-defaults generated provider fallbacks through parallel dispatch", async () => {
    mockPi.reset();
    const availableModels = providerAwareAvailableModels();
    mockPi.onCall(providerErrorResponse("openai-codex/primary:high"));
    mockPi.onCall({ output: "Recovered on the parallel generated fallback" });

    const task: Record<string, unknown> = { agent: "echo", task: "Task" };
    applyGeneratedProviderFallback(task);
    const result = await makeExecutor().execute(
      "parallel-provider-aware-fallback",
      { tasks: [task] },
      new AbortController().signal,
      undefined,
      await providerAwareContext(tempDir, availableModels),
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [
      "openai-codex/primary:high",
      "anthropic/fallback:high",
    ]);
    assert.equal(mockPi.callCount(), 2);
  });

  it("accepts a model-defaults-mutated input without retired-control rejection", async () => {
    mockPi.reset();
    mockPi.onCall({ output: "Accepted model-defaults input" });
    const input: Record<string, unknown> = { agent: "echo", task: "Task" };
    applyGeneratedProviderFallback(input);

    const result = await makeExecutor().execute(
      "model-defaults-mutated-input",
      input,
      new AbortController().signal,
      undefined,
      await providerAwareContext(tempDir, providerAwareAvailableModels()),
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details?.results?.[0]?.attemptedModels?.length, 1);
    assert.equal(mockPi.callCount(), 1);
  });

  it("uses top-level parallel maxTasks and configured concurrency", async () => {
    const maxTasksResult = await makeExecutor({ parallel: { maxTasks: 9 } }).execute(
      "id",
      { tasks: [{ agent: "echo", task: "task one", count: 9 }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(maxTasksResult.isError, undefined);
    assert.equal(mockPi.callCount(), 9);

    for (const testCase of [
      { name: "config-two", configConcurrency: 2, expectedMaxRunning: 2 },
      { name: "config-three", configConcurrency: 3, expectedMaxRunning: 3 },
    ]) {
      mockPi.reset();
      for (let index = 0; index < 3; index++) {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart("bash", { command: `${testCase.name}-${index}` })] },
            { delay: 250 },
            { jsonl: [events.toolEnd("bash"), events.assistantMessage(`done-${index}`)] },
          ],
        });
      }

      let maxRunning = 0;
      const result = await makeExecutor({
        parallel: { concurrency: testCase.configConcurrency },
      }).execute(
        "id",
        {
          tasks: [
            { agent: "echo", task: "task one" },
            { agent: "second", task: "task two" },
            { agent: "echo", task: "task three" },
          ],
        },
        new AbortController().signal,
        (update) => {
          const running = (update.details?.progress ?? []).filter(
            (entry) => entry.status === "running",
          ).length;
          maxRunning = Math.max(maxRunning, running);
        },
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined, testCase.name);
      assert.equal(maxRunning, testCase.expectedMaxRunning, testCase.name);
    }
  });

  it("starts successful top-level parallel async requests in the background", async () => {
    const result = await makeExecutor().execute(
      "id",
      {
        tasks: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.details?.mode, "parallel");
    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected an asyncId for background top-level parallel runs");
    const payload = await readAsyncPayload(asyncId);
    assert.equal(payload.success, true);
    assert.equal(payload.mode, "parallel");
    assert.equal(payload.results.length, 2);
  });

  it("rejects async chain requests before background launch", async () => {
    const result = await makeExecutor().execute(
      "id",
      {
        chain: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
    assert.equal(result.details?.asyncId, undefined);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects clarify async chain requests before foreground fallback", async () => {
    const result = await makeExecutor().execute(
      "id",
      {
        chain: [
          { agent: "echo", task: "task one" },
          { agent: "second", task: "task two" },
        ],
        async: true,
        clarify: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Saved chains are deliberately unsupported/);
    assert.doesNotMatch(result.content[0]?.text ?? "", /chain clarify UI/);
    assert.equal(result.details?.asyncId, undefined);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects invalid async top-level parallel requests during preflight", async () => {
    const result = await makeExecutor().execute(
      "id",
      { tasks: [{ agent: "echo", task: "task one", count: 9 }], async: true },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Max 8 tasks/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects removed management actions without touching request cwd", async () => {
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(path.join(worktreeDir, ".pi"), { recursive: true });

    const result = await makeExecutor().execute(
      "id",
      {
        action: "create",
        cwd: "worktree",
        config: { name: "local-helper", description: "Local helper", scope: "project" },
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    const text = result.content.map((item) => item.text ?? "").join("");
    assert.match(text, /Unknown action: create/);
    assert.equal(fs.existsSync(path.join(worktreeDir, ".pi", "agents", "local-helper.md")), false);
    assert.equal(fs.existsSync(path.join(tempDir, ".pi", "agents", "local-helper.md")), false);
  });

  it("resolves parallel task cwd values relative to the request cwd", async () => {
    const worktreeDir = path.join(tempDir, "worktree");
    writePackageSkill(path.join(worktreeDir, "packages", "app"), "parallel-step-skill");
    const executor = makeExecutorWithDiscoverAgents(() => ({
      agents: [
        makeAgent("echo", { description: "Echo test agent", skills: ["parallel-step-skill"] }),
      ],
      projectAgentsDir: null,
    }));

    const result = await executor.execute(
      "id",
      {
        tasks: [{ agent: "echo", task: "test", cwd: "packages/app" }],
        cwd: worktreeDir,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.details?.results?.[0]?.skills, ["parallel-step-skill"]);
  });

  it("keeps request cwd custom-agent definitions out of management", async () => {
    const tempHome = createTempDir("pi-subagent-home-");
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const agentDir = path.join(tempHome, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const worktreeDir = path.join(tempDir, "worktree");
    fs.mkdirSync(worktreeDir, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: tempDir });
    new ProjectTrustStore(agentDir).set(tempDir, true);
    const customPath = path.join(tempDir, ".tlh", "agents", "custom", "AUDITOR.md");
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(
      customPath,
      "---\nname: auditor\npackage: embedded\ndescription: Auditor agent\nmodel: openai/gpt-5-worktree\n---\n\nAudit code.\n",
      "utf-8",
    );
    writeProjectOverride(tempDir, "embedded.auditor", "openai/gpt-5-main");
    writeProjectOverride(worktreeDir, "embedded.auditor", "openai/gpt-5-other");

    try {
      const result = await makeExecutor().execute(
        "id",
        { action: "get", agent: "embedded.auditor", cwd: "worktree", agentScope: "project" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /not found/i);
      assert.doesNotMatch(
        result.content[0]?.text ?? "",
        /openai\/gpt-5-worktree|gpt-5-main|gpt-5-other/,
      );
      assert.equal((result.content[0]?.text ?? "").includes(fs.realpathSync(customPath)), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiCodingAgentDir;
      removeTempDir(tempHome);
    }
  });
});
