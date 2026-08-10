import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildAsyncRunnerSteps, resolveAsyncRunnerLogPaths } from "../../src/runs/background/async-execution.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const agent = (name: string, toolBudget?: AgentConfig["toolBudget"], maxExecutionTimeMs?: number): AgentConfig => ({
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

const ctx = {
	cwd: process.cwd(),
	currentSessionId: "session-1",
	currentModel: undefined,
	currentModelProvider: undefined,
	modelScope: undefined,
};

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
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 3, block: ["find"] });
		assert.deepEqual(result.steps[1]?.toolBudget, { hard: 2, block: ["grep"] });
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
		assert.deepEqual(result.steps[0]?.toolBudget, { hard: 4, block: ["read"] });
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
			agents: [agent("fast", undefined, 100), agent("slow", undefined, 300), agent("caller-bound", undefined, 900)],
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
});
