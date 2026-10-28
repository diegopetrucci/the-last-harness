import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildAsyncRunnerPlan,
  buildAsyncSingleRunnerPlan,
  resolveAsyncRunnerLogPaths,
} from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import type { ProjectAgentIdentity } from "../../src/agents/project-agent-loader.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { DEFAULT_ARTIFACT_CONFIG, type SubagentTerminalResult } from "../../src/shared/types.ts";
import { makeAsyncCtx } from "../support/helpers.ts";

const agent = (name: string, maxExecutionTimeMs?: number): AgentConfig => ({
  name,
  description: `${name} agent`,
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: "You are a test agent.",
  source: "project",
  filePath: `${name}.md`,
  ...(maxExecutionTimeMs !== undefined ? { maxExecutionTimeMs } : {}),
});

const ctx = makeAsyncCtx(process.cwd(), { currentSessionId: "session-1" });

describe("async runner execution", () => {
  it("places detached runner stdio logs in the async run directory", () => {
    const asyncDir = path.join("tmp", "async-run");
    assert.deepEqual(resolveAsyncRunnerLogPaths({ asyncDir }), {
      stdoutPath: path.join(asyncDir, "runner.stdout.log"),
      stderrPath: path.join(asyncDir, "runner.stderr.log"),
    });
  });

  it("omits runner log paths when asyncDir is unavailable", () => {
    assert.equal(resolveAsyncRunnerLogPaths({}), undefined);
  });

  it("carries the durable project-agent identity into detached runner config steps", () => {
    const selected = agent("embedded.worker");
    selected.supervisorBridge = false;
    const identity: ProjectAgentIdentity = {
      slug: "worker",
      root: process.cwd(),
      cwd: process.cwd(),
    };
    const result = buildAsyncRunnerPlan("run-project-config", {
      tasks: [{ agent: selected.name, task: "use captured config" }],
      agents: [selected],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
      projectAgentIdentities: [identity],
    });
    assert.ok("plan" in result, "expected successful plan build");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    assert.deepEqual(step.projectAgent, identity);
    assert.equal(step.supervisorBridge, false);
    assert.equal(JSON.stringify(step).includes("capability"), false);
  });

  it("carries the internal ticket-free prompt variant through parallel plans", () => {
    const result = buildAsyncRunnerPlan("run-prompt-variant", {
      tasks: [{ agent: "worker", task: "validate the carrier", promptVariant: "ticket-free" }],
      agents: [agent("worker")],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });
    assert.ok("plan" in result, "expected successful plan build");
    if ("error" in result) return;
    const step = result.plan.tasks[0];
    assert.equal(step?.promptVariant, "ticket-free");
    assert.equal(
      (JSON.parse(JSON.stringify(result.plan)) as typeof result.plan).tasks[0]?.promptVariant,
      "ticket-free",
    );
  });

  it("renders canonical test-runner prompt variants before runner task guidance", () => {
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const profile = path.join(os.tmpdir(), `tlh-prompt-profile-${process.pid}-${Date.now()}`);
    process.env.PI_CODING_AGENT_DIR = profile;
    try {
      const selected = agent("test-runner");
      selected.filePath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
      selected.systemPrompt = [
        "Common test-runner guidance.",
        "<!-- tlh:prompt-variant:normal:start -->",
        "Normal ticket protocol.",
        "<!-- tlh:prompt-variant:normal:end -->",
        "<!-- tlh:prompt-variant:ticket-free:start -->",
        "Ticket-free inline protocol.",
        "<!-- tlh:prompt-variant:ticket-free:end -->",
      ].join("\n");

      const free = buildAsyncRunnerPlan("run-rendered-ticket-free", {
        tasks: [{ agent: selected.name, task: "validate", promptVariant: "ticket-free" }],
        agents: [selected],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx,
        maxSubagentDepth: 2,
      });
      assert.ok("plan" in free, "expected ticket-free plan build");
      if ("error" in free) return;
      const freePrompt = free.plan.tasks[0]?.systemPrompt ?? "";
      assert.match(freePrompt, /Common test-runner guidance/);
      assert.match(freePrompt, /Ticket-free inline protocol/);
      assert.doesNotMatch(freePrompt, /Normal ticket protocol|tlh:prompt-variant/);

      const normal = buildAsyncRunnerPlan("run-rendered-normal", {
        tasks: [{ agent: selected.name, task: "validate" }],
        agents: [selected],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx,
        maxSubagentDepth: 2,
      });
      assert.ok("plan" in normal, "expected normal plan build");
      if ("error" in normal) return;
      const normalPrompt = normal.plan.tasks[0]?.systemPrompt ?? "";
      assert.match(normalPrompt, /Normal ticket protocol/);
      assert.doesNotMatch(normalPrompt, /Ticket-free inline protocol|tlh:prompt-variant/);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
    }
  });

  it("carries the internal ticket-free prompt variant through single plans", () => {
    const result = buildAsyncSingleRunnerPlan(
      {
        agent: "worker",
        agentConfig: agent("worker"),
        ctx,
        maxSubagentDepth: 2,
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        shareEnabled: false,
        sessionRoot: os.tmpdir(),
        sessionFile: path.join(os.tmpdir(), "session.jsonl"),
        promptVariant: "ticket-free",
      } as any,
      {
        task: "validate the carrier",
        taskWithOutputInstruction: "validate the carrier",
        runnerCwd: process.cwd(),
        systemPrompt: "You are a test agent.",
        resolvedSkillNames: [],
        outputMode: "inline",
      },
    );
    assert.ok(!("error" in result), "plan build must succeed");
    if ("error" in result) return;
    assert.equal(result.buildPlan().task.promptVariant, "ticket-free");
  });

  it("carries omitted, explicit-empty, and named tool policies through runner serialization", () => {
    const policies: Array<AgentConfig["tools"]> = [undefined, null, ["read"]];
    const agents = policies.map((tools, index) => ({
      ...agent(`tool-policy-${index}`),
      tools,
    }));
    const result = buildAsyncRunnerPlan("run-tool-policies", {
      tasks: policies.map((_tools, index) => ({
        agent: `tool-policy-${index}`,
        task: "Inspect the task",
      })),
      agents,
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected successful plan build");
    const steps = result.plan.tasks as RunnerSubagentStep[];
    assert.deepEqual(
      steps.map((step) => step.tools),
      policies,
    );
    const restored: unknown = JSON.parse(JSON.stringify(steps));
    if (!Array.isArray(restored)) throw new Error("Expected serialized steps to be an array");
    const restoredPolicies = restored.map((step: unknown) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) {
        throw new Error("Expected each serialized step to be an object");
      }
      if (!("tools" in step)) return undefined;
      const tools = step.tools;
      if (tools === null) return null;
      if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string")) {
        throw new Error("Expected serialized tools to be null or an array of strings");
      }
      return tools;
    });
    assert.deepEqual(restoredPolicies, policies);
  });

  it("persists independent agent ceilings under one run policy", () => {
    const result = buildAsyncRunnerPlan("run-mixed-ceilings", {
      tasks: [
        { agent: "fast", task: "short ceiling" },
        { agent: "slow", task: "long ceiling" },
        { agent: "caller-bound", task: "caller bound" },
      ],
      agents: [agent("fast", 100), agent("slow", 300), agent("caller-bound", 900)],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected successful plan build");
    assert.deepEqual(
      result.plan.tasks.map((step) => step.timeoutMs),
      [100, 300, 900],
    );
  });

  it("returns an actionable preflight error for extension-only tools with lazy skills", () => {
    const result = buildAsyncRunnerPlan("run-invalid-tool-policy", {
      tasks: [{ agent: "worker", task: "Inspect the task" }],
      agents: [agent("worker")].map((value) => ({
        ...value,
        tools: ["./custom-tool.ts"],
        skills: ["tmux"],
      })),
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.deepEqual(result, {
      error: INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
    });
  });

  it("returns an actionable preflight error for extension-only tools with inherited skills", () => {
    const result = buildAsyncRunnerPlan("run-invalid-inherited-tool-policy", {
      tasks: [{ agent: "worker", task: "Inspect the task" }],
      agents: [
        {
          ...agent("worker"),
          inheritSkills: true,
          tools: ["./custom-tool.ts"],
        },
      ],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx,
      maxSubagentDepth: 2,
    });

    assert.deepEqual(result, {
      error: INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
    });
  });
});

describe("async runner plan child-location persistence", () => {
  // Use a stable parent cwd that is unlikely to be a git repo or inside the
  // project; tmpdir works because the tests never shell out to git (no
  // production git calls happen inside the plan-build path, which is
  // synchronous and calls spawnSync internally via captureChildLocationSnapshot).
  // We DO need a real directory for resolveChildCwd to resolve against, but
  // the git runner is the production one — so in practice captureChildLocationSnapshot
  // returns a snapshot with at least childCwd + displayPath set regardless of
  // whether git succeeds, which is sufficient for these assertions.
  const parentCwd = os.tmpdir();
  const stepSubdir = path.join(os.tmpdir(), "tlh-unit-test-step-subdir");
  const stepCtx = makeAsyncCtx(parentCwd, { currentSessionId: "session-cl-1" });

  it("attaches childLocation to a parallel step whose cwd differs from the parent cwd", () => {
    const result = buildAsyncRunnerPlan("run-cl-parallel-diff", {
      tasks: [{ agent: "worker", task: "work in subdir", cwd: stepSubdir }],
      agents: [agent("worker")],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx: stepCtx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected successful plan build");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    assert.ok(
      step.childLocation !== undefined,
      "childLocation must be present when step cwd differs from parent cwd",
    );
    assert.equal(
      step.childLocation?.childCwd,
      stepSubdir,
      "childLocation.childCwd must equal the step cwd",
    );
  });

  it("omits childLocation from a parallel step whose cwd matches the parent cwd", () => {
    const result = buildAsyncRunnerPlan("run-cl-parallel-same", {
      tasks: [{ agent: "worker", task: "work in parent cwd" }],
      agents: [agent("worker")],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx: stepCtx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected successful plan build");
    if ("error" in result) return;
    const step = result.plan.tasks[0] as RunnerSubagentStep;
    assert.equal(
      step.childLocation,
      undefined,
      "childLocation must be absent when step cwd equals parent cwd",
    );
  });

  it("attaches distinct childLocation snapshots to steps with different cwds in one plan", () => {
    const stepSubdir2 = path.join(os.tmpdir(), "tlh-unit-test-step-subdir-2");
    const result = buildAsyncRunnerPlan("run-cl-parallel-multi", {
      tasks: [
        { agent: "worker", task: "work in subdir 1", cwd: stepSubdir },
        { agent: "worker2", task: "same as parent" },
        { agent: "worker3", task: "work in subdir 2", cwd: stepSubdir2 },
      ],
      agents: [agent("worker"), agent("worker2"), agent("worker3")],
      artifactConfig: DEFAULT_ARTIFACT_CONFIG,
      ctx: stepCtx,
      maxSubagentDepth: 2,
    });

    assert.ok("plan" in result, "expected successful plan build");
    if ("error" in result) return;
    const steps = result.plan.tasks as RunnerSubagentStep[];
    assert.ok(
      steps[0]?.childLocation !== undefined,
      "step 0 has a different cwd: childLocation must be present",
    );
    assert.equal(
      steps[1]?.childLocation,
      undefined,
      "step 1 has the same cwd as parent: childLocation must be absent",
    );
    assert.ok(
      steps[2]?.childLocation !== undefined,
      "step 2 has a different cwd: childLocation must be present",
    );
    // The two snapshots must refer to their respective child cwds.
    assert.equal(steps[0]?.childLocation?.childCwd, stepSubdir);
    assert.equal(steps[2]?.childLocation?.childCwd, stepSubdir2);
    assert.notEqual(
      steps[0]?.childLocation?.childCwd,
      steps[2]?.childLocation?.childCwd,
      "distinct step cwds must yield distinct snapshots",
    );
  });
});

describe("revival: priorTerminalResult propagation", () => {
  it("carries priorTerminalResult into the plan task as terminalResult", () => {
    // Regression: the merged file dropped priorTerminalResult from AsyncSingleParams
    // so revival/resume passes silently lost the prior attempts. Verify the field
    // is restored and propagated into the runner plan step.
    const revivalAgent = agent("worker");
    const prior: SubagentTerminalResult = {
      state: "failed",
      facts: { attempts: [] },
    };
    const result = buildAsyncSingleRunnerPlan(
      {
        agent: "worker",
        agentConfig: revivalAgent,
        ctx,
        maxSubagentDepth: 2,
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        shareEnabled: false,
        priorTerminalResult: prior,
        sessionRoot: os.tmpdir(),
        sessionFile: path.join(os.tmpdir(), "session.jsonl"),
      } as any,
      {
        task: "retry the task",
        taskWithOutputInstruction: "retry the task",
        runnerCwd: process.cwd(),
        systemPrompt: "You are a test agent.",
        resolvedSkillNames: [],
        outputMode: "inline",
      },
    );
    assert.ok(!("error" in result), "plan build must succeed");
    if ("error" in result) return;
    const plan = result.buildPlan();
    assert.equal(plan.kind, "single");
    assert.deepEqual(
      plan.task.terminalResult,
      prior,
      "terminalResult in the plan step must equal the supplied priorTerminalResult",
    );
  });

  it("omits terminalResult from the plan step when priorTerminalResult is absent", () => {
    const revivalAgent = agent("worker");
    const result = buildAsyncSingleRunnerPlan(
      {
        agent: "worker",
        agentConfig: revivalAgent,
        ctx,
        maxSubagentDepth: 2,
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        shareEnabled: false,
        sessionRoot: os.tmpdir(),
        sessionFile: path.join(os.tmpdir(), "session.jsonl"),
      } as any,
      {
        task: "first attempt",
        taskWithOutputInstruction: "first attempt",
        runnerCwd: process.cwd(),
        systemPrompt: "You are a test agent.",
        resolvedSkillNames: [],
        outputMode: "inline",
      },
    );
    assert.ok(!("error" in result), "plan build must succeed");
    if ("error" in result) return;
    const plan = result.buildPlan();
    assert.equal(plan.kind, "single");
    assert.equal(
      plan.task.terminalResult,
      undefined,
      "terminalResult must be absent when no priorTerminalResult was supplied",
    );
  });
});
