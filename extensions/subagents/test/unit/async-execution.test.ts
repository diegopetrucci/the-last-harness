import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildAsyncRunnerSteps,
  resolveAsyncRunnerLogPaths,
} from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { INVALID_LAZY_SKILL_TOOL_POLICY_ERROR } from "../../src/runs/shared/pi-args.ts";
import {
  createProjectAgentRunCapture,
  getProjectAgentSnapshotProvenance,
  registerProjectAgentSnapshot,
  resolveProjectAgentSnapshot,
  revokeProjectAgentSnapshot,
} from "../../src/agents/project-agent-snapshot.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { makeAsyncCtx } from "../support/helpers.ts";

const agent = (
  name: string,
  toolBudget?: AgentConfig["toolBudget"],
  maxExecutionTimeMs?: number,
): AgentConfig => ({
  name,
  description: `${name} agent`,
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: "You are a test agent.",
  source: "project",
  filePath: `${name}.md`,
  ...(toolBudget ? { toolBudget } : {}),
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

  it("carries the exact project-agent capture and supervisor bridge capability into detached runner config steps", () => {
    const selected = agent("embedded.worker");
    selected.supervisorBridge = false;
    const capability = registerProjectAgentSnapshot({
      projectRoot: process.cwd(),
      sessionId: "session-1",
      generationId: "generation-config",
      entries: [
        {
          agent: selected,
          digest: "digest-config",
          frontmatterFields: ["tools", "supervisorBridge"],
        },
      ],
    });
    const manifest = resolveProjectAgentSnapshot(
      capability,
      getProjectAgentSnapshotProvenance(capability),
    );
    const capture = createProjectAgentRunCapture(manifest, selected);
    const result = buildAsyncRunnerSteps("run-project-config", {
      chain: [{ agent: selected.name, task: "use captured config" }],
      agents: [selected],
      ctx,
      asyncDir: path.join("tmp", "async-project-config"),
      maxSubagentDepth: 2,
      projectAgentCaptures: [capture],
    });
    assert.ok("steps" in result, "expected successful step build");
    const step = result.steps[0] as RunnerSubagentStep;
    assert.deepEqual(step.projectAgent?.provenance, capture.provenance);
    assert.deepEqual(step.projectAgent?.config, capture.config);
    assert.equal(step.supervisorBridge, false);
    assert.equal(JSON.stringify(step).includes("capability"), false);
    revokeProjectAgentSnapshot(capability);
  });

  it("resolves async step tool budgets with step over run over agent precedence", () => {
    const result = buildAsyncRunnerSteps("run-1", {
      chain: [
        { agent: "worker", task: "run beats agent" },
        { agent: "worker", task: "step beats run", toolBudget: { hard: 2, block: ["grep"] } },
      ],
      agents: [agent("worker", { hard: 4, block: ["read"] })],
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
      toolBudget: { hard: 3, block: ["find"] },
    });

    assert.ok("steps" in result, "expected successful step build");
    // Sequential chains only produce RunnerSubagentStep entries (no parallel groups).
    assert.deepEqual((result.steps[0] as RunnerSubagentStep)?.toolBudget, {
      hard: 3,
      block: ["find"],
    });
    assert.deepEqual((result.steps[1] as RunnerSubagentStep)?.toolBudget, {
      hard: 2,
      block: ["grep"],
    });
  });

  it("uses agent tool budget when no step or run override exists", () => {
    const result = buildAsyncRunnerSteps("run-2", {
      chain: [{ agent: "worker", task: "agent budget applies" }],
      agents: [agent("worker", { hard: 4, block: ["read"] })],
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
    });

    assert.ok("steps" in result, "expected successful step build");
    // Sequential chains only produce RunnerSubagentStep entries (no parallel groups).
    assert.deepEqual((result.steps[0] as RunnerSubagentStep)?.toolBudget, {
      hard: 4,
      block: ["read"],
    });
  });

  it("carries omitted, explicit-empty, and named tool policies through runner serialization", () => {
    const policies: Array<AgentConfig["tools"]> = [undefined, null, ["read"]];
    const agents = policies.map((tools, index) => ({
      ...agent(`tool-policy-${index}`),
      tools,
    }));
    const result = buildAsyncRunnerSteps("run-tool-policies", {
      chain: policies.map((_tools, index) => ({
        agent: `tool-policy-${index}`,
        task: "Inspect the task",
      })),
      agents,
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
    });

    assert.ok("steps" in result, "expected successful step build");
    const steps = result.steps as RunnerSubagentStep[];
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

  it("preserves independent agent ceilings while a shorter caller timeout remains global", () => {
    const result = buildAsyncRunnerSteps("run-mixed-ceilings", {
      chain: [
        {
          parallel: [
            { agent: "fast", task: "short ceiling" },
            { agent: "slow", task: "long ceiling" },
            { agent: "caller-bound", task: "caller bound" },
          ],
        },
      ],
      agents: [
        agent("fast", undefined, 100),
        agent("slow", undefined, 300),
        agent("caller-bound", undefined, 900),
      ],
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
      timeoutMs: 250,
    });

    assert.ok("steps" in result, "expected successful step build");
    const parallel = result.steps[0];
    assert.ok(parallel && "parallel" in parallel && Array.isArray(parallel.parallel));
    assert.deepEqual(
      parallel.parallel.map((step) => step.timeoutMs),
      [100, undefined, undefined],
    );
  });

  it("returns an actionable preflight error for extension-only tools with lazy skills", () => {
    const result = buildAsyncRunnerSteps("run-invalid-tool-policy", {
      chain: [{ agent: "worker", task: "Inspect the task" }],
      agents: [agent("worker")].map((value) => ({
        ...value,
        tools: ["./custom-tool.ts"],
        skills: ["tmux"],
      })),
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
    });

    assert.deepEqual(result, {
      error: INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
    });
  });

  it("returns an actionable preflight error for extension-only tools with inherited skills", () => {
    const result = buildAsyncRunnerSteps("run-invalid-inherited-tool-policy", {
      chain: [{ agent: "worker", task: "Inspect the task" }],
      agents: [
        {
          ...agent("worker"),
          inheritSkills: true,
          tools: ["./custom-tool.ts"],
        },
      ],
      ctx,
      asyncDir: path.join(process.cwd(), ".tmp-async-test"),
      maxSubagentDepth: 2,
    });

    assert.deepEqual(result, {
      error: INVALID_LAZY_SKILL_TOOL_POLICY_ERROR,
    });
  });
});
