import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildAsyncRunnerPlan,
  buildAsyncSingleRunnerPlan,
  executeAsyncParallel,
  executeAsyncSingle,
  resolveAsyncRunnerLogPaths,
} from "../../src/runs/background/async-execution.ts";
import { createSubagentExecutor } from "../../src/extension/subagent-executor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import type { ProjectAgentIdentity } from "../../src/agents/project-agent-loader.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import {
  ASYNC_DIR,
  DEFAULT_ARTIFACT_CONFIG,
  getAsyncConfigPath,
  RESULTS_DIR,
  TEMP_ROOT_DIR,
  type SubagentTerminalResult,
} from "../../src/shared/types.ts";
import { writeAsyncArtifactJson as writeJson } from "../support/async-artifact-fixtures.ts";
import {
  makeAsyncCtx,
  makeExtensionAPI,
  makeMinimalCtx,
  makeSubagentState,
} from "../support/helpers.ts";

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

  it("rejects stale canonical ticket-free prompts before single or parallel launch", () => {
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const profile = path.join(os.tmpdir(), `tlh-prompt-profile-stale-${process.pid}-${Date.now()}`);
    process.env.PI_CODING_AGENT_DIR = profile;
    try {
      const staleSources = [
        "Legacy ticket-backed test-runner guidance.",
        [
          "Shared guidance.",
          "<!-- tlh:prompt-variant:normal:start -->",
          "Normal ticket protocol.",
          "<!-- tlh:prompt-variant:normal:end -->",
        ].join("\n"),
        "This prose mentions tlh:prompt-variant:ticket-free but defines no section.",
      ];

      for (const [index, systemPrompt] of staleSources.entries()) {
        const selected = agent("test-runner");
        selected.filePath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
        selected.systemPrompt = systemPrompt;
        const parallelPlan = buildAsyncRunnerPlan(`run-stale-ticket-free-${index}`, {
          tasks: [{ agent: selected.name, task: "validate", promptVariant: "ticket-free" }],
          agents: [selected],
          artifactConfig: DEFAULT_ARTIFACT_CONFIG,
          ctx,
          maxSubagentDepth: 2,
        });
        assert.ok("error" in parallelPlan, "stale parallel prompts must fail preflight");
        assert.match(parallelPlan.error, /full `tlh update`/);

        const singleId = `run-stale-ticket-free-single-${index}-${Date.now()}`;
        const single = executeAsyncSingle(singleId, {
          agent: selected.name,
          task: "validate",
          agentConfig: selected,
          ctx,
          maxSubagentDepth: 2,
          artifactConfig: DEFAULT_ARTIFACT_CONFIG,
          promptVariant: "ticket-free",
        });
        assert.ok(!(single instanceof Promise), "preflight rejection must be synchronous");
        if (single instanceof Promise) continue;
        assert.equal(single.isError, true);
        assert.match(single.content[0]?.text ?? "", /full `tlh update`/);
        assert.equal(fs.existsSync(getAsyncConfigPath(singleId)), false);
        assert.equal(fs.existsSync(path.join(ASYNC_DIR, singleId)), false);

        const parallelId = `run-stale-ticket-free-parallel-${index}-${Date.now()}`;
        const parallel = executeAsyncParallel(parallelId, {
          tasks: [{ agent: selected.name, task: "validate", promptVariant: "ticket-free" }],
          agents: [selected],
          artifactConfig: DEFAULT_ARTIFACT_CONFIG,
          ctx,
          maxSubagentDepth: 2,
        });
        assert.ok(!(parallel instanceof Promise), "preflight rejection must be synchronous");
        if (parallel instanceof Promise) continue;
        assert.equal(parallel.isError, true);
        assert.match(parallel.content[0]?.text ?? "", /full `tlh update`/);
        assert.equal(fs.existsSync(getAsyncConfigPath(parallelId)), false);
        assert.equal(fs.existsSync(path.join(ASYNC_DIR, parallelId)), false);
      }
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
    }
  });

  it("rejects invalid canonical prompt markers before launch", () => {
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const profile = path.join(
      os.tmpdir(),
      `tlh-prompt-profile-invalid-${process.pid}-${Date.now()}`,
    );
    process.env.PI_CODING_AGENT_DIR = profile;
    try {
      const selected = agent("test-runner");
      selected.filePath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
      selected.systemPrompt = "<!-- tlh:prompt-variant:future:start -->";
      const result = buildAsyncRunnerPlan("run-invalid-ticket-free-marker", {
        tasks: [{ agent: selected.name, task: "validate", promptVariant: "ticket-free" }],
        agents: [selected],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx,
        maxSubagentDepth: 2,
      });
      assert.ok("error" in result, "invalid markers must fail preflight");
      assert.match(result.error, /Malformed TLH prompt-variant marker/);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
    }
  });

  it("keeps legacy canonical and custom test-runner prompts unchanged", () => {
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const profile = path.join(
      os.tmpdir(),
      `tlh-prompt-profile-legacy-${process.pid}-${Date.now()}`,
    );
    process.env.PI_CODING_AGENT_DIR = profile;
    try {
      const legacySource = "Legacy ticket-backed test-runner guidance.";
      const canonical = agent("test-runner");
      canonical.filePath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
      canonical.systemPrompt = legacySource;
      for (const promptVariant of [undefined, "normal"] as const) {
        const result = buildAsyncRunnerPlan(`run-legacy-${promptVariant ?? "undefined"}`, {
          tasks: [
            {
              agent: canonical.name,
              task: "validate",
              ...(promptVariant ? { promptVariant } : {}),
            },
          ],
          agents: [canonical],
          artifactConfig: DEFAULT_ARTIFACT_CONFIG,
          ctx,
          maxSubagentDepth: 2,
        });
        assert.ok("plan" in result, "legacy normal prompt must remain launchable");
        if ("error" in result) continue;
        assert.equal(result.plan.tasks[0]?.systemPrompt, legacySource);
      }

      const custom = agent("test-runner");
      custom.filePath = path.join(profile, "custom-test-runner.md");
      custom.systemPrompt = legacySource;
      const customResult = buildAsyncRunnerPlan("run-custom-test-runner", {
        tasks: [{ agent: custom.name, task: "validate", promptVariant: "ticket-free" }],
        agents: [custom],
        artifactConfig: DEFAULT_ARTIFACT_CONFIG,
        ctx,
        maxSubagentDepth: 2,
      });
      assert.ok("plan" in customResult, "custom test-runner prompt must remain unchanged");
      if ("error" in customResult) return;
      assert.equal(customResult.plan.tasks[0]?.systemPrompt, legacySource);
    } finally {
      if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousProfile;
    }
  });

  it("rejects persisted ticket-free revival through resolution before launching a child", async () => {
    const previousProfile = process.env.PI_CODING_AGENT_DIR;
    const profile = path.join(
      os.tmpdir(),
      `tlh-prompt-profile-revival-${process.pid}-${Date.now()}`,
    );
    const runId = `run-persisted-ticket-free-${Date.now()}`;
    const asyncDir = path.join(ASYNC_DIR, runId);
    const sessionFile = path.join(profile, "revived-session.jsonl");
    process.env.PI_CODING_AGENT_DIR = profile;
    try {
      const revived = agent("test-runner");
      revived.filePath = path.join(profile, "tlh", "agents", "subagents", "test-runner.md");
      revived.systemPrompt = [
        "Shared test-runner guidance.",
        "<!-- tlh:prompt-variant:normal:start -->",
        "Normal ticket protocol.",
        "<!-- tlh:prompt-variant:normal:end -->",
      ].join("\n");
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(sessionFile, "", "utf8");
      writeJson(path.join(asyncDir, "status.json"), {
        runId,
        mode: "single",
        state: "complete",
        sessionId: "session-123",
        cwd: profile,
        startedAt: 100,
        lastUpdate: 100,
        sessionFile,
        steps: [
          {
            agent: revived.name,
            status: "complete",
            sessionFile,
            promptVariant: "ticket-free",
          },
        ],
      });

      const statusPath = path.join(asyncDir, "status.json");
      const statusBeforeResume = fs.readFileSync(statusPath, "utf8");
      const beforeTempEntries = fs.readdirSync(TEMP_ROOT_DIR).sort();
      const executor = createSubagentExecutor({
        pi: makeExtensionAPI(),
        state: makeSubagentState({ baseCwd: profile, currentSessionId: "session-123" }),
        config: { maxSubagentDepth: 2, control: {} },
        tempArtifactsDir: path.join(profile, "artifacts"),
        getSubagentSessionRoot: () => path.join(profile, "sessions"),
        expandTilde: (value) => value,
        discoverAgents: () => ({ agents: [revived] }),
      });
      const result = await executor.execute(
        "prompt-variant-revival",
        { action: "resume", id: runId, message: "continue the captured validation" },
        new AbortController().signal,
        undefined,
        makeMinimalCtx(profile),
      );

      assert.equal(result.isError, true);
      const errorText = result.content[0]?.type === "text" ? result.content[0].text : "";
      assert.match(errorText, /validated ticket-free section/);
      assert.match(errorText, /full `tlh update`/);
      assert.equal(result.details.asyncId, undefined);
      assert.deepEqual(fs.readdirSync(TEMP_ROOT_DIR).sort(), beforeTempEntries);
      assert.equal(fs.readFileSync(statusPath, "utf8"), statusBeforeResume);
    } finally {
      fs.rmSync(asyncDir, { recursive: true, force: true });
      fs.rmSync(path.join(RESULTS_DIR, `${runId}.json`), { force: true });
      fs.rmSync(getAsyncConfigPath(runId), { force: true });
      fs.rmSync(profile, { recursive: true, force: true });
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
