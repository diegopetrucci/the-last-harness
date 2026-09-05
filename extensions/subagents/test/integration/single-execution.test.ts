/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

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
  tryImport,
} from "../support/helpers.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import type {
  ChildProcessCleanupResult,
  ContextUsageDiagnostics,
  SingleResult,
} from "../../src/shared/types.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  getThinkingLevelDropNote,
  INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
} from "../../src/runs/shared/pi-args.ts";
import { waitForAsyncResultFile } from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";

interface ModelAttempt {
  success?: boolean;
  exitCode?: number;
  error?: string;
}

interface ProgressSummary {
  agent: string;
  index: number;
  status: string;
  activityState?: string;
  lastActivityAt?: number;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  currentPath?: string;
  turnCount?: number;
  tokens?: number;
  durationMs: number;
  toolCount: number;
  recentOutput: string[];
}

interface ArtifactPaths {
  inputPath: string;
  outputPath: string;
  jsonlPath: string;
  metadataPath: string;
  transcriptPath?: string;
}

interface RunSyncResult {
  exitCode: number;
  agent: string;
  messages: unknown[];
  error?: string;
  model?: string;
  skills?: string[];
  skillsWarning?: string;
  attemptedModels?: string[];
  modelAttempts?: ModelAttempt[];
  modelFallbackNotice?: string;
  modelIdentity?: { provider: string; model: string; thinking?: string };
  modelResolution?: {
    kind?: string;
    original?: { provider: string; model: string; thinking?: string };
    resumed?: { provider: string; model: string; thinking?: string };
    reason?: string;
  };
  usage: { turns: number; input: number; output: number };
  /** Typed from production ContextUsageDiagnostics so new fields are caught. */
  contextUsage?: ContextUsageDiagnostics;
  contextPressure?: {
    severity?: string;
    crossedThreshold?: string;
    contextTokens?: number;
    contextWindow?: number;
    contextPercent?: number;
    remainingTokens?: number;
    warnedAt?: number;
  };
  contextPressureCrossedThresholds?: string[];
  terminationReason?: string;
  progress: ProgressSummary;
  controlEvents?: Array<{
    type?: string;
    message: string;
    reason?: string;
    contextPressureSeverity?: string;
    contextPressureThreshold?: string;
    turns?: number;
    tokens?: number;
    currentPath?: string;
    recentFailureSummary?: string;
  }>;
  artifactPaths?: ArtifactPaths;
  transcriptPath?: string;
  transcriptError?: string;
  finalOutput?: string;
  interrupted?: boolean;
  timedOut?: boolean;
  pause?: {
    kind?: string;
    summary?: string;
    requestedAt?: number;
    pausedAt?: number;
    ownerPid?: number;
    request?: {
      tool?: string;
      action?: string;
      reason?: string;
      requestId?: string;
      summary?: string;
    };
  };
  cancel?: { summary?: string; cancelledAt?: number };
  savedOutputPath?: string;
  outputMode?: "inline" | "file-only";
  outputReference?: { path: string; bytes: number; lines: number; message: string };
  outputSaveError?: string;
  sessionFile?: string;
  tkTicket?: { id: string; title: string };
  acceptance?: {
    explicit?: boolean;
    status?: string;
    verifyRuns?: Array<{ status?: string }>;
    runtimeChecks?: Array<{ id?: string; status?: string; message?: string }>;
  };
  /** Typed from production ChildProcessCleanupResult so new fields are caught. */
  processCleanup?: ChildProcessCleanupResult;
}

interface MockPiCallRecord {
  args?: string[];
  systemPrompts?: Array<{ mode?: string; path?: string; text?: string; error?: string }>;
}

function mockAssistantMessage(text: string, stopReason: "stop" | "tool_use" = "stop") {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content:
        stopReason === "tool_use"
          ? [
              { type: "text", text },
              { type: "toolCall", name: "bash", arguments: { command: "echo test" } },
            ]
          : [{ type: "text", text }],
      model: "mock/test-model",
      stopReason,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    },
  };
}

function explicitAcceptanceRejectionOutput(output: string): string {
  return [
    output,
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [
        {
          id: "criterion-1",
          status: "not-satisfied",
          evidence: "The fixture intentionally rejects this criterion.",
        },
      ],
      changedFiles: ["src/report.md"],
      testsAddedOrUpdated: ["test/report.test.ts"],
      commandsRun: [
        { command: "false", result: "failed", summary: "Intentional rejection fixture." },
      ],
      validationOutput: ["Intentional rejection fixture."],
      residualRisks: [],
      noStagedFiles: true,
      diffSummary: "Intentional rejection fixture.",
      reviewFindings: [],
      manualNotes: "Intentional rejection fixture.",
    }),
    "```",
  ].join("\n");
}

function inferredAcceptanceRejectionOutput(output: string): string {
  return [
    output,
    "```acceptance-report",
    JSON.stringify({
      criteriaSatisfied: [],
      changedFiles: [],
      testsAddedOrUpdated: ["test/report.test.ts"],
      commandsRun: [
        { command: "true", result: "passed", summary: "Intentional rejection fixture." },
      ],
      residualRisks: [],
      noStagedFiles: true,
    }),
    "```",
  ].join("\n");
}

interface ExecutionModule {
  runSync(
    runtimeCwd: string,
    agents: ReturnType<typeof makeAgentConfigs>,
    agentName: string,
    task: string,
    options: Record<string, unknown>,
  ): Promise<RunSyncResult>;
}

interface UtilsModule {
  getFinalOutput(messages: unknown[]): string;
}

interface ExecutorToolResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
  details?: {
    totalCost?: { inputTokens: number; outputTokens: number; costUsd: number };
    timeoutMs?: number;
    deadlineAt?: number;
    asyncId?: string;
    /** Typed from production SingleResult so structural drift is caught. */
    results?: Pick<
      SingleResult,
      | "agent"
      | "exitCode"
      | "error"
      | "attemptedModels"
      | "modelFallbackNotice"
      | "progress"
      | "tkTicket"
      | "controlEvents"
      | "finalOutput"
      | "artifactPaths"
      | "savedOutputPath"
      | "outputMode"
      | "outputReference"
      | "acceptance"
    >[];
  };
}

