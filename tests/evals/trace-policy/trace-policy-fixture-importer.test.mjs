import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	formatTracePolicyFixtureSkeleton,
	importTracePolicyFixtureFromText,
} from "./trace-policy-fixture-importer.mjs";
import { evaluateTracePolicy } from "./trace-policy-checker.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const importerPath = join(repoRoot, "tests", "evals", "trace-policy", "trace-policy-fixture-importer.mjs");

test("trace-policy fixture importer redacts volatile paths ids timestamps and secret-like values", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		transcript: {
			agent: "developer",
			steps: [
				{
					type: "assistant",
					text: "Checking /Users/alice/.the-last-harness/agent on 2026-07-07T17:11:04.123Z with run_a1b2c3d4e5f6 and 123e4567-e89b-12d3-a456-426614174000",
					timestamp: "2026-07-07T17:11:04.123Z",
				},
				{
					type: "tool",
					tool: "bash",
					command: "OPENAI_API_KEY=sk-test password=lower-secret api_key='quoted-secret' bearer=unused printenv HOME && cat /var/folders/xx/yy/T/session-123/output.log && echo Bearer secret-token",
					path: "/Users/alice/project/tests/evals/trace-policy/fixture.json",
					input: {
						env: {
							HOME: "/Users/alice",
							TMPDIR: "/private/tmp/tlh-123",
							OPENAI_API_KEY: "sk-test",
						},
						traceId: "toolu_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
						nested: {
							sessionToken: "very-secret",
							reportPath: "/tmp/tlh-456/report.json",
						},
					},
					id: "msg_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
				},
			],
		},
	}));

	assert.equal(fixture.id, "imported-trace");
	assert.equal(fixture.transcript.agent, "developer");
	assert.deepEqual(fixture.transcript.steps[0], {
		type: "assistant",
		text: "Checking <HOME>/.the-last-harness/agent on <TIMESTAMP> with <ID> and <UUID>",
	});
	assert.deepEqual(fixture.transcript.steps[1], {
		type: "tool",
		tool: "bash",
		command: "OPENAI_API_KEY=<REDACTED> password=<REDACTED> api_key=<REDACTED> bearer=<REDACTED> printenv HOME && cat <TMP>/session-123/output.log && echo Bearer <REDACTED>",
		path: "<HOME>/project/tests/evals/trace-policy/fixture.json",
		input: {
			env: {
				HOME: "<HOME>",
				TMPDIR: "<TMP>/tlh-123",
				OPENAI_API_KEY: "<REDACTED>",
			},
			traceId: "<ID>",
			nested: {
				sessionToken: "<REDACTED>",
				reportPath: "<TMP>/tlh-456/report.json",
			},
		},
	});
	assert.match(formatTracePolicyFixtureSkeleton(fixture), /expectedResult: "allow"/);
});

test("trace-policy fixture importer quotes unsafe object keys in skeleton output", () => {
	const skeleton = formatTracePolicyFixtureSkeleton({
		safeKey: true,
		"x-api-key": "<REDACTED>",
		"tool-call": {
			"nested value": "ok",
		},
	});

	assert.match(skeleton, /safeKey: true/);
	assert.match(skeleton, /"x-api-key": "<REDACTED>"/);
	assert.match(skeleton, /"tool-call":/);
	assert.match(skeleton, /"nested value": "ok"/);
});

test("trace-policy fixture importer normalizes assistant content array object text", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Opened /Users/alice/project at 2026-07-07T17:11:04Z" },
					{ output_text: "API_TOKEN=super-secret" },
					{ output_text: "password=lower-secret api_key='quoted-secret'" },
				],
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "assistant",
			text: "Opened <HOME>/project at <TIMESTAMP>\nAPI_TOKEN=<REDACTED>\npassword=<REDACTED> api_key=<REDACTED>",
		},
	]);
});

test("trace-policy fixture importer redacts nested sensitive values", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				type: "tool",
				tool: "bash",
				input: {
					apiKeys: ["sk-one", { backup: "sk-two" }],
					auth: { bearer: "token", nested: { refresh: "secret" } },
					bearer: "direct-token",
					cookie: ["a=b", "c=d"],
					session: { id: "session_abcdef123456", file: "/Users/alice/session.json" },
					nonSensitive: { path: "/Users/alice/project" },
				},
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps[0].input, {
		apiKeys: "<REDACTED>",
		auth: "<REDACTED>",
		bearer: "<REDACTED>",
		cookie: "<REDACTED>",
		session: "<REDACTED>",
		nonSensitive: { path: "<HOME>/project" },
	});
});

