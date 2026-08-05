import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sumResultsCost, sumResultsUsage } from "../../src/shared/utils.ts";
import type { SingleResult, Usage } from "../../src/shared/types.ts";

function resultWithUsage(usage: Usage): SingleResult {
	return {
		agent: "agent",
		task: "task",
		exitCode: 0,
		messages: [],
		usage,
	};
}

describe("sumResultsUsage", () => {
	it("aggregates full child usage", () => {
		const total = sumResultsUsage([
			resultWithUsage({ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 }),
			resultWithUsage({ input: 20, output: 7, cacheRead: 3, cacheWrite: 4, cost: 0.03, turns: 2 }),
		]);

		assert.deepEqual(total, { input: 30, output: 12, cacheRead: 4, cacheWrite: 6, cost: 0.04, turns: 3 });
	});
});

describe("sumResultsCost", () => {
	it("aggregates input tokens, output tokens, and cost", () => {
		const total = sumResultsCost([
			resultWithUsage({ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 }),
			resultWithUsage({ input: 20, output: 7, cacheRead: 3, cacheWrite: 4, cost: 0.03, turns: 2 }),
		]);

		assert.deepEqual(total, { inputTokens: 30, outputTokens: 12, costUsd: 0.04 });
	});

	it("returns zero totals when all aggregated fields are zero", () => {
		assert.deepEqual(
			sumResultsCost([
				resultWithUsage({ input: 0, output: 0, cacheRead: 10, cacheWrite: 5, cost: 0, turns: 2 }),
			]),
			{ inputTokens: 0, outputTokens: 0, costUsd: 0 },
		);
	});

	it("includes attached nested subagent costs", () => {
		const parent = resultWithUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 });
		parent.children = [{
			id: "nested-run",
			parentRunId: "parent-run",
			parentStepIndex: 0,
			depth: 1,
			path: [{ runId: "parent-run", stepIndex: 0 }],
			state: "complete",
			totalCost: { inputTokens: 20, outputTokens: 7, costUsd: 0.03 },
		}];

		assert.deepEqual(sumResultsCost([parent]), { inputTokens: 30, outputTokens: 12, costUsd: 0.04 });
	});
});
