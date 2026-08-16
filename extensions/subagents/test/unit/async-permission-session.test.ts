import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";

function makeAgent(name: string): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "Do work",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    source: "project",
    filePath: `/tmp/${name}.md`,
  };
}

describe("async permission forwarding session identity", () => {
  it("uses the parent session id for permission forwarding instead of the async status identity", () => {
    const currentSessionId = path.join("/tmp", "parent-session.jsonl");
    const built = buildAsyncRunnerSteps("run-abc", {
      chain: [{ agent: "worker", task: "Do work" }],
      agents: [makeAgent("worker")],
      ctx: {
        pi: {} as never,
        cwd: "/tmp/project",
        currentSessionId,
        parentSessionId: "session-abc123",
      },
      maxSubagentDepth: 1,
      asyncDir: "/tmp/async-run",
    });

    assert.ok(!("error" in built));
    const step = built.steps[0];
    assert.ok(step && !("parallel" in step));
    assert.equal(step.parentSessionId, "session-abc123");
  });

  it("consumes one flat index per parallel task before later forked steps", () => {
    const built = buildAsyncRunnerSteps("run-abc", {
      chain: [
        { agent: "source", task: "produce targets" },
        {
          parallel: [
            { agent: "reviewer", task: "Review first" },
            { agent: "reviewer", task: "Review second" },
          ],
        },
        { agent: "worker", task: "Use reviews" },
      ],
      agents: [
        makeAgent("source"),
        makeAgent("reviewer"),
        { ...makeAgent("worker"), model: "anthropic/claude-sonnet-4-5:high", thinking: "high" },
      ],
      ctx: {
        pi: {} as never,
        cwd: "/tmp/project",
        currentSessionId: "/tmp/parent-session.jsonl",
      },
      sessionFilesByFlatIndex: [
        undefined,
        "/tmp/parallel-0.jsonl",
        "/tmp/parallel-1.jsonl",
        "/tmp/static-worker.jsonl",
      ],
      thinkingOverridesByFlatIndex: [undefined, "off", "off", "off"],
      maxSubagentDepth: 1,
      asyncDir: "/tmp/async-run",
    });

    assert.ok(!("error" in built));
    const group = built.steps[1];
    assert.ok(group && "parallel" in group && Array.isArray(group.parallel));
    assert.deepEqual(
      group.parallel.map((task) => task.sessionFile),
      ["/tmp/parallel-0.jsonl", "/tmp/parallel-1.jsonl"],
    );
    const staticWorker = built.steps[2];
    assert.ok(staticWorker && !("parallel" in staticWorker));
    assert.equal(staticWorker.sessionFile, "/tmp/static-worker.jsonl");
    assert.equal(staticWorker.model, "anthropic/claude-sonnet-4-5:off");
    assert.equal(staticWorker.thinking, "off");
  });

  it("gates thinking levels on merged agent fallback candidates", () => {
    const built = buildAsyncRunnerSteps("run-abc", {
      chain: [{ agent: "worker", task: "Do work" }],
      agents: [
        {
          ...makeAgent("worker"),
          model: "openai/gpt-5",
          fallbackModels: ["anthropic/claude-haiku-4-5"],
          thinking: "high",
        },
      ],
      ctx: {
        pi: {} as never,
        cwd: "/tmp/project",
        currentSessionId: "/tmp/parent-session.jsonl",
      },
      availableModels: [
        {
          provider: "openai",
          id: "gpt-5",
          fullId: "openai/gpt-5",
          reasoning: true,
          thinkingLevelMap: { high: "high" },
        },
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          fullId: "anthropic/claude-haiku-4-5",
          reasoning: false,
        },
      ],
      maxSubagentDepth: 1,
      asyncDir: "/tmp/async-run",
    });

    assert.ok(!("error" in built));
    const step = built.steps[0];
    assert.ok(step && !("parallel" in step));
    assert.equal(step.model, "openai/gpt-5:high");
    assert.deepEqual(step.modelCandidates, ["openai/gpt-5:high", "anthropic/claude-haiku-4-5"]);
    assert.deepEqual(step.attemptNotes, [
      'Notice: Thinking level "high" was dropped for model "anthropic/claude-haiku-4-5" because the model registry does not advertise support.',
    ]);
  });

  it("applies thinking overrides to async fallback candidates", () => {
    const built = buildAsyncRunnerSteps("run-abc", {
      chain: [{ agent: "worker", task: "Do work" }],
      agents: [
        {
          ...makeAgent("worker"),
          model: "openai/gpt-5-mini:high",
          fallbackModels: ["anthropic/claude-sonnet-4:low"],
          thinking: "high",
        },
      ],
      ctx: {
        pi: {} as never,
        cwd: "/tmp/project",
        currentSessionId: "/tmp/parent-session.jsonl",
      },
      thinkingOverridesByFlatIndex: ["off"],
      maxSubagentDepth: 1,
      asyncDir: "/tmp/async-run",
    });

    assert.ok(!("error" in built));
    const step = built.steps[0];
    assert.ok(step && !("parallel" in step));
    assert.equal(step.model, "openai/gpt-5-mini:off");
    assert.deepEqual(step.modelCandidates, [
      "openai/gpt-5-mini:off",
      "anthropic/claude-sonnet-4:off",
    ]);
    assert.equal(step.thinking, "off");
  });
});
