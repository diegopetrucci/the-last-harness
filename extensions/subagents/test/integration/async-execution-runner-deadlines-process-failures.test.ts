/**
 * Integration tests for async execution – deadlines and process failures.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { spawnSync } from "node:child_process";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import {
  ASYNC_DIR,
  type AsyncResultPayload,
  type AsyncStatusPayload,
  TEMP_ROOT_DIR,
  executeAsyncParallel,
  executeAsyncSingle,
  readAsyncPayload,
  waitForAsyncResultFile,
  waitForMockPiCall,
} from "../support/async-execution-helpers.ts";
import { scaleTestTimeout } from "../support/scale-timeout.ts";
import { getAsyncConfigPath } from "../../src/shared/types.ts";
import type {
  RunnerSubagentStep,
  SubagentRunConfig,
  SubagentRunPlan,
} from "../../src/runs/shared/parallel-utils.ts";

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

describe("async execution runner deadlines and process failures", () => {
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
    // The role ceiling is persisted on the direct plan/step; root artifacts
    // no longer copy timeoutMs into the executable run envelope.
    assert.equal(payload.timeoutMs, undefined);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(status.steps?.[0]?.timeoutMs, 2_147_483_648);
    assert.equal(payload.success, true);
    assert.equal(payload.results[0]?.timedOut, undefined);
  });

  it("keeps a shorter internal run deadline below the agent ceiling", async () => {
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
    // The shared run boundary is persisted as an absolute deadline. The
    // root timeoutMs field is reserved for historical artifacts and is not
    // copied into a newly generated executable result.
    assert.equal(payload.timeoutMs, undefined);
    assert.equal(payload.deadlineAt, result.details.deadlineAt);
  });

  it("saturates max-safe run and role async deadlines", async () => {
    const maxSafeDuration = Number.MAX_SAFE_INTEGER;
    const artifactConfig: SubagentRunConfig["artifactConfig"] = {
      mode: "compact",
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeTranscript: false,
      includeMetadata: false,
      includeChildEventProjections: false,
      cleanupDays: 7,
    };
    const ctx = {
      pi: { events: { emit() {} } },
      cwd: tempDir,
      currentSessionId: "session-1",
    };
    const assertSaturatedConfig = async (id: string) => {
      const config = JSON.parse(
        fs.readFileSync(getAsyncConfigPath(id), "utf-8"),
      ) as SubagentRunConfig;
      assert.equal(config.deadlineAt, maxSafeDuration);
      assert.ok(Number.isSafeInteger(config.deadlineAt));
      const payload = await readAsyncPayload(id);
      assert.equal(payload.success, true);
    };

    const parallelId = `async-max-safe-parallel-${Date.now().toString(36)}`;
    mockPi.onCall({ output: "max-safe parallel done" });
    const parallel = executeAsyncParallel(parallelId, {
      tasks: [{ agent: "worker", task: "Run with a max-safe duration." }],
      agents: [makeAgent("worker")],
      ctx,
      artifactConfig,
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      timeoutMs: maxSafeDuration,
    });
    assert.equal(parallel.isError, undefined);
    await assertSaturatedConfig(parallelId);

    const singleRunId = `async-max-safe-run-${Date.now().toString(36)}`;
    mockPi.onCall({ output: "max-safe run done" });
    const singleRun = executeAsyncSingle(singleRunId, {
      agent: "worker",
      task: "Run with a max-safe duration.",
      agentConfig: makeAgent("worker"),
      ctx,
      artifactConfig,
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
      timeoutMs: maxSafeDuration,
    });
    assert.equal(singleRun.isError, undefined);
    await assertSaturatedConfig(singleRunId);

    const singleRoleId = `async-max-safe-role-${Date.now().toString(36)}`;
    mockPi.onCall({ output: "max-safe role done" });
    const singleRole = executeAsyncSingle(singleRoleId, {
      agent: "worker",
      task: "Run with a max-safe role duration.",
      agentConfig: makeAgent("worker", { maxExecutionTimeMs: maxSafeDuration }),
      ctx,
      artifactConfig,
      shareEnabled: false,
      sessionRoot: path.join(tempDir, "sessions"),
      maxSubagentDepth: 2,
    });
    assert.equal(singleRole.isError, undefined);
    await assertSaturatedConfig(singleRoleId);
  });

  it("rejects malformed persisted timeoutOwner values before spawn", () => {
    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const piArgv1 = path.join(path.dirname(mockPi.dir), "pi-coding-agent", "dist", "cli.mjs");
    const runCase = (label: string, timeoutOwner?: unknown, timeoutMs?: unknown) => {
      const id = `async-timeout-owner-${label}-${Date.now().toString(36)}`;
      const asyncDir = path.join(tempDir, id);
      const resultPath = path.join(tempDir, `${id}-result.json`);
      const configPath = path.join(tempDir, `${id}-config.json`);
      const config = {
        id,
        plan: {
          kind: "single",
          task: {
            agent: "worker",
            task: `Timeout owner ${label}`,
            ...(timeoutOwner !== undefined ? { timeoutOwner } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        },
        resultPath,
        cwd: tempDir,
        asyncDir,
        artifactConfig: {
          mode: "compact",
          enabled: false,
          includeInput: false,
          includeOutput: false,
          includeJsonl: false,
          includeTranscript: false,
          includeMetadata: false,
          cleanupDays: 7,
        },
        piArgv1,
        sessionId: `session-${id}`,
      };
      fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
      const runner = spawnSync(process.execPath, [runnerPath, configPath], {
        cwd: process.cwd(),
        encoding: "utf-8",
        env: { ...process.env },
      });
      const payload = fs.existsSync(resultPath)
        ? (JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload)
        : undefined;
      return { runner, payload };
    };

    const malformed = runCase("malformed", "caller", 1000);
    assert.equal(malformed.runner.status, 1, malformed.runner.stderr);
    assert.equal(mockPi.callCount(), 0, "malformed timeoutOwner must fail before child spawn");
    assert.equal(malformed.payload?.state, "failed");
    assert.equal(malformed.payload?.error, "Async runner config must include a valid direct plan.");

    for (const timeoutOwner of ["role", "run", undefined]) {
      const label = timeoutOwner ?? "missing";
      mockPi.onCall({ output: `accepted ${label}` });
      const accepted = runCase(label, timeoutOwner, timeoutOwner === undefined ? undefined : 1000);
      assert.equal(accepted.runner.status, 0, `${label}: ${accepted.runner.stderr}`);
      assert.equal(accepted.payload?.state, "complete", `${label}: result state`);
      assert.equal(accepted.payload?.success, true, `${label}: result success`);
    }
    assert.equal(mockPi.callCount(), 3, "valid and historical timeoutOwner values should spawn");
  });

  it("fails closed for malformed executable execution-policy fields", () => {
    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const piArgv1 = path.join(path.dirname(mockPi.dir), "pi-coding-agent", "dist", "cli.mjs");
    const artifactConfig: SubagentRunConfig["artifactConfig"] = {
      mode: "compact",
      enabled: false,
      includeInput: false,
      includeOutput: false,
      includeJsonl: false,
      includeTranscript: false,
      includeMetadata: false,
      includeChildEventProjections: false,
      cleanupDays: 7,
    };
    const validStep: RunnerSubagentStep = {
      agent: "worker",
      task: "Valid trusted execution-policy values should launch.",
      inheritProjectContext: false,
      inheritSkills: false,
      timeoutMs: 1_000,
      timeoutOwner: "role",
      activeRuntimeMs: 1.5,
      activeRuntimeCheckpointAt: 0,
    };
    const validPlan: SubagentRunPlan = { kind: "single", task: validStep };
    const omittedFieldsStep: RunnerSubagentStep = {
      agent: "worker",
      task: "Legacy omission should remain executable.",
      inheritProjectContext: false,
      inheritSkills: false,
    };
    const omittedFieldsPlan: SubagentRunPlan = {
      kind: "single",
      task: omittedFieldsStep,
    };
    const runCase = (
      label: string,
      plan: unknown,
      fields: Record<string, unknown> = {},
      useStdin = false,
    ) => {
      const id = `async-policy-boundary-${label}-${Date.now().toString(36)}`;
      const asyncDir = path.join(tempDir, id);
      const resultPath = path.join(tempDir, `${id}-result.json`);
      const configPath = path.join(tempDir, `${id}-config.json`);
      const config: unknown = {
        id,
        plan,
        resultPath,
        cwd: tempDir,
        asyncDir,
        artifactConfig,
        piArgv1,
        sessionId: `session-${id}`,
        ...fields,
      };
      const configJson = JSON.stringify(config);
      if (!useStdin) fs.writeFileSync(configPath, configJson, "utf-8");
      const runner = spawnSync(
        process.execPath,
        useStdin ? [runnerPath] : [runnerPath, configPath],
        {
          cwd: process.cwd(),
          encoding: "utf-8",
          input: useStdin ? configJson : undefined,
          env: { ...process.env },
        },
      );
      const payload = fs.existsSync(resultPath)
        ? (JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload)
        : undefined;
      const statusPath = path.join(asyncDir, "status.json");
      const status = fs.existsSync(statusPath)
        ? (JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload)
        : undefined;
      return { runner, payload, status, configPath };
    };

    const directPlanError = "Async runner config must include a valid direct plan.";
    const malformedPlans: ReadonlyArray<readonly [string, unknown]> = [
      ["timeout-zero", { ...validPlan, task: { ...validStep, timeoutMs: 0 } }],
      ["timeout-fraction", { ...validPlan, task: { ...validStep, timeoutMs: 1.5 } }],
      ["timeout-string", { ...validPlan, task: { ...validStep, timeoutMs: "100" } }],
      [
        "timeout-unsafe",
        { ...validPlan, task: { ...validStep, timeoutMs: Number.MAX_SAFE_INTEGER + 1 } },
      ],
      ["active-negative", { ...validPlan, task: { ...validStep, activeRuntimeMs: -1 } }],
      ["active-string", { ...validPlan, task: { ...validStep, activeRuntimeMs: "1" } }],
      [
        "checkpoint-negative",
        { ...validPlan, task: { ...validStep, activeRuntimeCheckpointAt: -1 } },
      ],
      [
        "checkpoint-unsafe",
        {
          ...validPlan,
          task: { ...validStep, activeRuntimeCheckpointAt: Number.MAX_SAFE_INTEGER + 1 },
        },
      ],
      [
        "owner-without-timeout",
        {
          ...validPlan,
          task: { ...validStep, timeoutMs: undefined },
        },
      ],
      ["owner-invalid", { ...validPlan, task: { ...validStep, timeoutOwner: "caller" } }],
      [
        "parallel-task-timeout-string",
        { kind: "parallel", tasks: [{ ...validStep, timeoutMs: "100" }] },
      ],
    ];
    for (const [label, plan] of malformedPlans) {
      const rejected = runCase(label, plan);
      assert.equal(rejected.runner.status, 1, `${label}: ${rejected.runner.stderr}`);
      assert.match(rejected.runner.stderr, /valid direct plan/);
      assert.ok(rejected.payload, `${label}: runner should persist a result artifact`);
      assert.ok(rejected.status, `${label}: runner should persist a status artifact`);
      assert.equal(rejected.payload.error, directPlanError, label);
      assert.equal(rejected.payload.state, "failed", label);
      assert.equal(rejected.payload.success, false, label);
      assert.equal(rejected.payload.exitCode, 1, label);
      assert.equal(rejected.payload.results.length, 0, label);
      assert.equal(rejected.status.error, directPlanError, label);
      assert.equal(rejected.status.state, "failed", label);
      assert.equal(rejected.status.steps?.length, 0, label);
      if (label === "parallel-task-timeout-string") {
        assert.equal(rejected.status.mode, "parallel", label);
      }
    }
    assert.equal(mockPi.callCount(), 0, "malformed plans must not launch a child");

    const invalidConfigError = "Async runner config is malformed.";
    const malformedDeadlines: ReadonlyArray<readonly [string, unknown]> = [
      ["deadline-zero", 0],
      ["deadline-fraction", 1.5],
      ["deadline-string", "100"],
      ["deadline-unsafe", Number.MAX_SAFE_INTEGER + 1],
    ];
    for (const [index, [label, deadlineAt]] of malformedDeadlines.entries()) {
      const rejected = runCase(label, validPlan, { deadlineAt }, index % 2 === 1);
      assert.equal(rejected.runner.status, 1, `${label}: ${rejected.runner.stderr}`);
      assert.match(rejected.runner.stderr, /config is malformed/);
      assert.ok(rejected.payload, `${label}: runner should persist a result artifact`);
      assert.ok(rejected.status, `${label}: runner should persist a status artifact`);
      assert.equal(rejected.payload.error, invalidConfigError, label);
      assert.equal(rejected.payload.state, "failed", label);
      assert.equal(rejected.payload.success, false, label);
      assert.equal(rejected.payload.results.length, 0, label);
      assert.equal(rejected.payload.deadlineAt, undefined, label);
      assert.equal(rejected.status.error, invalidConfigError, label);
      assert.equal(rejected.status.state, "failed", label);
      assert.equal(rejected.status.deadlineAt, undefined, label);
      assert.equal(rejected.status.steps?.length, 0, label);
    }
    assert.equal(mockPi.callCount(), 0, "malformed config values must not launch a child");

    mockPi.onCall({ output: "legacy omission accepted" });
    const omitted = runCase("omitted-fields", omittedFieldsPlan);
    assert.equal(omitted.runner.status, 0, omitted.runner.stderr);
    assert.equal(omitted.payload?.state, "complete");
    assert.equal(omitted.payload?.success, true);

    mockPi.onCall({ output: "trusted policy accepted" });
    const valid = runCase("valid-trusted", validPlan, { deadlineAt: Date.now() + 60_000 });
    assert.equal(valid.runner.status, 0, valid.runner.stderr);
    assert.equal(valid.payload?.state, "complete");
    assert.equal(valid.payload?.success, true);
    assert.ok(
      (valid.payload?.results[0]?.activeRuntimeMs ?? 0) >= 2,
      "trusted runtime evidence must not reset consumed budget",
    );

    mockPi.onCall({ output: "max-safe step accepted" });
    const maxSafeStep = runCase("max-safe-step-no-run-deadline", {
      kind: "single",
      task: {
        ...validStep,
        task: "Trusted max-safe step timeout without a run deadline should launch.",
        timeoutMs: Number.MAX_SAFE_INTEGER,
        activeRuntimeMs: 0,
      },
    });
    assert.equal(maxSafeStep.runner.status, 0, maxSafeStep.runner.stderr);
    assert.equal(maxSafeStep.payload?.state, "complete");
    assert.equal(maxSafeStep.payload?.success, true);
    assert.equal(maxSafeStep.status?.deadlineAt, undefined);
    assert.equal(maxSafeStep.status?.steps?.[0]?.deadlineAt, Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(maxSafeStep.status?.steps?.[0]?.deadlineAt));

    assert.equal(mockPi.callCount(), 3, "only compatible plans should launch children");
  });

  it("normalizes fractional continuation runtime before deriving runner policy", async () => {
    const id = `async-fractional-continuation-${Date.now().toString(36)}`;
    mockPi.onCall({ output: "fractional continuation accepted" });
    const result = executeAsyncSingle(id, {
      agent: "worker",
      task: "Use the conservatively normalized continuation budget.",
      agentConfig: makeAgent("worker", { maxExecutionTimeMs: 10_000 }),
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
      activeRuntimeMs: 1.5,
      activeRuntimeCheckpointAt: Number.MAX_SAFE_INTEGER + 1,
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.details.timeoutMs, 9_998);
    const payload = await readAsyncPayload(id);
    assert.equal(payload.success, true);
    const status = JSON.parse(
      fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.equal(status.steps?.[0]?.timeoutMs, 9_998);
    assert.ok((status.steps?.[0]?.activeRuntimeMs ?? 0) >= 2);
    assert.equal(status.activeRuntimeCheckpointAt, Number.MAX_SAFE_INTEGER);
    assert.ok(Number.isSafeInteger(status.activeRuntimeCheckpointAt));
  });

  it("rejects retired timeout plans before launching a child", () => {
    const runnerPath = path.resolve(
      process.cwd(),
      "extensions/subagents/src/runs/background/subagent-runner.js",
    );
    const cases = [
      {
        label: "single-envelope-file",
        plan: {
          kind: "single",
          task: { agent: "worker", task: "This child must not launch." },
        },
        timeoutPlacement: "envelope",
        useStdin: false,
      },
      {
        label: "parallel-plan-stdin",
        plan: {
          kind: "parallel",
          tasks: [{ agent: "worker", task: "This child must not launch." }],
          timeoutMs: 123,
        },
        timeoutPlacement: "plan",
        useStdin: true,
      },
    ] as const;

    for (const testCase of cases) {
      const id = `async-retired-timeout-${testCase.label}-${Date.now().toString(36)}`;
      const asyncDir = path.join(tempDir, id);
      const resultPath = path.join(tempDir, `${id}-result.json`);
      const configPath = path.join(tempDir, `${id}-config.json`);
      const config = {
        id,
        ...(testCase.timeoutPlacement === "envelope" ? { timeoutMs: 123 } : {}),
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
      assert.match(runner.stderr, /caller-selected execution timeouts.*timeoutMs/i);
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
      const expectedError =
        "Async runner config contains retired timeoutMs execution control. Configure execution.maxRunTimeMs in <agent-dir>/extensions/subagent/config.json; caller-selected execution timeouts are no longer supported. Restart with a new direct single or parallel run after removing timeoutMs.";
      assert.equal(payload.state, "failed", testCase.label);
      assert.equal(payload.success, false, testCase.label);
      assert.equal(payload.error, expectedError, testCase.label);
      assert.equal(
        payload.timeoutMs,
        undefined,
        `${testCase.label}: result omits retired timeoutMs`,
      );
      assert.equal(status.state, "failed", testCase.label);
      assert.equal(status.error, expectedError, testCase.label);
      assert.equal(
        status.timeoutMs,
        undefined,
        `${testCase.label}: status omits retired timeoutMs`,
      );
      if (!testCase.useStdin) {
        assert.equal(
          fs.existsSync(configPath),
          false,
          `${testCase.label}: runner should consume its persisted config`,
        );
      }
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
    const metadata = JSON.parse(fs.readFileSync(artifactPaths.metadataPath, "utf-8")) as {
      task?: unknown;
    };
    assert.equal(metadata.task, "Inspect the task");
    assert.ok(
      fs
        .readFileSync(artifactPaths.outputPath, "utf-8")
        .includes(INVALID_LAZY_SKILL_TOOL_POLICY_ERROR),
    );
  });

  it("persists bounded active-runtime checkpoints without event or projection spam", async () => {
    mockPi.onCall({ delay: 2_500, output: "checkpointed result" });
    const id = `async-runtime-checkpoints-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "worker",
      task: "Remain active long enough to checkpoint.",
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

    const asyncDir = path.join(ASYNC_DIR, id);
    const payload = await readAsyncPayload(id);
    assert.equal(payload.state, "complete");
    const status = JSON.parse(
      fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"),
    ) as AsyncStatusPayload;
    assert.ok((status.activeRuntimeMs ?? 0) > 0, "final status should persist active runtime");
    assert.equal(
      typeof status.activeRuntimeCheckpointAt,
      "number",
      "final status should persist its authoritative checkpoint timestamp",
    );
    const eventTypes = readEventTypes(asyncDir);
    assert.equal(
      eventTypes.filter((type) => type.includes("runtime") || type.includes("checkpoint")).length,
      0,
      "accounting checkpoints must not append lifecycle events",
    );
    assert.equal(
      eventTypes.filter((type) => type === "subagent.nested.updated").length,
      0,
      "accounting checkpoints must not publish nested projections",
    );
  });

  it("attributes an async single timeout to the binding role ceiling", async () => {
    const roleTimeoutMs = scaleTestTimeout(500);
    mockPi.onCall({ delay: 60_000, output: "too late" });
    const id = `async-role-timeout-${Date.now().toString(36)}`;
    executeAsyncSingle(id, {
      agent: "role-bound",
      task: "Wait for the role ceiling.",
      agentConfig: makeAgent("role-bound", { maxExecutionTimeMs: roleTimeoutMs }),
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

    await waitForMockPiCall(mockPi, 0);
    const payload = await readAsyncPayload(id);
    assert.equal(payload.state, "failed");
    assert.equal(payload.timedOut, true);
    assert.equal(payload.results[0]?.timedOut, true);
    assert.equal(payload.results[0]?.error, `Subagent timed out after ${roleTimeoutMs}ms.`);
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
    assert.equal(
      payload.results[0]?.error,
      "Subagent exceeded the configured maximum execution time.",
    );
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