interface ExecutorModule {
  createSubagentExecutor?: (...args: unknown[]) => {
    execute: (...args: unknown[]) => Promise<ExecutorToolResult>;
  };
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    it("uses agent model config", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.exitCode, 0);
      // result.model is set from agent config via applyThinkingSuffix, then
      // overwritten by the first message_end event only if result.model is unset.
      // Since agent has model config, it stays as the configured value.
      assert.equal(result.model, "anthropic/claude-sonnet-4");
    });

    it("model override from options takes precedence", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        modelOverride: "openai/gpt-4o",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "openai/gpt-4o");
    });

    it(
      "foreground single runs inherit the parent session model when no model is set",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-parent-model",
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "deepseek", id: "deepseek-v4-flash" },
          },
        );

        assert.equal(result.isError, undefined);
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
      },
    );

    it(
      "foreground single explicit model overrides remain authoritative over the parent session model",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const executor = makeExecutor([makeAgent("echo")]);

        const result = await executor.execute(
          "single-explicit-model-override",
          { agent: "echo", task: "Task", model: "openai/gpt-5-mini" },
          new AbortController().signal,
          undefined,
          {
            ...makeMinimalCtx(tempDir),
            model: { provider: "deepseek", id: "deepseek-v4-flash" },
          },
        );

        assert.equal(result.isError, undefined);
        const args = readCallArgs();
        assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5-mini");
      },
    );

    it("prefers the parent session provider for ambiguous bare model ids", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels: [
          { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
          { provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
        ],
        preferredModelProvider: "github-copilot",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "github-copilot/gpt-5-mini");
      assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
    });

    it("surfaces a dropped thinking level in foreground progress without changing the model arg", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { model: "openai/gpt-5", thinking: "max" })];
      const availableModels = [
        {
          provider: "openai",
          id: "gpt-5",
          fullId: "openai/gpt-5",
          reasoning: true,
          thinkingLevelMap: { max: null },
        },
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "foreground-thinking-drop",
      });
      const note = getThinkingLevelDropNote("openai/gpt-5", "max", false, { availableModels });
      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "openai/gpt-5");
      const args = readCallArgs();
      assert.equal(args[args.indexOf("--model") + 1], "openai/gpt-5");
      assert.ok(note);
      assert.equal(result.progress.recentOutput.filter((line) => line === note).length, 1);
    });

    it("preserves a max thinking suffix for resolved foreground models without capability metadata", async () => {
      mockPi.onCall({ output: "Done" });
      const model = "anthropic/claude-sonnet-4-5";
      const agents = [makeAgent("echo", { model, thinking: "max" })];
      const availableModels = [
        {
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          fullId: model,
          reasoning: true,
        },
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "foreground-thinking-metadata-missing",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.model, `${model}:max`);
      const args = readCallArgs();
      assert.equal(args[args.indexOf("--model") + 1], `${model}:max`);
      assert.equal(getThinkingLevelDropNote(model, "max", false, { availableModels }), undefined);
    });

    it("tracks usage from message events", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.usage.turns, 1);
      assert.equal(result.usage.input, 100); // from mock
      assert.equal(result.usage.output, 50); // from mock
    });

    it("retries with fallback models on retryable provider failures", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const sessionFile = path.join(tempDir, "fallback-preallocated.jsonl");
      fs.writeFileSync(sessionFile, "", "utf-8");
      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-sync",
        sessionFile,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.equal(result.modelAttempts?.[1]?.success, true);
      assert.equal(result.contextUsage?.restoredTokens, undefined);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.usage.turns, 2);
      assert.equal(mockPi.callCount(), 2);
    });

    it("reports conservative registry filtering in the foreground result", async () => {
      mockPi.onCall({ output: "Primary completed" });
      const primary = {
        provider: "openai",
        id: "gpt-5-mini",
        fullId: "openai/gpt-5-mini",
      };
      const backup = {
        provider: "anthropic",
        id: "claude-sonnet-4",
        fullId: "anthropic/claude-sonnet-4",
      };
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: primary.fullId,
            fallbackModels: [backup.fullId],
          }),
        ],
        "echo",
        "Task",
        {
          runId: "foreground-registry-filter-notice",
          availableModels: [primary],
          modelRegistry: { allModels: [primary, backup] },
        },
      );

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.attemptedModels, [primary.fullId]);
      assert.match(result.modelFallbackNotice ?? "", /Skipped.*unavailable fallback model/);
      assert.match(result.modelFallbackNotice ?? "", /provider credentials|fallbackModels/);
      assert.ok((result.modelFallbackNotice ?? "").length <= 240);
      assert.equal(mockPi.callCount(), 1);
    });

    it("keeps fallback attempts when optional registry snapshot APIs are missing or uncertain", async () => {
      const primary = makeModel("primary", { provider: "openai" });
      const backup = makeModel("backup", { provider: "anthropic" });
      const primaryId = `${primary.provider}/${primary.id}`;
      const backupId = `${backup.provider}/${backup.id}`;
      for (const variant of ["missing-catalog", "catalog-throws", "availability-error"] as const) {
        mockPi.reset();
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "temporary provider failure" }],
                model: primary.id,
                errorMessage: "rate limit exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
              },
            },
          ],
          exitCode: 1,
        });
        mockPi.onCall({ output: "Recovered on the preserved fallback" });

        const ctx = makeMinimalCtx(tempDir);
        ctx.modelRegistry.getAvailable = () => [primary];
        if (variant === "missing-catalog") {
          Object.defineProperty(ctx.modelRegistry, "getAll", {
            configurable: true,
            value: undefined,
          });
        } else if (variant === "catalog-throws") {
          Object.defineProperty(ctx.modelRegistry, "getAll", {
            configurable: true,
            value: () => {
              throw new Error("catalog unavailable");
            },
          });
        } else {
          Object.defineProperty(ctx.modelRegistry, "getError", {
            configurable: true,
            value: () => "availability snapshot is stale",
          });
        }

        const result = await makeExecutor([
          makeAgent("echo", {
            model: primaryId,
            fallbackModels: [backupId],
          }),
        ]).execute(
          `optional-registry-${variant}`,
          { agent: "echo", task: "Task" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        assert.equal(result.isError, undefined);
        assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [primaryId, backupId]);
        assert.equal(mockPi.callCount(), 2);
      }
    });

    it("keeps the fallback resolution's original identity free of thinking the first attempt dropped", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const availableModels = [
        {
          provider: "openai",
          id: "gpt-5-mini",
          fullId: "openai/gpt-5-mini",
          reasoning: true,
          thinkingLevelMap: { high: null },
        },
        {
          provider: "anthropic",
          id: "claude-sonnet-4",
          fullId: "anthropic/claude-sonnet-4",
          reasoning: true,
        },
      ];
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          thinking: "high",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        availableModels,
        runId: "fallback-thinking-dropped-original",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4:high");
      assert.equal(result.modelResolution?.kind, "fallback");
      // Regression: the first attempt actually dropped "high" as unsupported, so
      // the fallback resolution must not restore it on the original identity.
      assert.deepEqual(result.modelResolution?.original, {
        provider: "openai",
        model: "gpt-5-mini",
      });
      assert.deepEqual(result.modelResolution?.resumed, {
        provider: "anthropic",
        model: "claude-sonnet-4",
        thinking: "high",
      });
      assert.match(
        result.modelResolution?.reason ?? "",
        /Runtime fallback selected 'anthropic\/claude-sonnet-4:high' after 'openai\/gpt-5-mini' failed/,
      );
    });

    it("lets runtime fallback supersede restored model resolution while preserving history", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              errorMessage: "rate limit exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 1,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const original = { provider: "openai", model: "gpt-5-mini", thinking: "high" };
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
          }),
        ],
        "echo",
        "Continue",
        {
          availableModels: [
            { provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini", reasoning: true },
            {
              provider: "anthropic",
              id: "claude-sonnet-4",
              fullId: "anthropic/claude-sonnet-4",
              reasoning: true,
            },
          ],
          modelResolution: {
            kind: "restored",
            original,
            resumed: original,
            reason:
              "Restored persisted child selection openai/gpt-5-mini:high instead of the current parent model.",
          },
          runId: "restored-fallback-resolution",
        },
      );

      assert.equal(result.modelResolution?.kind, "fallback");
      assert.deepEqual(result.modelResolution?.original, original);
      assert.deepEqual(result.modelResolution?.resumed, {
        provider: "anthropic",
        model: "claude-sonnet-4",
      });
      assert.match(result.modelResolution?.reason ?? "", /Restored persisted child selection/);
      assert.match(result.modelResolution?.reason ?? "", /Runtime fallback selected/);
    });

    it(
      "tries agent fallback models and only shows notices after a retry",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "quota hit" }],
                model: "openai/gpt-5-mini",
                errorMessage: "429 quota exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
              },
            },
          ],
          exitCode: 0,
        });
        mockPi.onCall({ output: "Recovered on the agent fallback" });
        const executor = makeExecutor([
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["google/gemini-2.5-pro"],
          }),
        ]);
        const ctx = makeMinimalCtx(tempDir);
        const primary = makeModel("gpt-5-mini", { provider: "openai" });
        const agentFallback = makeModel("gemini-2.5-pro", { provider: "google" });
        ctx.modelRegistry.getAvailable = () => [primary, agentFallback];
        ctx.modelRegistry.getAll = () => [primary, agentFallback];

        const result = await executor.execute(
          "single-agent-fallback-order",
          {
            agent: "echo",
            task: "Task",
            modelFallbackNotice: "Quota fallback engaged",
          },
          new AbortController().signal,
          undefined,
          ctx,
        );

        assert.equal(result.isError, undefined);
        assert.match(
          result.content[0]?.text ?? "",
          /Summary:\nNotice: Quota fallback engaged(?: Skipped.*)?\n\nRecovered on the agent fallback/,
        );
        assert.deepEqual(result.details?.results?.[0]?.attemptedModels, [
          "openai/gpt-5-mini",
          "google/gemini-2.5-pro",
        ]);
        assert.match(
          result.details?.results?.[0]?.modelFallbackNotice ?? "",
          /Quota fallback engaged/,
        );
        assert.equal(mockPi.callCount(), 2);
      },
    );

    it(
      "suppresses fallback notices when the primary attempt succeeds",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done without retry" });
        const executor = makeExecutor([
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
          }),
        ]);

        const result = await executor.execute(
          "single-fallback-notice-no-retry",
          { agent: "echo", task: "Task", modelFallbackNotice: "Should stay hidden" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.doesNotMatch(result.content[0]?.text ?? "", /Notice: Should stay hidden/);
        assert.equal(result.details?.results?.[0]?.modelFallbackNotice, undefined);
      },
    );

    it("retries with fallback models when provider errors exit zero", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "weekly quota hit" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({ output: "Recovered on fallback" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-zero-exit-provider-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
    });

    it("retries with fallback models when a zero-exit attempt has empty output", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({ output: "Recovered from empty output" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-zero-exit-empty-output",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.model, "anthropic/claude-sonnet-4");
      assert.equal(result.finalOutput, "Recovered from empty output");
      assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
      assert.equal(mockPi.callCount(), 2);
    });

    it("does not combine failed high-pressure fallback diagnostics with a successful empty attempt", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "failed-call", name: "edit", arguments: { path: "a.ts" } },
              ],
              model: "openai/gpt-5-mini",
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
              content: [{ type: "text", text: "provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "429 quota exceeded",
            },
          },
        ],
        exitCode: 0,
      });
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "successful-call",
                  name: "edit",
                  arguments: { path: "b.ts" },
                },
              ],
              model: "anthropic/claude-sonnet-4",
              stopReason: "toolUse",
            },
          },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "" }],
              model: "anthropic/claude-sonnet-4",
              stopReason: "stop",
            },
          },
        ],
      });
      const result = await runSync(
        tempDir,
        [
          makeAgent("echo", {
            model: "openai/gpt-5-mini",
            fallbackModels: ["anthropic/claude-sonnet-4"],
            completionGuard: false,
          }),
        ],
        "echo",
        "Task",
        {
          runId: "fallback-context-pressure-scope",
          availableModels: [
            {
              provider: "openai",
              id: "gpt-5-mini",
              fullId: "openai/gpt-5-mini",
              contextWindow: 1000,
            },
          ],
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminationReason, "completed");
      assert.equal(result.error, undefined);
      assert.equal(result.contextUsage?.contextPercent, 99);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, true],
      );
    });

    it("fails zero-exit provider errors when no fallback succeeds", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "weekly quota hit" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
      });
      const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "zero-exit-provider-error-no-fallback",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /429 quota exceeded/);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false],
      );
    });

    it("treats recovered child tool errors as successful foreground runs", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolResult("read", "EISDIR: illegal operation on a directory", true),
          events.assistantMessage("Done"),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Inspect files", {
        runId: "recovered-tool-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "Done");
      assert.equal(getFinalOutput(result.messages), "Done");
      assert.equal(result.progress.status, "completed");
    });

    it("treats recovered assistant provider errors as successful foreground runs", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "provider transport failed",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
          events.assistantMessage("Recovered"),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
        runId: "recovered-provider-error",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.equal(result.finalOutput, "Recovered");
      assert.equal(getFinalOutput(result.messages), "Recovered");
      assert.equal(result.progress.status, "completed");
    });

    it("keeps provider errors failed when followed only by empty assistant output", async () => {
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "temporary provider failure" }],
              model: "openai/gpt-5-mini",
              stopReason: "error",
              errorMessage: "provider transport failed",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
          events.assistantMessage(""),
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
        runId: "provider-error-empty-stop",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /provider transport failed/);
      assert.equal(result.finalOutput, "");
      assert.equal(result.progress.status, "failed");
    });

    it("fails when all fallback model attempts report provider errors", async () => {
      for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
        mockPi.onCall({
          jsonl: [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: `${model} quota hit` }],
                model,
                errorMessage: "429 quota exceeded",
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
              },
            },
          ],
          exitCode: 0,
        });
      }
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "zero-exit-provider-error-all-fallbacks-fail",
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(
        result.modelAttempts?.map((attempt) => attempt.success),
        [false, false],
      );
      assert.match(result.error ?? "", /429 quota exceeded/);
    });

    it("baselines output files per fallback attempt", async () => {
      const outputPath = path.join(tempDir, "fallback-output.md");
      mockPi.onCall({
        jsonl: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "primary failed" }],
              model: "openai/gpt-5-mini",
              errorMessage: "429 quota exceeded",
              usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
          },
        ],
        exitCode: 0,
        delay: 100,
      });
      mockPi.onCall({ output: "fallback assistant output" });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "fallback-output-per-attempt",
        outputPath,
      });
      setTimeout(() => {
        fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
      }, 20);

      const result = await runPromise;

      assert.equal(result.exitCode, 0);
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
    });

    it("does not retry on ordinary task/tool failures", async () => {
      mockPi.onCall({
        jsonl: [events.toolResult("bash", "process exited with code 127")],
        exitCode: 0,
      });
      const agents = [
        makeAgent("echo", {
          model: "openai/gpt-5-mini",
          fallbackModels: ["anthropic/claude-sonnet-4"],
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "no-fallback-task-failure",
      });

      assert.equal(result.exitCode, 127);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(mockPi.callCount(), 1);
    });

    it("tracks progress during execution", async () => {
      mockPi.onCall({ output: "Done" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

      assert.ok(result.progress, "should have progress");
      assert.equal(result.progress.agent, "echo");
      assert.equal(result.progress.index, 3);
      assert.equal(result.progress.status, "completed");
      assert.ok(result.progress.durationMs > 0, "should track duration");
    });

    it("tracks live activity updates and exposes artifact paths while running", async () => {
      const updates: Array<{
        details?: {
          results?: Array<{ artifactPaths?: ArtifactPaths }>;
          progress?: ProgressSummary[];
        };
      }> = [];
      mockPi.onCall({
        steps: [
          { jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
          {
            jsonl: [events.toolEnd("read"), events.toolResult("read", '{"name":"pkg"}')],
            delay: 20,
          },
          { jsonl: [events.assistantMessage("Done")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "live-progress",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
        onUpdate: (update: {
          details?: {
            results?: Array<{ artifactPaths?: ArtifactPaths }>;
            progress?: ProgressSummary[];
          };
        }) => {
          updates.push(update);
        },
      });

      assert.ok(updates.length > 0, "expected at least one live progress update");
      assert.equal(
        updates.some(
          (update) =>
            update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true,
        ),
        true,
      );
      const runningToolUpdate = updates.find(
        (update) => update.details?.progress?.[0]?.currentTool === "read",
      );
      assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
      assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
      assert.equal(
        typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt,
        "number",
      );
      assert.equal(typeof result.progress.lastActivityAt, "number");
      assert.equal(result.progress.currentToolStartedAt, undefined);
    });

    it("sets progress.status to failed on non-zero exit", async () => {
      mockPi.onCall({ exitCode: 1 });
      const agents = makeAgentConfigs(["fail"]);

      const result = await runSync(tempDir, agents, "fail", "Task", {});

      assert.equal(result.progress.status, "failed");
    });

    it("handles multi-turn conversation from JSONL", async () => {
      mockPi.onCall({
        jsonl: [
          events.toolStart("bash", { command: "ls" }),
          events.toolEnd("bash"),
          events.toolResult("bash", "file1.txt\nfile2.txt"),
          events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
        ],
      });
      const agents = makeAgentConfigs(["scout"]);

      const result = await runSync(tempDir, agents, "scout", "List files", {});

      assert.equal(result.exitCode, 0);
      const output = getFinalOutput(result.messages);
      assert.ok(output.includes("file1.txt"), "should capture assistant text");
      assert.equal(result.progress.toolCount, 1, "should count tool calls");
    });

    it("routes non-object child JSON to the raw transcript and preserves unknown events", async () => {
      const unknownEvent = {
        type: "future_event",
        extraField: { nested: true },
        anotherField: ["preserve", 7],
      };
      mockPi.onCall({
        jsonl: [
          null,
          [1, "two"],
          JSON.stringify("primitive"),
          42,
          unknownEvent,
          events.assistantMessage("Done"),
        ],
      });
      const artifactsDir = path.join(tempDir, "json-guard-artifacts");
      const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
        runId: "foreground-json-guards",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: false,
          includeOutput: false,
          includeJsonl: true,
          includeTranscript: true,
          includeMetadata: false,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "Done");
      assert.ok(result.artifactPaths?.jsonlPath, "expected JSONL artifact");
      assert.ok(result.transcriptPath, "expected transcript artifact");
      const jsonlRecords = fs
        .readFileSync(result.artifactPaths!.jsonlPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
      assert.equal(jsonlRecords.length, 6, "expected 6 JSONL records");
      assert.deepEqual(jsonlRecords[0], null);
      assert.deepEqual(jsonlRecords[1], [1, "two"]);
      assert.deepEqual(jsonlRecords[2], "primitive");
      assert.deepEqual(jsonlRecords[3], 42);
      assert.deepEqual(jsonlRecords[4], unknownEvent);
      // Record 5 is the assistant message_end event. The default acceptance level is "auto",
      // so formatAcceptancePrompt emits a "## Acceptance Contract" section; the mock's
      // taskRequestsAcceptance detects it and withAcceptanceReport appends an acceptance
      // report to the assistant text. Assert structure and key fields, not exact text.
      const r5 = jsonlRecords[5] as {
        type?: string;
        message?: {
          role?: string;
          model?: string;
          stopReason?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      assert.equal(r5.type, "message_end", "record 5 is message_end");
      assert.equal(r5.message?.role, "assistant", "record 5 message role is assistant");
      assert.equal(
        r5.message?.model,
        "mock/test-model",
        "record 5 message model is mock/test-model",
      );
      assert.equal(r5.message?.stopReason, "stop", "record 5 message stopReason is stop");
      assert.ok(
        r5.message?.content?.[0]?.text?.startsWith("Done"),
        "record 5 text starts with 'Done'",
      );

      const transcriptRecords = fs
        .readFileSync(result.transcriptPath!, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { recordType?: string; text?: string });
      assert.deepEqual(
        transcriptRecords
          .filter((record) => record.recordType === "stdout")
          .map((record) => record.text),
        ["null", '[1,"two"]', '"primitive"', "42", JSON.stringify(unknownEvent)],
      );
    });

    it("resolves skills from the effective task cwd", async () => {
      const taskCwd = createTempDir("pi-subagent-task-cwd-");
      try {
        writePackageSkill(taskCwd, "task-cwd-skill");
        mockPi.onCall({ output: "Done" });
        const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

        const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.skills, ["task-cwd-skill"]);
        assert.equal(result.skillsWarning, undefined);
      } finally {
        removeTempDir(taskCwd);
      }
    });

    it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
      const taskCwd = path.join(tempDir, "nested");
      fs.mkdirSync(taskCwd, { recursive: true });
      writePackageSkill(tempDir, "runtime-fallback-skill");
      mockPi.onCall({ output: "Done" });
      const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

      const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
      assert.equal(result.skillsWarning, undefined);
    });

    it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
      const agents = [makeAgent("worker")];

      const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Skills not found: pi-subagents");
      assert.equal(mockPi.callCount(), 0);
    });

    it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
      const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

      const result = await runSync(tempDir, agents, "worker", "Task", {});

      assert.equal(result.exitCode, 1);
      assert.equal(result.error, "Skills not found: pi-subagents");
      assert.equal(mockPi.callCount(), 0);
    });

    it("writes artifacts when configured", async () => {
      mockPi.onCall({ output: "Result text" });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "test-run",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.ok(result.transcriptPath, "should expose transcript path on the result");
      assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
      assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
      const transcript = fs
        .readFileSync(result.transcriptPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
      assert.equal(transcript[0]?.recordType, "message");
      assert.equal(transcript[0]?.source, "foreground");
      assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
      assert.equal(result.transcriptError, undefined);
      assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
    });

    it("does not surface transcript paths when transcript artifacts are disabled", async () => {
      mockPi.onCall({ output: "Result text" });
      const agents = makeAgentConfigs(["echo"]);
      const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "test-run-no-transcript",
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeTranscript: false,
          includeMetadata: true,
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.transcriptPath, undefined);
      assert.equal(result.transcriptError, undefined);
      assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        transcriptPath?: string;
        transcriptError?: string;
      };
      assert.equal(metadata.transcriptPath, undefined);
      assert.equal(metadata.transcriptError, undefined);
      assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
    });

    it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
      const outputPath = path.join(tempDir, "report.md");
      const artifactsDir = path.join(tempDir, "artifacts");
      mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
      const agents = makeAgentConfigs(["echo"]);

      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-preserved",
        outputPath,
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeMetadata: true,
        },
      });

      setTimeout(() => {
        fs.writeFileSync(outputPath, "real file content", "utf-8");
      }, 20);

      const result = await runPromise;
      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "real file content");
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
    });

    it("falls back to persisting assistant output when the target file was not changed", async () => {
      const outputPath = path.join(tempDir, "report.md");
      fs.writeFileSync(outputPath, "stale content", "utf-8");
      mockPi.onCall({ output: "fresh assistant output" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-fallback",
        outputPath,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.finalOutput, "fresh assistant output");
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
    });

    it(
      "routes foreground single relative outputs to the parent session artifact directory by default",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "default report" });
        const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);
        const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");
        const ctx = {
          ...makeMinimalCtx(tempDir),
          sessionManager: {
            getSessionId: () => "session-123",
            getSessionFile: () => parentSessionFile,
          },
        };

        const result = await executor.execute(
          "single-default-output-base",
          { agent: "researcher", task: "Write report" },
          new AbortController().signal,
          undefined,
          ctx,
        );

        const outputRoot = path.join(tempDir, "parent-session", "subagent-artifacts", "outputs");
        const taskArg = readCallArgs().at(-1) ?? "";
        assert.equal(result.isError, undefined);
        assert.match(
          taskArg,
          new RegExp(
            `Write your findings to exactly this path: ${escapeRegExp(outputRoot)}.*context\\.md`,
          ),
        );
        const outputPath = taskArg.match(/Write your findings to exactly this path: (\S+)/)?.[1];
        assert.ok(outputPath, "expected output path in child task");
        assert.equal(fs.readFileSync(outputPath, "utf-8"), "default report");
        assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
        assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
      },
    );

    it(
      "makes task-level output overrides authoritative in the child system prompt",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "override report" });
        const overridePath = path.join(tempDir, "custom-report.md");
        const executor = makeExecutor([
          makeAgent("researcher", {
            output: "default-report.md",
            systemPrompt:
              "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
          }),
        ]);

        const result = await executor.execute(
          "single-output-override-system-prompt",
          { agent: "researcher", task: "Write report", output: overridePath },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        const call = readCall();
        const taskArg = call.args.at(-1) ?? "";
        const systemPrompt = call.systemPrompts[0]?.text ?? "";
        assert.equal(result.isError, undefined);
        assert.match(
          taskArg,
          new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`),
        );
        assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
        assert.match(systemPrompt, /Runtime output path override:/);
        assert.match(
          systemPrompt,
          new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`),
        );
        assert.match(
          systemPrompt,
          /Ignore any other output filename or output path mentioned elsewhere/,
        );
      },
    );

    it(
      "treats string false as disabled output in foreground single runs",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ output: "inline report" });
        const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

        const result = await executor.execute(
          "single-string-false-output",
          { agent: "echo", task: "Write report", output: "false" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        assert.equal(result.isError, undefined);
        assert.match(result.content[0]?.text ?? "", /inline report/);
        assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
        assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
        assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
        assert.doesNotMatch(
          readCallArgs().at(-1) ?? "",
          /Write your findings to(?: exactly this path)?:/,
        );
      },
    );

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
        const completedDelayMs = 750;
        const resumeCeilingMs = 500;
        mockPi.onCall({
          delay: completedDelayMs,
          output: "completed successfully",
        });
        mockPi.onCall({ output: "fresh follow-up" });
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
        const activeRuntimeMs = remembered?.children[0]?.activeRuntimeMs;
        assert.ok(
          typeof activeRuntimeMs === "number" && activeRuntimeMs >= resumeCeilingMs,
          `expected the successful source to consume at least ${resumeCeilingMs}ms, got ${activeRuntimeMs}ms`,
        );
        assert.equal(remembered?.children[0]?.status, "completed");

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

    it("rejects file-only mode without an output path before spawning", async () => {
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-only-missing-path",
        outputMode: "file-only",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /outputMode: "file-only"/);
      assert.equal(mockPi.callCount(), 0);
    });

    it("returns only a saved-output reference in file-only mode", async () => {
      const outputPath = path.join(tempDir, "file-only-report.md");
      const artifactsDir = path.join(tempDir, "file-only-artifacts");
      mockPi.onCall({ output: "full saved output\nwith details" });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "output-file-only",
        outputPath,
        outputMode: "file-only",
        artifactsDir,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.outputMode, "file-only");
      assert.equal(result.savedOutputPath, outputPath);
      assert.equal(result.outputReference?.path, outputPath);
      assert.match(result.finalOutput ?? "", /^Output saved to:/);
      assert.match(result.finalOutput ?? "", /2 lines/);
      assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
      assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
      assert.ok(result.artifactPaths, "should have artifact paths");
      assert.equal(
        fs.readFileSync(result.artifactPaths.outputPath, "utf-8"),
        "full saved output\nwith details",
      );
    });

    it(
      "foreground acceptance rejection preserves an inline saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-inline.md");
        const savedContent = "saved deliverable from an otherwise successful run";
        mockPi.onCall({ output: explicitAcceptanceRejectionOutput(savedContent) });
        const executor = makeExecutor([makeAgent("echo", { completionGuard: false })]);

        const result = await executor.execute(
          "acceptance-rejected-inline",
          {
            agent: "echo",
            task: "Write the report",
            output: outputPath,
            artifacts: true,
            acceptance: { level: "checked", criteria: ["The report is accepted"] },
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.equal(child?.exitCode, 1);
        assert.equal(child?.acceptance?.explicit, true);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        const savedBytes = fs.readFileSync(outputPath);
        assert.equal(savedBytes.toString("utf-8"), savedContent);
        const artifactOutputPath = child?.artifactPaths?.outputPath;
        assert.ok(artifactOutputPath, "expected the supervisor-facing output artifact");
        assert.deepEqual(fs.readFileSync(artifactOutputPath), savedBytes);
        assert.match(child?.error ?? "", /Acceptance rejected/);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
      },
    );

    it(
      "foreground file-only acceptance rejection preserves only the saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "acceptance-rejected-file-only.md");
        const savedContent = "saved file-only deliverable";
        mockPi.onCall({ output: explicitAcceptanceRejectionOutput(savedContent) });
        const executor = makeExecutor([makeAgent("echo", { completionGuard: false })]);

        const result = await executor.execute(
          "acceptance-rejected-file-only",
          {
            agent: "echo",
            task: "Write the report",
            output: outputPath,
            outputMode: "file-only",
            artifacts: true,
            acceptance: { level: "checked", criteria: ["The report is accepted"] },
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, true);
        assert.equal(child?.exitCode, 1);
        assert.equal(child?.acceptance?.explicit, true);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        const savedBytes = fs.readFileSync(outputPath);
        assert.equal(savedBytes.toString("utf-8"), savedContent);
        const artifactOutputPath = child?.artifactPaths?.outputPath;
        assert.ok(artifactOutputPath, "expected the supervisor-facing output artifact");
        assert.deepEqual(fs.readFileSync(artifactOutputPath), savedBytes);
        assert.match(child?.error ?? "", /Acceptance rejected/);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
        assert.doesNotMatch(display, new RegExp(escapeRegExp(savedContent)));
      },
    );

    it(
      "foreground inferred acceptance rejection preserves an inline saved-output reference",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        const outputPath = path.join(tempDir, "inferred-acceptance-rejected.md");
        const savedContent = "saved deliverable without a report";
        mockPi.onCall({ output: inferredAcceptanceRejectionOutput(savedContent) });
        const executor = makeExecutor([makeAgent("worker", { completionGuard: false })]);

        const result = await executor.execute(
          "inferred-acceptance-rejected",
          {
            agent: "worker",
            task: "Implement the approved change",
            output: outputPath,
            artifacts: true,
          },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        const child = result.details?.results?.[0];
        const display = result.content.map((item) => item.text ?? "").join("\n");

        assert.equal(result.isError, undefined);
        assert.equal(child?.exitCode, 0);
        assert.equal(child?.acceptance?.explicit, false);
        assert.equal(child?.acceptance?.status, "rejected");
        assert.equal(child?.savedOutputPath, outputPath);
        assert.equal(fs.readFileSync(outputPath, "utf-8"), savedContent);
        assert.equal((display.match(/Output saved to:/g) ?? []).length, 1);
      },
    );

    it("passes maxSubagentDepth through to child execution env", async () => {
      mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
      const agents = makeAgentConfigs(["echo"]);
      const prevDepth = process.env.PI_SUBAGENT_DEPTH;
      const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_MAX_DEPTH;

      try {
        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "depth-env",
          maxSubagentDepth: 1,
        });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
          PI_SUBAGENT_DEPTH: "1",
          PI_SUBAGENT_MAX_DEPTH: "1",
        });
      } finally {
        if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
        else process.env.PI_SUBAGENT_DEPTH = prevDepth;
        if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
        else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
      }
    });

    it("filters inherited HERDR credentials in the actual foreground child spawn", async () => {
      mockPi.onCall({
        echoEnv: [
          "HERDR_PANE_ID",
          "HERDR_SOCKET_PATH",
          "HERDR_ENV",
          "PI_SUBAGENT_DEPTH",
          "PI_SUBAGENT_MAX_DEPTH",
        ],
      });
      const envKeys = [
        "HERDR_PANE_ID",
        "HERDR_SOCKET_PATH",
        "HERDR_ENV",
        "PI_SUBAGENT_DEPTH",
        "PI_SUBAGENT_MAX_DEPTH",
      ];
      const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
      process.env.HERDR_PANE_ID = "parent-pane-credential";
      process.env.HERDR_SOCKET_PATH = "/tmp/parent-herdr.sock";
      process.env.HERDR_ENV = "1";
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_MAX_DEPTH;

      try {
        const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
          runId: "foreground-herdr-env",
          maxSubagentDepth: 1,
        });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
          HERDR_PANE_ID: null,
          HERDR_SOCKET_PATH: null,
          HERDR_ENV: null,
          PI_SUBAGENT_DEPTH: "1",
          PI_SUBAGENT_MAX_DEPTH: "1",
        });
      } finally {
        for (const [key, value] of previousEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it("passes prompt inheritance env flags through to child execution", async () => {
      mockPi.onCall({
        echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"],
      });
      const agents = [
        makeAgent("echo", {
          systemPromptMode: "replace",
          inheritProjectContext: false,
          inheritSkills: false,
        }),
      ];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "prompt-inheritance-env",
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
        PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
        PI_SUBAGENT_INHERIT_SKILLS: "0",
      });
    });

    it("passes native supervisor metadata through to child execution", async () => {
      mockPi.onCall({
        echoEnv: [
          "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
          "PI_SUBAGENT_RUN_ID",
          "PI_SUBAGENT_CHILD_AGENT",
          "PI_SUBAGENT_CHILD_INDEX",
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "78f659a3",
        index: 2,
        parentSessionId: "session-parent",
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
        PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "session-parent",
        PI_SUBAGENT_RUN_ID: "78f659a3",
        PI_SUBAGENT_CHILD_AGENT: "echo",
        PI_SUBAGENT_CHILD_INDEX: "2",
      });
    });

    it(
      "passes custom tool extensions through even when explicit extensions are allowlisted",
      {
        skip:
          process.platform === "win32"
            ? "extension path resolution intermittent on Windows CI"
            : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const agents = [
          makeAgent("echo", {
            tools: ["read", "./custom-tool.ts"],
            extensions: ["./allowed-ext.ts"],
          }),
        ];

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "tool-extension-allowlist",
        });

        assert.equal(result.exitCode, 0);
        const args = readCallArgs();
        const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
        assert.ok(
          extensionArgs.some((arg) =>
            arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts")),
          ),
        );
        assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("custom-tool.ts")));
        assert.ok(extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
      },
    );

    it(
      "passes subagent-only extensions through to child execution",
      {
        skip:
          process.platform === "win32"
            ? "extension path resolution intermittent on Windows CI"
            : undefined,
      },
      async () => {
        mockPi.onCall({ output: "Done" });
        const agents = [
          makeAgent("echo", {
            tools: ["read"],
            subagentOnlyExtensions: ["./child-only-tool.ts"],
          }),
        ];

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "subagent-only-extension",
        });

        assert.equal(result.exitCode, 0);
        const args = readCallArgs();
        const extensionArgs = args.filter((_arg, index) => args[index - 1] === "--extension");
        assert.ok(
          extensionArgs.some((arg) =>
            arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts")),
          ),
        );
        assert.ok(
          extensionArgs.some((arg) => arg.replace(/\\/g, "/").endsWith("child-only-tool.ts")),
        );
      },
    );

    it("returns an actionable policy failure and writes foreground artifacts", async () => {
      const skillName = "lazy-policy-skill";
      writePackageSkill(tempDir, skillName);
      const artifactsDir = path.join(tempDir, "policy-artifacts");
      const agents = [
        makeAgent("worker", {
          tools: ["./custom-tool.ts"],
          skills: [skillName],
        }),
      ];

      const result = await runSync(tempDir, agents, "worker", "Inspect the task", {
        runId: "invalid-tool-policy",
        tkTicket: { id: "tlhsrhp-o76f", title: "Enforce child tool policy safely" },
        artifactsDir,
        artifactConfig: {
          enabled: true,
          includeInput: true,
          includeOutput: true,
          includeJsonl: true,
          includeMetadata: true,
          includeTranscript: true,
        },
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.tkTicket, {
        id: "tlhsrhp-o76f",
        title: "Enforce child tool policy safely",
      });
      assert.equal(result.error, INVALID_LAZY_SKILL_TOOL_POLICY_ERROR);
      assert.equal(mockPi.callCount(), 0, "invalid policy must not spawn Pi");
      const artifactPaths = result.artifactPaths;
      assert.ok(artifactPaths);
      assert.ok(artifactPaths.outputPath);
      assert.ok(
        fs
          .readFileSync(artifactPaths.outputPath, "utf-8")
          .includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
      );
      assert.ok(fs.existsSync(artifactPaths.metadataPath));
      assert.ok(artifactPaths.transcriptPath);
      assert.ok(fs.existsSync(artifactPaths.transcriptPath));
    });

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

    it("interrupts acceptance verification and returns a paused foreground result", async () => {
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
      mockPi.onCall({ jsonl: [events.assistantMessage(report)] });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const startedAt = Date.now();

      const acceptanceArtifactsDir = path.join(tempDir, "artifacts-acceptance-interrupt");
      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "acceptance-interrupt-metadata",
        artifactsDir: acceptanceArtifactsDir,
        artifactConfig: { enabled: true, includeMetadata: true },
        interruptSignal: controller.signal,
        acceptance: {
          level: "verified",
          verify: [
            {
              id: "slow",
              command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`,
              timeoutMs: 10_000,
            },
          ],
        },
      });

      assert.ok(Date.now() - startedAt < 3_000, "interrupt should abort verification promptly");
      assert.equal(result.exitCode, 0);
      assert.equal(result.interrupted, true);
      assert.equal(result.error, undefined);
      assert.equal(result.acceptance?.status, "skipped");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
      assert.equal(result.acceptance?.verifyRuns?.[0]?.status, undefined);
      assert.match(result.finalOutput ?? "", /Interrupted/);
      assert.ok(result.artifactPaths?.metadataPath);
      const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as {
        exitCode?: number;
        terminationReason?: string;
      };
      // Acceptance interruption happens after the initial child finalization; the
      // metadata must agree with the final returned result, not the pre-acceptance snapshot.
      assert.equal(metadata.exitCode, result.exitCode);
      assert.equal(metadata.terminationReason, result.terminationReason);
      assert.equal(result.terminationReason, "interrupted");
    });

    it("soft-interrupts the current turn and returns a paused result", async () => {
      mockPi.onCall({ delay: 10000 });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();
      const controlEvents: Array<{ type?: string; to?: string }> = [];

      const start = Date.now();
      setTimeout(() => controller.abort(), 200);

      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        runId: "interrupt-run",
        interruptSignal: controller.signal,
        acceptance: { level: "checked", criteria: ["Finish the slow task"] },
        onControlEvent: (event: { type?: string; to?: string }) => {
          controlEvents.push(event);
        },
      });
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
      assert.equal(result.exitCode, 0);
      assert.equal(result.interrupted, true);
      assert.equal(result.progress.activityState, undefined);
      assert.equal(result.acceptance?.status, "skipped");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "paused");
      assert.equal(result.acceptance?.runtimeChecks?.[0]?.status, "not-applicable");
      assert.deepEqual(controlEvents, []);
      assert.match(result.finalOutput ?? "", /Interrupted/);
    });

    it(
      "returns paused foreground single guidance with resume and redispatch commands",
      {
        skip: !createSubagentExecutor ? "executor not importable" : undefined,
      },
      async () => {
        mockPi.onCall({ delay: 10000 });
        const state = {
          baseCwd: tempDir,
          currentSessionId: null,
          asyncJobs: new Map(),
          foregroundRuns: new Map(),
          foregroundControls: new Map(),
          lastForegroundControlId: null,
        };
        const executor = makeExecutor([makeAgent("slow")], {}, state);
        const runPromise = executor.execute(
          "single-pause-run",
          { agent: "slow", task: "Slow task" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );

        const readyDeadline = Date.now() + 5000;
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
        assert.equal(mockPi.callCount(), 1);

        const interruptResult = await executor.execute(
          "single-pause-interrupt",
          { action: "interrupt" },
          new AbortController().signal,
          undefined,
          makeMinimalCtx(tempDir),
        );
        assert.match(
          interruptResult.content[0]?.text ?? "",
          /Interrupt requested for foreground run/,
        );

        const result = await runPromise;
        const text = result.content[0]?.text ?? "";
        assert.equal(result.isError, undefined);
        assert.match(text, /^Foreground run [a-z0-9-]+ paused after interrupt \(slow\)\./);
        assert.match(
          text,
          /Pause succeeded; this foreground run is paused and waiting for your explicit next action, not a dispatch error\./,
        );
        assert.match(
          text,
          /Resume: subagent\(\{ action: "resume", id: "[a-z0-9-]+", message: "\.\.\." \}\)/,
        );
        assert.match(text, /Replace\/re-dispatch: subagent\(\{ agent: "slow", task: "\.\.\." \}\)/);
      },
    );

    it("preserves manual interrupt semantics when a timeout is also configured", async () => {
      mockPi.onCall({ delay: 10000 });
      const agents = makeAgentConfigs(["slow"]);
      const controller = new AbortController();

      setTimeout(() => controller.abort(), 100);
      const result = await runSync(tempDir, agents, "slow", "Slow task", {
        interruptSignal: controller.signal,
        timeoutMs: 500,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.interrupted, true);
      assert.equal(result.timedOut, undefined);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /Interrupted/);
    });

    for (const testCase of [
      {
        name: "contact_supervisor need_decision",
        toolName: "contact_supervisor",
        args: { reason: "need_decision", message: "Need a decision" },
      },
      {
        name: "contact_supervisor interview_request",
        toolName: "contact_supervisor",
        args: { reason: "interview_request", message: "Need input", interview: { questions: [] } },
      },
    ]) {
      it(`pauses foreground children on blocking ${testCase.name}`, async () => {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
            { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: `${testCase.toolName}-blocking-detach`,
          pauseBlockingSupervisor: true,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.interrupted, true);
        assert.equal(result.pause?.kind, "awaiting_supervisor");
        assert.equal(result.pause?.ownerPid, undefined);
        if (testCase.args.reason === "interview_request") {
          assert.deepEqual(result.pause?.request, {
            tool: "contact_supervisor",
            reason: "interview_request",
            summary: "Need input",
          });
          assert.equal(JSON.stringify(result.pause?.request).includes("questions"), false);
        } else {
          assert.deepEqual(result.pause?.request, {
            tool: "contact_supervisor",
            reason: "need_decision",
            summary: "Need a decision",
          });
        }
        assert.match(
          result.finalOutput ?? "",
          /Resume unchanged: subagent\(\{ action: "resume", id: "/,
        );
        assert.match(result.finalOutput ?? "", /No child process is running\./);
        assert.match(result.finalOutput ?? "", /Cancel: subagent\(\{ action: "interrupt", id: /);
      });
    }

    it(
      "reaps stubborn child and grandchild through the full owned-group escalation before publishing paused",
      {
        skip: process.platform === "win32" ? "POSIX process groups are unavailable" : undefined,
      },
      async () => {
        mockPi.onCall({
          ignoreSigint: true,
          ignoreSigterm: true,
          spawnStubbornDescendants: true,
          steps: [
            {
              delay: 250,
              jsonl: [
                events.toolStart("contact_supervisor", {
                  reason: "need_decision",
                  message: "Need a decision",
                }),
              ],
            },
            { delay: 10_000, jsonl: [events.assistantMessage("should not complete")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);
        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: "stubborn-owned-group-pause",
          pauseBlockingSupervisor: true,
        });

        assert.equal(result.pause?.kind, "awaiting_supervisor");
        assert.equal(result.processCleanup?.terminated, true);
        assert.deepEqual(result.processCleanup?.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
        const parentPid = result.processCleanup?.processGroupId;
        assert.ok(parentPid, "expected owned process group id from this spawn");
        const signalLog = fs.readFileSync(
          path.join(mockPi.dir, `signals-${parentPid}.jsonl`),
          "utf-8",
        );
        assert.match(signalLog, /SIGINT/);
        assert.match(signalLog, /SIGTERM/);
        const descendants = JSON.parse(
          fs.readFileSync(path.join(mockPi.dir, `descendants-${parentPid}.json`), "utf-8"),
        ) as { childPid: number; grandchildPid: number };
        for (const pid of [parentPid, descendants.childPid, descendants.grandchildPid]) {
          assert.throws(() => process.kill(pid, 0), /ESRCH/);
        }
      },
    );

    it("persists supervisor pause transitions before signaling and clears owned pid after close", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const transitions: Array<{
        stage: "pausing" | "paused";
        ownerPid?: number;
        result: RunSyncResult;
      }> = [];

      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-ordering",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: (transition: unknown) => {
          transitions.push(
            transition as { stage: "pausing" | "paused"; ownerPid?: number; result: RunSyncResult },
          );
        },
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(
        transitions.map((entry) => entry.stage),
        ["pausing", "paused"],
      );
      assert.equal(typeof transitions[0]?.ownerPid, "number");
      assert.ok((transitions[0]?.ownerPid ?? 0) > 0);
      assert.equal(transitions[0]?.result.pause?.ownerPid, transitions[0]?.ownerPid);
      assert.equal(transitions[1]?.result.pause?.ownerPid, undefined);
      assert.equal(typeof transitions[1]?.result.pause?.pausedAt, "number");
      assert.equal(result.pause?.ownerPid, undefined);
    });

    it("fails explicitly when pre-signal supervisor pause persistence fails", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);

      const secret = "/private/root/pause-persist-secret";
      const result = await runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-persist-fails",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: ({ stage }: { stage: string }) => {
          if (stage === "pausing") throw new Error(`pause persistence failed at ${secret}`);
        },
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.pause, undefined);
      assert.equal(result.interrupted, false);
      assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
      assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
      assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
      assert.equal(result.progress.status, "failed");
    });

    it("fails explicitly when post-reap supervisor pause finalization fails", async () => {
      mockPi.onCall({
        steps: [
          {
            jsonl: [
              events.toolStart("contact_supervisor", {
                reason: "need_decision",
                message: "Need a decision",
              }),
            ],
          },
          { delay: 1000, jsonl: [events.assistantMessage("received pong")] },
        ],
      });
      const agents = makeAgentConfigs(["echo"]);
      const secret = "/private/root/pause-finalize-secret";
      const runPromise = runSync(tempDir, agents, "echo", "Task", {
        runId: "pause-finalize-fails",
        pauseBlockingSupervisor: true,
        onSupervisorPauseTransition: ({ stage }: { stage: string }) => {
          if (stage === "paused") throw new Error(`pause finalization failed at ${secret}`);
        },
      });

      const callDeadline = Date.now() + 5_000;
      let childPid: number | undefined;
      while (Date.now() < callDeadline && childPid === undefined) {
        const callFiles = fs
          .readdirSync(mockPi.dir)
          .filter((name) => name.startsWith("call-") && name.endsWith(".json"))
          .sort();
        const match = callFiles.at(-1)?.match(/^call-\d+-(\d+)-/);
        if (match) childPid = Number(match[1]);
        if (childPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const result = await runPromise;

      assert.ok(childPid, "expected mock child pid");
      assert.throws(() => process.kill(childPid!, 0), /ESRCH/);
      assert.equal(result.exitCode, 1);
      assert.equal(result.pause, undefined);
      assert.equal(result.interrupted, false);
      assert.match(result.error ?? "", /Foreground supervisor lifecycle update failed/);
      assert.match(result.finalOutput ?? "", /Foreground supervisor lifecycle update failed/);
      assert.doesNotMatch(result.finalOutput ?? "", new RegExp(escapeRegExp(secret)));
      assert.doesNotMatch(result.finalOutput ?? "", /Resume unchanged|awaiting supervisor/);
      assert.equal(result.progress.status, "failed");
    });

    for (const testCase of [
      {
        name: "contact_supervisor progress_update",
        toolName: "contact_supervisor",
        args: { reason: "progress_update", message: "FYI" },
      },
    ]) {
      it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
        mockPi.onCall({
          steps: [
            { jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
            { jsonl: [events.toolEnd(testCase.toolName)] },
            { jsonl: [events.assistantMessage("done")] },
          ],
        });
        const agents = makeAgentConfigs(["echo"]);

        const result = await runSync(tempDir, agents, "echo", "Task", {
          runId: `${testCase.toolName}-nonblocking`,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.finalOutput, "done");
        assert.equal(result.progress?.status, "completed");
      });
    }

    it("handles stderr without exit code as info (not error)", async () => {
      mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
      const agents = makeAgentConfigs(["echo"]);

      const result = await runSync(tempDir, agents, "echo", "Task", {});

      assert.equal(result.exitCode, 0);
    });
  },
);
