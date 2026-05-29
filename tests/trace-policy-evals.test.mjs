import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTracePolicy } from "./trace-policy-checker.mjs";
import { TRACE_POLICY_FIXTURES } from "./trace-policy-fixtures.mjs";

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