test("trace-policy fixture importer redacts bearer assignments in normalized strings", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				type: "assistant",
				text: "Set bearer=plain-token and Bearer='quoted-token' before echo Bearer session-token",
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "assistant",
			text: "Set bearer=<REDACTED> and Bearer=<REDACTED> before echo Bearer <REDACTED>",
		},
	]);
});

test("trace-policy fixture importer drops snake_case volatile fields and normalizes generated ids", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				type: "tool",
				tool: "bash",
				input: {
					created_at: 1783450000000,
					updated_at: "2026-07-07T17:11:04Z",
					timestamp_ms: 1783450000000,
					trace_id: "trace_abcdef123456",
					request_id: "req_abcdef123456",
					keptText: "request req_abcdef123456 and trace trace-abcdef123456 finished",
				},
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps[0].input, {
		keptText: "request <ID> and trace <ID> finished",
	});
});

test("trace-policy fixture importer accepts standalone assistant, user, and tool records", () => {
	const cases = [
		{
			name: "assistant",
			input: { type: "assistant", text: "I read /Users/alice/project at 2026-07-07T17:11:04Z" },
			expectedAgent: "developer",
			expectedSteps: [{ type: "assistant", text: "I read <HOME>/project at <TIMESTAMP>" }],
		},
		{
			name: "user",
			input: { role: "user", content: "Please inspect /Users/alice/project" },
			expectedAgent: "developer",
			expectedSteps: [{ type: "user", text: "Please inspect <HOME>/project" }],
		},
		{
			name: "tool",
			input: { type: "tool", tool: "read", path: "/tmp/tlh-live-evals-123/input.json" },
			expectedAgent: "developer",
			expectedSteps: [{ type: "tool", tool: "read", path: "<TMP>/tlh-live-evals-123/input.json" }],
		},
		{
			name: "agent override",
			input: { role: "assistant", agent: "architect", content: "Please inspect /Users/alice/project" },
			expectedAgent: "architect",
			expectedSteps: [{ type: "assistant", text: "Please inspect <HOME>/project" }],
		},
	];

	for (const { name, input, expectedAgent, expectedSteps } of cases) {
		const fixture = importTracePolicyFixtureFromText(JSON.stringify(input), { agent: "developer" });
		assert.equal(fixture.transcript.agent, expectedAgent, `${name} agent`);
		assert.deepEqual(fixture.transcript.steps, expectedSteps, name);
	}
});


test("trace-policy fixture importer preserves named wrapper role-based agent extraction", () => {
	const cases = [
		{
			name: "steps wrapper",
			input: {
				role: "architect",
				name: "wrapper-agent",
				steps: [{ role: "assistant", content: "Ready" }],
			},
		},
		{
			name: "events wrapper",
			input: {
				role: "architect",
				name: "wrapper-agent",
				events: [{ role: "assistant", content: "Ready" }],
			},
		},
		{
			name: "messages wrapper",
			input: {
				role: "architect",
				name: "wrapper-agent",
				messages: [{ message: { role: "assistant", content: "Ready" } }],
			},
		},
		{
			name: "transcript steps wrapper",
			input: {
				transcript: {
					role: "architect",
					name: "wrapper-agent",
					steps: [{ role: "assistant", content: "Ready" }],
				},
			},
		},
	];

	for (const { name, input } of cases) {
		const fixture = importTracePolicyFixtureFromText(JSON.stringify(input), { agent: "developer" });
		assert.equal(fixture.transcript.agent, "architect", `${name} agent`);
		assert.deepEqual(fixture.transcript.steps, [
			{
				type: "assistant",
				text: "Ready",
			},
		], name);
	}
});



test("trace-policy fixture importer keeps named assistant messages as assistant steps", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				role: "assistant",
				name: "assistant-alias",
				content: "I read /Users/alice/project at 2026-07-07T17:11:04Z",
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "assistant",
			text: "I read <HOME>/project at <TIMESTAMP>",
		},
	]);
});

test("trace-policy fixture importer emits tool steps from assistant toolCall blocks while preserving assistant text", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Editing /Users/alice/project at 2026-07-07T17:11:04Z" },
					{ type: "toolCall", name: "edit", arguments: { path: "src/greeter.mjs" } },
				],
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "assistant",
			text: "Editing <HOME>/project at <TIMESTAMP>",
		},
		{
			type: "tool",
			tool: "edit",
			path: "src/greeter.mjs",
		},
	]);
});


