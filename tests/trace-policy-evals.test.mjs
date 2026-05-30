import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTracePolicy } from "./trace-policy-checker.mjs";
import { TRACE_POLICY_FIXTURES } from "./trace-policy-fixtures.mjs";

function violationCodes(transcript) {
	return evaluateTracePolicy(transcript).violations.map((violation) => violation.code);
}

for (const fixture of TRACE_POLICY_FIXTURES) {
	test(`trace policy fixture: ${fixture.name}`, () => {
		const result = evaluateTracePolicy(fixture.transcript);

		assert.equal(result.agent, fixture.transcript.agent);
		assert.equal(result.ok, fixture.valid);
		if (fixture.valid) {
			assert.deepEqual(result.violations, []);
			return;
		}

		assert.deepEqual(
			result.violations.map((violation) => violation.code),
			fixture.expectedCodes,
		);
	});
}

test("reported architect source edit regression is rejected", () => {
	assert.deepEqual(violationCodes({
		agent: "architect",
		steps: [
			{ type: "tool", tool: "read", path: "src/greeter.mjs" },
			{ type: "tool", tool: "edit", path: "src/greeter.mjs" },
		],
	}), ["architect.direct_source_mutation"]);
});

test("reported product developer and code-reviewer delegations are rejected", () => {
	assert.deepEqual(violationCodes({
		agent: "product",
		steps: [
			{ type: "tool", tool: "subagent", input: { agent: "developer", prompt: "Implement it." } },
		],
	}), ["product.no_implementation_delegation"]);

	assert.deepEqual(violationCodes({
		agent: "product",
		steps: [
			{ type: "tool", tool: "subagent", input: { agent: "code-reviewer", prompt: "Review it." } },
		],
	}), ["product.no_implementation_delegation"]);
});

test("reported product docs traversal regression is rejected", () => {
	assert.deepEqual(violationCodes({
		agent: "product",
		steps: [
			{ type: "tool", tool: "edit", path: "docs/../scripts/merge-settings.mjs" },
		],
	}), ["product.write_boundary"]);
});
