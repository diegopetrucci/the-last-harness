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
  makeAgent,
  makeMinimalCtx,
  removeTempDir,
} from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { deliverInterruptRequest } from "../../src/runs/background/control-channel.ts";
import {
  SUBAGENT_CHILD_AGENT_ENV,
  SUBAGENT_PROJECT_AGENT_GUIDANCE_ENV,
  INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
} from "../../src/runs/shared/pi-args.ts";
import { sanitizeModelFallbackNotice } from "../../src/runs/shared/model-fallback.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  createSubagentExecutor,
  executeAsyncChain,
  executeAsyncSingle,
  isAsyncAvailable,
  readAsyncPayload,
  readMockPiArgs,
  readMockPiArgsMatching,
  readStatus,
  waitForAsyncControlCondition,
  waitForAsyncResultFile,
  waitForMockPiCall,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { getAsyncConfigPath } from "../../src/shared/types.ts";
import type { SubagentRunConfig } from "../../src/runs/shared/parallel-utils.ts";

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
      assert.equal(persistedConfig.steps, undefined);
      assert.equal(persistedConfig.plan?.kind, "single");
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
      const parallel = executeAsyncChain(parallelId, {
        chain: [
          {
            parallel: [
              { agent: "developer", task: "Echo the developer identity." },
              { agent: "code-reviewer", task: "Echo the code-reviewer identity." },
            ],
          },
        ],
        resultMode: "parallel",
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
    const parallelResult = executeAsyncChain(parallelId, {
      chain: [
        {
          parallel: [
            { agent: "worker", task: "Do one" },
            { agent: "reviewer", task: "Do two" },
          ],
        },
      ],
      resultMode: "parallel",
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

    mockPi.onCall({ output: "chain done" });
    const chainId = `async-receipt-chain-${Date.now().toString(36)}`;
    const chainResult = executeAsyncChain(chainId, {
      chain: [{ agent: "worker", task: "Do chained work" }],
      agents: [makeAgent("worker")],
      ...commonParams,
    });
    assert.match(chainResult.content[0]?.text ?? "", /^Async chain: .+ \[[^\]\n]+\]$/);
    assert.doesNotMatch(
      chainResult.content[0]?.text ?? "",
      /Do not run sleep timers or polling loops/,
    );
    assert.equal(chainResult.content[0]?.text?.includes("\n"), false);
    await waitForAsyncResultFile(chainId);
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

  it("infers async chain acceptance after expanding top-level task templates", async () => {
    mockPi.onCall({ output: "patched" });
    mockPi.onCall({ output: "reviewed" });

    const patchId = `async-role-task-template-patch-${Date.now().toString(36)}`;
    executeAsyncChain(patchId, {
      task: "Patch src/auth.ts",
      chain: [{ agent: "explorer", task: "{task}" }],
      agents: [makeAgent("explorer", { acceptanceRole: "read-only" })],
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-role-task-patch",
      },
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
    const patchPayload = await readAsyncPayload(patchId);
    assert.equal(patchPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");

    const reviewId = `async-role-task-template-review-${Date.now().toString(36)}`;
    executeAsyncChain(reviewId, {
      task: "Review only; do not edit files",
      chain: [{ agent: "implementer", task: "{task}" }],
      agents: [makeAgent("implementer", { acceptanceRole: "writer" })],
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-role-task-review",
      },
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
    const reviewPayload = await readAsyncPayload(reviewId);
    assert.equal(reviewPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "attested");
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
      discoverAgents: () => ({ agents: [makeAgent("worker", { defaultProgress: true })] }),
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
            reads: ["input.md"],
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
    assert.equal(persistedConfig.steps, undefined);
    assert.equal(persistedConfig.plan?.kind, "parallel");
    assert.equal(
      persistedConfig.plan?.kind === "parallel" ? persistedConfig.plan.tasks.length : undefined,
      1,
    );
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
    assert.equal(status.workflowGraph?.mode, "parallel");
    assert.equal(status.workflowGraph?.nodes[0]?.kind, "parallel-group");
    assert.equal(status.workflowGraph?.nodes[0]?.children?.[0]?.agent, "worker");
    assert.equal(status.chainStepCount, 1);
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

  it("async chains reject malformed named output references before spawning", async () => {
    const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
    const result = executeAsyncChain(id, {
      chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
      agents: [makeAgent("consumer")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
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

    assert.equal(result.isError, true);
    assert.match(
      result.content[0]?.text ?? "",
      /Invalid chain output reference '\{outputs\.bad-name\}'/,
    );
    assert.equal(mockPi.callCount(), 0);
  });

  it("async chains persist structured outputs, named outputs, and graph labels", async () => {
    const schema = {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" } },
    };
    mockPi.onCall({ structuredOutput: { value: "Alpha structured" } });
    mockPi.onCall({ output: "used named output" });
    const id = `async-structured-chain-${Date.now().toString(36)}`;
    const result = executeAsyncChain(id, {
      chain: [
        {
          agent: "producer",
          task: "Produce data",
          phase: "Collect",
          label: "Produce structured data",
          as: "data",
          outputSchema: schema,
        },
        { agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
      ],
      agents: [makeAgent("producer"), makeAgent("consumer")],
      ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
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

    assert.ok(!result.isError);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
    assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
    assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
    assert.equal(status.steps?.[0]?.label, "Produce structured data");
    assert.equal(status.steps?.[0]?.phase, "Collect");
    assert.equal(status.steps?.[0]?.outputName, "data");
    assert.equal(status.steps?.[0]?.structured, true);
    assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
    assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
    assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
    assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
  });

  it("async chains can start parallel, funnel into one step, then fan back out", async () => {
    mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A async findings" });
    mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B async findings" });
    mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Async funnel synthesis" });
    mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Async reviewer A done" });
    mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Async reviewer B done" });
    const id = `async-parallel-funnel-fanout-${Date.now().toString(36)}`;
    const result = executeAsyncChain(id, {
      chain: [
        {
          parallel: [
            { agent: "scout-a", task: "Scout API" },
            { agent: "scout-b", task: "Scout UI" },
          ],
          concurrency: 2,
        },
        { agent: "synthesizer", task: "Synthesize:\n{previous}" },
        {
          parallel: [
            { agent: "review-a", task: "Review funnel A:\n{previous}" },
            { agent: "review-b", task: "Review funnel B:\n{previous}" },
          ],
          concurrency: 2,
        },
      ],
      agents: [
        makeAgent("scout-a"),
        makeAgent("scout-b"),
        makeAgent("synthesizer"),
        makeAgent("review-a"),
        makeAgent("review-b"),
      ],
      ctx: {
        pi: { events: { emit() {} } },
        cwd: tempDir,
        currentSessionId: "session-parallel-funnel-fanout",
      },
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

    assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
    const resultPath = await waitForAsyncResultFile(id);
    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(payload.success, true);
    assert.deepEqual(
      payload.results.map((entry) => entry.output),
      [
        "Scout A async findings",
        "Scout B async findings",
        "Async funnel synthesis",
        "Async reviewer A done",
        "Async reviewer B done",
      ],
    );
    assert.deepEqual(
      status.steps?.map((step) => step.status),
      ["complete", "complete", "complete", "complete", "complete"],
    );
    assert.deepEqual(status.parallelGroups, [
      { start: 0, count: 2, stepIndex: 0 },
      { start: 3, count: 2, stepIndex: 2 },
    ]);
    const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
    assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
    assert.match(funnelTask, /Scout A async findings/);
    assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
    assert.match(funnelTask, /Scout B async findings/);
    assert.match(
      readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "",
      /Review funnel A:\nAsync funnel synthesis/,
    );
    assert.match(
      readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "",
      /Review funnel B:\nAsync funnel synthesis/,
    );
    assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
    assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
    assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
    assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
    assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
    assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
  });

  it(
    "paused sequential resumes keep the later child session instead of a pre-launch sibling session",
    {
      skip:
        process.platform === "win32"
          ? "cross-process interrupt delivery unreliable on Windows CI"
          : undefined,
    },
    async () => {
      mockPi.onCall({ delay: 500, output: "first done" });
      mockPi.onCall({ delay: 5_000, output: "second done" });
      const id = `async-paused-sequential-session-${Date.now().toString(36)}`;
      const sessionRoot = path.join(tempDir, "session-root-sequential");
      executeAsyncChain(id, {
        chain: [
          { agent: "worker", task: "First step" },
          { agent: "worker", task: "Second step" },
        ],
        resultMode: "chain",
        agents: [makeAgent("worker")],
        ctx: {
          pi: { events: { emit() {} } },
          cwd: tempDir,
          currentSessionId: "session-sequential",
        },
        artifactConfig: {
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        shareEnabled: false,
        sessionRoot,
        maxSubagentDepth: 2,
      });

      const asyncDir = path.join(ASYNC_DIR, id);
      const statusPath = path.join(asyncDir, "status.json");
      const sessionDir = path.join(sessionRoot, `async-${id}`);
      const firstSessionFile = path.join(sessionDir, "first.jsonl");
      const secondSessionFile = path.join(sessionDir, "second.jsonl");

      await waitForAsyncControlCondition(
        asyncDir,
        (status) => status.steps?.[0]?.status === "running",
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(firstSessionFile, "", "utf-8");
      await waitForAsyncControlCondition(
        asyncDir,
        (status) =>
          status.steps?.[0]?.status === "complete" && status.steps?.[1]?.status === "running",
      );
      fs.writeFileSync(secondSessionFile, "", "utf-8");

      const statusBeforeInterrupt = JSON.parse(
        fs.readFileSync(statusPath, "utf-8"),
      ) as AsyncStatusPayload & {
        pid?: number;
      };
      deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

      const { status } = await waitForAsyncControlCondition(
        asyncDir,
        (current) => current.state === "paused" && current.steps?.[1]?.status === "paused",
      );
      assert.equal(status.steps?.[0]?.sessionFile, path.resolve(firstSessionFile));
      assert.equal(status.steps?.[1]?.sessionFile, path.resolve(secondSessionFile));
      const target = resolveAsyncResumeTarget(
        { id, index: 1 },
        { asyncDirRoot: ASYNC_DIR, resultsDir: RESULTS_DIR },
      );
      assert.equal(target.kind, "revive");
      assert.equal(target.sessionFile, path.resolve(secondSessionFile));
    },
  );

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

  it("rejects a durable runner config without a direct plan or legacy steps", () => {
    const id = `async-missing-run-plan-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const config = {
      id,
      resultPath,
      cwd: tempDir,
      placeholder: "{previous}",
      asyncDir,
      resultMode: "single",
      sessionId: "session-missing-run-plan",
    } satisfies Omit<SubagentRunConfig, "plan" | "steps">;
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
    assert.match(runner.stderr, /direct plan or a non-empty legacy steps array/);
    assert.ok(fs.existsSync(resultPath), "runner should persist a result artifact");
    const statusPath = path.join(asyncDir, "status.json");
    assert.ok(fs.existsSync(statusPath), "runner should persist status");

    const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
    const expectedDiagnostic =
      "Async runner config must include a direct plan or a non-empty legacy steps array.";
    assert.equal(payload.state, "failed");
    assert.equal(payload.success, false);
    assert.equal(payload.exitCode, 1);
    assert.equal(payload.error, expectedDiagnostic);
    assert.equal(payload.results.length, 0);
    assert.equal(status.state, "failed");
    assert.equal(status.error, expectedDiagnostic);
    assert.equal(status.steps?.length, 0);
  });

  it("persists a failed runner result for invalid path-only lazy-skill policy", () => {
    const id = `async-invalid-tool-policy-${Date.now().toString(36)}`;
    const asyncDir = path.join(tempDir, id);
    const artifactsDir = path.join(tempDir, `${id}-artifacts`);
    const resultPath = path.join(tempDir, `${id}-result.json`);
    const configPath = path.join(tempDir, `${id}-config.json`);
    const config: SubagentRunConfig = {
      id,
      steps: [
        {
          agent: "worker",
          task: "Inspect the task",
          tools: ["./custom-tool.ts"],
          skills: ["tmux"],
          inheritProjectContext: false,
          inheritSkills: false,
          systemPrompt: "You are a test agent.",
        },
      ],
      resultPath,
      cwd: tempDir,
      placeholder: "{previous}",
      asyncDir,
      artifactsDir,
      artifactConfig: {
        enabled: true,
        includeInput: true,
        includeOutput: true,
        includeJsonl: true,
        includeMetadata: true,
        includeTranscript: true,
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
    } satisfies NonNullable<SubagentRunConfig["steps"]>[number] & {
      modelFallbackFilterNotice: string;
    };
    const config: SubagentRunConfig = {
      id,
      steps: [step, { parallel: [{ ...step, task: "Inspect the parallel task" }] }],
      resultPath,
      cwd: tempDir,
      placeholder: "{previous}",
      asyncDir,
      resultMode: "chain",
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

    const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
    const chainResult = executeAsyncChain(chainId, {
      chain: [{ agent: "worker", task: "Do work" }],
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

    assert.equal(chainResult.isError, true);
    assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
    assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
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

  it("returns a tool error when an async chain cannot write its detached runner config", () => {
    const id = `async-chain-write-fail-${Date.now().toString(36)}`;
    assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
    fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

    const result = executeAsyncChain(id, {
      chain: [{ agent: "worker", task: "Do work" }],
      agents: [makeAgent("worker")],
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
    assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
    assert.match(result.content[0]?.text ?? "", /async-cfg-/);
  });
});
