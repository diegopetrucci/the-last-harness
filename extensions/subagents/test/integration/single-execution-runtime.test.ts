/** Runtime ceilings, resume budgets, final drain, and timeout coverage. */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgentConfigs,
  makeAgent,
  makeMinimalCtx,
  events,
} from "../support/helpers.ts";
import {
  available,
  runSync,
  createSubagentExecutor,
  type ExecutionModule,
  type ExecuteAsyncSingleOverride,
  type ExecutorToolResult,
} from "../support/single-execution-fixtures.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { mockAssistantMessage, readPersistedStatus } from "../support/single-execution-fixtures.ts";

describe(
  "single sync execution",
  { skip: !available ? "pi packages not available" : undefined },
  () => {
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
      tempDir = createTempDir();
      mockPi.reset();
    });

    afterEach(() => {
      removeTempDir(tempDir);
    });

    function makeExecutor(
      agents = [makeAgent("echo")],
      config: Record<string, unknown> = {},
      state = {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      runSyncOverride: ExecutionModule["runSync"] | undefined = runSync,
      executeAsyncSingleOverride: ExecuteAsyncSingleOverride | undefined = undefined,
    ) {
      return createSubagentExecutor!({
        pi: { events: createEventBus(), getSessionName: () => undefined },
        state,
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
        runSync: runSyncOverride,
        executeAsyncSingle: executeAsyncSingleOverride,
      });
    }
    it(
      "uses the human-owned run ceiling for foreground execution",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const observedTimeouts: Array<number | undefined> = [];
        const wrappedRunSync: ExecutionModule["runSync"] = async (
          runtimeCwd,
          agents,
          agentName,
          task,
          options,
        ) => {
          observedTimeouts.push(options.timeoutMs as number | undefined);
          return runSync!(runtimeCwd, agents, agentName, task, options);
        };
        mockPi.onCall({ output: "policy" });
        const executor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: 2_000 })],
          { execution: { maxRunTimeMs: 1_234 } },
          undefined,
          wrappedRunSync,
        );

        const result = await executor.execute(
          "timeout-policy-default",
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.deepEqual(observedTimeouts, [1_234]);
      },
    );

    it(
      "keeps role ceilings active when the human run policy is explicitly false",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const observedTimeouts: Array<number | undefined> = [];
        const wrappedRunSync: ExecutionModule["runSync"] = async (
          runtimeCwd,
          agents,
          agentName,
          task,
          options,
        ) => {
          observedTimeouts.push(options.timeoutMs as number | undefined);
          return runSync!(runtimeCwd, agents, agentName, task, options);
        };
        mockPi.onCall({ output: "role policy" });
        const executor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: 600 })],
          { execution: { maxRunTimeMs: false } },
          undefined,
          wrappedRunSync,
        );

        const result = await executor.execute(
          "timeout-policy-role",
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.deepEqual(observedTimeouts, [600]);
      },
    );

    it(
      "rejects own retired timeout fields before foreground or async launch",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const executor = makeExecutor();
        const cases = [
          { agent: "echo", task: "Task", timeoutMs: 1 },
          { agent: "echo", task: "Task", async: true, timeoutMs: 1 },
          { tasks: [{ agent: "echo", task: "Task", timeoutMs: 1 }] },
          { action: "resume", id: "legacy-run", message: "Continue", timeoutMs: 1 },
        ];

        for (const [index, params] of cases.entries()) {
          const result = await executor.execute(
            `timeout-retired-${index}`,
            params as any,
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );
          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", /timeoutMs is no longer supported/);
          assert.match(result.content[0]?.text ?? "", /execution\.maxRunTimeMs/);
          assert.match(result.content[0]?.text ?? "", /Restart with a new direct run/);
        }
        assert.equal(mockPi.callCount(), 0);
      },
    );

    it(
      "formats a foreground resume after launch effects and falls back to the continuation id",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const sourceRunId = `resume-format-order-${Date.now().toString(36)}`;
        const sessionFile = path.join(tempDir, `${sourceRunId}.jsonl`);
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${sourceRunId}"}\n`, "utf-8");
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        state.foregroundRuns.set(sourceRunId, {
          runId: sourceRunId,
          mode: "single",
          state: "complete",
          cwd: tempDir,
          startedAt: 1,
          updatedAt: 2,
          children: [{ agent: "echo", status: "completed", sessionFile }],
        });
        const effects: string[] = [];
        const details: NonNullable<ExecutorToolResult["details"]> = { results: [] };
        Object.defineProperty(details, "asyncDir", {
          get() {
            effects.push(
              state.foregroundRuns.has(sourceRunId)
                ? "format:before-delete"
                : "format:after-delete",
            );
            return undefined;
          },
        });
        let continuedId = "";
        const executeAsyncSingle: ExecuteAsyncSingleOverride = (id) => {
          continuedId = id;
          effects.push("launch");
          return { content: [{ text: "stubbed continuation" }], details };
        };
        try {
          const result = await makeExecutor(
            [makeAgent("echo")],
            {},
            state,
            runSync,
            executeAsyncSingle,
          ).execute(
            "resume-format-order-call",
            { action: "resume", id: sourceRunId, message: "Continue." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined);
          assert.equal(result.details, details);
          assert.equal(
            result.content[0]?.text,
            [
              `Revived foreground subagent from ${sourceRunId}.`,
              `Revived run: ${continuedId}`,
              "Agent: echo",
              `Session: ${sessionFile}`,
              `Status if needed: subagent({ action: "status", id: "${continuedId}" })`,
            ].join("\n"),
          );
          assert.deepEqual(effects, ["launch", "format:after-delete"]);
          assert.equal(state.foregroundRuns.has(sourceRunId), false);
        } finally {
          fs.rmSync(sessionFile, { force: true });
        }
      },
    );

    it(
      "forwards non-success resume runtime evidence with the human run timeout before spawning",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const runId = `resume-runtime-forwarding-${Date.now().toString(36)}`;
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`, "utf-8");
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        state.foregroundRuns.set(runId, {
          runId,
          mode: "single",
          state: "failed",
          cwd: tempDir,
          startedAt: 1,
          updatedAt: 2,
          children: [
            {
              agent: "echo",
              status: "failed",
              sessionFile,
              activeRuntimeMs: 321.4,
              activeRuntimeCheckpointAt: 654.9,
            },
          ],
        });
        const observed: Array<{ id: string; params: Record<string, unknown> }> = [];
        const executeAsyncSingle: ExecuteAsyncSingleOverride = (id, params) => {
          observed.push({ id, params });
          return {
            content: [{ text: "stubbed continuation" }],
            details: { asyncId: "resume-runtime-forwarded" },
          };
        };
        try {
          const result = await makeExecutor(
            [makeAgent("echo", { maxExecutionTimeMs: 2_000 })],
            { execution: { maxRunTimeMs: 1_234 } },
            state,
            runSync,
            executeAsyncSingle,
          ).execute(
            "resume-runtime-forwarding-call",
            { action: "resume", id: runId, message: "Continue." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined);
          assert.equal(observed.length, 1);
          assert.match(observed[0]?.id ?? "", /^[0-9a-f]{8}$/);
          assert.equal(observed[0]?.params.timeoutMs, 1_234);
          assert.equal(observed[0]?.params.activeRuntimeMs, 322);
          assert.equal(observed[0]?.params.activeRuntimeCheckpointAt, 654);
          assert.equal(state.foregroundRuns.size, 0);
        } finally {
          fs.rmSync(sessionFile, { force: true });
        }
      },
    );

    it(
      "omits a disabled human timeout and resets successful resume runtime before spawning",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const runId = `resume-runtime-reset-${Date.now().toString(36)}`;
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`, "utf-8");
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        state.foregroundRuns.set(runId, {
          runId,
          mode: "single",
          state: "complete",
          cwd: tempDir,
          startedAt: 1,
          updatedAt: 2,
          children: [
            {
              agent: "echo",
              status: "completed",
              sessionFile,
              activeRuntimeMs: 9_001,
              activeRuntimeCheckpointAt: 777,
            },
          ],
        });
        const observed: Array<Record<string, unknown>> = [];
        const executeAsyncSingle: ExecuteAsyncSingleOverride = (_id, params) => {
          observed.push(params);
          return {
            content: [{ text: "stubbed continuation" }],
            details: { asyncId: "resume-runtime-reset" },
          };
        };
        try {
          const result = await makeExecutor(
            [makeAgent("echo", { maxExecutionTimeMs: 100 })],
            { execution: { maxRunTimeMs: false } },
            state,
            runSync,
            executeAsyncSingle,
          ).execute(
            "resume-runtime-reset-call",
            { action: "resume", id: runId, message: "Continue with a fresh budget." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined);
          assert.equal(observed.length, 1);
          assert.equal(observed[0]?.timeoutMs, undefined);
          assert.equal(observed[0]?.activeRuntimeMs, 0);
          assert.equal(Object.hasOwn(observed[0]!, "activeRuntimeCheckpointAt"), false);
          assert.equal(state.foregroundRuns.size, 0);
        } finally {
          fs.rmSync(sessionFile, { force: true });
        }
      },
    );

    it(
      "rejects an exhausted supervisor-paused resume before reading context or claiming",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const runId = `resume-supervisor-budget-${Date.now().toString(36)}`;
        const asyncDir = path.join(ASYNC_DIR, runId);
        const statusPath = path.join(asyncDir, "status.json");
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`, "utf-8");
        const activeRuntimeMs = 700;
        const activeRuntimeCheckpointAt = 600;
        const persistedStatus = {
          runId,
          mode: "single",
          state: "paused",
          steps: [
            {
              agent: "echo",
              status: "paused",
              sessionFile,
              pause: { kind: "awaiting_supervisor" },
              activeRuntimeMs,
              activeRuntimeCheckpointAt,
            },
          ],
          activeRuntimeMs,
          activeRuntimeCheckpointAt,
        };
        fs.writeFileSync(statusPath, JSON.stringify(persistedStatus), "utf-8");
        const beforeStatus = fs.readFileSync(statusPath);
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        state.foregroundRuns.set(runId, {
          runId,
          mode: "single",
          state: "paused",
          cwd: tempDir,
          startedAt: 1,
          updatedAt: 2,
          children: [
            {
              agent: "echo",
              status: "paused",
              sessionFile,
              pause: { kind: "awaiting_supervisor" },
              activeRuntimeMs,
              activeRuntimeCheckpointAt,
            },
          ],
        });
        const ctx = makeMinimalCtx(tempDir);
        let snapshotReads = 0;
        const originalGetAvailable = ctx.modelRegistry.getAvailable.bind(ctx.modelRegistry);
        ctx.modelRegistry.getAvailable = () => {
          snapshotReads += 1;
          return originalGetAvailable();
        };
        let continuationCalls = 0;
        const executeAsyncSingle: ExecuteAsyncSingleOverride = () => {
          continuationCalls += 1;
          throw new Error("continuation should not be invoked");
        };
        try {
          const result = await makeExecutor(
            [makeAgent("echo", { maxExecutionTimeMs: 500 })],
            { execution: { maxRunTimeMs: 10_000 } },
            state,
            runSync,
            executeAsyncSingle,
          ).execute(
            "resume-supervisor-budget-call",
            { action: "resume", id: runId, message: "Continue after the decision." },
            new AbortController().signal,
            undefined,
            ctx,
          );

          assert.equal(result.isError, true);
          assert.equal(
            result.content[0]?.text,
            "Agent 'echo' has exhausted its maxExecutionTimeMs ceiling after 700ms of active runtime.",
          );
          assert.equal(snapshotReads, 0);
          assert.equal(continuationCalls, 0);
          assert.equal(mockPi.callCount(), 0);
          assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
          assert.equal(state.foregroundRuns.size, 1);
        } finally {
          fs.rmSync(asyncDir, { recursive: true, force: true });
          fs.rmSync(sessionFile, { force: true });
        }
      },
    );

    it(
      "clamps an ordinary resume from runtime remembered by a real foreground pause",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ delay: 10_000 });
        mockPi.onCall({ output: "resumed" });
        const maxExecutionTimeMs = 5_000;
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const executor = makeExecutor([makeAgent("echo", { maxExecutionTimeMs })], {}, state);
        const runPromise = executor.execute(
          "producer-pause-run",
          { agent: "echo", task: "Pause after starting" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        const readyDeadline = Date.now() + 5_000;
        while (Date.now() < readyDeadline) {
          if (
            mockPi.callCount() === 1 &&
            typeof (
              [...state.foregroundControls.values()][0] as { interrupt?: unknown } | undefined
            )?.interrupt === "function"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await executor.execute(
          "producer-pause-interrupt",
          { action: "interrupt" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const paused = await runPromise;
        assert.equal(paused.isError, undefined);

        const remembered = [...state.foregroundRuns.values()][0];
        const activeRuntimeMs = remembered?.children[0]?.activeRuntimeMs;
        assert.ok(
          typeof activeRuntimeMs === "number" &&
            activeRuntimeMs > 0 &&
            activeRuntimeMs < maxExecutionTimeMs,
        );
        const result = await executor.execute(
          "resume-timeout-forwarding",
          { action: "resume", id: remembered!.runId, message: "Continue." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.equal(result.details?.timeoutMs, maxExecutionTimeMs - activeRuntimeMs);
        assert.ok(result.details?.deadlineAt !== undefined);
      },
    );

    it(
      "persists supervisor-pause runtime for a fresh-process resume",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        let statusPath: string | undefined;
        const maxExecutionTimeMs = 5_000;
        let pausingStatus: AsyncStatus | undefined;

        mockPi.onCall({
          ignoreSigint: true,
          ignoreSigterm: true,
          spawnStubbornDescendants: true,
          steps: [
            {
              delay: 150,
              jsonl: [
                events.toolStart("contact_supervisor", {
                  reason: "need_decision",
                  message: "Need a decision before continuing",
                }),
              ],
            },
            { delay: 10_000, jsonl: [events.assistantMessage("must not complete before pause")] },
          ],
        });

        const observedRunSync: ExecutionModule["runSync"] = async (
          runtimeCwd,
          agents,
          agentName,
          task,
          options,
        ) => {
          const callback =
            typeof options.onSupervisorPauseTransition === "function"
              ? (options.onSupervisorPauseTransition as (transition: unknown) => void)
              : undefined;
          return runSync!(runtimeCwd, agents, agentName, task, {
            ...options,
            onSupervisorPauseTransition: (transition: unknown) => {
              callback?.(transition);
              const stage =
                transition && typeof transition === "object" && "stage" in transition
                  ? transition.stage
                  : undefined;
              if (stage === "pausing") {
                for (const entry of fs.readdirSync(ASYNC_DIR, { withFileTypes: true })) {
                  if (!entry.isDirectory()) continue;
                  const candidatePath = path.join(ASYNC_DIR, entry.name, "status.json");
                  try {
                    const candidate = readPersistedStatus(candidatePath);
                    if (candidate.state === "pausing" && candidate.cwd === tempDir) {
                      statusPath = candidatePath;
                      pausingStatus = candidate;
                      break;
                    }
                  } catch {
                    // Ignore unrelated or transient status files while locating this run.
                  }
                }
              }
            },
          });
        };

        const initialState = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const initialExecutor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs })],
          {},
          initialState,
          observedRunSync,
        );
        const paused = await initialExecutor.execute(
          "supervisor-runtime-pause",
          { agent: "echo", task: "Pause while waiting for a supervisor decision" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(paused.isError, undefined);
        assert.ok(statusPath, "expected persisted status path before child cleanup");
        assert.ok(pausingStatus, "expected persisted pausing status before child cleanup");
        const pausingStep = pausingStatus.steps?.[0];
        const runId = pausingStatus.runId;
        assert.equal(pausingStatus.state, "pausing");
        assert.equal(pausingStep?.status, "pausing");
        assert.ok(
          typeof pausingStatus.activeRuntimeMs === "number" && pausingStatus.activeRuntimeMs > 0,
        );
        assert.equal(pausingStatus.activeRuntimeMs, pausingStep?.activeRuntimeMs);
        assert.ok(typeof pausingStatus.activeRuntimeCheckpointAt === "number");
        assert.equal(
          pausingStatus.activeRuntimeCheckpointAt,
          pausingStep?.activeRuntimeCheckpointAt,
        );
        assert.ok(
          (pausingStatus.activeRuntimeCheckpointAt ?? 0) >= (pausingStatus.pause?.requestedAt ?? 0),
        );

        const pausedStatus = readPersistedStatus(statusPath);
        assert.equal(pausedStatus.runId, runId);
        const pausedStep = pausedStatus.steps?.[0];
        assert.equal(pausedStatus.state, "paused");
        assert.equal(pausedStep?.status, "paused");
        assert.equal(pausedStatus.activeRuntimeMs, pausingStatus.activeRuntimeMs);
        assert.equal(pausedStep?.activeRuntimeMs, pausingStatus.activeRuntimeMs);
        assert.equal(
          pausedStatus.activeRuntimeCheckpointAt,
          pausingStatus.activeRuntimeCheckpointAt,
        );
        assert.equal(
          pausedStep?.activeRuntimeCheckpointAt,
          pausingStatus.activeRuntimeCheckpointAt,
        );
        assert.ok(
          (pausedStatus.pause?.pausedAt ?? 0) >= (pausedStatus.activeRuntimeCheckpointAt ?? 0),
        );
        assert.ok(
          (pausedStatus.pause?.pausedAt ?? 0) - (pausedStatus.activeRuntimeCheckpointAt ?? 0) >=
            100,
          "expected stubborn cleanup time after the runtime checkpoint",
        );

        const activeRuntimeMs = pausingStatus.activeRuntimeMs!;
        await new Promise((resolve) => setTimeout(resolve, 250));
        const offlineStatus = readPersistedStatus(statusPath);
        assert.equal(offlineStatus.activeRuntimeMs, activeRuntimeMs);
        assert.equal(
          offlineStatus.activeRuntimeCheckpointAt,
          pausingStatus.activeRuntimeCheckpointAt,
        );

        mockPi.onCall({ output: "resumed after restart" });
        const restartedState = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const resumed = await makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs })],
          {},
          restartedState,
        ).execute(
          "supervisor-runtime-resume",
          { action: "resume", id: runId, message: "Continue after the supervisor responds." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(restartedState.foregroundRuns.size, 0);
        assert.equal(resumed.isError, undefined);
        assert.equal(resumed.details?.timeoutMs, maxExecutionTimeMs - activeRuntimeMs);
        const resumedId = resumed.details?.asyncId;
        assert.ok(resumedId, "expected resumed async id");
        const resumedPayload = JSON.parse(
          fs.readFileSync(await waitForAsyncResultFile(resumedId), "utf-8"),
        ) as unknown;
        assert.ok(
          resumedPayload && typeof resumedPayload === "object" && !Array.isArray(resumedPayload),
        );
        assert.equal((resumedPayload as Record<string, unknown>).state, "complete");
        assert.equal((resumedPayload as Record<string, unknown>).success, true);
      },
    );

    it(
      "blocks unsafe foreground durable resume at the atomic claim boundary without spawning",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const runId = `foreground-context-race-${Date.now().toString(36)}`;
        const asyncDir = path.join(ASYNC_DIR, runId);
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`);
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        state.foregroundRuns.set(runId, {
          runId,
          mode: "single",
          state: "paused",
          cwd: tempDir,
          startedAt: 1,
          updatedAt: 1,
          children: [
            {
              agent: "echo",
              status: "paused",
              sessionFile,
              pause: { kind: "awaiting_supervisor" },
              contextUsage: { contextTokens: 799, contextWindow: 1000, peakTokens: 799 },
            },
          ],
        });
        fs.writeFileSync(
          path.join(asyncDir, "status.json"),
          JSON.stringify({
            runId,
            mode: "single",
            state: "paused",
            steps: [
              {
                agent: "echo",
                status: "paused",
                sessionFile,
                pause: { kind: "awaiting_supervisor" },
                contextUsage: { contextTokens: 800, contextWindow: 1000, peakTokens: 800 },
              },
            ],
          }),
          "utf-8",
        );
        const statusPath = path.join(asyncDir, "status.json");
        const beforeStatus = fs.readFileSync(statusPath);
        const beforeSession = fs.readFileSync(sessionFile);
        try {
          const result = await makeExecutor([makeAgent("echo")], {}, state).execute(
            "foreground-context-race-resume",
            { action: "resume", id: runId, message: "Continue." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );
          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", /used tokens 800/);
          assert.match(result.content[0]?.text ?? "", /80\.00%/);
          assert.equal(mockPi.callCount(), 0);
          assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
          assert.deepEqual(fs.readFileSync(sessionFile), beforeSession);
          assert.equal(
            (JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { lifecycle?: unknown }).lifecycle,
            undefined,
          );
        } finally {
          fs.rmSync(asyncDir, { recursive: true, force: true });
          fs.rmSync(sessionFile, { force: true });
        }
      },
    );

    it(
      "rejects an ordinary resume once accumulated runtime exhausts the agent ceiling",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        // The run phase and the resume phase deliberately use different ceilings.
        // A generous run ceiling means the child reaches a terminal failure on its
        // own instead of racing a kill, so activeRuntimeMs is a real duration
        // (>= runDelayMs). Non-success terminal runs retain that budget; a
        // successful completion would intentionally reset it before revival.
        // The resume ceiling is far below that duration, so
        // remainingExecutionTimeMs(resumeCeilingMs, activeRuntimeMs) is 0 and the
        // pre-spawn guard rejects the resume. CPU contention only makes
        // activeRuntimeMs larger, which pushes the precondition further into the
        // passing region rather than the failing one.
        const runDelayMs = 150;
        const runCeilingMs = 10_000;
        const resumeCeilingMs = 50;
        mockPi.onCall({
          delay: runDelayMs,
          output: "finished under the generous ceiling",
          exitCode: 1,
        });
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const executor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: runCeilingMs })],
          {},
          state,
        );
        const completed = await executor.execute(
          "producer-exhausted-run",
          { agent: "echo", task: "Run under a generous ceiling" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(completed.isError, true);
        assert.match(completed.content[0]?.text ?? "", /Child process exited with code 1/);

        const remembered = [...state.foregroundRuns.values()][0];
        const activeRuntimeMs = remembered?.children[0]?.activeRuntimeMs;
        assert.ok(typeof activeRuntimeMs === "number" && activeRuntimeMs >= resumeCeilingMs);
        // Same run state, but the agent is now declared with a ceiling the run has
        // already burned through.
        const resumeExecutor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: resumeCeilingMs })],
          {},
          state,
        );
        const result = await resumeExecutor.execute(
          "resume-ceiling-exhausted",
          { action: "resume", id: remembered!.runId, message: "Continue." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(
          result.content[0]?.text ?? "",
          new RegExp(`exhausted its maxExecutionTimeMs ceiling after ${activeRuntimeMs}ms`),
        );
        assert.equal(mockPi.callCount(), 1);
      },
    );

    it(
      "resets the logical runtime budget after successful completion before resume",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const resumeCeilingMs = 10_000;
        const consumedSourceRuntimeMs = resumeCeilingMs + 1_000;
        mockPi.onCall({ output: "completed successfully" });
        mockPi.onCall({ delay: 250, output: "fresh follow-up" });
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const initialExecutor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: 10_000 })],
          {},
          state,
        );
        const completed = await initialExecutor.execute(
          "producer-successful-run",
          { agent: "echo", task: "Complete successfully before resuming" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(completed.isError, undefined);

        const remembered = [...state.foregroundRuns.values()][0];
        assert.ok(remembered, "expected the successful source to be remembered");
        const source = remembered.children[0];
        assert.ok(source, "expected the successful source child to be remembered");
        assert.equal(source.status, "completed");
        source.activeRuntimeMs = consumedSourceRuntimeMs;
        assert.equal(source.activeRuntimeMs, consumedSourceRuntimeMs);
        assert.ok(
          source.activeRuntimeMs > resumeCeilingMs,
          `expected injected source runtime to exceed the ${resumeCeilingMs}ms resume ceiling`,
        );

        const resumeExecutor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: resumeCeilingMs })],
          {},
          state,
        );
        const resumed = await resumeExecutor.execute(
          "resume-after-success",
          { action: "resume", id: remembered!.runId, message: "Continue with a fresh budget." },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.equal(resumed.isError, undefined);
        assert.ok(resumed.details?.asyncId, "expected resumed async id");
        const resumedPayload = JSON.parse(
          fs.readFileSync(await waitForAsyncResultFile(resumed.details.asyncId!), "utf-8"),
        ) as {
          state?: string;
          success?: boolean;
          error?: string;
          results?: Array<{ output?: string; error?: string }>;
        };
        assert.equal(
          resumedPayload.state,
          "complete",
          `successful completion reset should allow resume: state=${resumedPayload.state}, error=${resumedPayload.error ?? resumedPayload.results?.[0]?.error ?? "none"}`,
        );
        assert.equal(resumedPayload.success, true);
        assert.match(resumedPayload.results?.[0]?.output ?? "", /fresh follow-up/);
        assert.equal(mockPi.callCount(), 2);
      },
    );

    it("treats forced drain after final assistant output as cleanup success", async () => {
      mockPi.onCall({
        jsonl: [events.assistantMessage("done-before-drain")],
        stderr: "Done after 1 turn(s). Ready for input.\n",
        keepAliveAfterFinalMessageMs: 10000,
      });
      const agents = makeAgentConfigs(["echo"]);

      const start = Date.now();
      const result = await runSync(tempDir, agents, "echo", "Task", {});
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "done-before-drain");
      assert.ok(
        !(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")),
      );
    });

    it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
            },
          },
        ],
        keepAliveAfterFinalMessageMs: 10000,
      });
      const agents = makeAgentConfigs(["echo"]);

      const start = Date.now();
      const result = await runSync(tempDir, agents, "echo", "Task", {});
      const elapsed = Date.now() - start;

      assert.ok(
        elapsed < 4000,
        `should clean up shortly after empty terminal stop, took ${elapsed}ms`,
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "");
      assert.equal(result.progress.status, "completed");
      assert.ok(
        !(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")),
      );
    });

    it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "failed" }],
              model: "mock/test-model",
              stopReason: "stop",
              errorMessage: "provider exploded",
              usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
            },
          },
        ],
        keepAliveAfterFinalMessageMs: 10000,
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "provider exploded");
      assert.equal(result.progress.status, "failed");
    });

    it("handles abort signal (completes faster than delay)", async () => {
      mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();

      const start = Date.now();
      setTimeout(() => controller.abort(), 200);

      await runSync(tempDir, agents, "slow", "Slow task", {
        signal: controller.signal,
      });
      const elapsed = Date.now() - start;

      // The key assertion: the run should complete much faster than the 10s delay,
      // proving the abort signal terminated the process early.
      assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
      // Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
    });

    it("marks foreground runs that exceed timeoutMs as timed out", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.assistantMessage("partial timeout update"),
              events.toolStart("read", { path: "README.md" }),
            ],
          },
          { delay: 10000 },
        ],
      });
      const agents = makeAgentConfigs(["slow"]);

      const start = Date.now();
      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-single",
        timeoutMs: 150,
      });
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.timedOut, true);
      assert.equal(result.error, "Subagent timed out after 150ms.");
      assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
      assert.match(result.finalOutput ?? "", /Run id: timeout-single/);
      assert.match(result.finalOutput ?? "", /Current tool: read/);
      assert.match(result.finalOutput ?? "", /Current path: README\.md/);
      assert.match(result.finalOutput ?? "", /Recent child output:\n- partial timeout update/);
      assert.equal(result.progress.status, "failed");
    });

    it("applies the agent execution ceiling to foreground timeouts", async () => {
      mockPi.onCall({
        steps: [{ jsonl: [events.assistantMessage("partial timeout update")] }, { delay: 10000 }],
      });
      const agents = [makeAgent("slow", { maxExecutionTimeMs: 75 })];

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-single-agent-ceiling",
        timeoutMs: 150,
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.error, "Subagent timed out after 75ms.");
    });

    it("does not fire or retain an above-Node-boundary foreground ceiling", async () => {
      mockPi.onCall({ output: "completed under long ceiling" });
      const agents = [makeAgent("long", { maxExecutionTimeMs: 2_147_483_648 })];

      const result = await runSync(tempDir, agents, "long", "Quick task", {
        runId: "timeout-single-above-node-boundary",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, undefined);
      assert.equal(result.finalOutput, "completed under long ceiling");
    });

    it("keeps a shorter foreground caller timeout below the agent ceiling", async () => {
      mockPi.onCall({ delay: 10000 });
      const agents = [makeAgent("slow", { maxExecutionTimeMs: 150 })];

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-single-caller-shorter",
        timeoutMs: 75,
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.error, "Subagent timed out after 75ms.");
    });

    it("writes timeout metadata with the resolved session file before artifact finalization", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.assistantMessage("partial output before timeout"),
              events.toolStart("read", { path: "src/runs/foreground/execution.ts" }),
            ],
          },
          { delay: 10000 },
        ],
      });
      const agents = makeAgentConfigs(["slow"]);
      const sessionFile = path.join(tempDir, "child-session.jsonl");
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-artifact-metadata",
        timeoutMs: 150,
        sessionFile,
        artifactsDir,
        artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.sessionFile, sessionFile);
      assert.ok(result.artifactPaths, "should have artifact paths");
      const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
      assert.match(artifactText, /Subagent timed out after 150ms\./);
      assert.match(artifactText, /Run id: timeout-artifact-metadata/);
      assert.match(
        artifactText,
        new RegExp(`Session file: ${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
      assert.match(
        artifactText,
        new RegExp(
          `Artifact output: ${result.artifactPaths.outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
      assert.match(artifactText, /Recent child output:\n- partial output before timeout/);

      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        timedOut?: boolean;
        sessionFile?: string;
      };
      assert.equal(metadata.timedOut, true);
      assert.equal(metadata.sessionFile, sessionFile);
    });

    it("does not advertise a jsonl timeout artifact when includeJsonl is false", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.assistantMessage("partial output before timeout"),
              events.toolStart("read", { path: "src/runs/foreground/execution.ts" }),
            ],
          },
          { delay: 10000 },
        ],
      });
      const agents = makeAgentConfigs(["slow"]);
      const artifactsDir = path.join(tempDir, "artifacts-no-jsonl");

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-no-jsonl-artifact",
        timeoutMs: 150,
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeOutput: true,
          includeMetadata: true,
          includeJsonl: false,
        },
      });

      assert.equal(result.timedOut, true);
      assert.ok(result.artifactPaths, "should have artifact paths");
      const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
      assert.doesNotMatch(artifactText, /Artifact jsonl:/);
    });

    it("does not advertise an output timeout artifact when includeOutput is false", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.assistantMessage("partial output before timeout"),
              events.toolStart("read", { path: "src/runs/foreground/execution.ts" }),
            ],
          },
          { delay: 10000 },
        ],
      });
      const agents = makeAgentConfigs(["slow"]);
      const artifactsDir = path.join(tempDir, "artifacts-no-output");

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-no-output-artifact",
        timeoutMs: 150,
        artifactsDir,
        artifactConfig: { enabled: true, includeOutput: false, includeMetadata: true },
      });

      assert.equal(result.timedOut, true);
      assert.doesNotMatch(result.finalOutput ?? "", /Artifact output:/);
    });

    it("does not add sessionFile to non-timeout metadata", async () => {
      mockPi.onCall({ output: "Hello from mock agent" });
      const agents = makeAgentConfigs(["echo"]);
      const sessionFile = path.join(tempDir, "child-session-success.jsonl");
      const artifactsDir = path.join(tempDir, "artifacts-success-session-metadata");

      const result = await runSync(tempDir, agents, "echo", "Say hello", {
        runId: "success-session-metadata",
        sessionFile,
        artifactsDir,
        artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.sessionFile, sessionFile);
      assert.ok(result.artifactPaths, "should have artifact paths");
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        timedOut?: boolean;
        sessionFile?: string;
      };
      assert.equal(metadata.timedOut, undefined);
      assert.equal(metadata.sessionFile, undefined);
    });

    it("does not run acceptance verification after a foreground timeout", async () => {
      const markerPath = path.join(tempDir, "verify-ran.txt");
      const report = [
        "done",
        "```acceptance-report",
        JSON.stringify({
          criteriaSatisfied: [
            { id: "criterion-1", status: "satisfied", evidence: "integration test evidence" },
          ],
          changedFiles: ["src/a.ts"],
          testsAddedOrUpdated: ["test/a.test.ts"],
          commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
          validationOutput: ["validation passed"],
          residualRisks: [],
          noStagedFiles: true,
          notes: "complete",
        }),
        "```",
      ].join("\n");
      mockPi.onCall({
        jsonl: [events.assistantMessage(report)],
        keepAliveAfterFinalMessageMs: 10000,
      });
      const agents = makeAgentConfigs(["slow"]);

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        timeoutMs: 150,
        acceptance: {
          level: "verified",
          verify: [
            {
              id: "marker",
              command:
                "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
              env: { VERIFY_MARKER: markerPath },
              timeoutMs: 10_000,
            },
          ],
        },
      });

      assert.equal(result.timedOut, true);
      assert.equal(result.acceptance?.status, "rejected");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
      assert.equal(result.acceptance?.verifyRuns?.length, 0);
      assert.equal(fs.existsSync(markerPath), false);
    });

    it("appends the acceptance digest to the artifact but not to finalOutput for timed-out runs", async () => {
      // Regression: the timeout branch unconditionally replaced the artifact content with
      // plain timeoutDiagnostics, discarding the digest that was appended at the earlier
      // artifact-set site. finalOutput must stay exactly timeoutDiagnostics; the artifact
      // copy is the only surface that receives the digest.
      const reportBody = JSON.stringify({
        criteriaSatisfied: [
          { id: "criterion-1", status: "satisfied", evidence: "integration test evidence" },
        ],
        changedFiles: ["src/a.ts"],
        testsAddedOrUpdated: ["test/a.test.ts"],
        commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
        validationOutput: ["validation passed"],
        residualRisks: [],
        noStagedFiles: true,
      });
      const report = ["Done", "```acceptance-report", reportBody, "```"].join("\n");
      // Verify timeout artifact semantics, not 150ms latency: scale both budgets so
      // the report arrives before timeout while the mock remains alive past it; keep
      // the report non-terminal so the fixed 1s final-stop drain cannot win.
      const timeoutMs = scaleTestTimeout(1_000);
      const keepAliveAfterFinalMessageMs = scaleTestTimeout(10_000);
      mockPi.onCall({
        jsonl: [mockAssistantMessage(report, "tool_use")],
        keepAliveAfterFinalMessageMs,
      });
      const agents = makeAgentConfigs(["slow"]);
      const digestArtifactsDir = path.join(tempDir, "artifacts-timeout-digest");

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "timeout-digest-split",
        timeoutMs,
        artifactsDir: digestArtifactsDir,
        artifactConfig: { enabled: true, includeOutput: true, includeMetadata: false },
      });

      assert.equal(result.timedOut, true);
      // finalOutput must be exactly the timeout diagnostics — no digest
      assert.match(result.finalOutput ?? "", /Recovery diagnostics:/);
      assert.doesNotMatch(
        result.finalOutput ?? "",
        /Validation evidence \(from acceptance report\):/,
      );
      // The artifact must carry the digest
      assert.ok(result.artifactPaths, "should have artifact paths");
      const artifactContent = fs.readFileSync(result.artifactPaths!.outputPath, "utf-8");
      assert.match(artifactContent, /Validation evidence \(from acceptance report\):/);
      // The artifact starts with the timeout diagnostics content (finalOutput is the prefix)
      assert.ok(
        artifactContent.startsWith(result.finalOutput!),
        `artifact should start with finalOutput (timeout diagnostics); finalOutput=${JSON.stringify(result.finalOutput?.slice(0, 200))}`,
      );
    });

    // Foreground interruption and supervisor pause coverage lives in
    // single-execution-supervisor-pause.test.ts.

    it("handles stderr without exit code as info (not error)", async () => {
      mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.exitCode, 0);
    });
  },
);
