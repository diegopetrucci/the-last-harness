/**
 * Integration tests for async execution – runner spawn/availability, readStatus,
 * ceilings, launch receipts, acceptance/task-shape conversion, and tool errors.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { spawn, spawnSync } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createEventBus,
  createMockPi,
  createTempDir,
  events,
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
} from "../../src/runs/shared/pi-args.ts";
import { sanitizeModelFallbackNotice } from "../../src/runs/shared/model-fallback.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import { resolveArtifactConfig } from "../../src/shared/artifacts.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  createSubagentExecutor,
  executeAsyncParallel,
  executeAsyncSingle,
  isAsyncAvailable,
  readAsyncPayload,
  readMockPiArgs,
  readStatus,
  waitForAsyncResultFile,
  waitForMockPiCall,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { getAsyncConfigPath } from "../../src/shared/types.ts";
import type {
  RunnerSubagentStep,
  SubagentRunConfig,
} from "../../src/runs/shared/parallel-utils.ts";
import type { ArtifactConfig } from "../../src/shared/types.ts";

type PersistedEventArtifactConfig = ArtifactConfig & {
  /** Internal field is absent from legacy runner envelopes. */
  includeChildEventProjections?: boolean;
};

type PersistedEventRunnerConfig = Omit<SubagentRunConfig, "artifactConfig"> & {
  artifactConfig: PersistedEventArtifactConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEventTypes(asyncDir: string): string[] {
  const eventPath = path.join(asyncDir, "events.jsonl");
  assert.ok(fs.existsSync(eventPath), "runner should persist an event log");
  const text = fs.readFileSync(eventPath, "utf-8").trim();
  assert.ok(text.length > 0, "event log should contain lifecycle records");
  return text.split("\n").map((line, index) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error(`event ${index} should be a JSON object`);
    if (typeof parsed.type !== "string") throw new Error(`event ${index} should have a type`);
    return parsed.type;
  });
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

describe("async execution utilities", () => {
  let tempDir: string;
  let previousAgentDir: string | undefined;
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
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    mockPi.reset();
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    removeTempDir(tempDir);
  });

  function makeAsyncExecutor(agents = [makeAgent("worker")]) {
    return createSubagentExecutor!({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (p: string) => p,
      discoverAgents: () => ({ agents }),
    });
  }

  it("reports the required async runner as available", () => {
    assert.equal(isAsyncAvailable(), true);
  });

  it("spawns the async runner with node when process.execPath is not node", async () => {
    const originalExecPath = process.execPath;
    process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
    try {
      mockPi.onCall({ output: "non-node exec async done" });
      const id = `async-non-node-exec-${Date.now().toString(36)}`;
      const result = executeAsyncSingle(id, {
        agent: "worker",
        task: "Say non-node exec async done. Do not edit files.",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      assert.equal(result.isError, undefined);
      const persistedConfig = JSON.parse(
        fs.readFileSync(getAsyncConfigPath(id), "utf-8"),
      ) as SubagentRunConfig;
      assert.equal(persistedConfig.plan.kind, "single");
      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(payload.success, true);
      assert.equal(payload.results[0]?.output, "non-node exec async done");
    } finally {
      process.execPath = originalExecPath;
    }
  });

  it("falls back to PATH node when node-like process.execPath is stale", async () => {
    const originalExecPath = process.execPath;
    process.execPath = path.join(
      tempDir,
      "deleted-node-install",
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    );
    try {
      mockPi.onCall({ output: "stale node exec async done" });
      const id = `async-stale-node-exec-${Date.now().toString(36)}`;
      const result = executeAsyncSingle(id, {
        agent: "worker",
        task: "Say stale node exec async done. Do not edit files.",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      assert.equal(result.isError, undefined);
      const resultPath = await waitForAsyncResultFile(id);
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      assert.equal(payload.success, true);
      assert.equal(payload.results[0]?.output, "stale node exec async done");
    } finally {
      process.execPath = originalExecPath;
    }
  });

  it("does not fire or retain an above-Node-boundary async agent ceiling", async () => {
    mockPi.onCall({ output: "agent ceiling async done" });
    const id = `async-agent-ceiling-${Date.now().toString(36)}`;
    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Say agent ceiling async done. Do not edit files.",
      agentConfig: makeAgent("worker", { maxExecutionTimeMs: 2_147_483_648 }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.timeoutMs, 2_147_483_648);
    const payload = await readAsyncPayload(id);
    assert.equal(payload.timeoutMs, 2_147_483_648);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.timedOut, undefined);
  });

  it("keeps a shorter async caller timeout below the agent ceiling with a coherent deadline", async () => {
    mockPi.onCall({ output: "caller timeout async done" });
    const id = `async-caller-timeout-${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Say caller timeout async done. Do not edit files.",
      agentConfig: makeAgent("worker", { maxExecutionTimeMs: 2000 }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      timeoutMs: 500,
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.timeoutMs, 500);
    assert.ok(result.details.deadlineAt !== undefined);
    assert.ok(result.details.deadlineAt >= startedAt + 500);
    assert.ok(result.details.deadlineAt <= Date.now() + 500);
    const payload = await readAsyncPayload(id);
    assert.equal(payload.timeoutMs, 500);
    assert.equal(payload.deadlineAt, result.details.deadlineAt);
  });

  it("readStatus returns null for missing directory", () => {
    const status = readStatus("/nonexistent/path/abc123");
    assert.equal(status, null);
  });

  it("readStatus parses valid status file", () => {
    const dir = createTempDir();
    try {
      const statusData = {
        runId: "test-123",
        state: "running",
        mode: "single",
        startedAt: Date.now(),
        lastUpdate: Date.now(),
        steps: [{ agent: "test", status: "running" }],
      };
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

      const status = readStatus(dir);
      assert.ok(status, "should parse status");
      assert.equal(status.runId, "test-123");
      assert.equal(status.state, "running");
      assert.equal(status.mode, "single");
    } finally {
      removeTempDir(dir);
    }
  });

  it("passes native supervisor metadata to background children", async () => {
    mockPi.onCall({
      echoEnv: [
        "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
        "PI_SUBAGENT_RUN_ID",
        "PI_SUBAGENT_CHILD_AGENT",
        "PI_SUBAGENT_CHILD_INDEX",
      ],
    });
    const id = `async-supervisor-metadata-${Date.now().toString(36)}`;
    const run = executeAsyncSingle(id, {
      agent: "worker",
      task: "Echo supervisor metadata",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });
    assert.equal(run.isError, undefined);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(JSON.parse(payload.results[0]?.output ?? "{}"), {
      PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: "session-1",
      PI_SUBAGENT_RUN_ID: id,
      PI_SUBAGENT_CHILD_AGENT: "worker",
      PI_SUBAGENT_CHILD_INDEX: "0",
    });
  });

  it("omits supervisor bridge runtime support for an opted-out async child", async () => {
    mockPi.onCall({ output: "async validation complete" });
    const id = `async-supervisor-bridge-optout-${Date.now().toString(36)}`;
    const run = executeAsyncSingle(id, {
      agent: "test-runner",
      task: "Run validation and report the result without editing files.",
      agentConfig: makeAgent("test-runner", {
        tools: ["bash"],
        supervisorBridge: false,
        systemPrompt: "Prompt prose is not a capability signal.",
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
    });
    assert.equal(run.isError, undefined);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    assert.equal(payload.success, true);

    const args = readMockPiArgs(mockPi, 0);
    assert.equal(args[args.indexOf("--tools") + 1], "bash");
    assert.equal(args[args.indexOf("--exclude-tools") + 1], "contact_supervisor");
    assert.equal(args.includes("--no-tools"), false);
  });

  it("propagates verified packaged provenance through async single and parallel launches", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousGuidanceMarker = process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
    const agentDir = path.join(tempDir, "profile");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";
    const canonicalAgent = (name: "developer" | "code-reviewer") =>
      makeAgent(name, {
        filePath: path.join(agentDir, "tlh", "agents", "subagents", `${name}.md`),
      });
    try {
      mockPi.onCall({ echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] });
      const singleId = `async-packaged-identity-${Date.now().toString(36)}`;
      const commonParams = {
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      };
      const single = executeAsyncSingle(singleId, {
        agent: "developer",
        task: "Echo the developer identity.",
        agentConfig: canonicalAgent("developer"),
        ...commonParams,
      });
      assert.equal(single.isError, undefined);
      const singlePayload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(singleId), "utf-8"),
      ) as AsyncResultPayload;
      assert.deepEqual(JSON.parse(singlePayload.results[0]?.output ?? "{}"), {
        [SUBAGENT_CHILD_AGENT_ENV]: "developer",
        [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "1",
      });

      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      mockPi.onCall({
        echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV],
      });
      const parallelId = `async-packaged-identities-${Date.now().toString(36)}`;
      const parallel = executeAsyncParallel(parallelId, {
        tasks: [
          { agent: "developer", task: "Echo the developer identity." },
          { agent: "code-reviewer", task: "Echo the code-reviewer identity." },
        ],
        agents: [canonicalAgent("developer"), canonicalAgent("code-reviewer")],
        ...commonParams,
      });
      assert.equal(parallel.isError, undefined);
      const parallelPayload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(parallelId), "utf-8"),
      ) as AsyncResultPayload;
      assert.deepEqual(
        parallelPayload.results.map((child) => JSON.parse(child.output)),
        [
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "developer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "1",
          },
          {
            [SUBAGENT_CHILD_AGENT_ENV]: "code-reviewer",
            [SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV]: "1",
          },
        ],
      );
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousGuidanceMarker === undefined)
        delete process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
      else process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = previousGuidanceMarker;
    }
  });

  it("clears inherited provenance for same-name custom async agents", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousGuidanceMarker = process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV];
    const agentDir = path.join(tempDir, "profile");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env[SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] = "1";
    try {
      mockPi.onCall({ echoEnv: [SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV] });
      const id = `async-custom-collision-${Date.now().toString(36)}`;
      const run = executeAsyncSingle(id, {
        agent: "developer",
        task: "Echo the custom collision identity.",
        agentConfig: makeAgent("developer", {
          filePath: path.join(tempDir, "custom", "developer.md"),
        }),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        maxSubagentDepth: 2,
      });
      assert.equal(run.isError, undefined);
      const payload = JSON.parse(
        fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"),
      ) as AsyncResultPayload;
      assert.deepEqual(JSON.parse(payload.results[0]?.output ?? "{}"), {
        [SUBAGENT_CHILD_AGENT_ENV]: "developer",
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

  it("async launch messages stay concise one-line receipts", async () => {
    const artifactConfig = {
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeMetadata: false,
      cleanupDays: 7,
    };
    const commonParams = {
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig,
      shareEnabled: false,
      maxSubagentDepth: 2,
    };
    mockPi.onCall({ output: "single done" });
    const singleId = `async-receipt-single-${Date.now().toString(36)}`;
    const singleResult = executeAsyncSingle(singleId, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
      ...commonParams,
    });
    assert.match(singleResult.content[0]?.text ?? "", /^Async: worker \[[^\]\n]+\]$/);
    assert.doesNotMatch(
      singleResult.content[0]?.text ?? "",
      /Do not run sleep timers or polling loops/,
    );
    assert.equal(singleResult.content[0]?.text?.includes("\n"), false);
    await waitForAsyncResultFile(singleId, scaleTestTimeout(30_000));

    mockPi.onCall({ output: "parallel one done" });
    mockPi.onCall({ output: "parallel two done" });
    const parallelId = `async-receipt-parallel-${Date.now().toString(36)}`;
    const parallelResult = executeAsyncParallel(parallelId, {
      tasks: [
        { agent: "worker", task: "Do one" },
        { agent: "reviewer", task: "Do two" },
      ],
      agents: [makeAgent("worker"), makeAgent("reviewer")],
      ...commonParams,
    });
    assert.match(parallelResult.content[0]?.text ?? "", /^Async parallel: .+ \[[^\]\n]+\]$/);
    assert.doesNotMatch(
      parallelResult.content[0]?.text ?? "",
      /Do not run sleep timers or polling loops/,
    );
    assert.equal(parallelResult.content[0]?.text?.includes("\n"), false);
    const parallelResultPath = await waitForAsyncResultFile(parallelId);
    const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as {
      agent?: string;
      mode?: string;
    };
    assert.equal(parallelPayload.mode, "parallel");
    assert.equal(parallelPayload.agent, "parallel:worker+reviewer");
  });

  it("applies agent acceptance roles to inferred async acceptance", async () => {
    mockPi.onCall({ output: "writer-role complete" });
    const executor = makeAsyncExecutor([makeAgent("reviewer", { acceptanceRole: "writer" })]);

    const result = await executor.execute(
      "async-agent-acceptance-role",
      { agent: "reviewer", task: "Handle the authentication flow", async: true },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected asyncId");
    const payload = await readAsyncPayload(asyncId);
    assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");
  });

  it("applies agent acceptance roles to inferred async parallel acceptance", async () => {
    mockPi.onCall({ output: "parallel exploration complete" });
    const executor = makeAsyncExecutor([makeAgent("worker", { acceptanceRole: "read-only" })]);

    const result = await executor.execute(
      "async-parallel-agent-acceptance-role",
      { tasks: [{ agent: "worker", task: "Explore the authentication flow" }], async: true },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected asyncId");
    const payload = await readAsyncPayload(asyncId);
    assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
  });

  it("top-level async parallel conversion preserves output, reads, and progress", async () => {
    mockPi.onCall({ output: "Async top-level report" });
    const executor = createSubagentExecutor!({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (p: string) => p,
      discoverAgents: () => ({
        agents: [makeAgent("worker", { defaultReads: ["input.md"], defaultProgress: true })],
      }),
    });

    const parentSessionFile = path.join(tempDir, "parent-session", "session.jsonl");
    const ctx = {
      ...makeMinimalCtx(tempDir),
      sessionManager: {
        getSessionId: () => "session-123",
        getSessionFile: () => parentSessionFile,
      },
    };
    const result = await executor.execute(
      "async-parallel-fields",
      {
        tasks: [
          {
            agent: "worker",
            task: "Do async work",
            output: "async-top-output.md",
          },
        ],
        async: true,
      },
      new AbortController().signal,
      undefined,
      ctx,
    );

    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected asyncId");
    const persistedConfig = JSON.parse(
      fs.readFileSync(getAsyncConfigPath(asyncId), "utf-8"),
    ) as SubagentRunConfig;
    assert.equal(persistedConfig.plan.kind, "parallel");
    assert.equal(persistedConfig.plan.tasks.length, 1);
    const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
    const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    assert.equal(payload.mode, "parallel");
    assert.equal(payload.sessionId, parentSessionFile);
    assert.equal(payload.results[0]?.acceptance?.status, "checked");
    assert.equal(status.sessionId, parentSessionFile);
    assert.equal(status.steps?.[0]?.acceptance?.status, "checked");
    const outputPath = path.join(
      tempDir,
      "parent-session",
      "subagent-artifacts",
      "outputs",
      asyncId,
      "async-top-output.md",
    );
    const outputDeadline = Date.now() + scaleTestTimeout(5_000);
    while (!fs.existsSync(outputPath)) {
      if (Date.now() > outputDeadline) {
        assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
    const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
    assert.ok(callFile, "expected a recorded mock pi call");
    const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"))
      .args as string[];
    const taskArg = args.at(-1) ?? "";
    const progressPath = path.join(
      tempDir,
      "parent-session",
      "subagent-artifacts",
      "progress",
      asyncId,
      "progress.md",
    );
    assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
    assert.ok(taskArg.includes(`Update progress at: ${progressPath}`));
    assert.ok(taskArg.includes(`Write your findings to exactly this path: ${outputPath}`));
    assert.equal(fs.existsSync(progressPath), true);
    assert.equal(fs.existsSync(path.join(tempDir, ".pi-subagents", "artifacts")), false);
    assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
  });

  it("async inferred acceptance rejection preserves a saved-output reference", async () => {
    const outputPath = path.join(tempDir, "async-inferred-acceptance-rejected.md");
    const savedContent = "saved async deliverable without a report";
    mockPi.onCall({ output: inferredAcceptanceRejectionOutput(savedContent) });
    const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

    const result = await executor.execute(
      "async-inferred-acceptance-rejected",
      {
        agent: "worker",
        task: "Implement the approved async change",
        output: outputPath,
        async: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );
    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected asyncId");
    const resultPath = await waitForAsyncResultFile(asyncId);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const child = payload.results[0];

    assert.equal(payload.success, true);
    assert.equal(child?.exitCode, 0);
    assert.equal(child?.acceptance?.explicit, false);
    assert.equal(child?.acceptance?.status, "rejected");
    assert.match(child?.output ?? "", /Output saved to:/);
    assert.equal(fs.readFileSync(outputPath, "utf-8"), savedContent);
  });

  it("async single rejects explicit reviewed acceptance before spawning a child", async () => {
    mockPi.onCall({ output: "should not run" });
    const artifactConfig = {
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeMetadata: false,
      cleanupDays: 7,
    };
    const id = `async-acceptance-${Date.now().toString(36)}`;
    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Implement acceptance-covered fix",
      agentConfig: makeAgent("worker", { completionGuard: false }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
      artifactConfig,
      shareEnabled: false,
      maxSubagentDepth: 2,
      acceptance: { level: "reviewed", criteria: ["Patch bug"], review: false },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /reviewed/);
    assert.match(result.content[0]?.text ?? "", /verified/);
    assert.match(result.content[0]?.text ?? "", /verify commands/);
    assert.match(result.content[0]?.text ?? "", /checked/);
    assert.equal(mockPi.callCount(), 0);
    assert.equal(fs.existsSync(path.join(ASYNC_DIR, id)), false);
    assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)), false);
  });

  it("top-level async single suppresses progress for review-only tasks", async () => {
    mockPi.onCall({ output: "Async review" });
    const executor = createSubagentExecutor!({
      pi: { events: createEventBus(), getSessionName: () => undefined },
      state: {
        baseCwd: tempDir,
        currentSessionId: null,
        asyncJobs: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
      },
      config: {},
      tempArtifactsDir: tempDir,
      getSubagentSessionRoot: () => tempDir,
      expandTilde: (p: string) => p,
      discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
    });

    const result = await executor.execute(
      "async-single-read-only-progress",
      {
        agent: "reviewer",
        task: "Review-only. Do not edit files. Return findings.",
        async: true,
      },
      new AbortController().signal,
      undefined,
      makeMinimalCtx(tempDir),
    );

    const asyncId = result.details?.asyncId;
    assert.ok(asyncId, "expected asyncId");
    const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
    const deadline = Date.now() + scaleTestTimeout(10_000);
    while (!fs.existsSync(resultPath)) {
      if (Date.now() > deadline)
        assert.fail(`Timed out waiting for async result file: ${resultPath}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
    assert.ok(callFile, "expected a recorded mock pi call");
    const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8"))
      .args as string[];
    assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
    assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
  });

  it("readStatus caches unchanged files and invalidates same-mtime replacements", () => {
    const dir = createTempDir();
    try {
      const statusPath = path.join(dir, "status.json");
      const fixedTimestamp = new Date(1_700_000_000_000);
      const statusData = {
        runId: "cache-test",
        state: "running",
        mode: "single",
        startedAt: fixedTimestamp.getTime(),
      };
      fs.writeFileSync(statusPath, JSON.stringify(statusData));
      fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);

      const cached = readStatus(dir);
      assert.ok(cached);
      assert.strictEqual(readStatus(dir), cached);

      writeAtomicJson(statusPath, { ...statusData, state: "stopped" });
      fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
      assert.equal(fs.statSync(statusPath).mtimeMs, fixedTimestamp.getTime());
      const replaced = readStatus(dir);
      assert.ok(replaced);
      assert.equal(replaced.state, "stopped");
      assert.notStrictEqual(replaced, cached);
    } finally {
      removeTempDir(dir);
    }
  });

  it("readStatus throws for malformed status files", () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
      assert.throws(() => readStatus(dir), /Failed to parse async status file/);
    } finally {
      removeTempDir(dir);
    }
  });

  it("rejects a durable runner config without a valid direct plan", () => {
    const id = `async-missing-run-plan-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const config: Record<string, unknown> = {
      id,
      resultPath,
      cwd: tempDir,
      asyncDir,
      sessionId: "session-missing-run-plan",
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const runner = spawnSync(process.execPath, [runnerPath, configPath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env },
    });

    assert.equal(runner.status, 1, runner.stderr);
    assert.equal(fs.existsSync(configPath), false, "runner should consume its persisted config");
    assert.match(runner.stderr, /valid direct plan/);
    assert.ok(fs.existsSync(resultPath), "runner should persist a result artifact");
    const statusPath = path.join(asyncDir, "status.json");
    assert.ok(fs.existsSync(statusPath), "runner should persist status");

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    const expectedDiagnostic = "Async runner config must include a valid direct plan.";
    assert.equal(payload.state, "failed");
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.error, expectedDiagnostic);
    assert.equal(payload.results.length, 0);
    assert.equal(payload.mode, "single");
    assert.equal(status.state, "failed");
    assert.equal(status.error, expectedDiagnostic);
    assert.equal(status.mode, "single");
    assert.equal(status.steps?.length, 0);

    const malformedConfigPath = path.join(tempDir, "async-malformed-envelope-config.json");
    fs.writeFileSync(
      malformedConfigPath,
      JSON.stringify({
        id: "async-malformed-envelope",
        resultPath: path.join(tempDir, "async-malformed-envelope-result.json"),
        cwd: tempDir,
      }),
      "utf-8",
    );
    const malformedRunner = spawnSync(process.execPath, [runnerPath, malformedConfigPath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env },
    });
    assert.equal(malformedRunner.status, 1, malformedRunner.stderr);
    assert.match(malformedRunner.stderr, /config is malformed/);
    assert.equal(
      fs.existsSync(malformedConfigPath),
      false,
      "valid JSON with a malformed envelope should still be consumed",
    );

    const unparseableConfigPath = path.join(tempDir, "async-unparseable-config.json");
    fs.writeFileSync(unparseableConfigPath, "{bad-json", "utf-8");
    const unparseableRunner = spawnSync(process.execPath, [runnerPath, unparseableConfigPath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env },
    });
    assert.equal(unparseableRunner.status, 1, unparseableRunner.stderr);
    assert.ok(
      fs.existsSync(unparseableConfigPath),
      "unparseable JSON should retain the config file",
    );
  });

  it("rejects retired structured-output plans before launching a child", () => {
    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const cases = [
      {
        label: "single-file",
        plan: {
          kind: "single",
          task: {
            agent: "worker",
            task: "This child must not launch.",
            structuredOutput: { schemaPath: "retired" },
          },
        },
        useStdin: false,
        expectedMode: "single",
      },
      {
        label: "parallel-stdin",
        plan: {
          kind: "parallel",
          tasks: [
            {
              agent: "worker",
              task: "This child must not launch.",
              structuredOutputSchema: { type: "object" },
            },
          ],
        },
        useStdin: true,
        expectedMode: "parallel",
      },
    ] as const;

    for (const testCase of cases) {
      const id = `async-retired-structured-${testCase.label}-${Date.now().toString(36)}`;
      const asyncDir = path.join(tempDir, id);
      const resultPath = path.join(tempDir, `${id}-result.json`);
      const configPath = path.join(tempDir, `${id}-config.json`);
      const config = {
        id,
        plan: testCase.plan,
        resultPath,
        cwd: tempDir,
        asyncDir,
        sessionId: `session-${id}`,
      };
      const configJson = JSON.stringify(config);
      if (!testCase.useStdin) fs.writeFileSync(configPath, configJson, "utf-8");

      const runner = spawnSync(
        process.execPath,
        testCase.useStdin ? [runnerPath] : [runnerPath, configPath],
        {
          cwd: process.cwd(),
          encoding: "utf-8",
          input: testCase.useStdin ? configJson : undefined,
          env: { ...process.env },
        },
      );

      assert.equal(runner.status, 1, `${testCase.label}: ${runner.stderr}`);
      assert.match(runner.stderr, /restart.*without.*properties/i, testCase.label);
      assert.equal(mockPi.callCount(), 0, `${testCase.label}: child runner must not launch Pi`);
      assert.ok(
        fs.existsSync(resultPath),
        `${testCase.label}: runner should persist a result artifact`,
      );
      const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
      const statusPath = path.join(asyncDir, "status.json");
      assert.ok(
        fs.existsSync(statusPath),
        `${testCase.label}: runner should persist a status artifact`,
      );
      const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      assert.equal(payload.state, "failed", testCase.label);
      assert.equal(payload.success, false, testCase.label);
      assert.equal(payload.mode, testCase.expectedMode, `${testCase.label}: result mode`);
      assert.equal(status.state, "failed", testCase.label);
      assert.equal(status.mode, testCase.expectedMode, `${testCase.label}: status mode`);
      assert.equal(
        payload.error,
        "Async runner config contains unsupported structuredOutput or structuredOutputSchema task properties. Structured output contracts are retired; restart with a new direct single or parallel run without those properties.",
        testCase.label,
      );
    }
  });

  it("persists a failed runner result for invalid path-only lazy-skill policy", () => {
    const id = `async-invalid-tool-policy-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const artifactsDir = path.join(tempDir, `${id}-artifacts`);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const config: SubagentRunConfig = {
      id,
      plan: {
        kind: "single",
        task: {
          agent: "worker",
          task: "Inspect the task",
          tools: ["./custom-tool.ts"],
          skills: ["tmux"],
          inheritProjectContext: false,
          inheritSkills: false,
          systemPrompt: "You are a test agent.",
        },
      },
      resultPath,
      cwd: tempDir,
      asyncDir,
      artifactsDir,
      artifactConfig: {
        mode: "debug",
        enabled: true,
        includeInput: true,
        includeOutput: true,
        includeJsonl: true,
        includeMetadata: true,
        includeTranscript: true,
        includeChildEventProjections: true,
        cleanupDays: 7,
      },
      sessionId: "session-invalid-tool-policy",
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const runner = spawnSync(process.execPath, [runnerPath, configPath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env },
    });

    assert.equal(runner.status, 0, runner.stderr);
    assert.equal(fs.existsSync(configPath), false, "runner should consume its persisted config");
    assert.ok(fs.existsSync(resultPath), "runner should persist a result artifact");
    assert.ok(fs.existsSync(path.join(asyncDir, "status.json")), "runner should persist status");

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, "failed");
    assert.equal(payload.success, false);
    assert.equal(payload.error, INVALID_LAZY_SKILL_TOOL_POLICY_ERROR);
    assert.equal(status.state, "failed");
    assert.equal(status.steps?.[0]?.status, "failed");
    assert.equal(status.steps?.[0]?.error, INVALID_LAZY_SKILL_TOOL_POLICY_ERROR);
    const artifactPaths = payload.results[0]?.artifactPaths;
    assert.ok(artifactPaths, "failed runner result should retain artifact paths");
    assert.ok(fs.existsSync(artifactPaths.inputPath));
    assert.ok(fs.existsSync(artifactPaths.outputPath));
    assert.ok(fs.existsSync(artifactPaths.metadataPath));
    assert.ok(
      fs
        .readFileSync(artifactPaths.outputPath, "utf-8")
        .includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
    );
  });

  it("enforces the compact profile at the persisted runner boundary", () => {
    const id = `async-persisted-compact-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const sessionFile = path.join(tempDir, `${id}-session.jsonl`);
    const outputFile = path.join(asyncDir, "output-0.log");
    mockPi.onCall({ output: "persisted compact result" });
    const config: SubagentRunConfig = {
      id,
      plan: {
        kind: "single",
        task: {
          agent: "worker",
          task: "Inspect the persisted profile.",
          inheritProjectContext: false,
          inheritSkills: false,
          sessionFile,
        },
      },
      resultPath,
      cwd: tempDir,
      asyncDir,
      artifactsDir: path.join(tempDir, `${id}-artifacts`),
      piArgv1: path.join(path.dirname(mockPi.dir), "pi-coding-agent", "dist", "cli.mjs"),
      // Contradictory legacy flags must not escalate an explicit compact mode.
      artifactConfig: {
        mode: "compact",
        enabled: true,
        includeInput: true,
        includeOutput: true,
        includeJsonl: true,
        includeMetadata: true,
        includeTranscript: true,
        includeChildEventProjections: false,
        cleanupDays: 7,
      },
      sessionId: `session-${id}`,
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const persisted: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!isRecord(persisted)) throw new Error("persisted runner config should be an object");
    if (!isRecord(persisted.artifactConfig))
      throw new Error("persisted runner config should include artifactConfig");
    assert.equal(persisted.artifactConfig.mode, "compact");

    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const runner = spawnSync(process.execPath, [runnerPath, configPath], {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { ...process.env },
    });

    assert.equal(runner.status, 0, runner.stderr);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    const artifactPaths = payload.results[0]?.artifactPaths;
    assert.ok(artifactPaths, "compact runner result should retain artifact paths");
    assert.equal(status.runId, id);
    assert.equal(status.mode, "single");
    assert.equal(status.state, "complete");
    assert.equal(status.sessionFile, sessionFile);
    assert.equal(status.steps?.[0]?.sessionFile, sessionFile);
    assert.equal(status.steps?.[0]?.transcriptPath, undefined);
    assert.equal(status.outputFile, outputFile);
    assert.equal(fs.existsSync(outputFile), true);
    assert.match(fs.readFileSync(outputFile, "utf-8"), /persisted compact result/);
    assert.equal(payload.id, id);
    assert.equal(payload.mode, status.mode);
    assert.equal(payload.state, status.state);
    assert.equal(payload.asyncDir, asyncDir);
    assert.equal(payload.results[0]?.sessionFile, sessionFile);
    assert.equal(fs.existsSync(artifactPaths.inputPath), false);
    assert.equal(fs.existsSync(artifactPaths.transcriptPath), false);
    assert.equal(fs.existsSync(artifactPaths.jsonlPath), false);
    assert.equal(fs.existsSync(artifactPaths.outputPath), true);
    assert.match(fs.readFileSync(artifactPaths.outputPath, "utf-8"), /persisted compact result/);
    assert.equal(fs.existsSync(artifactPaths.metadataPath), true);
    assert.equal(payload.results[0]?.transcriptPath, undefined);
  });

  it("suppresses compact child projections while retaining detailed legacy event logs", () => {
    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const piArgv1 = path.join(path.dirname(mockPi.dir), "pi-coding-agent", "dist", "cli.mjs");
    const runProfile = (
      label: string,
      artifactConfig: PersistedEventArtifactConfig,
    ): { asyncDir: string; eventTypes: string[]; output: string } => {
      const id = `async-event-projections-${label}-${Date.now().toString(36)}`;
      const asyncDir = path.join(tempDir, id);
      const resultPath = path.join(tempDir, `${id}-result.json`);
      const configPath = path.join(tempDir, `${id}-config.json`);
      mockPi.onCall({
        jsonl: [
          events.toolStart("read", { path: "fixture.txt" }),
          events.toolEnd("read"),
          events.toolResult("read", "tool result"),
          events.assistantMessage("canonical result"),
          { type: "future_child_event", payload: "unknown" },
          "raw child stdout",
        ],
        stderr: "raw child stderr\n",
      });
      const config: PersistedEventRunnerConfig = {
        id,
        plan: {
          kind: "single",
          task: {
            agent: "worker",
            task: "Exercise event projection policy.",
            inheritProjectContext: false,
            inheritSkills: false,
          },
        },
        resultPath,
        cwd: tempDir,
        asyncDir,
        artifactConfig,
        piArgv1,
        sessionId: `session-${id}`,
      };
      fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
      const runner = spawnSync(process.execPath, [runnerPath, configPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env },
      });
      assert.equal(runner.status, 0, `${label}: ${runner.stderr}`);
      const outputPath = path.join(asyncDir, "output-0.log");
      assert.ok(fs.existsSync(outputPath), `${label}: runner should preserve output log`);
      return {
        asyncDir,
        eventTypes: readEventTypes(asyncDir),
        output: fs.readFileSync(outputPath, "utf-8"),
      };
    };

    const compact = runProfile("compact", resolveArtifactConfig({ mode: "compact" }));
    assert.deepEqual(compact.eventTypes, [
      "subagent.run.started",
      "subagent.step.started",
      "subagent.step.completed",
      "subagent.run.completed",
    ]);
    assert.match(compact.output, /canonical result/);
    assert.match(compact.output, /raw child stdout/);
    assert.match(compact.output, /raw child stderr/);

    const debug = runProfile("debug", resolveArtifactConfig({ mode: "debug" }));
    const debugProjectionTypes = [
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "tool_result_end",
      "future_child_event",
      "subagent.child.stdout",
      "subagent.child.stderr",
    ];
    for (const type of debugProjectionTypes) {
      assert.ok(debug.eventTypes.includes(type), `debug event log should include ${type}`);
    }
    assert.ok(debug.eventTypes.includes("subagent.run.started"));
    assert.ok(debug.eventTypes.includes("subagent.run.completed"));

    const legacyArtifactConfig: PersistedEventArtifactConfig = {
      // In-flight runs from the artifact-profile rollout have a mode but not
      // the child-projection flag introduced by this ticket.
      mode: "compact",
      enabled: true,
      includeInput: true,
      includeOutput: true,
      includeJsonl: true,
      includeTranscript: true,
      includeMetadata: true,
      cleanupDays: 7,
    };
    const legacy = runProfile("legacy", legacyArtifactConfig);
    assert.deepEqual(
      new Set(legacy.eventTypes),
      new Set(debug.eventTypes),
      "legacy envelopes without the internal flag should retain detailed projections",
    );
  });

  it("sanitizes persisted fallback notices in both initial status step projections", async () => {
    const id = `async-persisted-fallback-notice-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const releaseMarker = path.join(tempDir, `${id}-release`);
    const persistedNotice = `\u0000${"Persisted fallback notice ".repeat(40)}\nwith control text`;
    const expectedNotice = sanitizeModelFallbackNotice(persistedNotice);
    assert.ok(expectedNotice);

    mockPi.onCall({ waitForMarker: releaseMarker, output: "done" });
    const model = "mock/test-model";
    const step = {
      agent: "worker",
      task: "Inspect the task",
      model,
      modelCandidates: [model],
      modelFallbackFilterNotice: persistedNotice,
      inheritProjectContext: false,
      inheritSkills: false,
    } satisfies RunnerSubagentStep & {
      modelFallbackFilterNotice: string;
    };
    const config: SubagentRunConfig = {
      id,
      plan: {
        kind: "parallel",
        tasks: [step, { ...step, task: "Inspect the parallel task" }],
      },
      resultPath,
      cwd: tempDir,
      asyncDir,
      artifactConfig: {
        mode: "compact",
        enabled: true,
        includeInput: false,
        includeOutput: true,
        includeJsonl: false,
        includeMetadata: true,
        includeTranscript: false,
        includeChildEventProjections: false,
        cleanupDays: 7,
      },
      piArgv1: path.join(path.dirname(mockPi.dir), "pi-coding-agent", "dist", "cli.mjs"),
      sessionId: "session-persisted-fallback-notice",
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const runner = spawn(process.execPath, [runnerPath, configPath], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const runnerStderr: Buffer[] = [];
    runner.stderr?.on("data", (chunk: Buffer) => runnerStderr.push(chunk));
    const runnerExited = new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("close", resolve);
    });

    try {
      const statusPath = path.join(asyncDir, "status.json");
      const deadline = Date.now() + scaleTestTimeout(15_000);
      while (!fs.existsSync(statusPath)) {
        if (Date.now() > deadline) assert.fail("Timed out waiting for initial runner status");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const initialStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
      assert.deepEqual(
        initialStatus.steps?.map((entry) => entry.modelFallbackNotice),
        [expectedNotice, expectedNotice],
      );
      assert.ok(expectedNotice.length <= 240);
      assert.equal(
        [...expectedNotice].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 0x1f || code === 0x7f;
        }),
        false,
      );
    } finally {
      fs.writeFileSync(releaseMarker, "", "utf-8");
      const exitCode = await runnerExited;
      assert.equal(exitCode, 0, Buffer.concat(runnerStderr).toString("utf-8"));
    }
  });

  it("hard-kills async children that ignore timeout SIGTERM", async () => {
    mockPi.onCall({ delay: 60_000, ignoreSigterm: true, output: "too late" });
    const id = `async-timeout-hard-kill-${Date.now().toString(36)}`;
    // Scale with TLH_TEST_TIMEOUT_SCALE so the run deadline does not fire before
    // the child is spawned and recorded on a loaded CI runner (corrected rule:
    // index 0 is just as exposed as any other index).
    const timeoutMs = scaleTestTimeout(1_500);
    // Mirrors the production TIMEOUT_HARD_KILL_MS constant in subagent-runner.ts.
    // It is NOT scaled because it is a fixed platform constant, not a test input.
    const TIMEOUT_HARD_KILL_MS_MIRROR = 3_000;
    // Invariant: elapsedBound must stay well below the mock child's 60_000ms delay
    // at every supported scale, proving the child was hard-killed rather than
    // allowed to finish. At scale=6: (9_000 + 3_000 + 12_000) = 24_000 << 60_000.
    const elapsedBound = timeoutMs + TIMEOUT_HARD_KILL_MS_MIRROR + scaleTestTimeout(2_000);
    const startedAt = Date.now();
    executeAsyncSingle(id, {
      agent: "stubborn",
      task: "Ignore soft termination",
      agentConfig: makeAgent("stubborn", {
        model: "primary-model",
        fallbackModels: ["fallback-model"],
      }),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      maxSubagentDepth: 2,
      timeoutMs,
    });

    await waitForMockPiCall(mockPi, 0);
    const resultPath = await waitForAsyncResultFile(id);
    const elapsedMs = Date.now() - startedAt;
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.state, "failed");
    assert.equal(payload.timedOut, true);
    assert.equal(payload.results[0]?.timedOut, true);
    assert.equal(payload.results[0]?.error, `Subagent timed out after ${timeoutMs}ms.`);
    assert.equal(status.timedOut, true);
    assert.equal(status.steps?.[0]?.timedOut, true);
    assert.ok(
      elapsedMs < elapsedBound,
      `timeout result should settle after hard kill, elapsed ${elapsedMs}ms (bound: ${elapsedBound}ms)`,
    );
    assert.equal(mockPi.callCount(), 1);
  });

  it("returns a tool error when the detached runner config cannot be written", () => {
    const id = `async-write-fail-${Date.now().toString(36)}`;
    assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
    fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
    assert.match(result.content[0]?.text ?? "", /async-cfg-/);
  });

  it("returns a tool error when an async run uses a missing cwd", () => {
    const id = `async-missing-cwd-${Date.now().toString(36)}`;
    const missingCwd = path.join(tempDir, "missing-cwd");

    const singleResult = executeAsyncSingle(id, {
      agent: "worker",
      task: "Do work",
      agentConfig: makeAgent("worker"),
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      cwd: missingCwd,
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(singleResult.isError, true);
    assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
    assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

    const parallelId = `async-missing-cwd-parallel-${Date.now().toString(36)}`;
    const parallelResult = executeAsyncParallel(parallelId, {
      tasks: [{ agent: "worker", task: "Do work" }],
      agents: [makeAgent("worker")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
      cwd: missingCwd,
      artifactConfig: {
        enabled: false,
        includeInput: false,
        includeOutput: false,
        includeJsonl: false,
        includeMetadata: false,
        cleanupDays: 7,
      },
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });

    assert.equal(parallelResult.isError, true);
    assert.match(parallelResult.content[0]?.text ?? "", /Failed to start async parallel/);
    assert.match(parallelResult.content[0]?.text ?? "", /cwd does not exist/);
  });

  it("returns a tool error when the async runner process cannot spawn", () => {
    const originalExecPath = process.execPath;
    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const originalPath = process.env[pathKey];
    process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
    process.env[pathKey] = tempDir;
    try {
      const id = `async-spawn-fail-${Date.now().toString(36)}`;
      const result = executeAsyncSingle(id, {
        agent: "worker",
        task: "Do work",
        agentConfig: makeAgent("worker"),
        ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot: path.join(tempDir, "sessions"),
        maxSubagentDepth: 2,
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
      assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
    } finally {
      process.execPath = originalExecPath;
      if (originalPath === undefined) {
        delete process.env[pathKey];
      } else {
        process.env[pathKey] = originalPath;
      }
    }
  });
});
