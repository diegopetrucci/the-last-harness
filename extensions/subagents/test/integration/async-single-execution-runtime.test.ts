/**
 * Async-path integration tests for runtime ceilings, resume budgets and durable resume.
 *
 * Provenance (tlhf-60wy): ported from single-execution-runtime.test.ts, which drove both runSync and
 * executor.execute(). Tests here go through the background path; shared
 * invariants that were runSync-driven were ported to background or shared-helper
 * tests (e.g. async-execution-lifecycle-interruptions, async-execution-runner-deadlines-process-failures). Only assertions on the removed foreground result/callback
 * shapes were dropped.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MockPi } from "../support/helpers.ts";
import {
  createMockPi,
  createTempDir,
  createEventBus,
  removeTempDir,
  makeAgent,
  makeMinimalCtx,
  makeModel,
} from "../support/helpers.ts";
import {
  available,
  createSubagentExecutor,
  type ExecuteAsyncSingleOverride,
} from "../support/single-execution-fixtures.ts";
import {
  ASYNC_DIR,
  RESULTS_DIR,
  SUBAGENT_ASYNC_STARTED_EVENT,
  getAsyncConfigPath,
} from "../../src/shared/types.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import {
  buildSkippedAcceptanceLedger,
  resolveEffectiveAcceptance,
} from "../../src/runs/shared/acceptance.ts";
import type { SubagentRunConfig } from "../../src/runs/shared/parallel-utils.ts";
import {
  buildSubagentRunTelemetry,
  type SubagentTelemetryProvenance,
} from "../../src/shared/telemetry.ts";
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";

describe(
  "async single dispatch — runtime ceilings and resume budgets",
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

    function pausedAcceptanceLedger() {
      return buildSkippedAcceptanceLedger({
        acceptance: resolveEffectiveAcceptance({
          agentName: "echo",
          task: "Resume the paused child.",
          mode: "single",
        }),
        ledgerStatus: "skipped",
        runtimeCheckStatus: "not-applicable",
        id: "paused",
        message: "Acceptance will run after resume.",
      });
    }

    function makeExecutor(
      agents = [makeAgent("echo")],
      config: Record<string, unknown> = {},
      state = {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
      },
      executeAsyncSingleOverride: ExecuteAsyncSingleOverride | undefined = undefined,
      telemetryProvenance: SubagentTelemetryProvenance | undefined = undefined,
      piOverride:
        | { events: ReturnType<typeof createEventBus>; getSessionName: () => undefined }
        | undefined = undefined,
    ) {
      return createSubagentExecutor!({
        pi: piOverride ?? { events: createEventBus(), getSessionName: () => undefined },
        state,
        config,
        tempArtifactsDir: tempDir,
        getSubagentSessionRoot: () => tempDir,
        expandTilde: (value: string) => value,
        discoverAgents: () => ({ agents }),
        executeAsyncSingle: executeAsyncSingleOverride,
        telemetryProvenance,
      });
    }

    it(
      "uses the human-owned run ceiling for async execution",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        // After async-only: the ceiling is forwarded to executeAsyncSingle as timeoutMs;
        // spy via executeAsyncSingleOverride instead of the retired runSync wrapper.
        const observedTimeouts: Array<number | undefined> = [];
        const spyExecuteAsync: ExecuteAsyncSingleOverride = (_id, params) => {
          observedTimeouts.push(params.timeoutMs as number | undefined);
          return {
            content: [{ text: "policy-stubbed" }],
            details: { asyncId: "policy-stubbed-id" },
          };
        };
        const executor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: 2_000 })],
          { execution: { maxRunTimeMs: 1_234 } },
          undefined,
          spyExecuteAsync,
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
        // After async-only: when maxRunTimeMs is false, the executor passes
        // timeoutMs=undefined to executeAsyncSingle, and the role ceiling
        // (agentConfig.maxExecutionTimeMs) is enforced inside executeAsyncSingle
        // via resolveAsyncSingleRuntimePolicy — not at the executor boundary.
        // Verify that the agent config carries the correct role ceiling to the async
        // call; the effective timeout enforcement is tested in async-execution tests.
        const observedMaxExecutionTime: Array<number | undefined> = [];
        const spyExecuteAsync: ExecuteAsyncSingleOverride = (_id, params) => {
          const agentCfg = params.agentConfig as { maxExecutionTimeMs?: number } | undefined;
          observedMaxExecutionTime.push(agentCfg?.maxExecutionTimeMs);
          return {
            content: [{ text: "role-policy-stubbed" }],
            details: { asyncId: "role-policy-stubbed-id" },
          };
        };
        const executor = makeExecutor(
          [makeAgent("echo", { maxExecutionTimeMs: 600 })],
          { execution: { maxRunTimeMs: false } },
          undefined,
          spyExecuteAsync,
        );

        const result = await executor.execute(
          "timeout-policy-role",
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.deepEqual(observedMaxExecutionTime, [600]);
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
        const details: NonNullable<
          Awaited<ReturnType<ReturnType<typeof makeExecutor>["execute"]>>["details"]
        > = { results: [] };
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
      "carries source telemetry provenance and continuation lineage through an async resume",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const sourceRunId = `resume-telemetry-${Date.now().toString(36)}-${process.pid}`;
        const asyncDir = path.join(ASYNC_DIR, sourceRunId);
        const sessionFile = path.join(asyncDir, "source-session.jsonl");
        const sourceProvenance: SubagentTelemetryProvenance = {
          tlhVersion: "source-tlh",
          piVersion: "source-pi",
          installGeneration: "source-generation",
          loadedAt: 101,
        };
        const currentProvenance: SubagentTelemetryProvenance = {
          tlhVersion: "current-tlh",
          piVersion: "current-pi",
          installGeneration: "current-generation",
          loadedAt: 202,
        };
        const sourceTelemetry = buildSubagentRunTelemetry({
          runId: sourceRunId,
          execution: "async",
          mode: "single",
          steps: [
            {
              index: 0,
              agent: "echo",
              outcome: { state: "completed" },
            },
          ],
          provenance: sourceProvenance,
          controls: {
            needsAttentionAfterMs: 30_000,
            failedToolAttemptsBeforeAttention: 3,
            notifyOn: ["needs_attention"],
            notifyChannels: ["event"],
          },
          startedAt: 1_000,
          endedAt: 1_100,
          outcome: { state: "completed" },
        });
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${sourceRunId}"}\n`, "utf-8");
        const status: AsyncStatus = {
          runId: sourceRunId,
          mode: "single",
          state: "complete",
          startedAt: 1_000,
          endedAt: 1_100,
          cwd: tempDir,
          steps: [
            {
              agent: "echo",
              status: "complete",
              startedAt: 1_000,
              endedAt: 1_100,
              sessionFile,
              exitCode: 0,
            },
          ],
          telemetry: sourceTelemetry,
        };
        fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");

        const pi = { events: createEventBus(), getSessionName: () => undefined };
        let continuationRunId: string | undefined;
        let observedConfig: SubagentRunConfig | undefined;
        pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
          const id = (payload as { id?: unknown }).id;
          if (typeof id !== "string") return;
          continuationRunId = id;
          const configPath = getAsyncConfigPath(id);
          if (fs.existsSync(configPath)) {
            observedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as SubagentRunConfig;
          }
        });
        mockPi.onCall({ output: "resumed continuation complete" });
        try {
          const result = await makeExecutor(
            [makeAgent("echo")],
            {},
            undefined,
            undefined,
            currentProvenance,
            pi,
          ).execute(
            "resume-telemetry-call",
            { action: "resume", id: sourceRunId, message: "Continue with telemetry context." },
            new AbortController().signal,
            undefined,
            makeMinimalCtx(tempDir),
          );

          assert.equal(result.isError, undefined);
          assert.ok(continuationRunId);
          assert.ok(observedConfig);
          assert.deepEqual(observedConfig.telemetry?.provenance, sourceProvenance);
          assert.deepEqual(observedConfig.telemetry?.lineage, {
            continuationFrom: { sourceRunId, sourceStepIndex: 0 },
          });
          const persisted = JSON.parse(
            fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
          ) as AsyncStatus;
          assert.deepEqual(persisted.telemetry?.provenance, sourceProvenance);
          assert.deepEqual(persisted.telemetry?.lineage?.continuations, [
            { sourceStepIndex: 0, continuationRunId },
          ]);
          await waitForAsyncResultFile(continuationRunId);
        } finally {
          fs.rmSync(asyncDir, { recursive: true, force: true });
          if (continuationRunId) {
            fs.rmSync(path.join(ASYNC_DIR, continuationRunId), { recursive: true, force: true });
            fs.rmSync(path.join(RESULTS_DIR, `${continuationRunId}.json`), { force: true });
          }
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
        const acceptance = pausedAcceptanceLedger();
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
              acceptance,
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
              acceptance,
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
      "blocks unsafe foreground durable resume at the atomic claim boundary without spawning",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const runId = `foreground-context-race-${Date.now().toString(36)}`;
        const asyncDir = path.join(ASYNC_DIR, runId);
        const sessionFile = path.join(tempDir, `${runId}.jsonl`);
        const acceptance = pausedAcceptanceLedger();
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`);
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
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
              acceptance,
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
                acceptance,
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
      "routes durable foreground resume context through canonical developer and native worker policies",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const model = makeModel("large-model", {
          provider: "route-test",
          contextWindow: 200_000,
        });
        Object.defineProperty(model, Symbol.for("the-last-harness.model-context-window-policy"), {
          value: {
            nativeContextWindow: 1_000_000,
            developerChildContextWindow: 272_000,
          },
        });
        const modelReference = `${model.provider}/${model.id}`;

        for (const [role, canonicalDeveloper] of [
          ["developer", true],
          ["worker", false],
        ] as const) {
          const runId = `foreground-context-route-${role}-${Date.now().toString(36)}`;
          const asyncDir = path.join(ASYNC_DIR, runId);
          const sessionFile = path.join(tempDir, `${runId}.jsonl`);
          const acceptance = pausedAcceptanceLedger();
          const contextUsage = {
            contextTokens: 220_000,
            contextWindow: 1_000_000,
            peakTokens: 220_000,
          };
          fs.mkdirSync(asyncDir, { recursive: true });
          fs.writeFileSync(sessionFile, `{"type":"session","id":"${runId}"}\n`);
          const state = {
            baseCwd: tempDir,
            currentSessionId: null,
            asyncJobs: new Map(),
            foregroundRuns: new Map(),
          };
          const agent =
            role === "developer"
              ? makeAgent("developer", {
                  model: modelReference,
                  filePath: path.join(getAgentDir(), "tlh", "agents", "subagents", "developer.md"),
                })
              : makeAgent("worker", { model: modelReference });
          state.foregroundRuns.set(runId, {
            runId,
            mode: "single",
            state: "paused",
            cwd: tempDir,
            startedAt: 1,
            updatedAt: 2,
            children: [
              {
                agent: role,
                status: "paused",
                sessionFile,
                pause: { kind: "awaiting_supervisor" },
                contextUsage,
                acceptance,
              },
            ],
          });
          const statusPath = path.join(asyncDir, "status.json");
          fs.writeFileSync(
            statusPath,
            JSON.stringify({
              runId,
              mode: "single",
              state: "paused",
              steps: [
                {
                  agent: role,
                  status: "paused",
                  sessionFile,
                  pause: { kind: "awaiting_supervisor" },
                  contextUsage,
                  acceptance,
                },
              ],
            }),
            "utf-8",
          );
          const beforeStatus = fs.readFileSync(statusPath);
          const observed: Array<Record<string, unknown>> = [];
          const executeAsyncSingle: ExecuteAsyncSingleOverride = (id, params) => {
            observed.push({ id, ...params });
            return {
              content: [{ text: "stubbed continuation" }],
              details: { asyncId: `continued-${role}` },
            };
          };

          try {
            const ctx = makeMinimalCtx(tempDir);
            ctx.model = model;
            ctx.modelRegistry.getAvailable = () => [model];
            const result = await makeExecutor([agent], {}, state, executeAsyncSingle).execute(
              `foreground-context-route-resume-${role}`,
              { action: "resume", id: runId, message: "Continue." },
              new AbortController().signal,
              undefined,
              ctx,
            );

            if (canonicalDeveloper) {
              assert.equal(result.isError, true);
              assert.match(result.content[0]?.text ?? "", /context window 272000/);
              assert.equal(observed.length, 0);
              assert.deepEqual(fs.readFileSync(statusPath), beforeStatus);
              assert.equal(state.foregroundRuns.size, 1);
            } else {
              assert.equal(result.isError, undefined);
              assert.equal(observed.length, 1);
              const availableModels = observed[0]?.availableModels as
                | Array<Record<string, unknown>>
                | undefined;
              assert.equal(availableModels?.[0]?.nativeContextWindow, 1_000_000);
              assert.equal(availableModels?.[0]?.developerChildContextWindow, 272_000);
              assert.equal(state.foregroundRuns.size, 0);
            }
          } finally {
            fs.rmSync(asyncDir, { recursive: true, force: true });
            fs.rmSync(sessionFile, { force: true });
          }
        }
      },
    );
  },
);
