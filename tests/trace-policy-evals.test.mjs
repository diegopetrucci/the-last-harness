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

test("architect plain bash source redirection is rejected", () => {
	assert.deepEqual(violationCodes({
		agent: "architect",
		steps: [
			{ type: "tool", tool: "bash", command: "echo hi > src/app.ts" },
		],
	}), ["architect.direct_source_mutation"]);
});

test("architect ticket command chained with source redirection is rejected after plan approval", () => {
	assert.deepEqual(violationCodes({
		agent: "architect",
		steps: [
			{ type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
			{ type: "user", text: "approved" },
			{ type: "tool", tool: "bash", command: 'tk create "x" -d "..." --acceptance "..."; echo hi > src/app.ts' },
		],
	}), ["architect.direct_source_mutation"]);
});

test("architect approved pure tk create stays allowed", () => {
	const result = evaluateTracePolicy({
		agent: "architect",
		steps: [
			{ type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
			{ type: "user", text: "approved" },
			{ type: "tool", tool: "bash", command: 'tk create "x" -d "..." --acceptance "..."' },
		],
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.violations, []);
});

test("architect approved env split-string pure tk create stays allowed", () => {
	const result = evaluateTracePolicy({
		agent: "architect",
		steps: [
			{ type: "assistant", action: "ask_plan_approval", text: "Plan is ready." },
			{ type: "user", text: "approved" },
			{ type: "tool", tool: "bash", command: 'env -S "tk create x -d ... --acceptance ..."' },
		],
	});

	assert.equal(result.ok, true);
	assert.deepEqual(result.violations, []);
});

test("bug-hunter plain bash rm is rejected", () => {
	assert.deepEqual(violationCodes({
		agent: "bug-hunter",
		steps: [
			{ type: "tool", tool: "bash", command: "rm -f secrets.txt" },
		],
	}), ["bug-hunter.read_only"]);
});

test("bug-hunter rejects mutating shell commands nested under control-flow reserved words", () => {
	for (const command of [
		"if true; then rm file; fi",
		'for f in x; do rm "$f"; done',
		"while true; do git reset --hard; done",
	]) {
		assert.deepEqual(violationCodes({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		}), ["bug-hunter.read_only"]);
	}
});

test("bug-hunter rejects backgrounded mutating bash segments", () => {
	for (const command of ["sleep 1 & rm -f secrets.txt", "true & git reset --hard"]) {
		assert.deepEqual(violationCodes({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		}), ["bug-hunter.read_only"]);
	}
});

test("bug-hunter rejects prefixed and command-substitution bash mutations", () => {
	const nestedEscapedLegacyBackticks = "echo `echo " + '\\`' + "rm file" + '\\``';

	for (const command of [
		"sudo -E rm file",
		"env -i git reset --hard",
		"env -P /bin rm file",
		"env --path /bin rm file",
		"env PATH=/tmp rm file",
		'env -S "rm file"',
		'env --split-string "rm file"',
		"env -Srm file",
		"env -Sgit reset --hard",
		"env -iSrm file",
		"env -iSgit reset --hard",
		'echo "$(rm file)"',
		"echo `rm file`",
		nestedEscapedLegacyBackticks,
	]) {
		assert.deepEqual(violationCodes({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		}), ["bug-hunter.read_only"]);
	}
});

test("bug-hunter keeps safe env prefixes read-only", () => {
	for (const command of [
		"env PATH=/tmp printf ok",
		"env -P /bin printf ok",
		"env --path /bin printf ok",
		'env -S "printf ok"',
		'env --split-string "printf ok"',
		"env -Sprintf ok",
		"env -Sgit status",
		"env -iSprintf ok",
		"echo `printf ok`",
	]) {
		const result = evaluateTracePolicy({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.violations, []);
	}
});

test("bug-hunter keeps shell comparisons and stderr redirection read-only", () => {
	for (const command of ['[[ "$a" > "$b" ]]', "(( a > b ))", "echo hi >&2"]) {
		const result = evaluateTracePolicy({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.violations, []);
	}
});

test("bug-hunter rejects in-place sed, mutating git, and package installs", () => {
	assert.deepEqual(violationCodes({
		agent: "bug-hunter",
		steps: [
			{ type: "tool", tool: "bash", command: "sed -i s/a/b/ src/app.ts" },
		],
	}), ["bug-hunter.read_only"]);

	assert.deepEqual(violationCodes({
		agent: "bug-hunter",
		steps: [
			{ type: "tool", tool: "bash", command: "git reset --hard" },
		],
	}), ["bug-hunter.read_only"]);

	assert.deepEqual(violationCodes({
		agent: "bug-hunter",
		steps: [
			{ type: "tool", tool: "bash", command: "npm install left-pad" },
		],
	}), ["bug-hunter.read_only"]);
});

test("bug-hunter rejects git apply and npm ci", () => {
	for (const command of ["git apply patch.diff", "npm ci"]) {
		assert.deepEqual(violationCodes({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		}), ["bug-hunter.read_only"]);
	}
});

test("bug-hunter rejects actual tk create", () => {
	assert.deepEqual(violationCodes({
		agent: "bug-hunter",
		steps: [
			{ type: "tool", tool: "bash", command: 'tk create "x" -d "..." --acceptance "..."' },
		],
	}), ["bug-hunter.read_only"]);
});

test("bug-hunter rejects env split-string payload mutations across categories", () => {
	for (const command of [
		'env -S "tk create x -d ... --acceptance ..."',
		'env --split-string "tk create x -d ... --acceptance ..."',
		'env -S "echo hi > src/app.ts"',
		"env --split-string \"sed -i 's/a/b/' src/app.ts\"",
	]) {
		assert.deepEqual(violationCodes({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		}), ["bug-hunter.read_only"]);
	}
});

test("bug-hunter keeps tk create text inside safe commands read-only", () => {
	for (const command of ["echo tk create x", "grep tk create file"]) {
		const result = evaluateTracePolicy({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.violations, []);
	}
});

test("bug-hunter bash tk show and npm test remain read-only", () => {
	for (const command of ["tk show tlh-oohv", "npm test"]) {
		const result = evaluateTracePolicy({
			agent: "bug-hunter",
			steps: [
				{ type: "tool", tool: "bash", command },
			],
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.violations, []);
	}
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

test("web-scout fetch budget violation is emitted once when later steps are non-network", () => {
	const result = evaluateTracePolicy({
		agent: "web-scout",
		steps: [
			{ type: "tool", tool: "web_search", query: "release notes" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/1" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/2" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/3" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/4" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/5" },
			{ type: "tool", tool: "fetch_content", url: "https://example.com/6" },
			{ type: "tool", tool: "read", path: "README.md" },
		],
	});

	assert.equal(result.ok, false);
	assert.deepEqual(result.violations.map((violation) => violation.code), ["web-scout.fetch_budget_exceeded"]);
});
