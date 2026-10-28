import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { discoverAgents } from "../../src/agents/agents.ts";

import type { ExtensionConfig } from "../../src/shared/types.ts";
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
    runId?: string;
    asyncId?: string;
    asyncDir?: string;
    progress?: Array<{ status?: string; currentTool?: string }>;
    results?: Array<{
      agent?: string;
      skills?: string[];
      attemptedModels?: string[];
      interrupted?: boolean;
      terminationReason?: string;
      pause?: { kind?: string };
      projectAgent?: { provenance?: { agent?: string } };
    }>;
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
  "./src/extension/subagent-executor.ts",
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

async function waitForCondition(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readMaxParallelRunning(asyncDir: string): number {
  const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as {
    steps?: Array<{ startedAt?: number; endedAt?: number }>;
  };
  const intervals = (status.steps ?? [])
    .filter(
      (step): step is { startedAt: number; endedAt: number } =>
        typeof step.startedAt === "number" &&
        typeof step.endedAt === "number" &&
        step.endedAt >= step.startedAt,
    )
    .flatMap((step) => [
      { at: step.startedAt, delta: 1 },
      { at: step.endedAt, delta: -1 },
    ]);
  intervals.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let running = 0;
  let maximum = 0;
  for (const event of intervals) {
    running += event.delta;
    maximum = Math.max(maximum, running);
  }
  return maximum;
}

describe("subagent executor dispatch wiring", { concurrency: 1 }, () => {
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
  ) {
    return createSubagentExecutor({
      pi: makeExtensionAPI({ events: createEventBus() }),
      state: makeSubagentState({ baseCwd: tempDir }),
      config,
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (value: string) => value,
      discoverAgents: discoverAgentsImpl,
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
    assert.ok(result.details?.asyncDir, "ordinary single dispatch should await the async runner");
    const status = JSON.parse(
      fs.readFileSync(path.join(result.details.asyncDir, "status.json"), "utf-8"),
    ) as { awaited?: boolean };
    assert.equal(status.awaited, true);
    assert.ok((readCallArgs().at(-1) ?? "").startsWith("Task: "));
  });

  it("rejects duplicate concurrent calls while the default awaited runner is active", async () => {
    mockPi.reset();
    mockPi.onCall({ delay: 10_000, output: "first call eventually stopped" });
    const executor = makeExecutor();
    const controller = new AbortController();
    const firstPromise = executor.execute(
      "awaited-duplicate-first",
      { agent: "echo", task: "Keep the first awaited call active." },
      controller.signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    try {
      await waitForCondition(() => mockPi.callCount() === 1, "first awaited child launch");
      const duplicate = await executor.execute(
        "awaited-duplicate-second",
        { agent: "echo", task: "This concurrent call must be rejected." },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(duplicate.isError, true);
      assert.match(
        duplicate.content[0]?.text ?? "",
        /a subagent call is already in progress.*exactly ONE subagent call per turn/i,
      );
      assert.equal(mockPi.callCount(), 1, "duplicate dispatch must not launch another child");
    } finally {
      controller.abort();
      await firstPromise;
    }
  });

  it("awaits the default runner through a durable pause and executor resume", async () => {
    mockPi.reset();
    mockPi.onCall({
      steps: [
        {
          delay: 250,
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Need a decision before continuing",
            }),
          ],
        },
      ],
      keepAliveAfterFinalMessageMs: 10_000,
    });
    mockPi.onCall({ output: "continued after supervisor guidance" });

    const executor = makeExecutor();
    const paused = await executor.execute(
      "awaited-pause",
      { agent: "echo", task: "Ask for a decision" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(paused.isError, undefined);
    const runId = paused.details?.asyncId;
    const asyncDir = paused.details?.asyncDir;
    assert.ok(runId, "expected an awaited run id");
    assert.ok(asyncDir, "expected an awaited run directory");
    assert.equal(paused.details?.results?.[0]?.pause?.kind, "awaiting_supervisor");
    const pausedStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(pausedStatus.awaited, true);
    assert.equal(pausedStatus.state, "paused");

    const resumed = await executor.execute(
      "awaited-resume",
      { action: "resume", id: runId, message: "Continue with the supervisor decision." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(resumed.isError, undefined);
    const continuationId = resumed.details?.asyncId;
    assert.ok(continuationId, "expected the resumed continuation id");
    const payload = await readAsyncPayload(continuationId);
    assert.match(payload.results[0]?.output ?? "", /continued after supervisor guidance/);
    const continuedStatus = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(continuedStatus.awaited, true);
    assert.equal(continuedStatus.state, "complete");
  });

  it("routes steer, interrupt, and cancellation through the default awaited owner", async () => {
    mockPi.reset();
    mockPi.onCall({
      steps: [{ delay: 10_000, jsonl: [events.assistantMessage("late completion")] }],
    });
    const executor = makeExecutor();
    const updates: ExecutorResult[] = [];
    const controlController = new AbortController();
    const runPromise = executor.execute(
      "awaited-controls",
      { agent: "echo", task: "Keep working until controlled" },
      controlController.signal,
      (update) => updates.push(update),
      makeMinimalCtx(tempDir),
    );

    await waitForCondition(
      () =>
        updates.some((update) =>
          update.details?.progress?.some((step) => step.status === "running"),
        ),
      "awaited running progress",
    );
    const liveUpdate = updates.find((update) => update.details?.asyncId);
    const runId = liveUpdate?.details?.asyncId;
    assert.ok(runId, "expected the live update to identify the run");
    await waitForCondition(() => mockPi.callCount() === 1, "controlled awaited child launch");

    const steer = await executor.execute(
      "awaited-steer",
      { action: "steer", id: runId, message: "Use the safer implementation." },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(steer.isError, undefined);
    assert.match(steer.content[0]?.text ?? "", /Steering queued for async run/);

    const interrupt = await executor.execute(
      "awaited-interrupt",
      { action: "interrupt", id: runId },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(interrupt.isError, undefined, interrupt.content[0]?.text ?? "");
    assert.match(interrupt.content[0]?.text ?? "", /Interrupt requested for async run/);
    controlController.abort();
    const interrupted = await runPromise;
    assert.equal(interrupted.isError, true);
    assert.equal(interrupted.details?.results?.[0]?.terminationReason, "cancelled");

    mockPi.onCall({
      steps: [
        {
          delay: 250,
          jsonl: [
            events.toolStart("contact_supervisor", {
              reason: "need_decision",
              message: "Pause before cancellation.",
            }),
          ],
        },
      ],
      keepAliveAfterFinalMessageMs: 10_000,
    });
    const paused = await executor.execute(
      "awaited-pause-for-cancel",
      { agent: "echo", task: "Pause before cancellation" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(paused.isError, undefined, paused.content[0]?.text ?? "");
    const pausedId = paused.details?.asyncId;
    const pausedDir = paused.details?.asyncDir;
    assert.ok(pausedId, "expected a paused run id");
    assert.ok(pausedDir, "expected a paused run directory");
    assert.equal(paused.details?.results?.[0]?.terminationReason, "paused");

    const cancelled = await executor.execute(
      "awaited-cancel",
      { action: "interrupt", id: pausedId, dir: pausedDir },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(cancelled.isError, undefined, cancelled.content[0]?.text ?? "");
    assert.match(cancelled.content[0]?.text ?? "", /Cancelled paused awaited run/);
    const cancelledStatus = JSON.parse(
      fs.readFileSync(path.join(pausedDir, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(cancelledStatus.awaited, true);
    assert.equal(cancelledStatus.state, "cancelled");
  });

  it("propagates an executor abort to the awaited owner and keeps live updates", async () => {
    mockPi.reset();
    mockPi.onCall({ output: "abort this run", keepAliveAfterFinalMessageMs: 10_000 });
    const executor = makeExecutor();
    const controller = new AbortController();
    const updates: ExecutorResult[] = [];
    const runPromise = executor.execute(
      "awaited-abort",
      { agent: "echo", task: "Abort this task" },
      controller.signal,
      (update) => updates.push(update),
      makeMinimalCtx(tempDir),
    );
    await waitForCondition(
      () =>
        updates.some((update) =>
          update.details?.progress?.some((step) => step.status === "running"),
        ),
      "awaited abort progress",
    );
    const liveUpdate = updates.find((update) => update.details?.asyncDir);
    assert.ok(liveUpdate?.details?.asyncDir, "expected an awaited directory in live updates");
    controller.abort();

    const result = await runPromise;
    assert.equal(result.isError, true);
    assert.equal(result.details?.results?.[0]?.terminationReason, "cancelled");
    assert.ok(updates.length >= 1, "expected a live awaited update");
    const status = JSON.parse(
      fs.readFileSync(path.join(liveUpdate.details.asyncDir, "status.json"), "utf-8"),
    ) as { awaited?: boolean; state?: string };
    assert.equal(status.awaited, true);
    assert.equal(status.state, "cancelled");
  });

  it("preserves mixed embedded/user agents while enforcing trusted cwd containment", async () => {
    const projectRoot = fs.realpathSync(createTempDir("pi-subagent-mixed-project-"));
    const profileDir = path.join(projectRoot, "profile");
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const insideRoot = path.join(projectRoot, "inside");
    fs.mkdirSync(insideRoot, { recursive: true });
    execFileSync("git", ["init", "--quiet", projectRoot]);
    fs.mkdirSync(path.join(projectRoot, ".tlh", "agents", "custom"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = profileDir;
    const profileSubagentsDir = path.join(profileDir, "tlh", "agents", "subagents");
    fs.mkdirSync(profileSubagentsDir, { recursive: true });
    fs.copyFileSync(
      path.join(process.cwd(), "agents", "subagents", "code-reviewer.md"),
      path.join(profileSubagentsDir, "code-reviewer.md"),
    );
    new ProjectTrustStore(profileDir).set(projectRoot, true);
    fs.writeFileSync(
      path.join(projectRoot, ".tlh", "agents", "custom", "READER.md"),
      "---\nname: reader\npackage: embedded\ndescription: Reader\ntools: read\n---\nProject reader\n",
    );
    const trustStore = new ProjectTrustStore(profileDir);
    const state = makeSubagentState({ baseCwd: projectRoot });
    let discoveredScope: string | undefined;
    const executor = createSubagentExecutor({
      pi: makeExtensionAPI({ events: createEventBus() }),
      state,
      config: {},
      tempArtifactsDir: projectRoot,
      getSubagentSessionRoot: () => path.join(projectRoot, "sessions"),
      expandTilde: (value: string) => value,
      discoverAgents: (
        _cwd: Parameters<DiscoverAgents>[0],
        scope: Parameters<DiscoverAgents>[1],
      ) => {
        discoveredScope = scope;
        return { agents: [makeAgent("code-reviewer")] };
      },
      getProjectAgentAccess: () => ({
        architect: true,
        canInitiate: true,
        agentDir: profileDir,
        trustStore,
      }),
    });

    let validRunId: string | undefined;
    try {
      mockPi.reset();
      mockPi.onCall({ matchArgIncludes: "project child", output: "project child" });
      mockPi.onCall({ matchArgIncludes: "user child", output: "user child" });
      const valid = await executor.execute(
        "mixed-trusted-cwd",
        {
          agentScope: "project",
          cwd: projectRoot,
          tasks: [
            { agent: "embedded.reader", task: "project child", cwd: "inside" },
            { agent: "code-reviewer", task: "user child", cwd: "inside" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(projectRoot),
      );
      assert.equal(valid.isError, undefined, valid.content[0]?.text ?? "");
      assert.equal(valid.details?.results?.length, 2);
      assert.equal(discoveredScope, "project");
      assert.ok(valid.details?.asyncDir);
      validRunId = valid.details?.asyncId;
      const status = JSON.parse(
        fs.readFileSync(path.join(valid.details.asyncDir, "status.json"), "utf-8"),
      ) as {
        awaited?: boolean;
        cwd?: string;
        steps?: Array<{ agent?: string; cwd?: string; projectAgent?: unknown }>;
      };
      assert.equal(status.awaited, true);
      assert.deepEqual(
        status.steps?.map((step) => step.agent),
        ["embedded.reader", "code-reviewer"],
      );
      assert.deepEqual(
        status.steps?.map((step) => path.resolve(step.cwd ?? status.cwd ?? "")),
        [insideRoot, insideRoot],
      );
      assert.ok(
        status.steps?.[0]?.projectAgent,
        "project provenance should survive mixed dispatch",
      );
    } finally {
      void validRunId;
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
      removeTempDir(projectRoot);
    }
  });

  it("authorizes project agents with the session UUID, not the session file path", async () => {
    const requests: Array<{ sessionId: string | null; targetNames: string[] }> = [];
    const executor = createSubagentExecutor({
      pi: makeExtensionAPI({ events: createEventBus() }),
      state: makeSubagentState({ baseCwd: tempDir }),
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
      expandTilde: (value: string) => value,
      discoverAgents: () => ({ agents: [makeAgent("echo")] }),
      getProjectAgentAccess: (request: {
        sessionId: string | null;
        targetNames: readonly string[];
      }) => {
        requests.push({
          sessionId: request.sessionId,
          targetNames: [...request.targetNames],
        });
        return { architect: true, canInitiate: false };
      },
    });
    const ctx = makeMinimalCtx(tempDir);
    ctx.sessionManager.getSessionId = () => "session-uuid-1";
    ctx.sessionManager.getSessionFile = () => path.join(tempDir, "parent-session.jsonl");

    const result = await executor.execute(
      "project-agent-session-identity",
      { agent: "embedded.reader", task: "must not launch" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    assert.equal(result.isError, true);
    assert.deepEqual(requests, [
      { sessionId: "session-uuid-1", targetNames: [] },
      { sessionId: "session-uuid-1", targetNames: ["embedded.reader"] },
    ]);
    assert.equal(mockPi.callCount(), 0);
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
    assert.ok((readCallArgs().at(-1) ?? "").startsWith("Task: parallel task"));
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

    const invalidTaskTicket = await makeExecutor().execute(
      "invalid-task-ticket",
      { tasks: [{ agent: "echo", task: "must not launch", ticket: "bad/id" }] },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(invalidTaskTicket.isError, true);
    assert.match(invalidTaskTicket.content[0]?.text ?? "", /tasks\[0\]\.ticket/);
    assert.equal(mockPi.callCount(), 0);

    const combinedTicket = await makeExecutor().execute(
      "combined-ticket",
      {
        agent: "echo",
        ticket: "tlhm-top-level",
        tasks: [{ agent: "echo", task: "must not launch" }],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(combinedTicket.isError, true);
    assert.match(combinedTicket.content[0]?.text ?? "", /tasks\[i\]\.ticket/);
    assert.equal(mockPi.callCount(), 0);

    const missingCwd = await makeExecutor().execute(
      "missing-ticket-cwd",
      {
        tasks: [
          {
            agent: "echo",
            task: "must not launch",
            ticket: "tlhm-missing-cwd",
            cwd: path.join(tempDir, "does-not-exist"),
          },
        ],
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    assert.equal(missingCwd.isError, true);
    assert.match(missingCwd.content[0]?.text ?? "", /task cwd does not exist/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects retired tasks[].count before launch", async () => {
    const result = await makeExecutor().execute(
      "id",
      { tasks: [{ agent: "echo", task: "task one", count: 3 }] } as never,
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /tasks\[0\]\.count is no longer supported/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("does not use migration notices as unknown-agent load errors", async () => {
    const result = await makeExecutorWithDiscoverAgents(() => ({
      agents: [makeAgent("echo", { description: "Echo test agent" })],
      projectAgentsDir: null,
      agentDiagnostics: [
        {
          source: "user",
          filePath: "legacy.md",
          error: "Obsolete frontmatter key 'completionGuard' is ignored.",
          kind: "notice",
        },
      ],
    })).execute(
      "id",
      { agent: "missing", task: "two" },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Unknown agent: missing");
    assert.equal(mockPi.callCount(), 0);
  });

  it("memoizes ticket lookups across top-level parallel tasks", async () => {
    const ticketRoot = createTempDir("pi-subagent-count-ticket-");
    const binDir = path.join(ticketRoot, "bin");
    const firstCwd = path.join(ticketRoot, "first");
    const secondCwd = path.join(ticketRoot, "second");
    const lookupLog = path.join(ticketRoot, "lookups.log");
    const previousPath = process.env.PATH;
    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(firstCwd, { recursive: true });
      fs.mkdirSync(secondCwd, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, "tk"),
        `#!/usr/bin/env node
import fs from "node:fs";
const expected = {
  "tlhm-count": [
    { cwd: ${JSON.stringify(firstCwd)}, body: "# Count ticket\\n" },
    { cwd: ${JSON.stringify(secondCwd)}, body: "# Count ticket in a second cwd\\n" },
  ],
  "tlhm-other": [{ cwd: ${JSON.stringify(firstCwd)}, body: "# Other ticket\\n" }],
};
const candidates = expected[process.argv[3]] ?? [];
const ticket = candidates.find((candidate) => fs.realpathSync(process.cwd()) === fs.realpathSync(candidate.cwd));
fs.appendFileSync(${JSON.stringify(lookupLog)}, process.argv[3] + "|" + process.cwd() + "\\n");
if (!ticket || process.argv[2] !== "show") process.exit(3);
process.stdout.write(ticket.body);
`,
        "utf8",
      );
      fs.chmodSync(path.join(binDir, "tk"), 0o755);
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;

      const result = await makeExecutor().execute(
        "id",
        {
          tasks: [
            { agent: "echo", task: "same key one", ticket: "tlhm-count", cwd: firstCwd },
            {
              agent: "echo",
              task: "same ticket different cwd",
              ticket: "tlhm-count",
              cwd: secondCwd,
            },
            { agent: "echo", task: "different ticket", ticket: "tlhm-other", cwd: firstCwd },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.details?.mode, "parallel");
      assert.equal(result.details?.results?.length, 3);
      assert.equal(mockPi.callCount(), 3);
      const lookups = fs.readFileSync(lookupLog, "utf8").trim().split("\n");
      assert.equal(lookups.length, 3, "same normalized cwd and ticket ID should be loaded once");
      assert.deepEqual(
        new Set(lookups.map((entry) => entry.split("|")[0])),
        new Set(["tlhm-count", "tlhm-other"]),
      );
      assert.equal(
        new Set(
          lookups
            .filter((entry) => entry.startsWith("tlhm-count|"))
            .map((entry) => entry.split("|")[1]),
        ).size,
        2,
        "same ticket ID in distinct cwds should be loaded separately",
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      removeTempDir(ticketRoot);
    }
  });

  it("rejects top-level parallel tasks that exceed the default limit", async () => {
    const result = await makeExecutor().execute(
      "id",
      { tasks: Array.from({ length: 9 }, () => ({ agent: "echo", task: "task one" })) },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Max 8 tasks/);
    assert.equal(mockPi.callCount(), 0);
  });

  it("rejects retired execution controls before awaited or async child launch", async () => {
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
      // Note: maxOutput is intentionally not retired in the branch; it is used
      // internally by native awaited runs (native-result-lifecycle-grouping tests).
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

  it("bounds top-level parallel maxTasks to the supported status envelope", async () => {
    for (const testCase of [
      { name: "below-max", configuredMaxTasks: 2, count: 2, accepted: true },
      { name: "at-max", configuredMaxTasks: 8, count: 8, accepted: true },
      { name: "above-max", configuredMaxTasks: 9, count: 9, accepted: false },
    ]) {
      mockPi.reset();
      mockPi.onCall({ output: "ok" });
      const result = await makeExecutor({
        parallel: { maxTasks: testCase.configuredMaxTasks },
      }).execute(
        testCase.name,
        {
          tasks: Array.from({ length: testCase.count }, () => ({
            agent: "echo",
            task: "task one",
          })),
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      if (testCase.accepted) {
        assert.equal(result.isError, undefined, testCase.name);
        assert.equal(result.details?.results?.length, testCase.count, testCase.name);
        assert.equal(mockPi.callCount(), testCase.count, testCase.name);
      } else {
        assert.equal(result.isError, true, testCase.name);
        assert.match(result.content[0]?.text ?? "", /Max 8 tasks/, testCase.name);
        assert.equal(mockPi.callCount(), 0, testCase.name);
      }
    }

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
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined, testCase.name);
      assert.ok(result.details?.asyncDir, `${testCase.name}: expected awaited run directory`);
      const status = JSON.parse(
        fs.readFileSync(path.join(result.details.asyncDir, "status.json"), "utf-8"),
      ) as { awaited?: boolean };
      assert.equal(status.awaited, true, testCase.name);
      assert.equal(
        readMaxParallelRunning(result.details.asyncDir),
        testCase.expectedMaxRunning,
        testCase.name,
      );
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

  it("rejects clarify async chain requests before awaited fallback", async () => {
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
      {
        tasks: Array.from({ length: 9 }, () => ({ agent: "echo", task: "task one" })),
        async: true,
      },
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
