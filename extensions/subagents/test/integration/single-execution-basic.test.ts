/** Basic foreground execution, output, controls, and identity coverage. */

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
  makeModel,
  events,
} from "../support/helpers.ts";
import {
  available,
  runSync,
  createSubagentExecutor,
  type MockPiCallRecord,
  type ExecutionModule,
  type ExecuteAsyncSingleOverride,
} from "../support/single-execution-fixtures.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";
import {
  getFinalOutput,
  escapeRegExp,
  mockAssistantMessage,
  type RunSyncResult,
} from "../support/single-execution-fixtures.ts";
import type { ContextUsageDiagnostics } from "../../src/shared/types.ts";

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

    function readCall(): {
      args: string[];
      systemPrompts: NonNullable<MockPiCallRecord["systemPrompts"]>;
    } {
      const callFile = fs
        .readdirSync(mockPi.dir)
        .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
        .sort()
        .at(-1);
      assert.ok(callFile, "expected a recorded mock pi call");
      const payload = JSON.parse(
        fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"),
      ) as MockPiCallRecord;
      assert.ok(Array.isArray(payload.args), "expected recorded args");
      return { args: payload.args, systemPrompts: payload.systemPrompts ?? [] };
    }

    function readCallArgs(): string[] {
      return readCall().args;
    }

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
    it("spawns agent and captures output", async () => {
      mockPi.onCall({ output: "Hello from mock agent" });
      const agents = makeAgentConfigs(["echo"]);

      const sessionFile = path.join(tempDir, "child-session.jsonl");
      const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

      assert.equal(result.exitCode, 0);
      assert.equal(result.agent, "echo");
      assert.equal(result.sessionFile, sessionFile);
      assert.ok(result.messages.length > 0, "should have messages");

      const output = getFinalOutput(result.messages);
      assert.equal(output, "Hello from mock agent");
    });

    it("propagates the packaged child identity through a foreground single launch", async () => {
      mockPi.onCall({ echoEnv: [SUBAGENT_CHILD_AGENT_ENV] });
      const result = await runSync(
        tempDir,
        [makeAgent("developer")],
        "developer",
        "Echo the packaged child identity.",
        {},
      );

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(getFinalOutput(result.messages)), {
        [SUBAGENT_CHILD_AGENT_ENV]: "developer",
      });
    });

    it("emits verified provenance only for the canonical foreground agent config", async () => {
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      const previousGuidanceMarker = process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
      const agentDir = path.join(tempDir, "profile");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";
      try {
        mockPi.onCall({ echoEnv: [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] });
        const canonical = makeAgent("developer", {
          filePath: path.join(agentDir, "tlh", "agents", "subagents", "developer.md"),
        });
        const verified = await runSync(
          tempDir,
          [canonical],
          "developer",
          "Echo verified provenance.",
          {},
        );
        assert.equal(verified.exitCode, 0);
        assert.deepEqual(JSON.parse(getFinalOutput(verified.messages)), {
          [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "1",
        });

        mockPi.onCall({ echoEnv: [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] });
        const collision = await runSync(
          tempDir,
          [
            makeAgent("developer", {
              filePath: path.join(tempDir, "custom", "developer.md"),
            }),
          ],
          "developer",
          "Echo disabled provenance.",
          {},
        );
        assert.equal(collision.exitCode, 0);
        assert.deepEqual(JSON.parse(getFinalOutput(collision.messages)), {
          [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "0",
        });
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousGuidanceMarker === undefined)
          delete process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
        else process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = previousGuidanceMarker;
      }
    });

    it("propagates each packaged child identity through a foreground parallel launch", async () => {
      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      const executor = makeExecutor([makeAgent("developer"), makeAgent("code-reviewer")]);
      const result = await executor.execute(
        "parallel-packaged-identities",
        {
          tasks: [
            { agent: "developer", task: "Echo the developer identity." },
            { agent: "code-reviewer", task: "Echo the code-reviewer identity." },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      assert.deepEqual(
        result.details?.results?.map((child) => JSON.parse(child.finalOutput ?? "{}")),
        [
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "developer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "0",
          },
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "code-reviewer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "0",
          },
        ],
      );
    });

    it("classifies the #456 empty terminal as context exhausted and persists failure metadata", async () => {
      const artifactsDir = path.join(tempDir, "context-exhausted-artifacts");
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call-456", name: "edit", arguments: { path: "a.ts" } },
              ],
              model: "mock/test-model",
              stopReason: "toolUse",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "  " }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
        ],
      });
      const result = await runSync(
        tempDir,
        [makeAgent("worker", { model: "mock/test-model", completionGuard: false })],
        "worker",
        "Finish the edit.",
        {
          runId: "context-exhausted-foreground",
          acceptance: false,
          artifactsDir,
          artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
          availableModels: [
            { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
          ],
        },
      );

      assert.equal(result.exitCode, 1);
      assert.equal(result.terminationReason, "context_exhausted");
      assert.equal(result.contextUsage?.contextPercent, 99);
      assert.ok(result.artifactPaths, "expected persisted artifacts");
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        exitCode?: number;
        error?: string;
        terminationReason?: string;
        contextPressure?: RunSyncResult["contextPressure"];
        contextPressureCrossedThresholds?: string[];
      };
      const artifactText = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
      assert.equal(result.finalOutput, "");
      assert.equal(artifactText, result.error);
      assert.equal(
        artifactText,
        "Subagent stopped with an unfinished tool interaction under high context pressure.",
      );
      assert.equal(artifactText.match(/unfinished tool interaction/g)?.length, 1);
      assert.equal(metadata.exitCode, result.exitCode);
      assert.equal(metadata.error, result.error);
      assert.equal(metadata.terminationReason, result.terminationReason);
      assert.equal(metadata.exitCode, 1);
      assert.equal(metadata.terminationReason, "context_exhausted");
      assert.equal(metadata.contextPressure?.severity, "critical");
      assert.deepEqual(metadata.contextPressureCrossedThresholds, ["warning", "critical"]);
      assert.deepEqual(metadata.contextPressure, result.contextPressure);
      assert.deepEqual(
        metadata.contextPressureCrossedThresholds,
        result.contextPressureCrossedThresholds,
      );
    });

    it("preserves ordinary high-context success output and metadata", async () => {
      const artifactsDir = path.join(tempDir, "ordinary-success-artifacts");
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call-success", name: "edit", arguments: { path: "a.ts" } },
              ],
              model: "mock/test-model",
              stopReason: "toolUse",
              usage: {
                totalTokens: 800,
                input: 700,
                output: 100,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
          {
            type: "tool_result_end",
            message: {
              role: "toolResult",
              toolCallId: "call-success",
              toolName: "edit",
              content: [{ type: "text", text: "edited" }],
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Ordinary success" }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
        ],
      });
      const result = await runSync(
        tempDir,
        [makeAgent("worker", { model: "mock/test-model", completionGuard: false })],
        "worker",
        "Finish the edit.",
        {
          runId: "ordinary-success-foreground",
          acceptance: false,
          artifactsDir,
          artifactConfig: { enabled: true, includeOutput: true, includeMetadata: true },
          availableModels: [
            { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
          ],
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.finalOutput, "Ordinary success");
      assert.ok(result.artifactPaths, "expected persisted artifacts");
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), result.finalOutput);
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        exitCode?: number;
        error?: string;
        terminationReason?: string;
      };
      assert.equal(metadata.exitCode, result.exitCode);
      assert.equal(metadata.error, result.error);
      assert.equal(metadata.terminationReason, result.terminationReason);
    });

    it("delivers foreground warning and critical pressure controls exactly once", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "preserve progress" }],
              model: "mock/test-model",
              stopReason: "toolUse",
              usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "finish narrowly" }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: { totalTokens: 950, input: 850, output: 100, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      });
      const events: NonNullable<RunSyncResult["controlEvents"]> = [];
      const result = await runSync(
        tempDir,
        [makeAgent("worker", { model: "mock/test-model", completionGuard: false })],
        "worker",
        "Preserve the work.",
        {
          runId: "foreground-pressure-controls",
          acceptance: false,
          availableModels: [
            { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
          ],
          onControlEvent: (event: unknown) => events.push(event as (typeof events)[number]),
        },
      );
      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        events.map((event) => event.contextPressureSeverity),
        ["warning", "critical"],
      );
      assert.deepEqual(
        result.controlEvents?.map((event) => event.contextPressureThreshold),
        ["warning", "critical"],
      );
      assert.equal(events.filter((event) => event.contextPressureSeverity === "warning").length, 1);
      assert.equal(
        events.filter((event) => event.contextPressureSeverity === "critical").length,
        1,
      );
    });

    it("preserves remembered foreground pressure projection and history only for same-segment revival", async () => {
      const runId = "foreground-pressure-revival";
      const sessionFile = path.join(tempDir, `${runId}.jsonl`);
      fs.writeFileSync(
        sessionFile,
        '{"type":"session","id":"foreground-pressure-revival"}\n',
        "utf-8",
      );
      const state = {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      };
      const persistedPressure = {
        severity: "warning",
        crossedThreshold: "warning",
        contextTokens: 799,
        contextWindow: 1000,
        contextPercent: 79.9,
        remainingTokens: 201,
        warnedAt: 123,
      };
      state.foregroundRuns.set(runId, {
        runId,
        mode: "single",
        cwd: tempDir,
        updatedAt: 1,
        children: [
          {
            agent: "echo",
            index: 0,
            status: "completed",
            sessionFile,
            contextUsage: { contextTokens: 799, contextWindow: 1000, peakTokens: 799 },
            contextPressure: { ...persistedPressure, unexpected: "drop at boundary" },
            contextPressureCrossedThresholds: ["warning"],
          },
        ],
      });
      const context = makeMinimalCtx(tempDir);
      context.model = makeModel("test-model", { provider: "mock" });
      context.modelRegistry.getAvailable = () => [
        makeModel("test-model", { provider: "mock", contextWindow: 1000 }),
      ];
      const executor = makeExecutor(
        [makeAgent("echo", { model: "mock/test-model", completionGuard: false })],
        {},
        state,
      );
      const terminalPressure = {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "continued" }],
          model: "mock/test-model",
          stopReason: "stop",
          usage: { totalTokens: 800, input: 700, output: 100, cacheRead: 0, cacheWrite: 0 },
        },
      };
      mockPi.onCall({ jsonl: [terminalPressure] });
      const revived = await executor.execute(
        "foreground-pressure-revival-call",
        { action: "resume", id: runId, message: "Continue the same segment." },
        new AbortController().signal,
        undefined,
        context,
      );
      const revivedId = revived.details?.asyncId;
      assert.ok(revivedId, "expected revived async id");
      const revivedPayload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(revivedId), "utf-8"),
      ) as {
        results?: Array<{
          contextPressure?: Record<string, unknown>;
          contextPressureCrossedThresholds?: string[];
        }>;
      };
      assert.deepEqual(revivedPayload.results?.[0]?.contextPressure, persistedPressure);
      assert.deepEqual(revivedPayload.results?.[0]?.contextPressureCrossedThresholds, ["warning"]);
      const revivedStatus = JSON.parse(
        fs.readFileSync(path.join(ASYNC_DIR, revivedId, "status.json"), "utf-8"),
      ) as {
        steps?: Array<{
          contextPressure?: Record<string, unknown>;
          contextPressureCrossedThresholds?: string[];
        }>;
      };
      assert.deepEqual(revivedStatus.steps?.[0]?.contextPressure, persistedPressure);
      assert.deepEqual(revivedStatus.steps?.[0]?.contextPressureCrossedThresholds, ["warning"]);
      const revivedEvents = fs
        .readFileSync(path.join(ASYNC_DIR, revivedId, "events.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; event?: { reason?: string } });
      assert.equal(
        revivedEvents.filter(
          (event) =>
            event.type === "subagent.control" && event.event?.reason === "context_pressure",
        ).length,
        0,
      );

      mockPi.onCall({ jsonl: [terminalPressure] });
      const fresh = await executor.execute(
        "foreground-pressure-new-run",
        { agent: "echo", task: "Start an independent continuation." },
        new AbortController().signal,
        undefined,
        context,
      );
      const freshResult = fresh.details?.results?.[0];
      assert.deepEqual(
        freshResult?.controlEvents?.map((event) => event.contextPressureSeverity),
        ["warning"],
      );
    });

    it("does not classify a raw acceptance-report terminal as context exhausted", async () => {
      const acceptanceReport = [
        "```acceptance-report",
        JSON.stringify({
          criteriaSatisfied: [
            { id: "criterion-1", status: "satisfied", evidence: "terminal report" },
          ],
          changedFiles: [],
          testsAddedOrUpdated: [],
          commandsRun: [],
          validationOutput: [],
          residualRisks: [],
          noStagedFiles: true,
        }),
        "```",
      ].join("\n");
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-acceptance",
                  name: "edit",
                  arguments: { path: "a.ts" },
                },
              ],
              model: "mock/test-model",
              stopReason: "toolUse",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: acceptanceReport }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: {
                totalTokens: 990,
                input: 900,
                output: 90,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
              },
            },
          },
        ],
      });
      const result = await runSync(
        tempDir,
        [makeAgent("worker", { model: "mock/test-model", completionGuard: false })],
        "worker",
        "Finish the edit.",
        {
          runId: "context-acceptance-foreground",
          acceptance: false,
          availableModels: [
            { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
          ],
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.contextUsage?.contextPercent, 99);
      assert.equal(result.finalOutput, "");
    });

    it("persists fresh and restored context diagnostics from response usage", async () => {
      mockPi.onCall({
        jsonl: [
          mockAssistantMessage("First", "tool_use"),
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done" }],
              model: "mock/test-model",
              stopReason: "stop",
              usage: { input: 20, output: 10, cacheRead: 770, cacheWrite: 0, cost: { total: 0 } },
            },
          },
        ],
      });
      const agents = [makeAgent("echo", { model: "mock/test-model" })];
      const freshSessionFile = path.join(tempDir, "fresh-preallocated.jsonl");
      fs.writeFileSync(freshSessionFile, "", "utf-8");
      const fresh = await runSync(tempDir, agents, "echo", "Task", {
        runId: "context-fresh",
        sessionFile: freshSessionFile,
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
      });
      assert.deepEqual(fresh.contextUsage, {
        contextTokens: 800,
        peakTokens: 800,
        contextWindow: 1000,
        contextPercent: 80,
      } satisfies ContextUsageDiagnostics);
      // Cast to ContextUsageDiagnostics (full production type) to prevent TypeScript
      // narrowing fresh.contextUsage to the literal shape of the deepEqual expected above.
      assert.equal((fresh.contextUsage as ContextUsageDiagnostics)?.restoredTokens, undefined);
      assert.equal(fresh.terminationReason, "completed");

      mockPi.onCall({ output: "Continued" });
      const restoredSessionFile = path.join(tempDir, "restored.jsonl");
      fs.writeFileSync(
        restoredSessionFile,
        '{"type":"session","version":1,"id":"restored","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
        "utf-8",
      );
      const restored = await runSync(tempDir, agents, "echo", "Continue", {
        runId: "context-restored",
        sessionFile: restoredSessionFile,
        availableModels: [
          { provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 1000 },
        ],
      });
      assert.equal(restored.contextUsage?.restoredTokens, restored.contextUsage?.contextTokens);
    });

    it(
      "rejects action='single' instead of treating it as execution",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-alias",
          { action: "single", agent: "echo", task: "Run through alias" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Unknown action: single/);
        assert.equal(mockPi.callCount(), 0);
      },
    );

    it(
      "rejects unknown action strings at runtime",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "unknown-action",
          { action: "not-a-real-action" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
        assert.match(result.content[0]?.text ?? "", /Valid:/);
      },
    );

    it("rejects duplicate concurrent subagent execution calls", async () => {
      mockPi.onCall({ output: "first call completed", delay: 100 });
      const executor = makeExecutor([makeAgent("echo")]);
      const ctx = makeMinimalCtx(tempDir);

      const first = executor.execute(
        "first",
        { agent: "echo", task: "First call" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const second = await executor.execute(
        "second",
        { agent: "echo", task: "Duplicate call" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const firstResult = await first;

      assert.equal(firstResult.isError, undefined);
      assert.equal(second.isError, true);
      assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
      assert.equal(mockPi.callCount(), 1);
    });

    it("ignores legacy per-session spawn quota config and env values", async () => {
      const savedMaxSpawns = process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
      process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = "0";
      try {
        mockPi.onCall({ output: "first call completed" });
        mockPi.onCall({ output: "second call completed" });
        const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
        const ctx = makeMinimalCtx(tempDir);

        const first = await executor.execute(
          "first",
          { agent: "echo", task: "First call" },
          new AbortController().signal,
          undefined,
          ctx,
        );
        const second = await executor.execute(
          "second",
          { agent: "echo", task: "Second call" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        assert.equal(first.isError, undefined);
        assert.match(first.content[0]?.text ?? "", /first call completed/);
        assert.equal(second.isError, undefined);
        assert.match(second.content[0]?.text ?? "", /second call completed/);
        assert.equal(mockPi.callCount(), 2);
      } finally {
        if (savedMaxSpawns === undefined) delete process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION;
        else process.env.PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = savedMaxSpawns;
      }
    });

    it("allows management actions while an execution call is in progress", async () => {
      mockPi.onCall({ output: "first call completed", delay: 100 });
      const executor = makeExecutor([makeAgent("echo")]);
      const ctx = makeMinimalCtx(tempDir);

      const first = executor.execute(
        "first",
        { agent: "echo", task: "First call" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const status = await executor.execute(
        "status",
        { action: "status" },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const firstResult = await first;

      assert.equal(firstResult.isError, undefined);
      assert.equal(status.isError, undefined);
      assert.doesNotMatch(
        status.content[0]?.text ?? "",
        /Rejected: a subagent call is already in progress/,
      );
      assert.equal(mockPi.callCount(), 1);
    });

    it("allows intentional parallel tasks inside one subagent execution call", async () => {
      mockPi.onCall({ output: "first parallel result" });
      mockPi.onCall({ output: "second parallel result" });
      const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);

      const result = await executor.execute(
        "parallel",
        {
          tasks: [
            { agent: "echo", task: "First task" },
            { agent: "second", task: "Second task" },
          ],
        },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      assert.equal(result.isError, undefined);
      assert.equal(mockPi.callCount(), 2);
      assert.deepEqual(result.details?.totalCost, {
        inputTokens: 200,
        outputTokens: 100,
        costUsd: 0.002,
      });
    });

    it(
      "reports total cost for foreground single runs",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "single result" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-cost",
          { agent: "echo", task: "Single task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.deepEqual(result.details?.totalCost, {
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
        });
      },
    );

    it(
      "carries resolved tk ticket metadata through active foreground single updates",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const originalTicketsDir = process.env.TICKETS_DIR;
        process.env.TICKETS_DIR = path.join(tempDir, ".tickets");
        try {
          fs.mkdirSync(path.join(tempDir, ".tickets"), { recursive: true });
          fs.writeFileSync(
            path.join(tempDir, ".tickets", "psr-raw4.md"),
            "---\nid: psr-raw4\n---\n# Show active tk title\n",
            "utf-8",
          );
          mockPi.onCall({
            steps: [
              { jsonl: [events.toolStart("read", { path: "README.md" })], delay: 60 },
              { jsonl: [events.assistantMessage("single ticket done")] },
            ],
          });
          const executor = makeExecutor([makeAgent("echo")]);
          const updates: Array<{
            details?: {
              results?: Array<{
                tkTicket?: { id: string; title: string };
                progress?: { status?: string };
              }>;
            };
          }> = [];
          const runPromise = executor.execute(
            "single-ticket",
            { agent: "echo", task: "Run `tk show psr-raw4` first." },
            new AbortController().signal,
            (update: unknown) => updates.push(update as (typeof updates)[number]),
            makeMinimalCtx(tempDir),
          );

          const deadline = Date.now() + 5_000;
          while (
            Date.now() < deadline &&
            !updates.some((update) =>
              update.details?.results?.some((result) => result.progress?.status === "running"),
            )
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const running = updates.find((update) =>
            update.details?.results?.some((result) => result.progress?.status === "running"),
          );
          assert.deepEqual(running?.details?.results?.[0]?.tkTicket, {
            id: "psr-raw4",
            title: "Show active tk title",
          });

          const result = await runPromise;
          assert.deepEqual(result.details?.results?.[0]?.tkTicket, {
            id: "psr-raw4",
            title: "Show active tk title",
          });
        } finally {
          if (originalTicketsDir === undefined) delete process.env.TICKETS_DIR;
          else process.env.TICKETS_DIR = originalTicketsDir;
        }
      },
    );

    it("fails implementation runs that complete without mutation attempts", async () => {
      mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
      const agents = [makeAgent("worker")];
      const controlEvents: Array<{ message: string }> = [];

      const result = await runSync(
        tempDir,
        agents,
        "worker",
        "Implement the approved file changes",
        {
          runId: "guard-run",
          onControlEvent: (event: { message: string }) => controlEvents.push(event),
        },
      );

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /completed without making edits/);
      assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
      assert.equal(result.progress.status, "failed");
      assert.deepEqual(
        controlEvents.map((event) => event.message),
        ["worker completed without making edits for an implementation task"],
      );
      assert.deepEqual(
        result.controlEvents?.map((event) => event.message),
        ["worker completed without making edits for an implementation task"],
      );
    });

    it("does not fail advisory oracle runs that finish without edits", async () => {
      mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
      const executor = makeExecutor([makeAgent("oracle")]);

      const result = await executor.execute(
        "failed-single-output",
        { agent: "oracle", task: "Implement the approved file changes" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(tempDir),
      );

      const text = result.content[0]?.text ?? "";
      assert.equal(result.isError, undefined);
      assert.match(text, /^subagent results/m);
      assert.match(text, /Mode: single/);
      assert.match(text, /Status: completed/);
      assert.match(text, /Children: 1 completed/);
      assert.match(text, /1\/1\. oracle — completed/);
      const oracleSummary = "Summary:\nOracle review:\n- finding one\n- finding two";
      assert.match(text, new RegExp(escapeRegExp(oracleSummary)));
      assert.equal(text.split(oracleSummary).length - 1, 1);
    });

    it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
      mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
      const agents = [makeAgent("worker")];

      const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
        runId: "guard-future-tense",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /completed without making edits/);
    });

    it("allows declared read-only agents to mention implementation words without edits", async () => {
      mockPi.onCall({ output: "Validation report after the patch" });
      const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

      const result = await runSync(
        tempDir,
        agents,
        "architect",
        "Produce a proposal that implements the approved fix",
        {
          runId: "guard-readonly-tools",
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.progress.status, "completed");
      assert.equal(result.finalOutput, "Validation report after the patch");
    });

    it("allows test-runner to report realistic final-validation wording without a mutation guard", async () => {
      mockPi.onCall({ output: "Validation passed; no edits were needed." });
      const runner = makeAgent("test-runner", {
        tools: ["bash"],
        completionGuard: false,
        supervisorBridge: false,
        systemPrompt: "Run exact validation commands. Prompt prose is not a capability signal.",
      });
      assert.equal(runner.completionGuard, false);
      assert.equal(runner.supervisorBridge, false);

      const result = await runSync(
        tempDir,
        [runner],
        "test-runner",
        "Run the final-validation ticket's exact commands, report pass/fail results, and do not modify the repository.",
        { runId: "test-runner-final-validation" },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.progress.status, "completed");
      assert.equal(result.finalOutput, "Validation passed; no edits were needed.");
      const args = readCallArgs();
      assert.equal(args[args.indexOf("--tools") + 1], "bash");
      assert.equal(args[args.indexOf("--exclude-tools") + 1], "contact_supervisor");
    });

    it("allows implementation runs when parsed messages include a real edit tool call", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  name: "edit",
                  arguments: { path: "src/file.ts", oldText: "a", newText: "b" },
                },
              ],
              model: "mock/test-model",
              stopReason: "toolUse",
              usage: {
                input: 100,
                output: 50,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0.001 },
              },
            },
          },
          events.assistantMessage("Applied edit"),
        ],
      });
      const agents = [makeAgent("worker")];

      const result = await runSync(
        tempDir,
        agents,
        "worker",
        "Implement the approved file changes",
        {
          runId: "guard-success",
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.progress.status, "completed");
      assert.equal(result.finalOutput, "Applied edit");
    });

    it("returns error for unknown agent", async () => {
      const agents = makeAgentConfigs(["echo"]);
      const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes("Unknown agent"));
    });

    it("emits an active-long-running notice after the turn threshold", async () => {
      mockPi.onCall({
        jsonl: [events.assistantMessage("first update"), events.assistantMessage("second update")],
      });
      const agents = makeAgentConfigs(["echo"]);
      const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

      const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
        runId: "run-active",
        controlConfig: {
          enabled: true,
          activeNoticeAfterTurns: 2,
          activeNoticeAfterMs: 999_999,
          activeNoticeAfterTokens: 999_999,
          notifyOn: ["active_long_running", "needs_attention"],
        },
        onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) =>
          controlEvents.push(event),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(controlEvents.length, 1);
      assert.equal(controlEvents[0]?.type, "active_long_running");
      assert.equal(controlEvents[0]?.reason, "turn_threshold");
      assert.equal(controlEvents[0]?.turns, 2);
      assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
      assert.equal(result.progress.activityState, "active_long_running");
    });

    it("does not emit idle attention while a tool call is still running", async () => {
      mockPi.onCall({
        steps: [
          { jsonl: [events.toolStart("bash", { command: "echo still running" })] },
          { delay: 1_300, jsonl: [events.toolEnd("bash")] },
          { jsonl: [events.assistantMessage("Done after the tool finished.")] },
        ],
      });
      const agents = [makeAgent("scout")];
      const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

      const result = await runSync(tempDir, agents, "scout", "Investigate behavior", {
        runId: "run-tool-inflight-idle-guard",
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 200,
          activeNoticeAfterMs: 999_999,
          activeNoticeAfterTurns: 999_999,
          activeNoticeAfterTokens: 999_999,
          notifyOn: ["active_long_running", "needs_attention"],
        },
        onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) =>
          controlEvents.push(event),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(
        controlEvents.find((event) => event.reason === "idle"),
        undefined,
      );
      assert.equal(
        result.controlEvents?.find((event) => event.reason === "idle"),
        undefined,
      );
      assert.equal(result.progress.activityState, undefined);
    });

    it("still emits idle attention after the tool finishes and the child goes silent", async () => {
      mockPi.onCall({
        steps: [
          { jsonl: [events.toolStart("bash", { command: "echo done" })] },
          { delay: 1_300, jsonl: [events.toolEnd("bash")] },
          { delay: 1_300, jsonl: [events.assistantMessage("Done after an idle gap.")] },
        ],
      });
      const agents = [makeAgent("scout")];
      const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

      const result = await runSync(tempDir, agents, "scout", "Investigate behavior", {
        runId: "run-post-tool-idle",
        controlConfig: {
          enabled: true,
          needsAttentionAfterMs: 200,
          activeNoticeAfterMs: 999_999,
          activeNoticeAfterTurns: 999_999,
          activeNoticeAfterTokens: 999_999,
          notifyOn: ["active_long_running", "needs_attention"],
        },
        onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) =>
          controlEvents.push(event),
      });

      assert.equal(result.exitCode, 0);
      const idleEvent = controlEvents.find((event) => event.reason === "idle");
      assert.equal(idleEvent?.type, "needs_attention");
      assert.equal(
        result.controlEvents?.find((event) => event.reason === "idle")?.type,
        "needs_attention",
      );
      assert.equal(result.progress.activityState, "needs_attention");
    });

    it("escalates repeated mutating tool failures to needs attention", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
          events.toolEnd("edit"),
          events.toolResult("edit", "No exact match found for async-status.ts", true),
          events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
          events.toolEnd("edit"),
          events.toolResult("edit", "No exact match found for async-status.ts", true),
          events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
          events.toolEnd("edit"),
          events.toolResult("edit", "No exact match found for async-status.ts", true),
          events.assistantMessage("I need to retry the same edit."),
        ],
      });
      const agents = [makeAgent("worker")];
      const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

      const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
        runId: "run-failures",
        controlConfig: {
          enabled: true,
          failedToolAttemptsBeforeAttention: 3,
          notifyOn: ["active_long_running", "needs_attention"],
        },
        onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) =>
          controlEvents.push(event),
      });

      assert.equal(result.exitCode, 0);
      const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
      assert.equal(failureEvent?.type, "needs_attention");
      assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
      assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
      assert.equal(result.progress.activityState, "needs_attention");
    });

    it("does not surface control state or events when control is disabled", async () => {
      mockPi.onCall({
        jsonl: [events.assistantMessage("first update"), events.assistantMessage("second update")],
      });
      const agents = makeAgentConfigs(["echo"]);
      const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

      const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
        runId: "run-control-disabled",
        controlConfig: {
          enabled: false,
          activeNoticeAfterTurns: 1,
          activeNoticeAfterMs: 1,
          activeNoticeAfterTokens: 1,
          notifyOn: ["active_long_running", "needs_attention"],
        },
        onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) =>
          controlEvents.push(event),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.progress.activityState, undefined);
      assert.equal(result.controlEvents, undefined);
      assert.equal(controlEvents.length, 0);
    });

    it("captures non-zero exit code", async () => {
      mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
      const agents = makeAgentConfigs(["fail"]);

      const result = await runSync(tempDir, agents, "fail", "Do something", {});

      assert.equal(result.exitCode, 1);
      assert.ok(result.error?.includes("Something went wrong"));
    });

    it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
      mockPi.onCall({ output: "Got it" });
      const longTask = "Analyze ".repeat(2000); // ~16KB
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", longTask, {});

      assert.equal(result.exitCode, 0);
      const output = getFinalOutput(result.messages);
      assert.equal(output, "Got it");
    });
  },
);