test("trace-policy fixture importer correlates Pi toolResult failures onto the canonical tool call", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		messages: [
			{
				type: "message",
				id: "assistant-1",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Escalating blocker from /Users/alice/project" },
						{
							type: "toolCall",
							id: "call_contact_supervisor_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
							name: "contact_supervisor",
							arguments: {
								reason: "need_decision",
								message: "Need approval for /Users/alice/project",
							},
						},
					],
				},
			},
			{
				type: "message",
				id: "tool-result-1",
				message: {
					role: "toolResult",
					toolCallId: "call_contact_supervisor_01HZX3R5J2N7QP9KJ3ZXCVBNM1",
					toolName: "contact_supervisor",
					isError: true,
					content: [
						{ type: "text", text: "raw sensitive output /Users/alice/.config/token.txt api_key=secret" },
					],
					details: {
						exitCode: 7,
						status: "failed",
						error: "blocking reply unavailable",
					},
				},
			},
			{
				type: "message",
				id: "assistant-2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Trying another tool anyway." }],
				},
			},
			{
				type: "message",
				id: "assistant-3",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_read_2", name: "read", arguments: { path: "tests/evals/trace-policy/trace-policy-checker.mjs" } }],
				},
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "assistant",
			text: "Escalating blocker from <HOME>/project",
		},
		{
			type: "tool",
			tool: "contact_supervisor",
			status: "failed",
			exitCode: 7,
			ok: false,
			input: {
				reason: "need_decision",
				message: "Need approval for <HOME>/project",
			},
		},
		{
			type: "assistant",
			text: "Trying another tool anyway.",
		},
		{
			type: "tool",
			tool: "read",
			path: "tests/evals/trace-policy/trace-policy-checker.mjs",
		},
	]);
	assert.equal(JSON.stringify(fixture.transcript.steps).includes("raw sensitive output"), false);
	assert.deepEqual(
		evaluateTracePolicy(fixture.transcript).violations.map((violation) => violation.code),
		["developer.blocking_escalation_stop_required"],
	);
});


test("trace-policy fixture importer preserves successful Pi toolCall imports without a duplicate result step", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		messages: [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "/Users/alice/project/README.md" } }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_read_1",
					toolName: "read",
					isError: false,
					content: [{ type: "text", text: "README content" }],
					details: { exitCode: 0 },
				},
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "tool",
			tool: "read",
			path: "<HOME>/project/README.md",
		},
	]);
});
test("trace-policy fixture importer normalizes Windows home and temp subpaths", () => {
	const fixture = importTracePolicyFixtureFromText(JSON.stringify({
		agent: "developer",
		steps: [
			{
				type: "tool",
				tool: "read",
				path: "C:\\Users\\alice\\project\\trace.json",
				input: {
					cachePath: "C:\\Users\\alice\\AppData\\Local\\Temp\\tlh-123\\trace.json",
				},
			},
		],
	}));

	assert.deepEqual(fixture.transcript.steps, [
		{
			type: "tool",
			tool: "read",
			path: "<HOME>/project/trace.json",
			input: {
				cachePath: "<TMP>/tlh-123/trace.json",
			},
		},
	]);
});

test("trace-policy fixture importer CLI emits a reviewable skeleton from JSONL input", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-trace-policy-importer-"));
	const inputPath = join(tempDir, "sample-trace.jsonl");
	writeFileSync(inputPath, [
		JSON.stringify({ type: "assistant", text: "Plan saved at /Users/alice/tmp on 2026-07-07T17:11:04Z" }),
		JSON.stringify({ type: "tool", tool: "read", path: "/tmp/tlh-live-evals-123/input.json" }),
	].join("\n"), "utf8");

	try {
		const result = spawnSync(process.execPath, [importerPath, inputPath, "--agent", "architect", "--reject"], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /id: "sample-trace"/);
		assert.match(result.stdout, /name: "imported sample trace"/);
		assert.match(result.stdout, /expectedResult: "reject"/);
		assert.match(result.stdout, /valid: false/);
		assert.match(result.stdout, /agent: "architect"/);
		assert.match(result.stdout, /<HOME>\/tmp/);
		assert.match(result.stdout, /<TIMESTAMP>/);
		assert.match(result.stdout, /<TMP>\/tlh-live-evals-123\/input\.json/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("trace-policy fixture importer CLI prefers --id over the input filename", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "tlh-trace-policy-importer-"));
	const inputPath = join(tempDir, "sample-trace.jsonl");
	writeFileSync(inputPath, JSON.stringify([{ type: "assistant", text: "Ready" }]), "utf8");

	try {
		const result = spawnSync(process.execPath, [importerPath, inputPath, "--id", "custom-trace"], {
			cwd: repoRoot,
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /id: "custom-trace"/);
		assert.match(result.stdout, /name: "imported custom trace"/);
		assert.doesNotMatch(result.stdout, /id: "sample-trace"/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
